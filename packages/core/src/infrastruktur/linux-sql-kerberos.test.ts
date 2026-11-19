import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  kerberosSkript, kerberosEntfernenSkript, kerberosParameter, pruefeKerberos, KERBEROS_SPNS, KERBEROS_ENCTYPES, KERBEROS_KONTO_TRESOR,
  SQL_KEYTAB, SQL_KERBEROS_KONTO, LINUX_AD,
} from './linux-sql-ad.js';
import { sqlErgebnis, LINUX_SQL_BAUSTEINE, PY_STATUS } from './linux-sql.js';
import { LinuxSqlSkill, LINUX_SQL_MIN_ZEITLIMIT_S } from './linux-sql-skill.js';
import { linuxBausteinBekannt } from '../fernzugriff/linux-bausteine.js';
import { pruefeChangePlan } from './change-schritte.js';

// I8e Etappe 3 Task 5 — linux_sql kerberos_einrichten / kerberos_entfernen

const BASH = (() => { const r = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }); return r.status === 0 && /^\d+\./.test(r.stdout.trim()); })();
const imChange = { ausChange: true } as never;
const KW = 'Kerberos-Geheim_9Xq!Lm#2Pz%w';
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const P = kerberosParameter('sqllnx01');
const SALZ = 'AD.3033.ATsvc-sqllnx';
const SOLL = [...KERBEROS_SPNS, SQL_KERBEROS_KONTO].map(p => `${p}@AD.3033.AT`);
beforeEach(async () => { await new Promise(r => setTimeout(r, 0)); });

/**
 * Stubs (nach den Hilfen, vor dem Ablauf). Keytab-Datei des Stubs: je Zeile „kvno principal enctype salz ok|falsch“ (ok = Schlüssel aus dem
 * richtigen Kennwort); kinit/kvno prüfen gegen $T/adkvno (bzw. $T/adkvno_k für Tickets aus dem Keytab), ktutil liest Befehle von stdin.
 */
