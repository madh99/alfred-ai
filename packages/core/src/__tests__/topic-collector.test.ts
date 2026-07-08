import { describe, it, expect, vi } from 'vitest';
import { TopicCollector, keywordImportance } from '../topic-collector.js';
import { topicItemDedupeHash } from '@alfred/storage';
import type { InterestsRepository, InterestTopic, TopicSource } from '@alfred/storage';

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() } as any;
}

const TOPIC: InterestTopic = {
  id: 't1', userId: 'u1', name: 'Claude Fable',
  keywords: ['claude', 'fable'], status: 'active', origin: 'manual',
  notifyThreshold: 'high', createdAt: '2026-07-01T00:00:00Z',
};

/** Fake-Repo mit echter Dedup-Logik (gleicher Hash → nicht eingefügt). */
function makeFakeRepo(sources: TopicSource[]) {
  const items = new Map<string, { id: string; title: string }>();
  const repo = {
    listAllActiveTopics: vi.fn(async () => [TOPIC]),
    listSources: vi.fn(async () => sources),
    insertItem: vi.fn(async (_topicId: string, item: { title: string; url?: string }) => {
      const hash = topicItemDedupeHash(item);
      if (items.has(hash)) return { inserted: false, id: items.get(hash)!.id };
      const id = `i${items.size + 1}`;
      items.set(hash, { id, title: item.title });
      return { inserted: true, id };
    }),
    markSourceChecked: vi.fn(async () => {}),
    touchActivity: vi.fn(async () => {}),
    // v1048 — Precheck + Channel-ID-Persistierung der youtube-Quelle
    itemExists: vi.fn(async (_topicId: string, hash: string) => items.has(hash)),
    updateSourceConfig: vi.fn(async () => {}),
  };
  return { repo: repo as unknown as InterestsRepository, items, spies: repo };
}

describe('keywordImportance', () => {
  it('Anteil gefundener Keywords in Titel+Summary', () => {
    expect(keywordImportance(TOPIC, { title: 'Claude Fable 5 erschienen' })).toBe(1);
    expect(keywordImportance(TOPIC, { title: 'Anthropic News', summary: 'Neues von Claude' })).toBe(0.5);
    expect(keywordImportance(TOPIC, { title: 'Bitcoin ATH' })).toBe(0);
  });

  it('ohne Keywords → undefined (alles aus Topic-Quellen gilt)', () => {
    expect(keywordImportance({ keywords: [] }, { title: 'X' })).toBeUndefined();
  });
});

