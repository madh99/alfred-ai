import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

export interface ReminderEntry {
  id: string;
  userId: string;
  platform: string;
  chatId: string;
  message: string;
  triggerAt: string; // ISO datetime
  createdAt: string;
  fired: boolean;
}

export class ReminderRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async create(
    userId: string,
    platform: string,
    chatId: string,
    message: string,
    triggerAt: Date,
  ): Promise<ReminderEntry> {
    const entry: ReminderEntry = {
      id: randomUUID(),
      userId,
      platform,
      chatId,
      message,
      triggerAt: triggerAt.toISOString(),
      createdAt: new Date().toISOString(),
      fired: false,
    };

    await this.adapter.execute(`
      INSERT INTO reminders (id, user_id, platform, chat_id, message, trigger_at, created_at, fired)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      entry.id,
      entry.userId,
      entry.platform,
      entry.chatId,
      entry.message,
      entry.triggerAt,
      entry.createdAt,
      0,
    ]);

    return entry;
  }

  async getDue(): Promise<ReminderEntry[]> {
    const now = new Date().toISOString();

    const rows = await this.adapter.query(
      `SELECT * FROM reminders WHERE fired = 0 AND trigger_at <= ? ORDER BY trigger_at ASC`,
      [now],
    ) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  async getByUser(userId: string): Promise<ReminderEntry[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM reminders WHERE fired = 0 AND user_id = ? ORDER BY trigger_at ASC`,
      [userId],
    ) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  async getAllPending(): Promise<ReminderEntry[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM reminders WHERE fired = 0 ORDER BY trigger_at ASC`,
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  async markFired(id: string): Promise<void> {
    await this.adapter.execute(`UPDATE reminders SET fired = 1 WHERE id = ?`, [id]);
  }

  async cancel(id: string): Promise<boolean> {
    const result = await this.adapter.execute(`DELETE FROM reminders WHERE id = ?`, [id]);
    return result.changes > 0;
  }

  private mapRow(row: Record<string, unknown>): ReminderEntry {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      platform: row.platform as string,
      chatId: row.chat_id as string,
      message: row.message as string,
      triggerAt: row.trigger_at as string,
      createdAt: row.created_at as string,
      fired: (row.fired as number) === 1,
    };
  }
}
