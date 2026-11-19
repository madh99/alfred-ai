import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resteEntfernenSkript, sqlErgebnis, shQ, LINUX_SQL_BAUSTEINE } from './linux-sql.js';
import { LinuxSqlSkill, LINUX_SQL_MIN_ZEITLIMIT_S } from './linux-sql-skill.js';
import { linuxBausteinBekannt } from '../fernzugriff/linux-bausteine.js';

// Owner 19.11.2026 — alte tempdb-Dateien entfernen: fail-closed, jede Datei gemeldet, Dateien in Gebrauch bleiben

const BASH = (() => { const r = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }); return r.status === 0 && /^\d+\./.test(r.stdout.trim()); })();
const imChange = { ausChange: true } as never;

interface Lauf {
  /** Dateien im nachgebildeten Datenordner (Name → Bytes) */
  dateien: Record<string, number>;
  /** Pfade, die sys.master_files meldet ({D} = Datenordner) */
  belegt?: string[];
  /** von einem Prozess geöffnet ({D} = Datenordner) */
  offen?: string[];
  /** Zahl in der ALFRED|-Zeile (Standard: belegt.length) */
  anzahl?: number;
  sqlFehler?: boolean;
  laeuft?: boolean;
}

function lauf(l: Lauf) {
  const belegt = l.belegt ?? ['/var/opt/mssql/data/master.mdf'];
  const stubs = [
    'DATEN="$T/data"',
    `feld() { case "$1" in sa) printf '%s' 'Sa-Geheim-1234567890!' ;; esac; }`,
    'bereit() { :; }',
    `laeuft() { ${l.laeuft === false ? 'return 1' : 'return 0'}; }`,
    `offen() { local x; for x in ${(l.offen ?? []).map(o => `"${o.replace('{D}', '$DATEN')}"`).join(' ')}; do [ "$x" = "$1" ] && return 0; done; return 1; }`,
    `sql() { ${l.sqlFehler ? 'echo "Msg 18456 Login failed"; return 1' : `${belegt.map(b => `echo "ALFRED-DATEI|${b.replace('{D}', '$DATEN')}"`).join('; ')}; echo "ALFRED|${l.anzahl ?? belegt.length}"`}; }`,
    'json_text() { local x; x=$(cat); printf \'"%s"\' "${x//\\"/}"; }',
  ].join('\n');
  const text = resteEntfernenSkript().replace('# ALFRED-ABLAUF', `${stubs}\n# ALFRED-ABLAUF`);
  const anlegen = Object.entries(l.dateien).map(([n, b]) => `head -c ${b} /dev/zero >"$T/data/${n}"`).join('\n');
  const huelle = `T=$(mktemp -d)\nmkdir -p "$T/data/tempdb"\n${anlegen}\nALFRED_EINGABE=''\n( ${text}\n)\necho "RC=$?"\necho '---REST'; (cd "$T/data" && ls -1); rm -rf "$T"`;
  const r = spawnSync('bash', [], { input: huelle, encoding: 'utf8' });
  const [vorne, rest = ''] = r.stdout.split('---REST\n');
  return {
    rc: Number(/RC=(\d+)/.exec(vorne)?.[1] ?? -1),
    e: sqlErgebnis<Record<string, unknown>>(vorne),
    vorne: `${vorne}\n${r.stderr}`,
    rest: rest.split('\n').filter(Boolean).sort(),
  };
}

describe('linux_sql reste_entfernen — Skripttext', () => {
  it('registriert, feste Kandidaten nur direkt im Datenordner, sa nur aus der Eingabe, Kollation festgelegt', () => {
    const s = resteEntfernenSkript();
    expect(linuxBausteinBekannt(LINUX_SQL_BAUSTEINE.resteEntfernen)).toBe(true);
    expect(s).toContain("DATEN='/var/opt/mssql/data'");
    expect(s).toContain('-mindepth 1 -maxdepth 1 -type f');
    expect(s).toContain('physical_name COLLATE DATABASE_DEFAULT');
    expect(s).toContain('SA=$(feld sa)');
    // einziges Löschen im Ablauf: genau eine geprüfte Datei (rm -rf steht nur in der gemeinsamen Aufräum-Falle für ALFRED_TMP)
    expect(s.match(/\brm -[a-z]+ [^;|]*/g)).toEqual(['rm -rf -- "$ALFRED_TMP"', 'rm -f -- "$f" ']);
    expect(LINUX_SQL_MIN_ZEITLIMIT_S.reste_entfernen).toBe(240);
    expect(shQ("a'b")).toBe("'a'\\''b'");
  });
});

