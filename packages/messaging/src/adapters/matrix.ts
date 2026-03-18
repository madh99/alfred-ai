import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage, SendMessageOptions, Attachment } from '@alfred/types';
import { MessagingAdapter } from '../adapter.js';

export class MatrixAdapter extends MessagingAdapter {
  readonly platform = 'matrix' as const;
  private client!: any;
  private readonly homeserverUrl: string;
  private readonly accessToken: string;
  private readonly botUserId: string;
  private readonly storagePath: string;

  constructor(homeserverUrl: string, accessToken: string, botUserId: string, storagePath?: string) {
    super();
    this.homeserverUrl = homeserverUrl.replace(/\/+$/, '');
    this.accessToken = accessToken;
    this.botUserId = botUserId;
    this.storagePath = storagePath ?? join(homedir(), '.alfred', 'matrix-storage');
  }

  async connect(): Promise<void> {
    this.status = 'connecting';

    // matrix-bot-sdk's sync loop breaks when loaded from esbuild bundle's node_modules.
    // Must load from a LOCAL node_modules via createRequire with the correct base path.
    // In ESM bundles, require() is not globally available, so we use createRequire.
    const { createRequire } = await import('node:module');
    const localRequire = createRequire(process.cwd() + '/index.js');
    const {
      MatrixClient,
      SimpleFsStorageProvider,
      AutojoinRoomsMixin,
    } = localRequire('matrix-bot-sdk');

    const storageProvider = new SimpleFsStorageProvider(
      this.storagePath,
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

  async sendDirectMessage(
    userId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<string | undefined> {
    if (!this.client) return undefined;
    try {
      // Find existing DM room or create one
      const rooms = this.client.getRooms?.() ?? [];
      let dmRoomId: string | undefined;
      for (const room of rooms) {
        const members = room.getJoinedMembers?.() ?? [];
        if (members.length === 2 && members.some((m: any) => m.userId === userId)) {
          dmRoomId = room.roomId;
          break;
        }
      }
      if (!dmRoomId) {
        const { room_id } = await this.client.createRoom({
          invite: [userId],
          is_direct: true,
          preset: 'trusted_private_chat',
        });
        dmRoomId = room_id;
      }
      return await this.sendMessage(dmRoomId!, text, options);
    } catch {
      return undefined;
    }
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<string> {
    const chunks = this.splitText(text, 32000);
    let lastEventId = '';

    for (const chunk of chunks) {
      if (options?.parseMode === 'html') {
        lastEventId = await this.client.sendEvent(chatId, 'm.room.message', {
          msgtype: 'm.text',
          body: chunk.replace(/<[^>]*>/g, ''),
          format: 'org.matrix.custom.html',
          formatted_body: chunk,
        });
      } else {
        lastEventId = await this.client.sendText(chatId, chunk);
      }
    }

    return lastEventId;
  }

  async editMessage(
    chatId: string,
    messageId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    const isHtml = options?.parseMode === 'html';
    const content: Record<string, unknown> = {
      'msgtype': 'm.text',
      'body': '* ' + (isHtml ? text.replace(/<[^>]*>/g, '') : text),
      'm.new_content': {
        msgtype: 'm.text',
        body: isHtml ? text.replace(/<[^>]*>/g, '') : text,
        ...(isHtml ? { format: 'org.matrix.custom.html', formatted_body: text } : {}),
      },
      'm.relates_to': {
        rel_type: 'm.replace',
        event_id: messageId,
      },
    };
    await this.client.sendEvent(chatId, 'm.room.message', content);
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
    let displayName: string | undefined;
    try {
      const profile = await this.client.getUserProfile(event.sender);
      displayName = profile?.displayname ?? undefined;
    } catch {
      // Profile lookup may fail; proceed without displayName
    }

    const base = {
      id: event.event_id as string,
      platform: 'matrix' as const,
      chatId: roomId,
      chatType: 'group' as const,
      userId: event.sender as string,
      userName: (event.sender as string).split(':')[0].slice(1),
      displayName,
      timestamp: new Date(event.origin_server_ts),
      replyToMessageId:
        event.content['m.relates_to']?.['m.in_reply_to']?.event_id as string | undefined,
    };

    switch (msgtype) {
      case 'm.text':
        return { ...base, text: event.content.body as string };

      case 'm.image': {
        const attachment = await this.downloadAttachment(event.content, 'image');
        if (attachment && event.content.body) attachment.fileName = event.content.body;
        return {
          ...base,
          text: '[Photo]',
          attachments: attachment ? [attachment] : undefined,
        };
      }

      case 'm.audio': {
        const attachment = await this.downloadAttachment(event.content, 'audio');
        if (attachment && event.content.body) attachment.fileName = event.content.body;
        return {
          ...base,
          text: '[Voice message]',
          attachments: attachment ? [attachment] : undefined,
        };
      }

      case 'm.video': {
        const attachment = await this.downloadAttachment(event.content, 'video');
        if (attachment && event.content.body) attachment.fileName = event.content.body;
        return {
          ...base,
          text: '[Video]',
          attachments: attachment ? [attachment] : undefined,
        };
      }

      case 'm.file': {
        const attachment = await this.downloadAttachment(event.content, 'document');
        if (attachment && event.content.body) attachment.fileName = event.content.body;
        return {
          ...base,
          text: '[Document]',
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
   * Downloads media from an mxc:// URL, trying the authenticated
   * /_matrix/client/v1/media endpoint first (Synapse 1.94+), then
   * falling back to the legacy /_matrix/media/v3 endpoint.
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

    const mxcParts = mxcUrl.slice(6); // remove "mxc://"
    const urls = [
      `${this.homeserverUrl}/_matrix/client/v1/media/download/${mxcParts}`,
      `${this.homeserverUrl}/_matrix/media/v3/download/${mxcParts}`,
    ];

    for (const downloadUrl of urls) {
      try {
        const res = await fetch(downloadUrl, {
          headers: { Authorization: `Bearer ${this.accessToken}` },
        });

        if (res.status === 404) {
          // Endpoint not available, try next
          continue;
        }

        if (!res.ok) {
          console.error(`[matrix] Download failed (${res.status})`, mxcUrl, downloadUrl);
          continue;
        }

        const arrayBuffer = await res.arrayBuffer();
        const data = Buffer.from(arrayBuffer);

        return {
          type,
          mimeType,
          fileName,
          size: size ?? data.length,
          data,
        };
      } catch (err) {
        console.error(`[matrix] Download error`, mxcUrl, downloadUrl, err);
        continue;
      }
    }

    console.error(`[matrix] All download endpoints failed for`, mxcUrl);
    return undefined;
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
