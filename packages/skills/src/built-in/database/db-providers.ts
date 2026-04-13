/**
 * Database providers — each wraps a specific DB client with a common interface.
 * All providers use dynamic imports so the npm packages are optional.
 */

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

export interface TableInfo {
  name: string;
  type?: string; // 'table' | 'view' | 'collection'
  rowCount?: number;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable?: boolean;
  defaultValue?: string;
  primaryKey?: boolean;
}

export interface BackupOptions {
  outputPath: string;
  format?: 'sql' | 'custom' | 'archive';
  label?: string;
  backupType?: 'full' | 'differential' | 'log' | 'copy_only';
}

export interface RestoreOptions {
  inputPath: string;
  stopAt?: string;
}

export interface BackupResult {
  path: string;
  sizeBytes: number;
  duration_ms: number;
}

export interface DbProvider {
  type: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  ping(): Promise<boolean>;
  getTables(): Promise<TableInfo[]>;
  describeTable(name: string): Promise<ColumnInfo[]>;
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  backup?(opts: BackupOptions): Promise<BackupResult>;
  restore?(opts: RestoreOptions): Promise<void>;
}

interface ConnConfig {
  host: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  ssl?: boolean;
  timeoutMs?: number;
  rowLimit?: number;
}

const DEFAULT_ROW_LIMIT = 100;
const DEFAULT_TIMEOUT = 30_000;

// ── PostgreSQL ──────────────────────────────────────────────

export class PostgresProvider implements DbProvider {
  type = 'postgres';
  private pool: any;
  constructor(private config: ConnConfig) {}

  async connect() {
    const { Pool } = await (Function('return import("pg")')() as Promise<any>);
    this.pool = new Pool({
      host: this.config.host, port: this.config.port ?? 5432,
      database: this.config.database, user: this.config.username, password: this.config.password,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: this.config.timeoutMs ?? DEFAULT_TIMEOUT,
    });
  }
  async disconnect() { await this.pool?.end(); }
  async ping() { try { await this.pool.query('SELECT 1'); return true; } catch { return false; } }

  async getTables(): Promise<TableInfo[]> {
    const r = await this.pool.query(`SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`);
    return r.rows.map((row: any) => ({ name: row.table_name, type: row.table_type === 'VIEW' ? 'view' : 'table' }));
  }

  async describeTable(name: string): Promise<ColumnInfo[]> {
    const r = await this.pool.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [name]);
    return r.rows.map((row: any) => ({ name: row.column_name, type: row.data_type, nullable: row.is_nullable === 'YES', defaultValue: row.column_default }));
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const limit = this.config.rowLimit ?? DEFAULT_ROW_LIMIT;
    const r = await this.pool.query(sql, params);
    const columns = r.fields?.map((f: any) => f.name) ?? [];
    const rows = r.rows?.slice(0, limit) ?? [];
    return { columns, rows, rowCount: r.rowCount ?? rows.length, truncated: (r.rows?.length ?? 0) > limit };
  }

  async backup(opts: BackupOptions): Promise<BackupResult> {
    const start = Date.now();
    const format = opts.format === 'sql' ? 'plain' : 'custom';
    const ext = format === 'plain' ? '.sql' : '.dump';
    const outFile = `${opts.outputPath}${ext}`;
    const args = [
      '--host', this.config.host, '--port', String(this.config.port ?? 5432),
      '--dbname', this.config.database ?? 'postgres', '--format', format, '--file', outFile,
    ];
    if (this.config.username) args.push('--username', this.config.username);
    const env = { ...process.env };
    if (this.config.password) env.PGPASSWORD = this.config.password;
    const { execFile: ef } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(ef)('pg_dump', args, { env, timeout: 300_000 });
    const { stat } = await import('node:fs/promises');
    const st = await stat(outFile);
    return { path: outFile, sizeBytes: st.size, duration_ms: Date.now() - start };
  }

  async restore(opts: RestoreOptions): Promise<void> {
    const isCustom = opts.inputPath.endsWith('.dump');
    const cmd = isCustom ? 'pg_restore' : 'psql';
    const args = isCustom
      ? ['--host', this.config.host, '--port', String(this.config.port ?? 5432),
         '--dbname', this.config.database ?? 'postgres', '--clean', '--if-exists', opts.inputPath]
      : ['--host', this.config.host, '--port', String(this.config.port ?? 5432),
         '--dbname', this.config.database ?? 'postgres', '--file', opts.inputPath];
    if (this.config.username) args.push('--username', this.config.username);
    const env = { ...process.env };
    if (this.config.password) env.PGPASSWORD = this.config.password;
    const { execFile: ef } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(ef)(cmd, args, { env, timeout: 600_000 });
  }
}

