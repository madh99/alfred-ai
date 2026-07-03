import { describe, it, expect, vi } from 'vitest';
import { InterestsSkill, formatTopicBriefing } from './interests.js';
import type { InterestsRepository, InterestTopic, TopicItem } from '@alfred/storage';
import type { SkillContext } from '@alfred/types';

const CTX = { userId: 'u1', masterUserId: 'u1', platform: 'api', chatId: 'c1' } as unknown as SkillContext;

const TOPIC: InterestTopic = {
  id: 't1', userId: 'u1', name: 'Claude Fable',
  keywords: ['claude', 'fable'], status: 'active', origin: 'manual',
  notifyThreshold: 'high', createdAt: '2026-07-01T00:00:00Z',
};

const ITEMS: TopicItem[] = [
  { id: 'i1', topicId: 't1', title: 'Fable 5 Release', url: 'https://ex.at/a', sourceKind: 'rss', publishedAt: '2026-07-01T08:00:00Z', createdAt: '2026-07-01T09:00:00Z' },
  { id: 'i2', topicId: 't1', title: 'Benchmark-Vergleich', sourceKind: 'web_search', createdAt: '2026-07-02T09:00:00Z' },
];

function makeRepo(overrides: Partial<Record<keyof InterestsRepository, any>> = {}): InterestsRepository {
  return {
    createTopic: vi.fn(async (_u: string, o: any) => ({ ...TOPIC, name: o.name, keywords: o.keywords ?? [] })),
    listTopics: vi.fn(async () => [TOPIC]),
    getTopicById: vi.fn(async () => TOPIC),
    findTopicByName: vi.fn(async (_u: string, q: string) => q.toLowerCase().includes('fable') ? TOPIC : null),
    findTopicByNameExact: vi.fn(async (_u: string, q: string) => q.toLowerCase().trim() === 'claude fable' ? TOPIC : null),
    updateTopic: vi.fn(async () => {}),
    touchActivity: vi.fn(async () => {}),
    listAllActiveTopics: vi.fn(async () => [TOPIC]),
    addSource: vi.fn(async (topicId: string, o: any) => ({ id: 'src-1', topicId, ...o, enabled: true, createdAt: 'x' })),
    listSources: vi.fn(async () => []),
    removeSource: vi.fn(async () => true),
    setSourceEnabled: vi.fn(async () => {}),
    markSourceChecked: vi.fn(async () => {}),
    insertItem: vi.fn(async () => ({ inserted: true, id: 'i' })),
    listItems: vi.fn(async () => ITEMS),
    countItemsSince: vi.fn(async () => 0),
    getDigest: vi.fn(async () => ({ topicId: 't1', summary: 'Fable 5 ist erschienen und schlägt Benchmarks.', itemsSinceUpdate: 0, updatedAt: '2026-07-02T06:00:00Z' })),
    upsertDigest: vi.fn(async () => {}),
    ...overrides,
  } as unknown as InterestsRepository;
}

describe('formatTopicBriefing', () => {
  it('Dossier + Items + Stand', () => {
    const out = formatTopicBriefing(TOPIC, { summary: 'Zusammenfassung.', updatedAt: '2026-07-02T06:00:00Z' }, ITEMS);
    expect(out).toContain('📡 **Claude Fable**');
    expect(out).toContain('Stichwörter: claude, fable');
    expect(out).toContain('Zusammenfassung.');
    expect(out).toContain('Dossier-Stand: 2026-07-02 06:00');
    expect(out).toContain('Neueste Beiträge (2)');
    expect(out).toContain('Fable 5 Release');
    expect(out).toContain('https://ex.at/a');
  });

  it('ohne Dossier und ohne Items → Hinweis', () => {
    const out = formatTopicBriefing(TOPIC, null, []);
    expect(out).toContain('Noch keine gesammelten Beiträge');
  });
});

