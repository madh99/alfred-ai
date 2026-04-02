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
  attributes?: Record<string, unknown>;
  reason?: string;
}

interface LLMLinkingResult {
  relations?: LLMRelation[];
  newEntities?: LLMNewEntity[];
  corrections?: LLMCorrection[];
}

const VALID_RELATION_TYPES = new Set([
  'relates_to', 'used_for', 'caused_by', 'depends_on', 'part_of',
  'prepares_for', 'relevant_to', 'located_at', 'works_at', 'parent_of',
  'spouse', 'family', 'knows', 'owns', 'monitors', 'affects',
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

  constructor(
    private readonly kgRepo: KnowledgeGraphRepository,
    private readonly config: LLMLinkingConfig,
    private readonly logger: Logger,
    private readonly apiKey: string,
    private readonly baseUrl: string = 'https://api.mistral.ai/v1',
  ) {}

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
    const allEntities = await this.kgRepo.getAllEntities(userId);
    if (allEntities.length < 3) return { relations: 0, newEntities: 0, corrections: 0 };

    // Filter to entities changed since last run (or all for first run)
    const cutoff = this.lastRunAt ?? '2000-01-01T00:00:00Z';
    const maxPerPass = this.config.maxEntitiesPerPass ?? 30;
    const changed = allEntities
      .filter(e => e.lastSeenAt > cutoff || !this.lastRunAt)
      .slice(0, maxPerPass);

    if (changed.length === 0) {
      this.lastRunAt = new Date().toISOString();
      return { relations: 0, newEntities: 0, corrections: 0 };
    }

    // Build prompt
    const prompt = this.buildPrompt(changed, allEntities);

    // Call LLM
    const model = this.config.model ?? 'mistral-small-latest';
    let result: LLMLinkingResult;
    try {
      result = await this.callLLM(prompt, model);
    } catch (err) {
      this.logger.warn({ err }, 'LLM entity linking call failed');
      return { relations: 0, newEntities: 0, corrections: 0 };
    }

    // Apply results
    const stats = await this.applyResults(userId, result, allEntities);
    this.lastRunAt = new Date().toISOString();

    this.logger.info({ ...stats, entitiesProcessed: changed.length }, 'LLM entity linking completed');
    return stats;
  }

  private buildPrompt(changed: KGEntity[], all: KGEntity[]): string {
    const changedList = changed.map(e =>
      `- [${e.entityType}] "${e.name}"${e.attributes?.value ? ` — ${String(e.attributes.value).slice(0, 120)}` : ''}${e.attributes?.role ? ` (${e.attributes.role})` : ''}`,
    ).join('\n');

    const allList = all.map(e =>
      `- [${e.entityType}] "${e.name}"`,
    ).join('\n');

    return `Du bist ein Knowledge-Graph-Analyst. Analysiere die NEUEN/GEÄNDERTEN Entities und finde semantische Zusammenhänge zu ALLEN bestehenden Entities.

NEUE/GEÄNDERTE ENTITIES:
${changedList}

ALLE BESTEHENDEN ENTITIES:
${allList}

Antworte NUR als JSON-Objekt mit diesen 3 optionalen Arrays:

{
  "relations": [
    {"source": "Entity-Name A", "target": "Entity-Name B", "type": "relation_type", "reason": "Kurze Begründung"}
  ],
  "newEntities": [
    {"name": "Neuer Name", "type": "entity_type", "attributes": {"key": "value"}, "reason": "Warum erstellen"}
  ],
  "corrections": [
    {"name": "Bestehender Name", "currentType": "alter_typ", "newType": "neuer_typ", "attributes": {"key": "value"}, "reason": "Warum ändern"}
  ]
}

REGELN:
- Nur ECHTE semantische Zusammenhänge, KEINE Spekulation
- Relation-Typen: relates_to, used_for, caused_by, depends_on, part_of, prepares_for, relevant_to, located_at, works_at, parent_of, spouse, family, knows, owns, monitors, affects
- Entity-Typen: person, location, item, vehicle, event, organization, metric
- Nicht wiederholen was offensichtlich ist (gleicher Name = gleiche Entity)
- newEntities: nur wenn eine wichtige Entity fehlt die aus dem Kontext klar hervorgeht
- corrections: nur wenn der aktuelle Typ eindeutig falsch ist
- Wenn nichts zu tun: {"relations":[],"newEntities":[],"corrections":[]}`;
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

    // 1. Apply new relations
    for (const rel of (result.relations ?? []).slice(0, 20)) {
      if (!VALID_RELATION_TYPES.has(rel.type)) continue;
      const source = entityByName.get(rel.source.toLowerCase());
      const target = entityByName.get(rel.target.toLowerCase());
      if (source && target && source.id !== target.id) {
        await this.kgRepo.upsertRelation(userId, source.id, target.id, rel.type, rel.reason?.slice(0, 100), 'llm_linking');
        stats.relations++;
      }
    }

    // 2. Create new entities
    for (const ne of (result.newEntities ?? []).slice(0, 5)) {
      if (!VALID_ENTITY_TYPES.has(ne.type)) continue;
      if (entityByName.has(ne.name.toLowerCase())) continue; // already exists
      const entity = await this.kgRepo.upsertEntity(userId, ne.name, ne.type as any, ne.attributes ?? {}, 'llm_linking');
      entityByName.set(ne.name.toLowerCase(), entity);
      stats.newEntities++;
    }

    // 3. Apply corrections (type changes + attribute updates)
    for (const corr of (result.corrections ?? []).slice(0, 10)) {
      if (!VALID_ENTITY_TYPES.has(corr.newType)) continue;
      const existing = entityByName.get(corr.name.toLowerCase());
      if (!existing) continue;
      if (existing.entityType === corr.currentType && corr.newType !== corr.currentType) {
        // Update entity type + merge attributes
        const mergedAttrs = { ...existing.attributes, ...(corr.attributes ?? {}) };
        await this.kgRepo.updateEntityType(existing.id, corr.newType, mergedAttrs);
        stats.corrections++;
      }
    }

    return stats;
  }
}
