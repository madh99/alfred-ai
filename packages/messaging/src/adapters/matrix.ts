import type { NormalizedMessage, SendMessageOptions } from '@alfred/types';
import { MessagingAdapter } from '../adapter.js';

export class MatrixAdapter extends MessagingAdapter {
  readonly platform = 'matrix' as const;
  private client!: any;
  private readonly homeserverUrl: string;
  private readonly accessToken: string;
  private readonly botUserId: string;

  constructor(homeserverUrl: string, accessToken: string, botUserId: string) {
    super();
    this.homeserverUrl = homeserverUrl;
    this.accessToken = accessToken;
    this.botUserId = botUserId;
  }

  async connect(): Promise<void> {
    this.status = 'connecting';

    const {
      MatrixClient,
      SimpleFsStorageProvider,
      AutojoinRoomsMixin,
    } = await import('matrix-bot-sdk');

    const storageProvider = new SimpleFsStorageProvider(
      './data/matrix-storage',
    );
    this.client = new MatrixClient(
      this.homeserverUrl,
      this.accessToken,
      storageProvider,
    );

    AutojoinRoomsMixin.setupOnClient(this.client);

    this.client.on('room.message', (roomId: string, event: any) => {
      if (event.sender === this.botUserId) return;
      if (event.content?.msgtype !== 'm.text') return;

      const normalized: NormalizedMessage = {
        id: event.event_id,
        platform: 'matrix',
        chatId: roomId,
        chatType: 'group',
        userId: event.sender,
        userName: (event.sender as string).split(':')[0].slice(1),
        text: event.content.body,
        timestamp: new Date(event.origin_server_ts),
        replyToMessageId:
          event.content['m.relates_to']?.['m.in_reply_to']?.event_id,
      };
      this.emit('message', normalized);
    });

    await this.client.start();
    this.status = 'connected';
    this.emit('connected');
  }

  async disconnect(): Promise<void> {
    this.client.stop();
    this.status = 'disconnected';
    this.emit('disconnected');
  }

  async sendMessage(
    chatId: string,
    text: string,
    _options?: SendMessageOptions,
  ): Promise<string> {
    const eventId: string = await this.client.sendText(chatId, text);
    return eventId;
  }

  async editMessage(
    chatId: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    await this.client.sendEvent(chatId, 'm.room.message', {
      'msgtype': 'm.text',
      'body': '* ' + text,
      'm.new_content': {
        msgtype: 'm.text',
        body: text,
      },
      'm.relates_to': {
        rel_type: 'm.replace',
        event_id: messageId,
      },
    });
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    await this.client.redactEvent(chatId, messageId);
  }
}
