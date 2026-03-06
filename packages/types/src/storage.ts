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
  timezone?: string;
  language?: string;
  bio?: string;
  preferences?: Record<string, unknown>;
  masterUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LinkToken {
  id: string;
  code: string;
  userId: string;
  platform: string;
  createdAt: string;
  expiresAt: string;
}

export interface BackgroundTask {
  id: string;
  userId: string;
  platform: string;
  chatId: string;
  description: string;
  skillName: string;
  skillInput: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ScheduledAction {
  id: string;
  userId: string;
  platform: string;
  chatId: string;
  name: string;
  description: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  skillName: string;
  skillInput: string;
  promptTemplate?: string;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
}

export interface WatchCondition {
  field: string;
  operator: 'lt' | 'gt' | 'lte' | 'gte' | 'eq' | 'neq' | 'contains' | 'not_contains' | 'changed' | 'increased' | 'decreased';
  value?: string | number;
}

export interface Watch {
  id: string;
  chatId: string;
  platform: string;
  name: string;
  skillName: string;
  skillParams: Record<string, unknown>;
  condition: WatchCondition;
  intervalMinutes: number;
  cooldownMinutes: number;
  enabled: boolean;
  lastCheckedAt: string | null;
  lastTriggeredAt: string | null;
  lastValue: string | null;
  createdAt: string;
  messageTemplate?: string;
}

export interface Document {
  id: string;
  userId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  chunkCount: number;
  contentHash?: string;
  createdAt: string;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  embeddingId?: string;
  createdAt: string;
}