describe('TopicCollector', () => {
  const WEB_SOURCE: TopicSource = {
    id: 's1', topicId: 't1', kind: 'web_search',
    config: { query: 'claude fable news' }, addedBy: 'manual', enabled: true,
    createdAt: '2026-07-01T00:00:00Z',
  };

  function makeSearchStack(results: Array<{ title: string; url?: string; snippet?: string }>) {
    const skill = { metadata: { name: 'web_search' } };
    const registry = { get: vi.fn((name: string) => name === 'web_search' ? skill : undefined) };
    const sandbox = { execute: vi.fn(async () => ({ success: true, data: { query: 'q', results } })) };
    return { registry: registry as any, sandbox: sandbox as any };
  }

  it('web_search-Quelle: Items landen dedupliziert im Repo', async () => {
    const { repo, spies } = makeFakeRepo([WEB_SOURCE]);
    const { registry, sandbox } = makeSearchStack([
      { title: 'Claude Fable 5 Release', url: 'https://ex.at/a', snippet: 'Anthropic veröffentlicht Fable' },
      { title: 'Fable Benchmark', url: 'https://ex.at/b' },
      // Duplikat per URL (Query-Variante)
      { title: 'Fable 5 Release (Kopie)', url: 'https://ex.at/a?ref=rss' },
    ]);
    const collector = new TopicCollector(repo, registry, sandbox, makeLogger());

    const inserted = await collector.collectTopic(TOPIC);
    expect(inserted).toBe(2);
    expect(spies.insertItem).toHaveBeenCalledTimes(3);
    expect(spies.markSourceChecked).toHaveBeenCalledWith('s1');
    expect(spies.touchActivity).toHaveBeenCalledWith('t1');
  });

  it('zweiter Lauf mit gleichen Ergebnissen → 0 neue Items, keine touchActivity', async () => {
    const { repo, spies } = makeFakeRepo([WEB_SOURCE]);
    const { registry, sandbox } = makeSearchStack([
      { title: 'Claude Fable 5 Release', url: 'https://ex.at/a' },
    ]);
    const collector = new TopicCollector(repo, registry, sandbox, makeLogger());

    expect(await collector.collectTopic(TOPIC)).toBe(1);
    (spies.touchActivity as any).mockClear();
    expect(await collector.collectTopic(TOPIC)).toBe(0);
    expect(spies.touchActivity).not.toHaveBeenCalled();
  });

  it('Quellen-Fehler bricht den Lauf nicht ab (nächste Quelle läuft)', async () => {
    const failing: TopicSource = { ...WEB_SOURCE, id: 's0' };
    const { repo } = makeFakeRepo([failing, WEB_SOURCE]);
    const skill = { metadata: { name: 'web_search' } };
    const registry = { get: vi.fn(() => skill) } as any;
    const sandbox = {
      execute: vi.fn()
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce({ success: true, data: { results: [{ title: 'OK', url: 'https://ex.at/ok' }] } }),
    } as any;
    const collector = new TopicCollector(repo, registry, sandbox, makeLogger());

    expect(await collector.collectTopic(TOPIC)).toBe(1);
  });

  it('collectAll läuft über alle aktiven Topics', async () => {
    const { repo } = makeFakeRepo([WEB_SOURCE]);
    const { registry, sandbox } = makeSearchStack([{ title: 'Neu', url: 'https://ex.at/n' }]);
    const collector = new TopicCollector(repo, registry, sandbox, makeLogger());
    expect(await collector.collectAll()).toBe(1);
  });

  it('leerer Titel wird verworfen', async () => {
    const { repo, spies } = makeFakeRepo([WEB_SOURCE]);
    const { registry, sandbox } = makeSearchStack([{ title: '   ', url: 'https://ex.at/x' }]);
    const collector = new TopicCollector(repo, registry, sandbox, makeLogger());
    expect(await collector.collectTopic(TOPIC)).toBe(0);
    expect(spies.insertItem).not.toHaveBeenCalled();
  });

  it('v990: exclude_keywords hält Fremdthemen aus den Topic-Items (ORF-Leak-Fall)', async () => {
    const filtered: TopicSource = {
      ...WEB_SOURCE, id: 's-f',
      config: { query: 'sport news', exclude_keywords: ['Formel 1', 'radsport'] },
    };
    const { repo, spies } = makeFakeRepo([filtered]);
    const { registry, sandbox } = makeSearchStack([
      { title: 'Klopp spricht mit DFB', url: 'https://ex.at/klopp' },
      { title: 'Volle Kurve in Silverstone', url: 'https://ex.at/f1', snippet: 'Formel 1 in England' },
      { title: 'Pogacar dominiert', url: 'https://ex.at/rad', snippet: 'Radsport-Klassiker' },
    ]);
    const collector = new TopicCollector(repo, registry, sandbox, makeLogger());
    expect(await collector.collectTopic(TOPIC)).toBe(1);
    expect((spies.insertItem as any).mock.calls[0][1].title).toBe('Klopp spricht mit DFB');
  });

  it('v975: Quelle mit config.events=true stempelt Items als sourceKind events', async () => {
    const eventsSource: TopicSource = {
      ...WEB_SOURCE, id: 's-ev',
      config: { query: 'public viewing termine', events: true },
    };
    const { repo, spies } = makeFakeRepo([eventsSource]);
    const { registry, sandbox } = makeSearchStack([
      { title: 'Kanada - Marokko – 04.07.2026, 19:00', url: 'https://fussball.cc/public-viewing/termine/x1' },
    ]);
    const collector = new TopicCollector(repo, registry, sandbox, makeLogger());
    expect(await collector.collectTopic(TOPIC)).toBe(1);
    expect((spies.insertItem as any).mock.calls[0][1]).toMatchObject({ sourceKind: 'events' });
  });

  // ── v1048 — YouTube-Kanäle als Themen-Quelle ──
  const YT_SOURCE: TopicSource = {
    id: 's-yt', topicId: 't1', kind: 'youtube',
    config: { channel: '@ServusTVSport' }, addedBy: 'manual', enabled: true,
    createdAt: '2026-07-01T00:00:00Z',
  };

  function makeYoutubeStack(videos: Array<{ videoId: string; title: string; url: string; publishedAt?: string; description?: string }>) {
    const fetchers = {
      resolveChannel: vi.fn(async () => 'UCabcdefghijklmnopqrstuv'),
      fetchChannelVideos: vi.fn(async () => ({ channelTitle: 'ServusTV Sport', videos })),
      fetchTranscript: vi.fn(async () => [
        { text: 'Argentinien gewinnt das Viertelfinale gegen Ägypten mit zwei zu null.', offset: 0, duration: 5 },
        { text: 'Die Tore erzielten Alvarez und Fernandez in der zweiten Halbzeit vor achtzigtausend Zuschauern im ausverkauften Stadion von Dallas.', offset: 5, duration: 6 },
      ]),
    };
    // Meta-Überschrift absichtlich dabei — muss gestrippt werden (v1051)
    const llm = { complete: vi.fn(async () => ({ content: '# Zusammenfassung: Argentinien - Ägypten\n\nArgentinien schlägt Ägypten 2:0 im WM-Viertelfinale. Alvarez und Fernandez treffen in Halbzeit zwei vor 80.000 Zuschauern in Dallas.' })) };
    return { fetchers, llm };
  }

  it('v1048: youtube-Quelle — Kanal aufgelöst + persistiert, Transcript per LLM verdichtet, sourceKind youtube', async () => {
    const { repo, spies } = makeFakeRepo([YT_SOURCE]);
    const { fetchers, llm } = makeYoutubeStack([
      { videoId: 'abc12345678', title: 'WM-Viertelfinale: Argentinien - Ägypten Highlights', url: 'https://youtube.com/watch?v=abc12345678', publishedAt: '2026-07-07' },
      // v1052-Regression: ZWEITES Video muss ebenfalls durchkommen — der
      // Query-strippende Dedupe-Hash kollabierte vorher alle watch?v=-URLs
      { videoId: 'def12345678', title: 'Pressekonferenz nach dem Spiel', url: 'https://youtube.com/watch?v=def12345678', publishedAt: '2026-07-07' },
    ]);
    const collector = new TopicCollector(repo, undefined, undefined, makeLogger(),
      { youtubeApiKey: 'key-x', llm: llm as any, youtubeFetchers: fetchers as any });
    expect(await collector.collectTopic(TOPIC)).toBe(2);
    expect(fetchers.resolveChannel).toHaveBeenCalled();
    // aufgelöste Channel-ID wird in der Quell-Config persistiert (Quota-Schonung)
    expect((spies as any).updateSourceConfig).toHaveBeenCalledWith('s-yt', expect.objectContaining({ channel_id_cached: 'UCabcdefghijklmnopqrstuv' }));
    const call = (spies.insertItem as any).mock.calls[0][1];
    expect(call.sourceKind).toBe('youtube');
    expect(call.summary.startsWith('Argentinien schlägt Ägypten 2:0')).toBe(true); // LLM-Verdichtung, Meta-Kopf gestrippt
    expect(call.summary).not.toContain('#');
    // v1052 — kanonische youtu.be-URL (Identität im Pfad, dedupe-sicher)
    expect(call.url).toBe('https://youtu.be/abc12345678');
    expect((spies.insertItem as any).mock.calls[1][1].url).toBe('https://youtu.be/def12345678');
  });

  it('v1048: bekanntes Video → KEIN Transcript-Fetch, KEIN LLM-Call (Precheck über Dedupe-Hash)', async () => {
    const { repo, spies } = makeFakeRepo([{ ...YT_SOURCE, config: { channel: '@ServusTVSport', channel_id_cached: 'UCabcdefghijklmnopqrstuv' } }]);
    const { fetchers, llm } = makeYoutubeStack([
      { videoId: 'abc12345678', title: 'WM-Viertelfinale Highlights', url: 'https://youtube.com/watch?v=abc12345678' },
    ]);
    const collector = new TopicCollector(repo, undefined, undefined, makeLogger(),
      { youtubeApiKey: 'key-x', llm: llm as any, youtubeFetchers: fetchers as any });
    expect(await collector.collectTopic(TOPIC)).toBe(1); // Lauf 1: eingesammelt
    expect(await collector.collectTopic(TOPIC)).toBe(0); // Lauf 2: bekannt
    expect(fetchers.fetchTranscript).toHaveBeenCalledTimes(1); // nur beim ersten Lauf
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(fetchers.resolveChannel).not.toHaveBeenCalled(); // ID kam aus der Config
    void spies;
  });

  it('v1048: ohne API-Key + UC-ID → RSS-Fallback über den Kanal-Feed', async () => {
    const { repo, spies } = makeFakeRepo([{ ...YT_SOURCE, config: { channel: 'UCabcdefghijklmnopqrstuv', transcript: false } }]);
    const { fetchers } = makeYoutubeStack([]);
    const collector = new TopicCollector(repo, undefined, undefined, makeLogger(), { youtubeFetchers: fetchers as any });
    (collector as any).fetchRss = vi.fn(async (src: TopicSource) => {
      expect(src.config.url).toBe('https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv');
      return [{ title: 'Highlight-Video', url: 'https://www.youtube.com/watch?v=xyz98765432', summary: 'Beschreibung aus dem Feed' }];
    });
    expect(await collector.collectTopic(TOPIC)).toBe(1);
    expect(fetchers.fetchChannelVideos).not.toHaveBeenCalled(); // kein API-Pfad
    expect((spies.insertItem as any).mock.calls[0][1].summary).toBe('Beschreibung aus dem Feed');
  });

  it('v1048: ohne API-Key und ohne UC-ID → Quelle schlägt sauber fehl (warn), andere Quellen laufen weiter', async () => {
    const { repo, spies } = makeFakeRepo([{ ...YT_SOURCE, config: { channel: '@NurEinName' } }, WEB_SOURCE]);
    const { registry, sandbox } = makeSearchStack([{ title: 'Claude Fable News', url: 'https://ex.at/n' }]);
    const logger = makeLogger();
    const collector = new TopicCollector(repo, registry, sandbox, logger);
    expect(await collector.collectTopic(TOPIC)).toBe(1); // web_search-Item kam trotzdem
    expect(logger.warn).toHaveBeenCalled();
    void spies;
  });
});
