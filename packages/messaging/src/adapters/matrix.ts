import type { NormalizedMessage, SendMessageOptions, Attachment } from '@alfred/types';
import { MessagingAdapter } from '../adapter.js';

export class MatrixAdapter extends MessagingAdapter {
  readonly platform = 'matrix' as const;
  private client!: any;
  private readonly homeserverUrl: string;
  private readonly accessToken: string;
  private readonly botUserId: string;

  constructor(homeserverUrl: string, accessToken: string, botUserId: string) {
    super();
    this.homeserverUrl = homeserverUrl.replace(/\/+$/, '');
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

    this.client.on('room.message', async (roomId: string, event: any) => {
      if (event.sender === this.botUserId) return;

      const msgtype = event.content?.msgtype as string | undefined;
      if (!msgtype) return;

      try {
        const message = await this.normalizeEvent(roomId, event, msgtype);
        if (message) {
          this.emit('message', message);
        }
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
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

  async sendPhoto(
    chatId: string,
    photo: Buffer,
    caption?: string,
  ): Promise<string | undefined> {
    const mxcUrl = await this.client.uploadContent(photo, 'image/png', 'image.png');
    const content: Record<string, unknown> = {
      msgtype: 'm.image',
      body: caption ?? 'image.png',
      url: mxcUrl,
      info: {
        mimetype: 'image/png',
        size: photo.length,
      },
    };
    const eventId: string = await this.client.sendEvent(chatId, 'm.room.message', content);
    return eventId;
  }

  async sendFile(
    chatId: string,
    file: Buffer,
    fileName: string,
    caption?: string,
  ): Promise<string | undefined> {
    const mimeType = this.guessMimeType(fileName);
    const mxcUrl = await this.client.uploadContent(file, mimeType, fileName);
    const content: Record<string, unknown> = {
      msgtype: 'm.file',
      body: caption ?? fileName,
      filename: fileName,
      url: mxcUrl,
      info: {
        mimetype: mimeType,
        size: file.length,
      },
    };
    const eventId: string = await this.client.sendEvent(chatId, 'm.room.message', content);
    return eventId;
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async normalizeEvent(
    roomId: string,
    event: any,
    msgtype: string,
  ): Promise<NormalizedMessage | undefined> {
    const base = {
      id: event.event_id as string,
      platform: 'matrix' as const,
      chatId: roomId,
      chatType: 'group' as const,
      userId: event.sender as string,
      userName: (event.sender as string).split(':')[0].slice(1),
      timestamp: new Date(event.origin_server_ts),
      replyToMessageId:
        event.content['m.relates_to']?.['m.in_reply_to']?.event_id as string | undefined,
    };

    switch (msgtype) {
      case 'm.text':
        return { ...base, text: event.content.body as string };

      case 'm.image': {
        const attachment = await this.downloadAttachment(event.content, 'image');
        return {
          ...base,
          text: event.content.body ?? '[Photo]',
          attachments: attachment ? [attachment] : undefined,
        };
      }

      case 'm.audio': {
        const attachment = await this.downloadAttachment(event.content, 'audio');
        return {
          ...base,
          text: event.content.body ?? '[Voice message]',
          attachments: attachment ? [attachment] : undefined,
        };
      }

      case 'm.video': {
        const attachment = await this.downloadAttachment(event.content, 'video');
        return {
          ...base,
          text: event.content.body ?? '[Video]',
          attachments: attachment ? [attachment] : undefined,
        };
      }

      case 'm.file': {
        const attachment = await this.downloadAttachment(event.content, 'document');
        return {
          ...base,
          text: event.content.body ?? '[Document]',
          attachments: attachment ? [attachment] : undefined,
        };
      }

      default:
        // Unknown msgtype — pass as text if there's a body
        if (event.content.body) {
          return { ...base, text: event.content.body as string };
        }
        return undefined;
    }
  }

  /**
   * Download a Matrix media file from an mxc:// URL.
   * Uses the /_matrix/media/v3/download endpoint.
   */
  private async downloadAttachment(
    content: any,
    type: 'image' | 'audio' | 'video' | 'document',
  ): Promise<Attachment | undefined> {
    const mxcUrl = content.url as string | undefined;
    if (!mxcUrl || !mxcUrl.startsWith('mxc://')) return undefined;

    const info = content.info ?? {};
    const mimeType = info.mimetype as string | undefined;
    const size = info.size as number | undefined;
    const fileName = (content.filename ?? content.body ?? 'file') as string;

    try {
      // mxc://server/mediaId → /_matrix/media/v3/download/server/mediaId
      const mxcParts = mxcUrl.slice(6); // remove "mxc://"
      const downloadUrl = `${this.homeserverUrl}/_matrix/media/v3/download/${mxcParts}`;

      const res = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });

      if (!res.ok) return undefined;

      const arrayBuffer = await res.arrayBuffer();
      const data = Buffer.from(arrayBuffer);

      return {
        type,
        mimeType,
        fileName,
        size: size ?? data.length,
        data,
      };
    } catch {
      return undefined;
    }
  }

  private guessMimeType(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase();
    const mimeMap: Record<string, string> = {
      pdf: 'application/pdf',
      txt: 'text/plain',
      json: 'application/json',
      csv: 'text/csv',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      mp4: 'video/mp4',
      zip: 'application/zip',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    return mimeMap[ext ?? ''] ?? 'application/octet-stream';
  }
}
