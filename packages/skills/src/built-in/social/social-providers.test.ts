import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramChannelProvider } from './telegram-channel-provider.js';
import { RestProvider } from './rest-provider.js';
import { BlueskyProvider } from './bluesky-provider.js';
import { BEST_PRACTICE_SLOTS, effectiveSlots, extractTrailingHashtags, mergeHashtags } from './social-provider.js';
import type { SocialChannel, ContentItem } from '@alfred/storage';

function makeChannel(config: Record<string, unknown>, platform = 'test'): SocialChannel {
  return {
    id: 'ch-1', userId: 'u1', platform, name: 'Kanal', mode: 'suggest',
    publishMode: 'api', planningHorizonDays: 14, postingSlots: [], blacklist: [],
    maxPostsPerDay: 3, approvedStreak: 0, status: 'active', config,
    createdAt: 'x', updatedAt: 'x',
  };
}

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: 'i1', channelId: 'ch-1', userId: 'u1', status: 'approved',
    title: 'Derby-Sieg', body: 'Was für ein Spiel!', media: [], hashtags: ['fussball'],
    source: 'manual', createdAt: 'x', updatedAt: 'x', ...overrides,
  };
}

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('effectiveSlots (v959)', () => {
  it('User-Slots gewinnen immer', () => {
    const eff = effectiveSlots({ postingSlots: ['Mo 18:00'], platform: 'telegram_channel' });
    expect(eff).toEqual({ slots: ['Mo 18:00'], source: 'user' });
  });

  it('ohne User-Slots: Plattform-Best-Practice', () => {
    const eff = effectiveSlots({ postingSlots: [], platform: 'instagram' });
    expect(eff.source).toBe('best-practice');
    expect(eff.slots).toEqual(BEST_PRACTICE_SLOTS.instagram);
  });

  it('unbekannte Plattform: Fallback mit Sonntag', () => {
    const eff = effectiveSlots({ postingSlots: [], platform: 'tiktok' });
    expect(eff.source).toBe('best-practice');
    expect(eff.slots.some(s => s.startsWith('So '))).toBe(true);
  });

  it('jedes Best-Practice-Preset deckt das Wochenende ab', () => {
    for (const [platform, slots] of Object.entries(BEST_PRACTICE_SLOTS)) {
      expect(slots.some(s => /^(Sa|So) /.test(s)), platform).toBe(true);
    }
  });
});

describe('extractTrailingHashtags/mergeHashtags (v961)', () => {
  it('trennt Hashtag-Läufe am Body-Ende ab', () => {
    const { body, tags } = extractTrailingHashtags('Haltet ihr Glasner für reif? #Glasner #Nottingham #Trainer');
    expect(body).toBe('Haltet ihr Glasner für reif?');
    expect(tags).toEqual(['#Glasner', '#Nottingham', '#Trainer']);
  });

  it('mergeHashtags dedupliziert ohne #-Präfix und case-insensitiv, Limit 10', () => {
    expect(mergeHashtags(['#ÖFB', 'wm2026'], ['#öfb', '#WM2026', '#Neu'])).toEqual(['#ÖFB', 'wm2026', '#Neu']);
    expect(mergeHashtags([], Array.from({ length: 15 }, (_, i) => `#t${i}`)).length).toBe(10);
  });
});

