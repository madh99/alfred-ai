import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  LINUX_SQL_SICHERUNG_BAUSTEINE, LINUX_SQL_SICHERUNG_ZEIT_MS, CIFS_UTILS_VERSION, ZUGANGSDATEI_FEST, PY_KETTE, KOPIE_SH, SICHERUNG_PROZEDUR, PRUEF_SELECT,
  pruefeSicherungEinrichten, sicherungEinrichtenSkript, pruefeSicherungJetzt, sicherungJetztSkript, sicherungenSkript, pruefeWiederherstellen, wiederherstellenSkript,
  sicherungJobsTsql, CIFS_OPTIONEN, kettengrenzenSkript, PROZEDUR_DEFINITION, PY_ROLLEN,
} from './linux-sql-sicherung.js';
import { sqlErgebnis, shQ, sqlSkript, PRUEFDATEN_SHA256, PRUEFDATEN_ZEILEN } from './linux-sql.js';
import { linuxBausteinBekannt, linuxBausteinSkript } from '../fernzugriff/linux-bausteine.js';

// Synchrone Bash-/Python-Läufe (spawnSync) blockieren den Worker; ohne Rückgabe an die Ereignisschleife zwischen den Tests
// kommt die RPC-Antwort von vitest zu spät („Timeout calling onTaskUpdate“) — nach jedem Test einmal abgeben
afterEach(() => new Promise<void>(r => setImmediate(r)));

// I8e Task 4 — Sicherung (FULL/DIFF/LOG über den SQL-Agent), geprüfte Kopie nach fs01, Aufbewahrung nur vollständiger Ketten,
// Budget, Wiederherstellungs-Beweis aus der fs01-Kopie

const EINRICHTEN = { server: 'fs01.ad.3033.at', freigabe: 'SQLLinuxBackup$', konto: 'svc-sqllnx-backup', domaene: 'AD3033', budgetGiB: 64 };
const BOESE = ['; rm -rf /', '$(id)', '`id`', 'a\nb', "x' ; id ; '", '../x', 'a b', 'a"b', 'a,b', 'a=b'];

const BASH = (() => {
  const r = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' });
  return r.status === 0 && /^\d+\./.test(r.stdout.trim());
})();
const PYTHON = (() => {
  for (const p of ['python3', 'python']) {
    const r = spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '3') return p;
  }
  return undefined;
})();

function alleSkripte(): Array<[string, string]> {
  return [
    ['einrichten', sicherungEinrichtenSkript(EINRICHTEN)],
    ['jetzt', sicherungJetztSkript({ art: 'LOG', datenbank: 'pruefdb01' })],
    ['liste', sicherungenSkript()],
    ['wiederherstellen', wiederherstellenSkript({ datenbank: 'pruefdb01', ziel: 'alfred_wh_pruefdb01' })],
    ['kettengrenzen', kettengrenzenSkript()],
  ];
}

describe('I8e Task 4 — Register, Validatoren, Einschleusung', { timeout: 120_000 }, () => {
  it('alle Bausteine registriert, Zeitgrenzen ≥ 65 s', () => {
    for (const k of Object.values(LINUX_SQL_SICHERUNG_BAUSTEINE)) expect(linuxBausteinBekannt(k), k).toBe(true);
    for (const ms of Object.values(LINUX_SQL_SICHERUNG_ZEIT_MS)) expect(ms).toBeGreaterThanOrEqual(65_000);
    expect(linuxBausteinSkript(LINUX_SQL_SICHERUNG_BAUSTEINE.liste, {})).toBe(sicherungenSkript());
  });
  it('sicherung_einrichten: Server FQDN, Freigabe, Konto, Domäne, Budget, cifs-Version — jeder Einschleusversuch abgewiesen', () => {
    expect(pruefeSicherungEinrichten(EINRICHTEN)).toBeUndefined();
    expect(pruefeSicherungEinrichten({ ...EINRICHTEN, cifsVersion: '2:7.0-2ubuntu0.6' })).toBeUndefined();
    for (const b of BOESE) {
      expect(pruefeSicherungEinrichten({ ...EINRICHTEN, server: `fs01${b}` }), b).toContain('server');
      expect(pruefeSicherungEinrichten({ ...EINRICHTEN, freigabe: `S${b}` }), b).toContain('freigabe');
      expect(pruefeSicherungEinrichten({ ...EINRICHTEN, konto: `svc${b}` }), b).toContain('konto');
      expect(pruefeSicherungEinrichten({ ...EINRICHTEN, domaene: `AD${b}` }), b).toContain('domaene');
      expect(pruefeSicherungEinrichten({ ...EINRICHTEN, cifsVersion: `2:7.0${b}` }), b).toContain('cifsVersion');
    }
    expect(pruefeSicherungEinrichten({ ...EINRICHTEN, server: 'fs01' })).toContain('server');
    // Fix-Runde 1 (Sicherheit): nur fs01, kein anderer Server; Freigabename ohne führende Sonderzeichen-Regel, höchstens 40 + $
    for (const fremd of ['fs02.ad.3033.at', 'boese.example.com', 'fs01.ad.3033.at.example.com', 'FS01.ad.3033.at']) expect(pruefeSicherungEinrichten({ ...EINRICHTEN, server: fremd }), fremd).toContain('nur der Dateiserver fs01.ad.3033.at');
    expect(pruefeSicherungEinrichten({ ...EINRICHTEN, freigabe: 'x'.repeat(41) })).toContain('freigabe');
    for (const g of [0, 0.5, 2000, '64', -1]) expect(pruefeSicherungEinrichten({ ...EINRICHTEN, budgetGiB: g }), String(g)).toContain('budgetGiB');
    expect(() => sicherungEinrichtenSkript({ ...EINRICHTEN, server: 'fs01.ad.3033.at;id' })).toThrow(/server/);
  });
  it('sicherung_jetzt / wiederherstellen: Art fest, Datenbank- und Zielname geprüft, Ziel nur alfred_wh_…', () => {
    expect(pruefeSicherungJetzt({ art: 'FULL', datenbank: 'pruefdb01' })).toBeUndefined();
    expect(pruefeSicherungJetzt({ art: 'full', datenbank: 'pruefdb01' })).toContain('art');
    expect(pruefeSicherungJetzt({ art: 'FULL', datenbank: 'master' })).toContain('datenbank');
    expect(pruefeWiederherstellen({ datenbank: 'pruefdb01', ziel: 'alfred_wh_pruefdb01' })).toBeUndefined();
    expect(pruefeWiederherstellen({ datenbank: 'pruefdb01', ziel: 'pruefdb01' })).toContain('ziel');
    expect(pruefeWiederherstellen({ datenbank: 'pruefdb01', ziel: 'alfred_wh_' })).toContain('ziel');
    for (const b of BOESE) {
      expect(pruefeSicherungJetzt({ art: 'FULL', datenbank: `db${b}` }), b).toContain('datenbank');
      expect(pruefeWiederherstellen({ datenbank: `db${b}`, ziel: 'alfred_wh_x' }), b).toContain('datenbank');
      expect(pruefeWiederherstellen({ datenbank: 'pruefdb01', ziel: `alfred_wh_x${b}` }), b).toContain('ziel');
    }
    expect(() => wiederherstellenSkript({ datenbank: 'pruefdb01', ziel: 'alfred_wh_x]; DROP DATABASE x; --' })).toThrow(/ziel/);
  });
  it('feste Werte: cifs-utils aus Ubuntu fest, Optionen mit Verschlüsselung (seal) und SMB 3.1.1, eine feste Zugangsdatei', () => {
    expect(CIFS_UTILS_VERSION).toBe('2:7.0-2ubuntu0.6');
    expect(CIFS_OPTIONEN).toContain('vers=3.1.1');
    expect(CIFS_OPTIONEN).toContain('sec=ntlmssp');
    expect(CIFS_OPTIONEN).toContain('seal');
    expect(CIFS_OPTIONEN).toContain('cache=none');
    expect(CIFS_OPTIONEN).toContain('file_mode=0600');
    expect(CIFS_OPTIONEN).toContain('dir_mode=0700');
    expect(ZUGANGSDATEI_FEST).toBe('/etc/alfred/sqllnx-cifs.cred');
  });
});

