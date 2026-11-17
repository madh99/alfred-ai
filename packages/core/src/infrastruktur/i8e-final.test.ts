import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { LinuxSqlSkill, linuxSqlStatusText, linuxSqlSicherungenText, LINUX_SQL_MIN_ZEITLIMIT_S, type LinuxSqlStatus } from './linux-sql-skill.js';
import { LINUX_SQL_BAUSTEINE, sqlSkript, installSkript, sqlKopf, shQ, sqlErgebnis, statusSkript, PY_STATUS } from './linux-sql.js';
import { LINUX_SQL_SICHERUNG_BAUSTEINE, sicherungJetztSkript, sicherungenSkript, wiederherstellenSkript, kettengrenzenSkript, KOPIE_FASSUNG } from './linux-sql-sicherung.js';
import { pruefeChangePlan, FESTE_AUSGABEN } from './change-schritte.js';
import { freigabeSkript } from './windows-cluster.js';
import { WindowsClusterSkill } from './windows-cluster-skill.js';

// I8e Paket 1 — abschließende Fix-Welle: nichts ändert oder löscht still

const imChange = { ausChange: true } as never;
const BASH = (() => { const r = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }); return r.status === 0 && /^\d+\./.test(r.stdout.trim()); })();

function welt(antworten: Record<string, Array<Record<string, unknown> | { code: number; stdout: string }>>, tresorDa: Record<string, string> = {}) {
  const aufrufe: Array<{ baustein: string; parameter: unknown; eingabe?: string }> = [];
  const reihenfolge: string[] = [];
  const tresor = new Map<string, string>(Object.entries(tresorDa));
  const gesetzt: string[] = [];
  const skill = new LinuxSqlSkill({
    skript: async (_z, baustein, parameter, eingabe) => {
      aufrufe.push({ baustein, parameter, ...(eingabe !== undefined ? { eingabe } : {}) }); reihenfolge.push(`aufruf:${baustein}`);
      const liste = antworten[baustein] ?? [];
      const a = liste.length > 1 ? liste.shift()! : liste[0];
      if (!a) return { code: 1, stdout: '', stderr: 'kein Stub' };
      if ('code' in a && 'stdout' in a) return { code: a.code as number, stdout: a.stdout as string, stderr: '' };
      return { code: a.zustand === 'fehler' ? 1 : 0, stdout: `ALFRED-SQL ${JSON.stringify(a)}\n`, stderr: '' };
    },
    tresor: { namen: async () => new Set(tresor.keys()), lies: async n => tresor.get(n)!, setze: async (n, w) => { gesetzt.push(n); reihenfolge.push(`setze:${n}`); tresor.set(n, w); } },
  });
  return { skill, aufrufe, gesetzt, reihenfolge, tresor };
}

