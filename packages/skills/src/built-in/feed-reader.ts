import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import type { SkillStateRepository } from '@alfred/storage';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { Skill } from '../skill.js';
import { effectiveUserId } from '../user-utils.js';

interface FeedEntry {
  url: string;
  label: string;
  lastCheckedAt: string | null;
  lastEntryId: string | null;
  /** Fallback: multiple identifiers for robust matching */
  lastEntryIds?: { guid?: string; link?: string; title?: string } | null;
}

export class FeedReaderSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'feed_reader',
    category: 'information',
    description: 'Subscribe to RSS/Atom feeds and check for new entries. Actions: subscribe, unsubscribe, list_feeds, check.',
    riskLevel: 'read',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['subscribe', 'unsubscribe', 'list_feeds', 'check', 'check_all'],
          description: 'The action to perform',
        },
        url: {
          type: 'string',
          description: 'Feed URL (for subscribe, unsubscribe, check)',
        },
        label: {
          type: 'string',
          description: 'Human-readable label for the feed (for subscribe)',
        },
      },
      required: ['action'],
    },
  };

  constructor(private readonly skillState: SkillStateRepository) {
    super();
  }

  async execute(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as string;
    const url = input.url as string | undefined;
    const userId = effectiveUserId(context);
    switch (action) {
      case 'subscribe':
        return this.subscribe(userId, url, input.label as string | undefined);
      case 'unsubscribe':
        return this.unsubscribe(userId, url);
      case 'list_feeds':
        return this.listFeeds(userId);
      case 'check':
      case 'check_all':
        return this.check(userId, url);
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  }

  private async subscribe(userId: string, url?: string, label?: string): Promise<SkillResult> {
    if (!url) return { success: false, error: 'URL is required for subscribe' };

    const entry: FeedEntry = {
      url,
      label: label ?? url,
      lastCheckedAt: null,
      lastEntryId: null,
    };
    await this.skillState.set(userId, 'feed_reader', `feed:${url}`, JSON.stringify(entry));
    return {
      success: true,
      data: entry,
      display: `Subscribed to feed: ${entry.label} (${url})`,
    };
  }

  private async unsubscribe(userId: string, url?: string): Promise<SkillResult> {
    if (!url) return { success: false, error: 'URL is required for unsubscribe' };

    const deleted = await this.skillState.delete(userId, 'feed_reader', `feed:${url}`);
    if (!deleted) return { success: false, error: `No subscription found for ${url}` };
    return { success: true, display: `Unsubscribed from feed: ${url}` };
  }

  private async listFeeds(userId: string): Promise<SkillResult> {
    const entries = await this.skillState.listBySkill(userId, 'feed_reader');
    const feeds = entries.map(e => {
      try { return JSON.parse(e.value) as FeedEntry; } catch { return null; }
    }).filter(Boolean) as FeedEntry[];

    if (feeds.length === 0) {
      return { success: true, data: [], display: 'No feed subscriptions found.' };
    }

    const lines = feeds.map(f => `• ${f.label} — ${f.url} (last checked: ${f.lastCheckedAt ?? 'never'})`);
    return {
      success: true,
      data: feeds,
      display: `Feed subscriptions:\n${lines.join('\n')}`,
    };
  }

  private async check(userId: string, url?: string): Promise<SkillResult> {
    if (!url) {
      // Check all feeds
      const entries = await this.skillState.listBySkill(userId, 'feed_reader');
      if (entries.length === 0) {
        return { success: true, data: { newCount: 0 }, display: 'No feed subscriptions to check.' };
      }
      let totalNew = 0;
      let successCount = 0;
      const results: Array<{ label: string; newCount: number; items: Array<{ title: string; link?: string; snippet?: string }> }> = [];
      const errors: string[] = [];
      for (const ent of entries) {
        try {
          const entry = JSON.parse(ent.value) as FeedEntry;
          const result = await this.checkSingleFeed(userId, entry);
          successCount++;
          if (result.newCount > 0) {
            totalNew += result.newCount;
            results.push(result);
          }
        } catch (err) {
          const label = (() => { try { return (JSON.parse(ent.value) as FeedEntry).label; } catch { return ent.key; } })();
          errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (errors.length > 0 && successCount === 0) {
        return { success: false, error: `All feeds failed: ${errors.join('; ')}` };
      }
      const lines = results.map(r => `${r.label}: ${r.newCount} new\n${r.items.map(i => `  • ${i.title}${i.link ? ` — ${i.link}` : ''}${i.snippet ? `\n    ${i.snippet}` : ''}`).join('\n')}`);
      return {
        success: true,
        data: { newCount: totalNew, feeds: results, errors: errors.length > 0 ? errors : undefined },
        display: totalNew > 0
          ? `${totalNew} new entries across ${results.length} feed(s):\n${lines.join('\n\n')}`
          : 'No new entries in any feed.',
      };
    }

    // Check single feed
    const stateValue = await this.skillState.get(userId, 'feed_reader', `feed:${url}`);
    if (!stateValue) return { success: false, error: `Not subscribed to ${url}. Use subscribe first.` };

    const entry = JSON.parse(stateValue) as FeedEntry;
    const result = await this.checkSingleFeed(userId, entry);
    const lines = result.items.map(i => `• ${i.title}${i.link ? ` — ${i.link}` : ''}${i.snippet ? `\n  ${i.snippet}` : ''}`);
    return {
      success: true,
      data: { newCount: result.newCount, items: result.items },
      display: result.newCount > 0
        ? `${result.newCount} new in ${result.label}:\n${lines.join('\n')}`
        : `No new entries in ${result.label}.`,
    };
  }

  private async checkSingleFeed(
    userId: string,
    entry: FeedEntry,
  ): Promise<{ label: string; newCount: number; items: Array<{ title: string; link?: string; pubDate?: string; snippet?: string }> }> {
    let RSSParser: any;
    try {
      RSSParser = (await import('rss-parser')).default;
    } catch {
      // ESM import fails in bundled context — fall back to createRequire
      // Resolve symlink (e.g. /usr/bin/alfred → .../bundle/index.js) for correct node_modules lookup
      const require = createRequire(realpathSync(process.argv[1] || ''));
      RSSParser = require('rss-parser');
    }
    const parser = new RSSParser({ timeout: 15_000 });
    const feed = await parser.parseURL(entry.url);

    const items = feed.items ?? [];
    let newItems: typeof items;

    if (entry.lastEntryId || entry.lastEntryIds) {
      // Try to find the last known item using multiple identifiers
      const lastIdx = this.findLastKnownIndex(items, entry);
      newItems = lastIdx > 0 ? items.slice(0, lastIdx) : lastIdx === 0 ? [] : this.fallbackByDate(items, entry.lastCheckedAt);
    } else {
      // First check — return up to 5 latest
      newItems = items.slice(0, 5);
    }

    // Update memory with latest entry identifiers (robust: store all available IDs)
    const top = items[0] as any;
    const latestId = top ? (top.guid ?? top.link ?? top.title ?? null) : null;
    const latestIds = top ? { guid: top.guid, link: top.link, title: top.title } : null;
    const updated: FeedEntry = {
      ...entry,
      lastCheckedAt: new Date().toISOString(),
      lastEntryId: latestId,
      lastEntryIds: latestIds,
    };
    await this.skillState.set(userId, 'feed_reader', `feed:${entry.url}`, JSON.stringify(updated));

    return {
      label: entry.label,
      newCount: newItems.length,
      items: newItems.map((i: any) => {
        // Extract snippet from contentSnippet, description, or content
        let snippet = (i.contentSnippet ?? i.summary ?? '') as string;
        if (!snippet && typeof i.content === 'string') {
          snippet = i.content.replace(/<[^>]*>/g, '').slice(0, 200);
        }
        return {
          title: i.title ?? '(untitled)',
          link: i.link,
          pubDate: i.pubDate,
          snippet: snippet ? snippet.slice(0, 200).trim() : undefined,
        };
      }),
    };
  }

  /**
   * Find the index of the last known item using multiple identification strategies:
   * 1. Composite match (guid + link + title)
   * 2. Legacy single-ID match (backward compat)
   * 3. Individual field matches (guid, link, title separately)
   * Returns -1 if not found.
   */
  private findLastKnownIndex(items: any[], entry: FeedEntry): number {
    const ids = entry.lastEntryIds;

    // Strategy 1: Match by any stored identifier field (most robust)
    if (ids) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        // guid match is strongest
        if (ids.guid && item.guid === ids.guid) return i;
        // link match (stable for most feeds)
        if (ids.link && item.link === ids.link) return i;
        // title match as last resort
        if (ids.title && item.title === ids.title) return i;
      }
    }

    // Strategy 2: Legacy single lastEntryId (backward compat with old feed entries)
    if (entry.lastEntryId) {
      const idx = items.findIndex((i: any) => (i.guid ?? i.link ?? i.title) === entry.lastEntryId);
      if (idx !== -1) return idx;
    }

    return -1; // Not found — will fall back to date-based filtering
  }

  /**
   * Fallback: filter items newer than lastCheckedAt.
   * If no date info available, return empty (no false positives).
   */
  private fallbackByDate(items: any[], lastCheckedAt: string | null): any[] {
    if (!lastCheckedAt) return items.slice(0, 5); // No date info → treat as first check

    const cutoff = new Date(lastCheckedAt).getTime();
    if (isNaN(cutoff)) return [];

    const newer = items.filter((i: any) => {
      const pub = i.pubDate ?? i.isoDate;
      if (!pub) return false;
      const pubTime = new Date(pub).getTime();
      return !isNaN(pubTime) && pubTime > cutoff;
    });

    // If no items have dates, return empty — better than false positives
    return newer;
  }
}