// ── MySQL / MariaDB ─────────────────────────────────────────

export class MySQLProvider implements DbProvider {
  type = 'mysql';
  private pool: any;
  constructor(private config: ConnConfig) {}

  async connect() {
    const mysql2 = await (Function('return import("mysql2/promise")')() as Promise<any>);
    this.pool = mysql2.createPool({
      host: this.config.host, port: this.config.port ?? 3306,
      database: this.config.database, user: this.config.username, password: this.config.password,
      ssl: this.config.ssl ? {} : undefined,
      connectTimeout: this.config.timeoutMs ?? DEFAULT_TIMEOUT,
      waitForConnections: true, connectionLimit: 5,
    });
  }
  async disconnect() { await this.pool?.end(); }
  async ping() { try { await this.pool.query('SELECT 1'); return true; } catch { return false; } }

  async getTables(): Promise<TableInfo[]> {
    const [rows] = await this.pool.query('SHOW TABLES');
    return rows.map((row: any) => ({ name: Object.values(row)[0] as string, type: 'table' }));
  }

  async describeTable(name: string): Promise<ColumnInfo[]> {
    const [rows] = await this.pool.query(
      `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND TABLE_SCHEMA = DATABASE() ORDER BY ORDINAL_POSITION`,
      [name],
    );
    return rows.map((row: any) => ({
      name: row.COLUMN_NAME, type: row.DATA_TYPE, nullable: row.IS_NULLABLE === 'YES',
      defaultValue: row.COLUMN_DEFAULT, primaryKey: row.COLUMN_KEY === 'PRI',
    }));
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const limit = this.config.rowLimit ?? DEFAULT_ROW_LIMIT;
    const [rows, fields] = await this.pool.query(sql, params);
    const columns = Array.isArray(fields) ? fields.map((f: any) => f.name) : [];
    const limited = Array.isArray(rows) ? rows.slice(0, limit) : [];
    return { columns, rows: limited, rowCount: limited.length, truncated: Array.isArray(rows) && rows.length > limit };
  }

  async backup(opts: BackupOptions): Promise<BackupResult> {
    const start = Date.now();
    const outFile = `${opts.outputPath}.sql`;
    const args = [
      '--host', this.config.host, '--port', String(this.config.port ?? 3306),
      '--result-file', outFile, '--single-transaction', '--routines', '--triggers', '--events',
    ];
    if (this.config.username) args.push('--user', this.config.username);
    if (this.config.database) args.push(this.config.database);
    const env = { ...process.env };
    if (this.config.password) env.MYSQL_PWD = this.config.password;
    const { execFile: ef } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(ef)('mysqldump', args, { env, timeout: 300_000 });
    const { stat } = await import('node:fs/promises');
    const st = await stat(outFile);
    return { path: outFile, sizeBytes: st.size, duration_ms: Date.now() - start };
  }

  async restore(opts: RestoreOptions): Promise<void> {
    const { execSync } = await import('node:child_process');
    const args = [`--host=${this.config.host}`, `--port=${this.config.port ?? 3306}`];
    if (this.config.username) args.push(`--user=${this.config.username}`);
    if (this.config.database) args.push(`--database=${this.config.database}`);
    const env = { ...process.env };
    if (this.config.password) env.MYSQL_PWD = this.config.password;
    execSync(`mysql ${args.join(' ')} < "${opts.inputPath}"`, { env, timeout: 600_000 });
  }
}

// ── MS SQL ───────────────────────────────────────────────────

