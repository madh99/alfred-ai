import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ScheduledAction } from '@alfred/types';

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
  constructor(private readonly db: BetterSqlite3.Database) {}

  countEnabled(): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM scheduled_actions WHERE enabled = 1'
    ).get() as { cnt: number };
    return row.cnt;
  }

  create(data: CreateScheduledActionInput): ScheduledAction {
    const now = new Date().toISOString();
    const id = randomUUID();

    const nextRunAt = this.calculateInitialNextRun(data.scheduleType, data.scheduleValue);

    this.db.prepare(`
      INSERT INTO scheduled_actions
        (id, user_id, platform, chat_id, name, description, schedule_type, schedule_value,
         skill_name, skill_input, prompt_template, enabled, next_run_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
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
    );

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

  findById(id: string): ScheduledAction | undefined {
    const row = this.db.prepare(
      `SELECT * FROM scheduled_actions WHERE id = ?`,
    ).get(id) as Record<string, unknown> | undefined;

    return row ? this.mapRow(row) : undefined;
  }

  getByUser(userId: string): ScheduledAction[] {
    const rows = this.db.prepare(
      `SELECT * FROM scheduled_actions WHERE user_id = ? ORDER BY created_at DESC`,
    ).all(userId) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  getDue(): ScheduledAction[] {
    const now = new Date().toISOString();
    const rows = this.db.prepare(
      `SELECT * FROM scheduled_actions
       WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC`,
    ).all(now) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  updateLastRun(id: string, lastRunAt: string, nextRunAt: string | null): void {
    this.db.prepare(`
      UPDATE scheduled_actions
      SET last_run_at = ?, next_run_at = ?
      WHERE id = ?
    `).run(lastRunAt, nextRunAt, id);
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const result = this.db.prepare(
      `UPDATE scheduled_actions SET enabled = ? WHERE id = ?`,
    ).run(enabled ? 1 : 0, id);
    return result.changes > 0;
  }

  delete(id: string): boolean {
    const result = this.db.prepare(
      `DELETE FROM scheduled_actions WHERE id = ?`,
    ).run(id);
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
        return this.getNextCronDate(scheduleValue, now)?.toISOString() ?? null;
      }
      default:
        return null;
    }
  }

  private getNextCronDate(cronExpr: string, after: Date): Date | null {
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    // Try up to 1440 minutes (24 hours) forward to find next match
    const candidate = new Date(after.getTime() + 60_000); // start 1 minute ahead
    candidate.setSeconds(0, 0);

    for (let i = 0; i < 1440; i++) {
      if (this.matchesCron(parts, candidate)) {
        return candidate;
      }
      candidate.setTime(candidate.getTime() + 60_000);
    }

    return null;
  }

  private matchesCron(parts: string[], date: Date): boolean {
    const minute = date.getMinutes();
    const hour = date.getHours();
    const dayOfMonth = date.getDate();
    const month = date.getMonth() + 1;
    const dayOfWeek = date.getDay();

    return (
      this.matchCronField(parts[0], minute) &&
      this.matchCronField(parts[1], hour) &&
      this.matchCronField(parts[2], dayOfMonth) &&
      this.matchCronField(parts[3], month) &&
      this.matchCronField(parts[4], dayOfWeek)
    );
  }

  private matchCronField(field: string, value: number): boolean {
    if (field === '*') return true;

    // */N — every N
    const stepMatch = /^\*\/(\d+)$/.exec(field);
    if (stepMatch) {
      const step = parseInt(stepMatch[1], 10);
      return value % step === 0;
    }

    // Specific number
    const num = parseInt(field, 10);
    if (!isNaN(num)) return value === num;

    return false;
  }

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
