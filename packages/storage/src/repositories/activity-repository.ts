import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';
import type { ActivityEntry, ActivityQuery, ActivityStats } from '@alfred/types';

export interface WeeklySkillStats {
  week: string;          // e.g. '2026-W13'
  skillName: string;
  calls: number;
  errors: number;
  avgDurationMs: number;
}

export interface HourlyStats {
  hour: number;          // 0-23
  totalCalls: number;
  errorCalls: number;
  avgDurationMs: number;
}

export class ActivityRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async log(entry: Omit<ActivityEntry, 'id' | 'timestamp'>): Promise<void> {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    await this.adapter.execute(`
      INSERT INTO activity_log (id, timestamp, event_type, source, source_id, user_id, platform, chat_id, action, outcome, error_message, duration_ms, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id, timestamp,
      entry.eventType, entry.source, entry.sourceId ?? null,
      entry.userId ?? null, entry.platform ?? null, entry.chatId ?? null,
      entry.action, entry.outcome,
      entry.errorMessage ?? null, entry.durationMs ?? null,
      entry.details ? JSON.stringify(entry.details) : null,
    ]);
  }

  async query(filters: ActivityQuery): Promise<ActivityEntry[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.eventType) {
      conditions.push('event_type = ?');
      params.push(filters.eventType);
    }
    if (filters.source) {
      conditions.push('source = ?');
      params.push(filters.source);
    }
    if (filters.outcome) {
      conditions.push('outcome = ?');
      params.push(filters.outcome);
    }
    if (filters.userId) {
      conditions.push('user_id = ?');
      params.push(filters.userId);
    }
    if (filters.since) {
      conditions.push('timestamp >= ?');
      params.push(filters.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ?? 100;
    params.push(limit);

    const rows = await this.adapter.query(
      `SELECT * FROM activity_log ${where} ORDER BY timestamp DESC LIMIT ?`, params,
    ) as Record<string, unknown>[];

    return rows.map(r => this.mapRow(r));
  }

  async count(filters: Omit<ActivityQuery, 'limit' | 'since'>): Promise<number> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.eventType) {
      conditions.push('event_type = ?');
      params.push(filters.eventType);
    }
    if (filters.source) {
      conditions.push('source = ?');
      params.push(filters.source);
    }
    if (filters.outcome) {
      conditions.push('outcome = ?');
      params.push(filters.outcome);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const row = await this.adapter.queryOne(
      `SELECT COUNT(*) as cnt FROM activity_log ${where}`, params,
    ) as { cnt: number };

    return row.cnt;
  }

  async stats(since?: string): Promise<ActivityStats[]> {
    const where = since ? 'WHERE timestamp >= ?' : '';
    const params = since ? [since] : [];

    const rows = await this.adapter.query(
      `SELECT event_type, outcome, COUNT(*) as cnt FROM activity_log ${where} GROUP BY event_type, outcome ORDER BY cnt DESC`, params,
    ) as Array<{ event_type: string; outcome: string; cnt: number }>;

    return rows.map(r => ({
      eventType: r.event_type,
      outcome: r.outcome,
      count: r.cnt,
    }));
  }

  /** Get skill usage grouped by user, with call counts per skill. */
  async skillUsageByUser(since?: string): Promise<Array<{ userId: string; skillName: string; calls: number; successes: number; errors: number }>> {
    const where = since
      ? "WHERE event_type = 'skill_execution' AND timestamp >= ?"
      : "WHERE event_type = 'skill_execution'";
    const params = since ? [since] : [];

    const rows = await this.adapter.query(`
      SELECT user_id, action as skill_name, COUNT(*) as calls,
             SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
             SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) as errors
      FROM activity_log ${where} AND user_id IS NOT NULL
      GROUP BY user_id, action ORDER BY calls DESC
    `, params) as Record<string, unknown>[];

    return rows.map(r => ({
      userId: r.user_id as string,
      skillName: r.skill_name as string,
      calls: r.calls as number,
      successes: r.successes as number,
      errors: r.errors as number,
    }));
  }

  // ── Temporal Analysis Queries ──────────────────────────────

  /** Get skill usage bucketed by ISO week for trend analysis. */
  async weeklySkillStats(since: string, userId?: string): Promise<WeeklySkillStats[]> {
    const userFilter = userId ? ' AND user_id = ?' : '';
    const params: unknown[] = [since];
    if (userId) params.push(userId);

    // Use adapter-specific week bucketing
    const weekExpr = this.adapter.type === 'postgres'
      ? "to_char(timestamp::timestamp, 'IYYY-\"W\"IW')"
      : "strftime('%Y-W%W', timestamp)";

    const rows = await this.adapter.query(`
      SELECT ${weekExpr} as week, action as skill_name,
             COUNT(*) as calls,
             SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) as errors,
             AVG(duration_ms) as avg_duration_ms
      FROM activity_log
      WHERE event_type = 'skill_exec' AND timestamp >= ?${userFilter}
      GROUP BY week, action
      ORDER BY week ASC, calls DESC
    `, params) as Record<string, unknown>[];

    return rows.map(r => ({
      week: r.week as string,
      skillName: r.skill_name as string,
      calls: Number(r.calls),
      errors: Number(r.errors),
      avgDurationMs: Math.round(Number(r.avg_duration_ms ?? 0)),
    }));
  }

  /** Get hourly activity distribution for anomaly detection. */
  async hourlyDistribution(since: string, userId?: string): Promise<HourlyStats[]> {
    const userFilter = userId ? ' AND user_id = ?' : '';
    const params: unknown[] = [since];
    if (userId) params.push(userId);

    const hourExpr = this.adapter.type === 'postgres'
      ? "EXTRACT(HOUR FROM timestamp::timestamp)::int"
      : "CAST(strftime('%H', timestamp) AS INTEGER)";

    const rows = await this.adapter.query(`
      SELECT ${hourExpr} as hour,
             COUNT(*) as total_calls,
             SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) as error_calls,
             AVG(duration_ms) as avg_duration_ms
      FROM activity_log
      WHERE timestamp >= ?${userFilter}
      GROUP BY hour
      ORDER BY hour ASC
    `, params) as Record<string, unknown>[];

    return rows.map(r => ({
      hour: Number(r.hour),
      totalCalls: Number(r.total_calls),
      errorCalls: Number(r.error_calls),
      avgDurationMs: Math.round(Number(r.avg_duration_ms ?? 0)),
    }));
  }

  async cleanup(olderThanDays: number = 90): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
    const result = await this.adapter.execute(
      `DELETE FROM activity_log WHERE timestamp < ?`, [cutoff],
    );
    return result.changes;
  }

  private mapRow(row: Record<string, unknown>): ActivityEntry {
    let details: Record<string, unknown> | undefined;
    if (row.details) {
      try { details = JSON.parse(row.details as string); } catch { /* ignore */ }
    }

    return {
      id: row.id as string,
      timestamp: row.timestamp as string,
      eventType: row.event_type as string,
      source: row.source as ActivityEntry['source'],
      sourceId: row.source_id as string | undefined,
      userId: row.user_id as string | undefined,
      platform: row.platform as string | undefined,
      chatId: row.chat_id as string | undefined,
      action: row.action as string,
      outcome: row.outcome as ActivityEntry['outcome'],
      errorMessage: row.error_message as string | undefined,
      durationMs: row.duration_ms as number | undefined,
      details,
    };
  }
}
