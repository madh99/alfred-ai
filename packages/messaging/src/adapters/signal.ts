import type { NormalizedMessage, SendMessageOptions } from '@alfred/types';
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
    } catch (error) {
      this.status = 'error';
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
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
    const isGroup = chatId.startsWith('group.');
    const body: Record<string, unknown> = {
      message: text,
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
    return String(result.timestamp ?? Date.now());
  }

  async editMessage(_chatId: string, _messageId: string, _text: string): Promise<void> {
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
      if (!dataMessage?.message) continue;

      const data = envelope.envelope;
      const chatId = dataMessage.groupInfo?.groupId
        ? `group.${dataMessage.groupInfo.groupId}`
        : data.sourceNumber ?? data.source ?? '';

      const normalized: NormalizedMessage = {
        id: String(dataMessage.timestamp ?? Date.now()),
        platform: 'signal',
        chatId,
        chatType: dataMessage.groupInfo ? 'group' : 'dm',
        userId: data.sourceNumber ?? data.source ?? '',
        userName: data.sourceName ?? data.sourceNumber ?? data.source ?? '',
        displayName: data.sourceName,
        text: dataMessage.message,
        timestamp: new Date(dataMessage.timestamp ?? Date.now()),
      };

      this.emit('message', normalized);
    }
  }
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
    };
  };
}
