import type { SocialChannel, ContentItem } from '@alfred/storage';

export interface ProviderCapabilities {
  text: boolean;
  image: boolean;
  video: boolean;
  maxTextLength?: number;
  supportsDelete: boolean;
  supportsMetrics: boolean;
}

export interface PublishResult {
  externalId: string;
  url?: string;
}

/**
 * v933 — Kanal-Provider (Muster: marketplace/). Secrets kommen NIE aus der DB,
 * sondern werden vom Kern pro Aufruf aufgelöst (project_environments,
 * Stage aus channel.config.env_stage — verschlüsselt via envEncryptionKey).
 */
export abstract class SocialProvider {
  abstract readonly platform: string;
  abstract capabilities(): ProviderCapabilities;
  abstract publish(item: ContentItem, channel: SocialChannel, secrets: Record<string, string>): Promise<PublishResult>;
  /** Prüft Credentials/Erreichbarkeit ohne zu posten. */
  abstract validateAuth(channel: SocialChannel, secrets: Record<string, string>): Promise<{ ok: boolean; detail?: string }>;
  /** Optional: Post wieder löschen (Leitplanke 6). */
  async deletePost(_externalId: string, _channel: SocialChannel, _secrets: Record<string, string>): Promise<boolean> {
    return false;
  }

  /**
   * v936 — Optional: Performance-Metriken zu veröffentlichten Posts
   * (Analytics-Collector ruft täglich; Basis des Lern-Loops).
   */
  async fetchMetrics(
    _items: Array<{ id: string; externalId: string }>,
    _channel: SocialChannel,
    _secrets: Record<string, string>,
  ): Promise<Array<{ itemId: string; kind: string; value: number }>> {
    return [];
  }
}

/**
 * v959 — Best-Practice-Posting-Slots je Plattform (Server-Ortszeit, Wochenende
 * bewusst enthalten — gerade Sport-Content lebt vom Wochenende). Gelten als
 * Default, solange der Kanal keine eigenen posting_slots konfiguriert hat;
 * User-Slots überstimmen immer.
 */
export const BEST_PRACTICE_SLOTS: Record<string, string[]> = {
  telegram_channel: ['Di 12:00', 'Do 18:30', 'Sa 10:00', 'So 19:00'],
  rest:             ['Mo 08:00', 'Mi 12:30', 'Fr 17:00', 'So 10:00'],
  instagram:        ['Di 11:00', 'Do 17:00', 'Sa 11:00', 'So 19:00'],
  facebook:         ['Mi 13:00', 'Fr 09:00', 'Sa 12:00', 'So 19:00'],
  threads:          ['Di 12:00', 'Do 18:00', 'So 20:00'],
  youtube:          ['Fr 15:00', 'So 11:00'],
  x:                ['Mo 08:30', 'Mi 12:00', 'Fr 17:30', 'Sa 20:00'],
};

const FALLBACK_SLOTS = ['Mo 18:00', 'Mi 18:00', 'Fr 18:00', 'So 10:00'];

/** Effektive Slots eines Kanals: User-Konfiguration gewinnt, sonst Plattform-Best-Practice. */
export function effectiveSlots(channel: { postingSlots: string[]; platform: string }): { slots: string[]; source: 'user' | 'best-practice' } {
  if (channel.postingSlots.length > 0) return { slots: channel.postingSlots, source: 'user' };
  return { slots: BEST_PRACTICE_SLOTS[channel.platform] ?? FALLBACK_SLOTS, source: 'best-practice' };
}

/** Baut den fertigen Post-Text (Body + Hashtags) mit optionalem Längen-Limit. */
export function composePostText(item: ContentItem, maxLength?: number): string {
  const tags = item.hashtags.length > 0 ? '\n\n' + item.hashtags.map(h => (h.startsWith('#') ? h : `#${h}`)).join(' ') : '';
  let text = `${item.title ? `${item.title}\n\n` : ''}${item.body}${tags}`;
  if (maxLength && text.length > maxLength) {
    // Hashtags haben Vorrang vor den letzten Body-Zeichen
    const room = maxLength - tags.length - 2;
    text = `${(item.title ? `${item.title}\n\n` : '') + item.body}`.slice(0, Math.max(0, room)) + '…' + tags;
  }
  return text;
}
