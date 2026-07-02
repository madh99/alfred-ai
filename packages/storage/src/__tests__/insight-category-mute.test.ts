import { describe, it, expect } from 'vitest';
import { InsightsRepository } from '../repositories/insights-repository.js';
import type { AsyncDbAdapter, DbRow } from '../db-adapter.js';

/**
 * v928 — Kategorie-Mute: läuft mit In-Memory-Stub-Adapter (kein better-sqlite3
 * nötig, damit der Test auch auf Windows-Dev läuft). Der Stub versteht genau
 * die SQL-Muster, die InsightsRepository für Prefs + upsertCandidate nutzt.
 */
function makeStubAdapter() {
  const prefs = new Map<string, { muted: number; updated_at: string }>();
  const inserts: Array<{ sql: string; params: unknown[] }> = [];

  const adapter: AsyncDbAdapter = {
    type: 'sqlite',
    async query(sql: string, params: unknown[] = []): Promise<DbRow[]> {
      if (sql.includes('FROM insight_category_prefs') && sql.includes('muted = 1')) {
        const userId = params[0] as string;
        return [...prefs.entries()]
          .filter(([k, v]) => k.startsWith(`${userId}::`) && v.muted === 1)
          .map(([k]) => ({ category: k.split('::')[1] }));
      }
      return [];
    },
    async queryOne(sql: string, params: unknown[] = []): Promise<DbRow | undefined> {
      if (sql.includes('FROM insight_category_prefs')) {
        const row = prefs.get(`${params[0]}::${params[1]}`);
        return row ? { muted: row.muted } : undefined;
      }
      if (sql.includes('FROM alfred_insights')) return undefined; // kein Dedup-Treffer
      return undefined;
    },
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('INSERT INTO insight_category_prefs')) {
        prefs.set(`${params[0]}::${params[1]}`, { muted: params[2] as number, updated_at: String(params[3]) });
        return { changes: 1 };
      }
      if (sql.startsWith('UPDATE insight_category_prefs')) {
        const key = `${params[2]}::${params[3]}`;
        const row = prefs.get(key);
        if (row) { row.muted = params[0] as number; row.updated_at = String(params[1]); }
        return { changes: row ? 1 : 0 };
      }
      if (sql.startsWith('INSERT INTO alfred_insights')) {
        inserts.push({ sql, params });
        return { changes: 1 };
      }
      return { changes: 0 };
    },
    async exec() { /* noop */ },
    async transaction<T>(fn: (tx: AsyncDbAdapter) => Promise<T>): Promise<T> { return fn(adapter); },
    async close() { /* noop */ },
  };

  return { adapter, inserts };
}

const USER = 'user-1';

describe('InsightsRepository — Kategorie-Mute (v928)', () => {
  it('setCategoryMuted + isCategoryMuted + listMutedCategories', async () => {
    const { adapter } = makeStubAdapter();
    const repo = new InsightsRepository(adapter);

    expect(await repo.isCategoryMuted(USER, 'kg-gap')).toBe(false);
    await repo.setCategoryMuted(USER, 'kg-gap', true);
    expect(await repo.isCategoryMuted(USER, 'kg-gap')).toBe(true);
    expect(await repo.listMutedCategories(USER)).toEqual(['kg-gap']);

    // Unmute (UPDATE-Pfad)
    await repo.setCategoryMuted(USER, 'kg-gap', false);
    expect(await repo.isCategoryMuted(USER, 'kg-gap')).toBe(false);
    expect(await repo.listMutedCategories(USER)).toEqual([]);
  });

  it('upsertCandidate legt für gemutete Kategorie NICHTS an', async () => {
    const { adapter, inserts } = makeStubAdapter();
    const repo = new InsightsRepository(adapter);
    await repo.setCategoryMuted(USER, 'kg-gap', true);

    const r = await repo.upsertCandidate(USER, {
      category: 'kg-gap', title: 'Geburtstag fehlt', body: 'x',
    });
    expect(r.inserted).toBe(false);
    expect(r.muted).toBe(true);
    expect(inserts.length).toBe(0);
  });

  it('andere Kategorien bleiben unbeeinflusst', async () => {
    const { adapter, inserts } = makeStubAdapter();
    const repo = new InsightsRepository(adapter);
    await repo.setCategoryMuted(USER, 'kg-gap', true);

    const r = await repo.upsertCandidate(USER, {
      category: 'reasoning', title: 'Beobachtung', body: 'y',
    });
    expect(r.inserted).toBe(true);
    expect(inserts.length).toBe(1);
  });

  it('Mute gilt pro User', async () => {
    const { adapter, inserts } = makeStubAdapter();
    const repo = new InsightsRepository(adapter);
    await repo.setCategoryMuted(USER, 'kg-gap', true);

    const r = await repo.upsertCandidate('user-2', {
      category: 'kg-gap', title: 'Geburtstag fehlt', body: 'x',
    });
    expect(r.inserted).toBe(true);
    expect(inserts.length).toBe(1);
  });
});
