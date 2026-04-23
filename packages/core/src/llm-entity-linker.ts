import type { Logger } from 'pino';
import type { KnowledgeGraphRepository, KGEntity } from '@alfred/storage';
import type { LLMLinkingConfig } from '@alfred/types';

type UsageCallback = (service: string, model: string, inputTokens: number, outputTokens: number) => void;

interface LLMRelation {
  source: string;
  target: string;
  type: string;
  confidence?: number;
  reason?: string;
}

interface LLMNewEntity {
  name: string;
  type: string;
  attributes?: Record<string, unknown>;
  reason?: string;
}

interface LLMCorrection {
  name: string;
  currentType: string;
  newType: string;
  newName?: string;
  attributes?: Record<string, unknown>;
  reason?: string;
}

interface LLMLinkingResult {
  relations?: LLMRelation[];
  weaken?: LLMRelation[];
  remove?: LLMRelation[];
  newEntities?: LLMNewEntity[];
  corrections?: LLMCorrection[];
}

const ALLOWED_RELATION_TYPES = new Set([
  // Person relationships
  'spouse', 'sibling', 'parent_of', 'child_of', 'family', 'grandparent_of', 'aunt_uncle_of',
  'knows', 'friend', 'colleague',
  // Person → Organization
  'works_at', 'member_of', 'customer_of',
  // Person/Org → Location
  'located_at', 'home_location',
  // General semantic
  'owns', 'uses', 'monitors', 'subscribes_to', 'prefers', 'dislikes',
  'part_of', 'depends_on', 'same_as',
  // Activity
  'plays_at', 'practices', 'teaches', 'coaches', 'studies',
  // Causal/temporal
  'caused_by', 'prepares_for', 'affects',
  // Events
  'involves', 'relevant_to',
  // Generic (fallback)
  'mentioned_with', 'relates_to',
]);

const VALID_ENTITY_TYPES = new Set([
  'person', 'location', 'item', 'vehicle', 'event', 'organization', 'metric',
]);

/**
 * LLM-based entity linker: uses a language model to find semantic
 * relationships that text-based matching cannot detect.
 * Runs periodically (daily/weekly), processes only new/changed entities.
 */
export class LLMEntityLinker {
  private lastRunAt?: string;
  private usageCallback?: UsageCallback;

  /** Set callback for tracking LLM usage (called with service, model, input/output tokens). */
  setUsageCallback(cb: UsageCallback): void { this.usageCallback = cb; }

  private documentRepo?: import('@alfred/storage').DocumentRepository;

  /** Set optional document repo for chunk-based linking. */
  setDocumentRepo(repo: import('@alfred/storage').DocumentRepository): void { this.documentRepo = repo; }

  /** German common words that the LLM sometimes proposes as entity names.
   *  These should never become entities regardless of LLM classification. */
  private static readonly BLACKLISTED_ENTITY_NAMES = new Set([
    'zuhause', 'hause', 'match', 'schritt', 'memory', 'stelle', 'betrieb',
    'verbindungsprobleme', 'verbindung', 'verwendung', 'verarbeitung',
    'verfügung', 'vergleich', 'vorschlag', 'zusammenfassung', 'beschreibung',
    'erinnerung', 'warnung', 'fehler', 'ergebnis', 'übersicht', 'antwort',
    'hinweis', 'lösung', 'problem', 'update', 'status', 'version',
    'konfiguration', 'einstellung', 'information', 'nachricht', 'anfrage',
    'bitte', 'danke', 'hilfe', 'beispiel', 'option', 'empfehlung',
    'inbox', 'kalender', 'notiz', 'aufgabe', 'rechnung', 'dokument',
    'backup', 'server', 'cluster', 'gateway', 'switch', 'router',
    'webhook', 'plugin', 'module', 'service', 'adapter', 'sensor',
  ]);

