import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

export interface DatabaseConnection {
  id: string;
  name: string;
  type: 'postgres' | 'mysql' | 'mssql' | 'mongodb' | 'influx' | 'sqlite' | 'redis';
  host: string;
  port?: number;
  databaseName?: string;
  username?: string;
  authConfig?: Record<string, unknown>;
  options?: Record<string, unknown>;
  createdAt: string;
}

export class DatabaseConnectionRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async create(conn: Omit<DatabaseConnection, 'id' | 'createdAt'>): Promise<DatabaseConnection> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(`
      INSERT INTO database_connections (id, name, type, host, port, database_name, username, auth_config, options, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, conn.name, conn.type, conn.host, conn.port ?? null, conn.databaseName ?? null,
      conn.username ?? null, conn.authConfig ? JSON.stringify(conn.authConfig) : null,
      conn.options ? JSON.stringify(conn.options) : null, now]);
    return { id, ...conn, createdAt: now };
  }

  async getAll(): Promise<DatabaseConnection[]> {
    const rows = await this.adapter.query('SELECT * FROM database_connections ORDER BY name') as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async getByName(name: string): Promise<DatabaseConnection | undefined> {
    const row = await this.adapter.queryOne('SELECT * FROM database_connections WHERE name = ?', [name]) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  async delete(name: string): Promise<boolean> {
    const result = await this.adapter.execute('DELETE FROM database_connections WHERE name = ?', [name]);
    return result.changes > 0;
  }

  private mapRow(row: Record<string, unknown>): DatabaseConnection {
    let authConfig: Record<string, unknown> | undefined;
    let options: Record<string, unknown> | undefined;
    try { if (row.auth_config) authConfig = JSON.parse(row.auth_config as string); } catch { /* empty */ }
    try { if (row.options) options = JSON.parse(row.options as string); } catch { /* empty */ }
    return {
      id: row.id as string,
      name: row.name as string,
      type: row.type as DatabaseConnection['type'],
      host: row.host as string,
      port: row.port as number | undefined,
      databaseName: row.database_name as string | undefined,
      username: row.username as string | undefined,
      authConfig,
      options,
      createdAt: row.created_at as string,
    };
  }
}
