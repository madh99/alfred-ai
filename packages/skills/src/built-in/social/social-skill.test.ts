import { describe, it, expect, vi } from 'vitest';
import { SocialSkill } from './social-skill.js';
import { SocialProvider, appendUtm, composePostText, type ProviderCapabilities, type PublishResult } from './social-provider.js';
import type { SocialRepository, SocialChannel, ContentItem } from '@alfred/storage';
import type { SkillContext } from '@alfred/types';

const CTX = { userId: 'u1', masterUserId: 'u1', platform: 'api', chatId: 'c1' } as unknown as SkillContext;

function makeChannel(overrides: Partial<SocialChannel> = {}): SocialChannel {
  return {
    id: 'ch-1', userId: 'u1', platform: 'test', name: 'Testkanal',
    mode: 'suggest', publishMode: 'api', planningHorizonDays: 14, postingSlots: [],
    blacklist: [], maxPostsPerDay: 3, approvedStreak: 0, status: 'active', config: {},
    createdAt: 'x', updatedAt: 'x', ...overrides,
  };
}

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: 'item-0001-aaaa', channelId: 'ch-1', userId: 'u1', status: 'draft',
    body: 'Hallo Welt', media: [], hashtags: ['fussball'], source: 'manual',
    createdAt: 'x', updatedAt: 'x', ...overrides,
  };
}

class FakeProvider extends SocialProvider {
  readonly platform: string;
  published: ContentItem[] = [];
  stories: string[] = [];
  failNext = false;
  constructor(platform = 'test') { super(); this.platform = platform; }
  comments: Array<{ itemId: string; externalCommentId: string; author?: string; text: string }> = [];
  capabilities(): ProviderCapabilities { return { text: true, image: true, video: ['facebook', 'x', 'telegram_channel', 'bluesky'].includes(this.platform), supportsDelete: true, supportsMetrics: false, supportsStories: this.platform === 'instagram', supportsComments: true }; }
  override async publishStory(imageUrl: string): Promise<PublishResult> {
    this.stories.push(imageUrl);
    return { externalId: 'story-1', url: 'https://instagram.com/stories/1' };
  }
  override async fetchComments(): Promise<any[]> { return this.comments; }
  async publish(item: ContentItem): Promise<PublishResult> {
    if (this.failNext) { this.failNext = false; throw new Error('API down'); }
    this.published.push(item);
    return { externalId: 'ext-1', url: 'https://ex.at/p/1' };
  }
  async validateAuth(): Promise<{ ok: boolean; detail?: string }> { return { ok: true, detail: 'Testkanal' }; }
  override async deletePost(): Promise<boolean> { return true; }
}

function makeRepo(channel: SocialChannel, item: ContentItem) {
  const state = { channel: { ...channel }, item: { ...item } };
  const repo = {
    createChannel: vi.fn(async (_u: string, o: any) => ({ ...makeChannel(), ...o, id: 'ch-new' })),
    getChannel: vi.fn(async (_u: string, id: string) => (id === state.channel.id ? state.channel : null)),
    findChannelByName: vi.fn(async (_u: string, q: string) =>
      state.channel.name.toLowerCase().includes(q.toLowerCase()) ? state.channel : null),
    listChannels: vi.fn(async () => [state.channel]),
    listAllActiveChannels: vi.fn(async () => [state.channel]),
    updateChannel: vi.fn(async (_u: string, _id: string, patch: any) => { Object.assign(state.channel, patch); }),
    deleteItem: vi.fn(async () => true),
    pauseAll: vi.fn(async () => 1),
    createItem: vi.fn(async (_u: string, chId: string, o: any) => ({ ...makeItem(), ...o, channelId: chId, id: 'item-new' })),
    getItem: vi.fn(async (_u: string, id: string) => (id === state.item.id ? state.item : null)),
    listItems: vi.fn(async () => [state.item]),
    transition: vi.fn(async (_u: string, _id: string, to: any, extra?: any) => {
      state.item = { ...state.item, status: to, ...(extra ?? {}) };
      return state.item;
    }),
    updateItemContent: vi.fn(async () => {}),
    mergePerformance: vi.fn(async (_u: string, _id: string, perf: Record<string, unknown>) => { state.item = { ...state.item, performance: { ...state.item.performance, ...perf } }; }),
    reschedule: vi.fn(async (_u: string, _id: string, at: string) => { state.item = { ...state.item, scheduledAt: at }; return true; }),
    countPublishedToday: vi.fn(async () => 0),
    upsertMetric: vi.fn(async () => {}),
    listMetrics: vi.fn(async () => []),
    createMediaAsset: vi.fn(async () => ({ id: 'asset-1' })),
    listMediaAssets: vi.fn(async () => []),
  };
  return { repo: repo as unknown as SocialRepository, state, spies: repo };
}

function makeSkill(channel: SocialChannel, item: ContentItem) {
  const { repo, state, spies } = makeRepo(channel, item);
  const skill = new SocialSkill(repo);
  const provider = new FakeProvider();
  skill.registerProvider(provider);
  skill.setSecretsResolver(async () => ({ API_TOKEN: 't' }));
  return { skill, provider, state, spies };
}

describe('composePostText', () => {
  it('Body + Hashtags, Titel vorangestellt', () => {
    const text = composePostText(makeItem({ title: 'Derby-Sieg!', hashtags: ['fussball', '#noe'] }));
    expect(text).toContain('Derby-Sieg!');
    expect(text).toContain('Hallo Welt');
    expect(text).toContain('#fussball #noe');
  });

  it('kürzt auf maxLength, Hashtags bleiben erhalten', () => {
    const text = composePostText(makeItem({ body: 'x'.repeat(500), hashtags: ['tag'] }), 120);
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text).toContain('#tag');
  });

  it('v1098: Bluesky-Realfall — UTM fliegt vor dem Body, Hashtags vor dem Inhalt („A Worl…"-Bug)', () => {
    const body = 'A World Cup squad has been announced without its most famous name, and the reaction back home tells a bigger story about the team. '
      + '\n\n👉 Ganzer Artikel: https://fussball.cc/news/sudafrikas-wm-kader-ohne-star?utm_source=bluesky&utm_medium=social&utm_campaign=sudafrikas-wm-kader-ohne-star';
    const item = makeItem({
      title: 'A Squad Left Without One of Its Own', body,
      hashtags: ['SouthAfricaFootball', 'WorldCup2026', 'JaydenAdams'],
      media: [{ type: 'image', source: 'generated', pathOrUrl: '/tmp/x.png' }],
    });
    const text = composePostText(item, 300, makeChannel());
    expect(text.length).toBeLessThanOrEqual(300);
    // Stufe 1: Link bleibt, aber ohne UTM-Ballast
    expect(text).toContain('https://fussball.cc/news/sudafrikas-wm-kader-ohne-star');
    expect(text).not.toContain('utm_');
    // der Body ist wieder Inhalt statt „A Worl…"
    expect(text).toContain('A World Cup squad has been announced');
    // Kennzeichnung überlebt
    expect(text).toContain('Bild: KI-generiert');
  });

  it('v1098: mit urlWeight (X, t.co zählt 23) bleiben die UTM-Parameter erhalten', () => {
    const body = 'z'.repeat(400) + '\n\n👉 Ganzer Artikel: https://fussball.cc/news/x?utm_source=x&utm_medium=social&utm_campaign=x';
    const text = composePostText(makeItem({ body, hashtags: [] }), 280, undefined, { urlWeight: 23 });
    expect(text).toContain('utm_source=x'); // Attribution bleibt — Kürzung spart hier nichts
  });

  it('v985: generiertes Medium → KI-Kennzeichnung im Text (Default an, überlebt Kürzung)', () => {
    const item = makeItem({
      body: 'y'.repeat(500), hashtags: ['tag'],
      media: [{ type: 'image', source: 'generated', pathOrUrl: '/tmp/x.png' }],
    });
    const text = composePostText(item, 160, makeChannel());
    expect(text).toContain('Bild: KI-generiert');
    expect(text.length).toBeLessThanOrEqual(160);
    // eigener Text + Abschalten per Kanal-Config
    const custom = composePostText(item, undefined, makeChannel({ config: { ai_disclosure_text: 'Symbolbild (KI)' } }));
    expect(custom).toContain('Symbolbild (KI)');
    const off = composePostText(item, undefined, makeChannel({ config: { ai_disclosure: false } }));
    expect(off).not.toContain('KI-generiert');
  });

  it('v1022: Traffic-Link am Body-Ende überlebt die Kürzung (Bluesky 300)', () => {
    const url = 'https://fussball.cc/news/azteca?utm_source=bluesky&utm_medium=social&utm_campaign=azteca';
    const item = makeItem({ title: 'Aztekenstadion', body: `${'Mexiko verliert erstmals. '.repeat(20)}\n\n👉 Ganzer Artikel: ${url}`, hashtags: ['WorldCup', 'Mexico'] });
    const text = composePostText(item, 300);
    expect(text.length).toBeLessThanOrEqual(300);
    // v1098 — im Kürzungsfall fliegen zuerst die UTM-Parameter (Link bleibt funktional)
    expect(text).toContain('https://fussball.cc/news/azteca');
    expect(text).not.toContain('utm_');
    expect(text).toContain('#WorldCup');
  });

  it('v1022: wird es eng, fliegen die Hashtags — nie der Link', () => {
    const url = 'https://fussball.cc/news/azteca';
    const item = makeItem({
      body: `${'w'.repeat(300)}\n\n👉 Ganzer Artikel: ${url}`,
      hashtags: ['aaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccc', 'dddddddddddddddddddd', 'eeeeeeeeeeeeeeeeeeee', 'ffffffffffffffffffff'],
    });
    const text = composePostText(item, 200);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).toContain(url);
    expect(text).not.toContain('#');
  });

  it('v1042: X zählt URLs als 23 Zeichen (t.co) — Body wird nicht mehr über-gekürzt', () => {
    const url = 'https://fussball.cc/news/viertelfinale-argentinien-aegypten?utm_source=x&utm_medium=social&utm_campaign=viertelfinale-argentinien-aegypten';
    const body = `${'Argentinien trifft im Viertelfinale auf Aegypten. '.repeat(4).trim()}\n\n👉 ${url}`;
    const item = makeItem({ body, hashtags: [] });
    // echte Länge > 280, t.co-gewichtet (URL=23) aber <= 280 → NICHT kürzen
    expect(body.length).toBeGreaterThan(280);
    const weighted = composePostText(item, 280, undefined, { urlWeight: 23 });
    expect(weighted).toContain(url); // URL komplett
    expect(weighted).not.toContain('…'); // keine Kürzung
    // ohne Gewichtung (Default): v1098 rettet zuerst die UTM-Parameter weg —
    // damit passt der volle Body wieder ins Limit (kein „…", Link funktional)
    const plain = composePostText(item, 280);
    expect(plain).not.toContain('utm_');
    expect(plain).toContain('https://fussball.cc/news/viertelfinale-argentinien-aegypten');
    expect(plain.length).toBeLessThanOrEqual(280);
  });

  it('v985: ohne generiertes Medium bzw. ohne Kanal keine Kennzeichnung', () => {
    const plain = makeItem({ media: [{ type: 'image', source: 'external', pathOrUrl: 'https://x/y.png' }] as any });
    expect(composePostText(plain, undefined, makeChannel())).not.toContain('KI-generiert');
    const generated = makeItem({ media: [{ type: 'image', source: 'generated', pathOrUrl: '/tmp/x.png' }] });
    expect(composePostText(generated)).not.toContain('KI-generiert');
  });
});

