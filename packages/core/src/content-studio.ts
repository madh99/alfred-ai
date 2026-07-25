import type { Logger } from 'pino';
import type {
  SocialRepository, SocialChannel, ContentItem, Story,
  InterestsRepository, InsightsRepository,
} from '@alfred/storage';
import type { LLMProvider } from '@alfred/llm';
import type { Skill, SkillRegistry, SkillSandbox } from '@alfred/skills';
import { effectiveSlots, extractTrailingHashtags, mergeHashtags, isNearDuplicateTitle, cosineSimilarity, languageName, applyImageOverlays, cropToRatio, resolveImageBranding, parseOverlayCorner, leadHatTiefe, type OverlaySpec } from '@alfred/skills';
export { extractTrailingHashtags, isNearDuplicateTitle };
import type { SourceProvisioner } from './source-provisioner.js';
import type { StoryDeduper, BlockedStory } from './story-dedup.js';
// v1100 — Fenster-Helfer der Engine (Zyklus unkritisch: Nutzung nur zur Laufzeit)
import { publishWindowFor, isWithinWindow } from './publishing-engine.js';
import { fetchArticleText } from './article-fetch.js';

const WEEKDAYS: Record<string, number> = { so: 0, mo: 1, di: 2, mi: 3, do: 4, fr: 5, sa: 6 };

/**
 * v1037 — visueller Default-Stil für Bild-Prompts, wenn der Kanal kein
 * image_style gesetzt hat: die TEXT-Persona gehört nicht in den Bild-Prompt
 * (sie enthält Wortzahlen, Verweis-Anweisungen etc. — fürs Bildmodell
 * sinnlos bis irreführend). config.image_style je Kanal übersteuert (v1004).
 */
// v1129 — markenneutral: „Sportfoto-Optik" stand aus der FussballCC-Ära in
// jedem Prompt von Kanälen ohne eigenes image_style (auch Energie-Marken).
const DEFAULT_IMAGE_STYLE = 'hochwertige redaktionelle Foto-Optik, realistisch, klare Komposition, natürliches Licht';

/**
 * v1103 — Sender-/Promo-Boilerplate erkennen (pure, testbar): YouTube-Shorts
 * ohne Transkript liefern als „Summary" die Kanal-Beschreibung („Viertelfinale:
 * Argentinien vs. Schweiz | LIVE bei ServusTV On … #Shorts"). Daraus entstand
 * am 12.07. eine VORSCHAU auf ein längst entschiedenes Nachtspiel.
 */
export function hatPromoBoilerplate(text: string | undefined): boolean {
  if (!text) return false;
  return /#shorts\b|\blive bei\b|\bjetzt abonnieren\b|\bsubscribe\b|\bjetzt streamen\b|\balle spiele live\b/i.test(text);
}

/**
 * v1111 — K.-o.-Ereignis-Erkennung: Inhalte mit Bezug auf konkrete
 * Turnier-Runden sind NIE evergreen (Realfall 13.07.: „Halbfinal-Fieber:
 * Wer holt den Pott?" als evergreen klassifiziert → Slot am 19.07., NACH
 * den Halbfinals am 14./15.). Als vorschau greift die 72h-Haltbarkeit.
 */
/**
 * v1131 — Absatz-Fallback für Website-Leads: Die GLIEDERUNG-Pflicht (v1046)
 * ist nur eine Prompt-Regel, und das LLM ignorierte sie (Realfall 19.07.:
 * DEA-Artikel mit ~1000 Zeichen ohne einen einzigen Umbruch). Lange Texte
 * ohne jede Struktur werden deterministisch an Satzgrenzen in 2-4 möglichst
 * gleich lange Absätze gegliedert; Texte mit vorhandenen Umbrüchen bleiben
 * unangetastet.
 */
export function ensureAbsaetze(body: string): string {
  const text = body.trim();
  if (text.includes('\n') || text.length < 600) return body;
  const saetze = text.match(/[^.!?…]+[.!?…]+["“”»)]*(?:\s+|$)/g);
  if (!saetze || saetze.length < 3) return body;
  const ziel = text.length > 1200 ? 4 : text.length > 850 ? 3 : 2;
  const proAbsatz = Math.ceil(text.length / ziel);
  const absaetze: string[] = [];
  let aktuell = '';
  for (const s of saetze) {
    aktuell += s;
    if (aktuell.length >= proAbsatz && absaetze.length < ziel - 1) {
      absaetze.push(aktuell.trim());
      aktuell = '';
    }
  }
  if (aktuell.trim()) absaetze.push(aktuell.trim());
  return absaetze.length >= 2 ? absaetze.join('\n\n') : body;
}

export function istKoEreignisBezug(text: string): boolean {
  return /halbfinal|viertelfinal|achtelfinal|endspiel|\bfinale\b|\bfinal[es]?\b|k\.?\s?-?o\.?-(runde|phase|spiel)/i.test(text);
}

/**
 * v935 — Nächste freie Posting-Slots eines Kanals (pure, testbar).
 * Slots wie ["Mo 18:00", "Do 19:30"] in SERVER-ORTSZEIT (v959); ohne eigene
 * Slots gelten Plattform-Best-Practices inkl. Wochenende (effectiveSlots) —
 * User-Konfiguration überstimmt immer.
 */
export function nextFreeSlots(
  channel: Pick<SocialChannel, 'postingSlots' | 'planningHorizonDays'> & { platform?: string },
  taken: Array<Pick<ContentItem, 'scheduledAt'>>,
  count: number,
  fromIso: string,
): string[] {
  const slotDefs = effectiveSlots({ postingSlots: channel.postingSlots, platform: channel.platform ?? '' }).slots
    .map(s => {
      const m = s.trim().match(/^([A-Za-zäö]{2})\s+(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      const wd = WEEKDAYS[m[1].toLowerCase()];
      if (wd === undefined) return null;
      return { weekday: wd, hour: Number(m[2]), minute: Number(m[3]) };
    })
    .filter((s): s is { weekday: number; hour: number; minute: number } => s !== null);
  if (slotDefs.length === 0) return [];

  const takenSet = new Set(taken.map(t => t.scheduledAt).filter((t): t is string => !!t).map(t => t.slice(0, 16)));
  const from = new Date(fromIso);
  const horizonEnd = from.getTime() + channel.planningHorizonDays * 24 * 3_600_000;
  const out: string[] = [];

  for (let day = 0; day <= channel.planningHorizonDays && out.length < count; day++) {
    // v1045 — KALENDARISCH iterieren statt +24h-Millisekunden: an DST-Grenzen
    // (Europe/Vienna) verschob die Millisekunden-Rechnung die Ortszeit ±1h
    // und konnte Wochentage überspringen/doppeln
    const date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + day, from.getHours(), from.getMinutes());
    for (const slot of slotDefs) {
      // v959 — LOKALE Server-Zeit (vorher UTC: „Mo 18:00" wurde auf einem
      // Europe/Vienna-Host um 20:00 Ortszeit veröffentlicht)
      if (date.getDay() !== slot.weekday) continue;
      const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), slot.hour, slot.minute);
      if (at.getTime() <= from.getTime() || at.getTime() > horizonEnd) continue;
      const key = at.toISOString().slice(0, 16);
      if (takenSet.has(key)) continue;
      out.push(at.toISOString());
      takenSet.add(key);
      if (out.length >= count) break;
    }
  }
  return out.sort();
}

// v973 — isNearDuplicateTitle lebt jetzt in @alfred/skills (social/dedup.ts),
// weil auch das Publish-Gate im social-Skill sie braucht; hier re-exportiert.

interface GeneratedIdea {
  title: string;
  body: string;
  hashtags: string[];
  warum: string;
  /** v941 — Bildvorschlag als eigenes Feld (wird NIE mitgepostet; dient als Prompt für image_generate). */
  bildidee?: string;
  /** v975 — Termin-Ankündigung: ISO-Zeit des Termins; der Post muss VOR diesem Zeitpunkt erscheinen. */
  terminBis?: string;
  /** v997 — Story-Art: bestimmt die Haltbarkeit (news/recap sind verderblich, evergreen nicht). */
  art?: 'news' | 'vorschau' | 'recap' | 'termin' | 'evergreen';
  /** v1003 — Termin-Ort (exakt aus der Termin-Zeile) für die Termin-Karte auf dem Bild. */
  ort?: string;
  /** v1003 — Einlass-Zeit, NUR wenn in der Quelle belegt. */
  einlass?: string;
  /** v1122 — Basis-Bild des Story-Leads: Follower mit image_share_story übernehmen es (eigene Overlays, kein Budget). */
  leadImagePath?: string;
  /** v1008 — Instagram-Karussell: 2–4 Slides (Motiv ohne Text + kurzer Titel fürs Overlay). */
  slides?: Array<{ motiv: string; titel?: string }>;
}

/**
 * v1073 — Ein Termin-ANKÜNDIGUNGS-Post ist nur art='termin' (oder ohne
 * art-Feld: der Story-/Event-Pfad liefert keins). Vorschauen/News tragen
 * terminBis NUR fürs Scheduling (Slot vor dem Ereignis, Verfall danach) —
 * sie bekommen KEINE Termin-Karte/-Vorlage und keinen Event-Payload
 * (Realfall 09.07.: Spiel-Vorschau mit eingebrannter „Anpfiff"-Karte
 * samt „—"-Platzhaltern).
 */
export function isTerminAnnouncement(x: { terminBis?: string; art?: string }): boolean {
  return Boolean(x.terminBis) && (x.art === undefined || x.art === 'termin');
}

/** v977 — Kommender Termin aus einer Event-Quelle (at = ISO, Ort in summary). */
interface UpcomingEvent {
  title: string;
  summary?: string;
  at: string;
}

/**
 * v998 — Perspektiven-Regel für Termin-Ankündigungen: Der Kanal ist ein
 * berichtendes Medium, der Ort aus der Termin-Zeile der Veranstalter
 * (Realfall 05.07.: „…und wir zeigen es euch in der Dublin Irish Pub" —
 * fussball.cc hat mit der Location nichts zu tun).
 */
const TERMIN_PERSPEKTIVE = '- PERSPEKTIVE bei Terminen (zwingend): Der Kanal ist ein berichtendes MEDIUM, NICHT der Veranstalter. Der in der Termin-Zeile genannte Ort (die Location) zeigt das Spiel bzw. richtet den Termin aus — NIEMALS „wir zeigen", „bei uns", „unser Lokal", „kommt zu uns". Richtig: „Der <Ort> zeigt das Spiel", „im <Ort> läuft…", „Fans können im <Ort> mitfiebern". Einladen ja — aber als Hinweis auf die Location, nie im eigenen Namen.';

/** v977 — ISO in Server-Lokalzeit lesbar machen („04.07.2026 19:00") für Prompts. */
export function formatLocalDateTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * v975 — Termin-Zeit aus Event-Titeln parsen („… – 04.07.2026, 19:00").
 * Interpretation in Server-Lokalzeit — dieselbe wie nextFreeSlots, damit
 * Slot-vor-Termin-Vergleiche konsistent sind. null = kein Termin erkennbar.
 */
export function parseEventTime(title: string): string | null {
  const m = title.match(/(\d{1,2})\.(\d{1,2})\.(\d{4}),?\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const at = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]));
  return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}

/**
 * v942 — LLMs liefern gelegentlich HTML-escapte Texte („WM-Modus &amp; Format",
 * Realfall 03.07.) — vor dem Speichern dekodieren.
 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    // v1045 — auch NUMERISCHE Entities (&#8217; = ’, &#xFC; = ü): Feeds und
    // LLMs liefern sie gelegentlich; sie landeten bisher wörtlich im Post
    .replace(/&#(\d+);/g, (m, d) => {
      const cp = Number(d);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => {
      const cp = parseInt(h, 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    });
}

/**
 * v941 — Meta-Zeilen wie „Bildidee: …" haben im Post-Text nichts verloren
 * (Realfall 03.07.: „Bildidee: Sechs Team-Wappen…" wäre mitgepostet worden).
 * Defense-in-depth zusätzlich zur Prompt-Regel.
 */
