import type BetterSqlite3 from 'better-sqlite3';
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
  constructor(private readonly db: BetterSqlite3.Database) {}

  // ── User CRUD ──────────────────────────────────────────────

  create(opts: { username: string; role: UserRole; displayName?: string; createdBy?: string }): AlfredUser {
    const id = randomUUID();
    const inviteCode = String(randomInt(100000, 999999));
    const inviteExpiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO alfred_users (id, username, role, display_name, invite_code, invite_expires_at, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, opts.username, opts.role, opts.displayName ?? null, inviteCode, inviteExpiresAt, opts.createdBy ?? null, now);

    return { id, username: opts.username, role: opts.role, displayName: opts.displayName, inviteCode, inviteExpiresAt, createdBy: opts.createdBy, active: true, settings: {}, createdAt: now };
  }

  getById(id: string): AlfredUser | undefined {
    const row = this.db.prepare('SELECT * FROM alfred_users WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapUser(row) : undefined;
  }

  getByUsername(username: string): AlfredUser | undefined {
    const row = this.db.prepare('SELECT * FROM alfred_users WHERE username = ?').get(username) as Record<string, unknown> | undefined;
    return row ? this.mapUser(row) : undefined;
  }

  getByInviteCode(code: string): AlfredUser | undefined {
    const row = this.db.prepare('SELECT * FROM alfred_users WHERE invite_code = ? AND invite_expires_at > datetime(\'now\')').get(code) as Record<string, unknown> | undefined;
    return row ? this.mapUser(row) : undefined;
  }

  getAll(): AlfredUser[] {
    const rows = this.db.prepare('SELECT * FROM alfred_users ORDER BY created_at').all() as Record<string, unknown>[];
    return rows.map(r => this.mapUser(r));
  }

  getActive(): AlfredUser[] {
    const rows = this.db.prepare('SELECT * FROM alfred_users WHERE active = 1 ORDER BY created_at').all() as Record<string, unknown>[];
    return rows.map(r => this.mapUser(r));
  }

  updateRole(id: string, role: UserRole): boolean {
    return this.db.prepare('UPDATE alfred_users SET role = ? WHERE id = ?').run(role, id).changes > 0;
  }

  deactivate(id: string): boolean {
    return this.db.prepare('UPDATE alfred_users SET active = 0 WHERE id = ?').run(id).changes > 0;
  }

  activate(id: string): boolean {
    return this.db.prepare('UPDATE alfred_users SET active = 1 WHERE id = ?').run(id).changes > 0;
  }

  clearInviteCode(id: string): void {
    this.db.prepare('UPDATE alfred_users SET invite_code = NULL, invite_expires_at = NULL WHERE id = ?').run(id);
  }

  regenerateInviteCode(id: string): string {
    const code = String(randomInt(100000, 999999));
    const expires = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    this.db.prepare('UPDATE alfred_users SET invite_code = ?, invite_expires_at = ? WHERE id = ?').run(code, expires, id);
    return code;
  }

  updateSettings(id: string, settings: Record<string, unknown>): void {
    this.db.prepare('UPDATE alfred_users SET settings = ? WHERE id = ?').run(JSON.stringify(settings), id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM alfred_users WHERE id = ?').run(id).changes > 0;
  }

  /**
   * Atomically consume an invite code: verify, link platform, clear code.
   * Returns the user or null if code is invalid/expired.
   */
  consumeInviteCode(code: string, platform: string, platformUserId: string): AlfredUser | null {
    const consume = this.db.transaction(() => {
      const user = this.getByInviteCode(code);
      if (!user) return null;

      // Check if platform user already linked
      const existing = this.getUserByPlatform(platform, platformUserId);
      if (existing) return null;

      this.linkPlatform(user.id, platform, platformUserId);
      this.clearInviteCode(user.id);
      return user;
    });
    return consume();
  }

  // ── Platform Links ─────────────────────────────────────────

  linkPlatform(userId: string, platform: string, platformUserId: string): UserPlatformLink {
    const now = new Date().toISOString();
    // Check if link already exists
    const existing = this.db.prepare(
      'SELECT id FROM user_platform_links WHERE platform = ? AND platform_user_id = ?',
    ).get(platform, platformUserId) as { id: string } | undefined;

    if (existing) {
      this.db.prepare('UPDATE user_platform_links SET user_id = ?, linked_at = ? WHERE id = ?').run(userId, now, existing.id);
      return { id: existing.id, userId, platform, platformUserId, linkedAt: now };
    }

    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO user_platform_links (id, user_id, platform, platform_user_id, linked_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, userId, platform, platformUserId, now);
    return { id, userId, platform, platformUserId, linkedAt: now };
  }

  getUserByPlatform(platform: string, platformUserId: string): AlfredUser | undefined {
    const link = this.db.prepare(
      'SELECT user_id FROM user_platform_links WHERE platform = ? AND platform_user_id = ?',
    ).get(platform, platformUserId) as { user_id: string } | undefined;
    if (!link) return undefined;
    return this.getById(link.user_id);
  }

  getPlatformLinks(userId: string): UserPlatformLink[] {
    const rows = this.db.prepare('SELECT * FROM user_platform_links WHERE user_id = ?').all(userId) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string,
      userId: r.user_id as string,
      platform: r.platform as string,
      platformUserId: r.platform_user_id as string,
      linkedAt: r.linked_at as string,
    }));
  }

  unlinkPlatform(userId: string, platform: string): boolean {
    return this.db.prepare('DELETE FROM user_platform_links WHERE user_id = ? AND platform = ?').run(userId, platform).changes > 0;
  }

  // ── User Services ──────────────────────────────────────────

  addService(userId: string, serviceType: string, serviceName: string, config: Record<string, unknown>): UserService {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR REPLACE INTO user_services (id, user_id, service_type, service_name, config, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, userId, serviceType, serviceName, JSON.stringify(config), now);
    return { id, userId, serviceType, serviceName, config, createdAt: now };
  }

  getServices(userId: string): UserService[] {
    const rows = this.db.prepare('SELECT * FROM user_services WHERE user_id = ?').all(userId) as Record<string, unknown>[];
    return rows.map(r => this.mapService(r));
  }

  getService(userId: string, serviceType: string, serviceName?: string): UserService | undefined {
    const row = serviceName
      ? this.db.prepare('SELECT * FROM user_services WHERE user_id = ? AND service_type = ? AND service_name = ?').get(userId, serviceType, serviceName) as Record<string, unknown> | undefined
      : this.db.prepare('SELECT * FROM user_services WHERE user_id = ? AND service_type = ? LIMIT 1').get(userId, serviceType) as Record<string, unknown> | undefined;
    return row ? this.mapService(row) : undefined;
  }

  removeService(userId: string, serviceType: string, serviceName: string): boolean {
    return this.db.prepare('DELETE FROM user_services WHERE user_id = ? AND service_type = ? AND service_name = ?').run(userId, serviceType, serviceName).changes > 0;
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
