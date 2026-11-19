import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sqlKopf, SQL_HILFE, PY_SQL_ZIEL, PY_STATUS, sqlErgebnis, sqlSkript, installSkript, statusSkript, resteEntfernenSkript,
  LINUX_SQL_BAUSTEINE, TLS_PRUEF_SCHALTER, TLS_PRUEF_FEHLER,
} from './linux-sql.js';
import { tlsPruefungSchaltenSkript, tlsEntfernenSkript, pruefeTlsPruefung, tlsErzwingenSkript } from './linux-sql-tls.js';
import { adLoginSkript, adLoginEntfernenSkript } from './linux-sql-ad.js';
import { sicherungEinrichtenSkript, sicherungJetztSkript, sicherungenSkript, wiederherstellenSkript, kettengrenzenSkript, PY_ROLLEN } from './linux-sql-sicherung.js';
import {
  haStatusSkript, haAgEndpunktSkript, haAgReplikatSkript, haAgAbschlussSkript, haAgEntfernenSkript, haAgFailoverSkript, PY_HA_STATUS, PY_AG_STATUS_FUNK, HA_KNOTEN,
  type HaAgEndpunktParameter, type HaAgReplikatParameter, type HaAgAbschlussParameter, type HaAgEntfernenParameter,
} from './linux-ha.js';
import { linuxBausteinBekannt } from '../fernzugriff/linux-bausteine.js';
import { LinuxSqlSkill, LINUX_SQL_MIN_ZEITLIMIT_S } from './linux-sql-skill.js';
import { pruefeChangePlan } from './change-schritte.js';

// Synchrone Bash-/Python-Läufe (spawnSync) blockieren den Worker; ohne Rückgabe an die Ereignisschleife zwischen den Tests
// kommt die RPC-Antwort von vitest zu spät („Timeout calling onTaskUpdate“) — nach jedem Test einmal abgeben
afterEach(() => new Promise<void>(r => setImmediate(r)));

// I8e Etappe 3 Task 7 — Alfreds eigene SQL-Verbindungen mit Zertifikatsprüfung, je Host schaltbar, ohne stillen Rückfall auf -C