  constructor(
    private readonly kgRepo: KnowledgeGraphRepository,
    private readonly config: LLMLinkingConfig,
    private readonly logger: Logger,
    private readonly apiKey: string,
    private readonly baseUrl: string = 'https://api.mistral.ai/v1',
  ) {}

  /** Check if a proposed entity name is a common word that should never be an entity. */
  private isBlacklistedEntityName(name: string): boolean {
    const lower = name.toLowerCase().trim();
    if (LLMEntityLinker.BLACKLISTED_ENTITY_NAMES.has(lower)) return true;
    // Single word, all lowercase → likely a German common noun, not a proper name
    if (/^[a-zäöüß]+$/.test(name) && name.length > 3) return true;
    // Contains control characters or is too short/long
    if (/[\n\r\t]/.test(name) || name.length < 2 || name.length > 50) return true;
    return false;
  }

  /** Check if a run is due based on schedule. */
  shouldRun(): boolean {
    if (!this.config.enabled) return false;
    if (!this.lastRunAt) return true;

    const elapsed = Date.now() - new Date(this.lastRunAt).getTime();
    const schedule = this.config.schedule ?? 'daily';
    if (schedule === 'daily') return elapsed > 20 * 60 * 60_000; // 20h
    if (schedule === 'weekly') return elapsed > 6 * 24 * 60 * 60_000; // 6d
    return false; // manual
  }

  /** Run the LLM entity linking pass. */
  async run(userId: string): Promise<{ relations: number; newEntities: number; corrections: number }> {
    const rawEntities = await this.kgRepo.getAllEntities(userId);

    // Filter out CMDB-only entities — they are already linked via CMDB relations.
    // Keep entities that have multiple sources (e.g. ['cmdb', 'chat']) since those
    // represent cross-domain entities worth linking to persons/orgs/locations.
    const allEntities = rawEntities.filter(e => {
      const sources = e.sources ?? [];
      if (sources.length === 1 && sources[0] === 'cmdb') return false;
      return true;
    });

    if (allEntities.length < 3) return { relations: 0, newEntities: 0, corrections: 0 };

    // Mix of entities to analyze: changed entities + core entities (persons, locations, vehicles, orgs)
    // This ensures the LLM links events to real-world entities, not just event↔event
    const cutoff = this.lastRunAt ?? '2000-01-01T00:00:00Z';
    const maxPerPass = this.config.maxEntitiesPerPass ?? 30;
    const coreTypes = new Set(['person', 'location', 'vehicle', 'organization']);
    const changed = allEntities.filter(e => e.lastSeenAt > cutoff || !this.lastRunAt);
    const coreEntities = allEntities.filter(e => coreTypes.has(e.entityType) && e.name !== 'User');
    // Deduplicate and prioritize: core entities first, then changed events/items
    const seen = new Set<string>();
    const toAnalyze: typeof allEntities = [];
    for (const e of [...coreEntities, ...changed]) {
      if (!seen.has(e.id) && toAnalyze.length < maxPerPass) {
        seen.add(e.id);
        toAnalyze.push(e);
      }
    }

    if (toAnalyze.length === 0) {
      this.lastRunAt = new Date().toISOString();
      return { relations: 0, newEntities: 0, corrections: 0 };
    }

    // Fetch document chunks for context (first chunk per doc, max 5 docs)
    let docContext = '';
    if (this.documentRepo) {
      try {
        const docs = await this.documentRepo.listAccessible(userId);
        for (const doc of docs.slice(0, 5)) {
          const chunks = await this.documentRepo.getChunks(doc.id);
          if (chunks.length > 0) {
            docContext += `\n- Dokument "${doc.filename}": ${chunks[0].content.slice(0, 200)}`;
          }
        }
      } catch { /* non-critical */ }
    }

    // Load existing relations for context (so LLM can identify stale/wrong ones)
    let existingRelations: Array<{ source: string; target: string; type: string; strength: number }> = [];
    try {
      const graph = await this.kgRepo.getFullGraph(userId);
      const entityById = new Map(allEntities.map(e => [e.id, e.name]));
      existingRelations = graph.relations
        .filter(r => entityById.has(r.sourceEntityId) && entityById.has(r.targetEntityId))
        .map(r => ({ source: entityById.get(r.sourceEntityId)!, target: entityById.get(r.targetEntityId)!, type: r.relationType, strength: r.strength }))
        .slice(0, 50);
    } catch { /* non-critical */ }

    // Build prompt
    const prompt = this.buildPrompt(toAnalyze, allEntities, docContext, existingRelations);

    // Call LLM
    const model = this.config.model ?? 'mistral-small-latest';
    let result: LLMLinkingResult;
    try {
      result = await this.callLLM(prompt, model);
    } catch (err) {
      this.logger.warn({ err }, 'LLM entity linking call failed');
      this.lastRunAt = new Date().toISOString(); // Prevent retry on every cycle
      return { relations: 0, newEntities: 0, corrections: 0 };
    }

    // Apply results
    const stats = await this.applyResults(userId, result, allEntities);
    this.lastRunAt = new Date().toISOString();

    this.logger.info({ ...stats, entitiesProcessed: toAnalyze.length }, 'LLM entity linking completed');
    return stats;
  }

