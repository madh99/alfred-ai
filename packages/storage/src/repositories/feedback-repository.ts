import type { AsyncDbAdapter } from '../db-adapter.js';
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
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async recordEvent(
    userId: string,
    feedbackType: FeedbackEvent['feedbackType'],
    sourceId: string | undefined,
    contextKey: string,
    description: string,
    rawContext?: Record<string, unknown>,
  ): Promise<FeedbackEvent> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(`
      INSERT INTO feedback_events (id, user_id, feedback_type, source_id, context_key, description, raw_context, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, userId, feedbackType, sourceId ?? null, contextKey, description, rawContext ? JSON.stringify(rawContext) : null, now]);
    return { id, userId, feedbackType, sourceId, contextKey, description, rawContext: rawContext ? JSON.stringify(rawContext) : undefined, occurredAt: now };
  }

  async countEvents(userId: string, contextKey: string, sinceIso?: string): Promise<number> {
    if (sinceIso) {
      const row = await this.adapter.queryOne(
        `SELECT COUNT(*) as cnt FROM feedback_events WHERE user_id = ? AND context_key = ? AND occurred_at >= ?`,
        [userId, contextKey, sinceIso],
      ) as { cnt: number };
      return row.cnt;
    }
    const row = await this.adapter.queryOne(
      `SELECT COUNT(*) as cnt FROM feedback_events WHERE user_id = ? AND context_key = ?`,
      [userId, contextKey],
    ) as { cnt: number };
    return row.cnt;
  }

  async getRecentEvents(userId: string, limit = 20): Promise<FeedbackEvent[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM feedback_events WHERE user_id = ? ORDER BY occurred_at DESC LIMIT ?`,
      [userId, limit],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async getEventsForKey(userId: string, contextKey: string): Promise<FeedbackEvent[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM feedback_events WHERE user_id = ? AND context_key = ? ORDER BY occurred_at DESC`,
      [userId, contextKey],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async pruneOldEvents(olderThanDays = 180): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60_000).toISOString();
    const result = await this.adapter.execute(
      `DELETE FROM feedback_events WHERE occurred_at < ?`,
      [cutoff],
    );
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
