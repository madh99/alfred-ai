import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { LINUX_SQL_BAUSTEINE, sqlErgebnis } from './linux-sql.js';
import { sqlUpdateSkript, pruefeSqlUpdate, SQL_UPDATE_OHNE_RUECKWEG, hadrFortsetzenSkript, HADR_FORTSETZEN_TSQL } from './linux-sql-update.js';
import { LinuxSqlSkill, LINUX_SQL_MIN_ZEITLIMIT_S } from './linux-sql-skill.js';
import { linuxBausteinBekannt } from '../fernzugriff/linux-bausteine.js';
import { aktionsArt, pruefeChangePlan, FESTE_AUSGABEN } from './change-schritte.js';

// Owner 23./24.11. — linux_sql aktualisieren (CU rollierend)
afterEach(() => new Promise<void>(r => setImmediate(r)));
const BASH = (() => { const r = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }); return r.status === 0 && /^\d+\./.test(r.stdout.trim()); })();
const PYTHON = ['python3', 'python'].find(p => spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3');
const PYTHON_PFAD = BASH && PYTHON ? spawnSync('bash', ['-c', `command -v ${PYTHON}`], { encoding: 'utf8' }).stdout.trim() : 'python3';
const ALT = '17.0.4006.2-1';
const NEU = '17.0.5065.9-3';

/**
 * Stubs: Paketstand in $T/pk_<paket> („<status>|<version>“), Paketquelle in $T/quelle, ProductVersion in $T/pv; apt-get install
 * schreibt die Zielversionen (Status „install ok installed“) und die ProductVersion, apt-mark hold setzt „hold ok installed“.
 * $T/conf_aendern lässt die Installation mssql.conf verändern. Alles Ausgeführte steht in $T/log.
 */
function lauf(eingabe: Record<string, unknown>, dateien: Record<string, string>, version = NEU) {
  const stubs = [
    `python3() { PYTHONIOENCODING=utf-8 '${PYTHON_PFAD}' "$@" | tr -d '\\r'; }`,
    'MSSQL_CONF="$T/mssql.conf"; sleep() { :; }',
    'log() { printf "%s\\n" "$*" >>"$T/log"; }',
    'bereit() { [ ! -f "$T/nicht_bereit" ]; }',
    'sql() { log "sql $SQL_LOGIN"; echo "ALFRED|$(cat "$T/pv")"; }',
    'dpkg-query() { local pk="${@: -1}"; [ -f "$T/pk_$pk" ] || return 1; cat "$T/pk_$pk"; }',
    'apt-cache() { cat "$T/quelle" 2>/dev/null | while read -r z; do echo " $2 | $z | https://packages.microsoft.com"; done; }',
    'apt-get() { log "apt-get $*"; case " $* " in *" install "*) for a in "$@"; do case "$a" in mssql-*=*) printf "install ok installed|%s" "${a#*=}" >"$T/pk_${a%%=*}" ;; esac; done; [ -f "$T/pv_fest" ] || printf "%s" "${V%-*}" >"$T/pv"; [ ! -f "$T/conf_aendern" ] || echo x >>"$T/mssql.conf"; [ ! -f "$T/install_scheitert" ] ;; esac; }',
    'apt-mark() { log "apt-mark $*"; for a in "$@"; do case "$a" in mssql-*) v=$(cut -d"|" -f2 "$T/pk_$a"); printf "hold ok installed|%s" "$v" >"$T/pk_$a" ;; esac; done; }',
    'systemctl() { log "systemctl $*"; case "$1" in is-active|is-enabled) return 0 ;; esac; }',
    'journalctl() { :; }',
    'hostname() { echo sqllnx01; }',
    'crm_mon() { log "crm_mon $*"; cat "$T/crm.xml"; }',
    'mktemp() { command mktemp -d; }',
  ].join('\n');
  const text = sqlUpdateSkript({ version }).replace('# ALFRED-ABLAUF', `${stubs}\n# ALFRED-ABLAUF`);
  const anlegen = Object.entries(dateien).map(([n, w]) => `printf '%b' ${JSON.stringify(w)} >"$T/${n}"`).join('\n');
  const huelle = [
    'T=$(mktemp -d)', 'printf "[network]\\ntlscert = /var/opt/mssql/tls/tls.crt\\n" >"$T/mssql.conf"', anlegen,
    `ALFRED_EINGABE=${JSON.stringify(JSON.stringify(eingabe))}`,
    `( ${text}\n) >"$T/aus" 2>&1; echo "RC=$?"`,
    'echo "---AUS"; cat "$T/aus"; echo "---LOG"; cat "$T/log" 2>/dev/null; echo "---PK"; cat "$T"/pk_mssql-server; echo; cat "$T"/pk_mssql-server-ha 2>/dev/null; rm -rf "$T"',
  ].join('\n');
  const o = spawnSync('bash', [], { input: huelle, encoding: 'utf8' }).stdout.replace(/\r/g, '');
  const teil = (a: string, b?: string) => o.split(`---${a}\n`)[1]?.split(b ? `---${b}\n` : '\u0000')[0] ?? '';
  return { rc: Number(/RC=(\d+)/.exec(o)?.[1] ?? -1), aus: teil('AUS', 'LOG'), e: sqlErgebnis<Record<string, unknown>>(teil('AUS', 'LOG')), log: teil('LOG', 'PK'), pk: teil('PK') };
}
const crm = (standby: boolean, aktiv = false) => `<crm_mon><summary><current_dc with_quorum="true"/></summary><nodes><node name="sqllnx01" id="1" online="true" standby="${standby}"/><node name="sqllnx02" id="2" online="true" standby="false"/></nodes><resources><clone id="ag_cluster-clone"><resource id="ag_cluster" role="Promoted" active="true"><node name="sqllnx02" id="2"/></resource>${aktiv ? '<resource id="ag_cluster" role="Unpromoted" active="true"><node name="sqllnx01" id="1"/></resource>' : '<resource id="ag_cluster" role="Stopped" active="false"/>'}</clone></resources></crm_mon>`;
const admin = { sa: 'Kennwort-1', login: 'alfred_admin' };
const basis = (x: Record<string, string> = {}) => ({ 'pk_mssql-server': `hold ok installed|${ALT}`, 'pk_mssql-server-ha': `hold ok installed|${ALT}`, quelle: `${NEU}\n${ALT}`, pv: '17.0.4006.2', 'crm.xml': crm(true), ...x });

describe('linux_sql aktualisieren — Parameter und Planung', () => {
  it('Version: apt-Version ab CU1', () => {
    expect(pruefeSqlUpdate({ version: NEU })).toBeUndefined();
    expect(pruefeSqlUpdate({ version: '17.0.5065.9' })).toContain('apt-Version mit Revision');
    expect(pruefeSqlUpdate({ version: '17.0.1000.7-1' })).toContain('erst ab CU1');
    expect(pruefeSqlUpdate({ version: '17.0.5065.9-3; rm -rf /' })).toContain('apt-Version');
  });

  it('registriert, ändernd, Zeitlimit; Plan nur mit festem Grund ohne Rückweg; fester Wortlaut', () => {
    expect(linuxBausteinBekannt(LINUX_SQL_BAUSTEINE.aktualisieren)).toBe(true);
    expect(aktionsArt('linux_sql', 'aktualisieren')).toBe('aendern');
    expect(LINUX_SQL_MIN_ZEITLIMIT_S.aktualisieren).toBe(1560);
    expect(FESTE_AUSGABEN['linux_sql.aktualisieren']).toContain('SQL_AKTUALISIERT {zugang}');
    const sk = new LinuxSqlSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
    const ctx = { skill: (n: string) => (n === 'linux_sql' ? sk : undefined) as never, asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
    const plan = (schritte: unknown[]) => ({ titel: 'SQL-Server CU11 rollierend', begruendung: 'SQL-Server-Update', typ: 'normal', risiko: 'medium', ausfallMinuten: 0, betroffen: ['sqllnx01'], ohneSicherungGrund: 'Sicherung der Datenbanken läuft per Agent', schritte });
    const f = (x: unknown[]) => pruefeChangePlan(plan(x) as never, ctx as never).fehler;
    const schritt = (parameter: Record<string, unknown>, rueckweg?: unknown) => ({ titel: 'CU', art: 'aktion', skill: 'linux_sql', aktion: 'aktualisieren', parameter: { zugang: 'sqllnx01', ...parameter }, zeitlimitS: 1600, ...(rueckweg ? { rueckweg } : {}) });
    expect(f([schritt({ version: NEU }, { keiner: SQL_UPDATE_OHNE_RUECKWEG })])).toEqual([]);
    expect(f([schritt({ version: NEU })]).some(x => x.includes(SQL_UPDATE_OHNE_RUECKWEG))).toBe(true);
    expect(f([schritt({ version: NEU }, { keiner: 'egal' })]).some(x => x.includes('hat keinen Rückweg'))).toBe(true);
    expect(f([schritt({ version: '17.0.5065.9' }, { keiner: SQL_UPDATE_OHNE_RUECKWEG })]).some(x => x.includes('apt-Version mit Revision'))).toBe(true);
  });
});

describe.skipIf(!BASH || !PYTHON)('linux_sql aktualisieren — Baustein', { timeout: 60_000 }, () => {
  it('Standby → mssql-server und mssql-server-ha auf Ziel, danach gehalten, Selbstprüfung', () => {
    const r = lauf(admin, basis());
    expect(r.rc, r.aus).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'geaendert', knoten: 'sqllnx01', von: ALT, version: '17.0.5065.9', paket: NEU, ha: NEU });
    expect(r.log).toMatch(/apt-get .*install .*--allow-change-held-packages .*mssql-server=17\.0\.5065\.9-3 mssql-server-ha=17\.0\.5065\.9-3/);
    expect(r.log).toContain('apt-mark -o DPkg::Lock::Timeout=300 hold mssql-server mssql-server-ha');
    expect(r.pk).toBe(`hold ok installed|${NEU}\nhold ok installed|${NEU}`);
  });

  it('ohne mssql-server-ha nur mssql-server; schon auf Ziel → nichts zu tun', () => {
    const ohneHa = lauf(admin, { ...basis(), 'pk_mssql-server-ha': '' });
    expect(ohneHa.rc, ohneHa.aus).toBe(0);
    expect(ohneHa.e).toMatchObject({ zustand: 'geaendert', ha: null });
    expect(ohneHa.log).not.toContain('mssql-server-ha=');
    const schon = lauf(admin, basis({ 'pk_mssql-server': `hold ok installed|${NEU}`, 'pk_mssql-server-ha': `hold ok installed|${NEU}`, pv: '17.0.5065.9', 'crm.xml': crm(false, true) }));
    expect(schon.rc, schon.aus).toBe(0);
    expect(schon.e).toMatchObject({ zustand: 'schon', von: NEU });
    expect(schon.log).not.toContain('apt-get');
  });

  it('fail-closed vor jeder Änderung: kein Standby, noch aktiv, Downgrade, nicht in der Quelle, falsches Login, HA abweichend', () => {
    const faelle: Array<[Record<string, unknown>, Record<string, string>, string, string?]> = [
      [admin, basis({ 'crm.xml': crm(false) }), 'nicht im Standby'],
      [admin, basis({ 'crm.xml': crm(true, true) }), 'noch aktiv'],
      [admin, basis({ 'crm.xml': 'kaputt' }), 'nicht im Standby (unlesbar)'],
      [admin, basis({ 'pk_mssql-server': `hold ok installed|${NEU}`, 'pk_mssql-server-ha': `hold ok installed|${NEU}` }), 'kein Downgrade', ALT],
      [admin, basis({ quelle: ALT }), 'in der Paketquelle nicht verfügbar'],
      [admin, basis({ 'pk_mssql-server-ha': 'hold ok installed|17.0.3000.1-1' }), 'weicht von mssql-server'],
      [admin, basis({ 'pk_mssql-server': '' }), 'nicht installiert'],
      [{ sa: 'x', login: 'alfred_status' }, basis(), 'nur als alfred_admin'],
    ];
    for (const [ein, d, text, v] of faelle) {
      const r = lauf(ein, d, v);
      expect(r.rc, text).toBe(1);
      expect(String(r.e?.fehler), text).toContain(text);
      expect(r.log, text).not.toMatch(/apt-get .*install|apt-mark/);
    }
  });

  it('mssql.conf beim Update verändert → Abbruch, Pakete trotzdem wieder gehalten; Installationsfehler → hold zurück', () => {
    const conf = lauf(admin, basis({ conf_aendern: '1' }));
    expect(conf.rc).toBe(1);
    expect(String(conf.e?.fehler)).toContain('mssql.conf wurde beim Update verändert');
    expect(conf.pk).toBe(`hold ok installed|${NEU}\nhold ok installed|${NEU}`);
    const fehl = lauf(admin, basis({ install_scheitert: '1' }));
    expect(fehl.rc).toBe(1);
    expect(String(fehl.e?.fehler)).toContain('apt-get install fehlgeschlagen');
    expect(fehl.log).toMatch(/apt-mark hold mssql-server mssql-server-ha/);
  });

  it('Version nach dem Update falsch → Abbruch', () => {
    const r = lauf(admin, basis({ pv_fest: '1' }));
    expect(r.rc).toBe(1);
    expect(String(r.e?.fehler)).toContain("meldet Version '17.0.4006.2', erwartet 17.0.5065.9");
  });
});

