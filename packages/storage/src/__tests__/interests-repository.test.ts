import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { Database } from '../database.js';
import { topicItemDedupeHash } from '../repositories/interests-repository.js';

let hasBetterSqlite3 = true;
try {
  const BetterSqlite3 = (await import('better-sqlite3')).default;
  const testDb = new BetterSqlite3(':memory:');
  testDb.close();
} catch {
  hasBetterSqlite3 = false;
}

// Pure Hash-Funktion — läuft immer (auch ohne better-sqlite3 / Windows-Dev)
describe('topicItemDedupeHash', () => {
  it('gleiche URL (mit Query/Trailing-Slash-Varianten) → gleicher Hash', () => {
    const a = topicItemDedupeHash({ url: 'https://ex.at/artikel?utm=x', title: 'A' });
    const b = topicItemDedupeHash({ url: 'https://ex.at/artikel/', title: 'B ganz anders' });
    expect(a).toBe(b);
  });

  it('ohne URL: normalisierter Titel entscheidet', () => {
    const a = topicItemDedupeHash({ title: 'Claude Fable 5: Release!' });
    const b = topicItemDedupeHash({ title: 'claude fable 5   release' });
    expect(a).toBe(b);
    const c = topicItemDedupeHash({ title: 'Ein anderer Artikel' });
    expect(a).not.toBe(c);
  });
});

describe.skipIf(!hasBetterSqlite3)('InterestsRepository (v929)', () => {
  let dbPath: string;
  let db: Database;

  afterEach(async () => {
    try { await db?.close(); } catch { /* ignore */ }
    if (dbPath && fs.existsSync(dbPath)) {
      try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
    }
  });

  async function setup() {
    const { Database } = await import('../database.js');
    const { InterestsRepository } = await import('../repositories/interests-repository.js');
    dbPath = path.join(os.tmpdir(), `alfred-test-interests-${Date.now()}.db`);
    db = Database.createSync(dbPath);
    return new InterestsRepository(db.getAdapter());
  }

  const USER = 'user-1';

  it('Topic-CRUD: create, list, find (fuzzy), update, status', async () => {
    const repo = await setup();
    const topic = await repo.createTopic(USER, { name: 'Claude Fable', keywords: ['claude', 'fable', 'anthropic'] });
    expect(topic.status).toBe('active');
    expect(topic.origin).toBe('manual');

    const listed = await repo.listTopics(USER);
    expect(listed.length).toBe(1);
    expect(listed[0].keywords).toEqual(['claude', 'fable', 'anthropic']);

    // Fuzzy: exakt, enthält, Keyword
    expect((await repo.findTopicByName(USER, 'claude fable'))?.id).toBe(topic.id);
    expect((await repo.findTopicByName(USER, 'Fable'))?.id).toBe(topic.id);
    expect((await repo.findTopicByName(USER, 'was gibts zu anthropic'))?.id).toBe(topic.id);
    expect(await repo.findTopicByName(USER, 'Bitcoin')).toBeNull();

    await repo.updateTopic(USER, topic.id, { status: 'paused', notifyThreshold: 'normal' });
    const updated = await repo.getTopicById(USER, topic.id);
    expect(updated?.status).toBe('paused');
    expect(updated?.notifyThreshold).toBe('normal');

    // paused → nicht in listAllActiveTopics
    expect((await repo.listAllActiveTopics()).length).toBe(0);

    // fremder User sieht nichts
    expect((await repo.listTopics('user-2')).length).toBe(0);
  });

  it('Sources: add, list, remove, enabled-Filter', async () => {
    const repo = await setup();
    const topic = await repo.createTopic(USER, { name: 'Hardware-Verkauf' });
    const s1 = await repo.addSource(topic.id, { kind: 'rss', config: { url: 'https://ex.at/feed.xml' } });
    const s2 = await repo.addSource(topic.id, { kind: 'web_search', config: { query: 'gpu gebraucht verkaufen' }, addedBy: 'auto' });

    expect((await repo.listSources(topic.id)).length).toBe(2);
    await repo.setSourceEnabled(s2.id, false);
    const enabled = await repo.listSources(topic.id, true);
    expect(enabled.length).toBe(1);
    expect(enabled[0].id).toBe(s1.id);

    expect(await repo.removeSource(topic.id, s1.id)).toBe(true);
    expect((await repo.listSources(topic.id)).length).toBe(1);
  });

  it('Items: insert dedupliziert per URL/Titel-Hash', async () => {
    const repo = await setup();
    const topic = await repo.createTopic(USER, { name: 'KI' });

    const r1 = await repo.insertItem(topic.id, { title: 'Fable 5 Release', url: 'https://ex.at/fable', sourceKind: 'rss' });
    expect(r1.inserted).toBe(true);
    // gleiche URL → Duplikat
    const r2 = await repo.insertItem(topic.id, { title: 'Anderer Titel', url: 'https://ex.at/fable?utm=x', sourceKind: 'web_search' });
    expect(r2.inserted).toBe(false);
    expect(r2.id).toBe(r1.id);
    // neue URL → neu
    const r3 = await repo.insertItem(topic.id, { title: 'Fable 5 Benchmark', url: 'https://ex.at/bench', sourceKind: 'rss' });
    expect(r3.inserted).toBe(true);

    const items = await repo.listItems(topic.id);
    expect(items.length).toBe(2);
    expect(await repo.countItemsSince(topic.id, '2000-01-01T00:00:00Z')).toBe(2);
  });

  it('Digest: upsert setzt items_since_update zurück, get liefert Stand', async () => {
    const repo = await setup();
    const topic = await repo.createTopic(USER, { name: 'KI' });
    expect(await repo.getDigest(topic.id)).toBeNull();

    await repo.upsertDigest(topic.id, 'Erstes Dossier.');
    const d1 = await repo.getDigest(topic.id);
    expect(d1?.summary).toBe('Erstes Dossier.');
    expect(d1?.itemsSinceUpdate).toBe(0);

    await repo.upsertDigest(topic.id, 'Aktualisiertes Dossier.');
    expect((await repo.getDigest(topic.id))?.summary).toBe('Aktualisiertes Dossier.');
  });
});
