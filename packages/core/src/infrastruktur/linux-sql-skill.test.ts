import { describe, it, expect } from 'vitest';
import { LinuxSqlSkill, linuxSqlKennwort, saName, loginTresorName, linuxSqlStatusText, zeitText, KENNWORT_ALPHABET } from './linux-sql-skill.js';
import { LINUX_SQL_BAUSTEINE, PRUEFDATEN_SHA256 } from './linux-sql.js';
import { aktionsArt, pruefeChangePlan, FESTE_AUSGABEN } from './change-schritte.js';

// I8e Paket 1 Task 3 — Skill linux_sql: Aufbau der Einzelinstanz über die Bausteine aus linux-sql.ts

interface Aufruf { zugang: string; baustein: string; parameter: unknown; eingabe?: string; timeoutMs: number; zweck: string }
const imChange = { ausChange: true } as never;

function welt(antworten: Record<string, Array<Record<string, unknown> | { code: number; stdout: string }>>, tresorDa: Record<string, string> = {}) {
  const aufrufe: Aufruf[] = [];
  const tresor = new Map<string, string>(Object.entries(tresorDa));
  const gesetzt: Array<{ name: string; wert: string; zweck: string }> = [];
  const skill = new LinuxSqlSkill({
    skript: async (zugang, baustein, parameter, eingabe, timeoutMs, zweck) => {
      aufrufe.push({ zugang, baustein, parameter, ...(eingabe !== undefined ? { eingabe } : {}), timeoutMs, zweck });
      const liste = antworten[baustein] ?? [];
      const a = liste.length > 1 ? liste.shift()! : liste[0];
      if (!a) return { code: 1, stdout: '', stderr: `kein Stub für ${baustein}` };
      if ('code' in a && 'stdout' in a) return { code: a.code as number, stdout: a.stdout as string, stderr: '' };
      return { code: a.zustand === 'fehler' ? 1 : 0, stdout: `irgendwas\nALFRED-SQL ${JSON.stringify(a)}\n`, stderr: '' };
    },
    tresor: {
      namen: async () => new Set(tresor.keys()),
      lies: async (name) => { const w = tresor.get(name); if (w === undefined) throw new Error(`fehlt ${name}`); return w; },
      setze: async (name, wert, zweck) => { gesetzt.push({ name, wert, zweck }); tresor.set(name, wert); },
    },
  });
  return { skill, aufrufe, tresor, gesetzt };
}

const PLATTEN = [{ scsi: 1, groesse_gib: 160, ziel: 'data' }, { scsi: 2, groesse_gib: 80, ziel: 'log' }, { scsi: 3, groesse_gib: 64, ziel: 'tempdb' }, { scsi: 4, groesse_gib: 128, ziel: 'backup' }];
const STATUS_VOLL = {
  zustand: 'gelesen', installiert: true, pakete: { 'mssql-server': '17.0.4006.2-1', 'mssql-tools18': '18.6.2.1-1', msodbcsql18: '18.6.2.1-1' }, dienst: 'active', aktiviert: 'enabled',
  konfig: { memorylimitmb: '12288', defaultdatadir: '/var/opt/mssql/data', defaultlogdir: '/var/opt/mssql/log', defaultbackupdir: '/var/opt/mssql/backup', sqlagent: 'true' },
  platz: ['/var/opt/mssql/data', '/var/opt/mssql/log', '/var/opt/mssql/tempdb', '/var/opt/mssql/backup', '/var/opt/mssql', '/'].map((pfad, i) => ({ pfad, eingehaengt: i < 4 || pfad === '/', gesamtMB: 1000, freiMB: 900 })),
  sql: { version: '17.0.4006.2', stufe: 'RTM', cu: 'CU1', edition: 'Enterprise Developer Edition (64-bit)', engineEdition: 3, maxSpeicherMb: 10240, kerne: 6,
    tempdb: [{ name: 'tempdev', typ: 'ROWS' }, { name: 'temp2', typ: 'ROWS' }, { name: 'templog', typ: 'LOG' }], datenbanken: [{ name: 'master' }, { name: 'pruefdb01' }, { name: 'tempdb' }] },
};

