import type { Platform } from './messaging.js';

export interface Conversation {
  id: string;
  platform: Platform;
  chatId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: string;
  createdAt: string;
}

export interface User {
  id: string;
  platform: Platform;
  platformUserId: string;
  username?: string;
  displayName?: string;
  createdAt: string;
  updatedAt: string;
}
