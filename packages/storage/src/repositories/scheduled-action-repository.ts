import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';
import { getNextCronDate, type ScheduledAction } from '@alfred/types';

export interface CreateScheduledActionInput {
  userId: string;
  platform: string;
  chatId: string;
  name: string;
  description: string;
  scheduleType: ScheduledAction['scheduleType'];
  scheduleValue: string;
  skillName: string;
  skillInput: string;
  promptTemplate?: string;
}

export class ScheduledActionRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async countEnabled(): Promise<number> {
    const row = await this.adapter.queryOne(
      'SELECT COUNT(*) as cnt FROM scheduled_actions WHERE enabled = 1'
    ) as { cnt: number };
    return row.cnt;
  }

  async create(data: CreateScheduledActionInput): Promise<ScheduledAction> {
    const now = new Date().toISOString();
    const id = randomUUID();

    const nextRunAt = this.calculateInitialNextRun(data.scheduleType, data.scheduleValue);

    await this.adapter.execute(`
      INSERT INTO scheduled_actions
        (id, user_id, platform, chat_id, name, description, schedule_type, schedule_value,
         skill_name, skill_input, prompt_template, enabled, next_run_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `, [
      id,
      data.userId,
      data.platform,
      data.chatId,
      data.name,
      data.description,
      data.scheduleType,
      data.scheduleValue,
      data.skillName,
      data.skillInput,
      data.promptTemplate ?? null,
      nextRunAt,
      now,
    ]);

    return {
      id,
      userId: data.userId,
      platform: data.platform,
      chatId: data.chatId,
      name: data.name,
      description: data.description,
      scheduleType: data.scheduleType,
      scheduleValue: data.scheduleValue,
      skillName: data.skillName,
      skillInput: data.skillInput,
      promptTemplate: data.promptTemplate,
      enabled: true,
      nextRunAt: nextRunAt ?? undefined,
      createdAt: now,
    };
  }

  async findById(id: string): Promise<ScheduledAction | undefined> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM scheduled_actions WHERE id = ?`,
      [id],
    ) as Record<string, unknown> | undefined;

    return row ? this.mapRow(row) : undefined;
  }

  async getAll(): Promise<ScheduledAction[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM scheduled_actions WHERE enabled = 1 ORDER BY next_run_at ASC`,
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  async getByUser(userId: string): Promise<ScheduledAction[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM scheduled_actions WHERE user_id = ? ORDER BY created_at DESC`,
      [userId],
    ) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  async getDue(): Promise<ScheduledAction[]> {
    const now = new Date().toISOString();
    const rows = await this.adapter.query(
      `SELECT * FROM scheduled_actions
       WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC`,
      [now],
    ) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  async updateLastRun(id: string, lastRunAt: string, nextRunAt: string | null): Promise<void> {
    await this.adapter.execute(`
      UPDATE scheduled_actions
      SET last_run_at = ?, next_run_at = ?
      WHERE id = ?
    `, [lastRunAt, nextRunAt, id]);
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const result = await this.adapter.execute(
      `UPDATE scheduled_actions SET enabled = ? WHERE id = ?`,
      [enabled ? 1 : 0, id],
    );
    return result.changes > 0;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.adapter.execute(
      `DELETE FROM scheduled_actions WHERE id = ?`,
      [id],
    );
    return result.changes > 0;
  }

  private calculateInitialNextRun(
    scheduleType: ScheduledAction['scheduleType'],
    scheduleValue: string,
  ): string | null {
    const now = new Date();

    switch (scheduleType) {
      case 'interval': {
        const minutes = parseInt(scheduleValue, 10);
        if (isNaN(minutes) || minutes <= 0) return null;
        return new Date(now.getTime() + minutes * 60_000).toISOString();
      }
      case 'once': {
        return new Date(scheduleValue).toISOString();
      }
      case 'cron': {
        return getNextCronDate(scheduleValue, now)?.toISOString() ?? null;
      }
      default:
        return null;
    }
  }

  // Cron matching delegated to shared @alfred/types cron utilities

  private mapRow(row: Record<string, unknown>): ScheduledAction {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      platform: row.platform as string,
      chatId: row.chat_id as string,
      name: row.name as string,
      description: row.description as string,
      scheduleType: row.schedule_type as ScheduledAction['scheduleType'],
      scheduleValue: row.schedule_value as string,
      skillName: row.skill_name as string,
      skillInput: row.skill_input as string,
      promptTemplate: row.prompt_template as string | undefined,
      enabled: (row.enabled as number) === 1,
      lastRunAt: row.last_run_at as string | undefined,
      nextRunAt: row.next_run_at as string | undefined,
      createdAt: row.created_at as string,
    };
  }
}
