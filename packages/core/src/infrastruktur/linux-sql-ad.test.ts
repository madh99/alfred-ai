import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  adBeitretenSkript, adVerlassenSkript, pruefeAdBeitreten, LINUX_AD, LINUX_AD_PAKETE, AD_SSSD_KOPF, AD_KEIN_ZUGANG, PY_SNTP, type AdBeitretenParameter,
} from './linux-sql-ad.js';
import { sqlErgebnis, LINUX_SQL_BAUSTEINE } from './linux-sql.js';
import { LinuxSqlSkill, LINUX_SQL_MIN_ZEITLIMIT_S } from './linux-sql-skill.js';
import { linuxBausteinBekannt } from '../fernzugriff/linux-bausteine.js';
import { pruefeChangePlan } from './change-schritte.js';

// I8e Etappe 3 Task 4 — Domänenbeitritt mit Einmal-Kennwort ohne Admin-Konto, lokaler Rückweg

const BASH = (() => { const r = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }); return r.status === 0 && /^\d+\./.test(r.stdout.trim()); })();
const PYTHON = ['python3', 'python'].find(p => spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3');
const imChange = { ausChange: true } as never;
const EINMAL = 'Einmal-Geheim_7Kq2Zx9Wv4Ty';
/** Shell-Literal in einfachen Anführungszeichen (echte Zeilenumbrüche, kein $-Ersetzen) */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const P: AdBeitretenParameter = { domaene: 'ad.3033.at', realm: 'AD.3033.AT', ou: 'Server', computername: 'sqllnx01', dcs: ['10.203.29.2', '10.203.29.3'], pakete: { ...LINUX_AD_PAKETE } };

interface Lauf {
  hostnameF?: string;
  ptr?: string;
  uhr?: string;
  /** Einmal-Kennwort in der Eingabe (Standard EINMAL) */
  einmal?: string;
  /** schon beigetreten: Keytab, sssd.conf, Pakete gehalten, sssd aktiv */
  beigetreten?: boolean;
  /** adcli join scheitert und gibt das Kennwort aus */
  adcliFehler?: boolean;
  /** Version in der Paketquelle (Standard: die feste) */
  verfuegbar?: Record<string, string>;
  /** vorhandene sssd.conf (fremd) */
  fremdeSssd?: boolean;
}

const KEYTAB_INHALT = 'Keytab name: FILE:/etc/krb5.keytab\nKVNO Principal\n---- ----------\n   2 SQLLNX01$@AD.3033.AT\n   2 host/sqllnx01.ad.3033.at@AD.3033.AT\n   2 host/SQLLNX01@AD.3033.AT';

/** Stubs (nach den Hilfsfunktionen, vor dem Ablauf): Systemprogramme als Shell-Funktionen, Zustand in Dateien unter $T */
function stubs(l: Lauf): string {
  return [
    'TMP_BASIS="$T"; SSSD_CONF="$T/etc/sssd/sssd.conf"; KRB5_CONF="$T/etc/krb5.conf"; KEYTAB="$T/etc/krb5.keytab"; NSS="$T/etc/nsswitch.conf"; SSS_DB="$T/sss/db"; SSS_MC="$T/sss/mc"',
    `feld() { case "$1" in einmal) printf '%s' ${q(l.einmal ?? EINMAL)} ;; esac; }`,
    'json_text() { local x; x=$(cat); printf \'"%s"\' "${x//\\"/}"; }',
    'log() { printf \'%s\\n\' "$*" >>"$T/log"; }',
    `hostname() { log "hostname $*"; [ "$1" = -f ] && echo ${q(l.hostnameF ?? 'sqllnx01.ad.3033.at')}; }`,
    'host() { log "host $*"; case "$*" in *SRV*) echo "_ldap._tcp.ad.3033.at has SRV record 0 100 389 dc01.ad.3033.at." ;; 10.203.30.10) echo ' + `"10.30.203.10.in-addr.arpa domain name pointer ${l.ptr ?? 'sqllnx01.ad.3033.at'}."` + ' ;; *) return 1 ;; esac; }',
    'ip() { echo "10.203.29.2 via 10.203.30.1 dev eth0 src 10.203.30.10 uid 0"; }',
    `uhr_abweichung() { echo ${q(l.uhr ?? '2|+1.4')}; }`,
    'dpkg-query() { local p="${@: -1}" st="install ok installed"; [ -f "$T/inst/$p" ] || return 1; [ ! -f "$T/held/$p" ] || st="hold ok installed"; if [[ "$*" == *Version* ]]; then printf \'%s|%s\' "$st" "$(cat "$T/inst/$p")"; else printf \'%s\' "$st"; fi; }',
    'apt-get() { log "apt-get $*"; local a; for a in "$@"; do case "$a" in *=*[0-9]*) [[ "$a" == DPkg* || "$a" == Dpkg* ]] || echo "${a#*=}" >"$T/inst/${a%%=*}" ;; esac; done; }',
    'apt-cache() { log "apt-cache $*"; local p="${@: -1}"; [ ! -f "$T/verf/$p" ] || echo " $p | $(cat "$T/verf/$p") | http://archive.ubuntu.com/ubuntu noble/main amd64 Packages"; }',
    'apt-mark() { log "apt-mark $*"; local a; for a in "$@"; do case "$a" in -o|DPkg*|hold) ;; *) touch "$T/held/$a" ;; esac; done; }',
    'chown() { :; }',
    'rechte_ok() { [ -f "$1" ]; }',
    'sleep() { :; }',
    'command() { if [ "$1" = -v ]; then case "$2" in adcli|realm|klist|sssd|host) return 0 ;; esac; fi; builtin command "$@"; }',
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
    'T=$(mktemp -d)', 'mkdir -p "$T/etc/sssd" "$T/inst" "$T/held" "$T/verf" "$T/sss/db" "$T/sss/mc"', ': >"$T/log"',
    `printf 'passwd:         files systemd\\ngroup:          files systemd\\nshadow:         files\\nhosts:          files dns\\n' >"$T/etc/nsswitch.conf"`,
    ...Object.entries(verf).map(([n, v]) => `echo ${q(v)} >"$T/verf/${n}"`),
  ];
  if (l.beigetreten) {
    z.push(...Object.entries(LINUX_AD_PAKETE).map(([n, v]) => `echo ${q(v)} >"$T/inst/${n}"; touch "$T/held/${n}"`));
    z.push(`printf '%s\\n' ${q(KEYTAB_INHALT)} >"$T/etc/krb5.keytab"`, 'touch "$T/aktiv" "$T/an" "$T/sss/db/cache_ad.3033.at.ldb"');
    z.push(`sed -E -i '/^(passwd|group):/ s/$/ sss/' "$T/etc/nsswitch.conf"`);
  }
  if (l.fremdeSssd) z.push(`printf '[sssd]\\ndomains = andere.domaene\\n' >"$T/etc/sssd/sssd.conf"`);
  return z.join('\n');
}

function ausfuehren(skript: string, l: Lauf, vorlauf = '') {
  const text = skript.replace('# ALFRED-ABLAUF', `${stubs(l)}\n# ALFRED-ABLAUF`);
  const huelle = `${vorbereiten(l)}\n${vorlauf}\nALFRED_EINGABE=''\n( ${text}\n)\necho "RC=$?"\necho '---LOG'; cat "$T/log"; echo '---DATEIEN'; (cd "$T" && find etc inst held sss aktiv an -type f 2>/dev/null | sort); echo '---SSSD'; cat "$T/etc/sssd/sssd.conf" 2>/dev/null; echo '---NSS'; cat "$T/etc/nsswitch.conf"; rm -rf "$T"`;
  const r = spawnSync('bash', [], { input: huelle, encoding: 'utf8' });
  const [vorne, rest = ''] = r.stdout.split('---LOG\n');
  const [log, rest2 = ''] = rest.split('---DATEIEN\n');
  const [dateien, rest3 = ''] = rest2.split('---SSSD\n');
  const [sssd, nss = ''] = rest3.split('---NSS\n');
  return {
    rc: Number(/RC=(\d+)/.exec(vorne)?.[1] ?? -1), e: sqlErgebnis<Record<string, unknown>>(vorne), aus: `${vorne}\n${r.stderr}`,
    log: log!, dateien: dateien!.split('\n').filter(Boolean), sssd: sssd!, nss,
  };
}
const beitreten = (l: Lauf = {}) => ausfuehren(adBeitretenSkript(P), l);

describe('linux_sql ad_beitreten — Skripttext und Parameter', { timeout: 60_000 }, () => {
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
    for (const t of [s, adVerlassenSkript()]) {
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
  });
  it.skipIf(!PYTHON)('SNTP-Programm ist gültiges Python', () => {
    const r = spawnSync(PYTHON!, ['-c', 'import sys; compile(sys.stdin.read(), "sntp", "exec")'], { input: PY_SNTP, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });
});

describe.skipIf(!BASH)('linux_sql ad_beitreten — ausgeführt', { timeout: 120_000 }, () => {
  it('hostname -f = sqllnx01 → Abbruch „hosts-Block/DNS fehlt“, nichts installiert, nichts geändert', () => {
    const r = beitreten({ hostnameF: 'sqllnx01' });
    expect(r.rc, r.aus).toBe(1);
    expect(String(r.e?.fehler)).toContain('hosts-Block/DNS fehlt');
    expect(String(r.e?.fehler)).toContain('nichts geändert');
    expect(r.log).not.toMatch(/apt-get|apt-mark|adcli|systemctl/);
    expect(r.dateien.filter(d => d !== 'etc/nsswitch.conf')).toEqual([]);
    expect(r.nss).not.toContain('sss');
  });
  it('PTR falsch, Uhr zu weit weg, Paket nicht verfügbar, fremde sssd.conf → Abbruch ohne Änderung', () => {
    for (const [l, text] of [
      [{ ptr: 'anders.ad.3033.at' }, "PTR von 10.203.30.10 ist 'anders.ad.3033.at'"],
      [{ uhr: '75|-75.2' }, 'Uhrzeit weicht -75.2 s von dc01 ab'],
      [{ fremdeSssd: true }, 'nicht von Alfred'],
    ] as Array<[Lauf, string]>) {
      const r = beitreten(l);
      expect(r.rc, r.aus).toBe(1);
      expect(String(r.e?.fehler)).toContain(text);
      expect(r.log).not.toMatch(/apt-get|adcli|systemctl/);
    }
    const v = beitreten({ verfuegbar: { sssd: '2.9.4-1.1ubuntu6.10' } });
    expect(v.rc, v.aus).toBe(1);
    expect(String(v.e?.fehler)).toContain('sssd=2.9.4-1.1ubuntu6.9 ist in der Paketquelle nicht verfügbar (verfügbar: 2.9.4-1.1ubuntu6.10');
    expect(v.log).not.toMatch(/apt-get .*install|adcli/);
    expect(v.dateien.filter(d => d !== 'etc/nsswitch.conf')).toEqual([]);
  });
  it('Beitritt: Pakete fest + hold, adcli als Computerkonto mit Kennwort über stdin, sssd.conf, NSS, Selbstprüfung — Kennwort nirgends sichtbar', () => {
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
    expect(r.sssd.split('\n')[0]).toBe(AD_SSSD_KOPF);
    expect(r.sssd).toContain('access_provider = simple');
    expect(r.sssd).toContain(`simple_allow_users = ${AD_KEIN_ZUGANG}`);
    expect(r.sssd).toContain('use_fully_qualified_names = True');
    expect(r.sssd).toContain('ad_hostname = sqllnx01.ad.3033.at');
    expect(r.nss).toMatch(/^passwd:\s+files systemd sss$/m);
    expect(r.nss).toMatch(/^group:\s+files systemd sss$/m);
    expect(r.dateien).toEqual(expect.arrayContaining(['etc/krb5.conf', 'etc/krb5.keytab', 'etc/sssd/sssd.conf', 'aktiv', 'an']));
    // hostname wird nur gelesen
    expect(r.log.split('\n').filter(z => z.startsWith('hostname'))).toEqual(['hostname -f']);
  });
  it('schon beigetreten → „schon“ ohne adcli join und ohne Kennwort', () => {
    const r = ausfuehren(adBeitretenSkript(P), { beigetreten: true, einmal: '' }, `printf '%s\\n' ${q(sssdAusLauf())} >"$T/etc/sssd/sssd.conf"; printf '%s\\n' ${q(krb5AusLauf())} >"$T/etc/krb5.conf"`);
    expect(r.rc, r.aus).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'schon', beitritt: 'schon', aenderungen: [] });
    expect(r.log).not.toMatch(/adcli join|apt-get|apt-mark|systemctl restart/);
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

/** sssd.conf/krb5.conf, wie ein erster Lauf sie schreibt (aus dem Skripttext gelesen) */
function ausSkript(variable: string): string {
  const z = adBeitretenSkript(P).split('\n');
  const i = z.findIndex(x => x.startsWith(`${variable}='`));
  const zeilen: string[] = [z[i]!.slice(variable.length + 2)];
  for (let k = i + 1; !zeilen[zeilen.length - 1]!.endsWith("'"); k++) zeilen.push(z[k]!);
  return zeilen.join('\n').slice(0, -1);
}
const sssdAusLauf = () => ausSkript('SSSD_SOLL');
const krb5AusLauf = () => ausSkript('KRB5_SOLL');

describe.skipIf(!BASH)('linux_sql ad_verlassen — ausgeführt', { timeout: 120_000 }, () => {
  it('nur lokal: sssd aus, sssd.conf + Keytab + Zwischenspeicher weg, NSS ohne sss; zweiter Lauf „schon“', () => {
    const vor = `printf '%s\\n' ${q(AD_SSSD_KOPF)} >"$T/etc/sssd/sssd.conf"`;
    const r = ausfuehren(adVerlassenSkript(), { beigetreten: true }, vor);
    expect(r.rc, r.aus).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'geaendert', domaene: 'ad.3033.at', sssd: 'aus' });
    expect(r.dateien.filter(d => d.startsWith('etc/') || d.startsWith('sss/') || d === 'aktiv' || d === 'an')).toEqual(['etc/nsswitch.conf']);
    expect(r.nss).not.toMatch(/\bsss\b/);
    expect(r.nss).toMatch(/^passwd:\s+files systemd$/m);
    expect(r.log).not.toMatch(/adcli|apt-get/);
    const s = ausfuehren(adVerlassenSkript(), {});
    expect(s.rc, s.aus).toBe(0);
    expect(s.e).toMatchObject({ zustand: 'schon', aenderungen: [] });
  });
});

describe('linux_sql ad_beitreten/ad_verlassen — Skill', () => {
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
    expect(w.aufrufe[0]!.eingabe).toBeUndefined();
  });
});

describe('linux_sql ad_beitreten — Change-Regeln', () => {
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
