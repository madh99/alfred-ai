import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

export interface EmbeddingEntry {
  id: string;
  userId: string;
  sourceType: string;
  sourceId: string;
  content: string;
  embedding: number[];
  model: string;
  dimensions: number;
  createdAt: string;
}

export interface StoreEmbeddingInput {
  userId: string;
  sourceType: string;
  sourceId: string;
  content: string;
  embedding: number[];
  model: string;
  dimensions: number;
}

export class EmbeddingRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async store(input: StoreEmbeddingInput): Promise<EmbeddingEntry> {
    const id = randomUUID();
    const now = new Date().toISOString();

    // Store embedding as Float32Array buffer
    const buffer = Buffer.from(new Float32Array(input.embedding).buffer);

    await this.adapter.transaction(async (tx) => {
      // Delete existing embedding for same source
      await tx.execute(
        'DELETE FROM embeddings WHERE user_id = ? AND source_type = ? AND source_id = ?',
        [input.userId, input.sourceType, input.sourceId],
      );

      await tx.execute(
        'INSERT INTO embeddings (id, user_id, source_type, source_id, content, embedding, model, dimensions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, input.userId, input.sourceType, input.sourceId, input.content, buffer, input.model, input.dimensions, now],
      );
    });

    return {
      id,
      userId: input.userId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      content: input.content,
      embedding: input.embedding,
      model: input.model,
      dimensions: input.dimensions,
      createdAt: now,
    };
  }

  async findByUser(userId: string): Promise<EmbeddingEntry[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM embeddings WHERE user_id = ? ORDER BY created_at DESC',
      [userId],
    ) as Record<string, unknown>[];

    return rows.map(row => this.mapRow(row));
  }

  async findBySource(sourceType: string, sourceId: string, userId?: string): Promise<EmbeddingEntry | undefined> {
    const sql = userId
      ? 'SELECT * FROM embeddings WHERE source_type = ? AND source_id = ? AND user_id = ?'
      : 'SELECT * FROM embeddings WHERE source_type = ? AND source_id = ?';
    const params = userId ? [sourceType, sourceId, userId] : [sourceType, sourceId];
    const row = await this.adapter.queryOne(sql, params) as Record<string, unknown> | undefined;

    if (!row) return undefined;
    return this.mapRow(row);
  }

  async delete(sourceType: string, sourceId: string, userId?: string): Promise<boolean> {
    const sql = userId
      ? 'DELETE FROM embeddings WHERE source_type = ? AND source_id = ? AND user_id = ?'
      : 'DELETE FROM embeddings WHERE source_type = ? AND source_id = ?';
    const params = userId ? [sourceType, sourceId, userId] : [sourceType, sourceId];
    const result = await this.adapter.execute(sql, params);
    return result.changes > 0;
  }

  private mapRow(row: Record<string, unknown>): EmbeddingEntry {
    const blob = row.embedding as Buffer;
    const float32 = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    const embedding = Array.from(float32);

    return {
      id: row.id as string,
      userId: row.user_id as string,
      sourceType: row.source_type as string,
      sourceId: row.source_id as string,
      content: row.content as string,
      embedding,
      model: row.model as string,
      dimensions: row.dimensions as number,
      createdAt: row.created_at as string,
    };
  }
}