describe('TelegramChannelProvider (v933)', () => {
  const channel = makeChannel({ chat_id: '@fussballcc' }, 'telegram_channel');

  it('sendMessage mit zusammengesetztem Text, liefert message_id + t.me-URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 77 } }));
    const provider = new TelegramChannelProvider('FALLBACK');
    const r = await provider.publish(makeItem(), channel, {});
    expect(r).toEqual({ externalId: '77', url: 'https://t.me/fussballcc/77' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('botFALLBACK/sendMessage');
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.chat_id).toBe('@fussballcc');
    expect(payload.text).toContain('Derby-Sieg');
    expect(payload.text).toContain('#fussball');
  });

  it('v1001: performance.trafficUrl → Inline-Button „Ganzer Artikel" (sendMessage + sendPhoto)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 90 } }));
    const provider = new TelegramChannelProvider('T');
    await provider.publish(
      makeItem({ performance: { trafficUrl: 'https://fussball.cc/news/x?utm_source=telegram_channel' } }),
      channel, {},
    );
    const payload = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(payload.reply_markup.inline_keyboard[0][0]).toEqual({ text: '📖 Ganzer Artikel', url: 'https://fussball.cc/news/x?utm_source=telegram_channel' });
    // ohne trafficUrl: kein reply_markup
    await provider.publish(makeItem(), channel, {});
    const plain = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(plain.reply_markup).toBeUndefined();
  });

  it('v1056: Video-Item → sendVideo (URL-Variante, supports_streaming, Caption)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 91 } }));
    const provider = new TelegramChannelProvider('FALLBACK');
    const r = await provider.publish(
      makeItem({ media: [{ type: 'video', source: 'generated', pathOrUrl: 'https://cdn.example/reel.mp4' }] }),
      channel, {},
    );
    expect(r.externalId).toBe('91');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/sendVideo');
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.video).toBe('https://cdn.example/reel.mp4');
    expect(payload.supports_streaming).toBe(true);
    expect(payload.caption).toContain('Derby-Sieg');
  });

  it('v1056: lokales Video → sendVideo als Multipart-Upload', async () => {
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const vid = join(tmpdir(), `alfred-tg-${Date.now()}.mp4`);
    writeFileSync(vid, Buffer.from('mp4-bytes'));
    try {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 92 } }));
      const provider = new TelegramChannelProvider('FALLBACK');
      await provider.publish(
        makeItem({ media: [{ type: 'video', source: 'generated', pathOrUrl: vid }] }),
        channel, {},
      );
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain('/sendVideo');
      const form = (init as RequestInit).body as FormData;
      expect(form.get('supports_streaming')).toBe('true');
      expect(form.get('video')).toBeInstanceOf(Blob);
    } finally {
      unlinkSync(vid);
    }
  });

  it('Bild-Item → sendPhoto mit Caption; Secret-Token gewinnt über Fallback', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 78 } }));
    const provider = new TelegramChannelProvider('FALLBACK');
    await provider.publish(
      makeItem({ media: [{ type: 'image', source: 'generated', pathOrUrl: 'https://ex.at/bild.png' }] }),
      channel, { TELEGRAM_BOT_TOKEN: 'SECRET' },
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('botSECRET/sendPhoto');
    expect(JSON.parse((init as RequestInit).body as string).photo).toBe('https://ex.at/bild.png');
  });

  it('v1022: lange Foto-Caption wird sauber auf 1024 gekürzt — KI-Kennzeichnung bleibt', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 91 } }));
    const provider = new TelegramChannelProvider('T');
    await provider.publish(
      makeItem({ body: 'x'.repeat(2000), media: [{ type: 'image', source: 'generated', pathOrUrl: 'https://ex.at/bild.png' }] }),
      channel, {},
    );
    const payload = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(payload.caption.length).toBeLessThanOrEqual(1024);
    expect(payload.caption).toContain('Bild: KI-generiert');
    expect(payload.caption).toContain('#fussball');
  });

  it('v942: lokale Bilddatei → Multipart-Upload (sendPhoto mit FormData)', async () => {
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmpFile = join(tmpdir(), `alfred-test-photo-${Date.now()}.png`);
    writeFileSync(tmpFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 80 } }));
      const provider = new TelegramChannelProvider('T');
      const r = await provider.publish(
        makeItem({ media: [{ type: 'image', source: 'generated', pathOrUrl: tmpFile }] }),
        channel, {},
      );
      expect(r.externalId).toBe('80');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain('/sendPhoto');
      expect((init as RequestInit).body).toBeInstanceOf(FormData);
      const form = (init as RequestInit).body as FormData;
      expect(form.get('chat_id')).toBe('@fussballcc');
      expect(String(form.get('caption'))).toContain('Derby-Sieg');
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('API-Fehler wird als Error mit description geworfen', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, description: 'chat not found' }, 400));
    const provider = new TelegramChannelProvider('T');
    await expect(provider.publish(makeItem(), channel, {})).rejects.toThrow('chat not found');
  });

  it('ohne Token und ohne Fallback → klarer Fehler', async () => {
    const provider = new TelegramChannelProvider(undefined);
    await expect(provider.publish(makeItem(), channel, {})).rejects.toThrow(/Bot-Token/);
  });
});