export class MSSQLProvider implements DbProvider {
  type = 'mssql';
  private pool: any;
  constructor(private config: ConnConfig) {}

  async connect() {
    const mssql = await (Function('return import("mssql")')() as Promise<any>);
    this.pool = await mssql.default.connect({
      server: this.config.host, port: this.config.port ?? 1433,
      database: this.config.database, user: this.config.username, password: this.config.password,
      options: { encrypt: this.config.ssl !== false, trustServerCertificate: true },
      connectionTimeout: this.config.timeoutMs ?? DEFAULT_TIMEOUT,
    });
  }
  async disconnect() { await this.pool?.close(); }
  async ping() { try { await this.pool.query('SELECT 1'); return true; } catch { return false; } }

  async getTables(): Promise<TableInfo[]> {
    const r = await this.pool.query(`SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_NAME`);
    return r.recordset.map((row: any) => ({ name: row.TABLE_NAME, type: row.TABLE_TYPE === 'VIEW' ? 'view' : 'table' }));
  }

  async describeTable(name: string): Promise<ColumnInfo[]> {
    const r = await this.pool.request()
      .input('tableName', name)
      .query(`SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @tableName ORDER BY ORDINAL_POSITION`);
    return r.recordset.map((row: any) => ({ name: row.COLUMN_NAME, type: row.DATA_TYPE, nullable: row.IS_NULLABLE === 'YES', defaultValue: row.COLUMN_DEFAULT }));
  }

  async query(sql: string): Promise<QueryResult> {
    const limit = this.config.rowLimit ?? DEFAULT_ROW_LIMIT;
    const r = await this.pool.query(sql);
    const rows = r.recordset?.slice(0, limit) ?? [];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { columns, rows, rowCount: r.rowsAffected?.[0] ?? rows.length, truncated: (r.recordset?.length ?? 0) > limit };
  }

  async backup(opts: BackupOptions): Promise<BackupResult> {
    const start = Date.now();
    const bt = opts.backupType ?? 'copy_only';
    const dbName = this.config.database ?? 'master';
    const ext = bt === 'log' ? '.trn' : '.bak';
    const outFile = `${opts.outputPath}${ext}`;
    const label = opts.label ?? `Alfred ${bt} Backup`;
    const sql = bt === 'log'
      ? `BACKUP LOG [${dbName}] TO DISK = N'${outFile}' WITH FORMAT, INIT, NAME = N'${label}'`
      : bt === 'differential'
        ? `BACKUP DATABASE [${dbName}] TO DISK = N'${outFile}' WITH DIFFERENTIAL, FORMAT, INIT, NAME = N'${label}'`
        : bt === 'full'
          ? `BACKUP DATABASE [${dbName}] TO DISK = N'${outFile}' WITH FORMAT, INIT, NAME = N'${label}'`
          : `BACKUP DATABASE [${dbName}] TO DISK = N'${outFile}' WITH COPY_ONLY, FORMAT, INIT, NAME = N'${label}'`;
    await this.query(sql);
    // Get backup size from header
    let sizeBytes = 0;
    try {
      const hdr = await this.query(`RESTORE HEADERONLY FROM DISK = N'${outFile}'`);
      sizeBytes = (hdr.rows[0]?.BackupSize as number) ?? 0;
    } catch { /* size unknown */ }
    return { path: outFile, sizeBytes, duration_ms: Date.now() - start };
  }

  async restore(opts: RestoreOptions): Promise<void> {
    const dbName = this.config.database ?? 'master';
    const isLog = opts.inputPath.endsWith('.trn');
    if (isLog && opts.stopAt) {
      await this.query(`RESTORE LOG [${dbName}] FROM DISK = N'${opts.inputPath}' WITH STOPAT = N'${opts.stopAt}'`);
    } else if (isLog) {
      await this.query(`RESTORE LOG [${dbName}] FROM DISK = N'${opts.inputPath}' WITH NORECOVERY`);
    } else {
      await this.query(`RESTORE DATABASE [${dbName}] FROM DISK = N'${opts.inputPath}' WITH REPLACE`);
    }
  }
}

