import type { Conversation, ConversationMessage, Platform } from '@alfred/types';
import type { ConversationRepository } from '@alfred/storage';

export class ConversationManager {
  constructor(private readonly conversations: ConversationRepository) {}

  getOrCreateConversation(platform: Platform, chatId: string, userId: string): Conversation {
    const existing = this.conversations.findByPlatformChat(platform, chatId);
    if (existing) {
      this.conversations.updateTimestamp(existing.id);
      return existing;
    }
    return this.conversations.create(platform, chatId, userId);
  }

  addMessage(conversationId: string, role: 'user' | 'assistant' | 'system', content: string, toolCalls?: string): ConversationMessage {
    return this.conversations.addMessage(conversationId, role, content, toolCalls);
  }

  getHistory(conversationId: string, limit = 20): ConversationMessage[] {
    return this.conversations.getMessages(conversationId, limit);
  }

  /** Delete all but the most recent `keep` messages for a conversation. */
  pruneMessages(conversationId: string, keep: number): number {
    return this.conversations.pruneMessages(conversationId, keep);
  }
}
