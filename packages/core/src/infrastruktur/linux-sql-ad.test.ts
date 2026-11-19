import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  adBeitretenSkript, adVerlassenSkript, pruefeAdBeitreten, pruefeAdVerlassen, LINUX_AD, LINUX_AD_PAKETE, AD_SSSD_KOPF, AD_KRB5_KOPF,
  zeitquelleEinrichtenSkript, zeitquelleEntfernenSkript, zeitquelleDropin,
  type AdBeitretenParameter,
} from './linux-sql-ad.js';
import { sqlErgebnis, LINUX_SQL_BAUSTEINE, ZEITQUELLE_DCS, ZEITQUELLE_DROPIN, ZEITQUELLE_KOPF } from './linux-sql.js';
import { LinuxSqlSkill, LINUX_SQL_MIN_ZEITLIMIT_S } from './linux-sql-skill.js';
import { linuxBausteinBekannt } from '../fernzugriff/linux-bausteine.js';
import { pruefeChangePlan } from './change-schritte.js';

// Prozess-Tests: Ereignisschleife zwischen Tests freigeben (sonst „Timeout calling onTaskUpdate“ unter Last)
afterEach(() => new Promise<void>(r => setImmediate(r)));

// I8e Etappe 3 Task 4 — Domänenbeitritt mit Einmal-Kennwort ohne Admin-Konto, lokaler Rückweg