describe('I8e Task 4 — Skripttext', { timeout: 120_000 }, () => {
  it('jedes Skript: strikter Modus, Parameter-Literal, Eingabe nur per Here-String, kein Kennwort in Befehlszeilen', () => {
    for (const [name, s] of alleSkripte()) {
      expect(s, name).toMatch(/^set -euo pipefail\n/);
      expect(s, name).toContain('ALFRED_P=\'{');
      expect(s, name).not.toMatch(/set -x|set -o xtrace/);
      for (const m of s.matchAll(/\$\{?ALFRED_EINGABE\}?/g)) {
        const zeile = s.slice(s.lastIndexOf('\n', m.index!) + 1, s.indexOf('\n', m.index!));
        expect(zeile, `${name}: ${zeile}`).toMatch(/<<<"\$ALFRED_EINGABE"/);
      }
      expect(s, name).not.toMatch(/password=\$|-o [^\n]*pass(word)?=/);
      expect(s, name).not.toMatch(/sqlcmd[^\n]* -P /);
      expect(s, name).not.toMatch(/export (SA|KW|SQLCMDPASSWORD)/);
    }
  });
  it('Zugangsdatei unter /run (mktemp, 0600) nur per printf geschrieben und im Aufräumen (trap) entfernt', () => {
    for (const [name, s] of alleSkripte().filter(([n]) => n === 'wiederherstellen')) {
      expect(s, name).toContain('ZUGANGSDATEI=$(mktemp "$RUN_DIR/alfred-c-XXXXXXXXXXXX")');
      expect(s, name).toMatch(/alfred_aufraeumen\(\) \{[^\n]*rm -f -- "\$ZUGANGSDATEI"/);
    }
    // die feste Zugangsdatei des Timers: 0600 root, per mktemp im Zielordner + printf (Builtin), Zustand ohne Inhalt im Ergebnis
    const e = sicherungEinrichtenSkript(EINRICHTEN);
    expect(e).toContain(`ZUGANG_FEST='${ZUGANGSDATEI_FEST}'`);
    expect(e).toContain('install -d -m 0700 -o root -g root /etc/alfred /var/lib/alfred');
    expect(e).toContain('schreibe_wenn_anders "$ZUGANG_FEST" 600 "$(printf');
    expect(e).toContain('t=$(mktemp "$(dirname "$1")/.alfred-neu.XXXXXX")');
    expect(e).toContain('[ "$zd" = "vorhanden (0600)" ]');
    expect(e).not.toMatch(/echo[^\n]*\$KW/);
    // Fix-Runde 1 (Sicherheit): sicherungen liest weder Tresor-Eingabe noch fs01
    const l = sicherungenSkript().split('# ALFRED-ABLAUF')[1]!;
    expect(l).not.toContain('ALFRED_EINGABE');
    expect(l).not.toContain('feld ');
    expect(l).not.toContain('mount ');
    expect(l).not.toContain('SA=');
    expect(KOPIE_SH).toContain('credentials=$CRED');
    expect(KOPIE_SH).toContain("stat -c '%u:%a' \"$CRED\"");
    expect(KOPIE_SH).not.toMatch(/password/i);
  });
  it('SQL-Agent: drei Jobs FULL täglich, DIFF alle 6 h, LOG alle 15 min mit CHECKSUM und COMPRESSION; fremde Jobs → Abbruch vor jeder Änderung', () => {
    const t = sicherungJobsTsql();
    expect(t).toContain("N'alfred-sqllnx-full'");
    expect(t).toContain("N'alfred-sqllnx-diff'");
    expect(t).toContain("N'alfred-sqllnx-log'");
    expect(t).toMatch(/alfred-sqllnx-diff[^\n]*@freq_subday_type = 8, @freq_subday_interval = 6/);
    expect(t).toMatch(/alfred-sqllnx-log[^\n]*@freq_subday_type = 4, @freq_subday_interval = 15/);
    expect(t).toMatch(/alfred-sqllnx-full[^\n]*@freq_type = 4, @freq_interval = 1, @freq_subday_type = 1/);
    const fremd = t.indexOf('THROW 50020');
    expect(fremd).toBeGreaterThan(0);
    for (const x of ['sp_add_job ', 'sp_delete_job', 'sp_executesql @proc']) expect(t.indexOf(x), x).toBeGreaterThan(fremd);
    expect(SICHERUNG_PROZEDUR).toContain('WITH CHECKSUM, COMPRESSION');
    expect(SICHERUNG_PROZEDUR).toContain('WITH DIFFERENTIAL, CHECKSUM, COMPRESSION');
    expect(SICHERUNG_PROZEDUR).toContain("BACKUP LOG ");
    // Kettenschutz: Basis und Vorgänger müssen Alfred-Sicherungen sein, Protokollkette lückenlos, Sicherungen einer DB nacheinander
    expect(SICHERUNG_PROZEDUR).toContain('THROW 50014');
    expect(SICHERUNG_PROZEDUR).toContain('THROW 50015');
    expect(SICHERUNG_PROZEDUR).toContain('sp_getapplock');
    // Fix-Runde 1: Fertig-Marke erst nach erfolgreichem BACKUP
    const marke = SICHERUNG_PROZEDUR.indexOf('EXEC master.sys.xp_create_subdir @fertig');
    expect(marke).toBeGreaterThan(SICHERUNG_PROZEDUR.indexOf("EXEC sp_executesql @sql, N'@d nvarchar(600)'"));
    expect(SICHERUNG_PROZEDUR).toContain("SET @fertig = @datei + N'.fertig'");
    expect(SICHERUNG_PROZEDUR).toContain("NOT LIKE N'alfred[_]wh[_]%'");
  });
  it('Restore-Skript: RESTORE_VERIFIED steht erst nach CHECKDB ohne Meldung, gleichen Prüfdaten und entfernter Ziel-DB', () => {
    const s = wiederherstellenSkript({ datenbank: 'pruefdb01', ziel: 'alfred_wh_pruefdb01' });
    const i = (x: string) => { const n = s.indexOf(x); expect(n, x).toBeGreaterThan(0); return n; };
    const verified = s.indexOf('RESTORE_VERIFIED');
    expect(s.indexOf('RESTORE_VERIFIED', verified + 1)).toBe(-1);
    expect(i('DBCC CHECKDB')).toBeLessThan(verified);
    expect(i('[ "$zeilen" = "$N_SOLL" ] && [ "$hash" = "$SOLL" ]')).toBeLessThan(verified);
    expect(i('DROP DATABASE [alfred_wh_pruefdb01]')).toBeLessThan(verified);
    expect(i('WITH RECOVERY')).toBeLessThan(i('DBCC CHECKDB'));
    expect(s).toContain('NORECOVERY');
    expect(s).toContain(`SOLL=${PRUEFDATEN_SHA256}`);
    expect(s).toContain(`N_SOLL=${PRUEFDATEN_ZEILEN}`);
    // aus der fs01-Kopie (hole), nie aus dem lokalen Sicherungsordner
    expect(s).toContain(' hole ');
    expect(s).not.toMatch(/FROM DISK = N'\/var\/opt\/mssql\/backup\/pruefdb01/);
  });
  it('Prüfdaten-Ausdruck des Restore-Beweises ist derselbe wie im Prüfdaten-Baustein', () => {
    const p = sqlSkript('pruefdaten', { datenbank: 'pruefdb01' });
    const kern = PRUEF_SELECT.slice(PRUEF_SELECT.indexOf('HASHBYTES'), PRUEF_SELECT.indexOf(' FROM '));
    const verdoppelt = kern.replace(/'/g, "''");
    const m = /^TSQL=('(?:[^']|'\\'')*')$/m.exec(p)!;
    const tsql = spawnSync('bash', ['-c', `X=${m[1]}; printf '%s' "$X"`], { encoding: 'utf8' }).stdout;
    if (BASH) expect(tsql).toContain(verdoppelt);
  });
  it.skipIf(!BASH)('bash -n: jedes Skript und das feste Kopier-Skript sind syntaktisch gültig', () => {
    for (const [name, s] of [...alleSkripte(), ['kopie.sh', KOPIE_SH] as [string, string]]) {
      const r = spawnSync('bash', ['-n'], { input: s, encoding: 'utf8' });
      expect(r.status, `${name}: ${r.stderr}`).toBe(0);
    }
  });
  it.skipIf(!PYTHON)('Python-Programm ist gültig (ast)', () => {
    const r = spawnSync(PYTHON!, ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: PY_KETTE, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });
});

// ── Kettenlogik und Kopie mit echtem Python an Wegwerf-Ordnern ─────────────────────────────────────────────────────────────────
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const TAG = 86400;
/** UTC-Stempel yyyyMMddHHmmss für Sekunden seit 1970 */
const stempel = (s: number) => new Date(s * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);

interface Welt { lokal: string; mnt: string; status: string; cache: string; konf: string; wurzel: string }
function welt(budgetBytes = 64 * 2 ** 30): Welt {
  const wurzel = mkdtempSync(join(tmpdir(), 'alfred-kette-'));
  const w = { wurzel, lokal: join(wurzel, 'lokal'), mnt: join(wurzel, 'mnt'), status: join(wurzel, 'status.json'), cache: join(wurzel, 'cache.json'), konf: join(wurzel, 'konf.json') };
  mkdirSync(w.lokal); mkdirSync(w.mnt);
  writeFileSync(w.konf, JSON.stringify({ fassung: 1, server: 'fs01.ad.3033.at', freigabe: 'SQLLinuxBackup$', konto: 'svc-sqllnx-backup', domaene: 'AD3033', budgetBytes }));
  return w;
}
function lokal(w: Welt, db: string, name: string, inhalt: string, alterS = 3600, fertig = true) {
  mkdirSync(join(w.lokal, db), { recursive: true });
  const p = join(w.lokal, db, name);
  writeFileSync(p, inhalt);
  if (fertig) mkdirSync(`${p}.fertig`, { recursive: true });
  const t = Date.now() / 1000 - alterS;
  utimesSync(p, t, t);
}
/** Python-Programm als Modul laden (ohne __main__), optional Funktionen ersetzen, dann main(argv) */
function py(argv: string[], patch = '', jetzt?: number) {
  const prog = `import sys\nsys.stdin.reconfigure(encoding='utf-8')\nsys.stdout.reconfigure(encoding='utf-8')\nns = {'__name__': 'alfred_test'}\nexec(compile(sys.stdin.read(), 'kette', 'exec'), ns)\n${patch}\nsys.exit(ns['main'](${JSON.stringify([...argv, ...(jetzt ? ['--jetzt', String(jetzt)] : [])])}))`;
  const r = spawnSync(PYTHON!, ['-c', prog], { input: PY_KETTE, encoding: 'utf8' });
  const zeile = r.stdout.split(/\r?\n/).reverse().find(z => /^ALFRED-[A-Z]+ /.test(z));
  return { rc: r.status, aus: r.stdout, err: r.stderr, json: zeile ? JSON.parse(zeile.slice(zeile.indexOf(' ') + 1)) : undefined };
}
const kopie = (w: Welt, jetzt?: number, patch = '') => py(['kopie', w.lokal, w.mnt, 'sqllnx01', w.konf, w.status, w.cache], patch, jetzt);
const manifest = (w: Welt) => JSON.parse(readFileSync(join(w.mnt, 'sqllnx01', 'alfred-sqllnx-manifest.json'), 'utf8'));
const aufFs01 = (w: Welt, db: string) => (existsSync(join(w.mnt, 'sqllnx01', db)) ? readdirSync(join(w.mnt, 'sqllnx01', db)).sort() : []);

/** Kette: FULL zu t0, LOGs alle 15 min (verkettet), optional DIFF */
function kette(w: Welt, db: string, t0: number, logs: number, vorher?: string, diffNach?: number): { full: string; logs: string[]; letzte: string } {
  const f = stempel(t0);
  lokal(w, db, `${db}_FULL_${f}.bak`, `full-${db}-${f}`);
  let vor = vorher ?? f; const namen: string[] = [];
  for (let i = 1; i <= logs; i++) {
    const z = stempel(t0 + i * 900);
    if (diffNach === i) lokal(w, db, `${db}_DIFF_${stempel(t0 + i * 900 - 60)}_${f}.bak`, `diff-${db}-${z}`);
    const n = `${db}_LOG_${z}_${vor}.trn`;
    lokal(w, db, n, `log-${db}-${z}`);
    namen.push(n); vor = z;
  }
  return { full: f, logs: namen, letzte: vor };
}

describe.skipIf(!PYTHON)('I8e Task 4 — Kopie nach fs01 (Python, echte Dateien)', { timeout: 120_000 }, () => {
  const JETZT = Date.UTC(2026, 10, 16, 12, 0, 0) / 1000;
  it('kopiert älteste zuerst, prüft SHA-256 durch Zurücklesen, schreibt das Manifest; zweiter Lauf kopiert nichts', () => {
    const w = welt();
    const k = kette(w, 'pruefdb01', JETZT - 2 * 3600, 3);
    const r = kopie(w, JETZT);
    expect(r.rc, r.aus + r.err).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.kopiert).toHaveLength(4);
    const m = manifest(w);
    expect(m.host).toBe('sqllnx01');
    const rel = `pruefdb01/pruefdb01_FULL_${k.full}.bak`;
    expect(m.dateien[rel].sha256).toBe(sha(`full-pruefdb01-${k.full}`));
    expect(aufFs01(w, 'pruefdb01').filter(n => n.includes('alfred-tmp'))).toEqual([]);
    const r2 = kopie(w, JETZT);
    expect(r2.json.kopiert).toEqual([]);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('Hash-Abweichung beim Zurücklesen → Abbruch, keine Datei unter dem endgültigen Namen, kein Manifest-Eintrag', () => {
    const w = welt();
    kette(w, 'pruefdb01', JETZT - 2 * 3600, 1);
    const r = kopie(w, JETZT, "ns['sha'] = lambda p: '0' * 64");
    expect(r.rc).not.toBe(0);
    expect(r.json.ok).toBe(false);
    expect(r.json.fehler).toContain('Prüfsumme der Kopie auf fs01 weicht ab');
    expect(aufFs01(w, 'pruefdb01')).toEqual([]);
    const m = manifest(w);
    expect(Object.keys(m.dateien)).toEqual([]);
    expect(JSON.parse(readFileSync(w.status, 'utf8')).ok).toBe(false);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('fremde Datei gleichen Namens auf fs01 wird nie überschrieben', () => {
    const w = welt();
    const k = kette(w, 'pruefdb01', JETZT - 2 * 3600, 0);
    mkdirSync(join(w.mnt, 'sqllnx01', 'pruefdb01'), { recursive: true });
    const fremd = join(w.mnt, 'sqllnx01', 'pruefdb01', `pruefdb01_FULL_${k.full}.bak`);
    writeFileSync(fremd, 'fremder inhalt');
    const r = kopie(w, JETZT);
    expect(r.json.ok).toBe(false);
    expect(r.json.fehler).toContain('nie überschrieben');
    expect(readFileSync(fremd, 'utf8')).toBe('fremder inhalt');
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('Budget überschritten → Fehler, nichts gelöscht (weder fs01 noch lokal)', () => {
    const w = welt(40);
    kette(w, 'pruefdb01', JETZT - 2 * 3600, 2);
    writeFileSync(join(w.mnt, 'fremd.txt'), 'x'.repeat(10));
    const r = kopie(w, JETZT);
    expect(r.rc).not.toBe(0);
    expect(r.json.fehler).toContain('Budget');
    expect(r.json.geloescht).toEqual([]);
    expect(r.json.lokalEntfernt).toEqual([]);
    expect(existsSync(join(w.mnt, 'fremd.txt'))).toBe(true);
    expect(readdirSync(join(w.lokal, 'pruefdb01')).filter(n => !n.endsWith('.fertig'))).toHaveLength(3);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('Aufbewahrung: alte vollständige Ketten weg (ganz), 7 Tage + 4 Sonntage bleiben, fremde Dateien bleiben', () => {
    const w = welt();
    // 40 Tage tägliche Ketten (FULL 00:30 UTC + 4 LOGs), verkettet
    let vor: string | undefined; const fulls: string[] = [];
    for (let d = 40; d >= 0; d--) {
      const t0 = Math.floor((JETZT - d * TAG) / TAG) * TAG + 1800;
      const k = kette(w, 'pruefdb01', t0, 4, vor);
      vor = k.letzte; fulls.push(k.full);
    }
    writeFileSync(join(w.mnt, 'nicht-von-alfred.bak'), 'x');
    mkdirSync(join(w.mnt, 'sqllnx01', 'pruefdb01'), { recursive: true });
    writeFileSync(join(w.mnt, 'sqllnx01', 'pruefdb01', 'pruefdb01_FULL_20200101000000.bak'), 'fremd, nicht im Manifest');
    const r1 = kopie(w, JETZT);
    expect(r1.json.ok, r1.json.fehler).toBe(true);
    const r2 = kopie(w, JETZT);
    expect(r2.json.ok, r2.json.fehler).toBe(true);
    expect(r2.json.befunde).toEqual([]);
    const bleiben = new Set(Object.keys(manifest(w).dateien).filter(n => n.includes('_FULL_')).map(n => /_FULL_(\d{14})/.exec(n)![1]!));
    // jüngste 8 Ketten (Ende innerhalb von 7 Tagen) + 4 Sonntage davor
    const sonntage = fulls.filter(f => new Date(Date.UTC(+f.slice(0, 4), +f.slice(4, 6) - 1, +f.slice(6, 8))).getUTCDay() === 0);
    const erwartet = new Set([...fulls.slice(-8), ...sonntage.filter(s => !fulls.slice(-8).includes(s)).slice(-4)]);
    expect([...bleiben].sort()).toEqual([...erwartet].sort());
    // gelöschte Ketten ganz: keine LOG-/DIFF-Datei einer gelöschten Vollsicherung bleibt im Manifest
    const m = manifest(w);
    for (const rel of Object.keys(m.dateien)) {
      const z = /_(\d{14})(?:_\d{14})?\.(bak|trn)$/.exec(rel)![1]!;
      const basis = fulls.filter(f => f <= z).pop()!;
      expect(bleiben.has(basis), rel).toBe(true);
    }
    expect(existsSync(join(w.mnt, 'nicht-von-alfred.bak'))).toBe(true);
    expect(existsSync(join(w.mnt, 'sqllnx01', 'pruefdb01', 'pruefdb01_FULL_20200101000000.bak'))).toBe(true);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('Aufbewahrung: unvollständige Kette (Lücke) → nichts gelöscht; neueste vollständige Kette nie gelöscht', () => {
    const w = welt();
    let vor: string | undefined;
    for (let d = 20; d >= 0; d--) {
      const t0 = Math.floor((JETZT - d * TAG) / TAG) * TAG + 1800;
      const k = kette(w, 'pruefdb01', t0, 3, vor);
      vor = k.letzte;
      // Lücke in der Kette von vor 3 Tagen: mittleres LOG fehlt
      if (d === 3) rmSync(join(w.lokal, 'pruefdb01', k.logs[1]!));
    }
    kopie(w, JETZT);
    const r = kopie(w, JETZT);
    expect(r.json.geloescht).toEqual([]);
    // Fix-Runde 1: sichtbar — Befund macht den Lauf nicht ok und steht im Fehlertext
    expect(r.json.befunde.join(' ')).toContain('unvollständig');
    expect(r.json.ok).toBe(false);
    expect(r.json.fehler).toContain('Aufbewahrung ausgesetzt');
    expect(Object.keys(manifest(w).dateien).filter(n => n.includes('_FULL_'))).toHaveLength(21);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('Aufbewahrung: nur eine (alte) vollständige Kette → bleibt, auch wenn sie älter als 7 Tage ist', () => {
    const w = welt();
    kette(w, 'pruefdb01', JETZT - 30 * TAG, 2);
    kopie(w, JETZT);
    const r = kopie(w, JETZT);
    expect(r.json.geloescht).toEqual([]);
    expect(aufFs01(w, 'pruefdb01')).toHaveLength(3);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('Datei, die noch geschrieben wird (jünger als 60 s), wird nicht kopiert', () => {
    const w = welt();
    lokal(w, 'pruefdb01', `pruefdb01_FULL_${stempel(JETZT)}.bak`, 'halb', 5);
    const r = kopie(w);
    expect(r.json.kopiert).toEqual([]);
    expect(r.json.hinweise.join(' ')).toContain('wird noch geschrieben');
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('hole: neueste vollständige Kette mit DIFF und LOGs aus der fs01-Kopie, Hash gegen das Manifest geprüft', () => {
    const w = welt();
    const a = kette(w, 'pruefdb01', JETZT - 2 * TAG, 3);
    const b = kette(w, 'pruefdb01', JETZT - TAG, 4, a.letzte, 3);
    kopie(w, JETZT);
    const ziel = join(w.wurzel, 'wh'); mkdirSync(ziel);
    const r = py(['hole', w.mnt, 'sqllnx01', 'pruefdb01', ziel]);
    expect(r.rc, r.aus + r.err).toBe(0);
    expect(r.json.kette).toBe(b.full);
    expect(r.json.diff).toMatch(/_DIFF_/);
    // nach dem DIFF (vor LOG 3) folgen LOG 3 und 4
    expect(r.json.logs).toEqual([b.logs[2], b.logs[3]]);
    expect(readdirSync(ziel).sort()).toEqual([r.json.full, r.json.diff, ...r.json.logs].sort());
    // verfälschte Kopie auf fs01 → Abbruch
    writeFileSync(join(w.mnt, 'sqllnx01', 'pruefdb01', b.logs[3]!), 'verfälscht');
    const ziel2 = join(w.wurzel, 'wh2'); mkdirSync(ziel2);
    const f = py(['hole', w.mnt, 'sqllnx01', 'pruefdb01', ziel2]);
    expect(f.rc).not.toBe(0);
    expect(f.json.fehler).toMatch(/weicht|Größe/);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('hole: Kette ohne Protokollsicherung oder mit Lücke wird nie gewählt', () => {
    const w = welt();
    const a = kette(w, 'pruefdb01', JETZT - 2 * TAG, 3);
    const b = kette(w, 'pruefdb01', JETZT - TAG, 3, a.letzte);
    rmSync(join(w.lokal, 'pruefdb01', b.logs[1]!));
    kopie(w, JETZT);
    const ziel = join(w.wurzel, 'wh'); mkdirSync(ziel);
    const r = py(['hole', w.mnt, 'sqllnx01', 'pruefdb01', ziel]);
    expect(r.rc).toBe(0);
    expect(r.json.kette).toBe(a.full);
    const w2 = welt();
    kette(w2, 'pruefdb01', JETZT - TAG, 0);
    kopie(w2, JETZT);
    const z2 = join(w2.wurzel, 'wh'); mkdirSync(z2);
    const f = py(['hole', w2.mnt, 'sqllnx01', 'pruefdb01', z2]);
    expect(f.rc).not.toBe(0);
    expect(f.json.fehler).toContain('keine vollständige Kette');
    rmSync(w.wurzel, { recursive: true, force: true });
    rmSync(w2.wurzel, { recursive: true, force: true });
  });
  it('lokale Aufbewahrung: nur auf fs01 geprüfte Dateien vor der vorletzten Vollsicherung werden lokal entfernt', () => {
    const w = welt();
    const a = kette(w, 'pruefdb01', JETZT - 3 * TAG, 2);
    const b = kette(w, 'pruefdb01', JETZT - 2 * TAG, 2, a.letzte);
    kette(w, 'pruefdb01', JETZT - TAG, 2, b.letzte);
    const r = kopie(w, JETZT);
    expect(r.json.ok).toBe(true);
    const rest = readdirSync(join(w.lokal, 'pruefdb01'));
    expect(rest.some(n => n.includes(a.full))).toBe(false);
    expect(rest.some(n => n.includes(`FULL_${b.full}`))).toBe(true);
    expect(rest.filter(n => !n.endsWith('.fertig'))).toHaveLength(6);
    expect(rest.filter(n => n.endsWith('.fertig'))).toHaveLength(6);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
});

describe.skipIf(!PYTHON)('I8e Task 4 Fix-Runde 1 — Aufbewahrung über Wochen, lokales Aufräumen, Fertig-Marke, Platz', { timeout: 120_000 }, () => {
  const START = Date.UTC(2026, 10, 2, 0, 0, 0) / 1000; // Montag
  it('KRITISCH 1: 7 Wochen täglich (FULL 00:30, LOGs 6/12/18 Uhr, DIFF 12:30) — jeden Tag ohne Befund/Hinweis, am Ende 8 + 4 Ketten', () => {
    const w = welt();
    // eine Python-Sitzung über alle Tage: Sicherungen wie die Prozedur anlegen, dann ein Kopierlauf mit „jetzt“ = 23:00 des Tages
    const prog = [
      'import os, time, json, datetime',
      `lokal, mnt, konf, st, ca = ${JSON.stringify([w.lokal, w.mnt, w.konf, w.status, w.cache])}`,
      'db = "pruefdb01"; os.makedirs(os.path.join(lokal, db), exist_ok=True)',
      "z = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime('%Y%m%d%H%M%S')",
      'def neu(n):',
      '    p = os.path.join(lokal, db, n); open(p, "w").write("inhalt " + n); os.makedirs(p + ".fertig"); t = time.time() - 3600; os.utime(p, (t, t))',
      'vor = None; probleme = []; ketten_am_ende = None',
      `for tag in range(49):`,
      `    b = ${START} + tag * 86400`,
      '    full = z(b + 1800); neu("%s_FULL_%s.bak" % (db, full))',
      '    for h in (6, 12, 18):',
      '        t = z(b + h * 3600 + 300); neu("%s_LOG_%s_%s.trn" % (db, t, vor or full)); vor = t',
      '        if h == 12: neu("%s_DIFF_%s_%s.bak" % (db, z(b + h * 3600 + 1800), full))',
      '    r = ns["kopie"](lokal, mnt, "sqllnx01", konf, st, ca, jetzt=b + 23 * 3600)',
      '    s = json.load(open(st))',
      '    if s["befunde"] or s["hinweise"] or not s["ok"]: probleme.append((tag, s["befunde"][:1], s["hinweise"][:1], s["fehler"]))',
      'm = json.load(open(os.path.join(mnt, "sqllnx01", "alfred-sqllnx-manifest.json")))',
      'fulls = sorted(r.split("_FULL_")[1][:14] for r in m["dateien"] if "_FULL_" in r)',
      'print("ERGEBNIS " + json.dumps({"probleme": probleme[:3], "fulls": fulls, "grenzen": len(m["entfernteKetten"].get(db, []))}))',
    ].join('\n');
    const r = py(['geprueft', w.cache, 'x/y'], prog);
    const zeile = r.aus.split(/\r?\n/).find(x => x.startsWith('ERGEBNIS '));
    expect(zeile, r.aus + r.err).toBeDefined();
    const e = JSON.parse(zeile!.slice(9));
    expect(e.probleme).toEqual([]);
    // 8 jüngste (Ende innerhalb von 7 Tagen) + 4 Sonntage davor
    expect(e.fulls).toHaveLength(12);
    const sonntage = e.fulls.slice(0, 4).map((f: string) => new Date(Date.UTC(+f.slice(0, 4), +f.slice(4, 6) - 1, +f.slice(6, 8))).getUTCDay());
    expect(sonntage).toEqual([0, 0, 0, 0]);
    expect(e.grenzen).toBeGreaterThan(0);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('KRITISCH 2 (sim2): FULL auf fs01 verschwunden, Manifest unverändert → lokal nichts entfernt, Befund sichtbar, Lauf nicht ok', () => {
    const w = welt();
    const T = 1_793_000_000;
    const a = kette(w, 'pruefdb01', T - 3 * TAG, 1);
    const b = kette(w, 'pruefdb01', T - 2 * TAG, 1, a.letzte);
    const c = kette(w, 'pruefdb01', T - TAG, 1, b.letzte);
    expect(kopie(w, T).json.ok).toBe(true); // a lokal entfernt (vor der vorletzten FULL, auf fs01 belegt)
    kette(w, 'pruefdb01', T, 1, c.letzte);
    rmSync(join(w.mnt, 'sqllnx01', 'pruefdb01', `pruefdb01_FULL_${b.full}.bak`));
    const r = kopie(w, T + 3600);
    expect(r.json.ok).toBe(false);
    expect(r.json.lokalEntfernt).toEqual([]);
    expect(existsSync(join(w.lokal, 'pruefdb01', `pruefdb01_FULL_${b.full}.bak`))).toBe(true);
    expect(r.json.befunde.join(' ')).toContain('fehlt auf fs01');
    expect(r.json.befunde.join(' ')).toContain('lokal nichts entfernt');
    expect(JSON.parse(readFileSync(w.status, 'utf8')).fehler).toContain('fehlt auf fs01');
    expect(r.json.datenbanken.pruefdb01.fehlend).toBe(1);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('lokales Aufräumen läuft auch nach einem Budgetfehler — aber nur für auf fs01 belegte Dateien', () => {
    const w = welt();
    const T = 1_793_000_000;
    const a = kette(w, 'pruefdb01', T - 3 * TAG, 1);
    const b = kette(w, 'pruefdb01', T - 2 * TAG, 1, a.letzte);
    expect(kopie(w, T).json.ok).toBe(true);
    kette(w, 'pruefdb01', T - TAG, 1, b.letzte);
    // Budget knapp unter dem, was die neue Kette braucht
    const k = JSON.parse(readFileSync(w.konf, 'utf8'));
    writeFileSync(w.konf, JSON.stringify({ ...k, budgetBytes: JSON.parse(readFileSync(w.status, 'utf8')).belegtBytes + 5 }));
    const r = kopie(w, T);
    expect(r.json.ok).toBe(false);
    expect(r.json.fehler).toContain('Budget');
    expect(r.json.lokalEntfernt).toEqual([`pruefdb01/pruefdb01_FULL_${a.full}.bak`, `pruefdb01/${a.logs[0]}`].sort());
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('WICHTIG 3: ohne Fertig-Marke nie kopiert (spätere Dateien der DB warten); nach 6 h ohne Marke ein Befund', () => {
    const w = welt();
    const T = 1_793_000_000;
    lokal(w, 'pruefdb01', `pruefdb01_FULL_${stempel(T - 7200)}.bak`, 'halb fertig', 3600, false);
    lokal(w, 'pruefdb01', `pruefdb01_LOG_${stempel(T - 3600)}_${stempel(T - 7200)}.trn`, 'log', 3600, true);
    const r = kopie(w, T);
    expect(r.json.kopiert).toEqual([]);
    expect(r.json.hinweise.join(' ')).toContain('wird noch geschrieben');
    expect(r.json.ok).toBe(true);
    mkdirSync(join(w.lokal, 'pruefdb01', `pruefdb01_FULL_${stempel(T - 7200)}.bak.fertig`));
    expect(kopie(w, T).json.kopiert).toHaveLength(2);
    const w2 = welt();
    lokal(w2, 'pruefdb01', `pruefdb01_FULL_${stempel(T - 90000)}.bak`, 'abgebrochen', 7 * 3600, false);
    const r2 = kopie(w2, T);
    expect(r2.json.ok).toBe(false);
    expect(r2.json.befunde.join(' ')).toContain('ohne Fertig-Marke');
    rmSync(w.wurzel, { recursive: true, force: true });
    rmSync(w2.wurzel, { recursive: true, force: true });
  });
  it('WICHTIG 4: hole prüft den freien Platz vor dem Holen (Kette + 1 GiB), sonst nichts geholt', () => {
    const w = welt();
    const T = 1_793_000_000;
    kette(w, 'pruefdb01', T - TAG, 2);
    kopie(w, T);
    const ziel = join(w.wurzel, 'wh'); mkdirSync(ziel);
    const r = py(['hole', w.mnt, 'sqllnx01', 'pruefdb01', ziel], "ns['frei_bytes'] = lambda p: 1000");
    expect(r.rc).not.toBe(0);
    expect(r.json.fehler).toContain('zu wenig Platz');
    expect(readdirSync(ziel)).toEqual([]);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
});

describe.skipIf(!PYTHON)('I8e Task 4 Fix-Runde 2 — Inhalt vor lokalem Löschen, Kettengrenzen lokal, Frische, Fehler im Kopierschritt', { timeout: 120_000 }, () => {
  const START = Date.UTC(2026, 10, 2, 0, 0, 0) / 1000; // Montag
  const grenzenDatei = (w: Welt) => join(w.wurzel, 'sqllnx', 'pruefdb01-entfernt.json');
  it('1: Datei auf fs01 mit gleicher Größe, aber anderem Inhalt → lokal nichts gelöscht, Befund, Lauf nicht ok', () => {
    const w = welt();
    const T = Math.floor(Date.now() / 1000);
    const a = kette(w, 'pruefdb01', T - 3 * TAG, 1);
    const b = kette(w, 'pruefdb01', T - 2 * TAG, 1, a.letzte);
    const c = kette(w, 'pruefdb01', T - TAG, 1, b.letzte);
    expect(kopie(w, T).json.ok).toBe(true);
    kette(w, 'pruefdb01', T - 3600, 1, c.letzte);
    const f = join(w.mnt, 'sqllnx01', 'pruefdb01', `pruefdb01_FULL_${b.full}.bak`);
    const alt = readFileSync(f, 'utf8');
    writeFileSync(f, alt.slice(0, -1) + (alt.endsWith('X') ? 'Y' : 'X'));
    const r = kopie(w, T);
    expect(r.json.ok).toBe(false);
    expect(r.json.lokalEntfernt).toEqual([]);
    expect(existsSync(join(w.lokal, 'pruefdb01', `pruefdb01_FULL_${b.full}.bak`))).toBe(true);
    expect(r.json.befunde.join(' ')).toContain('Inhalt auf fs01 weicht vom Manifest ab');
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('2: Kettengrenzen liegen lokal (0600, Ordner 0700); gefälschte Grenzen auf fs01 überbrücken keine echte Lücke', () => {
    const w = welt();
    const T = Math.floor(Date.now() / 1000);
    const b = kette(w, 'pruefdb01', T - 2 * TAG, 2);
    // Kette c beginnt mit einem LOG, dessen Vorgänger nie existierte (echte Lücke am Ende von b)
    const fehlt = stempel(T - 2 * TAG + 3 * 3600);
    const cFull = stempel(T - TAG);
    lokal(w, 'pruefdb01', `pruefdb01_FULL_${cFull}.bak`, 'full c');
    lokal(w, 'pruefdb01', `pruefdb01_LOG_${stempel(T - TAG + 900)}_${fehlt}.trn`, 'log c');
    kopie(w, T);
    // Fälschung auf der Freigabe: eine „gelöschte Kette“ zwischen b und c, die genau die Lücke schließen würde
    const mp = join(w.mnt, 'sqllnx01', 'alfred-sqllnx-manifest.json');
    const m = JSON.parse(readFileSync(mp, 'utf8'));
    m.entfernteKetten = { pruefdb01: [{ full: stempel(T - 2 * TAG + 2 * 3600), ersterBezug: b.letzte, letztes: fehlt }] };
    writeFileSync(mp, JSON.stringify(m));
    // lokal gibt es eine (andere, nicht überbrückende) Aufzeichnung — es gilt nur sie (Fix-Welle: ohne lokale Aufzeichnung greift M-1)
    mkdirSync(join(w.wurzel, 'sqllnx'), { recursive: true });
    writeFileSync(grenzenDatei(w), JSON.stringify([{ full: stempel(T - 5 * TAG), ersterBezug: null, letztes: null }]));
    const r = kopie(w, T);
    expect(r.json.ok).toBe(false);
    expect(r.json.befunde.join(' ')).toContain(`Protokollsicherung ${fehlt} fehlt`);
    expect(r.json.befunde.join(' ')).toContain('Grenzen gelöschter Ketten auf fs01 weichen von der lokalen Aufzeichnung ab');
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('2/6: gelöschte Ketten stehen in der lokalen Aufzeichnung und werden nie erneut kopiert', () => {
    const w = welt();
    const a = kette(w, 'pruefdb01', START + 1800, 2);
    kette(w, 'pruefdb01', START + TAG + 1800, 2, a.letzte);
    expect(kopie(w, START + TAG + 23 * 3600).json.ok).toBe(true);
    const r2 = kopie(w, START + 40 * TAG);
    expect(r2.json.ok, r2.json.fehler).toBe(true);
    expect(r2.json.geloescht).toContain(`pruefdb01/pruefdb01_FULL_${a.full}.bak`);
    expect(r2.json.kopiert).toEqual([]);
    const lokalGrenzen = JSON.parse(readFileSync(grenzenDatei(w), 'utf8'));
    expect(lokalGrenzen.map((g: { full: string }) => g.full)).toEqual([a.full]);
    if (process.platform !== 'win32') {
      expect(statSync(grenzenDatei(w)).mode & 0o777).toBe(0o600);
      expect(statSync(join(w.wurzel, 'sqllnx')).mode & 0o777).toBe(0o700);
    }
    const r3 = kopie(w, START + 40 * TAG);
    expect(r3.json.kopiert).toEqual([]);
    expect(r3.json.geloescht).toEqual([]);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('3: liste meldet den Kopierbericht nur als frisch, wenn er höchstens 45 min alt ist', () => {
    const w = welt();
    const T = Math.floor(Date.now() / 1000);
    kette(w, 'pruefdb01', T - TAG, 1);
    kopie(w, T);
    const frisch = py(['liste', w.lokal, 'sqllnx01', w.cache, w.status, w.konf]);
    expect(frisch.json.status.frisch).toBe(true);
    const st = JSON.parse(readFileSync(w.status, 'utf8'));
    writeFileSync(w.status, JSON.stringify({ ...st, zeit: new Date(Date.now() - 2 * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z') }));
    const alt = py(['liste', w.lokal, 'sqllnx01', w.cache, w.status, w.konf]);
    expect(alt.json.status.frisch).toBe(false);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('4: OSError beim Kopieren (z. B. Kontingent voll) → Befund, aufgeräumt wird trotzdem nur Belegtes', () => {
    const w = welt();
    const T = Math.floor(Date.now() / 1000);
    const a = kette(w, 'pruefdb01', T - 3 * TAG, 1);
    const b = kette(w, 'pruefdb01', T - 2 * TAG, 1, a.letzte);
    expect(kopie(w, T).json.ok).toBe(true);
    kette(w, 'pruefdb01', T - TAG, 1, b.letzte);
    const r = kopie(w, T, "def _voll(*a):\n    raise OSError(28, 'No space left on device')\nns['kopiere'] = _voll");
    expect(r.json.ok).toBe(false);
    expect(r.json.fehler).toContain('No space left on device');
    expect(r.json.lokalEntfernt).toEqual([`pruefdb01/pruefdb01_FULL_${a.full}.bak`, `pruefdb01/${a.logs[0]}`].sort());
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('5: Datei ohne Fertig-Marke älter als 6 h → nur sie übersprungen (Befund), spätere Dateien werden kopiert', () => {
    const w = welt();
    const T = Math.floor(Date.now() / 1000);
    lokal(w, 'pruefdb01', `pruefdb01_FULL_${stempel(T - 9 * 3600)}.bak`, 'full');
    lokal(w, 'pruefdb01', `pruefdb01_LOG_${stempel(T - 8 * 3600)}_${stempel(T - 9 * 3600)}.trn`, 'log ohne Marke', 7 * 3600, false);
    lokal(w, 'pruefdb01', `pruefdb01_LOG_${stempel(T - 7 * 3600)}_${stempel(T - 8 * 3600)}.trn`, 'log danach');
    const r = kopie(w, T);
    expect(r.json.ok).toBe(false);
    expect(r.json.befunde.join(' ')).toContain('ohne Fertig-Marke');
    expect(r.json.kopiert).toHaveLength(2);
    expect(r.json.kopiert.join(' ')).not.toContain(stempel(T - 8 * 3600) + '_');
    rmSync(w.wurzel, { recursive: true, force: true });
  });
});

describe.skipIf(!PYTHON)('I8e Fix-Welle — lokale Grenzen fehlen (M-1), Dateien gelöschter Ketten (M-2), Reste (M-6)', { timeout: 120_000 }, () => {
  const START = Date.UTC(2026, 10, 2, 0, 0, 0) / 1000; // Montag
  const grenzenDatei = (w: Welt) => join(w.wurzel, 'sqllnx', 'pruefdb01-entfernt.json');
  /** a (Mo) und b (Di) kopiert, dann 40 Tage später: a per Aufbewahrung gelöscht, lokal noch vorhanden */
  function zweiKetten() {
    const w = welt();
    const a = kette(w, 'pruefdb01', START + 1800, 2);
    kette(w, 'pruefdb01', START + TAG + 1800, 2, a.letzte);
    expect(kopie(w, START + TAG + 23 * 3600).json.ok).toBe(true);
    return { w, a };
  }
  it('M-2: Dateien einer gelöschten Kette, deren Hash bei der Löschung auf fs01 belegt war, werden lokal entfernt', () => {
    const { w, a } = zweiKetten();
    const r = kopie(w, START + 40 * TAG);
    expect(r.json.ok, r.json.fehler).toBe(true);
    const g = JSON.parse(readFileSync(grenzenDatei(w), 'utf8'));
    expect(Object.keys(g[0].dateien).sort()).toEqual([`pruefdb01_FULL_${a.full}.bak`, ...a.logs].sort());
    expect(r.json.lokalEntfernt.sort()).toEqual([`pruefdb01/pruefdb01_FULL_${a.full}.bak`, ...a.logs.map(n => `pruefdb01/${n}`)].sort());
    expect(existsSync(join(w.lokal, 'pruefdb01', `pruefdb01_FULL_${a.full}.bak`))).toBe(false);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('M-2: ohne Hash-Beleg in der lokalen Grenze (oder abweichende lokale Datei) → nichts entfernt, Befund „lokal liegen n Dateien gelöschter Ketten“', () => {
    // Beleg verfälscht: lokale Datei weicht vom bei der Löschung belegten Hash ab
    const w2 = zweiKetten();
    writeFileSync(join(w2.w.lokal, 'pruefdb01', w2.a.logs[0]!), 'anders');
    utimesSync(join(w2.w.lokal, 'pruefdb01', w2.a.logs[0]!), Date.now() / 1000 - 3600, Date.now() / 1000 - 3600);
    const r = kopie(w2.w, START + 40 * TAG);
    expect(r.json.ok).toBe(false);
    expect(r.json.befunde.join(' ')).toMatch(/lokal liegen \d+ Dateien gelöschter Ketten/);
    expect(existsSync(join(w2.w.lokal, 'pruefdb01', w2.a.logs[0]!))).toBe(true);
    rmSync(w2.w.wurzel, { recursive: true, force: true });
  });
  it('M-1: lokale Grenzdatei verloren, fs01 hat Grenzen → Befund, Grenzen auf fs01 bleiben, gelöschte Ketten werden nicht neu kopiert', () => {
    const w = welt();
    const a = kette(w, 'pruefdb01', START + 1800, 2);
    kette(w, 'pruefdb01', START + TAG + 1800, 2, a.letzte);
    kopie(w, START + TAG + 23 * 3600);
    const r1 = kopie(w, START + 40 * TAG);
    expect(r1.json.geloescht.length).toBeGreaterThan(0);
    // lokale Kopie der a-Dateien wiederherstellen (wie vor dem Aufräumen) und die lokale Grenzdatei verlieren
    for (const n of [`pruefdb01_FULL_${a.full}.bak`, ...a.logs]) if (!existsSync(join(w.lokal, 'pruefdb01', n))) lokal(w, 'pruefdb01', n, `x-${n}`);
    rmSync(grenzenDatei(w));
    const r = kopie(w, START + 40 * TAG);
    expect(r.json.ok).toBe(false);
    expect(r.json.befunde.join(' ')).toContain('lokale Kettengrenzen fehlen — Aufbewahrung ausgesetzt');
    expect(r.json.kopiert).toEqual([]);
    expect(manifest(w).entfernteKetten.pruefdb01.map((e: { full: string }) => e.full)).toEqual([a.full]);
    // Übernahme (nach Prüfung): schreibt die lokale Datei aus der Kopie auf fs01 und nennt den Unterschied
    const u = py(['grenzen_uebernehmen', w.mnt, 'sqllnx01', join(w.wurzel, 'sqllnx')]);
    expect(u.rc, u.aus).toBe(0);
    expect(u.json.unterschied).toMatchObject([{ datenbank: 'pruefdb01', lokal: 0, fs01: 1 }]);
    expect(JSON.parse(readFileSync(grenzenDatei(w), 'utf8')).map((e: { full: string }) => e.full)).toEqual([a.full]);
    const r3 = kopie(w, START + 40 * TAG);
    expect(r3.json.befunde.join(' ')).not.toContain('lokale Kettengrenzen fehlen');
    expect(r3.json.kopiert).toEqual([]);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('M-6: liste meldet Reste .alfred-wh-* im Sicherungsordner', () => {
    const w = welt();
    kette(w, 'pruefdb01', START + 1800, 1);
    kopie(w, START + TAG);
    mkdirSync(join(w.lokal, '.alfred-wh-abc123'));
    const l = py(['liste', w.lokal, 'sqllnx01', w.cache, w.status, w.konf]);
    expect(l.json.reste.some((x: string) => x.endsWith('.alfred-wh-abc123'))).toBe(true);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
});

describe.skipIf(!PYTHON)('I8e Nachtrag N-1 — kettengrenzen_uebernehmen nur bei fehlender Aufzeichnung, geprüft, ohne Löschwirkung', { timeout: 120_000 }, () => {
  const START = Date.UTC(2026, 10, 2, 0, 0, 0) / 1000; // Montag
  const gdir = (w: Welt) => join(w.wurzel, 'sqllnx');
  const gdatei = (w: Welt) => join(gdir(w), 'pruefdb01-entfernt.json');
  const mpfad = (w: Welt) => join(w.mnt, 'sqllnx01', 'alfred-sqllnx-manifest.json');
  /** drei Ketten a, b, c kopiert; dann b „gelöscht“ (fs01 + Manifest), Grenze von b nur auf fs01 */
  function aufbau() {
    const w = welt();
    const a = kette(w, 'pruefdb01', START + 1800, 2);
    const b = kette(w, 'pruefdb01', START + TAG + 1800, 2, a.letzte);
    const c = kette(w, 'pruefdb01', START + 2 * TAG + 1800, 2, b.letzte);
    expect(kopie(w, START + 2 * TAG + 23 * 3600).json.ok).toBe(true);
    const m = JSON.parse(readFileSync(mpfad(w), 'utf8'));
    const bDateien: Record<string, string> = {};
    for (const n of [`pruefdb01_FULL_${b.full}.bak`, ...b.logs]) {
      bDateien[n] = m.dateien[`pruefdb01/${n}`].sha256;
      delete m.dateien[`pruefdb01/${n}`];
      rmSync(join(w.mnt, 'sqllnx01', 'pruefdb01', n), { force: true });
      rmSync(join(w.lokal, 'pruefdb01', n), { force: true });
      rmSync(join(w.lokal, 'pruefdb01', `${n}.fertig`), { recursive: true, force: true });
    }
    const gb = { full: b.full, ersterBezug: a.letzte, letztes: b.letzte, dateien: bDateien };
    m.entfernteKetten = { pruefdb01: [gb] };
    writeFileSync(mpfad(w), JSON.stringify(m));
    return { w, a, b, c, m, gb };
  }
  const uebernehmen = (w: Welt) => py(['grenzen_uebernehmen', w.mnt, 'sqllnx01', gdir(w)]);
  it('übernommene Grenzen: markiert, ohne Hash-Belege, im Ergebnis aufgeführt', () => {
    const { w, a, b } = aufbau();
    const u = uebernehmen(w);
    expect(u.rc, u.aus).toBe(0);
    expect(u.json.unterschied).toEqual([{ datenbank: 'pruefdb01', lokal: 0, fs01: 1, grenzen: [{ full: b.full, ersterBezug: a.letzte, letztes: b.letzte }] }]);
    const g = JSON.parse(readFileSync(gdatei(w), 'utf8'));
    expect(g).toEqual([{ full: b.full, ersterBezug: a.letzte, letztes: b.letzte, uebernommen: true }]);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('vorhandene, abweichende lokale Aufzeichnung → Abbruch ohne Änderung („es gilt die lokale“)', () => {
    const { w } = aufbau();
    mkdirSync(gdir(w), { recursive: true });
    const alt = JSON.stringify([{ full: stempel(START - 5 * TAG), ersterBezug: null, letztes: null }]);
    writeFileSync(gdatei(w), alt);
    const u = uebernehmen(w);
    expect(u.rc).not.toBe(0);
    expect(u.json.fehler).toContain('lokale Aufzeichnung vorhanden — es gilt die lokale');
    expect(readFileSync(gdatei(w), 'utf8')).toBe(alt);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('ungültige Einträge auf fs01 → Abbruch ohne Änderung: Kette noch im Manifest, fremde Dateinamen, Überlappung/Reihenfolge', () => {
    for (const faelschen of [
      (x: ReturnType<typeof aufbau>) => { x.m.entfernteKetten.pruefdb01 = [{ ...x.gb, full: x.c.full }]; },
      (x: ReturnType<typeof aufbau>) => { x.m.entfernteKetten.pruefdb01 = [{ ...x.gb, dateien: { 'boese.bak': 'a'.repeat(64) } }]; },
      (x: ReturnType<typeof aufbau>) => { x.m.entfernteKetten.pruefdb01 = [{ ...x.gb, letztes: stempel(START) }]; },
      // Nachtrag 2 (M-A): Grenze nicht älter als die neueste Vollsicherung bzw. in der Zukunft
      (x: ReturnType<typeof aufbau>) => { x.m.entfernteKetten.pruefdb01 = [{ ...x.gb, full: stempel(START + 3 * TAG + 1800), ersterBezug: null, letztes: null, dateien: {} }]; },
      (x: ReturnType<typeof aufbau>) => { x.m.entfernteKetten.pruefdb01 = [{ ...x.gb, full: stempel(Date.now() / 1000 + 400 * TAG), ersterBezug: null, letztes: null, dateien: {} }]; },
      (x: ReturnType<typeof aufbau>) => { x.m.entfernteKetten.pruefdb01 = [x.gb, { full: stempel(START + TAG + 1800 + 900), ersterBezug: x.b.logs[0]!.split('_')[2]!, letztes: stempel(START + TAG + 4 * 3600) }]; },
    ]) {
      const x = aufbau();
      faelschen(x);
      writeFileSync(mpfad(x.w), JSON.stringify(x.m));
      const u = uebernehmen(x.w);
      expect(u.rc, JSON.stringify(x.m.entfernteKetten)).not.toBe(0);
      expect(existsSync(gdatei(x.w))).toBe(false);
      rmSync(x.w.wurzel, { recursive: true, force: true });
    }
  });
  it('übernommene Grenzen überbrücken keine Lücke und ermöglichen kein Löschen: ältere Ketten bleiben unangetastet, neuere normal', () => {
    const { w, a } = aufbau();
    expect(uebernehmen(w).rc).toBe(0);
    // Brücke: ketten() mit der übernommenen Grenze meldet das Ende von a weiterhin als Lücke
    const r = kopie(w, START + 40 * TAG);
    expect(r.json.ok, r.json.fehler).toBe(true);
    expect(r.json.befunde).toEqual([]);
    expect(r.json.geloescht.join(' ')).not.toContain(a.full);
    expect(existsSync(join(w.mnt, 'sqllnx01', 'pruefdb01', `pruefdb01_FULL_${a.full}.bak`))).toBe(true);
    expect(r.json.hinweise.join(' ')).toContain('vor übernommenen Kettengrenzen');
    expect(r.json.kopiert).toEqual([]);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('lokale Dateien einer übernommenen Kette werden nie gelöscht (kein Beleg aus fs01-Daten) — Befund', () => {
    const { w, b, gb } = aufbau();
    expect(uebernehmen(w).rc).toBe(0);
    // lokale Kopie von b wieder da (Inhalt wie früher kopiert)
    lokal(w, 'pruefdb01', `pruefdb01_FULL_${b.full}.bak`, `full-pruefdb01-${b.full}`);
    void gb;
    const r = kopie(w, START + 2 * TAG + 23 * 3600);
    expect(r.json.lokalEntfernt).toEqual([]);
    expect(existsSync(join(w.lokal, 'pruefdb01', `pruefdb01_FULL_${b.full}.bak`))).toBe(true);
    expect(r.json.befunde.join(' ')).toMatch(/lokal liegen 1 Dateien gelöschter Ketten/);
    // Nachtrag 2 (M-A): das Überspringen wegen übernommener Grenzen ist sichtbar (Befund, Lauf nicht ok)
    expect(r.json.befunde.join(' ')).toContain('1 Dateien wegen übernommener Grenzen nicht kopiert');
    expect(r.json.ok).toBe(false);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
});

// ── Bash-Bausteine mit Stubs ausführen ─────────────────────────────────────────────────────────────────────────────────────────
function bashLauf(skript: string, stubs: string[], eingabe = '') {
  // Ersetzung als Funktion: „$'“ im Stub-Text wäre sonst ein Ersetzungsmuster von String.replace
  const text = skript.replace('# ALFRED-ABLAUF', () => `${stubs.join('\n')}\n# ALFRED-ABLAUF`);
  const huelle = `T=$(mktemp -d)\nALFRED_EINGABE=${shQ(eingabe)}\n( ${text}\n)\necho "RC=$?"\necho "---RUN"; ls -A "$T/run" 2>/dev/null; echo "---LOG"; cat "$T/log" 2>/dev/null; rm -rf "$T"`;
  const r = spawnSync('bash', [], { input: huelle, encoding: 'utf8' });
  const [vorne, rest = ''] = r.stdout.split('---RUN\n');
  const [run = '', log = ''] = rest.split('---LOG\n');
  return { rc: Number(/RC=(\d+)/.exec(vorne)?.[1] ?? -1), e: sqlErgebnis<Record<string, unknown>>(vorne), vorne, run: run.trim(), log, err: r.stderr };
}
const GEMEINSAM = [
  'RUN_DIR="$T/run"; mkdir -p "$RUN_DIR"; : >"$T/log"',
  "feld() { case \"$1\" in sa) printf '%s' 'Sa-Geheim-123456!' ;; kennwort) printf '%s' 'Fs01-Geheim-987654' ;; esac; }",
  'bereit() { :; }',
  'json_text() { local x; x=$(cat); printf \'"%s"\' "${x//\\"/}"; }',
  'konf_feld() { case "$1" in server) echo fs01.ad.3033.at ;; freigabe) echo \'SQLLinuxBackup$\' ;; konto) echo svc-sqllnx-backup ;; domaene) echo AD3033 ;; esac; }',
  'umount() { echo "umount $*" >>"$T/log"; }',
  'mountpoint() { return 0; }',
  'rechnername() { echo sqllnx01; }',
  'fassung_pruefen() { :; }',
  'frei_kb() { echo 999999999; }',
  'geraet() { echo "$1"; }',
];

describe.skipIf(!BASH)('I8e Task 4 — Bausteine ausgeführt (Stubs)', { timeout: 120_000 }, () => {
  it('wiederherstellen: fs01 nicht einhängbar → Abbruch, Zugangsdatei unter /run entfernt (trap), Kennwort nie in der Ausgabe', () => {
    const r = bashLauf(wiederherstellenSkript({ datenbank: 'pruefdb01', ziel: 'alfred_wh_pruefdb01' }), [
      ...GEMEINSAM,
      "sql() { echo \"$1\" >>\"$T/log\"; echo 'ALFRED|frei'; }",
      'mount() { cp "$RUN_DIR"/alfred-c-* "$T/zugang-kopie" 2>/dev/null; echo "mount error(13): Permission denied" >&2; return 32; }',
    ]);
    expect(r.rc).toBe(1);
    expect(String(r.e?.fehler)).toContain('fs01');
    expect(r.run).toBe('');
    expect(r.vorne).not.toContain('Fs01-Geheim');
    expect(r.vorne).not.toContain('Sa-Geheim');
  });
  function restoreLauf(checkdb: string, pruef: string, mitDiff = true, checkdbExit0 = false, extra: string[] = []) {
    const hole = JSON.stringify({ kette: '20261115003000', full: 'pruefdb01_FULL_20261115003000.bak', diff: mitDiff ? 'pruefdb01_DIFF_20261115063000_20261115003000.bak' : null, logs: ['pruefdb01_LOG_20261115064500_20261115060500.trn'] });
    return bashLauf(wiederherstellenSkript({ datenbank: 'pruefdb01', ziel: 'alfred_wh_pruefdb01' }), [
      ...GEMEINSAM,
      'mount() { echo "mount $*" >>"$T/log"; }',
      'chown() { :; }',
      `kette_py() { if [ "$1" = hole ]; then for n in pruefdb01_FULL_20261115003000.bak pruefdb01_DIFF_20261115063000_20261115003000.bak pruefdb01_LOG_20261115064500_20261115060500.trn; do : >"$5/$n"; done; echo 'ALFRED-DATEI|FULL|pruefdb01_FULL_20261115003000.bak'; ${mitDiff ? "echo 'ALFRED-DATEI|DIFF|pruefdb01_DIFF_20261115063000_20261115003000.bak';" : ''} echo 'ALFRED-DATEI|LOG|pruefdb01_LOG_20261115064500_20261115060500.trn'; echo ${shQ(`ALFRED-HOLE ${hole}`)}; fi; }`,
      'mktemp() { if [ "${1:-}" = -d ]; then local d; d="$T/wh.$RANDOM"; command mkdir -p "$d"; echo "$d"; else command mktemp "$@"; fi; }',
      `sql() { echo "$1" >>"$T/log"; case "$1" in *"DB_ID(N'alfred_wh_pruefdb01') IS NULL THEN"*) if grep -q 'DROP DATABASE' "$T/log"; then echo 'ALFRED|frei'; else echo 'ALFRED|frei'; fi ;; *DBCC*) printf '%s' ${shQ(checkdb)}; ${checkdbExit0 ? ':' : `[ -z ${shQ(checkdb)} ]`} ;; *alfred_pruefung*) echo ${shQ(pruef)} ;; *) : ;; esac; }`,
      `sqls() { echo "$1" >>"$T/log"; case "$1" in *FILELISTONLY*) echo 'pruefdb01|/var/opt/mssql/data/pruefdb01.mdf|D|PRIMARY|8388608|35184372080640|1|0|0'; echo 'pruefdb01_log|/var/opt/mssql/log/pruefdb01_log.ldf|L|NULL|8388608|2199023255552|2|0|0' ;; *HEADERONLY*) case "$1" in *FULL*) t=1 ;; *DIFF*) t=5 ;; *) t=2 ;; esac; echo "alfred|Alfred I8e|$t|NULL|1|1|2|sa|SQLLNX01|pruefdb01" ;; esac; }`,
      ...extra,
    ]);
  }
  it('WICHTIG 4: zu wenig Platz auf der Daten- oder Logplatte → Abbruch vor dem ersten RESTORE, nichts angelegt', () => {
    for (const frei of ["frei_kb() { case \"$1\" in *data) echo 8000 ;; *) echo 999999999 ;; esac; }", "frei_kb() { case \"$1\" in *log) echo 8000 ;; *) echo 999999999 ;; esac; }"]) {
      const r = restoreLauf('', `ALFRED|${PRUEFDATEN_ZEILEN}|${PRUEFDATEN_SHA256}`, true, false, [frei]);
      expect(r.rc, r.vorne).toBe(1);
      expect(String(r.e?.fehler)).toContain('zu wenig Platz');
      expect(r.log).not.toContain('RESTORE DATABASE');
      expect(r.log).not.toContain('DROP DATABASE');
      expect(r.run).toBe('');
    }
    // Daten und Log auf derselben Platte: Summe zählt
    const gemeinsam = restoreLauf('', `ALFRED|${PRUEFDATEN_ZEILEN}|${PRUEFDATEN_SHA256}`, true, false, ['geraet() { echo 1; }', 'frei_kb() { echo 532000; }']);
    expect(String(gemeinsam.e?.fehler)).toContain('zu wenig Platz');
  });
  it('wiederherstellen: CHECKDB still, Prüfdaten gleich → RESTORE_VERIFIED, Reihenfolge NORECOVERY…RECOVERY, Ziel-DB entfernt', () => {
    const r = restoreLauf('', `ALFRED|${PRUEFDATEN_ZEILEN}|${PRUEFDATEN_SHA256}`);
    expect(r.rc, r.vorne + r.err).toBe(0);
    expect(r.e).toMatchObject({ ergebnis: 'RESTORE_VERIFIED', datenbank: 'pruefdb01', ziel: 'alfred_wh_pruefdb01', zeilen: PRUEFDATEN_ZEILEN, pruefsumme: PRUEFDATEN_SHA256, checkdb: 'ohne Befund', entfernt: true, logs: 1, diff: true });
    const log = r.log;
    const pos = (x: string) => log.indexOf(x);
    expect(pos("RESTORE DATABASE [alfred_wh_pruefdb01] FROM DISK")).toBeGreaterThan(0);
    expect(log).toContain("MOVE N'pruefdb01' TO N'/var/opt/mssql/data/alfred_wh_pruefdb01_pruefdb01.mdf'");
    expect(log).toContain("MOVE N'pruefdb01_log' TO N'/var/opt/mssql/log/alfred_wh_pruefdb01_pruefdb01_log.ldf'");
    expect(pos('RESTORE LOG [alfred_wh_pruefdb01]')).toBeGreaterThan(pos('_DIFF_'));
    expect(pos('RESTORE DATABASE [alfred_wh_pruefdb01] WITH RECOVERY')).toBeGreaterThan(pos('RESTORE LOG'));
    expect(pos('DBCC CHECKDB')).toBeGreaterThan(pos('WITH RECOVERY'));
    expect(pos('DROP DATABASE [alfred_wh_pruefdb01]')).toBeGreaterThan(pos('DBCC CHECKDB'));
    expect(r.run).toBe('');
    expect(r.vorne).not.toContain('Fs01-Geheim');
  });
  it('wiederherstellen: CHECKDB mit Meldung → Fehler, kein RESTORE_VERIFIED, Ziel-DB im Aufräumen entfernt', () => {
    const r = restoreLauf('Msg 8939, Level 16, State 98: Table error', `ALFRED|${PRUEFDATEN_ZEILEN}|${PRUEFDATEN_SHA256}`);
    expect(r.rc).toBe(1);
    expect(r.vorne).not.toContain('RESTORE_VERIFIED');
    expect(String(r.e?.fehler)).toContain('CHECKDB');
    expect(r.log).toMatch(/IF DB_ID\(N'alfred_wh_pruefdb01'\) IS NOT NULL DROP DATABASE \[alfred_wh_pruefdb01\]/);
    expect(r.run).toBe('');
  });
  it('wiederherstellen: CHECKDB mit Ausgabe trotz Exit 0 → Fehler, kein RESTORE_VERIFIED', () => {
    const r = restoreLauf('Msg 2570, Level 10: Page (1:153), slot 0 ... data purity', `ALFRED|${PRUEFDATEN_ZEILEN}|${PRUEFDATEN_SHA256}`, true, true);
    expect(r.rc).toBe(1);
    expect(r.vorne).not.toContain('RESTORE_VERIFIED');
    expect(String(r.e?.fehler)).toContain('CHECKDB meldet');
  });
  it('wiederherstellen: abweichende Prüfdaten → Fehler, kein RESTORE_VERIFIED', () => {
    for (const p of [`ALFRED|999|${PRUEFDATEN_SHA256}`, `ALFRED|${PRUEFDATEN_ZEILEN}|${'A'.repeat(64)}`]) {
      const r = restoreLauf('', p);
      expect(r.rc).toBe(1);
      expect(r.vorne).not.toContain('RESTORE_VERIFIED');
      expect(String(r.e?.fehler)).toContain('Prüfdaten');
    }
  });
  it('wiederherstellen: Ziel-DB besteht schon → Abbruch ohne Änderung (nichts eingehängt, nichts gelöscht)', () => {
    const r = bashLauf(wiederherstellenSkript({ datenbank: 'pruefdb01', ziel: 'alfred_wh_pruefdb01' }), [
      ...GEMEINSAM,
      "sql() { echo \"$1\" >>\"$T/log\"; echo 'ALFRED|belegt'; }",
      'mount() { echo "mount $*" >>"$T/log"; }',
    ]);
    expect(r.rc).toBe(1);
    expect(String(r.e?.fehler)).toContain('besteht schon');
    expect(r.log).not.toContain('mount ');
    expect(r.log).not.toContain('DROP DATABASE');
  });
  it('sicherung_jetzt: Datei aus der Prozedur, Kopie angestoßen, auf fs01 bestätigt; sonst Fehler', () => {
    const datei = '/var/opt/mssql/backup/pruefdb01/pruefdb01_LOG_20261116120000_20261116114500.trn';
    const lauf = (bestaetigt: boolean) => bashLauf(sicherungJetztSkript({ art: 'LOG', datenbank: 'pruefdb01' }), [
      ...GEMEINSAM,
      `sql() { echo "$1" >>"$T/log"; echo 'ALFRED|${datei}'; }`,
      'systemctl() { echo "systemctl $*" >>"$T/log"; }',
      `pruefe_datei() { [ "$1" = ${shQ(datei)} ]; }`,
      'warte_schreibruhe() { :; }',
      `kette_py() { echo "kette $*" >>"$T/log"; if [ "$1" = geprueft ]; then ${bestaetigt ? "echo 'ALFRED-GEPRUEFT {\"sha256\":\"ab\"}'" : "echo 'ALFRED-GEPRUEFT {}'; return 1"}; fi; }`,
    ]);
    const ok = lauf(true);
    expect(ok.rc, ok.vorne + ok.err).toBe(0);
    expect(ok.e).toMatchObject({ zustand: 'geaendert', art: 'LOG', datenbank: 'pruefdb01', datei, fs01: true });
    expect(ok.log).toContain("EXEC msdb.dbo.alfred_sicherung @art = N'LOG', @db = N'pruefdb01', @streng = 1;");
    expect(ok.log).toContain('systemctl start alfred-sqllnx-kopie.service');
    const nein = lauf(false);
    expect(nein.rc).toBe(1);
    expect(String(nein.e?.fehler)).toContain('fs01');
  });
});

// ── I8e Paket 2, Task 7 — Sicherung rollenabhängig in der AG (Owner-Entscheidung 1) ──────────────────────────────────────────────
/** Fassung der Prozedur im Stand vor Task 7 (5e6b4b87, live auf sqllnx01 seit v1889) */
const FASSUNG_VOR_TASK7 = 'c3091dc5';

describe('I8e Paket 2 Task 7 — Prozedur rollenabhängig', { timeout: 120_000 }, () => {
  const P = SICHERUNG_PROZEDUR;
  it('Sekundär überspringt: AG-Datenbank ohne Vorzug → genau „ALFRED|nicht-bevorzugt“, kein Fehler, keine Sicherung, kein LOG', () => {
    // AG-Zugehörigkeit aus sys.databases.replica_id; Datenbanken ohne AG laufen wie bisher (Funktion wird für sie nicht befragt)
    expect(P).toContain('@agdb = CASE WHEN replica_id IS NULL THEN 0 ELSE 1 END,');
    // Fix-Runde 1 (I-1): verschachtelt statt AND (T-SQL wertet AND nicht garantiert kurzgeschlossen aus) — Funktion nur für AG-Datenbanken
    expect(P).toContain('SET @bev = 1;\n        IF @agdb = 1\n        BEGIN\n          SET @bev = ISNULL(sys.fn_hadr_backup_is_preferred_replica(@n), 0);\n        END\n        IF @bev <> 1');
    expect(P.split('fn_hadr_backup_is_preferred_replica').length - 1).toBe(1);
    expect(P).not.toMatch(/AND ISNULL\(sys\.fn_hadr/);
    expect(P).toContain("INSERT @r VALUES (N'ALFRED|nicht-bevorzugt');");
    const skip = P.indexOf("INSERT @r VALUES (N'ALFRED|nicht-bevorzugt');");
    const sonst = P.indexOf('ELSE', skip);
    // im Überspringen-Zweig: kein THROW (Job scheitert nicht), keine Sicherung, kein Kettenblick
    expect(P.slice(skip, sonst)).not.toMatch(/THROW|BACKUP|backupset|@fehler/);
    // die Rollenprüfung kommt vor jedem Lesen der Kette und vor jeder Sicherung (auch LOG)
    const rolle = P.indexOf('sys.fn_hadr_backup_is_preferred_replica');
    for (const x of ['sys.database_recovery_status', 'msdb.dbo.backupset', "EXEC sp_executesql @sql, N'@d nvarchar(600)'", 'BACKUP LOG ']) expect(P.indexOf(x), x).toBeGreaterThan(rolle);
    expect(sonst).toBeLessThan(P.indexOf('sys.database_recovery_status'));
    // keine copy-only-Umwege
    expect(P).not.toMatch(/\bCOPY_ONLY\b/i);
  });
  it('Fix-Runde 1 (D): AG-Datenbanken erreichen das Überspringen unabhängig vom Zustand; Datenbanken ohne AG behalten den Zustandsfilter', () => {
    const cursor = P.slice(P.indexOf('DECLARE d CURSOR'), P.indexOf('ORDER BY name;'));
    expect(cursor).toContain('WHERE database_id > 4 AND ((state = 0 AND is_read_only = 0) OR replica_id IS NOT NULL) AND source_database_id IS NULL');
    // nicht ONLINE/schreibgeschützt kann nur eine AG-Datenbank ankommen: Rollenprüfung zuerst, danach (bevorzugt) überspringen statt sichern
    expect(P).toContain('@online = CASE WHEN state = 0 AND is_read_only = 0 THEN 1 ELSE 0 END FROM sys.databases WHERE name = @n');
    expect(P).toContain("IF @online = 0 SET @grund = N'Datenbank nicht online oder schreibgeschuetzt';");
    expect(P.indexOf('IF @online = 0')).toBeGreaterThan(P.indexOf('IF @bev <> 1'));
    expect(P.indexOf('IF @online = 0')).toBeLessThan(P.indexOf("EXEC sp_executesql @sql, N'@d nvarchar(600)'"));
  });
  it('FULL-Erzwingung: AG-Datenbank ohne passende eigene Vollsicherung (dieser Server) → FULL statt DIFF/LOG, sichtbar markiert', () => {
    // Basis und Vorgänger der AG-Datenbank nur aus Sicherungen DIESES Servers (msdb je Replikat; RESTORE-Einträge tragen den Quellserver)
    expect(P.split('(@agdb = 0 OR b.server_name = @@SERVERNAME)').length - 1).toBe(2);
    expect(P).toMatch(/b\.server_name = @@SERVERNAME AND b\.type = 'D' AND b\.is_copy_only = 0 ORDER BY b\.backup_set_id DESC/);
    // noch keine Vollsicherung / Basis anderswo / Protokollkette auf diesem Rechner unterbrochen → erzwungen
    expect(P).toContain("ELSE IF @agdb = 1 AND @art = N'DIFF' AND @dbl IS NULL SET @erzw = N'noch keine Vollsicherung auf diesem Rechner';");
    expect(P).toContain("ELSE IF @agdb = 1 AND @art = N'LOG' AND @f IS NULL SET @erzw = N'noch keine Vollsicherung auf diesem Rechner';");
    expect(P).toContain('IF @dev IS NULL AND @agdb = 1 SET @erzw');
    expect(P).toContain('IF @dev IS NULL OR @lf < @f SET @erzw');
    expect(P).toContain("IF @erzw IS NOT NULL SET @eff = N'FULL';");
    expect(P).toContain("N'ALFRED-ERZWUNGEN|' + @n + N'|FULL statt ' + @art + N': ' + @erzw");
    // Datei, Befehl und Endung nach der wirksamen Art
    expect(P).toContain("SET @datei = @ordner + N'/' + @n + N'_' + @eff + N'_' + @zeit + ISNULL(N'_' + @bezug, N'') + CASE WHEN @eff = N'LOG' THEN N'.trn' ELSE N'.bak' END;");
    expect(P).toContain('SET @sql = CASE @eff');
    // Datenbanken ohne AG wie bisher: Überspringen ohne Vollsicherung, fremde Basis/Lücke bleibt Fehler
    expect(P).toContain("ELSE IF @art = N'DIFF' AND @dbl IS NULL SET @grund = N'noch keine Vollsicherung';");
    expect(P).toContain("ELSE IF @art = N'LOG' AND @f IS NULL SET @grund = N'noch keine Vollsicherung (Protokollkette beginnt erst danach)';");
    for (const t of ['THROW 50014', 'THROW 50015', 'THROW 50016']) expect(P, t).toContain(t);
    // erzwungene FULL beginnt eine neue Kette (kein Bezug)
    expect(P.indexOf("IF @erzw IS NOT NULL SET @eff = N'FULL';")).toBeLessThan(P.indexOf('SET @zeit = FORMAT(SYSUTCDATETIME()'));
    expect(P).toContain('IF @erzw IS NOT NULL SET @bezug = NULL;');
  });
  it('Fassungswechsel: neue Fassung, die Prüfung über msdb.sys.sql_modules spielt sie ein und meldet „geaendert“', () => {
    const neu = /alfred-fassung ([0-9a-f]{8})/.exec(SICHERUNG_PROZEDUR)![1]!;
    expect(neu).not.toBe(FASSUNG_VOR_TASK7);
    const t = sicherungJobsTsql();
    expect(t).not.toContain(FASSUNG_VOR_TASK7);
    const bedingung = `IF OBJECT_ID(N'msdb.dbo.alfred_sicherung', N'P') IS NULL OR CHARINDEX(N'alfred-fassung ${neu}', ISNULL(${PROZEDUR_DEFINITION}, N'')) = 0`;
    expect(t).toContain(bedingung);
    const ab = t.indexOf(bedingung);
    const ein = t.indexOf('EXEC msdb.sys.sp_executesql @proc;', ab);
    expect(ein).toBeGreaterThan(ab);
    expect(t.slice(ein, ein + 80)).toContain("SET @z = N'geaendert';");
    // Jobs tragen die Fassung in der Beschreibung → werden mit der neuen Fassung neu angelegt
    expect(t).toContain(`@description = N'Alfred I8e ${neu}'`);
    // nichts still: sicherung_einrichten meldet den Wechsel als Änderung
    expect(sicherungEinrichtenSkript(EINRICHTEN)).toContain('[ "$jz" = schon ] || GEAENDERT=1');
  });
});

describe.skipIf(!BASH)('I8e Paket 2 Task 7 — sicherung_jetzt rollenabhängig (Stubs)', { timeout: 120_000 }, () => {
  const lauf = (antwort: string, art: 'LOG' | 'FULL' = 'LOG') => bashLauf(sicherungJetztSkript({ art, datenbank: 'pruefdb01' }), [
    ...GEMEINSAM,
    `sql() { echo "$1" >>"$T/log"; printf '%s\\n' ${shQ(antwort)}; }`,
    'systemctl() { echo "systemctl $*" >>"$T/log"; }',
    'pruefe_datei() { [[ "$1" =~ ^/var/opt/mssql/backup/pruefdb01/pruefdb01_(LOG|FULL)_ ]]; }',
    'warte_schreibruhe() { :; }',
    "kette_py() { echo \"kette $*\" >>\"$T/log\"; if [ \"$1\" = geprueft ]; then echo 'ALFRED-GEPRUEFT {\"sha256\":\"ab\"}'; fi; }",
  ]);
  it('Sekundär: „ALFRED|nicht-bevorzugt“ → klarer Abbruch, keine Kopie angestoßen', () => {
    const r = lauf('ALFRED|nicht-bevorzugt');
    expect(r.rc).toBe(1);
    expect(String(r.e?.fehler)).toContain('nicht das bevorzugte Sicherungsreplikat');
    expect(r.log).not.toContain('systemctl start');
  });
  it('erzwungene FULL statt LOG: Ergebnis nennt die wirksame Art und den Grund', () => {
    const datei = '/var/opt/mssql/backup/pruefdb01/pruefdb01_FULL_20261117120000.bak';
    const r = lauf(`ALFRED-ERZWUNGEN|pruefdb01|FULL statt LOG: Protokollkette auf diesem Rechner unterbrochen (Rollenwechsel)\nALFRED|${datei}`);
    expect(r.rc, r.vorne + r.err).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'geaendert', art: 'FULL', angefordert: 'LOG', datenbank: 'pruefdb01', datei, fs01: true });
    expect(String(r.e?.erzwungen)).toContain('Rollenwechsel');
    const normal = lauf('ALFRED|/var/opt/mssql/backup/pruefdb01/pruefdb01_LOG_20261117120000_20261117114500.trn');
    expect(normal.e).toMatchObject({ art: 'LOG', angefordert: 'LOG', erzwungen: null });
  });
  it('pruefe_datei: bei LOG/DIFF auch die erzwungene FULL derselben Datenbank, nie eine andere Datenbank', () => {
    const s = sicherungJetztSkript({ art: 'DIFF', datenbank: 'pruefdb01' });
    expect(s).toContain('pruefe_datei() { [[ "$1" =~ ^/var/opt/mssql/backup/pruefdb01/pruefdb01_(DIFF|FULL)_[0-9]{14}(_[0-9]{14})?\\.(bak|trn)$ ]] && [ -f "$1" ]; }');
    expect(sicherungJetztSkript({ art: 'FULL', datenbank: 'pruefdb01' })).toContain('pruefe_datei() { [[ "$1" =~ ^/var/opt/mssql/backup/pruefdb01/pruefdb01_(FULL)_');
  });
});

describe.skipIf(!PYTHON)('I8e Paket 2 Task 7 — Ketten nach Rollenwechsel (Python)', { timeout: 120_000 }, () => {
  const JETZT = Date.UTC(2026, 10, 17, 12, 0, 0) / 1000;
  it('Neubeginn: erstes LOG der neuen Kette bezieht sich auf die eigene Vollsicherung → vorige Kette vollständig, kein Befund', () => {
    const w = welt();
    kette(w, 'pruefdb01', JETZT - 2 * TAG, 4);
    // nach dem Rollenwechsel: erzwungene FULL, LOG-Kette beginnt an ihr (die LOGs dazwischen liegen auf dem anderen Rechner)
    kette(w, 'pruefdb01', JETZT - TAG, 4);
    kopie(w, JETZT);
    const r = kopie(w, JETZT);
    expect(r.json.ok, JSON.stringify(r.json.befunde)).toBe(true);
    expect(r.json.befunde).toEqual([]);
    expect(r.json.datenbanken.pruefdb01.ketten.map((k: { vollstaendig: boolean }) => k.vollstaendig)).toEqual([true, true]);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('echte Lücke am Übergang (Vorgänger fehlt) bleibt Befund', () => {
    const w = welt();
    const a = kette(w, 'pruefdb01', JETZT - 2 * TAG, 4);
    // das erste LOG der neuen Kette verweist auf ein LOG, das es nicht gibt
    kette(w, 'pruefdb01', JETZT - TAG, 4, stempel(JETZT - 2 * TAG + 5 * 900));
    expect(a.letzte).not.toBe(stempel(JETZT - 2 * TAG + 5 * 900));
    kopie(w, JETZT);
    const r = kopie(w, JETZT);
    expect(r.json.ok).toBe(false);
    expect(r.json.befunde.join(' ')).toContain('Protokollsicherung');
    rmSync(w.wurzel, { recursive: true, force: true });
  });
  it('Aufbewahrung läuft über einen Rollenwechsel hinweg weiter (gelöschte Neubeginn-Kette als Grenze)', () => {
    const w = welt();
    let vor: string | undefined;
    for (let d = 20; d >= 0; d--) {
      const t0 = Math.floor((JETZT - d * TAG) / TAG) * TAG + 1800;
      // vor 15 Tagen Rollenwechsel: die Kette beginnt neu an ihrer eigenen Vollsicherung
      const k = kette(w, 'pruefdb01', t0, 3, d === 15 ? undefined : vor);
      vor = k.letzte;
    }
    // erster Lauf kopiert, zweiter wendet die Aufbewahrung an, dritter läuft ohne Befund über die gelöschten Ketten hinweg
    kopie(w, JETZT);
    const r2 = kopie(w, JETZT);
    expect(r2.json.befunde, JSON.stringify(r2.json.befunde)).toEqual([]);
    expect(r2.json.geloescht.length).toBeGreaterThan(0);
    const r3 = kopie(w, JETZT);
    expect(r3.json.ok, JSON.stringify(r3.json.befunde)).toBe(true);
    expect(r3.json.befunde).toEqual([]);
    rmSync(w.wurzel, { recursive: true, force: true });
  });
});

describe.skipIf(!PYTHON)('I8e Paket 2 Task 7 — Rollen je Datenbank (Python PY_ROLLEN)', { timeout: 120_000 }, () => {
  /** PY_ROLLEN als Modul laden, lies/hadr_an/sqlcmd_lauf ersetzen, rollen() ausgeben */
  function rollen(patch: string) {
    const prog = `import sys, json\nsys.stdout.reconfigure(encoding='utf-8')\nns = {'__name__': 'alfred_test'}\nexec(compile(sys.stdin.read(), 'rollen', 'exec'), ns)\n${patch}\nprint('ALFRED-T ' + json.dumps(ns['rollen']()))`;
    const r = spawnSync(PYTHON!, ['-c', prog], { input: PY_ROLLEN, encoding: 'utf8' });
    const z = r.stdout.split(/\r?\n/).find(x => x.startsWith('ALFRED-T '));
    return { json: z ? JSON.parse(z.slice(9)) : undefined, err: r.stderr };
  }
  const SQL_OK = (aus: string, rc = 0) => `class P: pass\ndef s(login, kw):\n    p = P(); p.returncode = ${rc}; p.stdout = ${JSON.stringify(aus)}; p.stderr = ''\n    return p\nns['sqlcmd_lauf'] = s`;
  it('Rollen aus SQL über die Zugangsdatei des Resource-Agents: PRIMARY/SECONDARY/keine AG; Unlesbares → unbekannt', () => {
    const r = rollen(`ns['lies'] = lambda p: 'alfred_pacemaker\\nPm-Wert-1234'\n${SQL_OK('ALFRED|D|pruefdb01|PRIMARY\nALFRED|D|lokaldb01|KEINE\nALFRED|D|zweitdb01|SECONDARY\nALFRED|D|komischdb|-\nALFRED|D|x;y|PRIMARY\n')}`);
    expect(r.json, r.err).toEqual({ rollen: { pruefdb01: 'PRIMARY', lokaldb01: 'keine AG', zweitdb01: 'SECONDARY', komischdb: 'unbekannt' } });
  });
  it('fail-closed: SQL-Fehler → Fehler ohne Kennwort, keine Rollen; Zugangsdatei fehlt → keine AG nur bei HADR aus', () => {
    const f = rollen(`ns['lies'] = lambda p: 'alfred_pacemaker\\nPm-Wert-1234'\n${SQL_OK('Login failed for alfred_pacemaker Pm-Wert-1234', 1)}`);
    expect(f.json.rollen).toBeUndefined();
    expect(f.json.fehler).toContain('Login failed');
    expect(f.json.fehler).not.toContain('Pm-Wert-1234');
    expect(rollen("ns['lies'] = lambda p: None\nns['hadr_an'] = lambda: False").json).toEqual({ alle: 'keine AG' });
    const an = rollen("ns['lies'] = lambda p: None\nns['hadr_an'] = lambda: True").json;
    expect(an.alle).toBeUndefined();
    expect(an.rollen).toBeUndefined();
    expect(an.fehler).toContain('Rolle nicht lesbar');
  });
  it('Fix-Runde 1 (M-2): hadr_an streng — mssql.conf fehlt/unlesbar/kaputt → unbekannt (nie „keine AG“); nur gelesenes HADR aus → keine AG', () => {
    const d = mkdtempSync(join(tmpdir(), 'alfred-hadr-'));
    const mit = (konf: string) => rollen(`ns['lies'] = lambda p: None\nns['KONF'] = ${JSON.stringify(konf)}`).json;
    // fehlt
    const fehlt = mit(join(d, 'gibt-es-nicht.conf'));
    expect(fehlt.alle).toBeUndefined();
    expect(fehlt.fehler).toContain('mssql.conf fehlt oder ist unlesbar');
    // unlesbar (Ordner statt Datei)
    mkdirSync(join(d, 'ordner.conf'));
    expect(mit(join(d, 'ordner.conf')).fehler).toContain('mssql.conf fehlt oder ist unlesbar');
    // kaputt (kein Abschnittskopf)
    writeFileSync(join(d, 'kaputt.conf'), 'hadrenabled = 0\n');
    expect(mit(join(d, 'kaputt.conf')).alle).toBeUndefined();
    // gelesen: HADR aus (ausdrücklich oder Abschnitt fehlt) → keine AG; an → nicht lesbar
    writeFileSync(join(d, 'aus.conf'), '[hadr]\nhadrenabled = 0\n');
    expect(mit(join(d, 'aus.conf'))).toEqual({ alle: 'keine AG' });
    writeFileSync(join(d, 'ohne.conf'), '[memory]\nmemorylimitmb = 3072\n');
    expect(mit(join(d, 'ohne.conf'))).toEqual({ alle: 'keine AG' });
    writeFileSync(join(d, 'an.conf'), '[hadr]\nhadrenabled = 1\n');
    expect(mit(join(d, 'an.conf')).fehler).toContain('Zugangsdatei des Resource-Agents fehlt');
    rmSync(d, { recursive: true, force: true });
  });
});

/** absoluter Pfad des Python-Interpreters (der Baustein setzt PATH fest) */
const PY_EXE = PYTHON ? spawnSync(PYTHON, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim().replace(/\\/g, '/') : undefined;

describe.skipIf(!BASH || !PY_EXE)('I8e Paket 2 Task 7 — sicherungen nennt die Rolle je Datenbank (Stubs)', { timeout: 120_000 }, () => {
  const LISTE = { zustand: 'gelesen', host: 'sqllnx01', status: null, datenbanken: { pruefdb01: { ketten: [], waisen: [], fs01Dateien: 0, lokalDateien: 2 } } };
  const lauf = (rollenZeile: string) => bashLauf(sicherungenSkript(), [
    ...GEMEINSAM,
    `python3() { ${shQ(PY_EXE!)} "$@"; }`,
    'KONF_DATEI="$T/konf"; : >"$KONF_DATEI"',
    `kette_py() { echo ${shQ(`ALFRED-LISTE ${JSON.stringify(LISTE)}`)}; }`,
    'systemctl() { echo active; }',
    "zugangsdatei_zustand() { echo 'vorhanden (0600)'; }",
    `rollen_lesen() { ${rollenZeile ? `echo ${shQ(rollenZeile)}` : ':'}; }`,
  ]);
  const rolle = (r: ReturnType<typeof lauf>) => (r.e?.datenbanken as Record<string, { rolle: string }> | undefined)?.pruefdb01?.rolle;
  it('Rolle je Datenbank aus PY_ROLLEN; Datenbanken ohne Sicherung hier erscheinen mit Rolle', () => {
    const r = lauf(`ALFRED-ROLLEN ${JSON.stringify({ rollen: { pruefdb01: 'SECONDARY', neudb01: 'PRIMARY' } })}`);
    expect(r.rc, r.vorne + r.err).toBe(0);
    expect(rolle(r)).toBe('SECONDARY');
    expect(r.e?.ohneSicherung).toEqual({ neudb01: 'PRIMARY' });
  });
  it('fail-closed: keine/kaputte Rollen-Ausgabe oder fehlende Datenbank → unbekannt/nicht vorhanden, nie PRIMARY', () => {
    for (const z of ['', 'ALFRED-ROLLEN {kaputt', `ALFRED-ROLLEN ${JSON.stringify({ fehler: 'Login failed' })}`, `ALFRED-ROLLEN ${JSON.stringify({ rollen: { pruefdb01: 'MASTER' } })}`]) {
      const r = lauf(z);
      expect(r.rc, z + r.vorne + r.err).toBe(0);
      expect(rolle(r), z).toBe('unbekannt');
    }
    expect(rolle(lauf(`ALFRED-ROLLEN ${JSON.stringify({ rollen: { anderedb: 'PRIMARY' } })}`))).toBe('nicht vorhanden');
    expect(rolle(lauf(`ALFRED-ROLLEN ${JSON.stringify({ alle: 'keine AG' })}`))).toBe('keine AG');
    expect(lauf(`ALFRED-ROLLEN ${JSON.stringify({ fehler: 'Login failed' })}`).e?.rollenFehler).toBe('Login failed');
  });
  it('Skripttext: Rollen über die Zugangsdatei des Resource-Agents, nie über Tresor-Eingabe', () => {
    const s = sicherungenSkript();
    expect(s).toContain('PY_ROLLEN=');
    expect(PY_ROLLEN).toContain('/var/opt/mssql/secrets/passwd');
    expect(PY_ROLLEN).toContain('SQLCMDPASSWORD=kw');
    expect(PY_ROLLEN).not.toMatch(/"-P"/);
    expect(s.split('# ALFRED-ABLAUF')[1]).not.toContain('ALFRED_EINGABE');
  });
});
