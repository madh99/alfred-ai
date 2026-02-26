import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

let hasBetterSqlite3 = true;
try {
  const BetterSqlite3 = (await import('better-sqlite3')).default;
  const testDb = new BetterSqlite3(':memory:');
  testDb.close();
} catch {
  hasBetterSqlite3 = false;
}

describe.skipIf(!hasBetterSqlite3)('Database', () => {
  let dbPath: string;

  afterEach(() => {
    if (dbPath && fs.existsSync(dbPath)) {
      try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
    }
  });

  it('should create database and tables', async () => {
    const { Database } = await import('./database.js');
    dbPath = path.join(os.tmpdir(), `alfred-test-${Date.now()}.db`);
    const db = new Database(dbPath);

    const rawDb = db.getDb();
    const tables = rawDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('conversations');
    expect(tableNames).toContain('messages');
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('audit_log');

    db.close();
  });

  it('should close database', async () => {
    const { Database } = await import('./database.js');
    dbPath = path.join(os.tmpdir(), `alfred-test-${Date.now()}.db`);
    const db = new Database(dbPath);

    db.close();

    // After closing, calling operations on the underlying db should throw
    const rawDb = db.getDb();
    expect(() => {
      rawDb.prepare('SELECT 1').get();
    }).toThrow();
  });
});
