import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { YouTubeProvider } from './youtube-provider.js';
import { MetaProvider } from './meta-provider.js';
import { XProvider } from './x-provider.js';
import { SocialSkill } from './social-skill.js';
import { SocialProvider, type ProviderCapabilities, type PublishResult } from './social-provider.js';
import type { SocialChannel, ContentItem, SocialRepository } from '@alfred/storage';
import type { SkillContext } from '@alfred/types';

function makeChannel(platform: string, config: Record<string, unknown> = {}): SocialChannel {
  return {
    id: 'ch-1', userId: 'u1', platform, name: 'Kanal', mode: 'suggest',
    publishMode: 'api', planningHorizonDays: 14, postingSlots: [], blacklist: [],
    maxPostsPerDay: 10, approvedStreak: 0, status: 'active', config,
    createdAt: 'x', updatedAt: 'x',
  };
}

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: 'i1', channelId: 'ch-1', userId: 'u1', status: 'approved',
    title: 'Derby-Analyse', body: 'HOOK und Script…\n---\nBeschreibung mit Kapiteln',
    media: [], hashtags: ['fussball'], source: 'studio', createdAt: 'x', updatedAt: 'x', ...overrides,
  };
}

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); globalThis.fetch = fetchMock as unknown as typeof fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status < 400, status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body, text: async () => JSON.stringify(body),
  };
}

describe('YouTubeProvider (v936)', () => {
  const SECRETS = { YT_CLIENT_ID: 'cid', YT_CLIENT_SECRET: 'cs', YT_REFRESH_TOKEN: 'rt' };

  it('description: Teil nach --- wird YouTube-Beschreibung', () => {
    expect(YouTubeProvider.description(makeItem())).toBe('Beschreibung mit Kapiteln');
    expect(YouTubeProvider.description(makeItem({ body: 'nur script' }))).toBe('nur script');
  });

  it('publish ohne Video-Datei → klarer Fehler (attach_media-Hinweis)', async () => {
    const provider = new YouTubeProvider();
    await expect(provider.publish(makeItem(), makeChannel('youtube'), SECRETS)).rejects.toThrow(/attach_media/);
  });

  it('fehlende Secrets → klarer Fehler mit ENV-Stage-Hinweis', async () => {
    const provider = new YouTubeProvider();
    await expect(provider.publish(makeItem({ media: [{ type: 'video', source: 'user', pathOrUrl: '/tmp/v.mp4' }] }), makeChannel('youtube'), {}))
      .rejects.toThrow(/YT_CLIENT_ID/);
  });

  it('validateAuth: Token-Refresh + channels.list mine=true', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'AT' }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ snippet: { title: 'FussballCC TV' } }] }));
    const r = await new YouTubeProvider().validateAuth(makeChannel('youtube'), SECRETS);
    expect(r).toEqual({ ok: true, detail: 'FussballCC TV' });
    expect(fetchMock.mock.calls[0][0]).toContain('oauth2.googleapis.com/token');
  });

  it('fetchMetrics mappt statistics auf Item-IDs', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'AT' }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'yt-1', statistics: { viewCount: '1200', likeCount: '80' } }] }));
    const out = await new YouTubeProvider().fetchMetrics([{ id: 'i1', externalId: 'yt-1' }], makeChannel('youtube'), SECRETS);
    expect(out).toEqual([
      { itemId: 'i1', kind: 'views', value: 1200 },
      { itemId: 'i1', kind: 'likes', value: 80 },
    ]);
  });
});

