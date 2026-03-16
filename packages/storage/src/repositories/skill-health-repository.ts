import type { AsyncDbAdapter } from '../db-adapter.js';
import type { SkillHealth } from '@alfred/types';

export class SkillHealthRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async getByName(skillName: string): Promise<SkillHealth | undefined> {
    const row = await this.adapter.queryOne(
      'SELECT * FROM skill_health WHERE skill_name = ?', [skillName],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  async getAll(): Promise<SkillHealth[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM skill_health ORDER BY updated_at DESC',
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async recordSuccess(skillName: string): Promise<void> {
    const now = new Date().toISOString();
    await this.adapter.execute(`
      INSERT INTO skill_health (skill_name, success_count, fail_count, consecutive_fails, updated_at)
      VALUES (?, 1, 0, 0, ?)
      ON CONFLICT(skill_name) DO UPDATE SET
        success_count = success_count + 1,
        consecutive_fails = 0,
        disabled_until = NULL,
        updated_at = ?
    `, [skillName, now, now]);
  }

  async recordFailure(skillName: string, error: string): Promise<SkillHealth> {
    const now = new Date().toISOString();
    await this.adapter.execute(`
      INSERT INTO skill_health (skill_name, success_count, fail_count, consecutive_fails, last_error, last_error_at, updated_at)
      VALUES (?, 0, 1, 1, ?, ?, ?)
      ON CONFLICT(skill_name) DO UPDATE SET
        fail_count = fail_count + 1,
        consecutive_fails = consecutive_fails + 1,
        last_error = ?,
        last_error_at = ?,
        updated_at = ?
    `, [skillName, error, now, now, error, now, now]);
    return (await this.getByName(skillName))!;
  }

  async disable(skillName: string, until: string): Promise<void> {
    const now = new Date().toISOString();
    await this.adapter.execute(`
      UPDATE skill_health SET disabled_until = ?, updated_at = ?
      WHERE skill_name = ?
    `, [until, now, skillName]);
  }

  async enable(skillName: string): Promise<void> {
    const now = new Date().toISOString();
    await this.adapter.execute(`
      UPDATE skill_health SET disabled_until = NULL, consecutive_fails = 0, updated_at = ?
      WHERE skill_name = ?
    `, [now, skillName]);
  }

  async isDisabled(skillName: string): Promise<boolean> {
    const now = new Date().toISOString();
    const row = await this.adapter.queryOne(
      "SELECT disabled_until FROM skill_health WHERE skill_name = ? AND disabled_until > ?", [skillName, now],
    ) as Record<string, unknown> | undefined;
    return !!row;
  }

  async getDisabled(): Promise<SkillHealth[]> {
    const now = new Date().toISOString();
    const rows = await this.adapter.query(
      "SELECT * FROM skill_health WHERE disabled_until > ?",
      [now],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  private mapRow(row: Record<string, unknown>): SkillHealth {
    return {
      skillName: row.skill_name as string,
      successCount: row.success_count as number,
      failCount: row.fail_count as number,
      consecutiveFails: row.consecutive_fails as number,
      lastError: row.last_error as string | undefined,
      lastErrorAt: row.last_error_at as string | undefined,
      disabledUntil: row.disabled_until as string | undefined,
      updatedAt: row.updated_at as string,
    };
  }
}