// ── MongoDB ──────────────────────────────────────────────────

export class MongoProvider implements DbProvider {
  type = 'mongodb';
  private client: any;
  private db: any;
  constructor(private config: ConnConfig) {}

  async connect() {
    const { MongoClient } = await (Function('return import("mongodb")')() as Promise<any>);
    const port = this.config.port ?? 27017;
    const auth = this.config.username ? `${this.config.username}:${encodeURIComponent(this.config.password ?? '')}@` : '';
    const uri = `mongodb://${auth}${this.config.host}:${port}/${this.config.database ?? 'admin'}`;
    this.client = new MongoClient(uri, { serverSelectionTimeoutMS: this.config.timeoutMs ?? DEFAULT_TIMEOUT });
    await this.client.connect();
    this.db = this.client.db(this.config.database);
  }
  async disconnect() { await this.client?.close(); }
  async ping() { try { await this.db.command({ ping: 1 }); return true; } catch { return false; } }

  async getTables(): Promise<TableInfo[]> {
    const collections = await this.db.listCollections().toArray();
    return collections.map((c: any) => ({ name: c.name, type: 'collection' }));
  }

  async describeTable(name: string): Promise<ColumnInfo[]> {
    const sample = await this.db.collection(name).findOne();
    if (!sample) return [];
    return Object.entries(sample).map(([key, val]) => ({ name: key, type: typeof val, nullable: true }));
  }

  async query(queryStr: string): Promise<QueryResult> {
    const limit = this.config.rowLimit ?? DEFAULT_ROW_LIMIT;
    // Parse simple queries: collection.find({...})
    const findMatch = /^(\w+)\.find\((.*)\)$/s.exec(queryStr.trim());
    if (findMatch) {
      const [, coll, filterStr] = findMatch;
      const filter = filterStr ? JSON.parse(filterStr || '{}') : {};
      const docs = await this.db.collection(coll).find(filter).limit(limit).toArray();
      const columns = docs.length > 0 ? Object.keys(docs[0]) : [];
      return { columns, rows: docs, rowCount: docs.length, truncated: docs.length >= limit };
    }
    // Aggregate: collection.aggregate([...])
    const aggMatch = /^(\w+)\.aggregate\((.*)\)$/s.exec(queryStr.trim());
    if (aggMatch) {
      const [, coll, pipelineStr] = aggMatch;
      const pipeline = JSON.parse(pipelineStr);
      const docs = await this.db.collection(coll).aggregate(pipeline).limit(limit).toArray();
      const columns = docs.length > 0 ? Object.keys(docs[0]) : [];
      return { columns, rows: docs, rowCount: docs.length, truncated: docs.length >= limit };
    }
    // Count: collection.count({...})
    const countMatch = /^(\w+)\.count\((.*)\)$/s.exec(queryStr.trim());
    if (countMatch) {
      const [, coll, filterStr] = countMatch;
      const filter = filterStr ? JSON.parse(filterStr || '{}') : {};
      const count = await this.db.collection(coll).countDocuments(filter);
      return { columns: ['count'], rows: [{ count }], rowCount: 1, truncated: false };
    }
    return { columns: [], rows: [], rowCount: 0, truncated: false };
  }

  async backup(opts: BackupOptions): Promise<BackupResult> {
    const start = Date.now();
    const outDir = opts.outputPath;
    const args = ['--out', outDir];
    if (this.config.database) args.push('--db', this.config.database);
    const port = this.config.port ?? 27017;
    const auth = this.config.username ? `${this.config.username}:${encodeURIComponent(this.config.password ?? '')}@` : '';
    args.push('--uri', `mongodb://${auth}${this.config.host}:${port}`);
    const { execFile: ef } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(ef)('mongodump', args, { timeout: 300_000 });
    return { path: outDir, sizeBytes: 0, duration_ms: Date.now() - start };
  }

