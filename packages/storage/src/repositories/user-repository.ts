import type { AsyncDbAdapter } from '../db-adapter.js';
import type { Platform, User } from '@alfred/types';
import crypto from 'node:crypto';

export class UserRepository {
  private readonly adapter: AsyncDbAdapter;

  constructor(adapter: AsyncDbAdapter) {
    this.adapter = adapter;
  }

  async findOrCreate(platform: Platform, platformUserId: string, username?: string, displayName?: string): Promise<User> {
    const existing = await this.adapter.queryOne(
      'SELECT * FROM users WHERE platform = ? AND platform_user_id = ?',
      [platform, platformUserId]
    ) as Record<string, string> | undefined;

    if (existing) {
      return this.mapRow(existing);
    }

    const now = new Date().toISOString();
    const user: User = {
      id: crypto.randomUUID(),
      platform,
      platformUserId,
      username,
      displayName,
      createdAt: now,
      updatedAt: now,
    };

    await this.adapter.execute(`
      INSERT INTO users (id, platform, platform_user_id, username, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [user.id, user.platform, user.platformUserId, user.username ?? null, user.displayName ?? null, user.createdAt, user.updatedAt]);

    return user;
  }

  async findById(id: string): Promise<User | undefined> {
    const row = await this.adapter.queryOne('SELECT * FROM users WHERE id = ?', [id]) as Record<string, string> | undefined;
    if (!row) return undefined;
    return this.mapRow(row);
  }

  async update(id: string, data: Partial<Pick<User, 'username' | 'displayName'>>): Promise<void> {
    const fields: string[] = [];
    const values: (string | null)[] = [];

    if (data.username !== undefined) {
      fields.push('username = ?');
      values.push(data.username ?? null);
    }
    if (data.displayName !== undefined) {
      fields.push('display_name = ?');
      values.push(data.displayName ?? null);
    }

    if (fields.length === 0) return;

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    await this.adapter.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  async updateProfile(id: string, data: { timezone?: string; language?: string; bio?: string; preferences?: Record<string, unknown> }): Promise<void> {
    const fields: string[] = [];
    const values: (string | null)[] = [];

    if (data.timezone !== undefined) {
      fields.push('timezone = ?');
      values.push(data.timezone ?? null);
    }
    if (data.language !== undefined) {
      fields.push('language = ?');
      values.push(data.language ?? null);
    }
    if (data.bio !== undefined) {
      fields.push('bio = ?');
      values.push(data.bio ?? null);
    }
    if (data.preferences !== undefined) {
      fields.push('preferences = ?');
      values.push(data.preferences ? JSON.stringify(data.preferences) : null);
    }

    if (fields.length === 0) return;

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    await this.adapter.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  async getProfile(id: string): Promise<{ timezone?: string; language?: string; bio?: string; preferences?: Record<string, unknown>; displayName?: string } | undefined> {
    const row = await this.adapter.queryOne('SELECT display_name, timezone, language, bio, preferences FROM users WHERE id = ?', [id]) as Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      displayName: row.display_name ?? undefined,
      timezone: row.timezone ?? undefined,
      language: row.language ?? undefined,
      bio: row.bio ?? undefined,
      preferences: row.preferences ? JSON.parse(row.preferences) : undefined,
    };
  }

  async setMasterUser(userId: string, masterUserId: string): Promise<void> {
    await this.adapter.execute('UPDATE users SET master_user_id = ?, updated_at = ? WHERE id = ?',
      [masterUserId, new Date().toISOString(), userId]);
  }

  async getLinkedUsers(masterUserId: string): Promise<User[]> {
    const rows = await this.adapter.query(
      'SELECT DISTINCT * FROM users WHERE master_user_id = ? OR id = ?',
      [masterUserId, masterUserId]
    ) as Record<string, string>[];
    return rows.map(r => this.mapRow(r));
  }

  async findFirstByPlatformNotIn(excludedPlatforms: Platform[]): Promise<User | undefined> {
    const placeholders = excludedPlatforms.map(() => '?').join(', ');
    const row = await this.adapter.queryOne(
      `SELECT * FROM users WHERE platform NOT IN (${placeholders}) LIMIT 1`,
      excludedPlatforms
    ) as Record<string, string> | undefined;
    if (!row) return undefined;
    return this.mapRow(row);
  }

  async getMasterUserId(userId: string): Promise<string> {
    const row = await this.adapter.queryOne('SELECT master_user_id FROM users WHERE id = ?', [userId]) as { master_user_id: string | null } | undefined;
    return row?.master_user_id ?? userId;
  }

  async listAll(): Promise<User[]> {
    const rows = await this.adapter.query('SELECT * FROM users ORDER BY created_at') as Record<string, string>[];
    return rows.map(r => this.mapRow(r));
  }

  private mapRow(row: Record<string, string>): User {
    return {
      id: row.id,
      platform: row.platform as Platform,
      platformUserId: row.platform_user_id,
      username: row.username ?? undefined,
      displayName: row.display_name ?? undefined,
      timezone: row.timezone ?? undefined,
      language: row.language ?? undefined,
      bio: row.bio ?? undefined,
      preferences: row.preferences ? JSON.parse(row.preferences) : undefined,
      masterUserId: row.master_user_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
