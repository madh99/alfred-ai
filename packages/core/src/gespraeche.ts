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
  if (sitzung) {
    // v1336 — `sitzung:<id>:haupt` = ausdrücklich Hauptgespräch (Desktop-App); `sitzung:<id>` ohne Faden folgt dem aktiven
    // Faden des Chats (Terminal-Sitzung nach `/faden …`, Ablage wie bei Telegram)
    if (sitzung[2] === 'haupt') return mitFaden(null);
    if (sitzung[2]) return mitFaden(sitzung[2]);
    const f = o.aktiverFaden?.(m.platform, m.chatId) ?? null;
    return mitFaden(f && FADEN_RE.test(f) ? f : null);
  }
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
  /** v1334 — Spiegelung: Fragen und Antworten aus App/Web/Terminal auch in den Owner-Chat (Telegram). Standard aus (Owner-Entscheidung). */
  private spiegel = false;
  constructor(private readonly datei: string) {
    try {
      if (existsSync(datei)) {
        const j = JSON.parse(readFileSync(datei, 'utf8')) as Record<string, unknown>;
        this.spiegel = j['__spiegelung'] === true;
        for (const [k, v] of Object.entries(j)) if (!k.startsWith('__') && typeof v === 'string') this.daten[k] = v;
      }
    } catch { this.daten = {}; }
  }
  private key(platform: Platform, chatId: string): string { return `${platform}:${chatId}`; }
  aktiver(platform: Platform, chatId: string): string | null { const f = this.daten[this.key(platform, chatId)]; return f && FADEN_RE.test(f) ? f : null; }
  setze(platform: Platform, chatId: string, faden: string | null): void {
    const k = this.key(platform, chatId);
    if (faden) this.daten[k] = faden; else delete this.daten[k];
    this.sichere();
  }
  get spiegelung(): boolean { return this.spiegel; }
  setzeSpiegelung(an: boolean): void { this.spiegel = an; this.sichere(); }
  private sichere(): void {
    try { mkdirSync(path.dirname(this.datei), { recursive: true }); writeFileSync(this.datei, JSON.stringify({ ...this.daten, __spiegelung: this.spiegel }, null, 2)); } catch { /* Ablage optional */ }
  }
}

/** v1334 — Anzeigename einer Herkunft (`telegram:<chat>`, `api:sitzung:<geraet>[:<faden>]`, `api:web-chat-<user>`). */
export function herkunftName(herkunft: string | undefined, geraetName: (geraetId: string) => string | undefined): string {
  if (!herkunft) return '';
  if (herkunft.startsWith('intern:')) return 'System'; // v1336 — Fortsetzung nach Freigabe, geplante Aufgaben
  const [platform, ...rest] = herkunft.split(':');
  const chat = rest.join(':');
  if (platform === 'telegram') return 'Telegram';
  if (platform === 'api') {
    const s = /^sitzung:([^:]+)/.exec(chat);
    if (s) return geraetName(s[1]!) ?? 'Gerät';
    if (chat.startsWith('web-')) return 'Web';
    return 'API';
  }
  return platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : '';
}

/**
 * v1334 — Befehl `/verlauf [n]`: die letzten n Nachrichten des aktuellen Gesprächs mit Zeit und Herkunft — ohne Modell.
 * In Telegram sieht man so, was in der App oder im Web lief.
 */
export async function verlaufBefehl(
  text: string,
  nachrichten: (n: number) => Promise<Array<{ rolle: 'user' | 'assistant' | 'system'; text: string; zeit: string; herkunft?: string }>>,
  geraetName: (geraetId: string) => string | undefined,
  eigeneHerkunft: string,
): Promise<string> {
  const n = Math.min(40, Math.max(1, parseInt(text.replace(/^\/verlauf\b/i, '').trim(), 10) || 10));
  const liste = await nachrichten(n);
  if (liste.length === 0) return 'Noch keine Nachrichten in diesem Gespräch.';
  const zeit = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }); };
  const kurz = (s: string) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > 160 ? t.slice(0, 157) + '…' : t; };
  const zeilen = liste.map(m => {
    const woher = m.herkunft && m.herkunft !== eigeneHerkunft ? ` (${herkunftName(m.herkunft, geraetName)})` : '';
    const wer = m.rolle === 'system' ? 'System' : m.rolle === 'user' ? 'Du' : 'Alfred';
    return `${zeit(m.zeit)} ${wer}${m.rolle === 'user' ? woher : ''}: ${kurz(m.text)}`;
  });
  return `Letzte ${liste.length} Nachrichten dieses Gesprächs:\n${zeilen.join('\n')}`;
}

