import { describe, expect, it } from 'vitest';
import { BauplanVorlageRepository } from './bauplan-vorlage-repository.js';
import { BauplanInstanzRepository } from './bauplan-instanz-repository.js';

// Fake-DB: hält Zeilen im Speicher und versteht genau die vom Repository benutzten Anweisungen.
function fakeDb() {
  const vorlagen: Record<string, unknown>[] = [];
  const instanzen: Record<string, unknown>[] = [];
  const updates: Array<{ sql: string; p: unknown[] }> = [];
  const db = {
    queryOne: async (sql: string, p: unknown[]) => {
      if (sql.includes('MAX(version)')) {
        const v = vorlagen.filter(r => r.user_id === p[0] && r.key === p[1]).map(r => r.version as number);
        return { v: v.length ? Math.max(...v) : null };
      }
      if (sql.includes('infra_bauplan_vorlagen')) {
        const t = vorlagen.filter(r => r.user_id === p[0] && r.key === p[1] && (p.length < 3 || r.version === p[2]));
        return t.sort((a, b) => (b.version as number) - (a.version as number))[0];
      }
      if (sql.includes('LIKE')) {
        const like = String(p[1]).replace(/%/g, '');
        return instanzen.filter(r => r.user_id === p[0] && String(r.change_ids).includes(like)).reverse()[0];
      }
      return undefined;
    },
    query: async (sql: string, p: unknown[]) => {
      if (sql.includes('LIKE')) {
        const like = String(p[1]).replace(/%/g, '');
        return instanzen.filter(r => r.user_id === p[0] && String(r.change_ids).includes(like)).reverse();
      }
      return vorlagen.filter(r => r.user_id === p[0]).sort((a, b) => String(a.key).localeCompare(String(b.key)) || (a.version as number) - (b.version as number));
    },
    execute: async (sql: string, p: unknown[]) => {
      if (sql.startsWith('INSERT INTO infra_bauplan_vorlagen')) {
        // Spalten in der Reihenfolge des INSERT (Final-Welle V4: ableitung hinter abgeleitet_aus)
        const spalten = /\(([^)]*)\)/.exec(sql)![1]!.split(',').map(s => s.trim());
        const r: Record<string, unknown> = { status: 'entwurf' };
        let i = 0;
        for (const s of spalten) if (s !== 'status') r[s] = p[i++];
        vorlagen.push(r);
      } else if (sql.includes('INSERT INTO infra_bauplan_instanzen')) {
        instanzen.push({ id: p[0], user_id: p[1], name: p[2], dokumentart: p[3], change_ids: p[4], parameter: p[5], vorlage_key: p[6], vorlage_version: p[7], status: 'aktiv', created_at: p[8] });
      } else updates.push({ sql, p });
      return { changes: 1 };
    },
  };
  return { db, updates, instanzen };
}

