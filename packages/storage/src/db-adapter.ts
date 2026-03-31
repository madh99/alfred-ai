/**
 * Database adapter abstraction — allows Alfred to run on SQLite or PostgreSQL.
 *
 * Two modes:
 * - SQLite: synchronous (existing behavior, zero changes needed)
 * - PostgreSQL: requires async — repositories that need PG must use async methods
 *
 * Strategy: The Database class exposes both the raw better-sqlite3 handle (for
 * existing repos) AND the adapter interface (for new/converted repos).
 * Migration to PG is incremental — repos can be converted one at a time.
 */

export interface DbRow {
  [key: string]: unknown;
}

export interface DbRunResult {
  changes: number;
}

/**
 * Async database adapter interface.
 * SQLite implementation wraps sync calls in Promises (zero overhead).
 * PostgreSQL implementation uses native async pg queries.
 *
 * transaction() receives a callback that gets the *transactional* adapter.
 * On PostgreSQL this routes queries through the dedicated client.
 * On SQLite all operations are serialized anyway, so `tx === this`.
 */
export interface AsyncDbAdapter {
  readonly type: 'sqlite' | 'postgres';

  query(sql: string, params?: unknown[]): Promise<DbRow[]>;
  queryOne(sql: string, params?: unknown[]): Promise<DbRow | undefined>;
  execute(sql: string, params?: unknown[]): Promise<DbRunResult>;
  /** Execute raw SQL (DDL only — do not use with data containing semicolons in literals). */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: AsyncDbAdapter) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * SQLite async adapter — wraps better-sqlite3 sync calls in Promises.
 */
export class SQLiteAsyncAdapter implements AsyncDbAdapter {
  readonly type = 'sqlite' as const;

  constructor(private readonly db: import('better-sqlite3').Database) {}

  async query(sql: string, params?: unknown[]): Promise<DbRow[]> {
    return this.db.prepare(sql).all(...(params ?? [])) as DbRow[];
  }

  async queryOne(sql: string, params?: unknown[]): Promise<DbRow | undefined> {
    return this.db.prepare(sql).get(...(params ?? [])) as DbRow | undefined;
  }

  async execute(sql: string, params?: unknown[]): Promise<DbRunResult> {
    const result = this.db.prepare(sql).run(...(params ?? []));
    return { changes: result.changes };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: AsyncDbAdapter) => Promise<T>): Promise<T> {
    // Manual BEGIN/COMMIT because better-sqlite3's .transaction() doesn't
    // await async callbacks. All inner adapter ops resolve synchronously
    // (they wrap sync better-sqlite3 calls), so BEGIN/COMMIT is safe here.
    // NOTE: Do not introduce genuinely async ops (network, setTimeout)
    // inside SQLite transactions — they would break the transaction boundary.
    this.db.exec('BEGIN');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  /** Direct access to better-sqlite3 for existing sync repos (temporary, during migration). */
  getDriver(): import('better-sqlite3').Database {
    return this.db;
  }
}

/**
 * PostgreSQL async adapter — wraps pg Pool.
 */
export class PostgresAsyncAdapter implements AsyncDbAdapter {
  readonly type = 'postgres' as const;
  private pool: any;

  constructor(private readonly connectionString: string) {}

  async initialize(): Promise<void> {
    let Pool: any;
    try {
      Pool = (await (Function('return import("pg")')() as Promise<{ Pool: any }>)).Pool;
    } catch {
      throw new Error('PostgreSQL backend requires the "pg" package. Install it: npm install pg');
    }
    this.pool = new Pool({
      connectionString: this.connectionString,
      max: 20,
      idleTimeoutMillis: 30000,
    } as any);
    // Test connection
    const client = await this.pool.connect();
    client.release();
  }

  async query(sql: string, params?: unknown[]): Promise<DbRow[]> {
    const pgSql = this.adaptSql(sql);
    const result = await this.pool.query(pgSql, params);
    return result.rows;
  }

  async queryOne(sql: string, params?: unknown[]): Promise<DbRow | undefined> {
    const rows = await this.query(sql, params);
    return rows[0];
  }

