import type BetterSqlite3 from 'better-sqlite3';
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
  constructor(private readonly db: BetterSqlite3.Database) {}

  store(input: StoreEmbeddingInput): EmbeddingEntry {
    const id = randomUUID();
    const now = new Date().toISOString();

    // Store embedding as Float32Array buffer
    const buffer = Buffer.from(new Float32Array(input.embedding).buffer);

    const upsert = this.db.transaction(() => {
      // Delete existing embedding for same source
      this.db.prepare(
        'DELETE FROM embeddings WHERE user_id = ? AND source_type = ? AND source_id = ?',
      ).run(input.userId, input.sourceType, input.sourceId);

      this.db.prepare(
        'INSERT INTO embeddings (id, user_id, source_type, source_id, content, embedding, model, dimensions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, input.userId, input.sourceType, input.sourceId, input.content, buffer, input.model, input.dimensions, now);
    });
    upsert();

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

  findByUser(userId: string): EmbeddingEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM embeddings WHERE user_id = ? ORDER BY created_at DESC',
    ).all(userId) as Record<string, unknown>[];

    return rows.map(row => this.mapRow(row));
  }

  findBySource(sourceType: string, sourceId: string): EmbeddingEntry | undefined {
    const row = this.db.prepare(
      'SELECT * FROM embeddings WHERE source_type = ? AND source_id = ?',
    ).get(sourceType, sourceId) as Record<string, unknown> | undefined;

    if (!row) return undefined;
    return this.mapRow(row);
  }

  delete(sourceType: string, sourceId: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM embeddings WHERE source_type = ? AND source_id = ?',
    ).run(sourceType, sourceId);
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