export function stripMetaLines(body: string): string {
  return body
    .split('\n')
    .filter(line => !/^\s*(bild-?idee|bildvorschlag|image idea|thumbnail-?idee)\s*:/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * v1036 — Quellen-Boilerplate aus Feed-Texten entfernen, BEVOR sie Stoff
 * werden (Dossier, News-Desk, Konferenz). Realfall 07.07.: Transfermarkt-
 * Beschreibungen beginnen mit „Dieser Artikel erschien auf Transfermarkt in
 * seiner ersten Fassung um 13:28 Uhr und wird fortlaufend aktualisiert." —
 * die nackte Uhrzeit provozierte ein ERFUNDENES Datum im Artikel, der
 * Meta-Satz wurde als Fakt nacherzählt. Bewusst ENG gefasst (Satz muss mit
 * „Dieser Artikel erschien" beginnen und auf „aktualisiert." enden):
 * schlimmster Fall bei neuen Varianten ist „nicht gestrippt" = Status quo.
 */
export function stripSourceBoilerplate(text: string): string {
  return text
    .replace(/(^|\n)\s*Dieser Artikel erschien[^.\n]*aktualisiert\.?\s*/gi, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Tolerantes Parsen der LLM-Ideen (JSON-Array). */
/**
 * v978 — LLMs liefern gelegentlich fast-valides JSON (Realfall 04.07., DB/Live
 * bewiesen: deutsches Zitat „mehr als aufgetankt" — öffnend typografisch,
 * schließend ASCII-Quote → String vorzeitig beendet, JSON.parse kaputt, der
 * ganze Batch verworfen). Reparatur: ASCII-Schließzeichen nach „ typografisch
 * machen; greift NUR im Muster „…" und lässt strukturelle Quotes unangetastet.
 */
export function repairGermanQuotes(text: string): string {
  return text.replace(/„([^„"“]*)"/g, '„$1“');
}

/**
 * v978 — ersten balancierten Top-Level-JSON-Array im Text finden (String-/
 * Escape-bewusst). Der alte Greedy-Regex `\[[\s\S]*\]` riss von der ersten [
 * bis zur LETZTEN ] — Prosa mit Klammern vor/nach dem Array machte den Parse
 * kaputt.
 */
export function extractJsonArray(text: string): unknown[] | null {
  /** Index der zum `[` bei start passenden `]` (String-/Escape-bewusst), -1 wenn keine. */
  const matchBalanced = (t: string, start: number): number => {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']' && --depth === 0) return i;
    }
    return -1;
  };
  // Reparierte Variante ZUERST: bei kaputten Zitaten liest der Scanner sonst
  // String-Grenzen falsch und findet nur innere Felder (z.B. das hashtags-Array).
  const variants = [repairGermanQuotes(text), text];
  let scalarFallback: unknown[] | null = null;
  for (const t of variants) {
    for (let start = t.indexOf('['); start !== -1; start = t.indexOf('[', start + 1)) {
      const end = matchBalanced(t, start);
      if (end === -1) continue;
      try {
        const parsed = JSON.parse(t.slice(start, end + 1));
        if (Array.isArray(parsed)) {
          // Ideen sind Objekte — ein reines Skalar-Array ist ein inneres Feld;
          // leere Arrays (z.B. "hashtags": []) taugen nicht mal als Fallback
          if (parsed.some(e => e !== null && typeof e === 'object' && !Array.isArray(e))) return parsed;
          if (parsed.length > 0) scalarFallback ??= parsed;
        }
      } catch { /* nächste Startposition probieren */ }
    }
  }
  if (scalarFallback) return scalarFallback;
  // v980 — Truncation-Rettung: wurde die Antwort mitten im JSON abgeschnitten
  // (maxTokens), fehlt das schließende ]. Bis zum letzten kompletten Objekt
  // schneiden und schließen — vollständige Ideen überleben den Abschnitt.
  const start = text.indexOf('[');
  const lastObj = text.lastIndexOf('}');
  if (start !== -1 && lastObj > start) {
    for (const t of [text, repairGermanQuotes(text)]) {
      try {
        const parsed = JSON.parse(`${t.slice(start, t.lastIndexOf('}') + 1)}]`);
        if (Array.isArray(parsed) && parsed.some(e => e !== null && typeof e === 'object' && !Array.isArray(e))) return parsed;
      } catch { /* Rettung fehlgeschlagen */ }
    }
  }
  return null;
}

export function parseIdeas(text: string): GeneratedIdea[] {
  const parsed = extractJsonArray(text ?? '');
  if (!parsed) return [];
  try {
    return parsed
      .filter((i: any) => i && typeof i.body === 'string' && i.body.trim().length > 10)
      .map((i: any) => {
        const { body, tags: bodyTags } = extractTrailingHashtags(
          stripMetaLines(decodeHtmlEntities(String(i.body)).slice(0, 8000)),
        );
        const fieldTags: string[] = Array.isArray(i.hashtags) ? i.hashtags.map(String)
          : Array.isArray(i.tags) ? i.tags.map(String) : [];
        return {
          title: typeof i.title === 'string' ? decodeHtmlEntities(i.title).slice(0, 200) : '',
          body,
          // v961 — Feld-Tags + aus dem Body extrahierte mergen (Dedup ohne #, case-insensitiv)
          hashtags: mergeHashtags(fieldTags, bodyTags),
          warum: typeof i.warum === 'string' ? i.warum.slice(0, 300) : '',
          bildidee: typeof i.bildidee === 'string' && i.bildidee.trim().length > 0 ? i.bildidee.slice(0, 400)
            : typeof i.image_idea === 'string' && i.image_idea.trim().length > 0 ? i.image_idea.slice(0, 400) : undefined,
          // v975 — auf kanonisches ISO normalisieren (Vergleich mit Slot-ISO-Strings)
          terminBis: typeof i.terminBis === 'string' && Number.isFinite(Date.parse(i.terminBis))
            ? new Date(i.terminBis).toISOString() : undefined,
          // v997 — Story-Art für die Haltbarkeits-Logik
          art: (['news', 'vorschau', 'recap', 'termin', 'evergreen'] as const).find(k => k === i.art),
          // v1003 — strukturierte Termin-Felder für die Bild-Karte
          // v1073 — LLM-Platzhalter („—", „-", „n/a") verwerfen: sie wurden
          // sonst als Einlass/Ort in die Termin-Karte eingebrannt (Realfall)
          ort: ContentStudio.cleanTerminField(i.ort, 120),
          einlass: ContentStudio.cleanTerminField(i.einlass, 40),
          // v1008 — Karussell-Slides (Motiv + kurzer Overlay-Titel)
          slides: Array.isArray(i.slides)
            ? (i.slides as Array<{ motiv?: unknown; titel?: unknown }>)
              .filter(s => s && typeof s.motiv === 'string' && s.motiv.trim().length > 3)
              .map(s => ({ motiv: String(s.motiv).slice(0, 400), titel: typeof s.titel === 'string' && s.titel.trim() ? s.titel.trim().slice(0, 120) : undefined }))
              .slice(0, 4)
            : undefined,
        };
      })
      .filter((i: GeneratedIdea) => i.body.length > 10)
      .slice(0, 10);
  } catch {
    return [];
  }
}

/**
 * v935 — Content-Studio: füllt den Planungshorizont jedes aktiven Kanals mit
 * Content. Läuft täglich (07:30, HA-Slot vom Kern):
 *
 * 1. Wissens-Kontext einsammeln: Interessen-Dossiers (Topics des Kanals),
 *    Bestperformer aus channel_metrics, zuletzt veröffentlichte Titel
 *    (keine Wiederholungen).
 * 2. Fehlende Slots berechnen (nextFreeSlots) und Ideen per LLM in der
 *    Kanal-Persona erzeugen — YouTube-Kanäle bekommen komplette
 *    Video-Konzepte (Script mit Hook/Kapiteln, Titel, Beschreibung, Tags).
 * 3. Optional Bild je Post via image_generate (Monats-Budget in
 *    channel_metrics gezählt, Default 30).
 * 4. Modus suggest → Entwürfe + EIN stiller Sammel-Insight; approve/autonomous
 *    → direkt in die Slots terminiert (die Publishing-Engine übernimmt
 *    Freigabe bzw. Auto-Publish samt Leitplanken).
 *
 * Beim ersten Lauf je Kanal wird ein Interessen-Topic angelegt (origin=auto,
 * Quellen via Source-Provisioner) — damit sammelt der stündliche
 * TopicCollector Futter für künftige Ideen.
 */
export class ContentStudio {
  constructor(
    private readonly socialRepo: SocialRepository,
    private readonly interestsRepo: InterestsRepository | undefined,
    private readonly insightsRepo: InsightsRepository | undefined,
    private readonly llm: LLMProvider,
    private readonly skillRegistry: Pick<SkillRegistry, 'get'> | undefined,
    private readonly skillSandbox: Pick<SkillSandbox, 'execute'> | undefined,
    private readonly provisioner: SourceProvisioner | undefined,
    private readonly logger: Logger,
    private readonly ownerUserId: string,
    /** v942 — Ablageort für generierte Bilder (image_generate liefert Buffer-Attachments). */
    private readonly mediaDir?: string,
    /** v973 — semantische Story-Dedup (Embeddings + LLM-Judge-Fallback). */
    private readonly storyDeduper?: StoryDeduper,
  ) {}

  /**
   * v1085 — YouTube-Eigenproduktion: rendert ein Studio-Video-Konzept
   * automatisch zum fertigen Video (render_video im Social-Skill: Slideshow +
   * Voiceover + Untertitel + Musik-Bett; Monats-Budget wacht dort). Der
   * Aufruf ist fire-and-forget — das Rendern dauert Minuten.
   */
  private videoRenderer?: (itemId: string, format: '9:16' | '16:9') => Promise<void>;
  setVideoRenderer(fn: (itemId: string, format: '9:16' | '16:9') => Promise<void>): void {
    this.videoRenderer = fn;
  }

  /** Täglicher Lauf über alle aktiven Kanäle. @returns Anzahl erzeugter Items. */
  async runDaily(): Promise<number> {
    const channels = await this.socialRepo.listChannels(this.ownerUserId, 'active');
    let created = 0;
    // v993 — Redaktionsleitung: Familien planen GEMEINSAM (Story-zentriert,
    // eine Redaktionskonferenz je Familie); Solo-Kanäle wie bisher einzeln.
    const families = new Map<string, SocialChannel[]>();
    const solo: SocialChannel[] = [];
    for (const channel of channels) {
      const key = ContentStudio.familyKey(channel);
      if (key) {
        families.set(key, [...(families.get(key) ?? []), channel]);
      } else {
        solo.push(channel);
      }
    }
    for (const [family, members] of families) {
      try {
        if (members.length >= 2) created += await this.planFamily(family, members);
        else created += await this.fillChannel(members[0]);
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, family }, 'v993 family planning failed');
      }
    }
    for (const channel of solo) {
      try {
        created += await this.fillChannel(channel);
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, channel: channel.name }, 'v935 studio channel failed');
      }
    }
    // v1012 — Serien-Formate: wiederkehrende Wochen-Formate zuverlässig je
    // Kanal (unabhängig davon, ob Familie oder Solo — Formate sind kanal-lokal)
    for (const channel of channels) {
      try {
        created += await this.ensureFormats(channel);
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, channel: channel.name }, 'v1012 formats failed');
      }
    }
    if (created > 0) this.logger.info({ created, channels: channels.length }, 'v935 studio pass done');
    return created;
  }

  /**
   * v1012 — Serien-Formate (Playbook): config.formate = [{slot: "Mo 09:00",
   * name: "Wochenrückblick", anweisung: "…"}] — wiederkehrende Wochen-Formate,
   * die zuverlässig jede Woche zum Slot erscheinen (statt dem Zufall des
   * Dossiers überlassen zu sein). Dedup je Vorkommen (±3,5 Tage über
   * performance.format), Freigabe-Modus wie üblich (approve → wartet zum Slot).
   */
  async ensureFormats(channel: SocialChannel): Promise<number> {
    const raw = Array.isArray(channel.config.formate) ? channel.config.formate : [];
    const formats = (raw as Array<{ slot?: unknown; name?: unknown; anweisung?: unknown }>)
      .filter(f => f && typeof f.slot === 'string' && typeof f.name === 'string' && String(f.name).trim())
      .slice(0, 7);
    if (formats.length === 0) return 0;
    await this.ensureTopic(channel);
    const nowIso = new Date().toISOString();
    const existing = await this.socialRepo.listItems(this.ownerUserId, {
      channelId: channel.id, status: ['idea', 'draft', 'scheduled', 'approved', 'published'], limit: 200,
    });
    let created = 0;
    for (const f of formats) {
      const name = String(f.name).trim().slice(0, 80);
      const at = ContentStudio.nextSlotOccurrence(String(f.slot), nowIso);
      if (!at) continue;
      const window = 3.5 * 24 * 3_600_000;
      // v1022 — terminlose Entwürfe desselben Formats blocken IMMER: auf
      // suggest-Kanälen bleibt das Item draft OHNE scheduledAt — der alte
      // 1970-Fallback ließ so JEDEN Lauf ein neues Duplikat erzeugen
      // (LLM-Call + Bild-Budget, nach einer Woche 7 identische Entwürfe).
      const dupe = existing.some(i => i.performance?.format === name
        && ((!i.scheduledAt && !i.publishedAt)
          || Math.abs(Date.parse(i.scheduledAt ?? i.publishedAt ?? '') - Date.parse(at)) < window));
      if (dupe) continue;
      const dossier = await this.topicDossier(channel).catch(() => '');
      const prompt = `Du bist Content-Redakteur für den Social-Kanal "${channel.name}" (${channel.platform}).
${channel.persona ? `Persona/Tonalität: ${channel.persona}\n` : ''}
SERIEN-FORMAT „${name}" — erscheint jede Woche (${String(f.slot)}). Redaktions-Anweisung:
${typeof f.anweisung === 'string' && f.anweisung.trim() ? f.anweisung.trim() : 'Setze das Format sinnvoll um.'}
${dossier ? `\nAKTUELLES THEMEN-DOSSIER (Fakten NUR hieraus):\n${dossier}\n` : ''}
Regeln:
${this.lessonsBlock(channel)}- Sprache: ${ContentStudio.contentLanguage(channel)}. Konkret, kein Clickbait, KEINE URLs.
- Der Post erscheint am ${formatLocalDateTime(at)} — formuliere zeitlich passend, NIE relative Zeitwörter.
- 3-6 Hashtags NUR ins Feld "hashtags"; Bildvorschlag NUR ins Feld "bildidee" (nur Motive, kein Text).

Antworte NUR mit einem VALIDEN JSON-Array mit GENAU EINEM Objekt (Zitate typografisch „…“ oder escaped):
[{"title": "…", "body": "…", "hashtags": ["…"], "warum": "1 Satz", "bildidee": "optional"}]`;
      const response = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 6_000, tier: this.modelTier(channel), reasoningEffort: 'low' });
      const idea = parseIdeas(response.content ?? '')[0];
      if (!idea) {
        this.logger.warn({ channel: channel.name, format: name }, 'v1012 format render unparseable');
        continue;
      }
      const media = await this.maybeGenerateImage(channel, idea);
      const item = await this.socialRepo.createItem(this.ownerUserId, channel.id, {
        status: 'draft', title: idea.title || name, body: idea.body,
        hashtags: idea.hashtags, media, source: 'studio',
      });
      await this.socialRepo.mergePerformance(this.ownerUserId, item.id, {
        warum: idea.warum, format: name, art: 'evergreen',
      });
      // v1093 — Video-Serienformat: die Wochen-Folge wird sofort fertig
      // gerendert (Bild-Slides + Voiceover mit Kanal-/Familien-Stimme +
      // Untertitel + Musik) — Entwurf bleibt in der Freigabe, render_video
      // wacht über video_budget_per_month. Fire-and-forget wie auto_video.
      const wantVideo = (f as { video?: unknown }).video === '9:16' || (f as { video?: unknown }).video === '16:9'
        ? (f as { video?: unknown }).video as '9:16' | '16:9' : undefined;
      if (wantVideo && this.videoRenderer && media.some(m => m.type === 'image')) {
        void this.videoRenderer(item.id, wantVideo).catch(err =>
          this.logger.warn({ item: item.id, format: name, err: (err as Error).message }, 'v1093 format video render failed (Folge bleibt Text/Bild)'));
      }
      if (channel.mode === 'approve' || channel.mode === 'autonomous') {
        await this.socialRepo.transition(this.ownerUserId, item.id, 'scheduled', { scheduledAt: at });
      }
      existing.push({ ...item, scheduledAt: at, performance: { format: name } } as ContentItem);
      created++;
      this.logger.info({ channel: channel.name, format: name, at }, 'v1012 format item created');
    }
    return created;
  }

  /** v1012 — nächstes Vorkommen eines Wochen-Slots („Mo 09:00", Server-Ortszeit) nach fromIso. */
  static nextSlotOccurrence(slot: string, fromIso: string): string | undefined {
    const m = slot.trim().match(/^([A-Za-zäö]{2})\s+(\d{1,2}):(\d{2})$/);
    if (!m) return undefined;
    const wd = WEEKDAYS[m[1].toLowerCase()];
    if (wd === undefined) return undefined;
    const from = new Date(fromIso);
    for (let d = 0; d < 8; d++) {
      const date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d, Number(m[2]), Number(m[3]));
      if (date.getDay() === wd && date.getTime() > from.getTime()) return date.toISOString();
    }
    return undefined;
  }

  /**
   * v994 — News-Desk (Etappe 2): ereignisgetriebene Eilmeldungen.
   *
   * Stündlich vom Kern aufgerufen: bewertet die NEUEN Topic-Items der letzten
   * zwei Stunden je Familie (LLM-Score 0..1, Schwelle konfigurierbar über den
   * Lead-Kanal: config.newsdesk_threshold, Default 0.85). Über der Schwelle →
   * sofortige Story (source 'event') mit Beiträgen auf ALLEN Familien-Kanälen
   * und Ad-hoc-Slots (Lead +30 min, Follower +90 min) — approve-Kanäle
   * bekommen die Freigabe-Anfrage zum Slot, autonome posten direkt.
   * Leitplanken: Nachtruhe (config.newsdesk_quiet [von,bis], Default 22–6 —
   * der Morgen-Lauf greift den Stoff ohnehin auf), max. Eilmeldungen/Tag
   * (config.newsdesk_max_per_day, Default 3), Dedup gegen aktive Stories.
   */
  async newsDesk(): Promise<number> {
    const channels = await this.socialRepo.listChannels(this.ownerUserId, 'active');
    const families = new Map<string, SocialChannel[]>();
    for (const c of channels) {
      const key = ContentStudio.familyKey(c);
      if (key) families.set(key, [...(families.get(key) ?? []), c]);
    }
    let created = 0;
    for (const [family, members] of families) {
      if (members.length < 2) continue;
      try {
        created += await this.newsDeskFamily(family, members);
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, family }, 'v994 news desk failed');
      }
    }
    return created;
  }

  private async newsDeskFamily(family: string, members: SocialChannel[]): Promise<number> {
    const lead = ContentStudio.resolveLead(members); // v996 — Playbook-Lead vor Plattform-Heuristik
    // Nachtruhe (Server-Lokalzeit)
    const quiet = Array.isArray(lead.config.newsdesk_quiet) && (lead.config.newsdesk_quiet as unknown[]).length === 2
      ? (lead.config.newsdesk_quiet as number[]).map(Number) : [22, 6];
    const inQuietAt = (h: number) => quiet[0] > quiet[1] ? (h >= quiet[0] || h < quiet[1]) : (h >= quiet[0] && h < quiet[1]);
    const hour = new Date().getHours();
    if (inQuietAt(hour)) return 0;
    // Tages-Limit
    const maxPerDay = typeof lead.config.newsdesk_max_per_day === 'number' ? lead.config.newsdesk_max_per_day : 3;
    const todayEvents = (await this.socialRepo.listStories(this.ownerUserId, { family, sinceDays: 1 }))
      .filter(s => s.source === 'event').length;
    if (todayEvents >= maxPerDay) return 0;
    // Neue Items der letzten 2 Stunden (ohne Termin-Feeds).
    // v1044 — nach der Nachtruhe fielen Meldungen aus deren Fenster durch
    // BEIDE Raster (weder Eilmeldung noch Breaking-Priorität im Tageslauf):
    // liegt (jetzt−2h) noch in der Ruhe, reicht das Fenster bis 2h VOR den
    // Ruhebeginn zurück — Dubletten fängt der Story-Dedup.
    if (!this.interestsRepo) return 0;
    let sinceMs = Date.now() - 2 * 3_600_000;
    if (inQuietAt(new Date(sinceMs).getHours())) {
      const quietStart = new Date();
      quietStart.setHours(quiet[0], 0, 0, 0);
      if (quietStart.getTime() > Date.now()) quietStart.setDate(quietStart.getDate() - 1);
      sinceMs = Math.min(sinceMs, quietStart.getTime() - 2 * 3_600_000);
    }
    const sinceIso = new Date(sinceMs).toISOString();
    const unionTopics = [...new Set(members.flatMap(c => ContentStudio.linkedTopicIds(c)))];
    const fresh: Array<{ title: string; summary?: string; url?: string }> = [];
    for (const topicId of unionTopics) {
      const items = await this.interestsRepo.listItems(topicId, { sinceIso, limit: 30 });
      // v1036 — Quellen-Boilerplate strippen, BEVOR sie Story-Stoff wird
      // v1103 — YouTube-Items ohne echte Fakten-Summary (Shorts: kein Transkript
      // → „Summary" = Sender-Promo „LIVE bei … #Shorts") sind KEIN Eilmeldungs-
      // Stoff: der Tor-Clip „ÁLVAREEEEEZ!" wurde am 12.07. zur Vorschau auf ein
      // entschiedenes Nachtspiel. Die echten Artikel kommen einen Lauf später.
      fresh.push(...items
        .filter(i => i.sourceKind !== 'events')
        .filter(i => i.sourceKind !== 'youtube' || (typeof i.summary === 'string' && i.summary.trim().length >= 80 && !hatPromoBoilerplate(i.summary)))
        .map(i => ({ title: i.title, url: i.url, summary: i.summary ? stripSourceBoilerplate(i.summary) : undefined })));
    }
    if (fresh.length === 0) return 0;
    // Dedup gegen aktive Stories (Token reicht als Vorfilter)
    const activeStories = await this.socialRepo.listStories(this.ownerUserId, { family, status: 'active', sinceDays: 7 });
    const blockedTitles = activeStories.map(s => s.title);
    const candidates = fresh.filter(f => !isNearDuplicateTitle(f.title, blockedTitles)).slice(0, 15);
    if (candidates.length === 0) return 0;
    // v1115 — Event-Alter-Gate: der Score kennt Datum und jüngst behandelte
    // Storys. Realfall 13.07.: ORF lud morgens das Match-Video vom VORTAG hoch —
    // der Collector sah „frisch", der Score „dramatisches Ergebnis" (0.85), und
    // der News-Desk baute 7 Items für ein 36 h altes, längst behandeltes Spiel;
    // der Frische-Review warf sie 4 Sekunden später weg (Bild/TTS/Video umsonst).
    // Titel-Token und Embeddings griffen nicht („July 11 Matchday Recap" vs.
    // „Bellingham mit dem Doppelpack") — das Ereignis-Alter muss der Score
    // selbst beurteilen. Behandelt = ALLE Storys der letzten 3 Tage (auch
    // done/dropped — der Active-Filter der Dedup ließ genau die durch).
    const coveredTitles = (await this.socialRepo.listStories(this.ownerUserId, { family, sinceDays: 3 }))
      .map(s => s.title).slice(0, 20);
    // LLM-Eilmeldungs-Score (fast reicht fürs Sortieren)
    const threshold = typeof lead.config.newsdesk_threshold === 'number' ? lead.config.newsdesk_threshold : 0.85;
    const scorePrompt = `Bewerte für einen Fußball-Publisher, wie sehr jede Meldung eine EILMELDUNG ist (0..1):
0.9+ = muss SOFORT raus (Titelentscheidung, Rücktritt eines Stars, Skandal, dramatisches Ergebnis eines Top-Spiels),
0.5 = normale Tagesmeldung, 0.2 = Routine. Nur die Fakten der Meldung zählen.
HEUTE ist ${ContentStudio.heuteZeile()}. Eine EILMELDUNG ist ein Ereignis, das JETZT bzw. vor wenigen Stunden passiert ist.
KEINE Eilmeldung (max. 0.3): Spielberichte, Highlight-Videos oder Zusammenfassungen zu Spielen von gestern oder früher — auch wenn Video/Artikel gerade erst erschienen sind; ebenso Neuaufbereitungen bereits behandelter Storys ohne echte neue Entwicklung.
${coveredTitles.length > 0 ? `BEREITS BEHANDELT (letzte 3 Tage):\n${coveredTitles.map(t => `- ${t}`).join('\n')}\n` : ''}
${candidates.map((c, i) => `${i}: ${c.title}${c.summary ? ` — ${c.summary.replace(/<[^>]+>/g, ' ').slice(0, 150)}` : ''}`).join('\n')}

Antworte NUR mit einem VALIDEN JSON-Array: [{"index": 0, "score": 0.4}]`;
    const response = await this.llm.complete({ messages: [{ role: 'user', content: scorePrompt }], maxTokens: 1_000, tier: 'fast', reasoningEffort: 'low' });
    const scores = (extractJsonArray(response.content ?? '') ?? []) as Array<{ index?: unknown; score?: unknown }>;
    const breaking = scores
      .filter(s => typeof s.index === 'number' && typeof s.score === 'number' && s.score >= threshold)
      .map(s => ({ ...candidates[s.index as number], score: s.score as number }))
      .filter(c => c?.title)
      // v1042 — bei mehr Eilmeldungen als Tagesbudget gewinnt die WICHTIGSTE,
      // nicht die zufällige Array-Reihenfolge des LLM
      .sort((a, b) => b.score - a.score)
      .slice(0, maxPerDay - todayEvents);
    if (breaking.length === 0) return 0;

    // v1022 — Semantik-Dedup als BATCH (wie in der Konferenz): der alte
    // Einzel-Check pro Kandidat verglich nur gegen das eingefrorene Story-Set —
    // dieselbe Schlagzeile aus zwei Feeds wurde so zur Doppel-Eilmeldung auf
    // allen Familien-Kanälen. Der Batch dedupliziert auch untereinander.
    let acceptedBreaking = breaking;
    if (this.storyDeduper) {
      const r = await this.storyDeduper.filterCandidates(
        breaking.map(b => ({ ...b, body: b.summary ?? '' })),
        activeStories.map(s => ({ id: s.id, title: s.title, body: s.summary })),
      );
      acceptedBreaking = r.accepted;
    }
    if (acceptedBreaking.length === 0) return 0;

    // v1100 — Headline-only-Stoff anreichern: GoogleNews-Feeds liefern als
    // Summary nur die Schlagzeile (Realfall Adams) — für die akzeptierten
    // Eilmeldungen den Artikeltext der Quelle ziehen (max. 3 Fetches/Lauf,
    // still bei Fehler/Paywall — dann bleibt es bei der Schlagzeile und das
    // Substanz-Gate im Schreib-Prompt greift).
    let articleFetches = 0;
    for (const b of acceptedBreaking as Array<{ title: string; summary?: string; url?: string }>) {
      const plain = (b.summary ?? '').replace(/<[^>]+>/g, ' ').trim();
      // v1103 — Sender-Promo („LIVE bei …") zählt als headline-only
      const headlineOnly = plain.length < Math.max(80, b.title.length + 40) || hatPromoBoilerplate(plain);
      if (b.url && headlineOnly && articleFetches < 3) {
        articleFetches++;
        const text = await fetchArticleText(b.url);
        if (text) {
          b.summary = text;
          this.logger.info({ family, title: b.title.slice(0, 60), chars: text.length }, 'v1100 Eilmeldungs-Stoff per Artikel-Volltext angereichert');
        }
      }
    }

    let created = 0;
    for (const b of acceptedBreaking) {
      const story = await this.socialRepo.createStory(this.ownerUserId, {
        family, kind: 'news', title: b.title, summary: b.summary?.replace(/<[^>]+>/g, ' ').slice(0, 1500),
        importance: b.score, source: 'event',
      });
      await this.storyDeduper?.embedStory(story.id, { title: story.title, body: story.summary });
      let leadName: string | undefined;
      let leadDepth: boolean | undefined; // v1121 — Follower versprechen nur Tiefe, die der Lead hat
      let leadImg: string | undefined; // v1122 — Basis-Bild des Leads für image_share_story
      let itemsCreated = 0;
      for (const channel of [lead, ...members.filter(m => m.id !== lead.id)]) {
        const item = await this.renderAssignment(story, channel, channel.id === lead.id ? 'lead' : 'follow', leadName, undefined, leadDepth, leadImg);
        if (!item) continue;
        if (channel.id === lead.id) {
          leadDepth = leadHatTiefe(item.body);
          leadImg = item.media.find(m => m.type === 'image' && !m.pathOrUrl.startsWith('http'))?.pathOrUrl;
        }
        // v1077 — Eilmeldungs-Marker: „Wichtiges geht immer" — die Engine
        // lässt Breaking-Posts am Nacht-Fenster/Mindestabstand vorbei
        // (gedeckelt, mit Eigen-Jitter)
        await this.socialRepo.mergePerformance(this.ownerUserId, item.id, { breaking: true }).catch(() => { /* non-critical */ });
        // Ad-hoc-Slots: Lead +30 min, Follower +90 min — Freigabe kommt zum Slot.
        // v1022 — ist der Lead suggest (kein automatischer Publish), bleiben
        // Follower Entwurf: sie verweisen auf einen Artikel, der erst nach
        // der Lead-Freigabe live geht (gleiche Regel wie in planFamily).
        const slot = new Date(Date.now() + (channel.id === lead.id ? 30 : 90) * 60_000).toISOString();
        if ((channel.mode === 'approve' || channel.mode === 'autonomous')
          && (channel.id === lead.id || lead.mode !== 'suggest')) {
          await this.socialRepo.transition(this.ownerUserId, item.id, 'scheduled', { scheduledAt: slot });
        }
        await this.socialRepo.createAssignment({ storyId: story.id, channelId: channel.id, role: channel.id === lead.id ? 'lead' : 'follow', offsetHours: channel.id === lead.id ? 0 : 1, itemId: item.id });
        if (channel.id === lead.id) leadName = channel.name;
        itemsCreated++;
      }
      created += itemsCreated;
      // v1044 — Eilmeldungs-Story ohne ein einziges Item: droppen statt den
      // Stoff 30 Tage zu sperren (gleiche Regel wie in planFamily)
      if (itemsCreated === 0) {
        await this.socialRepo.setStoryStatus(this.ownerUserId, story.id, 'dropped').catch(() => { /* best-effort */ });
        this.logger.warn({ family, story: story.title }, 'v1044 leere Eilmeldungs-Story gedroppt (kein Item entstanden)');
        continue;
      }
      await this.insightsRepo?.upsertCandidate(this.ownerUserId, {
        category: 'social',
        title: `⚡ Eilmeldung: ${story.title.slice(0, 70)}`,
        body: `Der News-Desk hat ein wichtiges Ereignis erkannt (Score ${b.score.toFixed(2)}) und ${itemsCreated} Entwürfe vorbereitet — Veröffentlichung in 30–90 Minuten, Freigaben kommen zum Slot.\n\nStoff: ${story.summary ?? story.title}`,
        confidence: 0.9,
        sourceData: { router: true, urgency: 'high', storyId: story.id },
        dedupeKey: `social-newsdesk:${story.id}`,
      }).catch(() => { /* non-critical */ });
      this.logger.info({ family, story: story.title, score: b.score, items: itemsCreated }, 'v994 breaking story created');
    }
    return created;
  }

  /**
   * v1024 — Ad-hoc-Story auf User-Zuruf: derselbe Familienpfad wie der
   * News-Desk (Lead +30 min, Follower +90 min, je Kanal eigener Text mit
   * Persona/Sprache, Bilder, Freigaben nach Kanal-Modus), aber der Stoff
   * kommt vom USER statt aus den Feeds — bewusst OHNE Score-Schwelle,
   * Nachtruhe und News-Desk-Tageslimit: der User hat bereits entschieden.
   */
  async planAdhocStory(titel: string | undefined, stoff: string, familyKey?: string): Promise<{ created: number; channels: string[]; family: string; storyTitle: string; warnings: string[] }> {
    const channels = await this.socialRepo.listChannels(this.ownerUserId, 'active');
    const families = new Map<string, SocialChannel[]>();
    for (const c of channels) {
      const key = ContentStudio.familyKey(c);
      if (key) families.set(key, [...(families.get(key) ?? []), c]);
    }
    if (families.size === 0) throw new Error('Keine Kanal-Familie vorhanden — Kanälen config.family oder ein Projekt geben.');
    const family = familyKey && families.has(familyKey) ? familyKey
      : families.size === 1 ? [...families.keys()][0] : undefined;
    if (!family) throw new Error(`Mehrere Familien vorhanden (${[...families.keys()].join(', ')}) — family angeben.`);
    const members = families.get(family)!;
    const lead = ContentStudio.resolveLead(members);
    const title = (titel ?? stoff.split('\n')[0]).replace(/<[^>]+>/g, ' ').trim().slice(0, 140);
    const story = await this.socialRepo.createStory(this.ownerUserId, {
      family, kind: 'news', title, summary: stoff.replace(/<[^>]+>/g, ' ').slice(0, 800),
      importance: 1, source: 'manual',
    });
    await this.storyDeduper?.embedStory(story.id, { title: story.title, body: story.summary });
    let leadName: string | undefined;
    let leadDepth: boolean | undefined; // v1121 — Follower versprechen nur Tiefe, die der Lead hat
    let leadImg: string | undefined; // v1122 — Basis-Bild des Leads für image_share_story
    const done: string[] = [];
    const warnings: string[] = [];
    for (const channel of [lead, ...members.filter(m => m.id !== lead.id)]) {
      const item = await this.renderAssignment(story, channel, channel.id === lead.id ? 'lead' : 'follow', leadName, undefined, leadDepth, leadImg);
      if (!item) continue;
      if (channel.id === lead.id) {
        leadDepth = leadHatTiefe(item.body);
        leadImg = item.media.find(m => m.type === 'image' && !m.pathOrUrl.startsWith('http'))?.pathOrUrl;
      }
      // v1068 — Vorab-Check (beratend): hatte der Kanal in den letzten 7 Tagen
      // schon einen sehr ähnlichen Beitrag, bleibt das Item ENTWURF statt
      // terminiert — nichts geht verloren, nichts postet still doppelt, die
      // Freigabe ist die bewusste Entscheidung. Enforcement bleibt IMMER das
      // Publish-Gate (gleiche Kriterien, gemeinsamer Helfer — Realfall 09.07.:
      // TG hatte „Marokko im Viertelfinale" organisch schon, der Story-
      // Follower lief erst beim Publish ins Gate).
      let dup: import('@alfred/storage').ContentItem | undefined;
      try {
        const { findRecentChannelDuplicate } = await import('@alfred/skills');
        dup = await findRecentChannelDuplicate(this.socialRepo, this.ownerUserId, channel.id, item);
      } catch { /* Vorab-Check best-effort — das Publish-Gate greift ohnehin */ }
      if (dup) {
        warnings.push(`⚠️ ${channel.name}: sehr ähnlicher Beitrag bereits veröffentlicht („${(dup.title ?? dup.body.slice(0, 60)).slice(0, 70)}"${dup.publishedAt ? `, ${dup.publishedAt.slice(0, 10)}` : ''}) — bleibt ENTWURF; Freigabe = bewusster Doppel-Post (force).`);
        await this.socialRepo.mergePerformance(this.ownerUserId, item.id, {
          dupWarning: `Sehr ähnlich zu [${dup.id.slice(0, 8)}] „${(dup.title ?? '').slice(0, 70)}" (${dup.publishedAt?.slice(0, 10) ?? 'kürzlich'} auf ${channel.name})`,
        }).catch(() => { /* non-critical */ });
      } else {
        // Ad-hoc-Slots wie im News-Desk: Lead +30 min, Follower +90 min;
        // v1022-Regel gilt auch hier: suggest-Lead → Follower bleiben Entwurf
        const slot = new Date(Date.now() + (channel.id === lead.id ? 30 : 90) * 60_000).toISOString();
        if ((channel.mode === 'approve' || channel.mode === 'autonomous')
          && (channel.id === lead.id || lead.mode !== 'suggest')) {
          await this.socialRepo.transition(this.ownerUserId, item.id, 'scheduled', { scheduledAt: slot });
        }
      }
      await this.socialRepo.createAssignment({ storyId: story.id, channelId: channel.id, role: channel.id === lead.id ? 'lead' : 'follow', offsetHours: channel.id === lead.id ? 0 : 1, itemId: item.id });
      if (channel.id === lead.id) leadName = channel.name;
      done.push(channel.name);
    }
    await this.insightsRepo?.upsertCandidate(this.ownerUserId, {
      category: 'social',
      title: `⚡ Story angestoßen: ${story.title.slice(0, 70)}`,
      body: `Auf deinen Zuruf wurden ${done.length} Beiträge vorbereitet (${done.join(', ')}) — Lead in ~30, Follower in ~90 Minuten; Freigaben kommen je nach Kanal-Modus zum Slot.${warnings.length > 0 ? `\n\n${warnings.join('\n')}` : ''}\n\nStoff: ${story.summary ?? story.title}`,
      confidence: 0.9,
      sourceData: { router: true, urgency: 'high', storyId: story.id },
      dedupeKey: `social-planstory:${story.id}`,
    }).catch(() => { /* non-critical */ });
    this.logger.info({ family, story: story.title, items: done.length, dupWarnings: warnings.length }, 'v1024 adhoc story planned');
    return { created: done.length, channels: done, family, storyTitle: story.title, warnings };
  }

  /**
   * v995 — Plan-Review (Etappe 3): der Plan lebt bis zur Veröffentlichung.
   *
   * Alle 4 Stunden (und nach News-Desk-Treffern) werden alle geplanten und
   * freigegebenen Beiträge neu bewertet:
   * 1. ABGELAUFEN (deterministisch): terminBis vorbei → rejected, bevor die
   *    Engine am Publish-Gate scheitert.
   * 2. EILMELDUNGS-KOLLISION (deterministisch): entstand in den letzten 4h
   *    eine Event-Story, weichen reguläre Beiträge der nächsten Stunde um
   *    +2h — reine Terminverschiebung, die Freigabe bleibt erhalten.
   * 3. ÜBERHOLT/VERALTET (LLM-Vorschlag): Beiträge der nächsten 48h werden
   *    gegen die frische Nachrichtenlage geprüft — Ergebnis sind NUR
   *    Vorschläge (Sammel-Insight mit reject-/Überarbeitungs-Empfehlung);
   *    freigegebene Inhalte werden NIE stillschweigend geändert.
   */
  async planReview(): Promise<{ expired: number; deferred: number; flagged: number }> {
    const nowIso = new Date().toISOString();
    const result = { expired: 0, deferred: 0, flagged: 0 };
    const items = await this.socialRepo.listItems(this.ownerUserId, { status: ['scheduled', 'approved'], limit: 200 });
    const notes: string[] = [];

    // 1) Abgelaufene Termin-Posts
    for (const item of items) {
      const termin = typeof item.performance?.terminBis === 'string' ? item.performance.terminBis : undefined;
      if (termin && termin <= nowIso) {
        try {
          await this.socialRepo.transition(this.ownerUserId, item.id, 'rejected');
          result.expired++;
          notes.push(`⏰ Zurückgezogen (Termin vorbei): „${(item.title ?? item.body).slice(0, 60)}"`);
        } catch { /* Einzelfehler überspringen */ }
      }
    }

    // 1b) v1044 — Verpasste Freigaben: der Publish-Engine-Dedupe fragt je Slot
    //     genau EINMAL. Blieb die Antwort aus, hing das Item für immer als
    //     „scheduled mit vergangenem Slot" im Backlog und drosselte die
    //     Produktion. Jetzt: überaltert → zurückziehen; sonst bis zu 3× auf
    //     +4h umterminieren (der Freigabe-Dedupe hängt am Slot → neue Anfrage).
    const reviewChannels = await this.socialRepo.listChannels(this.ownerUserId, 'active');
    const channelById = new Map(reviewChannels.map(c => [c.id, c]));
    const overdueCut = new Date(Date.now() - 2 * 3_600_000).toISOString();
    for (const item of items) {
      if (item.status !== 'scheduled' || !item.scheduledAt || item.scheduledAt > overdueCut) continue;
      if (typeof item.performance?.terminBis === 'string') continue; // Termine regelt Schritt 1
      const ch = channelById.get(item.channelId);
      if (!ch || ch.mode === 'suggest') continue; // suggest: der User terminiert selbst
      const art = typeof item.performance?.art === 'string' ? item.performance.art : undefined;
      const shelf = ContentStudio.shelfLifeHours(art, ch);
      if (shelf !== undefined && Date.parse(item.createdAt) + shelf * 3_600_000 < Date.now()) {
        try {
          await this.socialRepo.transition(this.ownerUserId, item.id, 'rejected');
          result.expired++;
          notes.push(`⌛ Freigabe verpasst + überaltert (${art}, ${shelf}h) → zurückgezogen: „${(item.title ?? item.body).slice(0, 60)}"`);
        } catch { /* Einzelfehler überspringen */ }
        continue;
      }
      const nudges = Number(item.performance?.approvalNudges ?? 0);
      if (nudges >= 3) continue; // genug erinnert — bleibt liegen (LLM-Check empfiehlt ggf. reject)
      const newAt = new Date(Date.now() + 4 * 3_600_000).toISOString();
      if (await this.socialRepo.reschedule(this.ownerUserId, item.id, newAt, ['scheduled'])) {
        await this.socialRepo.mergePerformance(this.ownerUserId, item.id, { approvalNudges: nudges + 1 }).catch(() => { /* non-critical */ });
        result.deferred++;
        notes.push(`🔁 Freigabe verpasst → +4h neu terminiert (Anlauf ${nudges + 1}/3): „${(item.title ?? item.body).slice(0, 60)}"`);
      }
    }

    // 1c) v1056 — approved OHNE Termin ist für die Publish-Engine unsichtbar
    //     (dueApproved filtert scheduledBefore) und hing für immer fest
    //     (Realfall 08.07.: zwei fertige Auto-Reels vom 06.07.).
    //     Begleitformate → automatisch Ad-hoc-Termin (+15 min); reguläre
    //     Beiträge → nur Empfehlung (freigegebene Inhalte nie still ändern).
    // v1123 — gestaffelte Ad-hoc-Slots je Kanal: vorher bekamen ALLE slotlosen
    // Begleitformate eines Review-Laufs denselben „jetzt+15"-Termin (Realfall
    // 14.07.: 14 Reels gleichzeitig auf 23:52)
    const adhocTakenByChannel = new Map<string, Array<string | undefined>>();
    // v1124 — Kapazitäts-Ehrlichkeit: voller Tag → Companion auf morgen früh
    const budgetFloorByChannel = new Map<string, string | undefined>();
    for (const item of items) {
      if (item.status !== 'approved' || item.scheduledAt) continue;
      const { isCompanionFormat, staggeredAdhocSlot } = await import('@alfred/skills');
      if (isCompanionFormat(item)) {
        // v1101 — Zweitverwertungs-Abstand (performance.notBefore) respektieren
        const nb = typeof item.performance?.notBefore === 'string' ? item.performance.notBefore : undefined;
        const taken = adhocTakenByChannel.get(item.channelId)
          ?? items.filter(i => i.channelId === item.channelId && i.id !== item.id).map(i => i.scheduledAt);
        if (!budgetFloorByChannel.has(item.channelId)) {
          let floor: string | undefined;
          try {
            const kanal = channelById.get(item.channelId);
            if (kanal) {
              let publishedToday = 0;
              try { publishedToday = await this.socialRepo.countPublishedToday(kanal.id); } catch { /* Mini-Repos ohne Zähler */ }
              const tagesende = new Date(); tagesende.setHours(24, 0, 0, 0);
              const heuteGeplant = items.filter(i => i.channelId === item.channelId && i.scheduledAt
                && i.scheduledAt < tagesende.toISOString() && Date.parse(i.scheduledAt) > Date.now() - 12 * 3_600_000).length;
              if (publishedToday + heuteGeplant >= kanal.maxPostsPerDay) {
                const morgen = new Date(); morgen.setHours(32, 0, 0, 0); // morgen 08:00 lokal
                floor = morgen.toISOString();
              }
            }
          } catch { /* best-effort */ }
          budgetFloorByChannel.set(item.channelId, floor);
        }
        const floor = budgetFloorByChannel.get(item.channelId);
        const effNb = floor && (!nb || Date.parse(nb) < Date.parse(floor)) ? floor : nb;
        const adhoc = staggeredAdhocSlot(taken, effNb ? { notBefore: effNb } : {});
        if (await this.socialRepo.reschedule(this.ownerUserId, item.id, adhoc, ['approved'])) {
          taken.push(adhoc);
          adhocTakenByChannel.set(item.channelId, taken);
          result.deferred++;
          notes.push(`🎬 Begleitformat ohne Termin → ad-hoc terminiert (${formatLocalDateTime(adhoc)}): „${(item.title ?? item.body).slice(0, 60)}"`);
        }
      } else {
        result.flagged++;
        notes.push(`🕳 Freigegeben, aber OHNE Termin (wird nie veröffentlicht): „${(item.title ?? item.body).slice(0, 60)}" [${item.id.slice(0, 8)}] — Empfehlung: umterminieren oder sofort posten.`);
      }
    }

    // 2) Eilmeldungs-Kollision: reguläre Beiträge der nächsten Stunde weichen
    const recentBreaking = (await this.socialRepo.listStories(this.ownerUserId, { sinceDays: 1 }))
      .filter(s => s.source === 'event' && Date.parse(s.createdAt) > Date.now() - 4 * 3_600_000);
    if (recentBreaking.length > 0) {
      const hourAhead = new Date(Date.now() + 3_600_000).toISOString();
      // v1045 — Kollisionsprüfung: belegte Slot-Minuten JE KANAL, damit die
      // +2h-Verschiebung nicht zwei Posts auf dieselbe Minute legt
      const takenMinutes = new Map<string, Set<string>>();
      for (const it of items) {
        if (!it.scheduledAt) continue;
        const set = takenMinutes.get(it.channelId) ?? new Set<string>();
        set.add(it.scheduledAt.slice(0, 16));
        takenMinutes.set(it.channelId, set);
      }
      for (const item of items) {
        if (!item.scheduledAt || item.scheduledAt > hourAhead || item.scheduledAt <= nowIso) continue;
        if (typeof item.performance?.terminBis === 'string') continue; // Termine weichen nicht
        if (item.storyId && recentBreaking.some(s => s.id === item.storyId)) continue; // die Eilmeldung selbst
        const taken = takenMinutes.get(item.channelId) ?? new Set<string>();
        let newAtMs = Date.parse(item.scheduledAt) + 2 * 3_600_000;
        for (let tries = 0; tries < 8 && taken.has(new Date(newAtMs).toISOString().slice(0, 16)); tries++) {
          newAtMs += 15 * 60_000; // v1045 — belegte Minute → 15 min weiter
        }
        const newAt = new Date(newAtMs).toISOString();
        if (await this.socialRepo.reschedule(this.ownerUserId, item.id, newAt, ['scheduled', 'approved'])) {
          taken.delete(item.scheduledAt.slice(0, 16));
          taken.add(newAt.slice(0, 16));
          takenMinutes.set(item.channelId, taken);
          result.deferred++;
          notes.push(`↩️ +2h verschoben (macht der Eilmeldung Platz): „${(item.title ?? item.body).slice(0, 60)}"`);
        }
      }
    }

    // 2b) v997 — Haltbarkeit (deterministisch, NUR Empfehlung): news/recap,
    // deren Slot weiter als die Shelf-Life nach der Erzeugung liegt, sind beim
    // Erscheinen überaltert — sofort melden, nicht erst im 48h-Fenster.
    for (const item of items) {
      if (!item.scheduledAt || item.scheduledAt <= nowIso) continue;
      const art = typeof item.performance?.art === 'string' ? item.performance.art : undefined;
      const ch = channelById.get(item.channelId);
      const shelf = ch ? ContentStudio.shelfLifeHours(art, ch) : undefined;
      if (shelf === undefined) continue;
      const createdMs = Date.parse(item.createdAt);
      if (!Number.isFinite(createdMs)) continue; // defensiv (v1102: auch artlose Items haben jetzt Haltbarkeit)
      const deadline = new Date(createdMs + shelf * 3_600_000).toISOString();
      if (item.scheduledAt > deadline) {
        result.flagged++;
        notes.push(`⏳ Überaltert (${art}, Haltbarkeit ${shelf}h): „${(item.title ?? item.body).slice(0, 60)}" [${item.id.slice(0, 8)}] — Slot ${formatLocalDateTime(item.scheduledAt)}, erzeugt ${formatLocalDateTime(item.createdAt)}. Empfehlung: vorziehen oder ablehnen.`);
      }
    }

    // 3) LLM-Check gegen die Nachrichtenlage — v1111: über den GANZEN
    //    Planungshorizont (14 Tage) statt 48h: die als „evergreen" getarnten
    //    Halbfinal-Posts am 18./19.07. lagen außerhalb des alten Fensters
    //    und wären erst am Vortag aufgefallen. Nächste Slots zuerst.
    const soon = new Date(Date.now() + 14 * 24 * 3_600_000).toISOString();
    const upcoming = items.filter(i => i.scheduledAt && i.scheduledAt > nowIso && i.scheduledAt <= soon
      && typeof i.performance?.terminBis !== 'string' && i.status !== 'rejected')
      .sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!))
      .slice(0, 20);
    if (upcoming.length > 0 && this.interestsRepo) {
      const topicIds = [...new Set(reviewChannels.flatMap(c => ContentStudio.linkedTopicIds(c)))];
      const headlines: string[] = [];
      const sinceIso = new Date(Date.now() - 12 * 3_600_000).toISOString();
      for (const topicId of topicIds) {
        const fresh = await this.interestsRepo.listItems(topicId, { sinceIso, limit: 10 });
        headlines.push(...fresh.filter(i => i.sourceKind !== 'events').map(i => i.title));
      }
      if (headlines.length > 0) {
        const prompt = `Prüfe geplante Social-Beiträge gegen die AKTUELLE Nachrichtenlage.

NACHRICHTENLAGE (letzte 12h):
${[...new Set(headlines)].slice(0, 15).map(h => `- ${h}`).join('\n')}

GEPLANTE BEITRÄGE:
${upcoming.map((i, idx) => `${idx}: [${i.status}] ${(i.title ?? i.body.slice(0, 60))}`).join('\n')}

Je Beitrag: ok | ueberholt (Ereignis ist vorbei/entschieden, Beitrag ergibt keinen Sinn mehr) | aktualisieren (Kern stimmt, Fakten müssten nachgezogen werden). Sei KONSERVATIV — nur klare Fälle melden.
Antworte NUR mit einem VALIDEN JSON-Array: [{"index": 0, "verdict": "ok", "grund": "…"}]`;
        const response = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 1_500, tier: 'fast', reasoningEffort: 'low' });
        const verdicts = (extractJsonArray(response.content ?? '') ?? []) as Array<{ index?: unknown; verdict?: unknown; grund?: unknown }>;
        for (const v of verdicts) {
          if (typeof v.index !== 'number' || !upcoming[v.index]) continue;
          const item = upcoming[v.index];
          if (v.verdict === 'ueberholt') {
            // v1102 — Frische-Review HANDELT bei nicht freigegebenen Beiträgen:
            // überholte scheduled-Items werden zurückgezogen, der Slot wird vom
            // nächsten Studio-Lauf neu besetzt. Freigegebene Inhalte bleiben
            // unantastbar (nur Empfehlung) — bewusste v995-Regel.
            if (item.status === 'scheduled') {
              try {
                await this.socialRepo.transition(this.ownerUserId, item.id, 'rejected');
                result.expired++;
                notes.push(`🗑 Überholt (${String(v.grund ?? '')}) → zurückgezogen, Slot wird neu besetzt: „${(item.title ?? item.body).slice(0, 60)}" [${item.id.slice(0, 8)}]`);
                continue;
              } catch { /* Einzelfehler → fällt auf die Empfehlung zurück */ }
            }
            result.flagged++;
            notes.push(`🗑 Überholt (${String(v.grund ?? '')}): „${(item.title ?? item.body).slice(0, 60)}" [${item.id.slice(0, 8)}] — Empfehlung: ablehnen.`);
          } else if (v.verdict === 'aktualisieren') {
            result.flagged++;
            notes.push(`✏️ Veraltet (${String(v.grund ?? '')}): „${(item.title ?? item.body).slice(0, 60)}" [${item.id.slice(0, 8)}] — Empfehlung: „Verbessern" mit Anweisung „aktuelle Entwicklung einarbeiten"${item.status === 'approved' ? ' (Freigabe wird dabei zurückgesetzt)' : ''}.`);
          }
        }
      }
    }

    if (notes.length > 0) {
      await this.insightsRepo?.upsertCandidate(this.ownerUserId, {
        category: 'social',
        title: `Plan-Review: ${result.expired} zurückgezogen, ${result.deferred} verschoben, ${result.flagged} Empfehlungen`,
        body: notes.join('\n'),
        confidence: 0.8,
        sourceData: { router: true, urgency: result.flagged > 0 ? 'normal' : 'low' },
        dedupeKey: `social-planreview:${nowIso.slice(0, 13)}`,
      }).catch(() => { /* non-critical */ });
      this.logger.info({ ...result }, 'v995 plan review');
    }
    return result;
  }

  /** v993 — Einstieg für „Studio jetzt" auf einem Familien-Kanal: plant die GANZE Familie. */
  async planFamilyFor(channel: SocialChannel): Promise<number> {
    const family = ContentStudio.familyKey(channel);
    if (!family) return this.fillChannel(channel);
    const members = (await this.socialRepo.listChannels(this.ownerUserId, 'active'))
      .filter(c => ContentStudio.familyKey(c) === family);
    if (members.length < 2) return this.fillChannel(channel);
    return this.planFamily(family, members);
  }

  /**
   * v993 — Redaktionsleitung (Etappe 1): Story-zentrierte Familien-Planung.
   *
   * Phase 1 „Redaktionskonferenz": EIN LLM-Pass über das Familien-Dossier
   * entscheidet die Story-Liste (Art, Wichtigkeit, Kanal-Zuweisungen mit
   * Rolle lead/follow und Zeitversatz). Phase 2: je Zuweisung rendert der
   * Kanal-Prompt (Persona/model_tier) den konkreten Beitrag; der Lead geht
   * garantiert VOR den Followern live (Follower-Slot ≥ Lead-Slot + Versatz),
   * Termin-Stories bekommen auf JEDEM Kanal einen Slot vor dem Anpfiff.
   * Dedup ist exakt über die Story-Identität (StoryDeduper gegen aktive
   * Stories der letzten 30 Tage) — die Titel-Heuristiken bleiben Fallback.
   */
  async planFamily(family: string, channels: SocialChannel[], opts?: { nurTermine?: boolean }): Promise<number> {
    const now = new Date().toISOString();
    // Kapazität je Kanal (Slots minus Backlog, wie fillChannel).
    // v1044 — Schlüssel NORMALISIERT (trim+lowercase): die Konferenz referenziert
    // Kanäle über den LLM-Namen; exakter String-Vergleich verlor Zuweisungen
    // bei minimalen Abweichungen still.
    const capKey = (s: string) => s.trim().toLowerCase();
    const capacity = new Map<string, { channel: SocialChannel; slotPool: string[]; needed: number; created: number; planned: ContentItem[]; egDays: Map<string, number> }>();
    for (const channel of channels) {
      await this.ensureTopic(channel);
      const planned = await this.socialRepo.listItems(this.ownerUserId, {
        channelId: channel.id, status: ['scheduled', 'approved', 'draft', 'idea'], limit: 100,
      });
      if (planned.length >= 30) { capacity.set(capKey(channel.name), { channel, slotPool: [], needed: 0, created: 0, planned, egDays: new Map() }); continue; }
      const slots = await this.trimSlotsToDailyBudget(channel, nextFreeSlots(channel, planned, Math.max(0, 30 - planned.length), now), planned);
      const backlog = planned.filter(i => (i.status === 'draft' || i.status === 'idea') && !i.scheduledAt).length;
      capacity.set(capKey(channel.name), { channel, slotPool: [...slots], needed: Math.max(0, slots.length - backlog), created: 0, planned, egDays: new Map() });
    }
    const totalNeeded = [...capacity.values()].reduce((s, c) => s + c.needed, 0);

    // Sperrlisten: aktive Stories (30d) + published Titel der Familie.
    // v1044 — 60 Tage wie im Solo-Pfad (fillChannel): mit 14 Tagen konnte die
    // Konferenz denselben Stoff nach gut zwei Wochen erneut planen.
    const activeStories = await this.socialRepo.listStories(this.ownerUserId, { family, status: 'active', sinceDays: 30 });
    const publishedWindow = new Date(Date.now() - 60 * 24 * 3_600_000).toISOString();
    const blocked: BlockedStory[] = [
      ...activeStories.map(s => ({ id: s.id, title: s.title, body: s.summary, terminAt: s.terminBis })),
    ];
    for (const { channel } of capacity.values()) {
      const pub = await this.socialRepo.listItems(this.ownerUserId, { channelId: channel.id, status: 'published', updatedSince: publishedWindow, limit: 100 });
      blocked.push(...pub.map(i => ({ id: i.id, title: i.title ?? i.body.slice(0, 60), body: i.body, terminAt: typeof i.performance?.terminBis === 'string' ? i.performance.terminBis : undefined })));
    }

    // Familien-Dossier über die Vereinigung aller Themen + Termine
    const unionTopicIds = [...new Set(channels.flatMap(c => ContentStudio.linkedTopicIds(c)))];
    const pseudo = { ...channels[0], config: { ...channels[0].config, topic_ids: unionTopicIds } } as SocialChannel;
    const events = await this.upcomingEvents(pseudo);
    const dossier = await this.topicDossier(pseudo, blocked, events);
    const announcedAt = new Set(blocked.map(b => b.terminAt).filter(Boolean));
    const openTermine = events.filter(e => !announcedAt.has(e.at));
    // v1103 — Spielplan aus dem Dossier (Anstoßzeiten ohne Public-Viewing-Event):
    // bereits angekündigte/geplante Zeitpunkte fallen raus (Termin-Identität)
    const spiele = (await this.extractSpielplan(dossier))
      .filter(s => !announcedAt.has(s.at) && !openTermine.some(e => e.at === s.at));
    if (totalNeeded === 0 && openTermine.length === 0 && spiele.length === 0) return 0;
    // v1103 — Nachmittags-Lauf: ohne offene Termine/Spiele KEIN Konferenz-Call
    if (opts?.nurTermine === true && openTermine.length === 0 && spiele.length === 0) return 0;

    // Konferenz-Pass: höchstes Modell-Tier der Familie entscheidet
    const tierRank: Record<string, number> = { fast: 0, default: 1, medium: 2, strong: 3 };
    const tier = channels.map(c => this.modelTier(c)).sort((a, b) => (tierRank[b] ?? 0) - (tierRank[a] ?? 0))[0];
    const channelLines = [...capacity.values()].map(c =>
      `- "${c.channel.name}" (${c.channel.platform}, Bedarf: ${c.needed} Beiträge)${c.channel.persona ? ` — Rolle/Persona: ${c.channel.persona.slice(0, 120)}` : ''}`).join('\n');
    // v996 — Playbook: feste Redaktionsregeln der Familie (übersteuern die Konferenz)
    const pbLead = channels.find(c => c.config.family_role === 'lead');
    const pbRules: string[] = [];
    if (pbLead) pbRules.push(`- Lead-Kanal ist IMMER "${pbLead.name}" — weise die lead-Rolle NUR ihm zu.`);
    for (const c of channels) {
      const off = ContentStudio.playbookOffset(c, 'news');
      if (off !== undefined && c.id !== pbLead?.id) pbRules.push(`- "${c.name}" folgt standardmäßig mit versatz_h ${off}.`);
    }
    // v1044 — Deckel wächst mit dem Familien-Bedarf (Cap 20 als Prompt-Schutz):
    // der starre 10er-Deckel unterfüllte hochvolumige Kanäle (TG-Limit 20/Tag)
    const storyCount = Math.min(Math.max(totalNeeded, openTermine.length + spiele.length), Math.max(10, Math.min(totalNeeded + spiele.length, 20)));
    const spielplanBlock = spiele.length
      ? `KOMMENDE SPIELE (Anstoßzeiten aus den Quellen belegt — plane für relevante Spiele eine VORSCHAU mit art=vorschau und terminBis EXAKT aus der Zeile; KEINE Ort-Pflicht, es gibt keinen Veranstaltungsort):\n${spiele.map(s => `- ${s.spiel} | terminBis: ${s.at}`).join('\n')}\n\n`
      : '';
    const nurTermineRule = opts?.nurTermine === true
      ? '- NUR-TERMINE-LAUF: Erzeuge AUSSCHLIESSLICH Stories mit terminBis (Termine und Spiel-Vorschauen) — keine sonstigen News/Evergreens.\n'
      : '';
    const conferencePrompt = `Du leitest die Redaktionskonferenz einer Kanal-Familie. Entscheide die Story-Liste für die nächsten Tage.

KANÄLE DER FAMILIE:
${channelLines}

${ContentStudio.linieOf(channels) ? `REDAKTIONSLINIE (verbindlich, vom Herausgeber — Stories und Gewichtung daran ausrichten):\n${ContentStudio.linieOf(channels)}\n\n` : ''}${pbRules.length ? `PLAYBOOK (verbindliche Redaktionsregeln dieser Familie):\n${pbRules.join('\n')}\n\n` : ''}${spielplanBlock}${dossier ? `THEMEN-DOSSIER:\n${dossier}\n` : ''}${blocked.length ? `BEREITS GEPLANT/VERÖFFENTLICHT — dieser Stoff ist GESPERRT (auch umformuliert):\n${[...new Set(blocked.map(b => b.title))].slice(0, 50).map(t => `- ${t}`).join('\n')}\n` : ''}
Erzeuge bis zu ${storyCount} STORIES. Regeln:
${nurTermineRule}- Eine STORY ist ein Stoff, den mehrere Kanäle in IHRER Rolle erzählen — nicht jeder Kanal braucht jede Story.
- Je Story: genau EIN lead-Kanal (der ausführlichste, i.d.R. die Website), follow-Kanäle mit Zeitversatz in Stunden (typisch: Telegram +2, Instagram +6, Facebook +8; Termine/Eilmeldungen: alle 0).
- art: news | vorschau | recap | termin | evergreen. evergreen NIEMALS für Inhalte mit Bezug auf konkrete Turnier-Runden oder Spiele (Halbfinale, Finale, bestimmte Partien) — solche sind vorschau (mit terminBis, wenn der Anstoß bekannt ist) oder news. Termine aus „KOMMENDE TERMINE" IMMER als art=termin mit terminBis (ISO aus der Zeile) und Zuweisung an ALLE Kanäle mit versatz_h 0. In der zusammenfassung: Der Ort aus der Termin-Zeile ist der VERANSTALTER (zeigt das Spiel) — die Kanäle berichten nur darüber, nie „wir zeigen".
- Auch bei art=vorschau auf ein Ereignis mit bekanntem Zeitpunkt (Spiel, Ziehung, Finale): terminBis = ISO-Zeitpunkt des EREIGNISSES setzen — die Vorschau MUSS davor erscheinen; ohne terminBis landet sie auf irgendeinem späten Slot NACH dem Ereignis.
- wichtigkeit 0..1 (Eilmeldungs-Niveau 0.9+). FAKTEN nur aus dem Dossier.
- Weise nur Kanälen mit Bedarf zu (Ausnahme: art=termin darf immer).

Antworte NUR mit einem VALIDEN JSON-Array:
[{"titel": "Arbeitstitel", "zusammenfassung": "2-3 Sätze Stoff mit den Fakten", "art": "news", "wichtigkeit": 0.6, "terminBis": "ISO-Zeitpunkt des Ereignisses bei art=termin UND art=vorschau, sonst null", "kanaele": [{"kanal": "exakter Kanal-Name", "rolle": "lead", "versatz_h": 0}]}]`;
    const response = await this.llm.complete({ messages: [{ role: 'user', content: conferencePrompt }], maxTokens: 8_000, tier, reasoningEffort: 'low' });
    const rawStories = extractJsonArray(response.content ?? '') ?? [];
    if (rawStories.length === 0) {
      this.logger.warn({ family, head: (response.content ?? '').slice(0, 200) }, 'v993 Konferenz-Antwort unparseable');
      return 0;
    }
    type RawStory = { titel?: unknown; zusammenfassung?: unknown; art?: unknown; wichtigkeit?: unknown; terminBis?: unknown; kanaele?: unknown };
    const candidates = (rawStories as RawStory[])
      .filter(s => typeof s?.titel === 'string' && (s.titel as string).trim().length > 3)
      .map(s => ({
        title: String(s.titel).slice(0, 300),
        body: typeof s.zusammenfassung === 'string' ? s.zusammenfassung.slice(0, 1000) : '',
        kind: (['news', 'vorschau', 'recap', 'termin', 'evergreen'] as const).find(k => k === s.art) ?? 'news',
        importance: typeof s.wichtigkeit === 'number' ? Math.max(0, Math.min(1, s.wichtigkeit)) : 0.5,
        terminBis: typeof s.terminBis === 'string' && Number.isFinite(Date.parse(s.terminBis)) ? new Date(s.terminBis).toISOString() : undefined,
        kanaele: Array.isArray(s.kanaele) ? s.kanaele as Array<{ kanal?: unknown; rolle?: unknown; versatz_h?: unknown }> : [],
      }))
      // v1103 — Nur-Termine-Lauf: alles ohne terminBis fällt hart raus
      .filter(c => opts?.nurTermine !== true || c.terminBis !== undefined)
      // v1111 — Evergreen-Gate: K.-o.-Runden-Bezug ist NIE zeitlos — als
      // vorschau greift die 72h-Haltbarkeit (kein Slot hinter dem Ereignis)
      .map(c => {
        if (c.kind === 'evergreen' && istKoEreignisBezug(`${c.title} ${c.body}`)) {
          this.logger.info({ family, title: c.title }, 'v1111 evergreen mit K.-o.-Bezug → vorschau umgestuft');
          return { ...c, kind: 'vorschau' as const };
        }
        return c;
      });

    // Story-Dedup: Termin-Stories über Termin-Identität, Rest über Deduper.
    // v1042 — auch INNERHALB der Konferenz: zwei Stories mit identischem
    // terminBis (dasselbe Spiel doppelt vorgeschlagen) → nur die erste zählt
    // (fillChannel macht das seit je her; hier fehlte die In-Loop-Sperre).
    const normal = candidates.filter(c => !c.terminBis);
    const termine = candidates.filter(c => {
      if (!c.terminBis || announcedAt.has(c.terminBis)) return false;
      announcedAt.add(c.terminBis);
      return true;
    });
    let accepted: typeof candidates = termine;
    if (this.storyDeduper && normal.length > 0) {
      const r = await this.storyDeduper.filterCandidates(normal, blocked.filter(b => !b.terminAt));
      accepted = [...termine, ...r.accepted];
    } else {
      accepted = [...termine, ...normal.filter(c => !isNearDuplicateTitle(c.title, blocked.filter(b => !b.terminAt).map(b => b.title)))];
    }

    let created = 0;
    const createdTitles: string[] = [];
    // v1130 — Stoff-Anreicherung für Konferenz-Stories (Opt-in je Lead-Kanal,
    // config.stoff_enrich): GoogleNews-Themen liefern nur Schlagzeilen (Ø 82
    // Zeichen — Realfall LokalKraft 19.07.), das Substanz-Gate machte damit
    // aus JEDEM Website-Artikel eine Kurzmeldung. Gleiche Mechanik wie im
    // Eilmeldungs-Pfad (v1100), nur dass die Quelle rückwärts über
    // Titel-Ähnlichkeit gefunden wird (die Konferenz kennt keine URLs).
    let enrichFetches = 0;
    let enrichPool: Array<{ title: string; url: string }> | null = null;
    const getEnrichPool = async (): Promise<Array<{ title: string; url: string }>> => {
      if (enrichPool) return enrichPool;
      enrichPool = [];
      if (this.interestsRepo) {
        for (const tid of unionTopicIds) {
          try {
            for (const it of await this.interestsRepo.listItems(tid, { limit: 30 })) {
              if (typeof it.url === 'string' && it.url.trim()) enrichPool.push({ title: it.title, url: it.url });
            }
          } catch { /* einzelnes Topic überspringen */ }
        }
      }
      return enrichPool;
    };
    for (const cand of accepted.sort((a, b) => b.importance - a.importance)) {
      // Lead zuerst rendern — Follower brauchen dessen Slot als Untergrenze
      const assigns = cand.kanaele
        .map(k => ({ cap: capacity.get(capKey(String(k.kanal ?? ''))), role: k.rolle === 'lead' ? 'lead' as const : 'follow' as const, offset: typeof k.versatz_h === 'number' ? Math.max(0, Math.min(72, k.versatz_h)) : 0 }))
        .filter(a => a.cap !== undefined);
      // v1044 — verworfene Zuweisungen (LLM-Kanalname passt zu keinem Kanal)
      // sichtbar machen: vorher verschwanden sie ohne jede Spur
      if (assigns.length < cand.kanaele.length) {
        const unknown = cand.kanaele.map(k => String(k.kanal ?? '')).filter(n => !capacity.has(capKey(n)));
        this.logger.warn({ family, story: cand.title, unknown }, 'v1044 Konferenz-Zuweisung an unbekannten Kanal verworfen');
      }
      // v996 — Playbook übersteuert die Konferenz: fester Lead + konfigurierte Versätze
      if (pbLead && assigns.some(a => a.cap!.channel.id === pbLead.id)) {
        for (const a of assigns) a.role = a.cap!.channel.id === pbLead.id ? 'lead' : 'follow';
      }
      for (const a of assigns) {
        if (a.role !== 'follow') continue;
        const off = ContentStudio.playbookOffset(a.cap!.channel, cand.kind);
        if (off !== undefined) a.offset = off;
      }
      assigns.sort((a, b) => (a.role === 'lead' ? -1 : 1) - (b.role === 'lead' ? -1 : 1));

      // v997 — Haltbarkeit: verderbliche Story (news/recap) nur, wenn der LEAD
      // innerhalb der Shelf-Life landen kann — sonst Evergreen-Swap; auch das
      // nicht → Story GAR NICHT produzieren (kein LLM-/Bild-Budget verbrennen).
      const leadCap = assigns[0]?.cap;
      const leadShelf = leadCap ? ContentStudio.shelfLifeHours(cand.kind, leadCap.channel) : undefined;
      const deadline = leadShelf !== undefined ? new Date(Date.now() + leadShelf * 3_600_000).toISOString() : undefined;
      if (deadline && leadCap && (leadCap.channel.mode === 'approve' || leadCap.channel.mode === 'autonomous')
        && (leadCap.slotPool.length === 0 || leadCap.slotPool[0] > deadline)) {
        // v1116 — Rettungskette statt Sofort-Drop: erst Verdrängung (auch
        // nicht-verderbliche Vorausplanung weicht), dann Ad-hoc-Extra-Slot
        // im Tagesbudget. Nur wenn beides scheitert, fällt die Story weg.
        const freed = await this.swapWithEvergreen(leadCap.channel, deadline, leadCap.slotPool);
        const rescue = freed ?? await this.adhocSlotForPerishable(leadCap.channel, deadline);
        if (rescue) {
          if (!freed) this.logger.info({ family, title: cand.title, kind: cand.kind, slot: rescue }, 'v1116 ad-hoc lead slot (Raster voll, keine Verdrängung möglich)');
          leadCap.slotPool.unshift(rescue); // vorne einreihen — der Lead nimmt ihn per shift()
          // v1116 — der Rettungs-Slot IST Kapazität: bei vollem Raster steht
          // needed auf 0 und die Zuweisungsschleife hätte den Lead sonst als
          // „Kapazität erschöpft" übersprungen (der Follower lief dann allein
          // in den Sofort-Slot-Zweig).
          leadCap.needed = Math.max(leadCap.needed, leadCap.created + 1);
        } else {
          this.logger.info({ family, title: cand.title, kind: cand.kind }, 'v997 perishable story dropped (kein Lead-Slot innerhalb der Haltbarkeit)');
          continue;
        }
      }

      // v1130 — dünnen Konferenz-Stoff mit dem Artikel-Volltext der passendsten
      // Quelle anreichern (nur wenn der Lead-Kanal es per stoff_enrich will;
      // max. 4 Fetches je Lauf; scheitert der Fetch, bleibt die ehrliche
      // Kurzmeldung des Substanz-Gates — nie schlechter als bisher).
      const enrichLead = assigns.find(a => a.role === 'lead')?.cap?.channel;
      // v1132 — Deckel 4→8 + lauter Übersprung: die Konferenz erzeugt gern
      // 6+ Stories, die fünfte fiel STUMM auf die Kurzmeldung zurück
      // (Realfall 19.07.: „Solarparks fledermausfreundlich" 223 Zeichen).
      const enrichWanted = enrichLead?.config.stoff_enrich === true && !cand.terminBis
        && (cand.body.trim().length < 300 || hatPromoBoilerplate(cand.body));
      if (enrichWanted && enrichFetches >= 8) {
        this.logger.info({ family, story: cand.title.slice(0, 60), enrichFetches }, 'v1132 stoff-anreicherung: Abruf-Deckel erreicht — Kurzmeldung bleibt');
      }
      if (enrichWanted && enrichFetches < 8) {
        // v1131 — Embedding-Rückfall + Observability: der reine Token-Match
        // verfehlte umformulierte Konferenz-Titel („Urbane PV-Potenziale" vs.
        // Quell-Schlagzeile), und Fehlschläge waren im Log unsichtbar.
        const quelle = await this.findStoffQuelle(`${cand.title} ${cand.body}`, await getEnrichPool());
        if (!quelle) {
          this.logger.info({ family, story: cand.title.slice(0, 60) }, 'v1131 stoff-anreicherung: keine passende Quelle im Themen-Pool — Kurzmeldung bleibt');
        } else {
          enrichFetches++;
          const text = await this.articleFetch(quelle.url);
          if (text) {
            cand.body = `${cand.body.trim()}\n\nQUELLTEXT (${quelle.title}):\n${text}`.slice(0, 2300);
            this.logger.info({ family, story: cand.title.slice(0, 60), quelle: quelle.title.slice(0, 60), chars: text.length }, 'v1130 Konferenz-Stoff per Artikel-Volltext angereichert');
          } else {
            this.logger.info({ family, story: cand.title.slice(0, 60), quelle: quelle.url.slice(0, 90) }, 'v1131 stoff-anreicherung: Volltext-Abruf leer (Paywall/WAF/Timeout) — Kurzmeldung bleibt');
          }
        }
      }
      const story = await this.socialRepo.createStory(this.ownerUserId, {
        family, kind: cand.kind, title: cand.title, summary: cand.body,
        importance: cand.importance, terminBis: cand.terminBis, source: 'studio',
      });
      await this.storyDeduper?.embedStory(story.id, { title: story.title, body: story.summary });
      let leadSlot: string | undefined;
      let leadChannelName: string | undefined;
      let leadHasDepth: boolean | undefined; // v1121 — Follower versprechen nur Tiefe, die der Lead hat
      let leadImagePathShared: string | undefined; // v1122 — Basis-Bild des Leads für image_share_story
      // v1022 — Mixed-Mode-Familie: ist der Lead-Kanal suggest, gibt es keinen
      // Lead-Slot — Follower dürfen dann NICHT auf den nächstbesten Slot
      // vorziehen (sie verweisen auf einen Lead-Artikel, der noch nicht live
      // ist). Sie bleiben Entwurf ohne Slot und werden nach der Lead-Freigabe
      // terminiert (replan/Umterminieren).
      const leadIsSuggest = assigns[0]?.role === 'lead' && assigns[0].cap!.channel.mode === 'suggest';
      const createdBeforeStory = created; // v1044 — leere Stories erkennen (s. unten)
      for (const a of assigns) {
        const cap = a.cap!;
        if (cand.kind !== 'termin' && cap.created >= cap.needed) continue; // Kapazität erschöpft (Termine haben Vorrang)
        // v1045 — Haltbarkeit je KANAL (config shelf_life_hours des jeweiligen
        // Kanals): vorher galt die Lead-Deadline auch für alle Follower
        const myShelf = ContentStudio.shelfLifeHours(cand.kind, cap.channel);
        const myDeadline = myShelf !== undefined ? new Date(Date.now() + myShelf * 3_600_000).toISOString() : undefined;
        // Slot: Termin → vor Anpfiff; Lead → nächster freier; Follower → ≥ Lead + Versatz
        // v997 — Slot-Wahl VOR dem Rendern: verderbliche Follower ohne Slot in
        // der Haltbarkeit werden ausgelassen statt als alternder Entwurf angelegt.
        let slot: string | undefined;
        let awaitingLead = false; // v1044 — slotlos WEIL der suggest-Lead noch nicht live ist
        if (cap.channel.mode === 'approve' || cap.channel.mode === 'autonomous') {
          if (story.terminBis) {
            slot = this.pickTerminSlot(cap.slotPool, story.terminBis, cap.channel, this.adhocTaken(cap.channel.id));
          } else if (a.role !== 'lead' && !leadSlot && leadIsSuggest) {
            slot = undefined; // Entwurf ohne Slot — Lead (suggest) ist noch nicht live
            awaitingLead = true;
          } else if (a.role === 'lead' || !leadSlot) {
            // v1102 — Evergreen-Tagesdeckel: Füller nehmen nur Slots an Tagen
            // mit freier Evergreen-Kapazität (kein Tag frei → nicht produziert)
            slot = cand.kind === 'evergreen'
              ? this.pickEvergreenSlot(cap.channel, cap.slotPool, cap.planned, cap.egDays)
              : cap.slotPool.shift();
          } else {
            const target = new Date(Date.parse(leadSlot) + a.offset * 3_600_000).toISOString();
            if (cand.kind === 'evergreen') {
              slot = this.pickEvergreenSlot(cap.channel, cap.slotPool, cap.planned, cap.egDays, target);
            } else {
              const idx = cap.slotPool.findIndex(s => s >= target && (!myDeadline || s <= myDeadline));
              if (idx >= 0) slot = cap.slotPool.splice(idx, 1)[0];
              else if (myDeadline) slot = await this.swapWithEvergreen(cap.channel, myDeadline, cap.slotPool, target);
            }
          }
          if (myDeadline && slot && slot > myDeadline) {
            // Lead-Slot doch außerhalb (Pool war leer nach Swap-Versuch) → zurücklegen und auslassen
            cap.slotPool.unshift(slot);
            cap.slotPool.sort();
            continue;
          }
          // v1044 — wartet der Follower nur auf die Lead-Freigabe (suggest),
          // wird er als slotloser Entwurf ANGELEGT statt still verworfen:
          // vorher fielen verderbliche Follower in Mixed-Mode-Familien komplett aus.
          if (myDeadline && !slot && !awaitingLead) continue; // verderblich ohne Slot → nicht produzieren
        }
        const item = await this.renderAssignment(story, cap.channel, a.role, leadChannelName, leadSlot, leadHasDepth, leadImagePathShared);
        if (!item) {
          if (slot) { cap.slotPool.unshift(slot); cap.slotPool.sort(); } // Slot zurücklegen
          // v1042 — scheitert der LEAD-Text, wird die ganze Story ausgelassen:
          // vorher liefen die Follower ohne leadSlot in den Sofort-Slot-Zweig
          // und gingen live, obwohl der Artikel, auf den sie verweisen, nie
          // entstand (und der Traffic-CTA keine Lead-URL fand).
          if (a.role === 'lead') {
            this.logger.warn({ story: story.title, channel: cap.channel.name }, 'v1042 lead render failed — story ausgelassen');
            break;
          }
          continue;
        }
        if (slot) await this.socialRepo.transition(this.ownerUserId, item.id, 'scheduled', { scheduledAt: slot });
        if (a.role === 'lead') {
          leadSlot = slot; leadChannelName = cap.channel.name; leadHasDepth = leadHatTiefe(item.body);
          leadImagePathShared = item.media.find(m => m.type === 'image' && !m.pathOrUrl.startsWith('http'))?.pathOrUrl;
        }
        await this.socialRepo.createAssignment({ storyId: story.id, channelId: cap.channel.id, role: a.role, offsetHours: a.offset, itemId: item.id });
        cap.created++;
        created++;
        createdTitles.push(`${cap.channel.name}: ${item.title ?? story.title}`);
      }
      // v1044 — Story ohne ein einziges Item (Kapazität erschöpft, Kanalnamen
      // unbekannt, Lead-Render gescheitert): droppen statt aktiv lassen —
      // vorher sperrte die leere Story den Stoff 30 Tage (Titel + Embedding),
      // ohne dass je etwas erschienen wäre.
      if (created === createdBeforeStory) {
        await this.socialRepo.setStoryStatus(this.ownerUserId, story.id, 'dropped').catch(() => { /* best-effort */ });
        this.logger.info({ family, story: story.title }, 'v1044 leere Story gedroppt (kein Item entstanden)');
      }
    }
    if (created > 0) {
      this.logger.info({ family, stories: accepted.length, created }, 'v993 family planned');
    }
    return created;
  }

  /** v1022 — je Kanal vergebene Ad-hoc-Slot-Minuten (Kollisionsschutz für Termin-Slots). */
  private readonly adhocSlotMinutes = new Map<string, Set<string>>();

  private adhocTaken(channelId: string): Set<string> {
    let set = this.adhocSlotMinutes.get(channelId);
    if (!set) { set = new Set(); this.adhocSlotMinutes.set(channelId, set); }
    // v1045 — vergangene Minuten austragen: die Map wuchs im langlebigen
    // Prozess sonst unbegrenzt (schleichender Speicher-Verbrauch)
    const nowMinute = new Date().toISOString().slice(0, 16);
    for (const m of set) if (m < nowMinute) set.delete(m);
    return set;
  }

  /** v993 — Slot vor dem Anpfiff (Raster, sonst Ad-hoc Anpfiff−Vorlauf) — Termin-Logik wie v975/v977. */
  private pickTerminSlot(slotPool: string[], terminBis: string, channel: SocialChannel, taken?: Set<string>): string | undefined {
    const minute = (iso: string) => iso.slice(0, 16);
    const before = slotPool.filter(s => s < terminBis);
    if (before.length > 0) {
      const slot = before[before.length - 1];
      slotPool.splice(slotPool.indexOf(slot), 1);
      taken?.add(minute(slot));
      return slot;
    }
    const leadMs = this.terminLeadHours(channel) * 3_600_000;
    let adhoc = new Date(Math.max(Date.now() + 30 * 60_000, Date.parse(terminBis) - leadMs)).toISOString();
    // v1100 — fensterbewusst: fällt der Ad-hoc-Slot in die Nachtruhe des
    // Kanals UND beginnt das nächste Fenster noch VOR dem Termin, wandert
    // der Slot auf den Fensterbeginn (Realfall 11.07.: 23:53-Slots hingen
    // bis 07:00 als „überfällig"). Nacht-Termine behalten den Nacht-Slot —
    // die Engine bringt sie über die Eilmeldungs-/Termin-Ausnahme raus.
    const win = publishWindowFor(channel);
    if (win && !isWithinWindow(win, new Date(adhoc))) {
      const ws = new Date(adhoc);
      ws.setHours(win.from, 0, 0, 0);
      if (ws.toISOString() <= adhoc) ws.setDate(ws.getDate() + 1);
      if (ws.toISOString() < terminBis) adhoc = ws.toISOString();
    }
    // v1022 — Kollisionsprüfung: nicht auf einem Raster-Slot oder bereits
    // vergebenen Ad-hoc-Slot landen (vorher waren zwei Posts zur selben
    // Minute möglich) — in 10-Minuten-Schritten ausweichen, vor dem Termin bleiben
    while (adhoc < terminBis && (slotPool.some(s => minute(s) === minute(adhoc)) || taken?.has(minute(adhoc)))) {
      adhoc = new Date(Date.parse(adhoc) + 10 * 60_000).toISOString();
    }
    if (adhoc >= terminBis) return undefined;
    taken?.add(minute(adhoc));
    return adhoc;
  }

  /** v993 — einen Beitrag für eine Story-Zuweisung rendern (Kanal-Prompt, Persona, Rolle). */
  private async renderAssignment(
    story: Story, channel: SocialChannel, role: 'lead' | 'follow',
    leadChannelName?: string, leadSlot?: string, leadHasDepth?: boolean,
    leadImagePath?: string,
  ): Promise<ContentItem | null> {
    // v999 — Traffic-Modus: teaser (immer) oder auto (nur verderbliche Arten,
    // wo der Lead-Artikel echte Mehrtiefe hat); Default 'voll' = heutiges Verhalten.
    // v1121 — bei bewusst KURZEM Lead (Substanz-Gate) kein Teaser: das
    // Versprechen „die Pointe steht im Lead-Artikel" wäre gelogen.
    const tm = channel.config.traffic_mode;
    const teaser = role === 'follow' && leadHasDepth !== false
      && (tm === 'teaser' || (tm === 'auto' && (story.kind === 'news' || story.kind === 'recap')));
    // v1046 — Website-/Lead-Artikel als EINE Textwand waren unlesbar (Realfall
    // Public-Viewing-Artikel): Absatz-Struktur ist jetzt Pflicht.
    // v1100 — Substanz-Gate: aus einer nackten Schlagzeile wird KEIN
    // „ausführlicher" Artikel mehr aufgeblasen (Realfall Adams: 3 Absätze
    // Spekulation aus einem Satz Stoff) — dünner Stoff → ehrliche Kurzmeldung.
    // Termin-Ankündigungen sind ausgenommen: ihr Stoff IST der Termin
    // (Was/Wann/Wo-Absatz bleibt Pflicht).
    // v1103 — auch Promo-Boilerplate als Stoff („LIVE bei …") ist dünn
    const thinStoff = !story.terminBis
      && ((story.summary ?? story.title).trim().length < 300 || hatPromoBoilerplate(story.summary));
    const roleRule = role === 'lead'
      ? (thinStoff
        ? `- DEINE ROLLE: LEAD, aber der Stoff ist DÜNN (kaum mehr als die Schlagzeile): Schreibe eine ehrliche KURZMELDUNG — 2-3 Sätze, maximal 2 kurze Absätze. NUR was im Stoff steht. KEINE Füllsätze, KEINE Einordnungs-Floskeln, KEINE Spekulation über Hintergründe, Pläne, Auswirkungen oder Reaktionen.`
        : `- DEINE ROLLE: LEAD — der ausführlichste Beitrag der Familie zu dieser Story (vollwertig, 4-8 Sätze bzw. Persona-gemäß mehr).
- GLIEDERUNG: 2-4 Absätze, getrennt durch LEERZEILEN (\\n\\n im body) — nie eine einzige Textwand.${story.terminBis ? ' Bei Terminen: ein EIGENER kurzer Absatz mit den Fakten (Was, Wann, Wo).' : ''}`)
      // v1121 — ehrlicher Verweis: bei bewusst kurzem Lead (Substanz-Gate)
      // versprechen Follower keinen „ausführlichen" Artikel mehr (Realfall
      // 15.07.: Reels/Posts verwiesen auf den „ausführlichen Bericht", der
      // Lead war eine 3-Satz-Kurzmeldung).
      : `- DEINE ROLLE: FOLLOW — kürzer, eigener Blickwinkel deiner Persona.${leadChannelName ? (leadHasDepth === false
        ? ` Auf ${leadChannelName} ist zu dieser Story bereits live: eine bewusst KURZE Meldung${leadSlot ? ` (seit ${formatLocalDateTime(leadSlot)})` : ''} — du darfst darauf verweisen, aber versprich KEINE Ausführlichkeit: Formulierungen wie „ausführlicher Artikel/Bericht", „alle Details" oder „die ganze Geschichte" sind TABU.`
        : ` Der ausführliche Beitrag auf ${leadChannelName} ist zum Zeitpunkt deiner Veröffentlichung bereits live${leadSlot ? ` (seit ${formatLocalDateTime(leadSlot)})` : ''} — du DARFST darauf verweisen.`) : ''} NIE auf den eigenen Kanal verweisen. Schreibe KEINE URLs in den Text — der Link zum Lead-Artikel wird beim Veröffentlichen automatisch angehängt.${teaser ? '\n- TEASER-MODUS (zwingend): Wecke Neugier, aber verrate NICHT alles — das stärkste Detail, die Pointe oder die Zahlen bleiben im Lead-Artikel. Ende mit einem konkreten Grund weiterzulesen.' : ''}`;
    const prompt = `Du bist Content-Redakteur für den Social-Kanal "${channel.name}" (${channel.platform}).
