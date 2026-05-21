import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

export type InsightStatus = 'pending' | 'acted' | 'dismissed' | 'snoozed' | 'expired';

export type InsightCategory =
  | 'infra-forecast'
  | 'calendar-mismatch'
  | 'kg-gap'
  | 'cross-source-mention'
  | 'open-loop'
  | 'goal-drift'
  | 'skill-workflow'
  | 'finance'
  | 'meta';

export interface Insight {
  id: string;
  userId: string;
  category: InsightCategory;
  title: string;
  body: string;
  confidence: number; // 0..1
  sourceData?: Record<string, unknown>;
  actionSkill?: string;
  actionParams?: Record<string, unknown>;
  status: InsightStatus;
  snoozedUntil?: string;
  dedupeKey?: string;
  createdAt: string;
  updatedAt: string;
  actedAt?: string;
  dismissedAt?: string;
}

export interface InsightCandidate {
  category: InsightCategory;
  title: string;
  body: string;
  confidence?: number;
  sourceData?: Record<string, unknown>;
  actionSkill?: string;
  actionParams?: Record<string, unknown>;
  /** Stable key for dedup — same key = same insight, won't be inserted twice while pending. */
  dedupeKey?: string;
}

export class InsightsRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  /**
   * Upsert an insight candidate. If a `dedupeKey` exists with status='pending' or 'snoozed',
   * we update the existing row's body/confidence/sourceData (in case the underlying signal
   * changed) rather than inserting a duplicate. If it exists with 'dismissed'/'acted'/'expired'
   * we still skip — the user already decided about this topic, don't re-surface immediately.
   */
  async upsertCandidate(userId: string, candidate: InsightCandidate): Promise<{ inserted: boolean; id: string }> {
    const now = new Date().toISOString();
    if (candidate.dedupeKey) {
      const existing = await this.db.queryOne(
        `SELECT id, status FROM alfred_insights WHERE user_id = ? AND dedupe_key = ?`,
        [userId, candidate.dedupeKey],
      ) as { id: string; status: InsightStatus } | undefined;
      if (existing) {
        // Skip if user already decided. Only refresh active rows.
        if (existing.status === 'pending' || existing.status === 'snoozed') {
          await this.db.execute(
            `UPDATE alfred_insights SET title = ?, body = ?, confidence = ?, source_data = ?, action_skill = ?, action_params = ?, updated_at = ? WHERE id = ?`,
            [candidate.title, candidate.body, candidate.confidence ?? 0.5,
             candidate.sourceData ? JSON.stringify(candidate.sourceData) : null,
             candidate.actionSkill ?? null,
             candidate.actionParams ? JSON.stringify(candidate.actionParams) : null,
             now, existing.id],
          );
        }
        return { inserted: false, id: existing.id };
      }
    }

    const id = randomUUID();
    await this.db.execute(
      `INSERT INTO alfred_insights (id, user_id, category, title, body, confidence, source_data, action_skill, action_params, status, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [id, userId, candidate.category, candidate.title, candidate.body,
       candidate.confidence ?? 0.5,
       candidate.sourceData ? JSON.stringify(candidate.sourceData) : null,
       candidate.actionSkill ?? null,
       candidate.actionParams ? JSON.stringify(candidate.actionParams) : null,
       candidate.dedupeKey ?? null,
       now, now],
    );
    return { inserted: true, id };
  }

  async list(userId: string, opts?: { status?: InsightStatus | InsightStatus[]; category?: InsightCategory; limit?: number; includeExpiredSnoozes?: boolean }): Promise<Insight[]> {
    const where: string[] = ['user_id = ?'];
    const params: unknown[] = [userId];

    const statuses = opts?.status
      ? (Array.isArray(opts.status) ? opts.status : [opts.status])
      : ['pending', 'snoozed']; // default visible

    if (statuses.length === 1) { where.push('status = ?'); params.push(statuses[0]); }
    else { where.push(`status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses); }

    if (opts?.category) { where.push('category = ?'); params.push(opts.category); }
    if (!opts?.includeExpiredSnoozes) {
      where.push(`(status != 'snoozed' OR snoozed_until IS NULL OR snoozed_until <= ?)`);
      params.push(new Date().toISOString());
    }
    params.push(opts?.limit ?? 100);
    const rows = await this.db.query(
      `SELECT * FROM alfred_insights WHERE ${where.join(' AND ')}
       ORDER BY confidence DESC, created_at DESC LIMIT ?`,
      params,
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async getById(userId: string, id: string): Promise<Insight | null> {
    const row = await this.db.queryOne(`SELECT * FROM alfred_insights WHERE id = ? AND user_id = ?`, [id, userId]) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async dismiss(userId: string, id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute(`UPDATE alfred_insights SET status = 'dismissed', dismissed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [now, now, id, userId]);
  }

  async snooze(userId: string, id: string, hours: number): Promise<void> {
    const now = new Date().toISOString();
    const until = new Date(Date.now() + hours * 3_600_000).toISOString();
    await this.db.execute(`UPDATE alfred_insights SET status = 'snoozed', snoozed_until = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [until, now, id, userId]);
  }

  async markActed(userId: string, id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute(`UPDATE alfred_insights SET status = 'acted', acted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [now, now, id, userId]);
  }

  /** Reactivate snoozes whose snoozed_until is past. */
  async expireSnoozes(userId: string): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.db.execute(
      `UPDATE alfred_insights SET status = 'pending', snoozed_until = NULL, updated_at = ? WHERE user_id = ? AND status = 'snoozed' AND snoozed_until <= ?`,
      [now, userId, now],
    );
    return result.changes ?? 0;
  }

  /** Soft-expire long-pending insights after `maxAgeDays`. */
  async expireStale(userId: string, maxAgeDays = 21): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeDays * 86400_000).toISOString();
    const now = new Date().toISOString();
    const result = await this.db.execute(
      `UPDATE alfred_insights SET status = 'expired', updated_at = ? WHERE user_id = ? AND status = 'pending' AND created_at <= ?`,
      [now, userId, cutoff],
    );
    return result.changes ?? 0;
  }

  async stats(userId: string): Promise<{ pending: number; snoozed: number; dismissed: number; acted: number; expired: number }> {
    const rows = await this.db.query(
      `SELECT status, COUNT(*) AS c FROM alfred_insights WHERE user_id = ? GROUP BY status`,
      [userId],
    ) as Array<{ status: string; c: number | string }>;
    const out = { pending: 0, snoozed: 0, dismissed: 0, acted: 0, expired: 0 };
    for (const r of rows) (out as any)[r.status] = Number(r.c);
    return out;
  }

  private mapRow(r: Record<string, unknown>): Insight {
    return {
      id: r.id as string,
      userId: r.user_id as string,
      category: r.category as InsightCategory,
      title: r.title as string,
      body: r.body as string,
      confidence: Number(r.confidence ?? 0.5),
      sourceData: r.source_data ? safeJson(r.source_data as string) : undefined,
      actionSkill: r.action_skill as string | undefined,
      actionParams: r.action_params ? safeJson(r.action_params as string) : undefined,
      status: r.status as InsightStatus,
      snoozedUntil: r.snoozed_until as string | undefined,
      dedupeKey: r.dedupe_key as string | undefined,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      actedAt: r.acted_at as string | undefined,
      dismissedAt: r.dismissed_at as string | undefined,
    };
  }
}

function safeJson(s: string): Record<string, unknown> | undefined {
  try { return JSON.parse(s); } catch { return undefined; }
}
