import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import type { MemoryRepository } from '@alfred/storage';
import { Skill } from '../skill.js';

interface FeedEntry {
  url: string;
  label: string;
  lastCheckedAt: string | null;
  lastEntryId: string | null;
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
          enum: ['subscribe', 'unsubscribe', 'list_feeds', 'check'],
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

  constructor(private readonly memoryRepo: MemoryRepository) {
    super();
  }

  async execute(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as string;
    const url = input.url as string | undefined;
    const userId = context.userId;

    switch (action) {
      case 'subscribe':
        return this.subscribe(userId, url, input.label as string | undefined);
      case 'unsubscribe':
        return this.unsubscribe(userId, url);
      case 'list_feeds':
        return this.listFeeds(userId);
      case 'check':
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
    this.memoryRepo.save(userId, `feed:${url}`, JSON.stringify(entry), 'feed');
    return {
      success: true,
      data: entry,
      display: `Subscribed to feed: ${entry.label} (${url})`,
    };
  }

  private async unsubscribe(userId: string, url?: string): Promise<SkillResult> {
    if (!url) return { success: false, error: 'URL is required for unsubscribe' };

    const deleted = this.memoryRepo.delete(userId, `feed:${url}`);
    if (!deleted) return { success: false, error: `No subscription found for ${url}` };
    return { success: true, display: `Unsubscribed from feed: ${url}` };
  }

  private async listFeeds(userId: string): Promise<SkillResult> {
    const memories = this.memoryRepo.listByCategory(userId, 'feed');
    const feeds = memories.map(m => {
      try { return JSON.parse(m.value) as FeedEntry; } catch { return null; }
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
      const memories = this.memoryRepo.listByCategory(userId, 'feed');
      if (memories.length === 0) {
        return { success: true, data: { newCount: 0 }, display: 'No feed subscriptions to check.' };
      }
      let totalNew = 0;
      const results: Array<{ label: string; newCount: number; items: Array<{ title: string; link?: string }> }> = [];
      for (const mem of memories) {
        try {
          const entry = JSON.parse(mem.value) as FeedEntry;
          const result = await this.checkSingleFeed(userId, entry);
          if (result.newCount > 0) {
            totalNew += result.newCount;
            results.push(result);
          }
        } catch { /* skip broken entries */ }
      }
      const lines = results.map(r => `${r.label}: ${r.newCount} new\n${r.items.map(i => `  • ${i.title}`).join('\n')}`);
      return {
        success: true,
        data: { newCount: totalNew, feeds: results },
        display: totalNew > 0
          ? `${totalNew} new entries across ${results.length} feed(s):\n${lines.join('\n\n')}`
          : 'No new entries in any feed.',
      };
    }

    // Check single feed
    const mem = this.memoryRepo.listByCategory(userId, 'feed')
      .find(m => m.key === `feed:${url}`);
    if (!mem) return { success: false, error: `Not subscribed to ${url}. Use subscribe first.` };

    const entry = JSON.parse(mem.value) as FeedEntry;
    const result = await this.checkSingleFeed(userId, entry);
    const lines = result.items.map(i => `• ${i.title}${i.link ? ` — ${i.link}` : ''}`);
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
  ): Promise<{ label: string; newCount: number; items: Array<{ title: string; link?: string; pubDate?: string }> }> {
    const RSSParser = (await import('rss-parser')).default;
    const parser = new RSSParser({ timeout: 15_000 });
    const feed = await parser.parseURL(entry.url);

    const items = feed.items ?? [];
    let newItems: typeof items;

    if (entry.lastEntryId) {
      // Find items newer than the last known one
      const lastIdx = items.findIndex(i => (i.guid ?? i.link ?? i.title) === entry.lastEntryId);
      newItems = lastIdx > 0 ? items.slice(0, lastIdx) : lastIdx === 0 ? [] : items.slice(0, 10);
    } else {
      // First check — return up to 5 latest
      newItems = items.slice(0, 5);
    }

    // Update memory with latest entry ID
    const latestId = items[0] ? (items[0].guid ?? items[0].link ?? items[0].title ?? null) : null;
    const updated: FeedEntry = {
      ...entry,
      lastCheckedAt: new Date().toISOString(),
      lastEntryId: latestId,
    };
    this.memoryRepo.save(userId, `feed:${entry.url}`, JSON.stringify(updated), 'feed');

    return {
      label: entry.label,
      newCount: newItems.length,
      items: newItems.map(i => ({
        title: i.title ?? '(untitled)',
        link: i.link,
        pubDate: i.pubDate,
      })),
    };
  }
}