describe('MetaProvider (v936)', () => {
  it('Instagram: Container-Flow (media → media_publish) mit Permalink', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'container-1' }))          // /media
      .mockResolvedValueOnce(jsonResponse({ id: 'media-9' }))              // /media_publish
      .mockResolvedValueOnce(jsonResponse({ permalink: 'https://instagr.am/p/x' })); // permalink
    const provider = new MetaProvider('instagram');
    const r = await provider.publish(
      makeItem({ media: [{ type: 'image', source: 'generated', pathOrUrl: 'https://ex.at/b.png' }] }),
      makeChannel('instagram', { ig_user_id: '178' }), { META_ACCESS_TOKEN: 'MT' },
    );
    expect(r).toEqual({ externalId: 'media-9', url: 'https://instagr.am/p/x' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/178/media');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/178/media_publish');
  });

  it('Instagram ohne Medium → klarer Fehler', async () => {
    const provider = new MetaProvider('instagram');
    await expect(provider.publish(makeItem(), makeChannel('instagram', { ig_user_id: '1' }), { META_ACCESS_TOKEN: 'T' }))
      .rejects.toThrow(/Bild oder Video/);
  });

  it('Facebook: Text → /feed; Graph-Fehler wird durchgereicht', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: '123_456' }));
    const provider = new MetaProvider('facebook');
    const r = await provider.publish(makeItem(), makeChannel('facebook', { page_id: 'p1' }), { META_ACCESS_TOKEN: 'T' });
    expect(r.externalId).toBe('123_456');

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'Invalid OAuth' } }, 400));
    await expect(provider.publish(makeItem(), makeChannel('facebook', { page_id: 'p1' }), { META_ACCESS_TOKEN: 'T' }))
      .rejects.toThrow('Invalid OAuth');
  });

  it('Threads: Text-Container + publish', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'tc-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'thread-5' }));
    const provider = new MetaProvider('threads');
    const r = await provider.publish(makeItem(), makeChannel('threads', { threads_user_id: 'th1' }), { META_ACCESS_TOKEN: 'T' });
    expect(r.externalId).toBe('thread-5');
    expect(String(fetchMock.mock.calls[0][0])).toContain('graph.threads.net');
  });

  it('v988: Instagram-Karussell — je Bild ein Child-Container, dann CAROUSEL + publish', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'child-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'child-2' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'carousel-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'media-7' }))
      .mockResolvedValueOnce(jsonResponse({ permalink: 'https://instagr.am/p/c' }));
    const provider = new MetaProvider('instagram');
    const r = await provider.publish(
      makeItem({ media: [
        { type: 'image', source: 'generated', pathOrUrl: 'https://ex.at/1.png' },
        { type: 'image', source: 'generated', pathOrUrl: 'https://ex.at/2.png' },
      ] }),
      makeChannel('instagram', { ig_user_id: '178' }), { META_ACCESS_TOKEN: 'MT' },
    );
    expect(r.externalId).toBe('media-7');
    const bodies = fetchMock.mock.calls.map((c: any[]) => String(c[1]?.body ?? ''));
    expect(bodies[0]).toContain('is_carousel_item=true');
    expect(bodies[1]).toContain('2.png');
    expect(bodies[2]).toContain('media_type=CAROUSEL');
    expect(bodies[2]).toContain(encodeURIComponent('child-1,child-2'));
    expect(String(fetchMock.mock.calls[3][0])).toContain('media_publish');
  });

  it('v988: Facebook-Video → /videos mit file_url + description', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'vid-1' }));
    const provider = new MetaProvider('facebook');
    const r = await provider.publish(
      makeItem({ media: [{ type: 'video', source: 'generated', pathOrUrl: 'https://ex.at/clip.mp4' }] }),
      makeChannel('facebook', { page_id: 'p1' }), { META_ACCESS_TOKEN: 'T' },
    );
    expect(r.externalId).toBe('vid-1');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/p1/videos');
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain('file_url=');
  });

  it('deletePost: nur Facebook kann löschen', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    expect(await new MetaProvider('facebook').deletePost('1', makeChannel('facebook', { page_id: 'p' }), { META_ACCESS_TOKEN: 'T' })).toBe(true);
    expect(await new MetaProvider('instagram').deletePost('1', makeChannel('instagram', { ig_user_id: 'i' }), { META_ACCESS_TOKEN: 'T' })).toBe(false);
  });
});

