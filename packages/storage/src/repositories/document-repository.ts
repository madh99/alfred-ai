import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';
import type { Document, DocumentChunk } from '@alfred/types';

export class DocumentRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async createDocument(
    userId: string,
    filename: string,
    mimeType: string,
    sizeBytes: number,
    contentHash?: string,
  ): Promise<Document> {
    const id = randomUUID();
    const now = new Date().toISOString();

    await this.adapter.execute(
      'INSERT INTO documents (id, user_id, filename, mime_type, size_bytes, chunk_count, content_hash, visibility, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)',
      [id, userId, filename, mimeType, sizeBytes, contentHash ?? null, 'private', now],
    );

    return { id, userId, filename, mimeType, sizeBytes, chunkCount: 0, contentHash, visibility: 'private', createdAt: now };
  }

  async findByContentHash(userId: string, hash: string): Promise<Document | undefined> {
    const row = await this.adapter.queryOne(
      'SELECT * FROM documents WHERE user_id = ? AND content_hash = ? ORDER BY chunk_count DESC LIMIT 1',
      [userId, hash],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapDocumentRow(row) : undefined;
  }

  async updateChunkCount(documentId: string, count: number): Promise<void> {
    await this.adapter.execute(
      'UPDATE documents SET chunk_count = ? WHERE id = ?',
      [count, documentId],
    );
  }

  async addChunk(
    documentId: string,
    chunkIndex: number,
    content: string,
    embeddingId?: string,
  ): Promise<DocumentChunk> {
    const id = randomUUID();
    const now = new Date().toISOString();

    await this.adapter.execute(
      'INSERT INTO document_chunks (id, document_id, chunk_index, content, embedding_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, documentId, chunkIndex, content, embeddingId ?? null, now],
    );

    return { id, documentId, chunkIndex, content, embeddingId, createdAt: now };
  }

  async getDocument(id: string): Promise<Document | undefined> {
    const row = await this.adapter.queryOne('SELECT * FROM documents WHERE id = ?', [id]) as Record<string, unknown> | undefined;
    return row ? this.mapDocumentRow(row) : undefined;
  }

  async getChunks(documentId: string): Promise<DocumentChunk[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM document_chunks WHERE document_id = ? ORDER BY chunk_index ASC',
      [documentId],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapChunkRow(r));
  }

  async listByUser(userId: string): Promise<Document[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM documents WHERE user_id = ? ORDER BY created_at DESC',
      [userId],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapDocumentRow(r));
  }

  async setVisibility(id: string, visibility: 'private' | 'shared' | 'public'): Promise<void> {
    await this.adapter.execute('UPDATE documents SET visibility = ? WHERE id = ?', [visibility, id]);
  }

  /**
   * List documents accessible by a user: own + public + shared via shared_resources.
   */
  async listAccessible(userId: string, sharedDocIds?: string[]): Promise<Document[]> {
    const ownRows = await this.adapter.query(
      'SELECT * FROM documents WHERE user_id = ? ORDER BY created_at DESC',
      [userId],
    ) as Record<string, unknown>[];

    const publicRows = await this.adapter.query(
      'SELECT * FROM documents WHERE visibility = ? AND user_id != ? ORDER BY created_at DESC',
      ['public', userId],
    ) as Record<string, unknown>[];

    let sharedRows: Record<string, unknown>[] = [];
    if (sharedDocIds && sharedDocIds.length > 0) {
      const placeholders = sharedDocIds.map(() => '?').join(',');
      sharedRows = await this.adapter.query(
        `SELECT * FROM documents WHERE id IN (${placeholders}) AND user_id != ? ORDER BY created_at DESC`,
        [...sharedDocIds, userId],
      ) as Record<string, unknown>[];
    }

    const seen = new Set<string>();
    const result: Document[] = [];
    for (const rows of [ownRows, publicRows, sharedRows]) {
      for (const row of rows) {
        const id = row.id as string;
        if (!seen.has(id)) {
          seen.add(id);
          result.push(this.mapDocumentRow(row));
        }
      }
    }
    return result;
  }

  /**
   * Check if a user can access a document (owner, public, or shared).
   */
  async canAccess(documentId: string, userId: string, sharedDocIds?: string[]): Promise<boolean> {
    const doc = await this.getDocument(documentId);
    if (!doc) return false;
    if (doc.userId === userId) return true;
    if (doc.visibility === 'public') return true;
    if (sharedDocIds?.includes(documentId)) return true;
    return false;
  }

  async deleteDocument(id: string): Promise<void> {
    await this.adapter.transaction(async (tx) => {
      // Get embedding IDs from chunks before deleting them
      const chunks = await tx.query(
        'SELECT embedding_id FROM document_chunks WHERE document_id = ? AND embedding_id IS NOT NULL',
        [id],
      ) as { embedding_id: string }[];

      // Delete embeddings
      if (chunks.length > 0) {
        const embeddingIds = chunks.map(c => c.embedding_id);
        const placeholders = embeddingIds.map(() => '?').join(', ');
        await tx.execute(`DELETE FROM embeddings WHERE id IN (${placeholders})`, embeddingIds);
      }

      await tx.execute('DELETE FROM document_chunks WHERE document_id = ?', [id]);
      await tx.execute('DELETE FROM documents WHERE id = ?', [id]);
    });
  }

  async getChunksByEmbeddingIds(embeddingIds: string[]): Promise<DocumentChunk[]> {
    if (embeddingIds.length === 0) return [];

    const placeholders = embeddingIds.map(() => '?').join(', ');
    const rows = await this.adapter.query(
      `SELECT * FROM document_chunks WHERE embedding_id IN (${placeholders}) ORDER BY chunk_index ASC`,
      embeddingIds,
    ) as Record<string, unknown>[];
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
      contentHash: (row.content_hash as string) || undefined,
      visibility: (row.visibility as Document['visibility']) ?? 'private',
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
