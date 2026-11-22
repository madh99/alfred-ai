import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqlErgebnis, LINUX_SQL_BAUSTEINE } from './linux-sql.js';
import {
  adLoginSkript, adLoginEntfernenSkript, pruefeAdLogin, adLoginName, AD_LOGINS_DATEI, AD_LOGINS_KOPF, AD_SSSD_KOPF, type AdLoginParameter,
} from './linux-sql-ad.js';
import { linuxBausteinBekannt } from '../fernzugriff/linux-bausteine.js';
import { LinuxSqlSkill, LINUX_SQL_MIN_ZEITLIMIT_S } from './linux-sql-skill.js';
import { pruefeChangePlan } from './change-schritte.js';

// Synchrone Bash-Läufe (spawnSync) blockieren den Worker; nach jedem Test die Ereignisschleife einmal freigeben
afterEach(() => new Promise<void>(r => setImmediate(r)));

// I8e Etappe 3 Task 8 — linux_sql ad_login / ad_login_entfernen (AD-Gruppen als Logins)

const BASH = (() => { const r = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }); return r.status === 0 && /^\d+\./.test(r.stdout.trim()); })();
const PYTHON = ['python3', 'python'].find(p => spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3');
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const ohneCr = (s: string) => s.replace(/\r/g, '');
const ADMINS: AdLoginParameter = { gruppe: 'SQL-Linux-Admins', serverrolle: 'sysadmin' };
const APP: AdLoginParameter = { gruppe: 'SQL-Linux-Kunden', datenbank: 'kunden', datenbankrolle: 'db_datareader' };
const LOGIN = 'AD3033\\SQL-Linux-Admins';

describe('Task 8 — ad_login Parameter und T-SQL', { timeout: 120_000 }, () => {
  it('Validator: Gruppe ohne ] \' \\ und ohne Einschleusung, feste Rollen, Datenbank nur mit Rolle, mindestens eine Rolle', () => {
    expect(pruefeAdLogin(ADMINS)).toBeUndefined();
    expect(pruefeAdLogin(APP)).toBeUndefined();
    expect(pruefeAdLogin({ gruppe: 'SQL Linux Leser.1', datenbank: 'kunden', datenbankrolle: 'db_owner', serverrolle: 'sysadmin' })).toBeUndefined();
    for (const g of ['SQL]Admins', "SQL'Admins", 'AD3033\\x', 'x]; DROP LOGIN sa; --', ' SQL', 'SQL ', 'S', 'a'.repeat(65), '', 'SQL\nAdmins', 'SQL;Admins', 'Grüppe']) {
      expect(pruefeAdLogin({ gruppe: g, serverrolle: 'sysadmin' }), JSON.stringify(g)).toContain('gruppe:');
    }
    expect(pruefeAdLogin({ gruppe: 'SQL-Linux-Admins', serverrolle: 'securityadmin' })).toContain('serverrolle: nur sysadmin');
    expect(pruefeAdLogin({ gruppe: 'SQL-Linux-Admins', datenbank: 'kunden' })).toContain('nur zusammen');
    expect(pruefeAdLogin({ gruppe: 'SQL-Linux-Admins', datenbank: 'master', datenbankrolle: 'db_owner' })).toContain('keine Systemdatenbank');
    expect(pruefeAdLogin({ gruppe: 'SQL-Linux-Admins', datenbank: 'kunden]', datenbankrolle: 'db_owner' })).toContain('datenbank:');
    expect(pruefeAdLogin({ gruppe: 'SQL-Linux-Admins', datenbank: 'kunden', datenbankrolle: 'db_securityadmin' })).toContain('datenbankrolle: nur');
    expect(pruefeAdLogin({ gruppe: 'SQL-Linux-Admins' })).toContain('serverrolle oder datenbank');
    expect(pruefeAdLogin({ gruppe: 'SQL-Linux-Admins', serverrolle: 'sysadmin', kennwort: 'x' })).toContain('unbekannte Felder');
    expect(() => adLoginSkript({ gruppe: 'x]', serverrolle: 'sysadmin' })).toThrow('gruppe:');
    expect(adLoginName('SQL-Linux-Admins')).toBe(LOGIN);
  });

  it('Skript: Login in Klammern, Gruppe nur geprüft im Text, COLLATE bei Katalog-Verkettung, Datenbankteil über QUOTENAME/Parameter', () => {
    // T-SQL steht in shQ ('…' mit ''' für ') — für die Inhaltsprüfung zurückgewandelt
    const roh = (t: string) => t.replaceAll(`'\\''`, `'`);
    const s = roh(adLoginSkript(ADMINS));
    expect(linuxBausteinBekannt(LINUX_SQL_BAUSTEINE.adLogin)).toBe(true);
    expect(linuxBausteinBekannt(LINUX_SQL_BAUSTEINE.adLoginEntfernen)).toBe(true);
    expect(s).toContain(`CREATE LOGIN [${LOGIN}] FROM WINDOWS WITH DEFAULT_DATABASE = [master];`);
    expect(s).toContain(`ALTER SERVER ROLE [sysadmin] ADD MEMBER [${LOGIN}];`);
    expect(s).toContain(`DECLARE @n sysname = N'${LOGIN}'`);
    expect(s).toContain("RTRIM(sp.type) COLLATE DATABASE_DEFAULT");
    expect(s).toContain("type <> 'G'");
    // jede Katalogspalte, die mit Text verkettet wird, trägt COLLATE (Typ des Logins/Benutzers)
    for (const z of s.split('\n').filter(x => /N'ALFRED\|/.test(x) && /\.type\b/.test(x))) expect(z).toContain('COLLATE DATABASE_DEFAULT');
    const d = roh(adLoginSkript(APP));
    expect(d).toContain("QUOTENAME(@db) + N'.sys.sp_executesql'");
    expect(d).toContain("RTRIM(d.type) COLLATE DATABASE_DEFAULT");
    expect(d).toContain("N''CREATE USER '' + QUOTENAME(@n) + N'' FOR LOGIN '' + QUOTENAME(@n)");
    expect(d).toContain("N''ALTER ROLE '' + QUOTENAME(@drolle) + N'' ADD MEMBER '' + QUOTENAME(@n)");
    expect(d).toContain('is_primary_replica = 0');
    expect(d).not.toContain('ALTER SERVER ROLE');
    const e = roh(adLoginEntfernenSkript(ADMINS));
    expect(e).toContain(`DROP LOGIN [${LOGIN}]`);
    expect(e).toContain("type = 'G'");
    expect(e).toContain(`ALTER SERVER ROLE [sysadmin] DROP MEMBER [${LOGIN}]`);
    for (const t of [adLoginSkript(ADMINS), adLoginSkript(APP), adLoginEntfernenSkript(APP)]) {
      expect(t).not.toContain('Sa-Geheim');
      if (BASH) expect(spawnSync('bash', ['-n'], { input: t, encoding: 'utf8' }).status).toBe(0);
    }
    expect(LINUX_SQL_MIN_ZEITLIMIT_S.ad_login).toBe(240);
    expect(LINUX_SQL_MIN_ZEITLIMIT_S.ad_login_entfernen).toBe(240);
  });
});

// ── Bausteine ausgeführt (sqlcmd-Stub mit Katalog-Zustand) ─────────────────────────────────────────────────────────────────────

const ORDNER: string[] = [];
afterAll(() => { for (const d of ORDNER) rmSync(d, { recursive: true, force: true }); });
const PYTHON_PFAD = BASH && PYTHON ? spawnSync('bash', ['-c', `command -v ${PYTHON}`], { encoding: 'utf8' }).stdout.trim() : 'python3';
const STUBS = `python3() { PYTHONIOENCODING=utf-8 ${q(PYTHON_PFAD)} "$@" | tr -d '\\r'; }
TLS_SCHALTER="$T/etc/sqllnx-tls-pruefen"; SQLCMD="$T/sqlcmd"; sleep() { :; }
MARKER="$T/etc/sqllnx-ad-logins"; SSSD_CONF="$T/sssd.conf"; SQL_KT="$T/mssql.keytab"
lies() { cat "$T/conf_$2" 2>/dev/null || true; }
hostname() { cat "$T/hostname"; }
getent() { [ ! -f "$T/getent_fehlt" ] && printf '%s:*:1234:\\n' "$2" >>"$T/getent"; }
systemctl() { case "$1" in is-active) [ ! -f "$T/sssd_aus" ] ;; *) : ;; esac; }
chown() { :; }
stat() { if [ "$1 $2" = "-c %a %U %G" ]; then [ -e "$3" ] || return 1; cat "$T/marker_rechte" 2>/dev/null || echo '600 root root'; return; fi; command stat "$@"; }`;
/** sqlcmd-Stub: Lage aus $T/l (typ|aus|rolle) und $T/d (z|typ|sid|rm); Anlegen/Entfernen ändern den Zustand wie SQL Server */
const SQLCMD = (T: string) => `#!/bin/bash
q=$(cat)
printf '%s\\n----\\n' "$q" >>"${T}/tsql"
if [ -f "${T}/fehler" ]; then cat "${T}/fehler"; exit 1; fi
case "$q" in
  *"ALFRED|A|ok"*)
    if [ -f "${T}/anlegen_fehler" ]; then cat "${T}/anlegen_fehler"; exit 1; fi
    r=0; d=0
    case "$q" in *"ALTER SERVER ROLE"*) r=1 ;; esac
    case "$q" in *"CREATE USER"*) d=1 ;; esac
    echo "G|0|$r" >"${T}/l"; [ "$d" = 0 ] || echo "ok|G|1|1" >"${T}/d"
    echo 'ALFRED|A|ok' ;;
  *"ALFRED|E|ok"*)
    IFS='|' read -r lt la lr <"${T}/l"; IFS='|' read -r dz dt ds dm <"${T}/d" 2>/dev/null || true
    case "$q" in *"@ds bit = 1"*) lr=0 ;; esac
    case "$q" in *"@dl bit = 1"*) lt=-; la=-; lr=0 ;; esac
    case "$q" in *"@dr bit = 1"*) dm=0 ;; esac
    case "$q" in *"@du bit = 1"*) dt=-; ds=0; dm=0 ;; esac
    echo "$lt|$la|$lr" >"${T}/l"; [ -z "\${dz:-}" ] || echo "$dz|$dt|$ds|$dm" >"${T}/d"
    echo 'ALFRED|E|ok' ;;
  *"ALFRED|L|"*)
    echo "ALFRED|L|$(cat "${T}/l")"
    case "$q" in *"@db sysname"*) echo "ALFRED|D|$(cat "${T}/d")" ;; esac ;;
  *) echo 1 ;;
esac
`;
function welt(): string {
  const T = mkdtempSync(join(tmpdir(), 'alfred-adl-')).replace(/\\/g, '/');
  ORDNER.push(T);
  mkdirSync(join(T, 'etc'), { recursive: true });
  writeFileSync(join(T, 'sqlcmd'), SQLCMD(T));
  writeFileSync(join(T, 'sssd.conf'), `${AD_SSSD_KOPF}\n[sssd]\n`);
  writeFileSync(join(T, 'mssql.keytab'), 'KT');
  writeFileSync(join(T, 'conf_kerberoskeytabfile'), `${T}/mssql.keytab`);
  writeFileSync(join(T, 'hostname'), 'sqllnx01\n');
  writeFileSync(join(T, 'l'), '-|-|0\n'); writeFileSync(join(T, 'd'), 'ok|-|0|0\n');
  return T;
}
interface Lauf { rc: number; e?: Record<string, unknown>; aus: string; tsql: string[] }
function lauf(T: string, skript: string): Lauf {
  writeFileSync(join(T, 'tsql'), '');
  writeFileSync(join(T, 'eingabe'), '{"sa":"Sa-Geheim-1"}');
  const text = skript.replace('# ALFRED-ABLAUF', `${STUBS}\n# ALFRED-ABLAUF`);
  const huelle = [`T=${q(T)}`, 'chmod +x "$T/sqlcmd"', 'ALFRED_EINGABE=$(cat "$T/eingabe")', `( ${text}\n) >"$T/aus" 2>&1; echo "RC=$?"`].join('\n');
  const o = spawnSync('bash', [], { input: huelle, encoding: 'utf8' });
  const aus = ohneCr(readFileSync(join(T, 'aus'), 'utf8'));
  return { rc: Number(/RC=(\d+)/.exec(o.stdout)?.[1] ?? -1), e: sqlErgebnis(aus), aus, tsql: ohneCr(readFileSync(join(T, 'tsql'), 'utf8')).split('\n----\n').filter(x => x.trim()) };
}
const marker = (T: string) => (existsSync(join(T, 'etc', 'sqllnx-ad-logins')) ? ohneCr(readFileSync(join(T, 'etc', 'sqllnx-ad-logins'), 'utf8')) : undefined);
const angelegt = (l: Lauf) => l.tsql.filter(x => x.includes('ALFRED|A|ok'));

describe.skipIf(!BASH || !PYTHON)('Task 8 — ad_login / ad_login_entfernen ausgeführt', { timeout: 120_000 }, () => {
  it('Vorbedingungen: jede fehlende → Abbruch, kein Anlegen, kein Vermerk', () => {
    const faelle: Array<[string, (T: string) => void, string, AdLoginParameter?]> = [
      ['sqllnxcfg', T => writeFileSync(join(T, 'hostname'), 'sqllnxcfg\n'), 'sqllnxcfg bekommt keine AD-Logins'],
      ['nicht beigetreten', T => writeFileSync(join(T, 'sssd.conf'), '[sssd]\n'), 'zuerst ad_beitreten'],
      ['sssd aus', T => writeFileSync(join(T, 'sssd_aus'), ''), 'sssd läuft nicht'],
      ['gruppe unbekannt', T => writeFileSync(join(T, 'getent_fehlt'), ''), 'sql-linux-admins@ad.3033.at im AD nicht auflösbar'],
      ['ohne keytab', T => rmSync(join(T, 'conf_kerberoskeytabfile')), 'zuerst kerberos_einrichten'],
      ['marker fremd', T => writeFileSync(join(T, 'etc', 'sqllnx-ad-logins'), 'irgendwas\n'), 'nicht von Alfred'],
      ['marker rechte', T => { writeFileSync(join(T, 'etc', 'sqllnx-ad-logins'), `${AD_LOGINS_KOPF}\n`); writeFileSync(join(T, 'marker_rechte'), '644 root root'); }, 'nicht von Alfred'],
      ['sql-login gleichen namens', T => writeFileSync(join(T, 'l'), 'S|0|0\n'), 'besteht als Typ S'],
      ['windows-benutzer gleichen namens', T => writeFileSync(join(T, 'l'), 'U|0|0\n'), 'besteht als Typ U'],
      ['deaktiviert', T => writeFileSync(join(T, 'l'), 'G|1|0\n'), 'deaktiviert'],
      ['db fehlt', T => writeFileSync(join(T, 'd'), 'fehlt\n'), 'Datenbank kunden fehlt', APP],
      ['db sekundär', T => writeFileSync(join(T, 'd'), 'sekundaer\n'), 'Sekundär-Replikat', APP],
      ['db-benutzer andere sid', T => writeFileSync(join(T, 'd'), 'ok|G|0|0\n'), 'passt nicht zum Login', APP],
      ['db-benutzer sql', T => writeFileSync(join(T, 'd'), 'ok|S|1|0\n'), 'passt nicht zum Login', APP],
    ];
    for (const [name, vor, meldung, p] of faelle) {
      const T = welt(); vor(T);
      const vorher = marker(T);
      const r = lauf(T, adLoginSkript(p ?? ADMINS));
      expect(r.rc, `${name}: ${r.aus}`).toBe(1);
      expect(String(r.e?.fehler), name).toContain(meldung);
      expect(angelegt(r), name).toEqual([]);
      expect(marker(T), name).toBe(vorher);
    }
  });

  it('Anlegen: Vermerk vor der Anlage, Selbstprüfung über die Lage, wiederholbar; Rückweg entfernt genau das Vermerkte', () => {
    const T = welt();
    const r = lauf(T, adLoginSkript(ADMINS));
    expect(r.rc, r.aus).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'geaendert', login: LOGIN, typ: 'G', serverrolle: 'sysadmin', datenbank: '', aenderungen: ['L', 'S'] });
    expect(marker(T)).toBe(`${AD_LOGINS_KOPF}\nL|${LOGIN}\nS|sysadmin|${LOGIN}\n`);
    expect(angelegt(r)).toHaveLength(1);
    expect(angelegt(r)[0]).toContain(`CREATE LOGIN [${LOGIN}] FROM WINDOWS`);
    // wiederholt: nichts zu tun, kein Anlegen
    const w = lauf(T, adLoginSkript(ADMINS));
    expect(w.e).toMatchObject({ zustand: 'schon', aenderungen: [] });
    expect(angelegt(w)).toEqual([]);
    // Rückweg
    const e = lauf(T, adLoginEntfernenSkript(ADMINS));
    expect(e.rc, e.aus).toBe(0);
    expect(e.e).toMatchObject({ zustand: 'geaendert', login: LOGIN, belassen: [], aenderungen: ['S', 'L'] });
    const drop = e.tsql.find(x => x.includes('ALFRED|E|ok'))!;
    expect(drop).toContain('@ds bit = 1, @dl bit = 1');
    expect(marker(T)).toBe(`${AD_LOGINS_KOPF}\n`);
    expect(readFileSync(join(T, 'l'), 'utf8').trim()).toBe('-|-|0');
    // wiederholt: nichts mehr da
    const e2 = lauf(T, adLoginEntfernenSkript(ADMINS));
    expect(e2.e).toMatchObject({ zustand: 'schon', belassen: [] });
    expect(e2.tsql.filter(x => x.includes('ALFRED|E|ok'))).toEqual([]);
  });

  it('vorhandener Gruppen-Login (vor Alfred): nur die fehlende Rolle wird vermerkt; der Rückweg nimmt nur die Rolle, der Login bleibt (belassen)', () => {
    const T = welt();
    writeFileSync(join(T, 'l'), 'G|0|0\n');
    const r = lauf(T, adLoginSkript(ADMINS));
    expect(r.rc, r.aus).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'geaendert', aenderungen: ['S'] });
    expect(marker(T)).toBe(`${AD_LOGINS_KOPF}\nS|sysadmin|${LOGIN}\n`);
    const e = lauf(T, adLoginEntfernenSkript(ADMINS));
    expect(e.rc, e.aus).toBe(0);
    expect(e.e).toMatchObject({ aenderungen: ['S'], belassen: [`Login ${LOGIN} (nicht von Alfred angelegt)`] });
    expect(e.tsql.find(x => x.includes('ALFRED|E|ok'))).toContain('@ds bit = 1, @dl bit = 0');
    expect(readFileSync(join(T, 'l'), 'utf8').trim()).toBe('G|0|0');
    // ganz ohne Vermerk: nichts wird entfernt
    writeFileSync(join(T, 'l'), 'G|0|1\n');
    const n = lauf(T, adLoginEntfernenSkript(ADMINS));
    expect(n.e).toMatchObject({ zustand: 'schon', aenderungen: [] });
    expect(n.tsql.filter(x => x.includes('ALFRED|E|ok'))).toEqual([]);
    expect((n.e?.belassen as string[]).join(';')).toContain('Mitgliedschaft sysadmin (nicht von Alfred)');
  });

  it('Datenbank: Benutzer + Rolle auf dem Primär, Vermerk U/R; Rückweg auf einem Sekundär → Abbruch ohne Änderung', () => {
    const T = welt();
    const r = lauf(T, adLoginSkript(APP));
    expect(r.rc, r.aus).toBe(0);
    expect(marker(T)).toBe(`${AD_LOGINS_KOPF}\nL|AD3033\\SQL-Linux-Kunden\nU|kunden|AD3033\\SQL-Linux-Kunden\nR|kunden|db_datareader|AD3033\\SQL-Linux-Kunden\n`);
    expect(angelegt(r)[0]).toContain("@drolle = N'db_datareader'");
    writeFileSync(join(T, 'd'), 'sekundaer\n');
    const s = lauf(T, adLoginEntfernenSkript(APP));
    expect(s.rc).toBe(1);
    expect(String(s.e?.fehler)).toContain('auf dem Primär entfernen');
    expect(s.tsql.filter(x => x.includes('ALFRED|E|ok'))).toEqual([]);
    writeFileSync(join(T, 'd'), 'ok|G|1|1\n');
    const e = lauf(T, adLoginEntfernenSkript(APP));
    expect(e.rc, e.aus).toBe(0);
    expect(e.e).toMatchObject({ aenderungen: ['R', 'U', 'L'] });
    expect(marker(T)).toBe(`${AD_LOGINS_KOPF}\n`);
  });

  it('SQL Server findet die Gruppe nicht (Msg 15401) → klare Meldung, Vermerk bleibt für den Rückweg', () => {
    const T = welt();
    // Fix-Runde 1: liegengebliebene Zwischendateien räumt der EXIT-Trap weg
    writeFileSync(join(T, 'etc', '.alfred-adl-rest1'), 'x'); writeFileSync(join(T, 'etc', '.alfred-adl-rest1.alt'), 'x');
    writeFileSync(join(T, 'anlegen_fehler'), "Msg 15401, Level 16, State 1, Server sqllnx01, Line 5\nWindows NT user or group 'AD3033\\SQL-Linux-Admins' not found. Check the name again.\n");
    const r = lauf(T, adLoginSkript(ADMINS));
    expect(r.rc).toBe(1);
    expect(String(r.e?.fehler)).toContain('Msg 15401');
    expect(String(r.e?.fehler)).toContain('kerberos_einrichten + Neustart');
    expect(marker(T)).toContain(`L|${LOGIN}`);
    expect(existsSync(join(T, 'etc', '.alfred-adl-rest1'))).toBe(false);
    expect(existsSync(join(T, 'etc', '.alfred-adl-rest1.alt'))).toBe(false);
    expect(adLoginSkript(ADMINS)).toContain('umask 077');
  });
});

