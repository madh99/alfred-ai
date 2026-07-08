import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import type { Logger } from 'pino';
import type { InterestsRepository, InterestTopic, TopicSource } from '@alfred/storage';
import { topicItemDedupeHash } from '@alfred/storage';
import type { AsyncDbAdapter } from '@alfred/storage';
import type { Skill, SkillRegistry, SkillSandbox } from '@alfred/skills';
import { resolveYoutubeChannel, fetchYoutubeChannelVideos, fetchYoutubeTranscriptSegments, extractYoutubeVideoId } from '@alfred/skills';
import type { LLMProvider } from '@alfred/llm';

export interface CollectedRawItem {
  title: string;
  url?: string;
  summary?: string;
  publishedAt?: string;
}

/**
 * v929 — Relevanz eines Items zu den Topic-Keywords (0..1):
 * Anteil der Keywords, die in Titel+Summary vorkommen. Ohne Keywords undefined
 * (alles aus Topic-Quellen gilt als themenbezogen).
 */
export function keywordImportance(topic: Pick<InterestTopic, 'keywords'>, item: CollectedRawItem): number | undefined {
  if (!topic.keywords || topic.keywords.length === 0) return undefined;
  const haystack = `${item.title} ${item.summary ?? ''}`.toLowerCase();
  const hits = topic.keywords.filter(k => k.trim().length > 0 && haystack.includes(k.toLowerCase())).length;
  return Math.round((hits / topic.keywords.length) * 100) / 100;
}

/**
 * v929 — Interessen-Radar-Collector (Kern des „Stiller Sammler"-Konzepts).
 *
 * Läuft stündlich (HA-dedupliziert per Slot `topic-collect:<stunde>`), holt für
 * jedes aktive Topic alle enabled Quellen (RSS via rss-parser, web_search via
 * Skill) und legt neue Items dedupliziert (URL/Titel-Hash) in topic_items ab.
 * SENDET NICHTS — Abruf erfolgt on-demand (interests topic_briefing) bzw. ab
 * v930 über den Digest-Builder + Notification-Router.
 */
