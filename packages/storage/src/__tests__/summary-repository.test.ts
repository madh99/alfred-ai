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

describe.skipIf(!hasBetterSqlite3)('SummaryRepository', () => {
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
    const { SummaryRepository } = await import('../repositories/summary-repository.js');
    dbPath = path.join(os.tmpdir(), `alfred-test-summary-${Date.now()}.db`);
    db = new Database(dbPath);
    const repo = new SummaryRepository(db.getDb());
    return repo;
  }

  it('get() returns undefined for non-existent id', async () => {
    const repo = await setup();
    expect(repo.get('non-existent')).toBeUndefined();
  });

  it('upsert() inserts new entry', async () => {
    const repo = await setup();
    repo.upsert({
      conversationId: 'conv-1',
      summary: 'Test summary',
      messageCount: 5,
      lastUserMessage: 'hello',
      lastAssistantMessage: 'hi',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const result = repo.get('conv-1');
    expect(result).toBeDefined();
    expect(result!.summary).toBe('Test summary');
    expect(result!.messageCount).toBe(5);
    expect(result!.lastUserMessage).toBe('hello');
  });

  it('upsert() updates existing entry (ON CONFLICT)', async () => {
    const repo = await setup();
    repo.upsert({
      conversationId: 'conv-1',
      summary: 'First summary',
      messageCount: 5,
      updatedAt: '2026-01-01T00:00:00Z',
    });

    repo.upsert({
      conversationId: 'conv-1',
      summary: 'Updated summary',
      messageCount: 10,
      updatedAt: '2026-01-02T00:00:00Z',
    });

    const result = repo.get('conv-1');
    expect(result!.summary).toBe('Updated summary');
    expect(result!.messageCount).toBe(10);
  });

  it('delete() removes entry', async () => {
    const repo = await setup();
    repo.upsert({
      conversationId: 'conv-1',
      summary: 'To be deleted',
      messageCount: 3,
      updatedAt: '2026-01-01T00:00:00Z',
    });

    repo.delete('conv-1');
    expect(repo.get('conv-1')).toBeUndefined();
  });
});