${channel.persona ? `Persona/Tonalität: ${channel.persona}\n` : ''}
STORY (Redaktionskonferenz-Beschluss — NUR dieser Stoff, Fakten NUR hieraus):
Arbeitstitel: ${story.title}
Stoff: ${story.summary ?? story.title}
Art: ${story.kind}${story.terminBis ? `\nTermin: ${formatLocalDateTime(story.terminBis)} — Ort/Datum/Uhrzeit gehören in den TEXT, terminBis-Feld = ${story.terminBis}` : ''}

Regeln:
${roleRule}
${story.terminBis ? `${TERMIN_PERSPEKTIVE}\n` : ''}${channel.platform === 'instagram' && channel.config.image_carousel === true ? '- KARUSSELL (optional, nur bei Aufzählung/Analyse mit MEHREREN Punkten): 2-4 "slides" mit je einem Bild-Motiv (NUR Motive, kein Text) und "titel" (max. 8 Wörter, kommt deterministisch aufs Bild).\n' : ''}
${this.lessonsBlock(channel)}- Sprache: ${ContentStudio.contentLanguage(channel)}. Konkret, kein Clickbait; eigener TITEL (nicht der Arbeitstitel wortgleich).
- 3-6 Hashtags NUR ins Feld "hashtags"; KEINE Meta-Zeilen im body.
${(story.summary ?? '').includes('QUELLTEXT') ? '- Der QUELLTEXT-Block im Stoff ist Roh-Material der Original-Quelle: Fakten daraus nutzen, in EIGENEN Worten paraphrasieren und einordnen — NIE Sätze wörtlich übernehmen, KEINE Zitate erfinden; das Wort „QUELLTEXT" nie im Beitrag erwähnen.\n' : ''}
${await this.bildRegie(channel)}
- NIE relative Zeitwörter („heute"/„morgen"). Datum/Uhrzeit NUR nennen, wenn sie im Stoff eindeutig als EREIGNIS-Zeit belegt sind — Publikations-/Update-Zeiten der Quelle sind KEINE Ereigniszeiten. Fehlt das Datum: ohne Datum formulieren, NIE eines erfinden oder ergänzen.
- ZEITLICHE EINORDNUNG (v1100): HEUTE ist ${formatLocalDateTime(new Date().toISOString())}.${await this.terminKontext(channel)} Nutze das NUR, um falsche Phasen-Bezüge zu vermeiden (z. B. „kurz vor dem Start" / „in der Vorbereitung", wenn das Ereignis längst läuft oder vorbei ist) — Fakten für den Text stammen weiterhin AUSSCHLIESSLICH aus dem Stoff.
${await this.familienLinie(channel).then(l => l ? `- REDAKTIONSLINIE (verbindlich, vom Herausgeber): ${l}\n` : '')}
- KEINE Spekulation über Folgen, Pläne, Kaderplanungen oder Reaktionen, die nicht wörtlich im Stoff stehen — im Zweifel weglassen.