describe('RestProvider (v933)', () => {
  const channel = makeChannel({ base_url: 'https://cc.example/', publish_path: '/api/posts' }, 'rest');

  it('v1006: performance.translations wandern als "translations" ins Payload', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'p-10' }));
    const provider = new RestProvider();
    const translations = { en: { title: 'T', body: 'A long enough body text.' } };
    await provider.publish(makeItem({ performance: { translations } }), channel, { API_TOKEN: 'tok' });
    const payload = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(payload.translations).toEqual(translations);
    // ohne Übersetzungen: kein Schlüssel im Payload
    fetchMock.mockResolvedValue(jsonResponse({ id: 'p-11' }));
    await provider.publish(makeItem(), channel, { API_TOKEN: 'tok' });
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string).translations).toBeUndefined();
  });

  it('v1046: Termin-Items liefern event{beginn,ort,einlass,art} — Default UND Template-Modus', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'p-20' }));
    const provider = new RestProvider();
    const performance = { terminBis: '2026-07-07T16:00:00.000Z', ort: 'Dublin Irish Pub, Wien', einlass: '17:30', art: 'termin' };
    await provider.publish(makeItem({ performance }), channel, { API_TOKEN: 'tok' });
    let payload = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(payload.event).toEqual({ beginn: '2026-07-07T16:00:00.000Z', ort: 'Dublin Irish Pub, Wien', einlass: '17:30', art: 'termin' });
    // Template-Modus: event wird ergänzt, Template-Felder bleiben unangetastet
    const templChannel = makeChannel({ base_url: 'https://cc.example', body_template: { headline: '{{title}}' } }, 'rest');
    await provider.publish(makeItem({ performance }), templChannel, {});
    payload = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(payload.headline).toBe('Derby-Sieg');
    expect(payload.event.ort).toBe('Dublin Irish Pub, Wien');
    // ohne Termin: KEIN event-Schlüssel
    await provider.publish(makeItem(), channel, {});
    expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string).event).toBeUndefined();
  });

  it('POST an base_url+publish_path mit Bearer-Token, liest id/url aus Antwort', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'p-9', url: 'https://cc.example/posts/p-9' }));
    const provider = new RestProvider();
    const r = await provider.publish(makeItem(), channel, { API_TOKEN: 'tok' });
    expect(r).toEqual({ externalId: 'p-9', url: 'https://cc.example/posts/p-9' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cc.example/api/posts');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.title).toBe('Derby-Sieg');
    expect(payload.hashtags).toEqual(['fussball']);
  });

  it('body_template mit Platzhaltern wird substituiert', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: '1' }));
    const templChannel = makeChannel({
      base_url: 'https://cc.example',
      body_template: { headline: '{{title}}', content: '{{body}}', tags: '{{hashtags}}' },
    }, 'rest');
    const provider = new RestProvider();
    await provider.publish(makeItem(), templChannel, {});
    const payload = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(payload).toEqual({ headline: 'Derby-Sieg', content: 'Was für ein Spiel!', tags: ['fussball'] });
  });

  it('HTTP-Fehler → Error mit Status + Body-Auszug', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401));
    const provider = new RestProvider();
    await expect(provider.publish(makeItem(), channel, {})).rejects.toThrow(/HTTP 401/);
  });

  it('fehlende base_url → klarer Fehler', async () => {
    const provider = new RestProvider();
    await expect(provider.publish(makeItem(), makeChannel({}, 'rest'), {})).rejects.toThrow(/base_url/);
  });

  it('v943: Antwort-Hülle { ok, data: {…} } — id via Dot-Pfad/Fallback + url_template (fussball.cc)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { id: 'cmc31', slug: 'wm-auftakt-2026' } }, 201));
    const provider = new RestProvider();
    // Variante 1: explizite Dot-Pfade + URL-Template
    const explicitChannel = makeChannel({
      base_url: 'https://fussball.cc', publish_path: '/api/integrations/news',
      id_field: 'data.id', url_template: 'https://fussball.cc/news/{data.slug}',
    }, 'rest');
    const r1 = await provider.publish(makeItem(), explicitChannel, { API_TOKEN: 't' });
    expect(r1).toEqual({ externalId: 'cmc31', url: 'https://fussball.cc/news/wm-auftakt-2026' });
    // Variante 2: ohne Config — data.<id>-Fallback greift automatisch
    const r2 = await provider.publish(makeItem(), makeChannel({ base_url: 'https://fussball.cc' }, 'rest'), {});
    expect(r2.externalId).toBe('cmc31');
  });

  it('v953: media_upload — Bild erst in die Medienbibliothek, dann featuredMediaId am Beitrag (fussball.cc)', async () => {
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmpFile = join(tmpdir(), `alfred-test-media-${Date.now()}.png`);
    writeFileSync(tmpFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ ok: true, data: { id: 'media-7' } }, 201))          // Upload
        .mockResolvedValueOnce(jsonResponse({ ok: true, data: { id: 'p-1', slug: 'derby' } }, 201)); // Post
      const ch = makeChannel({
        base_url: 'https://cc.example', publish_path: '/api/integrations/news',
        media_upload: { path: '/api/integrations/media' },
      }, 'rest');
      const provider = new RestProvider();
      const r = await provider.publish(
        makeItem({ media: [{ type: 'image', source: 'generated', pathOrUrl: tmpFile }] }),
        ch, { API_TOKEN: 'tok' },
      );
      expect(r.externalId).toBe('p-1');
      // Call 1: multipart-Upload mit Bearer, Call 2: Post mit featuredMediaId
      const [uploadUrl, uploadInit] = fetchMock.mock.calls[0];
      expect(uploadUrl).toBe('https://cc.example/api/integrations/media');
      expect((uploadInit as RequestInit).body).toBeInstanceOf(FormData);
      expect(((uploadInit as RequestInit).headers as Record<string, string>).Authorization).toBe('Bearer tok');
      const postBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
      expect(postBody.featuredMediaId).toBe('media-7');
      expect(postBody.title).toBe('Derby-Sieg');
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('v1126: media_upload.alt_field — Alt-Text-Feldname konfigurierbar (lokalkraft.at verlangt „alt")', async () => {
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmpFile = join(tmpdir(), `alfred-test-altfield-${Date.now()}.png`);
    writeFileSync(tmpFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ data: { id: 'm-1' } }, 201))
        .mockResolvedValueOnce(jsonResponse({ data: { id: 'n-1', url: 'https://lokalkraft.at/news/x' } }, 201));
      const ch = makeChannel({
        base_url: 'https://lokalkraft.at', publish_path: '/api/integrations/v1/lokalkraft/news',
        media_upload: { path: '/api/integrations/v1/lokalkraft/media', alt_field: 'alt', attach_field: 'coverMediaId', id_field: 'data.id' },
      }, 'rest');
      const provider = new RestProvider();
      await provider.publish(
        makeItem({ media: [{ type: 'image', source: 'generated', pathOrUrl: tmpFile }] }),
        ch, { API_TOKEN: 'tok' },
      );
      const form = (fetchMock.mock.calls[0][1] as RequestInit).body as FormData;
      expect(form.get('alt')).toBe('Derby-Sieg'); // Item-Titel als Alt-Text im konfigurierten Feld
      expect(form.get('altText')).toBeNull();     // Default-Feld bleibt leer
      const postBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
      expect(postBody.coverMediaId).toBe('m-1');
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('v953: Media-Upload-Fehlschlag → Publish wirft (kein stiller Post ohne Bild)', async () => {
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmpFile = join(tmpdir(), `alfred-test-media-fail-${Date.now()}.png`);
    writeFileSync(tmpFile, Buffer.from([1]));
    try {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, code: 'VALIDATION_FAILED' }, 400));
      const ch = makeChannel({ base_url: 'https://cc.example', media_upload: { path: '/api/integrations/media' } }, 'rest');
      await expect(new RestProvider().publish(
        makeItem({ media: [{ type: 'image', source: 'generated', pathOrUrl: tmpFile }] }), ch, { API_TOKEN: 't' },
      )).rejects.toThrow(/Media-Upload HTTP 400/);
      expect(fetchMock.mock.calls.length).toBe(1); // kein Post-Call
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('v943: unaufgelöste url_template-Platzhalter → keine URL statt kaputtem Link', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { id: 'x1' } }));
    const provider = new RestProvider();
    const ch = makeChannel({ base_url: 'https://ex.at', url_template: 'https://ex.at/news/{data.slug}' }, 'rest');
    const r = await provider.publish(makeItem(), ch, {});
    expect(r.url).toBeUndefined();
  });
});

