import { describe, expect, it } from 'vitest';
import { ItsmRepository } from './itsm-repository.js';

// v1729 — Kurz-ID bei Changes (Realfall 01.11.: Entwurf 4bc22637 lesbar, Schreibaktionen meldeten „nicht gefunden“)
const zeile = (id: string) => ({ id, user_id: 'u', title: 'T', type: 'normal', status: 'draft', risk_level: 'low', created_at: 'x', updated_at: 'x' });

function repo(ids: string[]) {
  const db = {
    queryOne: async (_sql: string, p: unknown[]) => { const z = ids.find(i => i === p[0]); return z ? zeile(z) : undefined; },
    query: async (_sql: string, p: unknown[]) => ids.filter(i => i.startsWith(String(p[0]).replace(/%$/, ''))).slice(0, 2).map(zeile),
    execute: async () => ({ changes: 1 }),
  };
  return new ItsmRepository(db as never);
}

describe('getChangeRequestById — Kurz-ID', () => {
  const voll = '4bc22637-95c5-42ef-97ab-0ef3f09aef8e';
  it('findet exakt und per eindeutiger Kurz-ID', async () => {
    const r = repo([voll, '29b8e3f0-0000-4000-8000-000000000000']);
    expect((await r.getChangeRequestById('u', voll))?.id).toBe(voll);
    expect((await r.getChangeRequestById('u', '4bc22637'))?.id).toBe(voll);
    expect((await r.getChangeRequestById('u', '4BC22637'))?.id).toBe(voll);
  });
  it('nicht bei zu kurzer, mehrdeutiger oder fremder Eingabe', async () => {
    const r = repo([voll, '4bc22637-ffff-4000-8000-000000000000']);
    expect(await r.getChangeRequestById('u', '4bc22637')).toBeNull();
    expect(await r.getChangeRequestById('u', '4bc2')).toBeNull();
    expect(await r.getChangeRequestById('u', "4bc226' OR")).toBeNull();
  });
});