describe('I-1: Mindest-zeitlimitS je linux_sql-Aktion', () => {
  const skill = new LinuxSqlSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const ctx = { skill: (n: string) => (n === 'linux_sql' ? skill : undefined) as never, asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
  const plan = (schritt: Record<string, unknown>) => ({ titel: 'Fix-Welle Zeitlimit', begruendung: 'I8e Fix-Welle I-1 Mindest-zeitlimitS', typ: 'normal', risiko: 'low', ausfallMinuten: 0, betroffen: ['sqllnx01'], ohneSicherungGrund: 'neu', schritte: [schritt] });
  const inst = { titel: 'Installieren', art: 'aktion', skill: 'linux_sql', aktion: 'installieren', parameter: { zugang: 'sqllnx01', version: '17.0.4006.2-1' }, rueckweg: { keiner: 'neu' } };
  it('Werte aus den Baustein-Zeitgrenzen + 60 s; Standard 600 s bei installieren → Fehler mit dem Mindestwert', () => {
    expect(LINUX_SQL_MIN_ZEITLIMIT_S.installieren).toBe(1560);
    // Nachtrag: Summe der Baustein-Grenzen + 60 s je Baustein (4 Bausteine)
    expect(LINUX_SQL_MIN_ZEITLIMIT_S.konfigurieren).toBe(1020);
    expect(LINUX_SQL_MIN_ZEITLIMIT_S.sicherung_einrichten).toBe(1260);
    expect(LINUX_SQL_MIN_ZEITLIMIT_S.sicherung_jetzt).toBe(3060);
    expect(LINUX_SQL_MIN_ZEITLIMIT_S.wiederherstellen_pruefen).toBe(3560);
    const f = pruefeChangePlan(plan(inst), ctx).fehler;
    expect(f.join(' | ')).toContain('zeitlimitS 600 zu klein für linux_sql.installieren — mindestens 1560 s');
    expect(pruefeChangePlan(plan({ ...inst, zeitlimitS: 1560 }), ctx).fehler).toEqual([]);
    expect(skill.metadata.description).toContain('installieren 1560 s');
    expect(skill.metadata.description).toContain('wiederherstellen_pruefen 3560 s');
  });
});

describe('I-2: Kennwörter nie still zurückgesetzt, Tresor erst nach Erfolg', () => {
  it('Login-T-SQL: bestehender Login mit anderem Kennwort → THROW vor jeder Änderung, kein ALTER LOGIN … PASSWORD', () => {
    const t = sqlSkript('login', { name: 'app_kunden', serverrollen: ['dbcreator'] });
    expect(t).not.toMatch(/ALTER LOGIN \[app_kunden\] WITH PASSWORD/);
    expect(t).toContain('Login besteht mit anderem Kennwort');
    expect(t).toContain('nicht still zurückgesetzt; bitte bewusst entscheiden');
    const neu = sqlSkript('login', { name: 'app_kunden', serverrollen: [], nurNeu: true });
    expect(neu).toContain('Kennwort nicht im Tresor');
  });
  it('login_anlegen: Tresor-Eintrag fehlt → nurNeu, Kennwort erst nach Erfolg im Tresor; Fehler → kein Tresor-Eintrag', async () => {
    const ok = welt({ [LINUX_SQL_BAUSTEINE.login]: [{ zustand: 'angelegt' }] }, { 'sqllnx-sqllnx01-sa': 'Sa-1' });
    expect((await ok.skill.execute({ action: 'login_anlegen', zugang: 'sqllnx01', login: 'app_kunden', rolle: 'lesen' }, imChange)).success).toBe(true);
    expect(ok.aufrufe[0]!.parameter).toMatchObject({ nurNeu: true });
    expect(ok.reihenfolge).toEqual([`aufruf:${LINUX_SQL_BAUSTEINE.login}`, 'setze:sqllnx-sqllnx01-app_kunden']);
    const nein = welt({ [LINUX_SQL_BAUSTEINE.login]: [{ zustand: 'fehler', fehler: 'Login app_kunden besteht schon, Kennwort nicht im Tresor - nichts geändert' }] }, { 'sqllnx-sqllnx01-sa': 'Sa-1' });
    const r = await nein.skill.execute({ action: 'login_anlegen', zugang: 'sqllnx01', login: 'app_kunden', rolle: 'lesen' }, imChange);
    expect(r.success).toBe(false);
    expect(nein.gesetzt).toEqual([]);
    const da = welt({ [LINUX_SQL_BAUSTEINE.login]: [{ zustand: 'schon' }] }, { 'sqllnx-sqllnx01-sa': 'Sa-1', 'sqllnx-sqllnx01-app_kunden': 'Kw-1' });
    await da.skill.execute({ action: 'login_anlegen', zugang: 'sqllnx01', login: 'app_kunden', rolle: 'lesen' }, imChange);
    expect(da.aufrufe[0]!.parameter).toMatchObject({ nurNeu: false });
  });
  it('installieren: SQL schon installiert ohne Tresor-Eintrag → Abbruch ohne Änderung; neues sa erst nach gelungenem Setup in den Tresor', () => {
    const s = installSkript({ version: '17.0.4006.2-1', edition: 'EnterpriseDeveloper', saNeu: true });
    const pruef = s.indexOf('sa-Kennwort nicht im Tresor');
    expect(pruef).toBeGreaterThan(0);
    expect(pruef).toBeLessThan(s.indexOf('apt-get'));
    expect(s.indexOf('ALFRED-SA-GESETZT')).toBeGreaterThan(s.indexOf('mssql-conf -n setup'));
  });
  it('installieren (Skill): Setze nach Erfolg; Fehler nach dem Setup (Marke) → trotzdem in den Tresor; Fehler davor → nicht', async () => {
    const ok = { zustand: 'geaendert', paket: '17.0.4006.2-1', version: '17.0.4006.2', edition: 'Enterprise Developer', dienst: 'active' };
    const w = welt({ [LINUX_SQL_BAUSTEINE.installation]: [ok] });
    expect((await w.skill.execute({ action: 'installieren', zugang: 'sqllnx01', version: '17.0.4006.2-1' }, imChange)).success).toBe(true);
    expect(w.aufrufe[0]!.parameter).toMatchObject({ saNeu: true });
    expect(w.reihenfolge).toEqual([`aufruf:${LINUX_SQL_BAUSTEINE.installation}`, 'setze:sqllnx-sqllnx01-sa']);
    const nach = welt({ [LINUX_SQL_BAUSTEINE.installation]: [{ code: 1, stdout: 'ALFRED-SA-GESETZT\nALFRED-SQL {"zustand":"fehler","fehler":"Dienst startet nicht"}' }] });
    expect((await nach.skill.execute({ action: 'installieren', zugang: 'sqllnx01', version: '17.0.4006.2-1' }, imChange)).success).toBe(false);
    expect(nach.gesetzt).toEqual(['sqllnx-sqllnx01-sa']);
    const vor = welt({ [LINUX_SQL_BAUSTEINE.installation]: [{ zustand: 'fehler', fehler: 'SQL Server ist schon installiert, sa-Kennwort nicht im Tresor - nichts geändert' }] });
    expect((await vor.skill.execute({ action: 'installieren', zugang: 'sqllnx01', version: '17.0.4006.2-1' }, imChange)).success).toBe(false);
    expect(vor.gesetzt).toEqual([]);
  });
});

describe('M-3/M-5/M-6: Uhrzeit, Reste, Aufräumen', () => {
  const st = (k: Record<string, unknown>, extra: Partial<LinuxSqlStatus> = {}): LinuxSqlStatus => ({ zustand: 'gelesen', installiert: false, platz: [], sicherung: { zugangsdatei: 'vorhanden (0600)', timer: 'active', letzteKopie: { zeit: '2026-11-16T12:00:00Z', ok: true, fehler: '', ...k } }, ...extra });
  it('Bericht aus der Zukunft (alterMin < -5) → „UHRZEIT ABWEICHEND“, nie ok', () => {
    expect(linuxSqlStatusText('x', st({ alterMin: -30 }))).toContain('letzte Kopie 2026-11-16T12:00:00Z UHRZEIT ABWEICHEND');
    expect(linuxSqlStatusText('x', st({ alterMin: -3 }))).toContain('letzte Kopie 2026-11-16T12:00:00Z ok');
    const l = { zustand: 'gelesen', ziel: '//fs01.ad.3033.at/X$', budgetBytes: 1, timer: 'active', zugangsdatei: 'vorhanden (0600)',
      status: { zeit: '2026-11-16T12:00:00Z', ok: true, frisch: false, alterMin: -30 }, datenbanken: { db1: { ketten: [{ full: '1', diffs: 0, logs: 1, vollstaendig: true }], fs01Dateien: 2, ausstehend: 0, fehlend: 0 } } };
    expect(linuxSqlSicherungenText('x', l as never)).toContain('Hash unbekannt (Uhrzeit abweichend: 2026-11-16T12:00:00Z)');
  });
  it('Reste (alte tempdb-Dateien, .alfred-wh-*, /run/alfred-c-*) erscheinen im Status und in sicherungen, nichts wird gelöscht', () => {
    const t = linuxSqlStatusText('x', st({ alterMin: 3 }, { reste: ['/var/opt/mssql/data/tempdb.mdf', '/run/alfred-c-abc'] }));
    expect(t).toContain('Reste: /var/opt/mssql/data/tempdb.mdf, /run/alfred-c-abc');
    const vorlagen = FESTE_AUSGABEN['linux_sql.status']!.split(' | ');
    const alsMuster = (v: string) => new RegExp(`^${v.split(/\{[a-z]+\}/).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?')}$`);
    expect(vorlagen.filter(v => alsMuster(v).test(t))).toHaveLength(1);
    const l = { zustand: 'gelesen', ziel: '//fs01.ad.3033.at/X$', budgetBytes: 1, timer: 'active', zugangsdatei: 'vorhanden (0600)', reste: ['/var/opt/mssql/backup/.alfred-wh-x'], datenbanken: {} };
    expect(linuxSqlSicherungenText('x', l as never)).toContain('Reste: /var/opt/mssql/backup/.alfred-wh-x');
  });
  it('tempdb-Baustein meldet alte Dateien nach der Verlegung (ohne Löschen)', () => {
    const t = sqlSkript('tempdb', { dateien: 4, groesseMB: 1024, wachstumMB: 512, logGroesseMB: 2048 });
    expect(t).toContain('altdateien');
    expect(t).not.toMatch(/\brm\b[^\n]*tempdb/);
  });
  it('Kopf jedes Bausteins räumt alte /run/alfred-c-* (älter als 120 min) weg', () => {
    expect(sqlKopf('sql.status', {}).join('\n')).toContain("find /run -maxdepth 1 -type f -name 'alfred-c-*' -mmin +120 -delete");
  });
});

describe('M-4: Wahrheitswerte nur als true/false', () => {
  it('agent als Zeichenkette → Fehler beim Planen und zur Laufzeit, ohne Fernaufruf', async () => {
    const w = welt({}, { 'sqllnx-sqllnx01-sa': 'Sa-1' });
    for (const agent of ['false', 'true', 0, 1, 'nein']) {
      expect(w.skill.pruefeEingabe({ action: 'konfigurieren', zugang: 'sqllnx01', agent }), String(agent)).toContain('agent');
      expect((await w.skill.execute({ action: 'konfigurieren', zugang: 'sqllnx01', agent, tempdb_dateien: 4 }, imChange)).error, String(agent)).toContain('agent');
    }
    expect(w.aufrufe).toEqual([]);
    expect(w.skill.pruefeEingabe({ action: 'konfigurieren', zugang: 'sqllnx01', agent: false })).toBeUndefined();
  });
});

describe('M-7: verlangtes Kontingent ohne FSRM → Fehler vor jeder Änderung', () => {
  it('Skript bricht vor Set-Acl ab; Skill meldet „kontingent fehlt“ als Fehler mit Hinweis auf features_installieren', async () => {
    const s = freigabeSkript({ name: 'SQLLinuxBackup$', pfad: 'S:\\SQLLinuxBackup', vollzugriff: [], aendern: ['AD3033\\svc-sqllnx-backup'], kontingentGib: 64 });
    const abbruch = s.indexOf('FS-Resource-Manager fehlt');
    expect(abbruch).toBeGreaterThan(0);
    expect(abbruch).toBeLessThan(s.indexOf('Set-Acl -Path'));
    const skill = new WindowsClusterSkill({ skript: async () => ({ code: 0, stdout: `ALFRED-AD ${JSON.stringify({ unc: 'x', zustand: 'neu', rechte: [], kontingent: 'fehlt' })}`, stderr: '' }), schlafe: async () => undefined });
    const r = await skill.execute({ action: 'freigabe_anlegen', zugang: 'fs01', name: 'SQLLinuxBackup$', pfad: 'S:\\SQLLinuxBackup', aendern: ['AD3033\\svc-sqllnx-backup'], kontingent_gib: 64 }, imChange);
    expect(r.success).toBe(false);
    expect(r.error).toContain('features_installieren');
  });
});

describe('M-8: Fassung des installierten Kopier-Skripts', () => {
  it('sicherungen, sicherung_jetzt und wiederherstellen prüfen die Fassung; Abweichung → „Sicherung neu einrichten“', () => {
    expect(KOPIE_FASSUNG.kette).toMatch(/^[0-9a-f]{64}$/);
    for (const s of [sicherungenSkript(), sicherungJetztSkript({ art: 'LOG', datenbank: 'pruefdb01' }), wiederherstellenSkript({ datenbank: 'pruefdb01', ziel: 'alfred_wh_pruefdb01' })]) {
      expect(s).toContain(KOPIE_FASSUNG.kette);
      expect(s).toContain(KOPIE_FASSUNG.kopie);
      expect(s).toContain('Sicherung neu einrichten (Fassung');
    }
  });
  it.skipIf(!BASH)('ausgeführt: abweichende installierte Fassung → Abbruch vor jedem Sichern', () => {
    const skript = sicherungJetztSkript({ art: 'LOG', datenbank: 'pruefdb01' });
    const stubs = ["feld() { printf '%s' 'Sa-1'; }", 'bereit() { :; }', 'json_text() { local x; x=$(cat); printf \'"%s"\' "${x//\\"/}"; }',
      'systemctl() { :; }', "installiert_sha() { echo 0000; }", 'sql() { echo "SQL $1" >&2; echo ALFRED|x; }'];
    const text = skript.replace('# ALFRED-ABLAUF', () => `${stubs.join('\n')}\n# ALFRED-ABLAUF`);
    const r = spawnSync('bash', [], { input: `ALFRED_EINGABE=''\n( ${text}\n)\necho "RC=$?"`, encoding: 'utf8' });
    expect(r.stdout).toContain('RC=1');
    expect(String(sqlErgebnis<Record<string, unknown>>(r.stdout)?.fehler)).toContain('Sicherung neu einrichten (Fassung');
    expect(r.stderr).not.toContain('SQL EXEC');
  });
});

describe('M-9: Prüfstück je Datenbank', () => {
  const skill = new LinuxSqlSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const ctx = { skill: (n: string) => (n === 'linux_sql' ? skill : undefined) as never, asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
  const pr = (erwartet: string) => ({ titel: 'Fix-Welle Prüfstück', begruendung: 'I8e Fix-Welle M-9 Prüfstück je Datenbank', typ: 'normal', risiko: 'low', ausfallMinuten: 0, betroffen: ['x'], schritte: [{ titel: 'Prüfen', art: 'pruefung', pruefung: { typ: 'skill', skill: 'linux_sql', aktion: 'sicherungen', parameter: { zugang: 'sqllnx01' }, erwartet } }] });
  it('Text enthält „<db>: vollständig auf fs01“; nur dieses Stück ist als erwartet zulässig, das nackte nicht', () => {
    const l = { zustand: 'gelesen', ziel: '//fs01.ad.3033.at/X$', budgetBytes: 1, timer: 'active', zugangsdatei: 'vorhanden (0600)',
      status: { zeit: '2026-11-16T12:00:00Z', ok: true, frisch: true, alterMin: 3 }, datenbanken: { pruefdb01: { ketten: [{ full: '1', diffs: 0, logs: 1, vollstaendig: true }], fs01Dateien: 2, ausstehend: 0, fehlend: 0 } } };
    expect(linuxSqlSicherungenText('x', l as never)).toContain('pruefdb01: vollständig auf fs01');
    expect(pruefeChangePlan(pr('pruefdb01: vollständig auf fs01'), ctx).fehler).toEqual([]);
    expect(pruefeChangePlan(pr('vollständig auf fs01'), ctx).fehler.join(' ')).toContain('kommt in der Antwort');
  });
});

describe('Nachtrag N-1 / Restpunkte', () => {
  it('kettengrenzen prüft die Fassung; Anzeige nennt die übernommenen Grenzen', async () => {
    const s = kettengrenzenSkript();
    expect(s).toContain(KOPIE_FASSUNG.kette);
    expect(s.split('# ALFRED-ABLAUF')[1]).toContain('fassung_pruefen');
    const w = welt({ [LINUX_SQL_SICHERUNG_BAUSTEINE.grenzen]: [{ zustand: 'geaendert', unterschied: [{ datenbank: 'pruefdb01', lokal: 0, fs01: 1, grenzen: [{ full: '20261103003000', ersterBezug: '20261102180500', letztes: '20261103180500' }] }] }] }, { 'ad-svc-sqllnx-backup': 'Fs-1' });
    const r = await w.skill.execute({ action: 'kettengrenzen_uebernehmen', zugang: 'sqllnx01' }, imChange);
    expect(r.display).toContain('übernommen: 20261103003000 (Bezug 20261102180500, letztes 20261103180500)');
    expect(r.display).toContain('Aufbewahrung');
  });
  it.skipIf(!BASH)('Ergebniszeile nennt entfernte alte Zugangsdateien (nur wenn welche entfernt wurden)', () => {
    const kopf = sqlKopf('sql.status', {}).join('\n');
    const lauf = (n: number) => spawnSync('bash', [], { input: `ALFRED_EINGABE=''\n( ${kopf}\nALFRED_RESTE=${n}\nergebnis '{"zustand":"schon"}'\n)`, encoding: 'utf8' }).stdout;
    expect(sqlErgebnis(lauf(2))).toEqual({ zustand: 'schon', alteZugangsdateienEntfernt: 2 });
    expect(sqlErgebnis(lauf(0))).toEqual({ zustand: 'schon' });
  });
  it('Nachtrag 2 (M-B): status und sicherungen tragen alteZugangsdateienEntfernt; Notfallzeile auch; Anzeige ab 1', async () => {
    expect(statusSkript()).toContain('ALFRED_RESTE="${ALFRED_RESTE:-0}" python3 -c "$PY_STATUS"');
    expect(PY_STATUS).toContain('alteZugangsdateienEntfernt');
    expect(sicherungenSkript()).toContain('"${ALFRED_RESTE:-0}"');
    expect(sqlKopf('x', {}).join('\n')).toMatch(/trap '[^\n]*alteZugangsdateienEntfernt/);
    const st = { zustand: 'gelesen', installiert: false, platz: [], alteZugangsdateienEntfernt: 3 } as unknown as LinuxSqlStatus;
    expect(linuxSqlStatusText('x', st)).toContain('alte Zugangsdateien entfernt: 3');
    expect(linuxSqlStatusText('x', { ...st, alteZugangsdateienEntfernt: 0 } as LinuxSqlStatus)).not.toContain('alte Zugangsdateien');
    const l = { zustand: 'gelesen', ziel: '//fs01.ad.3033.at/X$', budgetBytes: 1, timer: 'active', zugangsdatei: 'vorhanden (0600)', datenbanken: {}, alteZugangsdateienEntfernt: 2 };
    expect(linuxSqlSicherungenText('x', l as never)).toContain('alte Zugangsdateien entfernt: 2');
    const w = welt({ [LINUX_SQL_BAUSTEINE.platten]: [{ zustand: 'schon', platten: [], alteZugangsdateienEntfernt: 4 }] });
    const r = await w.skill.execute({ action: 'platten_einrichten', zugang: 'sqllnx01', platten: [{ scsi: 1, groesse_gib: 16, ziel: 'data' }] }, imChange);
    expect(r.display).toContain('alte Zugangsdateien entfernt: 4');
  });
  it('Modulkopf dokumentiert sa-Wiederherstellung nach SSH-Verlust', () => {
    const quelle = readFileSync(new URL('./linux-sql.ts', import.meta.url), 'utf8');
    expect(quelle).toContain('mssql-conf set-sa-password');
    expect(quelle).toContain('älter als 120 min');
  });
});

describe('M-1: kettengrenzen_uebernehmen (nur im Change)', () => {
  it('Baustein hängt fs01 nur lesend ein, zeigt den Unterschied, schreibt die lokale Datei; Skill nur im Change', async () => {
    const s = kettengrenzenSkript();
    expect(s).toContain('fs01_einhaengen ro');
    expect(s).toContain(' grenzen_uebernehmen ');
    const w = welt({ [LINUX_SQL_SICHERUNG_BAUSTEINE.grenzen]: [{ zustand: 'geaendert', unterschied: [{ datenbank: 'pruefdb01', lokal: 0, fs01: 3 }] }] }, { 'ad-svc-sqllnx-backup': 'Fs-1' });
    expect((await w.skill.execute({ action: 'kettengrenzen_uebernehmen', zugang: 'sqllnx01' }, {} as never)).error).toContain('nur als Schritt');
    const r = await w.skill.execute({ action: 'kettengrenzen_uebernehmen', zugang: 'sqllnx01' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toContain('pruefdb01: lokal 0 → fs01 3');
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ kennwort: 'Fs-1' });
  });
});

void shQ;