  async execute(sql: string, params?: unknown[]): Promise<DbRunResult> {
    const pgSql = this.adaptSql(sql);
    const result = await this.pool.query(pgSql, params);
    return { changes: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    const pgSql = this.adaptSql(sql);
    // Split multi-statement DDL. Not safe for data SQL with semicolons in literals.
    const statements = pgSql.split(';').filter(s => s.trim());
    for (const stmt of statements) {
      await this.pool.query(stmt);
    }
  }

  async transaction<T>(fn: (tx: AsyncDbAdapter) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    // Create a client-bound adapter so all queries inside fn() go through this client
    const txAdapter = new PostgresClientAdapter(client, this.adaptSql.bind(this));
    try {
      await client.query('BEGIN');
      const result = await fn(txAdapter);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  /**
   * Convert SQLite ? placeholders to PostgreSQL $1, $2, ...
   * and adapt common SQLite-specific SQL functions.
   *
   * Note: Complex SQLite expressions (datetime arithmetic, INSERT OR REPLACE)
   * are handled at the repository level via adapter.type branching.
   */
  private adaptSql(sql: string): string {
    // Replace ? with $N, skipping ? inside string literals ('...')
    let idx = 0;
    let adapted = '';
    let inString = false;
    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];
      if (ch === "'" && (i === 0 || sql[i - 1] !== "'")) {
        inString = !inString;
        adapted += ch;
      } else if (ch === '?' && !inString) {
        adapted += `$${++idx}`;
      } else {
        adapted += ch;
      }
    }

    return adapted
      // datetime('now') → NOW()
      .replace(/datetime\s*\(\s*'now'\s*\)/gi, 'NOW()')
      // date('now') → CURRENT_DATE
      .replace(/date\s*\(\s*'now'\s*\)/gi, 'CURRENT_DATE')
      // SQLite LIKE is case-insensitive by default, PostgreSQL isn't
      .replace(/\bLIKE\b/gi, 'ILIKE');
  }
}

/**
 * Client-bound adapter for PostgreSQL transactions.
 * Routes all queries through a dedicated pg Client (not the Pool).
 */
class PostgresClientAdapter implements AsyncDbAdapter {
  readonly type = 'postgres' as const;

  constructor(
    private readonly client: any,
    private readonly adaptSql: (sql: string) => string,
  ) {}

  async query(sql: string, params?: unknown[]): Promise<DbRow[]> {
    const pgSql = this.adaptSql(sql);
    const result = await this.client.query(pgSql, params);
    return result.rows;
  }

  async queryOne(sql: string, params?: unknown[]): Promise<DbRow | undefined> {
    const rows = await this.query(sql, params);
    return rows[0];
  }

  async execute(sql: string, params?: unknown[]): Promise<DbRunResult> {
    const pgSql = this.adaptSql(sql);
    const result = await this.client.query(pgSql, params);
    return { changes: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    const pgSql = this.adaptSql(sql);
    const statements = pgSql.split(';').filter(s => s.trim());
    for (const stmt of statements) {
      await this.client.query(stmt);
    }
  }

  async transaction<T>(fn: (tx: AsyncDbAdapter) => Promise<T>): Promise<T> {
    // Nested transaction — use SAVEPOINTs
    const sp = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await this.client.query(`SAVEPOINT ${sp}`);
    try {
      const result = await fn(this);
      await this.client.query(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      throw err;
    }
  }

  async close(): Promise<void> {
    // No-op — client lifecycle managed by the parent transaction
  }
}

/**
 * Create the appropriate adapter based on config.
 */
export async function createDbAdapter(config: { backend: 'sqlite' | 'postgres'; path?: string; connectionString?: string }): Promise<AsyncDbAdapter> {
  if (config.backend === 'postgres' && config.connectionString) {
    const adapter = new PostgresAsyncAdapter(config.connectionString);
    await adapter.initialize();
    return adapter;
  }

  // Default: SQLite
  const BetterSqlite3 = (await (Function('return import("better-sqlite3")')() as Promise<{ default: any }>)).default;
  const dbPath = config.path ?? './data/alfred.db';

  // Ensure directory exists
  const { mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  return new SQLiteAsyncAdapter(db);
}