describe('I8e Task 3 — Kennwörter', () => {
  it('24 Zeichen, groß/klein/Ziffer/Sonderzeichen, nur druckbares ASCII ohne " \\ \' Leerzeichen $', () => {
    for (const z of ['"', '\\', "'", ' ', '$']) expect(KENNWORT_ALPHABET).not.toContain(z);
    const gesehen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const k = linuxSqlKennwort();
      expect(k).toHaveLength(24);
      expect(k).toMatch(/[A-Z]/); expect(k).toMatch(/[a-z]/); expect(k).toMatch(/[0-9]/); expect(k).toMatch(/[^A-Za-z0-9]/);
      expect(k).toMatch(/^[\x21-\x7e]+$/);
      expect(k).not.toMatch(/["\\' $]/);
      gesehen.add(k);
    }
    expect(gesehen.size).toBe(300);
  });
  it('Tresor-Namen: klein geschrieben, Tresor-Regel', () => {
    expect(saName('SQLLNX01')).toBe('sqllnx-sqllnx01-sa');
    expect(loginTresorName('sqllnx01', 'App_Kunden')).toBe('sqllnx-sqllnx01-app_kunden');
    expect(() => loginTresorName('sqllnx01', 'a'.repeat(60))).toThrow(/Tresor/);
  });
});

describe('I8e Task 3 — Skill linux_sql', () => {
  it('ändernde Aktionen außerhalb eines Changes abgewiesen, ohne Fernaufruf; status auch außerhalb', async () => {
    const w = welt({ [LINUX_SQL_BAUSTEINE.status]: [STATUS_VOLL] });
    for (const action of ['platten_einrichten', 'installieren', 'konfigurieren', 'login_anlegen', 'pruefdaten_anlegen']) {
      const r = await w.skill.execute({ action, zugang: 'sqllnx01' }, {} as never);
      expect(r.success, action).toBe(false);
      expect(r.error, action).toContain('nur als Schritt eines freigegebenen Changes');
    }
    expect(w.aufrufe).toEqual([]);
    const s = await w.skill.execute({ action: 'status', zugang: 'sqllnx01' }, {} as never);
    expect(s.success).toBe(true);
    expect(w.aufrufe[0]).toMatchObject({ baustein: LINUX_SQL_BAUSTEINE.status, parameter: {} });
    expect(w.aufrufe[0]!.eingabe).toBeUndefined(); // ohne Tresor-Eintrag nur Betriebssystem-Sicht
    expect(w.aufrufe[0]!.timeoutMs).toBeGreaterThanOrEqual(65_000);
    expect((await w.skill.execute({ action: 'status', zugang: 'a b' }, {} as never)).error).toContain('zugang');
    expect((await w.skill.execute({ action: 'loeschen', zugang: 'sqllnx01' }, imChange)).error).toContain('Unbekannte Aktion');
  });
  it('status: mit sa aus dem Tresor über stdin; Text im festen Wortlaut', async () => {
    const w = welt({ [LINUX_SQL_BAUSTEINE.status]: [STATUS_VOLL] }, { 'sqllnx-sqllnx01-sa': 'Sa-Wert-1' });
    const r = await w.skill.execute({ action: 'status', zugang: 'sqllnx01' }, {} as never);
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ sa: 'Sa-Wert-1' });
    expect(r.display).toBe('sqllnx01: SQL Server 17.0.4006.2 CU1 Enterprise Developer Edition (64-bit); Dienst aktiv, aktiviert; Speicherlimit 12288 MB; max server memory 10240 MB; tempdb 2 Datendateien; Datenbanken: pruefdb01; eingehängt: data, log, tempdb, backup; Sicherung: nicht eingerichtet; Zeit unbekannt');
    expect(JSON.stringify(r.data)).not.toContain('Sa-Wert-1');
    expect(linuxSqlStatusText('x', { zustand: 'gelesen', installiert: false, platz: [] })).toBe('x: SQL Server nicht installiert; eingehängt: keine Plattenziele; Sicherung: nicht eingerichtet; Zeit unbekannt');
    expect(linuxSqlStatusText('x', { ...STATUS_VOLL, sql: null, sqlHinweis: 'Dienst nicht aktiv', dienst: 'failed', aktiviert: 'enabled' }))
      .toBe('x: SQL Server 17.0.4006.2-1 (Paket); Dienst failed, aktiviert; Speicherlimit 12288 MB; SQL-Sicht: Dienst nicht aktiv; eingehängt: data, log, tempdb, backup; Sicherung: nicht eingerichtet; Zeit unbekannt');
    // jedes Stück des festen Wortlauts steht in FESTE_AUSGABEN (Planprüfung erwartet)
    for (const t of ['Dienst aktiv, aktiviert', 'eingehängt: data, log, tempdb, backup', 'SQL Server nicht installiert']) expect(FESTE_AUSGABEN['linux_sql.status']).toContain(t);
  });
  it('platten_einrichten: Kurzziele → feste Pfade, ohne Geheimnis; Idempotenz „nichts zu tun“', async () => {
    const w = welt({ [LINUX_SQL_BAUSTEINE.platten]: [
      { zustand: 'geaendert', platten: [{ scsi: 1, geraet: '/dev/sdb', ziel: '/var/opt/mssql/data', aktion: 'formatiert' }] },
      { zustand: 'schon', platten: [{ scsi: 1, geraet: '/dev/sdb', ziel: '/var/opt/mssql/data', aktion: 'schon' }] },
    ] });
    const r = await w.skill.execute({ action: 'platten_einrichten', zugang: 'sqllnx01', platten: PLATTEN }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.aufrufe[0]).toMatchObject({ zugang: 'sqllnx01', baustein: LINUX_SQL_BAUSTEINE.platten, timeoutMs: 180_000,
      parameter: { platten: [{ scsi: 1, groesseGiB: 160, ziel: '/var/opt/mssql/data' }, { scsi: 2, groesseGiB: 80, ziel: '/var/opt/mssql/log' }, { scsi: 3, groesseGiB: 64, ziel: '/var/opt/mssql/tempdb' }, { scsi: 4, groesseGiB: 128, ziel: '/var/opt/mssql/backup' }] } });
    expect(w.aufrufe[0]!.eingabe).toBeUndefined();
    expect(r.display).toContain('/dev/sdb → /var/opt/mssql/data (formatiert)');
    const r2 = await w.skill.execute({ action: 'platten_einrichten', zugang: 'sqllnx01', platten: PLATTEN }, imChange);
    expect(r2.display).toContain('nichts zu tun');
    // ungültige Parameter scheitern vor jedem Fernaufruf
    const n = w.aufrufe.length;
    expect((await w.skill.execute({ action: 'platten_einrichten', zugang: 'sqllnx01', platten: [{ scsi: 0, groesse_gib: 80, ziel: 'data' }] }, imChange)).error).toContain('scsi');
    expect((await w.skill.execute({ action: 'platten_einrichten', zugang: 'sqllnx01', platten: [{ scsi: 1, groesse_gib: 80, ziel: '/etc' }] }, imChange)).error).toContain('ziel');
    expect(w.aufrufe.length).toBe(n);
  });
  it('installieren: sa-Kennwort einmalig im Tresor erzeugt, nur über stdin; zweiter Lauf liest und meldet „nichts zu tun“', async () => {
    const ok = { zustand: 'geaendert', paket: '17.0.4006.2-1', version: '17.0.4006.2', edition: 'Enterprise Developer Edition (64-bit)', dienst: 'active' };
    const w = welt({ [LINUX_SQL_BAUSTEINE.installation]: [ok, { ...ok, zustand: 'schon' }] });
    const r = await w.skill.execute({ action: 'installieren', zugang: 'SQLLNX01', version: '17.0.4006.2-1' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.gesetzt).toHaveLength(1);
    const sa = w.gesetzt[0]!;
    expect(sa.name).toBe('sqllnx-sqllnx01-sa');
    expect(sa.wert).toHaveLength(24);
    expect(w.aufrufe[0]).toMatchObject({ zugang: 'SQLLNX01', baustein: LINUX_SQL_BAUSTEINE.installation, timeoutMs: 1_500_000, parameter: { version: '17.0.4006.2-1', edition: 'EnterpriseDeveloper' } });
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ sa: sa.wert });
    expect(r.display).toContain('sqllnx-sqllnx01-sa');
    const r2 = await w.skill.execute({ action: 'installieren', zugang: 'sqllnx01', version: '17.0.4006.2-1' }, imChange);
    expect(w.gesetzt).toHaveLength(1);
    expect(JSON.parse(w.aufrufe[1]!.eingabe!)).toEqual({ sa: sa.wert });
    expect(r2.display).toContain('nichts zu tun');
    for (const a of w.aufrufe) { expect(JSON.stringify(a.parameter)).not.toContain(sa.wert); expect(a.zweck).not.toContain(sa.wert); expect(a.baustein).not.toContain(sa.wert); }
    expect(JSON.stringify([r, r2])).not.toContain(sa.wert);
    expect((await w.skill.execute({ action: 'installieren', zugang: 'sqllnx01', version: '16.0.1000.6-1' }, imChange)).error).toContain('version');
  });
  it('Fehler des Bausteins: Meldung ohne Geheimnis, auch wenn die Ausgabe es enthielte', async () => {
    const w = welt({ [LINUX_SQL_BAUSTEINE.installation]: [{ code: 1, stdout: 'Kennwort Sa-Geheim-77 abgelehnt\nALFRED-SQL {"zustand":"fehler","baustein":"sql.installation","fehler":"setup mit Sa-Geheim-77 gescheitert"}' }] }, { 'sqllnx-sqllnx01-sa': 'Sa-Geheim-77' });
    const r = await w.skill.execute({ action: 'installieren', zugang: 'sqllnx01', version: '17.0.4006.2-1' }, imChange);
    expect(r.success).toBe(false);
    expect(r.error).toContain('setup mit [geschwärzt] gescheitert');
    expect(r.error).not.toContain('Sa-Geheim-77');
    expect(w.gesetzt).toEqual([]);
    const ohne = welt({ [LINUX_SQL_BAUSTEINE.status]: [{ code: 255, stdout: '' }] });
    expect((await ohne.skill.execute({ action: 'status', zugang: 'sqllnx01' }, {} as never)).error).toMatch(/Exit 255/);
  });
  it('Ruling R5 — konfigurieren auf dem Konfig-Knoten (einhaengepunkte nur data): Daten, Log, Sicherung und tempdb auf der Datenplatte', async () => {
    const w = welt({
      [LINUX_SQL_BAUSTEINE.konfiguration]: [{ zustand: 'geaendert', neustart: true }],
      [LINUX_SQL_BAUSTEINE.tempdb]: [{ zustand: 'geaendert', dateien: 2 }],
      [LINUX_SQL_BAUSTEINE.maxspeicher]: [{ zustand: 'geaendert', maxSpeicherMb: 2048 }],
    }, { 'sqllnx-sqllnxcfg-sa': 'Sa-C' });
    const r = await w.skill.execute({ action: 'konfigurieren', zugang: 'sqllnxcfg', einhaengepunkte: ['data'], speicher_limit_mb: 3072, max_server_memory_mb: 2048, tempdb_dateien: 2 }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.aufrufe[0]).toMatchObject({ parameter: { speicherLimitMB: 3072, datenPfad: '/var/opt/mssql/data', logPfad: '/var/opt/mssql/data', sicherungsPfad: '/var/opt/mssql/data', agent: true } });
    expect(w.aufrufe[1]).toMatchObject({ parameter: { dateien: 2, pfad: '/var/opt/mssql/data/tempdb/' } });
    expect(w.aufrufe[2]).toMatchObject({ parameter: { mb: 2048 } });
    // Standard (alle vier) unverändert: tempdb ohne pfad
    expect(w.skill.pruefeEingabe({ action: 'konfigurieren', zugang: 'sqllnxcfg', einhaengepunkte: ['data', 'log'], speicher_limit_mb: 3072, max_server_memory_mb: 2048 })).toContain('einhaengepunkte');
    expect(w.skill.pruefeEingabe({ action: 'konfigurieren', zugang: 'sqllnxcfg', einhaengepunkte: ['data'], speicher_limit_mb: 3072, max_server_memory_mb: 2048 })).toBeUndefined();
  });
  it('konfigurieren: mssql-conf, tempdb, max server memory der Reihe nach; max < Limit; Kerne aus dem Status, höchstens 8', async () => {
    const w = welt({
      [LINUX_SQL_BAUSTEINE.status]: [{ ...STATUS_VOLL, sql: { ...STATUS_VOLL.sql, kerne: 12 } }],
      [LINUX_SQL_BAUSTEINE.konfiguration]: [{ zustand: 'geaendert', neustart: true }],
      [LINUX_SQL_BAUSTEINE.tempdb]: [{ zustand: 'geaendert', dateien: 8, aenderungen: 9, neustart: true }],
      [LINUX_SQL_BAUSTEINE.maxspeicher]: [{ zustand: 'schon', maxSpeicherMb: 10240 }],
    }, { 'sqllnx-sqllnx01-sa': 'Sa-K' });
    const r = await w.skill.execute({ action: 'konfigurieren', zugang: 'sqllnx01' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.aufrufe.map(a => a.baustein)).toEqual([LINUX_SQL_BAUSTEINE.status, LINUX_SQL_BAUSTEINE.konfiguration, LINUX_SQL_BAUSTEINE.tempdb, LINUX_SQL_BAUSTEINE.maxspeicher]);
    expect(w.aufrufe[1]).toMatchObject({ parameter: { speicherLimitMB: 12288, datenPfad: '/var/opt/mssql/data', logPfad: '/var/opt/mssql/log', sicherungsPfad: '/var/opt/mssql/backup', agent: true } });
    expect(w.aufrufe[1]!.eingabe).toBeUndefined();
    expect(w.aufrufe[2]).toMatchObject({ parameter: { dateien: 8, groesseMB: 1024, wachstumMB: 512, logGroesseMB: 2048 } });
    expect(w.aufrufe[3]).toMatchObject({ parameter: { mb: 10240 } });
    for (const a of w.aufrufe.slice(2)) expect(JSON.parse(a.eingabe!)).toEqual({ sa: 'Sa-K' });
    expect(r.display).toContain('tempdb 8 Datendateien');
    const n = w.aufrufe.length;
    expect((await w.skill.execute({ action: 'konfigurieren', zugang: 'sqllnx01', speicher_limit_mb: 8192, max_server_memory_mb: 8192, tempdb_dateien: 4 }, imChange)).error).toContain('max_server_memory_mb');
    expect((await w.skill.execute({ action: 'konfigurieren', zugang: 'sqllnx01', tempdb_dateien: 9 }, imChange)).error).toContain('dateien');
    expect(w.aufrufe.length).toBe(n);
    // alle drei Bausteine „schon“ → nichts zu tun
    const s = welt({
      [LINUX_SQL_BAUSTEINE.konfiguration]: [{ zustand: 'schon' }], [LINUX_SQL_BAUSTEINE.tempdb]: [{ zustand: 'schon', dateien: 4 }], [LINUX_SQL_BAUSTEINE.maxspeicher]: [{ zustand: 'schon', maxSpeicherMb: 10240 }],
    }, { 'sqllnx-sqllnx01-sa': 'Sa-K' });
    const r2 = await s.skill.execute({ action: 'konfigurieren', zugang: 'sqllnx01', tempdb_dateien: 4 }, imChange);
    expect(r2.display).toContain('nichts zu tun');
    expect(s.aufrufe.map(a => a.baustein)).not.toContain(LINUX_SQL_BAUSTEINE.status);
    // ohne sa im Tresor: Abbruch vor jedem Fernaufruf
    const leer = welt({});
    expect((await leer.skill.execute({ action: 'konfigurieren', zugang: 'sqllnx01', tempdb_dateien: 4 }, imChange)).error).toContain('sqllnx-sqllnx01-sa');
    expect(leer.aufrufe).toEqual([]);
  });
  it('login_anlegen: Kennwort einmalig im Tresor, Rolle → Serverrollen, Geheimnisse nur in der Eingabe', async () => {
    const w = welt({ [LINUX_SQL_BAUSTEINE.login]: [{ zustand: 'angelegt', login: 'app_kunden', serverrollen: ['dbcreator'] }, { zustand: 'schon', login: 'app_kunden', serverrollen: ['dbcreator'] }] }, { 'sqllnx-sqllnx01-sa': 'Sa-L' });
    const r = await w.skill.execute({ action: 'login_anlegen', zugang: 'sqllnx01', login: 'app_kunden', rolle: 'dbcreator' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.gesetzt.map(g => g.name)).toEqual(['sqllnx-sqllnx01-app_kunden']);
    const kw = w.gesetzt[0]!.wert;
    expect(w.aufrufe[0]).toMatchObject({ baustein: LINUX_SQL_BAUSTEINE.login, parameter: { name: 'app_kunden', serverrollen: ['dbcreator'] } });
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ sa: 'Sa-L', kennwort: kw });
    expect(JSON.stringify(w.aufrufe[0]!.parameter)).not.toContain(kw);
    expect(JSON.stringify(r)).not.toContain(kw);
    expect(r.display).toContain('sqllnx-sqllnx01-app_kunden');
    const r2 = await w.skill.execute({ action: 'login_anlegen', zugang: 'sqllnx01', login: 'app_kunden', rolle: 'dbcreator' }, imChange);
    expect(r2.display).toContain('nichts zu tun');
    expect(w.gesetzt).toHaveLength(1);
    expect(JSON.parse(w.aufrufe[1]!.eingabe!)).toEqual({ sa: 'Sa-L', kennwort: kw });
    const rollen = welt({ [LINUX_SQL_BAUSTEINE.login]: [{ zustand: 'angelegt' }] }, { 'sqllnx-sqllnx01-sa': 'Sa-L' });
    await rollen.skill.execute({ action: 'login_anlegen', zugang: 'sqllnx01', login: 'admin_x', rolle: 'sysadmin' }, imChange);
    await rollen.skill.execute({ action: 'login_anlegen', zugang: 'sqllnx01', login: 'leser_x', rolle: 'lesen' }, imChange);
    expect(rollen.aufrufe.map(a => (a.parameter as { serverrollen: string[] }).serverrollen)).toEqual([['sysadmin'], []]);
    expect((await w.skill.execute({ action: 'login_anlegen', zugang: 'sqllnx01', login: 'app_kunden', rolle: 'securityadmin' }, imChange)).error).toContain('rolle');
    expect((await w.skill.execute({ action: 'login_anlegen', zugang: 'sqllnx01', login: 'sa', rolle: 'lesen' }, imChange)).error).toContain('login');
  });
  it('pruefdaten_anlegen: Zeilen und Prüfsumme im Ergebnis, Abweichung von der Soll-Prüfsumme → Fehler', async () => {
    const e = { zustand: 'geaendert', datenbank: 'pruefdb01', tabelle: 'dbo.alfred_pruefung', zeilen: 1000, pruefsumme: PRUEFDATEN_SHA256, wiederherstellungsmodell: 'FULL' };
    const w = welt({ [LINUX_SQL_BAUSTEINE.pruefdaten]: [e, { ...e, zustand: 'schon' }, { ...e, pruefsumme: 'AB' }] }, { 'sqllnx-sqllnx01-sa': 'Sa-P' });
    const r = await w.skill.execute({ action: 'pruefdaten_anlegen', zugang: 'sqllnx01', datenbank: 'pruefdb01' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.data).toMatchObject({ zeilen: 1000, pruefsumme: PRUEFDATEN_SHA256 });
    expect(w.aufrufe[0]).toMatchObject({ parameter: { datenbank: 'pruefdb01' } });
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ sa: 'Sa-P' });
    expect((await w.skill.execute({ action: 'pruefdaten_anlegen', zugang: 'sqllnx01', datenbank: 'pruefdb01' }, imChange)).display).toContain('nichts zu tun');
    expect((await w.skill.execute({ action: 'pruefdaten_anlegen', zugang: 'sqllnx01', datenbank: 'pruefdb01' }, imChange)).error).toContain('Prüfsumme');
    expect((await w.skill.execute({ action: 'pruefdaten_anlegen', zugang: 'sqllnx01', datenbank: 'master' }, imChange)).error).toContain('datenbank');
  });
  it('Planprüfung der Eingabe (ohne Tresor, ohne Fernaufruf)', () => {
    const w = welt({});
    expect(w.skill.pruefeEingabe({ action: 'platten_einrichten', zugang: 'sqllnx01', platten: PLATTEN })).toBeUndefined();
    expect(w.skill.pruefeEingabe({ action: 'platten_einrichten', zugang: 'sqllnx01', platten: [] })).toContain('platten');
    expect(w.skill.pruefeEingabe({ action: 'installieren', zugang: 'sqllnx01', version: '17.0.4006.2' })).toContain('version');
    expect(w.skill.pruefeEingabe({ action: 'konfigurieren', zugang: 'sqllnx01', speicher_limit_mb: 4096 })).toContain('max_server_memory_mb');
    expect(w.skill.pruefeEingabe({ action: 'login_anlegen', zugang: 'sqllnx01', login: 'x y', rolle: 'lesen' })).toContain('login');
    expect(w.skill.pruefeEingabe({ action: 'pruefdaten_anlegen', zugang: 'sqllnx01', datenbank: 'tempdb' })).toContain('datenbank');
    expect(w.skill.pruefeEingabe({ action: 'status', zugang: '{{schritt1.name}}' })).toBeUndefined();
  });
});

