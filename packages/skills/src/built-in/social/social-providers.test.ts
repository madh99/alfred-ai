import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramChannelProvider } from './telegram-channel-provider.js';
import { RestProvider } from './rest-provider.js';
import { BEST_PRACTICE_SLOTS, effectiveSlots } from './social-provider.js';
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
