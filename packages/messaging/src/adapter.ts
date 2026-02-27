import { EventEmitter } from 'node:events';
import type {
  Platform,
  NormalizedMessage,
  SendMessageOptions,
  MessagingAdapterStatus,
} from '@alfred/types';

export interface MessagingAdapterEvents {
  message: [message: NormalizedMessage];
  error: [error: Error];
  connected: [];
  disconnected: [];
}

export abstract class MessagingAdapter extends EventEmitter<MessagingAdapterEvents> {
  abstract readonly platform: Platform;
  protected status: MessagingAdapterStatus = 'disconnected';

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract sendMessage(
    chatId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<string>;
  abstract editMessage(
    chatId: string,
    messageId: string,
    text: string,
  ): Promise<void>;
  abstract deleteMessage(
    chatId: string,
    messageId: string,
  ): Promise<void>;

  async sendPhoto(
    _chatId: string,
    _photo: Buffer,
    _caption?: string,
  ): Promise<string | undefined> {
    return undefined; // Not supported by default
  }

  async sendFile(
    _chatId: string,
    _file: Buffer,
    _fileName: string,
    _caption?: string,
  ): Promise<string | undefined> {
    return undefined; // Not supported by default
  }

  getStatus(): MessagingAdapterStatus {
    return this.status;
  }
}
