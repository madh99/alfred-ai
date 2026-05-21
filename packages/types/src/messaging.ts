export type Platform = 'telegram' | 'discord' | 'whatsapp' | 'signal' | 'matrix' | 'msteams' | 'cli' | 'api';

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
  /** v657 — Volltext der referenzierten Nachricht (von Adapter direkt mitgeliefert,
   *  z.B. Telegram msg.reply_to_message.text). Wird vom message-pipeline in den
   *  LLM-Prompt als Reply-Kontext injiziert. */
  replyToText?: string;
  /** v657 — Sender der referenzierten Nachricht (z.B. 'Madh' oder 'Alfred Test Bot'). */
  replyToFrom?: string;
  attachments?: Attachment[];
  raw?: unknown;
  threadId?: string;
  metadata?: {
    scheduled?: boolean;
    skipHistory?: boolean;
    tier?: import('./llm.js').ModelTier;
    callbackQuery?: boolean;
    /** Real user chatId for scheduled tasks (which use isolated chatIds for conversation). */
    originalChatId?: string;
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
