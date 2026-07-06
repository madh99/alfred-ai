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
    return { text: true, image: true, video: true, maxTextLength: 4096, supportsDelete: true, supportsMetrics: false, supportsAudience: true };
  }

  /** v1019 — Kanalwachstum: Abonnenten-Stand via getChatMemberCount. */
  override async fetchAudience(channel: SocialChannel, secrets: Record<string, string>): Promise<{ followers: number } | null> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token(secrets)}/getChatMemberCount`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId(channel) }),
      });
      const data = await res.json() as { ok: boolean; result?: number };
      return data.ok && typeof data.result === 'number' ? { followers: data.result } : null;
    } catch { return null; }
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
    const text = composePostText(item, 4096, channel);
    const image = item.media.find(m => m.type === 'image');
    // v1001 — Traffic: Inline-Button „Ganzer Artikel" (URL kommt vom Skill via performance.trafficUrl)
    const trafficUrl = typeof item.performance?.trafficUrl === 'string' ? item.performance.trafficUrl : undefined;
    const trafficLabel = typeof item.performance?.trafficLabel === 'string' ? item.performance.trafficLabel : '📖 Ganzer Artikel';
    const replyMarkup = trafficUrl ? { inline_keyboard: [[{ text: trafficLabel, url: trafficUrl }]] } : undefined;

    let res: Response;
    if (image && image.pathOrUrl.startsWith('http')) {
      res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, photo: image.pathOrUrl, caption: text.slice(0, 1024), ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }),
      });
    } else if (image) {
      // v942 — lokale Datei (z.B. Studio-generiert): Multipart-Upload
      const { readFile } = await import('node:fs/promises');
      const bytes = await readFile(image.pathOrUrl);
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('caption', text.slice(0, 1024));
      if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
      form.append('photo', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'photo.png');
      res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
    } else {
      res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }),
      });
    }

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