// ── Skill und Change-Regeln ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Task 8 — Skill linux_sql ad_login, Rückweg im Change', { timeout: 120_000 }, () => {
  function skill(antwort: Record<string, unknown>) {
    const aufrufe: Array<{ baustein: string; parameter: unknown; eingabe?: string }> = [];
    const tresor = { namen: async () => new Set(['sqllnx-sqllnx01-sa', 'sqllnx-sqllnxcfg-sa']), lies: async () => 'Sa-Geheim-1', setze: async () => undefined };
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

  it('sqllnxcfg und Nicht-AD-Hosts abgewiesen (Planung und Ausführung), Injection abgewiesen, nur im Change', async () => {
    const { s, aufrufe } = skill({});
    expect(s.pruefeEingabe({ action: 'ad_login', zugang: 'sqllnx01', gruppe: 'SQL-Linux-Admins', serverrolle: 'sysadmin' })).toBeUndefined();
    expect(s.pruefeEingabe({ action: 'ad_login', zugang: 'sqllnxcfg', gruppe: 'SQL-Linux-Admins', serverrolle: 'sysadmin' })).toContain('sqllnxcfg bekommt keine AD-Logins');
    expect(s.pruefeEingabe({ action: 'ad_login_entfernen', zugang: 'sqllnxcfg', gruppe: 'SQL-Linux-Admins', serverrolle: 'sysadmin' })).toContain('sqllnxcfg');
    expect(s.pruefeEingabe({ action: 'ad_login', zugang: 'sqllnx09', gruppe: 'SQL-Linux-Admins', serverrolle: 'sysadmin' })).toContain('nur auf sqllnx01, sqllnx02');
    expect(s.pruefeEingabe({ action: 'ad_login', zugang: 'sqllnx01', gruppe: "x]; DROP LOGIN [sa]; --", serverrolle: 'sysadmin' })).toContain('gruppe:');
    expect((await s.execute({ action: 'ad_login', zugang: 'sqllnxcfg', gruppe: 'SQL-Linux-Admins', serverrolle: 'sysadmin' }, imChange)).error).toContain('sqllnxcfg bekommt keine AD-Logins');
    expect((await s.execute({ action: 'ad_login', zugang: 'sqllnx01', gruppe: 'SQL-Linux-Admins', serverrolle: 'sysadmin' })).error).toContain('nur als Schritt');
    expect(aufrufe).toEqual([]);
  });

  it('AD_LOGIN_OK mit Nachprüfung (Name, Typ, Rollen); sa nur über stdin; Rückweg AD_LOGIN_REMOVED mit belassen', async () => {
    const w = skill({ zustand: 'geaendert', login: LOGIN, typ: 'G', serverrolle: 'sysadmin', datenbank: '', datenbankrolle: '', aenderungen: ['L', 'S'] });
    const r = await w.s.execute({ action: 'ad_login', zugang: 'sqllnx01', gruppe: 'SQL-Linux-Admins', serverrolle: 'sysadmin' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toMatch(/^✅ AD_LOGIN_OK sqllnx01: AD3033\\SQL-Linux-Admins \(Windows-Gruppe, aktiv\) — Serverrolle sysadmin/);
    expect(r.display).toContain(AD_LOGINS_DATEI);
    expect(w.aufrufe[0]).toEqual({ baustein: LINUX_SQL_BAUSTEINE.adLogin, parameter: { gruppe: 'SQL-Linux-Admins', serverrolle: 'sysadmin' }, eingabe: '{"sa":"Sa-Geheim-1","login":"sa"}' });
    const f = skill({ zustand: 'geaendert', login: LOGIN, typ: 'S', serverrolle: 'sysadmin', datenbank: '', datenbankrolle: '' });
    expect((await f.s.execute({ action: 'ad_login', zugang: 'sqllnx01', gruppe: 'SQL-Linux-Admins', serverrolle: 'sysadmin' }, imChange)).error).toContain('Nachprüfung fehlgeschlagen');
    const e = skill({ zustand: 'geaendert', login: LOGIN, belassen: [`Login ${LOGIN} (nicht von Alfred angelegt)`], aenderungen: ['S'] });
    const re = await e.s.execute({ action: 'ad_login_entfernen', zugang: 'sqllnx01', gruppe: 'SQL-Linux-Admins', serverrolle: 'sysadmin' }, imChange);
    expect(re.display).toContain('AD_LOGIN_REMOVED sqllnx01: AD3033\\SQL-Linux-Admins — S; belassen (nicht von Alfred): Login');
  });

  it('Change: Rückweg Pflicht, genau ad_login_entfernen mit denselben Werten auf demselben Zugang; selbstgeprüft', () => {
    const { s: sk } = skill({});
    const ctx = { skill: (n: string) => (n === 'linux_sql' ? sk : undefined) as never, asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
    const plan = (schritte: unknown[]) => ({ titel: 'AD-Logins sqllnx01', begruendung: 'I8e Etappe 3 L3', typ: 'normal', risiko: 'medium', ausfallMinuten: 0, betroffen: ['sqllnx01'], ohneSicherungGrund: 'eigener Rückweg (ad_login_entfernen)', schritte });
    const f = (x: unknown[]) => pruefeChangePlan(plan(x) as never, ctx as never).fehler;
    const P = { zugang: 'sqllnx01', gruppe: 'SQL-Linux-Admins', serverrolle: 'sysadmin' };
    const schritt = (rueckweg?: unknown) => ({ titel: 'Login', art: 'aktion', skill: 'linux_sql', aktion: 'ad_login', parameter: P, zeitlimitS: 300, ...(rueckweg ? { rueckweg } : {}) });
    expect(f([schritt({ skill: 'linux_sql', aktion: 'ad_login_entfernen', parameter: { ...P } })])).toEqual([]);
    expect(f([schritt({ keiner: 'x' })]).some(x => x.includes('rueckweg linux_sql.ad_login_entfernen'))).toBe(true);
    expect(f([schritt({ skill: 'linux_sql', aktion: 'ad_login_entfernen', parameter: { ...P, gruppe: 'SQL-Linux-Leser' } })]).some(x => x.includes('rueckweg gruppe = SQL-Linux-Admins'))).toBe(true);
    expect(f([schritt({ skill: 'linux_sql', aktion: 'ad_login_entfernen', parameter: { zugang: 'sqllnx01', gruppe: 'SQL-Linux-Admins' } })]).some(x => x.includes('rueckweg serverrolle = sysadmin'))).toBe(true);
    expect(f([schritt({ skill: 'linux_sql', aktion: 'ad_login_entfernen', parameter: { ...P, zugang: 'sqllnx02' } })]).some(x => x.includes('muss auf demselben Zugang laufen'))).toBe(true);
  });
});
