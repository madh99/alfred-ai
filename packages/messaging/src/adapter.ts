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
    options?: SendMessageOptions,
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

  /**
   * Split text into chunks that fit within a character limit.
   * Splits on paragraph boundaries first, then sentence boundaries, then hard splits.
   */
  protected splitText(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      let splitIndex = -1;

      // Try to split on paragraph boundary (double newline)
      const paragraphRegion = remaining.slice(0, maxLen);
      const lastParagraph = paragraphRegion.lastIndexOf('\n\n');
      if (lastParagraph > 0) {
        splitIndex = lastParagraph;
      }

      // Try sentence boundary if no paragraph boundary found
      if (splitIndex < 0) {
        const sentenceRegion = remaining.slice(0, maxLen);
        // Look for sentence-ending punctuation followed by space or newline
        const sentenceMatch = sentenceRegion.match(/.*[.!?]\s/s);
        if (sentenceMatch) {
          splitIndex = sentenceMatch[0].length;
        }
      }

      // Hard split at maxLen if no natural boundary found
      if (splitIndex < 0) {
        splitIndex = maxLen;
      }

      chunks.push(remaining.slice(0, splitIndex).trimEnd());
      remaining = remaining.slice(splitIndex).trimStart();
    }

    return chunks;
  }
}
