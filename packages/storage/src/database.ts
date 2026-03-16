import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { Migrator } from './migrations/migrator.js';
import { MIGRATIONS } from './migrations/index.js';
import type { AsyncDbAdapter } from './db-adapter.js';
import { SQLiteAsyncAdapter, PostgresAsyncAdapter } from './db-adapter.js';

export class Database {
  private adapter!: AsyncDbAdapter;

  /** Use Database.create() or Database.createSync() instead. */
  private constructor() {}

  /**
   * Create a Database instance with the appropriate backend.
   * For SQLite: auto-backup, WAL mode, run migrations.
   * For PostgreSQL: run full PG schema if fresh, check schema version.
   */
  static async create(config: {
    backend?: 'sqlite' | 'postgres';
    path?: string;
    connectionString?: string;
  }): Promise<Database> {
    const db = new Database();

    if (config.backend === 'postgres') {
      if (!config.connectionString) {
        throw new Error('storage.backend is "postgres" but storage.connectionString is not set');
      }
      await db.initPostgres(config.connectionString);
    } else {
      db.initSQLite(config.path ?? './data/alfred.db');
    }

    return db;
  }

  /**
   * Legacy constructor-style factory for backward compatibility.
   * Creates a SQLite-only database synchronously (wrapped in async adapter).
   */
  static createSync(dbPath: string): Database {
    const db = new Database();
    db.initSQLite(dbPath);
    return db;
  }

  private initSQLite(dbPath: string): void {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });

    // Auto-backup on startup (if DB exists and is > 100KB)
    const stats = fs.statSync(dbPath, { throwIfNoEntry: false });
    if (stats && stats.size > 100_000) {
      const backupDir = path.join(path.dirname(dbPath), 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const backupPath = path.join(backupDir, `alfred-${new Date().toISOString().slice(0, 10)}.db`);
      if (!fs.existsSync(backupPath)) {
        try {
          const tmpDb = new BetterSqlite3(dbPath, { readonly: true });
          try { tmpDb.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
          tmpDb.close();
          fs.copyFileSync(dbPath, backupPath);
        } catch (err) {
          console.warn(`[Database] Backup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const sqliteDb = new BetterSqlite3(dbPath);
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('foreign_keys = ON');
    sqliteDb.pragma('busy_timeout = 5000');

    this.adapter = new SQLiteAsyncAdapter(sqliteDb);

    // Init base tables + run migrations
    this.initSQLiteTables(sqliteDb);
    this.runSQLiteMigrations(sqliteDb);
  }

  private async initPostgres(connectionString: string): Promise<void> {
    const pgAdapter = new PostgresAsyncAdapter(connectionString);
    await pgAdapter.initialize();
    this.adapter = pgAdapter;

    // Check if schema exists (check for schema_version table)
    try {
      const rows = await pgAdapter.query(
        `SELECT version FROM schema_version ORDER BY version DESC LIMIT 1`,
      );
      if (rows.length > 0) {
        const version = rows[0].version as number;
        console.log(`[Database] PostgreSQL schema version: ${version}`);
        return;
      }
    } catch {
      // Table doesn't exist — run full schema
    }

    // Run full PG schema (creates all tables + sets schema_version to 35)
    const { PG_SCHEMA } = await import('./migrations/pg-schema.js');
    await pgAdapter.exec(PG_SCHEMA);
    console.log('[Database] PostgreSQL schema initialized');
  }

  private initSQLiteTables(db: BetterSqlite3.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        platform_user_id TEXT NOT NULL,
        username TEXT,
        display_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        rule_id TEXT,
        effect TEXT NOT NULL,
        platform TEXT NOT NULL,
        chat_id TEXT,
        context TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_platform_chat
        ON conversations(platform, chat_id);

      CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages(conversation_id, created_at);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_platform
        ON users(platform, platform_user_id);
    `);
  }

  private runSQLiteMigrations(db: BetterSqlite3.Database): void {
    const migrator = new Migrator(db);
    migrator.migrate(MIGRATIONS);
  }

  /** Get the async database adapter (works for both SQLite and PostgreSQL). */
  getAdapter(): AsyncDbAdapter {
    return this.adapter;
  }

  /** Get the raw better-sqlite3 handle. Throws if backend is PostgreSQL. */
  getDb(): BetterSqlite3.Database {
    if (this.adapter.type === 'sqlite') {
      return (this.adapter as SQLiteAsyncAdapter).getDriver();
    }
    throw new Error('getDb() is not available for PostgreSQL backend. Use getAdapter() instead.');
  }

  async close(): Promise<void> {
    await this.adapter.close();
  }
}