describe('v999 — Traffic-CTA (Follower verlinkt Lead-Artikel)', () => {
  it('appendUtm: Slug aus Titel (Umlaute), ?/& korrekt', () => {
    expect(appendUtm('https://fussball.cc/news/x', 'telegram_channel', 'Kolumbien überrascht Österreich!'))
      .toBe('https://fussball.cc/news/x?utm_source=telegram_channel&utm_medium=social&utm_campaign=kolumbien-ueberrascht-oesterreich');
    expect(appendUtm('https://x.at/p?id=1', 'facebook', '')).toContain('?id=1&utm_source=facebook');
  });

  it('v1022: appendUtm setzt die Parameter VOR ein #Fragment', () => {
    expect(appendUtm('https://x.at/artikel#kommentare', 'bluesky', 'Titel'))
      .toBe('https://x.at/artikel?utm_source=bluesky&utm_medium=social&utm_campaign=titel#kommentare');
  });

  function trafficSetup(channelOverrides: Partial<SocialChannel> = {}, leadStatus = 'published') {
    const channel = makeChannel({ platform: 'test', ...channelOverrides });
    const item = makeItem({ storyId: 'story-1', body: 'Kurzer Teaser zum Spiel.' });
    const { skill, provider, state, spies } = makeSkill(channel, item);
    const leadItem = makeItem({ id: 'lead-1', channelId: 'ch-web', status: leadStatus as any, title: 'Kolumbien komplettiert das Achtelfinale', externalUrl: 'https://fussball.cc/news/kolumbien' });
    (spies as any).listAssignments = vi.fn(async () => [
      { id: 'a1', storyId: 'story-1', channelId: 'ch-web', role: 'lead', offsetHours: 0, itemId: 'lead-1', createdAt: 'x' },
      { id: 'a2', storyId: 'story-1', channelId: 'ch-1', role: 'follow', offsetHours: 2, itemId: 'item-0001-aaaa', createdAt: 'x' },
    ]);
    (spies.getItem as any) = vi.fn(async (_u: string, id: string) =>
      id === 'lead-1' ? leadItem : id === state.item.id ? state.item : null);
    return { skill, provider, state, channel };
  }

  it('publish_now: ausgehender Text bekommt Lead-Link + UTM, gespeichertes Item bleibt unverändert', async () => {
    const { skill, provider, state } = trafficSetup();
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(true);
    expect(provider.published[0].body).toContain('👉 Ganzer Artikel: https://fussball.cc/news/kolumbien?utm_source=test&utm_medium=social&utm_campaign=kolumbien-komplettiert-das-achtelfinale');
    expect(state.item.body).toBe('Kurzer Teaser zum Spiel.'); // DB-Item ohne Link
  });

  it('instagram: CTA „Link im Profil" statt URL; traffic_cta=false schaltet ab; utm=false lässt URL nackt', async () => {
    const { skill: s1, channel: c1 } = trafficSetup();
    const ig = await (s1 as any).applyTrafficCta('u1', makeItem({ storyId: 'story-1', body: 'B.' }), { ...c1, platform: 'instagram' });
    expect(ig.body).toContain('Link im Profil');
    expect(ig.body).not.toContain('http');

    const { skill: s2, channel: c2 } = trafficSetup({ config: { traffic_cta: false } });
    const off = await (s2 as any).applyTrafficCta('u1', makeItem({ storyId: 'story-1', body: 'B.' }), c2);
    expect(off.body).toBe('B.');

    const { skill: s3, channel: c3 } = trafficSetup({ config: { utm: false } });
    const bare = await (s3 as any).applyTrafficCta('u1', makeItem({ storyId: 'story-1', body: 'B.' }), c3);
    expect(bare.body).toContain('https://fussball.cc/news/kolumbien');
    expect(bare.body).not.toContain('utm_source');
  });

  it('v1001: telegram_channel → Body bleibt, URL wandert als trafficUrl in die Performance (Inline-Button)', async () => {
    const { skill, channel } = trafficSetup({ platform: 'telegram_channel' });
    const out = await (skill as any).applyTrafficCta('u1', makeItem({ storyId: 'story-1', body: 'B.' }), channel);
    expect(out.body).toBe('B.');
    expect(out.performance.trafficUrl).toContain('https://fussball.cc/news/kolumbien?utm_source=telegram_channel');
  });

  it('v1001: suggest_reply bekommt den Lead-Artikel-Link in den Prompt', async () => {
    const { skill, state, channel } = trafficSetup();
    const spies = (skill as any).repo;
    spies.getComment = vi.fn(async () => ({ id: 'c-1', channelId: channel.id, itemId: state.item.id, author: 'Fan', text: 'Wo finde ich Details?', status: 'new' }));
    const complete = vi.fn(async (_req: { messages: Array<{ content: string }> }) => ({ content: 'Alle Details stehen im Artikel!' }));
    (skill as any).llm = { complete };
    const r = await skill.execute({ action: 'suggest_reply', comment_id: 'c-1' }, CTX);
    expect(r.success).toBe(true);
    const prompt = complete.mock.calls[0]![0].messages[0].content;
    expect(prompt).toContain('AUSFÜHRLICHER ARTIKEL ZUM BEITRAG: https://fussball.cc/news/kolumbien');
    expect(prompt).toContain('DARFST du die Artikel-URL');
  });

  it('v1001: collectTrafficStats — views auf den rest-Kanal, clicks je utm_source auf den Familien-Kanal', async () => {
    const rest = makeChannel({ id: 'ch-web', name: 'fussball.cc', platform: 'rest', projectId: 'p1', config: { base_url: 'https://fussball.cc' } });
    const tg = makeChannel({ id: 'ch-tg', name: 'News', platform: 'telegram_channel', projectId: 'p1' });
    const leadItem = makeItem({ id: 'lead-1', channelId: 'ch-web', status: 'published', storyId: 'story-1', externalUrl: 'https://fussball.cc/news/kolumbien' });
    const { skill } = makeSkill(rest, leadItem);
    const spies = (skill as any).repo;
    spies.listChannels = vi.fn(async () => [rest, tg]);
    spies.listItems = vi.fn(async () => [leadItem]);
    spies.listAssignments = vi.fn(async () => [
      { id: 'a1', storyId: 'story-1', channelId: 'ch-web', role: 'lead', offsetHours: 0, itemId: 'lead-1', createdAt: 'x' },
      { id: 'a2', storyId: 'story-1', channelId: 'ch-tg', role: 'follow', offsetHours: 2, itemId: 'item-tg', createdAt: 'x' },
    ]);
    const metrics: any[] = [];
    spies.upsertMetric = vi.fn(async (chId: string, m: any) => { metrics.push({ chId, ...m }); });
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => ({
      ok: true,
      json: async () => ({ ok: true, data: [{ date: '2026-07-05', path: '/news/kolumbien', views: 143, sources: { telegram_channel: 12, direct: 80 } }] }),
    }));
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const n = await skill.collectTrafficStats('u1');
      expect(n).toBe(2);
    } finally { globalThis.fetch = orig; }
    expect(String(fetchMock.mock.calls[0][0])).toContain('https://fussball.cc/api/integrations/stats?since=');
    expect(metrics).toContainEqual({ chId: 'ch-web', itemId: 'lead-1', date: '2026-07-05', kind: 'views', value: 143 });
    expect(metrics).toContainEqual({ chId: 'ch-tg', itemId: 'item-tg', date: '2026-07-05', kind: 'clicks', value: 12 });
    // direct hat keinen Familien-Kanal → ignoriert
    expect(metrics.length).toBe(2);
  });

  it('kein Link: Lead selbst, rest-Plattform, Lead nicht published, Item ohne Story', async () => {
    const { skill } = trafficSetup();
    const asLead = await (skill as any).applyTrafficCta('u1', makeItem({ id: 'lead-1', storyId: 'story-1', body: 'B.' }), makeChannel({ platform: 'test' }));
    expect(asLead.body).toBe('B.');
    const rest = await (skill as any).applyTrafficCta('u1', makeItem({ storyId: 'story-1', body: 'B.' }), makeChannel({ platform: 'rest' }));
    expect(rest.body).toBe('B.');
    const noStory = await (skill as any).applyTrafficCta('u1', makeItem({ body: 'B.' }), makeChannel({ platform: 'test' }));
    expect(noStory.body).toBe('B.');

    const { skill: s4, channel: c4 } = trafficSetup({}, 'scheduled'); // Lead noch nicht live
    const early = await (s4 as any).applyTrafficCta('u1', makeItem({ storyId: 'story-1', body: 'B.' }), c4);
    expect(early.body).toBe('B.');
  });
});

describe('v1019 — Kanalwachstum (collectAudience)', () => {
  it('schreibt den Tagesstand als kind followers; Provider ohne supportsAudience wird übersprungen', async () => {
    const channel = makeChannel({});
    const { skill, spies } = makeSkill(channel, makeItem());
    const provider = (skill as any).providers.get('test') as FakeProvider;
    (provider as any).capabilities = () => ({ text: true, image: true, video: false, supportsDelete: true, supportsMetrics: false, supportsAudience: true });
    (provider as any).fetchAudience = vi.fn(async () => ({ followers: 1284 }));
    const metrics: any[] = [];
    (spies as any).upsertMetric = vi.fn(async (chId: string, m: any) => { metrics.push({ chId, ...m }); });
    const r = await skill.collectAudience('u1');
    expect(r.collected).toBe(1);
    expect(metrics[0].kind).toBe('followers');
    expect(metrics[0].value).toBe(1284);
    expect(metrics[0].itemId).toBeUndefined();

    // Provider ohne Audience-Support → nichts
    (provider as any).capabilities = () => ({ text: true, image: true, video: false, supportsDelete: true, supportsMetrics: false });
    metrics.length = 0;
    expect((await skill.collectAudience('u1')).collected).toBe(0);
    expect(metrics.length).toBe(0);
  });

  it('v1021: Meilenstein wird erkannt (gestern 480 → heute 520 kreuzt 500), Dedup über prev', async () => {
    const channel = makeChannel({});
    const { skill, spies } = makeSkill(channel, makeItem());
    const provider = (skill as any).providers.get('test') as FakeProvider;
    (provider as any).capabilities = () => ({ text: true, image: true, video: false, supportsDelete: true, supportsMetrics: false, supportsAudience: true });
    (provider as any).fetchAudience = vi.fn(async () => ({ followers: 520 }));
    const yesterday = new Date(Date.now() - 24 * 3_600_000).toISOString().slice(0, 10);
    (spies as any).listMetrics = vi.fn(async () => [{ date: yesterday, kind: 'followers', value: 480 }]);
    (spies as any).upsertMetric = vi.fn(async () => {});
    const r = await skill.collectAudience('u1');
    expect(r.milestones).toEqual([{ channel: 'Testkanal', channelId: 'ch-1', milestone: 500, followers: 520 }]);

    // kein prev-Wert (erster Lauf) → kein Meilenstein-Feuerwerk
    (spies as any).listMetrics = vi.fn(async () => []);
    expect((await skill.collectAudience('u1')).milestones).toEqual([]);
  });
});

describe('v1011 — health_check (Deploy-Sicherheitsnetz)', () => {
  it('prüft sharp, Medien-Ablage, LLM, Auth und Stats-Endpoint (404 = informativ, kein Problem)', async () => {
    const { tmpdir } = await import('node:os');
    const channel = makeChannel({ platform: 'rest', config: { base_url: 'https://cc.example' } });
    const { skill } = makeSkill(channel, makeItem({ channelId: 'ch-1' }));
    const rest = new FakeProvider('rest');
    skill.registerProvider(rest);
    skill.setMediaDir(tmpdir());
    (skill as any).llm = { complete: vi.fn() };
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    let r;
    try {
      r = await skill.execute({ action: 'health_check' }, CTX);
    } finally { globalThis.fetch = orig; }
    expect(r.success).toBe(true);
    expect(r.display).toContain('✅ sharp geladen');
    expect(r.display).toContain('✅ Medien-Ablage beschreibbar');
    expect(r.display).toContain('✅ LLM verfügbar');
    expect(r.display).toContain('Auth ok');
    expect(r.display).toContain('Stats-Endpoint noch nicht vorhanden');
    expect((r.data as any).problems).toBe(0);
  });

  it('401 am Stats-Endpoint → Scope-Warnung als Problem gezählt', async () => {
    const channel = makeChannel({ platform: 'rest', config: { base_url: 'https://cc.example' } });
    const { skill } = makeSkill(channel, makeItem({ channelId: 'ch-1' }));
    skill.registerProvider(new FakeProvider('rest'));
    (skill as any).llm = { complete: vi.fn() };
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    let r;
    try { r = await skill.execute({ action: 'health_check' }, CTX); } finally { globalThis.fetch = orig; }
    expect(r.display).toContain('API-Key-Scope prüfen');
    expect((r.data as any).problems).toBeGreaterThan(0);
  });
});

