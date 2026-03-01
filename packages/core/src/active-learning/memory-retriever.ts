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
  async retrieve(userId: string, query: string, limit = 15): Promise<RetrievedMemory[]> {
    try {
      // 1. Keyword search (always available)
      const keywordResults = this.memoryRepo.keywordSearch(userId, query, 30);

      // 2. Semantic search (only if embeddings available)
      let semanticResults: SemanticSearchResult[] = [];
      let hasSemanticSearch = false;
      if (this.embeddingService) {
        try {
          semanticResults = await this.embeddingService.semanticSearch(userId, query, 30);
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
        this.memoryRepo.recordAccess(mem.id);
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
            const memEntry = this.memoryRepo.recall(userId, sr.key);
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
              this.memoryRepo.recordAccess(memEntry.id);
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
      // Fallback: return recent memories
      return this.memoryRepo.getRecentForPrompt(userId, limit).map(m => ({
        key: m.key,
        value: m.value,
        category: m.category,
        type: m.type,
        score: 0,
      }));
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
