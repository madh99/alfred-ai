import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePublicMediaConfig, publishPublicMedia } from './public-media.js';
import { MetaProvider } from './meta-provider.js';
import type { SocialChannel, ContentItem } from '@alfred/storage';

let dir: string;
let imagePath: string;
const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pubmedia-'));
  imagePath = join(dir, 'studio-123-abc.png');
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('parsePublicMediaConfig (v969)', () => {
  it('akzeptiert rest- und s3-Configs, verwirft Unvollständiges', () => {
    expect(parsePublicMediaConfig({ provider: 'rest', base_url: 'https://fussball.cc' })).toBeTruthy();
    expect(parsePublicMediaConfig({ provider: 's3', endpoint: 'https://r2.example.com', bucket: 'media' })).toBeTruthy();
    expect(parsePublicMediaConfig({ provider: 'rest' })).toBeNull();
    expect(parsePublicMediaConfig({ provider: 's3', endpoint: 'x' })).toBeNull();
    expect(parsePublicMediaConfig(undefined)).toBeNull();
    expect(parsePublicMediaConfig('rest')).toBeNull();
  });
});

describe('publishPublicMedia rest (v969)', () => {
  it('lädt multipart hoch und macht relative Antwort-URLs absolut', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { id: 'm1', url: '/uploads/news/bild.webp' } }));
    const url = await publishPublicMedia(
      { provider: 'rest', base_url: 'https://fussball.cc', path: '/api/integrations/media' },
      imagePath, { API_TOKEN: 'fcc_123' }, 'Alt-Text',
    );
    expect(url).toBe('https://fussball.cc/uploads/news/bild.webp');
    const [reqUrl, init] = fetchMock.mock.calls[0];
    expect(reqUrl).toBe('https://fussball.cc/api/integrations/media');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer fcc_123');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('absolute URLs bleiben unverändert; fehlende URL in der Antwort wirft', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { url: 'https://cdn.fussball.cc/x.png' } }));
    const url = await publishPublicMedia({ provider: 'rest', base_url: 'https://fussball.cc' }, imagePath, {});
    expect(url).toBe('https://cdn.fussball.cc/x.png');

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { id: 'nur-id' } }));
    await expect(publishPublicMedia({ provider: 'rest', base_url: 'https://fussball.cc' }, imagePath, {}))
      .rejects.toThrow(/keine URL/);
  });

  it('Upload-Fehler wirft (kein stiller Post ohne Bild)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'kaputt' }, 500));
    await expect(publishPublicMedia({ provider: 'rest', base_url: 'https://fussball.cc' }, imagePath, {}))
      .rejects.toThrow(/HTTP 500/);
  });
});

describe('publishPublicMedia s3 (v969)', () => {
  it('signiert SigV4-PUT und baut die öffentliche URL', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' });
    const url = await publishPublicMedia(
      { provider: 's3', endpoint: 'https://acc.r2.cloudflarestorage.com', bucket: 'media', public_base_url: 'https://media.example.com' },
      imagePath, { S3_ACCESS_KEY_ID: 'AK', S3_SECRET_ACCESS_KEY: 'SK' },
    );
    expect(url).toBe('https://media.example.com/social/studio-123-abc.png');
    const [reqUrl, init] = fetchMock.mock.calls[0];
    expect(reqUrl).toBe('https://acc.r2.cloudflarestorage.com/media/social/studio-123-abc.png');
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\//);
    expect(init.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ohne public_base_url: endpoint/bucket/key; fehlende Secrets werfen', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' });
    const url = await publishPublicMedia(
      { provider: 's3', endpoint: 'https://s3.example.com', bucket: 'b', key_prefix: 'img' },
      imagePath, { S3_ACCESS_KEY_ID: 'AK', S3_SECRET_ACCESS_KEY: 'SK' },
    );
    expect(url).toBe('https://s3.example.com/b/img/studio-123-abc.png');

    await expect(publishPublicMedia({ provider: 's3', endpoint: 'https://s3.example.com', bucket: 'b' }, imagePath, {}))
      .rejects.toThrow(/S3_ACCESS_KEY_ID/);
  });
});