/** v1334 — Befehl `/spiegel an|aus|status`: Spiegelung von App/Web-Nachrichten in den Owner-Chat. */
export function spiegelBefehl(text: string, store: FadenStore): string {
  const arg = text.replace(/^\/spiegel\b/i, '').trim().toLowerCase();
  if (arg === 'an' || arg === 'ein') { store.setzeSpiegelung(true); return 'Spiegelung an: Fragen und Antworten aus App, Web und Terminal erscheinen ab jetzt auch hier.'; }
  if (arg === 'aus') { store.setzeSpiegelung(false); return 'Spiegelung aus.'; }
  return `Spiegelung ist ${store.spiegelung ? 'an' : 'aus'}. /spiegel an · /spiegel aus`;
}

/** archiv = frühere Gerätesitzung (nur lesen); angeheftet/archiviert (v1497) = Zustand eines Owner-Fadens. */
export interface FadenEintrag { faden: string | null; titel: string; zeit: string; anzahl: number; archiv?: string; angeheftet?: boolean; archiviert?: boolean; projekt?: { id: string; name: string } }

/** v1499 — aktive Projekte (Geräte-Projektakten) für die Seitenleiste und den Zuordnen-Dialog. */
export interface ProjektKurz { id: string; name: string; aktualisiert: string; geraet?: string }

/** v1497 — Anheften und Archivieren eines Fadens. */
export interface FadenAenderung { angeheftet?: boolean; archiviert?: boolean; /** v1499 — Projekt-ID, Name oder null (lösen) */ projekt?: string | null }

/** v1335 — Abhängigkeiten der Faden-Befehle und der Pipeline (ein Typ für beide Seiten). */
export interface FadenDeps {
  store: FadenStore;
  liste: () => Promise<FadenEintrag[]>;
  loeschen: (faden: string) => Promise<boolean>;
  umbenennen?: (faden: string, titel: string) => Promise<boolean>;
  setzen?: (faden: string, aenderung: FadenAenderung) => Promise<boolean>; // v1497
  geraetName: (geraetId: string) => string | undefined;
}

/**
 * Befehl `/faden` (Telegram und jeder andere Kanal): Liste, Wechsel, neu, haupt, löschen, anheften/lösen, archiv/zurück (v1497).
 * Liefert die Antwort als Text.
 */
