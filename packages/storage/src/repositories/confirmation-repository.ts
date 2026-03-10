import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { PendingConfirmation } from '@alfred/types';

export class ConfirmationRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  create(input: Omit<PendingConfirmation, 'id' | 'createdAt' | 'resolvedAt' | 'status'>): PendingConfirmation {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO pending_confirmations (id, chat_id, platform, source, source_id, description, skill_name, skill_params, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, input.chatId, input.platform, input.source, input.sourceId, input.description, input.skillName, JSON.stringify(input.skillParams), now, input.expiresAt);

    return { id, ...input, status: 'pending', createdAt: now };
  }

  findPending(chatId: string, platform: string): PendingConfirmation | undefined {
    const row = this.db.prepare(
      `SELECT * FROM pending_confirmations WHERE chat_id = ? AND platform = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`
    ).get(chatId, platform) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  resolve(id: string, status: 'approved' | 'rejected' | 'expired'): void {
    this.db.prepare(
      `UPDATE pending_confirmations SET status = ?, resolved_at = datetime('now') WHERE id = ?`
    ).run(status, id);
  }

  expireOld(): PendingConfirmation[] {
    // Atomic: select IDs first, then update only those IDs to avoid racing with approve/reject
    const rows = this.db.prepare(
      `SELECT * FROM pending_confirmations WHERE status = 'pending' AND expires_at <= datetime('now')`
    ).all() as Record<string, unknown>[];

    if (rows.length > 0) {
      const ids = rows.map(r => r.id as string);
      const placeholders = ids.map(() => '?').join(',');
      this.db.prepare(
        `UPDATE pending_confirmations SET status = 'expired', resolved_at = datetime('now') WHERE id IN (${placeholders}) AND status = 'pending'`
      ).run(...ids);
    }

    return rows.map(r => this.mapRow(r));
  }

  private mapRow(row: Record<string, unknown>): PendingConfirmation {
    let skillParams: Record<string, unknown> = {};
    try { skillParams = JSON.parse(row.skill_params as string); } catch { /* empty */ }

    return {
      id: row.id as string,
      chatId: row.chat_id as string,
      platform: row.platform as string,
      source: row.source as 'watch' | 'scheduled',
      sourceId: row.source_id as string,
      description: row.description as string,
      skillName: row.skill_name as string,
      skillParams,
      status: row.status as PendingConfirmation['status'],
      createdAt: row.created_at as string,
      expiresAt: row.expires_at as string,
      resolvedAt: row.resolved_at as string | undefined,
    };
  }
}