const STUBS = String.raw`TMP_BASIS="$T/run"; SSSD_CONF="$T/etc/sssd.conf"; KRB5_CONF="$T/etc/krb5.conf"; SQL_KT="$T/secrets/mssql.keytab"
MSSQLCONF="$T/mssql-conf"; MSSQL_CONF="$T/mssql.conf"; ZQ_DROPIN="$T/zq.conf"
feld() { case "$1" in kennwort) cat "$T/eingabe" ;; esac; }
json_text() { local x; x=$(cat); printf '"%s"' "§{x//\"/}"; }
log() { printf '%s\n' "$*" >>"$T/log"; }
schl() { local s="$1"; printf '%s' "§{s//\//_}"; }
timedatectl() { case "$1 §{2:-}" in "show -p") echo yes ;; "show-timesync -p") echo 10.203.29.2 ;; "timesync-status ") printf '       Offset: +2.1ms\n' ;; esac; }
realm() { [ -f "$SSSD_CONF" ] && echo ad.3033.at; }
dpkg-query() { [ ! -f "$T/kein_sql" ] || return 1; printf 'install ok installed|17.0.4006.2-1'; }
id() { :; }
lies() { cat "$T/conf/$2" 2>/dev/null || true; }
chown() { log "chown $*"; printf '%s' "§{1/:/ }" >"$T/meta/$(schl "§{@: -1}").own"; }
chmod() { log "chmod $*"; local m="$1"; printf '%s' "§{m#0}" >"$T/meta/$(schl "§{@: -1}").mod"; }
mv() { log "mv §{@: -2:1} -> §{@: -1}"; local s d; s=$(schl "§{@: -2:1}"); d=$(schl "§{@: -1}"); command mv "$@"; local x; for x in own mod; do [ ! -f "$T/meta/$s.$x" ] || command mv -f "$T/meta/$s.$x" "$T/meta/$d.$x"; done; }
stat() {
  if [ "$1 $2" = "-c %a %U %G" ]; then [ -e "$3" ] || return 1; printf '%s %s\n' "$(cat "$T/meta/$(schl "$3").mod" 2>/dev/null || echo 644)" "$(cat "$T/meta/$(schl "$3").own" 2>/dev/null || echo root root)"; return; fi
  command stat "$@"
}
systemctl() {
  case "$1" in
    is-active) [ -f "$T/sql_aktiv" ] ;;
    show) cat "$T/sql_start" ;;
    *) log "systemctl $*" ;;
  esac
}
cc_datei() { printf '%s' "§{KRB5CCNAME#FILE:}"; }
klein() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
akv() { cat "$T/adkvno"; }
# Eintrag „kvno principal aes256 salz ok“ im Keytab $1 für Principal $2 und kvno $3
kt_hat_ok() { local kv p e s st; while read -r kv p e s st; do if [ "$kv" = "$3" ] && [ "$(klein "$p")" = "$(klein "$2")" ] && [ "$e" = aes256-cts-hmac-sha1-96 ] && [ "$s" = ${SALZ} ] && [ "$st" = ok ]; then return 0; fi; done <"$1"; return 1; }
kinit() {
  log "kinit $*"
  if [ "$1" = -k ]; then
    if [ -f "$3" ] && kt_hat_ok "$3" "$4" "$(akv)"; then : >"$(cc_datei)"; return 0; fi
    echo "kinit: Preauthentication failed while getting initial credentials"; return 1
  fi
  local pw; pw=$(cat)
  if [ "$pw" != ${q(KW)} ]; then echo "Password for $1: kinit: Password incorrect while getting initial credentials ($pw)"; return 1; fi
  : >"$(cc_datei)"
  [ -f "$T/kein_salz" ] || printf '[1] 1700000000.1: Selected etype info: etype aes256-cts, salt "%s", params ""\n' ${SALZ} >"$KRB5_TRACE"
  echo "Password for $1: "
}
kvno() {
  log "kvno $*"
  local f=''; if [ "$1" = -k ]; then f="$2"; shift 2; fi
  [ -f "$(cc_datei)" ] || { echo "kvno: No credentials cache found"; return 1; }
  [ ! -f "$T/kein_spn" ] || { echo "kvno: Server not found in Kerberos database while getting credentials for $1"; return 1; }
  if [ -n "$f" ]; then
    local kv; kv=$(akv)
    kt_hat_ok "$f" "$1" "$kv" || { echo "kvno: Decrypt integrity check failed while verifying ticket for $1"; return 1; }
    echo "$1: kvno = $kv, keytab entry valid"; return 0
  fi
  echo "$1: kvno = $(akv)"
}
kdestroy() { log "kdestroy $*"; if [ "$1" = -c ]; then rm -f "§{2#FILE:}"; fi; }
klist() {
  local f="§{@: -1}" e=0 kv p en s st; [ "$2" = -e ] && e=1
  [ -f "$f" ] || { echo "klist: Key table file '$f' not found while starting keytab scan"; return 1; }
  printf 'Keytab name: FILE:%s\nKVNO Principal\n---- --------------------------------------------------------------------------\n' "$f"
  while read -r kv p en s st; do if [ "$e" = 1 ]; then printf '%4s %s (%s)\n' "$kv" "$p" "$en"; else printf '%4s %s\n' "$kv" "$p"; fi; done <"$f"
}
ktutil() {
  local KL=() z a i pw
  while IFS= read -r z; do
    read -r -a a <<<"$z"
    case "§{a[0]:-}" in
      rkt) log "ktutil rkt §{a[1]}"; while IFS= read -r i; do KL+=("$i"); done <"§{a[1]}" ;;
      list) echo 'slot KVNO Principal'; echo '---- ---- -------'; for i in "§{!KL[@]}"; do read -r kv p r <<<"§{KL[$i]}"; printf '%4s %4s %s\n' "$((i + 1))" "$kv" "$p"; done ;;
      delent) log "ktutil delent §{a[1]}"; unset 'KL[a[1]-1]'; KL=("§{KL[@]}") ;;
      addent)
        log "ktutil $z"
        if [ -f "$T/ohne_s" ]; then echo "addent: unknown option -s" >&2; continue; fi
        IFS= read -r pw; local st=falsch; [ "$pw" != ${q(KW)} ] || st=ok
        KL+=("§{a[5]} §{a[3]} §{a[7]} §{a[9]} $st") ;;
      wkt) log "ktutil wkt"; [ "§{#KL[@]}" -eq 0 ] || printf '%s\n' "§{KL[@]}" >>"§{a[1]}"; [ ! -f "$T/kvno_wechsel" ] || command mv -f "$T/kvno_wechsel" "$T/adkvno" ;;
      quit) return 0 ;;
      *) echo "Unknown request \"$z\".  Type \"?\" for a request list." >&2 ;;
    esac
  done
}`.replaceAll('§{', '${').replaceAll('${SALZ}', q(SALZ));

/** Keytab-Zeilen des Stubs */
const kt = (kvno: number, st = 'ok', salz = SALZ) => SOLL.flatMap(p => KERBEROS_ENCTYPES.map(e => `${kvno} ${p} ${e} ${salz} ${st}`)).join('\n');

interface KLauf { rc: number; e?: Record<string, unknown>; aus: string; log: string }
interface Welt { laeufe: KLauf[]; keytab: string; conf: Record<string, string>; rechte: string; dateien: string[]; kennwortInDateien: string }

