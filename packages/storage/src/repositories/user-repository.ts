import type BetterSqlite3 from 'better-sqlite3';
import type { Platform, User } from '@alfred/types';
import crypto from 'node:crypto';

export class UserRepository {
  private db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  findOrCreate(platform: Platform, platformUserId: string, username?: string, displayName?: string): User {
    const existing = this.db.prepare(
      'SELECT * FROM users WHERE platform = ? AND platform_user_id = ?'
    ).get(platform, platformUserId) as Record<string, string> | undefined;

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

    this.db.prepare(`
      INSERT INTO users (id, platform, platform_user_id, username, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(user.id, user.platform, user.platformUserId, user.username ?? null, user.displayName ?? null, user.createdAt, user.updatedAt);

    return user;
  }

  findById(id: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, string> | undefined;
    if (!row) return undefined;
    return this.mapRow(row);
  }

  update(id: string, data: Partial<Pick<User, 'username' | 'displayName'>>): void {
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

    this.db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  updateProfile(id: string, data: { timezone?: string; language?: string; bio?: string; preferences?: Record<string, unknown> }): void {
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

    this.db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  getProfile(id: string): { timezone?: string; language?: string; bio?: string; preferences?: Record<string, unknown>; displayName?: string } | undefined {
    const row = this.db.prepare('SELECT display_name, timezone, language, bio, preferences FROM users WHERE id = ?').get(id) as Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      displayName: row.display_name ?? undefined,
      timezone: row.timezone ?? undefined,
      language: row.language ?? undefined,
      bio: row.bio ?? undefined,
      preferences: row.preferences ? JSON.parse(row.preferences) : undefined,
    };
  }

  setMasterUser(userId: string, masterUserId: string): void {
    this.db.prepare('UPDATE users SET master_user_id = ?, updated_at = ? WHERE id = ?')
      .run(masterUserId, new Date().toISOString(), userId);
  }

  getLinkedUsers(masterUserId: string): User[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT * FROM users WHERE master_user_id = ? OR id = ?'
    ).all(masterUserId, masterUserId) as Record<string, string>[];
    return rows.map(r => this.mapRow(r));
  }

  findFirstByPlatformNotIn(excludedPlatforms: Platform[]): User | undefined {
    const placeholders = excludedPlatforms.map(() => '?').join(', ');
    const row = this.db.prepare(
      `SELECT * FROM users WHERE platform NOT IN (${placeholders}) LIMIT 1`
    ).get(...excludedPlatforms) as Record<string, string> | undefined;
    if (!row) return undefined;
    return this.mapRow(row);
  }

  getMasterUserId(userId: string): string {
    const row = this.db.prepare('SELECT master_user_id FROM users WHERE id = ?').get(userId) as { master_user_id: string | null } | undefined;
    return row?.master_user_id ?? userId;
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