const BASH = (() => { const r = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }); return r.status === 0 && /^\d+\./.test(r.stdout.trim()); })();
const PYTHON = ['python3', 'python'].find(p => spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3');
const imChange = { ausChange: true } as never;
const EINMAL = 'Einmal-Geheim_7Kq2Zx9Wv4Ty';
/** Shell-Literal in einfachen Anführungszeichen (echte Zeilenumbrüche, kein $-Ersetzen) */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const P: AdBeitretenParameter = { domaene: 'ad.3033.at', realm: 'AD.3033.AT', ou: 'Server', computername: 'sqllnx01', dcs: ['10.203.29.2', '10.203.29.3'], pakete: { ...LINUX_AD_PAKETE } };
const V = { computername: 'sqllnx01' };
// wie linux-ha.test.ts: die Bash-Läufe blockieren den Worker synchron (spawnSync); vor jedem Test an die Ereignisschleife abgeben,
// sonst läuft vitest-RPC (onTaskUpdate) in die Zeitgrenze
beforeEach(async () => { await new Promise(r => setTimeout(r, 0)); });

interface Lauf {
  hostnameF?: string;
  ptr?: string;
  /** Offset-Text in timedatectl timesync-status (Standard „+1.4ms“; leer = keine Messung) */
  uhr?: string;
  /** Ruling R11: Zeitquelle eingerichtet (Alfreds Drop-in, Standard ja) und NTPSynchronized (Standard yes) */
  zeitquelle?: boolean;
  sync?: string;
  /** Einmal-Kennwort in der Eingabe (Standard EINMAL) */
  einmal?: string;
  /** schon beigetreten: Keytab, Alfreds sssd.conf und krb5.conf, Pakete gehalten, sssd aktiv, PAM ohne sss */
  beigetreten?: boolean;
  /** adcli join scheitert und gibt das Kennwort aus */
  adcliFehler?: boolean;
  /** Version in der Paketquelle (Standard: die feste) */
  verfuegbar?: Record<string, string>;
  /** vorhandene sssd.conf (fremd) */
  fremdeSssd?: boolean;
  /** vorhandene krb5.conf: fremd (eigener Inhalt) oder Paketvorgabe von krb5-config (Vorlage, default_realm geändert) */
  krb5?: 'fremd' | 'vorgabe';
  /** Keytab mit einem zusätzlichen fremden Principal */
  fremderKeytab?: boolean;
  /** pam_sss steht schon in common-auth/common-account (wie nach der Installation von libpam-sss) */
  pamSss?: boolean;
  /** gesicherte Paketvorgabe der krb5.conf liegt vor */
  krb5Alt?: boolean;
}

const KEYTAB_INHALT = 'Keytab name: FILE:/etc/krb5.keytab\nKVNO Principal\n---- ----------\n   2 SQLLNX01$@AD.3033.AT\n   2 host/sqllnx01.ad.3033.at@AD.3033.AT\n   2 host/SQLLNX01@AD.3033.AT\n   2 RestrictedKrbHost/SQLLNX01@AD.3033.AT';
const KEYTAB_FREMD = `${KEYTAB_INHALT}\n   3 HTTP/web01.ad.3033.at@AD.3033.AT`;
/** gekürzte krb5-config-Vorlage (Aufbau wie /usr/share/kerberos-configs/krb5.conf.template) */
const VORLAGE = '[libdefaults]\n\tdefault_realm = ATHENA.MIT.EDU\n\tforwardable = true\n        rdns = false\n\n[realms]\n\tATHENA.MIT.EDU = {\n\t\tkdc = kerberos.mit.edu\n\t}';
const VORGABE = VORLAGE.replace('ATHENA.MIT.EDU\n\tforwardable', 'AD.3033.AT\n\tforwardable');
const FREMD_KRB5 = '[libdefaults]\n\tdefault_realm = ANDERS.LOKAL\n[realms]\n\tANDERS.LOKAL = {\n\t\tkdc = kdc.anders.lokal\n\t}';
const PAM_SSS = 'account\t[default=bad success=ok user_unknown=ignore]\tpam_sss.so';

/** Stubs (nach den Hilfsfunktionen, vor dem Ablauf): Systemprogramme als Shell-Funktionen, Zustand in Dateien unter $T */
function stubs(l: Lauf): string {
  return [
    'TMP_BASIS="$T"; SSSD_CONF="$T/etc/sssd/sssd.conf"; KRB5_CONF="$T/etc/krb5.conf"; KEYTAB="$T/etc/krb5.keytab"; NSS="$T/etc/nsswitch.conf"; SSS_DB="$T/sss/db"; SSS_MC="$T/sss/mc"',
    'KRB5_VORLAGE="$T/vorlage/krb5.conf.template"; KRB5_ALT="$T/etc/krb5.conf.alfred-vorher"; PAM_D="$T/pam.d"',
    `feld() { case "$1" in einmal) printf '%s' ${q(l.einmal ?? EINMAL)} ;; esac; }`,
    'json_text() { local x; x=$(cat); printf \'"%s"\' "${x//\\"/}"; }',
    'log() { printf \'%s\\n\' "$*" >>"$T/log"; }',
    `hostname() { log "hostname $*"; [ "$1" = -f ] && echo ${q(l.hostnameF ?? 'sqllnx01.ad.3033.at')}; }`,
    'host() { log "host $*"; case "$*" in *SRV*) echo "_ldap._tcp.ad.3033.at has SRV record 0 100 389 dc01.ad.3033.at." ;; 10.203.30.10) echo ' + `"10.30.203.10.in-addr.arpa domain name pointer ${l.ptr ?? 'sqllnx01.ad.3033.at'}."` + ' ;; *) return 1 ;; esac; }',
    'ip() { echo "10.203.29.2 via 10.203.30.1 dev eth0 src 10.203.30.10 uid 0"; }',
    // Ruling R11: Zeitquelle — Drop-in außerhalb von etc/ (Dateiliste der Tests), timedatectl liest Dateien unter $T/zeit
    'ZQ_DROPIN="$T/zq/alfred-ad.conf"',
    'timedatectl() { case "$1 ${2:-}" in "show -p") case "$3" in NTPSynchronized) cat "$T/zeit/sync" ;; NTP) echo yes ;; esac ;; "show-timesync -p") cat "$T/zeit/server" 2>/dev/null || true ;; "timesync-status ") cat "$T/zeit/status" 2>/dev/null || true ;; esac; }',
    'dpkg-query() { local p="${@: -1}" st="install ok installed"; [ -f "$T/inst/$p" ] || return 1; [ ! -f "$T/held/$p" ] || st="hold ok installed"; if [[ "$*" == *Version* ]]; then printf \'%s|%s\' "$st" "$(cat "$T/inst/$p")"; else printf \'%s\' "$st"; fi; }',
    // install: libpam-sss schaltet pam_sss ein (pam-auth-update --package), krb5-config legt Vorlage und krb5.conf an
    `apt-get() { log "apt-get $*"; local a; for a in "$@"; do case "$a" in *=*[0-9]*) [[ "$a" == DPkg* || "$a" == Dpkg* ]] && continue; echo "\${a#*=}" >"$T/inst/\${a%%=*}"
      case "\${a%%=*}" in libpam-sss) printf '%s\\n' ${q(PAM_SSS)} >>"$T/pam.d/common-account"; printf 'auth\\t[success=end default=ignore]\\tpam_sss.so use_first_pass\\n' >>"$T/pam.d/common-auth" ;;
        krb5-user) mkdir -p "$T/vorlage"; [ -f "$KRB5_VORLAGE" ] || printf '%s\\n' ${q(VORLAGE)} >"$KRB5_VORLAGE"; [ -f "$KRB5_CONF" ] || sed 's/ATHENA.MIT.EDU$/AD.3033.AT/' "$KRB5_VORLAGE" >"$KRB5_CONF" ;; esac ;; esac; done; }`,
    'apt-cache() { log "apt-cache $*"; local p="${@: -1}"; [ ! -f "$T/verf/$p" ] || echo " $p | $(cat "$T/verf/$p") | http://archive.ubuntu.com/ubuntu noble/main amd64 Packages"; }',
    'apt-mark() { log "apt-mark $*"; local a; for a in "$@"; do case "$a" in -o|DPkg*|hold) ;; *) touch "$T/held/$a" ;; esac; done; }',
    'pam-auth-update() { log "pam-auth-update $*"; [ "$1 $2" = "--disable sss" ] && sed -i "/pam_sss/d" "$PAM_D"/common-*; }',
    'chown() { :; }',
    'rechte_ok() { [ -f "$1" ]; }',
    'sleep() { :; }',
    'command() { if [ "$1" = -v ]; then case "$2" in adcli|realm|klist|sssd|host|pam-auth-update) return 0 ;; esac; fi; builtin command "$@"; }',
    'systemctl() { log "systemctl $*"; case "$1" in is-active) [ -f "$T/aktiv" ] ;; is-enabled) [ -f "$T/an" ] ;; enable) touch "$T/an"; [ "$2" != --now ] || touch "$T/aktiv" ;; restart) touch "$T/aktiv" ;; disable) rm -f "$T/an"; [ "$2" != --now ] || rm -f "$T/aktiv" ;; esac; }',
    `adcli() { log "adcli $*"; case "$1" in testjoin) [ -f "$KEYTAB" ] ;; join) local s; s=$(cat); [ "$s" = ${q(l.einmal ?? EINMAL)} ] && log "adcli-stdin-ok"; ${l.adcliFehler ? `echo "Couldn't authenticate as SQLLNX01$ with password $s"; return 5` : `printf '%s\\n' ${q(KEYTAB_INHALT)} >"$KEYTAB"`} ;; esac; }`,
    'klist() { [ -f "$KEYTAB" ] && cat "$KEYTAB"; }',
    'realm() { [ -f "$SSSD_CONF" ] && grep -q "^\\[domain/ad.3033.at\\]" "$SSSD_CONF" && echo ad.3033.at; }',
    'id() { [ -f "$T/aktiv" ] && grep -q sss "$NSS" && echo "uid=1(svc-sqllnx@ad.3033.at)"; }',
    'getent() { [ -f "$T/aktiv" ] && echo "sql-linux-admins@ad.3033.at:*:2:"; }',
  ].join('\n');
}

function vorbereiten(l: Lauf): string {
  const verf = { ...LINUX_AD_PAKETE, ...(l.verfuegbar ?? {}) };
  const z = [
    'T=$(mktemp -d)', 'mkdir -p "$T/etc/sssd" "$T/inst" "$T/held" "$T/verf" "$T/sss/db" "$T/sss/mc" "$T/pam.d" "$T/vorlage" "$T/zq" "$T/zeit"', ': >"$T/log"',
    `echo ${q(l.sync ?? 'yes')} >"$T/zeit/sync"; echo 10.203.29.2 >"$T/zeit/server"`,
    `printf '       Server: 10.203.29.2 (10.203.29.2)\n%s\n' ${q(l.uhr === '' ? 'Packet count: 0' : `       Offset: ${l.uhr ?? '+1.4ms'}`)} >"$T/zeit/status"`,
    ...(l.zeitquelle === false ? [] : [`printf '%s\n' ${q(zeitquelleDropin())} >"$T/zq/alfred-ad.conf"`]),
    `printf 'passwd:         files systemd\\ngroup:          files systemd\\nshadow:         files\\nhosts:          files dns\\n' >"$T/etc/nsswitch.conf"`,
    `printf 'auth\\t[success=1 default=ignore]\\tpam_unix.so nullok\\n' >"$T/pam.d/common-auth"`,
    `printf 'account\\t[success=1 new_authtok_reqd=done default=ignore]\\tpam_unix.so\\n' >"$T/pam.d/common-account"`,
    ...Object.entries(verf).map(([n, v]) => `echo ${q(v)} >"$T/verf/${n}"`),
  ];
  if (l.beigetreten) {
    z.push(...Object.entries(LINUX_AD_PAKETE).map(([n, v]) => `echo ${q(v)} >"$T/inst/${n}"; touch "$T/held/${n}"`));
    z.push(`printf '%s\\n' ${q(VORLAGE)} >"$T/vorlage/krb5.conf.template"`);
    z.push(`printf '%s\\n' ${q(sssdAusLauf())} >"$T/etc/sssd/sssd.conf"`, `printf '%s\\n' ${q(krb5AusLauf())} >"$T/etc/krb5.conf"`);
    z.push('touch "$T/aktiv" "$T/an" "$T/sss/db/cache_ad.3033.at.ldb"');
    z.push(`sed -E -i '/^(passwd|group):/ s/$/ sss/' "$T/etc/nsswitch.conf"`);
  }
  if (l.beigetreten || l.fremderKeytab) z.push(`printf '%s\\n' ${q(l.fremderKeytab ? KEYTAB_FREMD : KEYTAB_INHALT)} >"$T/etc/krb5.keytab"`);
  if (l.fremdeSssd) z.push(`printf '[sssd]\\ndomains = andere.domaene\\n' >"$T/etc/sssd/sssd.conf"`);
  if (l.krb5 === 'fremd') z.push(`printf '%s\\n' ${q(FREMD_KRB5)} >"$T/etc/krb5.conf"`);
  if (l.krb5 === 'vorgabe') z.push(`printf '%s\\n' ${q(VORLAGE)} >"$T/vorlage/krb5.conf.template"`, `printf '%s  \\n' ${q(VORGABE)} >"$T/etc/krb5.conf"`);
  if (l.krb5Alt) z.push(`printf '%s\\n' ${q(VORGABE)} >"$T/etc/krb5.conf.alfred-vorher"`);
  if (l.pamSss) z.push(`printf '%s\\n' ${q(PAM_SSS)} >>"$T/pam.d/common-account"`);
  return z.join('\n');
}

const TEILE = ['LOG', 'DATEIEN', 'SSSD', 'NSS', 'PAM', 'KRB5', 'KRB5ALT'] as const;
function ausfuehren(skript: string, l: Lauf, vorlauf = '') {
  const text = skript.replace('# ALFRED-ABLAUF', `${stubs(l)}\n# ALFRED-ABLAUF`);
  const huelle = [
    vorbereiten(l), vorlauf, "ALFRED_EINGABE=''", `( ${text}\n)`, 'echo "RC=$?"',
    'echo "---LOG"; cat "$T/log"',
    'echo "---DATEIEN"; (cd "$T" && find etc inst held sss aktiv an -type f 2>/dev/null | sort)',
    'echo "---SSSD"; cat "$T/etc/sssd/sssd.conf" 2>/dev/null',
    'echo "---NSS"; cat "$T/etc/nsswitch.conf"',
    'echo "---PAM"; cat "$T"/pam.d/common-*',
    'echo "---KRB5"; cat "$T/etc/krb5.conf" 2>/dev/null',
    'echo "---KRB5ALT"; cat "$T/etc/krb5.conf.alfred-vorher" 2>/dev/null',
    'rm -rf "$T"',
  ].join('\n');
  const r = spawnSync('bash', [], { input: huelle, encoding: 'utf8' });
  const teile = r.stdout.split(/^---(LOG|DATEIEN|SSSD|NSS|PAM|KRB5|KRB5ALT)\n/m);
  const vorne = teile[0]!;
  const t: Record<string, string> = {};
  for (let i = 1; i < teile.length; i += 2) t[teile[i]!] = teile[i + 1] ?? '';
  for (const k of TEILE) t[k] ??= '';
  return {
    rc: Number(/RC=(\d+)/.exec(vorne)?.[1] ?? -1), e: sqlErgebnis<Record<string, unknown>>(vorne), aus: `${vorne}\n${r.stderr}`,
    log: t.LOG!, dateien: t.DATEIEN!.split('\n').filter(Boolean), sssd: t.SSSD!, nss: t.NSS!, pam: t.PAM!, krb5: t.KRB5!, krb5Alt: t.KRB5ALT!,
  };
}
const beitreten = (l: Lauf = {}) => ausfuehren(adBeitretenSkript(P), l);
const ohneNss = (d: string[]) => d.filter(x => x !== 'etc/nsswitch.conf');

/** sssd.conf/krb5.conf, wie ein erster Lauf sie schreibt (aus dem Skripttext gelesen) */
function ausSkript(variable: string): string {
  const z = adBeitretenSkript(P).split('\n');
  const i = z.findIndex(x => x.startsWith(`${variable}='`));
  const zeilen: string[] = [z[i]!.slice(variable.length + 2)];
  for (let k = i + 1; !zeilen[zeilen.length - 1]!.endsWith("'"); k++) zeilen.push(z[k]!);
  return zeilen.join('\n').slice(0, -1);
}
function sssdAusLauf() { return ausSkript('SSSD_SOLL'); }
function krb5AusLauf() { return ausSkript('KRB5_SOLL'); }

describe('linux_sql ad_beitreten — Skripttext und Parameter', { timeout: 120_000 }, () => {
  it('registriert, gültiges Bash, Kennwort nur über stdin (nie Befehlszeile), feste Domänenwerte', () => {
    const s = adBeitretenSkript(P);
    expect(linuxBausteinBekannt(LINUX_SQL_BAUSTEINE.adBeitreten)).toBe(true);
    expect(linuxBausteinBekannt(LINUX_SQL_BAUSTEINE.adVerlassen)).toBe(true);
    expect(s).toContain("--login-type=computer --stdin-password");
    expect(s).toContain("printf '%s' \"$EINMAL\" | adcli join");
    expect(s).not.toMatch(/--one-time-password/);
    expect(s).toContain("NAME='SQLLNX01'");
    expect(s).toContain("OU_DN='OU=Server,DC=ad,DC=3033,DC=at'");
    expect(s).toContain("FQDN='sqllnx01.ad.3033.at'");
    expect(s).toContain("'adcli=0.9.2-1ubuntu2'");
    expect(s).not.toContain(EINMAL);
    expect(LINUX_SQL_MIN_ZEITLIMIT_S.ad_beitreten).toBe(660);
    expect(LINUX_SQL_MIN_ZEITLIMIT_S.ad_verlassen).toBe(360);
    // Fix-Runde 1 (R12): keine Anmeldung von Domänenbenutzern — deny statt simple; nur NSS-Responder
    expect(sssdAusLauf()).toContain('access_provider = deny');
    expect(sssdAusLauf()).not.toMatch(/simple_allow|access_provider = simple/);
    expect(sssdAusLauf()).toContain('services = nss\n');
    expect(krb5AusLauf().split('\n')[0]).toBe(AD_KRB5_KOPF);
    for (const t of [s, adVerlassenSkript(V)]) {
      if (!BASH) continue;
      const r = spawnSync('bash', ['-n'], { input: t, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    }
  });
  it('Parameter streng: sqllnxcfg nie, Domäne/OU/DCs fest, Paketliste vollständig', () => {
    expect(pruefeAdBeitreten(P)).toBeUndefined();
    expect(pruefeAdBeitreten({ ...P, computername: 'sqllnxcfg' })).toBe('sqllnxcfg tritt nicht bei (Spec 10)');
    expect(pruefeAdBeitreten({ ...P, domaene: 'andere.at' })).toContain('domaene');
    expect(pruefeAdBeitreten({ ...P, ou: 'Computers' })).toContain('ou');
    expect(pruefeAdBeitreten({ ...P, dcs: ['10.0.0.1'] })).toContain('dcs');
    expect(pruefeAdBeitreten({ ...P, computername: 'sqllnx01;rm' })).toContain('computername');
    const { adcli: _a, ...ohne } = LINUX_AD_PAKETE;
    expect(pruefeAdBeitreten({ ...P, pakete: ohne })).toContain('pakete');
    expect(pruefeAdBeitreten({ ...P, pakete: { ...LINUX_AD_PAKETE, sssd: '2.9 ; rm' } })).toContain('pakete.sssd');
    expect(() => adBeitretenSkript({ ...P, computername: 'sqllnxcfg' })).toThrow('Spec 10');
    expect(pruefeAdVerlassen(V)).toBeUndefined();
    expect(() => adVerlassenSkript({ computername: 'x;rm -rf /' })).toThrow('computername');
  });
  it('R11: keine eigene SNTP-Probe mehr — ad_beitreten liest die Zeitquelle (Drop-in, timedatectl)', () => {
    const s = adBeitretenSkript(P);
    expect(s).not.toMatch(/PY_SNTP|socket|uhr_abweichung/);
    expect(s).toContain(`ZQ_DROPIN='${ZEITQUELLE_DROPIN}'`);
    expect(s).toContain('UHR_MAX_MS=60000');
  });
});

describe.skipIf(!BASH)('linux_sql ad_beitreten — ausgeführt', { timeout: 180_000 }, () => {
  it('hostname -f = sqllnx01 → Abbruch „hosts-Block/DNS fehlt“, nichts installiert, nichts geändert', () => {
    const r = beitreten({ hostnameF: 'sqllnx01' });
    expect(r.rc, r.aus).toBe(1);
    expect(String(r.e?.fehler)).toContain('hosts-Block/DNS fehlt');
    expect(String(r.e?.fehler)).toContain('nichts geändert');
    expect(r.log).not.toMatch(/apt-get|apt-mark|adcli|systemctl|pam-auth-update/);
    expect(ohneNss(r.dateien)).toEqual([]);
    expect(r.nss).not.toContain('sss');
  });
  it('PTR falsch, Uhr zu weit weg, fremde sssd.conf/krb5.conf/Keytab, Paket nicht verfügbar → Abbruch ohne Änderung', () => {
    for (const [l, text] of [
      [{ ptr: 'anders.ad.3033.at' }, "PTR von 10.203.30.10 ist 'anders.ad.3033.at'"],
      [{ uhr: '-1min 15.2s' }, 'Zeitquelle zuerst einrichten (linux_sql zeitquelle_einrichten) — nichts geändert (Offset -75200 ms, höchstens ±60000 ms)'],
      [{ fremdeSssd: true }, 'nicht von Alfred'],
      [{ krb5: 'fremd' }, 'krb5.conf ist fremd (weder von Alfred noch die unveränderte Vorgabe von krb5-config) — nichts geändert'],
      [{ fremderKeytab: true }, 'enthält fremde Principals (http/web01.ad.3033.at@ad.3033.at'],
    ] as Array<[Lauf, string]>) {
      const r = beitreten(l);
      expect(r.rc, r.aus).toBe(1);
      expect(String(r.e?.fehler)).toContain(text);
      expect(r.log).not.toMatch(/apt-get|adcli|systemctl|pam-auth-update/);
    }
    const f = beitreten({ krb5: 'fremd' });
    expect(f.krb5.trim()).toBe(FREMD_KRB5);
    const v = beitreten({ verfuegbar: { sssd: '2.9.4-1.1ubuntu6.10' } });
    expect(v.rc, v.aus).toBe(1);
    expect(String(v.e?.fehler)).toContain('sssd=2.9.4-1.1ubuntu6.9 ist in der Paketquelle nicht verfügbar (verfügbar: 2.9.4-1.1ubuntu6.10');
    expect(v.log).not.toMatch(/apt-get .*install|adcli/);
    expect(ohneNss(v.dateien)).toEqual([]);
  });
  it('Beitritt: Pakete fest + hold, PAM ohne sss, adcli mit Kennwort über stdin, sssd.conf (deny), NSS, Selbstprüfung — Kennwort nirgends sichtbar', () => {
    const r = beitreten();
    expect(r.rc, r.aus).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'geaendert', domaene: 'ad.3033.at', computerkonto: 'AD3033\\SQLLNX01$', sssd: 'aktiv', beitritt: 'neu', fqdn: 'sqllnx01.ad.3033.at' });
    expect(r.log).toContain('adcli-stdin-ok');
    const join = r.log.split('\n').find(z => z.startsWith('adcli join'))!;
    expect(join).toContain('--computer-name=SQLLNX01');
    expect(join).toContain('--domain-ou=OU=Server,DC=ad,DC=3033,DC=at');
    expect(join).toContain('--host-fqdn=sqllnx01.ad.3033.at');
    // nie im Argument (ps), nie in Ausgabe/Fehler, nie im Protokoll der Stubs außer als Prüfvermerk
    expect(r.log).not.toContain(EINMAL);
    expect(r.aus).not.toContain(EINMAL);
    for (const n of Object.keys(LINUX_AD_PAKETE)) expect(r.dateien).toContain(`held/${n}`);
    expect(r.log).toContain(`apt-get -o DPkg::Lock::Timeout=300 install -y -q --no-install-recommends -o Dpkg::Options::=--force-confold ${Object.entries(LINUX_AD_PAKETE).map(([n, v]) => `${n}=${v}`).join(' ')}`);
    // R13: libpam-sss hat pam_sss eingeschaltet → abgeschaltet, vor dem Beitritt
    expect(r.log).toContain('pam-auth-update --disable sss');
    expect(r.log.indexOf('pam-auth-update')).toBeLessThan(r.log.indexOf('adcli join'));
    expect(r.pam).not.toContain('pam_sss');
    expect(r.pam).toContain('pam_unix.so');
    expect(r.sssd.split('\n')[0]).toBe(AD_SSSD_KOPF);
    expect(r.sssd).toContain('access_provider = deny');
    expect(r.sssd).not.toContain('simple_allow_users');
    expect(r.sssd).toContain('use_fully_qualified_names = True');
    expect(r.sssd).toContain('ad_hostname = sqllnx01.ad.3033.at');
    expect(r.nss).toMatch(/^passwd:\s+files systemd sss$/m);
    expect(r.nss).toMatch(/^group:\s+files systemd sss$/m);
    // krb5-config legte bei der Installation seine Vorgabe an → gesichert und durch Alfreds krb5.conf ersetzt
    expect(r.krb5.split('\n')[0]).toBe(AD_KRB5_KOPF);
    expect(r.krb5Alt).toContain('default_realm = AD.3033.AT');
    expect(r.e?.aenderungen).toEqual(expect.arrayContaining(['pam-ohne-sss', 'krb5-vorgabe-gesichert', 'krb5.conf', 'beitritt']));
    expect(r.dateien).toEqual(expect.arrayContaining(['etc/krb5.conf', 'etc/krb5.keytab', 'etc/sssd/sssd.conf', 'aktiv', 'an']));
    // hostname wird nur gelesen
    expect(r.log.split('\n').filter(z => z.startsWith('hostname'))).toEqual(['hostname -f']);
  });
  it('vorhandene unveränderte krb5-config-Vorgabe → gesichert und ersetzt', () => {
    const r = beitreten({ krb5: 'vorgabe' });
    expect(r.rc, r.aus).toBe(0);
    expect(r.krb5.split('\n')[0]).toBe(AD_KRB5_KOPF);
    expect(r.krb5Alt.trimEnd()).toBe(`${VORGABE}`);
  });
  it('ältere krb5-Sicherung weicht ab → Abbruch, nichts geändert; gleiche Sicherung → Beitritt', () => {
    const r = beitreten({ krb5: 'vorgabe', krb5Alt: true });
    expect(r.rc, r.aus).toBe(1);
    expect(String(r.e?.fehler)).toContain('ältere Sicherung weicht von der jetzigen');
    expect(String(r.e?.fehler)).toContain('nichts geändert');
    expect(r.log).not.toMatch(/apt-get|adcli|systemctl|pam-auth-update/);
    expect(r.krb5.split('\n')[0]).not.toBe(AD_KRB5_KOPF);
    const g = ausfuehren(adBeitretenSkript(P), { krb5: 'vorgabe' }, 'cp "$T/etc/krb5.conf" "$T/etc/krb5.conf.alfred-vorher"');
    expect(g.rc, g.aus).toBe(0);
    expect(g.krb5.split('\n')[0]).toBe(AD_KRB5_KOPF);
    expect(g.e?.aenderungen).not.toContain('krb5-vorgabe-gesichert');
  });
  it('schon beigetreten → „schon“ ohne adcli join, ohne Kennwort, ohne PAM-Änderung', () => {
    const r = ausfuehren(adBeitretenSkript(P), { beigetreten: true, einmal: '' });
    expect(r.rc, r.aus).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'schon', beitritt: 'schon', aenderungen: [] });
    expect(r.log).not.toMatch(/adcli join|apt-get|apt-mark|systemctl restart|pam-auth-update/);
  });
  it('R11: ohne eingerichtete Zeitquelle (kein Drop-in, nicht synchron, keine Messung) → Abbruch vor jeder Änderung', () => {
    for (const [l, text] of [
      [{ zeitquelle: false }, 'fehlt oder ist nicht von Alfred'],
      [{ sync: 'no' }, '(NTPSynchronized no)'],
      [{ uhr: '' }, '(keine Messung in timedatectl timesync-status)'],
    ] as Array<[Lauf, string]>) {
      const r = beitreten(l);
      expect(r.rc, r.aus).toBe(1);
      expect(String(r.e?.fehler)).toContain('Zeitquelle zuerst einrichten (linux_sql zeitquelle_einrichten) — nichts geändert');
      expect(String(r.e?.fehler)).toContain(text);
      expect(r.log).not.toMatch(/apt-get|apt-mark|adcli|systemctl|pam-auth-update/);
      expect(ohneNss(r.dateien)).toEqual([]);
    }
    // mit Zeitquelle: Abweichung im Ergebnis (Sekunden aus dem Offset von timesyncd)
    const ok = beitreten({ uhr: '-12.5ms' });
    expect(ok.rc, ok.aus).toBe(0);
    expect(ok.e?.uhrAbweichungS).toBe('-0.013');
  });
  it('nicht beigetreten ohne Einmal-Kennwort → Abbruch mit Hinweis auf computerkonto_vorbereiten', () => {
    const r = beitreten({ einmal: '' });
    expect(r.rc, r.aus).toBe(1);
    expect(String(r.e?.fehler)).toContain('windows_ad computerkonto_vorbereiten name sqllnx01');
    expect(r.log).not.toContain('adcli join');
  });
  it('adcli scheitert und gibt das Kennwort aus → Fehlertext geschwärzt', () => {
    const r = beitreten({ adcliFehler: true });
    expect(r.rc, r.aus).toBe(1);
    expect(String(r.e?.fehler)).toContain('adcli join fehlgeschlagen');
    expect(String(r.e?.fehler)).toContain('[geschwärzt]');
    expect(r.aus).not.toContain(EINMAL);
  });
});

