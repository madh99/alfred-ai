import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';
import type { PendingConfirmation } from '@alfred/types';

export class ConfirmationRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async create(input: Omit<PendingConfirmation, 'id' | 'createdAt' | 'resolvedAt' | 'status'>): Promise<PendingConfirmation> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(`
      INSERT INTO pending_confirmations (id, chat_id, platform, source, source_id, description, skill_name, skill_params, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `, [id, input.chatId, input.platform, input.source, input.sourceId, input.description, input.skillName, JSON.stringify(input.skillParams), now, input.expiresAt]);

    return { id, ...input, status: 'pending', createdAt: now };
  }

  async getById(id: string): Promise<PendingConfirmation | undefined> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM pending_confirmations WHERE id = ? AND status = 'pending'`,
      [id],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
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

    return {
      id: row.id as string,
      chatId: row.chat_id as string,
      platform: row.platform as string,
      source: row.source as PendingConfirmation['source'],
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
