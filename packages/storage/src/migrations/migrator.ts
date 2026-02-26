import type BetterSqlite3 from 'better-sqlite3';

export interface Migration {
  version: number;
  description: string;
  up(db: BetterSqlite3.Database): void;
}

export class Migrator {
  private readonly db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
    this.ensureMigrationsTable();
  }

  private ensureMigrationsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        description TEXT,
        applied_at TEXT NOT NULL
      )
    `);
  }

  /** Get current schema version */
  getCurrentVersion(): number {
    const row = this.db.prepare(
      'SELECT MAX(version) as version FROM _migrations'
    ).get() as { version: number | null } | undefined;
    return row?.version ?? 0;
  }

  /** Run all pending migrations */
  migrate(migrations: Migration[]): void {
    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    const currentVersion = this.getCurrentVersion();

    for (const migration of sorted) {
      if (migration.version <= currentVersion) {
        continue;
      }

      const run = this.db.transaction(() => {
        migration.up(this.db);
        this.db.prepare(
          'INSERT INTO _migrations (version, description, applied_at) VALUES (?, ?, ?)'
        ).run(migration.version, migration.description, new Date().toISOString());
      });

      run();
    }
  }

  /** Get list of applied migrations */
  getAppliedMigrations(): { version: number; appliedAt: string }[] {
    const rows = this.db.prepare(
      'SELECT version, applied_at FROM _migrations ORDER BY version ASC'
    ).all() as { version: number; applied_at: string }[];

    return rows.map((row) => ({
      version: row.version,
      appliedAt: row.applied_at,
    }));
  }
}
