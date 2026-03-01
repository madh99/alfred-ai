import { Client, GatewayIntentBits, Events } from 'discord.js';
import type { NormalizedMessage, SendMessageOptions, Attachment } from '@alfred/types';
import { MessagingAdapter } from '../adapter.js';

export class DiscordAdapter extends MessagingAdapter {
  readonly platform = 'discord' as const;
  private client: Client | null = null;
  private readonly token: string;

  constructor(token: string) {
    super();
    this.token = token;
  }

  async connect(): Promise<void> {
    this.status = 'connecting';

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot) return;

      try {
        // Download attachments
        const attachments = await this.downloadAttachments(message);

        const text = message.content || this.inferTextFromAttachments(attachments);

        const normalized: NormalizedMessage = {
          id: message.id,
          platform: 'discord',
          chatId: message.channelId,
          chatType: message.channel.isDMBased() ? 'dm' : 'group',
          userId: message.author.id,
          userName: message.author.username,
          displayName: message.author.displayName,
          text,
          timestamp: message.createdAt,
          replyToMessageId: message.reference?.messageId ?? undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
        };
        this.emit('message', normalized);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    });

    this.client.on(Events.ClientReady, () => {
      this.status = 'connected';
      this.emit('connected');
    });

    this.client.on(Events.Error, (error) => {
      this.emit('error', error);
    });

    await this.client.login(this.token);
  }

  async disconnect(): Promise<void> {
    this.client?.destroy();
    this.client = null;
    this.status = 'disconnected';
    this.emit('disconnected');
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<string> {
    if (!this.client) throw new Error('Client is not connected');

    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased() || !('send' in channel)) {
      throw new Error(`Channel ${chatId} is not a text channel`);
    }

    const chunks = this.splitText(text, 2000);
    let lastMessageId = '';

    for (let i = 0; i < chunks.length; i++) {
      if (i === 0 && options?.replyToMessageId) {
        const original = await channel.messages.fetch(options.replyToMessageId);
        const reply = await original.reply(chunks[i]);
        lastMessageId = reply.id;
      } else {
        const message = await channel.send(chunks[i]);
        lastMessageId = message.id;
      }
    }

    return lastMessageId;
  }

  async editMessage(
    chatId: string,
    messageId: string,
    text: string,
    _options?: SendMessageOptions,
  ): Promise<void> {
    if (!this.client) throw new Error('Client is not connected');

    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased() || !('messages' in channel)) {
      throw new Error(`Channel ${chatId} is not a text channel`);
    }

    const message = await channel.messages.fetch(messageId);
    await message.edit(text);
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    if (!this.client) throw new Error('Client is not connected');

    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased() || !('messages' in channel)) {
      throw new Error(`Channel ${chatId} is not a text channel`);
    }

    const message = await channel.messages.fetch(messageId);
    await message.delete();
  }

  async sendPhoto(
    chatId: string,
    photo: Buffer,
    caption?: string,
  ): Promise<string | undefined> {
    if (!this.client) return undefined;
    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased() || !('send' in channel)) return undefined;

    const msg = await channel.send({
      content: caption,
      files: [{ attachment: photo, name: 'image.png' }],
    });
    return msg.id;
  }

  async sendFile(
    chatId: string,
    file: Buffer,
    fileName: string,
    caption?: string,
  ): Promise<string | undefined> {
    if (!this.client) return undefined;
    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased() || !('send' in channel)) return undefined;

    const msg = await channel.send({
      content: caption,
      files: [{ attachment: file, name: fileName }],
    });
    return msg.id;
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async downloadAttachments(message: any): Promise<Attachment[]> {
    const result: Attachment[] = [];
    const discordAttachments = message.attachments;
    if (!discordAttachments || discordAttachments.size === 0) return result;

    for (const [, att] of discordAttachments) {
      try {
        const res = await fetch(att.url);
        if (!res.ok) continue;

        const arrayBuffer = await res.arrayBuffer();
        const data = Buffer.from(arrayBuffer);
        const type = this.classifyContentType(att.contentType);

        result.push({
          type,
          url: att.url,
          mimeType: att.contentType ?? undefined,
          fileName: att.name ?? undefined,
          size: att.size ?? data.length,
          data,
        });
      } catch (err) {
        console.error('[discord] Failed to download attachment', att.url, err);
      }
    }

    return result;
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
