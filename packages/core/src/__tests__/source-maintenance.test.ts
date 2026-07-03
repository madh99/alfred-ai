import { describe, it, expect, vi } from 'vitest';
import { SourceMaintenance, type FeedProbeResult } from '../source-maintenance.js';
import type { InterestsRepository, InsightsRepository, InterestTopic, TopicSource } from '@alfred/storage';

const OWNER = 'owner-1';

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() } as any;
}

const TOPIC: InterestTopic = {
  id: 't1', userId: OWNER, name: 'Fußball NÖ', keywords: ['fussball'],
  status: 'active', origin: 'auto', notifyThreshold: 'high', createdAt: 'x',
};

function makeSource(overrides: Partial<TopicSource> = {}): TopicSource {
  return {
    id: 'src-1', topicId: 't1', kind: 'rss', config: { url: 'https://ex.at/feed' },
    addedBy: 'auto', enabled: true, createdAt: 'x', ...overrides,
  };
}

function makeStack(opts: {
  sources: TopicSource[];
  probes: Record<string, FeedProbeResult>;
  provisionAdds?: string[];
}) {
  const state = { sources: opts.sources.map(s => ({ ...s, config: { ...s.config } })) };
  const repo = {
    listAllActiveTopics: vi.fn(async () => [TOPIC]),
    listSources: vi.fn(async (_t: string, onlyEnabled?: boolean) =>
      onlyEnabled ? state.sources.filter(s => s.enabled) : state.sources),
    setSourceEnabled: vi.fn(async (id: string, enabled: boolean) => {
      const s = state.sources.find(x => x.id === id);
      if (s) s.enabled = enabled;
    }),
    updateSourceConfig: vi.fn(async (id: string, config: Record<string, unknown>) => {
      const s = state.sources.find(x => x.id === id);
      if (s) s.config = config;
    }),
  } as unknown as InterestsRepository;

  const provisioner = {
    provision: vi.fn(async () => ({ rssAdded: opts.provisionAdds ?? [], queriesAdded: [] })),
  } as any;

  const insightsRepo = { upsertCandidate: vi.fn(async () => ({ inserted: true, id: 'i1' })) } as unknown as InsightsRepository;

  const probe = vi.fn(async (url: string) => opts.probes[url] ?? { ok: true, newestIso: new Date().toISOString() });
  const maintenance = new SourceMaintenance(repo, provisioner, insightsRepo, makeLogger(), OWNER, probe);
  return { maintenance, repo, provisioner, insightsRepo, state, probe };
}

describe('SourceMaintenance (v940)', () => {
  const FRESH = { ok: true, newestIso: new Date().toISOString() };
  const DEAD: FeedProbeResult = { ok: false, detail: 'ENOTFOUND' };

  it('erster Fehlschlag = nur Strike, Quelle bleibt aktiv (transiente Ausfälle)', async () => {
    const { maintenance, state } = makeStack({
      sources: [makeSource()], probes: { 'https://ex.at/feed': DEAD },
      provisionAdds: [],
    });
    const r = await maintenance.runWeekly();
    expect(r.disabled).toBe(0);
    expect(state.sources[0].enabled).toBe(true);
    expect(state.sources[0].config._strikes).toBe(1);
  });

  it('zweiter Strike in Folge deaktiviert die Quelle mit Grund', async () => {
    const { maintenance, state } = makeStack({
      sources: [makeSource({ config: { url: 'https://ex.at/feed', _strikes: 1 } })],
      probes: { 'https://ex.at/feed': DEAD },
    });
    const r = await maintenance.runWeekly();
    expect(r.disabled).toBe(1);
    expect(state.sources[0].enabled).toBe(false);
    expect(String(state.sources[0].config._disabledReason)).toContain('nicht erreichbar');
  });

  it('gesunde Probe setzt Strikes zurück', async () => {
    const { maintenance, state } = makeStack({
      sources: [makeSource({ config: { url: 'https://ex.at/feed', _strikes: 1 } })],
      probes: { 'https://ex.at/feed': FRESH },
    });
    await maintenance.runWeekly();
    expect(state.sources[0].config._strikes).toBe(0);
    expect(state.sources[0].enabled).toBe(true);
  });

  it('Staleness (>45 Tage nichts Neues) zählt als Strike', async () => {
    const old = new Date(Date.now() - 60 * 24 * 3_600_000).toISOString();
    const { maintenance, state } = makeStack({
      sources: [makeSource()],
      probes: { 'https://ex.at/feed': { ok: true, newestIso: old } },
    });
    await maintenance.runWeekly();
    expect(state.sources[0].config._strikes).toBe(1);
  });

  it('unter 2 funktionierenden Feeds → Provisioner bestückt nach + Report-Insight', async () => {
    const { maintenance, provisioner, insightsRepo } = makeStack({
      sources: [makeSource({ config: { url: 'https://ex.at/feed', _strikes: 1 } })],
      probes: { 'https://ex.at/feed': DEAD }, // → deaktiviert → 0 gesunde Feeds
      provisionAdds: ['https://neu.at/rss'],
    });
    const r = await maintenance.runWeekly();
    expect(r.disabled).toBe(1);
    expect(r.added).toBe(1);
    expect(provisioner.provision).toHaveBeenCalledWith(TOPIC);
    const candidate = (insightsRepo.upsertCandidate as any).mock.calls[0][1];
    expect(candidate.title).toContain('1 Feed(s) neu, 1 deaktiviert');
    expect(candidate.sourceData.router).toBe(true);
  });

  it('alles gesund + genug Feeds → kein Provision-Lauf, kein Insight', async () => {
    const { maintenance, provisioner, insightsRepo } = makeStack({
      sources: [
        makeSource({ id: 's1', config: { url: 'https://a.at/feed' } }),
        makeSource({ id: 's2', config: { url: 'https://b.at/feed' } }),
      ],
      probes: { 'https://a.at/feed': FRESH, 'https://b.at/feed': FRESH },
    });
    const r = await maintenance.runWeekly();
    expect(r).toEqual({ checked: 2, disabled: 0, added: 0 });
    expect(provisioner.provision).not.toHaveBeenCalled();
    expect(insightsRepo.upsertCandidate).not.toHaveBeenCalled();
  });

  it('web_search-Quellen und deaktivierte Quellen werden nicht geprobt', async () => {
    const { maintenance, probe } = makeStack({
      sources: [
        makeSource({ id: 's1', kind: 'web_search', config: { query: 'fussball news' } }),
        makeSource({ id: 's2', enabled: false, config: { url: 'https://tot.at/feed' } }),
        makeSource({ id: 's3', config: { url: 'https://ok.at/feed' } }),
      ],
      probes: { 'https://ok.at/feed': FRESH },
    });
    const r = await maintenance.runWeekly();
    expect(r.checked).toBe(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith('https://ok.at/feed');
  });
});
