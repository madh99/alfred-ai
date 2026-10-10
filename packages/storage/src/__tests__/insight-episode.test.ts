import { describe, it, expect } from 'vitest';
import { InsightsRepository, istNeueEpisode, EPISODE_TAGE } from '../repositories/insights-repository.js';
import type { AsyncDbAdapter, DbRow } from '../db-adapter.js';

const TAG = 86_400_000;
const jetzt = Date.parse('2026-10-10T18:00:00Z');
const vor = (tage: number) => new Date(jetzt - tage * TAG).toISOString();

describe('v1343 — Episoden statt dauerhafter Blockade', () => {
  it('erledigt und abgelaufen kommen nach EPISODE_TAGE wieder, vorher nicht', () => {
    expect(istNeueEpisode({ status: 'acted', acted_at: vor(EPISODE_TAGE + 1), updated_at: vor(EPISODE_TAGE + 1) }, jetzt)).toBe(true);
    expect(istNeueEpisode({ status: 'acted', acted_at: vor(2), updated_at: vor(2) }, jetzt)).toBe(false);
    expect(istNeueEpisode({ status: 'expired', updated_at: vor(EPISODE_TAGE) }, jetzt)).toBe(true);
    expect(istNeueEpisode({ status: 'expired', updated_at: vor(1) }, jetzt)).toBe(false);
  });
  it('verworfen, offen und später bleiben, wie sie sind', () => {
    expect(istNeueEpisode({ status: 'dismissed', updated_at: vor(100) }, jetzt)).toBe(false);
    expect(istNeueEpisode({ status: 'pending', updated_at: vor(100) }, jetzt)).toBe(false);
    expect(istNeueEpisode({ status: 'snoozed', updated_at: vor(100) }, jetzt)).toBe(false);
    expect(istNeueEpisode({ status: 'acted', updated_at: 'kaputt' }, jetzt)).toBe(false);
  });
  it('upsertCandidate öffnet eine alte erledigte Meldung als neue Episode (pending, neues created_at)', async () => {
    const ausgefuehrt: Array<{ sql: string; params: unknown[] }> = [];
    const alt = new Date(Date.now() - (EPISODE_TAGE + 2) * TAG).toISOString();
    const adapter: AsyncDbAdapter = {
      type: 'sqlite',
      async query(): Promise<DbRow[]> { return []; },
      async queryOne(sql: string): Promise<DbRow | undefined> {
        if (sql.includes('FROM insight_category_prefs')) return undefined;
        if (sql.includes('FROM alfred_insights')) return { id: 'i1', status: 'acted', updated_at: alt, acted_at: alt };
        return undefined;
      },
      async execute(sql: string, params: unknown[] = []) { ausgefuehrt.push({ sql, params }); return { changes: 1 }; },
    } as unknown as AsyncDbAdapter;
    const repo = new InsightsRepository(adapter);
    const r = await repo.upsertCandidate('u1', { category: 'reasoning', title: 'Wallbox nicht erreichbar', body: 'neu', dedupeKey: 'wallbox' });
    expect(r).toEqual({ inserted: true, id: 'i1' });
    const upd = ausgefuehrt.find(e => e.sql.startsWith('UPDATE alfred_insights'));
    expect(upd?.sql).toContain("status = 'pending'");
    expect(upd?.sql).toContain('created_at = ?');
  });
  it('upsertCandidate lässt eine frisch erledigte Meldung blockiert', async () => {
    const ausgefuehrt: string[] = [];
    const frisch = new Date(Date.now() - TAG).toISOString();
    const adapter = {
      type: 'sqlite',
      async query() { return []; },
      async queryOne(sql: string) { return sql.includes('FROM alfred_insights') ? { id: 'i2', status: 'acted', updated_at: frisch, acted_at: frisch } : undefined; },
      async execute(sql: string) { ausgefuehrt.push(sql); return { changes: 1 }; },
    } as unknown as AsyncDbAdapter;
    const r = await new InsightsRepository(adapter).upsertCandidate('u1', { category: 'reasoning', title: 't', body: 'b', dedupeKey: 'k' });
    expect(r).toEqual({ inserted: false, id: 'i2' });
    expect(ausgefuehrt.some(s => s.startsWith('UPDATE') || s.startsWith('INSERT INTO alfred_insights'))).toBe(false);
  });
});
