import type BetterSqlite3 from 'better-sqlite3';

export interface ConversationSummary {
  conversationId: string;
  summary: string;
  messageCount: number;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  updatedAt: string;
}

export class SummaryRepository {
  private db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  get(conversationId: string): ConversationSummary | undefined {
    const row = this.db.prepare(
      'SELECT conversation_id, summary, message_count, last_user_message, last_assistant_message, updated_at FROM conversation_summaries WHERE conversation_id = ?',
    ).get(conversationId) as Record<string, unknown> | undefined;

    if (!row) return undefined;

    return {
      conversationId: row.conversation_id as string,
      summary: row.summary as string,
      messageCount: row.message_count as number,
      lastUserMessage: row.last_user_message as string | undefined,
      lastAssistantMessage: row.last_assistant_message as string | undefined,
      updatedAt: row.updated_at as string,
    };
  }

  upsert(entry: ConversationSummary): void {
    this.db.prepare(`
      INSERT INTO conversation_summaries (conversation_id, summary, message_count, last_user_message, last_assistant_message, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        summary = excluded.summary,
        message_count = excluded.message_count,
        last_user_message = excluded.last_user_message,
        last_assistant_message = excluded.last_assistant_message,
        updated_at = excluded.updated_at
    `).run(
      entry.conversationId,
      entry.summary,
      entry.messageCount,
      entry.lastUserMessage ?? null,
      entry.lastAssistantMessage ?? null,
      entry.updatedAt,
    );
  }

  delete(conversationId: string): void {
    this.db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(conversationId);
  }
}
