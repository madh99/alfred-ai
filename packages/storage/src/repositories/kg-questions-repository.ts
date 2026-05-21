import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

export type QuestionStatus = 'asked' | 'answered' | 'ignored' | 'cancelled';

export interface KgQuestion {
  id: string;
  userId: string;
  targetKind: 'person' | 'organization' | 'location' | 'item' | string;
  targetId: string;
  attribute: string;
  questionText: string;
  askedAt: string;
  askedViaPlatform?: string;
  askedViaChatId?: string;
  status: QuestionStatus;
  answeredAt?: string;
  answerText?: string;
  parsedValue?: string;
  ignoreCount: number;
}

export class KgQuestionsRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  /**
   * Upsert one question per (user, target, attribute). If a question exists with `asked`
   * status and was asked >7d ago, bump `ignore_count` and return existing — we don't
   * re-ask immediately. If status is 'answered' or 'cancelled', skip silently (already
   * resolved). New row inserted only if no prior row at all.
   */
  async upsertAsk(userId: string, q: Pick<KgQuestion, 'targetKind' | 'targetId' | 'attribute' | 'questionText'> & Partial<Pick<KgQuestion, 'askedViaPlatform' | 'askedViaChatId'>>): Promise<{ inserted: boolean; ignoreCount: number; id: string } | null> {
    const existing = await this.db.queryOne(
      `SELECT id, status, asked_at, ignore_count FROM kg_questions WHERE user_id = ? AND target_kind = ? AND target_id = ? AND attribute = ?`,
      [userId, q.targetKind, q.targetId, q.attribute],
    ) as { id: string; status: QuestionStatus; asked_at: string; ignore_count: number } | undefined;

    if (existing) {
      if (existing.status === 'answered' || existing.status === 'cancelled') return null;
      // Re-ask only if older than 7d
      const ageDays = (Date.now() - new Date(existing.asked_at).getTime()) / 86400_000;
      if (ageDays < 7) return null;
      const newIgnore = (existing.ignore_count ?? 0) + 1;
      // Stop nagging after 3 ignores
      if (newIgnore >= 3) {
        await this.db.execute(`UPDATE kg_questions SET status = 'ignored', ignore_count = ? WHERE id = ?`, [newIgnore, existing.id]);
        return null;
      }
      const now = new Date().toISOString();
      await this.db.execute(
        `UPDATE kg_questions SET asked_at = ?, ignore_count = ?, question_text = ?, asked_via_platform = ?, asked_via_chat_id = ? WHERE id = ?`,
        [now, newIgnore, q.questionText, q.askedViaPlatform ?? null, q.askedViaChatId ?? null, existing.id],
      );
      return { inserted: false, ignoreCount: newIgnore, id: existing.id };
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO kg_questions (id, user_id, target_kind, target_id, attribute, question_text, asked_at, asked_via_platform, asked_via_chat_id, status, ignore_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'asked', 0)`,
      [id, userId, q.targetKind, q.targetId, q.attribute, q.questionText, now, q.askedViaPlatform ?? null, q.askedViaChatId ?? null],
    );
    return { inserted: true, ignoreCount: 0, id };
  }

  async markAnswered(userId: string, id: string, answerText: string, parsedValue?: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute(
      `UPDATE kg_questions SET status = 'answered', answered_at = ?, answer_text = ?, parsed_value = ? WHERE id = ? AND user_id = ?`,
      [now, answerText, parsedValue ?? null, id, userId],
    );
  }

  async cancel(userId: string, id: string): Promise<void> {
    await this.db.execute(`UPDATE kg_questions SET status = 'cancelled' WHERE id = ? AND user_id = ?`, [id, userId]);
  }

  async listAsked(userId: string, limit = 50): Promise<KgQuestion[]> {
    const rows = await this.db.query(
      `SELECT * FROM kg_questions WHERE user_id = ? AND status = 'asked' ORDER BY asked_at DESC LIMIT ?`,
      [userId, limit],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  /** Counts how often we've been ignored on a given attribute-class. Drives back-off. */
  async ignoreRateForAttribute(userId: string, attribute: string): Promise<number> {
    const row = await this.db.queryOne(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status='ignored' THEN 1 ELSE 0 END) AS ignored FROM kg_questions WHERE user_id = ? AND attribute = ?`,
      [userId, attribute],
    ) as { total: number | string; ignored: number | string } | undefined;
    if (!row || Number(row.total) === 0) return 0;
    return Number(row.ignored) / Number(row.total);
  }

  private mapRow(r: Record<string, unknown>): KgQuestion {
    return {
      id: r.id as string,
      userId: r.user_id as string,
      targetKind: r.target_kind as string,
      targetId: r.target_id as string,
      attribute: r.attribute as string,
      questionText: r.question_text as string,
      askedAt: r.asked_at as string,
      askedViaPlatform: r.asked_via_platform as string | undefined,
      askedViaChatId: r.asked_via_chat_id as string | undefined,
      status: r.status as QuestionStatus,
      answeredAt: r.answered_at as string | undefined,
      answerText: r.answer_text as string | undefined,
      parsedValue: r.parsed_value as string | undefined,
      ignoreCount: Number(r.ignore_count ?? 0),
    };
  }
}