describe('v1010 — Lessons-Hygiene (Konsolidierungs-Vorschlag)', () => {
  it('>5 Lektionen → Vorschlag mit Vorher/Nachher; ≤5 → nichts (kein LLM-Call)', async () => {
    const many = ['WM nicht EM', 'Es ist die WM 2026, nicht die EM', 'Ort immer nennen', 'Der Kanal ist Medium, nicht Veranstalter', 'Keine relativen Zeitwörter', 'Runde exakt aus dem Dossier', 'Hashtags nie in den Body'];
    const channel = makeChannel({ config: { lessons: many } });
    const { skill } = makeSkill(channel, makeItem());
    const complete = vi.fn(async (_r: { messages: Array<{ content: string }> }) => ({
      content: '["Es ist die WM 2026, nicht die EM — auch in Hashtags", "Ort immer nennen, Runde exakt aus dem Dossier", "Der Kanal ist Medium, nicht Veranstalter", "Keine relativen Zeitwörter", "Hashtags nie in den Body"]',
    }));
    (skill as any).llm = { complete };
    const props = await skill.consolidateLessons('u1');
    expect(props.length).toBe(1);
    expect(props[0].before.length).toBe(7);
    expect(props[0].after.length).toBe(5);
    expect(props[0].after[0]).toContain('WM 2026');

    const few = makeChannel({ config: { lessons: ['nur eine'] } });
    const { skill: s2 } = makeSkill(few, makeItem());
    const spy = vi.fn(async () => ({ content: '[]' }));
    (s2 as any).llm = { complete: spy };
    expect(await s2.consolidateLessons('u1')).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('v1009 — Kommentar-Copilot (Triage + Antwort-Vorschläge)', () => {
  it('Spam/Hass werden ignoriert, Fragen bekommen einen Vorschlag im Batch-Ergebnis', async () => {
    const channel = makeChannel({});
    const item = makeItem({ status: 'published', externalId: 'ext-9' });
    const { skill, spies } = makeSkill(channel, item);
    const provider = (skill as any).providers.get('test') as FakeProvider;
    provider.comments = [
      { itemId: item.id, externalCommentId: 'x1', author: 'Bot4711', text: 'CHEAP FOLLOWERS click here www.spam.tld' },
      { itemId: item.id, externalCommentId: 'x2', author: 'Wutbürger', text: 'Ihr seid alle Vollidioten!!!' },
      { itemId: item.id, externalCommentId: 'x3', author: 'Fan', text: 'Wann ist eigentlich Anpfiff beim nächsten Spiel?' },
    ];
    (spies as any).upsertComment = vi.fn(async () => true);
    const newComments = [
      { id: 'c-1', channelId: 'ch-1', author: 'Bot4711', text: 'CHEAP FOLLOWERS click here www.spam.tld', status: 'new' },
      { id: 'c-2', channelId: 'ch-1', author: 'Wutbürger', text: 'Ihr seid alle Vollidioten!!!', status: 'new' },
      { id: 'c-3', channelId: 'ch-1', author: 'Fan', text: 'Wann ist eigentlich Anpfiff beim nächsten Spiel?', status: 'new' },
    ];
    (spies as any).listComments = vi.fn(async () => newComments);
    const statusCalls: any[] = [];
    (spies as any).setCommentStatus = vi.fn(async (_u: string, id: string, status: string) => { statusCalls.push({ id, status }); });
    (spies as any).getComment = vi.fn(async (_u: string, id: string) => newComments.find(c => c.id === id) ?? null);
    const complete = vi.fn(async (_r: { messages: Array<{ content: string }> }) => ({ content: '' }));
    complete
      .mockResolvedValueOnce({ content: '[{"index":0,"spam":true,"hass":false,"frage":false},{"index":1,"spam":false,"hass":true,"frage":false},{"index":2,"spam":false,"hass":false,"frage":true}]' })
      .mockResolvedValueOnce({ content: 'Anpfiff ist am 6. Juli um 21:00 — alle Details im Artikel!' });
    (skill as any).llm = { complete };

    const r = await skill.collectComments('u1');
    expect(r.collected).toBe(3);
    const info = r.byChannel[0];
    expect(info.spamIgnored).toBe(1);
    expect(info.hassFlagged).toBe(1);
    expect(statusCalls).toEqual([{ id: 'c-1', status: 'ignored' }, { id: 'c-2', status: 'ignored' }]);
    expect(info.suggestions![0].id).toBe('c-3');
    expect(info.suggestions![0].draft).toContain('Anpfiff ist am 6. Juli');
  });

  it('comment_triage=false → nur Zählung, keine LLM-Calls', async () => {
    const channel = makeChannel({ config: { comment_triage: false } });
    const item = makeItem({ status: 'published', externalId: 'ext-9' });
    const { skill, spies } = makeSkill(channel, item);
    const provider = (skill as any).providers.get('test') as FakeProvider;
    provider.comments = [{ itemId: item.id, externalCommentId: 'x1', text: 'Frage?' }];
    (spies as any).upsertComment = vi.fn(async () => true);
    const complete = vi.fn(async () => ({ content: '[]' }));
    (skill as any).llm = { complete };
    const r = await skill.collectComments('u1');
    expect(r.byChannel[0].count).toBe(1);
    expect(r.byChannel[0].spamIgnored).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('v1016 — Auto-Reel (Entwurf beim Lead-Publish)', () => {
  function reelSetup(igConfig: Record<string, unknown> = { auto_reel: true }) {
    const lead = makeChannel({ id: 'ch-web', platform: 'rest', name: 'fussball.cc', projectId: 'p1', config: { base_url: 'https://cc.example' } });
    const ig = makeChannel({ id: 'ch-ig', platform: 'instagram', name: 'FussballCC IG', projectId: 'p1', config: igConfig });
    const leadItem = makeItem({ channelId: 'ch-web', storyId: 's-1', title: 'Kolumbien weiter', body: 'Ein ausreichend langer Artikeltext über das Achtelfinale mit vielen Details.', hashtags: ['wm2026'] });
    const { skill, spies, state } = makeSkill(lead, leadItem);
    skill.registerProvider(new FakeProvider('rest'));
    skill.registerProvider(new FakeProvider('instagram'));
    (spies as any).listChannels = vi.fn(async () => [lead, ig]);
    (spies as any).listAssignments = vi.fn(async () => [
      { id: 'a1', storyId: 's-1', channelId: 'ch-web', role: 'lead', offsetHours: 0, itemId: 'item-0001-aaaa', createdAt: 'x' },
      { id: 'a2', storyId: 's-1', channelId: 'ch-ig', role: 'follow', offsetHours: 6, itemId: 'item-ig', createdAt: 'x' },
    ]);
    const follower = makeItem({ id: 'item-ig', channelId: 'ch-ig', media: [{ type: 'image', source: 'generated', pathOrUrl: '/tmp/bild.png' }] });
    const origGetItem = (spies as any).getItem;
    (spies as any).getItem = vi.fn(async (u: string, id: string) => (id === 'item-ig' ? follower : origGetItem(u, id)));
    const created: any[] = [];
    (spies as any).createItem = vi.fn(async (_u: string, chId: string, o: any) => { created.push({ chId, ...o }); return { ...makeItem(), ...o, channelId: chId, id: 'reel-doc' }; });
    const render = vi.fn(async () => ({ videoPath: '/tmp/reel.mp4', durationSec: 25 }));
    skill.setVideoTools({ render, probe: vi.fn(async () => ({ ok: true })) } as any);
    const complete = vi.fn(async () => ({ content: '{"script": "Kolumbien steht im Viertelfinale und keiner hat es kommen sehen — die ganze Geschichte in dreißig Sekunden.", "caption": "Kolumbien weiter! Wer stoppt sie noch?"}' }));
    (skill as any).llm = { complete };
    return { skill, spies, state, created, render, complete };
  }

  it('Lead published → Reel-ENTWURF mit Video, Script und Wochen-Limit-Zählung', async () => {
    const { skill, created, render } = reelSetup();
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(true);
    await new Promise(res => setTimeout(res, 10)); // fire-and-forget abwarten
    expect(render).toHaveBeenCalled();
    // v1022 — Titel OHNE „Reel: "-Präfix (er liefe beim Publish in die öffentliche Caption)
    const reel = created.find(c => c.media?.[0]?.type === 'video');
    expect(reel).toBeDefined();
    expect(reel.title).toBe('Kolumbien weiter');
    expect(reel.chId).toBe('ch-ig');
    expect(reel.status).toBe('draft'); // bewusst MIT Freigabe
    expect(reel.media[0]).toEqual({ type: 'video', source: 'generated', pathOrUrl: '/tmp/reel.mp4' });
    // v1086 — das gerenderte Reel landet in der Video-Bibliothek
    const assetCall = ((skill as any).repo.createMediaAsset as any).mock.calls[0];
    expect(assetCall[1]).toMatchObject({ kind: 'video', path: '/tmp/reel.mp4', model: 'reel', durationSec: 25 });
  });

  it('v1068: findRecentChannelDuplicate — gleiche Kriterien für Gate und Vorab-Check', async () => {
    const { findRecentChannelDuplicate } = await import('./social-skill.js');
    const published = [
      makeItem({ id: 'item-pub1-aaaa', status: 'published', title: 'Marokko im Viertelfinale – der nächste Coup?' }),
      makeItem({ id: 'item-pub2-bbbb', status: 'published', title: 'Transferupdate: Neuer Stürmer für Salzburg', storyId: 's-9' }),
    ];
    const repo = { listItems: vi.fn(async () => published) } as any;
    // Titel-Ähnlichkeit (Kandidat ohne id — Vorab-Check-Fall)
    const dup = await findRecentChannelDuplicate(repo, 'u1', 'ch-1', { title: 'Marokko im Viertelfinale: der Coup geht weiter', body: 'x' });
    expect(dup?.id).toBe('item-pub1-aaaa');
    // Story-Identität schlägt Titel
    const storyDup = await findRecentChannelDuplicate(repo, 'u1', 'ch-1', { title: 'Völlig anderer Titel', body: 'x', storyId: 's-9' });
    expect(storyDup?.id).toBe('item-pub2-bbbb');
    // Begleitformate sind ausgenommen
    const reel = await findRecentChannelDuplicate(repo, 'u1', 'ch-1', { title: 'Marokko im Viertelfinale: der Coup geht weiter', body: 'x', performance: { format: 'reel' } });
    expect(reel).toBeUndefined();
    // kein Treffer bei unähnlichem Titel ohne Story
    const none = await findRecentChannelDuplicate(repo, 'u1', 'ch-1', { title: 'Panini-Album: Sticker-Tausch am Samstag', body: 'x' });
    expect(none).toBeUndefined();
  });

  it('v1064: reject_content nimmt den FB-Zwilling mit derselben Videodatei mit', async () => {
    const ig = makeChannel({ id: 'ch-ig', platform: 'instagram', name: 'FussballCC IG' });
    const fb = makeChannel({ id: 'ch-fb', platform: 'facebook', name: 'FussballCC FB' });
    const reel = makeItem({
      id: 'item-0001-aaaa', channelId: 'ch-ig', status: 'draft',
      media: [{ type: 'video', source: 'generated', pathOrUrl: '/tmp/reel.mp4' }],
      performance: { format: 'reel', autoReel: true },
    });
    const twin = makeItem({
      id: 'item-0002-bbbb', channelId: 'ch-fb', status: 'draft',
      media: [{ type: 'video', source: 'generated', pathOrUrl: '/tmp/reel.mp4' }],
      performance: { format: 'reel', autoReel: true },
    });
    const { skill, spies } = makeSkill(ig, reel);
    (spies as any).listChannels = vi.fn(async () => [ig, fb]);
    (spies as any).listItems = vi.fn(async (_u: string, q: any) => (q?.channelId === 'ch-fb' ? [twin] : [reel]));
    const r = await skill.execute({ action: 'reject_content', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(true);
    expect((spies as any).transition).toHaveBeenCalledWith('u1', 'item-0002-bbbb', 'rejected');
    expect(r.display).toContain('mit-abgelehnt');
  });

  it('v1064: reject_content OHNE Video-Zwilling lässt fremde Items in Ruhe', async () => {
    const ig = makeChannel({ id: 'ch-ig', platform: 'instagram', name: 'IG' });
    const post = makeItem({ id: 'item-0001-aaaa', channelId: 'ch-ig', status: 'draft' }); // regulärer Post, kein Reel
    const { skill, spies } = makeSkill(ig, post);
    const r = await skill.execute({ action: 'reject_content', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(true);
    expect((spies as any).transition).toHaveBeenCalledTimes(1); // nur das Item selbst
  });

  it('v1062: render_reel stößt das Auto-Reel für einen VERÖFFENTLICHTEN Lead erneut an', async () => {
    const setup = reelSetup();
    await setup.skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    await new Promise(res => setTimeout(res, 10));
    expect(setup.render).toHaveBeenCalledTimes(1);
    const r = await setup.skill.execute({ action: 'render_reel', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(true);
    await new Promise(res => setTimeout(res, 10));
    expect(setup.render).toHaveBeenCalledTimes(2); // zweiter Durchlauf, gleicher Pfad
  });

  it('v1076: render_reel läuft auch für UNVERÖFFENTLICHTE Beiträge (User-Artikel)', async () => {
    const setup = reelSetup();
    const r = await setup.skill.execute({ action: 'render_reel', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(true); // Story vorhanden → Bilder kommen vom Follower
    await new Promise(res => setTimeout(res, 10));
    expect(setup.render).toHaveBeenCalled();
  });

  it('v1076: render_reel verweigert rejected und Story-lose Beiträge ohne lokales Bild', async () => {
    const ig = makeChannel({ id: 'ch-ig', platform: 'instagram', name: 'IG', projectId: 'p1' });
    const noImage = makeItem({ id: 'item-0001-aaaa', channelId: 'ch-ig', status: 'draft', media: [], storyId: undefined });
    const { skill } = makeSkill(ig, noImage);
    const r = await skill.execute({ action: 'render_reel', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('lokales Bild');
    const rejected = makeItem({ id: 'item-0001-aaaa', channelId: 'ch-ig', status: 'rejected' });
    const { skill: skill2 } = makeSkill(ig, rejected);
    const r2 = await skill2.execute({ action: 'render_reel', item_id: 'item-0001-aaaa' }, CTX);
    expect(r2.success).toBe(false);
    expect(r2.error).toContain('abgelehnt');
  });

  it('v1058: Reel-Slides bevorzugen den SAUBEREN asset-Zwilling (ohne eingebrannte Titel)', async () => {
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const studio = join(tmpdir(), `studio-reeltest-${Date.now()}.png`);
    const asset = studio.replace('studio-', 'asset-');
    writeFileSync(studio, Buffer.from('mit-overlay'));
    writeFileSync(asset, Buffer.from('sauber'));
    try {
      const setup = reelSetup();
      // Follower-Bild zeigt auf die STUDIO-Datei (mit eingebrannten Boxen)
      const follower = makeItem({ id: 'item-ig', channelId: 'ch-ig', media: [{ type: 'image', source: 'generated', pathOrUrl: studio }] });
      (setup.spies as any).getItem = vi.fn(async (_u: string, id: string) => (id === 'item-ig' ? follower : null));
      await setup.skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
      for (let i = 0; i < 80 && (setup.render as any).mock.calls.length === 0; i++) await new Promise(res => setTimeout(res, 25));
      expect(setup.render).toHaveBeenCalled();
      const pseudo = (setup.render as any).mock.calls[0][0];
      expect(pseudo.media[0].pathOrUrl).toBe(asset); // Zwilling statt Studio-Bild
      // v1058 — opts-Parameter (Hook/End-Card) wird durchgereicht
      expect((setup.render as any).mock.calls[0][3]).toBeDefined();
    } finally {
      unlinkSync(studio);
      unlinkSync(asset);
    }
  });

  it('v1056: FB-Familien-Kanal mit auto_reel → ZWEITER Reel-Entwurf mit derselben Videodatei (kein Doppel-Render)', async () => {
    const setup = reelSetup();
    // v1076 — Zweitverwertung ist fähigkeitsgesteuert: der Provider muss
    // registriert sein und Video können (wie in Produktion)
    setup.skill.registerProvider(new FakeProvider('facebook'));
    const fb = makeChannel({ id: 'ch-fb', platform: 'facebook', name: 'FussballCC FB', projectId: 'p1', config: { auto_reel: true } });
    const lead = makeChannel({ id: 'ch-web', platform: 'rest', name: 'fussball.cc', projectId: 'p1', config: { base_url: 'https://cc.example' } });
    const ig = makeChannel({ id: 'ch-ig', platform: 'instagram', name: 'FussballCC IG', projectId: 'p1', config: { auto_reel: true } });
    (setup.spies as any).listChannels = vi.fn(async () => [lead, ig, fb]);
    await setup.skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    await new Promise(res => setTimeout(res, 10));
    expect(setup.render).toHaveBeenCalledTimes(1); // EIN Render für beide
    const reels = setup.created.filter(c => c.media?.[0]?.type === 'video');
    expect(reels.map(r => r.chId).sort()).toEqual(['ch-fb', 'ch-ig']);
    expect(reels[0].media[0].pathOrUrl).toBe(reels[1].media[0].pathOrUrl); // gleiche Datei
  });

  it('v1101: Reel-Zwilling auf TEXT-Kanal mit Story-Post → eigene Video-Caption + 6h-Abstand; IG bleibt 1:1', async () => {
    const setup = reelSetup();
    setup.skill.registerProvider(new FakeProvider('telegram_channel'));
    const tg = makeChannel({ id: 'ch-tg', platform: 'telegram_channel', name: 'News TG', projectId: 'p1', config: { auto_reel: true } });
    const lead = makeChannel({ id: 'ch-web', platform: 'rest', name: 'fussball.cc', projectId: 'p1', config: { base_url: 'https://cc.example' } });
    const ig = makeChannel({ id: 'ch-ig', platform: 'instagram', name: 'IG', projectId: 'p1', config: { auto_reel: true } });
    (setup.spies as any).listChannels = vi.fn(async () => [lead, ig, tg]);
    // Auf TG läuft die Story bereits als regulärer Post (Realfall Adams 11.07.)
    const publishedAt = new Date(Date.now() - 40 * 60_000).toISOString();
    const sibling = makeItem({ id: 'item-tg-text', channelId: 'ch-tg', storyId: 's-1', status: 'published', publishedAt });
    const origList = (setup.spies as any).listItems;
    (setup.spies as any).listItems = vi.fn(async (u: string, q: any) =>
      q?.channelId === 'ch-tg' ? [sibling] : origList(u, q));
    await setup.skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    await new Promise(res => setTimeout(res, 10));
    const tgReel = setup.created.find(c => c.chId === 'ch-tg');
    const igReel = setup.created.find(c => c.chId === 'ch-ig' && c.media?.[0]?.type === 'video');
    expect(tgReel.title).toBe('🎬 Das Video zur Meldung: Kolumbien weiter');
    expect(igReel.title).toBe('Kolumbien weiter'); // native Reel-Oberfläche: unverändert
    const merges = ((setup.skill as any).repo.mergePerformance as any).mock.calls.map((c: any[]) => c[2]);
    const withDistance = merges.find((m: any) => typeof m?.notBefore === 'string');
    expect(withDistance).toBeDefined();
    expect(Date.parse(withDistance.notBefore)).toBe(Date.parse(publishedAt) + 6 * 3_600_000);
  });

  it('v1101: Ad-hoc-Termin respektiert performance.notBefore (Zweitverwertungs-Abstand)', async () => {
    const channel = makeChannel();
    const notBefore = new Date(Date.now() + 6 * 3_600_000).toISOString();
    const reel = makeItem({ status: 'draft', performance: { format: 'reel', autoReel: true, notBefore } });
    const { skill, spies } = makeSkill(channel, reel);
    const r = await skill.execute({ action: 'approve_content', item_id: reel.id }, CTX);
    expect(r.success).toBe(true);
    const call = (spies.reschedule as any).mock.calls.find((c: any[]) => c[1] === reel.id);
    expect(call).toBeDefined();
    expect(Date.parse(call[2])).toBeGreaterThanOrEqual(Date.parse(notBefore));
  });

  it('v1056: Freigabe eines slotlosen Begleitformats → Ad-hoc-Termin (+15 min)', async () => {
    const channel = makeChannel();
    const reel = makeItem({ status: 'draft', performance: { format: 'reel', autoReel: true } });
    const { skill, spies } = makeSkill(channel, reel);
    const r = await skill.execute({ action: 'approve_content', item_id: reel.id }, CTX);
    expect(r.success).toBe(true);
    const call = (spies.reschedule as any).mock.calls.find((c: any[]) => c[1] === reel.id);
    expect(call).toBeDefined();
    expect(call[3]).toEqual(['approved']);
    const at = Date.parse(call[2]);
    expect(at).toBeGreaterThan(Date.now() + 10 * 60_000);
    expect(at).toBeLessThan(Date.now() + 20 * 60_000);
    // regulärer Artikel ohne Slot: KEINE Auto-Terminierung (bewusste Entscheidung)
    const article = makeItem({ id: 'item-0002-bbbb', status: 'draft' });
    const s2 = makeSkill(channel, article);
    await s2.skill.execute({ action: 'approve_content', item_id: article.id }, CTX);
    expect((s2.spies.reschedule as any)).not.toHaveBeenCalled();
  });

  it('Wochen-Limit erreicht bzw. auto_reel aus → kein Render', async () => {
    const capped = reelSetup({ auto_reel: true, reel_max_per_week: 0 });
    await capped.skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    await new Promise(res => setTimeout(res, 10));
    expect(capped.render).not.toHaveBeenCalled();

    const off = reelSetup({});
    await off.skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    await new Promise(res => setTimeout(res, 10));
    expect(off.render).not.toHaveBeenCalled();
  });
});

describe('v1081 — Reel-Video an den Lead-Artikel (attach_reel_video)', () => {
  function attachSetup(webConfig: Record<string, unknown>, leadOverrides: Partial<ContentItem> = {}) {
    const web = makeChannel({ id: 'ch-web', platform: 'rest', name: 'fussball.cc', projectId: 'p1', config: webConfig });
    const ig = makeChannel({ id: 'ch-ig', platform: 'instagram', name: 'IG', projectId: 'p1' });
    const reel = makeItem({
      id: 'item-reel-aaaa', channelId: 'ch-ig', storyId: 's-1', status: 'approved',
      performance: { format: 'reel', autoReel: true },
      media: [{ type: 'video', source: 'generated', pathOrUrl: '/tmp/reel.mp4' }],
    });
    const { skill, spies } = makeSkill(ig, reel);
    const rest = new FakeProvider('rest');
    const attach = vi.fn(async () => true);
    (rest as any).attachVideo = attach;
    skill.registerProvider(rest);
    skill.registerProvider(new FakeProvider('instagram'));
    (spies as any).listChannels = vi.fn(async () => [web, ig]);
    (spies as any).listAssignments = vi.fn(async () => [
      { id: 'a1', storyId: 's-1', channelId: 'ch-web', role: 'lead', offsetHours: 0, itemId: 'item-lead-aaaa', createdAt: 'x' },
    ]);
    const lead = makeItem({ id: 'item-lead-aaaa', channelId: 'ch-web', status: 'published', externalId: 'art-77', ...leadOverrides });
    const origGetItem = (spies as any).getItem;
    (spies as any).getItem = vi.fn(async (u: string, id: string) => (id === 'item-lead-aaaa' ? lead : origGetItem(u, id)));
    return { skill, spies, attach };
  }

  it('Reel published → PATCH mit Videodatei auf den bestehenden Lead-Artikel + Einmal-Marker', async () => {
    const { skill, spies, attach } = attachSetup({ attach_reel_video: true });
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-reel-aaaa' }, CTX);
    expect(r.success).toBe(true);
    await new Promise(res => setTimeout(res, 10)); // fire-and-forget abwarten
    expect(attach).toHaveBeenCalledTimes(1);
    const call = attach.mock.calls[0] as unknown[];
    expect(call[0]).toBe('art-77');
    expect(call[1]).toBe('/tmp/reel.mp4');
    // Einmaligkeit: articleVideo am Lead-Item vermerkt
    expect((spies.mergePerformance as any).mock.calls.some(
      (c: any[]) => c[1] === 'item-lead-aaaa' && c[2].articleVideo === '/tmp/reel.mp4',
    )).toBe(true);
  });

  it('ohne Opt-in bzw. bereits angehängt → kein PATCH', async () => {
    const off = attachSetup({});
    await off.skill.execute({ action: 'publish_now', item_id: 'item-reel-aaaa' }, CTX);
    await new Promise(res => setTimeout(res, 10));
    expect(off.attach).not.toHaveBeenCalled();

    const done = attachSetup({ attach_reel_video: true }, { performance: { articleVideo: '/tmp/alt.mp4' } });
    await done.skill.execute({ action: 'publish_now', item_id: 'item-reel-aaaa' }, CTX);
    await new Promise(res => setTimeout(res, 10));
    expect(done.attach).not.toHaveBeenCalled();
  });
});

describe('v1087 — post_from_video (Beitrag aus Bibliotheks-Video)', () => {
  it('textet je video-fähigem Kanal, überspringt unfähige, vermerkt fromAsset + Nutzung', async () => {
    const fb = makeChannel({ id: 'ch-fb', platform: 'facebook', name: 'FussballCC FB', persona: 'locker' });
    const insta = makeChannel({ id: 'ch-ig2', platform: 'instagram', name: 'IG ohne Video' }); // FakeProvider: instagram kann KEIN Video
    const item = makeItem();
    const { skill, spies } = makeSkill(fb, item);
    skill.registerProvider(new FakeProvider('facebook'));
    skill.registerProvider(new FakeProvider('instagram'));
    (spies as any).getChannel = vi.fn(async (_u: string, id: string) => (id === 'ch-fb' ? fb : id === 'ch-ig2' ? insta : null));
    (spies as any).listMediaAssets = vi.fn(async () => [{
      id: 'vid-1', userId: 'u1', path: '/tmp/lib-video.mp4', motif: 'Torjubel nach dem Siegtreffer', kind: 'video', durationSec: 30,
      lastUsedAt: 'x', useCount: 1, blocked: false, pinned: false, createdAt: 'x', model: 'upload',
    }]);
    (spies as any).touchMediaAsset = vi.fn(async () => {});
    const created: any[] = [];
    (spies as any).createItem = vi.fn(async (_u: string, chId: string, o: any) => { created.push({ chId, ...o }); return { ...makeItem(), ...o, channelId: chId, id: 'new-1' }; });
    (skill as any).llm = { complete: vi.fn(async () => ({ content: '{"titel": "Was für ein Tor!", "text": "Der Moment, über den heute alle reden.", "hashtags": ["wm2026"]}' })) };

    const r = await skill.execute({ action: 'post_from_video', asset_id: 'vid-1', channels: ['ch-fb', 'ch-ig2'], stoff: 'Siegtreffer in der 89. Minute' }, CTX);
    expect(r.success).toBe(true);
    expect(created.length).toBe(1); // nur FB — IG-FakeProvider kann kein Video
    expect(created[0].chId).toBe('ch-fb');
    expect(created[0].title).toBe('Was für ein Tor!');
    expect(created[0].media[0]).toMatchObject({ type: 'video', source: 'user', pathOrUrl: '/tmp/lib-video.mp4' });
    expect(r.display).toContain('Übersprungen');
    expect((spies.mergePerformance as any).mock.calls.some((c: any[]) => c[2]?.fromAsset === 'vid-1')).toBe(true);
    expect((spies as any).touchMediaAsset).toHaveBeenCalledWith('u1', 'vid-1', 'ch-fb');
  });

  it('v1088 edit_video: trimmt/verkettet Bibliotheks-Clips und legt das Ergebnis als neues Video-Asset an', async () => {
    const { skill, spies } = makeSkill(makeChannel(), makeItem());
    (spies as any).listMediaAssets = vi.fn(async () => [
      { id: 'v1', userId: 'u1', path: '/tmp/a.mp4', motif: 'Torjubel', kind: 'video', lastUsedAt: 'x', useCount: 1, blocked: false, pinned: false, createdAt: 'x' },
      { id: 'v2', userId: 'u1', path: '/tmp/b.mp4', motif: 'Fanmarsch', kind: 'video', lastUsedAt: 'x', useCount: 1, blocked: false, pinned: false, createdAt: 'x' },
    ]);
    const edit = vi.fn(async () => ({ videoPath: '/tmp/edit-1.mp4', durationSec: 14.5 }));
    skill.setVideoTools({ render: vi.fn(), edit } as any);
    // v1092 — Effekte je Clip: tempo (Zeitlupe) + look (Farb-Preset) laufen durch
    const r = await skill.execute({ action: 'edit_video', clips: [{ asset_id: 'v1', von: 2, bis: 10, tempo: 0.5, look: 'kino' }, { asset_id: 'v2' }], titel: 'BEST OF', format: '9:16' }, CTX);
    expect(r.success).toBe(true);
    const call = (edit.mock.calls[0] as unknown[])[0] as { clips: Array<{ path: string; startSec?: number; endSec?: number; speed?: number; look?: string }>; format: string };
    expect(call.format).toBe('9:16');
    expect(call.clips[0]).toMatchObject({ path: '/tmp/a.mp4', startSec: 2, endSec: 10, speed: 0.5, look: 'kino' });
    expect(call.clips[1]).toMatchObject({ path: '/tmp/b.mp4' });
    expect(call.clips[1].speed).toBeUndefined();
    const assetCall = ((spies as any).createMediaAsset as any).mock.calls[0];
    expect(assetCall[1]).toMatchObject({ kind: 'video', model: 'schnitt', path: '/tmp/edit-1.mp4', durationSec: 14.5, motif: 'BEST OF' });
    // unbekannter Clip → klarer Fehler
    const bad = await skill.execute({ action: 'edit_video', clips: [{ asset_id: 'nix' }] }, CTX);
    expect(bad.success).toBe(false);
    expect(bad.error).toContain('nicht gefunden');
  });

  it('v1089 animate_image: Bild → KI-Clip mit Budget-Zählung und Bibliotheks-Eintrag; Budget erschöpft → Fehler', async () => {
    const ig = makeChannel({ id: 'ch-ig', platform: 'instagram', name: 'IG', projectId: 'p1', config: { reel_ai_provider: 'veo', ai_clip_budget_per_month: 2 } });
    const { skill, spies } = makeSkill(ig, makeItem());
    (spies as any).listChannels = vi.fn(async () => [ig]);
    (spies as any).listMediaAssets = vi.fn(async () => [{
      id: 'img-1', userId: 'u1', path: '/tmp/bild.png', motif: 'Stadion bei Flutlicht', kind: 'image',
      lastUsedAt: 'x', useCount: 1, blocked: false, pinned: false, createdAt: 'x',
    }]);
    (spies as any).touchMediaAsset = vi.fn(async () => {});
    const generateClip = vi.fn(async () => ({ clipPath: '/tmp/clip-1.mp4', durationSec: 6 }));
    skill.setVideoTools({ render: vi.fn(), generateClip } as any);
    (skill as any).llm = { complete: vi.fn(async () => ({ content: 'slow cinematic push-in, flags waving' })) };

    const r = await skill.execute({ action: 'animate_image', asset_id: 'img-1' }, CTX);
    expect(r.success).toBe(true);
    const req = (generateClip.mock.calls[0] as unknown[])[0] as { provider: string; prompt: string; imagePath: string };
    expect(req.provider).toBe('veo');
    expect(req.imagePath).toBe('/tmp/bild.png');
    expect(req.prompt).toContain('cinematic');
    expect((spies.upsertMetric as any).mock.calls.some((c: any[]) => c[1]?.kind === 'gen_ai_clip')).toBe(true);
    const assetCall = ((spies as any).createMediaAsset as any).mock.calls[0];
    expect(assetCall[1]).toMatchObject({ kind: 'video', model: 'veo', path: '/tmp/clip-1.mp4', durationSec: 6 });

    // Budget erschöpft → klarer Fehler, KEIN Clip-Aufruf
    (spies.listMetrics as any).mockResolvedValue([{ date: '2026-07-01', kind: 'gen_ai_clip', value: 2 }]);
    const blocked = await skill.execute({ action: 'animate_image', asset_id: 'img-1' }, CTX);
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('Monatsbudget');
    expect(generateClip).toHaveBeenCalledTimes(1);
  });

  it('v1094 find_highlights: analysiert, schneidet je Fenster einen Clip und legt Bibliotheks-Assets an', async () => {
    const { skill, spies } = makeSkill(makeChannel(), makeItem());
    (spies as any).listMediaAssets = vi.fn(async () => [{
      id: 'long-1', userId: 'u1', path: '/tmp/match.mp4', motif: 'Ganzes Spiel', kind: 'video', durationSec: 600,
      lastUsedAt: 'x', useCount: 1, blocked: false, pinned: false, createdAt: 'x',
    }]);
    (spies as any).touchMediaAsset = vi.fn(async () => {});
    const analyze = vi.fn(async () => [{ start: 120, end: 132, score: -8 }, { start: 300, end: 310, score: -10 }]);
    const edit = vi.fn(async (o: any) => ({ videoPath: `/tmp/hl-${o.clips[0].startSec}.mp4`, durationSec: o.clips[0].endSec - o.clips[0].startSec }));
    skill.setVideoTools({ render: vi.fn(), analyze, edit } as any);
    const r = await skill.execute({ action: 'find_highlights', asset_id: 'long-1', anzahl: 2 }, CTX);
    expect(r.success).toBe(true);
    expect(analyze).toHaveBeenCalledWith('/tmp/match.mp4', { count: 2 });
    expect(edit).toHaveBeenCalledTimes(2);
    expect(((edit.mock.calls[0] as unknown[])[0] as any).clips[0]).toMatchObject({ path: '/tmp/match.mp4', startSec: 120, endSec: 132 });
    const assetCalls = ((spies as any).createMediaAsset as any).mock.calls;
    expect(assetCalls.length).toBe(2);
    expect(assetCalls[0][1]).toMatchObject({ kind: 'video', model: 'highlight', durationSec: 12 });
    expect(assetCalls[0][1].motif).toContain('Highlight 1/2');
  });

  it('ohne asset_id bzw. unbekanntes Video → klare Fehler', async () => {
    const { skill, spies } = makeSkill(makeChannel(), makeItem());
    (spies as any).listMediaAssets = vi.fn(async () => []);
    const r1 = await skill.execute({ action: 'post_from_video', channels: ['x'] }, CTX);
    expect(r1.success).toBe(false);
    expect(r1.error).toContain('asset_id');
    const r2 = await skill.execute({ action: 'post_from_video', asset_id: 'gibtsnicht', channels: ['x'] }, CTX);
    expect(r2.success).toBe(false);
    expect(r2.error).toContain('nicht gefunden');
  });
});

describe('v1096 — Publish-Sicherheitsnetz für Nur-Video-Kanäle', () => {
  class VideoOnlyProvider extends FakeProvider {
    override capabilities() { return { ...super.capabilities(), text: false, video: true }; }
  }

  function netSetup(item: ReturnType<typeof makeItem>) {
    const yt = makeChannel({ id: 'ch-yt', platform: 'youtube', name: 'YT', config: { auto_video_format: '16:9' } });
    const { skill, spies } = makeSkill(yt, item);
    skill.registerProvider(new VideoOnlyProvider('youtube'));
    (spies as any).reschedule = vi.fn(async () => true);
    const render = vi.fn(async () => ({ videoPath: '/tmp/v.mp4', durationSec: 30 }));
    skill.setVideoTools({ render } as any);
    return { skill, spies, render };
  }

  it('kein Video + Bild vorhanden → Render angestoßen, +15 min umterminiert, Versuch gezählt', async () => {
    const item = makeItem({ id: 'item-yt-1', channelId: 'ch-yt', status: 'approved', media: [{ type: 'image', source: 'generated', pathOrUrl: '/tmp/b.png' }] });
    const { skill, spies } = netSetup(item);
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-yt-1' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('Video wird gerendert');
    expect((r.data as any)?.permanent).toBeUndefined(); // kein Dauer-Fehler
    expect((spies.mergePerformance as any).mock.calls.some((c: any[]) => c[2]?.autoVideoAttempts === 1)).toBe(true);
    expect((spies as any).reschedule).toHaveBeenCalled();
  });

  it('2 Versuche verbraucht → klarer Dauer-Fehler; ohne Bild → sofort Dauer-Fehler', async () => {
    const worn = makeItem({ id: 'item-yt-1', channelId: 'ch-yt', status: 'approved', performance: { autoVideoAttempts: 2 }, media: [{ type: 'image', source: 'generated', pathOrUrl: '/tmp/b.png' }] });
    const a = netSetup(worn);
    const r1 = await a.skill.execute({ action: 'publish_now', item_id: 'item-yt-1' }, CTX);
    expect(r1.success).toBe(false);
    expect((r1.data as any)?.permanent).toBe(true);
    expect(r1.error).toContain('2×');

    const noImage = makeItem({ id: 'item-yt-1', channelId: 'ch-yt', status: 'approved', media: [] });
    const b = netSetup(noImage);
    const r2 = await b.skill.execute({ action: 'publish_now', item_id: 'item-yt-1' }, CTX);
    expect(r2.success).toBe(false);
    expect((r2.data as any)?.permanent).toBe(true);
    expect(r2.error).toContain('weder Video noch lokales Bild');
  });

  it('mit Video → Netz greift nicht, Publish läuft normal durch', async () => {
    const withVideo = makeItem({ id: 'item-yt-1', channelId: 'ch-yt', status: 'approved', media: [{ type: 'video', source: 'generated', pathOrUrl: '/tmp/v.mp4' }] });
    const { skill } = netSetup(withVideo);
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-yt-1' }, CTX);
    expect(r.success).toBe(true);
  });
});

describe('v1024 — plan_story (Ad-hoc-Story auf User-Zuruf)', () => {
  it('unverdrahtet → Fehler; ohne Stoff → Hinweis; mit Stoff → Planner korrekt aufgerufen', async () => {
    const channel = makeChannel();
    const item = makeItem();
    const { skill } = makeSkill(channel, item);

    const unwired = await skill.execute({ action: 'plan_story', stoff: 'Ein US-Spieler darf trotz Roter Karte spielen — die Politik hat interveniert.' }, CTX);
    expect(unwired.success).toBe(false);
    expect(unwired.error).toContain('nicht verfügbar');

    const fn = vi.fn(async () => ({ created: 2, channels: ['fussball.cc', 'FussballCC News'], family: 'project:p1', storyTitle: 'USA-Politikum' }));
    skill.setStoryPlanner(fn);

    const missing = await skill.execute({ action: 'plan_story', stoff: 'zu kurz' }, CTX);
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('stoff');

    const r = await skill.execute({ action: 'plan_story', titel: 'USA-Politikum', stoff: 'Ein US-Spieler darf trotz Roter Karte spielen — die Politik hat interveniert. FIFA prüft.' }, CTX);
    expect(r.success).toBe(true);
    expect(fn).toHaveBeenCalledWith('USA-Politikum', expect.stringContaining('Roter Karte'), undefined);
    expect(r.display).toContain('2 Beiträge');
    expect(r.display).toContain('fussball.cc');
  });
});

describe('v1007 — Auto-Story (IG-Story beim Lead-Publish)', () => {
  it('Lead published → 9:16-Story mit Overlay über public_media, dokumentiert als eigenes Item', async () => {
    const { loadSharp } = await import('./image-overlay.js');
    const sharp = await loadSharp();
    const png: Buffer = await (sharp as any)({ create: { width: 400, height: 500, channels: 3, background: { r: 20, g: 80, b: 40 } } }).png().toBuffer();
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const imgFile = join(tmpdir(), `alfred-test-story-src-${Date.now()}.png`);
    writeFileSync(imgFile, png);
    try {
      const lead = makeChannel({ id: 'ch-web', platform: 'rest', name: 'fussball.cc', projectId: 'p1', config: { base_url: 'https://cc.example' } });
      const ig = makeChannel({ id: 'ch-ig', platform: 'instagram', name: 'FussballCC IG', projectId: 'p1', config: { auto_story: true, public_media: { provider: 'rest', base_url: 'https://cc.example' } } });
      const leadItem = makeItem({ id: 'item-0001-aaaa', channelId: 'ch-web', storyId: 's-1', title: 'Kolumbien weiter', body: 'Ein ausreichend langer Artikeltext.' });
      const followerItem = makeItem({ id: 'item-ig', channelId: 'ch-ig', status: 'scheduled', media: [{ type: 'image', source: 'generated', pathOrUrl: imgFile }] });
      const { skill, spies } = makeSkill(lead, leadItem);
      const restProv = new FakeProvider('rest');
      const igProv = new FakeProvider('instagram');
      skill.registerProvider(restProv);
      skill.registerProvider(igProv);
      (spies as any).listChannels = vi.fn(async () => [lead, ig]);
      (spies as any).listAssignments = vi.fn(async () => [
        { id: 'a1', storyId: 's-1', channelId: 'ch-web', role: 'lead', offsetHours: 0, itemId: 'item-0001-aaaa', createdAt: 'x' },
        { id: 'a2', storyId: 's-1', channelId: 'ch-ig', role: 'follow', offsetHours: 6, itemId: 'item-ig', createdAt: 'x' },
      ]);
      const origGetItem = (spies as any).getItem;
      (spies as any).getItem = vi.fn(async (u: string, id: string) => (id === 'item-ig' ? followerItem : origGetItem(u, id)));
      const created: any[] = [];
      (spies as any).createItem = vi.fn(async (_u: string, chId: string, o: any) => { created.push({ chId, ...o }); return { ...makeItem(), ...o, channelId: chId, id: 'doc-1' }; });
      // fetch: public_media-Upload der Story
      const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: { url: '/uploads/story.png' } }), text: async () => '' }));
      const orig = globalThis.fetch;
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      let r;
      try {
        r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
      } finally { globalThis.fetch = orig; }
      expect(r.success).toBe(true);
      expect(igProv.stories).toEqual(['https://cc.example/uploads/story.png']);
      expect(r.display).toContain('IG-Story auf **FussballCC IG**');
      // Doku-Item auf dem IG-Kanal
      expect(created.some(c => c.chId === 'ch-ig' && String(c.title).startsWith('Story:'))).toBe(true);
    } finally { unlinkSync(imgFile); }
  });

  it('ohne auto_story bzw. für Nicht-Leads passiert nichts', async () => {
    const lead = makeChannel({ id: 'ch-web', platform: 'rest', projectId: 'p1' });
    const leadItem = makeItem({ channelId: 'ch-web', storyId: 's-1' });
    const { skill, spies } = makeSkill(lead, leadItem);
    const restProv = new FakeProvider('rest');
    const igProv = new FakeProvider('instagram');
    skill.registerProvider(restProv);
    skill.registerProvider(igProv);
    (spies as any).listChannels = vi.fn(async () => [lead, makeChannel({ id: 'ch-ig', platform: 'instagram', projectId: 'p1' })]); // kein auto_story
    (spies as any).listAssignments = vi.fn(async () => [{ id: 'a1', storyId: 's-1', channelId: 'ch-web', role: 'lead', offsetHours: 0, itemId: 'item-0001-aaaa', createdAt: 'x' }]);
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(true);
    expect(igProv.stories.length).toBe(0);
  });
});

describe('v1006 — Mehrsprachigkeit (translate_to auf rest-Kanälen)', () => {
  it('publish_now übersetzt vorher, persistiert den Cache und der Provider bekommt die Übersetzungen', async () => {
    const channel = makeChannel({ platform: 'rest', config: { base_url: 'https://cc.example', translate_to: ['en', 'fr'] } });
    const item = makeItem({ title: 'Kolumbien weiter', body: 'Ein ausreichend langer Artikeltext über das Achtelfinale.' });
    const { skill, spies } = makeSkill(channel, item);
    const rest = new FakeProvider('rest');
    skill.registerProvider(rest);
    const complete = vi.fn(async (_r: { messages: Array<{ content: string }> }) => ({
      content: '{"en": {"title": "Colombia advance", "body": "A sufficiently long article text about the round of 16."}, "fr": {"title": "La Colombie avance", "body": "Un texte suffisamment long sur les huitièmes de finale."}}',
    }));
    (skill as any).llm = { complete };
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(true);
    const prompt = complete.mock.calls[0]![0].messages[0].content;
    expect(prompt).toContain('Deutsch');
    expect(prompt).toContain('"en" (Englisch)');
    // ausgehendes Item trägt die Übersetzungen, Cache wurde persistiert
    const sent = rest.published[0] as ContentItem;
    expect((sent.performance as any).translations.en.title).toBe('Colombia advance');
    expect((spies as any).mergePerformance.mock.calls.some((c: any[]) => c[2]?.translations?.fr?.title === 'La Colombie avance')).toBe(true);
  });

  it('kaputte LLM-Antwort oder Nicht-rest-Kanal → Publish läuft unverändert weiter', async () => {
    const channel = makeChannel({ platform: 'rest', config: { translate_to: ['en'] } });
    const { skill } = makeSkill(channel, makeItem());
    const rest = new FakeProvider('rest');
    skill.registerProvider(rest);
    (skill as any).llm = { complete: vi.fn(async () => ({ content: 'KEIN JSON' })) };
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(true);
    expect((rest.published[0].performance as any)?.translations).toBeUndefined();

    const tg = makeChannel({ platform: 'test', config: { translate_to: ['en'] } });
    const { skill: s2, provider: p2 } = makeSkill(tg, makeItem());
    const llmSpy = vi.fn(async () => ({ content: '{}' }));
    (s2 as any).llm = { complete: llmSpy };
    await s2.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(p2.published.length).toBe(1);
    expect(llmSpy).not.toHaveBeenCalled(); // translate_to wirkt nur auf rest
  });
});

describe('SocialSkill — Veröffentlichung + Leitplanken', () => {
  it('publish_now (api): Provider published, Item wird published mit external-Daten', async () => {
    const { skill, provider, state } = makeSkill(makeChannel(), makeItem());
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(true);
    expect(provider.published.length).toBe(1);
    expect(state.item.status).toBe('published');
    expect(state.item.externalId).toBe('ext-1');
    expect(r.display).toContain('https://ex.at/p/1');
  });

  it('publish_now (prepare): kein Provider-Call, fertige Aufbereitung als Antwort', async () => {
    const { skill, provider, state } = makeSkill(makeChannel({ publishMode: 'prepare' }), makeItem({ title: 'Derby' }));
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(true);
    expect(provider.published.length).toBe(0);
    expect(state.item.status).toBe('approved');
    expect(r.display).toContain('Fertig aufbereitet');
    expect(r.display).toContain('Derby');
    expect(r.display).toContain('mark_published');
  });

  it('Leitplanke Tages-Limit: publish_now verweigert bei Limit', async () => {
    const { skill, spies } = makeSkill(makeChannel({ maxPostsPerDay: 2 }), makeItem());
    (spies.countPublishedToday as any).mockResolvedValue(2);
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('Tages-Limit');
  });

  it('v1100 limit_override: Wichtiges darf +2 übers Tages-Limit — der harte Deckel bleibt', async () => {
    // Am Limit (2/2) + Override → geht raus
    const first = makeSkill(makeChannel({ maxPostsPerDay: 2 }), makeItem());
    (first.spies.countPublishedToday as any).mockResolvedValue(2);
    const r = await first.skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa', limit_override: true }, CTX);
    expect(r.success).toBe(true);
    expect(first.provider.published.length).toBe(1);
    // Harter Deckel (max+2 = 4) → auch mit Override Schluss
    const second = makeSkill(makeChannel({ maxPostsPerDay: 2 }), makeItem());
    (second.spies.countPublishedToday as any).mockResolvedValue(4);
    const r2 = await second.skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa', limit_override: true }, CTX);
    expect(r2.success).toBe(false);
    expect(r2.error).toContain('Tages-Limit');
  });

  it('Leitplanke Blacklist: Treffer blockiert die Veröffentlichung', async () => {
    const { skill, provider } = makeSkill(
      makeChannel({ blacklist: ['schiedsrichter'] }),
      makeItem({ body: 'Der Schiedsrichter war eine Katastrophe!' }),
    );
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('Blacklist');
    expect(provider.published.length).toBe(0);
  });

  it('pausierter Kanal: publish_now verweigert', async () => {
    const { skill } = makeSkill(makeChannel({ status: 'paused' }), makeItem());
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('paused');
  });

  it('Provider-Fehler → Item failed mit Fehlertext, kein Throw', async () => {
    const { skill, provider, state } = makeSkill(makeChannel(), makeItem());
    provider.failNext = true;
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(false);
    expect(state.item.status).toBe('failed');
    expect(state.item.error).toContain('API down');
  });

  it('Erstpost-Sperre: approve erhöht Streak, reject setzt zurück', async () => {
    const { skill, state } = makeSkill(makeChannel({ approvedStreak: 2 }), makeItem({ status: 'scheduled' }));
    await skill.execute({ action: 'approve_content', item_id: 'item-0001-aaaa' }, CTX);
    expect(state.channel.approvedStreak).toBe(3);

    state.item.status = 'scheduled';
    await skill.execute({ action: 'reject_content', item_id: 'item-0001-aaaa' }, CTX);
    expect(state.channel.approvedStreak).toBe(0);
  });

  it('mark_published trackt manuell gepostete Beiträge', async () => {
    const { skill, state } = makeSkill(makeChannel({ publishMode: 'prepare' }), makeItem({ status: 'approved' }));
    const r = await skill.execute({ action: 'mark_published', item_id: 'item-0001-aaaa', external_url: 'https://insta.example/p/9' }, CTX);
    expect(r.success).toBe(true);
    expect(state.item.status).toBe('published');
    expect(state.item.externalUrl).toBe('https://insta.example/p/9');
  });

  it('delete_remote löscht via Provider (Leitplanke 6)', async () => {
    const { skill } = makeSkill(makeChannel(), makeItem({ status: 'published', externalId: 'ext-1' }));
    const r = await skill.execute({ action: 'delete_remote', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(true);
    expect(r.display).toContain('gelöscht');
  });

  it('v973: Doppel-Publish-Gate — sehr ähnlicher Beitrag der letzten 7 Tage blockt, force übergeht', async () => {
    const channel = makeChannel();
    const item = makeItem({ title: 'WM-Aus für Österreich: Spanien zu stark im Sechzehntelfinale' });
    const alreadyPublished = makeItem({
      id: 'pub-1', status: 'published',
      title: 'WM-Aus für Österreich: Spanien zu stark im Sechzehntelfinale', // Realfall: wortgleich 2× live
      externalUrl: 'https://cc.example/news/wm-aus',
    });
    const { repo, state, spies } = makeRepo(channel, item);
    (spies.listItems as any) = vi.fn(async (_u: string, q: any) =>
      q?.status === 'published' ? [alreadyPublished] : [state.item]);
    (repo as any).listItems = spies.listItems;
    const skill = new SocialSkill(repo);
    skill.registerProvider(new FakeProvider());

    const blocked = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('bereits veröffentlicht');
    expect(blocked.error).toContain('force');
    // v983 — Gate-Fehler sind dauerhaft: Engine soll failed statt Retry-Loop
    expect((blocked.data as any)?.permanent).toBe(true);

    const forced = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa', force: true }, CTX);
    expect(forced.success).toBe(true);
  });

  it('v1023: Story-Geschwister — verschiedene Story-IDs publizieren trotz Titel-Overlap, gleiche Story blockt', async () => {
    // Realfall 06.07.: Spielbericht + Aztekenstadion-Angle (zwei geplante
    // Stories) teilen „gegen/Mexiko/England" → FB-Post fälschlich geblockt.
    const channel = makeChannel();
    const item = makeItem({ title: 'Historische Aztekenstadion-Serie reißt: Mexiko weint gegen England', storyId: 'story-azteka' });
    const sibling = makeItem({
      id: 'pub-1', status: 'published', storyId: 'story-spielbericht',
      title: '3:2 gegen Mexiko: England zittert sich ins Viertelfinale',
    });
    const { repo, state, spies } = makeRepo(channel, item);
    (spies.listItems as any) = vi.fn(async (_u: string, q: any) =>
      q?.status === 'published' ? [sibling] : [state.item]);
    (repo as any).listItems = spies.listItems;
    const skill = new SocialSkill(repo);
    skill.registerProvider(new FakeProvider());

    const ok = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(ok.success).toBe(true); // andere Story = kein Duplikat

    // dieselbe Story bereits auf dem Kanal → blockt, auch bei anderem Titel
    const rerun = makeItem({ id: 'item-0002-bbbb', title: 'Völlig anderer Titel ohne Overlap', storyId: 'story-spielbericht' });
    state.item = rerun;
    (spies.getItem as any) = vi.fn(async () => rerun);
    (repo as any).getItem = spies.getItem;
    const blocked = await skill.execute({ action: 'publish_now', item_id: 'item-0002-bbbb' }, CTX);
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('bereits veröffentlicht');
  });

  it('v1035: Auto-Story-Doku blockt den Feed-Post derselben Story NICHT (Realfall 07.07.)', async () => {
    const channel = makeChannel();
    const item = makeItem({ title: 'Pochettino übernimmt Verantwortung für US-Aus', storyId: 'story-us' });
    const storyDoc = makeItem({
      id: 'pub-story', status: 'published', storyId: 'story-us',
      title: 'Story: Pochettino übernimmt Verantwortung nach US-Achtelfinal-Aus',
      performance: { format: 'story', autoStory: true },
    });
    const { repo, state, spies } = makeRepo(channel, item);
    (spies.listItems as any) = vi.fn(async (_u: string, q: any) =>
      q?.status === 'published' ? [storyDoc] : [state.item]);
    (repo as any).listItems = spies.listItems;
    const skill = new SocialSkill(repo);
    skill.registerProvider(new FakeProvider());
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(true); // Begleitformat zählt nicht als Duplikat
  });

  it('v1035: Reel publiziert trotz Feed-Post derselben Story — aber zwei FEED-Posts blocken weiterhin', async () => {
    const channel = makeChannel();
    // Reel-Kandidat gegen publizierten Feed-Post derselben Story → erlaubt
    const reel = makeItem({ title: 'Kolumbien weiter', storyId: 'story-k', performance: { format: 'reel', autoReel: true } });
    const feedPost = makeItem({ id: 'pub-feed', status: 'published', storyId: 'story-k', title: 'Kolumbien steht im Viertelfinale' });
    const { repo, state, spies } = makeRepo(channel, reel);
    (spies.listItems as any) = vi.fn(async (_u: string, q: any) =>
      q?.status === 'published' ? [feedPost] : [state.item]);
    (repo as any).listItems = spies.listItems;
    const skill = new SocialSkill(repo);
    skill.registerProvider(new FakeProvider());
    const ok = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(ok.success).toBe(true);

    // REGRESSION: regulärer Feed-Post derselben Story bleibt geblockt (v973/v1023)
    const secondFeed = makeItem({ id: 'item-0002-bbbb', title: 'Nochmal Kolumbien', storyId: 'story-k' });
    state.item = secondFeed;
    (spies.getItem as any) = vi.fn(async () => secondFeed);
    (repo as any).getItem = spies.getItem;
    const blocked = await skill.execute({ action: 'publish_now', item_id: 'item-0002-bbbb' }, CTX);
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('bereits veröffentlicht');
  });

  it('v983: Termin-Ankündigung publisht trotz titel-ähnlicher VORSCHAU desselben Spiels', async () => {
    // Realfall 04.07.: „Kanada – Marokko: Der Kampf um den nächsten Schritt" (Vorschau,
    // published) blockierte „Kanada – Marokko: Wer zieht ins Viertelfinale ein?"
    // (PV-Ankündigung) 11 Stunden lang im 5-Minuten-Takt.
    const future = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const channel = makeChannel();
    const announcement = makeItem({
      title: 'Kanada – Marokko: Wer zieht ins Viertelfinale ein?',
      performance: { terminBis: future },
    });
    const preview = makeItem({
      id: 'pub-1', status: 'published',
      title: 'Kanada – Marokko: Der Kampf um den nächsten Schritt',
    });
    const { repo, state, spies } = makeRepo(channel, announcement);
    (spies.listItems as any) = vi.fn(async (_u: string, q: any) =>
      q?.status === 'published' ? [preview] : [state.item]);
    (repo as any).listItems = spies.listItems;
    const skill = new SocialSkill(repo);
    skill.registerProvider(new FakeProvider());

    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(true);
  });

  it('v983: GLEICHER Termin bereits angekündigt → permanenter Block', async () => {
    const future = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const channel = makeChannel();
    const announcement = makeItem({ title: 'Public Viewing heute im Pub', performance: { terminBis: future } });
    const alreadyAnnounced = makeItem({
      id: 'pub-1', status: 'published',
      title: 'Ganz anderer Titel — selber Termin', performance: { terminBis: future },
    });
    const { repo, state, spies } = makeRepo(channel, announcement);
    (spies.listItems as any) = vi.fn(async (_u: string, q: any) =>
      q?.status === 'published' ? [alreadyAnnounced] : [state.item]);
    (repo as any).listItems = spies.listItems;
    const skill = new SocialSkill(repo);
    skill.registerProvider(new FakeProvider());

    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('Termin wurde');
    expect((r.data as any)?.permanent).toBe(true);
  });

  it('v983: abgelaufener Termin wird nicht mehr veröffentlicht (permanent); force übergeht', async () => {
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const channel = makeChannel();
    const stale = makeItem({ title: 'Public Viewing gestern', performance: { terminBis: past } });
    const { skill } = makeSkill(channel, stale);

    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('vorbei');
    expect((r.data as any)?.permanent).toBe(true);

    const forced = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa', force: true }, CTX);
    expect(forced.success).toBe(true);
  });

  it('v983: normaler Beitrag wird NICHT von published Termin-Ankündigung geblockt', async () => {
    const channel = makeChannel();
    const normal = makeItem({ title: 'Kanada gegen Marokko: Der Spielbericht' });
    const announcement = makeItem({
      id: 'pub-1', status: 'published',
      title: 'Kanada gegen Marokko: Public Viewing im Pub',
      performance: { terminBis: new Date(Date.now() + 3_600_000).toISOString() },
    });
    const { repo, state, spies } = makeRepo(channel, normal);
    (spies.listItems as any) = vi.fn(async (_u: string, q: any) =>
      q?.status === 'published' ? [announcement] : [state.item]);
    (repo as any).listItems = spies.listItems;
    const skill = new SocialSkill(repo);
    skill.registerProvider(new FakeProvider());

    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(true);
  });

  it('v984: authHealthCheck erneuert IG-Long-lived-Token und schreibt ihn zurück', async () => {
    const channel = makeChannel({ platform: 'test', name: 'IG-Testkanal' });
    // Der Refresh-Zweig hängt an platform 'instagram' — Kanal entsprechend
    (channel as any).platform = 'instagram';
    const { repo } = makeRepo(channel, makeItem());
    const skill = new SocialSkill(repo);
    const provider = new FakeProvider();
    (provider as any).platform = 'instagram';
    skill.registerProvider(provider);
    skill.setSecretsResolver(async () => ({ META_ACCESS_TOKEN: 'IGAAalterToken' }));
    const written: Array<Record<string, string>> = [];
    skill.setSecretsWriter(async (_c, patch) => { written.push(patch); });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: 'IGAAneuerToken', token_type: 'bearer', expires_in: 5183944 }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const r = await skill.authHealthCheck('u1');
      expect(r.refreshed).toEqual(['IG-Testkanal']);
      expect(written).toEqual([{ META_ACCESS_TOKEN: 'IGAAneuerToken' }]);
      expect(String((fetchMock.mock.calls[0] as any)[0])).toContain('refresh_access_token');
      expect(r.failures).toEqual([]);
      expect(r.checked).toBe(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it('v984: „token too new" ist KEIN Fehler; EAA-Token wird nicht refresht; Auth-Fehler landet in failures', async () => {
    const ig = makeChannel({ id: 'ch-ig', name: 'IG' });
    (ig as any).platform = 'instagram';
    const fb = makeChannel({ id: 'ch-fb', name: 'FB' });
    (fb as any).platform = 'facebook';
    const { repo } = makeRepo(ig, makeItem());
    (repo as any).listChannels = vi.fn(async () => [ig, fb]);
    const skill = new SocialSkill(repo);
    const igProvider = new FakeProvider();
    (igProvider as any).platform = 'instagram';
    const fbProvider = new FakeProvider();
    (fbProvider as any).platform = 'facebook';
    (fbProvider as any).validateAuth = vi.fn(async () => ({ ok: false, detail: 'Invalid OAuth access token' }));
    skill.registerProvider(igProvider);
    skill.registerProvider(fbProvider);
    skill.setSecretsResolver(async (c) => ({ META_ACCESS_TOKEN: c.id === 'ch-ig' ? 'IGAAtok' : 'EAAtok' }));
    skill.setSecretsWriter(async () => {});
    const fetchMock = vi.fn(async () => ({
      ok: false, status: 400,
      json: async () => ({ error: { message: 'Access token is too new to be refreshed (min age 24 hours)' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const r = await skill.authHealthCheck('u1');
      // Refresh nur für den IG-Kanal versucht (EAA = Facebook-Login-Token, kein Refresh-Endpoint)
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // too-new ist kein failure; der FB-Auth-Fehler schon
      expect(r.failures).toEqual([{ channel: 'FB', detail: 'Invalid OAuth access token' }]);
      expect(r.refreshed).toEqual([]);
      expect(r.checked).toBe(2);
    } finally { vi.unstubAllGlobals(); }
  });

  it('v987: delete_item löscht ungepublishte Items lokal (ohne Story-Sperre); published wird verweigert', async () => {
    const { skill, spies } = makeSkill(makeChannel(), makeItem({ status: 'draft' }));
    const r = await skill.execute({ action: 'delete_item', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(true);
    expect(r.display).toContain('ohne Story-Sperre');
    expect((spies as any).deleteItem).toHaveBeenCalledWith('u1', 'item-0001-aaaa');

    const { skill: skill2, spies: spies2 } = makeSkill(makeChannel(), makeItem({ status: 'published' }));
    const blocked = await skill2.execute({ action: 'delete_item', item_id: 'item-0001-aaaa' }, CTX);
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('delete_remote');
    expect((spies2 as any).deleteItem).not.toHaveBeenCalled();
  });

  it('v989: collectComments sammelt dedupliziert, reply_comment antwortet live und setzt replied', async () => {
    const channel = makeChannel({});
    const published = makeItem({ id: 'pub-1', status: 'published' });
    (published as any).externalId = 'ext-77';
    const storedComments: any[] = [];
    const { repo } = makeRepo(channel, published);
    (repo as any).listItems = vi.fn(async (_u: string, q: any) => (q?.status === 'published' ? [published] : []));
    (repo as any).upsertComment = vi.fn(async (input: any) => {
      if (storedComments.some(c => c.externalCommentId === input.externalCommentId)) return false;
      storedComments.push({ ...input, id: `db-${storedComments.length + 1}`, status: 'new' });
      return true;
    });
    (repo as any).getComment = vi.fn(async (_u: string, id: string) =>
      storedComments.find(c => c.id === id || c.externalCommentId === id) ?? null);
    (repo as any).setCommentStatus = vi.fn(async (_u: string, id: string, status: string, reply?: string) => {
      const c = storedComments.find(x => x.id === id);
      if (c) { c.status = status; c.replyText = reply; }
    });
    (repo as any).listComments = vi.fn(async () => storedComments.filter(c => c.status === 'new'));

    const skill = new SocialSkill(repo);
    const provider = new FakeProvider();
    (provider as any).capabilities = () => ({ text: true, image: true, video: false, supportsDelete: false, supportsMetrics: false, supportsComments: true });
    (provider as any).fetchComments = vi.fn(async () => [
      { itemId: 'pub-1', externalCommentId: 'c-1', externalPostId: 'ext-77', author: 'Max', text: 'Wann geht es los?' },
      { itemId: 'pub-1', externalCommentId: 'c-1', externalPostId: 'ext-77', author: 'Max', text: 'Wann geht es los?' }, // Duplikat
    ]);
    (provider as any).replyToComment = vi.fn(async () => true);
    skill.registerProvider(provider);
    skill.setSecretsResolver(async () => ({}));

    const collected = await skill.collectComments('u1');
    expect(collected.collected).toBe(1);
    expect(collected.byChannel[0].count).toBe(1);

    const list = await skill.execute({ action: 'list_comments' }, CTX);
    expect(list.success).toBe(true);
    expect(list.display).toContain('Wann geht es los?');

    const reply = await skill.execute({ action: 'reply_comment', comment_id: 'db-1', reply: 'Heute 19:00 im Pub!' }, CTX);
    expect(reply.success).toBe(true);
    expect((provider as any).replyToComment).toHaveBeenCalledWith('c-1', 'Heute 19:00 im Pub!', expect.anything(), expect.anything());
    expect(storedComments[0].status).toBe('replied');
    expect(storedComments[0].replyText).toBe('Heute 19:00 im Pub!');

    // bereits beantwortet → Fehler statt Doppel-Antwort
    const again = await skill.execute({ action: 'reply_comment', comment_id: 'db-1', reply: 'nochmal' }, CTX);
    expect(again.success).toBe(false);
  });

  it('v992: suggest_reply liefert LLM-Entwurf in Kanal-Persona OHNE Side-Effect', async () => {
    const channel = makeChannel({ persona: 'locker, per Du' });
    const { repo } = makeRepo(channel, makeItem({ status: 'published' }));
    (repo as any).getComment = vi.fn(async () => ({
      id: 'db-1', userId: 'u1', channelId: 'ch-1', itemId: 'item-0001-aaaa',
      externalCommentId: 'c-1', author: 'Max', text: 'Wann geht es heute los?',
      status: 'new', createdAt: 'x', updatedAt: 'x',
    }));
    (repo as any).setCommentStatus = vi.fn(async () => {});
    const skill = new SocialSkill(repo);
    skill.registerProvider(new FakeProvider());
    const llm = { complete: vi.fn(async () => ({ content: '„Heute um 19:00 im Dublin Irish Pub — komm vorbei!"' })) };
    skill.setLlm(llm as any);

    const r = await skill.execute({ action: 'suggest_reply', comment_id: 'db-1' }, CTX);
    expect(r.success).toBe(true);
    expect((r.data as any).draft).toContain('19:00 im Dublin Irish Pub');
    // Persona + Kommentar im Prompt; NICHTS wurde gesendet oder markiert
    const prompt = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('locker, per Du');
    expect(prompt).toContain('Wann geht es heute los?');
    expect((repo as any).setCommentStatus).not.toHaveBeenCalled();
  });

  it('v991: regenerate_image ersetzt generierte Medien (User-Medien bleiben), Hinweis fließt als Bildidee ein', async () => {
    const item = makeItem({
      status: 'scheduled',
      media: [
        { type: 'image', source: 'generated', pathOrUrl: '/tmp/alt.png' },
        { type: 'image', source: 'user', pathOrUrl: 'https://ex.at/eigenes.jpg' },
      ],
    });
    const { skill, spies } = makeSkill(makeChannel(), item);
    const imageFn = vi.fn(async (_c: unknown, _i: unknown) => [{ type: 'image' as const, source: 'generated' as const, pathOrUrl: '/tmp/neu.png' }]);
    skill.setImageGenerator(imageFn);

    const r = await skill.execute({ action: 'regenerate_image', item_id: 'item-0001-aaaa', hint: 'beide Flaggen zeigen' }, CTX);
    expect(r.success).toBe(true);
    expect(imageFn.mock.calls[0][1]).toMatchObject({ bildidee: 'beide Flaggen zeigen' });
    const newMedia = (spies.updateItemContent as any).mock.calls[0][2].media;
    expect(newMedia.map((m: any) => m.pathOrUrl)).toEqual(['/tmp/neu.png', 'https://ex.at/eigenes.jpg']);

    // kein Bild erzeugt (Budget/Gate) → Fehler, Medien unangetastet
    imageFn.mockResolvedValueOnce([]);
    const fail = await skill.execute({ action: 'regenerate_image', item_id: 'item-0001-aaaa' }, CTX);
    expect(fail.success).toBe(false);
    expect((spies.updateItemContent as any).mock.calls.length).toBe(1);
  });

  it('v991: revise_content — LLM überarbeitet nach Anweisung, kaputte deutsche Zitate werden repariert', async () => {
    const { skill, spies } = makeSkill(makeChannel({ config: { model_tier: 'medium' } }), makeItem({ status: 'draft', title: 'Alt', body: 'Alter langer Text über das Spiel mit vielen Details.' }));
    const llm = {
      complete: vi.fn(async () => ({
        content: '{"title": "Neu und knapp", "body": "Der Trainer sagt „wir sind bereit" und die Fans feiern kurz und knackig mit.", "hashtags": ["wm2026"]}',
      })),
    };
    skill.setLlm(llm as any);

    const r = await skill.execute({ action: 'revise_content', item_id: 'item-0001-aaaa', instruction: 'halb so lang' }, CTX);
    expect(r.success).toBe(true);
    // Kanal-Tier wird genutzt, Thinking aus
    expect((llm.complete as any).mock.calls[0][0]).toMatchObject({ tier: 'medium', reasoningEffort: 'low' });
    const patch = (spies.updateItemContent as any).mock.calls[0][2];
    expect(patch.title).toBe('Neu und knapp');
    expect(patch.body).toContain('„wir sind bereit“'); // ASCII-Schlusszeichen repariert
    expect(patch.hashtags).toEqual(['wm2026']);

    // published → verweigert
    const { skill: s2 } = makeSkill(makeChannel(), makeItem({ status: 'published' }));
    s2.setLlm(llm as any);
    const blocked = await s2.execute({ action: 'revise_content', item_id: 'item-0001-aaaa', instruction: 'x' }, CTX);
    expect(blocked.success).toBe(false);
  });

  it('pause_all = Social-Stopp', async () => {
    const { skill } = makeSkill(makeChannel(), makeItem());
    const r = await skill.execute({ action: 'pause_all' }, CTX);
    expect(r.success).toBe(true);
    expect(r.display).toContain('Social-Stopp');
  });

  it('crosspost: kopiert formatgerecht auf Ziel-Kanäle, überspringt die Quelle', async () => {
    const source = makeChannel({ id: 'ch-1', name: 'Telegram-Kanal' });
    const target = makeChannel({ id: 'ch-2', name: 'fussball.cc', platform: 'rest', persona: 'redaktionell' });
    const item = makeItem({ channelId: 'ch-1', title: 'Derby-Sieg', hashtags: ['fussball'] });
    const createdItems: any[] = [];
    const repo = {
      getChannel: vi.fn(async (_u: string, id: string) => (id === 'ch-1' ? source : id === 'ch-2' ? target : null)),
      findChannelByName: vi.fn(async (_u: string, q: string) =>
        q.toLowerCase().includes('fussball.cc') ? target : q.toLowerCase().includes('telegram') ? source : null),
      getItem: vi.fn(async () => item),
      listItems: vi.fn(async () => [item]),
      createItem: vi.fn(async (_u: string, chId: string, o: any) => {
        const copy = { ...makeItem(), ...o, channelId: chId, id: `copy-${createdItems.length + 1}` };
        createdItems.push(copy);
        return copy;
      }),
      transition: vi.fn(async () => item),
    } as unknown as SocialRepository;
    const skill = new SocialSkill(repo);
    skill.registerProvider(new FakeProvider());
    skill.setLlm({
      complete: vi.fn(async () => ({ content: '{"title":"Derby-Sieg: Die Analyse","body":"Redaktionell aufbereiteter Beitrag zum Derby-Sieg mit allen Details.","hashtags":["fussball","derby"]}' })),
    } as any);

    const r = await skill.execute({ action: 'crosspost', item_id: 'item-0001-aaaa', channels: ['fussball.cc', 'Telegram-Kanal'] }, CTX);
    expect(r.success).toBe(true);
    // Quelle (Telegram-Kanal) übersprungen — nur EINE Kopie auf fussball.cc
    expect(createdItems.length).toBe(1);
    expect(createdItems[0].channelId).toBe('ch-2');
    expect(createdItems[0].body).toContain('Redaktionell aufbereiteter');
    expect(createdItems[0].hashtags).toEqual(['fussball', 'derby']);
    expect(createdItems[0].media).toEqual(item.media);
  });

  it('crosspost ohne LLM: wörtliche Kopie; unbekannter Ziel-Kanal → Fehler', async () => {
    const source = makeChannel({ id: 'ch-1', name: 'Quelle' });
    const target = makeChannel({ id: 'ch-2', name: 'Ziel', platform: 'rest' });
    const item = makeItem({ channelId: 'ch-1', body: 'Original-Text bleibt wörtlich erhalten.' });
    const createdItems: any[] = [];
    const repo = {
      getChannel: vi.fn(async (_u: string, id: string) => (id === 'ch-2' ? target : id === 'ch-1' ? source : null)),
      findChannelByName: vi.fn(async (_u: string, q: string) => (q === 'Ziel' ? target : null)),
      getItem: vi.fn(async () => item),
      listItems: vi.fn(async () => [item]),
      createItem: vi.fn(async (_u: string, chId: string, o: any) => {
        const copy = { ...makeItem(), ...o, channelId: chId, id: 'copy-1' };
        createdItems.push(copy);
        return copy;
      }),
      transition: vi.fn(async () => item),
    } as unknown as SocialRepository;
    const skill = new SocialSkill(repo);

    const ok = await skill.execute({ action: 'crosspost', item_id: 'item-0001-aaaa', channels: ['Ziel'] }, CTX);
    expect(ok.success).toBe(true);
    expect(createdItems[0].body).toBe('Original-Text bleibt wörtlich erhalten.');

    const bad = await skill.execute({ action: 'crosspost', item_id: 'item-0001-aaaa', channels: ['GibtEsNicht'] }, CTX);
    expect(bad.success).toBe(false);
    expect(bad.error).toContain('GibtEsNicht');
  });

  it('v951: link_topic/unlink_topic pflegen config.topic_ids (Legacy topic_id wird überführt)', async () => {
    const channel = makeChannel({ config: { topic_id: 't-legacy' } });
    const state = { config: channel.config as Record<string, unknown> };
    const repo = {
      getChannel: vi.fn(async () => ({ ...channel, config: state.config })),
      findChannelByName: vi.fn(async () => ({ ...channel, config: state.config })),
      updateChannel: vi.fn(async (_u: string, _id: string, patch: any) => { state.config = patch.config; }),
    } as unknown as SocialRepository;
    const skill = new SocialSkill(repo);
    skill.setTopicResolver(async (q: string) =>
      q.toLowerCase().includes('panini') ? { id: 't-panini', name: 'Panini-Sammelalbum' }
        : q === 't-legacy' ? { id: 't-legacy', name: 'WM 2026' } : null);

    // Verknüpfen: Legacy-topic_id wird in topic_ids überführt + neues Topic dazu
    const r = await skill.execute({ action: 'link_topic', channel: 'Testkanal', topic: 'Panini' }, CTX);
    expect(r.success).toBe(true);
    expect(state.config.topic_ids).toEqual(expect.arrayContaining(['t-legacy', 't-panini']));
    expect(state.config.topic_id).toBeUndefined();

    // Lösen
    const r2 = await skill.execute({ action: 'unlink_topic', channel: 'Testkanal', topic: 'Panini' }, CTX);
    expect(r2.success).toBe(true);
    expect(state.config.topic_ids).toEqual(['t-legacy']);

    // Unbekanntes Thema → klarer Fehler mit create_topic-Hinweis
    const bad = await skill.execute({ action: 'link_topic', channel: 'Testkanal', topic: 'GibtEsNicht' }, CTX);
    expect(bad.success).toBe(false);
    expect(bad.error).toContain('create_topic');
  });

  it('v955: edit_content korrigiert Text/Hashtags; lesson wird am Kanal gespeichert (Realfall EM→WM)', async () => {
    const channel = makeChannel();
    const item = makeItem({ status: 'scheduled', body: 'Nach dem EM-Aus gegen Spanien folgt die harte Analyse.', hashtags: ['EURO2024'] });
    const state = { config: channel.config as Record<string, unknown> };
    const repo = {
      getItem: vi.fn(async () => item),
      listItems: vi.fn(async () => [item]),
      getChannel: vi.fn(async () => ({ ...channel, config: state.config })),
      findChannelByName: vi.fn(async () => ({ ...channel, config: state.config })),
      updateItemContent: vi.fn(async () => {}),
      updateChannel: vi.fn(async (_u: string, _id: string, patch: any) => { state.config = patch.config; }),
    } as unknown as SocialRepository;
    const skill = new SocialSkill(repo);

    const r = await skill.execute({
      action: 'edit_content', item_id: 'item-0001-aaaa',
      body: 'Nach dem WM-Aus gegen Spanien folgt die harte Analyse.',
      hashtags: ['WM2026'],
      lesson: 'Es ist die WM 2026, nicht die EM — auch in Hashtags.',
    }, CTX);
    expect(r.success).toBe(true);
    expect((repo.updateItemContent as any).mock.calls[0][2]).toEqual({
      body: 'Nach dem WM-Aus gegen Spanien folgt die harte Analyse.',
      hashtags: ['WM2026'],
    });
    expect(state.config.lessons).toEqual(['Es ist die WM 2026, nicht die EM — auch in Hashtags.']);
    expect(r.display).toContain('Lektion gespeichert');
  });

  it('v955: edit_content verweigert bei published; get_content liefert vollen Text; add_lesson dedupliziert', async () => {
    const channel = makeChannel({ config: { lessons: ['Alte Lektion'] } });
    const published = makeItem({ status: 'published' });
    const state = { config: channel.config as Record<string, unknown> };
    const repo = {
      getItem: vi.fn(async () => published),
      listItems: vi.fn(async () => [published]),
      getChannel: vi.fn(async () => ({ ...channel, config: state.config })),
      findChannelByName: vi.fn(async () => ({ ...channel, config: state.config })),
      updateItemContent: vi.fn(async () => {}),
      updateChannel: vi.fn(async (_u: string, _id: string, patch: any) => { state.config = patch.config; }),
    } as unknown as SocialRepository;
    const skill = new SocialSkill(repo);

    const edit = await skill.execute({ action: 'edit_content', item_id: 'item-0001-aaaa', body: 'Neuer Text hier.' }, CTX);
    expect(edit.success).toBe(false);
    expect(edit.error).toContain('Veröffentlichte');

    const get = await skill.execute({ action: 'get_content', item_id: 'item-0001-aaaa' }, CTX);
    expect(get.success).toBe(true);
    expect(get.display).toContain('Hallo Welt');

    await skill.execute({ action: 'add_lesson', channel: 'Testkanal', lesson: 'Alte Lektion' }, CTX);
    expect(state.config.lessons).toEqual(['Alte Lektion']); // dedupliziert
    await skill.execute({ action: 'add_lesson', channel: 'Testkanal', lesson: 'Neue Lektion' }, CTX);
    expect(state.config.lessons).toEqual(['Alte Lektion', 'Neue Lektion']);
  });

  it('create_channel verweigert unbekannte Plattform mit Liste der vorhandenen', async () => {
    const { skill } = makeSkill(makeChannel(), makeItem());
    const r = await skill.execute({ action: 'create_channel', platform: 'instagram', name: 'IG' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('test');
  });

  it('v959: replan_channel ruft den Replanner und meldet die Anzahl', async () => {
    const { skill } = makeSkill(makeChannel(), makeItem());
    const replan = vi.fn(async () => 3);
    skill.setReplanner(replan);
    const r = await skill.execute({ action: 'replan_channel', channel: 'Testkanal' }, CTX);
    expect(r.success).toBe(true);
    expect(replan).toHaveBeenCalledOnce();
    expect(r.display).toContain('3');
    expect(r.display).toContain('umgeplant');
  });

  it('v964: schedule_content termininiert scheduled-Items STATUSERHALTEND um', async () => {
    const { skill, state, spies } = makeSkill(makeChannel(), makeItem({ status: 'scheduled', scheduledAt: '2026-07-10T18:00:00.000Z' }));
    const r = await skill.execute({ action: 'schedule_content', item_id: 'item-0001-aaaa', scheduled_at: '2026-07-11T10:00:00.000Z' }, CTX);
    expect(r.success).toBe(true);
    expect(spies.reschedule).toHaveBeenCalledWith('u1', 'item-0001-aaaa', '2026-07-11T10:00:00.000Z', ['scheduled', 'approved']);
    expect(spies.transition).not.toHaveBeenCalled();
    expect(state.item.status).toBe('scheduled');
    expect(state.item.scheduledAt).toBe('2026-07-11T10:00:00.000Z');
  });

  it('v964: approved-Item behält beim Umterminieren seine Freigabe', async () => {
    const { skill, state, spies } = makeSkill(makeChannel(), makeItem({ status: 'approved', scheduledAt: '2026-07-10T18:00:00.000Z' }));
    const r = await skill.execute({ action: 'schedule_content', item_id: 'item-0001-aaaa', scheduled_at: '2026-07-12T08:00:00.000Z' }, CTX);
    expect(r.success).toBe(true);
    expect(spies.transition).not.toHaveBeenCalled();
    expect(state.item.status).toBe('approved');
    expect(r.display).toContain('Status bleibt approved');
  });

  it('v964: draft-Item wird wie bisher via Transition terminiert', async () => {
    const { skill, spies } = makeSkill(makeChannel(), makeItem({ status: 'draft' }));
    const r = await skill.execute({ action: 'schedule_content', item_id: 'item-0001-aaaa', scheduled_at: '2026-07-12T08:00:00.000Z' }, CTX);
    expect(r.success).toBe(true);
    expect(spies.transition).toHaveBeenCalledWith('u1', 'item-0001-aaaa', 'scheduled', { scheduledAt: '2026-07-12T08:00:00.000Z' });
    expect(spies.reschedule).not.toHaveBeenCalled();
  });

  it('v962: add_content generiert ein Bild, wenn der Kanal generate_images hat', async () => {
    const { skill, spies } = makeSkill(makeChannel({ config: { generate_images: true } }), makeItem());
    const gen = vi.fn(async () => [{ type: 'image', source: 'generated', pathOrUrl: '/tmp/bild.png' }]);
    skill.setImageGenerator(gen as any);
    const r = await skill.execute({ action: 'add_content', channel: 'Testkanal', body: 'Ein ausreichend langer Ad-hoc-Beitrag.' }, CTX);
    expect(r.success).toBe(true);
    expect(gen).toHaveBeenCalledOnce();
    expect((spies.createItem as any).mock.calls[0][2].media).toEqual([{ type: 'image', source: 'generated', pathOrUrl: '/tmp/bild.png' }]);
    expect(r.display).toContain('mit generiertem Bild');
  });

  it('v962: add_content ohne generate_images ruft den Generator nicht', async () => {
    const { skill, spies } = makeSkill(makeChannel(), makeItem());
    const gen = vi.fn(async () => []);
    skill.setImageGenerator(gen as any);
    const r = await skill.execute({ action: 'add_content', channel: 'Testkanal', body: 'Ein ausreichend langer Ad-hoc-Beitrag.' }, CTX);
    expect(r.success).toBe(true);
    expect(gen).not.toHaveBeenCalled();
    expect((spies.createItem as any).mock.calls[0][2].media).toEqual([]);
  });

  it('v962: media_url des Users hat Vorrang vor der Generierung', async () => {
    const { skill, spies } = makeSkill(makeChannel({ config: { generate_images: true } }), makeItem());
    const gen = vi.fn(async () => [{ type: 'image', source: 'generated', pathOrUrl: '/tmp/bild.png' }]);
    skill.setImageGenerator(gen as any);
    await skill.execute({ action: 'add_content', channel: 'Testkanal', body: 'Ein ausreichend langer Ad-hoc-Beitrag.', media_url: 'https://ex.at/foto.jpg' }, CTX);
    expect(gen).not.toHaveBeenCalled();
    expect((spies.createItem as any).mock.calls[0][2].media[0].pathOrUrl).toBe('https://ex.at/foto.jpg');
  });

  it('v962: Generator-Fehlschlag blockiert den Post nicht (ohne Bild, mit Warnhinweis)', async () => {
    const { skill } = makeSkill(makeChannel({ config: { generate_images: true } }), makeItem());
    skill.setImageGenerator(vi.fn(async () => { throw new Error('image API down'); }) as any);
    const r = await skill.execute({ action: 'add_content', channel: 'Testkanal', body: 'Ein ausreichend langer Ad-hoc-Beitrag.' }, CTX);
    expect(r.success).toBe(true);
    expect(r.display).toContain('Kein Bild');
  });

  it('v963: update_channel merged config verschachtelt — body_template bleibt vollständig', async () => {
    const channel = makeChannel({
      config: {
        generate_images: true,
        body_template: { title: '{{title}}', content: '{{body}}', status: 'DRAFT', tags: '{{hashtags}}' },
      },
    });
    const { skill, state } = makeSkill(channel, makeItem());
    const r = await skill.execute({ action: 'update_channel', channel: 'Testkanal', config: { body_template: { status: 'PUBLISHED' } } }, CTX);
    expect(r.success).toBe(true);
    expect((state.channel.config as any).body_template).toEqual({ title: '{{title}}', content: '{{body}}', status: 'PUBLISHED', tags: '{{hashtags}}' });
    expect((state.channel.config as any).generate_images).toBe(true);
  });

  it('v963: null in der Config löscht den Schlüssel, Arrays werden ersetzt', async () => {
    const channel = makeChannel({ config: { media_upload: { path: '/api/media' }, topic_ids: ['a', 'b'] } });
    const { skill, state } = makeSkill(channel, makeItem());
    await skill.execute({ action: 'update_channel', channel: 'Testkanal', config: { media_upload: null, topic_ids: ['c'] } }, CTX);
    expect('media_upload' in (state.channel.config as any)).toBe(false);
    expect((state.channel.config as any).topic_ids).toEqual(['c']);
  });

  it('v959: update_channel mit posting_slots weist auf replan_channel hin', async () => {
    const { skill } = makeSkill(makeChannel(), makeItem());
    const r = await skill.execute({ action: 'update_channel', channel: 'Testkanal', posting_slots: ['Sa 10:00', 'So 19:00'] }, CTX);
    expect(r.success).toBe(true);
    expect(r.display).toContain('replan_channel');
  });

  it('v979: update_channel model_tier landet in config.model_tier (bestehende Config bleibt)', async () => {
    const channel = makeChannel({ config: { generate_images: true } });
    const { skill, state } = makeSkill(channel, makeItem());
    const r = await skill.execute({ action: 'update_channel', channel: 'Testkanal', model_tier: 'medium' }, CTX);
    expect(r.success).toBe(true);
    expect((state.channel.config as any).model_tier).toBe('medium');
    expect((state.channel.config as any).generate_images).toBe(true);
    // ungültiger Wert wird ignoriert
    const r2 = await skill.execute({ action: 'update_channel', channel: 'Testkanal', model_tier: 'turbo' }, CTX);
    expect(r2.success).toBe(false); // nichts zu ändern
  });
});