  private buildPrompt(changed: KGEntity[], all: KGEntity[], docContext = '', existingRelations: Array<{ source: string; target: string; type: string; strength: number }> = []): string {
    const changedList = changed.map(e =>
      `- [${e.entityType}] "${e.name}"${e.attributes?.value ? ` — ${String(e.attributes.value).slice(0, 120)}` : ''}${e.attributes?.role ? ` (${e.attributes.role})` : ''}`,
    ).join('\n');

    const allList = all.map(e => {
      const extra = e.attributes?.realName ? ` (Realname: ${e.attributes.realName})` : '';
      return `- [${e.entityType}] "${e.name}"${extra}`;
    }).join('\n');

    const relList = existingRelations.length > 0
      ? existingRelations.map(r => `- "${r.source}" —${r.type}→ "${r.target}" (strength: ${r.strength.toFixed(1)})`).join('\n')
      : '(keine)';

    // Identify User entity and children for prompt context
    const userEntity = all.find(e => e.name === 'User' && e.entityType === 'person');
    const userRealName = userEntity?.attributes?.realName as string | undefined;
    const childEntities = all.filter(e => e.entityType === 'person' && /^(sohn|tochter)\s/i.test(e.name));
    const childNames = childEntities.map(e => `"${e.name}"`).join(', ');

    return `Du bist ein Knowledge-Graph-Analyst. Du verknüpfst Wissen wie ein aufmerksamer menschlicher Assistent.

WIE EIN MENSCH DENKEN — BEISPIELE:

RICHTIG:
- Chat: "War heute beim Dr. Steindl in der Viktor Kaplan Straße" → Dr. Steindl ist eine Person (Arzt). Viktor Kaplan Straße ist der Praxis-Ort. NICHT die Wohnadresse des Users.
- Kalender: "Termin bei Dr. Steindl, Viktor Kaplan Straße 12" → Event located_at Viktor Kaplan Straße 12. Dr. Steindl involves Event.
- Memory: "Mutter wohnt in Eichgraben" → Maria Dohnal located_at Eichgraben. NICHT User located_at Eichgraben.
- Chat: "Noah spielt bei SV Altlengbach" → Noah plays_at SV Altlengbach.

FALSCH:
- Termin-Adresse → User wohnt dort (Termin-Ort ≠ Wohnadresse!)
- Person same_as Location (Typ-Verwechslung!)
- "könnte in Verbindung stehen" → Spekulation, nicht speichern
- Dr. Steindl als Location anlegen (ist eine Person!)

IDENTITÄT:
- "User" ist der Hauptbenutzer${userRealName ? ` (Realname: ${userRealName})` : ''}.
${childNames ? `- Kinder: ${childNames}. EIGENSTÄNDIGE Personen, besitzen NICHT die Dinge des Users.` : ''}
- Gleicher Nachname ≠ gleiche Person.
${docContext ? `\nDOKUMENT-KONTEXT:${docContext}` : ''}

NEUE/GEÄNDERTE ENTITIES:
${changedList}

ALLE ENTITIES:
${allList}

BESTEHENDE RELATIONEN (Top 50):
${relList}

Antworte NUR als JSON:
{
  "relations": [{"source": "A", "target": "B", "type": "relation_type", "confidence": 0.9, "reason": "Begründung"}],
  "weaken": [{"source": "A", "target": "B", "type": "type", "reason": "Warum veraltet"}],
  "remove": [{"source": "A", "target": "B", "type": "type", "reason": "Warum falsch"}],
  "newEntities": [{"name": "Name", "type": "entity_type", "attributes": {}, "reason": "Warum"}],
  "corrections": [{"name": "Name", "currentType": "type", "newType": "type", "attributes": {"key": "val"}, "reason": "Warum"}]
}

ERLAUBTE RELATION-TYPEN (NUR diese verwenden!):
spouse, sibling, parent_of, child_of, family, grandparent_of, aunt_uncle_of, knows, friend, colleague, works_at, member_of, customer_of, located_at, home_location, owns, uses, monitors, subscribes_to, prefers, dislikes, part_of, depends_on, same_as, plays_at, practices, teaches, coaches, studies, caused_by, prepares_for, affects, involves, relevant_to, mentioned_with, relates_to

REGELN:
- Nur ECHTE Zusammenhänge, KEINE Spekulation
- confidence: 0.0-1.0. Nur >= 0.7 wird gespeichert. "wohnt laut Memory" = 0.9. "könnte" = 0.3.
- KEINE neuen Relation-Typen erfinden
- same_as NUR zwischen GLEICHEM Entity-Typ (Person↔Person, Location↔Location)
- Adresse in Termin/Arztbesuch/Ladung = Termin-Ort, NICHT Wohnadresse
- Nur "wohnt in/lebt in" = Wohnadresse (located_at/home_location)
- Entity-Typen: person, location, item, vehicle, event, organization, metric
- corrections: NUR Attribute ändern, NICHT den Entity-Typ. newType MUSS gleich currentType sein.
- KEINE Entities für Attribute (Geburtsdatum, Telefon → als Attribute auf Person via corrections)
- Wenn nichts zu tun: {"relations":[],"weaken":[],"remove":[],"newEntities":[],"corrections":[]}

TRANSITIVE INFERENZ:
- A parent_of B und A spouse C → C parent_of B
- A parent_of B und A parent_of C → B sibling C
- Person arbeitet bei Firma → works_at Organization`;
  }

