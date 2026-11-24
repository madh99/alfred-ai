import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PY_AGENT, PY_UPDATE } from './linux-sql.js';
import { linuxSqlBefunde, linuxSqlUeberwachung, linuxSqlZugaenge, linuxSqlSicherungsBefunde, debVersionNeuer } from './linux-sql-ueberwachung.js';
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

/**
 * Realfall 23.11.: der SQL Server Agent lief auf sqllnx01/02 seit 20./21.11. nicht („SSL Provider: The data is invalid“) — keine geplante
 * Sicherung mehr, die Überwachung meldete nichts. Owner 23.11. „ok“: Agent-Befund + Sicherungsalter (LOG > 2 h, FULL > 26 h) hoch.
 */
describe('Agent und Sicherungsalter (Owner 23.11.)', () => {
  const basis = { installiert: true, ad: { beigetreten: true, keytab: null }, tls: { zertifikat: null }, konfig: { sqlagent: 'true' } };
  it('Agent eingeschaltet, aber gestoppt → hoch', () => {
    const a = linuxSqlBefunde('sqllnx01', { ...basis, agent: { laeuft: false, letzteZeile: '2026-11-21 11:04:40 - ? [098] SQLServerAgent terminated (normally)' } });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ schwere: 'hoch', schluessel: 'ueberwachung:sqllnx01:agent', kategorie: 'ueberwachung' });
    expect(a[0]!.text).toContain('SQL Server Agent läuft nicht');
  });
  it('Agent läuft, unbekannt oder ausgeschaltet → kein Befund', () => {
    expect(linuxSqlBefunde('sqllnx01', { ...basis, agent: { laeuft: true } })).toEqual([]);
    expect(linuxSqlBefunde('sqllnx01', { ...basis, agent: { laeuft: null, fehler: 'fehlt' } })).toEqual([]);
    expect(linuxSqlBefunde('sqllnx01', { ...basis, konfig: { sqlagent: 'false' }, agent: { laeuft: false } })).toEqual([]);
  });

  const db = (name: string, alterVollMin: number | null, alterLogMin: number | null, gruppe: string | null = 'G1', modell = 'FULL') =>
    ({ name, modell, zustand: 'ONLINE', gruppe, alterVollMin, alterLogMin });
  const host = (dbs: unknown[], eingerichtet = true) => ({ ...basis, sicherung: { zugangsdatei: eingerichtet ? 'vorhanden (0600)' : 'fehlt' }, sql: { datenbanken: [db('master', 5000, null, null, 'SIMPLE'), ...dbs] } });

  it('Cluster: das jüngste Replikat zählt (Sekundär alt, Primär frisch) → kein Befund', () => {
    const m = new Map<string, unknown>([['sqllnx01', host([db('pruefdb01', 60, 10)])], ['sqllnx02', host([db('pruefdb01', 9000, 9000)])]]);
    expect(linuxSqlSicherungsBefunde(m as never)).toEqual([]);
  });
  it('LOG älter als 120 min und FULL älter als 26 h → zwei hohe Befunde, Schlüssel am ersten Host', () => {
    const m = new Map<string, unknown>([['sqllnx02', host([db('pruefdb01', 4400, 4400)])], ['sqllnx01', host([db('pruefdb01', 1561, 121)])]]);
    const a = linuxSqlSicherungsBefunde(m as never);
    expect(a.map(x => x.schluessel).sort()).toEqual(['ueberwachung:sqllnx01:sicherung:pruefdb01:log', 'ueberwachung:sqllnx01:sicherung:pruefdb01:voll']);
    expect(a.every(x => x.schwere === 'hoch')).toBe(true);
    expect(a.find(x => x.schluessel?.endsWith(':log'))!.text).toContain('letzte LOG-Sicherung vor 2 h');
  });
  it('Grenzen: LOG 120 min und FULL 1560 min (26 h) noch ok', () => {
    const m = new Map<string, unknown>([['sqllnx01', host([db('pruefdb01', 1560, 120)])]]);
    expect(linuxSqlSicherungsBefunde(m as never)).toEqual([]);
  });
  it('nie gesichert (null) → Befund; SIMPLE ohne LOG-Prüfung; Systemdatenbanken nie', () => {
    const m = new Map<string, unknown>([['sqllnx01', host([db('neu', null, null), db('einfach', 10, null, 'G2', 'SIMPLE')])]]);
    const a = linuxSqlSicherungsBefunde(m as never);
    expect(a.map(x => x.schluessel).sort()).toEqual(['ueberwachung:sqllnx01:sicherung:neu:log', 'ueberwachung:sqllnx01:sicherung:neu:voll']);
    expect(a[0]!.text).toContain('nie');
  });
  it('Sicherung nicht eingerichtet → keine Prüfung', () => {
    const m = new Map<string, unknown>([['sqltest', host([db('x', null, null, null)], false)]]);
    expect(linuxSqlSicherungsBefunde(m as never)).toEqual([]);
  });
  it('Lauf: ein Host ohne SQL-Sicht → Sicherungsalter nicht ausgewertet, nichts gelöst (fail-closed); beide lesbar → alle Befunde', async () => {
    const st: Record<string, unknown> = {
      sqllnx01: { ...host([db('pruefdb01', 4400, 4400)]), agent: { laeuft: false } },
      sqllnx02: { ...basis, sicherung: { zugangsdatei: 'vorhanden (0600)' }, sql: null, sqlFehler: 'Login timeout' },
    };
    const r = await linuxSqlUeberwachung(['sqllnx01', 'sqllnx02'], async (z) => ({ success: true, data: st[z] }));
    expect(r.befunde.map(b => b.schluessel).sort()).toEqual(['ueberwachung:sqllnx01:agent']);
    expect([...r.erfasst]).toEqual([]);
    expect(r.fehler.join()).toContain('sqllnx02: Status unvollständig — SQL-Sicht fehlt');
    expect(r.fehler.join()).toContain('Sicherungsalter nicht ausgewertet');
    // beide lesbar → Agent- und Sicherungsbefunde zusammen
    st.sqllnx02 = host([db('pruefdb01', 4500, 4500)]);
    const r2 = await linuxSqlUeberwachung(['sqllnx01', 'sqllnx02'], async (z) => ({ success: true, data: st[z] }));
    expect(r2.befunde.map(b => b.schluessel).sort()).toEqual(['ueberwachung:sqllnx01:agent', 'ueberwachung:sqllnx01:sicherung:pruefdb01:log', 'ueberwachung:sqllnx01:sicherung:pruefdb01:voll']);
    expect([...r2.erfasst].sort()).toEqual(['sqllnx01', 'sqllnx02']);
  });
});

