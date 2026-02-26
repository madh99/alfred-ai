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

describe.skipIf(!hasBetterSqlite3)('UserRepository', () => {
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
    const { UserRepository } = await import('./user-repository.js');
    dbPath = path.join(os.tmpdir(), `alfred-test-user-${Date.now()}.db`);
    db = new Database(dbPath);
    const repo = new UserRepository(db.getDb());
    return repo;
  }

  it('should create a user via findOrCreate', async () => {
    const repo = await setup();

    const user = repo.findOrCreate('telegram', 'tg-user-1', 'alice', 'Alice W');

    expect(user).toBeDefined();
    expect(user.id).toBeDefined();
    expect(typeof user.id).toBe('string');
    expect(user.platform).toBe('telegram');
    expect(user.platformUserId).toBe('tg-user-1');
    expect(user.username).toBe('alice');
    expect(user.displayName).toBe('Alice W');
    expect(user.createdAt).toBeDefined();
    expect(user.updatedAt).toBeDefined();
  });

  it('should find existing user', async () => {
    const repo = await setup();

    const first = repo.findOrCreate('discord', 'dc-user-1', 'bob');
    const second = repo.findOrCreate('discord', 'dc-user-1', 'bob');

    expect(first.id).toBe(second.id);
    expect(first.platform).toBe(second.platform);
    expect(first.platformUserId).toBe(second.platformUserId);
  });

  it('should update user', async () => {
    const repo = await setup();

    const user = repo.findOrCreate('telegram', 'tg-user-2', 'charlie');
    expect(user.username).toBe('charlie');

    repo.update(user.id, { username: 'charlie_updated' });

    const updated = repo.findById(user.id);
    expect(updated).toBeDefined();
    expect(updated!.username).toBe('charlie_updated');
    expect(updated!.id).toBe(user.id);
  });
});
