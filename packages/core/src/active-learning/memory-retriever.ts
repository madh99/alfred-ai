import type { Logger } from 'pino';
import { istInterneMemory } from './interne-memories.js';
import type { MemoryRepository, MemoryEntry } from '@alfred/storage';
import type { EmbeddingService } from '../embedding-service.js';

export interface RetrievedMemory {
  key: string;
  value: string;
  category: string;
  type: string;
  score: number;
  /** v1216 — Alter der Erinnerung für den Prompt (Vergangenheit sichtbar machen). */
  updatedAt?: string;
}

// 30-day half-life for temporal decay
const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
const LN2 = Math.LN2;

// Weight distribution
const KEYWORD_WEIGHT = 0.3;
const SEMANTIC_WEIGHT = 0.7;

// Diversity: max memories per type (type-specific limits)
const MAX_PER_TYPE: Record<string, number> = {
  entity: 8,
  fact: 8,
  rule: 10,
  connection: 5,
  pattern: 5,
  general: 5,
  feedback: 3,
  preference: 3,
};
const DEFAULT_MAX_PER_TYPE = 5;

export class MemoryRetriever {
  constructor(
    private readonly memoryRepo: MemoryRepository,
    private readonly logger: Logger,
    private readonly embeddingService?: EmbeddingService,
  ) {}

