import type { Logger } from 'pino';
import type {
  SocialRepository, SocialChannel, ContentItem, Story,
  InterestsRepository, InsightsRepository,
} from '@alfred/storage';
import type { LLMProvider } from '@alfred/llm';
import type { Skill, SkillRegistry, SkillSandbox } from '@alfred/skills';
import { effectiveSlots, extractTrailingHashtags, mergeHashtags, isNearDuplicateTitle } from '@alfred/skills';
export { extractTrailingHashtags, isNearDuplicateTitle };
import type { SourceProvisioner } from './source-provisioner.js';
import type { StoryDeduper, BlockedStory } from './story-dedup.js';

const WEEKDAYS: Record<string, number> = { so: 0, mo: 1, di: 2, mi: 3, do: 4, fr: 5, sa: 6 };

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
    const date = new Date(from.getTime() + day * 24 * 3_600_000);
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
}

/** v977 — Kommender Termin aus einer Event-Quelle (at = ISO, Ort in summary). */
interface UpcomingEvent {
  title: string;
  summary?: string;
  at: string;
}

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
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
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
    if (created > 0) this.logger.info({ created, channels: channels.length }, 'v935 studio pass done');
    return created;
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
    const lead = members.find(c => c.platform === 'rest') ?? members[0];
    // Nachtruhe (Server-Lokalzeit)
    const quiet = Array.isArray(lead.config.newsdesk_quiet) && (lead.config.newsdesk_quiet as unknown[]).length === 2
      ? (lead.config.newsdesk_quiet as number[]).map(Number) : [22, 6];
    const hour = new Date().getHours();
    const inQuiet = quiet[0] > quiet[1] ? (hour >= quiet[0] || hour < quiet[1]) : (hour >= quiet[0] && hour < quiet[1]);
    if (inQuiet) return 0;
    // Tages-Limit
    const maxPerDay = typeof lead.config.newsdesk_max_per_day === 'number' ? lead.config.newsdesk_max_per_day : 3;
    const todayEvents = (await this.socialRepo.listStories(this.ownerUserId, { family, sinceDays: 1 }))
      .filter(s => s.source === 'event').length;
    if (todayEvents >= maxPerDay) return 0;
    // Neue Items der letzten 2 Stunden (ohne Termin-Feeds)
    if (!this.interestsRepo) return 0;
    const sinceIso = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const unionTopics = [...new Set(members.flatMap(c => ContentStudio.linkedTopicIds(c)))];
    const fresh: Array<{ title: string; summary?: string }> = [];
    for (const topicId of unionTopics) {
      const items = await this.interestsRepo.listItems(topicId, { sinceIso, limit: 30 });
      fresh.push(...items.filter(i => i.sourceKind !== 'events').map(i => ({ title: i.title, summary: i.summary })));
    }
    if (fresh.length === 0) return 0;
    // Dedup gegen aktive Stories (Token reicht als Vorfilter)
    const activeStories = await this.socialRepo.listStories(this.ownerUserId, { family, status: 'active', sinceDays: 7 });
    const blockedTitles = activeStories.map(s => s.title);
    const candidates = fresh.filter(f => !isNearDuplicateTitle(f.title, blockedTitles)).slice(0, 15);
    if (candidates.length === 0) return 0;
    // LLM-Eilmeldungs-Score (fast reicht fürs Sortieren)
    const threshold = typeof lead.config.newsdesk_threshold === 'number' ? lead.config.newsdesk_threshold : 0.85;
    const scorePrompt = `Bewerte für einen Fußball-Publisher, wie sehr jede Meldung eine EILMELDUNG ist (0..1):
0.9+ = muss SOFORT raus (Titelentscheidung, Rücktritt eines Stars, Skandal, dramatisches Ergebnis eines Top-Spiels),
0.5 = normale Tagesmeldung, 0.2 = Routine. Nur die Fakten der Meldung zählen.

${candidates.map((c, i) => `${i}: ${c.title}${c.summary ? ` — ${c.summary.replace(/<[^>]+>/g, ' ').slice(0, 150)}` : ''}`).join('\n')}

Antworte NUR mit einem VALIDEN JSON-Array: [{"index": 0, "score": 0.4}]`;
    const response = await this.llm.complete({ messages: [{ role: 'user', content: scorePrompt }], maxTokens: 1_000, tier: 'fast', reasoningEffort: 'low' });
    const scores = (extractJsonArray(response.content ?? '') ?? []) as Array<{ index?: unknown; score?: unknown }>;
    const breaking = scores
      .filter(s => typeof s.index === 'number' && typeof s.score === 'number' && s.score >= threshold)
      .map(s => ({ ...candidates[s.index as number], score: s.score as number }))
      .filter(c => c?.title)
      .slice(0, maxPerDay - todayEvents);
    if (breaking.length === 0) return 0;

    let created = 0;
    for (const b of breaking) {
      // Semantik-Dedup wie in der Konferenz
      if (this.storyDeduper) {
        const r = await this.storyDeduper.filterCandidates(
          [{ title: b.title, body: b.summary ?? '' }],
          activeStories.map(s => ({ id: s.id, title: s.title, body: s.summary })),
        );
        if (r.accepted.length === 0) continue;
      }
      const story = await this.socialRepo.createStory(this.ownerUserId, {
        family, kind: 'news', title: b.title, summary: b.summary?.replace(/<[^>]+>/g, ' ').slice(0, 800),
        importance: b.score, source: 'event',
      });
      await this.storyDeduper?.embedStory(story.id, { title: story.title, body: story.summary });
      let leadName: string | undefined;
      let itemsCreated = 0;
      for (const channel of [lead, ...members.filter(m => m.id !== lead.id)]) {
        const item = await this.renderAssignment(story, channel, channel.id === lead.id ? 'lead' : 'follow', leadName, undefined);
        if (!item) continue;
        // Ad-hoc-Slots: Lead +30 min, Follower +90 min — Freigabe kommt zum Slot
        const slot = new Date(Date.now() + (channel.id === lead.id ? 30 : 90) * 60_000).toISOString();
        if (channel.mode === 'approve' || channel.mode === 'autonomous') {
          await this.socialRepo.transition(this.ownerUserId, item.id, 'scheduled', { scheduledAt: slot });
        }
        await this.socialRepo.createAssignment({ storyId: story.id, channelId: channel.id, role: channel.id === lead.id ? 'lead' : 'follow', offsetHours: channel.id === lead.id ? 0 : 1, itemId: item.id });
        if (channel.id === lead.id) leadName = channel.name;
        itemsCreated++;
      }
      created += itemsCreated;
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
  async planFamily(family: string, channels: SocialChannel[]): Promise<number> {
    const now = new Date().toISOString();
    // Kapazität je Kanal (Slots minus Backlog, wie fillChannel)
    const capacity = new Map<string, { channel: SocialChannel; slotPool: string[]; needed: number; created: number }>();
    for (const channel of channels) {
      await this.ensureTopic(channel);
      const planned = await this.socialRepo.listItems(this.ownerUserId, {
        channelId: channel.id, status: ['scheduled', 'approved', 'draft', 'idea'], limit: 100,
      });
      if (planned.length >= 30) { capacity.set(channel.name, { channel, slotPool: [], needed: 0, created: 0 }); continue; }
      const slots = nextFreeSlots(channel, planned, Math.max(0, 30 - planned.length), now);
      const backlog = planned.filter(i => (i.status === 'draft' || i.status === 'idea') && !i.scheduledAt).length;
      capacity.set(channel.name, { channel, slotPool: [...slots], needed: Math.max(0, slots.length - backlog), created: 0 });
    }
    const totalNeeded = [...capacity.values()].reduce((s, c) => s + c.needed, 0);

    // Sperrlisten: aktive Stories (30d) + published Titel der Familie (14d)
    const activeStories = await this.socialRepo.listStories(this.ownerUserId, { family, status: 'active', sinceDays: 30 });
    const publishedWindow = new Date(Date.now() - 14 * 24 * 3_600_000).toISOString();
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
    if (totalNeeded === 0 && openTermine.length === 0) return 0;

    // Konferenz-Pass: höchstes Modell-Tier der Familie entscheidet
    const tierRank: Record<string, number> = { fast: 0, default: 1, medium: 2, strong: 3 };
    const tier = channels.map(c => this.modelTier(c)).sort((a, b) => (tierRank[b] ?? 0) - (tierRank[a] ?? 0))[0];
    const channelLines = [...capacity.values()].map(c =>
      `- "${c.channel.name}" (${c.channel.platform}, Bedarf: ${c.needed} Beiträge)${c.channel.persona ? ` — Rolle/Persona: ${c.channel.persona.slice(0, 120)}` : ''}`).join('\n');
    const storyCount = Math.min(Math.max(totalNeeded, openTermine.length), 10);
    const conferencePrompt = `Du leitest die Redaktionskonferenz einer Kanal-Familie. Entscheide die Story-Liste für die nächsten Tage.

KANÄLE DER FAMILIE:
${channelLines}

${dossier ? `THEMEN-DOSSIER:\n${dossier}\n` : ''}${blocked.length ? `BEREITS GEPLANT/VERÖFFENTLICHT — dieser Stoff ist GESPERRT (auch umformuliert):\n${[...new Set(blocked.map(b => b.title))].slice(0, 50).map(t => `- ${t}`).join('\n')}\n` : ''}
Erzeuge bis zu ${storyCount} STORIES. Regeln:
- Eine STORY ist ein Stoff, den mehrere Kanäle in IHRER Rolle erzählen — nicht jeder Kanal braucht jede Story.
- Je Story: genau EIN lead-Kanal (der ausführlichste, i.d.R. die Website), follow-Kanäle mit Zeitversatz in Stunden (typisch: Telegram +2, Instagram +6, Facebook +8; Termine/Eilmeldungen: alle 0).
- art: news | vorschau | recap | termin | evergreen. Termine aus „KOMMENDE TERMINE" IMMER als art=termin mit terminBis (ISO aus der Zeile) und Zuweisung an ALLE Kanäle mit versatz_h 0.
- wichtigkeit 0..1 (Eilmeldungs-Niveau 0.9+). FAKTEN nur aus dem Dossier.
- Weise nur Kanälen mit Bedarf zu (Ausnahme: art=termin darf immer).

Antworte NUR mit einem VALIDEN JSON-Array:
[{"titel": "Arbeitstitel", "zusammenfassung": "2-3 Sätze Stoff mit den Fakten", "art": "news", "wichtigkeit": 0.6, "terminBis": "optional ISO", "kanaele": [{"kanal": "exakter Kanal-Name", "rolle": "lead", "versatz_h": 0}]}]`;
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
      }));

    // Story-Dedup: Termin-Stories über Termin-Identität, Rest über Deduper
    const normal = candidates.filter(c => !c.terminBis);
    const termine = candidates.filter(c => c.terminBis && !announcedAt.has(c.terminBis));
    let accepted: typeof candidates = termine;
    if (this.storyDeduper && normal.length > 0) {
      const r = await this.storyDeduper.filterCandidates(normal, blocked.filter(b => !b.terminAt));
      accepted = [...termine, ...r.accepted];
    } else {
      accepted = [...termine, ...normal.filter(c => !isNearDuplicateTitle(c.title, blocked.filter(b => !b.terminAt).map(b => b.title)))];
    }

    let created = 0;
    const createdTitles: string[] = [];
    for (const cand of accepted.sort((a, b) => b.importance - a.importance)) {
      const story = await this.socialRepo.createStory(this.ownerUserId, {
        family, kind: cand.kind, title: cand.title, summary: cand.body,
        importance: cand.importance, terminBis: cand.terminBis, source: 'studio',
      });
      await this.storyDeduper?.embedStory(story.id, { title: story.title, body: story.summary });
      // Lead zuerst rendern — Follower brauchen dessen Slot als Untergrenze
      const assigns = cand.kanaele
        .map(k => ({ cap: capacity.get(String(k.kanal ?? '')), role: k.rolle === 'lead' ? 'lead' as const : 'follow' as const, offset: typeof k.versatz_h === 'number' ? Math.max(0, Math.min(72, k.versatz_h)) : 0 }))
        .filter(a => a.cap !== undefined)
        .sort((a, b) => (a.role === 'lead' ? -1 : 1) - (b.role === 'lead' ? -1 : 1));
      let leadSlot: string | undefined;
      let leadChannelName: string | undefined;
      for (const a of assigns) {
        const cap = a.cap!;
        if (cand.kind !== 'termin' && cap.created >= cap.needed) continue; // Kapazität erschöpft (Termine haben Vorrang)
        const item = await this.renderAssignment(story, cap.channel, a.role, leadChannelName, leadSlot);
        if (!item) continue;
        // Slot: Termin → vor Anpfiff; Lead → nächster freier; Follower → ≥ Lead + Versatz
        let slot: string | undefined;
        if (cap.channel.mode === 'approve' || cap.channel.mode === 'autonomous') {
          if (story.terminBis) {
            slot = this.pickTerminSlot(cap.slotPool, story.terminBis, cap.channel);
          } else if (a.role === 'lead' || !leadSlot) {
            slot = cap.slotPool.shift();
          } else {
            const target = new Date(Date.parse(leadSlot) + a.offset * 3_600_000).toISOString();
            const idx = cap.slotPool.findIndex(s => s >= target);
            if (idx >= 0) slot = cap.slotPool.splice(idx, 1)[0];
          }
          if (slot) await this.socialRepo.transition(this.ownerUserId, item.id, 'scheduled', { scheduledAt: slot });
        }
        if (a.role === 'lead') { leadSlot = slot; leadChannelName = cap.channel.name; }
        await this.socialRepo.createAssignment({ storyId: story.id, channelId: cap.channel.id, role: a.role, offsetHours: a.offset, itemId: item.id });
        cap.created++;
        created++;
        createdTitles.push(`${cap.channel.name}: ${item.title ?? story.title}`);
      }
    }
    if (created > 0) {
      this.logger.info({ family, stories: accepted.length, created }, 'v993 family planned');
    }
    return created;
  }

  /** v993 — Slot vor dem Anpfiff (Raster, sonst Ad-hoc Anpfiff−Vorlauf) — Termin-Logik wie v975/v977. */
  private pickTerminSlot(slotPool: string[], terminBis: string, channel: SocialChannel): string | undefined {
    const before = slotPool.filter(s => s < terminBis);
    if (before.length > 0) {
      const slot = before[before.length - 1];
      slotPool.splice(slotPool.indexOf(slot), 1);
      return slot;
    }
    const leadMs = this.terminLeadHours(channel) * 3_600_000;
    const adhoc = new Date(Math.max(Date.now() + 30 * 60_000, Date.parse(terminBis) - leadMs)).toISOString();
    return adhoc < terminBis ? adhoc : undefined;
  }

  /** v993 — einen Beitrag für eine Story-Zuweisung rendern (Kanal-Prompt, Persona, Rolle). */
  private async renderAssignment(
    story: Story, channel: SocialChannel, role: 'lead' | 'follow',
    leadChannelName?: string, leadSlot?: string,
  ): Promise<ContentItem | null> {
    const roleRule = role === 'lead'
      ? '- DEINE ROLLE: LEAD — der ausführlichste Beitrag der Familie zu dieser Story (vollwertig, 4-8 Sätze bzw. Persona-gemäß mehr).'
      : `- DEINE ROLLE: FOLLOW — kürzer, eigener Blickwinkel deiner Persona.${leadChannelName ? ` Der ausführliche Beitrag auf ${leadChannelName} ist zum Zeitpunkt deiner Veröffentlichung bereits live${leadSlot ? ` (seit ${formatLocalDateTime(leadSlot)})` : ''} — du DARFST darauf verweisen.` : ''} NIE auf den eigenen Kanal verweisen.`;
    const prompt = `Du bist Content-Redakteur für den Social-Kanal "${channel.name}" (${channel.platform}).
${channel.persona ? `Persona/Tonalität: ${channel.persona}\n` : ''}
STORY (Redaktionskonferenz-Beschluss — NUR dieser Stoff, Fakten NUR hieraus):
Arbeitstitel: ${story.title}
Stoff: ${story.summary ?? story.title}
Art: ${story.kind}${story.terminBis ? `\nTermin: ${formatLocalDateTime(story.terminBis)} — Ort/Datum/Uhrzeit gehören in den TEXT, terminBis-Feld = ${story.terminBis}` : ''}

Regeln:
${roleRule}
${this.lessonsBlock(channel)}- Deutsch, konkret, kein Clickbait; eigener TITEL (nicht der Arbeitstitel wortgleich).
- 3-6 Hashtags NUR ins Feld "hashtags"; KEINE Meta-Zeilen im body.
- BILDIDEE ohne Text/Datum/Zahlen — nur Motive.
- NIE relative Zeitwörter („heute"/„morgen") — Datum/Uhrzeit nennen.

Antworte NUR mit einem VALIDEN JSON-Array mit GENAU EINEM Objekt (Zitate typografisch „…“ oder escaped):
[{"title": "…", "body": "…", "hashtags": ["…"], "warum": "1 Satz", "bildidee": "optional", "terminBis": ${story.terminBis ? `"${story.terminBis}"` : 'null'}}]`;
    const response = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 6_000, tier: this.modelTier(channel), reasoningEffort: 'low' });
    const ideas = parseIdeas(response.content ?? '');
    if (ideas.length === 0) {
      this.logger.warn({ channel: channel.name, story: story.title, head: (response.content ?? '').slice(0, 160) }, 'v993 assignment render unparseable');
      return null;
    }
    const idea = ideas[0];
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
    });
    if (!story.terminBis) await this.storyDeduper?.embedStory(item.id, { title: idea.title, body: idea.body });
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
    const slots = nextFreeSlots(channel, planned, Math.max(0, MAX_IN_FLIGHT - planned.length), now);
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
    const window = slotPool.length > 0 ? { from: slotPool[0], to: slotPool[slotPool.length - 1] } : undefined;
    // v971 — in BATCHES generieren (LLM liefert je Aufruf max. ~10 brauchbare
    // Ideen): weitere Runden bis der Bedarf gedeckt ist oder keine neuen,
    // dedup-überlebenden Ideen mehr kommen.
    for (let round = 0; round < 4 && created < target; round++) {
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
            const before = slotPool.filter(s => s < idea.terminBis!);
            if (before.length > 0) {
              slot = before[before.length - 1];
              slotPool.splice(slotPool.indexOf(slot), 1);
            } else {
              const leadMs = this.terminLeadHours(channel) * 3_600_000;
              const adhoc = new Date(Math.max(Date.now() + 30 * 60_000, Date.parse(idea.terminBis) - leadMs)).toISOString();
              if (adhoc < idea.terminBis) {
                slot = adhoc;
                this.logger.info({ channel: channel.name, termin: idea.terminBis, slot }, 'v977 termin ad-hoc slot (Raster hatte keinen Platz vor dem Anpfiff)');
              } else {
                this.logger.info({ channel: channel.name, termin: idea.terminBis, title: idea.title }, 'v975 termin idea dropped (kein Slot vor dem Termin möglich)');
                blocked.push({ title: idea.title || idea.body.slice(0, 60), terminAt: idea.terminBis });
                continue;
              }
            }
          } else {
            slot = slotPool.shift();
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
        });
        // v973 — Embedding des neuen Items persistieren (künftige Läufe lesen
        // es); Termin-Posts nicht — sie nehmen an den Gates nicht teil.
        if (!idea.terminBis) await this.storyDeduper?.embedStory(item.id, { title: idea.title, body: idea.body });
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
  async generateImageForItem(channel: SocialChannel, item: { title?: string; body: string; bildidee?: string }): Promise<Array<{ type: 'image'; source: 'generated'; pathOrUrl: string }>> {
    // v991 — optionaler User-Hinweis („beide Flaggen zeigen") wird zur Bildidee
    return this.maybeGenerateImage(channel, { title: item.title ?? '', body: item.body, hashtags: [], warum: '', bildidee: item.bildidee });
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
    const prompt = (isYoutube
      ? this.buildYoutubePrompt(channel, count, dossier, bestPerformers, blockedTitles)
      : this.buildPostPrompt(channel, count, dossier, bestPerformers, blockedTitles, window))
      + familyBlock;

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
      const files = await readdir(this.mediaDir).catch(() => [] as string[]);
      for (const name of files) {
        if (!name.startsWith('studio-')) continue; // nur eigene Artefakte anfassen
        const full = join(this.mediaDir, name);
        try {
          const s = await stat(full);
          if (s.mtimeMs > cutoff) continue;
          if (await this.socialRepo.countItemsReferencingMedia(name) > 0) continue;
          await unlink(full);
          removed++;
        } catch { /* Einzelfehler überspringen */ }
      }
      if (removed > 0) this.logger.info({ removed, maxAgeDays }, 'v990 mediaDir cleaned');
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'v990 mediaDir cleanup failed');
    }
    return removed;
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

  private buildPostPrompt(channel: SocialChannel, count: number, dossier: string, best: string, recent: string[], window?: { from: string; to: string }): string {
    // v975 — Termin-Ankündigungen: nur anweisen, wenn das Dossier Termine führt
    const terminRule = dossier.includes('KOMMENDE TERMINE')
      ? `- TERMIN-ANKÜNDIGUNGEN (Vorrang): Erzeuge für die Einträge unter „KOMMENDE TERMINE" Ankündigungs-Posts — MIT Ort, Datum und Uhrzeit exakt aus der Termin-Zeile (nichts erfinden, den Ort IMMER nennen). Übernimm die ISO-Zeit aus [terminBis: …] UNVERÄNDERT ins Feld "terminBis". Ort/Datum/Uhrzeit gehören in den BODY-TEXT — niemals in die "bildidee".\n`
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
- ZEITBEZUG (zwingend): Ist der Post eine VORSCHAU/Ankündigung auf ein datiertes Ereignis (Spiel, Termin, Deadline), setze "terminBis" auf den ISO-Zeitpunkt des Ereignisses — der Post wird dann garantiert VOR dem Ereignis veröffentlicht. NIE relative Zeitwörter („heute", „morgen", „heute Nacht") — nenne stattdessen Datum/Uhrzeit. Rückblicke auf Vergangenes brauchen KEIN "terminBis".
${terminRule}${this.lessonsBlock(channel)}- Deutsch, zur Persona passend, konkret statt generisch, kein Clickbait.
- body = VOLLWERTIGER Beitrag mit 4-8 Sätzen und eigenem Mehrwert (Einordnung, Details, Frage an die Community) — NIEMALS nur Schlagzeile plus ein Satz. Dossier-Beiträge sind Rohstoff, kein Abschreibmaterial.
- Jeder Post eigenständig; Bezug zu aktuellen Dossier-Themen wo sinnvoll.
- 3-6 Hashtags je Post — AUSSCHLIESSLICH ins Feld "hashtags", NIEMALS in den body (weder am Ende noch als eigene Zeile; sie werden beim Posten automatisch angehängt).
- body = NUR der fertige Post-Text. KEINE Meta-Zeilen wie "Bildidee:", Regieanweisungen oder Platzhalter — ein Bildvorschlag gehört ausschließlich ins separate Feld "bildidee".
- BILDIDEE ohne Text: "bildidee" beschreibt NUR Motive (Szenen, Objekte, Stimmung) — NIEMALS Datum, Uhrzeit, Zahlen, Schriftzüge oder Text-Overlays (Bildmodelle schreiben Text FALSCH; Fakten gehören in den body).
${channel.blacklist.length ? `- TABU (niemals erwähnen): ${channel.blacklist.join(', ')}\n` : ''}
Antworte NUR mit einem VALIDEN JSON-Array (Zitate in Texten typografisch „…“ oder mit \\" escapen — nie nackte " im String):
[{"title": "kurzer Titel", "body": "der Post-Text", "hashtags": ["…"], "warum": "1 Satz warum jetzt", "bildidee": "optional: Bildvorschlag für dieses Posting", "terminBis": "NUR bei Termin-Ankündigung/Vorschau: ISO-Zeitpunkt des Ereignisses"}]`;
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
   * v954 — Familien-Schlüssel eines Kanals: Projekt-Bindung oder explizites
   * config.family (für Familien ohne Projekt, z.B. „games"). null = solo.
   */
  static familyKey(channel: Pick<SocialChannel, 'projectId' | 'config'>): string | null {
    if (typeof channel.config.family === 'string' && channel.config.family.trim()) return `family:${channel.config.family.trim().toLowerCase()}`;
    if (channel.projectId) return `project:${channel.projectId}`;
    return null;
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
        const itemLines = items.filter(i => i.sourceKind !== 'events').slice(0, 8).map(i => {
          const covered = blockedTitles.length > 0 && isNearDuplicateTitle(i.title, blockedTitles);
          const summary = typeof i.summary === 'string' && i.summary.trim().length > 0
            ? ` — ${i.summary.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220)}`
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
    if (channel.config.generate_images !== true) return [];
    if (!this.skillRegistry || !this.skillSandbox) return [];
    const skill = this.skillRegistry.get('image_generate') as Skill | undefined;
    if (!skill) return [];

    // Monats-Budget (Leitplanke 5): channel_metrics kind 'gen_image' je Tag
    const budget = typeof channel.config.image_budget_per_month === 'number' ? channel.config.image_budget_per_month : 30;
    const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
    const used = (await this.socialRepo.listMetrics(channel.id, { kind: 'gen_image', sinceDate: monthStart }))
      .reduce((sum, m) => sum + m.value, 0);
    if (used >= budget) {
      this.logger.info({ channel: channel.name, used, budget }, 'v935 image budget reached — post ohne Bild');
      return [];
    }

    try {
      const {
        resolveImagePolicy, extractNameCandidates, scrubMotif, scrubTextDirectives,
        buildSafeImagePrompt, strictRetryPrompt, verifyImagePolicy,
      } = await import('./image-policy.js');
      const policy = resolveImagePolicy(channel.config);

      // v941 — die Bildidee des Studios ist der beste Prompt (Fallback: Titel/Body)
      let motif = idea.bildidee ?? `Social-Media-Bild für: ${idea.title || idea.body.slice(0, 150)}`;
      // v950 Schicht 2 — deterministisch: Personen-Namen aus dem Motiv schrubben
      if (policy === 'symbolic') {
        const names = extractNameCandidates(idea.title, idea.body, idea.bildidee);
        const scrubbedResult = scrubMotif(motif, names);
        if (scrubbedResult.scrubbed) {
          this.logger.info({ channel: channel.name, names }, 'v950 motif scrubbed (image policy symbolic)');
        }
        motif = scrubbedResult.motif;
      }
      // v982 — Text-/Datums-Direktiven schrubben (BEIDE Policies): Bildmodelle
      // rendern Text falsch — „Datum & Uhrzeit als Overlay" wurde zu „23.04.
      // 21:00" für einen Termin am 04.07. 19:00 (Realfall).
      const textScrub = scrubTextDirectives(motif);
      if (textScrub.scrubbed) {
        this.logger.info({ channel: channel.name, motif: textScrub.motif }, 'v982 text directives scrubbed');
      }
      motif = textScrub.motif;

      // v950 Schicht 1+3 — bis zu 2 Versuche: normal → Vision-Verstoß → strenges Symbolmotiv
      for (let attempt = 0; attempt < 2; attempt++) {
        const prompt = attempt === 0
          ? buildSafeImagePrompt(motif, channel.persona, policy)
          : strictRetryPrompt(channel.persona);
        const result = await this.skillSandbox.execute(skill, { prompt },
          { userId: this.ownerUserId, masterUserId: this.ownerUserId, platform: 'api', chatId: 'content-studio' } as never);
        if (!result.success) return [];
        // v990 — JEDER Generierungs-Versuch zählt aufs Budget (auch wenn das
        // Vision-Gate das Bild gleich verwirft): der OpenAI-Betrag ist dann
        // trotzdem angefallen. Vorher liefen Gate-Retries am Budget vorbei.
        {
          const today = new Date().toISOString().slice(0, 10);
          const todayUsed = (await this.socialRepo.listMetrics(channel.id, { kind: 'gen_image', sinceDate: today }))
            .find(m => m.date === today && !m.itemId)?.value ?? 0;
          await this.socialRepo.upsertMetric(channel.id, { date: today, kind: 'gen_image', value: todayUsed + 1 });
        }

        // v942 — image_generate liefert das Bild als Buffer-Attachment
        const attachment = (result as { attachments?: Array<{ data?: unknown; fileName?: string }> }).attachments?.[0];
        const buffer = attachment?.data && Buffer.isBuffer(attachment.data) ? attachment.data : undefined;

        // v950 Schicht 3 — Vision-Output-Gate (nur symbolic; fail-closed bei Ausfall)
        if (policy === 'symbolic' && buffer) {
          const verdict = await verifyImagePolicy(this.llm, buffer);
          if (verdict === null) {
            this.logger.warn({ channel: channel.name }, 'v950 vision check unavailable — Bild verworfen (fail-closed)');
            return [];
          }
          // v982 — auch gerenderter Text/Zahlen ist ein Verstoß (halluzinierte Daten)
          if (verdict.person || verdict.logo || verdict.text) {
            this.logger.info({ channel: channel.name, attempt, verdict }, 'v950 image policy violation — Bild verworfen');
            if (attempt === 0) continue; // ein Retry mit strengem Symbolmotiv
            return []; // zweiter Verstoß → Post ohne Bild
          }
        }

        let url: string | undefined;
        if (buffer && this.mediaDir) {
          const { writeFile, mkdir } = await import('node:fs/promises');
          const { join } = await import('node:path');
          await mkdir(this.mediaDir, { recursive: true });
          const file = join(this.mediaDir, `studio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
          await writeFile(file, buffer);
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
   * v936 — Wöchentlicher Nischen-Report (Lern-Loop sichtbar machen): fasst je
   * Kanal Bestperformer + Themen-Trends zusammen und legt EINEN stillen
   * Insights-Eintrag ab. @returns true wenn ein Report erzeugt wurde.
   */
  async weeklyNicheReport(): Promise<boolean> {
    if (!this.insightsRepo) return false;
    const channels = await this.socialRepo.listChannels(this.ownerUserId, 'active');
    if (channels.length === 0) return false;
    const sections: string[] = [];
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
