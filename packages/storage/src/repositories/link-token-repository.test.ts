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

describe.skipIf(!hasBetterSqlite3)('LinkTokenRepository', () => {
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
    const { LinkTokenRepository } = await import('./link-token-repository.js');
    dbPath = path.join(os.tmpdir(), `alfred-test-linktoken-${Date.now()}.db`);
    db = new Database(dbPath);
    const repo = new LinkTokenRepository(db.getDb());
    return repo;
  }

  it('should create a token with a 6-digit code and expiry', async () => {
    const repo = await setup();

    const token = repo.create('user-1', 'telegram');

    expect(token).toBeDefined();
    expect(token.id).toBeDefined();
    expect(typeof token.id).toBe('string');
    expect(token.code).toBeDefined();
    expect(token.code).toMatch(/^\d{6}$/);
    expect(token.userId).toBe('user-1');
    expect(token.platform).toBe('telegram');
    expect(token.createdAt).toBeDefined();
    expect(token.expiresAt).toBeDefined();

    // Expiry should be in the future
    const expiresAt = new Date(token.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it('should find a non-expired token by code', async () => {
    const repo = await setup();

    const created = repo.create('user-1', 'telegram');
    const found = repo.findByCode(created.code);

    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
    expect(found!.code).toBe(created.code);
    expect(found!.userId).toBe('user-1');
    expect(found!.platform).toBe('telegram');
  });

  it('should return undefined for expired token', async () => {
    const repo = await setup();

    const created = repo.create('user-1', 'telegram');

    // Manually set expires_at to the past
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    db.getDb().prepare('UPDATE link_tokens SET expires_at = ? WHERE id = ?').run(pastDate, created.id);

    const found = repo.findByCode(created.code);
    expect(found).toBeUndefined();
  });

  it('should return undefined for non-existent code', async () => {
    const repo = await setup();

    const found = repo.findByCode('000000');
    expect(found).toBeUndefined();
  });

  it('should consume (delete) a token', async () => {
    const repo = await setup();

    const created = repo.create('user-1', 'telegram');
    repo.consume(created.id);

    const found = repo.findByCode(created.code);
    expect(found).toBeUndefined();
  });

  it('should cleanup expired tokens', async () => {
    const repo = await setup();

    const t1 = repo.create('user-1', 'telegram');
    const t2 = repo.create('user-2', 'discord');

    // Expire t1
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    db.getDb().prepare('UPDATE link_tokens SET expires_at = ? WHERE id = ?').run(pastDate, t1.id);

    repo.cleanup();

    // t1 should be gone (expired), t2 should remain (not expired)
    const found1 = repo.findByCode(t1.code);
    const found2 = repo.findByCode(t2.code);

    expect(found1).toBeUndefined();
    expect(found2).toBeDefined();
  });
});