describe('Skill linux_sql aktualisieren', () => {
  it('außerhalb eines Changes abgewiesen; Nachprüfung und Wortlaut', async () => {
    const aufrufe: string[] = [];
    const sk = new LinuxSqlSkill({ skript: async (_z, b) => { aufrufe.push(b); return { code: 0, stdout: '', stderr: '' }; } });
    const r0 = await sk.execute({ action: 'aktualisieren', zugang: 'sqllnx01', version: NEU }, {} as never);
    expect(r0.error).toContain('nur als Schritt eines freigegebenen Changes');
    expect(aufrufe).toEqual([]);
  });
});

describe.skipIf(!BASH || !PYTHON)('linux_sql hadr_fortsetzen', { timeout: 60_000 }, () => {
  const lauf2 = (eingabe: Record<string, unknown>, antwort: string) => {
    const stubs = [
      `python3() { PYTHONIOENCODING=utf-8 '${PYTHON_PFAD}' "$@" | tr -d '\r'; }`,
      'bereit() { :; }',
      `sql() { printf "%s|%s\n" "$SQL_LOGIN" "$(printf "%s" "$1" | head -c 60)" >>"$T/log"; ${antwort} }`,
    ].join('\n');
    const text = hadrFortsetzenSkript().replace('# ALFRED-ABLAUF', `${stubs}\n# ALFRED-ABLAUF`);
    const huelle = ['T=$(mktemp -d)', `ALFRED_EINGABE=${JSON.stringify(JSON.stringify(eingabe))}`, `( ${text}\n) >"$T/aus" 2>&1; echo "RC=$?"`, 'echo "---AUS"; cat "$T/aus"; echo "---LOG"; cat "$T/log" 2>/dev/null; rm -rf "$T"'].join('\n');
    const o = spawnSync('bash', [], { input: huelle, encoding: 'utf8' }).stdout.replace(/\r/g, '');
    const aus = o.split('---AUS\n')[1]?.split('---LOG\n')[0] ?? '';
    return { rc: Number(/RC=(\d+)/.exec(o)?.[1] ?? -1), e: sqlErgebnis<Record<string, unknown>>(aus), log: o.split('---LOG\n')[1] ?? '' };
  };
  it('setzt angehaltene fort, Nachweis 0 angehalten; nichts angehalten → schon', () => {
    const r = lauf2(admin, 'echo "ALFRED|1|0|1";');
    expect(r.rc).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'geaendert', fortgesetzt: 1, angehalten: 0, datenbanken: 1 });
    expect(r.log).toContain('alfred_admin|SET NOCOUNT ON; -- ALFRED-HADR-FORTSETZEN');
    expect(lauf2(admin, 'echo "ALFRED|0|0|1";').e).toMatchObject({ zustand: 'schon', fortgesetzt: 0 });
  });
  it('fail-closed: noch angehalten, nicht SECONDARY (THROW), unlesbar, falsches Login', () => {
    expect(String(lauf2(admin, 'echo "ALFRED|1|1|1";').e?.fehler)).toContain('noch 1 AG-Datenbanken angehalten');
    expect(String(lauf2(admin, 'echo "Msg 50040 Replikat ist nicht SECONDARY"; return 1;').e?.fehler)).toContain('nicht SECONDARY');
    expect(String(lauf2(admin, 'echo "ALFRED|x";').e?.fehler)).toContain('unlesbar');
    const s = lauf2({ sa: 'x', login: 'alfred_status' }, 'echo "ALFRED|0|0|1";');
    expect(String(s.e?.fehler)).toContain('nur als alfred_admin');
    expect(s.log).toBe('');
  });
  it('T-SQL: nur lokale, angehaltene Datenbanken; nur auf SECONDARY', () => {
    expect(HADR_FORTSETZEN_TSQL).toContain("is_local = 1 AND role_desc = N'SECONDARY'");
    expect(HADR_FORTSETZEN_TSQL).toContain('WHERE is_local = 1 AND is_suspended = 1');
    expect(HADR_FORTSETZEN_TSQL).toContain("SET HADR RESUME");
    expect(aktionsArt('linux_sql', 'hadr_fortsetzen')).toBe('aendern');
    expect(linuxBausteinBekannt(LINUX_SQL_BAUSTEINE.hadrFortsetzen)).toBe(true);
  });
});
