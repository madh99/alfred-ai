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
  it('Instagram: Container-Flow (media → Status-Poll → media_publish) mit Permalink', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'container-1' }))          // /media
      .mockResolvedValueOnce(jsonResponse({ status_code: 'FINISHED' }))    // v997 Status-Poll
      .mockResolvedValueOnce(jsonResponse({ id: 'media-9' }))              // /media_publish
      .mockResolvedValueOnce(jsonResponse({ permalink: 'https://instagr.am/p/x' })); // permalink
    const provider = new MetaProvider('instagram');
    const r = await provider.publish(
      makeItem({ media: [{ type: 'image', source: 'generated', pathOrUrl: 'https://ex.at/b.png' }] }),
      makeChannel('instagram', { ig_user_id: '178' }), { META_ACCESS_TOKEN: 'MT' },
    );
    expect(r).toEqual({ externalId: 'media-9', url: 'https://instagr.am/p/x' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/178/media');
    expect(String(fetchMock.mock.calls[1][0])).toContain('status_code');
    expect(String(fetchMock.mock.calls[2][0])).toContain('/178/media_publish');
  });

  it('v1057: IG-Video (Reel) — REELS-Container mit 300s-Transcoding-Poll (60×5s statt 60s-Default)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'c-reel' }))               // /media (REELS-Container)
      .mockResolvedValueOnce(jsonResponse({ id: 'media-77' }))             // /media_publish
      .mockResolvedValueOnce(jsonResponse({ permalink: 'https://instagr.am/reel/x' }));
    const provider = new MetaProvider('instagram');
    const wait = vi.spyOn(provider as any, 'waitForContainer').mockResolvedValue(undefined);
    const r = await provider.publish(
      makeItem({ media: [{ type: 'video', source: 'generated', pathOrUrl: 'https://cdn.example/reel.mp4' }] }),
      makeChannel('instagram', { ig_user_id: '178' }), { META_ACCESS_TOKEN: 'MT' },
    );
    expect(r.externalId).toBe('media-77');
    // Realfall 08.07.: 41s-Reel scheiterte am 60s-Poll — Videos bekommen 300s
    expect(wait).toHaveBeenCalledWith('c-reel', 'MT', expect.any(String), { tries: 60, delayMs: 5_000 });
  });

  it('v997: Bild-Container erst IN_PROGRESS → Poll wartet auf FINISHED; media_publish-Retry bei „Media ID is not available"', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'container-2' }))                       // /media
      .mockResolvedValueOnce(jsonResponse({ status_code: 'IN_PROGRESS' }))              // Poll 1
      .mockResolvedValueOnce(jsonResponse({ status_code: 'FINISHED' }))                 // Poll 2
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Media ID is not available' } }, 400)) // publish 1 → Retry
      .mockResolvedValueOnce(jsonResponse({ id: 'media-10' }))                          // publish 2
      .mockResolvedValueOnce(jsonResponse({ permalink: 'https://instagr.am/p/y' }));
    const provider = new MetaProvider('instagram');
    const p = provider.publish(
      makeItem({ media: [{ type: 'image', source: 'generated', pathOrUrl: 'https://ex.at/b.png' }] }),
      makeChannel('instagram', { ig_user_id: '178' }), { META_ACCESS_TOKEN: 'MT' },
    );
    await vi.runAllTimersAsync();
    const r = await p;
    vi.useRealTimers();
    expect(r.externalId).toBe('media-10');
    expect(fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes('media_publish')).length).toBe(2);
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
      .mockResolvedValueOnce(jsonResponse({ status_code: 'FINISHED' })) // v997 Status-Poll
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
    expect(String(fetchMock.mock.calls[4][0])).toContain('media_publish');
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

  it('v989: fetchComments (FB) sammelt fremde Kommentare, eigene Seiten-Antworten werden übersprungen', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [
      { id: 'c-1', message: 'Super Aktion, sind dabei!', from: { id: 'user-9', name: 'Max' }, created_time: '2026-07-05T10:00:00+0000' },
      { id: 'c-2', message: 'Danke euch!', from: { id: 'p1', name: 'Fussball.cc' } }, // eigene Antwort der Seite
      { id: 'c-3', message: '' }, // leer → raus
    ] }));
    const provider = new MetaProvider('facebook');
    const out = await provider.fetchComments(
      [{ id: 'i1', externalId: 'post-77' }],
      makeChannel('facebook', { page_id: 'p1' }), { META_ACCESS_TOKEN: 'T' },
    );
    expect(out).toEqual([{
      itemId: 'i1', externalCommentId: 'c-1', externalPostId: 'post-77',
      author: 'Max', text: 'Super Aktion, sind dabei!', createdAt: '2026-07-05T10:00:00+0000',
    }]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/post-77/comments');
  });

  it('v989: replyToComment — FB /comments, IG /replies (IG-Token → graph.instagram.com)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'reply-1' }));
    const fb = new MetaProvider('facebook');
    expect(await fb.replyToComment('c-1', 'Danke!', makeChannel('facebook', { page_id: 'p1' }), { META_ACCESS_TOKEN: 'T' })).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/c-1/comments');

    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'reply-2' }));
    const ig = new MetaProvider('instagram');
    expect(await ig.replyToComment('c-9', 'Merci!', makeChannel('instagram', { ig_user_id: '178' }), { META_ACCESS_TOKEN: 'IGAAx' })).toBe(true);
    expect(String(fetchMock.mock.calls[1][0])).toContain('graph.instagram.com');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/c-9/replies');
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

  it('v1029: Bild wird über /2/media/upload hochgeladen und als media_ids am Tweet mitgeschickt', async () => {
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const img = join(tmpdir(), `alfred-x-${Date.now()}.png`);
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ data: { id: 'media-1' } }))       // media/upload
        .mockResolvedValueOnce(jsonResponse({ data: { id: '777' } }, 201));     // tweets
      const provider = new XProvider();
      const item = makeItem({ media: [{ type: 'image', source: 'generated', pathOrUrl: img }] });
      const r = await provider.publish(item, makeChannel('x'), { X_ACCESS_TOKEN: 'XT' });
      expect(r.externalId).toBe('777');
      expect(String(fetchMock.mock.calls[0][0])).toContain('/2/media/upload');
      const payload = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
      expect(payload.media).toEqual({ media_ids: ['media-1'] });
      expect(payload.text).toContain('Bild: KI-generiert'); // Bild geht mit → Kennzeichnung korrekt
    } finally {
      unlinkSync(img);
    }
  });

  it('v1056: Video via v1.1 chunked upload (INIT/APPEND/FINALIZE) → media_ids am Tweet', async () => {
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const vid = join(tmpdir(), `alfred-x-${Date.now()}v.mp4`);
    writeFileSync(vid, Buffer.from('kleines-mp4'));
    try {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ media_id_string: 'vid42' })) // INIT
        .mockResolvedValueOnce(jsonResponse({}))                            // APPEND (1 Segment)
        .mockResolvedValueOnce(jsonResponse({}))                            // FINALIZE (ohne processing_info = fertig)
        .mockResolvedValueOnce(jsonResponse({ data: { id: '888' } }, 201)); // tweets
      const provider = new XProvider();
      const item = makeItem({ media: [{ type: 'video', source: 'generated', pathOrUrl: vid }] });
      const r = await provider.publish(item, makeChannel('x'), {
        X_ACCESS_TOKEN: 'XT',
        X_CONSUMER_KEY: 'CK', X_CONSUMER_SECRET: 'CS',
        X_OAUTH1_ACCESS_TOKEN: 'AT', X_OAUTH1_ACCESS_SECRET: 'AS',
      });
      expect(r.externalId).toBe('888');
      const initForm = (fetchMock.mock.calls[0][1] as RequestInit).body as FormData;
      expect(initForm.get('command')).toBe('INIT');
      expect(initForm.get('media_category')).toBe('tweet_video');
      const appendForm = (fetchMock.mock.calls[1][1] as RequestInit).body as FormData;
      expect(appendForm.get('command')).toBe('APPEND');
      expect(appendForm.get('segment_index')).toBe('0');
      const finForm = (fetchMock.mock.calls[2][1] as RequestInit).body as FormData;
      expect(finForm.get('command')).toBe('FINALIZE');
      const payload = JSON.parse((fetchMock.mock.calls[3][1] as RequestInit).body as string);
      expect(payload.media).toEqual({ media_ids: ['vid42'] });
    } finally {
      unlinkSync(vid);
    }
  });

  it('v1056: ohne OAuth-1.0a-Secrets wird KEIN Video hochgeladen (Tweet ohne Medium)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: '889' } }, 201)); // nur tweets
    const provider = new XProvider();
    const item = makeItem({ media: [{ type: 'video', source: 'generated', pathOrUrl: '/tmp/gibt-es-nicht.mp4' }] });
    const r = await provider.publish(item, makeChannel('x'), { X_ACCESS_TOKEN: 'XT' });
    expect(r.externalId).toBe('889');
    const payload = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(payload.media).toBeUndefined();
  });

  it('v1030: mit OAuth-1.0a-Secrets läuft der Upload über die v1.1-API (signierter OAuth-Header)', async () => {
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const img = join(tmpdir(), `alfred-x-${Date.now()}c.png`);
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ media_id_string: '424242' }))   // v1.1 media/upload
        .mockResolvedValueOnce(jsonResponse({ data: { id: '779' } }, 201));   // tweets
      const provider = new XProvider();
      const item = makeItem({ media: [{ type: 'image', source: 'generated', pathOrUrl: img }] });
      const r = await provider.publish(item, makeChannel('x'), {
        X_ACCESS_TOKEN: 'XT',
        X_CONSUMER_KEY: 'CK', X_CONSUMER_SECRET: 'CS',
        X_OAUTH1_ACCESS_TOKEN: 'AT', X_OAUTH1_ACCESS_SECRET: 'AS',
      });
      expect(r.externalId).toBe('779');
      expect(String(fetchMock.mock.calls[0][0])).toContain('upload.twitter.com/1.1/media/upload.json');
      const auth = ((fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>).Authorization;
      expect(auth).toMatch(/^OAuth /);
      expect(auth).toContain('oauth_consumer_key="CK"');
      expect(auth).toContain('oauth_signature_method="HMAC-SHA1"');
      expect(auth).toContain('oauth_signature="');
      const payload = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
      expect(payload.media).toEqual({ media_ids: ['424242'] });
    } finally {
      unlinkSync(img);
    }
  });

  it('v1029: scheitert der Bild-Upload, geht der Post OHNE Bild und OHNE KI-Kennzeichnung raus', async () => {
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const img = join(tmpdir(), `alfred-x-${Date.now()}b.png`);
    writeFileSync(img, Buffer.from([0x89, 0x50]));
    try {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ errors: [{ message: 'nope' }] }, 403)) // media/upload scheitert
        .mockResolvedValueOnce(jsonResponse({ data: { id: '778' } }, 201));           // tweets
      const provider = new XProvider();
      const item = makeItem({ media: [{ type: 'image', source: 'generated', pathOrUrl: img }] });
      const r = await provider.publish(item, makeChannel('x'), { X_ACCESS_TOKEN: 'XT' });
      expect(r.externalId).toBe('778');
      const payload = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
      expect(payload.media).toBeUndefined();
      expect(payload.text).not.toContain('KI-generiert'); // Realfall 06.07.: Kennzeichnung ohne Bild
    } finally {
      unlinkSync(img);
    }
  });

  it('v1031: 401 mit gecachtem Token → Cache verworfen, frisch refresht, Call wiederholt', async () => {
    const provider = new XProvider();
    const secrets: Record<string, string> = { X_REFRESH_TOKEN: 'R1', X_CLIENT_ID: 'CID' };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'ALT', refresh_token: 'R2', expires_in: 7200 })) // Refresh #1 (füllt Cache)
      .mockResolvedValueOnce(jsonResponse({ title: 'Unauthorized' }, 401))                                  // tweets mit entwertetem Token
      .mockResolvedValueOnce(jsonResponse({ access_token: 'NEU', refresh_token: 'R3', expires_in: 7200 })) // Refresh #2 (erzwungen)
      .mockResolvedValueOnce(jsonResponse({ data: { id: '880' } }, 201));                                   // Retry ok
    const r = await provider.publish(makeItem(), makeChannel('x'), secrets);
    expect(r.externalId).toBe('880');
    const retry = fetchMock.mock.calls[3];
    expect((retry[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer NEU' });
    expect(secrets.X_REFRESH_TOKEN).toBe('R3'); // Rotation auch beim erzwungenen Refresh
  });

  it('v1028: Refresh-Rotation — neues Refresh-Token wird persistiert, Access-Token gecacht', async () => {
    const provider = new XProvider();
    const writer = vi.fn(async () => { /* persistiert */ });
    provider.setSecretsWriter(writer);
    const channel = makeChannel('x');
    const secrets: Record<string, string> = { X_REFRESH_TOKEN: 'R1', X_CLIENT_ID: 'CID' };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'AT1', refresh_token: 'R2', expires_in: 7200 })) // oauth2/token
      .mockResolvedValueOnce(jsonResponse({ data: { id: '111' } }, 201))  // tweets #1
      .mockResolvedValueOnce(jsonResponse({ data: { id: '222' } }, 201)); // tweets #2 (KEIN zweiter Refresh)
    await provider.publish(makeItem(), channel, secrets);
    // rotiertes Refresh-Token: im Secrets-Objekt aktualisiert UND weggeschrieben
    expect(secrets.X_REFRESH_TOKEN).toBe('R2');
    expect(writer).toHaveBeenCalledWith(channel, { X_REFRESH_TOKEN: 'R2' });
    // zweiter Publish: Access-Token aus dem Cache — kein weiterer oauth2/token-Call
    await provider.publish(makeItem(), channel, secrets);
    const oauthCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('oauth2/token'));
    expect(oauthCalls.length).toBe(1);
    const tweet2 = fetchMock.mock.calls[2];
    expect((tweet2[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer AT1' });
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
