import type { Logger } from 'pino';
import type { LLMProvider } from '@alfred/llm';
import type { MemoryRepository, MemoryEntry, EmbeddingRepository } from '@alfred/storage';
import type { EmbeddingService } from '../embedding-service.js';
import { resolveRelativeDates, extractRelevantUntil, extractSourceEventRefs } from '@alfred/skills';
import { INTERNAL_MEMORY_KEY_PREFIXES } from '../knowledge-graph.js';

const MIGRATION_MARKER_KEY = '_alfred_internal_migration_v582_dates_done';

// v1142 — H3: Das LLM erfindet KEINEN Key mehr (der Realfall
// kg_connection_{deutschland,österreich,linz,wien} → „kg_connection_dach_cities"
// presste vier verschiedene Orts-Verknüpfungen zu Brei und zerstörte nebenbei
// Präfix-basierte Dedup-Marker). Der Key kommt deterministisch aus der Gruppe,
// das LLM fasst nur den INHALT zusammen.
const MERGE_PROMPT = `You are a memory consolidation system. Merge these similar memories into one concise entry.

Memories to merge:
{MEMORIES}

Return a single JSON object with: {"value": "merged concise value"}
Return ONLY valid JSON, no explanation.`;

/**
 * v1142 — H3: Schutzliste für die Konsolidierung. Zusätzlich zu entity/fact/
 * rule/manual sind jetzt geschützt: relationship (Familien-Wissen!), connection,
 * feedback (Dedup-Marker wie insight_delivered:*), pattern (H4 dedupliziert
 * deterministisch) und ALLE internen Alfred-Keys.
 */
export function istVorKonsolidierungGeschuetzt(m: Pick<MemoryEntry, 'type' | 'source' | 'key'>): boolean {
  if (m.source === 'manual') return true;
  if (['entity', 'fact', 'rule', 'relationship', 'connection', 'feedback', 'pattern'].includes(m.type)) return true;
  return INTERNAL_MEMORY_KEY_PREFIXES.test(m.key);
}

/**
 * v1142 — H3: deterministischer Merge-Key — der Eintrag mit der höchsten
 * Confidence gewinnt (Tie-Break: jüngstes updatedAt, dann Key alphabetisch).
 */
export function waehleMergeKey(group: Array<Pick<MemoryEntry, 'key' | 'confidence' | 'updatedAt' | 'category'>>): { key: string; category: string } {
  const gewinner = [...group].sort((a, b) =>
    (b.confidence - a.confidence)
    || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))
    || a.key.localeCompare(b.key))[0];
  return { key: gewinner.key, category: gewinner.category };
}

export class MemoryConsolidator {
  private embeddingRepo?: EmbeddingRepository;

  constructor(
    private readonly llm: LLMProvider,
    private readonly memoryRepo: MemoryRepository,
    private readonly logger: Logger,
  ) {}

  private embeddingService?: EmbeddingService;

  /** Set optional embedding repo for cleanup after memory deletion. */
  setEmbeddingRepo(repo: EmbeddingRepository): void { this.embeddingRepo = repo; }

  /** Set optional embedding service for semantic similarity grouping. */
  setEmbeddingService(svc: EmbeddingService): void { this.embeddingService = svc; }

  /**
   * One-shot migration: backfill `relevant_until`, `source_event_refs`, and re-resolve
   * relative-date phrases on legacy memories that were stored before the resolver landed.
   *
   * Idempotent: marker memory `_alfred_internal_migration_v582_dates_done` prevents re-runs.
   * Safe to call on every startup — bails out early if already done.
   *
   * Anchor for date resolution: each memory's own `updated_at` (= last write time of the text).
   */
  async migrateLegacyMemoriesV582(userId: string, timezone?: string): Promise<{ resolved: number; relevantUntilSet: number; refsSet: number; resolvedExpirySet: number }> {
    const stats = { resolved: 0, relevantUntilSet: 0, refsSet: 0, resolvedExpirySet: 0 };

    try {
      const marker = await this.memoryRepo.recall(userId, MIGRATION_MARKER_KEY);
      if (marker) return stats; // already migrated

      const all = await this.memoryRepo.getAllForUser(userId);
      for (const m of all) {
        if (m.key === MIGRATION_MARKER_KEY) continue;

        // 1. Re-resolve relative-date phrases against memory's own updated_at
        const updatedDate = m.updatedAt ? new Date(m.updatedAt) : new Date();
        const newValue = resolveRelativeDates(m.value, updatedDate, timezone);
        if (newValue !== m.value) {
          await this.memoryRepo.updateValue(m.userId, m.key, newValue);
          stats.resolved++;
        }

        // 2. Extract relevant_until from the (now annotated) value
        if (!m.relevantUntil) {
          const ru = extractRelevantUntil(newValue);
          if (ru) {
            await this.memoryRepo.setRelevantUntil(m.userId, m.key, `${ru}T23:59:59Z`);
            stats.relevantUntilSet++;
          }
        }

        // 3. Extract source_event_refs from the value
        if (!m.sourceEventRefs || m.sourceEventRefs.length === 0) {
          const refs = extractSourceEventRefs(newValue);
          if (refs.length > 0) {
            await this.memoryRepo.setSourceEventRefs(m.userId, m.key, refs);
            stats.refsSet++;
          }
        }

        // 4. Auto-expiry for legacy `_resolved` corrections without expires_at: 30 days from now
        //    (giving them a sane lifetime rather than retroactive expiry).
        if (m.type === 'correction' && m.key.endsWith('_resolved') && !m.expiresAt) {
          const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          await this.memoryRepo.setExpiry(m.userId, m.key, expiresAt);
          stats.resolvedExpirySet++;
        }
      }

      // Set marker so we never run again
      await this.memoryRepo.saveWithMetadata(
        userId, MIGRATION_MARKER_KEY,
        new Date().toISOString(),
        'system', 'general', 1.0, 'auto',
      );

      this.logger.info({ userId, ...stats }, 'Legacy memory migration v582 completed');
    } catch (err) {
      this.logger.warn({ err, userId }, 'Legacy memory migration v582 failed (will retry on next start)');
    }

    return stats;
  }