export class TopicCollector {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly repo: InterestsRepository,
    private readonly skillRegistry: Pick<SkillRegistry, 'get'> | undefined,
    private readonly skillSandbox: Pick<SkillSandbox, 'execute'> | undefined,
    private readonly logger: Logger,
    private readonly opts: {
      /** PG-Adapter für den HA-Slot (reasoning_slots); SQLite/Single-Node → kein Slot nötig. */
      dbAdapter?: AsyncDbAdapter;
      nodeId?: string;
      intervalMs?: number;
      /** v1048 — YouTube-Quellen: offizieller Data-API-Key (ohne Key nur RSS-Fallback mit UC-ID). */
      youtubeApiKey?: string;
      /** v1048 — fast-Tier-LLM für die Transcript-Verdichtung (optional). */
      llm?: Pick<LLMProvider, 'complete'>;
      /** v1048 — nur für Tests: YouTube-Zugriffe injizierbar. */
      youtubeFetchers?: {
        resolveChannel: typeof resolveYoutubeChannel;
        fetchChannelVideos: typeof fetchYoutubeChannelVideos;
        fetchTranscript: typeof fetchYoutubeTranscriptSegments;
      };
    } = {},
  ) {}

  /** v1048 — Kanalname→ID-Cache über Läufe hinweg (Quota-Schonung wie im Skill). */
  private readonly youtubeChannelCache = new Map<string, string>();

  start(): void {
    if (this.timer) return;
    const interval = this.opts.intervalMs ?? 60 * 60_000;
    this.timer = setInterval(() => { void this.tick(); }, interval);
    this.logger.info({ intervalMs: interval }, 'v929 topic collector started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    // HA-Dedup: nur ein Node pro Stunde sammelt
    const hourSlot = new Date().toISOString().slice(0, 13);
    if (this.opts.dbAdapter?.type === 'postgres') {
      try {
        const r = await this.opts.dbAdapter.execute(
          'INSERT INTO reasoning_slots (slot_key, node_id, claimed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
          [`topic-collect:${hourSlot}`, this.opts.nodeId ?? 'single', new Date().toISOString()],
        );
        if ((r.changes ?? 0) === 0) return;
      } catch { /* Tabelle fehlt evtl. noch → trotzdem sammeln */ }
    }
    await this.collectAll();
  }

  /** Sammelt alle aktiven Topics (aller User). @returns Anzahl neuer Items gesamt. */
  async collectAll(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let total = 0;
    try {
      const topics = await this.repo.listAllActiveTopics();
      for (const topic of topics) {
        try {
          total += await this.collectTopic(topic);
        } catch (err) {
          this.logger.warn({ err, topic: topic.name }, 'v929 topic collect failed');
        }
      }
      if (topics.length > 0) {
        this.logger.info({ topics: topics.length, newItems: total }, 'v929 topic collect pass done');
      }
    } finally {
      this.running = false;
    }
    return total;
  }

  /** Sammelt EIN Topic über alle enabled Quellen. @returns Anzahl neuer Items. */
  async collectTopic(topic: InterestTopic): Promise<number> {
    const sources = await this.repo.listSources(topic.id, true);
    let inserted = 0;
    for (const source of sources) {
      let items: CollectedRawItem[] = [];
      try {
        items = source.kind === 'rss'
          ? await this.fetchRss(source)
          : source.kind === 'youtube'
            ? await this.fetchYoutube(topic, source)
            : await this.fetchWebSearch(topic, source);
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, topic: topic.name, kind: source.kind }, 'v929 source fetch failed');
        continue;
      }
      // v990 — Quellen-Exclude-Filter: config.exclude_keywords hält Fremdthemen
      // aus den Topic-Items (Realfall: ORF-Sport-Feed spülte Formel 1/Radsport
      // in die Fußball-Kanäle). Substring-Match auf Titel+Summary, kleingeschrieben.
      const excludes = Array.isArray(source.config.exclude_keywords)
        ? (source.config.exclude_keywords as unknown[])
          .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
          .map(k => k.toLowerCase())
        : [];
      for (const item of items) {
        if (!item.title || item.title.trim().length === 0) continue;
        if (excludes.length > 0) {
          const hay = `${item.title} ${item.summary ?? ''}`.toLowerCase();
          if (excludes.some(k => hay.includes(k))) continue;
        }
        const r = await this.repo.insertItem(topic.id, {
          title: item.title,
          url: item.url,
          summary: item.summary,
          // v975 — Quellen mit config.events=true (z.B. Termin-Feeds wie
          // Public-Viewing) stempeln ihre Items als 'events': das Studio-
          // Dossier führt sie als eigene Termin-Sektion statt im News-Strom,
          // wo jeder Collector-Lauf sie aus den Top-8 verdrängt hat.
          sourceKind: source.config.events === true ? 'events' : source.kind,
          publishedAt: item.publishedAt,
          importance: keywordImportance(topic, item),
        });
        if (r.inserted) inserted++;
      }
      await this.repo.markSourceChecked(source.id).catch(() => { /* non-critical */ });
    }
    if (inserted > 0) await this.repo.touchActivity(topic.id).catch(() => { /* non-critical */ });
    return inserted;
  }

  private async fetchRss(source: TopicSource): Promise<CollectedRawItem[]> {
    const url = typeof source.config.url === 'string' ? source.config.url : '';
    if (!url) return [];
    let RSSParser: any;
    try {
      RSSParser = (await import('rss-parser')).default;
    } catch {
      // Bundled context (externalisierte Dep) — createRequire relativ zum Bundle
      const require = createRequire(realpathSync(process.argv[1] || ''));
      RSSParser = require('rss-parser');
    }
    const parser = new RSSParser({ timeout: 15_000 });
    const feed = await parser.parseURL(url);
    return (feed.items ?? []).slice(0, 20).map((i: any) => {
      let snippet = (i.contentSnippet ?? i.summary ?? '') as string;
      if (!snippet && typeof i.content === 'string') snippet = i.content.replace(/<[^>]*>/g, '');
      return {
        title: String(i.title ?? '').trim(),
        url: typeof i.link === 'string' ? i.link : undefined,
        summary: snippet ? snippet.slice(0, 500) : undefined,
        publishedAt: i.isoDate ?? i.pubDate ?? undefined,
      };
    });
  }

  /**
   * v1048 — Quellart `youtube`: neueste Videos eines Kanals als Themen-Stoff.
   * Discovery über die offizielle Data-API (derselbe Codepfad wie der
   * YouTube-Skill: Handle-/Namens-Auflösung mit Quota-Cache, aufgelöste ID
   * wird in der Quell-Config persistiert); für NEUE Videos wird das Transcript
   * gezogen und per fast-LLM zu einer Fakten-Summary verdichtet — Transcripts
   * sind FAKTEN-Quelle, die Video-URL bleibt als Beleg am Item. Ohne API-Key
   * greift ein RSS-Fallback (braucht eine UC-Channel-ID).
   *
   * Config: { channel: "@handle" | Kanal-URL | UC-ID | Name, max_videos?: 1-10,
   *           language?: "de", transcript?: true, summarize?: true,
   *           exclude_keywords?: [...] (generischer Filter greift) }
   */
  private async fetchYoutube(topic: InterestTopic, source: TopicSource): Promise<CollectedRawItem[]> {
    const cfg = source.config;
    const channel = typeof cfg.channel === 'string' ? cfg.channel.trim() : '';
    if (!channel) return [];
    const max = typeof cfg.max_videos === 'number' && cfg.max_videos >= 1 ? Math.min(cfg.max_videos, 10) : 5;
    const lang = typeof cfg.language === 'string' && cfg.language.trim() ? cfg.language.trim() : 'de';
    const f = this.opts.youtubeFetchers ?? {
      resolveChannel: resolveYoutubeChannel,
      fetchChannelVideos: fetchYoutubeChannelVideos,
      fetchTranscript: fetchYoutubeTranscriptSegments,
    };
    const apiKey = this.opts.youtubeApiKey;

    let videos: Array<{ videoId: string; title: string; url: string; publishedAt?: string; description?: string }>;
    if (apiKey) {
      let channelId = typeof cfg.channel_id_cached === 'string' && cfg.channel_id_cached ? cfg.channel_id_cached : undefined;
      if (!channelId) {
        channelId = /^UC[\w-]{22}$/.test(channel)
          ? channel
          : await f.resolveChannel(apiKey, { channelName: channel }, this.youtubeChannelCache);
        if (channelId) {
          // aufgelöste ID persistieren — spart die Auflösung (bis zu 100 Quota-Units) je Lauf
          await this.repo.updateSourceConfig(source.id, { ...cfg, channel_id_cached: channelId }).catch(() => { /* non-critical */ });
        }
      }
      if (!channelId) throw new Error(`YouTube-Kanal nicht auflösbar: ${channel}`);
      const r = await f.fetchChannelVideos(apiKey, channelId, max);
      if ('error' in r) throw new Error(r.error);
      videos = r.videos;
    } else {
      // RSS-Fallback ohne API-Key: offizieller Kanal-Feed, braucht die UC-ID
      const uc = /(UC[\w-]{22})/.exec(channel)?.[1]
        ?? (typeof cfg.channel_id_cached === 'string' ? /(UC[\w-]{22})/.exec(cfg.channel_id_cached)?.[1] : undefined);
      if (!uc) throw new Error('YouTube-Quelle ohne API-Key braucht eine Channel-ID (UC…) — config.youtube.apiKey setzen oder UC-ID angeben');
      const feedItems = await this.fetchRss({ ...source, config: { url: `https://www.youtube.com/feeds/videos.xml?channel_id=${uc}` } } as TopicSource);
      videos = feedItems.slice(0, max).flatMap(i => {
        const vid = extractYoutubeVideoId(i.url);
        return vid ? [{ videoId: vid, title: i.title, url: i.url!, publishedAt: i.publishedAt, description: i.summary }] : [];
      });
    }

    const out: CollectedRawItem[] = [];
    for (const v of videos) {
      if (!v.title || !v.videoId) continue;
      // v1052 — KANONISCHE youtu.be-URL: der Dedupe-Hash strippt Query-Parameter
      // (gewollt gegen ?ref=-Tracking) — bei watch?v=… steckt die Video-Identität
      // aber GENAU dort, alle Videos kollabierten auf einen Hash und nur das
      // erste je Topic wurde eingesammelt (Realfall 08.07.: ServusTV/kicker 5→1,
      // FIFA/Sky 0). youtu.be/<id> trägt die Identität im Pfad.
      const url = `https://youtu.be/${v.videoId}`;
      // Precheck über den Dedupe-Hash: Transcript-Fetch + LLM-Verdichtung
      // NUR für Videos, die noch nicht in topic_items liegen
      if (await this.repo.itemExists(topic.id, topicItemDedupeHash({ url, title: v.title }))) continue;
      let summary = (v.description ?? '').trim() || undefined;
      if (cfg.transcript !== false) {
        const segments = await f.fetchTranscript(v.videoId, lang).catch(() => null);
        const text = segments?.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
        if (text && text.length > 100) {
          summary = cfg.summarize !== false && this.opts.llm
            ? await this.condenseTranscript(v.title, text).catch(() => text.slice(0, 1500))
            : text.slice(0, 1500);
        }
      }
      out.push({ title: v.title, url, summary, publishedAt: v.publishedAt });
    }
    if (out.length > 0) this.logger.info({ topic: topic.name, channel, videos: out.length }, 'v1048 youtube source collected');
    return out;
  }

  /** v1048 — Transcript zu einer reinen Fakten-Summary verdichten (fast-Tier, 1 Call je NEUEM Video). */
  private async condenseTranscript(title: string, text: string): Promise<string> {
    const response = await this.opts.llm!.complete({
      messages: [{
        role: 'user',
        content: `Fasse das Transcript des Videos "${title}" als reine FAKTEN-Zusammenfassung zusammen (5-8 Sätze, max. 900 Zeichen): Ergebnisse, Namen, Zahlen, Kernaussagen sinngemäß. KEINE Bewertung, KEINE Meta-Kommentare, KEIN „Das Video zeigt". Antworte NUR mit der Zusammenfassung auf Deutsch.\n\nTRANSCRIPT:\n${text.slice(0, 12_000)}`,
      }],
      maxTokens: 600,
      tier: 'fast',
      reasoningEffort: 'low',
    });
    // v1051 — Meta-Kopfzeilen strippen (Realfall: „# Zusammenfassung: …"-
    // Überschrift trotz „NUR mit der Zusammenfassung"-Regel)
    const s = (response.content ?? '').trim()
      .replace(/^#{1,6}\s*[^\n]*\n+/, '')
      .replace(/^zusammenfassung:?\s*/i, '')
      .trim();
    if (s.length < 30) throw new Error('Verdichtung leer');
    return s.slice(0, 1000);
  }

  private async fetchWebSearch(topic: InterestTopic, source: TopicSource): Promise<CollectedRawItem[]> {
    if (!this.skillRegistry || !this.skillSandbox) return [];
    const skill = this.skillRegistry.get('web_search') as Skill | undefined;
    if (!skill) return [];
    const query = typeof source.config.query === 'string' && source.config.query.trim().length > 0
      ? source.config.query
      : topic.name;
    const result = await this.skillSandbox.execute(skill, { query, count: 5 }, {
      userId: topic.userId, masterUserId: topic.userId, platform: 'api', chatId: 'topic-collector',
    } as any);
    if (!result.success || !result.data) return [];
    // web_search liefert results: [{title, url, description}] (tolerant lesen)
    const raw = (result.data as Record<string, unknown>).results ?? result.data;
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 5).map((r: any) => ({
      title: String(r.title ?? '').trim(),
      url: typeof r.url === 'string' ? r.url : (typeof r.link === 'string' ? r.link : undefined),
      summary: typeof r.description === 'string' ? r.description.slice(0, 500)
        : (typeof r.snippet === 'string' ? r.snippet.slice(0, 500) : undefined),
    })).filter(i => i.title.length > 0);
  }
}
