import type { AsyncDbAdapter } from '../db-adapter.js';

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
  constructor(private readonly adapter: AsyncDbAdapter) {}

  /** Record a single LLM call (upsert into today's row for this model). */
  async record(model: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, costUsd: number, userId?: string): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    // Global aggregate (unchanged)
    await this.adapter.execute(`
      INSERT INTO llm_usage (date, model, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, model) DO UPDATE SET
        calls = calls + excluded.calls,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
        cost_usd = cost_usd + excluded.cost_usd
    `, [date, model, 1, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd]);
    // Per-user in separate table (no double-counting)
    if (userId) {
      await this.adapter.execute(`
        INSERT INTO llm_usage_by_user (date, user_id, model, calls, input_tokens, output_tokens, cost_usd)
        VALUES (?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(date, user_id, model) DO UPDATE SET
          calls = calls + 1,
          input_tokens = input_tokens + excluded.input_tokens,
          output_tokens = output_tokens + excluded.output_tokens,
          cost_usd = cost_usd + excluded.cost_usd
      `, [date, userId, model, inputTokens, outputTokens, costUsd]);
    }
  }

  /** Get usage grouped by user_id for a date range. */
  async getByUser(startDate: string, endDate: string): Promise<Array<{ userId: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }>> {
    const rows = await this.adapter.query(`
      SELECT user_id, SUM(calls) as calls, SUM(input_tokens) as input_tokens,
             SUM(output_tokens) as output_tokens, SUM(cost_usd) as cost_usd
      FROM llm_usage_by_user WHERE date >= ? AND date <= ?
      GROUP BY user_id ORDER BY cost_usd DESC
    `, [startDate, endDate]) as Record<string, unknown>[];
    return rows.map(r => ({
      userId: r.user_id as string,
      calls: r.calls as number,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      costUsd: r.cost_usd as number,
    }));
  }

  /** Get usage for a specific date. */
  async getDaily(date: string): Promise<DailyUsageSummary> {
    const rows = await this.adapter.query(`
      SELECT model, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
      FROM llm_usage WHERE date = ?
    `, [date]) as Record<string, unknown>[];
    return this.buildSummary(date, rows);
  }

  /** Get usage for a date range (inclusive). */
  async getRange(startDate: string, endDate: string): Promise<DailyUsageSummary[]> {
    const rows = await this.adapter.query(`
      SELECT date, model, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
      FROM llm_usage WHERE date >= ? AND date <= ? ORDER BY date, model
    `, [startDate, endDate]) as Record<string, unknown>[];
    const byDate = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const d = row.date as string;
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d)!.push(row);
    }
    return [...byDate.entries()].map(([d, r]) => this.buildSummary(d, r));
  }

  /** Get all-time totals grouped by model. */
  async getTotal(): Promise<UsageRecord[]> {
    const rows = await this.adapter.query(`
      SELECT model,
        SUM(calls) as calls,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cache_read_tokens) as cache_read_tokens,
        SUM(cache_write_tokens) as cache_write_tokens,
        SUM(cost_usd) as cost_usd
      FROM llm_usage GROUP BY model
    `) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async cleanup(olderThanDays: number = 365): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString().slice(0, 10);
    const result = await this.adapter.execute(
      `DELETE FROM llm_usage WHERE date < ?`, [cutoff],
    );
    return result.changes;
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