  async restore(opts: RestoreOptions): Promise<void> {
    const args = ['--drop', opts.inputPath];
    if (this.config.database) args.push('--db', this.config.database);
    const port = this.config.port ?? 27017;
    const auth = this.config.username ? `${this.config.username}:${encodeURIComponent(this.config.password ?? '')}@` : '';
    args.push('--uri', `mongodb://${auth}${this.config.host}:${port}`);
    const { execFile: ef } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(ef)('mongorestore', args, { timeout: 600_000 });
  }
}

// ── InfluxDB ─────────────────────────────────────────────────

export class InfluxProvider implements DbProvider {
  type = 'influx';
  private queryApi: any;
  constructor(private config: ConnConfig) {}

  async connect() {
    const { InfluxDB } = await (Function('return import("@influxdata/influxdb-client")')() as Promise<any>);
    const url = `http${this.config.ssl ? 's' : ''}://${this.config.host}:${this.config.port ?? 8086}`;
    const client = new InfluxDB({ url, token: this.config.password });
    this.queryApi = client.getQueryApi(this.config.database ?? '');
  }
  async disconnect() { /* InfluxDB client has no close */ }
  async ping() { return true; }

  async getTables(): Promise<TableInfo[]> {
    const rows: TableInfo[] = [];
    await this.queryApi.collectRows('buckets()', (row: any) => { rows.push({ name: row._value, type: 'bucket' }); });
    return rows;
  }

  async describeTable(name: string): Promise<ColumnInfo[]> {
    const cols: ColumnInfo[] = [];
    const flux = `import "influxdata/influxdb/schema"\nschema.measurementFieldKeys(bucket: "${name.replace(/"/g, '')}")`;
    await this.queryApi.collectRows(flux, (row: any) => { cols.push({ name: row._value, type: 'field' }); });
    return cols;
  }

  async query(fluxQuery: string): Promise<QueryResult> {
    const limit = this.config.rowLimit ?? DEFAULT_ROW_LIMIT;
    const rows: Record<string, unknown>[] = [];
    await this.queryApi.collectRows(fluxQuery, (row: any) => { if (rows.length < limit) rows.push(row); });
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { columns, rows, rowCount: rows.length, truncated: rows.length >= limit };
  }

  async backup(opts: BackupOptions): Promise<BackupResult> {
    const start = Date.now();
    const { execFile: ef } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const args = ['backup', '--path', opts.outputPath];
    if (this.config.database) args.push('--bucket', this.config.database);
    await promisify(ef)('influx', args, { timeout: 300_000 });
    return { path: opts.outputPath, sizeBytes: 0, duration_ms: Date.now() - start };
  }

  async restore(opts: RestoreOptions): Promise<void> {
    const { execFile: ef } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(ef)('influx', ['restore', '--path', opts.inputPath], { timeout: 600_000 });
  }
}

// ── SQLite ────────────────────────────────────────────────────

export class SQLiteProvider implements DbProvider {
  type = 'sqlite';
  private db: any;
  constructor(private config: ConnConfig) {}

  async connect() {
    const BetterSqlite3 = (await (Function('return import("better-sqlite3")')() as Promise<any>)).default;
    this.db = new BetterSqlite3(this.config.host, { readonly: !this.config.ssl });
  }
  async disconnect() { this.db?.close(); }
  async ping() { try { this.db.prepare('SELECT 1').get(); return true; } catch { return false; } }

  async getTables(): Promise<TableInfo[]> {
    const rows = this.db.prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
    return rows.map((r: any) => ({ name: r.name, type: r.type }));
  }

  async describeTable(name: string): Promise<ColumnInfo[]> {
    const rows = this.db.prepare(`PRAGMA table_info("${name.replace(/"/g, '')}")`).all();
    return rows.map((r: any) => ({ name: r.name, type: r.type, nullable: !r.notnull, defaultValue: r.dflt_value, primaryKey: r.pk === 1 }));
  }

  async query(sql: string): Promise<QueryResult> {
    const limit = this.config.rowLimit ?? DEFAULT_ROW_LIMIT;
    const isSelect = /^\s*(SELECT|PRAGMA|EXPLAIN)/i.test(sql);
    if (isSelect) {
      const rows = this.db.prepare(sql).all().slice(0, limit);
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return { columns, rows, rowCount: rows.length, truncated: rows.length >= limit };
    }
    const result = this.db.prepare(sql).run();
    return { columns: ['changes'], rows: [{ changes: result.changes }], rowCount: 1, truncated: false };
  }