/** setup: Bash nach dem Grundzustand (beigetreten, Zeitquelle, SQL installiert und aktiv seit Epoche 0, AD-kvno 4) */
function welt(skript: string, setup = '', n = 1, eingabe = KW, stubZusatz = ''): Welt {
  const text = skript.replace('# ALFRED-ABLAUF', `${STUBS}\n${stubZusatz}\n# ALFRED-ABLAUF`);
  const huelle = [
    'T=$(mktemp -d)', 'mkdir -p "$T/etc" "$T/run" "$T/conf" "$T/meta" "$T/secrets"', ': >"$T/log"',
    `printf '%s' ${q(eingabe)} >"$T/eingabe"`,
    `printf '%s\\n' ${q('# Alfred I8e — linux_sql ad_beitreten (nicht von Hand ändern)')} >"$T/etc/sssd.conf"`,
    `printf '%s\\n' ${q('# Alfred I8e — linux_sql ad_beitreten (krb5.conf, nicht von Hand ändern)')} >"$T/etc/krb5.conf"`,
    `printf '%s\\n' ${q('# Alfred I8e — linux_sql zeitquelle_einrichten (nicht von Hand ändern)')} >"$T/zq.conf"`,
    'echo 4 >"$T/adkvno"; touch "$T/sql_aktiv"; echo "@0" >"$T/sql_start"; : >"$T/mssql.conf"',
    `printf '#!/bin/bash\\necho "mssql-conf $*" >>"%s/log"\\ncase "$1" in set) echo "$3" >"%s/conf/\${2#network.}" ;; unset) rm -f "%s/conf/\${2#network.}" ;; esac\\n' "$T" "$T" "$T" >"$T/mssql-conf"; chmod +x "$T/mssql-conf"`,
    setup, "ALFRED_EINGABE=''",
    ...Array.from({ length: n }, (_, i) => `( ${text}\n) >"$T/aus" 2>&1; echo "RC=$?"; echo "---AUS${i}"; cat "$T/aus"; echo "---LOG${i}"; cat "$T/log"; : >"$T/log"; rm -f "$T/aus"`),
    'echo "---KEYTAB"; cat "$T/secrets/mssql.keytab" 2>/dev/null',
    'echo "---CONF"; for f in "$T"/conf/*; do [ -f "$f" ] && echo "$(basename "$f")=$(cat "$f")"; done',
    'echo "---RECHTE"; k="$T/secrets/mssql.keytab"; s="${k//\\//_}"; echo "$(cat "$T/meta/$s.mod" 2>/dev/null) $(cat "$T/meta/$s.own" 2>/dev/null)"',
    'echo "---DATEIEN"; (cd "$T" && find run secrets -mindepth 1 | sort)',
    `echo "---KW"; grep -rlF -- ${q(KW)} "$T" | grep -v '/eingabe$' || true`,
    'echo "---ENDE"', 'rm -rf "$T"',
  ].join('\n');
  const o = spawnSync('bash', [], { input: huelle, encoding: 'utf8' }).stdout;
  const zw = (a: string, b: string) => o.split(`${a}\n`)[1]?.split(`${b}\n`)[0] ?? '';
  const rcs = [...o.matchAll(/^RC=(\d+)$/gm)].map(m => Number(m[1]));
  const conf: Record<string, string> = {};
  for (const z of zw('---CONF', '---RECHTE').split('\n').filter(Boolean)) { const i = z.indexOf('='); conf[z.slice(0, i)] = z.slice(i + 1); }
  return {
    laeufe: Array.from({ length: n }, (_, i) => {
      const aus = zw(`---AUS${i}`, `---LOG${i}`);
      return { rc: rcs[i] ?? -1, e: sqlErgebnis<Record<string, unknown>>(aus), aus, log: zw(`---LOG${i}`, i + 1 < n ? `RC=${rcs[i + 1]}` : '---KEYTAB') };
    }),
    keytab: zw('---KEYTAB', '---CONF'), conf, rechte: zw('---RECHTE', '---DATEIEN').trim(),
    dateien: zw('---DATEIEN', '---KW').split('\n').filter(Boolean), kennwortInDateien: zw('---KW', '---ENDE').trim(),
  };
}
const einrichten = (setup = '', n = 1, eingabe = KW, stubZusatz = '') => welt(kerberosSkript(P), setup, n, eingabe, stubZusatz);
/** vorhandener Keytab (Stub-Format), laut Rechte-Stub mssql:mssql 0400 */
const KT_VORHER = (inhalt: string) => `printf '%s\\n' ${q(inhalt)} >"$T/secrets/mssql.keytab"; k="$T/secrets/mssql.keytab"; s="\${k//\\//_}"; echo 400 >"$T/meta/$s.mod"; echo 'mssql mssql' >"$T/meta/$s.own"`;

