import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { Database } from '../database.js';
import { isValidTransition } from '../repositories/social-repository.js';

let hasBetterSqlite3 = true;
try {
  const BetterSqlite3 = (await import('better-sqlite3')).default;
  const testDb = new BetterSqlite3(':memory:');
  testDb.close();
} catch {
  hasBetterSqlite3 = false;
}

// Pipeline-Regeln — pure, läuft auch auf Windows-Dev
describe('isValidTransition (Content-Pipeline v933)', () => {
  it('erlaubt den Happy-Path idea→draft→scheduled→approved→publishing→published', () => {
    expect(isValidTransition('idea', 'draft')).toBe(true);
    expect(isValidTransition('draft', 'scheduled')).toBe(true);
    expect(isValidTransition('scheduled', 'approved')).toBe(true);
    expect(isValidTransition('approved', 'publishing')).toBe(true);
    expect(isValidTransition('publishing', 'published')).toBe(true);
  });

  it('published ist final; failed kann erneut versucht werden', () => {
    expect(isValidTransition('published', 'draft')).toBe(false);
    expect(isValidTransition('published', 'rejected')).toBe(false);
    expect(isValidTransition('failed', 'publishing')).toBe(true);
    expect(isValidTransition('failed', 'approved')).toBe(true);
  });

  it('verbietet Sprünge (idea→published, draft→publishing)', () => {
    expect(isValidTransition('idea', 'published')).toBe(false);
    expect(isValidTransition('draft', 'publishing')).toBe(false);
    expect(isValidTransition('rejected', 'published')).toBe(false);
  });
});

describe.skipIf(!hasBetterSqlite3)('SocialRepository (v933)', () => {
  let dbPath: string;
  let db: Database;

  afterEach(async () => {
    try { await db?.close(); } catch { /* ignore */ }
    if (dbPath && fs.existsSync(dbPath)) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
      }
    }
  });

  async function setup() {
    const { Database } = await import('../database.js');
    const { SocialRepository } = await import('../repositories/social-repository.js');
    dbPath = path.join(os.tmpdir(), `alfred-test-social-${Date.now()}.db`);
    db = Database.createSync(dbPath);
    return new SocialRepository(db.getAdapter());
  }

  const USER = 'user-1';

  it('Channel-CRUD inkl. fuzzy find, update und pauseAll', async () => {
    const repo = await setup();
    const c = await repo.createChannel(USER, {
      platform: 'telegram_channel', name: 'FussballCC News', handle: '@fussballcc',
      config: { chat_id: '@fussballcc' },
    });
    expect(c.mode).toBe('suggest');
    expect(c.publishMode).toBe('prepare');
    expect(c.maxPostsPerDay).toBe(3);
    expect(c.approvedStreak).toBe(0);

    expect((await repo.findChannelByName(USER, 'fussballcc news'))?.id).toBe(c.id);
    expect((await repo.findChannelByName(USER, '@fussballcc'))?.id).toBe(c.id);
    expect(await repo.findChannelByName(USER, 'gibtsnicht')).toBeNull();

    await repo.updateChannel(USER, c.id, { mode: 'approve', blacklist: ['politik'], approvedStreak: 2 });
    const updated = await repo.getChannel(USER, c.id);
    expect(updated?.mode).toBe('approve');
    expect(updated?.blacklist).toEqual(['politik']);
    expect(updated?.approvedStreak).toBe(2);

    expect(await repo.pauseAll(USER)).toBe(1);
    expect((await repo.getChannel(USER, c.id))?.status).toBe('paused');
    expect((await repo.listChannels('user-2')).length).toBe(0);
  });

  it('Content-Pipeline: Übergänge validiert, ungültige werfen', async () => {
    const repo = await setup();
    const c = await repo.createChannel(USER, { platform: 'rest', name: 'Blog' });
    const item = await repo.createItem(USER, c.id, { body: 'Erster Post', hashtags: ['fussball'] });
    expect(item.status).toBe('draft');

    const scheduled = await repo.transition(USER, item.id, 'scheduled', { scheduledAt: '2026-07-04T18:00:00Z' });
    expect(scheduled.scheduledAt).toBe('2026-07-04T18:00:00Z');
    const approved = await repo.transition(USER, item.id, 'approved');
    expect(approved.status).toBe('approved');
    await repo.transition(USER, item.id, 'publishing');
    const published = await repo.transition(USER, item.id, 'published', {
      publishedAt: '2026-07-04T18:00:05Z', externalId: '42', externalUrl: 'https://t.me/x/42',
    });
    expect(published.externalId).toBe('42');

    await expect(repo.transition(USER, item.id, 'draft')).rejects.toThrow(/Ungültiger Status-Übergang/);
  });

  it('countPublishedToday zählt nur published des Tages/Kanals', async () => {
    const repo = await setup();
    const c = await repo.createChannel(USER, { platform: 'rest', name: 'Blog' });
    const today = new Date().toISOString();
    for (let i = 0; i < 2; i++) {
      const item = await repo.createItem(USER, c.id, { body: `Post ${i}` });
      await repo.transition(USER, item.id, 'approved');
      await repo.transition(USER, item.id, 'published', { publishedAt: today });
    }
    const draft = await repo.createItem(USER, c.id, { body: 'Entwurf' });
    expect(draft.status).toBe('draft');
    expect(await repo.countPublishedToday(c.id)).toBe(2);
  });

  it('Metrics: upsert dedupliziert (auch Kanal-Ebene ohne item_id)', async () => {
    const repo = await setup();
    const c = await repo.createChannel(USER, { platform: 'rest', name: 'Blog' });
    await repo.upsertMetric(c.id, { date: '2026-07-03', kind: 'followers', value: 100 });
    await repo.upsertMetric(c.id, { date: '2026-07-03', kind: 'followers', value: 105 });
    const metrics = await repo.listMetrics(c.id);
    expect(metrics.length).toBe(1);
    expect(metrics[0].value).toBe(105);
  });
});