  private async callLLM(prompt: string, model: string): Promise<LLMLinkingResult> {
    const provider = this.config.provider ?? 'mistral';
    const url = provider === 'mistral'
      ? `${this.baseUrl}/chat/completions`
      : provider === 'openai'
        ? 'https://api.openai.com/v1/chat/completions'
        : `${this.baseUrl}/chat/completions`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      throw new Error(`LLM API ${res.status}: ${await res.text().catch(() => '')}`);
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content ?? '{}';

    // Track usage
    if (this.usageCallback && data.usage) {
      this.usageCallback('llm_linking', model, data.usage.prompt_tokens ?? 0, data.usage.completion_tokens ?? 0);
    }

    try {
      return JSON.parse(content) as LLMLinkingResult;
    } catch {
      // Truncated JSON: try to salvage partial arrays
      try {
        // Find last complete object in each array
        const salvaged: LLMLinkingResult = {};
        const relMatch = content.match(/"relations"\s*:\s*\[([\s\S]*)/);
        if (relMatch) {
          const items = [...relMatch[1].matchAll(/\{[^}]+\}/g)].map(m => { try { return JSON.parse(m[0]); } catch { return null; } }).filter(Boolean);
          if (items.length > 0) salvaged.relations = items;
        }
        const neMatch = content.match(/"newEntities"\s*:\s*\[([\s\S]*)/);
        if (neMatch) {
          const items = [...neMatch[1].matchAll(/\{[^}]+\}/g)].map(m => { try { return JSON.parse(m[0]); } catch { return null; } }).filter(Boolean);
          if (items.length > 0) salvaged.newEntities = items;
        }
        const corrMatch = content.match(/"corrections"\s*:\s*\[([\s\S]*)/);
        if (corrMatch) {
          const items = [...corrMatch[1].matchAll(/\{[^}]+\}/g)].map(m => { try { return JSON.parse(m[0]); } catch { return null; } }).filter(Boolean);
          if (items.length > 0) salvaged.corrections = items;
        }
        if (salvaged.relations?.length || salvaged.newEntities?.length || salvaged.corrections?.length) {
          this.logger.info({ salvaged: (salvaged.relations?.length ?? 0) + (salvaged.newEntities?.length ?? 0) + (salvaged.corrections?.length ?? 0) }, 'LLM linking: salvaged partial JSON');
          return salvaged;
        }
      } catch { /* give up */ }
      this.logger.warn({ content: content.slice(0, 200) }, 'LLM linking: failed to parse JSON response');
      return {};
    }
  }

