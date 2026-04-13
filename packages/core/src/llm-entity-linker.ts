import type { Logger } from 'pino';
import type { KnowledgeGraphRepository, KGEntity } from '@alfred/storage';
import type { LLMLinkingConfig } from '@alfred/types';

type UsageCallback = (service: string, model: string, inputTokens: number, outputTokens: number) => void;

interface LLMRelation {
  source: string;
  target: string;
  type: string;
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

// Known relation types: accepted at full strength (0.5).
// The LLM MAY propose new types not in this set — those are accepted at lower strength (0.3).
const KNOWN_RELATION_TYPES = new Set([
  // Core relations
  'relates_to', 'mentioned_with', 'used_for', 'caused_by', 'depends_on', 'part_of',
  'prepares_for', 'relevant_to', 'located_at', 'works_at', 'parent_of',
  'spouse', 'sibling', 'family', 'grandparent_of', 'aunt_uncle_of',
  'knows', 'owns', 'monitors', 'affects', 'plays_at', 'same_as',
  // Code-used types (extractors, cross-extractor, memories)
  'involves', 'sent', 'available_at', 'charges_at', 'home_location',
  'affects_cost', 'works_with', 'neighbor_of', 'has_pattern',
  'prefers', 'dislikes', 'neutral_on',
  // Activity/interest/skill relations
  'practices', 'interested_in', 'skilled_at', 'hobby_of',
  'teaches', 'coaches', 'studies', 'subscribes_to',
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

    return `Du bist ein Knowledge-Graph-Analyst. Analysiere die NEUEN/GEÄNDERTEN Entities und finde semantische Zusammenhänge. Prüfe auch ob BESTEHENDE RELATIONEN noch korrekt sind.${docContext ? `\n\nDOKUMENT-KONTEXT (Inhalt von gespeicherten Dokumenten):${docContext}` : ''}

NEUE/GEÄNDERTE ENTITIES:
${changedList}

ALLE BESTEHENDEN ENTITIES:
${allList}

BESTEHENDE RELATIONEN (Top 50):
${relList}

Antworte NUR als JSON-Objekt mit diesen 5 optionalen Arrays:

{
  "relations": [
    {"source": "Entity-Name A", "target": "Entity-Name B", "type": "relation_type", "reason": "Kurze Begründung"}
  ],
  "weaken": [
    {"source": "Entity-Name A", "target": "Entity-Name B", "type": "relation_type", "reason": "Warum veraltet/falsch"}
  ],
  "remove": [
    {"source": "Entity-Name A", "target": "Entity-Name B", "type": "relation_type", "reason": "Warum komplett falsch"}
  ],
  "newEntities": [
    {"name": "Neuer Name", "type": "entity_type", "attributes": {"key": "value"}, "reason": "Warum erstellen"}
  ],
  "corrections": [
    {"name": "Bestehender Name", "currentType": "alter_typ", "newType": "neuer_typ", "newName": "optional — neuer Name falls Entity-Name falsch ist", "attributes": {"key": "value"}, "reason": "Warum ändern"}
  ]
}

REGELN:
- Nur ECHTE semantische Zusammenhänge, KEINE Spekulation
- Relation-Typen (bevorzugt): mentioned_with, used_for, caused_by, depends_on, part_of, prepares_for, relevant_to, located_at, works_at, parent_of, spouse, sibling, family, grandparent_of, aunt_uncle_of, knows, owns, monitors, affects, plays_at, practices, interested_in, skilled_at, involves, prefers, dislikes, teaches, coaches, subscribes_to
- Du DARFST auch neue Relation-Typen erstellen wenn kein bestehender passt — englisch, snake_case, 3-30 Zeichen (z.B. "trains_at", "manages", "lives_near"). Neue Types starten mit niedrigerer Konfidenz.
- Entity-Typen: person, location, item, vehicle, event, organization, metric
- "weaken": nutze wenn eine bestehende Relation wahrscheinlich veraltet ist (z.B. alter Arbeitgeber, alte Adresse) — Strength wird halbiert
- "remove": nutze NUR wenn eine Relation eindeutig falsch ist (z.B. falsche Person-Zuordnung, offensichtlicher Extraktionsfehler)
- Prüfe die BESTEHENDEN RELATIONEN — gibt es widersprüchliche oder veraltete?
- Nicht wiederholen was offensichtlich ist (gleicher Name = gleiche Entity)
- KEINE Relations vorschlagen die in BESTEHENDE RELATIONEN schon existieren
- KEINE Relations zwischen zwei Organisationen außer "same_as" (gleiche Firma, anderer Name) oder "part_of" (Tochtergesellschaft). Organisationen die zufällig im selben Graph sind haben KEINE Beziehung zueinander!
- newEntities: nur wenn eine wichtige Entity fehlt die aus dem Kontext klar hervorgeht
- KEINE Entities erstellen die offensichtlich eine bereits existierende Entity unter anderem Namen beschreiben (z.B. wenn "User" einen Realnamen hat, keine separate Entity für diesen Namen erstellen — stattdessen zur User-Entity verlinken)
- Wenn eine Entity einen Realnamen-Attribut hat, betrachte diesen als Alias — Referenzen zu diesem Namen gehören zur existierenden Entity
- corrections: nur wenn der aktuelle Typ eindeutig falsch ist

TRANSITIVE INFERENZ (wichtig!):
- Wenn A parent_of B und A spouse C → C ist auch parent_of B
- Wenn A family(mother) B und B parent_of C → A ist grandparent_of C
- Wenn A parent_of B und A parent_of C → B und C sind siblings
- Wenn ein "Freund" eine Ehefrau hat → Freund spouse Ehefrau
- Wenn jemand bei einer Firma arbeitet → Person works_at Organization
- Prüfe ob bestehende Entities falsch typisiert sind

- Wenn nichts zu tun: {"relations":[],"weaken":[],"remove":[],"newEntities":[],"corrections":[]}`;
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
      signal: AbortSignal.timeout(30_000),
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
      // Validate relation type format (must be snake_case, 3-30 chars)
      if (!rel.type || !/^[a-z][a-z_]{2,29}$/.test(rel.type)) continue;
      const source = entityByName.get(rel.source.toLowerCase());
      const target = entityByName.get(rel.target.toLowerCase());
      if (!source || !target || source.id === target.id) continue;
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
      // Org↔Org: only allow same_as and part_of — never relates_to, used_for, etc.
      if (source.entityType === 'organization' && target.entityType === 'organization' && !['same_as', 'part_of'].includes(rel.type)) continue;
      // Skip relations between items that are clearly HA entities (LED, Switch, AP, etc.)
      if (source.entityType === 'item' && target.entityType === 'item' && source.sources.includes('smarthome') && target.sources.includes('smarthome')) continue;
      const relation = await this.kgRepo.upsertRelation(userId, source.id, target.id, rel.type, rel.reason?.slice(0, 100), 'llm_linking');
      // New/unknown relation types start weaker (0.3) — they need confirmation to grow
      if (!KNOWN_RELATION_TYPES.has(rel.type) && relation.strength >= 0.5) {
        await this.kgRepo.updateRelationStrength(relation.id, 0.3);
      }
      stats.relations++;
    }

    // 2. Create new entities (with blacklist check — LLM sometimes proposes
    //    common German words like "Zuhause", "Verbindungsprobleme" as entities)
    for (const ne of (result.newEntities ?? []).slice(0, 5)) {
      if (!VALID_ENTITY_TYPES.has(ne.type)) continue;
      if (entityByName.has(ne.name.toLowerCase())) continue; // already exists
      if (this.isBlacklistedEntityName(ne.name)) {
        this.logger.debug({ name: ne.name, type: ne.type }, 'LLM linker: skipped blacklisted entity name');
        continue;
      }
      const entity = await this.kgRepo.upsertEntity(userId, ne.name, ne.type as any, ne.attributes ?? {}, 'llm_linking');
      entityByName.set(ne.name.toLowerCase(), entity);
      stats.newEntities++;
    }

    // 3. Apply corrections (type changes + attribute updates)
    for (const corr of (result.corrections ?? []).slice(0, 10)) {
      const existing = entityByName.get(corr.name.toLowerCase());
      if (!existing) continue;

      // Type correction
      if (VALID_ENTITY_TYPES.has(corr.newType) && existing.entityType === corr.currentType && corr.newType !== corr.currentType) {
        const mergedAttrs = { ...existing.attributes, ...(corr.attributes ?? {}) };
        await this.kgRepo.updateEntityType(existing.id, corr.newType, mergedAttrs);
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
    const entityList = allEntities.map(e => `- [${e.entityType}] "${e.name}"`).join('\n');

    const chatSample = messages.slice(0, 100).map(m =>
      `[${m.role}]: ${m.content.slice(0, 150)}`,
    ).join('\n');

    const prompt = `Du bist ein Knowledge-Graph-Analyst. Analysiere diese Chat-Konversationen und extrahiere IMPLIZITES Wissen das nicht explizit als Fakt gespeichert wurde.

BESTEHENDE ENTITIES:
${entityList}

LETZTE CHAT-NACHRICHTEN:
${chatSample}

Finde:
1. NEUE Entities die in den Chats erwähnt aber noch nicht im KG sind (Personen, Orte, Produkte, Services)
2. RELATIONEN zwischen bestehenden Entities die aus dem Chat-Kontext hervorgehen
3. TYP-KORREKTUREN für falsch klassifizierte Entities

Antworte als JSON:
{
  "relations": [{"source": "...", "target": "...", "type": "...", "reason": "..."}],
  "newEntities": [{"name": "...", "type": "...", "attributes": {}, "reason": "..."}],
  "corrections": [{"name": "...", "currentType": "...", "newType": "...", "newName": "optional — neuer Name falls Entity-Name falsch ist", "reason": "..."}]
}

Nur ECHTE Zusammenhänge, keine Spekulation. Wenn nichts gefunden: leere Arrays.`;

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