describe('XProvider (v936)', () => {
  it('POST /2/tweets mit gekürztem Text (280), liefert Status-URL', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: '999' } }, 201));
    const provider = new XProvider();
    const r = await provider.publish(makeItem({ body: 'x'.repeat(400) }), makeChannel('x'), { X_ACCESS_TOKEN: 'XT' });
    expect(r).toEqual({ externalId: '999', url: 'https://x.com/i/status/999' });
    const payload = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(payload.text.length).toBeLessThanOrEqual(280);
  });

  it('fetchMetrics mappt public_metrics', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: '999', public_metrics: { impression_count: 500, like_count: 12 } }] }));
    const out = await new XProvider().fetchMetrics([{ id: 'i1', externalId: '999' }], makeChannel('x'), { X_ACCESS_TOKEN: 'XT' });
    expect(out).toEqual([
      { itemId: 'i1', kind: 'views', value: 500 },
      { itemId: 'i1', kind: 'likes', value: 12 },
    ]);
  });
});

// ── v936 — Skill: Monats-Limit + Analytics-Collector ──────────────────

class MetricsProvider extends SocialProvider {
  readonly platform = 'test';
  capabilities(): ProviderCapabilities { return { text: true, image: false, video: false, supportsDelete: false, supportsMetrics: true }; }
  async publish(): Promise<PublishResult> { return { externalId: 'e1' }; }
  async validateAuth(): Promise<{ ok: boolean }> { return { ok: true }; }
  override async fetchMetrics(items: Array<{ id: string; externalId: string }>): Promise<Array<{ itemId: string; kind: string; value: number }>> {
    return items.map(i => ({ itemId: i.id, kind: 'views', value: 42 }));
  }
}

