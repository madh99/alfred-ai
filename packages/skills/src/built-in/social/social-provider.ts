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

/**
 * v961 — Hashtags gehören ins hashtags-Feld, nicht in den Text: das LLM hängt
 * sie trotzdem oft ZUSÄTZLICH ans Body-Ende (Realfall 03.07.: „… Wie hat euch
 * das Match gefallen? #ÖFB #Spanien #Turnier" plus identisches hashtags-Feld
 * → beim Posten doppelt, auf fussball.cc mitten im Artikeltext).
 * Deterministische Schicht (v957-Lektion): abschließende Hashtag-Läufe vom
 * Body abtrennen und als Tags zurückgeben. Bewusst konservativ: reine
 * Hashtag-Schlusszeilen immer; Läufe am Satzende nur ab 2 Tags, damit ein
 * einzelner, in den Satz integrierter Hashtag („… stolz auf das #Nationalteam")
 * den Satz nicht verstümmelt.
 */
export function extractTrailingHashtags(body: string): { body: string; tags: string[] } {
  const HASHTAG = /#[\p{L}\p{N}_]+/gu;
  const tags: string[] = [];
  let text = body.trimEnd();
  for (;;) {
    const lines = text.split('\n');
    const last = lines[lines.length - 1].trim();
    // Schlusszeile, die NUR aus Hashtags (+ Trennzeichen) besteht
    if (lines.length > 1 && last.length > 0 && /^(?:#[\p{L}\p{N}_]+[\s,;·|]*)+$/u.test(last)) {
      tags.unshift(...(last.match(HASHTAG) ?? []));
      text = lines.slice(0, -1).join('\n').trimEnd();
      continue;
    }
    // Lauf aus ≥2 Hashtags am Ende der letzten Textzeile
    const m = text.match(/(?:\s+#[\p{L}\p{N}_]+){2,}\s*$/u);
    if (m && m.index !== undefined && m.index > 0) {
      tags.unshift(...(m[0].match(HASHTAG) ?? []));
      text = text.slice(0, m.index).trimEnd();
      continue;
    }
    break;
  }
  return { body: text.replace(/\n{3,}/g, '\n\n').trim(), tags };
}

/** v961 — Tags mergen (Dedup ohne #, case-insensitiv), Feld-Format bleibt erhalten. */
export function mergeHashtags(fieldTags: string[], bodyTags: string[], max = 10): string[] {
  const norm = (t: string) => t.replace(/^#/, '').toLowerCase();
  const merged: string[] = [];
  for (const t of [...fieldTags, ...bodyTags]) {
    if (t.trim() && !merged.some(x => norm(x) === norm(t))) merged.push(t);
  }
  return merged.slice(0, max);
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
