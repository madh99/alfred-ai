import type { AsyncDbAdapter } from '@alfred/storage';
import type { Logger } from 'pino';

interface DbQueryStep {
  sql: string;
  params?: string[];
  createTable?: boolean;
}

interface DbQueryResult {
  success: boolean;
  data: Record<string, unknown>;
  rowCount?: number;
  error?: string;
}

export class DbQueryExecutor {
  constructor(private readonly adapter: AsyncDbAdapter, private readonly logger: Logger) {}

  async execute(step: DbQueryStep, templateContext: Record<string, unknown>): Promise<DbQueryResult> {
    let sql = step.sql;
    for (const [key, value] of Object.entries(templateContext)) {
      sql = sql.replace(new RegExp(`\\{\\{${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`, 'g'), String(value ?? ''));
    }
    const isWrite = /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i.test(sql);
    try {
      if (isWrite) {
        const result = await this.adapter.execute(sql, step.params ?? []);
        return { success: true, data: { changes: result.changes }, rowCount: result.changes };
      }
      const rows = await this.adapter.query(sql, step.params ?? []);
      return { success: true, data: { rows, count: (rows as unknown[]).length }, rowCount: (rows as unknown[]).length };
    } catch (err) {
      return { success: false, data: {}, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