const BASH = (() => { const r = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }); return r.status === 0 && /^\d+\./.test(r.stdout.trim()); })();
const PYTHON = ['python3', 'python'].find(p => spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3');
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const ohneCr = (s: string) => s.replace(/\r/g, '');
const FQDN = 'sqllnx01.ad.3033.at';
const SSL_FEHLER = 'Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : SSL Provider: [error:0A000086:SSL routines::certificate verify failed:unable to get local issuer certificate].';

// ── Testdaten der AG-Bausteine (wie linux-ha.test.ts AG_SKRIPTE) ──────────────────────────────────────────────────────────────────
const BES = { primaer: 'sqllnx01', sekundaer: 'sqllnx02', konfig: 'sqllnxcfg' };
const DER = (f: string) => `30820010${f.repeat(16)}`;
const PEERS: Record<string, HaAgReplikatParameter['peers']> = {
  sqllnx01: [{ name: 'sqllnx02', zertifikat: DER('B2'), fingerabdruck: '2'.repeat(40) }, { name: 'sqllnxcfg', zertifikat: DER('C3'), fingerabdruck: '3'.repeat(40) }],
  sqllnx02: [{ name: 'sqllnx01', zertifikat: DER('A1'), fingerabdruck: '1'.repeat(40) }, { name: 'sqllnxcfg', zertifikat: DER('C3'), fingerabdruck: '3'.repeat(40) }],
  sqllnxcfg: [{ name: 'sqllnx01', zertifikat: DER('A1'), fingerabdruck: '1'.repeat(40) }, { name: 'sqllnx02', zertifikat: DER('B2'), fingerabdruck: '2'.repeat(40) }],
};
const ROLLE_VON = { sqllnx01: 'primaer', sqllnx02: 'sekundaer', sqllnxcfg: 'konfig' } as const;
type K = keyof typeof ROLLE_VON;
const AG_EP = (k: K): HaAgEndpunktParameter => ({ cluster: 'sqllnxcl01', ag: 'sqllnxag01', besetzung: { ...BES }, rolle: ROLLE_VON[k], knoten: [...HA_KNOTEN] });
const AG_RP = (k: K): HaAgReplikatParameter => ({ ag: 'sqllnxag01', besetzung: { ...BES }, rolle: ROLLE_VON[k], knoten: [...HA_KNOTEN], peers: PEERS[k]!.map(x => ({ ...x })), datenbanken: ['pruefdb01'] });
const AG_AB: HaAgAbschlussParameter = { ag: 'sqllnxag01', besetzung: { ...BES }, knoten: [...HA_KNOTEN], datenbanken: ['alfredpruef'], vip: { ip: '10.203.30.13', praefix: 27 } };
const AG_EN = (k: K): HaAgEntfernenParameter => ({ ag: 'sqllnxag01', besetzung: { ...BES }, rolle: ROLLE_VON[k], knoten: [...HA_KNOTEN], ressourcen: k === 'sqllnx01' });
function AG_SKRIPTE(): string[] {
  return (['sqllnx01', 'sqllnx02', 'sqllnxcfg'] as const).flatMap(k => [haAgEndpunktSkript(AG_EP(k)), haAgReplikatSkript(AG_RP(k)), haAgEntfernenSkript(AG_EN(k))])
    .concat(haAgAbschlussSkript(AG_AB), haAgFailoverSkript({ ag: 'sqllnxag01', ziel: 'sqllnx02', vorher: 'sqllnx01', knoten: [...HA_KNOTEN] }));
}

/** alle erzeugten Skripte mit SQL-Verbindungen (linux_sql, Sicherung, linux_ha) */
function alleSkripte(): Array<[string, string]> {
  return [
    ['installation', installSkript({ version: '17.0.4006.2-1', edition: 'EnterpriseDeveloper' })],
    ['tempdb', sqlSkript('tempdb', { dateien: 4, groesseMB: 1024, wachstumMB: 256, logGroesseMB: 1024 })],
    ['maxspeicher', sqlSkript('maxspeicher', { mb: 2048 })],
    ['login', sqlSkript('login', { name: 'app_kunden', serverrollen: ['dbcreator'] })],
    ['pruefdaten', sqlSkript('pruefdaten', { datenbank: 'pruefdb01' })],
    ['status', statusSkript()],
    ['reste', resteEntfernenSkript()],
    ['schalten-an', tlsPruefungSchaltenSkript({ an: true, cn: FQDN })],
    ['schalten-aus', tlsPruefungSchaltenSkript({ an: false })],
    // Task 8: Erzwingen und AD-Logins verbinden ebenfalls nur über sql_ziel
    ['erzwingen-an', tlsErzwingenSkript({ an: true, host: 'sqllnx01', cn: FQDN })],
    ['ad-login', adLoginSkript({ gruppe: 'SQL-Linux-Admins', serverrolle: 'sysadmin' })],
    ['ad-login-entfernen', adLoginEntfernenSkript({ gruppe: 'SQL-Linux-Kunden', datenbank: 'kunden', datenbankrolle: 'db_datareader' })],
    ['sich-einrichten', sicherungEinrichtenSkript({ server: 'fs01.ad.3033.at', freigabe: 'SQLLinuxBackup$', konto: 'svc-sqllnx-backup', domaene: 'AD3033', budgetGiB: 64 })],
    ['sich-jetzt', sicherungJetztSkript({ art: 'LOG', datenbank: 'pruefdb01' })],
    ['sich-liste', sicherungenSkript()],
    ['sich-wiederherstellen', wiederherstellenSkript({ datenbank: 'pruefdb01', ziel: 'alfred_wh_pruefdb01' })],
    ['sich-grenzen', kettengrenzenSkript()],
    ['ha-status', haStatusSkript()],
    ...AG_SKRIPTE().map((s, i) => [`ag-${i}`, s] as [string, string]),
  ];
}

/** Text ohne die gemeinsame Bash-Funktion sql_ziel und ohne die Python-Funktion sql_ziel() — dort (und nur dort) steht -C */
function ohneSqlZiel(t: string): { rest: string; bash: number; python: number } {
  let bash = 0; let python = 0;
  const zeilen = t.split('\n'); const rest: string[] = [];
  for (let i = 0; i < zeilen.length; i++) {
    const z = zeilen[i]!;
    if (z === 'sql_ziel() {') { bash++; while (i < zeilen.length && zeilen[i] !== '}') i++; continue; }
    if (z === 'def sql_ziel():') { python++; i++; while (i < zeilen.length && /^\s/.test(zeilen[i]!)) i++; i--; continue; }
    rest.push(z);
  }
  return { rest: rest.join('\n'), bash, python };
}
const MIT_C = /(^|[\s"'([,])-C(?=[\s"',)\]]|$)/m;

describe('Task 7 — kein -C außerhalb von sql_ziel (alle erzeugten Skripte)', () => {
  it('jedes Skript mit sqlcmd: -C nur in sql_ziel (Bash) bzw. sql_ziel() (Python); sqlcmd nur über sql_ziel/sqlcmd_sa', () => {
    for (const [name, s] of alleSkripte()) {
      const { rest, bash, python } = ohneSqlZiel(s);
      expect(MIT_C.test(rest), `${name}: -C außerhalb von sql_ziel`).toBe(false);
      expect(rest, name).not.toMatch(/-S\s*["']?localhost/);
      if (/SQLCMD/.test(s)) expect(bash + python, `${name}: kein sql_ziel`).toBeGreaterThan(0);
      // jeder Bash-Aufruf von sqlcmd (Kennwort in SQLCMDPASSWORD) nimmt das Ziel aus SQL_ZIEL
      for (const z of rest.split('\n').filter(x => x.includes('SQLCMDPASSWORD="'))) expect(z, name).toContain('"$SQLCMD" "${SQL_ZIEL[@]}"');
    }
    // Python: jedes subprocess.run mit SQLCMD baut die Argumente mit sql_ziel()
    for (const py of [PY_STATUS, PY_ROLLEN, PY_HA_STATUS, PY_AG_STATUS_FUNK]) {
      for (const z of py.split('\n').filter(x => /subprocess\.run\(\[SQLCMD/.test(x))) expect(z).toContain('[SQLCMD] + sql_ziel() + [');
      expect(ohneSqlZiel(py).python).toBe(1);
    }
  });

  it('eine gemeinsame Funktion: SQL_HILFE trägt sql_ziel, sql, sqlcmd_sa; die Sicherung nutzt sie über sqls; Python-Schnipsel einmal je Programm', () => {
    const h = SQL_HILFE.join('\n');
    expect(h.match(/^sql_ziel\(\) \{/gm)).toHaveLength(1);
    expect(h).toContain(`TLS_SCHALTER='${TLS_PRUEF_SCHALTER}'`);
    expect(h).toContain(`SQL_TLS_FEHLER='${TLS_PRUEF_FEHLER}'`);
    expect(TLS_PRUEF_FEHLER).toBe('Zertifikatsprüfung fehlgeschlagen (Schalter /etc/alfred/sqllnx-tls-pruefen)');
    expect(wiederherstellenSkript({ datenbank: 'pruefdb01', ziel: 'alfred_wh_pruefdb01' })).toContain('sqls() { sql "$1" -s "|"; }');
    for (const py of [PY_STATUS, PY_ROLLEN, PY_HA_STATUS]) expect(py.split(PY_SQL_ZIEL).length, 'PY_SQL_ZIEL genau einmal').toBe(2);
    // der Status liest denselben Schalter
    expect(PY_STATUS).toContain(`tls["pruefSchalter"] = os.path.lexists(${JSON.stringify(TLS_PRUEF_SCHALTER)})`);
  });

  it.skipIf(!BASH)('bash -n: neue und geänderte Skripte syntaktisch gültig', () => {
    for (const [name, s] of alleSkripte()) { const r = spawnSync('bash', ['-n'], { input: s, encoding: 'utf8' }); expect(r.status, `${name}: ${r.stderr}`).toBe(0); }
  });

  it.skipIf(!PYTHON)('Python-Programme parsen', () => {
    for (const py of [PY_STATUS, PY_ROLLEN, PY_HA_STATUS, PY_SQL_ZIEL]) {
      const r = spawnSync(PYTHON!, ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: py, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    }
  });
});

// ── Bash: sql_ziel / sql / bereit mit sqlcmd-Stub ────────────────────────────────────────────────────────────────────────────────

const ORDNER: string[] = [];
afterAll(() => { for (const d of ORDNER) rmSync(d, { recursive: true, force: true }); });
function ordner(): string {
  const T = mkdtempSync(join(tmpdir(), 'alfred-tlsp-')).replace(/\\/g, '/');
  ORDNER.push(T);
  for (const d of ['run', 'etc']) mkdirSync(join(T, d), { recursive: true });
  // sqlcmd-Stub: Argumente je Aufruf (eine Zeile, durch | getrennt) nach $T/argv; Fehlerdatei → Text + Exit 1; sonst ALFRED|TRUE
  writeFileSync(join(T, 'sqlcmd'), `#!/bin/bash\n(IFS='|'; printf '%s\\n' "$*") >>"${T}/argv"\ncat >/dev/null\nif [ -f "${T}/fehler" ]; then cat "${T}/fehler"; exit 1; fi\nif [ -f "${T}/unverschluesselt" ]; then echo 'ALFRED|FALSE'; else echo 'ALFRED|TRUE'; fi\n`);
  return T;
}
interface Lauf { rc: number; e?: Record<string, unknown>; aus: string; argv: string[] }
function lauf(T: string, skript: string, stubs: string, eingabe = '{"sa":"Sa-Geheim-1"}'): Lauf {
  writeFileSync(join(T, 'argv'), '');
  const text = skript.replace('# ALFRED-ABLAUF', `${stubs}\n# ALFRED-ABLAUF`);
  writeFileSync(join(T, 'eingabe'), eingabe);
  const huelle = [`T=${q(T)}`, 'chmod +x "$T/sqlcmd"', 'ALFRED_EINGABE=$(cat "$T/eingabe")', `( ${text}\n) >"$T/aus" 2>&1; echo "RC=$?"`].join('\n');
  const o = spawnSync('bash', [], { input: huelle, encoding: 'utf8' });
  const aus = ohneCr(readFileSync(join(T, 'aus'), 'utf8'));
  return { rc: Number(/RC=(\d+)/.exec(o.stdout)?.[1] ?? -1), e: sqlErgebnis(aus), aus, argv: ohneCr(readFileSync(join(T, 'argv'), 'utf8')).split('\n').filter(Boolean) };
}
/** kleines Skript aus Kopf + SQL_HILFE: bereit, dann eine Abfrage über sql (wie jeder Baustein) */
const PROBE = [...sqlKopf('sql.probe', {}), ...SQL_HILFE, '# ALFRED-ABLAUF', 'SA=x', 'bereit || abbruch "SQL Server antwortet nicht"', 'a=$(sql "SELECT 1")', 'ergebnis "{\\"zustand\\":\\"ok\\"}"'].join('\n');
/** absolute Pfade: der Baustein-Kopf setzt PATH auf die Linux-Standardordner (Git Bash: python unter C:) */
const PYTHON_PFAD = BASH && PYTHON ? spawnSync('bash', ['-c', `command -v ${PYTHON}`], { encoding: 'utf8' }).stdout.trim() : 'python3';
const PY_STUB = `python3() { PYTHONIOENCODING=utf-8 ${q(PYTHON_PFAD)} "$@" | tr -d '\\r'; }`;
const PFADE = `${PY_STUB}\nTLS_SCHALTER="$T/etc/sqllnx-tls-pruefen"; SQLCMD="$T/sqlcmd"; sleep() { :; }`;

describe.skipIf(!BASH || !PYTHON)('Task 7 — sql_ziel ausgeführt (sqlcmd-Stub)', { timeout: 60_000 }, () => {
  it('ohne Schalter: -C -S localhost (wie bisher)', () => {
    const T = ordner();
    const r = lauf(T, PROBE, PFADE);
    expect(r.rc, r.aus).toBe(0);
    expect(r.argv.length).toBe(2);
    for (const a of r.argv) { expect(a.split('|').slice(0, 3)).toEqual(['-C', '-S', 'localhost']); expect(a.split('|')).not.toContain('-N'); }
  });

  it('mit Schalter: -N -S <fqdn aus der Datei>, nie -C', () => {
    const T = ordner();
    writeFileSync(join(T, 'etc', 'sqllnx-tls-pruefen'), `${FQDN}\n`);
    const r = lauf(T, PROBE, PFADE);
    expect(r.rc, r.aus).toBe(0);
    expect(r.argv.length).toBe(2);
    for (const a of r.argv) { expect(a.split('|').slice(0, 3)).toEqual(['-N', '-S', FQDN]); expect(a.split('|')).not.toContain('-C'); expect(a.split('|')).not.toContain('localhost'); }
    // ohne abschließenden Zeilenumbruch ebenso
    writeFileSync(join(T, 'etc', 'sqllnx-tls-pruefen'), FQDN);
    expect(lauf(T, PROBE, PFADE).argv[0]!.split('|').slice(0, 3)).toEqual(['-N', '-S', FQDN]);
  });

  it('ungültiger Schalter → Abbruch mit klarer Meldung, kein sqlcmd-Aufruf (fail-closed)', () => {
    for (const inhalt of ['evil.example.com\n', `${FQDN}\n${FQDN}\n`, `${FQDN}\n\n`, '\n', '', 'SQLLNX01.ad.3033.at\n', `${FQDN} \n`, 'sqllnx01.ad.3033.at.evil\n', '-C\n']) {
      const T = ordner();
      writeFileSync(join(T, 'etc', 'sqllnx-tls-pruefen'), inhalt);
      const r = lauf(T, PROBE, PFADE);
      expect(r.rc, JSON.stringify(inhalt)).toBe(1);
      expect(String(r.e?.fehler), JSON.stringify(inhalt)).toContain('ungültig (erwartet genau eine Zeile <host>.ad.3033.at) — keine Verbindung ohne Zertifikatsprüfung');
      expect(r.argv, JSON.stringify(inhalt)).toEqual([]);
    }
    // ein Ordner statt einer Datei: nicht lesbar
    const T = ordner();
    mkdirSync(join(T, 'etc', 'sqllnx-tls-pruefen'));
    const r = lauf(T, PROBE, PFADE);
    expect(r.rc).toBe(1);
    expect(String(r.e?.fehler)).toContain('nicht lesbar — keine Verbindung ohne Zertifikatsprüfung');
    expect(r.argv).toEqual([]);
  });

  it('Schalter gesetzt + Zertifikatsfehler → Abbruch „Zertifikatsprüfung fehlgeschlagen“ mit sqlcmd-Zeile, sofort, kein zweiter Versuch mit -C', () => {
    const T = ordner();
    writeFileSync(join(T, 'etc', 'sqllnx-tls-pruefen'), `${FQDN}\n`);
    writeFileSync(join(T, 'fehler'), `${SSL_FEHLER}\n`);
    const r = lauf(T, PROBE, PFADE);
    expect(r.rc).toBe(1);
    expect(String(r.e?.fehler)).toBe(`${TLS_PRUEF_FEHLER}: ${SSL_FEHLER}`);
    expect(r.argv).toHaveLength(1);
    expect(r.argv.join('\n')).not.toMatch(/(^|\|)-C(\||$)/m);
    // anderer Verbindungsfehler (Dienst nicht erreichbar): wartet wie bisher, bricht dann mit derselben Meldung ab — ebenfalls nie -C
    writeFileSync(join(T, 'fehler'), 'Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : Login timeout expired.\n');
    const w = lauf(T, PROBE, PFADE);
    expect(w.rc).toBe(1);
    expect(String(w.e?.fehler)).toBe(`${TLS_PRUEF_FEHLER}: Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : Login timeout expired.`);
    expect(w.argv).toHaveLength(60);
    expect(w.argv.every(a => a.startsWith(`-N|-S|${FQDN}|`))).toBe(true);
  });

  it('ohne Schalter scheitert bereit wie bisher (eigene Meldung des Bausteins, kein TLS-Text)', () => {
    const T = ordner();
    writeFileSync(join(T, 'fehler'), 'Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : Login timeout expired.\n');
    const r = lauf(T, PROBE, PFADE);
    expect(r.rc).toBe(1);
    expect(r.e?.fehler).toBe('SQL Server antwortet nicht');
  });

  it('Sicherung (sqls) und echte Bausteine: dasselbe Ziel', () => {
    const T = ordner();
    writeFileSync(join(T, 'etc', 'sqllnx-tls-pruefen'), `${FQDN}\n`);
    const sqls = [...sqlKopf('sql.probe', {}), ...SQL_HILFE, 'sqls() { sql "$1" -s "|"; }', '# ALFRED-ABLAUF', 'SA=x', 'a=$(sqls "SELECT 1")', 'ergebnis "{\\"zustand\\":\\"ok\\"}"'].join('\n');
    const r = lauf(T, sqls, PFADE);
    expect(r.rc, r.aus).toBe(0);
    expect(r.argv[0]!.split('|').slice(0, 3)).toEqual(['-N', '-S', FQDN]);
    expect(r.argv[0]).toMatch(/\|-s\|\|?$/);
    // echter Baustein (maxspeicher): erste Verbindung (bereit) geht an den FQDN
    const m = lauf(T, sqlSkript('maxspeicher', { mb: 2048 }), PFADE);
    expect(m.argv.length).toBeGreaterThan(0);
    expect(m.argv.every(a => a.startsWith(`-N|-S|${FQDN}|`))).toBe(true);
  });
});

// ── Python: sql_ziel() / sql_tls_fehler ─────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!PYTHON)('Task 7 — Python-Schnipsel sql_ziel()', { timeout: 60_000 }, () => {
  /** PY_ROLLEN (Sicherung) als Modul geladen, Schalter umgelenkt, subprocess.run ersetzt — Ergebnis: Argumente, rollen() */
  function rollen(schalter: string | null, antwort: { rc: number; out?: string; err?: string }) {
    const T = ordner();
    const sch = join(T, 'etc', 'sqllnx-tls-pruefen').replace(/\\/g, '/');
    if (schalter !== null) writeFileSync(sch, schalter);
    writeFileSync(join(T, 'pm'), 'alfred_pacemaker\nPm-Geheim-2\n');
    const prog = [
      'import json, types',
      `g = {"__name__": "test"}`,
      `exec(compile(${JSON.stringify(PY_ROLLEN)}, "rollen", "exec"), g)`,
      `g["SQL_SCHALTER"] = ${JSON.stringify(sch)}`,
      `g["PMDATEI"] = ${JSON.stringify(join(T, 'pm').replace(/\\/g, '/'))}`,
      'aufrufe = []',
      'def run(a, **k):',
      '    aufrufe.append(a)',
      `    return types.SimpleNamespace(returncode=${antwort.rc}, stdout=${JSON.stringify(antwort.out ?? '')}, stderr=${JSON.stringify(antwort.err ?? '')})`,
      'g["subprocess"].run = run',
      'print(json.dumps({"r": g["rollen"](), "argv": aufrufe}))',
    ].join('\n');
    const r = spawnSync(PYTHON!, ['-'], { input: prog, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
    expect(r.stderr).toBe('');
    return JSON.parse(r.stdout.trim().split('\n').pop()!) as { r: Record<string, unknown>; argv: string[][] };
  }

  it('ohne Schalter -C -S localhost; mit Schalter -N -S <fqdn>', () => {
    const o = rollen(null, { rc: 0, out: 'ALFRED|D|pruefdb01|PRIMARY\n' });
    expect(o.argv[0]!.slice(1, 4)).toEqual(['-C', '-S', 'localhost']);
    expect(o.r).toEqual({ rollen: { pruefdb01: 'PRIMARY' } });
    const m = rollen(`${FQDN}\n`, { rc: 0, out: 'ALFRED|D|pruefdb01|PRIMARY\n' });
    expect(m.argv[0]!.slice(1, 4)).toEqual(['-N', '-S', FQDN]);
    expect(m.argv[0]).not.toContain('-C');
    expect(m.argv[0]).toContain('alfred_pacemaker');
  });

  it('ungültiger Schalter → Fehler, kein sqlcmd-Aufruf; Schalter + Verbindungsfehler → feste Meldung, Kennwort geschwärzt, kein zweiter Versuch', () => {
    for (const inhalt of ['evil.example.com\n', `${FQDN}\n\n`, `${FQDN}\nx\n`, '', 'SQLLNX01.ad.3033.at']) {
      const o = rollen(inhalt, { rc: 0 });
      expect(o.argv, JSON.stringify(inhalt)).toEqual([]);
      expect(String(o.r.fehler), JSON.stringify(inhalt)).toContain('ungültig (erwartet genau eine Zeile <host>.ad.3033.at) - keine Verbindung ohne Zertifikatsprüfung');
    }
    const f = rollen(`${FQDN}\n`, { rc: 1, err: `${SSL_FEHLER} Pm-Geheim-2\n` });
    expect(f.argv).toHaveLength(1);
    expect(String(f.r.fehler)).toBe(`${TLS_PRUEF_FEHLER}: ${SSL_FEHLER} [geschwärzt]`);
    // T-SQL-Fehler (Msg …) mit Schalter: kein TLS-Text, bisherige Meldung
    const t = rollen(`${FQDN}\n`, { rc: 1, out: "Msg 208, Level 16, State 1, Server x, Line 1 Invalid object name 'y'." });
    expect(String(t.r.fehler)).not.toContain('Zertifikatsprüfung');
    // ohne Schalter: Verbindungsfehler bleibt die bisherige Meldung
    expect(String(rollen(null, { rc: 1, err: SSL_FEHLER }).r.fehler)).not.toContain('Zertifikatsprüfung');
  });

  it('PY_STATUS und AG-Lage: SqlZielFehler als sqlFehler, TLS-Fehler mit fester Meldung', () => {
    expect(PY_STATUS).toContain('except SqlZielFehler as e:');
    expect(PY_STATUS).toContain('r["sqlFehler"] = sql_tls_fehler(p) or');
    expect(PY_AG_STATUS_FUNK).toContain('except SqlZielFehler as e:');
    expect(PY_AG_STATUS_FUNK).toContain('tf = sql_tls_fehler(p)');
  });
});

// ── tls_pruefung_schalten ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Stubs nach den Hilfen: Pfade in den Testordner, openssl/alfreds/lies je Datei-Schalter, Rechte als Protokoll */
const SCHALT_STUBS = `${PFADE}
TMP_BASIS="$T/run"; CRT="$T/tls.crt"; CA_BUNDLE="$T/bundle.crt"; CA_ISS="$T/iss.crt"; MANIFEST="$T/manifest"
log() { printf '%s\\n' "$*" >>"$T/log"; }
openssl() { log "openssl $*"; case "$1" in x509) [ ! -f "$T/abgelaufen" ] ;; verify) if [ -f "$T/kette_kaputt" ]; then echo "error 20 at 0 depth lookup: unable to get local issuer certificate"; return 2; fi ;; esac; }
alfreds() { [ -f "$T/alfreds" ]; }
lies() { cat "$T/conf_$2" 2>/dev/null || true; }
chown() { log "chown $*"; }
chmod() { log "chmod $*"; command chmod "$@"; }
rechte() { [ -e "$1" ] && echo '644 root root'; }`;

describe.skipIf(!BASH || !PYTHON)('Task 7 — tls_pruefung_schalten ausgeführt', { timeout: 120_000 }, () => {
  function welt(): string {
    const T = ordner();
    writeFileSync(join(T, 'tls.crt'), 'CERT'); writeFileSync(join(T, 'alfreds'), ''); writeFileSync(join(T, 'conf_tlscert'), `${T}/tls.crt`);
    writeFileSync(join(T, 'log'), '');
    return T;
  }
  const an = tlsPruefungSchaltenSkript({ an: true, cn: FQDN });
  const aus = tlsPruefungSchaltenSkript({ an: false });
  const schalter = (T: string) => (existsSync(join(T, 'etc', 'sqllnx-tls-pruefen')) ? readFileSync(join(T, 'etc', 'sqllnx-tls-pruefen'), 'utf8') : undefined);

  it('Validator, Register, Zeitlimit', () => {
    expect(linuxBausteinBekannt(LINUX_SQL_BAUSTEINE.tlsPruefungSchalten)).toBe(true);
    expect(pruefeTlsPruefung({ an: true, cn: FQDN })).toBeUndefined();
    expect(pruefeTlsPruefung({ an: false })).toBeUndefined();
    expect(pruefeTlsPruefung({ an: 'ja' })).toContain('an:');
    expect(pruefeTlsPruefung({ an: true, cn: 'sql01.ad.3033.at' })).toContain('cn:');
    expect(pruefeTlsPruefung({ an: true, cn: "sqllnx01.ad.3033.at'; id" })).toContain('cn:');
    expect(pruefeTlsPruefung({ an: false, cn: FQDN })).toContain('nur mit an=true');
    expect(LINUX_SQL_MIN_ZEITLIMIT_S.tls_pruefung_schalten).toBe(180);
    expect(an).not.toContain('Sa-Geheim');
  });

  it('an: Zertifikat fehlt / nicht Alfreds / nicht genutzt / abgelaufen / Kette kaputt → Abbruch, kein Schalter, keine Verbindung', () => {
    const faelle: Array<[string, (T: string) => void, string]> = [
      ['fehlt', T => rmSync(join(T, 'tls.crt')), 'fehlt — zuerst tls_einspielen'],
      ['manifest', T => rmSync(join(T, 'alfreds')), 'nicht mit diesem Inhalt in Alfreds Manifest'],
      ['mssql.conf', T => writeFileSync(join(T, 'conf_tlscert'), '/anders.crt'), 'network.tlscert ist nicht'],
      ['abgelaufen', T => writeFileSync(join(T, 'abgelaufen'), ''), 'abgelaufen oder nicht lesbar'],
      ['kette', T => writeFileSync(join(T, 'kette_kaputt'), ''), 'Kette gegen den Vertrauensspeicher'],
    ];
    for (const [name, vor, meldung] of faelle) {
      const T = welt(); vor(T);
      const r = lauf(T, an, SCHALT_STUBS);
      expect(r.rc, name).toBe(1);
      expect(String(r.e?.fehler), name).toContain(meldung);
      expect(String(r.e?.fehler), name).toMatch(/Schalter nicht gesetzt/);
      expect(schalter(T), name).toBeUndefined();
      expect(r.argv, name).toEqual([]);
    }
  });

  it('an: Probe scheitert (Zertifikat) oder unverschlüsselt → Abbruch, kein Schalter; Probe mit -N -S <fqdn>, nie -C', () => {
    const T = welt();
    writeFileSync(join(T, 'fehler'), `${SSL_FEHLER}\n`);
    const r = lauf(T, an, SCHALT_STUBS);
    expect(r.rc).toBe(1);
    expect(String(r.e?.fehler)).toBe(`${TLS_PRUEF_FEHLER} — Probe -N -S ${FQDN} als sa: ${SSL_FEHLER}; Schalter nicht gesetzt`);
    expect(r.argv).toHaveLength(1);
    expect(r.argv[0]!.split('|').slice(0, 3)).toEqual(['-N', '-S', FQDN]);
    expect(schalter(T)).toBeUndefined();
    rmSync(join(T, 'fehler')); writeFileSync(join(T, 'unverschluesselt'), '');
    const u = lauf(T, an, SCHALT_STUBS);
    expect(String(u.e?.fehler)).toContain('nicht verschlüsselt');
    expect(schalter(T)).toBeUndefined();
  });

  it('an: alles gut → Schalter (FQDN, 0644 root, atomar), Selbstprüfung über sql_ziel; wiederholbar; aus = Rückweg', () => {
    const T = welt();
    const r = lauf(T, an, SCHALT_STUBS);
    expect(r.rc, r.aus).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'geaendert', schalter: 'an', fqdn: FQDN, verschluesselt: true, aenderungen: ['schalter'] });
    expect(schalter(T)).toBe(`${FQDN}\n`);
    // Probe und Selbstprüfung: beide -N -S <fqdn>
    expect(r.argv).toHaveLength(2);
    for (const a of r.argv) expect(a.split('|').slice(0, 3)).toEqual(['-N', '-S', FQDN]);
    const log = ohneCr(readFileSync(join(T, 'log'), 'utf8'));
    expect(log).toMatch(/chown root:root .*\/etc\/\.alfred-tls-/);
    expect(log).toMatch(/chmod 0644 .*\/etc\/\.alfred-tls-/);
    expect(log).toContain(`openssl verify -purpose sslserver -verify_hostname ${FQDN}`);
    // wiederholt: nichts zu tun
    const w = lauf(T, an, SCHALT_STUBS);
    expect(w.e).toMatchObject({ zustand: 'schon', schalter: 'an', aenderungen: [] });
    // Rückweg (ohne sa)
    const a = lauf(T, aus, SCHALT_STUBS, '');
    expect(a.rc, a.aus).toBe(0);
    expect(a.e).toMatchObject({ zustand: 'geaendert', schalter: 'aus', aenderungen: ['schalter-entfernt'] });
    expect(schalter(T)).toBeUndefined();
    expect(a.argv).toEqual([]);
    expect(lauf(T, aus, SCHALT_STUBS, '').e).toMatchObject({ zustand: 'schon', schalter: 'aus' });
  });

  it('an: ein anderer Inhalt im Schalter wird ersetzt; Selbstprüfung scheitert → voriger Zustand zurück', () => {
    const T = welt();
    writeFileSync(join(T, 'etc', 'sqllnx-tls-pruefen'), 'sqllnx02.ad.3033.at\n');
    const r = lauf(T, an, SCHALT_STUBS);
    expect(r.e).toMatchObject({ zustand: 'geaendert', schalter: 'an' });
    expect(schalter(T)).toBe(`${FQDN}\n`);
    // Selbstprüfung scheitert (zweiter sqlcmd-Aufruf): voriger Inhalt zurück
    writeFileSync(join(T, 'etc', 'sqllnx-tls-pruefen'), 'sqllnx02.ad.3033.at\n');
    const stub2 = `${SCHALT_STUBS}\nsqlcmd_sa() { if [ "\${SQL_ZIEL[2]}" = ${FQDN} ] && [ -n "\${SQL_TLS:-}" ]; then "$SQLCMD" "\${SQL_ZIEL[@]}" <<<"$1" >/dev/null; echo "${SSL_FEHLER}"; return 1; fi; "$SQLCMD" "\${SQL_ZIEL[@]}" <<<"$1"; }`;
    const z = lauf(T, an, stub2);
    expect(z.rc).toBe(1);
    expect(String(z.e?.fehler)).toContain('Selbstprüfung');
    expect(String(z.e?.fehler)).toContain('Schalter zurückgenommen (voriger Zustand)');
    expect(schalter(T)).toBe('sqllnx02.ad.3033.at\n');
    // ohne vorigen Schalter: danach keiner
    rmSync(join(T, 'etc', 'sqllnx-tls-pruefen'));
    lauf(T, an, stub2);
    expect(schalter(T)).toBeUndefined();
  });

  it('tls_entfernen bricht ab, solange die Zertifikatsprüfung an ist', () => {
    const T = welt();
    writeFileSync(join(T, 'etc', 'sqllnx-tls-pruefen'), `${FQDN}\n`);
    const r = lauf(T, tlsEntfernenSkript(), `${PY_STUB}\nTLS_SCHALTER="$T/etc/sqllnx-tls-pruefen"; MSSQLCONF="$T/kein-mssql-conf"`, '');
    expect(r.rc).toBe(1);
    expect(String(r.e?.fehler)).toContain('Zertifikatsprüfung ist an');
    expect(String(r.e?.fehler)).toContain('tls_pruefung_schalten an=false');
  });
});

// ── Skill und Change-Regeln ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Task 7 — Skill linux_sql tls_pruefung_schalten, Rückweg im Change', () => {
  function skill(antwort: Record<string, unknown>) {
    const aufrufe: Array<{ baustein: string; parameter: unknown; eingabe?: string }> = [];
    const tresor = { namen: async () => new Set(['sqllnx-sqllnx01-sa']), lies: async () => 'Sa-Geheim-1', setze: async () => undefined };
    const s = new LinuxSqlSkill({
      skript: async (_z, baustein, parameter, eingabe) => {
        aufrufe.push({ baustein, parameter, ...(eingabe ? { eingabe } : {}) });
        return { code: antwort.zustand === 'fehler' ? 1 : 0, stdout: `ALFRED-SQL ${JSON.stringify(antwort)}\n`, stderr: '' };
      },
      tresor,
    });
    return { s, aufrufe };
  }
  const imChange = { ausChange: true } as never;

  it('nur im Change; Planprüfung: an Wahrheitswert, nur TLS-Hosts', async () => {
    const { s } = skill({});
    expect((await s.execute({ action: 'tls_pruefung_schalten', zugang: 'sqllnx01', an: true })).error).toContain('nur als Schritt eines freigegebenen Changes');
    expect(s.pruefeEingabe({ action: 'tls_pruefung_schalten', zugang: 'sqllnx01', an: true })).toBeUndefined();
    expect(s.pruefeEingabe({ action: 'tls_pruefung_schalten', zugang: 'sqllnxcfg', an: false })).toBeUndefined();
    expect(s.pruefeEingabe({ action: 'tls_pruefung_schalten', zugang: 'sqllnx01', an: 'true' })).toContain('an: true oder false');
    expect(s.pruefeEingabe({ action: 'tls_pruefung_schalten', zugang: 'sqllnx01' })).toContain('an: true oder false');
    expect(s.pruefeEingabe({ action: 'tls_pruefung_schalten', zugang: 'sql01', an: true })).toContain('nur auf sqllnx01, sqllnx02, sqllnxcfg');
  });

  it('an=true: sa nur über stdin, cn aus dem Zugang, Nachprüfung, TLS_PRUEFUNG_AN; an=false: ohne Tresor, TLS_PRUEFUNG_AUS', async () => {
    const w = skill({ zustand: 'geaendert', schalter: 'an', fqdn: FQDN, verschluesselt: true, datei: TLS_PRUEF_SCHALTER, aenderungen: ['schalter'] });
    const r = await w.s.execute({ action: 'tls_pruefung_schalten', zugang: 'sqllnx01', an: true }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toMatch(/^✅ TLS_PRUEFUNG_AN sqllnx01: /);
    expect(w.aufrufe[0]).toMatchObject({ baustein: LINUX_SQL_BAUSTEINE.tlsPruefungSchalten, parameter: { an: true, cn: FQDN }, eingabe: '{"sa":"Sa-Geheim-1"}' });
    // falsches Ergebnis (FQDN anders) → Fehler
    const f = skill({ zustand: 'geaendert', schalter: 'an', fqdn: 'sqllnx02.ad.3033.at', verschluesselt: true, datei: TLS_PRUEF_SCHALTER });
    expect((await f.s.execute({ action: 'tls_pruefung_schalten', zugang: 'sqllnx01', an: true }, imChange)).error).toContain('Nachprüfung fehlgeschlagen');
    const a = skill({ zustand: 'geaendert', schalter: 'aus', datei: TLS_PRUEF_SCHALTER, aenderungen: ['schalter-entfernt'] });
    const ra = await a.s.execute({ action: 'tls_pruefung_schalten', zugang: 'sqllnx01', an: false }, imChange);
    expect(ra.display).toMatch(/^✅ TLS_PRUEFUNG_AUS sqllnx01: /);
    expect(a.aufrufe[0]).toEqual({ baustein: LINUX_SQL_BAUSTEINE.tlsPruefungSchalten, parameter: { an: false } });
    // Fehler des Bausteins kommt mit der festen Meldung durch
    const e = skill({ zustand: 'fehler', fehler: `${TLS_PRUEF_FEHLER} — Probe -N -S ${FQDN} als sa: x; Schalter nicht gesetzt` });
    expect((await e.s.execute({ action: 'tls_pruefung_schalten', zugang: 'sqllnx01', an: true }, imChange)).error).toContain(TLS_PRUEF_FEHLER);
  });

  it('Change: Rückweg Pflicht, genau tls_pruefung_schalten mit umgekehrtem an auf demselben Zugang; selbstgeprüft', () => {
    const { s: sk } = skill({});
    const ctx = { skill: (n: string) => (n === 'linux_sql' ? sk : undefined) as never, asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
    const plan = (schritte: unknown[]) => ({ titel: 'Zertifikatsprüfung sqllnx01', begruendung: 'I8e Etappe 3 Task 7', typ: 'normal', risiko: 'medium', ausfallMinuten: 0, betroffen: ['sqllnx01'], ohneSicherungGrund: 'eigener Rückweg (an=false)', schritte });
    const f = (x: unknown[]) => pruefeChangePlan(plan(x) as never, ctx as never).fehler;
    const schritt = (an: boolean, rueckweg?: unknown) => ({ titel: 'Schalten', art: 'aktion', skill: 'linux_sql', aktion: 'tls_pruefung_schalten', parameter: { zugang: 'sqllnx01', an }, zeitlimitS: 240, ...(rueckweg ? { rueckweg } : {}) });
    expect(f([schritt(true, { skill: 'linux_sql', aktion: 'tls_pruefung_schalten', parameter: { zugang: 'sqllnx01', an: false } })])).toEqual([]);
    expect(f([schritt(false, { skill: 'linux_sql', aktion: 'tls_pruefung_schalten', parameter: { zugang: 'sqllnx01', an: true } })])).toEqual([]);
    expect(f([schritt(true, { keiner: 'x' })]).some(x => x.includes('rueckweg linux_sql.tls_pruefung_schalten (zugang, an umgekehrt)'))).toBe(true);
    expect(f([schritt(true, { skill: 'linux_sql', aktion: 'tls_pruefung_schalten', parameter: { zugang: 'sqllnx01', an: true } })]).some(x => x.includes('rueckweg an = false'))).toBe(true);
    expect(f([schritt(true, { skill: 'linux_sql', aktion: 'tls_pruefung_schalten', parameter: { zugang: 'sqllnx02', an: false } })]).some(x => x.includes('muss auf demselben Zugang laufen'))).toBe(true);
    expect(f([schritt(true, { skill: 'linux_sql', aktion: 'tls_entfernen', parameter: { zugang: 'sqllnx01' } })]).some(x => x.includes('braucht als Rückweg genau'))).toBe(true);
  });
});
