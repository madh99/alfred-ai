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
  /** v1495 — Kosinus-Abstand aus vectorSearch (pgvector); fehlt bei anderen Abfragen. */
  distance?: number;
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
  private pgvectorAvailable: boolean | null = null;

  constructor(private readonly adapter: AsyncDbAdapter) {}

  /**
   * pgvector-accelerated nearest neighbor search (PG only).
   * Falls back to null if pgvector is not available — caller should use JS-side cosine.
   */
  /** v1475 — sourceType filtert in der Datenbank (vorher: nächste N aller Arten, Dokumente gingen unter 4 000 Erinnerungen unter). */
  async vectorSearch(userId: string, queryEmbedding: number[], limit = 10, sourceType?: string): Promise<EmbeddingEntry[] | null> {
    if (this.adapter.type !== 'postgres') return null;

    // Check pgvector availability once
    if (this.pgvectorAvailable === null) {
      try {
        await this.adapter.execute('CREATE EXTENSION IF NOT EXISTS vector', []);
        // Migrate embedding column from BYTEA to vector if needed
        try {
          await this.adapter.execute(
            `ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS embedding_vec vector(${queryEmbedding.length})`,
            [],
          );
        } catch { /* column might already exist */ }
        this.pgvectorAvailable = true;
      } catch {
        this.pgvectorAvailable = false;
      }
    }
    if (!this.pgvectorAvailable) return null;

    try {
      // Ensure embedding_vec is populated for this user
      const needsBackfill = await this.adapter.queryOne(
        'SELECT 1 FROM embeddings WHERE user_id = ? AND embedding_vec IS NULL LIMIT 1',
        [userId],
      );
      if (needsBackfill) {
        // Backfill: convert BYTEA → vector for this user's embeddings
        const rows = await this.adapter.query(
          'SELECT id, embedding FROM embeddings WHERE user_id = ? AND embedding_vec IS NULL',
          [userId],
        ) as Record<string, unknown>[];
        for (const row of rows) {
          const blob = row.embedding as Buffer;
          const floats = Array.from(new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4));
          const vecStr = `[${floats.join(',')}]`;
          await this.adapter.execute(
            'UPDATE embeddings SET embedding_vec = ?::vector WHERE id = ?',
            [vecStr, row.id],
          );
        }
      }

      // pgvector cosine distance search
      const vecStr = `[${queryEmbedding.join(',')}]`;
      const results = await this.adapter.query(
        `SELECT *, embedding_vec <=> ?::vector AS distance FROM embeddings WHERE user_id = ? AND embedding_vec IS NOT NULL${sourceType ? ' AND source_type = ?' : ''} ORDER BY distance LIMIT ?`,
        sourceType ? [vecStr, userId, sourceType, limit] : [vecStr, userId, limit],
      ) as Record<string, unknown>[];

      return results.map(row => this.mapRow(row));
    } catch (err) {
      this.pgvectorAvailable = false;
      return null; // fallback to JS-side
    }
  }

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

      // If pgvector is available, also store as vector type for fast DB-side search
      if (this.pgvectorAvailable && this.adapter.type === 'postgres') {
        const vecStr = `[${input.embedding.join(',')}]`;
        await tx.execute('UPDATE embeddings SET embedding_vec = ?::vector WHERE id = ?', [vecStr, id]).catch(() => {});
      }
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

  async getDistinctModel(): Promise<string | null> {
    // Return any model that differs from the majority, or the only model if all are the same.
    // If multiple models exist, return the OLDEST one (most likely the stale one).
    const row = await this.adapter.queryOne(
      'SELECT model FROM embeddings ORDER BY created_at ASC LIMIT 1',
      [],
    ) as Record<string, unknown> | undefined;
    return row ? (row.model as string) : null;
  }

  /** v1495 — Einträge, deren Dimension nicht zur Probe des Anbieters passt (z. B. 256 Nullen statt 1 024 Werte). */
  async loescheAndereDimension(dimension: number): Promise<number> {
    const r = await this.adapter.execute('DELETE FROM embeddings WHERE dimensions <> ?', [dimension]);
    return r.changes;
  }

  /** v1495 — Nullvektoren (alle Bytes 0) tragen keine Bedeutung; jeder Abstand zu ihnen ist NaN. */
  async loescheNullvektoren(): Promise<number> {
    const sql = this.adapter.type === 'postgres'
      ? "DELETE FROM embeddings WHERE embedding = decode(repeat('00', octet_length(embedding)), 'hex')"
      : 'DELETE FROM embeddings WHERE embedding = zeroblob(length(embedding))';
    const r = await this.adapter.execute(sql, []);
    return r.changes;
  }

  /** v1495 — Memory-Embeddings, deren Memory es nicht mehr gibt (Quelle = Memory-ID). */
  async loescheVerwaisteMemoryEmbeddings(): Promise<number> {
    const r = await this.adapter.execute(
      "DELETE FROM embeddings WHERE source_type = 'memory' AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = embeddings.source_id)",
      [],
    );
    return r.changes;
  }

  /**
   * v1495 — pgvector-Spalte auf die echte Dimension bringen. Sie wurde beim ersten Suchlauf mit der Länge
   * des damaligen Abfragevektors angelegt (256); echte Vektoren passten danach nicht mehr hinein.
   * Neu angelegt wird sie nur, wenn die Dimension abweicht; vorhandene Einträge füllt vectorSearch nach.
   */
  async vektorSpalteAnpassen(dimension: number): Promise<boolean> {
    if (this.adapter.type !== 'postgres') return false;
    try {
      const row = await this.adapter.queryOne(
        "SELECT atttypmod FROM pg_attribute WHERE attrelid = 'embeddings'::regclass AND attname = 'embedding_vec' AND NOT attisdropped",
        [],
      ) as Record<string, unknown> | undefined;
      if (row && Number(row.atttypmod) === dimension) { this.pgvectorAvailable = true; return false; }
      await this.adapter.execute('CREATE EXTENSION IF NOT EXISTS vector', []);
      if (row) await this.adapter.execute('ALTER TABLE embeddings DROP COLUMN embedding_vec', []);
      await this.adapter.execute(`ALTER TABLE embeddings ADD COLUMN embedding_vec vector(${Math.trunc(dimension)})`, []);
      this.pgvectorAvailable = true; // neue Einträge schreiben den Vektor sofort mit
      return true;
    } catch {
      return false;
    }
  }

  /** v1495 — Memories ohne Embedding (Quelle = Memory-ID), für die Nachberechnung beim Start. */
  async listMemoriesOhneEmbedding(limit = 5000): Promise<Array<{ id: string; userId: string; key: string; value: string }>> {
    const rows = await this.adapter.query(
      "SELECT m.id, m.user_id, m.key, m.value FROM memories m WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.source_type = 'memory' AND e.source_id = m.id) ORDER BY m.updated_at DESC LIMIT ?",
      [limit],
    ) as Record<string, unknown>[];
    return rows.map(r => ({ id: r.id as string, userId: r.user_id as string, key: r.key as string, value: r.value as string }));
  }

  async deleteAll(): Promise<number> {
    const result = await this.adapter.execute('DELETE FROM embeddings', []);
    return result.changes;
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
      // v1495 — vorher verworfen: jeder pgvector-Treffer bekam dadurch die Ähnlichkeit 1,0
      ...(row.distance != null ? { distance: Number(row.distance) } : {}),
    };
  }
}
