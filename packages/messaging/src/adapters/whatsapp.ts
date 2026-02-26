import type { NormalizedMessage, SendMessageOptions } from '@alfred/types';
import { MessagingAdapter } from '../adapter.js';

export class WhatsAppAdapter extends MessagingAdapter {
  readonly platform = 'whatsapp' as const;
  private socket: any;
  private readonly dataPath: string;

  constructor(dataPath: string) {
    super();
    this.dataPath = dataPath;
  }

  async connect(): Promise<void> {
    this.status = 'connecting';

    const baileys = await import('@whiskeysockets/baileys');
    const { makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys.default ?? baileys;

    const { state, saveCreds } = await useMultiFileAuthState(this.dataPath);

    this.socket = makeWASocket({
      auth: state,
      printQRInTerminal: true,
    });

    this.socket.ev.on('creds.update', saveCreds);

    this.socket.ev.on('connection.update', (update: any) => {
      if (update.connection === 'open') {
        this.status = 'connected';
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
          this.connect();
        }
      }
    });

    this.socket.ev.on('messages.upsert', ({ messages, type }: { messages: any[]; type: string }) => {
      if (type !== 'notify') return;

      for (const message of messages) {
        if (!message.message) continue;
        if (message.key.fromMe) continue;

        const text =
          message.message.conversation ??
          message.message.extendedTextMessage?.text;

        if (!text) continue;

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
          text,
          timestamp: new Date(
            (message.messageTimestamp as number) * 1000,
          ),
          replyToMessageId:
            message.message.extendedTextMessage?.contextInfo?.stanzaId ?? undefined,
        };

        this.emit('message', normalized);
      }
    });
  }

  async disconnect(): Promise<void> {
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
}