Antworte NUR mit einem VALIDEN JSON-Array mit GENAU EINEM Objekt (Zitate typografisch „…“ oder escaped):
[{"title": "…", "body": "…", "hashtags": ["…"], "warum": "1 Satz", "bildidee": "optional", "terminBis": ${story.terminBis ? `"${story.terminBis}", "ort": "Ort exakt aus dem Stoff", "einlass": "NUR wenn im Stoff belegt, z.B. 19:30"` : 'null'}${channel.platform === 'instagram' && channel.config.image_carousel === true ? ', "slides": [{"motiv": "…", "titel": "…"}]' : ''}}]`;
    const response = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 6_000, tier: this.modelTier(channel), reasoningEffort: 'low' });
    const ideas = parseIdeas(response.content ?? '');
    if (ideas.length === 0) {
      this.logger.warn({ channel: channel.name, story: story.title, head: (response.content ?? '').slice(0, 160) }, 'v993 assignment render unparseable');
      return null;
    }
    const idea = ideas[0];
    // v1131 — Website-Leads: 1000-Zeichen-Textwände ohne Umbruch deterministisch
    // gliedern (die Prompt-Pflicht aus v1046 allein reichte nicht)
    if (role === 'lead' && channel.platform === 'rest') idea.body = ensureAbsaetze(idea.body);
    // v1043 — der STORY-Termin ist autoritativ, nicht das LLM-Echo: echot das
    // Modell terminBis nicht mit, bekäme das Bild sonst weder Termin-Vorlage
    // noch Termin-Karte, obwohl das Item (mergePerformance unten) ein Termin ist.
    if (story.terminBis) idea.terminBis = story.terminBis;
    // v1122 — Story-Bild-Teilen: Follower kennen das Basis-Bild des Leads
    if (role === 'follow' && leadImagePath) idea.leadImagePath = leadImagePath;
    const media = await this.maybeGenerateImage(channel, idea);
    const item = await this.socialRepo.createItem(this.ownerUserId, channel.id, {
      status: 'draft',
      title: idea.title || undefined,
      body: idea.body,
      hashtags: idea.hashtags,
      media,
      source: 'studio',
      storyId: story.id,
    });
    await this.socialRepo.mergePerformance(this.ownerUserId, item.id, {
      warum: idea.warum, storyRole: role,
      ...(story.terminBis ? { terminBis: story.terminBis } : {}),
      // v997 — Story-Art fürs Plan-Review und die Evergreen-Verdrängung
      art: story.kind,
      // v1003 — Termin-Felder (für die Bild-Karte)
      ...(idea.ort ? { ort: idea.ort } : {}),
      ...(idea.einlass ? { einlass: idea.einlass } : {}),
    });
    if (!story.terminBis) await this.storyDeduper?.embedStory(item.id, { title: idea.title, body: idea.body });
    // v1096 — Nur-Video-Kanäle (YouTube) mit auto_video: Konferenz-/News-Desk-
    // und Ad-hoc-Story-Beiträge sofort fertig rendern, damit der Entwurf MIT
    // Video in der Freigabe liegt (Realfall 11.07.: Story-Zuweisungen an
    // YouTube scheiterten am Slot mit „Kein Video am Item" — der v1085-Hook
    // deckte nur Studio-Konzepte). Das Publish-Sicherheitsnetz (Skill) fängt
    // zusätzlich alle übrigen Pfade.
    const itemMedia = item.media ?? [];
    if (channel.platform === 'youtube' && channel.config.auto_video === true && this.videoRenderer && itemMedia.some(m => m.type === 'image')) {
      const fmt = channel.config.auto_video_format === '9:16' ? '9:16' as const : '16:9' as const;
      void this.videoRenderer(item.id, fmt).catch(err =>
        this.logger.warn({ item: item.id, err: (err as Error).message }, 'v1096 assignment video render failed (Publish-Netz greift)'));
    }
    return item;
  }

  /** Füllt einen Kanal bis zum Planungshorizont. */
  async fillChannel(channel: SocialChannel): Promise<number> {
    await this.ensureTopic(channel);

    const now = new Date().toISOString();
    const planned = await this.socialRepo.listItems(this.ownerUserId, {
      channelId: channel.id, status: ['scheduled', 'approved', 'draft', 'idea'], limit: 100,
    });
    // v971 — Kapazität am Planungshorizont statt hartem 10er-Deckel: der alte
    // Deckel ließ bei 9 offenen Items genau 1 neues zu, egal wie viele Slots
    // konfiguriert waren (Realfall: 11 Slots/Woche → „1 neuer Entwurf").
    // MAX_IN_FLIGHT bleibt als Schutz für LLM-/Bild-Budget.
    const MAX_IN_FLIGHT = 30;
    const egDays = new Map<string, number>(); // v1102 — Evergreen-Slots dieses Laufs (Tagesdeckel)
    const slots = await this.trimSlotsToDailyBudget(channel, nextFreeSlots(channel, planned, Math.max(0, MAX_IN_FLIGHT - planned.length), now), planned);
    // Entwürfe/Ideen ohne Termin zählen als Vorrat — nicht doppelt erzeugen
    const backlog = planned.filter(i => (i.status === 'draft' || i.status === 'idea') && !i.scheduledAt).length;
    const needed = Math.max(0, slots.length - backlog);
    // v977 — Termine haben Vorrang vor der Kapazität: ein voller Kanal
    // (needed=0) generierte gar nicht — Ankündigungen für morgige Spiele
    // hatten nie eine Chance (Realfall 04.07.). Der MAX_IN_FLIGHT-Deckel
    // bleibt als Budget-Schutz bestehen.
    const upcoming = await this.upcomingEvents(channel);
    if (needed === 0 && upcoming.length === 0) return 0;
    if (planned.length >= MAX_IN_FLIGHT) return 0;

    const family = await this.familyContext(channel);
    // v973 — VOLLSTÄNDIGE Story-Sperrliste (DB-bewiesene Lücken geschlossen):
    // planned (wie bisher) + PUBLISHED des eigenen Kanals (60 Tage — vorher nur
    // Prompt-Appell: „WM-Aus…" wurde wortgleich ZWEIMAL veröffentlicht) +
    // REJECTED (21 Tage — Ablehnung sperrt die STORY, nicht nur den Wortlaut;
    // vorher wurde derselbe Arnautovic-Titel 4× wörtlich neu erzeugt) +
    // Geschwister-Beiträge der Familie.
    const publishedWindow = new Date(Date.now() - 60 * 24 * 3_600_000).toISOString();
    const rejectedWindow = new Date(Date.now() - 21 * 24 * 3_600_000).toISOString();
    const [ownPublished, ownRejected] = await Promise.all([
      this.socialRepo.listItems(this.ownerUserId, { channelId: channel.id, status: 'published', updatedSince: publishedWindow, limit: 200 }),
      this.socialRepo.listItems(this.ownerUserId, { channelId: channel.id, status: 'rejected', updatedSince: rejectedWindow, limit: 200 }),
    ]);
    // v975 — eigene Termin-Ankündigungen tragen ihr terminAt (performance.
    // terminBis) mit: sie sperren NUR denselben Termin, nicht den Text
    // (Ort/Format teilen sich alle Ankündigungen).
    const asBlocked = (i: ContentItem): BlockedStory => {
      const t = i.performance?.terminBis;
      return { id: i.id, title: i.title ?? i.body.slice(0, 60), body: i.body, terminAt: typeof t === 'string' ? t : undefined };
    };
    const blocked: BlockedStory[] = [
      ...planned.map(asBlocked),
      ...ownPublished.map(asBlocked),
      ...ownRejected.map(asBlocked),
      ...family.siblingStories,
    ];

    const isYoutube = channel.platform === 'youtube';
    let created = 0;
    const createdTitles: string[] = [];
    const slotPool = [...slots];
    // v977 — Termin-Vorrang: bei vollem Kanal (needed=0) läuft ein reiner
    // Termin-Durchlauf für noch unangekündigte, kommende Termine.
    const announcedNow = new Set(blocked.map(b => b.terminAt).filter(Boolean));
    const unannounced = upcoming.filter(e => !announcedNow.has(e.at));
    const terminOnly = needed === 0;
    const target = terminOnly ? Math.min(unannounced.length, 4) : needed;
    if (target === 0) return 0;
    // v977 — Veröffentlichungsfenster für den Prompt: das LLM kennt sonst das
    // Erscheinungsdatum nicht und schreibt „heute Nacht" für ein Spiel, dessen
    // Post zwei Tage später erscheint (Realfall Argentinien 04./05.07.).
    // v971 — in BATCHES generieren (LLM liefert je Aufruf max. ~10 brauchbare
    // Ideen): weitere Runden bis der Bedarf gedeckt ist oder keine neuen,
    // dedup-überlebenden Ideen mehr kommen.
    for (let round = 0; round < 4 && created < target; round++) {
      // v1045 — Fenster JE RUNDE neu aus dem (schrumpfenden) Slot-Pool: das
      // eingefrorene Fenster nannte in Runde 2-4 Zeiträume, die längst weg waren
      const window = slotPool.length > 0 ? { from: slotPool[0], to: slotPool[slotPool.length - 1] } : undefined;
      const batchSize = Math.min(8, target - created);
      const ideas = await this.generateIdeas(channel, batchSize, family.block, blocked, upcoming, window);
      // v978 — ein leerer/unparsebarer Batch beendet den Lauf NICHT mehr
      // (vorher: erster kaputter Batch → Kanal blieb komplett leer); die
      // nächste Runde ist ein frischer LLM-Wurf.
      if (ideas.length === 0) continue;

      // v973 — Token-Gate + semantisches Gate (Embeddings/Judge) in einem:
      // Paraphrasen derselben Story („geringfügig anders geschrieben") werden
      // jetzt auch gefangen, nicht nur nah-wortgleiche Titel.
      // v975 — Termin-Ankündigungen laufen an beiden Gates VORBEI: ihre
      // Identität ist der Termin selbst (exaktes terminBis), der Text teilt
      // sich Ort/Format mit jeder anderen Ankündigung.
      const candidates = ideas.map(i => ({ ...i, title: i.title || i.body.slice(0, 60) }));
      const announcedAt = new Set(blocked.map(b => b.terminAt).filter((t): t is string => !!t));
      const terminCands: GeneratedIdea[] = [];
      for (const c of candidates) {
        if (!c.terminBis || announcedAt.has(c.terminBis)) continue; // Termin schon angekündigt (oder im Batch doppelt)
        announcedAt.add(c.terminBis);
        terminCands.push(c);
      }
      const normalCands = candidates.filter(c => !c.terminBis);
      const normalBlocked = blocked.filter(b => !b.terminAt);
      let accepted: GeneratedIdea[];
      if (this.storyDeduper) {
        const result = await this.storyDeduper.filterCandidates(normalCands, normalBlocked);
        accepted = result.accepted;
        if (result.droppedToken + result.droppedSemantic > 0) {
          this.logger.info({ channel: channel.name, droppedToken: result.droppedToken, droppedSemantic: result.droppedSemantic }, 'v973 duplicate ideas dropped');
        }
      } else {
        // Fallback ohne Deduper: reines Token-Gate (v957-Verhalten)
        accepted = [];
        for (const idea of normalCands) {
          if (isNearDuplicateTitle(idea.title, [...normalBlocked.map(b => b.title), ...accepted.map(a => a.title!)])) continue;
          accepted.push(idea);
        }
      }
      // Termine zuerst: sie sind an feste Slots vor dem Anpfiff gebunden.
      // Im Termin-Durchlauf (voller Kanal) werden NUR Termine angelegt.
      accepted = terminOnly ? terminCands : [...terminCands, ...accepted];
      this.logger.info({ channel: channel.name, round, ideas: ideas.length, termine: terminCands.length, akzeptiert: accepted.length, created }, 'v978 studio round');
      if (accepted.length === 0) break; // nur noch Duplikate → Thema erschöpft

      for (const idea of accepted) {
        if (created >= target) break;
        // v1111 — Evergreen-Gate (wie Konferenz): K.-o.-Bezug ist nie zeitlos
        if (idea.art === 'evergreen' && istKoEreignisBezug(`${idea.title ?? ''} ${idea.body}`)) {
          this.logger.info({ channel: channel.name, title: idea.title }, 'v1111 evergreen mit K.-o.-Bezug → vorschau umgestuft');
          idea.art = 'vorschau';
        }
        // v975 — Slot-Wahl VOR dem Anlegen: eine Termin-Ankündigung braucht
        // einen Slot VOR dem Anpfiff (den spätesten davor — nah am Termin).
        // v977 — gibt das Raster keinen her, schlägt der Termin das Raster:
        // Ad-hoc-Slot max(jetzt+30min, Anpfiff − Vorlauf). Erst wenn selbst
        // das nach dem Anpfiff läge, wird verworfen — und der Termin für die
        // restlichen Runden gesperrt (vorher wurde dieselbe unplatzierbare
        // Idee jede Runde neu generiert und verbrannte Batch-Kapazität).
        let slot: string | undefined;
        if (channel.mode === 'approve' || channel.mode === 'autonomous') {
          if (idea.terminBis) {
            // v1022 — Slot-Wahl inkl. Kollisionsprüfung zentral über pickTerminSlot
            const hadGridSlot = slotPool.some(s => s < idea.terminBis!);
            slot = this.pickTerminSlot(slotPool, idea.terminBis, channel, this.adhocTaken(channel.id));
            if (slot && !hadGridSlot) {
              this.logger.info({ channel: channel.name, termin: idea.terminBis, slot }, 'v977 termin ad-hoc slot (Raster hatte keinen Platz vor dem Anpfiff)');
            }
            if (!slot) {
              this.logger.info({ channel: channel.name, termin: idea.terminBis, title: idea.title }, 'v975 termin idea dropped (kein Slot vor dem Termin möglich)');
              blocked.push({ title: idea.title || idea.body.slice(0, 60), terminAt: idea.terminBis });
              continue;
            }
          } else {
            // v997 — Haltbarkeit: news/recap brauchen einen Slot innerhalb der
            // Shelf-Life (Realfall 05.07.: Achtelfinal-Recaps landeten am Ende
            // der vollen Queue — Slot 17./18.07., zwei Wochen nach dem Spiel).
            // Kein früher Slot frei → Evergreen-Swap; auch das nicht → Idee
            // verwerfen BEVOR Bild-Budget verbrannt wird.
            const shelf = ContentStudio.shelfLifeHours(idea.art, channel);
            if (shelf !== undefined) {
              const deadline = new Date(Date.now() + shelf * 3_600_000).toISOString();
              if (slotPool.length > 0 && slotPool[0] <= deadline) {
                slot = slotPool.shift();
              } else {
                // v1116 — Rettungskette wie in der Konferenz: Verdrängung → Ad-hoc-Slot → Drop
                slot = await this.swapWithEvergreen(channel, deadline, slotPool);
                if (!slot) {
                  slot = await this.adhocSlotForPerishable(channel, deadline);
                  if (slot) this.logger.info({ channel: channel.name, title: idea.title, art: idea.art, slot }, 'v1116 ad-hoc slot (Raster voll, keine Verdrängung möglich)');
                }
                if (!slot) {
                  this.logger.info({ channel: channel.name, title: idea.title, art: idea.art, shelf }, 'v997 perishable idea dropped (kein Slot innerhalb der Haltbarkeit)');
                  continue;
                }
              }
            } else {
              // v1102 — hier landen nur noch Evergreens (artlose Ideen haben
              // seit dem 7-Tage-Default eine Shelf-Life): Tagesdeckel anwenden
              slot = idea.art === 'evergreen'
                ? this.pickEvergreenSlot(channel, slotPool, planned, egDays)
                : slotPool.shift();
              if (idea.art === 'evergreen' && !slot) {
                this.logger.info({ channel: channel.name, title: idea.title }, 'v1102 evergreen idea dropped (Tagesdeckel — kein Tag mit freier Evergreen-Kapazität)');
                continue;
              }
            }
          }
        }
        const media = await this.maybeGenerateImage(channel, idea);
        const item = await this.socialRepo.createItem(this.ownerUserId, channel.id, {
          status: 'draft',
          title: idea.title || undefined,
          body: idea.body,
          hashtags: idea.hashtags,
          media,
          source: 'studio',
        });
        await this.socialRepo.mergePerformance(this.ownerUserId, item.id, {
          warum: idea.warum,
          ...(idea.terminBis ? { terminBis: idea.terminBis } : {}),
          // v997 — Story-Art fürs Plan-Review und die Evergreen-Verdrängung
          ...(idea.art ? { art: idea.art } : {}),
          // v1003 — Termin-Felder (für die Bild-Karte, auch bei regenerate_image)
          ...(idea.ort ? { ort: idea.ort } : {}),
          ...(idea.einlass ? { einlass: idea.einlass } : {}),
        });
        // v973 — Embedding des neuen Items persistieren (künftige Läufe lesen
        // es); Termin-Posts nicht — sie nehmen an den Gates nicht teil.
        if (!idea.terminBis) await this.storyDeduper?.embedStory(item.id, { title: idea.title, body: idea.body });
        // v1085 — YouTube-Eigenproduktion (Opt-in auto_video): Konzept mit
        // Bild → Video sofort rendern, damit der Entwurf FERTIG in der
        // Freigabe-Queue liegt (Skript = Voiceover, Kanal-Stimme, Musik-Bett;
        // render_video wacht über video_budget_per_month). Fire-and-forget —
        // ohne Video bleibt es ein Konzept, das render_video manuell nachholt.
        if (isYoutube && channel.config.auto_video === true && this.videoRenderer && media.some(m => m.type === 'image')) {
          const fmt = channel.config.auto_video_format === '9:16' ? '9:16' as const : '16:9' as const;
          void this.videoRenderer(item.id, fmt).catch(err =>
            this.logger.warn({ item: item.id, err: (err as Error).message }, 'v1085 auto_video render failed (Konzept bleibt ohne Video)'));
        }
        if (slot) await this.socialRepo.transition(this.ownerUserId, item.id, 'scheduled', { scheduledAt: slot });
        blocked.push({ id: item.id, title: idea.title || idea.body.slice(0, 60), body: idea.body, terminAt: idea.terminBis });
        createdTitles.push(idea.title || idea.body.slice(0, 60));
        created++;
      }
    }
    if (created === 0) return 0;

    // suggest-Modus: EIN stiller Sammel-Insight statt aktivem Nachfragen
    if (created > 0 && channel.mode === 'suggest' && this.insightsRepo) {
      await this.insightsRepo.upsertCandidate(this.ownerUserId, {
        category: 'social',
        title: `${created} Content-Vorschläge für ${channel.name}`,
        body: `Das Content-Studio hat Entwürfe vorbereitet${isYoutube ? ' (Video-Konzepte mit Script)' : ''}:\n${createdTitles.map(t => `• ${t}`).join('\n')}\n\nAnsehen/terminieren per Chat (social list_content) oder UI.`,
        confidence: 0.6,
        sourceData: { router: true, urgency: 'low', channelId: channel.id, storedAt: new Date().toISOString() },
        dedupeKey: `social-studio:${channel.id}:${now.slice(0, 10)}`,
      }).catch(() => { /* non-critical */ });
    }
    return created;
  }

  /**
   * v959 — Bestehende GEPLANTE (nicht freigegebene) Beiträge eines Kanals in
   * die aktuellen Slots umplanen — für „Slots geändert, Bestand nachziehen".
   * Reihenfolge bleibt erhalten; approved/published werden nicht angefasst.
   */
  async replanChannel(channel: SocialChannel): Promise<number> {
    const scheduled = (await this.socialRepo.listItems(this.ownerUserId, {
      channelId: channel.id, status: 'scheduled', limit: 100,
    })).sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''));
    if (scheduled.length === 0) return 0;
    const taken = await this.socialRepo.listItems(this.ownerUserId, {
      channelId: channel.id, status: ['approved', 'published'], limit: 100,
    });
    const slots = nextFreeSlots(channel, taken, scheduled.length, new Date().toISOString());
    let moved = 0;
    for (let i = 0; i < scheduled.length && i < slots.length; i++) {
      if (scheduled[i].scheduledAt === slots[i]) continue;
      if (await this.socialRepo.reschedule(this.ownerUserId, scheduled[i].id, slots[i])) moved++;
    }
    this.logger.info({ channel: channel.name, moved, of: scheduled.length }, 'v959 channel replanned');
    return moved;
  }

  /**
   * v962 — Bild für ein AD-HOC-Item erzeugen („Poste X auf …" via add_content/
   * crosspost): gleiche Leitplanken wie Studio-Posts (Bildnisrecht-Policy,
   * Vision-Gate, Monats-Budget). Liefert [] wenn generate_images aus ist,
   * das Budget erschöpft ist oder das Bild die Prüfung nicht besteht.
   */
  async generateImageForItem(channel: SocialChannel, item: { title?: string; body: string; bildidee?: string; performance?: Record<string, unknown> }): Promise<Array<{ type: 'image'; source: 'generated'; pathOrUrl: string }>> {
    // v991 — optionaler User-Hinweis („beide Flaggen zeigen") wird zur Bildidee
    // v1003 — Termin-Felder aus der Performance, damit die Bild-Karte auch bei regenerate_image entsteht
    const p = item.performance ?? {};
    return this.maybeGenerateImage(channel, {
      title: item.title ?? '', body: item.body, hashtags: [], warum: '', bildidee: item.bildidee,
      terminBis: typeof p.terminBis === 'string' ? p.terminBis : undefined,
      // v1073 — art mitgeben: nur echte Termin-Posts bekommen Karte/Vorlage
      art: (['news', 'vorschau', 'recap', 'termin', 'evergreen'] as const).find(k => k === p.art),
      ort: ContentStudio.cleanTerminField(p.ort, 120),
      einlass: ContentStudio.cleanTerminField(p.einlass, 40),
    });
  }

  // ── Wissens-Kontext + Ideen ───────────────────────────────────────────

  private async generateIdeas(
    channel: SocialChannel, count: number, familyBlock: string, blocked: BlockedStory[],
    events: UpcomingEvent[] = [], window?: { from: string; to: string },
  ): Promise<GeneratedIdea[]> {
    const [dossier, bestPerformers] = await Promise.all([
      this.topicDossier(channel, blocked, events),
      this.bestPerformers(channel),
    ]);
    // v973 — Prompt-Sperrliste = die KOMPLETTE Blockliste (vorher nur 15
    // published — bei 20 Posts/Tag deckte das keinen Tag ab). Dedupliziert,
    // Cap 60 gegen Token-Aufblähung; das harte Gate bleibt ohnehin in Code.
    const blockedTitles = [...new Set(blocked.map(b => b.title))].slice(0, 60);

    const isYoutube = channel.platform === 'youtube';
    // v1074 — Bild-Regie (Art-Director-Anweisung + Anti-Wiederholungs-Liste)
    const bildRegie = isYoutube ? undefined : await this.bildRegie(channel);
    // v1102 — Redaktionslinie (Wochenfokus-Memo der Familie) fließt verbindlich ein
    const linie = await this.familienLinie(channel);
    const linieBlock = linie ? `\nREDAKTIONSLINIE (verbindlich, vom Herausgeber — Inhalte und Gewichtung daran ausrichten): ${linie}\n` : '';
    const prompt = (isYoutube
      ? this.buildYoutubePrompt(channel, count, dossier, bestPerformers, blockedTitles)
      : this.buildPostPrompt(channel, count, dossier, bestPerformers, blockedTitles, window, bildRegie))
      + linieBlock + familyBlock;

    // v980 — 12000 statt 3000 maxTokens: Gen-5-Modelle (Sonnet) denken adaptiv
    // MIT ins Output-Budget und schreiben längere Artikel — bei 3000 war die
    // Antwort abgeschnitten (kein schließendes ]) oder bestand NUR aus
    // Thinking (leerer Text). Live bewiesen: 8 Sonnet-Calls exakt bei 3000.
    // v981 — reasoningEffort 'low': schaltet bei Gen-5-Modellen das adaptive
    // Thinking ab (Sonnet verbrannte sonst das GESAMTE Token-Budget mit
    // Denken und lieferte null Text — 4 leere Runden am IG-Kanal, live).
    const response = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 12_000, tier: this.modelTier(channel), reasoningEffort: 'low' });
    const content = response.content ?? '';
    const ideas = parseIdeas(content);
    // v978 — Beobachtbarkeit: ein unparsebarer Batch war bisher UNSICHTBAR
    // (stiller Abbruch, „Horizont bereits gefüllt") — Realfall 04.07.
    // v980 — auch bei LEEREM Content loggen (Thinking fraß das ganze Budget).
    if (ideas.length === 0) {
      this.logger.warn({ channel: channel.name, contentLength: content.length, head: content.slice(0, 200) }, 'v978 LLM-Batch unparseable/leer — Runde übersprungen');
    }
    return ideas;
  }

  /**
   * v990 — mediaDir-Bereinigung (täglich vom Kern): generierte Bilder älter
   * als 30 Tage löschen, sofern KEIN content_item sie mehr referenziert
   * (published-Bilder liegen zu dem Zeitpunkt längst auf den Plattformen bzw.
   * in der Medienbibliothek). Läuft je Node lokal — kein HA-Slot nötig.
   */
  async cleanupMediaDir(maxAgeDays = 30): Promise<number> {
    if (!this.mediaDir) return 0;
    let removed = 0;
    try {
      const { readdir, stat, unlink } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const cutoff = Date.now() - maxAgeDays * 24 * 3_600_000;
      // v1005 — Bibliotheks-Bilder (asset-*) leben nach eigener Uhr: raus erst,
      // wenn sie 3× so lange wie der Aufbewahrungs-Horizont UNGENUTZT sind.
      const assetCutoffMs = Date.now() - maxAgeDays * 3 * 24 * 3_600_000;
      const assetCutoff = new Date(assetCutoffMs).toISOString();
      const assets = await this.socialRepo.listMediaAssets(this.ownerUserId, { limit: 1000 }).catch(() => []);
      const dbAssetPaths = new Set(assets.map(a => a.path));
      const templateIds = await this.terminTemplateIds();
      const files = await readdir(this.mediaDir).catch(() => [] as string[]);
      for (const name of files) {
        const full = join(this.mediaDir, name);
        if (name.startsWith('studio-')) {
          try {
            const s = await stat(full);
            if (s.mtimeMs > cutoff) continue;
            if (await this.socialRepo.countItemsReferencingMedia(name) > 0) continue;
            await unlink(full);
            removed++;
          } catch { /* Einzelfehler überspringen */ }
        } else if (name.startsWith('asset-')) {
          // v1043 — VERWAISTE Bibliotheks-Dateien (DB-Zeile weg — z. B. Dedup
          // oder Löschung vom anderen Node) wurden nie bereinigt und ließen
          // die Disk schleichend volllaufen.
          if (dbAssetPaths.has(full)) continue;
          try {
            const s = await stat(full);
            if (s.mtimeMs > assetCutoffMs) continue;
            await unlink(full);
            removed++;
          } catch { /* Einzelfehler überspringen */ }
        }
      }
      for (const asset of assets) {
        // v1041 — gepinnte Assets (Stamm-Bilder, Termin-Vorlagen) altern nie raus
        if (asset.pinned) continue;
        // v1043 — als Termin-Vorlage referenzierte Assets sind löschgeschützt
        if (templateIds.has(asset.id)) continue;
        if (asset.lastUsedAt >= assetCutoff) continue;
        try {
          // v1043 — HA: die Datei kann auf dem ANDEREN Node liegen (geteilte
          // PG-DB, getrennte Dateisysteme). Nur löschen, was LOKAL existiert —
          // vorher entfernte node-b die DB-Zeile, während node-a's Datei blieb.
          const s = await stat(asset.path).catch(() => undefined);
          if (!s) continue;
          await unlink(asset.path).catch(() => { /* Datei ggf. schon weg */ });
          await this.socialRepo.deleteMediaAsset(this.ownerUserId, asset.id);
          removed++;
        } catch { /* Einzelfehler überspringen */ }
      }
      if (removed > 0) this.logger.info({ removed, maxAgeDays }, 'v990 mediaDir cleaned');
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'v990 mediaDir cleanup failed');
    }
    return removed;
  }

  /** v1043 — Asset-IDs, die irgendein Kanal als Termin-Vorlage referenziert (löschgeschützt wie gepinnt). */
  private async terminTemplateIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    const channels = await this.socialRepo.listChannels(this.ownerUserId).catch(() => [] as SocialChannel[]);
    for (const c of channels) {
      const ov = (c.config.image_overlay && typeof c.config.image_overlay === 'object' ? c.config.image_overlay : {}) as Record<string, unknown>;
      if (typeof ov.termin_image === 'string' && ov.termin_image.trim()) ids.add(ov.termin_image.trim());
    }
    return ids;
  }

  /** v977 — konfigurierbarer Ankündigungs-Vorlauf (config.termin_lead_hours, Default 3h, Cap 48h). */
  private terminLeadHours(channel: SocialChannel): number {
    const raw = Number(channel.config.termin_lead_hours);
    return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 48) : 3;
  }

  /**
   * v979 — Modell-Tier für die Content-Erzeugung je Kanal (config.model_tier):
   * 'fast' (Default, unverändert) | 'medium' (hochwertige Serienproduktion,
   * z.B. Sonnet für Redaktionstexte) | 'default' | 'strong'. Unbekannte Werte
   * fallen auf 'fast'; ein nicht konfiguriertes medium-Tier routet der
   * ModelRouter ohnehin auf default.
   */
  private modelTier(channel: SocialChannel): 'fast' | 'medium' | 'default' | 'strong' {
    const raw = channel.config.model_tier;
    return raw === 'medium' || raw === 'default' || raw === 'strong' ? raw : 'fast';
  }

  /**
   * v954 — Kanal-Familien-Koordination: Geschwister-Kanäle derselben Familie
   * (gleiches Projekt oder config.family) werden mit Rolle und deren
   * geplanten/kürzlichen Titeln in den Prompt gegeben — der Kanal spielt
   * seine ROLLE statt denselben Stoff zu doppeln; Cross-Verweise erwünscht,
   * bewusstes Verteilen läuft weiter über crosspost.
   */
  private async familyContext(channel: SocialChannel): Promise<{ block: string; siblingStories: BlockedStory[] }> {
    const family = ContentStudio.familyKey(channel);
    if (!family) return { block: '', siblingStories: [] };
    try {
      const siblings = (await this.socialRepo.listChannels(this.ownerUserId))
        .filter(c => c.id !== channel.id && c.status !== 'archived' && ContentStudio.familyKey(c) === family);
      if (siblings.length === 0) return { block: '', siblingStories: [] };
      const sections: string[] = [];
      const siblingStories: BlockedStory[] = [];
      // v973 — Gate-Liste mit Zeitfenster statt Limit 15 (bei 20 Posts/Tag
      // deckte 15 keinen Tag ab); der Prompt-Block bleibt bei 15 Titeln.
      const siblingWindow = new Date(Date.now() - 60 * 24 * 3_600_000).toISOString();
      for (const sibling of siblings) {
        const allItems = await this.socialRepo.listItems(this.ownerUserId, {
          channelId: sibling.id, status: ['scheduled', 'approved', 'published'], updatedSince: siblingWindow, limit: 150,
        });
        // v975 — Termin-Ankündigungen der Geschwister sperren hier NICHTS:
        // jeder Kanal darf (und soll) denselben Termin selbst ankündigen.
        const items = allItems.filter(i => typeof i.performance?.terminBis !== 'string');
        siblingStories.push(...items.map(i => ({ id: i.id, title: i.title ?? i.body.slice(0, 60), body: i.body })));
        const titles = items.map(i => (i.title ?? i.body.slice(0, 60))).slice(0, 15);
        sections.push(`- **${sibling.name}** (${sibling.platform})${sibling.persona ? ` — Rolle: ${sibling.persona.slice(0, 140)}` : ''}${titles.length ? `\n  Geplant/zuletzt dort: ${titles.join(' · ')}` : ''}`);
      }
      const block = `\n\n## Kanal-Familie (abgestimmte Arbeitsteilung)
