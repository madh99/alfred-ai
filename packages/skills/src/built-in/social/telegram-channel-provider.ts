import type { SocialChannel, ContentItem } from '@alfred/storage';
import { SocialProvider, composePostText, type ProviderCapabilities, type PublishResult } from './social-provider.js';

/**
 * v933 — Telegram-Kanal-Provider: postet über die Bot-API an einen Kanal.
 * channel.config: { chat_id: '@meinkanal' | '-100…' }
 * Secrets: { TELEGRAM_BOT_TOKEN } — Fallback: globaler Bot-Token (vom Kern
 * injiziert), der Bot muss Kanal-Admin sein.
 */
export class TelegramChannelProvider extends SocialProvider {
  readonly platform = 'telegram_channel';

  constructor(private readonly fallbackBotToken?: string) {
    super();
  }

  capabilities(): ProviderCapabilities {
    return { text: true, image: true, video: true, maxTextLength: 4096, supportsDelete: true, supportsMetrics: false };
  }

  private token(secrets: Record<string, string>): string {
    const t = secrets.TELEGRAM_BOT_TOKEN ?? this.fallbackBotToken;
    if (!t) throw new Error('Kein Telegram-Bot-Token (Secret TELEGRAM_BOT_TOKEN oder globale Telegram-Config)');
    return t;
  }

  private chatId(channel: SocialChannel): string {
    const c = channel.config.chat_id;
    if (typeof c !== 'string' || c.length === 0) throw new Error('channel.config.chat_id fehlt (z.B. "@meinkanal")');
    return c;
  }

  async publish(item: ContentItem, channel: SocialChannel, secrets: Record<string, string>): Promise<PublishResult> {
    const token = this.token(secrets);
    const chatId = this.chatId(channel);
    const text = composePostText(item, 4096);
    const image = item.media.find(m => m.type === 'image');

    let endpoint: string;
    let payload: Record<string, unknown>;
    if (image && image.pathOrUrl.startsWith('http')) {
      endpoint = 'sendPhoto';
      payload = { chat_id: chatId, photo: image.pathOrUrl, caption: text.slice(0, 1024) };
    } else {
      endpoint = 'sendMessage';
      payload = { chat_id: chatId, text };
    }

    const res = await fetch(`https://api.telegram.org/bot${token}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json() as { ok: boolean; result?: { message_id: number }; description?: string };
    if (!data.ok || !data.result) {
      throw new Error(`Telegram: ${data.description ?? `HTTP ${res.status}`}`);
    }
    const username = chatId.startsWith('@') ? chatId.slice(1) : undefined;
    return {
      externalId: String(data.result.message_id),
      url: username ? `https://t.me/${username}/${data.result.message_id}` : undefined,
    };
  }

  async validateAuth(channel: SocialChannel, secrets: Record<string, string>): Promise<{ ok: boolean; detail?: string }> {
    try {
      const token = this.token(secrets);
      const chatId = this.chatId(channel);
      const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId }),
      });
      const data = await res.json() as { ok: boolean; result?: { title?: string }; description?: string };
      return data.ok
        ? { ok: true, detail: data.result?.title }
        : { ok: false, detail: data.description ?? `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async deletePost(externalId: string, channel: SocialChannel, secrets: Record<string, string>): Promise<boolean> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token(secrets)}/deleteMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId(channel), message_id: Number(externalId) }),
      });
      const data = await res.json() as { ok: boolean };
      return data.ok === true;
    } catch {
      return false;
    }
  }
}
