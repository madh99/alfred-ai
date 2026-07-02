import type { Logger } from 'pino';
import type { InterestsRepository, InterestTopic } from '@alfred/storage';
import type { Skill, SkillRegistry, SkillSandbox } from '@alfred/skills';
import type { LLMProvider } from '@alfred/llm';

export interface ProvisionResult {
  rssAdded: string[];
  queriesAdded: string[];
}

/** Heuristik: sieht die URL nach einem Feed aus? (für die Vorauswahl aus Suchtreffern) */
export function looksLikeFeedUrl(url: string): boolean {
  return /(\/feed\/?$|\/rss\/?$|\.xml$|\/atom\/?$|feeds?\.|\/rss\.|\/feed\.|format=rss)/i.test(url);
}

/**
 * v930 — Source-Provisioner: bestückt ein (neues) Topic automatisch mit Quellen.
 *
 * 1. web_search „<thema> rss feed" → Kandidaten-URLs (Feed-Heuristik zuerst,
 *    optional LLM-Auswahl aus den Treffern)
 * 2. RSS-Kandidaten werden best-effort validiert (parseURL) — kaputte fliegen raus
 * 3. Zusätzlich 1–2 stehende web_search-Queries (Thema + Keywords)
 *
 * Alles added_by='auto' — der User sieht und verwaltet die Quellen in der UI.
 */
export class SourceProvisioner {
  constructor(
    private readonly repo: InterestsRepository,
    private readonly skillRegistry: Pick<SkillRegistry, 'get'> | undefined,
    private readonly skillSandbox: Pick<SkillSandbox, 'execute'> | undefined,
    private readonly llm: LLMProvider | undefined,
    private readonly logger: Logger,
    /** Testbar: RSS-Validierung injizierbar (default: rss-parser parseURL). */
    private readonly validateRss: (url: string) => Promise<boolean> = defaultValidateRss,
  ) {}

  async provision(topic: InterestTopic): Promise<ProvisionResult> {
    const result: ProvisionResult = { rssAdded: [], queriesAdded: [] };
    const existing = await this.repo.listSources(topic.id);
    const existingUrls = new Set(existing.map(s => String(s.config.url ?? s.config.query ?? '').toLowerCase()));

    // (1) RSS-Kandidaten via Web-Suche
    const candidates = await this.findRssCandidates(topic);
    for (const url of candidates.slice(0, 3)) {
      if (existingUrls.has(url.toLowerCase())) continue;
      const valid = await this.validateRss(url).catch(() => false);
      if (!valid) { this.logger.debug({ url }, 'v930 provisioner: rss candidate invalid, skipped'); continue; }
      await this.repo.addSource(topic.id, { kind: 'rss', config: { url }, addedBy: 'auto' });
      result.rssAdded.push(url);
    }

    // (2) 1–2 stehende Such-Queries (Thema selbst + engstes Keyword-Paar)
    const queries = [topic.name];
    if (topic.keywords.length >= 2) queries.push(`${topic.keywords.slice(0, 2).join(' ')} news`);
    for (const query of queries.slice(0, 2)) {
      if (existingUrls.has(query.toLowerCase())) continue;
      await this.repo.addSource(topic.id, { kind: 'web_search', config: { query }, addedBy: 'auto' });
      result.queriesAdded.push(query);
    }

    this.logger.info({ topic: topic.name, rss: result.rssAdded.length, queries: result.queriesAdded.length }, 'v930 sources provisioned');
    return result;
  }

  private async findRssCandidates(topic: InterestTopic): Promise<string[]> {
    if (!this.skillRegistry || !this.skillSandbox) return [];
    const skill = this.skillRegistry.get('web_search') as Skill | undefined;
    if (!skill) return [];
    let results: Array<{ title: string; url: string; snippet?: string }> = [];
    try {
      const r = await this.skillSandbox.execute(skill, { query: `${topic.name} rss feed`, count: 10 }, {
        userId: topic.userId, masterUserId: topic.userId, platform: 'api', chatId: 'source-provisioner',
      } as any);
      const raw = r.success ? (r.data as Record<string, unknown>)?.results : undefined;
      if (Array.isArray(raw)) {
        results = raw.filter((x: any) => typeof x?.url === 'string')
          .map((x: any) => ({ title: String(x.title ?? ''), url: String(x.url), snippet: typeof x.snippet === 'string' ? x.snippet : undefined }));
      }
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, topic: topic.name }, 'v930 provisioner: web_search failed');
      return [];
    }
    if (results.length === 0) return [];

    // Heuristik zuerst: URLs die nach Feed aussehen
    const heuristic = results.map(r => r.url).filter(looksLikeFeedUrl);
    if (heuristic.length >= 2 || !this.llm) return [...new Set(heuristic)];

    // Sonst LLM aus den Treffern wählen lassen (Seiten verlinken Feeds oft nur im Text)
    try {
      const prompt = `Suchtreffer für RSS-Feeds zum Thema "${topic.name}":
${results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}${r.snippet ? ` — ${r.snippet.slice(0, 120)}` : ''}`).join('\n')}

Gib als JSON-Array die 2-3 wahrscheinlichsten direkten RSS/Atom-Feed-URLs zurück (nur URLs die direkt ein Feed sind, keine HTML-Seiten). Nur das JSON-Array, sonst nichts. Beispiel: ["https://example.com/feed.xml"]`;
      const response = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 300, tier: 'fast' });
      const match = response.content?.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) {
          const urls = parsed.filter((u: unknown): u is string => typeof u === 'string' && u.startsWith('http'));
          return [...new Set([...heuristic, ...urls])];
        }
      }
    } catch { /* Heuristik-Ergebnis reicht */ }
    return [...new Set(heuristic)];
  }
}

async function defaultValidateRss(url: string): Promise<boolean> {
  try {
    let RSSParser: any;
    try {
      RSSParser = (await import('rss-parser')).default;
    } catch {
      // Bundled context (externalisierte Dep) — createRequire relativ zum Bundle
      const { createRequire } = await import('node:module');
      const { realpathSync } = await import('node:fs');
      RSSParser = createRequire(realpathSync(process.argv[1] || ''))('rss-parser');
    }
    const parser = new RSSParser({ timeout: 10_000 });
    const feed = await parser.parseURL(url);
    return Array.isArray(feed.items);
  } catch {
    return false;
  }
}