Dieser Kanal gehört zu einer Familie. Die Geschwister-Kanäle:
${sections.join('\n')}

REGELN für die Abstimmung:
- KEINE inhaltliche Doppelung (zwingend): Themen, die oben bei einem Geschwister-Kanal geplant/veröffentlicht sind, hier NICHT nochmal bringen — wähle stattdessen ANDERE Dossier-Themen. Ausnahme nur mit KLAR anderem Blickwinkel UND komplett anderem Titel (nie denselben/ähnlichen Titel). Im Zweifel: anderes Thema.
- Spiele die ROLLE dieses Kanals (siehe Persona) — was die Geschwister besser abdecken, denen überlassen.
- QUERVERWEISE NUR AUF EXISTIERENDES (zwingend): Auf einen Geschwister-Beitrag darfst du NUR verweisen, wenn er OBEN in dessen Liste („Geplant/zuletzt dort") tatsächlich steht — dann benenne ihn so wie gelistet. NIEMALS Inhalte versprechen, die dort nicht stehen. Hat ein Geschwister-Kanal keine passenden Beiträge, dann KEIN Verweis — der Post muss für sich allein stehen.
- NIE auf den EIGENEN Kanal verweisen („mehr dazu auf ${channel.name}" ist verboten — der Leser IST schon dort).
- Cross-Promo auf dauerhafte ANGEBOTE/Features der Geschwister (z.B. Sammelalbum-Tracker, Tauschbörse) ist ok — die existieren unabhängig von einzelnen Beiträgen. Dosiert einsetzen, nicht in jedem Post.`;
      return { block, siblingStories };
    } catch { return { block: '', siblingStories: [] }; }
  }

  private buildPostPrompt(channel: SocialChannel, count: number, dossier: string, best: string, recent: string[], window?: { from: string; to: string }, bildRegie?: string): string {
    // v975 — Termin-Ankündigungen: nur anweisen, wenn das Dossier Termine führt
    const terminRule = dossier.includes('KOMMENDE TERMINE')
      ? `- TERMIN-ANKÜNDIGUNGEN (Vorrang): Erzeuge für die Einträge unter „KOMMENDE TERMINE" Ankündigungs-Posts — MIT Ort, Datum und Uhrzeit exakt aus der Termin-Zeile (nichts erfinden, den Ort IMMER nennen). Übernimm die ISO-Zeit aus [terminBis: …] UNVERÄNDERT ins Feld "terminBis". Setze zusätzlich "ort" (exakt aus der Termin-Zeile) und "einlass" (NUR wenn eine Einlass-Zeit in der Quelle steht, sonst weglassen). Ort/Datum/Uhrzeit gehören in den BODY-TEXT — niemals in die "bildidee".\n${TERMIN_PERSPEKTIVE}\n`
      : '';
    // v1008 — Karussell-Regel nur für Instagram-Kanäle mit Opt-in
    const carouselRule = channel.platform === 'instagram' && channel.config.image_carousel === true
      ? '- KARUSSELL (optional, nur wenn der Inhalt eine Aufzählung/Analyse mit MEHREREN klaren Punkten ist): gib 2-4 "slides" an — je Slide ein Bild-Motiv (Regeln wie bildidee: NUR Motive, kein Text) und ein "titel" (max. 8 Wörter; wird deterministisch aufs Bild gelegt). Einfache Meldungen bekommen KEIN Karussell.\n'
      : '';
    // v977 — das LLM kennt sonst das Erscheinungsdatum nicht und schreibt
    // „heute Nacht" für ein Spiel, dessen Post zwei Tage später erscheint
    const windowLine = window
      ? `\nVERÖFFENTLICHUNGSZEITRAUM: Diese Posts erscheinen zwischen ${formatLocalDateTime(window.from)} und ${formatLocalDateTime(window.to)} — formuliere so, dass der Text zu JEDEM Zeitpunkt in diesem Fenster stimmt.\n`
      : '';
    return `Du bist Content-Redakteur für den Social-Kanal "${channel.name}" (${channel.platform}).
${channel.persona ? `Persona/Tonalität: ${channel.persona}\n` : ''}${dossier ? `\nAktuelles Themen-Dossier:\n${dossier}\n` : ''}${windowLine}${best ? `\nWas zuletzt gut funktioniert hat:\n${best}\n` : ''}${recent.length ? `\nBEREITS BEHANDELT — dieser STOFF ist gesperrt (auch umformuliert/mit anderem Titel VERBOTEN; wähle ANDERE Ereignisse/Geschichten):\n${recent.map(t => `- ${t}`).join('\n')}\n` : ''}
Erzeuge ${count} veröffentlichungsfertige Posts. Regeln:
- FAKTEN-TREUE (zwingend): Turnier-/Event-Namen, Jahreszahlen, Ergebnisse und Personalien NUR aus dem Dossier oben übernehmen — NIEMALS aus dem Trainingswissen raten. Steht im Dossier „WM", schreibe WM (nicht EM/EURO); auch in Hashtags. Ist ein Fakt nicht im Dossier belegt, lass ihn weg.
- ZEITBEZUG (zwingend): Ist der Post eine VORSCHAU/Ankündigung auf ein datiertes Ereignis (Spiel, Termin, Deadline), setze "terminBis" auf den ISO-Zeitpunkt des Ereignisses — der Post wird dann garantiert VOR dem Ereignis veröffentlicht. NIE relative Zeitwörter („heute", „morgen", „heute Nacht"). Datum/Uhrzeit im Text NUR, wenn sie im Stoff eindeutig als EREIGNIS-Zeit belegt sind — Publikations-/Update-Zeiten der Quelle sind KEINE Ereigniszeiten; fehlt das Datum, ohne Datum formulieren und NIE eines erfinden. Rückblicke auf Vergangenes brauchen KEIN "terminBis".
${terminRule}${this.lessonsBlock(channel)}- Sprache: ${ContentStudio.contentLanguage(channel)}. Zur Persona passend, konkret statt generisch, kein Clickbait.
- body = VOLLWERTIGER Beitrag mit 4-8 Sätzen und eigenem Mehrwert (Einordnung, Details, Kontext) — NIEMALS nur Schlagzeile plus ein Satz. Dossier-Beiträge sind Rohstoff, kein Abschreibmaterial.
- ABWECHSLUNG BEIM SCHLUSS (zwingend): HÖCHSTENS jeder dritte Post endet mit einer Frage/Aufforderung an die Community — die anderen enden mit einem Fakt, einer Einordnung oder einem Ausblick. Identische Endungen über viele Posts wirken wie Spam.
- Jeder Post eigenständig; Bezug zu aktuellen Dossier-Themen wo sinnvoll.
- 3-6 Hashtags je Post — AUSSCHLIESSLICH ins Feld "hashtags", NIEMALS in den body (weder am Ende noch als eigene Zeile; sie werden beim Posten automatisch angehängt).
- body = NUR der fertige Post-Text. KEINE Meta-Zeilen wie "Bildidee:", Regieanweisungen oder Platzhalter — ein Bildvorschlag gehört ausschließlich ins separate Feld "bildidee".
${bildRegie ?? '- BILDIDEE ohne Text: "bildidee" beschreibt NUR Motive (Szenen, Objekte, Stimmung) — NIEMALS Datum, Uhrzeit, Zahlen, Schriftzüge oder Text-Overlays (Bildmodelle schreiben Text FALSCH; Fakten gehören in den body).\n'}- "art" (zwingend): news = tagesaktuelle Meldung (verdirbt in ~2 Tagen) | recap = Nachbericht zu einem Ereignis (verdirbt in ~3 Tagen) | vorschau = Blick auf ein kommendes Ereignis | termin = Termin-Ankündigung | evergreen = zeitlos (Hintergrund, Community-Frage, Geschichte) — NIEMALS bei Bezug auf konkrete Turnier-Runden/Spiele (Halbfinale, Finale etc.): das ist vorschau oder news. Sei ehrlich — verderbliche Posts werden früh eingeplant oder verworfen.
${carouselRule}${channel.blacklist.length ? `- TABU (niemals erwähnen): ${channel.blacklist.join(', ')}\n` : ''}
Antworte NUR mit einem VALIDEN JSON-Array (Zitate in Texten typografisch „…“ oder mit \\" escapen — nie nackte " im String):
[{"title": "kurzer Titel", "body": "der Post-Text", "hashtags": ["…"], "warum": "1 Satz warum jetzt", "art": "news|vorschau|recap|termin|evergreen", "bildidee": "optional: Bildvorschlag für dieses Posting", "terminBis": "NUR bei Termin-Ankündigung/Vorschau: ISO-Zeitpunkt des Ereignisses", "ort": "NUR bei Terminen: Ort exakt aus der Termin-Zeile", "einlass": "NUR bei Terminen und NUR wenn belegt, z.B. 19:30"${carouselRule ? ', "slides": [{"motiv": "Bild-Motiv ohne Text", "titel": "kurzer Slide-Titel"}]' : ''}}]`;
  }

  private buildYoutubePrompt(channel: SocialChannel, count: number, dossier: string, best: string, recent: string[]): string {
    return `Du planst Videos für den YouTube-Kanal "${channel.name}".
${channel.persona ? `Persona/Stil: ${channel.persona}\n` : ''}${dossier ? `\nAktuelles Themen-Dossier:\n${dossier}\n` : ''}${best ? `\nWas zuletzt gut funktioniert hat:\n${best}\n` : ''}${recent.length ? `\nBEREITS BEHANDELT — dieser STOFF ist gesperrt (auch umformuliert/mit anderem Titel VERBOTEN; wähle ANDERE Ereignisse/Geschichten):\n${recent.map(t => `- ${t}`).join('\n')}\n` : ''}
Erzeuge ${count} komplette Video-Konzepte. Das body-Feld MUSS enthalten:
HOOK (erste 15 Sekunden), dann SCRIPT mit Kapitel-Überschriften und Sprechtext,
dann eine Zeile "---" und darunter BESCHREIBUNG (YouTube-Description mit Kapitelmarken).
Der User kann das Video selbst drehen (Script ablesen) oder Alfred Material geben.
FAKTEN-TREUE (zwingend): Turnier-/Event-Namen, Jahreszahlen und Fakten NUR aus dem Dossier — niemals aus dem Trainingswissen raten (WM bleibt WM, nicht EM); auch in Tags.
${this.lessonsBlock(channel)}Ein Thumbnail-Vorschlag gehört NICHT in den body, sondern ins separate Feld "bildidee". Hashtags AUSSCHLIESSLICH ins Feld "hashtags", niemals in den body.
${channel.blacklist.length ? `TABU: ${channel.blacklist.join(', ')}\n` : ''}
Antworte NUR mit einem JSON-Array:
[{"title": "Video-Titel (max 100 Zeichen)", "body": "HOOK…\\nSCRIPT…\\n---\\nBESCHREIBUNG…", "hashtags": ["tag1", "tag2"], "warum": "1 Satz warum dieses Video jetzt", "bildidee": "optional: Thumbnail-Vorschlag"}]`;
  }

  /**
   * v1074 — Bild-Regie: Art-Director-Anweisung für die Bildidee (Hauptmotiv,
   * Perspektive, Licht, Farbwelt) + Anti-Wiederholungs-Liste aus den zuletzt
   * genutzten Bibliotheks-Motiven. Abschaltbar je Kanal
   * (config.image_art_director: false → alte Ein-Satz-Anweisung).
   */
  private async bildRegie(channel: SocialChannel): Promise<string> {
    const base = '- BILDIDEE ohne Text: "bildidee" beschreibt NUR Motive (Szenen, Objekte, Stimmung) — NIEMALS Datum, Uhrzeit, Zahlen, Schriftzüge oder Text-Overlays (Bildmodelle schreiben Text FALSCH; Fakten gehören in den body).\n';
    if (channel.config.generate_images !== true || channel.config.image_art_director === false) return base;
    let avoid = '';
    try {
      const family = ContentStudio.familyKey(channel);
      const assets = await this.socialRepo.listMediaAssets(this.ownerUserId, { ...(family ? { family } : { channelId: channel.id }), limit: 200 });
      const recent = assets
        .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
        .slice(0, 8)
        .map(a => a.motif.replace(/\s+/g, ' ').slice(0, 90));
      if (recent.length >= 3) {
        avoid = `- NICHT SCHON WIEDER — diese Bildmotive liefen zuletzt (wähle sichtbar ANDERE Schauplätze/Objekte/Perspektiven):\n${recent.map(m => `  · ${m}`).join('\n')}\n`;
      }
    } catch { /* best-effort — Regie funktioniert auch ohne Liste */ }
    return '- BILDIDEE (Bild-Regie, wie ein Art-Director): 2-4 Sätze KONKRET — Hauptmotiv, Bildaufbau/Perspektive (Nahaufnahme/Weitwinkel/Boden- oder Vogelperspektive), Licht & Stimmung (Flutlicht, Dämmerung, Regen …) und Farbwelt. NUR Szenen/Objekte/Stimmung — NIEMALS Datum, Uhrzeit, Zahlen, Schriftzüge oder Text-Overlays (Fakten gehören in den body). Der Schauplatz soll zur GESCHICHTE des Posts passen — nicht reflexhaft Stadion/Ball.\n' + avoid;
  }

  /**
   * v1073 — Termin-Feld (ort/einlass) säubern: LLM-Platzhalter wie „—", „-",
   * „n/a", „unbekannt" verwerfen statt sie in die Termin-Karte einzubrennen.
   */
  static cleanTerminField(raw: unknown, maxLen: number): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const v = raw.trim();
    if (!v || /^[—–\-.\s]+$/.test(v) || /^(n\/?a|tbd|unbekannt|unknown|keine? angabe)$/i.test(v)) return undefined;
    return v.slice(0, maxLen);
  }

  /**
   * v954 — Familien-Schlüssel eines Kanals: Projekt-Bindung oder explizites
   * config.family (für Familien ohne Projekt, z.B. „games"). null = solo.
   */
  static familyKey(channel: Pick<SocialChannel, 'projectId' | 'config'>): string | null {
    if (typeof channel.config.family === 'string' && channel.config.family.trim()) return `family:${channel.config.family.trim().toLowerCase()}`;
    if (channel.projectId) return `project:${channel.projectId}`;
    return null;
  }

  /**
   * v996 — Playbook: fester Lead-Kanal der Familie (config.family_role='lead');
   * Fallback wie bisher: die eigene Plattform (rest), sonst der erste Kanal.
   */
  static resolveLead(members: SocialChannel[]): SocialChannel {
    return members.find(c => c.config.family_role === 'lead')
      ?? members.find(c => c.platform === 'rest')
      ?? members[0];
  }

  /**
   * v1115 — Heute-Zeile für Prompts (Wochentag + Datum + Uhrzeit, Server-Lokalzeit).
   * Bewusst OHNE Intl/toLocaleDateString — ICU ist auf small-icu-Builds beim
   * Kaltstart nicht verlässlich (v1101-Lektion im Skill, gleiches Muster).
   */
  static heuteZeile(now = new Date()): string {
    const tage = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
    const p = (n: number) => String(n).padStart(2, '0');
    return `${tage[now.getDay()]}, ${p(now.getDate())}.${p(now.getMonth() + 1)}.${now.getFullYear()}, ${p(now.getHours())}:${p(now.getMinutes())} Uhr`;
  }

  /**
   * v997 — Haltbarkeit je Story-Art: news 48h, recap 72h (config.shelf_life_hours
   * übersteuert je Art). termin/vorschau laufen über terminBis, evergreen ist
   * unbegrenzt — beides liefert undefined (= keine Deadline).
   */
  static shelfLifeHours(art: string | undefined, channel: Pick<SocialChannel, 'config'>): number | undefined {
    // v1034 — auch 'vorschau' ist verderblich: eine Vorschau OHNE terminBis
    // (Konferenz-Lücke) bekam sonst irgendeinen späten Slot — Realfall 06.07.:
    // Viertelfinal-Doppelpack für den 7.7. wurde auf den 13.7. terminiert.
    if (art === 'evergreen' || art === 'termin') return undefined; // bewusst unbegrenzt (Termin-Ablauf regelt Schritt 1)
    const cfg = channel.config.shelf_life_hours;
    const cfgVal = (key: string): number | undefined => {
      if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
        const v = (cfg as Record<string, unknown>)[key];
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
      }
      return undefined;
    };
    if (art !== 'news' && art !== 'recap' && art !== 'vorschau') {
      // v1102 — Items OHNE Art-Marker hatten GAR KEINE Haltbarkeit: ein
      // Beitrag vom 03.07. stand am 12.07. noch eingeplant (Realfall Glasner).
      // Default 7 Tage, per shelf_life_hours.default übersteuerbar.
      return cfgVal('default') ?? 168;
    }
    return cfgVal(art) ?? (art === 'news' ? 48 : 72);
  }

  /**
   * v997 — Verdrängung: ein Item, das einen Slot innerhalb der Deadline
   * belegt, weicht auf den spätesten freien Slot des Pools — sein früher
   * Slot wird für den verderblichen Inhalt frei (Status bleibt, reine
   * Terminverschiebung). Gibt den freigewordenen Slot zurück.
   * v1116 — nicht mehr nur Evergreens: auch andere Beiträge weichen, wenn
   * ihre eigene Haltbarkeit den späten Slot noch deckt (artlose Features,
   * frische Recaps). Am 13.07. fielen 10 News-Stories komplett aus der
   * Planung, weil die nahen Lead-Slots von Vorausplanung belegt waren und
   * nur ein einziges Evergreen als Opfer in Frage kam. Evergreens weichen
   * weiterhin zuerst; Termine und Eilmeldungen weichen NIE.
   */
  private async swapWithEvergreen(
    channel: SocialChannel, deadline: string, slotPool: string[], notBefore?: string,
  ): Promise<string | undefined> {
    if (slotPool.length === 0) return undefined; // kein Tausch-Slot frei
    const earliest = new Date(Date.now() + 30 * 60_000).toISOString();
    const floor = notBefore && notBefore > earliest ? notBefore : earliest;
    const planned = await this.socialRepo.listItems(this.ownerUserId, {
      channelId: channel.id, status: ['scheduled', 'approved'], limit: 100,
    });
    const lateSlot = slotPool[slotPool.length - 1];
    const victim = planned
      .filter(i => i.scheduledAt && i.scheduledAt > floor && i.scheduledAt <= deadline)
      .filter(i => typeof i.performance?.terminBis !== 'string' && i.performance?.breaking !== true)
      .filter(i => {
        const art = typeof i.performance?.art === 'string' ? i.performance.art : undefined;
        if (art === 'evergreen') return true;
        // v1116 — beweglich, wenn die eigene Haltbarkeit den späten Slot noch deckt
        const shelf = ContentStudio.shelfLifeHours(art, channel);
        if (shelf === undefined) return false; // termin o. Ä. ohne Marker — nicht anfassen
        const createdMs = Date.parse(i.createdAt);
        return Number.isFinite(createdMs) && createdMs + shelf * 3_600_000 >= Date.parse(lateSlot);
      })
      .sort((a, b) => {
        const ea = a.performance?.art === 'evergreen' ? 0 : 1;
        const eb = b.performance?.art === 'evergreen' ? 0 : 1;
        return (ea - eb) || a.scheduledAt!.localeCompare(b.scheduledAt!);
      })[0];
    if (!victim) return undefined;
    const freed = victim.scheduledAt!;
    if (!(await this.socialRepo.reschedule(this.ownerUserId, victim.id, lateSlot, ['scheduled', 'approved']))) return undefined;
    slotPool.pop();
    this.logger.info({ channel: channel.name, victim: victim.id, art: victim.performance?.art ?? 'ohne', from: freed, to: lateSlot },
      'v997 slot swap (verderblicher Inhalt braucht den frühen Slot)');
    return freed;
  }

  /**
   * v1116 — Ad-hoc-Slot für verderbliche Stories: ist das Raster innerhalb
   * der Haltbarkeit voll UND keine Verdrängung möglich, wird eine Extra-Zeit
   * eingeschoben statt die Story zu verwerfen (Realfall 13.07.: 10 News-
   * Stories gedroppt → der Tagesplan bestand nur noch aus Evergreen, YouTube
   * und X gingen leer aus). Leitplanken: Tagesbudget (max_posts_per_day,
   * heute inkl. bereits veröffentlichter), 90 min Mindestabstand zu allen
   * geplanten Posts des Kanals, Nachtruhe (newsdesk_quiet, Default 22–6).
   */
  private async adhocSlotForPerishable(channel: SocialChannel, deadline: string, notBefore?: string): Promise<string | undefined> {
    const planned = await this.socialRepo.listItems(this.ownerUserId, {
      channelId: channel.id, status: ['scheduled', 'approved'], limit: 100,
    });
    const taken = planned.map(i => i.scheduledAt ? Date.parse(i.scheduledAt) : NaN).filter(Number.isFinite) as number[];
    const quiet = Array.isArray(channel.config.newsdesk_quiet) && (channel.config.newsdesk_quiet as unknown[]).length === 2
      ? (channel.config.newsdesk_quiet as number[]).map(Number) : [22, 6];
    const inQuiet = (d: Date) => quiet[0] > quiet[1]
      ? (d.getHours() >= quiet[0] || d.getHours() < quiet[1])
      : (d.getHours() >= quiet[0] && d.getHours() < quiet[1]);
    let publishedToday = 0;
    try { publishedToday = await this.socialRepo.countPublishedToday(channel.id); } catch { /* Mini-Repos (Tests) ohne Zähler → 0 */ }
    const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const perDay = new Map<string, number>();
    for (const i of planned) {
      if (!i.scheduledAt) continue;
      const day = localDay(new Date(i.scheduledAt));
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    const today = localDay(new Date());
    const MIN_GAP = 90 * 60_000;
    const start = Math.max(Date.now() + 30 * 60_000, notBefore ? Date.parse(notBefore) : 0);
    const end = Date.parse(deadline);
    for (let t = start; t <= end; t += 30 * 60_000) {
      const d = new Date(t);
      if (inQuiet(d)) continue;
      if (taken.some(x => Math.abs(x - t) < MIN_GAP)) continue;
      const day = localDay(d);
      const used = (perDay.get(day) ?? 0) + (day === today ? publishedToday : 0);
      if (used >= channel.maxPostsPerDay) continue;
      return d.toISOString();
    }
    return undefined;
  }

  /**
   * v1100 — Budget-bewusste Slot-Vergabe: HEUTIGE Slots werden aufs
   * Rest-Tagesbudget gekappt (max_posts_per_day − heute veröffentlicht −
   * heute bereits geplant/freigegeben). Vorher plante das Studio munter
   * 22:31-/23:53-Slots, obwohl der Kanal längst am Limit war — die Engine
   * musste dann jedes Item einzeln auf morgen schieben (Realfall 11.07.).
   * Slots ab morgen bleiben unangetastet; Termin-Ad-hoc-Slots laufen nicht
   * über den Pool und behalten ihren Vorrang (Engine-Override).
   */
  private async trimSlotsToDailyBudget(channel: SocialChannel, slots: string[], planned: ContentItem[]): Promise<string[]> {
    if (slots.length === 0) return slots;
    const dayEnd = new Date(); dayEnd.setHours(24, 0, 0, 0);
    const dayEndIso = dayEnd.toISOString();
    if (!slots.some(s => s < dayEndIso)) return slots; // heute gar nicht betroffen
    let publishedToday = 0;
    try { publishedToday = await this.socialRepo.countPublishedToday(channel.id); } catch { /* Mini-Repos (Tests) ohne Zähler → 0 */ }
    const plannedToday = planned.filter(i => i.scheduledAt && i.scheduledAt < dayEndIso
      && (i.status === 'scheduled' || i.status === 'approved')).length;
    let remaining = Math.max(0, channel.maxPostsPerDay - publishedToday - plannedToday);
    const kept = slots.filter(s => {
      if (s >= dayEndIso) return true;
      if (remaining > 0) { remaining--; return true; }
      return false;
    });
    if (kept.length < slots.length) {
      this.logger.info({ channel: channel.name, dropped: slots.length - kept.length, publishedToday, plannedToday },
        'v1100 heutige Slots aufs Rest-Tagesbudget gekappt');
    }
    return kept;
  }

  /** v1100 — Zeit-Einordnung für den Schreib-Prompt (10 min gecacht je Familie). */
  private readonly terminCtxCache = new Map<string, { at: number; text: string }>();

  /**
   * v1100 — anstehende Termin-Storys der Familie als Einordnungs-Zeile
   * (Realfall Adams: „kurz vor dem Start der WM 2026" mitten im Halbfinale —
   * das Modell kannte weder Datum noch Turnierphase).
   */
  private async terminKontext(channel: SocialChannel): Promise<string> {
    const family = ContentStudio.familyKey(channel) ?? channel.id;
    const cached = this.terminCtxCache.get(family);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.text;
    let text = '';
    try {
      const nowIso = new Date().toISOString();
      const stories = await this.socialRepo.listStories(this.ownerUserId, { family, status: 'active', sinceDays: 14 });
      // v1103 — auch Spiel-VORSCHAUEN mit terminBis zählen zur Zeit-Einordnung
      // (Spiele ohne Public-Viewing-Event haben keine termin-Story)
      const termine = stories
        .filter(s => (s.kind === 'termin' || s.kind === 'vorschau') && typeof s.terminBis === 'string' && s.terminBis > nowIso)
        .sort((a, b) => a.terminBis!.localeCompare(b.terminBis!))
        .slice(0, 4)
        .map(s => `${s.title} (${formatLocalDateTime(s.terminBis!)})`);
      if (termine.length > 0) text = ` Bekannte anstehende Termine: ${termine.join(' · ')}.`;
    } catch { /* Einordnung ist optional */ }
    this.terminCtxCache.set(family, { at: Date.now(), text });
    return text;
  }

  /**
   * v1102 — Redaktionslinie: kurzes Wochenfokus-Memo der Familie
   * (config.redaktionslinie auf irgendeinem Familien-Kanal, per
   * update_channel änderbar). Fließt verbindlich in Konferenz- und
   * Schreib-Prompts und steht im Wochen-Report. 10 min gecacht.
   */
  private readonly linieCache = new Map<string, { at: number; text: string }>();

  static linieOf(channels: Array<Pick<SocialChannel, 'config'>>): string {
    for (const c of channels) {
      const v = c.config.redaktionslinie;
      if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 500);
    }
    return '';
  }

  private async familienLinie(channel: SocialChannel): Promise<string> {
    const own = ContentStudio.linieOf([channel]);
    if (own) return own;
    const family = ContentStudio.familyKey(channel);
    if (!family) return '';
    const cached = this.linieCache.get(family);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.text;
    let text = '';
    try {
      const channels = await this.socialRepo.listChannels(this.ownerUserId, 'active');
      text = ContentStudio.linieOf(channels.filter(c => ContentStudio.familyKey(c) === family));
    } catch { /* Linie ist optional */ }
    this.linieCache.set(family, { at: Date.now(), text });
    return text;
  }

  /** v1102 — Evergreen-Tagesdeckel (config.evergreen_max_per_day, Default 2). */
  private evergreenDayCap(channel: SocialChannel): number {
    const raw = Number(channel.config.evergreen_max_per_day);
    return Number.isFinite(raw) && raw >= 0 ? raw : 2;
  }

  /**
   * v1102 — Slot für ein Evergreen wählen, ohne den Tagesdeckel zu reißen:
   * erster Pool-Slot (optional ≥ notBefore), an dessen LOKALEM Tag noch
   * Evergreen-Kapazität frei ist (bestehende Planung + in diesem Lauf
   * vergebene Slots via takenDays). Kein Tag frei → undefined (Evergreen
   * wird nicht produziert — der Vorrat darf die Aktualität nie dominieren).
   */
  private pickEvergreenSlot(
    channel: SocialChannel, slotPool: string[], planned: ContentItem[],
    takenDays: Map<string, number>, notBefore?: string,
  ): string | undefined {
    const cap = this.evergreenDayCap(channel);
    if (cap === 0) return undefined;
    const dayKey = (iso: string) => {
      const d = new Date(iso);
      return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    };
    const counts = new Map<string, number>(takenDays);
    for (const i of planned) {
      if (!i.scheduledAt || i.performance?.art !== 'evergreen') continue;
      if (i.status !== 'scheduled' && i.status !== 'approved') continue;
      const k = dayKey(i.scheduledAt);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const idx = slotPool.findIndex(s => (!notBefore || s >= notBefore) && (counts.get(dayKey(s)) ?? 0) < cap);
    if (idx < 0) return undefined;
    const slot = slotPool.splice(idx, 1)[0];
    takenDays.set(dayKey(slot), (takenDays.get(dayKey(slot)) ?? 0) + 1);
    return slot;
  }

  /**
   * v1103 — Spielplan aus dem Dossier: Das System kannte Anstoßzeiten nur über
   * den Public-Viewing-Events-Feed — Spiele ohne Event (Realfall Argentinien–
   * Schweiz, Nachtspiel in US-Zeit) hatten weder Vorbericht noch Phasen-
   * Orientierung. Ein fast-LLM-Pass extrahiert EXPLIZIT belegte Anstoßzeiten;
   * die Konferenz plant daraus Vorschauen MIT terminBis (erscheinen garantiert
   * vor dem Anstoß), und der Termin-Kontext der Schreib-Prompts kennt sie.
   */
  private async extractSpielplan(dossier: string): Promise<Array<{ spiel: string; at: string }>> {
    if (!dossier.trim()) return [];
    // Vorab-Filter: ohne Uhrzeit-Muster (Anstoßzeiten wie „21:00", „21.00 Uhr",
    // ISO) steht im Material nichts Extrahierbares — spart den LLM-Call.
    if (!/\b\d{1,2}[:.]\d{2}\b/.test(dossier)) return [];
    try {
      const prompt = `Extrahiere aus dem Material KOMMENDE Fußball-Spiele mit EXPLIZIT genannter Anstoßzeit (Datum UND Uhrzeit müssen im Material stehen — NIEMALS raten oder ergänzen; Spiele ohne belegte Zeit weglassen). Ergebnisse bereits gespielter Partien sind KEINE kommenden Spiele.

MATERIAL:
${dossier.slice(0, 6000)}

Antworte NUR mit einem VALIDEN JSON-Array (leer wenn nichts belegt ist):
[{"spiel": "England – Argentinien (WM-Halbfinale)", "at": "2026-07-15T19:00:00Z"}]`;
      const response = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 800, tier: 'fast', reasoningEffort: 'low' });
      const raw = (extractJsonArray(response.content ?? '') ?? []) as Array<{ spiel?: unknown; at?: unknown }>;
      const nowMs = Date.now();
      const seen = new Set<string>();
      const out: Array<{ spiel: string; at: string }> = [];
      for (const r of raw) {
        if (typeof r.spiel !== 'string' || typeof r.at !== 'string') continue;
        const ms = Date.parse(r.at);
        if (!Number.isFinite(ms) || ms <= nowMs || ms > nowMs + 21 * 24 * 3_600_000) continue;
        const at = new Date(ms).toISOString();
        if (seen.has(at + r.spiel.toLowerCase())) continue;
        seen.add(at + r.spiel.toLowerCase());
        out.push({ spiel: r.spiel.slice(0, 120), at });
        if (out.length >= 8) break;
      }
      return out;
    } catch {
      return []; // Spielplan ist Zusatz-Kontext — nie blockierend
    }
  }

  /**
   * v1103 — Nachmittags-Lauf „Termin-Lücken": Paarungen, die erst tagsüber
   * entstehen (Viertelfinal-Sieger etc.), verpassten die Morgen-Konferenz —
   * der nächste Lauf kam erst NACH einem Nachtspiel. Plant NUR Stories mit
   * terminBis (Termine + Spiel-Vorschauen); gibt es keine offenen, kostet
   * der Lauf keinen Konferenz-LLM-Call.
   */
  async runTerminGaps(): Promise<number> {
    const channels = await this.socialRepo.listChannels(this.ownerUserId, 'active');
    const families = new Map<string, SocialChannel[]>();
    for (const c of channels) {
      const key = ContentStudio.familyKey(c);
      if (key) families.set(key, [...(families.get(key) ?? []), c]);
    }
    let created = 0;
    for (const [family, members] of families) {
      if (members.length < 2) continue;
      try {
        created += await this.planFamily(family, members, { nurTermine: true });
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, family }, 'v1103 termin-gap run failed');
      }
    }
    return created;
  }

  /**
   * v996 — Playbook: konfigurierter Staging-Versatz eines Follower-Kanals.
   * config.family_offset_hours: Zahl (für alle Story-Arten) ODER Objekt je
   * Story-Art mit optionalem default, z.B. {news: 2, vorschau: 4, default: 6}.
   */
  static playbookOffset(channel: Pick<SocialChannel, 'config'>, kind: string): number | undefined {
    const raw = channel.config.family_offset_hours;
    const clamp = (v: number) => Math.max(0, Math.min(72, v));
    if (typeof raw === 'number' && Number.isFinite(raw)) return clamp(raw);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const rec = raw as Record<string, unknown>;
      const v = rec[kind] ?? rec.default;
      if (typeof v === 'number' && Number.isFinite(v)) return clamp(v);
    }
    return undefined;
  }

  /** v951 — alle verknüpften Topic-IDs eines Kanals (topic_ids[] + Legacy topic_id). */
  static linkedTopicIds(channel: Pick<SocialChannel, 'config'>): string[] {
    const ids = new Set<string>();
    if (Array.isArray(channel.config.topic_ids)) {
      for (const id of channel.config.topic_ids) if (typeof id === 'string' && id) ids.add(id);
    }
    if (typeof channel.config.topic_id === 'string' && channel.config.topic_id) ids.add(channel.config.topic_id);
    return [...ids];
  }

  /**
   * v951 — Kanäle können MEHRERE Themen speisen (z.B. „WM 2026" + „Panini-
   * Sammelalbum"): je Topic eine eigene Dossier-Sektion, das LLM verteilt
   * die Posts über alle Themen.
   */
  /**
   * v955 — Kanal-Lektionen: vom User gemeldete Korrekturen (config.lessons[])
   * landen als zwingende Regeln im Prompt — der Kanal LERNT aus Fehlern
   * (Realfall: „EM-Aus" statt „WM-Aus", #EURO2024 statt #WM2026).
   */
  private lessonsBlock(channel: SocialChannel): string {
    const lessons = Array.isArray(channel.config.lessons)
      ? (channel.config.lessons as unknown[]).filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
      : [];
    if (lessons.length === 0) return '';
    return `- KORREKTUREN AUS DER VERGANGENHEIT (zwingend beachten):\n${lessons.slice(-20).map(l => `  • ${l}`).join('\n')}\n`;
  }

  /**
   * v975/v977 — Kommende Termine (Event-Items der verknüpften Themen): nur
   * Zukunft, über Topics hinweg per Titel dedupliziert (derselbe Feed hängt
   * oft an mehreren Themen), zeitlich sortiert. Event-Items laufen NICHT im
   * News-Strom mit — dort verdrängte jeder Collector-Lauf sie aus den Top-8
   * (Realfall Public Viewing), und ihr ORT steckt in der summary.
   */
  private async upcomingEvents(channel: SocialChannel): Promise<UpcomingEvent[]> {
    if (!this.interestsRepo) return [];
    const events = new Map<string, UpcomingEvent>();
    const nowIso = new Date().toISOString();
    for (const topicId of ContentStudio.linkedTopicIds(channel)) {
      try {
        const items = await this.interestsRepo.listItems(topicId, { limit: 30 });
        for (const ev of items.filter(i => i.sourceKind === 'events')) {
          const at = parseEventTime(ev.title);
          if (!at || at <= nowIso) continue; // vorbei oder Zeit nicht lesbar
          if (!events.has(ev.title)) events.set(ev.title, { title: ev.title, summary: ev.summary, at });
        }
      } catch { /* einzelnes Topic überspringen */ }
    }
    return [...events.values()].sort((a, b) => a.at.localeCompare(b.at));
  }

  private async topicDossier(channel: SocialChannel, blocked?: BlockedStory[], events: UpcomingEvent[] = []): Promise<string> {
    if (!this.interestsRepo) return '';
    const topicIds = ContentStudio.linkedTopicIds(channel);
    if (topicIds.length === 0) return '';
    const blockedTitles = blocked?.map(b => b.title) ?? [];
    const sections: string[] = [];
    // v1045 — Cross-Topic-Dedup: derselbe Quell-Artikel hängt oft an mehreren
    // Themen (WM + Transfers) und wurde doppelt gelistet = doppelt gewichtet
    const seenAcrossTopics = new Set<string>();
    for (const topicId of topicIds) {
      try {
        const [topic, digest, items] = await Promise.all([
          this.interestsRepo.getTopicById(this.ownerUserId, topicId),
          this.interestsRepo.getDigest(topicId),
          this.interestsRepo.listItems(topicId, { limit: 30 }),
        ]);
        // v973 — Rohstoff-Hygiene: Dossier-Beiträge, die dieser Kanal (oder die
        // Familie) schon behandelt hat, werden markiert — das LLM greift zu
        // anderem Stoff statt dieselbe Story neu zu erzählen.
        // v986 — die SUMMARY kommt mit ins Dossier: eine nackte Schlagzeile
        // zwang das LLM, Details zu ERFINDEN (Halluzinations-Quelle Nr. 1);
        // mit dem Feed-Auszug hat die Fakten-Treue-Regel echtes Material.
        // v1045 — Wichtigkeit vor reiner Frische: Top-8 nach Radar-importance
        // (Gleichstand: neuere zuerst = stabile listItems-Reihenfolge)
        const itemLines = items
          .filter(i => i.sourceKind !== 'events')
          .map((i, idx) => ({ i, idx }))
          .sort((a, b) => (b.i.importance ?? 0.5) - (a.i.importance ?? 0.5) || a.idx - b.idx)
          .map(x => x.i)
          .filter(i => {
            const key = (i.url && i.url.trim()) || i.title.toLowerCase().trim();
            if (seenAcrossTopics.has(key)) return false;
            seenAcrossTopics.add(key);
            return true;
          })
          .slice(0, 8).map(i => {
          const covered = blockedTitles.length > 0 && isNearDuplicateTitle(i.title, blockedTitles);
          // v1036 — Quellen-Boilerplate strippen, bevor sie ins Dossier gelangt
          const cleanSummary = typeof i.summary === 'string' ? stripSourceBoilerplate(i.summary) : '';
          // v1048 — YouTube-Quellen (verdichtete Transcripts) dürfen mehr
          // Material zeigen: für Spielanalysen reichen 220 Zeichen nicht
          const summary = cleanSummary.trim().length > 0
            ? ` — ${cleanSummary.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, i.sourceKind === 'youtube' ? 400 : 220)}`
            : '';
          return `- ${i.title}${summary}${covered ? ' [BEREITS BEHANDELT — nicht erneut verwenden]' : ''}`;
        }).join('\n');
        const body = `${digest?.summary ?? ''}${itemLines ? `\nNeueste Beiträge:\n${itemLines}` : ''}`.trim();
        if (body) sections.push(topicIds.length > 1 ? `### Thema „${topic?.name ?? topicId.slice(0, 8)}"\n${body}` : body);
      } catch { /* einzelnes Topic überspringen */ }
    }
    // Bereits angekündigte Termine (performance.terminBis) nicht erneut anbieten.
    // Identität = Termin-Zeit; parallele Termine zur selben Zeit teilen sich
    // eine Ankündigung (dann beide in EINEM Post nennen).
    const announced = new Set((blocked ?? []).map(b => b.terminAt).filter(Boolean));
    const upcoming = events.filter(e => !announced.has(e.at)).slice(0, 10);
    if (upcoming.length > 0) {
      sections.push(`### KOMMENDE TERMINE (ankündigen — der Post muss VOR dem Termin erscheinen)\n${upcoming.map(e => `- ${e.title}${e.summary ? ` — Ort: ${e.summary}` : ''} [terminBis: ${e.at}]`).join('\n')}`);
    }
    if (sections.length > 1) {
      sections.push('(Verteile die Posts sinnvoll über ALLE obigen Themen — nicht alles zu einem Thema.)');
    }
    return sections.join('\n\n');
  }

  private async bestPerformers(channel: SocialChannel): Promise<string> {
    try {
      const metrics = await this.socialRepo.listMetrics(channel.id, { limit: 50 });
      const byItem = metrics.filter(m => m.itemId).sort((a, b) => b.value - a.value).slice(0, 3);
      if (byItem.length === 0) return '';
      const lines: string[] = [];
      for (const m of byItem) {
        const item = await this.socialRepo.getItem(this.ownerUserId, m.itemId!);
        if (item) lines.push(`- "${(item.title ?? item.body).slice(0, 70)}" (${m.kind}: ${m.value})`);
      }
      return lines.join('\n');
    } catch { return ''; }
  }

  // ── Bild-Erstellung (Budget-gezählt) ─────────────────────────────────

  private async maybeGenerateImage(channel: SocialChannel, idea: GeneratedIdea): Promise<Array<{ type: 'image'; source: 'generated'; pathOrUrl: string }>> {
    // v1008 — Instagram-Karussell (Opt-in config.image_carousel): 2–4 Slides
    // aus dem Idea-JSON, je Slide eigenes Motiv + deterministischer Titel-
    // Overlay. Budget zählt je Slide-Versuch; ist es erschöpft, endet das
    // Karussell dort (Einzelbild ist besser als nichts).
    const slides = channel.platform === 'instagram' && channel.config.image_carousel === true && Array.isArray(idea.slides)
      ? idea.slides.filter(s => s && typeof s.motiv === 'string' && s.motiv.trim().length > 3).slice(0, 4)
      : [];
    if (slides.length >= 2) {
      const out: Array<{ type: 'image'; source: 'generated'; pathOrUrl: string }> = [];
      for (const slide of slides) {
        const media = await this.produceImage(channel, idea, slide.motiv, slide.titel?.trim() ? slide.titel.trim() : null);
        if (media.length === 0) break;
        out.push(...media);
      }
      if (out.length > 0) {
        this.logger.info({ channel: channel.name, slides: out.length }, 'v1008 carousel images produced');
        return out;
      }
      return [];
    }
    return this.produceImage(channel, idea);
  }

  /**
   * EIN Bild erzeugen (oder aus der Bibliothek wiederverwenden): Budget,
   * Bildnisrecht-Scrubbing, Vision-Gate, Plattform-Crop, Overlays, Ablage.
   * @param motifOverride v1008 — eigenes Motiv (Karussell-Slide) statt idea.bildidee
   * @param forcedTitle v1008 — Overlay-Titel erzwingen (string), nur Branding (null) oder Automatik (undefined)
   */
  private async produceImage(
    channel: SocialChannel, idea: GeneratedIdea,
    motifOverride?: string, forcedTitle?: string | null,
  ): Promise<Array<{ type: 'image'; source: 'generated'; pathOrUrl: string }>> {
    if (channel.config.generate_images !== true) return [];
    // v1122 — Story-Bild teilen (Opt-in image_share_story): Follower übernehmen
    // das Basis-Bild des Leads statt selbst zu generieren (eigene Overlays,
    // kein Budget). Braucht keinen Generator — deshalb VOR dem Registry-Check.
    if (channel.config.image_share_story === true && typeof idea.leadImagePath === 'string' && idea.leadImagePath && this.mediaDir) {
      const shared = await this.tryShareLeadImage(channel, idea, forcedTitle).catch(() => undefined);
      if (shared) return shared;
    }
    if (!this.skillRegistry || !this.skillSandbox) return [];
    const skill = this.skillRegistry.get('image_generate') as Skill | undefined;
    if (!skill) return [];

    // Monats-Budget (Leitplanke 5): channel_metrics kind 'gen_image' je Tag.
    // v1042 — die Prüfung greift erst VOR der Generierung (weiter unten):
    // Termin-Vorlage und Bibliotheks-Reuse kosten nichts und dürfen auch bei
    // erschöpftem Budget liefern (vorher: gar kein Bild trotz Gratis-Pfaden).
    const budget = typeof channel.config.image_budget_per_month === 'number' ? channel.config.image_budget_per_month : 30;
    const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
    const used = (await this.socialRepo.listMetrics(channel.id, { kind: 'gen_image', sinceDate: monthStart }))
      .reduce((sum, m) => sum + m.value, 0);

    try {
      const {
        resolveImagePolicy, extractNameCandidates, scrubMotif, scrubTextDirectives,
        buildSafeImagePrompt, strictRetryPrompt, verifyImagePolicy, resolveSymbolMotif,
      } = await import('./image-policy.js');
      const policy = resolveImagePolicy(channel.config);
      // v1129 — Marken-Symbolmotiv des Kanals (config.image_symbol_motif, sonst
      // neutral): ersetzt die frühere globale Fußball-Konstante in Fallbacks,
      // Vision-Retry und der Symbolik-Zeile des Prompts.
      const symbolMotif = resolveSymbolMotif(channel.config);

      // v941 — die Bildidee des Studios ist der beste Prompt (Fallback: Titel/Body)
      // v1069 — Fallback OHNE „Social-Media-Bild": Nano Banana nahm das
      // wörtlich und malte einen Instagram-UI-Rahmen ums Bild (Testfall 09.07.)
      let motif = motifOverride ?? idea.bildidee ?? `Fotorealistisches Bildmotiv zum Thema: ${idea.title || idea.body.slice(0, 150)}`;
      // v950 Schicht 2 — deterministisch: Personen-Namen aus dem Motiv schrubben
      if (policy === 'symbolic') {
        const names = extractNameCandidates(idea.title, idea.body, idea.bildidee);
        const scrubbedResult = scrubMotif(motif, names, symbolMotif);
        if (scrubbedResult.scrubbed) {
          this.logger.info({ channel: channel.name, names }, 'v950 motif scrubbed (image policy symbolic)');
        }
        motif = scrubbedResult.motif;
      }
      // v982 — Text-/Datums-Direktiven schrubben (BEIDE Policies): Bildmodelle
      // rendern Text falsch — „Datum & Uhrzeit als Overlay" wurde zu „23.04.
      // 21:00" für einen Termin am 04.07. 19:00 (Realfall).
      const textScrub = scrubTextDirectives(motif, symbolMotif);
      if (textScrub.scrubbed) {
        this.logger.info({ channel: channel.name, motif: textScrub.motif }, 'v982 text directives scrubbed');
      }
      motif = textScrub.motif;

      // v1004 — Kanal-Stil (einheitlicher Look je Kanal, übersteuert die Persona
      // im Bild-Prompt), Qualität und Plattform-Format
      const style = typeof channel.config.image_style === 'string' && channel.config.image_style.trim()
        ? channel.config.image_style.trim() : undefined;
      const quality = channel.config.image_quality === 'low' || channel.config.image_quality === 'medium' || channel.config.image_quality === 'high'
        ? channel.config.image_quality : undefined;
      // v1069 — optionales Bild-Modell je Kanal (z.B. gemini-3.1-flash-image =
      // Nano Banana 2, gemini-3-pro-image = Nano Banana Pro); leer = Provider-
      // Default (gpt-image-1). Der Generator routet am Modellnamen.
      const imageModel = typeof channel.config.image_model === 'string' && channel.config.image_model.trim()
        ? channel.config.image_model.trim() : undefined;
      const format = ContentStudio.platformImageSpec(channel);

      // v1074 — Stil-Referenz (Opt-in, nur Gemini-Modelle): gepinnte
      // Stamm-Bilder aus der Bibliothek geben Look/Farbwelt vor — das Motiv
      // bleibt neu. Best-effort: ohne gepinnte Assets läuft alles wie bisher.
      let referenceImages: string[] | undefined;
      if (imageModel && /^gemini-/.test(imageModel) && channel.config.image_style_reference === true) {
        try {
          const family = ContentStudio.familyKey(channel);
          const pinned = (await this.socialRepo.listMediaAssets(this.ownerUserId, { ...(family ? { family } : { channelId: channel.id }), limit: 200 }))
            .filter(a => a.pinned && !a.blocked)
            .sort((a, b) => ((b.format === format.size ? 1 : 0) - (a.format === format.size ? 1 : 0)) || b.lastUsedAt.localeCompare(a.lastUsedAt));
          const { access } = await import('node:fs/promises');
          const picks: string[] = [];
          for (const a of pinned) {
            if (picks.length >= 2) break;
            if (await access(a.path).then(() => true).catch(() => false)) picks.push(a.path);
          }
          if (picks.length > 0) referenceImages = picks;
        } catch { /* best-effort */ }
      }

      // v1041 — Termin-Vorlage: für Termin-Posts nimmt der Kanal ein festes
      // Basis-Bild (config.image_overlay.termin_image = Asset-ID), die Daten
      // (Teams, Anpfiff, Ort) kommen wie immer deterministisch aus der
      // Termin-Karte. Kein Budget, kein Vision-Gate, immer gleicher Look.
      if (forcedTitle === undefined && isTerminAnnouncement(idea) && this.mediaDir) {
        const fromTemplate = await this.tryTerminTemplate(channel, idea, format).catch(() => undefined);
        if (fromTemplate) return fromTemplate;
      }

      // v1005 — Bild-Bibliothek: passt ein vorhandenes Basis-Bild (Motiv ähnlich,
      // gleicher Stil/Format, Cooldown abgelaufen)? → wiederverwenden, nur das
      // Overlay ist neu. Kostet KEIN Bild-Budget.
      if (channel.config.image_reuse !== false && this.mediaDir) {
        const reused = await this.tryReuseAsset(channel, motif, idea, style, format, forcedTitle).catch(() => undefined);
        if (reused) return reused;
      }

      // v1042 — erst ab hier kostet es Geld: Budget-Gate für die Generierung
      if (used >= budget) {
        // v1135 — Budget-Ehrlichkeit: erschöpftes Bild-Budget sichtbar machen
        // (EIN Insight je Kanal+Monat; vorher nur eine pino-Zeile)
        void this.insightsRepo?.upsertCandidate(this.ownerUserId, {
          category: 'social',
          title: `⛽ Bild-Budget erschöpft: ${channel.name}`,
          body: `Das Monats-Budget für generierte Bilder auf **${channel.name}** ist aufgebraucht (${used}/${budget}). Bis Monatsende ${channel.config.image_budget_fallback === true ? 'werden Bibliotheksbilder wiederverwendet (Fallback aktiv)' : 'erscheinen Beiträge OHNE Bild'} — Budget anpassen (image_budget_per_month) oder bewusst so lassen.`,
          confidence: 0.85,
          sourceData: { router: true, urgency: 'high' },
          dedupeKey: `social-budget:${channel.id}:image_budget_per_month:${new Date().toISOString().slice(0, 7)}`,
        }).catch(() => { /* non-critical */ });
        // v1122 — Opt-in Bibliotheks-Fallback (image_budget_fallback): lieber
        // ein passables Bibliotheksbild als gar keines (Realfall 15.07.: ab
        // Monatsmitte erschienen fussball.cc-Artikel nackt). Lax-Suche:
        // Cooldown/Stil ignoriert, niedrigere Ähnlichkeits-Schwelle, notfalls
        // das am längsten nicht genutzte Format-passende Asset.
        if (channel.config.image_budget_fallback === true && this.mediaDir) {
          const rescue = await this.tryReuseAsset(channel, motif, idea, style, format, forcedTitle, { lax: true }).catch(() => undefined);
          if (rescue) {
            this.logger.info({ channel: channel.name, used, budget }, 'v1122 Budget erschöpft — Bibliotheks-Fallback statt ohne Bild');
            return rescue;
          }
        }
        this.logger.info({ channel: channel.name, used, budget }, 'v935 image budget reached — post ohne Bild');
        return [];
      }

      // v950 Schicht 1+3 — bis zu 2 Versuche: normal → Vision-Verstoß → strenges Symbolmotiv
      // v1037 — OHNE image_style kommt ein neutraler VISUELLER Default in den
      // Bild-Prompt, nicht mehr die TEXT-Persona des Kanals (Realfall 07.07.:
      // „200–400 Wörter mit Einordnung; auf Sammelalbum-Tracker verweisen"
      // stand als „Stil" im Bild-Prompt). image_style je Kanal übersteuert (v1004).
      const visualStyle = style ?? DEFAULT_IMAGE_STYLE;
      for (let attempt = 0; attempt < 2; attempt++) {
        // v1038(A) — Retry nach Vision-Verstoß erzeugt das GENERISCHE
        // Symbolmotiv: dafür NIE neu generieren, wenn ein Symbolbild in der
        // Bibliothek liegt (kurze Karenz statt Cooldown) — vorher entstand
        // bei jedem Verstoß ein frisches, fast identisches Stadion-Bild.
        if (attempt === 1 && channel.config.image_reuse !== false && this.mediaDir) {
          const fallbackReuse = await this.tryReuseAsset(channel, symbolMotif, idea, style, format, forcedTitle).catch(() => undefined);
          if (fallbackReuse) return fallbackReuse;
        }
        const prompt = attempt === 0
          ? buildSafeImagePrompt(motif, visualStyle, policy, symbolMotif)
          : strictRetryPrompt(visualStyle, symbolMotif);
        const result = await this.skillSandbox.execute(skill, {
          prompt,
          ...(imageModel ? { model: imageModel } : {}),
          ...(quality ? { quality } : {}),
          ...(format.size ? { size: format.size } : {}),
          ...(referenceImages ? { reference_images: referenceImages } : {}),
        }, { userId: this.ownerUserId, masterUserId: this.ownerUserId, platform: 'api', chatId: 'content-studio' } as never);
        if (!result.success) {
          // v1055 — TIMEOUT-Fehlschläge zählen aufs Budget: die OpenAI-Kosten
          // sind angefallen (das Bild wurde fertig generiert, kam nur zu spät) —
          // v990-Prinzip „jeder Versuch zählt". Andere Fehler (Auth, invalid)
          // kosten nichts und bleiben ungezählt.
          if (/timed out/i.test(result.error ?? '')) {
            await this.socialRepo.incrementMetric(channel.id, { date: new Date().toISOString().slice(0, 10), kind: 'gen_image' }).catch(() => { /* non-critical */ });
            this.logger.warn({ channel: channel.name, error: result.error }, 'v1055 image generation timeout — zählt aufs Budget (Kosten angefallen)');
          }
          return [];
        }
        // v990 — JEDER Generierungs-Versuch zählt aufs Budget (auch wenn das
        // Vision-Gate das Bild gleich verwirft): der OpenAI-Betrag ist dann
        // trotzdem angefallen. Vorher liefen Gate-Retries am Budget vorbei.
        // v1045 — atomar (value = value + 1): das Read-Modify-Write zählte
        // bei nebenläufigen Generierungen zu niedrig.
        await this.socialRepo.incrementMetric(channel.id, { date: new Date().toISOString().slice(0, 10), kind: 'gen_image' });

        // v942 — image_generate liefert das Bild als Buffer-Attachment
        const attachment = (result as { attachments?: Array<{ data?: unknown; fileName?: string; mimeType?: string }> }).attachments?.[0];
        const buffer = attachment?.data && Buffer.isBuffer(attachment.data) ? attachment.data : undefined;
        // v1070 — echten MIME-Type ans Vision-Gate durchreichen: der feste
        // PNG-Default ließ das Gate bei Gemini-JPEGs fail-closed verwerfen
        const attachMime = typeof attachment?.mimeType === 'string' && attachment.mimeType.startsWith('image/')
          ? attachment.mimeType : 'image/png';

        // v1043 — fail-closed OHNE Buffer: liefert der Skill nur eine URL,
        // können weder Vision-Gate (Bildnisrecht!) noch Crop/Overlays laufen —
        // bei symbolic darf so ein Bild NIE raus (Umgehung des v950-Prinzips).
        if (policy === 'symbolic' && !buffer) {
          this.logger.warn({ channel: channel.name }, 'v1043 image ohne Buffer (nur URL) — bei symbolic verworfen (fail-closed)');
          return [];
        }

        // v1040(1a) — der Retry generiert das GENERISCHE Symbolmotiv: genau das
        // gehört in die Bibliothek, nicht das Artikel-Motiv (Realfall 07.07.:
        // neutrale Stadionbilder trugen spezifische Trainer-Beschreibungen und
        // vergifteten das Reuse-Matching).
        let libraryMotif = attempt === 1 ? symbolMotif : motif;

        // v950 Schicht 3 — Vision-Output-Gate (nur symbolic; fail-closed bei Ausfall)
        if (policy === 'symbolic' && buffer) {
          let verdict = await verifyImagePolicy(this.llm, buffer, attachMime);
          if (verdict === null) {
            // v1134 — EIN zweiter PRÜF-Versuch vor fail-closed: transiente
            // Vision-Ausfälle kosteten sonst das fertige (bezahlte) Bild
            // (Realfall 19.07.: Bluesky-Post ging ohne Bild raus). Die
            // Schutzlogik bleibt: fällt auch der Retry aus → kein Bild.
            await new Promise(r => setTimeout(r, this.visionRetryDelayMs));
            verdict = await verifyImagePolicy(this.llm, buffer, attachMime);
            if (verdict !== null) this.logger.info({ channel: channel.name }, 'v1134 vision check im 2. Versuch erfolgreich');
          }
          if (verdict === null) {
            this.logger.warn({ channel: channel.name }, 'v950 vision check unavailable (auch Retry) — Bild verworfen (fail-closed)');
            return [];
          }
          // v982 — auch gerenderter Text/Zahlen ist ein Verstoß (halluzinierte Daten)
          if (verdict.person || verdict.logo || verdict.text) {
            this.logger.info({ channel: channel.name, attempt, verdict }, 'v950 image policy violation — Bild verworfen');
            if (attempt === 0) continue; // ein Retry mit strengem Symbolmotiv
            return []; // zweiter Verstoß → Post ohne Bild
          }
          // v1040(1b) — das Gate hat das Bild ohnehin angesehen: seine
          // Beschreibung dessen, was WIRKLICH zu sehen ist, wird die
          // Bibliotheks-Beschreibung (das Bildmodell weicht vom Prompt ab).
          // Der „Symbolbild"-Marker (kurze Karenz, v1038) bleibt erhalten.
          if (verdict.motiv) {
            const generic = attempt === 1 || ContentStudio.isGenericMotif(motif);
            // v1129 — markenneutraler Marker (vorher „Symbolbild Fußball:")
            libraryMotif = generic && !ContentStudio.isGenericMotif(verdict.motiv)
              ? `Symbolbild: ${verdict.motiv}` : verdict.motiv;
          }
        }

        let url: string | undefined;
        if (buffer && this.mediaDir) {
          // v1004 — Plattform-Zuschnitt (z.B. Instagram Hochformat max. 4:5)
          const framed = format.crop ? await cropToRatio(buffer, format.crop[0], format.crop[1]).catch(() => buffer) : buffer;
          // v1002 — deterministische Text-Overlays (Wasserzeichen, Titel, Termin-
          // Karte) NACH allen Gates: Text kommt nie vom Bildmodell (v982-Lektion).
          const finalBuffer = await this.applyOverlays(framed, channel, idea, forcedTitle).catch(() => framed);
          const { writeFile, mkdir } = await import('node:fs/promises');
          const { join } = await import('node:path');
          await mkdir(this.mediaDir, { recursive: true });
          // v1027 — „-no-title"-Marker im Dateinamen, wenn KEIN Titel und keine
          // Termin-Karte eingebrannt wurde: die Plattform (fussball.cc) rendert
          // Titel dann selbst und erkennt titellose Bilder am Upload-Dateinamen
          const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ContentStudio.overlayBakesTitle(channel, idea, forcedTitle) ? '' : '-no-title'}`;
          const file = join(this.mediaDir, `studio-${stamp}.png`);
          await writeFile(file, finalBuffer);
          // v1005 — sauberes Basis-Bild (vor Overlay) in die Bibliothek legen;
          // die Bibliothek ist best-effort und darf das Bild NIE kosten
          try {
            if (channel.config.image_reuse !== false) {
              const assetFile = join(this.mediaDir, `asset-${stamp}.png`);
              await writeFile(assetFile, framed);
              // v1040 — gespeichert wird, was das Bild WIRKLICH zeigt (Vision-
              // Beschreibung des Gates), nicht der Prompt
              await this.socialRepo.createMediaAsset(this.ownerUserId, {
                channelId: channel.id, family: ContentStudio.familyKey(channel) ?? undefined,
                path: assetFile, motif: libraryMotif, style, format: format.size ?? 'square',
                // v1072 — womit das Bild erzeugt wurde (Bibliothek-Anzeige)
                model: imageModel ?? 'gpt-image-1',
              });
            }
          } catch { /* Bibliothek ist best-effort */ }
          url = file;
        } else {
          const data = result.data as Record<string, unknown> | undefined;
          url = typeof data?.url === 'string' ? data.url
            : typeof data?.path === 'string' ? data.path
            : typeof data?.filePath === 'string' ? data.filePath : undefined;
        }
        if (!url) return [];
        // v990 — Zählung erfolgt oben je Versuch (direkt nach der Generierung)
        return [{ type: 'image', source: 'generated', pathOrUrl: url }];
      }
      return [];
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, channel: channel.name }, 'v935 image generation failed');
      return [];
    }
  }

  /**
   * v1006 — Inhaltssprache eines Kanals (config.language, Default Deutsch) als
   * Anzeigename für Prompts — vorher war „Deutsch" hartkodiert.
   */
  static contentLanguage(channel: Pick<SocialChannel, 'config'>): string {
    return languageName(typeof channel.config.language === 'string' && channel.config.language.trim() ? channel.config.language.trim() : 'de');
  }

  /**
   * v1005 — Motiv-Tokens fürs Ähnlichkeits-Matching (v923-Lektion: auf
   * Nicht-Wortzeichen splitten, kurze Füllwörter raus).
   */
  static motifTokens(text: string): Set<string> {
    return new Set(text.toLowerCase().split(/[^a-zäöüß0-9]+/).filter(t => t.length > 3));
  }

  /** v1038 — generisches Symbolmotiv (Fallback-Bilder u. ä.): darf mit kurzer Karenz wiederverwendet werden. */
  static isGenericMotif(motif: string): boolean {
    return /^symbolbild/i.test(motif.trim());
  }

  /**
   * v1130 — Story→Quellitem-Match über Titel-Token-Überlappung: die Konferenz
   * schreibt eigene Arbeitstitel, behält aber die Entitäten der Quelle
   * (Batteriespeicher, Netzentgelte …). Mindestens 2 gemeinsame Tokens und
   * ≥50 % des kleineren Token-Sets — sonst kein Match (lieber Kurzmeldung
   * als der Volltext eines FALSCHEN Artikels).
   */
  static bestStoffMatch(text: string, pool: Array<{ title: string; url: string }>): { title: string; url: string } | undefined {
    const want = ContentStudio.motifTokens(text);
    if (want.size === 0) return undefined;
    let best: { title: string; url: string } | undefined;
    let bestScore = 0;
    for (const p of pool) {
      const have = ContentStudio.motifTokens(p.title);
      if (have.size === 0) continue;
      const inter = [...have].filter(t => want.has(t)).length;
      if (inter < 2) continue;
      const score = inter / Math.min(want.size, have.size);
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return bestScore >= 0.5 ? best : undefined;
  }

  /**
   * v1131 — Stoff-Quelle finden: erst der strenge Token-Match (bestStoffMatch),
   * dann Embedding-Rückfall — die Konferenz formuliert Titel stark um
   * („Wiener Stadthalle: Urbane PV-Potenziale" vs. Quell-Schlagzeile), dabei
   * verfehlt der Token-Match. Token-Vorfilter (≥1 gemeinsames Token, Top 8)
   * hält die Embedding-Kosten klein; Cosine ≥ 0.72 gegen den Quell-Titel.
   */
  private async findStoffQuelle(text: string, pool: Array<{ title: string; url: string }>): Promise<{ title: string; url: string } | undefined> {
    const strict = ContentStudio.bestStoffMatch(text, pool);
    if (strict) return strict;
    if (!this.storyDeduper) return undefined;
    const want = ContentStudio.motifTokens(text);
    const kandidaten = pool
      .map(p => ({ p, inter: [...ContentStudio.motifTokens(p.title)].filter(t => want.has(t)).length }))
      .filter(x => x.inter >= 1)
      .sort((a, b) => b.inter - a.inter)
      .slice(0, 8);
    if (kandidaten.length === 0) return undefined;
    const wantVec = await this.storyDeduper.embedText(text).catch(() => undefined);
    if (!wantVec) return undefined;
    let best: { title: string; url: string } | undefined;
    let bestCos = 0;
    for (const k of kandidaten) {
      const v = await this.storyDeduper.embedText(k.p.title).catch(() => undefined);
      if (!v) continue;
      const cos = cosineSimilarity(wantVec, v);
      if (cos > bestCos) { bestCos = cos; best = k.p; }
    }
    return bestCos >= 0.72 ? best : undefined;
  }

  /** v1130 — Volltext-Fetcher injizierbar (Tests mocken den Netz-Zugriff). */
  articleFetch: typeof fetchArticleText = fetchArticleText;

  /** v1134 — Wartezeit vor dem zweiten Vision-Prüf-Versuch (Tests: 1 ms). */
  visionRetryDelayMs = 5_000;

  /** v1038 — Embedding-Cache je Asset (Motive ändern sich selten; ein Studio-Lauf fragt viele Kandidaten). */
  private readonly motifVecCache = new Map<string, number[] | null>();

  private async embedMotifCached(assetId: string, motif: string): Promise<number[] | undefined> {
    // v1042 — Key trägt den INHALT (vorher nur die Länge: ein per „Beschreibungen
    // erneuern" geändertes Motiv gleicher Länge traf den veralteten Vektor)
    const key = `${assetId}:${motif}`;
    if (this.motifVecCache.has(key)) return this.motifVecCache.get(key) ?? undefined;
    const vec = await this.storyDeduper?.embedText(motif).catch(() => undefined);
    this.motifVecCache.set(key, vec ?? null);
    if (this.motifVecCache.size > 1_000) {
      const first = this.motifVecCache.keys().next().value;
      if (first !== undefined) this.motifVecCache.delete(first);
    }
    return vec;
  }

  /**
   * v1005 — Bild-Bibliothek: ähnliches Basis-Bild, gleicher Stil + gleiches
   * Format, letzte Nutzung länger her als der Cooldown
   * (config.image_reuse_cooldown_days, Default 30). Trifft eines: Basis-Bild
   * lesen, aktuelles Overlay drauf, als neues Item-Bild speichern — ohne
   * Budget-Verbrauch.
   *
   * v1038 — drei Ausbauten (Realfall: Bibliothek voller Fast-Duplikate, weil
   * Reuse praktisch nie zuschlug):
   * (A) Generische Symbolbilder + (D) Stamm-Bilder (pinned) haben nur eine
   *     KURZE Karenz (config.image_reuse_short_cooldown_days, Default 2) statt
   *     des vollen Cooldowns — das Fallback-Stadionbild wird nie mehr neu
   *     produziert, solange eines in der Bibliothek liegt.
   * (B) Semantisches Matching per Embedding (Cosine ≥ 0.82) fängt Paraphrasen,
   *     die das Token-Jaccard verfehlt („Stadion unter Flutlicht mit Ball" ≈
   *     „Fußball auf Rasen, Stadion unscharf"). Ohne Embedding-Provider bleibt
   *     das Token-Matching allein (bisheriges Verhalten).
   * (D) Stamm-Bilder gewinnen bei mehreren Treffern immer.
   *
   * v1039 (C) — der Cooldown gilt JE KANAL (asset.channelUses), nicht global:
   * ein gestern auf Instagram genutztes Basis-Bild ist für Facebook sofort
   * frei (anderes Publikum, anderes Overlay). Altbestand ohne Kanal-Daten
   * fällt konservativ auf den globalen Zeitstempel zurück.
   */
  /**
   * v1122 — Story-Bild teilen (Opt-in image_share_story): Follower übernehmen
   * das Basis-Bild des Story-Leads — bevorzugt den sauberen asset-Zwilling
   * (ohne eingebrannte Titel-Boxen), aufs Kanal-Format gecroppt, mit den
   * EIGENEN Overlays. Kostet kein Bild-Budget: ein Basis-Bild je Story statt
   * eines je Kanal (Realfall Juli: ~490 generierte Bilder für weitgehend
   * dieselben Stories — das fussball.cc-Budget war Mitte des Monats leer).
   */
  private async tryShareLeadImage(
    channel: SocialChannel, idea: GeneratedIdea, forcedTitle?: string | null,
  ): Promise<Array<{ type: 'image'; source: 'generated'; pathOrUrl: string }> | undefined> {
    const src = idea.leadImagePath!;
    const twin = src.replace(/([\\/])studio-/, '$1asset-');
    const { readFile, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    let base: Buffer | undefined;
    for (const p of twin !== src ? [twin, src] : [src]) {
      try { base = await readFile(p); break; } catch { /* nächster Kandidat (HA: Datei ggf. auf anderem Node) */ }
    }
    if (!base) return undefined;
    const format = ContentStudio.platformImageSpec(channel);
    // aufs Kanal-Format bringen (Lead ist meist 3:2-Website, IG braucht 4:5 usw.)
    const ratio: [number, number] | undefined = format.crop
      ?? (format.size === '1024x1536' ? [2, 3] : format.size === '1536x1024' ? [3, 2] : format.size === '1024x1024' ? [1, 1] : undefined);
    if (ratio) base = await cropToRatio(base, ratio[0], ratio[1]).catch(() => base!);
    const finalBuffer = await this.applyOverlays(base, channel, idea, forcedTitle).catch(() => base!);
    const file = join(this.mediaDir!, `studio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ContentStudio.overlayBakesTitle(channel, idea, forcedTitle) ? '' : '-no-title'}.png`);
    await writeFile(file, finalBuffer);
    this.logger.info({ channel: channel.name, source: src.slice(-48) }, 'v1122 story image shared from lead (kein Budget verbraucht)');
    return [{ type: 'image', source: 'generated', pathOrUrl: file }];
  }

  private async tryReuseAsset(
    channel: SocialChannel, motif: string, idea: GeneratedIdea,
    style: string | undefined, format: { size?: string; crop?: [number, number] },
    forcedTitle?: string | null,
    // v1122 — lax: Budget-Fallback-Modus (Cooldown/Stil ignoriert, niedrigere
    // Schwellen, notfalls das am längsten nicht genutzte Format-passende Asset)
    opts?: { lax?: boolean },
  ): Promise<Array<{ type: 'image'; source: 'generated'; pathOrUrl: string }> | undefined> {
    const cooldownDays = typeof channel.config.image_reuse_cooldown_days === 'number' && channel.config.image_reuse_cooldown_days >= 0
      ? channel.config.image_reuse_cooldown_days : 30;
    const shortDays = typeof channel.config.image_reuse_short_cooldown_days === 'number' && channel.config.image_reuse_short_cooldown_days >= 0
      ? channel.config.image_reuse_short_cooldown_days : 2;
    const now = Date.now();
    const family = ContentStudio.familyKey(channel);
    const assets = await this.socialRepo.listMediaAssets(this.ownerUserId, family ? { family } : { channelId: channel.id });
    const wanted = ContentStudio.motifTokens(motif);
    if (wanted.size === 0) return undefined;
    const genericWanted = ContentStudio.isGenericMotif(motif);
    const wantedVec = await this.storyDeduper?.embedText(motif).catch(() => undefined);
    const matches: Array<{ asset: (typeof assets)[number]; score: number }> = [];
    for (const asset of assets) {
      if (asset.blocked) continue; // v1014 — vom User gesperrt
      const effectiveDays = asset.pinned || (genericWanted && ContentStudio.isGenericMotif(asset.motif))
        ? Math.min(shortDays, cooldownDays) : cooldownDays;
      // v1039(C) — Nutzung DIESES Kanals zählt; nie von diesem Kanal genutzt = frei
      const lastUsedHere = asset.channelUses ? asset.channelUses[channel.id] : asset.lastUsedAt;
      if (!opts?.lax && lastUsedHere !== undefined && lastUsedHere >= new Date(now - effectiveDays * 24 * 3_600_000).toISOString()) continue;
      if (!opts?.lax && (asset.style ?? '') !== (style ?? '')) continue;
      if ((asset.format ?? 'square') !== (format.size ?? 'square')) continue;
      const have = ContentStudio.motifTokens(asset.motif);
      const inter = [...wanted].filter(t => have.has(t)).length;
      const union = new Set([...wanted, ...have]).size;
      const jaccard = union === 0 ? 0 : inter / union;
      let score = jaccard >= (opts?.lax ? 0.15 : 0.5) ? jaccard : 0;
      if (score === 0 && wantedVec) {
        const assetVec = await this.embedMotifCached(asset.id, asset.motif);
        if (assetVec) {
          const cos = cosineSimilarity(wantedVec, assetVec);
          if (cos >= (opts?.lax ? 0.7 : 0.82)) score = cos;
        }
      }
      if (score === 0) continue;
      matches.push({ asset, score });
    }
    // v1122 — lax ohne Motiv-Treffer: das am längsten nicht genutzte,
    // format-passende Asset (besser irgendein Stadion-Bild als gar keines)
    if (matches.length === 0 && opts?.lax) {
      const eligible = assets.filter(a => !a.blocked && (a.format ?? 'square') === (format.size ?? 'square'));
      eligible.sort((a, b) => String((a.channelUses ? a.channelUses[channel.id] : undefined) ?? a.lastUsedAt ?? '')
        .localeCompare(String((b.channelUses ? b.channelUses[channel.id] : undefined) ?? b.lastUsedAt ?? '')));
      matches.push(...eligible.map(asset => ({ asset, score: 0 })));
    }
    if (matches.length === 0) return undefined;
    // Stamm-Bilder gewinnen immer; sonst der beste Score
    matches.sort((a, b) => Number(b.asset.pinned) - Number(a.asset.pinned) || b.score - a.score);
    const { readFile, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    // v1043 — HA: Lesefehler heißt „Datei liegt auf dem anderen Node", NICHT
    // „Asset kaputt". Vorher wurde hier die geteilte DB-Zeile GELÖSCHT und
    // damit fremde Bibliotheks-Bilder zerstört. Jetzt: nächsten Treffer
    // versuchen, nie löschen.
    let best: (typeof matches)[number] | undefined;
    let base: Buffer | undefined;
    for (const m of matches) {
      try {
        base = await readFile(m.asset.path);
        best = m;
        break;
      } catch {
        this.logger.warn({ asset: m.asset.id, channel: channel.name }, 'v1043 asset file not readable on this node — übersprungen (nicht gelöscht)');
      }
    }
    if (!best || !base) return undefined;
    const finalBuffer = await this.applyOverlays(base, channel, idea, forcedTitle).catch(() => base);
    // v1027 — gleicher „-no-title"-Marker wie im Frisch-Pfad (Plattform-Signal)
    const file = join(this.mediaDir!, `studio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ContentStudio.overlayBakesTitle(channel, idea, forcedTitle) ? '' : '-no-title'}.png`);
    await writeFile(file, finalBuffer);
    await this.socialRepo.touchMediaAsset(this.ownerUserId, best.asset.id, channel.id).catch(() => { /* non-critical */ });
    this.logger.info({ channel: channel.name, asset: best.asset.id, score: Number(best.score.toFixed(2)), motif: motif.slice(0, 80) }, 'v1005 image reused from library (kein Budget verbraucht)');
    return [{ type: 'image', source: 'generated', pathOrUrl: file }];
  }

  /**
   * v1041 — Termin-Vorlage: Kanal-Config image_overlay.termin_image (Asset-ID
   * aus der Bibliothek, per UI wählbar/hochladbar) liefert das feste Basis-Bild
   * für ALLE Termin-Posts des Kanals; Teams/Anpfiff/Ort kommen deterministisch
   * aus der Termin-Karte. Kein Budget, kein Vision-Gate, konsistenter Look.
   * Vorlage nicht gesetzt oder Datei weg → undefined (normaler Pfad).
   */
  private async tryTerminTemplate(
    channel: SocialChannel, idea: GeneratedIdea,
    format: { size?: string; crop?: [number, number] },
  ): Promise<Array<{ type: 'image'; source: 'generated'; pathOrUrl: string }> | undefined> {
    const ov = (channel.config.image_overlay && typeof channel.config.image_overlay === 'object'
      ? channel.config.image_overlay : {}) as Record<string, unknown>;
    const templateId = typeof ov.termin_image === 'string' && ov.termin_image.trim() ? ov.termin_image.trim() : undefined;
    if (!templateId) return undefined;
    const asset = (await this.socialRepo.listMediaAssets(this.ownerUserId, { limit: 1000 })).find(a => a.id === templateId);
    if (!asset) return undefined;
    const { readFile, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    let base: Buffer;
    try {
      base = await readFile(asset.path);
    } catch {
      // v1043 — sichtbar machen statt still zurückfallen: die Vorlage ist
      // konfiguriert, aber auf DIESEM Node nicht lesbar (anderer Node/gelöscht)
      this.logger.warn({ channel: channel.name, asset: asset.id, path: asset.path }, 'v1043 termin template file not readable — fallback auf Generierung');
      return undefined;
    }
    const framed = format.crop ? await cropToRatio(base, format.crop[0], format.crop[1]).catch(() => base) : base;
    const finalBuffer = await this.applyOverlays(framed, channel, idea, undefined).catch(() => framed);
    const file = join(this.mediaDir!, `studio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ContentStudio.overlayBakesTitle(channel, idea, undefined) ? '' : '-no-title'}.png`);
    await writeFile(file, finalBuffer);
    // Nutzung festhalten: schützt die Vorlage vor dem Alters-Cleanup
    await this.socialRepo.touchMediaAsset(this.ownerUserId, asset.id, channel.id).catch(() => { /* non-critical */ });
    this.logger.info({ channel: channel.name, asset: asset.id }, 'v1041 termin template image used (kein Budget verbraucht)');
    return [{ type: 'image', source: 'generated', pathOrUrl: file }];
  }

  /**
   * v1004 — Bild-Format je Plattform: Instagram Hochformat (generiert 1024x1536,
   * zugeschnitten auf 4:5 — mehr Hochformat erlaubt IG nicht), Text-/Web-Kanäle
   * Querformat, sonst Quadrat. config.image_size übersteuert.
   */
  static platformImageSpec(channel: Pick<SocialChannel, 'platform' | 'config'>): { size?: '1024x1024' | '1536x1024' | '1024x1536'; crop?: [number, number] } {
    const cfg = channel.config.image_size;
    const size = cfg === '1024x1024' || cfg === '1536x1024' || cfg === '1024x1536' ? cfg : undefined;
    if (size) return { size, crop: channel.platform === 'instagram' && size === '1024x1536' ? [4, 5] : undefined };
    switch (channel.platform) {
      case 'instagram': return { size: '1024x1536', crop: [4, 5] };
      case 'facebook':
      case 'rest':
      case 'telegram_channel':
      case 'x':
      case 'threads':
      case 'youtube': return { size: '1536x1024' };
      default: return {};
    }
  }

  /**
   * v1027 — Brennt der Overlay-Schritt einen TITEL bzw. eine Termin-Karte ins
   * Bild? Spiegelbild der Spec-Logik in applyOverlays. Entscheidet den
   * Dateinamen-Marker „-no-title": Die fussball.cc-Plattform rendert Titel
   * selbst (locale-aware, HTML/OG) und braucht ein verlässliches Signal,
   * welche gelieferten Bilder KEINEN eingebrannten Titel tragen — der reine
   * Datums-Cutoff kann saubere Bilder nicht von Termin-Karten-Bildern
   * unterscheiden (Plattform-Marker: „no-title" im Dateinamen, Token-Grenzen).
   */
  static overlayBakesTitle(
    channel: Pick<SocialChannel, 'config'>,
    idea: Pick<GeneratedIdea, 'title' | 'terminBis'>,
    forcedTitle?: string | null,
  ): boolean {
    const ov = (channel.config.image_overlay && typeof channel.config.image_overlay === 'object'
      ? channel.config.image_overlay : {}) as Record<string, unknown>;
    const termin = forcedTitle === undefined && !!idea.terminBis && ov.termin_card !== false;
    const title = forcedTitle !== undefined
      ? typeof forcedTitle === 'string' && forcedTitle.length > 0
      : (!termin && ov.title === true && !!idea.title);
    return termin || title;
  }

  /**
   * v1002 — Overlay-Spec für ein generiertes Bild bauen und anwenden:
   * Wasserzeichen (config.image_overlay.watermark, Default AN; Text via
   * resolveImageBranding: config.image_branding → Lead-Domain → Kanalname)
   * + optionaler Titelbalken (config.image_overlay.title, Default AUS).
   */
  private async applyOverlays(buffer: Buffer, channel: SocialChannel, idea: GeneratedIdea, forcedTitle?: string | null): Promise<Buffer> {
    const ov = (channel.config.image_overlay && typeof channel.config.image_overlay === 'object'
      ? channel.config.image_overlay : {}) as Record<string, unknown>;
    const siblings = await this.socialRepo.listChannels(this.ownerUserId, 'active').catch(() => [] as SocialChannel[]);
    // v1003 — Termin-Karte (Default AN): Matchup + Anpfiff (+ Einlass/Ort) aus
    // den Datenfeldern — NIE vom Bildmodell (v982-Lektion).
    // v1008 — forcedTitle: Karussell-Slides erzwingen ihren Slide-Titel
    // (string) bzw. nur Branding (null); undefined = Automatik.
    // v1073 — Karte nur für echte Termin-Ankündigungen (nicht für Vorschauen,
    // die terminBis nur fürs Scheduling tragen)
    const termin = forcedTitle === undefined && idea.terminBis && isTerminAnnouncement(idea) && ov.termin_card !== false ? {
      headline: (idea.title || idea.body.slice(0, 60)).slice(0, 90),
      anpfiff: `${formatLocalDateTime(idea.terminBis)} Uhr`,
      ...(idea.einlass ? { einlass: idea.einlass } : {}),
      ...(idea.ort ? { ort: idea.ort } : {}),
    } : undefined;
    // v1026 — Logo (SVG inline in der Config) + wählbare Ecken für Logo und Text
    const logoRaw = (ov.logo && typeof ov.logo === 'object' ? ov.logo : undefined) as Record<string, unknown> | undefined;
    const logo = logoRaw && typeof logoRaw.svg === 'string' && logoRaw.svg.trim().startsWith('<svg')
      ? {
        svg: logoRaw.svg,
        corner: parseOverlayCorner(logoRaw.corner, 'bottom-right'),
        // v1032 — optionale Umfärbung (Hex; leer = Originalfarben)
        ...(typeof logoRaw.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(logoRaw.color.trim()) ? { color: logoRaw.color.trim() } : {}),
      }
      : undefined;
    const spec: OverlaySpec = {
      branding: ov.watermark === false ? undefined : resolveImageBranding(channel, siblings),
      brandingCorner: parseOverlayCorner(ov.watermark_corner, logo && parseOverlayCorner(logoRaw?.corner, 'bottom-right') === 'bottom-right' ? 'bottom-left' : 'bottom-right'),
      title: forcedTitle !== undefined
        ? (forcedTitle ?? undefined)
        : (!termin && ov.title === true && idea.title ? idea.title : undefined),
      termin,
      logo,
      font: typeof ov.font === 'string' ? ov.font : undefined,
    };
    if (!spec.branding && !spec.title && !spec.termin && !spec.logo) return buffer;
    const out = await applyImageOverlays(buffer, spec);
    if (out !== buffer) this.logger.info({ channel: channel.name, branding: spec.branding, title: !!spec.title, termin: !!spec.termin, logo: !!spec.logo }, 'v1002 image overlays applied');
    return out;
  }

  /**
   * v1026 — Overlays neu anwenden: baut die Bilder aller UNVERÖFFENTLICHTEN
   * Beiträge aus dem sauberen Basis-Asset der Bild-Bibliothek neu zusammen
   * (Basis + aktuelle Overlay-Config) — ohne LLM, ohne Bild-Budget. Für
   * Look-Umbauten und Config-Wechsel (Titel-Stil, Logo, Ecken). Die
   * studio-Datei wird IN PLACE überschrieben (Item-Media bleibt unverändert).
   * Karussells und Bilder ohne Asset-Zwilling werden übersprungen.
   */
  async refreshOverlays(channelNameOrId?: string): Promise<{ refreshed: number; skipped: number; channels: string[] }> {
    const all = await this.socialRepo.listChannels(this.ownerUserId, 'active');
    const needle = channelNameOrId?.trim().toLowerCase();
    const targets = needle
      ? all.filter(c => c.id === channelNameOrId || c.name.toLowerCase().includes(needle) || c.platform === needle)
      : all;
    let refreshed = 0;
    let skipped = 0;
    const touched = new Set<string>();
    const { readFile, writeFile } = await import('node:fs/promises');
    for (const channel of targets) {
      const items = await this.socialRepo.listItems(this.ownerUserId, {
        channelId: channel.id, status: ['draft', 'scheduled', 'approved'], limit: 200,
      });
      for (const item of items) {
        const images = item.media.filter(m => m.type === 'image');
        if (images.length !== 1 || images[0].source !== 'generated' || images[0].pathOrUrl.startsWith('http')) {
          if (images.length > 0) skipped++;
          continue;
        }
        const studioPath = images[0].pathOrUrl;
        const assetTwin = studioPath.replace(/([\\/])studio-/, '$1asset-');
        if (assetTwin === studioPath) { skipped++; continue; }
        try {
          const base = await readFile(assetTwin);
          const perf = item.performance ?? {};
          const idea = {
            title: item.title ?? '', body: item.body, hashtags: [], warum: '',
            ...(typeof perf.terminBis === 'string' ? { terminBis: perf.terminBis } : {}),
            ...(typeof perf.ort === 'string' ? { ort: perf.ort } : {}),
            ...(typeof perf.einlass === 'string' ? { einlass: perf.einlass } : {}),
          } as GeneratedIdea;
          const rebuilt = await this.applyOverlays(base, channel, idea, undefined);
          await writeFile(studioPath, rebuilt);
          refreshed++;
          touched.add(channel.name);
        } catch {
          skipped++; // Asset fehlt (anderer Node/alt) oder Datei nicht schreibbar
        }
      }
    }
    this.logger.info({ refreshed, skipped, channels: [...touched] }, 'v1026 overlays refreshed');
    return { refreshed, skipped, channels: [...touched] };
  }

  /**
   * v1039 (E) — Dedup-Aufräumen der Bild-Bibliothek: Fast-Duplikate (gleicher
   * Pool = Familie/Kanal + Stil + Format, Motiv ähnlich nach denselben Regeln
   * wie die Wiederverwendung: Jaccard ≥ 0.5 ODER Embedding-Cosine ≥ 0.82)
   * werden zu Gruppen zusammengefasst; pro Gruppe bleibt EIN Bild (gepinnt >
   * meistgenutzt > neuestes), der Rest wird gelöscht (Datei + Eintrag).
   * Gepinnte und gesperrte Assets werden NIE gelöscht. Bereits verwendete
   * studio-Dateien der Items bleiben unberührt — gelöscht wird nur die
   * Basis-Bild-Kopie der Bibliothek.
   */
  async dedupMediaLibrary(): Promise<{ scanned: number; groups: number; removed: number }> {
    const templateIds = await this.terminTemplateIds();
    const assets = (await this.socialRepo.listMediaAssets(this.ownerUserId, { limit: 1000 }))
      .filter(a => !a.blocked);
    // Pools: nur innerhalb desselben Wiederverwendungs-Kontexts vergleichen
    const pools = new Map<string, typeof assets>();
    for (const a of assets) {
      const key = `${a.family ?? a.channelId ?? ''}|${a.style ?? ''}|${a.format ?? 'square'}`;
      const list = pools.get(key) ?? [];
      list.push(a);
      pools.set(key, list);
    }
    let groups = 0;
    let removed = 0;
    const { unlink } = await import('node:fs/promises');
    for (const pool of pools.values()) {
      if (pool.length < 2) continue;
      // Union-Find über paarweise Motiv-Ähnlichkeit
      const parent = pool.map((_, i) => i);
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      const tokens = pool.map(a => ContentStudio.motifTokens(a.motif));
      for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
          const inter = [...tokens[i]].filter(t => tokens[j].has(t)).length;
          const union = new Set([...tokens[i], ...tokens[j]]).size;
          let similar = union > 0 && inter / union >= 0.5;
          if (!similar) {
            const vi = await this.embedMotifCached(pool[i].id, pool[i].motif);
            const vj = await this.embedMotifCached(pool[j].id, pool[j].motif);
            if (vi && vj) similar = cosineSimilarity(vi, vj) >= 0.82;
          }
          if (similar) parent[find(i)] = find(j);
        }
      }
      const clusters = new Map<number, typeof pool>();
      for (let i = 0; i < pool.length; i++) {
        const root = find(i);
        const list = clusters.get(root) ?? [];
        list.push(pool[i]);
        clusters.set(root, list);
      }
      for (const cluster of clusters.values()) {
        if (cluster.length < 2) continue;
        groups++;
        const keeper = [...cluster].sort((a, b) =>
          Number(b.pinned) - Number(a.pinned) || b.useCount - a.useCount || b.createdAt.localeCompare(a.createdAt))[0];
        for (const asset of cluster) {
          // v1043 — auch als Termin-Vorlage referenzierte (nicht gepinnte) Assets nie löschen
          if (asset.id === keeper.id || asset.pinned || templateIds.has(asset.id)) continue;
          try {
            await unlink(asset.path).catch(() => { /* Datei ggf. schon weg (anderer Node) */ });
            await this.socialRepo.deleteMediaAsset(this.ownerUserId, asset.id);
            removed++;
          } catch { /* Einzelfehler überspringen */ }
        }
      }
    }
    this.logger.info({ scanned: assets.length, groups, removed }, 'v1039 media library deduped');
    return { scanned: assets.length, groups, removed };
  }

  /**
   * v936 — Wöchentlicher Nischen-Report (Lern-Loop sichtbar machen): fasst je
   * Kanal Bestperformer + Themen-Trends zusammen und legt EINEN stillen
   * Insights-Eintrag ab. @returns true wenn ein Report erzeugt wurde.
   */
  async weeklyNicheReport(): Promise<boolean> {
    if (!this.insightsRepo) return false;
    const channels = await this.socialRepo.listChannels(this.ownerUserId, 'active');
    if (channels.length === 0) return false;
    const sections: string[] = [];
    // v1102 — Redaktionslinie prominent im Wochen-Report (Erinnerung + Anlass zum Fortschreiben)
    const wochenLinie = ContentStudio.linieOf(channels);
    if (wochenLinie) sections.push(`**🧭 Redaktionslinie:** ${wochenLinie}\n_Fortschreiben per Zuruf: „Setze die Redaktionslinie auf …"_`);
    // v1021 — Wachstums-Sektion: Follower-Deltas der Woche je Kanal + Treiber
    const growthLines: string[] = [];
    let totalDelta = 0;
    let driver: { name: string; delta: number; pct: number } | undefined;
    for (const channel of channels) {
      try {
        const weekAgoDate = new Date(Date.now() - 8 * 24 * 3_600_000).toISOString().slice(0, 10);
        const rows = (await this.socialRepo.listMetrics(channel.id, { kind: 'followers', sinceDate: weekAgoDate }))
          .filter(m => !m.itemId)
          .sort((a, b) => a.date.localeCompare(b.date));
        if (rows.length < 2) continue;
        const delta = rows[rows.length - 1].value - rows[0].value;
        totalDelta += delta;
        const pct = (delta / Math.max(1, rows[0].value)) * 100;
        growthLines.push(`${channel.name}: ${rows[rows.length - 1].value.toLocaleString('de-AT')} (${delta >= 0 ? '+' : ''}${delta})`);
        if (delta > 0 && (!driver || pct > driver.pct)) driver = { name: channel.name, delta, pct };
      } catch { /* Kanal ohne Wachstumsdaten */ }
    }
    if (growthLines.length > 0) {
      sections.push(`**👥 Wachstum diese Woche: ${totalDelta >= 0 ? '+' : ''}${totalDelta}**\n${growthLines.join(' · ')}${driver ? `\n🚀 Stärkster Treiber relativ: ${driver.name} (+${driver.delta} · +${driver.pct.toFixed(1)} %)` : ''}`);
    }
    for (const channel of channels) {
      const [best, dossier] = await Promise.all([this.bestPerformers(channel), this.topicDossier(channel)]);
      const weekStart = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
      const publishedCount = await this.socialRepo.countPublishedSince(channel.id, weekStart);
      sections.push(`**${channel.name}** (${channel.platform}) — ${publishedCount} Posts diese Woche${best ? `\nBestperformer:\n${best}` : ''}${dossier ? `\nThemen-Lage: ${dossier.slice(0, 300)}` : ''}`);
    }
    let analysis = '';
    try {
      const response = await this.llm.complete({
        messages: [{ role: 'user', content: `Analysiere die Wochendaten dieser Social-Kanäle und leite 3-5 konkrete Nischen-/Format-Empfehlungen ab (deutsch, direkt umsetzbar, keine Allgemeinplätze):\n\n${sections.join('\n\n')}` }],
        maxTokens: 800, tier: 'fast',
      });
      analysis = response.content?.trim() ?? '';
    } catch { /* Report auch ohne LLM-Analyse abliefern */ }
    await this.insightsRepo.upsertCandidate(this.ownerUserId, {
      category: 'social',
      title: `Wochen-Report Social (${new Date().toISOString().slice(0, 10)})`,
      body: `${sections.join('\n\n')}${analysis ? `\n\n**Empfehlungen:**\n${analysis}` : ''}`,
      confidence: 0.6,
      sourceData: { router: true, urgency: 'low', storedAt: new Date().toISOString() },
      dedupeKey: `social-weekly:${new Date().toISOString().slice(0, 10)}`,
    });
    return true;
  }

  // ── Auto-Interessen-Topic je Kanal ────────────────────────────────────

  private async ensureTopic(channel: SocialChannel): Promise<void> {
    if (!this.interestsRepo) return;
    // v951 — nur auto-anlegen, wenn GAR KEIN Topic verknüpft ist (topic_ids ODER topic_id)
    if (ContentStudio.linkedTopicIds(channel).length > 0) return;
    try {
      const niche = typeof channel.config.niche === 'string' && channel.config.niche.trim().length > 0
        ? channel.config.niche.trim() : channel.name;
      const existing = await this.interestsRepo.findTopicByName(this.ownerUserId, niche);
      const topic = existing ?? await this.interestsRepo.createTopic(this.ownerUserId, {
        name: niche,
        keywords: Array.isArray(channel.config.keywords) ? (channel.config.keywords as unknown[]).map(String) : [],
        origin: 'auto',
      });
      if (!existing && this.provisioner) {
        try { await this.provisioner.provision(topic); } catch { /* best-effort */ }
      }
      await this.socialRepo.updateChannel(this.ownerUserId, channel.id, {
        config: { ...channel.config, topic_id: topic.id },
      });
      channel.config.topic_id = topic.id;
      this.logger.info({ channel: channel.name, topic: topic.name }, 'v935 channel topic ensured');
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, channel: channel.name }, 'v935 ensureTopic failed');
    }
  }
}
