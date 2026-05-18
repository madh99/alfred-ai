import type { AsyncDbAdapter } from '../db-adapter.js';
import type { Conversation, ConversationMessage, Platform } from '@alfred/types';
import crypto from 'node:crypto';

/** Monotonically increasing timestamp — ensures no two messages have the same created_at. */
let lastMessageTs = 0;

export class ConversationRepository {
  private readonly adapter: AsyncDbAdapter;

  constructor(adapter: AsyncDbAdapter) {
    this.adapter = adapter;
  }

  async create(platform: Platform, chatId: string, userId: string): Promise<Conversation> {
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      platform,
      chatId,
      userId,
      createdAt: now,
      updatedAt: now,
    };

    await this.adapter.execute(`
      INSERT INTO conversations (id, platform, chat_id, user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [conversation.id, conversation.platform, conversation.chatId, conversation.userId, conversation.createdAt, conversation.updatedAt]);

    return conversation;
  }

  async findById(id: string): Promise<Conversation | undefined> {
    const row = await this.adapter.queryOne('SELECT * FROM conversations WHERE id = ?', [id]) as Record<string, string> | undefined;
    if (!row) return undefined;
    return this.mapRow(row);
  }

  async findByPlatformChat(platform: Platform, chatId: string): Promise<Conversation | undefined> {
    const row = await this.adapter.queryOne('SELECT * FROM conversations WHERE platform = ? AND chat_id = ?', [platform, chatId]) as Record<string, string> | undefined;
    if (!row) return undefined;
    return this.mapRow(row);
  }

  async findByPlatformAndUser(platform: string, userId: string): Promise<Conversation | undefined> {
    const row = await this.adapter.queryOne('SELECT * FROM conversations WHERE platform = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 1', [platform, userId]) as Record<string, string> | undefined;
    if (!row) return undefined;
    return this.mapRow(row);
  }

  async addMessage(conversationId: string, role: ConversationMessage['role'], content: string, toolCalls?: string): Promise<ConversationMessage> {
    const message: ConversationMessage = {
      id: crypto.randomUUID(),
      conversationId,
      role,
      content,
      toolCalls,
      createdAt: (() => {
        let now = Date.now();
        if (now <= lastMessageTs) now = lastMessageTs + 1;
        lastMessageTs = now;
        return new Date(now).toISOString();
      })(),
    };

    await this.adapter.execute(`
      INSERT INTO messages (id, conversation_id, role, content, tool_calls, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [message.id, message.conversationId, message.role, message.content, message.toolCalls ?? null, message.createdAt]);

    return message;
  }

