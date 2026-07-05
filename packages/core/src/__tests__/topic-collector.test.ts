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
});