  async backup(opts: BackupOptions): Promise<BackupResult> {
    const start = Date.now();
    const outFile = `${opts.outputPath}.sqlite`;
    this.db.exec(`VACUUM INTO '${outFile.replace(/'/g, "''")}'`);
    const { stat } = await import('node:fs/promises');
    const st = await stat(outFile);
    return { path: outFile, sizeBytes: st.size, duration_ms: Date.now() - start };
  }

  async restore(opts: RestoreOptions): Promise<void> {
    const dbPath = this.config.host;
    this.db.close();
    const { copyFile } = await import('node:fs/promises');
    await copyFile(opts.inputPath, dbPath);
    await this.connect();
  }
}

// ── Redis ─────────────────────────────────────────────────────

export class RedisProvider implements DbProvider {
  type = 'redis';
  private client: any;
  constructor(private config: ConnConfig) {}

  async connect() {
    const Redis = (await (Function('return import("ioredis")')() as Promise<any>)).default;
    this.client = new Redis({
      host: this.config.host, port: this.config.port ?? 6379,
      password: this.config.password, db: parseInt(this.config.database ?? '0', 10),
      connectTimeout: this.config.timeoutMs ?? DEFAULT_TIMEOUT,
      tls: this.config.ssl ? {} : undefined,
    });
  }
  async disconnect() { await this.client?.quit(); }
  async ping() { try { return (await this.client.ping()) === 'PONG'; } catch { return false; } }

  async getTables(): Promise<TableInfo[]> {
    const info = await this.client.dbsize();
    return [{ name: `db${this.config.database ?? '0'}`, type: 'keyspace', rowCount: info }];
  }

  async describeTable(): Promise<ColumnInfo[]> {
    return [{ name: 'key', type: 'string' }, { name: 'value', type: 'varies' }, { name: 'type', type: 'string' }, { name: 'ttl', type: 'integer' }];
  }

  async query(command: string): Promise<QueryResult> {
    const limit = this.config.rowLimit ?? DEFAULT_ROW_LIMIT;
    const parts = command.trim().split(/\s+/);
    const cmd = parts[0].toUpperCase();
    const args = parts.slice(1);

    if (cmd === 'KEYS') {
      const keys = (await this.client.keys(args[0] ?? '*')).slice(0, limit);
      return { columns: ['key'], rows: keys.map((k: string) => ({ key: k })), rowCount: keys.length, truncated: keys.length >= limit };
    }
    if (cmd === 'GET') {
      const val = await this.client.get(args[0]);
      return { columns: ['key', 'value'], rows: [{ key: args[0], value: val }], rowCount: 1, truncated: false };
    }
    // Generic command
    const result = await this.client.call(cmd, ...args);
    return { columns: ['result'], rows: [{ result: typeof result === 'object' ? JSON.stringify(result) : result }], rowCount: 1, truncated: false };
  }

  async backup(): Promise<BackupResult> {
    const start = Date.now();
    await this.client.bgsave();
    // Wait for BGSAVE to complete (max 30s)
    for (let i = 0; i < 30; i++) {
      const lastSave = await this.client.lastsave();
      if (Date.now() / 1000 - lastSave < 5) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    return { path: 'RDB on server (BGSAVE)', sizeBytes: 0, duration_ms: Date.now() - start };
  }
}

// ── Factory ──────────────────────────────────────────────────

export function createProvider(type: string, config: ConnConfig): DbProvider {
  switch (type) {
    case 'postgres': return new PostgresProvider(config);
    case 'mysql': return new MySQLProvider(config);
    case 'mssql': return new MSSQLProvider(config);
    case 'mongodb': return new MongoProvider(config);
    case 'influx': return new InfluxProvider(config);
    case 'sqlite': return new SQLiteProvider(config);
    case 'redis': return new RedisProvider(config);
    default: throw new Error(`Unsupported database type: ${type}`);
  }
}