  /**
   * Run consolidation for a user:
   * 1. Delete stale low-confidence memories (older than staleDays)
   * 2. Find and merge similar memories via LLM
   */
  async consolidate(
    userId: string,
    staleDays = 60,
    staleMaxConfidence = 0.5,
  ): Promise<{ deleted: number; merged: number }> {
    let deleted = 0;
    let merged = 0;

    // 1. Delete stale memories
    try {
      const stale = await this.memoryRepo.findStale(userId, staleDays, staleMaxConfidence);
      if (stale.length > 0) {
        const staleIds = stale.map(m => m.id);
        deleted = await this.memoryRepo.deleteByIds(staleIds);
        // Clean up orphaned embeddings
        if (this.embeddingRepo) {
          for (const id of staleIds) { await this.embeddingRepo.delete('memory', id, userId).catch(() => {}); }
        }
        this.logger.info({ userId, deleted }, 'Deleted stale memories');
      }
    } catch (err) {
      this.logger.error({ err }, 'Failed to delete stale memories');
    }

    // 1a. Pair-cleanup: when a `_resolved` correction exists, delete its original counterpart.
    //     Two-stage matching: exact-prefix first, fallback to keyword overlap (≥3 shared, ≥5 chars).
    try {
      const corrections = await this.memoryRepo.getByType(userId, 'correction', 100);
      const resolved = corrections.filter(c => c.key.endsWith('_resolved'));
      if (resolved.length > 0) {
        for (const r of resolved) {
          // Stage 1: exact prefix match — strip "_resolved" from key
          const expectedOriginalKey = r.key.slice(0, -'_resolved'.length);
          const exactMatch = corrections.find(c => c.key === expectedOriginalKey);
          if (exactMatch) {
            await this.memoryRepo.deleteByIds([exactMatch.id], userId);
            if (this.embeddingRepo) await this.embeddingRepo.delete('memory', exactMatch.id, userId).catch(() => {});
            deleted++;
            this.logger.info({ userId, resolved: r.key, deleted: exactMatch.key }, 'Pair-cleanup: deleted original correction (exact match)');
            continue;
          }
          // Stage 2: keyword overlap on key tokens (≥3 shared, ≥5 chars)
          const rTokens = r.key.replace(/_resolved$/, '').split('_').filter(t => t.length >= 5);
          if (rTokens.length < 3) continue; // not enough specificity for safe match
          for (const c of corrections) {
            if (c.id === r.id || c.key.endsWith('_resolved')) continue;
            const cTokens = c.key.split('_').filter(t => t.length >= 5);
            const shared = rTokens.filter(t => cTokens.includes(t));
            if (shared.length >= 3) {
              await this.memoryRepo.deleteByIds([c.id], userId);
              if (this.embeddingRepo) await this.embeddingRepo.delete('memory', c.id, userId).catch(() => {});
              deleted++;
              this.logger.info({ userId, resolved: r.key, deleted: c.key, shared }, 'Pair-cleanup: deleted original correction (keyword match)');
              break;
            }
          }
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'Failed to run correction pair-cleanup');
    }

    // 1b. Delete low-confidence rule memories older than 30 days
    try {
      const ruleCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const rules = await this.memoryRepo.getByType(userId, 'rule', 100);
      const expiredRules = rules.filter(
        r => r.confidence < 0.3 && r.updatedAt < ruleCutoff,
      );
      if (expiredRules.length > 0) {
        const ruleIds = expiredRules.map(r => r.id);
        const ruleDeleted = await this.memoryRepo.deleteByIds(ruleIds);
        if (this.embeddingRepo) {
          for (const id of ruleIds) { await this.embeddingRepo.delete('memory', id, userId).catch(() => {}); }
        }
        deleted += ruleDeleted;
        this.logger.info(
          { userId, ruleDeleted, keys: expiredRules.map(r => r.key) },
          'Deleted expired low-confidence rules',
        );
      }
    } catch (err) {
      this.logger.error({ err }, 'Failed to delete expired rules');
    }

    // 2. Find and merge similar memories
    try {
      const allMemories = await this.memoryRepo.listAll(userId);
      const groups = this.findSimilarGroups(allMemories);

      for (const group of groups) {
        try {
          const mergeResult = await this.mergeGroup(group);
          if (mergeResult) {
            // Save merged entry FIRST (keep highest confidence from the group)
            const maxConfidence = Math.max(...group.map(m => m.confidence));
            await this.memoryRepo.saveWithMetadata(
              userId,
              mergeResult.key,
              mergeResult.value,
              mergeResult.category,
              group[0].type,
              maxConfidence,
              'auto',
            );
            // Then delete old entries + orphaned embeddings
            const groupIds = group.map(m => m.id);
            await this.memoryRepo.deleteByIds(groupIds);
            if (this.embeddingRepo) {
              for (const id of groupIds) { await this.embeddingRepo.delete('memory', id, userId).catch(() => {}); }
            }
            merged++;
            this.logger.info(
              { mergedKeys: group.map(m => m.key), newKey: mergeResult.key },
              'Merged similar memories',
            );
          }
        } catch (err) {
          this.logger.warn({ err, keys: group.map(m => m.key) }, 'Failed to merge memory group');
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'Failed to find similar memories for merging');
    }

    return { deleted, merged };
  }

  /**
   * Find groups of similar memories using Jaccard similarity on key tokens
   * + optional semantic similarity on values (when EmbeddingService is available).
   */
  private findSimilarGroups(memories: MemoryEntry[]): MemoryEntry[][] {
    // v1142 — H3: erweiterte Schutzliste (relationship/connection/feedback/
    // pattern + interne Keys) statt nur entity/fact/rule/manual.
    const candidates = memories.filter(m => !istVorKonsolidierungGeschuetzt(m));

    const groups: MemoryEntry[][] = [];
    const used = new Set<string>();

    for (let i = 0; i < candidates.length; i++) {
      if (used.has(candidates[i].id)) continue;

      const group = [candidates[i]];
      const tokensA = this.tokenize(candidates[i].key);
      const valueTokensA = this.tokenize(candidates[i].value);

      for (let j = i + 1; j < candidates.length; j++) {
        if (used.has(candidates[j].id)) continue;
        // v1142 — H3: nur Gleiches mit Gleichem mergen (Typ UND Kategorie)
        if (candidates[j].type !== candidates[i].type || candidates[j].category !== candidates[i].category) continue;

        const tokensB = this.tokenize(candidates[j].key);
        const keySim = this.jaccardSimilarity(tokensA, tokensB);

        // Also check value similarity for memories with different keys but similar content
        const valueTokensB = this.tokenize(candidates[j].value);
        const valueSim = this.jaccardSimilarity(valueTokensA, valueTokensB);

        // Match if keys are similar (≥0.5) OR values are very similar (≥0.7)
        if (keySim >= 0.5 || valueSim >= 0.7) {
          group.push(candidates[j]);
        }
      }

      if (group.length >= 2) {
        for (const m of group) used.add(m.id);
        groups.push(group);
      }
    }

    return groups;
  }

  private tokenize(text: string): Set<string> {
    return new Set(text.toLowerCase().split(/[\s_\-]+/).filter(t => t.length >= 2));
  }

  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let intersection = 0;
    for (const token of a) {
      if (b.has(token)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  private async mergeGroup(
    group: MemoryEntry[],
  ): Promise<{ key: string; value: string; category: string } | null> {
    const memoriesText = group
      .map(m => `- ${m.key}: ${m.value} [${m.category}]`)
      .join('\n');

    const prompt = MERGE_PROMPT.replace('{MEMORIES}', memoriesText);

    try {
      const response = await this.llm.complete({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        tier: 'fast',
        maxTokens: 256,
      });

      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      if (!parsed.value) return null;

      // v1142 — H3: Key/Kategorie deterministisch aus der Gruppe, nie vom LLM
      const { key, category } = waehleMergeKey(group);
      return { key, category, value: String(parsed.value) };
    } catch (err) {
      this.logger.debug({ err }, 'LLM merge failed');
      return null;
    }
  }
}
