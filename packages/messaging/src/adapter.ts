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

  getStatus(): MessagingAdapterStatus {
    return this.status;
  }
}