describe('linux_sql kerberos_einrichten — Skripttext und Parameter', () => {
  it('registriert, gültiges Bash, feste Werte, kein Kennwort im Text, Mindest-Zeitlimit', () => {
    expect(linuxBausteinBekannt(LINUX_SQL_BAUSTEINE.kerberosEinrichten)).toBe(true);
    expect(linuxBausteinBekannt(LINUX_SQL_BAUSTEINE.kerberosEntfernen)).toBe(true);
    expect(KERBEROS_SPNS).toEqual([
      'MSSQLSvc/sqllnx01.ad.3033.at:1433', 'MSSQLSvc/sqllnx01.ad.3033.at', 'MSSQLSvc/sqllnx02.ad.3033.at:1433', 'MSSQLSvc/sqllnx02.ad.3033.at',
      'MSSQLSvc/sqllnxag01.ad.3033.at:1433', 'MSSQLSvc/sqllnxag01.ad.3033.at',
    ]);
    expect(KERBEROS_ENCTYPES).toEqual(['aes256-cts-hmac-sha1-96', 'aes128-cts-hmac-sha1-96']);
    expect(SQL_KEYTAB).toBe('/var/opt/mssql/secrets/mssql.keytab');
    expect(KERBEROS_KONTO_TRESOR).toBe('ad-svc-sqllnx');
    const s = kerberosSkript(P);
    expect(s).toContain("SPN_PRUEF='MSSQLSvc/sqllnx01.ad.3033.at:1433'");
    expect(s).toContain("printf '%s\\n' \"$KW\" | KRB5CCNAME=\"$CC\" KRB5_TRACE=");
    expect(s).toContain('kt_befehle | ktutil');
    expect(s).not.toMatch(/systemctl (restart|start|stop)/);
    expect(LINUX_SQL_MIN_ZEITLIMIT_S.kerberos_einrichten).toBe(240);
    expect(LINUX_SQL_MIN_ZEITLIMIT_S.kerberos_entfernen).toBe(150);
    for (const t of [s, kerberosEntfernenSkript()]) {
      if (!BASH) continue;
      const r = spawnSync('bash', ['-n'], { input: t, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    }
  });
  it('Parameter streng: sqllnxcfg nie, nur sqllnx01/02, SPNs/Konto/Realm fest', () => {
    expect(pruefeKerberos(P)).toBeUndefined();
    expect(pruefeKerberos(kerberosParameter('sqllnx02'))).toBeUndefined();
    expect(pruefeKerberos(kerberosParameter('sqllnxcfg'))).toBe('sqllnxcfg bekommt keinen Keytab (Spec 10)');
    expect(pruefeKerberos(kerberosParameter('sqllnxag01'))).toContain('nur sqllnx01 oder sqllnx02');
    expect(pruefeKerberos({ ...P, konto: 'administrator' })).toContain('konto');
    expect(pruefeKerberos({ ...P, realm: 'X.AT' })).toContain('realm');
    expect(pruefeKerberos({ ...P, spns: ['HTTP/x.ad.3033.at'] })).toContain('spns');
    expect(() => kerberosSkript(kerberosParameter('sqllnxcfg'))).toThrow('Spec 10');
  });
});

describe.skipIf(!BASH)('linux_sql kerberos_einrichten — ausgeführt', { timeout: 240_000 }, () => {
  it('neu: kvno aus dem AD, 6 SPNs + Konto × AES256/AES128 mit AD-Salz, 0400 mssql, mssql-conf; Kennwort nirgends; Wiederholung „schon“', () => {
    const w = einrichten('', 2);
    const [a, b] = w.laeufe as [KLauf, KLauf];
    expect(a.rc, a.aus).toBe(0);
    expect(a.e).toMatchObject({ zustand: 'geaendert', kvno: 4, spns: 6, principals: 7, keytabNeu: true, aeltereKvno: [], salz: 'kdc', neustartNoetig: true, fqdn: 'sqllnx01.ad.3033.at' });
    expect(String(a.e?.keytab)).toMatch(/\/secrets\/mssql\.keytab$/);
    expect(a.e?.aenderungen).toEqual(['keytab', 'mssql-conf:kerberoskeytabfile', 'mssql-conf:privilegedadaccount']);
    expect(w.keytab.trim().split('\n').sort()).toEqual(kt(4).split('\n').sort());
    expect(w.rechte).toBe('400 mssql mssql');
    expect(a.log).toMatch(/chown mssql:mssql .*\/secrets\/\.alfred-kt-[^/]+\/mssql\.keytab/);
    expect(a.log).toMatch(/chmod 0400 .*\/secrets\/\.alfred-kt-[^/]+\/mssql\.keytab/);
    // Rechte vor dem Verschieben, Selbstprüfung (kinit -k, kvno -k) vor dem Verschieben, mssql-conf erst danach
    const i = (t: string) => a.log.indexOf(t);
    expect(i('chmod 0400')).toBeLessThan(i('mv '));
    expect(i('kinit -k -t')).toBeLessThan(i('mv '));
    expect(i('kvno -k')).toBeLessThan(i('mv '));
    expect(i('mv ')).toBeLessThan(i('mssql-conf set'));
    expect(a.log).toContain('kvno MSSQLSvc/sqllnx01.ad.3033.at:1433@AD.3033.AT');
    expect(a.log).toContain('kinit -k -t');
    expect(a.log).toMatch(/kdestroy -c FILE:.*cc-k/);
    for (const p of SOLL) for (const e of KERBEROS_ENCTYPES) expect(a.log).toContain(`ktutil addent -password -p ${p} -k 4 -e ${e} -s ${SALZ}`);
    expect(a.log).toContain('mssql-conf set network.kerberoskeytabfile');
    expect(a.log).toContain('mssql-conf set network.privilegedadaccount svc-sqllnx');
    expect(w.conf.privilegedadaccount).toBe('svc-sqllnx');
    expect(w.conf.kerberoskeytabfile).toMatch(/\/secrets\/mssql\.keytab$/);
    expect(a.log).not.toMatch(/systemctl (restart|start|stop)/);
    // Kennwort: nie in Argumenten (Stub-Protokoll), Ausgabe, Ergebnis oder liegengebliebenen Dateien
    for (const x of [a.log, a.aus, b.log, b.aus, JSON.stringify(a.e)]) expect(x).not.toContain(KW);
    expect(w.kennwortInDateien).toBe('');
    expect(w.dateien).toEqual(['secrets/mssql.keytab']);
    // Wiederholung: nichts zu tun, kein ktutil, kein mssql-conf set; Neustart bleibt nötig (Dienst läuft seit vor dem Keytab)
    expect(b.rc, b.aus).toBe(0);
    expect(b.e).toMatchObject({ zustand: 'schon', kvno: 4, spns: 6, keytabNeu: false, neustartNoetig: true, aenderungen: [] });
    expect(b.log).not.toMatch(/ktutil|mssql-conf|chown|chmod 0400/);
  });
  it('schon eingerichtet und SQL Server nach dem Keytab gestartet → „schon“, kein Neustart nötig', () => {
    const w = einrichten(`${KT_VORHER(kt(4))}; echo "$T/secrets/mssql.keytab" >"$T/conf/kerberoskeytabfile"; echo svc-sqllnx >"$T/conf/privilegedadaccount"; echo @9999999999 >"$T/sql_start"`);
    const r = w.laeufe[0]!;
    expect(r.rc, r.aus).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'schon', neustartNoetig: false, aenderungen: [] });
  });
  it('kvno-Abweichung (Kennwort während des Laufs gewechselt, AD jetzt kvno 5) → Abbruch mit beiden Zahlen, mssql-conf nicht aufgerufen, Keytab nicht ersetzt', () => {
    const w = einrichten('echo 5 >"$T/kvno_wechsel"');
    const r = w.laeufe[0]!;
    expect(r.rc, r.aus).toBe(1);
    expect(String(r.e?.fehler)).toContain('Keytab-kvno 4, AD-kvno 5');
    expect(String(r.e?.fehler)).toContain('mssql-conf unverändert');
    expect(r.log).not.toContain('mssql-conf');
    expect(r.log).not.toMatch(/^mv /m);
    expect(w.keytab).toBe('');
    expect(w.conf).toEqual({});
    expect(w.dateien).toEqual([]);
    expect(w.kennwortInDateien).toBe('');
  });
  it('Keytab-Ticket gültig, das AD nennt aber eine andere kvno → Abbruch „Keytab-kvno X, AD-kvno Y“', () => {
    // Stub: kvno -k gelingt, nennt aber 6
    const w = einrichten('', 1, KW, String.raw`kvno() { log "kvno $*"; if [ "$1" = -k ]; then echo "$3: kvno = 6, keytab entry valid"; else echo "$1: kvno = 4"; fi; }`);
    const r = w.laeufe[0]!;
    expect(r.rc, r.aus).toBe(1);
    expect(String(r.e?.fehler)).toContain('Keytab-kvno 4, AD-kvno 6');
    expect(r.log).not.toContain('mssql-conf');
    expect(w.keytab).toBe('');
  });
  it('höhere kvno im vorhandenen Keytab als im AD → Abbruch ohne Änderung (beide Zahlen genannt)', () => {
    const w = einrichten(KT_VORHER(kt(7)));
    const r = w.laeufe[0]!;
    expect(r.rc, r.aus).toBe(1);
    expect(String(r.e?.fehler)).toContain('Keytab-kvno 7, AD-kvno 4');
    expect(String(r.e?.fehler)).toContain('nichts geändert');
    expect(r.log).not.toMatch(/ktutil|mssql-conf|chown|chmod 0400|^mv /m);
    expect(w.keytab.trim()).toBe(kt(7));
  });
  it('Erneuerung: Keytab mit kvno 3, AD-kvno 4 → kvno-4-Einträge dazu, kvno 3 bleibt (Spec 7.7)', () => {
    const w = einrichten(KT_VORHER(kt(3)));
    const r = w.laeufe[0]!;
    expect(r.rc, r.aus).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'geaendert', kvno: 4, aeltereKvno: [3], keytabNeu: true });
    expect(w.keytab.trim().split('\n').sort()).toEqual([...kt(3).split('\n'), ...kt(4).split('\n')].sort());
    expect(r.log).toMatch(/ktutil rkt .*mssql\.keytab/);
    expect(r.log).not.toContain('ktutil delent');
  });
  it('Einträge der AD-kvno mit falschem Schlüssel → ersetzt (delent), ältere bleiben', () => {
    const w = einrichten(KT_VORHER(`${kt(3)}\n${kt(4, 'falsch')}`));
    const r = w.laeufe[0]!;
    expect(r.rc, r.aus).toBe(0);
    expect(r.log).toContain('ktutil delent 28');
    expect(r.log).toContain('ktutil delent 15');
    expect(w.keytab.trim().split('\n').sort()).toEqual([...kt(3).split('\n'), ...kt(4).split('\n')].sort());
  });
  it('fremder Principal im Keytab → Abbruch ohne Änderung', () => {
    const w = einrichten(KT_VORHER(`${kt(3)}\n3 HTTP/web01.ad.3033.at@AD.3033.AT aes256-cts-hmac-sha1-96 X ok`));
    const r = w.laeufe[0]!;
    expect(r.rc).toBe(1);
    expect(String(r.e?.fehler)).toContain('enthält fremde Principals (http/web01.ad.3033.at@ad.3033.at');
    expect(r.log).not.toMatch(/ktutil|mssql-conf/);
  });
  it('falsches Kennwort → Abbruch vor jeder Änderung, Fehlertext geschwärzt', () => {
    const w = einrichten('', 1, 'Falsch-Kennwort_123');
    const r = w.laeufe[0]!;
    expect(r.rc).toBe(1);
    expect(String(r.e?.fehler)).toContain('kinit svc-sqllnx@AD.3033.AT mit dem Kennwort aus dem Tresor scheitert');
    expect(String(r.e?.fehler)).toContain('[geschwärzt]');
    expect(r.aus).not.toContain('Falsch-Kennwort_123');
    expect(r.log).not.toMatch(/ktutil|mssql-conf|kvno/);
  });
  it('ktutil ohne -s: Kennwortzeile würde als Befehl gelesen → Abbruch, Fehlertext geschwärzt, nichts ersetzt', () => {
    const w = einrichten('touch "$T/ohne_s"');
    const r = w.laeufe[0]!;
    expect(r.rc).toBe(1);
    expect(String(r.e?.fehler)).toContain('ktutil hat keinen Keytab geschrieben');
    expect(String(r.e?.fehler)).toContain('[geschwärzt]');
    expect(r.aus).not.toContain(KW);
    expect(w.kennwortInDateien).toBe('');
    expect(w.keytab).toBe('');
    expect(r.log).not.toContain('mssql-conf');
  });
  it('kein Salz im Trace → AD-Regel REALM + Konto', () => {
    const r = einrichten('touch "$T/kein_salz"').laeufe[0]!;
    expect(r.rc, r.aus).toBe(0);
    expect(r.e?.salz).toBe('regel');
  });
  it('SPN fehlt am Konto → Abbruch mit Hinweis auf spn_setzen', () => {
    const r = einrichten('touch "$T/kein_spn"').laeufe[0]!;
    expect(r.rc).toBe(1);
    expect(String(r.e?.fehler)).toContain('windows_ad spn_setzen');
    expect(r.log).not.toMatch(/ktutil|mssql-conf/);
  });
  it('Vorbedingungen: nicht beigetreten, keine Zeitquelle, SQL nicht installiert → Abbruch ohne kinit', () => {
    for (const [setup, text] of [
      ['rm -f "$T/etc/sssd.conf"', 'nicht in ad.3033.at beigetreten — zuerst linux_sql ad_beitreten; nichts geändert'],
      [`printf 'anders\\n' >"$T/etc/krb5.conf"`, 'krb5.conf fehlt oder ist nicht von Alfred'],
      ['rm -f "$T/zq.conf"', 'Zeitquelle zuerst einrichten'],
      ['touch "$T/kein_sql"', 'mssql-server ist nicht installiert'],
    ] as Array<[string, string]>) {
      const r = einrichten(setup).laeufe[0]!;
      expect(r.rc, setup).toBe(1);
      expect(String(r.e?.fehler), setup).toContain(text);
      expect(r.log, setup).not.toMatch(/kinit|ktutil|mssql-conf/);
    }
  });
});