  /**
   * Hybrid retrieval combining keyword search, semantic search, and temporal decay.
   * Graceful degradation: without embeddings → 100% keyword score.
   */
  async retrieve(userId: string, query: string, limit = 15, additionalUserIds?: string[]): Promise<RetrievedMemory[]> {
    // Build list of all user IDs to search (primary + linked platform IDs)
    const userIds = [userId];
    if (additionalUserIds) {
      for (const id of additionalUserIds) {
        if (id !== userId) userIds.push(id);
      }
    }

    try {

      // 1. Keyword search across all user IDs (always available)
      const keywordSeen = new Set<string>();
      const keywordResults: MemoryEntry[] = [];
      for (const uid of userIds) {
        for (const m of await this.memoryRepo.keywordSearch(uid, query, 30)) {
          if (istInterneMemory(m.key)) continue; // v1216 — Dedup-Marker/Zähler sind kein Wissen
          if (!keywordSeen.has(m.id)) {
            keywordSeen.add(m.id);
            keywordResults.push(m);
          }
        }
      }

      // 2. Semantic search across all user IDs (only if embeddings available)
      // v1495 — nur Memory-Embeddings, aufgelöst über die Quell-ID (Memory-ID) mit dem aktuellen Inhalt.
      // Vorher kamen alle Quellarten (offene Punkte, Social-Items) als „Memory" zurück, der Schlüssel wurde aus
      // dem Text geraten, und Treffer ohne Memory zählten mit 0,7 ohne Altersabzug als Typ „general" —
      // Realfall 18.10.: sie belegten alle 5 general-Plätze, die Stromrechnungen fielen heraus.
      const semanticResults: Array<{ memory: MemoryEntry; score: number }> = [];
      let hasSemanticSearch = false;
      if (this.embeddingService) {
        try {
          const treffer: Array<{ sourceId: string; score: number }> = [];
          const gesehen = new Set<string>();
          for (const uid of userIds) {
            for (const r of await this.embeddingService.semanticSearchByType(uid, query, 'memory', 30, 0)) {
              if (!gesehen.has(r.sourceId)) { gesehen.add(r.sourceId); treffer.push(r); }
            }
          }
          const memories = new Map((await this.memoryRepo.getByIds(treffer.map(t => t.sourceId))).map(m => [m.id, m]));
          for (const t of treffer) {
            const memory = memories.get(t.sourceId);
            if (!memory) continue; // verwaistes Embedding
            if (istInterneMemory(memory.key)) continue; // v1216
            semanticResults.push({ memory, score: t.score });
          }
          hasSemanticSearch = semanticResults.length > 0;
        } catch (err) {
          this.logger.debug({ err }, 'Semantic search failed, falling back to keyword-only');
        }
      }

      // 3. Score and merge
      const scored = new Map<string, { memory: RetrievedMemory; score: number }>();

      // Score keyword results
      const maxKeywordIdx = keywordResults.length;
      for (let i = 0; i < keywordResults.length; i++) {
        const mem = keywordResults[i];
        // Rank-based score: first result = 1.0, linear decay
        const keywordScore = maxKeywordIdx > 0 ? 1 - (i / maxKeywordIdx) : 0;
        const weight = hasSemanticSearch ? KEYWORD_WEIGHT : 1.0;

        const combined = this.applyBoosts(
          keywordScore * weight,
          mem,
        );

        scored.set(mem.key, {
          memory: {
            key: mem.key,
            value: mem.value,
            category: mem.category,
            type: mem.type,
            score: combined,
            updatedAt: mem.updatedAt, // v1216
          },
          score: combined,
        });

        // Track access
        await this.memoryRepo.recordAccess(mem.id);
      }

      // Score semantic results
      if (hasSemanticSearch) {
        for (const sr of semanticResults) {
          const mem = sr.memory;
          const existing = scored.get(mem.key);
          if (existing) {
            // Merge: add semantic score to existing keyword score
            existing.score += sr.score * SEMANTIC_WEIGHT;
            existing.memory.score = existing.score;
            continue;
          }
          const semanticScore = this.applyBoosts(sr.score * SEMANTIC_WEIGHT, mem);
          scored.set(mem.key, {
            memory: {
              key: mem.key,
              value: mem.value,
              category: mem.category,
              type: mem.type,
              score: semanticScore,
              updatedAt: mem.updatedAt, // v1216
            },
            score: semanticScore,
          });
          await this.memoryRepo.recordAccess(mem.id);
        }
      }

      // 4. Sort by score
      const allResults = Array.from(scored.values())
        .sort((a, b) => b.score - a.score);

      // 5. Apply diversity limit: max N per type
      const typeCounts = new Map<string, number>();
      const diverseResults: RetrievedMemory[] = [];

      for (const { memory } of allResults) {
        const count = typeCounts.get(memory.type) || 0;
        const maxForType = MAX_PER_TYPE[memory.type] ?? DEFAULT_MAX_PER_TYPE;
        if (count >= maxForType) continue;

        typeCounts.set(memory.type, count + 1);
        diverseResults.push(memory);

        if (diverseResults.length >= limit) break;
      }

      this.logger.debug(
        {
          keywordCount: keywordResults.length,
          semanticCount: semanticResults.length,
          resultCount: diverseResults.length,
          hasSemanticSearch,
        },
        'Hybrid memory retrieval complete',
      );

      return diverseResults;
    } catch (err) {
      this.logger.error({ err }, 'Memory retrieval failed');
      // Fallback: return recent memories across all user IDs
      const fallbackSeen = new Set<string>();
      const fallback: RetrievedMemory[] = [];
      for (const uid of userIds) {
        for (const m of await this.memoryRepo.getRecentForPrompt(uid, limit)) {
          if (!fallbackSeen.has(m.key)) {
            fallbackSeen.add(m.key);
            fallback.push({ key: m.key, value: m.value, category: m.category, type: m.type, score: 0 });
          }
        }
      }
      return fallback.slice(0, limit);
    }
  }

  private applyBoosts(baseScore: number, memory?: MemoryEntry): number {
    let score = baseScore;

    if (memory) {
      // Confidence boost: score *= (0.5 + 0.5 * confidence)
      score *= 0.5 + 0.5 * memory.confidence;

      // Temporal decay: exponential decay with 30-day half-life
      const updatedAt = new Date(memory.updatedAt).getTime();
      const ageMs = Date.now() - updatedAt;
      const decay = Math.exp((-LN2 * ageMs) / HALF_LIFE_MS);
      score *= decay;
    }

    return score;
  }
}
