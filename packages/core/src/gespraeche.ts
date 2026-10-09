import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Platform } from '@alfred/types';

/**
 * v1330 — Gespräche des Owners kanalunabhängig (Owner-Freigabe 09.10. 17:05, „ein Gespräch, viele Kanäle"):
 * Der Verlauf hängt nicht mehr am Kanal (Telegram-Chat, Gerätesitzung, Web-Chat), sondern am Owner.
 *
 * - Hauptgespräch: der bisherige Telegram-Chat des Owners (Zeile bleibt, keine Migration). Telegram, Gerätesitzungen
 *   (`sitzung:<id>`), Terminal und Web (`web-chat-…`) lesen und schreiben darin.
 * - Faden: `owner:faden:<faden>` (faden aus [a-z0-9-]{1,40}), erreichbar aus jeder Oberfläche: App/Terminal über
 *   `sitzung:<id>:<faden>`, Web über `web-faden-<faden>`, Telegram über den Befehl `/faden` (aktiver Faden je Chat).
 * - Der Kanal bleibt der Zustellweg: `message.chatId` (Streams, Pushes, Herkunft) ändert sich nicht, nur der
 *   Gesprächsschlüssel der Pipeline.
 * - Familie und Gäste bleiben in ihren Kanal-Gesprächen; Gruppen, Projekt-Chats und interne API-Chats
 *   (`api-chat-…`, `api-update-…`, `scheduled-…`) ebenfalls.
 */
export const FADEN_RE = /^[a-z0-9-]{1,40}$/;

export interface GespraechsZiel { platform: Platform; chatId: string; faden: string | null }

export interface GespraechsOptionen {
  /** Owner-Chat (Telegram-ID) und Plattform — das Hauptgespräch. Ohne Owner-Chat: `api` / `owner:haupt`. */
  ownerChatId?: string;
  ownerPlatform?: Platform;
  /** Aktiver Faden eines Kanal-Chats (Telegram nach `/faden`), null = Hauptgespräch. */
  aktiverFaden?: (platform: Platform, chatId: string) => string | null;
}

export function hauptgespraech(o: GespraechsOptionen): { platform: Platform; chatId: string } {
  return o.ownerChatId ? { platform: o.ownerPlatform ?? 'telegram', chatId: o.ownerChatId } : { platform: 'api', chatId: 'owner:haupt' };
}

export function fadenSchluessel(faden: string): { platform: Platform; chatId: string } {
  return { platform: 'api', chatId: `owner:faden:${faden}` };
}

export const FADEN_PRAEFIX = 'owner:faden:';

/** Gesprächsschlüssel für eine Owner-Nachricht; undefined = Kanal-Gespräch wie bisher. */
export function gespraechsZiel(
  m: { platform: Platform; chatId: string; chatType?: string; metadata?: Record<string, unknown> },
  o: GespraechsOptionen,
): GespraechsZiel | undefined {
  if (m.chatType === 'group') return undefined;
  if (m.metadata?.projectId || m.chatId.startsWith('project:') || m.chatId.startsWith('scheduled-')) return undefined;
  const haupt = hauptgespraech(o);
  const mitFaden = (faden: string | null): GespraechsZiel => faden ? { ...fadenSchluessel(faden), faden } : { ...haupt, faden: null };
  if (o.ownerChatId && m.platform === (o.ownerPlatform ?? 'telegram') && m.chatId === o.ownerChatId) {
    const f = o.aktiverFaden?.(m.platform, m.chatId) ?? null;
    return mitFaden(f && FADEN_RE.test(f) ? f : null);
  }
  if (m.platform !== 'api') return undefined;
  const sitzung = /^sitzung:([^:]+)(?::([a-z0-9-]{1,40}))?$/.exec(m.chatId);
  if (sitzung) return mitFaden(sitzung[2] ?? null);
  if (m.chatId.startsWith('web-chat-')) return mitFaden(null);
  const web = /^web-faden-([a-z0-9-]{1,40})$/.exec(m.chatId);
  if (web) return mitFaden(web[1]!);
  return undefined;
}