describe.skipIf(!BASH)('linux_sql kerberos_entfernen — ausgeführt', { timeout: 120_000 }, () => {
  it('Alfreds Werte und Keytab weg, Neustart nötig; zweiter Lauf „schon“', () => {
    const w = welt(kerberosEntfernenSkript(), `${KT_VORHER(`${kt(3)}\n${kt(4)}`)}; echo "$T/secrets/mssql.keytab" >"$T/conf/kerberoskeytabfile"; echo svc-sqllnx >"$T/conf/privilegedadaccount"`, 2);
    const [a, b] = w.laeufe as [KLauf, KLauf];
    expect(a.rc, a.aus).toBe(0);
    expect(a.e).toMatchObject({ zustand: 'geaendert', belassen: [], neustartNoetig: true, aenderungen: ['mssql-conf:kerberoskeytabfile', 'mssql-conf:privilegedadaccount', 'keytab'] });
    expect(a.log).toContain('mssql-conf unset network.kerberoskeytabfile');
    expect(w.keytab).toBe('');
    expect(w.conf).toEqual({});
    expect(b.rc, b.aus).toBe(0);
    expect(b.e).toMatchObject({ zustand: 'schon', neustartNoetig: false, aenderungen: [] });
  });
  it('fremde Werte und fremder Keytab bleiben (belassen)', () => {
    const w = welt(kerberosEntfernenSkript(), `${KT_VORHER('3 HTTP/web01.ad.3033.at@AD.3033.AT aes256-cts-hmac-sha1-96 X ok')}; echo /etc/anders.keytab >"$T/conf/kerberoskeytabfile"; echo anderes-konto >"$T/conf/privilegedadaccount"`);
    const r = w.laeufe[0]!;
    expect(r.rc, r.aus).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'schon', neustartNoetig: false, aenderungen: [] });
    const bel = (r.e?.belassen as string[]).join(' | ');
    expect(bel).toContain('network.kerberoskeytabfile = /etc/anders.keytab (nicht Alfreds Wert)');
    expect(bel).toContain('network.privilegedadaccount = anderes-konto');
    expect(bel).toContain('enthält fremde Principals oder ist nicht lesbar: http/web01.ad.3033.at@ad.3033.at');
    expect(w.keytab).toContain('HTTP/web01');
    expect(r.log).not.toContain('mssql-conf unset');
  });
});

