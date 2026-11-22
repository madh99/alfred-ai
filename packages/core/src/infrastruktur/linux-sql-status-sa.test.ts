import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxSqlStatusText, type LinuxSqlStatus } from './linux-sql-skill.js';
import { linuxSqlBefunde } from './linux-sql-ueberwachung.js';
import { PY_STATUS, STATUS_TSQL } from './linux-sql.js';
import { FESTE_AUSGABEN } from './change-schritte.js';

// I8e Folge-Etappe (Spec 2026-11-22 §7.3, Plan Task 6): Status zeigt sa und Alfred-Logins; gescheiterte Status-Anmeldung → Befund hoch
afterEach(() => new Promise<void>(r => setImmediate(r)));
const PYTHON = ['python3', 'python'].find(p => spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3');
const ORDNER: string[] = [];
afterEach(() => { while (ORDNER.length) rmSync(ORDNER.pop()!, { recursive: true, force: true }); });

const BASIS: LinuxSqlStatus = {
  zustand: 'gelesen', installiert: true, dienst: 'active', aktiviert: 'enabled', konfig: { memorylimitmb: '12288' }, platz: [],
  sql: { version: '17.0.4006.2', cu: 'CU1', edition: 'Enterprise Developer Edition (64-bit)', maxSpeicherMb: 10240, tempdb: [], datenbanken: [] },
};

describe('Statustext: sa und Alfred-Logins', () => {
  it('sa abgeschaltet mit Host-Marke, Alfred-Logins genannt', () => {
    const t = linuxSqlStatusText('sqllnx01', { ...BASIS, saMarke: true, sql: { ...BASIS.sql!, saAbgeschaltet: 1, alfredLogins: [{ name: 'alfred_admin' }, { name: 'alfred_status' }] } });
    expect(t).toContain('; sa aus (gesperrt); Alfred-Logins alfred_admin, alfred_status');
  });
  it('sa aktiv ohne Alfred-Logins', () => {
    const t = linuxSqlStatusText('sqllnx01', { ...BASIS, saMarke: false, sql: { ...BASIS.sql!, saAbgeschaltet: 0, alfredLogins: null } });
    expect(t).toContain('; sa aktiv; Alfred-Logins keine');
  });
  it('sa abgeschaltet ohne Marke wird sichtbar', () => {
    const t = linuxSqlStatusText('sqllnx01', { ...BASIS, saMarke: false, sql: { ...BASIS.sql!, saAbgeschaltet: 1, alfredLogins: [] } });
    expect(t).toContain('; sa aus (ohne Host-Marke)');
  });
  it('ohne die neuen Felder (alter Status) bleibt der Text wie bisher', () => {
    expect(linuxSqlStatusText('sqllnx01', BASIS)).not.toMatch(/; sa |Alfred-Logins/);
  });
  it('feste Ausgaben: positive Stücke', () => {
    for (const s of ['sa aus (gesperrt)', 'Alfred-Logins alfred_admin, alfred_status']) expect(FESTE_AUSGABEN['linux_sql.status']).toContain(s);
  });
  it('Status-T-SQL liest sa und Alfred-Logins', () => {
    expect(STATUS_TSQL).toContain('AS saAbgeschaltet');
    expect(STATUS_TSQL).toContain('AS alfredLogins');
  });
});

describe('Überwachung: gescheiterte Status-Anmeldung', () => {
  it('alfred_status gescheitert → Befund hoch', () => {
    const b = linuxSqlBefunde('sqllnx01', { anmeldung: { login: 'alfred_status', ok: false } });
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ schwere: 'hoch', schluessel: 'ueberwachung:sqllnx01:anmeldung' });
    expect(b[0]!.text).toContain('SQL-Anmeldung als alfred_status gescheitert');
  });
  it('gelungen oder vor der Umstellung (sa) → kein Befund', () => {
    expect(linuxSqlBefunde('sqllnx01', { anmeldung: { login: 'alfred_status', ok: true } })).toEqual([]);
    expect(linuxSqlBefunde('sqllnx01', { anmeldung: { login: 'sa', ok: false } })).toEqual([]);
  });
});

describe.skipIf(!PYTHON)('Python-Status: Anmeldung und Host-Marke', { timeout: 60_000 }, () => {
  function status(eingabe: string, sqlOk: boolean, marke = false): Record<string, unknown> {
    const T = mkdtempSync(join(tmpdir(), 'alfred-pysa-')).replace(/\\/g, '/');
    ORDNER.push(T);
    const stub = join(T, 'sqlcmd.py');
    writeFileSync(stub, sqlOk ? `import sys\nsys.stdin.read()\nprint('{"saAbgeschaltet": 1}')\n` : `import sys\nsys.stdin.read()\nprint("Login failed for user 'alfred_status'")\nsys.exit(1)\n`);
    if (marke) writeFileSync(join(T, 'sa-aus'), 'x');
    const py = 'import os\nif not hasattr(os, "statvfs"):\n    os.statvfs = lambda p: type("S", (), {"f_bavail": 1, "f_frsize": 1, "f_blocks": 1, "f_bsize": 1, "f_bfree": 1})()\n' + PY_STATUS
      .replace(/^SQLCMD = .*$/m, `SQLCMD = ${JSON.stringify(PYTHON)}\nSQLCMD_STUB = ${JSON.stringify(stub)}`)
      .replace('[SQLCMD] + sql_ziel()', '[SQLCMD, SQLCMD_STUB] + sql_ziel()')
      .replace(/def lauf\(\*a\):/, 'def lauf(*a):\n    if a[:2] == ("systemctl", "is-active"):\n        return 0, "active"');
    const o = spawnSync(PYTHON!, ['-c', py, join(T, 'sa-aus')], { input: eingabe, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
    const z = o.stdout.split(/\r?\n/).find(l => l.startsWith('ALFRED-SQL ')) ?? 'ALFRED-SQL {}';
    return JSON.parse(z.slice(11));
  }
  it('alfred_status gescheitert → anmeldung.ok false, fester Fehlertext', () => {
    const r = status('{"sa":"Kw","login":"alfred_status"}', false);
    expect(r.anmeldung).toEqual({ login: 'alfred_status', ok: false });
    expect(String(r.sqlFehler)).toMatch(/^SQL-Anmeldung als alfred_status gescheitert/);
  });
  it('gelungen → anmeldung.ok true; Host-Marke gemeldet', () => {
    const r = status('{"sa":"Kw","login":"alfred_status"}', true, true);
    expect(r.anmeldung).toEqual({ login: 'alfred_status', ok: true });
    expect(r.saMarke).toBe(true);
  });
});