export async function fadenBefehl(
  text: string,
  platform: Platform,
  chatId: string,
  deps: { store: FadenStore; liste: () => Promise<FadenEintrag[]>; loeschen: (faden: string) => Promise<boolean>; umbenennen?: (faden: string, titel: string) => Promise<boolean>; setzen?: (faden: string, aenderung: FadenAenderung) => Promise<boolean> },
): Promise<string> {
  const arg = text.replace(/^\/faden\b/i, '').trim();
  const [wort, ...rest] = arg.split(/\s+/);
  const aktiv = deps.store.aktiver(platform, chatId);
  // v1335 — `/faden name <Kennung> <Titel>` (oder ohne Kennung: aktiver Faden)
  if (wort === 'name' || wort === 'titel') {
    let f = rest[0] ?? ''; let titel = rest.slice(1).join(' ').trim();
    if (!FADEN_RE.test(f) || !titel) { f = aktiv ?? ''; titel = rest.join(' ').trim(); }
    if (!f) return 'Welcher Faden? /faden name <Kennung> <Titel> — im Hauptgespräch geht das nicht.';
    if (!titel) return 'Welcher Titel? /faden name <Kennung> <Titel>';
    const ok = deps.umbenennen ? await deps.umbenennen(f, titel.slice(0, 80)) : false;
    return ok ? `Faden ${f} heißt jetzt „${titel.slice(0, 80)}“.` : `Faden ${f} nicht gefunden.`;
  }
  const zeit = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); };
  const zeile = (f: FadenEintrag, i: number) => `${f.faden === aktiv ? '▶' : ' '} ${i + 1}. ${f.angeheftet ? '📌 ' : ''}${f.faden ? f.faden : 'Hauptgespräch'} — ${f.titel || '(leer)'} · ${zeit(f.zeit)} · ${f.anzahl}`;
  const sichtbar = async () => (await deps.liste()).filter(f => !f.archiv && !f.archiviert);
  if (!wort || wort === 'liste') {
    const alle = await deps.liste();
    const l = alle.filter(f => !f.archiv && !f.archiviert);
    const archiviert = alle.filter(f => f.archiviert).length;
    return `Gespräche (▶ = aktiv hier, 📌 = angeheftet):\n${l.map(zeile).join('\n')}${archiviert ? `\n\nArchiviert: ${archiviert} — /faden archiv zeigt sie.` : ''}\n\n/faden <Nr|Kennung> wechseln · /faden neu [Titel] · /faden haupt · /faden name <Kennung> <Titel> · /faden anheften|lösen <Nr|Kennung> · /faden archiv [<Nr|Kennung>] · /faden zurück <Kennung> · /faden projekt <Nr|Kennung> <Projekt> · /faden löschen <Kennung>`;
  }
  // v1499 — `/faden projekt <Nr|Kennung> <Projekt>` ordnet zu, `… -` löst
  if (wort === 'projekt') {
    if (!deps.setzen) return 'Das geht hier nicht.';
    const l = await sichtbar();
    const nr = Number(rest[0]);
    const f = Number.isInteger(nr) && nr >= 1 && nr <= l.length ? l[nr - 1].faden : FADEN_RE.test(rest[0] ?? '') ? rest[0] : null;
    const name = rest.slice(1).join(' ').trim();
    if (!f || !name) return 'So geht es: /faden projekt <Nr|Kennung> <Projekt> — oder /faden projekt <Nr|Kennung> - zum Lösen.';
    if (f.startsWith('projekt-')) return 'Ein Projektfaden gehört immer zu seinem Projekt.';
    const loesen = name === '-';
    if (!(await deps.setzen(f, { projekt: loesen ? null : name }))) return loesen ? `Faden ${f} nicht gefunden.` : `Faden ${f} oder Projekt „${name}“ nicht gefunden.`;
    return loesen ? `Faden ${f} gehört zu keinem Projekt mehr.` : `Faden ${f} gehört jetzt zum Projekt „${name}“.`;
  }
  // v1497 — anheften, lösen, archivieren, zurückholen (ohne Angabe: der aktive Faden)
  if (['anheften', 'lösen', 'loesen', 'archiv', 'archivieren', 'zurück', 'zurueck'].includes(wort)) {
    if (wort === 'archiv' && rest.length === 0) {
      const a = (await deps.liste()).filter(f => f.archiviert);
      return a.length
        ? `Archivierte Gespräche:\n${a.map((f, i) => `  ${i + 1}. ${f.faden} — ${f.titel || '(leer)'} · ${zeit(f.zeit)} · ${f.anzahl}`).join('\n')}\n\n/faden <Kennung> öffnen (Schreiben holt ihn zurück) · /faden zurück <Kennung>`
        : 'Keine archivierten Gespräche.';
    }
    if (!deps.setzen) return 'Das geht hier nicht.';
    // Nummern beziehen sich bei „zurück“ auf die Archivliste, sonst auf die sichtbare Liste
    const l = wort.startsWith('zur') ? (await deps.liste()).filter(x => x.archiviert) : await sichtbar();
    const nr = Number(rest[0]);
    const f = Number.isInteger(nr) && nr >= 1 && nr <= l.length ? l[nr - 1].faden : (rest[0] ?? aktiv ?? null);
    if (!f || !FADEN_RE.test(f)) return 'Das Hauptgespräch lässt sich weder anheften noch archivieren. /faden zeigt die Liste.';
    const aenderung: FadenAenderung = wort === 'anheften' ? { angeheftet: true }
      : wort.startsWith('l') ? { angeheftet: false }
        : wort.startsWith('arch') ? { archiviert: true } : { archiviert: false };
    if (!(await deps.setzen(f, aenderung))) return `Faden ${f} nicht gefunden.`;
    const warAktiv = aktiv === f;
    if (aenderung.archiviert && warAktiv) deps.store.setze(platform, chatId, null);
    if (aenderung.angeheftet === true) return `Faden ${f} angeheftet.`;
    if (aenderung.angeheftet === false) return `Faden ${f} gelöst.`;
    return aenderung.archiviert ? `Faden ${f} archiviert.${warAktiv ? ' Du bist zurück im Hauptgespräch.' : ''}` : `Faden ${f} ist zurück in der Liste.`;
  }
  if (wort === 'haupt') { deps.store.setze(platform, chatId, null); return 'Zurück im Hauptgespräch.'; }
  if (wort === 'neu') {
    const f = neuerFadenId(); deps.store.setze(platform, chatId, f);
    // v1335 — Titel gleich setzen (legt die Gesprächszeile an, bevor die erste Nachricht kommt)
    if (rest.length && deps.umbenennen) await deps.umbenennen(f, rest.join(' ').slice(0, 80));
    return `Neuer Faden ${f} angelegt — alles ab jetzt läuft dort${rest.length ? ` („${rest.join(' ').slice(0, 80)}“)` : ''}. /faden haupt bringt dich zurück.`;
  }
  if (wort === 'löschen' || wort === 'loeschen') {
    const f = rest[0] ?? '';
    if (!FADEN_RE.test(f)) return 'Welchen Faden? /faden löschen <Kennung>';
    const ok = await deps.loeschen(f);
    if (ok && aktiv === f) deps.store.setze(platform, chatId, null);
    return ok ? `Faden ${f} gelöscht.` : `Faden ${f} nicht gefunden.`;
  }
  // Wechsel über Nummer (sichtbare Liste) oder Kennung (auch archivierte — Schreiben holt sie zurück, v1497)
  const alle = (await deps.liste()).filter(f => !f.archiv);
  const l = alle.filter(f => !f.archiviert);
  const nr = Number(wort);
  const ziel = Number.isInteger(nr) && nr >= 1 && nr <= l.length ? l[nr - 1] : alle.find(f => f.faden === wort);
  if (!ziel) return `Kein Faden „${wort}“. /faden zeigt die Liste.`;
  deps.store.setze(platform, chatId, ziel.faden);
  return ziel.faden ? `Weiter im Faden ${ziel.faden} — ${ziel.titel || '(leer)'}.` : 'Zurück im Hauptgespräch.';
}

