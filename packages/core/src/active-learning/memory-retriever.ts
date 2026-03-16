import type { Logger } from 'pino';
import type { MemoryRepository, MemoryEntry } from '@alfred/storage';
import type { EmbeddingService, SemanticSearchResult } from '../embedding-service.js';

export interface RetrievedMemory {
  key: string;
  value: string;
  category: string;
  type: string;
  score: number;
}

// 30-day half-life for temporal decay
const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
const LN2 = Math.LN2;

// Weight distribution
const KEYWORD_WEIGHT = 0.3;
const SEMANTIC_WEIGHT = 0.7;

// Diversity: max memories per type
const MAX_PER_TYPE = 3;

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
          if (!keywordSeen.has(m.id)) {
            keywordSeen.add(m.id);
            keywordResults.push(m);
          }
        }
      }

      // 2. Semantic search across all user IDs (only if embeddings available)
      let semanticResults: SemanticSearchResult[] = [];
      let hasSemanticSearch = false;
      if (this.embeddingService) {
        try {
          const semanticSeen = new Set<string>();
          for (const uid of userIds) {
            for (const r of await this.embeddingService.semanticSearch(uid, query, 30)) {
              if (!semanticSeen.has(r.key)) {
                semanticSeen.add(r.key);
                semanticResults.push(r);
              }
            }
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
          },
          score: combined,
        });

        // Track access
        await this.memoryRepo.recordAccess(mem.id);
      }

      // Score semantic results
      if (hasSemanticSearch) {
        for (const sr of semanticResults) {
          const semanticScore = sr.score * SEMANTIC_WEIGHT;

          // Find matching memory entry for metadata
          const existing = scored.get(sr.key);
          if (existing) {
            // Merge: add semantic score to existing keyword score
            existing.score += semanticScore;
            existing.memory.score = existing.score;
          } else {
            // Semantic-only result: try to find the memory for metadata
            const memEntry = await this.memoryRepo.recall(userId, sr.key);
            const combined = this.applyBoosts(
              semanticScore,
              memEntry || undefined,
            );

            scored.set(sr.key, {
              memory: {
                key: sr.key,
                value: sr.value,
                category: sr.category,
                type: memEntry?.type || 'general',
                score: combined,
              },
              score: combined,
            });

            if (memEntry) {
              await this.memoryRepo.recordAccess(memEntry.id);
            }
          }
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
        if (count >= MAX_PER_TYPE) continue;

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
