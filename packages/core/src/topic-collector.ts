import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import type { Logger } from 'pino';
import type { InterestsRepository, InterestTopic, TopicSource } from '@alfred/storage';
import type { AsyncDbAdapter } from '@alfred/storage';
import type { Skill, SkillRegistry, SkillSandbox } from '@alfred/skills';

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
    } = {},
  ) {}

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
          : await this.fetchWebSearch(topic, source);
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, topic: topic.name, kind: source.kind }, 'v929 source fetch failed');
        continue;
      }
      for (const item of items) {
        if (!item.title || item.title.trim().length === 0) continue;
        const r = await this.repo.insertItem(topic.id, {
          title: item.title,
          url: item.url,
          summary: item.summary,
          sourceKind: source.kind,
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