describe('BauplanVorlageRepository', () => {
  it('speichere vergibt aufsteigende Versionen, Status entwurf', async () => {
    const { db } = fakeDb();
    const r = new BauplanVorlageRepository(db as never);
    const a = await r.speichere('u', { key: 'k', json: '{}', abdruck: 'x' });
    const b = await r.speichere('u', { key: 'k', json: '{"a":1}', abdruck: 'y', abgeleitetAus: 'k@1' });
    expect([a.version, b.version]).toEqual([1, 2]);
    expect(b.status).toBe('entwurf');
    expect(b.abgeleitetAus).toBe('k@1');
    expect((await r.speichere('u', { key: 'anderer', json: '{}', abdruck: 'z' })).version).toBe(1);
  });
  it('V4 Final-Welle: ableitung wird beim Speichern gesetzt und gelesen (unveränderlich: setze kennt die Spalte nicht)', async () => {
    const { db, updates } = fakeDb();
    const r = new BauplanVorlageRepository(db as never);
    const ab = JSON.stringify({ quellen: ['a'], fest: [], hinweise: [], ohneAnnahme: [] });
    const z = await r.speichere('u', { key: 'k', json: '{}', abdruck: 'x', abgeleitetAus: 'a', ableitung: ab });
    expect(z.ableitung).toBe(ab);
    expect((await r.finde('u', 'k'))?.ableitung).toBe(ab);
    expect((await r.speichere('u', { key: 'k', json: '{}', abdruck: 'y' })).ableitung).toBeUndefined();
    expect((await r.finde('u', 'k'))?.ableitung).toBeUndefined();
    await r.setze('u', z.id, { ableitung: 'x' } as never);
    expect(updates).toHaveLength(0);
  });
  it('finde: ohne Version die höchste, mit Version genau diese', async () => {
    const { db } = fakeDb();
    const r = new BauplanVorlageRepository(db as never);
    await r.speichere('u', { key: 'k', json: '1', abdruck: 'x' });
    await r.speichere('u', { key: 'k', json: '2', abdruck: 'y' });
    expect((await r.finde('u', 'k'))?.version).toBe(2);
    expect((await r.finde('u', 'k', 1))?.json).toBe('1');
    expect(await r.finde('u', 'nix')).toBeUndefined();
    expect((await r.liste('u')).map(z => z.version)).toEqual([1, 2]);
  });
  it('setze schreibt nur übergebene Spalten', async () => {
    const { db, updates } = fakeDb();
    const r = new BauplanVorlageRepository(db as never);
    await r.setze('u', 'id1', { status: 'angefragt', frageHash: 'h' });
    expect(updates[0].sql).toContain('status = ?');
    expect(updates[0].sql).toContain('frage_hash = ?');
    expect(updates[0].sql).not.toContain('grund');
    expect(updates[0].sql).not.toContain('widerrufen_at');
    expect(updates[0].p.slice(0, 2)).toEqual(['angefragt', 'h']);
    await r.setze('u', 'id1', {});
    expect(updates).toHaveLength(1);
  });
});

describe('BauplanInstanzRepository — Vorlage-Spalten und findeNachChange', () => {
  it('speichert vorlageKey/-Version und findet über change_ids', async () => {
    const { db, instanzen } = fakeDb();
    const r = new BauplanInstanzRepository(db as never);
    const i = await r.anlegen('u', { name: 'n', dokumentart: 'betrieb', changeIds: ['c-1', 'c-2'], vorlageKey: 'k', vorlageVersion: 3 });
    expect(i.vorlageKey).toBe('k');
    expect(i.vorlageVersion).toBe(3);
    expect(instanzen[0].vorlage_key).toBe('k');
    expect((await r.findeNachChange('u', 'c-2'))?.id).toBe(i.id);
    expect(await r.findeNachChange('u', 'c-9')).toBeUndefined();
  });
  it('Final-Welle T5(2): mehrere Instanzen mit dem Change → die mit vorlageKey zuerst, auch wenn die ohne jünger ist', async () => {
    const { db } = fakeDb();
    const r = new BauplanInstanzRepository(db as never);
    const mit = await r.anlegen('u', { name: 'paket', dokumentart: 'testprotokoll', changeIds: ['c-1', 'c-2'], vorlageKey: 'pki_lab', vorlageVersion: 1 });
    await r.anlegen('u', { name: 'hand', dokumentart: 'betrieb', changeIds: ['c-2'] }); // jünger, ohne Vorlage
    expect((await r.findeNachChange('u', 'c-2'))?.id).toBe(mit.id);
    // nur ohne Vorlage → die jüngste ohne
    const o = await r.findeNachChange('u', 'c-2');
    expect(o?.vorlageKey).toBe('pki_lab');
    const nurHand = await r.anlegen('u', { name: 'hand2', dokumentart: 'betrieb', changeIds: ['c-7'] });
    expect((await r.findeNachChange('u', 'c-7'))?.id).toBe(nurHand.id);
  });
});