  async getMessages(conversationId: string, limit = 50): Promise<ConversationMessage[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?) sub ORDER BY created_at ASC, id ASC',
      [conversationId, limit]
    ) as Record<string, string>[];

    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role as ConversationMessage['role'],
      content: row.content,
      toolCalls: row.tool_calls ?? undefined,
      createdAt: row.created_at,
    }));
  }

  async updateTimestamp(id: string): Promise<void> {
    await this.adapter.execute('UPDATE conversations SET updated_at = ? WHERE id = ?', [new Date().toISOString(), id]);
  }

  /** Delete all but the most recent `keep` messages for a conversation. */
  async pruneMessages(conversationId: string, keep: number): Promise<number> {
    const result = await this.adapter.execute(`
      DELETE FROM messages WHERE conversation_id = ? AND id NOT IN (
        SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?
      )
    `, [conversationId, conversationId, keep]);
    return result.changes;
  }

  /**
   * Full-text search across all messages of a user (across ALL their conversations).
   *
   * Joins messages → conversations to filter by user_id, so a user cannot see another
   * user's chat history. Returns matches ranked by FTS score with optional time-decay
   * (newer messages weighted higher).
   *
   * Backend-specific:
   *   - SQLite: uses FTS5 virtual table `messages_fts` with `bm25()` scoring
   *   - Postgres: uses `tsvector` column + `ts_rank` scoring
   */
  async searchMessages(
    userId: string,
    query: string,
    opts?: { limit?: number; roles?: Array<'user' | 'assistant' | 'system' | 'tool'>; sinceDays?: number; timeDecay?: boolean },
  ): Promise<Array<{ id: string; conversationId: string; role: string; content: string; createdAt: string; score: number; platform: string; chatId: string }>> {
    const limit = opts?.limit ?? 20;
    const roles = opts?.roles ?? ['user', 'assistant'];
    const placeholders = roles.map(() => '?').join(',');
    const sinceCutoff = opts?.sinceDays
      ? new Date(Date.now() - opts.sinceDays * 24 * 60 * 60_000).toISOString()
      : null;
    const decay = opts?.timeDecay ?? true;

    if (this.adapter.type === 'postgres') {
      // Postgres: ts_rank with optional exponential time-decay multiplier
      // Decay factor: exp(-age_days / 30) — recent messages weight ~1, 30d-old ~0.37, 90d ~0.05
      const rankExpr = decay
        ? `ts_rank(content_tsv, plainto_tsquery('simple', ?)) * exp(-EXTRACT(EPOCH FROM (now() - m.created_at::timestamptz)) / (30.0 * 86400))`
        : `ts_rank(content_tsv, plainto_tsquery('simple', ?))`;
      const sinceClause = sinceCutoff ? ` AND m.created_at >= ?` : '';
      const params: unknown[] = [query, query]; // rankExpr + plainto_tsquery
      params.push(...roles);
      if (sinceCutoff) params.push(sinceCutoff);
      params.push(userId, limit);
      const sql = `
        SELECT m.id, m.conversation_id, m.role, m.content, m.created_at,
               ${rankExpr} AS score, c.platform, c.chat_id
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE content_tsv @@ plainto_tsquery('simple', ?)
          AND m.role IN (${placeholders})
          ${sinceClause}
          AND c.user_id = ?
        ORDER BY score DESC, m.created_at DESC
        LIMIT ?
      `;
      const rows = await this.adapter.query(sql, params) as Record<string, unknown>[];
      return rows.map(r => ({
        id: r.id as string, conversationId: r.conversation_id as string,
        role: r.role as string, content: r.content as string, createdAt: r.created_at as string,
        score: Number(r.score ?? 0), platform: r.platform as string, chatId: r.chat_id as string,
      }));
    }

    // SQLite: bm25 scoring (lower = better), so negate for "higher = better" semantics.
    // Time-decay implemented in app code below since SQLite has limited date arithmetic.
    const sinceClause = sinceCutoff ? ` AND m.created_at >= ?` : '';
    const params: unknown[] = [query];
    params.push(...roles);
    if (sinceCutoff) params.push(sinceCutoff);
    params.push(userId, Math.min(limit * 3, 200)); // over-fetch for re-ranking
    const sql = `
      SELECT m.id, m.conversation_id, m.role, m.content, m.created_at,
             bm25(messages_fts) AS bm25_score, c.platform, c.chat_id
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      JOIN conversations c ON c.id = m.conversation_id
      WHERE messages_fts MATCH ?
        AND m.role IN (${placeholders})
        ${sinceClause}
        AND c.user_id = ?
      ORDER BY bm25_score ASC
      LIMIT ?
    `;
    const rows = await this.adapter.query(sql, params) as Record<string, unknown>[];
    const now = Date.now();
    const scored = rows.map(r => {
      const bm25 = Number(r.bm25_score ?? 0);
      const baseScore = -bm25; // negate: now higher is better
      let score = baseScore;
      if (decay) {
        const ageDays = (now - new Date(r.created_at as string).getTime()) / 86_400_000;
        score = baseScore * Math.exp(-ageDays / 30);
      }
      return {
        id: r.id as string, conversationId: r.conversation_id as string,
        role: r.role as string, content: r.content as string, createdAt: r.created_at as string,
        score, platform: r.platform as string, chatId: r.chat_id as string,
      };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  private mapRow(row: Record<string, string>): Conversation {
    return {
      id: row.id,
      platform: row.platform as Platform,
      chatId: row.chat_id,
      userId: row.user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
