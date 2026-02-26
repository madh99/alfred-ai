import { Client, GatewayIntentBits, Events } from 'discord.js';
import type { NormalizedMessage, SendMessageOptions } from '@alfred/types';
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

    this.client.on(Events.MessageCreate, (message) => {
      if (message.author.bot) return;

      const normalized: NormalizedMessage = {
        id: message.id,
        platform: 'discord',
        chatId: message.channelId,
        chatType: message.channel.isDMBased() ? 'dm' : 'group',
        userId: message.author.id,
        userName: message.author.username,
        displayName: message.author.displayName,
        text: message.content,
        timestamp: message.createdAt,
        replyToMessageId: message.reference?.messageId ?? undefined,
      };
      this.emit('message', normalized);
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

    if (options?.replyToMessageId) {
      const original = await channel.messages.fetch(options.replyToMessageId);
      const reply = await original.reply(text);
      return reply.id;
    }

    const message = await channel.send(text);
    return message.id;
  }

  async editMessage(
    chatId: string,
    messageId: string,
    text: string,
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
}
