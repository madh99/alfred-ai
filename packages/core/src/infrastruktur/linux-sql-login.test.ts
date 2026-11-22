import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqlKopf, SQL_HILFE, SA_LESEN, SA_SPERRE, PY_STATUS, statusSkript, shQ } from './linux-sql.js';

// I8e Folge-Etappe (Spec 2026-11-22 §7.2, Plan Task 2): Login-Feld und Host-Sperre für sa in den Fernskripten
afterEach(() => new Promise<void>(r => setImmediate(r)));

const BASH = (() => { const r = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }); return r.status === 0 && /^\d+\./.test(r.stdout.trim()); })();
const PYTHON = ['python3', 'python'].find(p => spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3');
const PYTHON_PFAD = BASH && PYTHON ? spawnSync('bash', ['-c', `command -v ${PYTHON}`], { encoding: 'utf8' }).stdout.trim() : 'python3';
const ohneCr = (s: string) => s.replace(/\r/g, '');
const ORDNER: string[] = [];
afterEach(() => { while (ORDNER.length) rmSync(ORDNER.pop()!, { recursive: true, force: true }); });

function lauf(eingabe: string, sperre: boolean): { rc: number; aus: string; argv: string } {
  const T = mkdtempSync(join(tmpdir(), 'alfred-login-')).replace(/\\/g, '/');
  ORDNER.push(T);
  writeFileSync(join(T, 'sqlcmd'), `#!/bin/bash\n(IFS='|'; printf '%s\\n' "$*") >>"${T}/argv"\ncat >/dev/null\necho 'ALFRED|1'\n`);
  writeFileSync(join(T, 'argv'), '');
  if (sperre) writeFileSync(join(T, 'sa-aus'), 'ALFRED-SA-AUS\n');
  writeFileSync(join(T, 'eingabe'), eingabe);
  const stubs = `python3() { PYTHONIOENCODING=utf-8 ${shQ(PYTHON_PFAD)} "$@" | tr -d '\\r'; }\nSQLCMD="$T/sqlcmd"; SA_SPERRE="$T/sa-aus"`;
  const skript = [...sqlKopf('linux_sql.status', {}), ...SQL_HILFE, ...SA_LESEN, 'sqlcmd_sa "SELECT 1" >/dev/null', 'echo "FERTIG als $SQL_LOGIN"', 'ALFRED_ZEILE=1']
    .join('\n').replace('# ALFRED-ABLAUF', `${stubs}\n# ALFRED-ABLAUF`);
  const huelle = [`T=${shQ(T)}`, 'chmod +x "$T/sqlcmd"', 'ALFRED_EINGABE=$(cat "$T/eingabe")', `( ${skript}\n) >"$T/aus" 2>&1; echo "RC=$?"`].join('\n');
  const o = spawnSync('bash', [], { input: huelle, encoding: 'utf8' });
  return { rc: Number(/RC=(\d+)/.exec(o.stdout)?.[1] ?? -1), aus: ohneCr(readFileSync(join(T, 'aus'), 'utf8')), argv: ohneCr(readFileSync(join(T, 'argv'), 'utf8')) };
}

describe('Host-Marke und Login-Feld — Konstanten', () => {
  it('Marke liegt unter /etc/alfred', () => expect(SA_SPERRE).toBe('/etc/alfred/sqllnx-sa-aus'));
  it('jedes HA-Skript, das das sa-Feld liest, liest in der nächsten Zeile das Login (login_lesen)', () => {
    const zeilen = ohneCr(readFileSync(join(__dirname, 'linux-ha.ts'), 'utf8')).split('\n');
    const stellen = zeilen.map((z, i) => (z.trim() === 'geheim_lesen sa SA "sa-Kennwort"' ? i : -1)).filter(i => i >= 0);
    expect(stellen.length).toBe(5);
    for (const i of stellen) expect(zeilen[i + 1]!.trim()).toBe('login_lesen');
  });
});

describe.skipIf(!BASH || !PYTHON)('sqlcmd_sa mit Login-Feld (ausgeführt)', { timeout: 60_000 }, () => {
  it('login=alfred_admin → sqlcmd mit -U alfred_admin', () => {
    const r = lauf('{"sa":"Kw-Geheim-123!","login":"alfred_admin"}', false);
    expect(r.rc).toBe(0);
    expect(r.aus).toContain('FERTIG als alfred_admin');
    expect(r.argv).toContain('|-U|alfred_admin|');
    expect(r.argv + r.aus).not.toContain('Kw-Geheim-123!');
  });

  it('ohne login-Feld (Altlauf) → sa', () => {
    const r = lauf('{"sa":"Kw-Geheim-123!"}', false);
    expect(r.rc).toBe(0);
    expect(r.argv).toContain('|-U|sa|');
  });

  it('Marke gesetzt + login=sa → Abbruch vor jedem sqlcmd', () => {
    const r = lauf('{"sa":"Kw-Geheim-123!","login":"sa"}', true);
    expect(r.rc).not.toBe(0);
    expect(r.aus).toContain('sa ist auf diesem Host abgeschaltet');
    expect(r.aus).toContain('Anmeldung als sa gesperrt');
    expect(r.argv).toBe('');
  });

  it('Marke gesetzt + ohne login-Feld → ebenfalls gesperrt', () => {
    const r = lauf('{"sa":"Kw-Geheim-123!"}', true);
    expect(r.rc).not.toBe(0);
    expect(r.argv).toBe('');
  });

  it('Marke gesetzt + alfred_admin → erlaubt', () => {
    const r = lauf('{"sa":"Kw-Geheim-123!","login":"alfred_admin"}', true);
    expect(r.rc).toBe(0);
    expect(r.argv).toContain('|-U|alfred_admin|');
  });

  it('fremdes Login → Abbruch', () => {
    const r = lauf('{"sa":"Kw-Geheim-123!","login":"root"}', false);
    expect(r.rc).not.toBe(0);
    expect(r.aus).toContain('login: nur sa, alfred_admin oder alfred_status');
    expect(r.argv).toBe('');
  });
});

describe.skipIf(!PYTHON)('Python-Status mit Login-Feld', { timeout: 60_000 }, () => {
  function status(eingabe: string, sperre: boolean): { r: Record<string, unknown>; argv: string } {
    const T = mkdtempSync(join(tmpdir(), 'alfred-pystat-')).replace(/\\/g, '/');
    ORDNER.push(T);
    const sqlcmd = join(T, 'sqlcmd.py');
    writeFileSync(sqlcmd, `import sys\nopen(${JSON.stringify(join(T, 'argv'))}, 'a').write('|'.join(sys.argv[1:]) + '\\n')\nsys.stdin.read()\nprint('{"tempdb": []}')\n`);
    writeFileSync(join(T, 'argv'), '');
    if (sperre) writeFileSync(join(T, 'sa-aus'), 'x');
    // SQLCMD → Python-Stub; Dienst „active“ erzwingen; os.statvfs fehlt unter Windows → nachgebildet
    const py = 'import os\nif not hasattr(os, "statvfs"):\n    os.statvfs = lambda p: type("S", (), {"f_bavail": 1, "f_frsize": 1, "f_blocks": 1, "f_bsize": 1, "f_bfree": 1})()\n' + PY_STATUS
      .replace(/^SQLCMD = .*$/m, `SQLCMD = ${JSON.stringify(PYTHON)}\nSQLCMD_STUB = ${JSON.stringify(sqlcmd)}`)
      .replace('[SQLCMD] + sql_ziel()', '[SQLCMD, SQLCMD_STUB] + sql_ziel()')
      .replace(/def lauf\(\*a\):/, 'def lauf(*a):\n    if a[:2] == ("systemctl", "is-active"):\n        return 0, "active"');
    const o = spawnSync(PYTHON!, ['-c', py, join(T, 'sa-aus')], { input: eingabe, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
    const zeile = o.stdout.split(/\r?\n/).find(z => z.startsWith('ALFRED-SQL ')) ?? 'ALFRED-SQL {}';
    return { r: JSON.parse(zeile.slice(11)), argv: ohneCr(readFileSync(join(T, 'argv'), 'utf8')) };
  }

  it('login=alfred_status → -U alfred_status', () => {
    const { argv } = status('{"sa":"Kw-1","login":"alfred_status"}', false);
    expect(argv).toContain('|-U|alfred_status|');
  });

  it('Marke + sa → kein sqlcmd, Sperrtext in sqlFehler', () => {
    const { r, argv } = status('{"sa":"Kw-1","login":"sa"}', true);
    expect(argv).toBe('');
    expect(String(r.sqlFehler)).toContain('Anmeldung als sa gesperrt');
  });

  it('fremdes Login → kein sqlcmd', () => {
    const { r, argv } = status('{"sa":"Kw-1","login":"root"}', false);
    expect(argv).toBe('');
    expect(String(r.sqlFehler)).toContain('login: nur sa, alfred_admin oder alfred_status');
  });

  it('statusSkript übergibt die Marke als Argument', () => {
    expect(statusSkript()).toContain(`SA_SPERRE=${shQ(SA_SPERRE)}`);
    expect(statusSkript()).toContain('python3 -c "$PY_STATUS" "$SA_SPERRE"');
  });
});
