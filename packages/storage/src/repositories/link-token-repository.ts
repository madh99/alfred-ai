import type BetterSqlite3 from 'better-sqlite3';
import type { LinkToken } from '@alfred/types';
import crypto from 'node:crypto';

export class LinkTokenRepository {
  constructor(private db: BetterSqlite3.Database) {}

  create(userId: string, platform: string): LinkToken {
    const token: LinkToken = {
      id: crypto.randomUUID(),
      code: String(Math.floor(100000 + Math.random() * 900000)), // 6-digit
      userId,
      platform,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 min
    };
    this.db.prepare(`
      INSERT INTO link_tokens (id, code, user_id, platform, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(token.id, token.code, token.userId, token.platform, token.createdAt, token.expiresAt);
    return token;
  }

  findByCode(code: string): LinkToken | undefined {
    const row = this.db.prepare(
      'SELECT * FROM link_tokens WHERE code = ? AND expires_at > ?'
    ).get(code, new Date().toISOString()) as Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      code: row.code,
      userId: row.user_id,
      platform: row.platform,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  consume(id: string): void {
    this.db.prepare('DELETE FROM link_tokens WHERE id = ?').run(id);
  }

  cleanup(): void {
    this.db.prepare('DELETE FROM link_tokens WHERE expires_at <= ?').run(new Date().toISOString());
  }
}
