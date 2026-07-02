import { describe, it, expect, vi } from 'vitest';
import { parseSuggestions, InterestDetector } from '../interest-detector.js';
import { SourceProvisioner, looksLikeFeedUrl } from '../source-provisioner.js';
import { TopicDigestBuilder, digestUrgency } from '../topic-digest-builder.js';
import { boostByTopicRelevance } from '../topic-relevance.js';
import type { InterestsRepository, InsightsRepository, InterestTopic, TopicItem } from '@alfred/storage';

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() } as any;
}

const TOPIC: InterestTopic = {
  id: 't1', userId: 'owner', name: 'Claude Fable',
  keywords: ['claude', 'fable'], status: 'active', origin: 'manual',
  notifyThreshold: 'high', createdAt: '2026-07-01T00:00:00Z',
};

// ── Score-Kriterium 4: Themen-Relevanz ─────────────────────────────────

describe('boostByTopicRelevance (v930 Score-Kriterium 4)', () => {
  it('hebt Items mit ≥2 Keyword-Treffern eine Stufe an (max high) + warum', () => {
    const items = [
      { summary: 'Neuer Artikel: Claude Fable 5 schlägt Benchmarks', urgency: 'low' as const },
      { summary: 'Claude und Fable dominieren die News', urgency: 'normal' as const, warum: 'aktuell' },
      { summary: 'BMW SoC bei 3%', urgency: 'high' as const },
    ];
    const boosted = boostByTopicRelevance(items, [TOPIC]);
    expect(boosted[0].urgency).toBe('normal');
    expect(boosted[0].warum).toContain('Interessen-Thema „Claude Fable"');
    expect(boosted[1].urgency).toBe('high');
    expect(boosted[1].warum).toContain('aktuell · ');
    expect(boosted[2].urgency).toBe('high'); // kein Treffer → unverändert
    expect(boosted[2].warum).toBeUndefined();
  });

  it('boostet nie über high; urgent bleibt urgent', () => {
    const items = [
      { summary: 'claude fable news', urgency: 'high' as const },
      { summary: 'claude fable kritisch', urgency: 'urgent' as const },
    ];
    const boosted = boostByTopicRelevance(items, [TOPIC]);
    expect(boosted[0].urgency).toBe('high');
    expect(boosted[1].urgency).toBe('urgent');
  });

  it('ohne Topics/Treffer: Items unverändert', () => {
    const items = [{ summary: 'irgendwas', urgency: 'low' as const }];
    expect(boostByTopicRelevance(items, [])).toEqual(items);
    expect(boostByTopicRelevance(items, [TOPIC])[0].urgency).toBe('low');
  });
});

// ── Interest-Detector ──────────────────────────────────────────────────

describe('parseSuggestions', () => {
  it('parst JSON-Array tolerant (auch mit Text drumherum)', () => {
    const out = parseSuggestions('Hier die Themen:\n[{"name":"GPU-Verkauf","keywords":["gpu","verkauf"],"strength":"strong","warum":"mehrfach besprochen"}]');
    expect(out).toEqual([{ name: 'GPU-Verkauf', keywords: ['gpu', 'verkauf'], strength: 'strong', warum: 'mehrfach besprochen' }]);
  });

  it('kaputte/leere Antworten → leeres Array; unbekannte strength → medium', () => {
    expect(parseSuggestions('KEINE')).toEqual([]);
    expect(parseSuggestions('[]')).toEqual([]);
    expect(parseSuggestions('[{"name":"Xy","strength":"mega"}]')[0].strength).toBe('medium');
  });
});

function makeInterestsRepo(existing: InterestTopic[] = []) {
  return {
    listTopics: vi.fn(async () => existing),
    findTopicByName: vi.fn(async (_u: string, name: string) =>
      existing.find(t => t.name.toLowerCase() === name.toLowerCase()) ?? null),
    createTopic: vi.fn(async (_u: string, o: any) => ({ ...TOPIC, id: 'new-1', name: o.name, keywords: o.keywords ?? [], origin: o.origin })),
    listSources: vi.fn(async () => []),
    addSource: vi.fn(async (topicId: string, o: any) => ({ id: 'src-1', topicId, ...o, enabled: true, createdAt: 'x' })),
    listAllActiveTopics: vi.fn(async () => existing),
    getDigest: vi.fn(async () => null),
    upsertDigest: vi.fn(async () => {}),
    listItems: vi.fn(async () => []),
    countItemsSince: vi.fn(async () => 0),
  } as unknown as InterestsRepository;
}

function makeInsightsRepo() {
  return { upsertCandidate: vi.fn(async () => ({ inserted: true, id: 'i1' })) } as unknown as InsightsRepository;
}

