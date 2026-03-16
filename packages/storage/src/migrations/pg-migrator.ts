/**
 * PostgreSQL incremental migrator — mirrors the SQLite Migrator but works
 * with AsyncDbAdapter (async, PG-compatible).
 *
 * Uses a separate `_pg_migrations` table to track applied PG migrations
 * independently from the SQLite `_migrations` table.
 */
import type { AsyncDbAdapter } from '../db-adapter.js';

export interface PgMigration {
  version: number;
  description: string;
  up(db: AsyncDbAdapter): Promise<void>;
}

export class PgMigrator {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async ensureTable(): Promise<void> {
    await this.adapter.exec(`
      CREATE TABLE IF NOT EXISTS _pg_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT,
        applied_at TEXT NOT NULL
      )
    `);
  }

  async getCurrentVersion(): Promise<number> {
    const row = await this.adapter.queryOne(
      'SELECT MAX(version) as version FROM _pg_migrations',
    ) as { version: number | null } | undefined;
    return row?.version ?? 0;
  }

  async migrate(migrations: PgMigration[]): Promise<void> {
    await this.ensureTable();
    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    const currentVersion = await this.getCurrentVersion();

    for (const migration of sorted) {
      if (migration.version <= currentVersion) continue;

      await this.adapter.transaction(async (tx) => {
        await migration.up(tx);
        await tx.execute(
          'INSERT INTO _pg_migrations (version, description, applied_at) VALUES (?, ?, ?)',
          [migration.version, migration.description, new Date().toISOString()],
        );
      });
    }
  }
}
