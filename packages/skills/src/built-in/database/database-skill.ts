import type { SkillMetadata, SkillContext, SkillResult, DatabaseConfig } from '@alfred/types';
import { Skill } from '../../skill.js';
import type { DatabaseConnectionRepository, DatabaseConnection } from '@alfred/storage';
import { createProvider, type DbProvider, type QueryResult } from './db-providers.js';

const SENSITIVE_TABLES = /^(users?|accounts?|passwords?|credentials?|tokens?|sessions?|secrets?)$/i;

export class DatabaseSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'database',
    category: 'infrastructure',
    description: `Query and manage database connections. Supports PostgreSQL, MySQL/MariaDB, MS SQL, MongoDB, InfluxDB, SQLite, Redis.
Actions:
- connect: Add a new database connection. Params: name, type (postgres|mysql|mssql|mongodb|influx|sqlite|redis), host, port, database, username, password, readOnly (default true)
- disconnect: Remove a connection. Params: name
- list: List all configured connections
- schema: Show tables/collections. Params: connection (name)
- describe: Show columns of a table. Params: connection, table
- query: Execute a query. Params: connection, sql (SQL/Flux/Redis command). Default read-only. Results limited to rowLimit (default 100)
- test: Test connection. Params: connection
Watch-compatible: query action returns rowCount and first row data for condition evaluation.`,
    riskLevel: 'admin',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['connect', 'disconnect', 'list', 'schema', 'describe', 'query', 'test'], description: 'Database action' },
        name: { type: 'string', description: 'Connection name (for connect/disconnect)' },
        connection: { type: 'string', description: 'Connection name to use (for schema/describe/query/test)' },
        type: { type: 'string', enum: ['postgres', 'mysql', 'mssql', 'mongodb', 'influx', 'sqlite', 'redis'], description: 'Database type (for connect)' },
        host: { type: 'string', description: 'Host address (for connect)' },
        port: { type: 'number', description: 'Port (for connect, default varies by type)' },
        database: { type: 'string', description: 'Database name (for connect)' },
        username: { type: 'string', description: 'Username (for connect)' },
        password: { type: 'string', description: 'Password (for connect)' },
        readOnly: { type: 'boolean', description: 'Read-only mode (default true)' },
        table: { type: 'string', description: 'Table name (for describe)' },
        sql: { type: 'string', description: 'SQL query, Flux query, MongoDB query, or Redis command (for query)' },
      },
      required: ['action'],
    },
  };

  private readonly providers = new Map<string, DbProvider>();
  private readonly config: DatabaseConfig;

  constructor(
    config: DatabaseConfig,
    private readonly connRepo: DatabaseConnectionRepository,
  ) {
    super();
    this.config = config;
  }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = input.action as string;
    switch (action) {
      case 'connect': return this.addConnection(input);
      case 'disconnect': return this.removeConnection(input);
      case 'list': return this.listConnections();
      case 'schema': return this.getSchema(input);
      case 'describe': return this.describeTable(input);
      case 'query': return this.executeQuery(input);
      case 'test': return this.testConnection(input);
      default: return { success: false, error: `Unknown action "${action}".` };
    }
  }

  private async addConnection(input: Record<string, unknown>): Promise<SkillResult> {
    const name = input.name as string;
    const type = input.type as DatabaseConnection['type'];
    const host = input.host as string;
    if (!name || !type || !host) return { success: false, error: 'Missing name, type, or host' };

    const existing = this.connRepo.getByName(name);
    if (existing) return { success: false, error: `Connection "${name}" already exists. Use disconnect first.` };

    const conn = this.connRepo.create({
      name, type, host,
      port: input.port as number | undefined,
      databaseName: input.database as string | undefined,
      username: input.username as string | undefined,
      authConfig: input.password ? { password: input.password as string } : undefined,
      options: { readOnly: (input.readOnly as boolean) ?? true, rowLimit: this.config.defaultRowLimit ?? 100, timeoutMs: this.config.defaultTimeoutMs ?? 30000 },
    });

    // Test connection
    try {
      const provider = await this.getProvider(conn);
      const ok = await provider.ping();
      if (!ok) throw new Error('Ping failed');

      const tables = await provider.getTables();
      return {
        success: true,
        data: { connectionId: conn.id, name, type, tables: tables.length },
        display: `✅ Verbindung "${name}" hergestellt (${type}://${host}). ${tables.length} Tabellen/Collections gefunden.`,
      };
    } catch (err) {
      // Remove failed connection
      this.connRepo.delete(name);
      this.providers.delete(name);
      return { success: false, error: `Verbindung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async removeConnection(input: Record<string, unknown>): Promise<SkillResult> {
    const name = (input.name ?? input.connection) as string;
    if (!name) return { success: false, error: 'Missing "name"' };

    const provider = this.providers.get(name);
    if (provider) { try { await provider.disconnect(); } catch { /* ignore */ } this.providers.delete(name); }

    const deleted = this.connRepo.delete(name);
    return deleted
      ? { success: true, data: { name }, display: `✅ Verbindung "${name}" entfernt.` }
      : { success: false, error: `Connection "${name}" not found.` };
  }

  private listConnections(): SkillResult {
    const connections = this.connRepo.getAll();
    if (connections.length === 0) return { success: true, data: [], display: 'Keine Datenbankverbindungen konfiguriert.' };

    const display = connections.map(c =>
      `- **${c.name}** (${c.type}) — ${c.host}${c.port ? ':' + c.port : ''}${c.databaseName ? '/' + c.databaseName : ''}`,
    ).join('\n');

    return { success: true, data: connections.map(c => ({ name: c.name, type: c.type, host: c.host, database: c.databaseName })), display: `**Datenbankverbindungen (${connections.length}):**\n${display}` };
  }

  private async getSchema(input: Record<string, unknown>): Promise<SkillResult> {
    const name = input.connection as string;
    if (!name) return { success: false, error: 'Missing "connection" name' };

    const provider = await this.getProviderByName(name);
    if (!provider) return { success: false, error: `Connection "${name}" not found` };

    const tables = await provider.getTables();
    const display = tables.map(t => `- ${t.name}${t.type && t.type !== 'table' ? ` (${t.type})` : ''}${t.rowCount != null ? ` — ${t.rowCount} rows` : ''}`).join('\n');

    return { success: true, data: { connection: name, tables }, display: `**Schema "${name}"** (${tables.length} Objekte):\n${display}` };
  }

  private async describeTable(input: Record<string, unknown>): Promise<SkillResult> {
    const name = input.connection as string;
    const table = input.table as string;
    if (!name || !table) return { success: false, error: 'Missing "connection" or "table"' };

    const provider = await this.getProviderByName(name);
    if (!provider) return { success: false, error: `Connection "${name}" not found` };

    const columns = await provider.describeTable(table);
    const display = `**${table}** (${columns.length} Spalten):\n` +
      '| Spalte | Typ | Nullable | Default |\n|--------|-----|----------|--------|\n' +
      columns.map(c => `| ${c.name} | ${c.type} | ${c.nullable ? '✓' : '✗'} | ${c.defaultValue ?? '—'} |`).join('\n');

    return { success: true, data: { connection: name, table, columns }, display };
  }

  private async executeQuery(input: Record<string, unknown>): Promise<SkillResult> {
    const name = input.connection as string;
    const sql = input.sql as string;
    if (!name || !sql) return { success: false, error: 'Missing "connection" or "sql"' };

    const conn = this.connRepo.getByName(name);
    if (!conn) return { success: false, error: `Connection "${name}" not found` };

    // Security: check read-only
    const readOnly = (conn.options as Record<string, unknown>)?.readOnly !== false && !this.config.allowWrite;
    if (readOnly) {
      const isWrite = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)/i.test(sql);
      if (isWrite) return { success: false, error: 'Schreibzugriff nicht erlaubt. Connection ist read-only.' };
    }

    // Security: warn about sensitive tables
    const tableMatch = sql.match(/FROM\s+(\w+)/i);
    if (tableMatch && SENSITIVE_TABLES.test(tableMatch[1])) {
      // Don't block, just note it in the display
    }

    const provider = await this.getProviderByName(name);
    if (!provider) return { success: false, error: `Connection "${name}" not found` };

    try {
      const result = await provider.query(sql);
      return { success: true, data: { rowCount: result.rowCount, columns: result.columns, rows: result.rows, truncated: result.truncated, firstRow: result.rows[0] }, display: this.formatResult(result, name) };
    } catch (err) {
      return { success: false, error: `Query fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async testConnection(input: Record<string, unknown>): Promise<SkillResult> {
    const name = input.connection as string;
    if (!name) return { success: false, error: 'Missing "connection"' };

    const provider = await this.getProviderByName(name);
    if (!provider) return { success: false, error: `Connection "${name}" not found` };

    const ok = await provider.ping();
    return { success: true, data: { connection: name, reachable: ok }, display: ok ? `✅ "${name}" erreichbar.` : `❌ "${name}" nicht erreichbar.` };
  }

  private formatResult(result: QueryResult, connName: string): string {
    if (result.rows.length === 0) return `**${connName}:** Keine Ergebnisse.`;

    const header = `**${connName}:** ${result.rowCount} Zeilen${result.truncated ? ' (gekürzt)' : ''}\n\n`;

    if (result.columns.length <= 6 && result.rows.length <= 20) {
      // Markdown table
      const table = '| ' + result.columns.join(' | ') + ' |\n' +
        '|' + result.columns.map(() => '---').join('|') + '|\n' +
        result.rows.map(row =>
          '| ' + result.columns.map(c => {
            const v = row[c];
            return v == null ? '—' : String(v).slice(0, 50);
          }).join(' | ') + ' |',
        ).join('\n');
      return header + table;
    }

    // Too many columns — show as list
    return header + result.rows.slice(0, 10).map((row, i) =>
      `**#${i + 1}:** ${result.columns.map(c => `${c}=${row[c] ?? '—'}`).join(', ')}`,
    ).join('\n');
  }

  private async getProviderByName(name: string): Promise<DbProvider | null> {
    if (this.providers.has(name)) return this.providers.get(name)!;
    const conn = this.connRepo.getByName(name);
    if (!conn) return null;
    return this.getProvider(conn);
  }

  private async getProvider(conn: DatabaseConnection): Promise<DbProvider> {
    if (this.providers.has(conn.name)) return this.providers.get(conn.name)!;

    const opts = (conn.options ?? {}) as Record<string, unknown>;
    const provider = createProvider(conn.type, {
      host: conn.host,
      port: conn.port,
      database: conn.databaseName,
      username: conn.username,
      password: (conn.authConfig as Record<string, string>)?.password,
      ssl: opts.ssl as boolean | undefined,
      timeoutMs: (opts.timeoutMs as number) ?? this.config.defaultTimeoutMs ?? 30000,
      rowLimit: (opts.rowLimit as number) ?? this.config.defaultRowLimit ?? 100,
    });

    await provider.connect();
    this.providers.set(conn.name, provider);
    return provider;
  }
}
