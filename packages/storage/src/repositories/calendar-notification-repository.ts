import type { AsyncDbAdapter } from '../db-adapter.js';

export class CalendarNotificationRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async wasNotified(eventId: string, chatId: string): Promise<boolean> {
    const row = await this.adapter.queryOne(
      'SELECT 1 FROM calendar_notifications WHERE event_id = ? AND chat_id = ?', [eventId, chatId],
    );
    return !!row;
  }

  async markNotified(eventId: string, chatId: string, platform: string, eventStart: string): Promise<void> {
    const now = new Date().toISOString();
    await this.adapter.execute(`
      INSERT INTO calendar_notifications (event_id, chat_id, platform, notified_at, event_start)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (event_id, chat_id) DO NOTHING
    `, [eventId, chatId, platform, now, eventStart]);
  }

  async cleanup(cutoffIso: string): Promise<number> {
    const result = await this.adapter.execute(
      'DELETE FROM calendar_notifications WHERE event_start < ?', [cutoffIso],
    );
    return result.changes;
  }
}
