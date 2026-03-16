import type { Conversation, ConversationMessage, Platform } from '@alfred/types';
import type { ConversationRepository } from '@alfred/storage';

export class ConversationManager {
  constructor(private readonly conversations: ConversationRepository) {}

  async getOrCreateConversation(platform: Platform, chatId: string, userId: string): Promise<Conversation> {
    const existing = await this.conversations.findByPlatformChat(platform, chatId);
    if (existing) {
      await this.conversations.updateTimestamp(existing.id);
      return existing;
    }
    return this.conversations.create(platform, chatId, userId);
  }

  async addMessage(conversationId: string, role: 'user' | 'assistant' | 'system', content: string, toolCalls?: string): Promise<ConversationMessage> {
    return this.conversations.addMessage(conversationId, role, content, toolCalls);
  }

  async getHistory(conversationId: string, limit = 20): Promise<ConversationMessage[]> {
    return this.conversations.getMessages(conversationId, limit);
  }

  /** Delete all but the most recent `keep` messages for a conversation. */
  async pruneMessages(conversationId: string, keep: number): Promise<number> {
    return this.conversations.pruneMessages(conversationId, keep);
  }
}
