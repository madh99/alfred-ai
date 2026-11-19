import { describe, it, expect } from 'vitest';
import { linuxSqlBefunde, linuxSqlUeberwachung } from './linux-sql-ueberwachung.js';
import { befundeAlsProblems, type ProblemZugriff } from './befund-problems.js';

const tls = (restTage: number | null) => ({ tls: { thumbprint: 'ABCDEF0123456789', gueltigBis: '2026-12-01T00:00:00Z', restTage, erzwungen: true, pruefSchalter: true } });

describe('linuxSqlBefunde', () => {
  it('Restlaufzeit 40 und 31 → kein Befund', () => {
    expect(linuxSqlBefunde('sqllnx01', tls(40))).toEqual([]);
    expect(linuxSqlBefunde('sqllnx01', tls(31))).toEqual([]);
  });
  it('30 und 8 → mittel', () => {
    const a = linuxSqlBefunde('sqllnx01', tls(30));
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ schwere: 'mittel', schluessel: 'ueberwachung:sqllnx01:tls', kategorie: 'ueberwachung', zugang: 'sqllnx01', bereich: 'sqllnx01' });
    expect(a[0]!.text).toContain('TLS-Zertifikat sqllnx01 läuft in 30 Tagen ab');
    expect(linuxSqlBefunde('sqllnx01', tls(8))[0]!.schwere).toBe('mittel');
  });
  it('7 und 0 → hoch', () => {
    expect(linuxSqlBefunde('sqllnx01', tls(7))[0]!.schwere).toBe('hoch');
    expect(linuxSqlBefunde('sqllnx01', tls(0))[0]!.schwere).toBe('hoch');
  });
  it('-1 → hoch, abgelaufen', () => {
    const a = linuxSqlBefunde('sqllnx01', tls(-1));
    expect(a[0]!.schwere).toBe('hoch');
    expect(a[0]!.text).toContain('abgelaufen');
  });
  it('kein TLS oder unvollständig → kein Befund', () => {
    expect(linuxSqlBefunde('sqllnx01', {})).toEqual([]);
    expect(linuxSqlBefunde('sqllnx01', { tls: null })).toEqual([]);
    expect(linuxSqlBefunde('sqllnx01', { tls: { thumbprint: null, restTage: 3 } })).toEqual([]);
    expect(linuxSqlBefunde('sqllnx01', tls(null))).toEqual([]);
    expect(linuxSqlBefunde('sqllnx01', null)).toEqual([]);
  });
  it('Keytab: false → hoch; null, true, fehlend → kein Befund', () => {
    const a = linuxSqlBefunde('sqllnx02', { ad: { keytab: { kvno: 3, spns: 6, aktuell: false, adKvno: 4 } } });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ schwere: 'hoch', schluessel: 'ueberwachung:sqllnx02:keytab', kategorie: 'ueberwachung' });
    expect(a[0]!.text).toContain('Keytab sqllnx02 veraltet');
    expect(linuxSqlBefunde('sqllnx02', { ad: { keytab: { kvno: 3, spns: 6, aktuell: null } } })).toEqual([]);
    expect(linuxSqlBefunde('sqllnx02', { ad: { keytab: { kvno: 3, spns: 6, aktuell: true } } })).toEqual([]);
    expect(linuxSqlBefunde('sqllnx02', { ad: { keytab: null } })).toEqual([]);
  });
});

describe('linuxSqlUeberwachung (Verdrahtung mit befundeAlsProblems)', () => {
  const statusAus = (m: Record<string, unknown>) => async (z: string) => (z in m ? { success: true, data: m[z] } : { success: false, error: 'nicht erreichbar' });

  it('nicht lesbarer Host: Fehler, nicht erfasst', async () => {
    const r = await linuxSqlUeberwachung(['sqllnx01', 'sqllnx02'], statusAus({ sqllnx01: tls(5) }));
    expect(r.erfasst).toEqual(new Set(['sqllnx01']));
    expect(r.fehler[0]).toContain('sqllnx02');
    expect(r.befunde).toHaveLength(1);
  });

  it('Problem entsteht und löst sich, wenn das Zertifikat erneuert ist', async () => {
    const probleme: Array<{ id: string; title: string; status: string; detectionMethod?: string }> = [];
    const z = {
      liste: async () => probleme,
      anlegen: async (d: { title: string; detectionMethod?: string }) => { const id = `p${probleme.length + 1}`; probleme.push({ id, title: d.title, status: 'open', ...(d.detectionMethod ? { detectionMethod: d.detectionMethod } : {}) }); return id; },
      loese: async (id: string) => { probleme.find(p => p.id === id)!.status = 'resolved'; },
      assetFuer: async () => undefined,
    } as unknown as ProblemZugriff;
    const lauf = async (rest: number) => {
      const r = await linuxSqlUeberwachung(['sqllnx01'], statusAus({ sqllnx01: tls(rest) }));
      return befundeAlsProblems(r.befunde, z, { docId: 't', datum: 'heute' }, { hosts: r.erfasst, alle: false, kategorien: new Set(['ueberwachung']) });
    };
    expect((await lauf(5)).neu).toHaveLength(1);
    expect(probleme[0]!.detectionMethod).toContain('ueberwachung:sqllnx01:tls');
    expect((await lauf(5)).neu).toHaveLength(0);
    expect((await lauf(360)).geloest).toHaveLength(1);
    expect(probleme[0]!.status).toBe('resolved');
    expect((await lauf(3)).neu).toHaveLength(1);
  });
});