describe('MetaProvider + public_media (v969)', () => {
  function makeChannel(config: Record<string, unknown>): SocialChannel {
    return {
      id: 'ch-ig', userId: 'u1', platform: 'instagram', name: 'IG', mode: 'approve',
      publishMode: 'api', planningHorizonDays: 14, postingSlots: [], blacklist: [],
      maxPostsPerDay: 3, approvedStreak: 5, status: 'active', config,
      createdAt: 'x', updatedAt: 'x',
    };
  }
  function makeItem(): ContentItem {
    return {
      id: 'i1', channelId: 'ch-ig', userId: 'u1', status: 'approved',
      title: 'Derby', body: 'Was für ein Spiel!', hashtags: ['fussball'],
      media: [{ type: 'image', source: 'generated', pathOrUrl: imagePath }],
      source: 'studio', createdAt: 'x', updatedAt: 'x',
    };
  }

  it('lokales Bild → Upload über public_media, öffentliche URL im Container-Flow', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { url: '/uploads/x.webp' } })) // public_media-Upload
      .mockResolvedValueOnce(jsonResponse({ id: 'container-1' }))                          // /media
      .mockResolvedValueOnce(jsonResponse({ id: 'post-1' }))                               // /media_publish
      .mockResolvedValueOnce(jsonResponse({ permalink: 'https://instagram.com/p/1' }));    // permalink
    const provider = new MetaProvider('instagram');
    const r = await provider.publish(makeItem(), makeChannel({
      ig_user_id: 'ig-9',
      public_media: { provider: 'rest', base_url: 'https://fussball.cc' },
    }), { META_ACCESS_TOKEN: 'MT', API_TOKEN: 'fcc_1' });
    expect(r.externalId).toBe('post-1');
    // Container-Call bekam die ÖFFENTLICHE URL, nicht den lokalen Pfad
    const containerBody = String(fetchMock.mock.calls[1][1].body);
    expect(containerBody).toContain(encodeURIComponent('https://fussball.cc/uploads/x.webp'));
  });

  it('lokales Bild OHNE public_media → verständlicher Fehler', async () => {
    const provider = new MetaProvider('instagram');
    await expect(provider.publish(makeItem(), makeChannel({ ig_user_id: 'ig-9' }), { META_ACCESS_TOKEN: 'MT' }))
      .rejects.toThrow(/public_media/);
  });

  it('v970: IG-Login-Token (IG…) → graph.instagram.com, Page-Token (EAA…) → graph.facebook.com', async () => {
    const provider = new MetaProvider('instagram');
    const channel = makeChannel({ ig_user_id: '17841417218854772' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ username: 'fussball.cc' }));
    await provider.validateAuth(channel, { META_ACCESS_TOKEN: 'IGAAxyz' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('https://graph.instagram.com/');

    fetchMock.mockResolvedValueOnce(jsonResponse({ username: 'fussball.cc' }));
    await provider.validateAuth(channel, { META_ACCESS_TOKEN: 'EAAxyz' });
    expect(String(fetchMock.mock.calls[1][0])).toContain('https://graph.facebook.com/');
  });

  it('v970: Publish mit IG-Login-Token nutzt den Container-Flow auf graph.instagram.com', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { url: '/uploads/x.webp' } })) // public_media
      .mockResolvedValueOnce(jsonResponse({ id: 'container-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'post-1' }))
      .mockResolvedValueOnce(jsonResponse({ permalink: 'https://instagram.com/p/1' }));
    const provider = new MetaProvider('instagram');
    const r = await provider.publish(makeItem(), makeChannel({
      ig_user_id: '17841417218854772',
      public_media: { provider: 'rest', base_url: 'https://fussball.cc' },
    }), { META_ACCESS_TOKEN: 'IGAAxyz', API_TOKEN: 'fcc_1' });
    expect(r.externalId).toBe('post-1');
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://graph.instagram.com/v21.0/17841417218854772/media');
    expect(String(fetchMock.mock.calls[2][0])).toBe('https://graph.instagram.com/v21.0/17841417218854772/media_publish');
  });
});
