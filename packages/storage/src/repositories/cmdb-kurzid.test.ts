import { describe, expect, it } from 'vitest';
import { CmdbRepository } from './cmdb-repository.js';

// v1730 — Kurz-ID bei CMDB-Assets (Mangel seit 24.10.: update_asset verlangte volle IDs)
const voll = '9d72cbb0-1111-4000-8000-000000000000';
const zeile = (id: string) => ({ id, user_id: 'u', asset_type: 'server', name: 'n', status: 'active', attributes: '{}', created_at: 'x', updated_at: 'x' });

function repo(ids: string[]) {
  const ausgefuehrt: unknown[][] = [];
  const db = {
    queryOne: async (_sql: string, p: unknown[]) => { const z = ids.find(i => i === p[0]); return z ? zeile(z) : undefined; },
    query: async (_sql: string, p: unknown[]) => ids.filter(i => i.startsWith(String(p[0]).replace(/%$/, ''))).slice(0, 2).map(zeile),
    execute: async (_sql: string, p: unknown[]) => { ausgefuehrt.push(p); return { changes: 1 }; },
  };
  return { r: new CmdbRepository(db as never), ausgefuehrt };
}

describe('CMDB-Assets — Kurz-ID', () => {
  it('findet und ändert per eindeutiger Kurz-ID mit der vollen ID', async () => {
    const { r, ausgefuehrt } = repo([voll, 'aaaaaaaa-0000-4000-8000-000000000000']);
    expect((await r.getAssetById('u', '9d72cbb0'))?.id).toBe(voll);
    await r.updateAsset('u', '9d72cbb0', { purpose: 'Test' });
    expect(ausgefuehrt[0]).toContain(voll);
    expect(ausgefuehrt[0]).not.toContain('9d72cbb0');
  });
  it('mehrdeutig oder zu kurz: nicht gefunden', async () => {
    const { r } = repo([voll, '9d72cbb0-2222-4000-8000-000000000000']);
    expect(await r.getAssetById('u', '9d72cbb0')).toBeNull();
    expect(await r.getAssetById('u', '9d72')).toBeNull();
  });
});
