import type { AsyncDbAdapter } from '../db-adapter.js';
import type { LinkToken } from '@alfred/types';
import crypto from 'node:crypto';

export class LinkTokenRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async create(userId: string, platform: string): Promise<LinkToken> {
    // Retry up to 5 times in case of code collision (UNIQUE constraint)
    for (let attempt = 0; attempt < 5; attempt++) {
      const token: LinkToken = {
        id: crypto.randomUUID(),
        code: String(Math.floor(100000 + Math.random() * 900000)), // 6-digit
        userId,
        platform,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 min
      };
      try {
        await this.adapter.execute(`
          INSERT INTO link_tokens (id, code, user_id, platform, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [token.id, token.code, token.userId, token.platform, token.createdAt, token.expiresAt]);
        return token;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        if (!msg.includes('UNIQUE') || attempt === 4) throw err;
        // Code collision — retry with a new code
      }
    }
    throw new Error('Failed to generate unique link code after retries');
  }

  async findByCode(code: string): Promise<LinkToken | undefined> {
    const row = await this.adapter.queryOne(
      'SELECT * FROM link_tokens WHERE code = ? AND expires_at > ?',
      [code, new Date().toISOString()],
    ) as Record<string, string> | undefined;
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

  async consume(id: string): Promise<void> {
    await this.adapter.execute('DELETE FROM link_tokens WHERE id = ?', [id]);
  }

  /** Count recent failed confirmation attempts for a user (for rate limiting). */
  async countRecentByUser(userId: string, withinMinutes = 10): Promise<number> {
    const since = new Date(Date.now() - withinMinutes * 60_000).toISOString();
    const row = await this.adapter.queryOne(
      'SELECT COUNT(*) as cnt FROM link_tokens WHERE user_id = ? AND created_at > ?',
      [userId, since],
    ) as { cnt: number };
    return row.cnt;
  }

  async cleanup(): Promise<void> {
    await this.adapter.execute('DELETE FROM link_tokens WHERE expires_at <= ?', [new Date().toISOString()]);
  }

  /** Create a session token (longer code, used for web auth persistence). */
  async createSession(token: string, userId: string, platform: string, expiresAt: string): Promise<void> {
    await this.adapter.execute(`
      INSERT INTO link_tokens (id, code, user_id, platform, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET expires_at = excluded.expires_at
    `, [crypto.randomUUID(), token, userId, platform, new Date().toISOString(), expiresAt]);
  }

  /** Find a session by its token (stored as code). */
  async findByToken(token: string): Promise<{ userId: string; expiresAt: string } | undefined> {
    const row = await this.adapter.queryOne(
      'SELECT user_id, expires_at FROM link_tokens WHERE code = ? AND expires_at > ?',
      [token, new Date().toISOString()],
    ) as { user_id: string; expires_at: string } | undefined;
    if (!row) return undefined;
    return { userId: row.user_id, expiresAt: row.expires_at };
  }
}
