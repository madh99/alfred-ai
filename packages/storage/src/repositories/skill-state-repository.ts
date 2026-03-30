import type { AsyncDbAdapter } from '../db-adapter.js';

export interface SkillStateEntry {
  id: string;
  userId: string;
  skill: string;
  key: string;
  value: string;
  updatedAt: string;
  expiresAt?: string | null;
}

export class SkillStateRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async get(userId: string, skill: string, key: string): Promise<string | undefined> {
    const row = await this.adapter.queryOne(
      'SELECT value FROM skill_state WHERE user_id = ? AND skill = ? AND key = ?',
      [userId, skill, key],
    ) as { value: string } | undefined;
    return row?.value;
  }

  async set(userId: string, skill: string, key: string, value: string, ttlMinutes?: number): Promise<void> {
    const id = `${userId}:${skill}:${key}`;
    const now = new Date().toISOString();
    const expiresAt = ttlMinutes ? new Date(Date.now() + ttlMinutes * 60_000).toISOString() : null;
    await this.adapter.execute(
      `INSERT INTO skill_state (id, user_id, skill, key, value, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, skill, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
      [id, userId, skill, key, value, now, expiresAt],
    );
  }

  async delete(userId: string, skill: string, key: string): Promise<boolean> {
    const result = await this.adapter.execute(
      'DELETE FROM skill_state WHERE user_id = ? AND skill = ? AND key = ?',
      [userId, skill, key],
    );
    return (result as any)?.changes > 0;
  }

  async listBySkill(userId: string, skill: string): Promise<SkillStateEntry[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM skill_state WHERE user_id = ? AND skill = ? ORDER BY updated_at DESC',
      [userId, skill],
    ) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string,
      userId: r.user_id as string,
      skill: r.skill as string,
      key: r.key as string,
      value: r.value as string,
      updatedAt: r.updated_at as string,
      expiresAt: r.expires_at as string | null,
    }));
  }

  async cleanupExpired(): Promise<number> {
    const result = await this.adapter.execute(
      "DELETE FROM skill_state WHERE expires_at IS NOT NULL AND expires_at < datetime('now')",
      [],
    );
    return (result as any)?.changes ?? 0;
  }
}
