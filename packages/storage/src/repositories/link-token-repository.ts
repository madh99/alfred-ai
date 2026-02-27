import type BetterSqlite3 from 'better-sqlite3';
import type { LinkToken } from '@alfred/types';
import crypto from 'node:crypto';

export class LinkTokenRepository {
  constructor(private db: BetterSqlite3.Database) {}

  create(userId: string, platform: string): LinkToken {
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
        this.db.prepare(`
          INSERT INTO link_tokens (id, code, user_id, platform, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(token.id, token.code, token.userId, token.platform, token.createdAt, token.expiresAt);
        return token;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        if (!msg.includes('UNIQUE') || attempt === 4) throw err;
        // Code collision — retry with a new code
      }
    }
    throw new Error('Failed to generate unique link code after retries');
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

  /** Count recent failed confirmation attempts for a user (for rate limiting). */
  countRecentByUser(userId: string, withinMinutes = 10): number {
    const since = new Date(Date.now() - withinMinutes * 60_000).toISOString();
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM link_tokens WHERE user_id = ? AND created_at > ?'
    ).get(userId, since) as { cnt: number };
    return row.cnt;
  }

  cleanup(): void {
    this.db.prepare('DELETE FROM link_tokens WHERE expires_at <= ?').run(new Date().toISOString());
  }
}
