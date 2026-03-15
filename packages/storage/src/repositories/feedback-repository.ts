import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface FeedbackEvent {
  id: string;
  userId: string;
  feedbackType: 'watch_rejection' | 'conversation_correction';
  sourceId?: string;
  contextKey: string;
  description: string;
  rawContext?: string;
  occurredAt: string;
}

export class FeedbackRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  recordEvent(
    userId: string,
    feedbackType: FeedbackEvent['feedbackType'],
    sourceId: string | undefined,
    contextKey: string,
    description: string,
    rawContext?: Record<string, unknown>,
  ): FeedbackEvent {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO feedback_events (id, user_id, feedback_type, source_id, context_key, description, raw_context, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, feedbackType, sourceId ?? null, contextKey, description, rawContext ? JSON.stringify(rawContext) : null, now);
    return { id, userId, feedbackType, sourceId, contextKey, description, rawContext: rawContext ? JSON.stringify(rawContext) : undefined, occurredAt: now };
  }

  countEvents(userId: string, contextKey: string, sinceIso?: string): number {
    if (sinceIso) {
      const row = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM feedback_events WHERE user_id = ? AND context_key = ? AND occurred_at >= ?`,
      ).get(userId, contextKey, sinceIso) as { cnt: number };
      return row.cnt;
    }
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM feedback_events WHERE user_id = ? AND context_key = ?`,
    ).get(userId, contextKey) as { cnt: number };
    return row.cnt;
  }

  getRecentEvents(userId: string, limit = 20): FeedbackEvent[] {
    const rows = this.db.prepare(
      `SELECT * FROM feedback_events WHERE user_id = ? ORDER BY occurred_at DESC LIMIT ?`,
    ).all(userId, limit) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  getEventsForKey(userId: string, contextKey: string): FeedbackEvent[] {
    const rows = this.db.prepare(
      `SELECT * FROM feedback_events WHERE user_id = ? AND context_key = ? ORDER BY occurred_at DESC`,
    ).all(userId, contextKey) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  pruneOldEvents(olderThanDays = 180): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60_000).toISOString();
    const result = this.db.prepare(
      `DELETE FROM feedback_events WHERE occurred_at < ?`,
    ).run(cutoff);
    return result.changes;
  }

  private mapRow(row: Record<string, unknown>): FeedbackEvent {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      feedbackType: row.feedback_type as FeedbackEvent['feedbackType'],
      sourceId: row.source_id as string | undefined,
      contextKey: row.context_key as string,
      description: row.description as string,
      rawContext: row.raw_context as string | undefined,
      occurredAt: row.occurred_at as string,
    };
  }
}