describe('InterestsSkill', () => {
  it('create_topic legt an; existierendes Thema wird nicht dupliziert', async () => {
    const repo = makeRepo({ findTopicByNameExact: vi.fn(async () => null) });
    const skill = new InterestsSkill(repo);
    const r = await skill.execute({ action: 'create_topic', name: 'HW-Verkauf', keywords: ['gpu'] }, CTX);
    expect(r.success).toBe(true);
    expect((repo.createTopic as any).mock.calls[0][1]).toEqual({ name: 'HW-Verkauf', keywords: ['gpu'] });

    const repo2 = makeRepo(); // exakter Name existiert
    const skill2 = new InterestsSkill(repo2);
    const r2 = await skill2.execute({ action: 'create_topic', name: 'Claude Fable' }, CTX);
    expect(r2.success).toBe(true);
    expect((r2.data as any).existed).toBe(true);
    expect(repo2.createTopic).not.toHaveBeenCalled();
  });

  it('v952: Keyword-Kollision blockiert das Anlegen NICHT mehr (Realfall Panini)', async () => {
    // Fuzzy findet ein fremdes Topic (Keyword „Panini" in FussballCC News) —
    // der Duplikat-Check muss trotzdem EXAKT prüfen und anlegen
    const repo = makeRepo({
      findTopicByName: vi.fn(async () => TOPIC),          // fuzzy: Treffer (falsch für create)
      findTopicByNameExact: vi.fn(async () => null),      // exakt: existiert nicht
    });
    const skill = new InterestsSkill(repo);
    const r = await skill.execute({ action: 'create_topic', name: 'Panini-Sammelalbum WM 2026', keywords: ['panini', 'sticker'] }, CTX);
    expect(r.success).toBe(true);
    expect((r.data as any).existed).toBeUndefined();
    expect(repo.createTopic).toHaveBeenCalledTimes(1);
  });

  it('add_source validiert kind/url/query', async () => {
    const repo = makeRepo();
    const skill = new InterestsSkill(repo);
    const bad = await skill.execute({ action: 'add_source', topic: 'fable', kind: 'rss' }, CTX);
    expect(bad.success).toBe(false);
    const ok = await skill.execute({ action: 'add_source', topic: 'fable', kind: 'rss', url: 'https://ex.at/feed' }, CTX);
    expect(ok.success).toBe(true);
    expect((repo.addSource as any).mock.calls[0][1]).toEqual({ kind: 'rss', config: { url: 'https://ex.at/feed' }, addedBy: 'manual' });
  });

  it('topic_briefing liefert Dossier + Items (ohne LLM kein Refresh)', async () => {
    const repo = makeRepo();
    const skill = new InterestsSkill(repo);
    const r = await skill.execute({ action: 'topic_briefing', topic: 'fable' }, CTX);
    expect(r.success).toBe(true);
    expect(r.display).toContain('Fable 5 ist erschienen');
    expect(r.display).toContain('Neueste Beiträge');
  });

  it('topic_briefing: unbekanntes Thema → Fehler mit vorhandenen Themen', async () => {
    const repo = makeRepo({ findTopicByName: vi.fn(async () => null) });
    const skill = new InterestsSkill(repo);
    const r = await skill.execute({ action: 'topic_briefing', topic: 'Bitcoin' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('Claude Fable');
  });

  it('topic_briefing: neue Items + LLM → Dossier-Refresh (upsertDigest)', async () => {
    const repo = makeRepo({ countItemsSince: vi.fn(async () => 2) });
    const llm = { complete: vi.fn(async () => ({ content: 'Neues Dossier mit frischen Erkenntnissen zum Thema.' })) } as any;
    const skill = new InterestsSkill(repo, llm);
    const r = await skill.execute({ action: 'topic_briefing', topic: 'fable' }, CTX);
    expect(r.success).toBe(true);
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(repo.upsertDigest).toHaveBeenCalledWith('t1', 'Neues Dossier mit frischen Erkenntnissen zum Thema.');
    expect(r.display).toContain('Neues Dossier');
  });

  it('collect_now nutzt den injizierten Collector', async () => {
    const skill = new InterestsSkill(makeRepo());
    const noCollector = await skill.execute({ action: 'collect_now' }, CTX);
    expect(noCollector.success).toBe(false);

    skill.setCollector(vi.fn(async () => 7));
    const r = await skill.execute({ action: 'collect_now' }, CTX);
    expect(r.success).toBe(true);
    expect((r.data as any).newItems).toBe(7);
  });

  it('set_status ändert den Themen-Status', async () => {
    const repo = makeRepo();
    const skill = new InterestsSkill(repo);
    const r = await skill.execute({ action: 'set_status', topic: 'fable', status: 'paused' }, CTX);
    expect(r.success).toBe(true);
    expect(repo.updateTopic).toHaveBeenCalledWith('u1', 't1', { status: 'paused' });
  });
});