// ── Planregeln ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('I8e Task 3 — Change „sqllnx01 aufbauen“', () => {
  const skill = new LinuxSqlSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const proxmox = { metadata: { name: 'proxmox', inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['provision_vm', 'delete_vm', 'create_snapshot', 'rollback_snapshot', 'agent_status'] },
    template: { type: 'number' }, node: { type: 'string' }, storage: { type: 'string' }, hostname: { type: 'string' }, ip: { type: 'string' }, gateway: { type: 'string' },
    new_vmid: { type: 'number' }, vmid: { type: 'number' }, extra_disks: { type: 'array' }, name: { type: 'string' },
  }, required: ['action'] } } };
  /** gefälschte CMDB: alles existiert außer den neu bereitgestellten VMs */
  const NEUE_VMS = new Set(['sqllnx01', 'anderevm']);
  const ctx = { skill: (n: string) => (n === 'linux_sql' ? skill : n === 'proxmox' ? proxmox : undefined) as never, asset: (n: string) => (NEUE_VMS.has(n.toLowerCase()) ? undefined : { id: `a-${n}`, name: n }), changes: [] };
  const status = (erwartet: string) => ({ typ: 'skill', skill: 'linux_sql', aktion: 'status', parameter: { zugang: 'sqllnx01' }, erwartet });
  const keiner = { keiner: 'Neuaufbau, Rückweg = VM löschen (Change-Ebene proxmox.delete_vm)' };
  const provision = { titel: 'VM bereitstellen', art: 'aktion', skill: 'proxmox', aktion: 'provision_vm', zeitlimitS: 1800,
    parameter: { template: 9020, node: 'pve1', storage: 'data2', hostname: 'sqllnx01', ip: '10.203.28.10/28', gateway: '10.203.28.1', new_vmid: 160, extra_disks: [160, 80, 64, 128] },
    rueckweg: { skill: 'proxmox', aktion: 'delete_vm', parameter: { vmid: 160 } }, pruefung: { typ: 'ping', ziel: '10.203.28.10' } };
  const aufbau = [
    { titel: 'Platten einrichten', art: 'aktion', skill: 'linux_sql', aktion: 'platten_einrichten', parameter: { zugang: 'sqllnx01', platten: PLATTEN }, zeitlimitS: 300, rueckweg: keiner, pruefung: status('eingehängt: data, log, tempdb, backup') },
    { titel: 'SQL Server installieren', art: 'aktion', skill: 'linux_sql', aktion: 'installieren', parameter: { zugang: 'sqllnx01', version: '17.0.4006.2-1' }, zeitlimitS: 1800, rueckweg: keiner, pruefung: status('Dienst aktiv, aktiviert') },
    { titel: 'Konfigurieren', art: 'aktion', skill: 'linux_sql', aktion: 'konfigurieren', parameter: { zugang: 'sqllnx01', speicher_limit_mb: 12288, max_server_memory_mb: 10240 }, zeitlimitS: 1200, rueckweg: keiner, pruefung: status('Dienst aktiv') },
    { titel: 'Login anlegen', art: 'aktion', skill: 'linux_sql', aktion: 'login_anlegen', parameter: { zugang: 'sqllnx01', login: 'app_kunden', rolle: 'dbcreator' }, zeitlimitS: 300, rueckweg: keiner, pruefung: status('Dienst aktiv') },
    { titel: 'Prüfdaten anlegen', art: 'aktion', skill: 'linux_sql', aktion: 'pruefdaten_anlegen', parameter: { zugang: 'sqllnx01', datenbank: 'pruefdb01' }, zeitlimitS: 300, rueckweg: keiner, pruefung: status('pruefdb01') },
    { titel: 'Abschluss', art: 'pruefung', pruefung: status('Dienst aktiv, aktiviert') },
  ];
  const plan = (schritte: unknown[], extra: Record<string, unknown> = {}) => ({ titel: 'sqllnx01 aufbauen', begruendung: 'I8e Paket 1 — SQL Server 2025 auf Linux, Einzelinstanz', typ: 'normal', risiko: 'mittel', ausfallMinuten: 0, betroffen: ['pve1'], schritte, ...extra });
  const NEU = { ohneSicherungGrund: 'neue VM sqllnx01, nichts Bestehendes betroffen' };

  it('Einordnung: status liest, alles andere ändert', () => {
    expect(aktionsArt('linux_sql', 'status')).toBe('lesen');
    for (const a of ['platten_einrichten', 'installieren', 'konfigurieren', 'login_anlegen', 'pruefdaten_anlegen']) expect(aktionsArt('linux_sql', a)).toBe('aendern');
  });
  it('vollständiger Aufbau mit provision_vm: 0 Fehler', () => {
    const r = pruefeChangePlan(plan([provision, ...aufbau], NEU), ctx);
    expect(r.fehler).toEqual([]);
  });
  it('ohne provision_vm und ohne Sicherung → Sicherung und Rückweg verlangt', () => {
    const f = pruefeChangePlan(plan(aufbau), ctx).fehler;
    expect(f.some(x => x.includes('fehlt eine Sicherung'))).toBe(true);
    for (const nr of [1, 2, 3, 4, 5]) expect(f.some(x => x.startsWith(`Schritt ${nr}:`) && x.includes('linux_sql') && x.includes('provision_vm')), `Schritt ${nr}`).toBe(true);
  });
  it('mit Sicherung, aber ohne Bereitstellung derselben VM → Rückweg verlangt; Bereitstellung der VM im selben Change → zulässig', () => {
    const snap = { titel: 'Snapshot', art: 'aktion', skill: 'proxmox', aktion: 'create_snapshot', parameter: { vmid: 150, name: 'vor_sql' }, pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'agent_status', parameter: { vmid: 150 } } };
    const andere = { ...provision, parameter: { ...provision.parameter, hostname: 'anderevm' } };
    const f = pruefeChangePlan(plan([snap, andere, ...aufbau]), ctx).fehler;
    expect(f.filter(x => x.includes('linux_sql')).length).toBe(5);
    expect(f.some(x => x.includes('fehlt eine Sicherung'))).toBe(false);
    expect(pruefeChangePlan(plan([snap, provision, ...aufbau]), ctx).fehler).toEqual([]);
    // Bereitstellung erst NACH dem Schritt zählt nicht
    const spaet = pruefeChangePlan(plan([snap, aufbau[0], provision, ...aufbau.slice(1)]), ctx).fehler;
    expect(spaet.filter(x => x.includes('linux_sql'))).toHaveLength(1);
    expect(spaet[0]).toMatch(/^Schritt 2:/);
  });
  it('ohneSicherungGrund allein erlaubt die Aktionen ohne Rückweg (bestehende VM, Owner-Begründung)', () => {
    expect(pruefeChangePlan(plan(aufbau, NEU), ctx).fehler).toEqual([]);
  });
  it('ein anderer Skill mit gleichem Aktionsnamen gewinnt dadurch nichts (Regel gilt nur für linux_sql)', () => {
    const fremd = { metadata: { name: 'fremd', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['installieren', 'login_anlegen'] } } } } };
    const c2 = { ...ctx, skill: (n: string) => (n === 'fremd' ? fremd : ctx.skill(n)) as never };
    const f = pruefeChangePlan(plan([provision, { titel: 'x', art: 'aktion', skill: 'fremd', aktion: 'installieren', parameter: {}, rueckweg: keiner }], NEU), c2).fehler;
    expect(f.some(x => x.startsWith('Schritt 2:') && x.includes('ohne Rückweg nur bei'))).toBe(true);
    expect(f.some(x => x.startsWith('Schritt 2:') && x.includes('pruefung fehlt'))).toBe(true);
  });
  it('alle Aufbau-Aktionen prüfen sich selbst — Prüfung optional', () => {
    const ohnePruefung = aufbau.slice(0, 5).map(({ pruefung: _p, ...s }) => s);
    expect(pruefeChangePlan(plan([provision, ...ohnePruefung], NEU), ctx).fehler).toEqual([]);
  });
  it('erwartet außerhalb des festen Wortlauts von linux_sql.status wird abgewiesen', () => {
    const f = pruefeChangePlan(plan([provision, { ...aufbau[1], pruefung: status('SQL läuft prima') }], NEU), ctx).fehler;
    expect(f.some(x => x.includes('linux_sql.status') && x.includes('kommt in der Antwort'))).toBe(true);
  });
});

