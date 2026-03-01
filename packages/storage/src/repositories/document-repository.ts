import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Document, DocumentChunk } from '@alfred/types';

export class DocumentRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  createDocument(
    userId: string,
    filename: string,
    mimeType: string,
    sizeBytes: number,
  ): Document {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(
      'INSERT INTO documents (id, user_id, filename, mime_type, size_bytes, chunk_count, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    ).run(id, userId, filename, mimeType, sizeBytes, now);

    return { id, userId, filename, mimeType, sizeBytes, chunkCount: 0, createdAt: now };
  }

  updateChunkCount(documentId: string, count: number): void {
    this.db.prepare(
      'UPDATE documents SET chunk_count = ? WHERE id = ?',
    ).run(count, documentId);
  }

  addChunk(
    documentId: string,
    chunkIndex: number,
    content: string,
    embeddingId?: string,
  ): DocumentChunk {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(
      'INSERT INTO document_chunks (id, document_id, chunk_index, content, embedding_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, documentId, chunkIndex, content, embeddingId ?? null, now);

    return { id, documentId, chunkIndex, content, embeddingId, createdAt: now };
  }

  getDocument(id: string): Document | undefined {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapDocumentRow(row) : undefined;
  }

  getChunks(documentId: string): DocumentChunk[] {
    const rows = this.db.prepare(
      'SELECT * FROM document_chunks WHERE document_id = ? ORDER BY chunk_index ASC',
    ).all(documentId) as Record<string, unknown>[];
    return rows.map(r => this.mapChunkRow(r));
  }

  listByUser(userId: string): Document[] {
    const rows = this.db.prepare(
      'SELECT * FROM documents WHERE user_id = ? ORDER BY created_at DESC',
    ).all(userId) as Record<string, unknown>[];
    return rows.map(r => this.mapDocumentRow(r));
  }

  deleteDocument(id: string): void {
    const deleteAll = this.db.transaction(() => {
      // Get embedding IDs from chunks before deleting them
      const chunks = this.db.prepare(
        'SELECT embedding_id FROM document_chunks WHERE document_id = ? AND embedding_id IS NOT NULL'
      ).all(id) as { embedding_id: string }[];

      // Delete embeddings
      if (chunks.length > 0) {
        const embeddingIds = chunks.map(c => c.embedding_id);
        const placeholders = embeddingIds.map(() => '?').join(', ');
        this.db.prepare(`DELETE FROM embeddings WHERE id IN (${placeholders})`).run(...embeddingIds);
      }

      this.db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(id);
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    });
    deleteAll();
  }

  getChunksByEmbeddingIds(embeddingIds: string[]): DocumentChunk[] {
    if (embeddingIds.length === 0) return [];

    const placeholders = embeddingIds.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT * FROM document_chunks WHERE embedding_id IN (${placeholders}) ORDER BY chunk_index ASC`,
    ).all(...embeddingIds) as Record<string, unknown>[];
    return rows.map(r => this.mapChunkRow(r));
  }

  private mapDocumentRow(row: Record<string, unknown>): Document {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      filename: row.filename as string,
      mimeType: row.mime_type as string,
      sizeBytes: row.size_bytes as number,
      chunkCount: row.chunk_count as number,
      createdAt: row.created_at as string,
    };
  }

  private mapChunkRow(row: Record<string, unknown>): DocumentChunk {
    return {
      id: row.id as string,
      documentId: row.document_id as string,
      chunkIndex: row.chunk_index as number,
      content: row.content as string,
      embeddingId: (row.embedding_id as string) || undefined,
      createdAt: row.created_at as string,
    };
  }
}
