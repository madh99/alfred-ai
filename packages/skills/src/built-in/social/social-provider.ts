import type { SocialChannel, ContentItem } from '@alfred/storage';

export interface ProviderCapabilities {
  text: boolean;
  image: boolean;
  video: boolean;
  maxTextLength?: number;
  supportsDelete: boolean;
  supportsMetrics: boolean;
  /** v989 — Kommentare lesen/beantworten (fetchComments/replyToComment implementiert). */
  supportsComments?: boolean;
  /** v1007 — Stories veröffentlichen (publishStory implementiert, aktuell Instagram). */
  supportsStories?: boolean;
  /** v1019 — Kanalwachstum: fetchAudience liefert den aktuellen Follower-/Abonnenten-Stand. */
  supportsAudience?: boolean;
}

/** v989 — vom Provider eingesammelter Roh-Kommentar. */
export interface FetchedComment {
  itemId: string;
  externalCommentId: string;
  externalPostId?: string;
  author?: string;
  text: string;
  createdAt?: string;
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

  /** v989 — Optional: Kommentare zu veröffentlichten Posts einsammeln. */
  async fetchComments(
    _items: Array<{ id: string; externalId: string }>,
    _channel: SocialChannel,
    _secrets: Record<string, string>,
  ): Promise<FetchedComment[]> {
    return [];
  }

  /** v989 — Optional: auf einen Kommentar antworten. */
  async replyToComment(
    _externalCommentId: string, _text: string,
    _channel: SocialChannel, _secrets: Record<string, string>,
  ): Promise<boolean> {
    return false;
  }

  /** v1007 — Optional: eine Story veröffentlichen (capabilities().supportsStories). */
  async publishStory(
    _imageUrl: string, _channel: SocialChannel, _secrets: Record<string, string>,
  ): Promise<PublishResult> {
    throw new Error(`${this.platform}: Stories werden nicht unterstützt`);
  }

  /** v1019 — Optional: aktueller Follower-/Abonnenten-Stand (capabilities().supportsAudience). */
  async fetchAudience(
    _channel: SocialChannel, _secrets: Record<string, string>,
  ): Promise<{ followers: number } | null> {
    return null;
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
  bluesky:          ['Mo 09:00', 'Mi 12:30', 'Fr 18:00', 'So 20:00'],
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

/**
 * v985 — KI-Kennzeichnung (EU AI Act Art. 50, Transparenzpflicht ab
 * 02.08.2026): Posts mit GENERIERTEN Medien werden beim Veröffentlichen
 * gekennzeichnet. Default AN — config.ai_disclosure=false schaltet je Kanal
 * ab, config.ai_disclosure_text ersetzt den Standardtext.
 */
export function aiDisclosure(
  item: Pick<ContentItem, 'media'>,
  channel: Pick<SocialChannel, 'config'>,
): string | null {
  if (channel.config.ai_disclosure === false) return null;
  if (!item.media?.some(m => m.source === 'generated')) return null;
  const custom = channel.config.ai_disclosure_text;
  return typeof custom === 'string' && custom.trim().length > 0 ? custom.trim() : 'Bild: KI-generiert';
}

/** v1006 — Anzeigename einer Sprache (deutsch benannt, für Prompts); unbekannte Codes bleiben Codes. */
export function languageName(code: string): string {
  const names: Record<string, string> = {
    de: 'Deutsch', en: 'Englisch', fr: 'Französisch', it: 'Italienisch', es: 'Spanisch',
    pt: 'Portugiesisch', nl: 'Niederländisch', pl: 'Polnisch', tr: 'Türkisch', hr: 'Kroatisch',
    cs: 'Tschechisch', hu: 'Ungarisch', sv: 'Schwedisch', da: 'Dänisch', ro: 'Rumänisch',
  };
  return names[code.toLowerCase()] ?? code;
}

/**
 * v999 — UTM-Parameter für Traffic-Links (Follower-Post → Lead-Artikel):
 * utm_source = Plattform, utm_medium = social, utm_campaign = Story-Slug.
 * config.utm === false am Kanal lässt die URL unangetastet.
 */
export function appendUtm(url: string, platform: string, campaign: string): string {
  const slug = campaign.toLowerCase()
    .replace(/[äöüß]/g, ch => (({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' } as Record<string, string>)[ch] ?? ch))
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'social';
  const params = `utm_source=${encodeURIComponent(platform)}&utm_medium=social&utm_campaign=${encodeURIComponent(slug)}`;
  return url.includes('?') ? `${url}&${params}` : `${url}?${params}`;
}

/** Baut den fertigen Post-Text (Body + Hashtags + ggf. KI-Kennzeichnung) mit optionalem Längen-Limit. */
export function composePostText(item: ContentItem, maxLength?: number, channel?: Pick<SocialChannel, 'config'>): string {
  const tags = item.hashtags.length > 0 ? '\n\n' + item.hashtags.map(h => (h.startsWith('#') ? h : `#${h}`)).join(' ') : '';
  // v985 — Kennzeichnung hängt hinter den Hashtags und überlebt die Kürzung
  const disclosure = channel ? aiDisclosure(item, channel) : null;
  const suffix = disclosure ? `\n\n${disclosure}` : '';
  let text = `${item.title ? `${item.title}\n\n` : ''}${item.body}${tags}${suffix}`;
  if (maxLength && text.length > maxLength) {
    // Hashtags + Kennzeichnung haben Vorrang vor den letzten Body-Zeichen
    const room = maxLength - tags.length - suffix.length - 2;
    text = `${(item.title ? `${item.title}\n\n` : '') + item.body}`.slice(0, Math.max(0, room)) + '…' + tags + suffix;
  }
  return text;
}
