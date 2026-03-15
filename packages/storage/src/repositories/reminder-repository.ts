import type BetterSqlite3 from 'better-sqlite3';
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
  constructor(private readonly db: BetterSqlite3.Database) {}

  create(
    userId: string,
    platform: string,
    chatId: string,
    message: string,
    triggerAt: Date,
  ): ReminderEntry {
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

    this.db.prepare(`
      INSERT INTO reminders (id, user_id, platform, chat_id, message, trigger_at, created_at, fired)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.userId,
      entry.platform,
      entry.chatId,
      entry.message,
      entry.triggerAt,
      entry.createdAt,
      0,
    );

    return entry;
  }

  getDue(): ReminderEntry[] {
    const now = new Date().toISOString();

    const rows = this.db.prepare(
      `SELECT * FROM reminders WHERE fired = 0 AND trigger_at <= ? ORDER BY trigger_at ASC`,
    ).all(now) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  getByUser(userId: string): ReminderEntry[] {
    const rows = this.db.prepare(
      `SELECT * FROM reminders WHERE fired = 0 AND user_id = ? ORDER BY trigger_at ASC`,
    ).all(userId) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  getAllPending(): ReminderEntry[] {
    const rows = this.db.prepare(
      `SELECT * FROM reminders WHERE fired = 0 ORDER BY trigger_at ASC`,
    ).all() as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  markFired(id: string): void {
    this.db.prepare(`UPDATE reminders SET fired = 1 WHERE id = ?`).run(id);
  }

  cancel(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM reminders WHERE id = ?`).run(id);
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
