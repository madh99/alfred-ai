import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID, randomInt } from 'node:crypto';

export type UserRole = 'admin' | 'user' | 'family' | 'guest' | 'service';

export interface AlfredUser {
  id: string;
  username: string;
  role: UserRole;
  displayName?: string;
  inviteCode?: string;
  inviteExpiresAt?: string;
  createdBy?: string;
  active: boolean;
  settings: Record<string, unknown>;
  createdAt: string;
}

export interface UserPlatformLink {
  id: string;
  userId: string;
  platform: string;
  platformUserId: string;
  linkedAt: string;
}

export interface UserService {
  id: string;
  userId: string;
  serviceType: string;
  serviceName: string;
  config: Record<string, unknown>;
  createdAt: string;
}

export class AlfredUserRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  // ── User CRUD ──────────────────────────────────────────────

  async create(opts: { username: string; role: UserRole; displayName?: string; createdBy?: string }): Promise<AlfredUser> {
    const id = randomUUID();
    const inviteCode = String(randomInt(100000, 999999));
    const inviteExpiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const now = new Date().toISOString();

    await this.adapter.execute(`
      INSERT INTO alfred_users (id, username, role, display_name, invite_code, invite_expires_at, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, opts.username, opts.role, opts.displayName ?? null, inviteCode, inviteExpiresAt, opts.createdBy ?? null, now]);

    return { id, username: opts.username, role: opts.role, displayName: opts.displayName, inviteCode, inviteExpiresAt, createdBy: opts.createdBy, active: true, settings: {}, createdAt: now };
  }

  async getById(id: string): Promise<AlfredUser | undefined> {
    const row = await this.adapter.queryOne('SELECT * FROM alfred_users WHERE id = ?', [id]) as Record<string, unknown> | undefined;
    return row ? this.mapUser(row) : undefined;
  }

  async getByUsername(username: string): Promise<AlfredUser | undefined> {
    const row = await this.adapter.queryOne('SELECT * FROM alfred_users WHERE username = ?', [username]) as Record<string, unknown> | undefined;
    return row ? this.mapUser(row) : undefined;
  }

  async getByInviteCode(code: string): Promise<AlfredUser | undefined> {
    const row = await this.adapter.queryOne('SELECT * FROM alfred_users WHERE invite_code = ? AND invite_expires_at > datetime(\'now\')', [code]) as Record<string, unknown> | undefined;
    return row ? this.mapUser(row) : undefined;
  }

  async getAll(): Promise<AlfredUser[]> {
    const rows = await this.adapter.query('SELECT * FROM alfred_users ORDER BY created_at') as Record<string, unknown>[];
    return rows.map(r => this.mapUser(r));
  }

  async getActive(): Promise<AlfredUser[]> {
    const rows = await this.adapter.query('SELECT * FROM alfred_users WHERE active = 1 ORDER BY created_at') as Record<string, unknown>[];
    return rows.map(r => this.mapUser(r));
  }

  async updateRole(id: string, role: UserRole): Promise<boolean> {
    const result = await this.adapter.execute('UPDATE alfred_users SET role = ? WHERE id = ?', [role, id]);
    return result.changes > 0;
  }

  async deactivate(id: string): Promise<boolean> {
    const result = await this.adapter.execute('UPDATE alfred_users SET active = 0 WHERE id = ?', [id]);
    return result.changes > 0;
  }

  async activate(id: string): Promise<boolean> {
    const result = await this.adapter.execute('UPDATE alfred_users SET active = 1 WHERE id = ?', [id]);
    return result.changes > 0;
  }

  async clearInviteCode(id: string): Promise<void> {
    await this.adapter.execute('UPDATE alfred_users SET invite_code = NULL, invite_expires_at = NULL WHERE id = ?', [id]);
  }

  async regenerateInviteCode(id: string): Promise<string> {
    const code = String(randomInt(100000, 999999));
    const expires = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    await this.adapter.execute('UPDATE alfred_users SET invite_code = ?, invite_expires_at = ? WHERE id = ?', [code, expires, id]);
    return code;
  }

  async updateSettings(id: string, settings: Record<string, unknown>): Promise<void> {
    await this.adapter.execute('UPDATE alfred_users SET settings = ? WHERE id = ?', [JSON.stringify(settings), id]);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.adapter.execute('DELETE FROM alfred_users WHERE id = ?', [id]);
    return result.changes > 0;
  }

  /**
   * Atomically consume an invite code: verify, link platform, clear code.
   * Returns the user or null if code is invalid/expired.
   */
  async consumeInviteCode(code: string, platform: string, platformUserId: string): Promise<AlfredUser | null> {
    return await this.adapter.transaction(async (tx) => {
      const user = await tx.queryOne(
        'SELECT * FROM alfred_users WHERE invite_code = ? AND (invite_expires_at IS NULL OR invite_expires_at > ?)',
        [code, new Date().toISOString()],
      ) as Record<string, unknown> | undefined;
      if (!user) return null;
      const alfredUser = this.mapUser(user);

      // Check if platform user already linked
      const existing = await tx.queryOne(
        'SELECT id FROM user_platform_links WHERE platform = ? AND platform_user_id = ?',
        [platform, platformUserId],
      );
      if (existing) return null;

      await tx.execute(
        'INSERT INTO user_platform_links (id, user_id, platform, platform_user_id, linked_at) VALUES (?, ?, ?, ?, ?)',
        [randomUUID(), alfredUser.id, platform, platformUserId, new Date().toISOString()],
      );
      await tx.execute(
        'UPDATE alfred_users SET invite_code = NULL, invite_expires_at = NULL WHERE id = ?',
        [alfredUser.id],
      );
      return alfredUser;
    });
  }

  // ── Platform Links ─────────────────────────────────────────

  async linkPlatform(userId: string, platform: string, platformUserId: string): Promise<UserPlatformLink> {
    const now = new Date().toISOString();
    // Check if link already exists
    const existing = await this.adapter.queryOne(
      'SELECT id FROM user_platform_links WHERE platform = ? AND platform_user_id = ?',
      [platform, platformUserId],
    ) as { id: string } | undefined;

    if (existing) {
      await this.adapter.execute('UPDATE user_platform_links SET user_id = ?, linked_at = ? WHERE id = ?', [userId, now, existing.id]);
      return { id: existing.id, userId, platform, platformUserId, linkedAt: now };
    }

    const id = randomUUID();
    await this.adapter.execute(`
      INSERT INTO user_platform_links (id, user_id, platform, platform_user_id, linked_at)
      VALUES (?, ?, ?, ?, ?)
    `, [id, userId, platform, platformUserId, now]);
    return { id, userId, platform, platformUserId, linkedAt: now };
  }

  async getUserByPlatform(platform: string, platformUserId: string): Promise<AlfredUser | undefined> {
    const link = await this.adapter.queryOne(
      'SELECT user_id FROM user_platform_links WHERE platform = ? AND platform_user_id = ?',
      [platform, platformUserId],
    ) as { user_id: string } | undefined;
    if (!link) return undefined;
    return this.getById(link.user_id);
  }

  async getPlatformLinks(userId: string): Promise<UserPlatformLink[]> {
    const rows = await this.adapter.query('SELECT * FROM user_platform_links WHERE user_id = ?', [userId]) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string,
      userId: r.user_id as string,
      platform: r.platform as string,
      platformUserId: r.platform_user_id as string,
      linkedAt: r.linked_at as string,
    }));
  }

  async unlinkPlatform(userId: string, platform: string): Promise<boolean> {
    const result = await this.adapter.execute('DELETE FROM user_platform_links WHERE user_id = ? AND platform = ?', [userId, platform]);
    return result.changes > 0;
  }

  // ── User Services ──────────────────────────────────────────

  async addService(userId: string, serviceType: string, serviceName: string, config: Record<string, unknown>): Promise<UserService> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(`
      INSERT INTO user_services (id, user_id, service_type, service_name, config, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, service_type, service_name) DO UPDATE SET config = excluded.config
    `, [id, userId, serviceType, serviceName, JSON.stringify(config), now]);
    return { id, userId, serviceType, serviceName, config, createdAt: now };
  }

  async getServices(userId: string): Promise<UserService[]> {
    const rows = await this.adapter.query('SELECT * FROM user_services WHERE user_id = ?', [userId]) as Record<string, unknown>[];
    return rows.map(r => this.mapService(r));
  }

  async getService(userId: string, serviceType: string, serviceName?: string): Promise<UserService | undefined> {
    const row = serviceName
      ? await this.adapter.queryOne('SELECT * FROM user_services WHERE user_id = ? AND service_type = ? AND service_name = ?', [userId, serviceType, serviceName]) as Record<string, unknown> | undefined
      : await this.adapter.queryOne('SELECT * FROM user_services WHERE user_id = ? AND service_type = ? LIMIT 1', [userId, serviceType]) as Record<string, unknown> | undefined;
    return row ? this.mapService(row) : undefined;
  }

  async removeService(userId: string, serviceType: string, serviceName: string): Promise<boolean> {
    const result = await this.adapter.execute('DELETE FROM user_services WHERE user_id = ? AND service_type = ? AND service_name = ?', [userId, serviceType, serviceName]);
    return result.changes > 0;
  }

  // ── Mappers ────────────────────────────────────────────────

  private mapUser(row: Record<string, unknown>): AlfredUser {
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(row.settings as string); } catch { /* empty */ }
    return {
      id: row.id as string,
      username: row.username as string,
      role: row.role as UserRole,
      displayName: row.display_name as string | undefined,
      inviteCode: row.invite_code as string | undefined,
      inviteExpiresAt: row.invite_expires_at as string | undefined,
      createdBy: row.created_by as string | undefined,
      active: (row.active as number) === 1,
      settings,
      createdAt: row.created_at as string,
    };
  }

  private mapService(row: Record<string, unknown>): UserService {
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(row.config as string); } catch { /* empty */ }
    return {
      id: row.id as string,
      userId: row.user_id as string,
      serviceType: row.service_type as string,
      serviceName: row.service_name as string,
      config,
      createdAt: row.created_at as string,
    };
  }
}