describe.skipIf(!BASH)('linux_sql ad_verlassen — ausgeführt', { timeout: 180_000 }, () => {
  it('eigene Einrichtung: sssd aus, sssd.conf + Keytab + Zwischenspeicher weg, NSS und PAM ohne sss, krb5-Vorgabe zurück; zweiter Lauf „schon“', () => {
    const r = ausfuehren(adVerlassenSkript(V), { beigetreten: true, pamSss: true, krb5Alt: true });
    expect(r.rc, r.aus).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'geaendert', domaene: 'ad.3033.at', sssd: 'aus', belassen: [] });
    expect(r.dateien.filter(d => d.startsWith('etc/') || d.startsWith('sss/') || d === 'aktiv' || d === 'an')).toEqual(['etc/krb5.conf', 'etc/nsswitch.conf']);
    expect(r.krb5.trim()).toBe(VORGABE);
    expect(r.krb5Alt).toBe('');
    expect(r.nss).not.toMatch(/\bsss\b/);
    expect(r.nss).toMatch(/^passwd:\s+files systemd$/m);
    expect(r.pam).not.toContain('pam_sss');
    expect(r.log).toContain('pam-auth-update --disable sss');
    // Fix-Runde 2 (R13): PAM und NSS ohne sss, bevor sssd stoppt
    expect(r.log.indexOf('pam-auth-update --disable sss')).toBeLessThan(r.log.indexOf('systemctl disable --now sssd'));
    const a = r.e?.aenderungen as string[];
    expect(a.indexOf('pam-ohne-sss')).toBeLessThan(a.indexOf('sssd-aus'));
    expect(a.indexOf('nsswitch')).toBeLessThan(a.indexOf('sssd-aus'));
    expect(a.indexOf('pam-ohne-sss')).toBeGreaterThanOrEqual(0);
    expect(r.log).not.toMatch(/adcli|apt-get/);
    const s = ausfuehren(adVerlassenSkript(V), {});
    expect(s.rc, s.aus).toBe(0);
    expect(s.e).toMatchObject({ zustand: 'schon', aenderungen: [], belassen: [] });
  });
  it('fremde krb5.conf (ohne Alfred-Kopf) → bleibt unverändert', () => {
    const r = ausfuehren(adVerlassenSkript(V), { beigetreten: true }, `printf '%s\\n' ${q(FREMD_KRB5)} >"$T/etc/krb5.conf"`);
    expect(r.rc, r.aus).toBe(0);
    expect(r.krb5.trim()).toBe(FREMD_KRB5);
    expect(r.e?.aenderungen).not.toContain('krb5.conf');
    expect(r.e?.aenderungen).not.toContain('krb5-vorgabe-zurueck');
  });
  it('ohne Sicherung: Alfreds krb5.conf wird entfernt', () => {
    const r = ausfuehren(adVerlassenSkript(V), { beigetreten: true });
    expect(r.rc, r.aus).toBe(0);
    expect(r.krb5).toBe('');
    expect(r.e?.aenderungen).toContain('krb5.conf');
  });
  it('fremde sssd.conf → bleibt samt sssd, NSS und PAM; Ergebnis nennt sie', () => {
    const r = ausfuehren(adVerlassenSkript(V), { beigetreten: true, fremdeSssd: true, pamSss: true });
    expect(r.rc, r.aus).toBe(0);
    expect(r.e?.sssd).toBe('fremd');
    expect(String((r.e?.belassen as string[])[0])).toContain('sssd.conf (nicht von Alfred) — sssd, NSS und PAM unverändert');
    expect(r.sssd).toContain('domains = andere.domaene');
    expect(r.dateien).toEqual(expect.arrayContaining(['etc/sssd/sssd.conf', 'aktiv', 'an', 'sss/db/cache_ad.3033.at.ldb']));
    expect(r.nss).toMatch(/^passwd:\s+files systemd sss$/m);
    expect(r.pam).toContain('pam_sss');
    expect(r.log).not.toMatch(/systemctl disable|pam-auth-update/);
  });
  it('Keytab mit fremdem Principal → bleibt; Ergebnis nennt ihn; der Rest wird zurückgenommen', () => {
    const r = ausfuehren(adVerlassenSkript(V), { beigetreten: true, fremderKeytab: true });
    expect(r.rc, r.aus).toBe(0);
    expect(r.e?.sssd).toBe('aus');
    expect(String((r.e?.belassen as string[])[0])).toContain('krb5.keytab (enthält fremde Principals oder ist nicht lesbar: http/web01.ad.3033.at@ad.3033.at');
    expect(r.dateien).toContain('etc/krb5.keytab');
    expect(r.dateien).not.toContain('etc/sssd/sssd.conf');
  });
});

