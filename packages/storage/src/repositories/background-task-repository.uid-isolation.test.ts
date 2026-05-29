import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { Database } from '../database.js';

/**
 * v808 — DANGEROUS-B Cross-User-Isolation-Tests für BackgroundTaskRepository.
 *
 * Stellt sicher dass `getByIdForUser(id, userA)` keine task von userB zurückgibt
 * — selbst wenn die ID korrekt ist. Verteidigt gegen Cross-User-Leaks im
 * Background-Tasks-WebUI-Inspector.
 */

let hasBetterSqlite3 = true;
try {
  const BetterSqlite3 = (await import('better-sqlite3')).default;
  const testDb = new BetterSqlite3(':memory:');
  testDb.close();
} catch {
  hasBetterSqlite3 = false;
}

describe.skipIf(!hasBetterSqlite3)('BackgroundTaskRepository — uid-Isolation (v808)', () => {
  let dbPath: string;
  let db: Database;

  afterEach(async () => {
    try { await db?.close(); } catch { /* ignore */ }
    if (dbPath && fs.existsSync(dbPath)) {
      try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
    }
  });

  async function setup() {
    const { Database } = await import('../database.js');
    const { BackgroundTaskRepository } = await import('./background-task-repository.js');
    dbPath = path.join(os.tmpdir(), `alfred-test-bgtask-uid-${Date.now()}.db`);
    db = Database.createSync(dbPath);
    const repo = new BackgroundTaskRepository(db.getAdapter());
    return repo;
  }

  it('getByIdForUser liefert task wenn uid übereinstimmt', async () => {
    const repo = await setup();
    const t = await repo.create('user-A', 'telegram', 'chat-1', 'Test', 'web_search', '{}');
    const fetched = await repo.getByIdForUser(t.id, 'user-A');
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe(t.id);
  });

  it('getByIdForUser liefert undefined bei falscher uid (Cross-User-Schutz)', async () => {
    const repo = await setup();
    const t = await repo.create('user-A', 'telegram', 'chat-1', 'Geheim', 'web_search', '{}');
    const fetched = await repo.getByIdForUser(t.id, 'user-B');
    expect(fetched).toBeUndefined();
  });

  it('getById vs getByIdForUser — Regression-Test für DANGEROUS-B', async () => {
    const repo = await setup();
    const t = await repo.create('user-A', 'telegram', 'chat-1', 'Test', 'web_search', '{}');
    const unsafe = await repo.getById(t.id);
    const safe = await repo.getByIdForUser(t.id, 'user-B');
    // getById liefert (unsafe) — getByIdForUser blockt (safe)
    expect(unsafe).toBeDefined();
    expect(safe).toBeUndefined();
  });
});
