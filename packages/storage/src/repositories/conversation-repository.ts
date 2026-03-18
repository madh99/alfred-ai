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