/**
 * v1499 — Faden aus der Chat-Kennung einer Anfrage (Herkunft eines Projektstarts): App/Terminal `sitzung:<gerät>:<faden>`,
 * Owner-Faden `owner:faden:<faden>`. Hauptgespräch, Projektfäden und Kanal-Chats (Telegram) haben keinen eigenen Faden.
 */
export function fadenAusChatId(chatId: string | undefined): string | undefined {
  if (!chatId) return undefined;
  const m = /^owner:faden:([a-z0-9-]{1,40})$/.exec(chatId) ?? /^(?:api:)?sitzung:[^:]+:([a-z0-9-]{1,40})$/.exec(chatId);
  const f = m?.[1];
  if (!f || f === 'haupt' || f.startsWith('projekt-')) return undefined;
  return f;
}

/**
 * v1499 — Projekt eines Fadens: der Projektfaden `projekt-<id8>` gehört immer zu seinem Projekt, andere Fäden über die
 * Zuordnung (conversations.project_id). Nur aktive Projekte zählen; archivierte geben den Faden frei.
 */
export function projektDesFadens(faden: string | null, projectId: string | undefined, projekte: ProjektKurz[]): { id: string; name: string } | undefined {
  const kurz = /^projekt-([0-9a-f]{8})$/.exec(faden ?? '')?.[1];
  const p = kurz ? projekte.find(x => x.id.startsWith(kurz)) : projectId ? projekte.find(x => x.id === projectId) : undefined;
  return p ? { id: p.id, name: p.name } : undefined;
}

/** v1499 — Projekt aus der Eingabe des Owners: ID, ID-Anfang oder Name (ohne Groß/klein, ohne 🔨). */
export function projektAusEingabe(eingabe: string, projekte: ProjektKurz[]): ProjektKurz | undefined {
  const e = eingabe.replace(/🔨/g, '').trim().toLowerCase();
  if (!e) return undefined;
  return projekte.find(p => p.id === e) ?? projekte.find(p => e.length >= 6 && p.id.startsWith(e))
    ?? projekte.find(p => p.name.toLowerCase() === e) ?? (() => { const t = projekte.filter(p => p.name.toLowerCase().includes(e)); return t.length === 1 ? t[0] : undefined; })();
}

/**
 * v1504 — Zeitplan einer geplanten Aufgabe lesbar (Rückmeldung an den Owner statt „Scheduled action created … running "undefined"“):
 * cron „M H * * *“ → „täglich um HH:MM“, „M H * * D“ → „jeden Montag um HH:MM“, once → „einmalig am TT.MM.JJJJ um HH:MM“ (Ortszeit Wien).
 */
export function zeitplanText(art: string, wert: string): string {
  const zwei = (n: number) => String(n).padStart(2, '0');
  if (art === 'once') {
    const d = new Date(wert);
    if (Number.isNaN(d.getTime())) return `einmalig (${wert})`;
    return `einmalig am ${d.toLocaleString('de-AT', { timeZone: 'Europe/Vienna', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', ' um')}`;
  }
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/.exec(wert.trim());
  if (art !== 'cron' || !m) return `nach Plan „${wert}“`;
  const um = `${zwei(Number(m[2]))}:${zwei(Number(m[1]))}`;
  if (m[3] === '*') return `täglich um ${um}`;
  const tage = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  return `jeden ${tage[Number(m[3])]} um ${um}`;
}