  private async applyResults(
    userId: string, result: LLMLinkingResult, allEntities: KGEntity[],
  ): Promise<{ relations: number; newEntities: number; corrections: number }> {
    const stats = { relations: 0, newEntities: 0, corrections: 0 };
    const entityByName = new Map(allEntities.map(e => [e.name.toLowerCase(), e]));

    // 1. Apply new relations (with type validation)
    for (const rel of (result.relations ?? []).slice(0, 20)) {
      if (!rel.type || !ALLOWED_RELATION_TYPES.has(rel.type)) continue;
      const source = entityByName.get(rel.source.toLowerCase());
      const target = entityByName.get(rel.target.toLowerCase());
      if (!source || !target || source.id === target.id) continue;
      // Confidence gate: skip low-confidence relations
      const confidence = typeof rel.confidence === 'number' ? rel.confidence : 0.5;
      if (confidence < 0.7) {
        this.logger.debug({ source: rel.source, target: rel.target, type: rel.type, confidence }, 'LLM linker: low confidence, skipped');
        continue;
      }
      // Strict validation: prevent common LLM hallucinations
      if (rel.type === 'works_at') {
        if (target.entityType !== 'organization') continue;
        // Only User or explicit employment entities work somewhere — not children, HA items, spouses
        if (source.name !== 'User' && source.entityType !== 'organization' && !source.sources.includes('memories')) continue;
        if (source.sources.includes('smarthome')) continue; // HA person.* entities don't "work" anywhere
      }
      if (rel.type === 'plays_at') {
        if (source.entityType !== 'person' || target.entityType !== 'organization') continue;
      }
      // Personal preference/ownership relations only for User, not children or other family
      if (['owns', 'monitors', 'prefers', 'dislikes', 'uses', 'subscribes_to'].includes(rel.type)) {
        if (source.entityType === 'person' && source.name !== 'User' && /^(sohn|tochter)\s/i.test(source.name)) continue;
      }
      if (rel.type === 'parent_of' && (source.entityType !== 'person' || target.entityType !== 'person')) continue;
      if (rel.type === 'spouse') {
        if (source.entityType !== 'person' || target.entityType !== 'person') continue;
        // Spouse only from memory-sourced entities (like sibling) — too high-stakes for LLM guessing
        if (!source.sources.includes('memories') && !target.sources.includes('memories')) continue;
      }
      if (rel.type === 'family' && (source.entityType !== 'person' || target.entityType !== 'person')) continue;
      if (rel.type === 'sibling') {
        if (source.entityType !== 'person' || target.entityType !== 'person') continue;
        // Only allow siblings if both have memory source (not HA items, not events)
        if (!source.sources.includes('memories') || !target.sources.includes('memories')) continue;
      }
      if (rel.type === 'located_at' && target.entityType !== 'location') continue;
      // Person → Location: only accept if reason explicitly mentions living/residing
      if (rel.type === 'located_at' && source.entityType === 'person' && source.name === 'User') {
        const reasonLower = (rel.reason ?? '').toLowerCase();
        if (!reasonLower.includes('wohnt') && !reasonLower.includes('lebt') && !reasonLower.includes('adresse') && !reasonLower.includes('zuhause') && !reasonLower.includes('home')) {
          this.logger.debug({ source: rel.source, target: rel.target, reason: rel.reason }, 'LLM linker: User located_at rejected (no residence indicator in reason)');
          continue;
        }
      }
      // home_location: same guard
      if (rel.type === 'home_location' && source.entityType === 'person' && source.name === 'User') {
        const reasonLower = (rel.reason ?? '').toLowerCase();
        if (!reasonLower.includes('wohnt') && !reasonLower.includes('lebt') && !reasonLower.includes('adresse') && !reasonLower.includes('zuhause') && !reasonLower.includes('home')) {
          continue;
        }
      }
      // same_as between persons: only if names are genuinely the same person (alias, nickname, etc.)
      // NOT just same surname — "Linus Dohnal" != "Markus Dohnal"
      if (rel.type === 'same_as' && source.entityType === 'person' && target.entityType === 'person') {
        const srcName = source.name.toLowerCase().trim();
        const tgtName = target.name.toLowerCase().trim();
        // Allow: exact match, one contains the other (e.g. "Alex" ↔ "Alexandra"), or "Sohn X" ↔ "X Surname"
        const srcFirst = srcName.split(/\s+/)[0].replace(/^(sohn|tochter)\s*/i, '');
        const tgtFirst = tgtName.split(/\s+/)[0].replace(/^(sohn|tochter)\s*/i, '');
        if (srcName !== tgtName && !srcName.includes(tgtName) && !tgtName.includes(srcName) && srcFirst !== tgtFirst) {
          continue; // Different persons with same surname — skip
        }
      }
      // same_as only between same entity types
      if (rel.type === 'same_as' && source.entityType !== target.entityType) continue;
      // Org↔Org: only allow same_as and part_of — never relates_to, used_for, etc.
      if (source.entityType === 'organization' && target.entityType === 'organization' && !['same_as', 'part_of'].includes(rel.type)) continue;
      // Skip relations between items that are clearly HA entities (LED, Switch, AP, etc.)
      if (source.entityType === 'item' && target.entityType === 'item' && source.sources.includes('smarthome') && target.sources.includes('smarthome')) continue;
      await this.kgRepo.upsertRelation(userId, source.id, target.id, rel.type, rel.reason?.slice(0, 100), 'llm_linking');
      stats.relations++;
    }

    // 2. Create new entities (with blacklist check — LLM sometimes proposes
    //    common German words like "Zuhause", "Verbindungsprobleme" as entities)
    for (const ne of (result.newEntities ?? []).slice(0, 5)) {
      if (!VALID_ENTITY_TYPES.has(ne.type)) continue;
      if (entityByName.has(ne.name.toLowerCase())) {
        const existing = entityByName.get(ne.name.toLowerCase())!;
        if (existing.entityType !== ne.type) {
          this.logger.debug({ name: ne.name, existingType: existing.entityType, proposedType: ne.type }, 'LLM linker: entity exists with different type, creation rejected');
        }
        continue;
      }
      if (this.isBlacklistedEntityName(ne.name)) {
        this.logger.debug({ name: ne.name, type: ne.type }, 'LLM linker: skipped blacklisted entity name');
        continue;
      }
      // Reject sentence fragments and phrases as entity names
      if (ne.name.length > 40) continue;
      if (/\b(von|und|oder|für|mit|der|die|das|ein|eine|ist|hat|wird|alle|system)\b/i.test(ne.name) && ne.type !== 'event') continue;
      if (/[.!?;()]/.test(ne.name)) continue; // sentence punctuation
      if (ne.type === 'person' && !/^[A-ZÄÖÜ]/.test(ne.name)) continue;
      const entity = await this.kgRepo.upsertEntity(userId, ne.name, ne.type as any, ne.attributes ?? {}, 'llm_linking');
      entityByName.set(ne.name.toLowerCase(), entity);
      stats.newEntities++;
    }

    // 3. Apply corrections (type changes, attribute enrichment, name corrections)
    for (const corr of (result.corrections ?? []).slice(0, 10)) {
      const existing = entityByName.get(corr.name.toLowerCase());
      if (!existing) continue;

      // Type correction — entity types are immutable, only attributes can be changed
      if (corr.newType !== corr.currentType) {
        this.logger.debug({ name: corr.name, currentType: corr.currentType, newType: corr.newType }, 'LLM linker: entity type change rejected (immutable)');
        // Still apply attributes if provided
        if (corr.attributes && Object.keys(corr.attributes).length > 0) {
          const mergedAttrs = { ...existing.attributes, ...corr.attributes };
          await this.kgRepo.upsertEntity(userId, existing.name, existing.entityType as any, mergedAttrs, existing.sources[0] ?? 'llm_linking');
          stats.corrections++;
        }
      } else if (corr.attributes && Object.keys(corr.attributes).length > 0) {
        // Attribute enrichment without type change (e.g., add birthday, livesIn, employer to a person)
        const mergedAttrs = { ...existing.attributes, ...corr.attributes };
        await this.kgRepo.upsertEntity(userId, existing.name, existing.entityType as any, mergedAttrs, existing.sources[0] ?? 'llm_linking');
        stats.corrections++;
      }

      // Name correction (e.g., "Noah Dohnal" → "Noah Habel")
      if (corr.newName && corr.newName !== corr.name && corr.newName.length >= 2 && corr.newName.length <= 50) {
        const renamed = await this.kgRepo.renameEntity(existing.id, corr.newName);
        if (renamed) {
          entityByName.delete(corr.name.toLowerCase());
          entityByName.set(corr.newName.toLowerCase(), { ...existing, name: corr.newName });
          stats.corrections++;
        }
      }
    }

    // 4. Weaken stale/outdated relations (halve strength)
    for (const w of (result.weaken ?? []).slice(0, 10)) {
      const source = entityByName.get(w.source.toLowerCase());
      const target = entityByName.get(w.target.toLowerCase());
      if (!source || !target) continue;
      try {
        const allRels = await this.kgRepo.getRelationsForEntity(userId, source.id);
        const match = allRels.find(r => r.targetEntityId === target.id && r.relationType === w.type);
        if (match) {
          await this.kgRepo.updateRelationStrength(match.id, Math.max(0.1, match.strength * 0.5));
          this.logger.debug({ source: w.source, target: w.target, type: w.type, reason: w.reason }, 'Relation weakened by LLM');
        }
      } catch { /* non-critical */ }
    }

    // 5. Remove clearly wrong relations
    for (const r of (result.remove ?? []).slice(0, 5)) {
      const source = entityByName.get(r.source.toLowerCase());
      const target = entityByName.get(r.target.toLowerCase());
      if (!source || !target) continue;
      try {
        const allRels = await this.kgRepo.getRelationsForEntity(userId, source.id);
        const match = allRels.find(rel => rel.targetEntityId === target.id && rel.relationType === r.type);
        if (match) {
          await this.kgRepo.deleteRelation(match.id);
          this.logger.info({ source: r.source, target: r.target, type: r.type, reason: r.reason }, 'Relation removed by LLM');
        }
      } catch { /* non-critical */ }
    }

    return stats;
  }

