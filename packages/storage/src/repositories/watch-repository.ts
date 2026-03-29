import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';
import type { Watch, WatchCondition, CompositeCondition } from '@alfred/types';

export class WatchRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async create(watch: Omit<Watch, 'id' | 'createdAt' | 'lastCheckedAt' | 'lastTriggeredAt' | 'lastValue'>): Promise<Watch> {
    const id = randomUUID();
    const now = new Date().toISOString();

    await this.adapter.execute(`
      INSERT INTO watches
        (id, chat_id, platform, name, skill_name, skill_params,
         condition_field, condition_operator, condition_value,
         interval_minutes, cooldown_minutes, enabled, created_at, message_template,
         action_skill_name, action_skill_params, action_on_trigger, conditions_json,
         requires_confirmation, trigger_watch_id, user_id, thread_id,
         quiet_hours_start, quiet_hours_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
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
      watch.triggerWatchId ?? null,
      watch.userId ?? null,
      watch.threadId ?? null,
      watch.quietHoursStart ?? null,
      watch.quietHoursEnd ?? null,
    ]);

    return {
      id,
      userId: watch.userId,
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
      triggerWatchId: watch.triggerWatchId,
      threadId: watch.threadId,
      quietHoursStart: watch.quietHoursStart,
      quietHoursEnd: watch.quietHoursEnd,
    };
  }

  async countEnabled(): Promise<number> {
    const row = await this.adapter.queryOne(
      'SELECT COUNT(*) as cnt FROM watches WHERE enabled = 1'
    ) as { cnt: number };
    return row.cnt;
  }

  async getEnabled(): Promise<Watch[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM watches WHERE enabled = 1 ORDER BY created_at DESC',
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  async getDue(): Promise<Watch[]> {
    const sql = this.adapter.type === 'postgres'
      ? `SELECT * FROM watches WHERE enabled = 1
         AND (last_checked_at IS NULL
              OR last_checked_at::timestamp + (interval_minutes * interval '1 minute') <= NOW())
         ORDER BY last_checked_at ASC`
      : `SELECT * FROM watches WHERE enabled = 1
         AND (last_checked_at IS NULL
              OR datetime(last_checked_at, '+' || interval_minutes || ' minutes') <= datetime('now'))
         ORDER BY last_checked_at ASC`;
    const rows = await this.adapter.query(sql) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  async claimDue(nodeId: string, claimTtlMs = 300_000): Promise<Watch[]> {
    if (this.adapter.type === 'postgres') {
      const now = new Date().toISOString();
      const claimExpiresAt = new Date(Date.now() + claimTtlMs).toISOString();
      const rows = await this.adapter.query(`
        WITH candidates AS (
          SELECT id FROM watches
          WHERE enabled = 1
            AND (last_checked_at IS NULL OR last_checked_at::timestamp + (interval_minutes * interval '1 minute') <= NOW())
            AND (claimed_by IS NULL OR claim_expires_at < $1)
          FOR UPDATE SKIP LOCKED
        )
        UPDATE watches SET claimed_by = $2, claim_expires_at = $3
        WHERE id IN (SELECT id FROM candidates)
        RETURNING *
      `, [now, nodeId, claimExpiresAt]) as Record<string, unknown>[];
      return rows.map((row) => this.mapRow(row));
    }
    // SQLite: single-node, no claim needed
    return this.getDue();
  }

  async claimSingle(watchId: string, nodeId: string, claimTtlMs = 300_000): Promise<boolean> {
    if (this.adapter.type === 'postgres') {
      const now = new Date().toISOString();
      const claimExpiresAt = new Date(Date.now() + claimTtlMs).toISOString();
      const rows = await this.adapter.query(
        `UPDATE watches SET claimed_by = $1, claim_expires_at = $2
         WHERE id = $3 AND (claimed_by IS NULL OR claim_expires_at < $4)
         RETURNING id`,
        [nodeId, claimExpiresAt, watchId, now],
      ) as Record<string, unknown>[];
      return rows.length > 0;
    }
    // SQLite: single-node, always succeed
    return true;
  }

  async updateAfterCheck(id: string, update: {
    lastCheckedAt: string;
    lastValue: string | null;
    lastTriggeredAt?: string;
  }): Promise<void> {
    if (update.lastTriggeredAt) {
      await this.adapter.execute(`
        UPDATE watches
        SET last_checked_at = ?, last_value = ?, last_triggered_at = ?, claimed_by = NULL, claim_expires_at = NULL
        WHERE id = ?
      `, [update.lastCheckedAt, update.lastValue, update.lastTriggeredAt, id]);
    } else {
      await this.adapter.execute(`
        UPDATE watches
        SET last_checked_at = ?, last_value = ?, claimed_by = NULL, claim_expires_at = NULL
        WHERE id = ?
      `, [update.lastCheckedAt, update.lastValue, id]);
    }
  }

  async findByChatId(chatId: string, platform: string): Promise<Watch[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM watches WHERE chat_id = ? AND platform = ? ORDER BY created_at DESC`,
      [chatId, platform],
    ) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  async toggle(id: string, enabled: boolean): Promise<boolean> {
    const result = await this.adapter.execute(
      `UPDATE watches SET enabled = ? WHERE id = ?`,
      [enabled ? 1 : 0, id],
    );
    return result.changes > 0;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.adapter.execute(
      `DELETE FROM watches WHERE id = ?`,
      [id],
    );
    return result.changes > 0;
  }

  async updateActionError(id: string, error: string | null): Promise<void> {
    await this.adapter.execute(
      `UPDATE watches SET last_action_error = ? WHERE id = ?`,
      [error, id],
    );
  }

  async updateSettings(id: string, settings: {
    cooldownMinutes?: number;
    intervalMinutes?: number;
    quietHoursStart?: string | null;
    quietHoursEnd?: string | null;
    enabled?: boolean;
  }): Promise<void> {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (settings.cooldownMinutes !== undefined) {
      setClauses.push('cooldown_minutes = ?');
      values.push(settings.cooldownMinutes);
    }
    if (settings.intervalMinutes !== undefined) {
      setClauses.push('interval_minutes = ?');
      values.push(settings.intervalMinutes);
    }
    if (settings.quietHoursStart !== undefined) {
      setClauses.push('quiet_hours_start = ?');
      values.push(settings.quietHoursStart);
    }
    if (settings.quietHoursEnd !== undefined) {
      setClauses.push('quiet_hours_end = ?');
      values.push(settings.quietHoursEnd);
    }
    if (settings.enabled !== undefined) {
      setClauses.push('enabled = ?');
      values.push(settings.enabled ? 1 : 0);
    }

    if (setClauses.length === 0) return;

    values.push(id);
    await this.adapter.execute(
      `UPDATE watches SET ${setClauses.join(', ')} WHERE id = ?`,
      values,
    );
  }

  async updateSkillParams(id: string, params: Record<string, unknown>): Promise<void> {
    await this.adapter.execute(
      `UPDATE watches SET skill_params = ? WHERE id = ?`,
      [JSON.stringify(params), id],
    );
  }

  async getById(id: string): Promise<Watch | undefined> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM watches WHERE id = ?`,
      [id],
    ) as Record<string, unknown> | undefined;

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
      userId: row.user_id as string | undefined,
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
      triggerWatchId: row.trigger_watch_id as string | undefined,
      threadId: row.thread_id as string | undefined,
      quietHoursStart: (row.quiet_hours_start as string) ?? null,
      quietHoursEnd: (row.quiet_hours_end as string) ?? null,
    };
  }
}
