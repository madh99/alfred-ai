import { describe, expect, it } from 'vitest';
import { CmdbRepository } from './cmdb-repository.js';

// Betriebs-Instanz: eindeutige Auflösung von Assets (Name ohne Groß/Klein) und Dokumenten (ID-Anfang) in der Datenbank
function repo(rows: Record<string, unknown>[]) {
  const aufrufe: Array<{ sql: string; p: unknown[] }> = [];
  const db = { query: async (sql: string, p: unknown[]) => { aufrufe.push({ sql, p }); return rows; }, queryOne: async () => undefined, execute: async () => ({ changes: 0 }) };
  return { r: new CmdbRepository(db as never), aufrufe };
}
const asset = (id: string, name: string, status = 'active') => ({ id, user_id: 'u', asset_type: 'vm', name, status, attributes: '{}', created_at: 'x', updated_at: 'x' });
const dok = (id: string) => ({ id, user_id: 'u', doc_type: 'inventory', title: 't', content: 'c', format: 'markdown', version: 1, created_at: 'x' });

describe('CmdbRepository — eindeutige Auflösung', () => {
  it('findAssetsByNameAll: Namensvergleich ohne Groß/Klein, je Benutzer, liefert alle Treffer', async () => {
    const { r, aufrufe } = repo([asset('a1', 'PKIISS01'), asset('a2', 'pkiiss01', 'decommissioned')]);
    const l = await r.findAssetsByNameAll('u', 'pkiiss01');
    expect(l.map(a => a.id)).toEqual(['a1', 'a2']);
    expect(aufrufe[0]!.sql).toMatch(/LOWER\(name\) = LOWER\(\?\)/);
    expect(aufrufe[0]!.sql).toMatch(/user_id = \?/);
    expect(aufrufe[0]!.p).toEqual(['u', 'pkiiss01']);
  });

  it('findDocumentsByIdPrefix: LIKE auf den ID-Anfang, je Benutzer, höchstens 2, ungültiger Anfang ergibt []', async () => {
    const { r, aufrufe } = repo([dok('d0c0d0c0-1'), dok('d0c0d0c0-2')]);
    expect((await r.findDocumentsByIdPrefix('u', 'd0c0d0')).map(d => d.id)).toEqual(['d0c0d0c0-1', 'd0c0d0c0-2']);
    expect(aufrufe[0]!.sql).toMatch(/user_id = \? AND id LIKE \? LIMIT 2/);
    expect(aufrufe[0]!.p).toEqual(['u', 'd0c0d0%']);
    // ungültige Anfänge: leere Liste, ohne Datenbankzugriff, nichts wird bereinigt
    for (const x of ['%%%%%%', 'abc', 'ab%_cd1', 'ABCDEF%', '', 'g'.repeat(8), 'a'.repeat(37)]) expect(await r.findDocumentsByIdPrefix('u', x)).toEqual([]);
    expect(aufrufe).toHaveLength(1);
  });
});
