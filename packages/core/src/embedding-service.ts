import type { Logger } from 'pino';
import type { LLMProvider } from '@alfred/llm';
import type { EmbeddingRepository } from '@alfred/storage';
import type { MemoryEntry } from '@alfred/storage';

export interface SemanticSearchResult {
  key: string;
  value: string;
  category: string;
  score: number;
}

export class EmbeddingService {
  constructor(
    private readonly llm: LLMProvider,
    private readonly embeddingRepo: EmbeddingRepository,
    private readonly logger: Logger,
  ) {}

  /**
   * Check stored embeddings model against current provider and invalidate if mismatched.
   * Returns the number of deleted embeddings, or 0 if no mismatch.
   */
  async validateModelConsistency(currentModel: string): Promise<number> {
    const existingModel = await this.embeddingRepo.getDistinctModel();
    if (!existingModel || existingModel === currentModel) {
      return 0;
    }

    this.logger.warn(
      { oldModel: existingModel, newModel: currentModel },
      'Embedding model changed — invalidating old embeddings',
    );
    const deleted = await this.embeddingRepo.deleteAll();
    this.logger.info({ deleted }, 'Deleted stale embeddings');
    return deleted;
  }

  async embedAndStore(
    userId: string,
    content: string,
    sourceType: string,
    sourceId: string,
  ): Promise<string | undefined> {
    if (!this.llm.supportsEmbeddings()) {
      return undefined;
    }

    try {
      const result = await this.llm.embed(content);
      if (!result) return undefined;

      const entry = await this.embeddingRepo.store({
        userId,
        sourceType,
        sourceId,
        content,
        embedding: result.embedding,
        model: result.model,
        dimensions: result.dimensions,
      });

      this.logger.debug({ userId, sourceType, sourceId }, 'Embedding stored');
      return entry.id;
    } catch (err) {
      this.logger.error({ err, userId, sourceType, sourceId }, 'Failed to embed content');
      return undefined;
    }
  }

  async semanticSearch(
    userId: string,
    query: string,
    limit = 10,
  ): Promise<SemanticSearchResult[]> {
    if (!this.llm.supportsEmbeddings()) {
      return [];
    }

    try {
      const queryResult = await this.llm.embed(query);
      if (!queryResult) return [];

      const embeddings = await this.embeddingRepo.findByUser(userId);
      if (embeddings.length === 0) return [];

      // Compute cosine similarity
      const scored = embeddings.map(entry => {
        const score = this.cosineSimilarity(queryResult.embedding, entry.embedding);
        return { ...entry, score };
      });

      // Sort by similarity (highest first) and take top-N
      scored.sort((a, b) => b.score - a.score);
      const topResults = scored.slice(0, limit);

      return topResults.map(r => ({
        key: r.content.includes(':') ? r.content.split(':')[0].trim() : r.sourceId,
        value: r.content,
        category: r.sourceType,
        score: r.score,
      }));
    } catch (err) {
      this.logger.error({ err }, 'Semantic search failed');
      return [];
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }
}