  /**
   * Weekly chat analysis: extract implicit knowledge from recent user messages.
   * Called from Sunday maintenance. Uses LLM to find patterns, interests, implicit facts.
   */
  async analyzeRecentChats(userId: string, messages: Array<{ role: string; content: string }>): Promise<{ relations: number; newEntities: number; corrections: number }> {
    if (messages.length < 5) return { relations: 0, newEntities: 0, corrections: 0 };

    const allEntities = await this.kgRepo.getAllEntities(userId);
    const entityList = allEntities.map(e => {
      const extra = e.attributes?.realName ? ` (Realname: ${e.attributes.realName})` : '';
      return `- [${e.entityType}] "${e.name}"${extra}`;
    }).join('\n');

    // Identify User + children for prompt context (same as buildPrompt)
    const userEntity = allEntities.find(e => e.name === 'User' && e.entityType === 'person');
    const userRealName = userEntity?.attributes?.realName as string | undefined;
    const childEntities = allEntities.filter(e => e.entityType === 'person' && /^(sohn|tochter)\s/i.test(e.name));
    const childNames = childEntities.map(e => `"${e.name}"`).join(', ');

    const chatSample = messages.slice(0, 100).map(m =>
      `[${m.role}]: ${m.content.slice(0, 150)}`,
    ).join('\n');

    const prompt = `Du bist ein Knowledge-Graph-Analyst. Analysiere diese Chat-Konversationen und extrahiere IMPLIZITES Wissen das nicht explizit als Fakt gespeichert wurde.

WICHTIG — IDENTITÄT:
- "User" ist der Hauptbenutzer${userRealName ? ` (Realname: ${userRealName})` : ''}. Alle persönlichen Relationen (owns, works_at, monitors, prefers, dislikes, uses, subscribes_to) gehören zum "User" — NICHT zu seinen Kindern oder anderen Familienmitgliedern.
${childNames ? `- Kinder des Users: ${childNames}. Diese sind EIGENSTÄNDIGE Personen. Sie besitzen NICHT die Dinge des Users (Cryptos, Fahrzeuge, Wallbox etc.). Verwechsle sie NICHT mit dem User.` : ''}
- Entities mit ähnlichem Nachnamen sind NICHT dieselbe Person. "Linus Dohnal" ≠ "Markus Dohnal".

BESTEHENDE ENTITIES:
${entityList}

LETZTE CHAT-NACHRICHTEN:
${chatSample}

Finde:
1. NEUE Entities die in den Chats erwähnt aber noch nicht im KG sind (Personen, Orte, Produkte, Services)
2. RELATIONEN zwischen bestehenden Entities die aus dem Chat-Kontext hervorgehen
3. TYP-KORREKTUREN für falsch klassifizierte Entities

REGELN:
- Nur ECHTE Zusammenhänge, keine Spekulation
- KEINE Entities für Attribute (Geburtsdatum, Staatsbürgerschaft, Alter, Adresse) — nutze "corrections" mit attributes stattdessen. Beispiel: Person wohnt in Eichgraben → corrections: {"name":"Person","currentType":"person","newType":"person","attributes":{"livesIn":"Eichgraben"}} + relation Person→lives_in→Eichgraben + newEntity Eichgraben (location)
- KEINE same_as zwischen Personen mit verschiedenen Vornamen
- Wenn nichts gefunden: leere Arrays

Antworte als JSON:
{
  "relations": [{"source": "...", "target": "...", "type": "...", "reason": "..."}],
  "newEntities": [{"name": "...", "type": "...", "attributes": {}, "reason": "..."}],
  "corrections": [{"name": "...", "currentType": "...", "newType": "...", "attributes": {"key":"value"}, "reason": "..."}]
}`;

    const model = this.config.model ?? 'mistral-small-latest';
    try {
      const result = await this.callLLM(prompt, model);
      return this.applyResults(userId, result, allEntities);
    } catch (err) {
      this.logger.warn({ err }, 'Weekly chat analysis failed');
      return { relations: 0, newEntities: 0, corrections: 0 };
    }
  }
}
