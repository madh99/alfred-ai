import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { AuditEntry } from '@alfred/types';
import type { Database } from '../database.js';

let hasBetterSqlite3 = true;
try {
  const BetterSqlite3 = (await import('better-sqlite3')).default;
  const testDb = new BetterSqlite3(':memory:');
  testDb.close();
} catch {
  hasBetterSqlite3 = false;
}

describe.skipIf(!hasBetterSqlite3)('AuditRepository', () => {
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
    const { AuditRepository } = await import('./audit-repository.js');
    dbPath = path.join(os.tmpdir(), `alfred-test-audit-${Date.now()}.db`);
    db = new Database(dbPath);
    const repo = new AuditRepository(db.getDb());
    return repo;
  }

  function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
    return {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      userId: 'user-1',
      action: 'test.action',
      riskLevel: 'read',
      effect: 'allow',
      platform: 'telegram',
      ...overrides,
    };
  }

  it('should log an audit entry', async () => {
    const repo = await setup();

    repo.log(makeEntry());

    const count = repo.count({});
    expect(count).toBe(1);
  });

  it('should query audit entries', async () => {
    const repo = await setup();

    repo.log(makeEntry({ action: 'action.one' }));
    repo.log(makeEntry({ action: 'action.two' }));
    repo.log(makeEntry({ action: 'action.three' }));

    const results = repo.query({ limit: 2 });
    expect(results).toHaveLength(2);

    const allResults = repo.query({});
    expect(allResults).toHaveLength(3);
  });

  it('should filter by action', async () => {
    const repo = await setup();

    repo.log(makeEntry({ action: 'file.read' }));
    repo.log(makeEntry({ action: 'file.write' }));
    repo.log(makeEntry({ action: 'file.read' }));

    const readResults = repo.query({ action: 'file.read' });
    expect(readResults).toHaveLength(2);
    expect(readResults.every((e) => e.action === 'file.read')).toBe(true);

    const writeResults = repo.query({ action: 'file.write' });
    expect(writeResults).toHaveLength(1);
    expect(writeResults[0].action).toBe('file.write');
  });
});
