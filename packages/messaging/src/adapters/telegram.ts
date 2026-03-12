import { Bot, InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import type { NormalizedMessage, SendMessageOptions, Attachment } from '@alfred/types';
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

    // Handle text messages
    this.bot.on('message:text', (ctx) => {
      this.emit('message', this.normalizeMessage(ctx.message, ctx.message.text));
    });

    // Handle photos
    this.bot.on('message:photo', async (ctx) => {
      const msg = ctx.message;
      const caption = msg.caption ?? '';
      const text = caption || '[Photo]';

      // Get the largest photo
      const photo = msg.photo[msg.photo.length - 1];
      const attachment = await this.downloadAttachment(photo.file_id, 'image', 'image/jpeg');

      const normalized = this.normalizeMessage(msg, text);
      normalized.attachments = attachment ? [attachment] : undefined;
      this.emit('message', normalized);
    });

    // Handle voice messages
    this.bot.on('message:voice', async (ctx) => {
      const msg = ctx.message;
      const attachment = await this.downloadAttachment(
        msg.voice.file_id,
        'audio',
        msg.voice.mime_type ?? 'audio/ogg',
      );

      const normalized = this.normalizeMessage(msg, '[Voice message]');
      normalized.attachments = attachment ? [attachment] : undefined;
      this.emit('message', normalized);
    });

    // Handle audio files
    this.bot.on('message:audio', async (ctx) => {
      const msg = ctx.message;
      const caption = msg.caption ?? '';
      const text = caption || `[Audio: ${msg.audio.file_name ?? 'audio'}]`;
      const attachment = await this.downloadAttachment(
        msg.audio.file_id,
        'audio',
        msg.audio.mime_type ?? 'audio/mpeg',
      );

      const normalized = this.normalizeMessage(msg, text);
      normalized.attachments = attachment ? [attachment] : undefined;
      this.emit('message', normalized);
    });

    // Handle video messages
    this.bot.on('message:video', async (ctx) => {
      const msg = ctx.message;
      const caption = msg.caption ?? '';
      const text = caption || '[Video]';
      const attachment = await this.downloadAttachment(
        msg.video.file_id,
        'video',
        msg.video.mime_type ?? 'video/mp4',
      );

      const normalized = this.normalizeMessage(msg, text);
      normalized.attachments = attachment ? [attachment] : undefined;
      this.emit('message', normalized);
    });

    // Handle documents
    this.bot.on('message:document', async (ctx) => {
      const msg = ctx.message;
      const doc = msg.document;
      const caption = msg.caption ?? '';
      const text = caption || `[Document: ${doc.file_name ?? 'file'}]`;
      const attachment = await this.downloadAttachment(
        doc.file_id,
        'document',
        doc.mime_type ?? 'application/octet-stream',
        doc.file_name,
      );

      const normalized = this.normalizeMessage(msg, text);
      normalized.attachments = attachment ? [attachment] : undefined;
      this.emit('message', normalized);
    });

    // Handle video notes (round video messages)
    this.bot.on('message:video_note', async (ctx) => {
      const msg = ctx.message;
      const attachment = await this.downloadAttachment(
        msg.video_note.file_id,
        'video',
        'video/mp4',
      );

      const normalized = this.normalizeMessage(msg, '[Video note]');
      normalized.attachments = attachment ? [attachment] : undefined;
      this.emit('message', normalized);
    });

    // Handle stickers
    this.bot.on('message:sticker', (ctx) => {
      const msg = ctx.message;
      const emoji = msg.sticker.emoji ?? '🏷️';
      this.emit('message', this.normalizeMessage(msg, `[Sticker: ${emoji}]`));
    });

    // Handle callback queries (inline keyboard button presses)
    this.bot.on('callback_query:data', (ctx) => {
      const cb = ctx.callbackQuery;
      const from = cb.from;
      const chatId = cb.message?.chat?.id;
      if (!chatId) return;

      // Acknowledge the callback to remove the loading spinner
      ctx.answerCallbackQuery().catch(() => {});

      const normalized: NormalizedMessage = {
        id: String(cb.id),
        platform: 'telegram',
        chatId: String(chatId),
        chatType: cb.message?.chat?.type === 'private' ? 'dm' : 'group',
        userId: String(from.id),
        userName: from.username ?? String(from.id),
        displayName: [from.first_name, from.last_name].filter(Boolean).join(' '),
        text: cb.data,
        timestamp: new Date(),
        metadata: { callbackQuery: true },
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
    const chunks = this.splitText(text, 4096);
    let lastMessageId = '';
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const replyMarkup = isLast && options?.replyMarkup?.inlineKeyboard
        ? {
            inline_keyboard: options.replyMarkup.inlineKeyboard.map(row =>
              row.map(btn => ({ text: btn.text, callback_data: btn.callbackData }))
            ),
          }
        : undefined;

      const result = await this.bot.api.sendMessage(Number(chatId), chunks[i], {
        reply_to_message_id: options?.replyToMessageId
          ? Number(options.replyToMessageId)
          : undefined,
        parse_mode: mapParseMode(options?.parseMode),
        message_thread_id: options?.threadId ? Number(options.threadId) : undefined,
        reply_markup: replyMarkup,
      });
      lastMessageId = String(result.message_id);
    }
    return lastMessageId;
  }

  async editMessage(
    chatId: string,
    messageId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    await this.bot.api.editMessageText(
      Number(chatId),
      Number(messageId),
      text,
      {
        parse_mode: mapParseMode(options?.parseMode),
      },
    );
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    await this.bot.api.deleteMessage(Number(chatId), Number(messageId));
  }

  async sendPhoto(
    chatId: string,
    photo: Buffer,
    caption?: string,
  ): Promise<string | undefined> {
    const result = await this.bot.api.sendPhoto(
      Number(chatId),
      new InputFile(photo, 'image.png'),
      { caption },
    );
    return String(result.message_id);
  }

  async sendFile(
    chatId: string,
    file: Buffer,
    fileName: string,
    caption?: string,
  ): Promise<string | undefined> {
    const result = await this.bot.api.sendDocument(
      Number(chatId),
      new InputFile(file, fileName),
      { caption },
    );
    return String(result.message_id);
  }

  async sendVoice(
    chatId: string,
    audio: Buffer,
    caption?: string,
  ): Promise<string | undefined> {
    const result = await this.bot.api.sendVoice(
      Number(chatId),
      new InputFile(audio, 'voice.ogg'),
      { caption },
    );
    return String(result.message_id);
  }

  private normalizeMessage(msg: Message, text: string): NormalizedMessage {
    return {
      id: String(msg.message_id),
      platform: 'telegram',
      chatId: String(msg.chat.id),
      chatType: msg.chat.type === 'private' ? 'dm' : 'group',
      userId: String(msg.from!.id),
      userName: msg.from!.username ?? String(msg.from!.id),
      displayName: [msg.from!.first_name, msg.from!.last_name]
        .filter(Boolean)
        .join(' '),
      text,
      timestamp: new Date(msg.date * 1000),
      replyToMessageId: msg.reply_to_message
        ? String(msg.reply_to_message.message_id)
        : undefined,
      threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
    };
  }

  private async downloadAttachment(
    fileId: string,
    type: Attachment['type'],
    mimeType: string,
    fileName?: string,
  ): Promise<Attachment | undefined> {
    try {
      const file = await this.bot.api.getFile(fileId);
      const filePath = file.file_path;
      if (!filePath) return undefined;

      const url = `https://api.telegram.org/file/bot${this.bot.token}/${filePath}`;
      const response = await fetch(url);
      if (!response.ok) return undefined;

      const buffer = Buffer.from(await response.arrayBuffer());

      return {
        type,
        mimeType,
        fileName: fileName ?? filePath.split('/').pop(),
        size: buffer.length,
        data: buffer,
      };
    } catch (err) {
      console.error('[telegram] Failed to download file', fileId, err instanceof Error ? err.message : 'Unknown error');
      return undefined;
    }
  }
}
