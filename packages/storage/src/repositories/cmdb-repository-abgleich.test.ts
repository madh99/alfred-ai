import { describe, expect, it } from 'vitest';
import { CmdbRepository } from './cmdb-repository.js';

describe('v1715 — Quellen-Abgleich leert gepflegte Felder nicht', () => {
  it('Zweck, Notizen, Besitzer, Ort, Tags, FQDN und Umgebung bleiben, wenn die Quelle sie nicht liefert', async () => {
    const sql: string[] = [];
    const db = {
      queryOne: async (q: string) => (q.startsWith('SELECT id FROM cmdb_assets') ? { id: 'a1' } : null),
      execute: async (q: string) => { sql.push(q); return { changes: 1 }; },
      query: async () => [],
    };
    await new CmdbRepository(db as never).upsertAsset('u', { name: 'pg-repo-01', assetType: 'vm', sourceSkill: 'proxmox', sourceId: 'pve3:150' });
    const u = sql.find(q => q.includes('UPDATE cmdb_assets'))!;
    for (const f of ['purpose', 'notes', 'owner', 'location', 'tags', 'fqdn', 'environment']) expect(u).toContain(`COALESCE(?, ${f})`);
  });
});
