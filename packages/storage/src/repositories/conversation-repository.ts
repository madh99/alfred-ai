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

  /**
   * v627 — List conversations with optional filters + last-message + message-count.
   * Used by the WebUI history viewer to populate the sidebar without N+1 queries.
   *
   * v637 — `userIds` (Plural) ergänzt. Bei verlinkten Accounts (Telegram + Matrix +
   * Discord etc.) speichert `conversations.user_id` die platform-spezifische ID, nicht
   * den Master. Caller liefert alle linked-User-IDs damit Matrix/Discord-Chats nicht
   * aus dem Filter fallen. Der alte `userId` bleibt erhalten für die Single-User-Fälle.
   */
  async listConversations(opts?: {
    userId?: string;
    userIds?: string[];
    platform?: Platform;
    limit?: number;
    offset?: number;
    /** v644 — exclude soft-deleted (default true) */
    includeDeleted?: boolean;
    /** v644 — Date-Range-Filter (createdAt) */
    sinceIso?: string;
    untilIso?: string;
    /** v644 — sort options */
    sortBy?: 'updated' | 'created' | 'message_count_desc' | 'pinned_first';
  }): Promise<Array<Conversation & { messageCount: number; lastMessageAt?: string; lastMessagePreview?: string }>> {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const where: string[] = [];
    const params: unknown[] = [];
    const allUserIds = (opts?.userIds && opts.userIds.length > 0) ? opts.userIds : (opts?.userId ? [opts.userId] : []);
    if (allUserIds.length === 1) {
      where.push('c.user_id = ?'); params.push(allUserIds[0]);
    } else if (allUserIds.length > 1) {
      where.push(`c.user_id IN (${allUserIds.map(() => '?').join(',')})`);
      params.push(...allUserIds);
    }
    if (opts?.platform) { where.push('c.platform = ?'); params.push(opts.platform); }
    if (!opts?.includeDeleted) where.push('c.deleted_at IS NULL');
    if (opts?.sinceIso) { where.push('c.created_at >= ?'); params.push(opts.sinceIso); }
    if (opts?.untilIso) { where.push('c.created_at <= ?'); params.push(opts.untilIso); }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    let orderBy = 'c.updated_at DESC';
    switch (opts?.sortBy) {
      case 'created': orderBy = 'c.created_at DESC'; break;
      case 'message_count_desc': orderBy = 'message_count DESC, c.updated_at DESC'; break;
      case 'pinned_first':
      default: orderBy = `CASE WHEN c.pinned_at IS NULL THEN 1 ELSE 0 END, c.pinned_at DESC, c.updated_at DESC`; break;
    }

    const sql = `
      SELECT c.id, c.platform, c.chat_id, c.user_id, c.created_at, c.updated_at,
        c.custom_label, c.pinned_at, c.deleted_at, c.branched_from_conversation_id, c.branched_at_message_id,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
        (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at,
        (SELECT SUBSTR(m.content, 1, 120) FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_preview
      FROM conversations c
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);
    const rows = await this.adapter.query(sql, params) as Record<string, unknown>[];
    return rows.map(r => ({
      ...this.mapRow(r as Record<string, string>),
      messageCount: Number(r.message_count ?? 0),
      lastMessageAt: r.last_message_at as string | undefined,
      lastMessagePreview: r.last_preview as string | undefined,
    }));
  }

  /** v644 — Update conversation custom_label / pinned_at. */
  async updateLifecycle(id: string, updates: { customLabel?: string | null; pinned?: boolean }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if ('customLabel' in updates) { sets.push('custom_label = ?'); params.push(updates.customLabel ?? null); }
    if ('pinned' in updates) {
      sets.push('pinned_at = ?');
      params.push(updates.pinned ? new Date().toISOString() : null);
    }
    if (sets.length === 0) return;
    params.push(id);
    await this.adapter.execute(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  /** v644 — Soft-delete (sets deleted_at). Messages bleiben für eventuelle Wiederherstellung. */
  async softDelete(id: string): Promise<void> {
    await this.adapter.execute('UPDATE conversations SET deleted_at = ? WHERE id = ?', [new Date().toISOString(), id]);
  }

  /** v644 — Permanent delete (cascade messages). */
  async hardDelete(id: string): Promise<void> {
    await this.adapter.execute('DELETE FROM messages WHERE conversation_id = ?', [id]);
    await this.adapter.execute('DELETE FROM conversations WHERE id = ?', [id]);
  }

  /**
   * v644 — Branch off an existing conversation at a given message: copies all messages
   * up to and including `atMessageId` into a new conversation row. The new conversation
   * has a fresh chat_id (web-fork-<uuid>) so the runtime doesn't auto-attach to the
   * old chat-thread. Returns the new conversation id.
   */
  async branchAtMessage(sourceConversationId: string, atMessageId: string, opts: { userId: string; newChatId?: string }): Promise<string> {
    const source = await this.findById(sourceConversationId);
    if (!source) throw new Error('source conversation not found');
    const cutoffMsg = await this.adapter.queryOne(
      'SELECT created_at FROM messages WHERE id = ? AND conversation_id = ?',
      [atMessageId, sourceConversationId],
    ) as { created_at: string } | undefined;
    if (!cutoffMsg) throw new Error('cutoff message not found');

    const newConv = await this.create(source.platform, opts.newChatId ?? `web-fork-${crypto.randomUUID().slice(0, 8)}`, opts.userId);
    await this.adapter.execute(
      'UPDATE conversations SET branched_from_conversation_id = ?, branched_at_message_id = ? WHERE id = ?',
      [sourceConversationId, atMessageId, newConv.id],
    );

    const messagesToCopy = await this.adapter.query(
      'SELECT * FROM messages WHERE conversation_id = ? AND created_at <= ? ORDER BY created_at ASC, id ASC',
      [sourceConversationId, cutoffMsg.created_at],
    ) as Array<Record<string, unknown>>;
    for (const m of messagesToCopy) {
      const newId = crypto.randomUUID();
      await this.adapter.execute(
        'INSERT INTO messages (id, conversation_id, role, content, tool_calls, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [newId, newConv.id, m.role as string, m.content as string, (m.tool_calls as string | null) ?? null, m.created_at as string],
      );
    }
    return newConv.id;
  }

  /**
   * v627 — Paginated message fetch for lazy-loading older history in the viewer.
   * Returns the N messages BEFORE `beforeIso` (exclusive), oldest-first within the page.
   * If `beforeIso` is omitted, returns the N most recent messages.
   */
  async getMessagesPaged(conversationId: string, opts?: { beforeIso?: string; limit?: number }): Promise<ConversationMessage[]> {
    const limit = opts?.limit ?? 50;
    const params: unknown[] = [conversationId];
    let sql = `SELECT * FROM messages WHERE conversation_id = ?`;
    if (opts?.beforeIso) { sql += ` AND created_at < ?`; params.push(opts.beforeIso); }
    sql += ` ORDER BY created_at DESC, id DESC LIMIT ?`;
    params.push(limit);
    const rows = await this.adapter.query(sql, params) as Record<string, string>[];
    return rows.reverse().map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role as ConversationMessage['role'],
      content: row.content,
      toolCalls: row.tool_calls ?? undefined,
      createdAt: row.created_at,
    }));
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
    userId: string | string[],
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

    // v637 — userId akzeptiert jetzt auch string[] (linked-User-IDs für Matrix/Discord/WhatsApp).
    const userIds = Array.isArray(userId) ? userId : [userId];
    const userPlaceholders = userIds.map(() => '?').join(',');
    const userInClause = userIds.length === 1 ? 'c.user_id = ?' : `c.user_id IN (${userPlaceholders})`;

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
      params.push(...userIds, limit);
      const sql = `
        SELECT m.id, m.conversation_id, m.role, m.content, m.created_at,
               ${rankExpr} AS score, c.platform, c.chat_id
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE content_tsv @@ plainto_tsquery('simple', ?)
          AND m.role IN (${placeholders})
          ${sinceClause}
          AND ${userInClause}
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
    params.push(...userIds, Math.min(limit * 3, 200)); // over-fetch for re-ranking
    const sql = `
      SELECT m.id, m.conversation_id, m.role, m.content, m.created_at,
             bm25(messages_fts) AS bm25_score, c.platform, c.chat_id
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      JOIN conversations c ON c.id = m.conversation_id
      WHERE messages_fts MATCH ?
        AND m.role IN (${placeholders})
        ${sinceClause}
        AND ${userInClause}
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
      customLabel: (row.custom_label as string | undefined) ?? undefined,
      pinnedAt: (row.pinned_at as string | undefined) ?? undefined,
      deletedAt: (row.deleted_at as string | undefined) ?? undefined,
      branchedFromConversationId: (row.branched_from_conversation_id as string | undefined) ?? undefined,
      branchedAtMessageId: (row.branched_at_message_id as string | undefined) ?? undefined,
    };
  }
}
