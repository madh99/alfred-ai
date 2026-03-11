import type BetterSqlite3 from 'better-sqlite3';
import type { SkillHealth } from '@alfred/types';

export class SkillHealthRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  getByName(skillName: string): SkillHealth | undefined {
    const row = this.db.prepare(
      'SELECT * FROM skill_health WHERE skill_name = ?',
    ).get(skillName) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  getAll(): SkillHealth[] {
    const rows = this.db.prepare(
      'SELECT * FROM skill_health ORDER BY updated_at DESC',
    ).all() as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  recordSuccess(skillName: string): void {
    this.db.prepare(`
      INSERT INTO skill_health (skill_name, success_count, fail_count, consecutive_fails, updated_at)
      VALUES (?, 1, 0, 0, datetime('now'))
      ON CONFLICT(skill_name) DO UPDATE SET
        success_count = success_count + 1,
        consecutive_fails = 0,
        disabled_until = NULL,
        updated_at = datetime('now')
    `).run(skillName);
  }

  recordFailure(skillName: string, error: string): SkillHealth {
    this.db.prepare(`
      INSERT INTO skill_health (skill_name, success_count, fail_count, consecutive_fails, last_error, last_error_at, updated_at)
      VALUES (?, 0, 1, 1, ?, datetime('now'), datetime('now'))
      ON CONFLICT(skill_name) DO UPDATE SET
        fail_count = fail_count + 1,
        consecutive_fails = consecutive_fails + 1,
        last_error = ?,
        last_error_at = datetime('now'),
        updated_at = datetime('now')
    `).run(skillName, error, error);
    return this.getByName(skillName)!;
  }

  disable(skillName: string, until: string): void {
    this.db.prepare(`
      UPDATE skill_health SET disabled_until = ?, updated_at = datetime('now')
      WHERE skill_name = ?
    `).run(until, skillName);
  }

  enable(skillName: string): void {
    this.db.prepare(`
      UPDATE skill_health SET disabled_until = NULL, consecutive_fails = 0, updated_at = datetime('now')
      WHERE skill_name = ?
    `).run(skillName);
  }

  isDisabled(skillName: string): boolean {
    const row = this.db.prepare(
      "SELECT disabled_until FROM skill_health WHERE skill_name = ? AND disabled_until > datetime('now')",
    ).get(skillName) as Record<string, unknown> | undefined;
    return !!row;
  }

  getDisabled(): SkillHealth[] {
    const rows = this.db.prepare(
      "SELECT * FROM skill_health WHERE disabled_until > datetime('now')",
    ).all() as Record<string, unknown>[];
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
