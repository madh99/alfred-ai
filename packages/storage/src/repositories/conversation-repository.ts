import type BetterSqlite3 from 'better-sqlite3';
import type { Conversation, ConversationMessage, Platform } from '@alfred/types';
import crypto from 'node:crypto';

export class ConversationRepository {
  private db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  create(platform: Platform, chatId: string, userId: string): Conversation {
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      platform,
      chatId,
      userId,
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO conversations (id, platform, chat_id, user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(conversation.id, conversation.platform, conversation.chatId, conversation.userId, conversation.createdAt, conversation.updatedAt);

    return conversation;
  }

  findById(id: string): Conversation | undefined {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, string> | undefined;
    if (!row) return undefined;
    return this.mapRow(row);
  }

  findByPlatformChat(platform: Platform, chatId: string): Conversation | undefined {
    const row = this.db.prepare('SELECT * FROM conversations WHERE platform = ? AND chat_id = ?').get(platform, chatId) as Record<string, string> | undefined;
    if (!row) return undefined;
    return this.mapRow(row);
  }

  addMessage(conversationId: string, role: ConversationMessage['role'], content: string, toolCalls?: string): ConversationMessage {
    const message: ConversationMessage = {
      id: crypto.randomUUID(),
      conversationId,
      role,
      content,
      toolCalls,
      createdAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, tool_calls, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(message.id, message.conversationId, message.role, message.content, message.toolCalls ?? null, message.createdAt);

    return message;
  }

  getMessages(conversationId: string, limit = 50): ConversationMessage[] {
    const rows = this.db.prepare(
      'SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at ASC, rowid ASC'
    ).all(conversationId, limit) as Record<string, string>[];

    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role as ConversationMessage['role'],
      content: row.content,
      toolCalls: row.tool_calls ?? undefined,
      createdAt: row.created_at,
    }));
  }

  updateTimestamp(id: string): void {
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
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