describe('I8e Task 3 — Werkzeugwahl', () => {
  it('linux_sql und Ubuntu wählen die Infrastruktur-Kategorie', async () => {
    const { selectCategoriesOhneRueckfall } = await import('../skill-filter.js');
    const alle = new Set(['core', 'automation', 'infrastructure', 'productivity'] as never[]);
    expect([...(selectCategoriesOhneRueckfall('Was meldet linux_sql für vm7?', alle as never) ?? [])]).toContain('infrastructure');
    expect([...(selectCategoriesOhneRueckfall('Wie geht es der Ubuntu-Maschine?', alle as never) ?? [])]).toContain('infrastructure');
  });
});

// ── Fix-Runde 1: keine stillen Änderungen an bestehenden Instanzen ─────────────────────────────────────────────────────────────
describe('I8e Task 3 Fix 1 — bestehende VM, Wortlaut, Tresor-Namen', () => {
  const skill = new LinuxSqlSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const proxmox = { metadata: { name: 'proxmox', inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['provision_vm', 'delete_vm', 'create_snapshot', 'agent_status'] }, hostname: { type: 'string' }, vmid: { type: 'number' }, name: { type: 'string' },
  }, required: ['action'] } } };
  const cmdb = new Set(['pve1', 'pve2', 'sqlalt01']);
  const ctx = { skill: (n: string) => (n === 'linux_sql' ? skill : n === 'proxmox' ? proxmox : undefined) as never, asset: (n: string) => (cmdb.has(n.toLowerCase()) ? { id: `a-${n}`, name: n } : undefined), changes: [] };
  const snap = { titel: 'Snapshot', art: 'aktion', skill: 'proxmox', aktion: 'create_snapshot', parameter: { vmid: 150, name: 'vor_sql' }, pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'agent_status', parameter: { vmid: 150 } } };
  const prov = (hostname: string) => ({ titel: 'VM', art: 'aktion', skill: 'proxmox', aktion: 'provision_vm', parameter: { hostname }, rueckweg: { skill: 'proxmox', aktion: 'delete_vm', parameter: { vmid: 160 } }, pruefung: { typ: 'ping', ziel: '10.0.0.1' } });
  const inst = (zugang: string) => ({ titel: 'Installieren', art: 'aktion', skill: 'linux_sql', aktion: 'installieren', parameter: { zugang, version: '17.0.4006.2-1' }, zeitlimitS: 1800, rueckweg: { keiner: 'Neuaufbau' } });
  const plan = (schritte: unknown[]) => ({ titel: 'SQL aufbauen', begruendung: 'I8e Paket 1 Fix-Runde 1', typ: 'normal', risiko: 'mittel', ausfallMinuten: 0, betroffen: ['pve1'], schritte });

  it('provision_vm für einen Namen, den die CMDB schon kennt, zählt nicht als Neuaufbau → Rückweg verlangt', () => {
    expect(pruefeChangePlan(plan([snap, prov('sqlneu01'), inst('sqlneu01')]), ctx).fehler).toEqual([]);
    const f = pruefeChangePlan(plan([snap, prov('SQLALT01'), inst('sqlalt01')]), ctx).fehler;
    expect(f.some(x => x.startsWith('Schritt 3:') && x.includes('ohne Rückweg nur beim Neuaufbau') && x.includes('CMDB'))).toBe(true);
  });

  it('FESTE_AUSGABEN: jede Variante des Statustexts passt genau auf eine Vorlage, ihre festen Stücke bestehen die erwartet-Prüfung', () => {
    const vorlagen = FESTE_AUSGABEN['linux_sql.status']!.split(' | ');
    const alsMuster = (v: string) => new RegExp(`^${v.split(/\{[a-z]+\}/).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?')}$`);
    const varianten: Array<[string, string[]]> = [
      [linuxSqlStatusText('sqllnx01', STATUS_VOLL), ['Dienst aktiv, aktiviert', 'Speicherlimit', 'max server memory', 'Datendateien', 'eingehängt: data, log, tempdb, backup']],
      [linuxSqlStatusText('sqllnx01', { ...STATUS_VOLL, sql: { ...STATUS_VOLL.sql, datenbanken: [{ name: 'master' }] } }), ['Datenbanken:', 'Dienst aktiv, aktiviert']],
      [linuxSqlStatusText('sqllnx01', { zustand: 'gelesen', installiert: false, platz: [] }), ['SQL Server', 'eingehängt:']],
      [linuxSqlStatusText('sqllnx01', { ...STATUS_VOLL, sql: null, sqlHinweis: 'ohne sa-Kennwort nur Betriebssystem-Sicht' }), ['(Paket)', 'SQL-Sicht:', 'Dienst aktiv, aktiviert', 'Speicherlimit']],
      [linuxSqlStatusText('sqllnx01', { ...STATUS_VOLL, dienst: 'failed', aktiviert: 'disabled', sql: null, sqlHinweis: 'Dienst nicht aktiv' }), ['(Paket)', 'SQL-Sicht:']],
      // Ruling R11: Zeitteil am Ende — positiv nur „Zeit synchron (DC)“
      [linuxSqlStatusText('sqllnx01', { ...STATUS_VOLL, zeit: { dropin: 'alfred', synchronisiert: 'yes', server: '10.203.29.2', dc: true } }), ['Zeit synchron (DC)', 'Dienst aktiv, aktiviert']],
      [linuxSqlStatusText('sqllnxcfg', { zustand: 'gelesen', installiert: false, platz: [], zeit: { dropin: 'alfred', synchronisiert: 'no', server: null, dc: false } }), ['SQL Server']],
      [linuxSqlStatusText('sqllnx02', { ...STATUS_VOLL, sql: null, sqlHinweis: 'x', zeit: { dropin: 'fehlt', synchronisiert: 'no', server: '185.125.190.56', dc: false } }), ['(Paket)']],
    ];
    for (const [text, stuecke] of varianten) {
      expect(vorlagen.filter(v => alsMuster(v).test(text)), text).toHaveLength(1);
      for (const e of stuecke) {
        expect(text, e).toContain(e);
        const schritt = { titel: 'Abschluss', art: 'pruefung', pruefung: { typ: 'skill', skill: 'linux_sql', aktion: 'status', parameter: { zugang: 'sqllnx01' }, erwartet: e } };
        expect(pruefeChangePlan(plan([schritt]), ctx).fehler, e).toEqual([]);
      }
    }
  });

  it('R11: Zeitteil des Status — fester Wortlaut je Lage', () => {
    expect(zeitText({ dropin: 'alfred', synchronisiert: 'yes', server: '10.203.29.3', dc: true })).toBe('Zeit synchron (DC) — Server 10.203.29.3');
    expect(zeitText({ dropin: 'alfred', synchronisiert: 'no', server: '10.203.29.2', dc: true })).toBe('Zeit NICHT synchron (Zeitquelle DC eingerichtet; NTPSynchronized no, Server 10.203.29.2)');
    // synchron, aber mit einem anderen Server (z. B. per DHCP) zählt nicht als DC-Zeit
    expect(zeitText({ dropin: 'alfred', synchronisiert: 'yes', server: '192.168.1.1', dc: false })).toContain('Zeit NICHT synchron');
    expect(zeitText({ dropin: 'fehlt', synchronisiert: 'no', server: null, dc: false })).toBe('Zeit ohne DC-Zeitquelle (Drop-in fehlt; NTPSynchronized no, Server keiner)');
    expect(zeitText(undefined)).toBe('Zeit unbekannt');
    expect(FESTE_AUSGABEN['linux_sql.status']).toContain(' | Zeit synchron (DC)');
  });

  it('pruefeEingabe: Tresor-Name des sa-Kennworts zu lang → abgewiesen (installieren, login_anlegen)', () => {
    const lang = `s${'q'.repeat(55)}`;
    expect(skill.pruefeEingabe({ action: 'installieren', zugang: lang, version: '17.0.4006.2-1' })).toContain('Tresor');
    expect(skill.pruefeEingabe({ action: 'login_anlegen', zugang: lang, login: 'app', rolle: 'lesen' })).toContain('Tresor');
    expect(skill.pruefeEingabe({ action: 'installieren', zugang: 'sqllnx01', version: '17.0.4006.2-1' })).toBeUndefined();
  });

  it('Abweichungen der Bausteine (zusätzliche Serverrolle, fremde Datenbank) kommen als Fehler, nie als „nichts zu tun“', async () => {
    const w = welt({
      [LINUX_SQL_BAUSTEINE.login]: [{ zustand: 'fehler', fehler: 'Login: Msg 50003 Login app hat zusaetzlich sysadmin - nicht still entfernt; bitte bewusst entscheiden' }],
      [LINUX_SQL_BAUSTEINE.pruefdaten]: [{ zustand: 'fehler', fehler: 'Prüfdaten: Msg 50004 Datenbank kunden ist eine fremde Datenbank - nichts geaendert' }],
    }, { 'sqllnx-sqllnx01-sa': 'Sa-F', 'sqllnx-sqllnx01-app': 'Kw-F' });
    const l = await w.skill.execute({ action: 'login_anlegen', zugang: 'sqllnx01', login: 'app', rolle: 'lesen' }, imChange);
    expect(l.success).toBe(false);
    expect(l.error).toContain('zusaetzlich sysadmin');
    const p = await w.skill.execute({ action: 'pruefdaten_anlegen', zugang: 'sqllnx01', datenbank: 'kunden' }, imChange);
    expect(p.success).toBe(false);
    expect(p.error).toContain('fremde Datenbank');
  });
});
