/**
 * Realfall 17.11. (Change 6279a86a, Schritt 5): Die Installation hält die SQL-Pakete (apt-mark hold) → dpkg meldet „hold ok installed“.
 * Status, Installation und Sicherung erkannten nur „install ok installed“ und hielten SQL Server für nicht installiert.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { installSkript, PY_STATUS } from './linux-sql.js';
import { sicherungEinrichtenSkript } from './linux-sql-sicherung.js';

// Prozess-Tests: Ereignisschleife zwischen Tests freigeben (sonst „Timeout calling onTaskUpdate“ unter Last)
afterEach(() => new Promise<void>(r => setImmediate(r)));

const BASH = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }).status === 0;
const PYTHON = ['python3', 'python'].find(p => spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3');

const zeile = (skript: string) => {
  const z = skript.split('\n').find(l => l.startsWith('paket_version()'));
  expect(z, 'paket_version im Skript').toBeDefined();
  return z!;
};

function bashVersion(funktion: string, status: string): string {
  const stub = `dpkg-query() { printf '%s' ${JSON.stringify(`${status}|17.0.4006.2-1`)}; }`;
  return spawnSync('bash', [], { input: `${stub}\n${funktion}\npaket_version mssql-server`, encoding: 'utf8' }).stdout.trim(); // wie $(…) in bash
}

describe('Paketerkennung: gehaltene Pakete gelten als installiert', { timeout: 120_000 }, () => {
  const skripte: Array<[string, string]> = [
    ['installieren', installSkript({ version: '17.0.4006.2-1', edition: 'EnterpriseDeveloper' })],
    ['sicherung_einrichten', sicherungEinrichtenSkript({ server: 'fs01.ad.3033.at', freigabe: 'SQLLinuxBackup$', konto: 'svc-sqllnx-backup', domaene: 'AD3033', budgetGiB: 64 })],
  ];

  it.skipIf(!BASH).each(skripte)('%s: hold/install ok installed → Version, sonst leer', (_n, skript) => {
    const f = zeile(skript);
    expect(bashVersion(f, 'hold ok installed')).toBe('17.0.4006.2-1');
    expect(bashVersion(f, 'install ok installed')).toBe('17.0.4006.2-1');
    expect(bashVersion(f, 'deinstall ok config-files')).toBe('');
    expect(bashVersion(f, 'install ok half-installed')).toBe('');
  });

  it.skipIf(!PYTHON)('status: hold ok installed → installiert mit Version', () => {
    const zeilen = PY_STATUS.split('\n');
    const von = zeilen.indexOf('pakete = {}'), bis = zeilen.findIndex(l => l.startsWith('r["installiert"]'));
    expect(von).toBeGreaterThan(-1); expect(bis).toBeGreaterThan(von);
    const prog = (st: string) => [
      'import json, sys',
      `def lauf(*a): return 0, ${JSON.stringify(`${st}|17.0.4006.2-1`)}`,
      'r = {}',
      ...zeilen.slice(von, bis + 1),
      'print(json.dumps(r))',
    ].join('\n');
    const lauf = (st: string) => JSON.parse(spawnSync(PYTHON!, ['-c', prog(st)], { encoding: 'utf8' }).stdout) as { installiert: boolean; pakete: Record<string, string | null> };
    expect(lauf('hold ok installed')).toMatchObject({ installiert: true, pakete: { 'mssql-server': '17.0.4006.2-1' } });
    expect(lauf('install ok installed').installiert).toBe(true);
    expect(lauf('deinstall ok config-files')).toMatchObject({ installiert: false, pakete: { 'mssql-server': null } });
  });
});


describe('Status: SQL-Sicht mit sqlcmd -y 0 (ohne -h -1)', { timeout: 120_000 }, () => {
  it('kein -h -1 neben -y 0 (sqlcmd: „mutually exclusive“, Realfall 17.11.)', () => {
    const aufruf = PY_STATUS.split('\n').find(l => l.includes('subprocess.run([SQLCMD'));
    expect(aufruf).toContain('"-y", "0"');
    expect(aufruf).not.toContain('"-h"');
  });

  it.skipIf(!PYTHON)('sql_json schneidet Spaltenkopf und Trennlinie ab, lehnt Unvollständiges ab', () => {
    const zeilen = PY_STATUS.split('\n');
    const von = zeilen.indexOf('def sql_json(text):'), bis = zeilen.indexOf('if login_fehler:');
    expect(von).toBeGreaterThan(-1); expect(bis).toBeGreaterThan(von);
    const prog = ['import json, sys', ...zeilen.slice(von, bis), 'print(json.dumps(sql_json(sys.stdin.read())))'].join('\n');
    const lauf = (t: string) => JSON.parse(spawnSync(PYTHON!, ['-c', prog], { input: t, encoding: 'utf8' }).stdout);
    expect(lauf('j\n-\n{"version":"17.0.4006.2","kerne":4,"datenbanken":[{"name":"pruefdb01"}]}\n')).toEqual({ version: '17.0.4006.2', kerne: 4, datenbanken: [{ name: 'pruefdb01' }] });
    expect(lauf('j\n----\n{"a":[1,\n2]}\n')).toEqual({ a: [1, 2] });
    expect(lauf('Msg 18456, Login failed')).toBeNull();
    expect(lauf('j\n-\n{"a":')).toBeNull();
  });
});

describe('Sicherung einrichten: Prozedurtext aus msdb (nicht aus der aktuellen Datenbank)', { timeout: 120_000 }, () => {
  it('kein OBJECT_DEFINITION, Fassungsvergleich und Ergebnis über msdb.sys.sql_modules (Realfall 17.11., „Prozedur 0“)', async () => {
    const { sicherungJobsTsql, PROZEDUR_DEFINITION } = await import('./linux-sql-sicherung.js');
    const t = sicherungJobsTsql();
    expect(t).not.toContain('OBJECT_DEFINITION');
    expect(PROZEDUR_DEFINITION).toContain('msdb.sys.sql_modules');
    expect(t.split(PROZEDUR_DEFINITION).length - 1).toBe(2);
  });
});