describe('BlueskyProvider (v1013)', () => {
  const channel = makeChannel({ handle: 'fussballcc.bsky.social' }, 'bluesky');

  it('linkFacets: Byte-Offsets (UTF-8!) + Satzzeichen am URL-Ende abgeschnitten', () => {
    const text = 'Müller trifft! 👉 Ganzer Artikel: https://fussball.cc/news/x.';
    const facets = BlueskyProvider.linkFacets(text);
    expect(facets.length).toBe(1);
    expect(facets[0].features[0].uri).toBe('https://fussball.cc/news/x');
    const { byteStart, byteEnd } = facets[0].index;
    expect(Buffer.from(text, 'utf8').slice(byteStart, byteEnd).toString('utf8')).toBe('https://fussball.cc/news/x');
  });

  it('v1022: Kürzungs-Ellipse „…" gehört nicht zur Facet-URL (Realfall 06.07.)', () => {
    const facets = BlueskyProvider.linkFacets('👉 Ganzer Artikel: https://fussball.cc/news/azteca…');
    expect(facets.length).toBe(1);
    expect(facets[0].features[0].uri).toBe('https://fussball.cc/news/azteca');
  });

  it('v1083: pdsHostFromDidDoc liest den PDS-Host fürs Video-Service-Token (aud = PDS-DID, Realfall 09.07.)', () => {
    const didDoc = {
      service: [
        { id: '#other', type: 'SomethingElse', serviceEndpoint: 'https://example.com' },
        { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://poisonpie.us-west.host.bsky.network' },
      ],
    };
    expect(BlueskyProvider.pdsHostFromDidDoc(didDoc)).toBe('poisonpie.us-west.host.bsky.network');
    expect(BlueskyProvider.pdsHostFromDidDoc(undefined)).toBeUndefined();
    expect(BlueskyProvider.pdsHostFromDidDoc({ service: [] })).toBeUndefined();
    expect(BlueskyProvider.pdsHostFromDidDoc({ service: [{ id: '#atproto_pds', serviceEndpoint: 'kein-url' }] })).toBeUndefined();
  });

  it('publish: createSession → uploadBlob (lokales Bild) → createRecord mit Facets + Embed', async () => {
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const img = join(tmpdir(), `alfred-bsky-${Date.now()}.png`);
    writeFileSync(img, Buffer.from([0x89, 0x50]));
    try {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ accessJwt: 'JWT', did: 'did:plc:abc', handle: 'fussballcc.bsky.social' }))
        .mockResolvedValueOnce(jsonResponse({ blob: { ref: 'blob-1' } }))
        .mockResolvedValueOnce(jsonResponse({ uri: 'at://did:plc:abc/app.bsky.feed.post/3k2xyz' }));
      const provider = new BlueskyProvider();
      const r = await provider.publish(
        makeItem({ body: 'Kolumbien weiter! https://fussball.cc/news/kolumbien', media: [{ type: 'image', source: 'generated', pathOrUrl: img }] }),
        channel, { BLUESKY_APP_PASSWORD: 'app-pass' },
      );
      expect(r.externalId).toBe('3k2xyz');
      expect(r.url).toBe('https://bsky.app/profile/fussballcc.bsky.social/post/3k2xyz');
      expect(String(fetchMock.mock.calls[0][0])).toContain('createSession');
      expect(String(fetchMock.mock.calls[1][0])).toContain('uploadBlob');
      const record = JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string).record;
      expect(record.facets[0].features[0].uri).toBe('https://fussball.cc/news/kolumbien');
      expect(record.embed.images[0].image).toEqual({ ref: 'blob-1' });
    } finally { unlinkSync(img); }
  });

  it('validateAuth ok/fehlgeschlagen; deletePost nutzt rkey', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ accessJwt: 'J', did: 'd', handle: 'h.bsky.social' }));
    expect(await new BlueskyProvider().validateAuth(channel, { BLUESKY_APP_PASSWORD: 'p' })).toEqual({ ok: true, detail: 'h.bsky.social' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Invalid identifier or password' }, 401));
    const bad = await new BlueskyProvider().validateAuth(channel, { BLUESKY_APP_PASSWORD: 'x' });
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('Invalid identifier');

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ accessJwt: 'J', did: 'did:plc:abc', handle: 'h' }))
      .mockResolvedValueOnce(jsonResponse({}));
    expect(await new BlueskyProvider().deletePost('3k2xyz', channel, { BLUESKY_APP_PASSWORD: 'p' })).toBe(true);
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(String(lastCall[0])).toContain('deleteRecord');
    const del = JSON.parse((lastCall[1] as RequestInit).body as string);
    expect(del.rkey).toBe('3k2xyz');
  });
});

