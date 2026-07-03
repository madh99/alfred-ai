import type { Logger } from 'pino';
import type {
  SocialRepository, SocialChannel, ContentItem,
  InterestsRepository, InsightsRepository,
} from '@alfred/storage';
import type { LLMProvider } from '@alfred/llm';
import type { Skill, SkillRegistry, SkillSandbox } from '@alfred/skills';
import type { SourceProvisioner } from './source-provisioner.js';

const WEEKDAYS: Record<string, number> = { so: 0, mo: 1, di: 2, mi: 3, do: 4, fr: 5, sa: 6 };

/**
 * v935 — Nächste freie Posting-Slots eines Kanals (pure, testbar).
 * Slots wie ["Mo 18:00", "Do 19:30"]; ohne Slots: Mo/Mi/Fr 18:00.
 * Belegte Zeitpunkte (bestehende geplante Items) werden übersprungen.
 */
export function nextFreeSlots(
  channel: Pick<SocialChannel, 'postingSlots' | 'planningHorizonDays'>,
  taken: Array<Pick<ContentItem, 'scheduledAt'>>,
  count: number,
  fromIso: string,
): string[] {
  const slotDefs = (channel.postingSlots.length > 0 ? channel.postingSlots : ['Mo 18:00', 'Mi 18:00', 'Fr 18:00'])
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
      if (date.getUTCDay() !== slot.weekday) continue;
      const at = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), slot.hour, slot.minute));
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

/**
 * v957 — deterministischer Doppelungs-Check über Kanalgrenzen (Muster v924):
 * Tokens ≥4 Zeichen, Duplikat bei ≥3 gemeinsamen ODER ≥60% Überlappung.
 * Realfall: „Alaba lässt Zukunft im Nationalteam offen" erschien wortgleich
 * auf Telegram UND fussball.cc — die Prompt-Regel allein hielt nicht.
 */
export function isNearDuplicateTitle(candidate: string, existingTitles: string[]): boolean {
  const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-zä-ü0-9]+/i).filter(t => t.length >= 4));
  const cand = tokens(candidate);
  if (cand.size === 0) return false;
  for (const existing of existingTitles) {
    const ex = tokens(existing);
    if (ex.size === 0) continue;
    let common = 0;
    for (const t of cand) if (ex.has(t)) common++;
    const overlap = common / Math.min(cand.size, ex.size);
    if (common >= 3 || (overlap >= 0.6 && common >= 2)) return true;
  }
  return false;
}

interface GeneratedIdea {
  title: string;
  body: string;
  hashtags: string[];
  warum: string;
  /** v941 — Bildvorschlag als eigenes Feld (wird NIE mitgepostet; dient als Prompt für image_generate). */
  bildidee?: string;
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
export function parseIdeas(text: string): GeneratedIdea[] {
  const match = text?.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((i: any) => i && typeof i.body === 'string' && i.body.trim().length > 10)
      .map((i: any) => ({
        title: typeof i.title === 'string' ? decodeHtmlEntities(i.title).slice(0, 200) : '',
        body: stripMetaLines(decodeHtmlEntities(String(i.body)).slice(0, 8000)),
        hashtags: Array.isArray(i.hashtags) ? i.hashtags.map(String).slice(0, 10)
          : Array.isArray(i.tags) ? i.tags.map(String).slice(0, 10) : [],
        warum: typeof i.warum === 'string' ? i.warum.slice(0, 300) : '',
        bildidee: typeof i.bildidee === 'string' && i.bildidee.trim().length > 0 ? i.bildidee.slice(0, 400)
          : typeof i.image_idea === 'string' && i.image_idea.trim().length > 0 ? i.image_idea.slice(0, 400) : undefined,
      }))
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
  ) {}