describe('PY_AGENT (ausgeführt)', () => {
  const PY = ['python3', 'python'].find(p => spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3');
  const lauf = (inhalt: Buffer | null) => {
    const d = mkdtempSync(join(tmpdir(), 'agent-')); const f = join(d, 'sqlagent.out');
    if (inhalt) writeFileSync(f, inhalt);
    const prog = `r = {}\ng = lambda s, k: ${JSON.stringify(f)} if k == "errorlogfile" else None\n${PY_AGENT}\nimport json\nprint(json.dumps(r["agent"]))`;
    return JSON.parse(spawnSync(PY!, ['-'], { input: prog, encoding: 'utf8' }).stdout);
  };
  it.skipIf(!PY)('Realfall-Log (UTF-16) mit „terminated“ am Ende → laeuft false', () => {
    const t = '2026-11-21 11:04:40 - ! [000] Unable to connect to server \'(local),1433\'; SQLServerAgent cannot start\r\n2026-11-21 11:04:40 - ? [098] SQLServerAgent terminated (normally)\r\n';
    const a = lauf(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, 'utf16le')]));
    expect(a.laeuft).toBe(false);
    expect(a.letzteZeile).toContain('[098] SQLServerAgent terminated');
  });
  it.skipIf(!PY)('Startzeilen ohne Abbruch → laeuft true; Datei fehlt → null', () => {
    expect(lauf(Buffer.from('2026-11-23 10:00:00 - ? [129] SQLSERVERAGENT starting\n2026-11-23 10:00:02 - ? [146] Request servicer engine started\n')).laeuft).toBe(true);
    expect(lauf(null)).toEqual({ laeuft: null, fehler: 'sqlagent.out fehlt' });
  });
});

