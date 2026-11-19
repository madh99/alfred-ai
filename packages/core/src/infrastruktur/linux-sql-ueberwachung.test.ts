import { describe, it, expect } from 'vitest';
import { linuxSqlBefunde, linuxSqlUeberwachung, linuxSqlZugaenge } from './linux-sql-ueberwachung.js';
import { befundeAlsProblems, type ProblemZugriff } from './befund-problems.js';

const tls = (restTage: number | null) => ({ installiert: true, ad: { beigetreten: true, keytab: null }, tls: { zertifikat: '/var/opt/mssql/secrets/tls.crt', thumbprint: 'ABCDEF0123456789', gueltigBis: '2026-12-01T00:00:00Z', restTage, erzwungen: true, pruefSchalter: true } });

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

describe('R21 — unlesbar ist nicht ok', () => {
  const aus = (d: unknown) => async () => ({ success: true, data: d });
  const gut = { installiert: true, ad: { beigetreten: true, keytab: { kvno: 3, spns: 6, aktuell: true } }, tls: { zertifikat: '/c.crt', thumbprint: 'AB', gueltigBis: '2027-01-01T00:00:00Z', restTage: 100 } };

  it('vollständiger Status zählt als erfasst', async () => {
    const r = await linuxSqlUeberwachung(['a'], aus(gut));
    expect(r.erfasst.has('a')).toBe(true);
    expect(r.fehler).toEqual([]);
  });
  it.each([
    ['ohne ad', { ...gut, ad: undefined }],
    ['ohne tls', { ...gut, tls: undefined }],
    ['Zertifikat konfiguriert, aber unlesbar', { ...gut, tls: { zertifikat: '/c.crt', thumbprint: null, restTage: null } }],
    ['Keytab nicht lesbar', { ...gut, ad: { keytab: { kvno: null, spns: 0, aktuell: null, fehler: 'nicht lesbar' } } }],
    ['Keytab-Aktualität unbekannt', { ...gut, ad: { keytab: { kvno: 3, spns: 6, aktuell: null } } }],
    ['installiert fehlt', { ...gut, installiert: undefined }],
  ])('%s → Lesefehler, nicht erfasst', async (_n, d) => {
    const r = await linuxSqlUeberwachung(['a'], aus(d));
    expect(r.erfasst.size).toBe(0);
    expect(r.fehler[0]).toContain('a: Status unvollständig');
  });
  it('installiert false → übersprungen, weder erfasst noch Fehler', async () => {
    const r = await linuxSqlUeberwachung(['dockerhost'], aus({ installiert: false, zustand: 'nicht_installiert' }));
    expect(r).toMatchObject({ uebersprungen: ['dockerhost'], fehler: [] });
    expect(r.erfasst.size).toBe(0);
  });
  it('ohne Zertifikat und ohne Keytab (installiert) → erfasst, keine Befunde', async () => {
    const r = await linuxSqlUeberwachung(['a'], aus({ installiert: true, ad: { beigetreten: false, keytab: null }, tls: { zertifikat: null, thumbprint: null, restTage: null } }));
    expect(r.erfasst.has('a')).toBe(true);
    expect(r.befunde).toEqual([]);
  });
  it('Zugangsauswahl: alle Nicht-Windows-Zugänge', () => {
    expect(linuxSqlZugaenge([{ name: 'sqllnx01', system: 'linux' }, { name: 'dockerhost' }, { name: 'sql01', system: 'windows' }])).toEqual(['sqllnx01', 'dockerhost']);
  });
});

describe('R21 — lückenhafter Status meldet gelesene Befunde trotzdem', () => {
  it('Keytab ungeprüft, TLS läuft ab → Befund da, aber nicht erfasst', async () => {
    const d = { installiert: true, ad: { keytab: { kvno: 3, spns: 6, aktuell: null } }, tls: { zertifikat: '/c', thumbprint: 'ABCDEF0123456789', restTage: 3 } };
    const r = await linuxSqlUeberwachung(['a'], async () => ({ success: true, data: d }));
    expect(r.befunde).toHaveLength(1);
    expect(r.erfasst.size).toBe(0);
    expect(r.fehler).toHaveLength(1);
  });
});