describe('InterestDetector', () => {
  const SIGNALS = {
    entities: [{ name: 'GPU-Verkauf', type: 'concept', mentions: 12 }],
    recentSummaries: ['User plant Grafikkarten zu verkaufen'],
  };

  it('strength=strong → Topic auto angelegt + Provisioner + stiller Info-Eintrag', async () => {
    const interests = makeInterestsRepo();
    const insights = makeInsightsRepo();
    const llm = { complete: vi.fn(async () => ({ content: '[{"name":"GPU-Verkauf","keywords":["gpu"],"strength":"strong","warum":"mehrfach"}]' })) } as any;
    const provision = vi.fn(async () => ({ rssAdded: ['https://f'], queriesAdded: ['q'] }));
    const detector = new InterestDetector(
      interests, insights, llm, { provision } as any,
      async () => SIGNALS, makeLogger(), 'owner',
    );

    const r = await detector.runDetection();
    expect(r.autoCreated).toEqual(['GPU-Verkauf']);
    expect((interests.createTopic as any).mock.calls[0][1].origin).toBe('auto');
    expect(provision).toHaveBeenCalledTimes(1);
    const stored = (insights.upsertCandidate as any).mock.calls[0][1];
    expect(stored.category).toBe('interest-suggestion');
    expect(stored.sourceData.autoCreated).toBe(true);
  });

  it('strength=medium → Insight-Vorschlag mit Aktion „Thema anlegen"', async () => {
    const interests = makeInterestsRepo();
    const insights = makeInsightsRepo();
    const llm = { complete: vi.fn(async () => ({ content: '[{"name":"E-Auto-Förderung","keywords":["förderung"],"strength":"medium","warum":"öfter Thema"}]' })) } as any;
    const detector = new InterestDetector(interests, insights, llm, undefined, async () => SIGNALS, makeLogger(), 'owner');

    const r = await detector.runDetection();
    expect(r.suggested).toEqual(['E-Auto-Förderung']);
    expect(interests.createTopic).not.toHaveBeenCalled();
    const stored = (insights.upsertCandidate as any).mock.calls[0][1];
    expect(stored.actionSkill).toBe('interests');
    expect(stored.actionParams).toEqual({ action: 'create_topic', name: 'E-Auto-Förderung', keywords: ['förderung'] });
    expect(stored.sourceData.actionLabel).toBe('Thema anlegen');
  });

  it('bereits existierendes Thema wird übersprungen', async () => {
    const interests = makeInterestsRepo([TOPIC]);
    const insights = makeInsightsRepo();
    const llm = { complete: vi.fn(async () => ({ content: '[{"name":"Claude Fable","strength":"strong","warum":"x"}]' })) } as any;
    const detector = new InterestDetector(interests, insights, llm, undefined, async () => SIGNALS, makeLogger(), 'owner');

    const r = await detector.runDetection();
    expect(r.autoCreated).toEqual([]);
    expect(interests.createTopic).not.toHaveBeenCalled();
  });
});

// ── Source-Provisioner ─────────────────────────────────────────────────

describe('SourceProvisioner', () => {
  it('looksLikeFeedUrl-Heuristik', () => {
    expect(looksLikeFeedUrl('https://ex.at/feed')).toBe(true);
    expect(looksLikeFeedUrl('https://ex.at/rss.xml')).toBe(true);
    expect(looksLikeFeedUrl('https://feeds.ex.at/all')).toBe(true);
    expect(looksLikeFeedUrl('https://ex.at/artikel/claude')).toBe(false);
  });

  it('valide RSS-Kandidaten + stehende Queries werden angelegt, kaputte Feeds übersprungen', async () => {
    const repo = makeInterestsRepo();
    const skill = { metadata: { name: 'web_search' } };
    const registry = { get: vi.fn(() => skill) } as any;
    const sandbox = {
      execute: vi.fn(async () => ({
        success: true,
        data: { results: [
          { title: 'Feed A', url: 'https://a.at/feed' },
          { title: 'Feed B', url: 'https://b.at/rss.xml' },
          { title: 'HTML-Seite', url: 'https://c.at/artikel' },
        ] },
      })),
    } as any;
    const validate = vi.fn(async (url: string) => url !== 'https://b.at/rss.xml'); // B ist kaputt
    const provisioner = new SourceProvisioner(repo, registry, sandbox, undefined, makeLogger(), validate);

    const r = await provisioner.provision(TOPIC);
    expect(r.rssAdded).toEqual(['https://a.at/feed']);
    expect(r.queriesAdded.length).toBe(2); // Themenname + Keyword-Query
    const kinds = (repo.addSource as any).mock.calls.map((c: any[]) => c[1].kind);
    expect(kinds.filter((k: string) => k === 'rss').length).toBe(1);
    expect(kinds.filter((k: string) => k === 'web_search').length).toBe(2);
    expect((repo.addSource as any).mock.calls.every((c: any[]) => c[1].addedBy === 'auto')).toBe(true);
  });

  it('ohne web_search-Skill: nur Queries, keine RSS', async () => {
    const repo = makeInterestsRepo();
    const registry = { get: vi.fn(() => undefined) } as any;
    const provisioner = new SourceProvisioner(repo, registry, { execute: vi.fn() } as any, undefined, makeLogger(), vi.fn(async () => true));
    const r = await provisioner.provision(TOPIC);
    expect(r.rssAdded).toEqual([]);
    expect(r.queriesAdded.length).toBe(2);
  });
});

