import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Watch, WatchCondition } from '@alfred/types';

export class WatchRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  create(watch: Omit<Watch, 'id' | 'createdAt' | 'lastCheckedAt' | 'lastTriggeredAt' | 'lastValue'>): Watch {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO watches
        (id, chat_id, platform, name, skill_name, skill_params,
         condition_field, condition_operator, condition_value,
         interval_minutes, cooldown_minutes, enabled, created_at, message_template)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      watch.chatId,
      watch.platform,
      watch.name,
      watch.skillName,
      JSON.stringify(watch.skillParams),
      watch.condition.field,
      watch.condition.operator,
      watch.condition.value != null ? String(watch.condition.value) : null,
      watch.intervalMinutes,
      watch.cooldownMinutes,
      watch.enabled ? 1 : 0,
      now,
      watch.messageTemplate ?? null,
    );

    return {
      id,
      chatId: watch.chatId,
      platform: watch.platform,
      name: watch.name,
      skillName: watch.skillName,
      skillParams: watch.skillParams,
      condition: watch.condition,
      intervalMinutes: watch.intervalMinutes,
      cooldownMinutes: watch.cooldownMinutes,
      enabled: watch.enabled,
      lastCheckedAt: null,
      lastTriggeredAt: null,
      lastValue: null,
      createdAt: now,
      messageTemplate: watch.messageTemplate,
    };
  }

  getDue(): Watch[] {
    const rows = this.db.prepare(`
      SELECT * FROM watches
      WHERE enabled = 1
        AND (last_checked_at IS NULL
             OR datetime(last_checked_at, '+' || interval_minutes || ' minutes') <= datetime('now'))
      ORDER BY last_checked_at ASC
    `).all() as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  updateAfterCheck(id: string, update: {
    lastCheckedAt: string;
    lastValue: string | null;
    lastTriggeredAt?: string;
  }): void {
    if (update.lastTriggeredAt) {
      this.db.prepare(`
        UPDATE watches
        SET last_checked_at = ?, last_value = ?, last_triggered_at = ?
        WHERE id = ?
      `).run(update.lastCheckedAt, update.lastValue, update.lastTriggeredAt, id);
    } else {
      this.db.prepare(`
        UPDATE watches
        SET last_checked_at = ?, last_value = ?
        WHERE id = ?
      `).run(update.lastCheckedAt, update.lastValue, id);
    }
  }

  findByChatId(chatId: string, platform: string): Watch[] {
    const rows = this.db.prepare(
      `SELECT * FROM watches WHERE chat_id = ? AND platform = ? ORDER BY created_at DESC`,
    ).all(chatId, platform) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  toggle(id: string, enabled: boolean): boolean {
    const result = this.db.prepare(
      `UPDATE watches SET enabled = ? WHERE id = ?`,
    ).run(enabled ? 1 : 0, id);
    return result.changes > 0;
  }

  delete(id: string): boolean {
    const result = this.db.prepare(
      `DELETE FROM watches WHERE id = ?`,
    ).run(id);
    return result.changes > 0;
  }

  getById(id: string): Watch | undefined {
    const row = this.db.prepare(
      `SELECT * FROM watches WHERE id = ?`,
    ).get(id) as Record<string, unknown> | undefined;

    return row ? this.mapRow(row) : undefined;
  }

  private mapRow(row: Record<string, unknown>): Watch {
    let skillParams: Record<string, unknown> = {};
    try { skillParams = JSON.parse(row.skill_params as string); } catch { /* empty */ }

    const condition: WatchCondition = {
      field: row.condition_field as string,
      operator: row.condition_operator as WatchCondition['operator'],
    };
    if (row.condition_value != null) {
      const num = Number(row.condition_value);
      condition.value = isNaN(num) ? row.condition_value as string : num;
    }

    return {
      id: row.id as string,
      chatId: row.chat_id as string,
      platform: row.platform as string,
      name: row.name as string,
      skillName: row.skill_name as string,
      skillParams,
      condition,
      intervalMinutes: row.interval_minutes as number,
      cooldownMinutes: row.cooldown_minutes as number,
      enabled: (row.enabled as number) === 1,
      lastCheckedAt: (row.last_checked_at as string) ?? null,
      lastTriggeredAt: (row.last_triggered_at as string) ?? null,
      lastValue: (row.last_value as string) ?? null,
      createdAt: row.created_at as string,
      messageTemplate: row.message_template as string | undefined,
    };
  }
}
