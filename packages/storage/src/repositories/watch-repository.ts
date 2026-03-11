import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Watch, WatchCondition, CompositeCondition } from '@alfred/types';

export class WatchRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  create(watch: Omit<Watch, 'id' | 'createdAt' | 'lastCheckedAt' | 'lastTriggeredAt' | 'lastValue'>): Watch {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO watches
        (id, chat_id, platform, name, skill_name, skill_params,
         condition_field, condition_operator, condition_value,
         interval_minutes, cooldown_minutes, enabled, created_at, message_template,
         action_skill_name, action_skill_params, action_on_trigger, conditions_json,
         requires_confirmation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      watch.actionSkillName ?? null,
      watch.actionSkillParams ? JSON.stringify(watch.actionSkillParams) : null,
      watch.actionOnTrigger ?? 'alert',
      watch.compositeCondition ? JSON.stringify(watch.compositeCondition) : null,
      watch.requiresConfirmation ? 1 : 0,
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
      compositeCondition: watch.compositeCondition,
      actionSkillName: watch.actionSkillName,
      actionSkillParams: watch.actionSkillParams,
      actionOnTrigger: watch.actionOnTrigger ?? 'alert',
      requiresConfirmation: watch.requiresConfirmation,
    };
  }

  getEnabled(): Watch[] {
    const rows = this.db.prepare(
      'SELECT * FROM watches WHERE enabled = 1 ORDER BY created_at DESC',
    ).all() as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
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

  updateActionError(id: string, error: string | null): void {
    this.db.prepare(
      `UPDATE watches SET last_action_error = ? WHERE id = ?`,
    ).run(error, id);
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

    let compositeCondition: CompositeCondition | undefined;
    if (row.conditions_json) {
      try { compositeCondition = JSON.parse(row.conditions_json as string) as CompositeCondition; } catch { /* empty */ }
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
      compositeCondition,
      actionSkillName: row.action_skill_name as string | undefined,
      actionSkillParams: row.action_skill_params
        ? (() => { try { return JSON.parse(row.action_skill_params as string); } catch { return undefined; } })()
        : undefined,
      actionOnTrigger: (row.action_on_trigger as Watch['actionOnTrigger']) ?? 'alert',
      lastActionError: row.last_action_error as string | undefined,
      requiresConfirmation: (row.requires_confirmation as number) === 1,
    };
  }
}
