export type Platform = 'telegram' | 'discord' | 'whatsapp' | 'signal' | 'matrix';

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
}

export interface Attachment {
  type: 'image' | 'audio' | 'video' | 'document' | 'other';
  url?: string;
  mimeType?: string;
  fileName?: string;
  size?: number;
}

export interface SendMessageOptions {
  replyToMessageId?: string;
  parseMode?: 'text' | 'markdown' | 'html';
}

export type MessagingAdapterStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface MessagingAdapterEvents {
  message: [message: NormalizedMessage];
  error: [error: Error];
  connected: [];
  disconnected: [];
}
