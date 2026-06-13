import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';
import type { PendingConfirmation } from '@alfred/types';

export class ConfirmationRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async create(input: Omit<PendingConfirmation, 'id' | 'createdAt' | 'resolvedAt' | 'status'>): Promise<PendingConfirmation> {
    const id = randomUUID();
    const now = new Date().toISOString();
    // v657 — extra_actions als JSON. Bei Migration v77 wird die Spalte zugefügt; falls
    // alfred mit alter DB-Version läuft fängt try/catch das ab und schreibt ohne.
    const extraJson = input.extraActions && input.extraActions.length > 0 ? JSON.stringify(input.extraActions) : null;
    try {
      await this.adapter.execute(`
        INSERT INTO pending_confirmations (id, chat_id, platform, source, source_id, description, skill_name, skill_params, extra_actions, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `, [id, input.chatId, input.platform, input.source, input.sourceId, input.description, input.skillName, JSON.stringify(input.skillParams), extraJson, now, input.expiresAt]);
    } catch {
      // Fallback ohne extra_actions Spalte (DB nicht migriert)
      await this.adapter.execute(`
        INSERT INTO pending_confirmations (id, chat_id, platform, source, source_id, description, skill_name, skill_params, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `, [id, input.chatId, input.platform, input.source, input.sourceId, input.description, input.skillName, JSON.stringify(input.skillParams), now, input.expiresAt]);
    }

    return { id, ...input, status: 'pending', createdAt: now };
  }

  async getById(id: string): Promise<PendingConfirmation | undefined> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM pending_confirmations WHERE id = ? AND status = 'pending'`,
      [id],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  /**
   * Look up confirmation by ID regardless of status. Used by the message pipeline to
   * give the user a meaningful response when an inline button is pressed for an action
   * that has already been resolved (approved/rejected/expired) — instead of falling
   * through to the LLM with a confusing "no matching action" reply.
   */
  async getByIdAnyStatus(id: string): Promise<PendingConfirmation | undefined> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM pending_confirmations WHERE id = ?`,
      [id],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  /**
   * v629 — All pending confirmations whose chat_id/platform belongs to the given user.
   * Joins `conversations` to verify ownership so a user can never approve another
   * user's pending confirmation via the web UI.
   */
  async findAllPendingForUser(userId: string | string[], limit = 50): Promise<PendingConfirmation[]> {
    // v637 — accept linked-user-IDs array, sodass Matrix/Discord-Confirmations
    // des Owners auch im Side-Panel landen (conversations.user_id ist platform-spezifisch).
    const userIds = Array.isArray(userId) ? userId : [userId];
    if (userIds.length === 0) return [];
    const userClause = userIds.length === 1 ? 'c.user_id = ?' : `c.user_id IN (${userIds.map(() => '?').join(',')})`;
    const rows = await this.adapter.query(
      `SELECT pc.* FROM pending_confirmations pc
       JOIN conversations c ON c.chat_id = pc.chat_id AND c.platform = pc.platform
       WHERE ${userClause} AND pc.status = 'pending'
       ORDER BY pc.created_at DESC
       LIMIT ?`,
      [...userIds, limit],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async findAllPending(chatId: string, platform: string): Promise<PendingConfirmation[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM pending_confirmations WHERE chat_id = ? AND platform = ? AND status = 'pending' ORDER BY created_at DESC`,
      [chatId, platform],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async findPending(chatId: string, platform: string): Promise<PendingConfirmation | undefined> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM pending_confirmations WHERE chat_id = ? AND platform = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [chatId, platform],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  /** v884 — pending Confirmation, auf deren gesendete Nachricht der User per Reply
   *  geantwortet hat. Löst das "neueste pending"-Problem bei mehreren offenen
   *  Bestätigungen — antwortest du auf eine bestimmte Frage, triffst du genau die. */
  async findPendingBySentMessageId(chatId: string, platform: string, sentMessageId: string): Promise<PendingConfirmation | undefined> {
    try {
      const row = await this.adapter.queryOne(
        `SELECT * FROM pending_confirmations WHERE chat_id = ? AND platform = ? AND sent_message_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
        [chatId, platform, sentMessageId],
      ) as Record<string, unknown> | undefined;
      return row ? this.mapRow(row) : undefined;
    } catch { return undefined; } // Spalte fehlt (DB nicht migriert) → kein Reply-Matching
  }

  /** v884 — message_id der gesendeten Bestätigungs-Nachricht nachtragen (nach dem Versand). */
  async setSentMessageId(id: string, sentMessageId: string): Promise<void> {
    try {
      await this.adapter.execute(
        `UPDATE pending_confirmations SET sent_message_id = ? WHERE id = ?`,
        [sentMessageId, id],
      );
    } catch { /* Spalte fehlt → Reply-Matching inaktiv, Rest unberührt */ }
  }

  async resolve(id: string, status: 'approved' | 'rejected' | 'expired'): Promise<void> {
    const now = new Date().toISOString();
    await this.adapter.execute(
      `UPDATE pending_confirmations SET status = ?, resolved_at = ? WHERE id = ?`,
      [status, now, id],
    );
  }

  async expireOld(): Promise<PendingConfirmation[]> {
    const now = new Date().toISOString();
    // Atomic: select IDs first, then update only those IDs to avoid racing with approve/reject
    const rows = await this.adapter.query(
      `SELECT * FROM pending_confirmations WHERE status = 'pending' AND expires_at <= ?`,
      [now],
    ) as Record<string, unknown>[];

    if (rows.length > 0) {
      const ids = rows.map(r => r.id as string);
      const placeholders = ids.map(() => '?').join(',');
      await this.adapter.execute(
        `UPDATE pending_confirmations SET status = 'expired', resolved_at = ? WHERE id IN (${placeholders}) AND status = 'pending'`,
        [now, ...ids],
      );
    }

    return rows.map(r => this.mapRow(r));
  }

  private mapRow(row: Record<string, unknown>): PendingConfirmation {
    let skillParams: Record<string, unknown> = {};
    try { skillParams = JSON.parse(row.skill_params as string); } catch { /* empty */ }
    let extraActions: PendingConfirmation['extraActions'];
    if (row.extra_actions) {
      try { extraActions = JSON.parse(row.extra_actions as string); } catch { /* skip */ }
    }

    return {
      id: row.id as string,
      chatId: row.chat_id as string,
      platform: row.platform as string,
      source: row.source as PendingConfirmation['source'],
      sourceId: row.source_id as string,
      description: row.description as string,
      skillName: row.skill_name as string,
      skillParams,
      extraActions,
      status: row.status as PendingConfirmation['status'],
      createdAt: row.created_at as string,
      expiresAt: row.expires_at as string,
      resolvedAt: row.resolved_at as string | undefined,
      sentMessageId: (row.sent_message_id as string | null) ?? undefined,
    };
  }
}