describe('SocialSkill v936 — Monats-Limit + collectMetrics', () => {
  const CTX = { userId: 'u1', masterUserId: 'u1' } as unknown as SkillContext;

  function makeRepo(channel: SocialChannel, publishedMonth: number) {
    const item = makeItem({ status: 'approved' });
    return {
      getChannel: vi.fn(async () => channel),
      findChannelByName: vi.fn(async () => channel),
      listChannels: vi.fn(async () => [channel]),
      getItem: vi.fn(async () => item),
      listItems: vi.fn(async () => [makeItem({ status: 'published', externalId: 'e1' })]),
      countPublishedToday: vi.fn(async () => 0),
      countPublishedSince: vi.fn(async () => publishedMonth),
      transition: vi.fn(async () => item),
      upsertMetric: vi.fn(async () => {}),
      mergePerformance: vi.fn(async () => {}),
    } as unknown as SocialRepository;
  }

  it('Monats-Limit erreicht → publish_now verweigert (X-Free-Tier-Schutz)', async () => {
    const channel = makeChannel('test', { max_posts_per_month: 450 });
    const skill = new SocialSkill(makeRepo(channel, 450));
    skill.registerProvider(new MetricsProvider());
    const r = await skill.execute({ action: 'publish_now', item_id: 'i1' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('Monats-Limit');
  });

  it('collectMetrics schreibt channel_metrics + performance je Item', async () => {
    const channel = makeChannel('test');
    const repo = makeRepo(channel, 0);
    const skill = new SocialSkill(repo);
    skill.registerProvider(new MetricsProvider());
    const n = await skill.collectMetrics('u1');
    expect(n).toBe(1);
    expect((repo.upsertMetric as any).mock.calls[0][1]).toMatchObject({ itemId: 'i1', kind: 'views', value: 42 });
    expect(repo.mergePerformance).toHaveBeenCalledWith('u1', 'i1', { views: 42 });
  });
});

// ── v938 — render_video + attach_media-Probe ──────────────────────────

describe('SocialSkill v938 — Video-Pipeline', () => {
  const CTX = { userId: 'u1', masterUserId: 'u1' } as unknown as SkillContext;

  function makeVideoRepo(channel: SocialChannel, item: ContentItem, videosUsed = 0) {
    return {
      getChannel: vi.fn(async () => channel),
      findChannelByName: vi.fn(async () => channel),
      getItem: vi.fn(async () => item),
      listItems: vi.fn(async () => [item]),
      updateItemContent: vi.fn(async () => {}),
      listMetrics: vi.fn(async (_c: string, q: any) => q?.kind === 'gen_video' && videosUsed > 0
        ? [{ date: '2026-07-01', kind: 'gen_video', value: videosUsed }] : []),
      upsertMetric: vi.fn(async () => {}),
    } as unknown as SocialRepository;
  }

  it('render_video: rendert, hängt Video an und zählt das Budget', async () => {
    const channel = makeChannel('youtube');
    const item = makeItem({ media: [{ type: 'image', source: 'generated', pathOrUrl: '/data/img1.png' }] });
    const repo = makeVideoRepo(channel, item);
    const skill = new SocialSkill(repo);
    const render = vi.fn(async () => ({ videoPath: '/data/social-videos/v.mp4', durationSec: 32 }));
    skill.setVideoTools({ render });

    const r = await skill.execute({ action: 'render_video', item_id: 'i1', format: '9:16' }, CTX);
    expect(r.success).toBe(true);
    expect(render).toHaveBeenCalledWith(item, channel, '9:16');
    const media = (repo.updateItemContent as any).mock.calls[0][2].media;
    expect(media.some((m: any) => m.type === 'video' && m.source === 'generated')).toBe(true);
    expect((repo.upsertMetric as any).mock.calls[0][1]).toMatchObject({ kind: 'gen_video', value: 1 });
  });

  it('render_video: Monats-Budget erreicht → verweigert', async () => {
    const channel = makeChannel('youtube', { video_budget_per_month: 10 });
    const item = makeItem({ media: [{ type: 'image', source: 'generated', pathOrUrl: '/data/img1.png' }] });
    const skill = new SocialSkill(makeVideoRepo(channel, item, 10));
    skill.setVideoTools({ render: vi.fn() });
    const r = await skill.execute({ action: 'render_video', item_id: 'i1' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('Budget');
  });

  it('render_video ohne Bilder am Item → klarer Hinweis', async () => {
    const channel = makeChannel('youtube');
    const skill = new SocialSkill(makeVideoRepo(channel, makeItem()));
    skill.setVideoTools({ render: vi.fn() });
    const r = await skill.execute({ action: 'render_video', item_id: 'i1' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('Bilder');
  });

  it('attach_media: kaputtes lokales Video wird per ffprobe abgewiesen', async () => {
    const channel = makeChannel('youtube');
    const item = makeItem();
    const repo = makeVideoRepo(channel, item);
    const skill = new SocialSkill(repo);
    skill.setVideoTools({ render: vi.fn(), probe: vi.fn(async () => ({ ok: false, detail: 'moov atom not found' })) });
    const r = await skill.execute({ action: 'attach_media', item_id: 'i1', media_url: '/tmp/kaputt.mp4', media_type: 'video' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('moov atom');
    expect(repo.updateItemContent).not.toHaveBeenCalled();
  });

  it('attach_media: valides Video wird mit Dauer bestätigt', async () => {
    const channel = makeChannel('youtube');
    const repo = makeVideoRepo(channel, makeItem());
    const skill = new SocialSkill(repo);
    skill.setVideoTools({ render: vi.fn(), probe: vi.fn(async () => ({ ok: true, durationSec: 63 })) });
    const r = await skill.execute({ action: 'attach_media', item_id: 'i1', media_url: '/tmp/video.mp4', media_type: 'video' }, CTX);
    expect(r.success).toBe(true);
    expect(r.display).toContain('63s');
  });
});
