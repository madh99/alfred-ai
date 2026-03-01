import type { NormalizedMessage, SendMessageOptions, Attachment } from '@alfred/types';
import { MessagingAdapter } from '../adapter.js';

/**
 * Signal adapter using the signal-cli-rest-api.
 * Requires a running signal-cli-rest-api instance (Docker).
 * @see https://github.com/bbernhard/signal-cli-rest-api
 */
export class SignalAdapter extends MessagingAdapter {
  readonly platform = 'signal' as const;
  private pollingInterval: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly apiUrl: string,
    private readonly phoneNumber: string,
  ) {
    super();
  }

  async connect(): Promise<void> {
    this.status = 'connecting';

    const maxRetries = 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Verify API is reachable
        const res = await fetch(`${this.apiUrl}/v1/about`);
        if (!res.ok) {
          throw new Error(`Signal API not reachable: ${res.status}`);
        }

        // Start polling for new messages
        this.pollingInterval = setInterval(() => {
          this.pollMessages().catch((err) => {
            this.emit('error', err instanceof Error ? err : new Error(String(err)));
          });
        }, 2000);

        this.status = 'connected';
        this.emit('connected');
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries) {
          const delay = 1000 * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    this.status = 'error';
    this.emit('error', lastError!);
  }

  async disconnect(): Promise<void> {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }
    this.status = 'disconnected';
    this.emit('disconnected');
  }

  async sendMessage(chatId: string, text: string, _options?: SendMessageOptions): Promise<string> {
    const chunks = this.splitText(text, 6000);
    let lastTimestamp = '';

    for (const chunk of chunks) {
      const isGroup = chatId.startsWith('group.');
      const body: Record<string, unknown> = {
        message: chunk,
        number: this.phoneNumber,
      };

      if (isGroup) {
        body.recipients = [chatId.replace('group.', '')];
      } else {
        body.recipients = [chatId];
      }

      const res = await fetch(`${this.apiUrl}/v2/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(`Signal send failed: ${res.status} ${await res.text()}`);
      }

      const result = (await res.json()) as Record<string, unknown>;
      lastTimestamp = String(result.timestamp ?? Date.now());
    }

    return lastTimestamp;
  }

  async editMessage(_chatId: string, _messageId: string, _text: string, _options?: SendMessageOptions): Promise<void> {
    // Signal does not support message editing via REST API
    throw new Error('Signal does not support message editing');
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    const body = {
      number: this.phoneNumber,
      recipients: [chatId],
      timestamp: Number(messageId),
    };

    const res = await fetch(`${this.apiUrl}/v1/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Signal delete failed: ${res.status} ${await res.text()}`);
    }
  }

  private async pollMessages(): Promise<void> {
    const res = await fetch(`${this.apiUrl}/v1/receive/${this.phoneNumber}`);
    if (!res.ok) return;

    const messages = (await res.json()) as SignalEnvelope[];

    for (const envelope of messages) {
      const dataMessage = envelope.envelope?.dataMessage;
      if (!dataMessage) continue;

      // Skip messages with no text and no attachments
      if (!dataMessage.message && (!dataMessage.attachments || dataMessage.attachments.length === 0)) continue;

      const data = envelope.envelope;
      const chatId = dataMessage.groupInfo?.groupId
        ? `group.${dataMessage.groupInfo.groupId}`
        : data.sourceNumber ?? data.source ?? '';

      // Download attachments
      const attachments: Attachment[] = [];
      if (dataMessage.attachments) {
        for (const att of dataMessage.attachments) {
          const downloaded = await this.downloadAttachment(att);
          if (downloaded) {
            attachments.push(downloaded);
          }
        }
      }

      const text = dataMessage.message
        || this.inferTextFromAttachments(attachments)
        || '';

      if (!text && attachments.length === 0) continue;

      const normalized: NormalizedMessage = {
        id: String(dataMessage.timestamp ?? Date.now()),
        platform: 'signal',
        chatId,
        chatType: dataMessage.groupInfo ? 'group' : 'dm',
        userId: data.sourceNumber ?? data.source ?? '',
        userName: data.sourceName ?? data.sourceNumber ?? data.source ?? '',
        displayName: data.sourceName,
        text,
        timestamp: new Date(dataMessage.timestamp ?? Date.now()),
        attachments: attachments.length > 0 ? attachments : undefined,
      };

      this.emit('message', normalized);
    }
  }

  private async downloadAttachment(att: SignalAttachment): Promise<Attachment | undefined> {
    if (!att.id) return undefined;

    try {
      const res = await fetch(`${this.apiUrl}/v1/attachments/${att.id}`);
      if (!res.ok) return undefined;

      const arrayBuffer = await res.arrayBuffer();
      const data = Buffer.from(arrayBuffer);
      const type = this.classifyContentType(att.contentType);

      return {
        type,
        mimeType: att.contentType ?? undefined,
        fileName: att.filename ?? undefined,
        size: att.size ?? data.length,
        data,
      };
    } catch (err) {
      console.error('[signal] Failed to download attachment', att.id, err);
      return undefined;
    }
  }

  private classifyContentType(
    contentType?: string,
  ): 'image' | 'audio' | 'video' | 'document' | 'other' {
    if (!contentType) return 'other';
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('audio/')) return 'audio';
    if (contentType.startsWith('video/')) return 'video';
    return 'document';
  }

  private inferTextFromAttachments(attachments: Attachment[]): string {
    if (attachments.length === 0) return '';
    const types = attachments.map(a => a.type);
    if (types.includes('image')) return '[Photo]';
    if (types.includes('audio')) return '[Voice message]';
    if (types.includes('video')) return '[Video]';
    if (types.includes('document')) return '[Document]';
    return '[File]';
  }
}

interface SignalAttachment {
  contentType?: string;
  filename?: string;
  id?: string;
  size?: number;
}

interface SignalEnvelope {
  envelope: {
    source?: string;
    sourceNumber?: string;
    sourceName?: string;
    dataMessage?: {
      timestamp?: number;
      message?: string;
      groupInfo?: {
        groupId?: string;
      };
      attachments?: SignalAttachment[];
    };
  };
}
