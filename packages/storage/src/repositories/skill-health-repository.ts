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
        success_count = skill_health.success_count + 1,
        consecutive_fails = 0,
        disabled_until = NULL,
        updated_at = excluded.updated_at
    `, [skillName, now]);
  }

  async recordFailure(skillName: string, error: string): Promise<SkillHealth> {
    const now = new Date().toISOString();
    await this.adapter.execute(`
      INSERT INTO skill_health (skill_name, success_count, fail_count, consecutive_fails, last_error, last_error_at, updated_at)
      VALUES (?, 0, 1, 1, ?, ?, ?)
      ON CONFLICT(skill_name) DO UPDATE SET
        fail_count = skill_health.fail_count + 1,
        consecutive_fails = skill_health.consecutive_fails + 1,
        last_error = excluded.last_error,
        last_error_at = excluded.last_error_at,
        updated_at = excluded.updated_at
    `, [skillName, error, now, now]);
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

  // ── v607 D7 — host-specific skill-failure pattern memory ────────────────

  /**
   * Record a skill failure scoped to a specific remote host. Used by skills
   * that operate on remote infrastructure (deploy, ssh, proxmox, etc.) so the
   * LLM can be warned about known-broken combinations on subsequent calls.
   *
   * Idempotent on (skill_name, host, error_class) — increments count.
   */
  async recordHostFailure(input: {
    skillName: string;
    host: string;
    errorClass: string;
    errorMessage?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    // Try update first
    const updateRes = await this.adapter.execute(
      `UPDATE skill_host_failures SET count = count + 1, last_seen = ?, error_message = ? WHERE skill_name = ? AND host = ? AND error_class = ?`,
      [now, input.errorMessage ?? null, input.skillName, input.host, input.errorClass],
    );
    if (updateRes.changes === 0) {
      // No existing row — insert
      const id = (await import('node:crypto')).randomUUID();
      try {
        await this.adapter.execute(
          `INSERT INTO skill_host_failures (id, skill_name, host, error_class, error_message, count, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          [id, input.skillName, input.host, input.errorClass, input.errorMessage ?? null, now, now],
        );
      } catch { /* race: row appeared, retry update */
        await this.adapter.execute(
          `UPDATE skill_host_failures SET count = count + 1, last_seen = ? WHERE skill_name = ? AND host = ? AND error_class = ?`,
          [now, input.skillName, input.host, input.errorClass],
        );
      }
    }
  }

  /**
   * Look up known failures for a (skill, host) pair. Returns most recent first.
   * Used by the reasoning prompt to warn the LLM about known-broken patterns
   * before it invokes the skill again.
   */
  async getHostFailures(skillName: string, host: string): Promise<Array<{
    errorClass: string;
    errorMessage?: string;
    count: number;
    firstSeen: string;
    lastSeen: string;
  }>> {
    const rows = await this.adapter.query(
      `SELECT error_class, error_message, count, first_seen, last_seen
       FROM skill_host_failures
       WHERE skill_name = ? AND host = ?
       ORDER BY last_seen DESC LIMIT 10`,
      [skillName, host],
    ) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      errorClass: r.error_class as string,
      errorMessage: (r.error_message as string | null) ?? undefined,
      count: r.count as number,
      firstSeen: r.first_seen as string,
      lastSeen: r.last_seen as string,
    }));
  }

  /** List recent host-failures across all skills, useful for pipeline-prompt enrichment. */
  async listRecentHostFailures(limit = 20): Promise<Array<{
    skillName: string; host: string; errorClass: string; errorMessage?: string;
    count: number; firstSeen: string; lastSeen: string;
  }>> {
    const rows = await this.adapter.query(
      `SELECT skill_name, host, error_class, error_message, count, first_seen, last_seen
       FROM skill_host_failures ORDER BY last_seen DESC LIMIT ?`,
      [limit],
    ) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      skillName: r.skill_name as string,
      host: r.host as string,
      errorClass: r.error_class as string,
      errorMessage: (r.error_message as string | null) ?? undefined,
      count: r.count as number,
      firstSeen: r.first_seen as string,
      lastSeen: r.last_seen as string,
    }));
  }
}