describe.skipIf(!BASH)('linux_sql reste_entfernen — ausgeführt', () => {
  it('löscht nur ungenutzte Reste, behält Dateien aus sys.master_files (auch in anderer Pfadform) und geöffnete, meldet jede Datei', () => {
    const r = lauf({
      dateien: { 'tempdb.mdf': 2048, 'templog.ldf': 1024, 'tempdb2.ndf': 512, 'tempdb3.ndf': 256, 'master.mdf': 64, 'temp-notiz.txt': 8 },
      belegt: ['{D}/master.mdf', '{D}//tempdb2.ndf'],
      offen: ['{D}/tempdb3.ndf'],
    });
    expect(r.rc, r.vorne).toBe(0);
    expect(r.e?.zustand).toBe('geaendert');
    expect(r.e?.masterFiles).toBe(2);
    expect((r.e?.entfernt as Array<{ datei: string; bytes: number }>).map(x => [x.datei.split('/').pop(), x.bytes])).toEqual([['tempdb.mdf', 2048], ['templog.ldf', 1024]]);
    expect((r.e?.inGebrauch as Array<{ datei: string; grund: string }>).map(x => [x.datei.split('/').pop(), x.grund])).toEqual([['tempdb2.ndf', 'master_files'], ['tempdb3.ndf', 'offen']]);
    expect(r.rest).toEqual(['master.mdf', 'temp-notiz.txt', 'tempdb', 'tempdb2.ndf', 'tempdb3.ndf']);
    expect(r.vorne).not.toContain('Sa-Geheim');
  });
  it('nichts da → zustand schon, nichts gelöscht; Unterordner (tempdb des Konfig-Knotens) bleibt unberührt', () => {
    const r = lauf({ dateien: { 'master.mdf': 64 } });
    expect(r.rc, r.vorne).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'schon', entfernt: [], inGebrauch: [] });
    expect(r.rest).toEqual(['master.mdf', 'tempdb']);
  });
  it('fail-closed: SQL nicht lesbar, Zählung abweichend, Dienst aus oder unerwartete Pfadform → Abbruch, nichts gelöscht', () => {
    const d = { 'tempdb.mdf': 16, 'templog.ldf': 16 };
    for (const [l, text] of [
      [{ dateien: d, sqlFehler: true }, 'sys.master_files nicht lesbar — nichts gelöscht'],
      [{ dateien: d, anzahl: 5 }, '5 Dateien gemeldet, 1 gelesen — nichts gelöscht'],
      [{ dateien: d, laeuft: false }, 'sqlservr läuft nicht'],
      [{ dateien: d, belegt: ['var/opt/mssql/data/master.mdf'] }, 'unerwartete Pfadform'],
    ] as Array<[Lauf, string]>) {
      const r = lauf(l);
      expect(r.rc, r.vorne).toBe(1);
      expect(String(r.e?.fehler)).toContain(text);
      expect(r.rest).toEqual(['tempdb', 'tempdb.mdf', 'templog.ldf']);
    }
  });
});

describe('linux_sql reste_entfernen — Skill', () => {
  function skill(antwort: Record<string, unknown>) {
    const aufrufe: Array<{ baustein: string; eingabe?: string }> = [];
    const s = new LinuxSqlSkill({
      skript: async (_z, baustein, _p, eingabe) => { aufrufe.push({ baustein, ...(eingabe ? { eingabe } : {}) }); return { code: antwort.zustand === 'fehler' ? 1 : 0, stdout: `ALFRED-SQL ${JSON.stringify(antwort)}\n`, stderr: '' }; },
      tresor: { namen: async () => new Set(['sqllnx-sqllnx02-sa']), lies: async () => 'Sa-1', setze: async () => undefined },
    });
    return { s, aufrufe };
  }
  it('nur im Change; nennt jede gelöschte Datei mit Größe und die Dateien in Gebrauch', async () => {
    const w = skill({ zustand: 'geaendert', ordner: '/var/opt/mssql/data', masterFiles: 12, entfernt: [{ datei: '/var/opt/mssql/data/tempdb.mdf', bytes: 1073741824 }, { datei: '/var/opt/mssql/data/templog.ldf', bytes: 2147483648 }], inGebrauch: [{ datei: '/var/opt/mssql/data/tempdb2.ndf', grund: 'offen' }] });
    expect((await w.s.execute({ action: 'reste_entfernen', zugang: 'sqllnx02' }, {} as never)).error).toContain('nur als Schritt');
    const r = await w.s.execute({ action: 'reste_entfernen', zugang: 'sqllnx02' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toBe('✅ Alte tempdb-Dateien auf sqllnx02 entfernt (2, gegen 12 Dateien in sys.master_files geprüft): /var/opt/mssql/data/tempdb.mdf (1024 MiB), /var/opt/mssql/data/templog.ldf (2048 MiB); in Gebrauch, nicht gelöscht: /var/opt/mssql/data/tempdb2.ndf (geöffnet)');
    expect(w.aufrufe[0]!.baustein).toBe(LINUX_SQL_BAUSTEINE.resteEntfernen);
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ sa: 'Sa-1' });
  });
  it('nichts da → „nichts zu tun“; Abbruch des Bausteins → Fehler mit Grund', async () => {
    expect((await skill({ zustand: 'schon', ordner: '/var/opt/mssql/data', masterFiles: 12, entfernt: [], inGebrauch: [] }).s.execute({ action: 'reste_entfernen', zugang: 'sqllnx02' }, imChange)).display)
      .toBe('Keine alten tempdb-Dateien auf sqllnx02 in /var/opt/mssql/data — nichts zu tun');
    const f = await skill({ zustand: 'fehler', fehler: 'sys.master_files nicht lesbar — nichts gelöscht' }).s.execute({ action: 'reste_entfernen', zugang: 'sqllnx02' }, imChange);
    expect(f.success).toBe(false);
    expect(f.error).toContain('nichts gelöscht');
  });
});