  /** Täglicher Lauf über alle aktiven Kanäle. @returns Anzahl erzeugter Items. */
  async runDaily(): Promise<number> {
    const channels = await this.socialRepo.listChannels(this.ownerUserId, 'active');
    let created = 0;
    for (const channel of channels) {
      try {
        created += await this.fillChannel(channel);
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, channel: channel.name }, 'v935 studio channel failed');
      }
    }
    if (created > 0) this.logger.info({ created, channels: channels.length }, 'v935 studio pass done');
    return created;
  }

  /** Füllt einen Kanal bis zum Planungshorizont. */
  async fillChannel(channel: SocialChannel): Promise<number> {
    await this.ensureTopic(channel);

    const now = new Date().toISOString();
    const planned = await this.socialRepo.listItems(this.ownerUserId, {
      channelId: channel.id, status: ['scheduled', 'approved', 'draft', 'idea'], limit: 100,
    });
    const slots = nextFreeSlots(channel, planned, Math.max(0, 10 - planned.length), now);
    // Entwürfe/Ideen ohne Termin zählen als Vorrat — nicht doppelt erzeugen
    const backlog = planned.filter(i => (i.status === 'draft' || i.status === 'idea') && !i.scheduledAt).length;
    const needed = Math.max(0, slots.length - backlog);
    if (needed === 0) return 0;

    const family = await this.familyContext(channel);
    let ideas = await this.generateIdeas(channel, needed, family.block);
    if (ideas.length === 0) return 0;

    // v957 — deterministische Doppelungs-Sperre über Kanalgrenzen: Ideen, deren
    // Titel einem geplanten/veröffentlichten Beitrag des Kanals ODER eines
    // Geschwister-Kanals zu ähnlich ist, werden verworfen (Prompt-Regel reicht nicht).
    const blockedTitles = [
      ...planned.map(i => i.title ?? i.body.slice(0, 60)),
      ...family.siblingTitles,
    ];
    const before = ideas.length;
    ideas = ideas.filter(idea => !isNearDuplicateTitle(idea.title || idea.body.slice(0, 60), blockedTitles));
    if (ideas.length < before) {
      this.logger.info({ channel: channel.name, dropped: before - ideas.length }, 'v957 near-duplicate ideas dropped (family dedup)');
    }
    if (ideas.length === 0) return 0;

    const isYoutube = channel.platform === 'youtube';
    let created = 0;
    const createdTitles: string[] = [];
    for (let i = 0; i < ideas.length && i < needed; i++) {
      const idea = ideas[i];
      const media = await this.maybeGenerateImage(channel, idea);
      const item = await this.socialRepo.createItem(this.ownerUserId, channel.id, {
        status: 'draft',
        title: idea.title || undefined,
        body: idea.body,
        hashtags: idea.hashtags,
        media,
        source: 'studio',
      });
      await this.socialRepo.mergePerformance(this.ownerUserId, item.id, { warum: idea.warum });
      if (channel.mode === 'approve' || channel.mode === 'autonomous') {
        const slot = slots[created];
        if (slot) await this.socialRepo.transition(this.ownerUserId, item.id, 'scheduled', { scheduledAt: slot });
      }
      createdTitles.push(idea.title || idea.body.slice(0, 60));
      created++;
    }

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

  // ── Wissens-Kontext + Ideen ───────────────────────────────────────────

  private async generateIdeas(channel: SocialChannel, count: number, familyBlock: string): Promise<GeneratedIdea[]> {
    const [dossier, bestPerformers, recentTitles] = await Promise.all([
      this.topicDossier(channel),
      this.bestPerformers(channel),
      this.recentPublishedTitles(channel),
    ]);

    const isYoutube = channel.platform === 'youtube';
    const prompt = (isYoutube
      ? this.buildYoutubePrompt(channel, count, dossier, bestPerformers, recentTitles)
      : this.buildPostPrompt(channel, count, dossier, bestPerformers, recentTitles))
      + familyBlock;

    const response = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 3000, tier: 'fast' });
    return parseIdeas(response.content ?? '');
  }

  /**
   * v954 — Kanal-Familien-Koordination: Geschwister-Kanäle derselben Familie
   * (gleiches Projekt oder config.family) werden mit Rolle und deren
   * geplanten/kürzlichen Titeln in den Prompt gegeben — der Kanal spielt
   * seine ROLLE statt denselben Stoff zu doppeln; Cross-Verweise erwünscht,
   * bewusstes Verteilen läuft weiter über crosspost.
   */
  private async familyContext(channel: SocialChannel): Promise<{ block: string; siblingTitles: string[] }> {
    const family = ContentStudio.familyKey(channel);
    if (!family) return { block: '', siblingTitles: [] };
    try {
      const siblings = (await this.socialRepo.listChannels(this.ownerUserId))
        .filter(c => c.id !== channel.id && c.status !== 'archived' && ContentStudio.familyKey(c) === family);
      if (siblings.length === 0) return { block: '', siblingTitles: [] };
      const sections: string[] = [];
      const siblingTitles: string[] = [];
      for (const sibling of siblings) {
        const items = await this.socialRepo.listItems(this.ownerUserId, {
          channelId: sibling.id, status: ['scheduled', 'approved', 'published'], limit: 15,
        });
        const titles = items.map(i => (i.title ?? i.body.slice(0, 60))).slice(0, 15);
        siblingTitles.push(...titles);
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
      return { block, siblingTitles };
    } catch { return { block: '', siblingTitles: [] }; }
  }

  private buildPostPrompt(channel: SocialChannel, count: number, dossier: string, best: string, recent: string[]): string {
    return `Du bist Content-Redakteur für den Social-Kanal "${channel.name}" (${channel.platform}).
${channel.persona ? `Persona/Tonalität: ${channel.persona}\n` : ''}${dossier ? `\nAktuelles Themen-Dossier:\n${dossier}\n` : ''}${best ? `\nWas zuletzt gut funktioniert hat:\n${best}\n` : ''}${recent.length ? `\nBEREITS VERÖFFENTLICHT (nicht wiederholen):\n${recent.map(t => `- ${t}`).join('\n')}\n` : ''}
Erzeuge ${count} veröffentlichungsfertige Posts. Regeln:
- FAKTEN-TREUE (zwingend): Turnier-/Event-Namen, Jahreszahlen, Ergebnisse und Personalien NUR aus dem Dossier oben übernehmen — NIEMALS aus dem Trainingswissen raten. Steht im Dossier „WM", schreibe WM (nicht EM/EURO); auch in Hashtags. Ist ein Fakt nicht im Dossier belegt, lass ihn weg.
${this.lessonsBlock(channel)}- Deutsch, zur Persona passend, konkret statt generisch, kein Clickbait.
- body = VOLLWERTIGER Beitrag mit 4-8 Sätzen und eigenem Mehrwert (Einordnung, Details, Frage an die Community) — NIEMALS nur Schlagzeile plus ein Satz. Dossier-Beiträge sind Rohstoff, kein Abschreibmaterial.
- Jeder Post eigenständig; Bezug zu aktuellen Dossier-Themen wo sinnvoll.
- 3-6 Hashtags je Post.
- body = NUR der fertige Post-Text. KEINE Meta-Zeilen wie "Bildidee:", Regieanweisungen oder Platzhalter — ein Bildvorschlag gehört ausschließlich ins separate Feld "bildidee".
${channel.blacklist.length ? `- TABU (niemals erwähnen): ${channel.blacklist.join(', ')}\n` : ''}
Antworte NUR mit einem JSON-Array:
[{"title": "kurzer Titel", "body": "der Post-Text", "hashtags": ["…"], "warum": "1 Satz warum jetzt", "bildidee": "optional: Bildvorschlag für dieses Posting"}]`;
  }

  private buildYoutubePrompt(channel: SocialChannel, count: number, dossier: string, best: string, recent: string[]): string {
    return `Du planst Videos für den YouTube-Kanal "${channel.name}".
${channel.persona ? `Persona/Stil: ${channel.persona}\n` : ''}${dossier ? `\nAktuelles Themen-Dossier:\n${dossier}\n` : ''}${best ? `\nWas zuletzt gut funktioniert hat:\n${best}\n` : ''}${recent.length ? `\nBEREITS PRODUZIERT (nicht wiederholen):\n${recent.map(t => `- ${t}`).join('\n')}\n` : ''}
Erzeuge ${count} komplette Video-Konzepte. Das body-Feld MUSS enthalten:
HOOK (erste 15 Sekunden), dann SCRIPT mit Kapitel-Überschriften und Sprechtext,
dann eine Zeile "---" und darunter BESCHREIBUNG (YouTube-Description mit Kapitelmarken).
Der User kann das Video selbst drehen (Script ablesen) oder Alfred Material geben.
FAKTEN-TREUE (zwingend): Turnier-/Event-Namen, Jahreszahlen und Fakten NUR aus dem Dossier — niemals aus dem Trainingswissen raten (WM bleibt WM, nicht EM); auch in Tags.
${this.lessonsBlock(channel)}Ein Thumbnail-Vorschlag gehört NICHT in den body, sondern ins separate Feld "bildidee".
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

  private async topicDossier(channel: SocialChannel): Promise<string> {
    if (!this.interestsRepo) return '';
    const topicIds = ContentStudio.linkedTopicIds(channel);
    if (topicIds.length === 0) return '';
    const sections: string[] = [];
    for (const topicId of topicIds) {
      try {
        const [topic, digest, items] = await Promise.all([
          this.interestsRepo.getTopicById(this.ownerUserId, topicId),
          this.interestsRepo.getDigest(topicId),
          this.interestsRepo.listItems(topicId, { limit: 8 }),
        ]);
        const itemLines = items.map(i => `- ${i.title}`).join('\n');
        const body = `${digest?.summary ?? ''}${itemLines ? `\nNeueste Beiträge:\n${itemLines}` : ''}`.trim();
        if (body) sections.push(topicIds.length > 1 ? `### Thema „${topic?.name ?? topicId.slice(0, 8)}"\n${body}` : body);
      } catch { /* einzelnes Topic überspringen */ }
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

  private async recentPublishedTitles(channel: SocialChannel): Promise<string[]> {
    const published = await this.socialRepo.listItems(this.ownerUserId, {
      channelId: channel.id, status: 'published', limit: 15,
    });
    return published.map(i => (i.title ?? i.body).slice(0, 80));
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
        resolveImagePolicy, extractNameCandidates, scrubMotif,
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

      // v950 Schicht 1+3 — bis zu 2 Versuche: normal → Vision-Verstoß → strenges Symbolmotiv
      for (let attempt = 0; attempt < 2; attempt++) {
        const prompt = attempt === 0
          ? buildSafeImagePrompt(motif, channel.persona, policy)
          : strictRetryPrompt(channel.persona);
        const result = await this.skillSandbox.execute(skill, { prompt },
          { userId: this.ownerUserId, masterUserId: this.ownerUserId, platform: 'api', chatId: 'content-studio' } as never);
        if (!result.success) return [];

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
          if (verdict.person || verdict.logo) {
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
        const today = new Date().toISOString().slice(0, 10);
        const todayUsed = (await this.socialRepo.listMetrics(channel.id, { kind: 'gen_image', sinceDate: today }))
          .find(m => m.date === today && !m.itemId)?.value ?? 0;
        await this.socialRepo.upsertMetric(channel.id, { date: today, kind: 'gen_image', value: todayUsed + 1 });
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
