import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ActivityEntry, ActivityQuery, ActivityStats } from '@alfred/types';

export class ActivityRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  log(entry: Omit<ActivityEntry, 'id' | 'timestamp'>): void {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO activity_log (id, timestamp, event_type, source, source_id, user_id, platform, chat_id, action, outcome, error_message, duration_ms, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, timestamp,
      entry.eventType, entry.source, entry.sourceId ?? null,
      entry.userId ?? null, entry.platform ?? null, entry.chatId ?? null,
      entry.action, entry.outcome,
      entry.errorMessage ?? null, entry.durationMs ?? null,
      entry.details ? JSON.stringify(entry.details) : null,
    );
  }

  query(filters: ActivityQuery): ActivityEntry[] {
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

    const rows = this.db.prepare(
      `SELECT * FROM activity_log ${where} ORDER BY timestamp DESC LIMIT ?`
    ).all(...params, limit) as Record<string, unknown>[];

    return rows.map(r => this.mapRow(r));
  }

  count(filters: Omit<ActivityQuery, 'limit' | 'since'>): number {
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
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM activity_log ${where}`
    ).get(...params) as { cnt: number };

    return row.cnt;
  }

  stats(since?: string): ActivityStats[] {
    const where = since ? 'WHERE timestamp >= ?' : '';
    const params = since ? [since] : [];

    const rows = this.db.prepare(
      `SELECT event_type, outcome, COUNT(*) as cnt FROM activity_log ${where} GROUP BY event_type, outcome ORDER BY cnt DESC`
    ).all(...params) as Array<{ event_type: string; outcome: string; cnt: number }>;

    return rows.map(r => ({
      eventType: r.event_type,
      outcome: r.outcome,
      count: r.cnt,
    }));
  }

  cleanup(olderThanDays: number = 90): number {
    const result = this.db.prepare(
      `DELETE FROM activity_log WHERE timestamp < datetime('now', '-' || ? || ' days')`
    ).run(olderThanDays);
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
