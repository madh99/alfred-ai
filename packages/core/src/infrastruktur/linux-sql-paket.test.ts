/**
 * Realfall 17.11. (Change 6279a86a, Schritt 5): Die Installation hält die SQL-Pakete (apt-mark hold) → dpkg meldet „hold ok installed“.
 * Status, Installation und Sicherung erkannten nur „install ok installed“ und hielten SQL Server für nicht installiert.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { installSkript, PY_STATUS } from './linux-sql.js';
import { sicherungEinrichtenSkript } from './linux-sql-sicherung.js';

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

describe('Paketerkennung: gehaltene Pakete gelten als installiert', () => {
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