describe('v1019 — fetchAudience', () => {
  it('Bluesky: Follower via öffentlichem AppView', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ followersCount: 421 }));
    const r = await new BlueskyProvider().fetchAudience(makeChannel({ handle: 'fussballcc.bsky.social' }, 'bluesky'), {});
    expect(r).toEqual({ followers: 421 });
    expect(String(fetchMock.mock.calls[0][0])).toContain('public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=fussballcc.bsky.social');
  });

  it('Telegram: getChatMemberCount; Fehler → null', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: 987 }));
    const provider = new TelegramChannelProvider('T');
    expect(await provider.fetchAudience(makeChannel({ chat_id: '@fussballcc' }, 'telegram_channel'), {})).toEqual({ followers: 987 });
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false }, 400));
    expect(await provider.fetchAudience(makeChannel({ chat_id: '@fussballcc' }, 'telegram_channel'), {})).toBeNull();
  });

  it('Rest: audience.followers aus dem Stats-Endpoint (fussball.cc = registrierte User); ohne Feld → null', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, audience: { followers: 1234 }, data: [] }));
    const ch = makeChannel({ base_url: 'https://cc.example' }, 'rest');
    expect(await new RestProvider().fetchAudience(ch, { API_TOKEN: 't' })).toEqual({ followers: 1234 });
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: [] }));
    expect(await new RestProvider().fetchAudience(ch, { API_TOKEN: 't' })).toBeNull();
  });
});