describe('linux_sql kerberos_einrichten — Skill und Change-Regeln', () => {
  function skill(antwort: Record<string, unknown>, tresor = ['ad-svc-sqllnx']) {
    const aufrufe: Array<{ baustein: string; parameter: unknown; eingabe?: string }> = [];
    const gelesen: string[] = [];
    const s = new LinuxSqlSkill({
      skript: async (_z, baustein, parameter, eingabe) => {
        aufrufe.push({ baustein, parameter, ...(eingabe ? { eingabe } : {}) });
        return { code: antwort.zustand === 'fehler' ? 1 : 0, stdout: `ALFRED-SQL ${JSON.stringify(antwort)}\n`, stderr: '' };
      },
      tresor: { namen: async () => new Set(tresor), lies: async (n: string) => { gelesen.push(n); return KW; }, setze: async () => undefined },
    });
    return { s, aufrufe, gelesen };
  }
  const ok = { zustand: 'geaendert', kvno: 4, spns: 6, principals: 7, keytab: SQL_KEYTAB, keytabNeu: true, aeltereKvno: [3], salz: 'kdc', neustartNoetig: true, aenderungen: ['keytab', 'mssql-conf:kerberoskeytabfile'] };

  it('nur im Change; Kennwort nur über stdin aus ad-svc-sqllnx; KERBEROS_KEYTAB_OK mit Neustart-Hinweis', async () => {
    const w = skill(ok);
    expect((await w.s.execute({ action: 'kerberos_einrichten', zugang: 'sqllnx01' }, {} as never)).error).toContain('nur als Schritt');
    const r = await w.s.execute({ action: 'kerberos_einrichten', zugang: 'sqllnx01' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toContain('KERBEROS_KEYTAB_OK sqllnx01: /var/opt/mssql/secrets/mssql.keytab kvno 4 (= AD), 6 SPNs + svc-sqllnx je AES256/AES128, ältere kvno 3 behalten');
    expect(r.display).toContain('Neustart von SQL Server nötig (rollierend per Change)');
    expect(w.gelesen).toEqual(['ad-svc-sqllnx']);
    expect(w.aufrufe[0]!.baustein).toBe(LINUX_SQL_BAUSTEINE.kerberosEinrichten);
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ kennwort: KW });
    expect(w.aufrufe[0]!.parameter).toEqual({ konto: 'svc-sqllnx', realm: LINUX_AD.realm, spns: [...KERBEROS_SPNS], computername: 'sqllnx01' });
    expect(JSON.stringify(w.aufrufe[0]!.parameter)).not.toContain(KW);
    expect(JSON.stringify(r)).not.toContain(KW);
    const schon = await skill({ ...ok, zustand: 'schon', aeltereKvno: [], neustartNoetig: false, aenderungen: [] }).s.execute({ action: 'kerberos_einrichten', zugang: 'sqllnx02' }, imChange);
    expect(schon.display).toContain('kein Neustart nötig — nichts zu tun');
  });
  it('sqllnxcfg abgewiesen (zugang oder computername), ohne Tresor und Aufruf', async () => {
    const w = skill(ok);
    for (const input of [{ zugang: 'sqllnxcfg' }, { zugang: 'sqllnx01', computername: 'sqllnxcfg' }, { zugang: 'SQLLNXCFG' }]) {
      const r = await w.s.execute({ action: 'kerberos_einrichten', ...input }, imChange);
      expect(r.success).toBe(false);
      expect(r.error).toBe('sqllnxcfg bekommt keinen Keytab (Spec 10)');
      expect(w.s.pruefeEingabe({ action: 'kerberos_einrichten', ...input })).toBe('sqllnxcfg bekommt keinen Keytab (Spec 10)');
    }
    expect(w.aufrufe).toEqual([]);
    expect(w.gelesen).toEqual([]);
    expect(w.s.pruefeEingabe({ action: 'kerberos_einrichten', zugang: 'sqllnx02' })).toBeUndefined();
    expect(w.s.pruefeEingabe({ action: 'kerberos_einrichten', zugang: 'sql01' })).toContain('nur sqllnx01 oder sqllnx02');
  });
  it('Fehler des Bausteins ohne Kennwort; Tresor-Eintrag fehlt → Fehler; Nachprüfung (SPN-Zahl) im Skill', async () => {
    const f = await skill({ zustand: 'fehler', fehler: `ktutil hat keinen Keytab geschrieben: Unknown request "${KW}"` }).s.execute({ action: 'kerberos_einrichten', zugang: 'sqllnx01' }, imChange);
    expect(f.success).toBe(false);
    expect(f.error).toContain('ktutil hat keinen Keytab geschrieben');
    expect(f.error).not.toContain(KW);
    const kv = await skill({ zustand: 'fehler', fehler: 'Keytab-kvno 4, AD-kvno 5 — Kennwort von svc-sqllnx während des Laufs geändert?' }).s.execute({ action: 'kerberos_einrichten', zugang: 'sqllnx01' }, imChange);
    expect(kv.error).toContain('Keytab-kvno 4, AD-kvno 5');
    const leer = skill(ok, []);
    const t = await leer.s.execute({ action: 'kerberos_einrichten', zugang: 'sqllnx01' }, imChange);
    expect(t.error).toContain('Tresor-Eintrag ad-svc-sqllnx fehlt');
    expect(leer.aufrufe).toEqual([]);
    const n = await skill({ ...ok, spns: 5 }).s.execute({ action: 'kerberos_einrichten', zugang: 'sqllnx01' }, imChange);
    expect(n.success).toBe(false);
    expect(n.error).toContain('Nachprüfung fehlgeschlagen');
  });
  it('kerberos_entfernen: ohne Eingabe, KERBEROS_REMOVED mit belassen', async () => {
    const w = skill({ zustand: 'geaendert', belassen: ['network.privilegedadaccount = x (nicht Alfreds Wert)'], neustartNoetig: true, aenderungen: ['keytab'] });
    const r = await w.s.execute({ action: 'kerberos_entfernen', zugang: 'sqllnx01' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toContain('KERBEROS_REMOVED sqllnx01: keytab; belassen (nicht von Alfred): network.privilegedadaccount = x');
    expect(r.display).toContain('Neustart von SQL Server nötig');
    expect(w.aufrufe[0]!.eingabe).toBeUndefined();
    expect(w.gelesen).toEqual([]);
  });
  it('Change: Rückweg genau kerberos_entfernen auf demselben Zugang; selbstgeprüft', () => {
    const sk = new LinuxSqlSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
    const ctx = { skill: (n: string) => (n === 'linux_sql' ? sk : undefined) as never, asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
    const plan = (rueckweg: unknown) => ({ titel: 'Keytab sqllnx02', begruendung: 'I8e Etappe 3 L3', typ: 'normal', risiko: 'mittel', ausfallMinuten: 0, betroffen: ['sqllnx02'],
      ohneSicherungGrund: 'eigener Rückweg (kerberos_entfernen)',
      schritte: [{ titel: 'Keytab', art: 'aktion', skill: 'linux_sql', aktion: 'kerberos_einrichten', parameter: { zugang: 'sqllnx02' }, zeitlimitS: 300, rueckweg }] });
    const f = (rw: unknown) => pruefeChangePlan(plan(rw) as never, ctx as never).fehler;
    expect(f({ keiner: 'geht nicht' }).some(x => x.includes('rueckweg linux_sql.kerberos_entfernen (zugang)'))).toBe(true);
    expect(f({ skill: 'linux_sql', aktion: 'kerberos_entfernen', parameter: { zugang: 'sqllnx01' } }).some(x => x.includes('kerberos_entfernen muss auf demselben Zugang laufen'))).toBe(true);
    expect(f({ skill: 'linux_sql', aktion: 'kerberos_entfernen', parameter: { zugang: 'sqllnx02' } })).toEqual([]);
  });
});

describe('linux_sql status — AD-Daten (Task 5, Text in Task 6)', () => {
  it('PY_STATUS liest beigetreten und Keytab (kvno, SPNs, aktuell) ohne Kennwort', () => {
    expect(PY_STATUS).toContain('r["ad"] = ad');
    expect(PY_STATUS).toContain(`KT = "${SQL_KEYTAB}"`);
    expect(PY_STATUS).toContain('"aktuell": (akv == hoch) if akv is not None else None');
    // der AD-Teil liest kein Kennwort (nur Keytabs)
    const adTeil = PY_STATUS.slice(PY_STATUS.indexOf('def kopf('), PY_STATUS.indexOf('r["ad"] = ad'));
    expect(adTeil).not.toMatch(/kennwort|password|"sa"/i);
    expect(adTeil).toContain('"kinit"] + list(v)');
  });
});