/** Zustell-chatId eines Kanals für einen Faden (App/Terminal `sitzung:<id>[:<faden>]`, Web `web-faden-<f>`). */
export function neuerFadenId(): string { return Date.now().toString(36); }

/**
 * Aktiver Faden je Kanal-Chat (Telegram nach `/faden …`), als kleine JSON-Datei im Datenordner.
 */
export class FadenStore {
  private daten: Record<string, string> = {};
  constructor(private readonly datei: string) {
    try { if (existsSync(datei)) this.daten = JSON.parse(readFileSync(datei, 'utf8')) as Record<string, string>; } catch { this.daten = {}; }
  }
  private key(platform: Platform, chatId: string): string { return `${platform}:${chatId}`; }
  aktiver(platform: Platform, chatId: string): string | null { const f = this.daten[this.key(platform, chatId)]; return f && FADEN_RE.test(f) ? f : null; }
  setze(platform: Platform, chatId: string, faden: string | null): void {
    const k = this.key(platform, chatId);
    if (faden) this.daten[k] = faden; else delete this.daten[k];
    try { mkdirSync(path.dirname(this.datei), { recursive: true }); writeFileSync(this.datei, JSON.stringify(this.daten, null, 2)); } catch { /* Ablage optional */ }
  }
}

export interface FadenEintrag { faden: string | null; titel: string; zeit: string; anzahl: number; archiv?: string }

/**
 * Befehl `/faden` (Telegram und jeder andere Kanal): Liste, Wechsel, neu, haupt, löschen. Liefert die Antwort als Text.
 */
export async function fadenBefehl(
  text: string,
  platform: Platform,
  chatId: string,
  deps: { store: FadenStore; liste: () => Promise<FadenEintrag[]>; loeschen: (faden: string) => Promise<boolean> },
): Promise<string> {
  const arg = text.replace(/^\/faden\b/i, '').trim();
  const [wort, ...rest] = arg.split(/\s+/);
  const aktiv = deps.store.aktiver(platform, chatId);
  const zeit = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); };
  if (!wort || wort === 'liste') {
    const l = (await deps.liste()).filter(f => !f.archiv);
    const zeilen = l.map((f, i) => `${f.faden === aktiv ? '▶' : ' '} ${i + 1}. ${f.faden ? f.faden : 'Hauptgespräch'} — ${f.titel || '(leer)'} · ${zeit(f.zeit)} · ${f.anzahl}`);
    return `Gespräche (▶ = aktiv hier):\n${zeilen.join('\n')}\n\n/faden <Nr|Kennung> wechseln · /faden neu [Titel] · /faden haupt · /faden löschen <Kennung>`;
  }
  if (wort === 'haupt') { deps.store.setze(platform, chatId, null); return 'Zurück im Hauptgespräch.'; }
  if (wort === 'neu') { const f = neuerFadenId(); deps.store.setze(platform, chatId, f); return `Neuer Faden ${f} angelegt — alles ab jetzt läuft dort${rest.length ? ` (${rest.join(' ')})` : ''}. /faden haupt bringt dich zurück.`; }
  if (wort === 'löschen' || wort === 'loeschen') {
    const f = rest[0] ?? '';
    if (!FADEN_RE.test(f)) return 'Welchen Faden? /faden löschen <Kennung>';
    const ok = await deps.loeschen(f);
    if (ok && aktiv === f) deps.store.setze(platform, chatId, null);
    return ok ? `Faden ${f} gelöscht.` : `Faden ${f} nicht gefunden.`;
  }
  // Wechsel über Nummer oder Kennung
  const l = (await deps.liste()).filter(f => !f.archiv);
  const nr = Number(wort);
  const ziel = Number.isInteger(nr) && nr >= 1 && nr <= l.length ? l[nr - 1] : l.find(f => f.faden === wort);
  if (!ziel) return `Kein Faden „${wort}“. /faden zeigt die Liste.`;
  deps.store.setze(platform, chatId, ziel.faden);
  return ziel.faden ? `Weiter im Faden ${ziel.faden} — ${ziel.titel || '(leer)'}.` : 'Zurück im Hauptgespräch.';
}
