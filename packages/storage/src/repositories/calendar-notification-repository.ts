import type BetterSqlite3 from 'better-sqlite3';

export class CalendarNotificationRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  wasNotified(eventId: string, chatId: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM calendar_notifications WHERE event_id = ? AND chat_id = ?'
    ).get(eventId, chatId);
    return !!row;
  }

  markNotified(eventId: string, chatId: string, platform: string, eventStart: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO calendar_notifications (event_id, chat_id, platform, notified_at, event_start)
      VALUES (?, ?, ?, datetime('now'), ?)
    `).run(eventId, chatId, platform, eventStart);
  }

  cleanup(cutoffIso: string): number {
    const result = this.db.prepare(
      'DELETE FROM calendar_notifications WHERE event_start < ?'
    ).run(cutoffIso);
    return result.changes;
  }
}
