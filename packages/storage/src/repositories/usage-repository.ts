import type BetterSqlite3 from 'better-sqlite3';

export interface UsageRecord {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface DailyUsageSummary {
  date: string;
  models: UsageRecord[];
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

export class UsageRepository {
  private readonly stmtUpsert: BetterSqlite3.Statement;
  private readonly stmtDaily: BetterSqlite3.Statement;
  private readonly stmtRange: BetterSqlite3.Statement;
  private readonly stmtTotal: BetterSqlite3.Statement;

  constructor(private readonly db: BetterSqlite3.Database) {
    this.stmtUpsert = db.prepare(`
      INSERT INTO llm_usage (date, model, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, model) DO UPDATE SET
        calls = calls + excluded.calls,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
        cost_usd = cost_usd + excluded.cost_usd
    `);

    this.stmtDaily = db.prepare(`
      SELECT model, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
      FROM llm_usage WHERE date = ?
    `);

    this.stmtRange = db.prepare(`
      SELECT date, model, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
      FROM llm_usage WHERE date >= ? AND date <= ? ORDER BY date, model
    `);

    this.stmtTotal = db.prepare(`
      SELECT model,
        SUM(calls) as calls,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cache_read_tokens) as cache_read_tokens,
        SUM(cache_write_tokens) as cache_write_tokens,
        SUM(cost_usd) as cost_usd
      FROM llm_usage GROUP BY model
    `);
  }

  /** Record a single LLM call (upsert into today's row for this model). */
  record(model: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, costUsd: number): void {
    const date = new Date().toISOString().slice(0, 10);
    this.stmtUpsert.run(date, model, 1, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd);
  }

  /** Get usage for a specific date. */
  getDaily(date: string): DailyUsageSummary {
    const rows = this.stmtDaily.all(date) as Record<string, unknown>[];
    return this.buildSummary(date, rows);
  }

  /** Get usage for a date range (inclusive). */
  getRange(startDate: string, endDate: string): DailyUsageSummary[] {
    const rows = this.stmtRange.all(startDate, endDate) as Record<string, unknown>[];
    const byDate = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const d = row.date as string;
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d)!.push(row);
    }
    return [...byDate.entries()].map(([d, r]) => this.buildSummary(d, r));
  }

  /** Get all-time totals grouped by model. */
  getTotal(): UsageRecord[] {
    const rows = this.stmtTotal.all() as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  private buildSummary(date: string, rows: Record<string, unknown>[]): DailyUsageSummary {
    const models = rows.map(r => this.mapRow(r));
    return {
      date,
      models,
      totalCalls: models.reduce((s, m) => s + m.calls, 0),
      totalInputTokens: models.reduce((s, m) => s + m.inputTokens, 0),
      totalOutputTokens: models.reduce((s, m) => s + m.outputTokens, 0),
      totalCostUsd: Math.round(models.reduce((s, m) => s + m.costUsd, 0) * 1_000_000) / 1_000_000,
    };
  }

  private mapRow(r: Record<string, unknown>): UsageRecord {
    return {
      model: r.model as string,
      calls: r.calls as number,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      cacheReadTokens: r.cache_read_tokens as number,
      cacheWriteTokens: r.cache_write_tokens as number,
      costUsd: r.cost_usd as number,
    };
  }
}
