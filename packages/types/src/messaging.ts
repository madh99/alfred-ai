export type Platform = 'telegram' | 'discord' | 'whatsapp' | 'signal' | 'matrix' | 'cli' | 'api';

export type ChatType = 'dm' | 'group';

export type MessageType = 'text' | 'command' | 'reply';

export interface NormalizedMessage {
  id: string;
  platform: Platform;
  chatId: string;
  chatType: ChatType;
  userId: string;
  userName: string;
  displayName?: string;
  text: string;
  timestamp: Date;
  replyToMessageId?: string;
  attachments?: Attachment[];
  raw?: unknown;
  threadId?: string;
  metadata?: {
    scheduled?: boolean;
    skipHistory?: boolean;
    tier?: import('./llm.js').ModelTier;
    callbackQuery?: boolean;
  };
}

export interface Attachment {
  type: 'image' | 'audio' | 'video' | 'document' | 'other';
  url?: string;
  mimeType?: string;
  fileName?: string;
  size?: number;
  data?: Buffer;
}

export interface InlineButton {
  text: string;
  callbackData: string;
}

export interface SendMessageOptions {
  replyToMessageId?: string;
  parseMode?: 'text' | 'markdown' | 'html';
  threadId?: string;
  replyMarkup?: {
    inlineKeyboard?: InlineButton[][];
  };
}

export type MessagingAdapterStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface MessagingAdapterEvents {
  message: [message: NormalizedMessage];
  error: [error: Error];
  connected: [];
  disconnected: [];
}
