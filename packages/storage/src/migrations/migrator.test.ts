import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { Migration } from './migrator.js';

let hasBetterSqlite3 = true;
try {
  const BetterSqlite3 = (await import('better-sqlite3')).default;
  const testDb = new BetterSqlite3(':memory:');
  testDb.close();
} catch {
  hasBetterSqlite3 = false;
}

describe.skipIf(!hasBetterSqlite3)('Migrator', () => {
  let dbPath: string;
  let rawDb: import('better-sqlite3').Database;

  afterEach(() => {
    try { rawDb?.close(); } catch { /* ignore */ }
    if (dbPath && fs.existsSync(dbPath)) {
      try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
    }
  });

  async function setup() {
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const { Migrator } = await import('./migrator.js');
    dbPath = path.join(os.tmpdir(), `alfred-test-migrator-${Date.now()}.db`);
    rawDb = new BetterSqlite3(dbPath);
    const migrator = new Migrator(rawDb);
    return { migrator, rawDb };
  }

  it('should create _migrations table on construction', async () => {
    const { rawDb } = await setup();

    const tables = rawDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
      .all() as { name: string }[];

    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('_migrations');
  });

  it('should return version 0 when no migrations applied', async () => {
    const { migrator } = await setup();

    expect(migrator.getCurrentVersion()).toBe(0);
  });

  it('should run pending migrations', async () => {
    const { migrator, rawDb } = await setup();

    const migrations: Migration[] = [
      {
        version: 1,
        description: 'Create test_table',
        up(db) {
          db.exec('CREATE TABLE test_table (id INTEGER PRIMARY KEY, value TEXT)');
        },
      },
    ];

    migrator.migrate(migrations);

    expect(migrator.getCurrentVersion()).toBe(1);

    // Verify the table was actually created
    const tables = rawDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_table'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
  });

  it('should skip already applied migrations', async () => {
    const { migrator } = await setup();

    let callCount = 0;
    const migrations: Migration[] = [
      {
        version: 1,
        description: 'First migration',
        up(db) {
          callCount++;
          db.exec('CREATE TABLE first_table (id INTEGER PRIMARY KEY)');
        },
      },
      {
        version: 2,
        description: 'Second migration',
        up(db) {
          callCount++;
          db.exec('CREATE TABLE second_table (id INTEGER PRIMARY KEY)');
        },
      },
    ];

    migrator.migrate(migrations);
    expect(callCount).toBe(2);
    expect(migrator.getCurrentVersion()).toBe(2);

    // Running again should skip both
    callCount = 0;
    migrator.migrate(migrations);
    expect(callCount).toBe(0);
    expect(migrator.getCurrentVersion()).toBe(2);
  });

  it('should run only new migrations', async () => {
    const { migrator } = await setup();

    const firstBatch: Migration[] = [
      {
        version: 1,
        description: 'First',
        up(db) {
          db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY)');
        },
      },
    ];

    migrator.migrate(firstBatch);
    expect(migrator.getCurrentVersion()).toBe(1);

    let secondRan = false;
    const secondBatch: Migration[] = [
      ...firstBatch,
      {
        version: 2,
        description: 'Second',
        up(db) {
          secondRan = true;
          db.exec('CREATE TABLE t2 (id INTEGER PRIMARY KEY)');
        },
      },
    ];

    migrator.migrate(secondBatch);
    expect(secondRan).toBe(true);
    expect(migrator.getCurrentVersion()).toBe(2);
  });

  it('should track applied migrations', async () => {
    const { migrator } = await setup();

    const migrations: Migration[] = [
      { version: 1, description: 'First migration', up() {} },
      { version: 2, description: 'Second migration', up() {} },
    ];

    migrator.migrate(migrations);

    const applied = migrator.getAppliedMigrations();
    expect(applied).toHaveLength(2);
    expect(applied[0].version).toBe(1);
    expect(applied[1].version).toBe(2);
    expect(typeof applied[0].appliedAt).toBe('string');
    expect(typeof applied[1].appliedAt).toBe('string');
  });

  it('should sort migrations by version before running', async () => {
    const { migrator } = await setup();

    const order: number[] = [];
    const migrations: Migration[] = [
      {
        version: 3,
        description: 'Third',
        up() { order.push(3); },
      },
      {
        version: 1,
        description: 'First',
        up() { order.push(1); },
      },
      {
        version: 2,
        description: 'Second',
        up() { order.push(2); },
      },
    ];

    migrator.migrate(migrations);

    expect(order).toEqual([1, 2, 3]);
    expect(migrator.getCurrentVersion()).toBe(3);
  });
});
