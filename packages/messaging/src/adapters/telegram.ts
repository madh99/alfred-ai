import { Bot } from 'grammy';
import type { NormalizedMessage, SendMessageOptions } from '@alfred/types';
import { MessagingAdapter } from '../adapter.js';

function mapParseMode(
  mode?: SendMessageOptions['parseMode'],
): 'MarkdownV2' | 'HTML' | undefined {
  if (mode === 'markdown') return 'MarkdownV2';
  if (mode === 'html') return 'HTML';
  return undefined;
}

export class TelegramAdapter extends MessagingAdapter {
  readonly platform = 'telegram' as const;
  private readonly bot: Bot;

  constructor(token: string) {
    super();
    this.bot = new Bot(token);
  }

  async connect(): Promise<void> {
    this.status = 'connecting';

    this.bot.on('message:text', (ctx) => {
      const msg = ctx.message;
      const normalized: NormalizedMessage = {
        id: String(msg.message_id),
        platform: 'telegram',
        chatId: String(msg.chat.id),
        chatType: msg.chat.type === 'private' ? 'dm' : 'group',
        userId: String(msg.from.id),
        userName: msg.from.username ?? String(msg.from.id),
        displayName: [msg.from.first_name, msg.from.last_name]
          .filter(Boolean)
          .join(' '),
        text: msg.text,
        timestamp: new Date(msg.date * 1000),
        replyToMessageId: msg.reply_to_message
          ? String(msg.reply_to_message.message_id)
          : undefined,
      };
      this.emit('message', normalized);
    });

    this.bot.catch((err) => {
      this.emit('error', err.error as Error);
    });

    this.bot.start({
      onStart: () => {
        this.status = 'connected';
        this.emit('connected');
      },
    });
  }

  async disconnect(): Promise<void> {
    await this.bot.stop();
    this.status = 'disconnected';
    this.emit('disconnected');
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<string> {
    const result = await this.bot.api.sendMessage(Number(chatId), text, {
      reply_to_message_id: options?.replyToMessageId
        ? Number(options.replyToMessageId)
        : undefined,
      parse_mode: mapParseMode(options?.parseMode),
    });
    return String(result.message_id);
  }

  async editMessage(
    chatId: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    await this.bot.api.editMessageText(
      Number(chatId),
      Number(messageId),
      text,
    );
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    await this.bot.api.deleteMessage(Number(chatId), Number(messageId));
  }
}