describe('linux_sql ad_beitreten/ad_verlassen — Skill', { timeout: 120_000 }, () => {
  function skill(antwort: Record<string, unknown>, opt: { tresor?: string[]; ohneEntferne?: boolean } = {}) {
    const aufrufe: Array<{ baustein: string; parameter: unknown; eingabe?: string }> = [];
    const namen = new Set(opt.tresor ?? ['ad-join-sqllnx01']);
    const entfernt: string[] = [];
    const s = new LinuxSqlSkill({
      skript: async (_z, baustein, parameter, eingabe) => { aufrufe.push({ baustein, parameter, ...(eingabe ? { eingabe } : {}) }); return { code: antwort.zustand === 'fehler' ? 1 : 0, stdout: `ALFRED-SQL ${JSON.stringify(antwort)}\n`, stderr: '' }; },
      tresor: {
        namen: async () => namen, lies: async () => EINMAL, setze: async () => undefined,
        ...(opt.ohneEntferne ? {} : { entferne: async (n: string) => { entfernt.push(n); return namen.delete(n); } }),
      },
    });
    return { s, aufrufe, entfernt };
  }
  const ok = { zustand: 'geaendert', domaene: 'ad.3033.at', computerkonto: 'AD3033\\SQLLNX01$', sssd: 'aktiv', beitritt: 'neu', fqdn: 'sqllnx01.ad.3033.at', uhrAbweichungS: '+1.4', aenderungen: ['pakete', 'beitritt'] };

  it('nur im Change; Einmal-Kennwort nur über stdin; Tresor-Eintrag nach Erfolg entfernt; AD_JOINED', async () => {
    const w = skill(ok);
    expect((await w.s.execute({ action: 'ad_beitreten', zugang: 'sqllnx01' }, {} as never)).error).toContain('nur als Schritt');
    const r = await w.s.execute({ action: 'ad_beitreten', zugang: 'sqllnx01' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toContain('AD_JOINED AD3033\\SQLLNX01$ in ad.3033.at');
    expect(r.display).toContain('Tresor-Eintrag ad-join-sqllnx01 entfernt');
    expect(w.entfernt).toEqual(['ad-join-sqllnx01']);
    expect(w.aufrufe[0]!.baustein).toBe(LINUX_SQL_BAUSTEINE.adBeitreten);
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ einmal: EINMAL });
    expect(JSON.stringify(w.aufrufe[0]!.parameter)).not.toContain(EINMAL);
    expect(w.aufrufe[0]!.parameter).toMatchObject({ domaene: LINUX_AD.domaene, computername: 'sqllnx01', ou: 'Server' });
    expect(r.display).not.toContain(EINMAL);
  });
  it('Fehlschlag → Tresor-Eintrag bleibt, Fehlertext ohne Kennwort', async () => {
    const w = skill({ zustand: 'fehler', fehler: `adcli join fehlgeschlagen: falsches Kennwort ${EINMAL}` });
    const r = await w.s.execute({ action: 'ad_beitreten', zugang: 'sqllnx01' }, imChange);
    expect(r.success).toBe(false);
    expect(r.error).toContain('adcli join fehlgeschlagen');
    expect(r.error).not.toContain(EINMAL);
    expect(w.entfernt).toEqual([]);
  });
  it('Selbstprüfung des Skills: sssd nicht aktiv → Fehler, Eintrag bleibt', async () => {
    const w = skill({ ...ok, sssd: 'aus' });
    const r = await w.s.execute({ action: 'ad_beitreten', zugang: 'sqllnx01' }, imChange);
    expect(r.success).toBe(false);
    expect(w.entfernt).toEqual([]);
  });
  it('ohne Tresor-Eintrag: Baustein ohne Eingabe, schon beigetreten → „nichts zu tun“', async () => {
    const w = skill({ ...ok, zustand: 'schon', beitritt: 'schon', aenderungen: [] }, { tresor: [] });
    const r = await w.s.execute({ action: 'ad_beitreten', zugang: 'sqllnx01' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toContain('nichts zu tun');
    expect(w.aufrufe[0]!.eingabe).toBeUndefined();
    expect(w.entfernt).toEqual([]);
  });
  it('Tresor ohne Entfernen → Erfolg mit sichtbarer WARNUNG', async () => {
    const r = await skill(ok, { ohneEntferne: true }).s.execute({ action: 'ad_beitreten', zugang: 'sqllnx01' }, imChange);
    expect(r.success).toBe(true);
    expect(r.display).toContain('WARNUNG: Tresor-Eintrag ad-join-sqllnx01 nicht entfernt');
  });
  it('sqllnxcfg als zugang oder computername → Validierungsfehler, kein Aufruf, kein Tresor', async () => {
    const w = skill(ok);
    for (const input of [{ zugang: 'sqllnxcfg' }, { zugang: 'sqllnx01', computername: 'sqllnxcfg' }, { zugang: 'SQLLNXCFG' }]) {
      const r = await w.s.execute({ action: 'ad_beitreten', ...input }, imChange);
      expect(r.success).toBe(false);
      expect(r.error).toBe('sqllnxcfg tritt nicht bei (Spec 10)');
      expect(w.s.pruefeEingabe({ action: 'ad_beitreten', ...input })).toBe('sqllnxcfg tritt nicht bei (Spec 10)');
    }
    expect(w.s.pruefeEingabe({ action: 'ad_beitreten', zugang: 'sqllnxcfg', pakete: '{{schritt1.x}}' })).toBe('sqllnxcfg tritt nicht bei (Spec 10)');
    expect(w.aufrufe).toEqual([]);
    expect(w.s.pruefeEingabe({ action: 'ad_beitreten', zugang: 'sqllnx02' })).toBeUndefined();
    expect(w.s.pruefeEingabe({ action: 'ad_beitreten', zugang: 'sqllnx02', pakete: { sssd: 'x y' } })).toContain('pakete.sssd');
    expect(w.s.pruefeEingabe({ action: 'ad_beitreten', zugang: 'sqllnx02', pakete: { fremd: '1.0' } })).toContain('unbekannt fremd');
  });
  it('computername abweichend vom zugang → Tresor ad-join-<computername>, Paketversion überschreibbar', async () => {
    const w = skill(ok, { tresor: ['ad-join-sqllnx02'] });
    const r = await w.s.execute({ action: 'ad_beitreten', zugang: 'sqllnx02-neu', computername: 'SQLLNX02', pakete: { sssd: '2.9.4-1.1ubuntu6.10' } }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.entfernt).toEqual(['ad-join-sqllnx02']);
    expect((w.aufrufe[0]!.parameter as AdBeitretenParameter).pakete.sssd).toBe('2.9.4-1.1ubuntu6.10');
    expect((w.aufrufe[0]!.parameter as AdBeitretenParameter).computername).toBe('sqllnx02');
  });
  it('ad_verlassen: nur im Change, AD_LEFT mit Hinweis auf windows_ad computerkonto_entfernen', async () => {
    const w = skill({ zustand: 'geaendert', domaene: 'ad.3033.at', sssd: 'aus', aenderungen: ['sssd-aus', 'keytab'] });
    expect((await w.s.execute({ action: 'ad_verlassen', zugang: 'sqllnx01' }, {} as never)).success).toBe(false);
    const r = await w.s.execute({ action: 'ad_verlassen', zugang: 'sqllnx01' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toContain('AD_LEFT sqllnx01');
    expect(r.display).toContain('windows_ad computerkonto_entfernen');
    expect(w.aufrufe[0]!.baustein).toBe(LINUX_SQL_BAUSTEINE.adVerlassen);
    expect(w.aufrufe[0]!.parameter).toEqual({ computername: 'sqllnx01' });
    expect(w.aufrufe[0]!.eingabe).toBeUndefined();
  });
  it('ad_verlassen: Belassenes (fremd) steht in der Anzeige, Erfolg', async () => {
    const w = skill({ zustand: 'schon', domaene: 'ad.3033.at', sssd: 'fremd', belassen: ['/etc/sssd/sssd.conf (nicht von Alfred) — sssd, NSS und PAM unverändert'], aenderungen: [] });
    const r = await w.s.execute({ action: 'ad_verlassen', zugang: 'sqllnx02-neu', computername: 'SQLLNX02' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toContain('belassen (nicht von Alfred): /etc/sssd/sssd.conf');
    expect(r.display).toContain('fremde sssd-Einrichtung unverändert');
    expect(w.aufrufe[0]!.parameter).toEqual({ computername: 'sqllnx02' });
  });
});

describe('linux_sql ad_beitreten — Change-Regeln', { timeout: 120_000 }, () => {
  const skill = new LinuxSqlSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const ctx = { skill: (n: string) => (n === 'linux_sql' ? skill : undefined) as never, asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
  const plan = (rueckweg: unknown) => ({ titel: 'AD-Beitritt sqllnx01', begruendung: 'I8e Etappe 3', typ: 'normal', risiko: 'mittel', ausfallMinuten: 0, betroffen: ['sqllnx01'],
    ohneSicherungGrund: 'Beitritt hat einen eigenen Rückweg (ad_verlassen)',
    schritte: [{ titel: 'Beitritt', art: 'aktion', skill: 'linux_sql', aktion: 'ad_beitreten', parameter: { zugang: 'sqllnx01' }, zeitlimitS: 700, rueckweg }] });
  it('Rückweg genau linux_sql.ad_verlassen auf demselben Zugang; selbstgeprüft (keine eigene Prüfung nötig)', () => {
    const f = (rw: unknown) => pruefeChangePlan(plan(rw) as never, ctx as never).fehler;
    expect(f({ keiner: 'geht nicht' }).some(x => x.includes('braucht immer einen Rückweg — rueckweg linux_sql.ad_verlassen (zugang)'))).toBe(true);
    expect(f({ skill: 'linux_sql', aktion: 'status', parameter: { zugang: 'sqllnx01' } }).some(x => x.includes('braucht als Rückweg genau linux_sql.ad_verlassen'))).toBe(true);
    expect(f({ skill: 'linux_sql', aktion: 'ad_verlassen', parameter: { zugang: 'sqllnx02' } }).some(x => x.includes('ad_verlassen muss auf demselben Zugang laufen'))).toBe(true);
    expect(f({ skill: 'linux_sql', aktion: 'ad_verlassen', parameter: { zugang: 'sqllnx01' } })).toEqual([]);
  });
});

// ── Ruling R11 — linux_sql zeitquelle_einrichten / zeitquelle_entfernen ─────────────────────────────────────────────────────────

/** Stubs: timedatectl liest $T/zeit; Neustart mit Alfreds Drop-in und antwortendem DC → synchron mit dc02 (Offset aus $T/zeit/offset) */
const ZEIT_STUBS = String.raw`ZQ_DROPIN="$T/etc/timesyncd.conf.d/alfred-ad.conf"; TIMESYNCD="$T/timesyncd"; DROPIN_ORDNER=("$T/etc/timesyncd.conf.d" "$T/run/timesyncd.conf.d")
json_text() { local x; x=$(cat); printf '"%s"' "§{x//\"/}"; }
log() { printf '%s\n' "$*" >>"$T/log"; }
sleep() { :; }
timedatectl() {
  case "$1 §{2:-}" in
    "show -p") case "$3" in NTPSynchronized) cat "$T/zeit/sync" ;; NTP) cat "$T/zeit/ntp" ;; esac ;;
    "show-timesync -p") cat "$T/zeit/server" ;;
    "timesync-status ") cat "$T/zeit/status" ;;
    "set-ntp true") log "timedatectl set-ntp true"; echo yes >"$T/zeit/ntp" ;;
  esac
}
systemctl() {
  local u="§{@: -1}"
  case "$1" in is-active) [ -f "$T/svc/$u" ]; return ;; esac
  log "systemctl $*"
  case "$1" in
    restart)
      [ ! -f "$T/restart_fehler" ] || { echo "Job for $u failed"; return 1; }
      touch "$T/svc/$u"
      if [ -f "$ZQ_DROPIN" ] && [ -f "$T/dc_antwortet" ]; then
        echo yes >"$T/zeit/sync"; echo 10.203.29.3 >"$T/zeit/server"
        printf '       Server: 10.203.29.3 (10.203.29.3)\nPoll interval: 32s (min: 32s; max 34min 8s)\n       Offset: %s\n        Delay: 515us\n' "$(cat "$T/zeit/offset")" >"$T/zeit/status"
      elif [ -f "$ZQ_DROPIN" ]; then
        echo no >"$T/zeit/sync"; echo 10.203.29.2 >"$T/zeit/server"; printf '       Server: 10.203.29.2 (10.203.29.2)\n Packet count: 0\n' >"$T/zeit/status"
      else
        echo no >"$T/zeit/sync"; echo 185.125.190.56 >"$T/zeit/server"; : >"$T/zeit/status"
      fi ;;
  esac
}`.replaceAll('§{', '${');

interface ZeitLauf { rc: number; e?: Record<string, unknown>; aus: string; log: string }
function zeitLaeufe(skript: string, setup = '', n = 1): { laeufe: ZeitLauf[]; dropin: string; dateien: string[] } {
  const text = skript.replace('# ALFRED-ABLAUF', `${ZEIT_STUBS}\n# ALFRED-ABLAUF`);
  const huelle = [
    'T=$(mktemp -d)', 'mkdir -p "$T/zeit" "$T/svc" "$T/etc/timesyncd.conf.d" "$T/run/timesyncd.conf.d"',
    // wie live vor R11: timesyncd läuft, versucht ntp.ubuntu.com ohne Antwort
    `printf '#!/bin/sh\\n' >"$T/timesyncd"; chmod +x "$T/timesyncd"; echo no >"$T/zeit/sync"; echo yes >"$T/zeit/ntp"; echo 185.125.190.56 >"$T/zeit/server"; : >"$T/zeit/status"; echo -1.234ms >"$T/zeit/offset"`,
    'touch "$T/svc/systemd-timesyncd" "$T/dc_antwortet"; : >"$T/log"',
    setup, "ALFRED_EINGABE=''",
    ...Array.from({ length: n }, (_, i) => `( ${text}\n) >"$T/aus" 2>&1; echo "RC=$?"; echo "---AUS${i}"; cat "$T/aus"; echo "---LOG${i}"; cat "$T/log"; : >"$T/log"`),
    'echo "---DROPIN"; cat "$T/etc/timesyncd.conf.d/alfred-ad.conf" 2>/dev/null', 'echo "---DATEIEN"; (cd "$T" && find etc run -type f | sort)', 'echo "---ENDE"', 'rm -rf "$T"',
  ].join('\n');
  const o = spawnSync('bash', [], { input: huelle, encoding: 'utf8' }).stdout;
  const zw = (a: string, b: string) => o.split(`${a}\n`)[1]?.split(`${b}\n`)[0] ?? '';
  const rcs = [...o.matchAll(/^RC=(\d+)$/gm)].map(m => Number(m[1]));
  return {
    laeufe: Array.from({ length: n }, (_, i) => {
      const aus = zw(`---AUS${i}`, `---LOG${i}`);
      return { rc: rcs[i] ?? -1, e: sqlErgebnis<Record<string, unknown>>(aus), aus, log: zw(`---LOG${i}`, i + 1 < n ? `RC=${rcs[i + 1]}` : '---DROPIN') };
    }),
    dropin: zw('---DROPIN', '---DATEIEN'), dateien: zw('---DATEIEN', '---ENDE').split('\n').filter(Boolean),
  };
}
const einrichten = (setup = '', n = 1) => zeitLaeufe(zeitquelleEinrichtenSkript(), setup, n);
const DROPIN_EIGEN = `printf '%s\\n' ${q(zeitquelleDropin())} >"$T/etc/timesyncd.conf.d/alfred-ad.conf"`;

describe('linux_sql zeitquelle_einrichten — Skripttext', { timeout: 120_000 }, () => {
  it('registriert, gültiges Bash, Drop-in genau: Alfred-Kopf, NTP = die DCs, FallbackNTP leer', () => {
    expect(linuxBausteinBekannt(LINUX_SQL_BAUSTEINE.zeitquelleEinrichten)).toBe(true);
    expect(linuxBausteinBekannt(LINUX_SQL_BAUSTEINE.zeitquelleEntfernen)).toBe(true);
    expect(ZEITQUELLE_DCS).toEqual(LINUX_AD.dcs);
    expect(ZEITQUELLE_DROPIN).toBe('/etc/systemd/timesyncd.conf.d/alfred-ad.conf');
    expect(zeitquelleDropin()).toBe(`${ZEITQUELLE_KOPF}\n[Time]\nNTP=\nNTP=10.203.29.2 10.203.29.3\nFallbackNTP=`);
    expect(LINUX_SQL_MIN_ZEITLIMIT_S.zeitquelle_einrichten).toBe(300);
    expect(LINUX_SQL_MIN_ZEITLIMIT_S.zeitquelle_entfernen).toBe(150);
    for (const t of [zeitquelleEinrichtenSkript(), zeitquelleEntfernenSkript()]) {
      if (!BASH) continue;
      const r = spawnSync('bash', ['-n'], { input: t, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    }
  });
});

describe.skipIf(!BASH)('linux_sql zeitquelle_einrichten — ausgeführt', { timeout: 180_000 }, () => {
  it('synchronisiert → Drop-in, Neustart, TIME_SYNCED-Daten; Wiederholung „schon“ ohne Neustart', () => {
    const w = einrichten('', 2);
    const [a, b] = w.laeufe as [ZeitLauf, ZeitLauf];
    expect(a.rc, a.aus).toBe(0);
    expect(a.e).toMatchObject({ zustand: 'geaendert', server: '10.203.29.3', offsetMs: -1, synchronisiert: true, aenderungen: ['dropin', 'timesyncd-neu-gestartet'] });
    expect(w.dropin.trimEnd()).toBe(zeitquelleDropin());
    expect(a.log).toContain('systemctl restart systemd-timesyncd');
    expect(b.rc, b.aus).toBe(0);
    expect(b.e).toMatchObject({ zustand: 'schon', server: '10.203.29.3', synchronisiert: true, aenderungen: [] });
    expect(b.log).not.toContain('systemctl');
  });
  it('Offset-Formen von timesyncd: us, ms, s, min — gerundet auf ganze ms', () => {
    for (const [roh, ms] of [['-21us', 0], ['+999.4ms', 999], ['-0.5004s', -500], ['0', 0]] as Array<[string, number]>) {
      const r = einrichten(`echo ${q(roh)} >"$T/zeit/offset"`).laeufe[0]!;
      expect(r.rc, `${roh}: ${r.aus}`).toBe(0);
      expect(r.e?.offsetMs, roh).toBe(ms);
    }
    const gross = einrichten(`echo '+2min 3.5s' >"$T/zeit/offset"`).laeufe[0]!;
    expect(gross.rc).toBe(1);
    expect(String(gross.e?.fehler)).toContain('Offset zum DC nach 120 s zu groß (höchstens ±1000 ms; NTPSynchronized yes, Server 10.203.29.3, Offset 123500 ms');
  });
  it('NTP aus → timedatectl set-ntp true (gemeldet)', () => {
    const r = einrichten('echo no >"$T/zeit/ntp"').laeufe[0]!;
    expect(r.rc, r.aus).toBe(0);
    expect(r.log).toContain('timedatectl set-ntp true');
    expect(r.e?.aenderungen).toEqual(['dropin', 'ntp-an', 'timesyncd-neu-gestartet']);
  });
  it('nicht synchronisiert nach der Frist → Abbruch mit gelesenem Status, Drop-in bleibt (Rückweg entfernt es)', () => {
    const w = einrichten('rm -f "$T/dc_antwortet"');
    const r = w.laeufe[0]!;
    expect(r.rc).toBe(1);
    expect(String(r.e?.fehler)).toContain('nach 120 s nicht mit einem DC synchronisiert (NTPSynchronized no, Server 10.203.29.2, Offset keine Messung; timesync-status:');
    expect(String(r.e?.fehler)).toContain('Packet count: 0');
    expect(String(r.e?.fehler)).toContain('Drop-in bleibt (Rückweg zeitquelle_entfernen)');
    expect(w.dropin.trimEnd()).toBe(zeitquelleDropin());
  });
  it('chrony/ntpd aktiv, fremdes Drop-in mit NTP=, fremde Datei an Alfreds Stelle → Abbruch ohne Änderung', () => {
    for (const [setup, text] of [
      ['touch "$T/svc/chrony"', 'andere Zeitquelle aktiv — nichts geändert (chrony läuft'],
      ['touch "$T/svc/ntpsec"', 'andere Zeitquelle aktiv — nichts geändert (ntpsec läuft'],
      [`printf '[Time]\\nNTP=pool.ntp.org\\n' >"$T/run/timesyncd.conf.d/zz-anders.conf"`, 'zz-anders.conf setzt NTP/FallbackNTP (würde die DCs ergänzen oder ersetzen) — nichts geändert'],
      [`printf '[Time]\\nNTP=10.0.0.1\\n' >"$T/etc/timesyncd.conf.d/alfred-ad.conf"`, 'alfred-ad.conf ist nicht von Alfred (andere Kopfzeile) — nichts geändert'],
      ['rm -f "$T/timesyncd"', 'systemd-timesyncd fehlt'],
    ] as Array<[string, string]>) {
      const w = einrichten(setup);
      const r = w.laeufe[0]!;
      expect(r.rc, `${setup}: ${r.aus}`).toBe(1);
      expect(String(r.e?.fehler)).toContain(text);
      expect(r.log.trim(), setup).toBe('');
      expect(w.dropin.startsWith(ZEITQUELLE_KOPF), setup).toBe(false);
    }
    // ein fremdes Drop-in ohne NTP-Zeilen stört nicht
    const ok = einrichten(`printf '[Time]\\nPollIntervalMaxSec=1024\\n' >"$T/etc/timesyncd.conf.d/poll.conf"`).laeufe[0]!;
    expect(ok.rc, ok.aus).toBe(0);
  });
  it('Neustart scheitert → Abbruch, Drop-in bleibt', () => {
    const w = einrichten('touch "$T/restart_fehler"');
    expect(w.laeufe[0]!.rc).toBe(1);
    expect(String(w.laeufe[0]!.e?.fehler)).toContain('systemd-timesyncd startet nicht: Job for systemd-timesyncd failed — Drop-in bleibt');
    expect(w.dropin.trimEnd()).toBe(zeitquelleDropin());
  });
});

describe.skipIf(!BASH)('linux_sql zeitquelle_entfernen — ausgeführt', { timeout: 120_000 }, () => {
  it('entfernt nur Alfreds Drop-in, startet timesyncd neu; andere Drop-ins bleiben; zweiter Lauf „schon“', () => {
    const w = zeitLaeufe(zeitquelleEntfernenSkript(), `${DROPIN_EIGEN}; printf '[Time]\\nPollIntervalMaxSec=1024\\n' >"$T/etc/timesyncd.conf.d/poll.conf"`, 2);
    const [a, b] = w.laeufe as [ZeitLauf, ZeitLauf];
    expect(a.rc, a.aus).toBe(0);
    expect(a.e).toMatchObject({ zustand: 'geaendert', belassen: [], aenderungen: ['dropin-entfernt', 'timesyncd-neu-gestartet'] });
    expect(a.log).toContain('systemctl restart systemd-timesyncd');
    expect(w.dateien).toEqual(['etc/timesyncd.conf.d/poll.conf']);
    expect(b.rc, b.aus).toBe(0);
    expect(b.e).toMatchObject({ zustand: 'schon', aenderungen: [] });
    expect(b.log.trim()).toBe('');
  });
  it('fremde Datei an Alfreds Stelle → bleibt, steht in belassen, kein Neustart', () => {
    const w = zeitLaeufe(zeitquelleEntfernenSkript(), `printf '[Time]\\nNTP=10.0.0.1\\n' >"$T/etc/timesyncd.conf.d/alfred-ad.conf"`);
    const r = w.laeufe[0]!;
    expect(r.rc, r.aus).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'schon', aenderungen: [] });
    expect(String((r.e?.belassen as string[])[0])).toContain('alfred-ad.conf (nicht von Alfred)');
    expect(w.dropin).toContain('NTP=10.0.0.1');
    expect(r.log.trim()).toBe('');
  });
});

describe('linux_sql zeitquelle_einrichten/zeitquelle_entfernen — Skill und Change-Regeln', { timeout: 120_000 }, () => {
  function skill(antwort: Record<string, unknown>) {
    const aufrufe: Array<{ baustein: string; parameter: unknown; eingabe?: string }> = [];
    const s = new LinuxSqlSkill({
      skript: async (_z, baustein, parameter, eingabe) => {
        aufrufe.push({ baustein, parameter, ...(eingabe ? { eingabe } : {}) });
        return { code: antwort.zustand === 'fehler' ? 1 : 0, stdout: `ALFRED-SQL ${JSON.stringify(antwort)}\n`, stderr: '' };
      },
    });
    return { s, aufrufe };
  }
  const ok = { zustand: 'geaendert', server: '10.203.29.2', offsetMs: -3, synchronisiert: true, aenderungen: ['dropin', 'timesyncd-neu-gestartet'] };
  it('nur im Change, auch auf sqllnxcfg; TIME_SYNCED; Nachprüfung im Skill (Server ein DC, |Offset| < 1 s)', async () => {
    const w = skill(ok);
    expect((await w.s.execute({ action: 'zeitquelle_einrichten', zugang: 'sqllnxcfg' }, {} as never)).error).toContain('nur als Schritt');
    const r = await w.s.execute({ action: 'zeitquelle_einrichten', zugang: 'sqllnxcfg' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toBe('✅ TIME_SYNCED sqllnxcfg: systemd-timesyncd synchron mit DC 10.203.29.2 (Offset -3 ms; Drop-in /etc/systemd/timesyncd.conf.d/alfred-ad.conf) — geändert: dropin, timesyncd-neu-gestartet');
    expect(w.aufrufe).toEqual([{ baustein: LINUX_SQL_BAUSTEINE.zeitquelleEinrichten, parameter: {} }]);
    expect(w.s.pruefeEingabe({ action: 'zeitquelle_einrichten', zugang: 'sqllnxcfg' })).toBeUndefined();
    expect((await skill({ ...ok, zustand: 'schon', aenderungen: [] }).s.execute({ action: 'zeitquelle_einrichten', zugang: 'sqllnx01' }, imChange)).display).toContain('— nichts zu tun');
    for (const x of [{ server: '185.125.190.56' }, { offsetMs: 1500 }, { synchronisiert: false }]) {
      const f = await skill({ ...ok, ...x }).s.execute({ action: 'zeitquelle_einrichten', zugang: 'sqllnx01' }, imChange);
      expect(f.success).toBe(false);
      expect(f.error).toContain('Nachprüfung fehlgeschlagen');
    }
    const fehler = await skill({ zustand: 'fehler', fehler: 'andere Zeitquelle aktiv — nichts geändert (chrony läuft; systemd-timesyncd wäre wirkungslos)' }).s.execute({ action: 'zeitquelle_einrichten', zugang: 'sqllnx01' }, imChange);
    expect(fehler.error).toContain('andere Zeitquelle aktiv — nichts geändert');
  });
  it('zeitquelle_entfernen: Anzeige mit belassen', async () => {
    const r = await skill({ zustand: 'schon', belassen: ['/etc/systemd/timesyncd.conf.d/alfred-ad.conf (nicht von Alfred)'], aenderungen: [] }).s.execute({ action: 'zeitquelle_entfernen', zugang: 'sqllnx02' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toContain('belassen (nicht von Alfred): /etc/systemd/timesyncd.conf.d/alfred-ad.conf');
    expect(r.display).toContain('nichts zu tun');
  });
  it('Change: Rückweg genau zeitquelle_entfernen auf demselben Zugang; selbstgeprüft', () => {
    const sk = new LinuxSqlSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
    const ctx = { skill: (n: string) => (n === 'linux_sql' ? sk : undefined) as never, asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
    const plan = (rueckweg: unknown) => ({ titel: 'Zeitquelle sqllnxcfg', begruendung: 'I8e Etappe 3, Ruling R11: Zeit von den DCs', typ: 'normal', risiko: 'niedrig', ausfallMinuten: 0, betroffen: ['sqllnxcfg'],
      ohneSicherungGrund: 'nur ein Drop-in, eigener Rückweg',
      schritte: [{ titel: 'Zeitquelle', art: 'aktion', skill: 'linux_sql', aktion: 'zeitquelle_einrichten', parameter: { zugang: 'sqllnxcfg' }, zeitlimitS: 300, rueckweg }] });
    const f = (rw: unknown) => pruefeChangePlan(plan(rw) as never, ctx as never).fehler;
    expect(f({ keiner: 'geht nicht' }).some(x => x.includes('rueckweg linux_sql.zeitquelle_entfernen (zugang)'))).toBe(true);
    expect(f({ skill: 'linux_sql', aktion: 'zeitquelle_entfernen', parameter: { zugang: 'sqllnx01' } }).some(x => x.includes('zeitquelle_entfernen muss auf demselben Zugang laufen'))).toBe(true);
    expect(f({ skill: 'linux_sql', aktion: 'zeitquelle_entfernen', parameter: { zugang: 'sqllnxcfg' } })).toEqual([]);
  });
});