describe('SQL-Update verfügbar (Owner 23.11.: Pakete auf hold, bisher keine Prüfung)', () => {
  const st = (inst: string | null, kandidat: string | null | undefined) => ({ pakete: { 'mssql-server': inst }, update: kandidat === undefined ? undefined : { kandidat } });
  it('debVersionNeuer vergleicht Build und Revision numerisch', () => {
    expect(debVersionNeuer('17.0.5065.9-2', '17.0.4006.2-1')).toBe(true);
    expect(debVersionNeuer('17.0.4006.2-1', '17.0.4006.2-1')).toBe(false);
    expect(debVersionNeuer('17.0.4006.2-1', '17.0.5065.9-2')).toBe(false);
    expect(debVersionNeuer('17.0.4006.10-1', '17.0.4006.9-1')).toBe(true);
    expect(debVersionNeuer('17.0.4006.2-2', '17.0.4006.2-1')).toBe(true);
    expect(debVersionNeuer('kaputt', '17.0.4006.2-1')).toBe(false);
  });
  it('neuere Version in der Paketquelle → Befund mittel mit beiden Versionen', () => {
    const a = linuxSqlBefunde('sqllnx01', st('17.0.4006.2-1', '17.0.5065.9-2'));
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ schwere: 'mittel', schluessel: 'ueberwachung:sqllnx01:sql-update', kategorie: 'ueberwachung', zugang: 'sqllnx01' });
    expect(a[0]!.text).toContain('17.0.4006.2-1');
    expect(a[0]!.text).toContain('17.0.5065.9-2');
    // Realfall 24.11.: Titel = „<bereich>: <text>“ — der Text trägt den Host nicht noch einmal
    expect(a[0]!.text.startsWith('SQL-Server-Update verfügbar')).toBe(true);
  });
  it('gleich, älter, ohne Kandidat oder nicht installiert → kein Befund', () => {
    expect(linuxSqlBefunde('sqllnx01', st('17.0.4006.2-1', '17.0.4006.2-1'))).toEqual([]);
    expect(linuxSqlBefunde('sqllnx01', st('17.0.5065.9-2', '17.0.4006.2-1'))).toEqual([]);
    expect(linuxSqlBefunde('sqllnx01', st('17.0.4006.2-1', null))).toEqual([]);
    expect(linuxSqlBefunde('sqllnx01', st('17.0.4006.2-1', undefined))).toEqual([]);
    expect(linuxSqlBefunde('sqllnx01', st(null, '17.0.5065.9-2'))).toEqual([]);
  });
});

describe('PY_UPDATE (ausgeführt)', () => {
  const PY = ['python3', 'python'].find(p => spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3');
  const lauf = (rc: number, text: string, installiert = true) => {
    const prog = `import os, subprocess\nr = {"installiert": ${installiert ? 'True' : 'False'}}\ndef _apt_policy():\n    return ${rc}, ${JSON.stringify(text)}\n${PY_UPDATE}\nimport json\nprint(json.dumps(r.get("update")))`;
    return JSON.parse(spawnSync(PY!, ['-'], { input: prog, encoding: 'utf8' }).stdout);
  };
  const POLICY = 'mssql-server:\n  Installed: 17.0.4006.2-1\n  Candidate: 17.0.5065.9-2\n  Version table:\n     17.0.5065.9-2 500\n *** 17.0.4006.2-1 100\n';
  it.skipIf(!PY)('Candidate aus apt-cache policy', () => {
    expect(lauf(0, POLICY)).toEqual({ kandidat: '17.0.5065.9-2' });
  });
  it.skipIf(!PY)('(none), Fehler, nicht installiert', () => {
    expect(lauf(0, 'mssql-server:\n  Installed: 17.0.4006.2-1\n  Candidate: (none)\n')).toEqual({ kandidat: null });
    expect(lauf(100, '')).toEqual({ kandidat: null, fehler: 'apt-cache policy fehlgeschlagen' });
    expect(lauf(0, POLICY, false)).toBeNull();
  });
});