// ── Digest-Builder ─────────────────────────────────────────────────────

describe('digestUrgency', () => {
  it('beste Item-Relevanz bestimmt die Stufe', () => {
    expect(digestUrgency([{ importance: 0.9 }, { importance: 0.1 }])).toBe('high');
    expect(digestUrgency([{ importance: 0.5 }])).toBe('normal');
    expect(digestUrgency([{ importance: 0.1 }])).toBe('low');
    expect(digestUrgency([{}])).toBe('normal'); // ohne importance → 0.5
  });
});

describe('TopicDigestBuilder', () => {
  const NEW_ITEM: TopicItem = {
    id: 'i1', topicId: 't1', title: 'Fable 5 Release', url: 'https://ex.at/a',
    sourceKind: 'rss', importance: 0.9, createdAt: '2026-07-02T08:00:00Z',
  };

  function makeRouter() {
    return { route: vi.fn(async () => 'sent'), store: vi.fn(async () => 'stored') } as any;
  }

  it('neue Items → Dossier aktualisiert + EINE Meldung über den Router', async () => {
    const repo = makeInterestsRepo([TOPIC]);
    (repo.getDigest as any).mockResolvedValue({ topicId: 't1', summary: 'Alt.', itemsSinceUpdate: 0, updatedAt: '2026-07-01T06:00:00Z' });
    (repo.countItemsSince as any).mockResolvedValue(1);
    (repo.listItems as any).mockResolvedValue([NEW_ITEM]);
    const llm = { complete: vi.fn(async () => ({ content: 'Neues Dossier: Fable 5 ist da und überzeugt.' })) } as any;
    const router = makeRouter();
    const builder = new TopicDigestBuilder(repo, llm, router, makeLogger(), { chatId: 'c1', platform: 'telegram' as any });

    const updated = await builder.run();
    expect(updated).toBe(1);
    expect(repo.upsertDigest).toHaveBeenCalledWith('t1', 'Neues Dossier: Fable 5 ist da und überzeugt.');
    // importance 0.9 → high ≥ notifyThreshold high → route (Router entscheidet senden/still)
    expect(router.route).toHaveBeenCalledTimes(1);
    const n = (router.route as any).mock.calls[0][0];
    expect(n.source).toBe('interests');
    expect(n.urgency).toBe('high');
    expect(n.body).toContain('Fable 5 Release');
  });

  it('unter Topic-Schwelle → nur stille Ablage (store statt route)', async () => {
    const repo = makeInterestsRepo([TOPIC]); // notifyThreshold high
    (repo.countItemsSince as any).mockResolvedValue(1);
    (repo.listItems as any).mockResolvedValue([{ ...NEW_ITEM, importance: 0.2 }]); // → low
    const router = makeRouter();
    const builder = new TopicDigestBuilder(repo, undefined, router, makeLogger(), { chatId: 'c1', platform: 'telegram' as any });

    await builder.run();
    expect(router.route).not.toHaveBeenCalled();
    expect(router.store).toHaveBeenCalledTimes(1);
  });

  it('keine neuen Items → nichts passiert', async () => {
    const repo = makeInterestsRepo([TOPIC]);
    (repo.getDigest as any).mockResolvedValue({ topicId: 't1', summary: 'Alt.', itemsSinceUpdate: 0, updatedAt: '2026-07-02T06:00:00Z' });
    (repo.countItemsSince as any).mockResolvedValue(0);
    const router = makeRouter();
    const builder = new TopicDigestBuilder(repo, undefined, router, makeLogger(), { chatId: 'c1', platform: 'telegram' as any });

    expect(await builder.run()).toBe(0);
    expect(repo.upsertDigest).not.toHaveBeenCalled();
    expect(router.route).not.toHaveBeenCalled();
    expect(router.store).not.toHaveBeenCalled();
  });
});
