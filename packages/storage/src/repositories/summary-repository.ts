import type { AsyncDbAdapter } from '../db-adapter.js';

export interface ConversationSummary {
  conversationId: string;
  summary: string;
  messageCount: number;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  updatedAt: string;
}

export class SummaryRepository {
  private adapter: AsyncDbAdapter;

  constructor(adapter: AsyncDbAdapter) {
    this.adapter = adapter;
  }

  async get(conversationId: string): Promise<ConversationSummary | undefined> {
    const row = await this.adapter.queryOne(
      'SELECT conversation_id, summary, message_count, last_user_message, last_assistant_message, updated_at FROM conversation_summaries WHERE conversation_id = ?',
      [conversationId],
    ) as Record<string, unknown> | undefined;

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

  async upsert(entry: ConversationSummary): Promise<void> {
    await this.adapter.execute(`
      INSERT INTO conversation_summaries (conversation_id, summary, message_count, last_user_message, last_assistant_message, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        summary = excluded.summary,
        message_count = excluded.message_count,
        last_user_message = excluded.last_user_message,
        last_assistant_message = excluded.last_assistant_message,
        updated_at = excluded.updated_at
    `, [
      entry.conversationId,
      entry.summary,
      entry.messageCount,
      entry.lastUserMessage ?? null,
      entry.lastAssistantMessage ?? null,
      entry.updatedAt,
    ]);
  }

  async cleanup(olderThanDays: number = 180): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
    const result = await this.adapter.execute(
      `DELETE FROM conversation_summaries WHERE updated_at < ?`,
      [cutoff],
    );
    return result.changes;
  }

  async delete(conversationId: string): Promise<void> {
    await this.adapter.execute(
      'DELETE FROM conversation_summaries WHERE conversation_id = ?',
      [conversationId],
    );
  }
}
