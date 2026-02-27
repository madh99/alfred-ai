import type { NormalizedMessage, SendMessageOptions, Attachment } from '@alfred/types';
import { MessagingAdapter } from '../adapter.js';

export class WhatsAppAdapter extends MessagingAdapter {
  readonly platform = 'whatsapp' as const;
  private socket: any;
  private downloadMedia: any;
  private readonly dataPath: string;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(dataPath: string) {
    super();
    this.dataPath = dataPath;
  }

  async connect(): Promise<void> {
    this.status = 'connecting';

    const baileys = await import('@whiskeysockets/baileys');
    const mod = baileys.default ?? baileys;
    const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = mod;

    this.downloadMedia = downloadMediaMessage;

    const { state, saveCreds } = await useMultiFileAuthState(this.dataPath);

    this.socket = makeWASocket({
      auth: state,
      printQRInTerminal: true,
    });

    this.socket.ev.on('creds.update', saveCreds);

    this.socket.ev.on('connection.update', (update: any) => {
      if (update.connection === 'open') {
        this.status = 'connected';
        this.reconnectAttempts = 0;
        this.emit('connected');
      }

      if (update.connection === 'close') {
        const statusCode = (update.lastDisconnect?.error as any)?.output
          ?.statusCode;
        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut;

        this.status = 'disconnected';
        this.emit('disconnected');

        if (shouldReconnect) {
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60_000);
          this.reconnectAttempts++;
          this.reconnectTimer = setTimeout(() => this.connect(), delay);
        }
      }
    });

    this.socket.ev.on('messages.upsert', ({ messages, type }: { messages: any[]; type: string }) => {
      if (type !== 'notify') return;

      for (const message of messages) {
        if (!message.message) continue;
        if (message.key.fromMe) continue;

        this.processMessage(message).catch((err) => {
          this.emit('error', err instanceof Error ? err : new Error(String(err)));
        });
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectAttempts = 0;
    this.socket?.end(undefined);
    this.socket = undefined;
    this.status = 'disconnected';
    this.emit('disconnected');
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<string> {
    const msg = await this.socket!.sendMessage(
      chatId,
      { text },
      options?.replyToMessageId
        ? {
            quoted: {
              key: { remoteJid: chatId, id: options.replyToMessageId },
              message: {},
            } as any,
          }
        : undefined,
    );
    return msg?.key?.id ?? '';
  }

  async editMessage(
    chatId: string,
    messageId: string,
    text: string,
    _options?: SendMessageOptions,
  ): Promise<void> {
    await this.socket!.sendMessage(chatId, {
      text,
      edit: {
        remoteJid: chatId,
        id: messageId,
        fromMe: true,
      } as any,
    });
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    await this.socket!.sendMessage(chatId, {
      delete: {
        remoteJid: chatId,
        id: messageId,
        fromMe: true,
      } as any,
    });
  }

  async sendPhoto(
    chatId: string,
    photo: Buffer,
    caption?: string,
  ): Promise<string | undefined> {
    const msg = await this.socket!.sendMessage(chatId, {
      image: photo,
      caption,
    });
    return msg?.key?.id;
  }

  async sendFile(
    chatId: string,
    file: Buffer,
    fileName: string,
    caption?: string,
  ): Promise<string | undefined> {
    const msg = await this.socket!.sendMessage(chatId, {
      document: file,
      fileName,
      caption,
      mimetype: this.guessMimeType(fileName),
    });
    return msg?.key?.id;
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async processMessage(message: any): Promise<void> {
    const msg = message.message;

    // Extract text from various message types
    const text =
      msg.conversation ??
      msg.extendedTextMessage?.text ??
      msg.imageMessage?.caption ??
      msg.videoMessage?.caption ??
      msg.documentMessage?.caption ??
      '';

    // Determine message type and download media if present
    const attachments: Attachment[] = [];
    let fallbackText = text;

    if (msg.imageMessage) {
      const data = await this.downloadMediaSafe(message);
      if (data) {
        attachments.push({
          type: 'image',
          mimeType: msg.imageMessage.mimetype ?? 'image/jpeg',
          size: msg.imageMessage.fileLength ?? data.length,
          data,
        });
      }
      if (!fallbackText) fallbackText = '[Photo]';
    } else if (msg.audioMessage) {
      const data = await this.downloadMediaSafe(message);
      if (data) {
        attachments.push({
          type: 'audio',
          mimeType: msg.audioMessage.mimetype ?? 'audio/ogg',
          size: msg.audioMessage.fileLength ?? data.length,
          data,
        });
      }
      if (!fallbackText) fallbackText = '[Voice message]';
    } else if (msg.videoMessage) {
      const data = await this.downloadMediaSafe(message);
      if (data) {
        attachments.push({
          type: 'video',
          mimeType: msg.videoMessage.mimetype ?? 'video/mp4',
          size: msg.videoMessage.fileLength ?? data.length,
          data,
        });
      }
      if (!fallbackText) fallbackText = '[Video]';
    } else if (msg.documentMessage) {
      const data = await this.downloadMediaSafe(message);
      if (data) {
        attachments.push({
          type: 'document',
          mimeType: msg.documentMessage.mimetype ?? 'application/octet-stream',
          fileName: msg.documentMessage.fileName ?? 'document',
          size: msg.documentMessage.fileLength ?? data.length,
          data,
        });
      }
      if (!fallbackText) fallbackText = '[Document]';
    } else if (msg.stickerMessage) {
      // Skip stickers — they don't carry useful information
      if (!text) return;
    }

    // Skip messages with no text and no attachments
    if (!fallbackText && attachments.length === 0) return;

    const normalized: NormalizedMessage = {
      id: message.key.id ?? '',
      platform: 'whatsapp',
      chatId: message.key.remoteJid ?? '',
      chatType: message.key.remoteJid?.endsWith('@g.us')
        ? 'group'
        : 'dm',
      userId:
        message.key.participant ?? message.key.remoteJid ?? '',
      userName:
        message.pushName ??
        message.key.participant ??
        message.key.remoteJid ??
        '',
      text: fallbackText,
      timestamp: new Date(
        (message.messageTimestamp as number) * 1000,
      ),
      replyToMessageId:
        msg.extendedTextMessage?.contextInfo?.stanzaId ?? undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    this.emit('message', normalized);
  }

  private async downloadMediaSafe(message: any): Promise<Buffer | undefined> {
    try {
      if (!this.downloadMedia) return undefined;
      const buffer = await this.downloadMedia(message, 'buffer', {});
      return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    } catch (err) {
      console.error('[whatsapp] Failed to download media', err);
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
