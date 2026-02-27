import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { Database } from '../database.js';

let hasBetterSqlite3 = true;
try {
  const BetterSqlite3 = (await import('better-sqlite3')).default;
  const testDb = new BetterSqlite3(':memory:');
  testDb.close();
} catch {
  hasBetterSqlite3 = false;
}

describe.skipIf(!hasBetterSqlite3)('DocumentRepository', () => {
  let dbPath: string;
  let db: Database;

  afterEach(() => {
    try { db?.close(); } catch { /* ignore */ }
    if (dbPath && fs.existsSync(dbPath)) {
      try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
    }
  });

  async function setup() {
    const { Database } = await import('../database.js');
    const { DocumentRepository } = await import('./document-repository.js');
    dbPath = path.join(os.tmpdir(), `alfred-test-document-${Date.now()}.db`);
    db = new Database(dbPath);
    const repo = new DocumentRepository(db.getDb());
    return repo;
  }

  it('should create a document with correct fields', async () => {
    const repo = await setup();

    const doc = repo.createDocument('user-1', 'report.pdf', 'application/pdf', 102400);

    expect(doc).toBeDefined();
    expect(doc.id).toBeDefined();
    expect(typeof doc.id).toBe('string');
    expect(doc.userId).toBe('user-1');
    expect(doc.filename).toBe('report.pdf');
    expect(doc.mimeType).toBe('application/pdf');
    expect(doc.sizeBytes).toBe(102400);
    expect(doc.chunkCount).toBe(0);
    expect(doc.createdAt).toBeDefined();
  });

  it('should add chunks and retrieve them with getChunks', async () => {
    const repo = await setup();

    const doc = repo.createDocument('user-1', 'notes.txt', 'text/plain', 500);

    const chunk1 = repo.addChunk(doc.id, 0, 'First chunk of content', 'emb-1');
    const chunk2 = repo.addChunk(doc.id, 1, 'Second chunk of content', 'emb-2');
    const chunk3 = repo.addChunk(doc.id, 2, 'Third chunk of content');

    expect(chunk1.id).toBeDefined();
    expect(chunk1.documentId).toBe(doc.id);
    expect(chunk1.chunkIndex).toBe(0);
    expect(chunk1.content).toBe('First chunk of content');
    expect(chunk1.embeddingId).toBe('emb-1');

    const chunks = repo.getChunks(doc.id);

    expect(chunks.length).toBe(3);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[1].chunkIndex).toBe(1);
    expect(chunks[2].chunkIndex).toBe(2);
    expect(chunks[0].content).toBe('First chunk of content');
    expect(chunks[1].content).toBe('Second chunk of content');
    expect(chunks[2].content).toBe('Third chunk of content');
    expect(chunks[2].embeddingId).toBeUndefined();
  });

  it('should update chunk count', async () => {
    const repo = await setup();

    const doc = repo.createDocument('user-1', 'notes.txt', 'text/plain', 500);
    expect(doc.chunkCount).toBe(0);

    repo.addChunk(doc.id, 0, 'Chunk 1');
    repo.addChunk(doc.id, 1, 'Chunk 2');
    repo.updateChunkCount(doc.id, 2);

    const updated = repo.getDocument(doc.id);
    expect(updated).toBeDefined();
    expect(updated!.chunkCount).toBe(2);
  });

  it('should list documents by user', async () => {
    const repo = await setup();

    repo.createDocument('user-1', 'file1.txt', 'text/plain', 100);
    repo.createDocument('user-2', 'file2.txt', 'text/plain', 200);
    repo.createDocument('user-1', 'file3.pdf', 'application/pdf', 300);

    const user1Docs = repo.listByUser('user-1');
    const user2Docs = repo.listByUser('user-2');

    expect(user1Docs.length).toBe(2);
    expect(user2Docs.length).toBe(1);
    expect(user1Docs.every((d) => d.userId === 'user-1')).toBe(true);
    expect(user2Docs[0].userId).toBe('user-2');
  });

  it('should delete a document and its chunks', async () => {
    const repo = await setup();

    const doc = repo.createDocument('user-1', 'delete-me.txt', 'text/plain', 100);
    repo.addChunk(doc.id, 0, 'Chunk to delete', 'emb-del');
    repo.addChunk(doc.id, 1, 'Another chunk');

    repo.deleteDocument(doc.id);

    const found = repo.getDocument(doc.id);
    expect(found).toBeUndefined();

    const chunks = repo.getChunks(doc.id);
    expect(chunks.length).toBe(0);
  });

  it('should retrieve document by id via getDocument', async () => {
    const repo = await setup();

    const doc = repo.createDocument('user-1', 'findme.txt', 'text/plain', 42);
    const found = repo.getDocument(doc.id);

    expect(found).toBeDefined();
    expect(found!.id).toBe(doc.id);
    expect(found!.filename).toBe('findme.txt');
  });

  it('should return undefined for non-existent document', async () => {
    const repo = await setup();

    const found = repo.getDocument('non-existent-id');
    expect(found).toBeUndefined();
  });

  it('should retrieve chunks by embedding IDs', async () => {
    const repo = await setup();

    const doc = repo.createDocument('user-1', 'embed.txt', 'text/plain', 100);
    repo.addChunk(doc.id, 0, 'Chunk A', 'emb-a');
    repo.addChunk(doc.id, 1, 'Chunk B', 'emb-b');
    repo.addChunk(doc.id, 2, 'Chunk C', 'emb-c');

    const results = repo.getChunksByEmbeddingIds(['emb-a', 'emb-c']);

    expect(results.length).toBe(2);
    expect(results[0].embeddingId).toBe('emb-a');
    expect(results[1].embeddingId).toBe('emb-c');
  });

  it('should return empty array for getChunksByEmbeddingIds with empty input', async () => {
    const repo = await setup();

    const results = repo.getChunksByEmbeddingIds([]);
    expect(results).toEqual([]);
  });
});
