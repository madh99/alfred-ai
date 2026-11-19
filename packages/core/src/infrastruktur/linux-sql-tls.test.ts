import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate, createHash } from 'node:crypto';
import {
  tlsAnfordernSkript, tlsEinspielenSkript, tlsEntfernenSkript, tlsParameter, pruefeTls, tlsEingabe, TLS_ANFORDERN_GRUND, PY_TLS_EINGABE,
  TLS_CRT, TLS_KEY, TLS_KEY_NEU, TLS_CA_ROOT, TLS_CA_ISSUING, TLS_MANIFEST,
} from './linux-sql-tls.js';
import { sqlErgebnis, LINUX_SQL_BAUSTEINE, PY_STATUS } from './linux-sql.js';
import { LinuxSqlSkill, LINUX_SQL_MIN_ZEITLIMIT_S, linuxSqlStatusText, adText, tlsText, type LinuxSqlStatus } from './linux-sql-skill.js';
import { linuxBausteinBekannt } from '../fernzugriff/linux-bausteine.js';
import { pruefeChangePlan, FESTE_AUSGABEN } from './change-schritte.js';
import { loeseAuf, kuerzeDaten, MAX_DATEN } from './change-lauf.js';
import { linuxTlsSans, pruefeFremdAusstellung, csrSha256, derFelder, derOderPem } from './windows-sqltls-linux.js';

// I8e Etappe 3 Task 6 — linux_sql tls_anfordern / tls_einspielen / tls_entfernen

const BASH = (() => { const r = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }); return r.status === 0 && /^\d+\./.test(r.stdout.trim()); })();
const OPENSSL = BASH && spawnSync('bash', ['-c', 'openssl version'], { encoding: 'utf8' }).status === 0;
const PYTHON = ['python3', 'python'].find(p => spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3');
const ECHT = !!(BASH && OPENSSL && PYTHON);
/** absolute Pfade: der Baustein-Kopf setzt PATH auf die Linux-Standardordner (Git Bash: openssl in /mingw64/bin, python unter C:) */
const pfad = (n: string) => spawnSync('bash', ['-c', `command -v ${n}`], { encoding: 'utf8' }).stdout.trim();
const OPENSSL_PFAD = OPENSSL ? pfad('openssl') : 'openssl';
const PYTHON_PFAD = BASH && PYTHON ? pfad(PYTHON) : 'python3';
const imChange = { ausChange: true } as never;
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const ohneCr = (s: string) => s.replace(/\r/g, '');

/**
 * Stubs (nach den Hilfen, vor dem Ablauf): Pfade in den Testordner, Besitzer/Rechte als Metadaten (chown/chmod/stat), mssql-conf als
 * Skript, update-ca-certificates hängt die CA-Dateien an das Bündel. openssl und python3 sind echt (CR der Windows-Programme entfernt).
 */
const STUBS = String.raw`TMP_BASIS="$T/run"; SECRETS="$T/secrets"; CRT="$SECRETS/tls.crt"; KEY="$SECRETS/tls.key"; KEY_NEU="$SECRETS/tls.key.neu"
CA_DIR="$T/ca"; CA_ROOT="$CA_DIR/ad3033-root.crt"; CA_ISS="$CA_DIR/ad3033-issuing.crt"; CA_BUNDLE="$T/bundle.crt"
MANIFEST="$T/etc/alfred/sqllnx-tls.manifest"; MSSQLCONF="$T/mssql-conf"; MSSQL_CONF="$T/mssql.conf"
log() { printf '%s\n' "$*" >>"$T/log"; }
schl() { local s="$1"; s=§{s//\//_}; printf '%s' "§{s//:/_}"; }
python3() { PYTHONIOENCODING=utf-8 PYEXE "$@" | tr -d '\r'; }
openssl() { log "openssl $1"; OSEXE "$@" | tr -d '\r'; }
id() { :; }
dpkg-query() { [ ! -f "$T/kein_sql" ] || return 1; printf 'install ok installed|17.0.4006.2-1'; }
lies() { cat "$T/conf/$2" 2>/dev/null || true; }
chown() { log "chown $*"; printf '%s' "§{1/:/ }" >"$T/meta/$(schl "§{@: -1}").own"; }
chmod() { log "chmod $*"; local m="$1"; printf '%s' "§{m#0}" >"$T/meta/$(schl "§{@: -1}").mod"; }
mv() { if [ -f "$T/mv_crt_scheitert" ] && [ "§{@: -1}" = "$CRT" ]; then log "mv scheitert"; return 1; fi; log "mv §{@: -2:1} -> §{@: -1}"; local s d x; s=$(schl "§{@: -2:1}"); d=$(schl "§{@: -1}"); command mv "$@"; for x in own mod; do [ ! -f "$T/meta/$s.$x" ] || command mv -f "$T/meta/$s.$x" "$T/meta/$d.$x"; done; }
stat() {
  if [ "$1 $2" = "-c %a %U %G" ]; then [ -e "$3" ] || return 1; printf '%s %s\n' "$(cat "$T/meta/$(schl "$3").mod" 2>/dev/null || echo 644)" "$(cat "$T/meta/$(schl "$3").own" 2>/dev/null || echo root root)"; return; fi
  command stat "$@"
}
systemctl() { case "$1" in is-active) [ -f "$T/sql_aktiv" ] ;; show) cat "$T/sql_start" ;; *) log "systemctl $*" ;; esac; }
update-ca-certificates() { log "update-ca-certificates $*"; cat "$CA_DIR"/*.crt >"$CA_BUNDLE" 2>/dev/null || : >"$CA_BUNDLE"; }`.replaceAll('§{', '${').replace('PYEXE', q(PYTHON_PFAD)).replace('OSEXE', q(OPENSSL_PFAD));

interface Lauf { rc: number; e?: Record<string, unknown>; aus: string; log: string }
interface Welt { T: string; lauf: (skript: string, eingabe?: string) => Lauf; datei: (rel: string) => string | undefined; conf: () => Record<string, string>; rechte: (rel: string) => string; dateien: () => string }

const ORDNER: string[] = [];
function welt(): Welt {
  const T = mkdtempSync(join(tmpdir(), 'alfred-tls-')).replace(/\\/g, '/');
  ORDNER.push(T);
  for (const d of ['run', 'conf', 'meta', 'etc']) mkdirSync(join(T, d), { recursive: true });
  writeFileSync(join(T, 'mssql-conf'), `#!/bin/bash\necho "mssql-conf $*" >>"${T}/log"\ncase "$1" in set) echo "$3" >"${T}/conf/\${2#network.}" ;; unset) rm -f "${T}/conf/\${2#network.}" ;; esac\n`);
  writeFileSync(join(T, 'sql_aktiv'), ''); writeFileSync(join(T, 'sql_start'), '@0\n'); writeFileSync(join(T, 'mssql.conf'), '');
  const lauf = (skript: string, eingabe?: string): Lauf => {
    writeFileSync(join(T, 'log'), '');
    writeFileSync(join(T, 'eingabe'), eingabe ?? '');
    const text = skript.replace('# ALFRED-ABLAUF', `${STUBS}\n# ALFRED-ABLAUF`);
    const huelle = [`T=${q(T)}`, 'chmod +x "$T/mssql-conf"', 'ALFRED_EINGABE=$(cat "$T/eingabe")', `( ${text}\n) >"$T/aus" 2>&1; echo "RC=$?"`].join('\n');
    const o = spawnSync('bash', [], { input: huelle, encoding: 'utf8' });
    const aus = ohneCr(readFileSync(join(T, 'aus'), 'utf8'));
    return { rc: Number(/RC=(\d+)/.exec(o.stdout)?.[1] ?? -1), e: sqlErgebnis(aus), aus, log: ohneCr(readFileSync(join(T, 'log'), 'utf8')) };
  };
  const datei = (rel: string) => (existsSync(join(T, rel)) ? ohneCr(readFileSync(join(T, rel), 'utf8')) : undefined);
  const conf = () => Object.fromEntries(['tlscert', 'tlskey', 'tlsprotocols', 'forceencryption'].filter(k => existsSync(join(T, 'conf', k))).map(k => [k, readFileSync(join(T, 'conf', k), 'utf8').trim()]));
  const rechte = (rel: string) => { const s = `${T}/${rel}`.replace(/\//g, '_').replace(/:/g, '_'); return `${datei(`meta/${s}.mod`) ?? '-'} ${datei(`meta/${s}.own`) ?? '-'}`; };
  const dateien = () => spawnSync('bash', ['-c', `cd ${q(T)} && find secrets ca etc run -mindepth 1 2>/dev/null | sort`], { encoding: 'utf8' }).stdout;
  return { T, lauf, datei, conf, rechte, dateien };
}

/** Test-CA (Root, Issuing, fremde Root) im eigenen Ordner; Zertifikate aus Anforderungen signieren */
let CA = '';
const CA_CNF = `[req]
distinguished_name = dn
prompt = no
[dn]
CN = Alfred Test Root
[root]
basicConstraints = critical,CA:true
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[iss]
basicConstraints = critical,CA:true,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
[leaf]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:sqllnx01,DNS:sqllnx01.ad.3033.at,DNS:sqllnxag01,DNS:sqllnxag01.ad.3033.at
[leaf_ohne_listener]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:sqllnx01,DNS:sqllnx01.ad.3033.at
[leaf_client]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = clientAuth
subjectAltName = DNS:sqllnx01,DNS:sqllnx01.ad.3033.at,DNS:sqllnxag01,DNS:sqllnxag01.ad.3033.at
`;
function caBash(befehle: string): string {
  const r = spawnSync('bash', [], { input: `export MSYS_NO_PATHCONV=1\ncd ${q(CA)}\nset -e\n${befehle}`, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`CA: ${r.stderr}`);
  return r.stdout;
}
const pemDatei = (n: string) => ohneCr(readFileSync(join(CA, n), 'utf8'));
let serie = 10;
function signiere(csrPem: string, abschnitt = 'leaf', tage = 365, aussteller = 'iss'): string {
  writeFileSync(join(CA, 'in.csr'), csrPem);
  caBash(`openssl x509 -req -in in.csr -CA ${aussteller}.crt -CAkey ${aussteller}.key -set_serial ${serie++} -days ${tage} -extfile ca.cnf -extensions ${abschnitt} -out out.crt 2>/dev/null`);
  return pemDatei('out.crt');
}
const KETTE = () => pemDatei('iss.crt') + pemDatei('root.crt');
/** Ruling R17: SHA-256 der Root-DER (fest vorgegeben) */
const rootSha = (n: string) => createHash('sha256').update(Buffer.from(new X509Certificate(pemDatei(n)).raw)).digest('hex');
const PE = (rootSha256 = rootSha('root.crt')) => ({ ...P1, rootSha256 });

beforeAll(() => {
  if (!ECHT) return;
  CA = mkdtempSync(join(tmpdir(), 'alfred-tls-ca-')).replace(/\\/g, '/');
  writeFileSync(join(CA, 'ca.cnf'), CA_CNF);
  caBash([
    'openssl req -x509 -newkey rsa:2048 -nodes -keyout root.key -config ca.cnf -extensions root -days 3650 -out root.crt 2>/dev/null',
    'openssl req -newkey rsa:2048 -nodes -keyout iss.key -subj "/CN=Alfred Test Issuing" -out iss.csr 2>/dev/null',
    'openssl x509 -req -in iss.csr -CA root.crt -CAkey root.key -set_serial 2 -days 3650 -extfile ca.cnf -extensions iss -out iss.crt 2>/dev/null',
    // zweite Kette: Issuing 2 unter der fremden Root (Root-Wechsel gegen eine eingespielte Root)
    'openssl req -newkey rsa:2048 -nodes -keyout iss2.key -subj "/CN=Alfred Test Issuing 2" -out iss2.csr 2>/dev/null',
    'openssl req -x509 -newkey rsa:2048 -nodes -keyout root2.key -subj "/CN=Fremde Root" -days 3650 -extensions root -config ca.cnf -out root2.crt 2>/dev/null',
    'openssl x509 -req -in iss2.csr -CA root2.crt -CAkey root2.key -set_serial 3 -days 3650 -extfile ca.cnf -extensions iss -out iss2.crt 2>/dev/null',
    // fremder 3072-Schlüssel mit demselben Namen (Zertifikat zu einem anderen Schlüssel)
    'openssl req -newkey rsa:3072 -nodes -keyout fremd.key -subj "/CN=sqllnx01.ad.3033.at" -out fremd.csr 2>/dev/null',
    'openssl req -newkey rsa:2048 -nodes -keyout klein.key -subj "/CN=sqllnx01.ad.3033.at" -out klein.csr 2>/dev/null',
  ].join('\n'));
}, 120_000);
afterAll(() => { for (const d of [...ORDNER, CA]) if (d) rmSync(d, { recursive: true, force: true }); });

const P1 = tlsParameter('sqllnx01');
const PRIVAT = /PRIVATE KEY|BEGIN RSA PRIVATE|BEGIN ENCRYPTED PRIVATE/;
function keinSchluessel(...l: Lauf[]) { for (const x of l) { expect(x.aus).not.toMatch(PRIVAT); expect(x.log).not.toMatch(PRIVAT); expect(JSON.stringify(x.e ?? {})).not.toMatch(PRIVAT); } }

describe('linux_sql TLS — Parameter (SANs je Host aus linuxTlsSans)', () => {
  it('sqllnx01/02 mit Listener, sqllnxcfg nur sich selbst; CN = FQDN; andere Hosts abgewiesen', () => {
    expect(tlsParameter('sqllnx01')).toEqual({ cn: 'sqllnx01.ad.3033.at', sans: ['sqllnx01', 'sqllnx01.ad.3033.at', 'sqllnxag01', 'sqllnxag01.ad.3033.at'] });
    expect(tlsParameter('SQLLNX02').sans).toEqual(linuxTlsSans('sqllnx02'));
    expect(tlsParameter('sqllnxcfg')).toEqual({ cn: 'sqllnxcfg.ad.3033.at', sans: ['sqllnxcfg', 'sqllnxcfg.ad.3033.at'] });
    expect(() => tlsParameter('sql01')).toThrow('TLS nur für sqllnx01, sqllnx02, sqllnxcfg');
    expect(pruefeTls(P1)).toBeUndefined();
    expect(pruefeTls({ cn: 'sqllnxcfg.ad.3033.at', sans: P1.sans })).toContain('sans: genau sqllnxcfg');
    expect(pruefeTls({ cn: 'x.ad.3033.at', sans: [] })).toContain('cn:');
    expect(() => tlsAnfordernSkript({ cn: 'sqllnx01.ad.3033.at', sans: ['sqllnx01'] })).toThrow('sans');
  });
  it('Bausteine registriert; Skript nennt CN/SANs, Pfade und kein forceencryption, keinen Neustart', () => {
    for (const b of [LINUX_SQL_BAUSTEINE.tlsAnfordern, LINUX_SQL_BAUSTEINE.tlsEinspielen, LINUX_SQL_BAUSTEINE.tlsEntfernen]) expect(linuxBausteinBekannt(b)).toBe(true);
    const a = tlsAnfordernSkript(P1); const e = tlsEinspielenSkript({ ...P1, rootSha256: 'a'.repeat(64) }); const r = tlsEntfernenSkript();
    expect(a).toContain("CN='sqllnx01.ad.3033.at'");
    expect(a).toContain("SAN_CNF='DNS:sqllnx01,DNS:sqllnx01.ad.3033.at,DNS:sqllnxag01,DNS:sqllnxag01.ad.3033.at'");
    expect(a).toContain(`KEY_NEU='${TLS_KEY_NEU}'`);
    for (const s of [a, e, r]) { expect(s).not.toMatch(/forceencryption 1|set network\.forceencryption|systemctl (re)?start/); expect(s).not.toMatch(/openssl (rsa|pkey)[^\n]*-text[^\n]*-in "\$KEY/); }
    expect(e).toContain(`CRT='${TLS_CRT}'`); expect(e).toContain(`KEY='${TLS_KEY}'`); expect(e).toContain(`CA_ROOT='${TLS_CA_ROOT}'`); expect(e).toContain(`CA_ISS='${TLS_CA_ISSUING}'`);
    expect(r).toContain(`MANIFEST='${TLS_MANIFEST}'`);
    expect(tlsEntfernenSkript()).toContain('forceencryption = 1 — zuerst das Erzwingen zurücknehmen');
  });
});

describe.skipIf(!ECHT)('linux_sql tls_anfordern / tls_einspielen — echter openssl', () => {
  it('Anfordern: RSA-3072-Schlüssel 0400 mssql auf dem Host, CSR mit CN und SANs; Wiederholung nutzt denselben Schlüssel (gleiche Anforderung)', () => {
    const w = welt();
    const a = w.lauf(tlsAnfordernSkript(P1));
    expect(a.rc, a.aus).toBe(0);
    expect(a.e).toMatchObject({ zustand: 'geaendert', cn: P1.cn, sans: P1.sans, bits: 3072, schluesselNeu: true });
    expect(w.rechte('secrets/tls.key.neu')).toBe('400 mssql mssql');
    expect(w.datei('secrets/tls.key.neu')).toMatch(/BEGIN PRIVATE KEY/);
    const pem = ohneCr(String(a.e!.csrPem));
    expect(csrSha256(pem)).toBe(a.e!.csrSha256);
    expect(pem.replace(/-----[^-]+-----|\s/g, '')).toBe(a.e!.csrBase64);
    // CSR-Inhalt mit openssl gelesen
    writeFileSync(join(w.T, 'csr.pem'), pem);
    const t = spawnSync('bash', ['-c', `openssl req -noout -text -in ${q(`${w.T}/csr.pem`)}`], { encoding: 'utf8' }).stdout;
    expect(t).toContain('CN=sqllnx01.ad.3033.at');
    expect(t).toContain('DNS:sqllnx01, DNS:sqllnx01.ad.3033.at, DNS:sqllnxag01, DNS:sqllnxag01.ad.3033.at');
    expect(t).toContain('Public-Key: (3072 bit)');
    // keine Konfiguration, kein Rest im Lauf-Ordner, kein Zwischenordner neben dem Schlüssel
    expect(w.conf()).toEqual({});
    expect(w.dateien().trim().split('\n')).toEqual(['secrets/tls.key.neu']);
    const b = w.lauf(tlsAnfordernSkript(P1));
    expect(b.rc, b.aus).toBe(0);
    expect(b.e).toMatchObject({ zustand: 'schon', schluesselNeu: false, csrSha256: a.e!.csrSha256 });
    expect(b.log).not.toContain('openssl genpkey');
    keinSchluessel(a, b);
    // sqllnxcfg: nur die eigenen zwei Namen
    const c = welt().lauf(tlsAnfordernSkript(tlsParameter('sqllnxcfg')));
    expect(c.rc, c.aus).toBe(0);
    expect(c.e!.sans).toEqual(['sqllnxcfg', 'sqllnxcfg.ad.3033.at']);
  }, 120_000);

  it('Anfordern: fremder tls.key.neu (Rechte oder 2048 Bit) → Abbruch ohne Änderung', () => {
    const w = welt();
    mkdirSync(join(w.T, 'secrets'));
    writeFileSync(join(w.T, 'secrets/tls.key.neu'), readFileSync(join(CA, 'klein.key')));
    const a = w.lauf(tlsAnfordernSkript(P1));
    expect(a.rc).toBe(1);
    expect(a.e!.fehler).toContain('statt 400 mssql mssql');
    writeFileSync(join(w.T, `meta/${`${w.T}/secrets/tls.key.neu`.replace(/[/:]/g, '_')}.mod`), '400');
    writeFileSync(join(w.T, `meta/${`${w.T}/secrets/tls.key.neu`.replace(/[/:]/g, '_')}.own`), 'mssql mssql');
    const b = w.lauf(tlsAnfordernSkript(P1));
    expect(b.rc).toBe(1);
    expect(b.e!.fehler).toContain('ist kein RSA-3072-Schlüssel');
    expect(w.datei('secrets/tls.key.neu')).toBe(ohneCr(readFileSync(join(CA, 'klein.key'), 'utf8')));
    keinSchluessel(a, b);
  }, 60_000);

  /** Welt mit angeforderter Anforderung (Schlüssel .neu) */
  function angefordert(p = P1): { w: Welt; csr: string } {
    const w = welt();
    const a = w.lauf(tlsAnfordernSkript(p));
    expect(a.rc, a.aus).toBe(0);
    return { w, csr: ohneCr(String(a.e!.csrPem)) };
  }
  const eingabe = (zertifikat: string, kette = KETTE()) => JSON.stringify({ zertifikat, kette });

  it('Einspielen: Kette geprüft, Schlüssel .neu → tls.key, Zertifikat, CA-Dateien, Manifest, mssql-conf ohne forceencryption, kein Neustart; Wiederholung „schon“', () => {
    const { w, csr } = angefordert();
    const z = signiere(csr);
    const e = w.lauf(tlsEinspielenSkript(PE()), eingabe(z));
    expect(e.rc, e.aus).toBe(0);
    const x = new X509Certificate(z);
    expect(e.e).toMatchObject({ zustand: 'geaendert', cn: P1.cn, bits: 3072, thumbprint: x.fingerprint.replace(/:/g, ''), schluessel: 'neu', zertifikat: `${w.T}/secrets/tls.crt`, neustartNoetig: true });
    expect(e.e!.restTage).toBeGreaterThanOrEqual(363);
    expect(String(e.e!.gueltigBis)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(e.e!.aenderungen).toEqual(expect.arrayContaining(['manifest', 'ca-root', 'ca-issuing', 'vertrauensspeicher', 'schluessel', 'zertifikat', 'mssql-conf:tlscert', 'mssql-conf:tlskey', 'mssql-conf:tlsprotocols']));
    expect(w.datei('secrets/tls.key.neu')).toBeUndefined();
    expect(w.datei('secrets/tls.key')).toMatch(/BEGIN PRIVATE KEY/);
    expect(new X509Certificate(w.datei('secrets/tls.crt')!).fingerprint).toBe(x.fingerprint);
    expect(w.rechte('secrets/tls.key')).toBe('400 mssql mssql');
    expect(w.rechte('secrets/tls.crt')).toBe('444 mssql mssql');
    expect(w.rechte('ca/ad3033-root.crt')).toBe('644 root root');
    expect(new X509Certificate(w.datei('ca/ad3033-root.crt')!).subject).toContain('Alfred Test Root');
    expect(new X509Certificate(w.datei('ca/ad3033-issuing.crt')!).subject).toContain('Alfred Test Issuing');
    expect(w.datei('etc/alfred/sqllnx-tls.manifest')!.split('\n')[0]).toBe('# Alfred I8e — linux_sql tls_einspielen (SHA-256 der eingespielten Dateien, nicht von Hand ändern)');
    expect(w.datei('etc/alfred/sqllnx-tls.manifest')!.trim().split('\n')).toHaveLength(5);
    expect(w.rechte('etc/alfred/sqllnx-tls.manifest')).toBe('600 root root');
    expect(w.conf()).toEqual({ tlscert: `${w.T}/secrets/tls.crt`, tlskey: `${w.T}/secrets/tls.key`, tlsprotocols: '1.2,1.3' });
    expect(e.log).toContain('update-ca-certificates');
    expect(e.log).not.toMatch(/systemctl (re)?start|forceencryption/);
    // keine Zwischendateien
    expect(w.dateien()).not.toMatch(/\.alfred-tls-|alfred-tls\./);
    // Wiederholung: nichts zu tun; Dienst seit „später“ aktiv → kein Neustart nötig
    writeFileSync(join(w.T, 'sql_start'), '@9999999999\n');
    const s = w.lauf(tlsEinspielenSkript(PE()), eingabe(z));
    expect(s.rc, s.aus).toBe(0);
    expect(s.e).toMatchObject({ zustand: 'schon', schluessel: 'aktiv', neustartNoetig: false, aenderungen: [] });
    expect(s.log).not.toContain('mssql-conf set');
    keinSchluessel(e, s);
  }, 120_000);

  it('Review Focus 4: Zertifikat zu einem anderen Schlüssel → Abbruch, nichts geändert; nach einer Einspielung bleibt die alte Konfiguration', () => {
    const { w, csr } = angefordert();
    const fremd = signiere(ohneCr(readFileSync(join(CA, 'fremd.csr'), 'utf8')));
    const vorher = w.dateien();
    const a = w.lauf(tlsEinspielenSkript(PE()), eingabe(fremd));
    expect(a.rc).toBe(1);
    expect(a.e!.fehler).toContain('Zertifikat passt nicht zum Schlüssel auf dem Host');
    expect(a.e!.fehler).toContain('bisherige TLS-Konfiguration bleibt');
    expect(w.dateien()).toBe(vorher);
    expect(w.conf()).toEqual({});
    expect(a.log).not.toMatch(/mssql-conf|update-ca-certificates|^mv /m);
    // richtig eingespielt, dann eine falsche Antwort: tls.crt, tls.key, mssql.conf, Manifest unverändert
    const z = signiere(csr);
    expect(w.lauf(tlsEinspielenSkript(PE()), eingabe(z)).rc).toBe(0);
    const crt = w.datei('secrets/tls.crt'); const key = w.datei('secrets/tls.key'); const man = w.datei('etc/alfred/sqllnx-tls.manifest'); const conf = w.conf();
    const b = w.lauf(tlsEinspielenSkript(PE()), eingabe(fremd));
    expect(b.rc).toBe(1);
    expect(b.e!.fehler).toContain('Zertifikat passt nicht zum Schlüssel auf dem Host');
    expect(w.datei('secrets/tls.crt')).toBe(crt);
    expect(w.datei('secrets/tls.key')).toBe(key);
    expect(w.datei('etc/alfred/sqllnx-tls.manifest')).toBe(man);
    expect(w.conf()).toEqual(conf);
    keinSchluessel(a, b);
  }, 120_000);

  it('Prüfungen vor jeder Änderung: SAN fehlt, falsche Root, nur clientAuth, < 30 Tage, Schlüssel in der Eingabe, fremde Datei → Abbruch, nichts geändert', () => {
    const { w, csr } = angefordert();
    const vorher = w.dateien();
    const faelle: Array<[string, string, string]> = [
      ['SAN fehlt', eingabe(signiere(csr, 'leaf_ohne_listener')), 'SANs'],
      ['fremde Root', eingabe(signiere(csr), pemDatei('iss.crt') + pemDatei('root2.crt')), 'Kette: Root mit SHA-256'],
      ['nur clientAuth', eingabe(signiere(csr, 'leaf_client')), 'nicht für Server-Authentifizierung'],
      ['läuft bald ab', eingabe(signiere(csr, 'leaf', 20)), 'weniger als 30 Tagen'],
      ['Schlüssel in der Eingabe', JSON.stringify({ zertifikat: signiere(csr), kette: KETTE() + ohneCr(readFileSync(join(CA, 'fremd.key'), 'utf8')) }), 'enthält einen privaten Schlüssel'],
      ['eine Kette zu wenig', eingabe(signiere(csr), pemDatei('iss.crt')), '1 Zertifikatsblöcke, erwartet 2'],
    ];
    for (const [name, ein, text] of faelle) {
      const r = w.lauf(tlsEinspielenSkript(PE()), ein);
      expect(r.rc, name).toBe(1);
      expect(String(r.e?.fehler), name).toContain(text);
      expect(String(r.e?.fehler), name).toContain('nichts geändert');
      expect(w.dateien(), name).toBe(vorher);
      expect(w.conf(), name).toEqual({});
      expect(r.aus, name).not.toMatch(PRIVAT);
    }
    // fremde (nicht im Manifest stehende) CA-Datei bzw. fremde mssql.conf → nichts angefasst
    mkdirSync(join(w.T, 'ca'), { recursive: true });
    writeFileSync(join(w.T, 'ca/ad3033-root.crt'), pemDatei('root2.crt'));
    const f = w.lauf(tlsEinspielenSkript(PE()), eingabe(signiere(csr)));
    expect(f.rc).toBe(1);
    expect(f.e!.fehler).toContain('Root weicht von der eingespielten ab');
    expect(w.datei('ca/ad3033-root.crt')).toBe(pemDatei('root2.crt'));
    expect(existsSync(join(w.T, 'secrets/tls.key.neu'))).toBe(true);
    rmSync(join(w.T, 'ca/ad3033-root.crt'));
    writeFileSync(join(w.T, 'conf/tlscert'), '/etc/ssl/fremd.pem\n');
    const g = w.lauf(tlsEinspielenSkript(PE()), eingabe(signiere(csr)));
    expect(g.rc).toBe(1);
    expect(g.e!.fehler).toContain('network.tlscert = /etc/ssl/fremd.pem (nicht Alfreds Pfad');
    expect(w.datei('conf/tlscert')).toBe('/etc/ssl/fremd.pem\n');
  }, 180_000);

  it('Erneuerung: neue Anforderung + neues Zertifikat ersetzt Alfreds alte Dateien, Manifest nur mit den neuen', () => {
    const { w, csr } = angefordert();
    expect(w.lauf(tlsEinspielenSkript(PE()), eingabe(signiere(csr))).rc).toBe(0);
    const alt = w.datei('secrets/tls.key');
    const a2 = w.lauf(tlsAnfordernSkript(P1));
    expect(a2.e).toMatchObject({ schluesselNeu: true });
    const z2 = signiere(ohneCr(String(a2.e!.csrPem)));
    const e2 = w.lauf(tlsEinspielenSkript(PE()), eingabe(z2));
    expect(e2.rc, e2.aus).toBe(0);
    expect(e2.e).toMatchObject({ zustand: 'geaendert', schluessel: 'neu' });
    expect(w.datei('secrets/tls.key')).not.toBe(alt);
    expect(new X509Certificate(w.datei('secrets/tls.crt')!).fingerprint).toBe(new X509Certificate(z2).fingerprint);
    expect(w.datei('etc/alfred/sqllnx-tls.manifest')!.trim().split('\n')).toHaveLength(5);
    keinSchluessel(a2, e2);
  }, 120_000);

  it('tls_entfernen: nur Alfreds Werte und Dateien (Manifest), unbenutzter .neu; forceencryption 1 → Abbruch ohne Änderung; Wiederholung „schon“', () => {
    const { w, csr } = angefordert();
    expect(w.lauf(tlsEinspielenSkript(PE()), eingabe(signiere(csr))).rc).toBe(0);
    w.lauf(tlsAnfordernSkript(P1)); // neuer, unbenutzter Schlüssel
    writeFileSync(join(w.T, 'conf/forceencryption'), '1\n');
    const vorher = w.dateien();
    const f = w.lauf(tlsEntfernenSkript());
    expect(f.rc).toBe(1);
    expect(f.e!.fehler).toContain('forceencryption = 1');
    expect(w.dateien()).toBe(vorher);
    rmSync(join(w.T, 'conf/forceencryption'));
    // die CA-Issuing-Datei hat jemand verändert → bleibt (belassen)
    writeFileSync(join(w.T, 'ca/ad3033-issuing.crt'), `${w.datei('ca/ad3033-issuing.crt')}\n`);
    const r = w.lauf(tlsEntfernenSkript());
    expect(r.rc, r.aus).toBe(0);
    expect(r.e).toMatchObject({ zustand: 'geaendert', neustartNoetig: true });
    expect(r.e!.aenderungen).toEqual(expect.arrayContaining(['mssql-conf:tlscert', 'mssql-conf:tlskey', 'mssql-conf:tlsprotocols', 'entfernt:tls.crt', 'entfernt:tls.key', 'entfernt:ad3033-root.crt', 'entfernt:tls.key.neu', 'vertrauensspeicher', 'manifest']));
    expect((r.e!.belassen as string[]).join(' ')).toContain('ad3033-issuing.crt (nicht von Alfred');
    expect(w.conf()).toEqual({});
    expect(w.dateien().trim().split('\n')).toEqual(['ca/ad3033-issuing.crt', 'etc/alfred']);
    expect(r.log).toContain('update-ca-certificates --fresh');
    const s = w.lauf(tlsEntfernenSkript());
    expect(s.e).toMatchObject({ zustand: 'schon', neustartNoetig: false });
    keinSchluessel(f, r, s);
  }, 120_000);

  it('Ruling R17: falsche erwartete Root → Abbruch ohne Änderung; andere Root als die eingespielte → Abbruch, Dateien unverändert', () => {
    const { w, csr } = angefordert();
    const vorher = w.dateien();
    const a = w.lauf(tlsEinspielenSkript(PE(rootSha('root2.crt'))), eingabe(signiere(csr)));
    expect(a.rc).toBe(1);
    expect(a.e!.fehler).toContain(`Kette: Root mit SHA-256 ${rootSha('root.crt')} statt erwartet ${rootSha('root2.crt')} — nichts geändert`);
    expect(w.dateien()).toBe(vorher);
    expect(w.lauf(tlsEinspielenSkript(PE()), eingabe(signiere(csr))).rc).toBe(0);
    const stand = () => [w.datei('ca/ad3033-root.crt'), w.datei('ca/ad3033-issuing.crt'), w.datei('secrets/tls.crt'), w.datei('secrets/tls.key'), w.datei('etc/alfred/sqllnx-tls.manifest'), JSON.stringify(w.conf())];
    const v2 = stand();
    // neue Anforderung, Zertifikat aus einer anderen PKI (Root 2), erwartet Root 2 → die eingespielte Root wird nicht ersetzt
    const a2 = w.lauf(tlsAnfordernSkript(P1));
    const z2 = signiere(ohneCr(String(a2.e!.csrPem)), 'leaf', 365, 'iss2');
    const b = w.lauf(tlsEinspielenSkript(PE(rootSha('root2.crt'))), eingabe(z2, pemDatei('iss2.crt') + pemDatei('root2.crt')));
    expect(b.rc).toBe(1);
    expect(b.e!.fehler).toContain('Root weicht von der eingespielten ab');
    expect(b.e!.fehler).toContain('nichts geändert');
    expect(stand()).toEqual(v2);
    expect(b.log).not.toMatch(/mssql-conf|update-ca-certificates/);
    keinSchluessel(a, b);
  }, 120_000);

  it('Fix-Runde 1: scheitert das Ersetzen von tls.crt nach dem Schlüssel-mv, kommen alter Schlüssel und .neu zurück', () => {
    const { w, csr } = angefordert();
    expect(w.lauf(tlsEinspielenSkript(PE()), eingabe(signiere(csr))).rc).toBe(0);
    const crt = w.datei('secrets/tls.crt'); const key = w.datei('secrets/tls.key');
    const a2 = w.lauf(tlsAnfordernSkript(P1));
    const neu = w.datei('secrets/tls.key.neu');
    writeFileSync(join(w.T, 'mv_crt_scheitert'), '');
    const b = w.lauf(tlsEinspielenSkript(PE()), eingabe(signiere(ohneCr(String(a2.e!.csrPem)))));
    expect(b.rc).toBe(1);
    expect(b.e!.fehler).toContain('nicht ersetzt — Schlüssel zurückgestellt');
    expect(b.e!.fehler).toContain('Rückweg tls_entfernen');
    expect(w.datei('secrets/tls.crt')).toBe(crt);
    expect(w.datei('secrets/tls.key')).toBe(key);
    expect(w.datei('secrets/tls.key.neu')).toBe(neu);
    expect(w.rechte('secrets/tls.key')).toBe('400 mssql mssql');
    expect(w.rechte('secrets/tls.key.neu')).toBe('400 mssql mssql');
    expect(w.dateien()).not.toMatch(/\.alfred-tls-|tls\.key\.alt/);
    keinSchluessel(a2, b);
  }, 120_000);

  it('Eingabe-Prüfung (python): genau ein Zertifikat und zwei in der Kette, kein Text daneben', () => {
    const w = welt();
    const lauf = (ein: string) => spawnSync('bash', [], { input: `python3() { PYTHONIOENCODING=utf-8 ${q(PYTHON_PFAD)} "$@"; }\nmkdir -p ${q(`${w.T}/e`)}\npython3 -c ${q(PY_TLS_EINGABE)} ${q(`${w.T}/e`)} <<<${q(ein)}`, encoding: 'utf8' });
    expect(lauf(JSON.stringify({ zertifikat: pemDatei('iss.crt'), kette: KETTE() })).status).toBe(0);
    expect(w.datei('e/zert.pem')).toBe(new X509Certificate(pemDatei('iss.crt')).toString().replace(/\r/g, ''));
    expect(lauf(JSON.stringify({ zertifikat: `x\n${pemDatei('iss.crt')}`, kette: KETTE() })).stderr).toContain('Text außerhalb');
    expect(lauf(JSON.stringify({ zertifikat: KETTE(), kette: KETTE() })).stderr).toContain('2 Zertifikatsblöcke, erwartet 1');
    expect(lauf('kein json').stderr).toContain('kein JSON');
  }, 60_000);

  it('PY_STATUS TLS-Teil: Thumbprint, Ablauf, Resttage aus dem Zertifikat; erzwungen aus forceencryption', () => {
    const teil = PY_STATUS.slice(PY_STATUS.indexOf('import datetime as _dt'), PY_STATUS.indexOf('r["tls"] = tls'));
    const z = signiere(ohneCr(readFileSync(join(CA, 'fremd.csr'), 'utf8')), 'leaf', 100);
    writeFileSync(join(CA, 'status.crt'), z);
    const prog = [
      'import json, os, subprocess',
      'def lauf(*a):',
      '    p = subprocess.run(list(a), capture_output=True, text=True, timeout=30)',
      '    return p.returncode, p.stdout.strip()',
      `KONF = {"tlscert": ${JSON.stringify(`${CA}/status.crt`)}, "forceencryption": "1"}`,
      'g = lambda s, k: KONF.get(k) if s == "network" else None',
      teil,
      'print(json.dumps(tls))',
    ].join('\n');
    const r = spawnSync(PYTHON!, ['-'], { input: prog, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    const t = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, unknown>;
    const x = new X509Certificate(z);
    expect(t).toMatchObject({ thumbprint: x.fingerprint.replace(/:/g, ''), erzwungen: true, pruefSchalter: false });
    expect(t.restTage).toBeGreaterThanOrEqual(98);
    expect(new Date(String(t.gueltigBis)).getTime()).toBe(new Date(x.validTo).getTime());
  }, 60_000);
});

describe('linux_sql TLS — Skill, Verweise, Change-Regeln', () => {
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

  it('Planprüfung: Host je zugang/computername (alle drei, sonst Fehler), Zeitlimits', () => {
    const { s } = skill({});
    expect(s.pruefeEingabe({ action: 'tls_anfordern', zugang: 'sqllnxcfg' })).toBeUndefined();
    expect(s.pruefeEingabe({ action: 'tls_anfordern', zugang: 'sqllnx03' })).toContain('TLS nur für sqllnx01, sqllnx02, sqllnxcfg');
    expect(s.pruefeEingabe({ action: 'tls_einspielen', zugang: 'sqllnx01', computername: 'sql01', zert_base64: '{{schritt2.zertBase64}}' })).toContain('TLS nur für');
    const refs = { zert_base64: '{{schritt2.zertBase64}}', issuing_base64: '{{schritt2.issuingBase64}}', root_base64: '{{schritt2.rootBase64}}' };
    expect(s.pruefeEingabe({ action: 'tls_einspielen', zugang: 'sqllnx01', ...refs, erwartet_root_sha256: 'ab'.repeat(32) })).toBeUndefined();
    // Ruling R17: Pflicht, fester Wert (kein Verweis)
    expect(s.pruefeEingabe({ action: 'tls_einspielen', zugang: 'sqllnx01', ...refs })).toContain('erwartet_root_sha256');
    expect(s.pruefeEingabe({ action: 'tls_einspielen', zugang: 'sqllnx01', ...refs, erwartet_root_sha256: '{{schritt2.rootSha256}}' })).toContain('fester Wert');
    expect(s.pruefeEingabe({ action: 'tls_einspielen', zugang: 'sqllnx01', zertifikat: 'kein pem', kette: 'x', erwartet_root_sha256: 'ab'.repeat(32) })).toContain('zertifikat');
    for (const a of ['tls_anfordern', 'tls_einspielen', 'tls_entfernen']) expect(LINUX_SQL_MIN_ZEITLIMIT_S[a]).toBeGreaterThan(60);
  });

  it.skipIf(!ECHT)('tls_einspielen: nur im Change; Zertifikat/Kette nur über stdin (PEM oder DER-Base64 gleich), Thumbprint gegengeprüft', async () => {
    const csr = ohneCr(readFileSync(join(CA, 'fremd.csr'), 'utf8'));
    const z = signiere(csr);
    const x = new X509Certificate(z);
    const tp = x.fingerprint.replace(/:/g, '');
    const ok = { zustand: 'geaendert', cn: 'sqllnx01.ad.3033.at', thumbprint: tp, gueltigBis: '2027-11-19T12:00:00Z', restTage: 365, schluessel: 'neu', neustartNoetig: true, aenderungen: ['zertifikat'] };
    const w = skill(ok);
    expect((await w.s.execute({ action: 'tls_einspielen', zugang: 'sqllnx01', zertifikat: z, kette: KETTE(), erwartet_root_sha256: rootSha('root.crt') }, {} as never)).error).toContain('nur als Schritt');
    const r = await w.s.execute({ action: 'tls_einspielen', zugang: 'sqllnx01', zertifikat: z, kette: KETTE(), erwartet_root_sha256: rootSha('root.crt') }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toContain(`TLS_INSTALLED sqllnx01: /var/opt/mssql/secrets/tls.crt Thumbprint ${tp}`);
    expect(r.display).toContain('Verschlüsselung NICHT erzwungen; Neustart von SQL Server nötig (rollierend per Change)');
    expect(w.aufrufe[0]!.baustein).toBe(LINUX_SQL_BAUSTEINE.tlsEinspielen);
    expect(w.aufrufe[0]!.parameter).toEqual(PE());
    const ein = JSON.parse(w.aufrufe[0]!.eingabe!) as Record<string, string>;
    expect(Object.keys(ein)).toEqual(['zertifikat', 'kette']);
    // DER-Base64 (Form der Change-Verweise) ergibt dieselbe Eingabe; Kettenreihenfolge egal
    const der = (p: string) => Buffer.from(new X509Certificate(p).raw).toString('base64');
    const r2 = await w.s.execute({ action: 'tls_einspielen', zugang: 'sqllnx01', zert_base64: der(z), issuing_base64: der(pemDatei('iss.crt')), root_base64: der(pemDatei('root.crt')), erwartet_root_sha256: rootSha('root.crt').toUpperCase() }, imChange);
    expect(r2.success, r2.error).toBe(true);
    expect(w.aufrufe[1]!.eingabe).toBe(w.aufrufe[0]!.eingabe);
    expect(tlsEingabe({ zertifikat: z, kette: pemDatei('root.crt') + pemDatei('iss.crt'), erwartet_root_sha256: rootSha('root.crt') }).kette).toBe(ein.kette);
    // Eingabe-Fehler vor jedem Aufruf
    const n = skill(ok);
    for (const [input, text] of [
      [{ zertifikat: z, kette: pemDatei('iss.crt') + pemDatei('root2.crt') }, 'Issuing-CA ist nicht von der Root'],
      [{ zertifikat: pemDatei('iss.crt'), kette: KETTE() }, 'nicht von der Issuing-CA'],
      [{ zertifikat: z, kette: `${KETTE()}-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n` }, 'privaten Schlüssel'],
      [{ zert_base64: der(z), issuing_base64: der(pemDatei('iss.crt')) }, 'nur zusammen'],
      // Ruling R17: andere erwartete Root bzw. keine → abgewiesen, kein Fernaufruf
      [{ zertifikat: z, kette: KETTE(), erwartet_root_sha256: rootSha('root2.crt') }, `Root mit SHA-256 ${rootSha('root.crt')} statt erwartet ${rootSha('root2.crt')}`],
      [{ zertifikat: z, kette: KETTE(), erwartet_root_sha256: undefined }, 'erwartet_root_sha256: SHA-256 (64 Hex)'],
    ] as Array<[Record<string, unknown>, string]>) {
      const f = await n.s.execute({ action: 'tls_einspielen', zugang: 'sqllnx01', erwartet_root_sha256: rootSha('root.crt'), ...input }, imChange);
      expect(f.success).toBe(false);
      expect(f.error).toContain(text);
    }
    expect(n.aufrufe).toEqual([]);
    // Nachprüfung: anderer Thumbprint im Ergebnis → Fehler
    const t = await skill({ ...ok, thumbprint: 'A'.repeat(40) }).s.execute({ action: 'tls_einspielen', zugang: 'sqllnx01', zertifikat: z, kette: KETTE(), erwartet_root_sha256: rootSha('root.crt') }, imChange);
    expect(t.error).toContain('Nachprüfung fehlgeschlagen');
  });

  it.skipIf(!ECHT)('tls_anfordern: Anforderung nachgeprüft; data (csrBase64) bleibt unter MAX_DATEN und löst als csr_base64 auf → windows_pki fremd_csr_ausstellen', async () => {
    const pem = ohneCr(readFileSync(join(CA, 'fremd.csr'), 'utf8'));
    const b64 = pem.replace(/-----[^-]+-----|\s/g, '');
    const ok = { zustand: 'geaendert', cn: P1.cn, sans: P1.sans, bits: 3072, schluessel: TLS_KEY_NEU, schluesselNeu: true, csrPem: pem, csrSha256: csrSha256(pem), csrBase64: b64, aenderungen: ['schluessel-neu'] };
    const w = skill(ok);
    const r = await w.s.execute({ action: 'tls_anfordern', zugang: 'sqllnx01' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toContain(`TLS_CSR_READY sqllnx01: Anforderung CN=sqllnx01.ad.3033.at, SAN sqllnx01, sqllnx01.ad.3033.at, sqllnxag01, sqllnxag01.ad.3033.at, RSA 3072, SHA-256 ${ok.csrSha256}`);
    expect(w.aufrufe[0]!.eingabe).toBeUndefined();
    // Change-Daten unverkürzt (Verweise lesen aus den gekürzten Daten)
    expect(JSON.stringify(r.data).length).toBeLessThan(MAX_DATEN);
    expect(kuerzeDaten(r.data)).toEqual(r.data);
    const erg = [{ nr: 3, ok: true, daten: kuerzeDaten(r.data) }] as never;
    const aufg = loeseAuf({ cn: P1.cn, sans: P1.sans, csr_base64: '{{schritt3.csrBase64}}', csr_sha256: '{{schritt3.csrSha256}}' }, erg);
    expect(aufg.fehler).toBeUndefined();
    const a = pruefeFremdAusstellung(aufg.wert as never);
    expect(typeof a).not.toBe('string');
    expect(a).toMatchObject({ cn: P1.cn, csr_sha256: ok.csrSha256 });
    // PEM als Verweis fällt durch die Wert-Sicherheit (deshalb csrBase64)
    expect(loeseAuf({ csr_pem: '{{schritt3.csrPem}}' }, erg).fehler).toContain('unzulässigen Wert');
    expect(pruefeFremdAusstellung({ cn: P1.cn, sans: P1.sans, csr_sha256: ok.csrSha256, csr_base64: b64, csr_pem: pem })).toBe('entweder csr_pem oder csr_base64');
    expect(pruefeFremdAusstellung({ cn: P1.cn, sans: P1.sans, csr_sha256: 'a'.repeat(64), csr_base64: b64 })).toContain('passt nicht zur Anforderung');
    // Nachprüfung: SHA-256 passt nicht zur Anforderung, privater Block → Fehler
    expect((await skill({ ...ok, csrSha256: 'b'.repeat(64) }).s.execute({ action: 'tls_anfordern', zugang: 'sqllnx01' }, imChange)).error).toContain('Nachprüfung fehlgeschlagen');
    expect((await skill({ ...ok, notiz: 'BEGIN PRIVATE KEY' }).s.execute({ action: 'tls_anfordern', zugang: 'sqllnx01' }, imChange)).error).toContain('Nachprüfung fehlgeschlagen');
  });

  it.skipIf(!ECHT)('windows_pki fremd_csr_ausstellen liefert zusätzlich zertBase64/issuingBase64/rootBase64; als Verweis zulässig in zert_base64/issuing_base64/root_base64', () => {
    const z = signiere(ohneCr(readFileSync(join(CA, 'fremd.csr'), 'utf8')));
    const f = derFelder({ zustand: 'ausgestellt', zertifikatPem: z, kettePem: KETTE() });
    const der = (p: string) => Buffer.from(new X509Certificate(p).raw).toString('base64');
    expect(f).toEqual({ zertBase64: der(z), issuingBase64: der(pemDatei('iss.crt')), rootBase64: der(pemDatei('root.crt')) });
    expect(derFelder({ zustand: 'ausgestellt', zertifikatPem: z, kettePem: pemDatei('iss.crt') })).toEqual({});
    // Fix-Runde 1 (Minor 3): data enthält die Base64-Felder ohne doppelte PEM-Felder; nur ohne sie die PEM-Felder
    expect(derOderPem({ zustand: 'ausgestellt', zertifikatPem: z, kettePem: KETTE() })).toEqual(f);
    expect(derOderPem({ zustand: 'ausgestellt', zertifikatPem: z, kettePem: pemDatei('iss.crt') })).toEqual({ zertifikatPem: z, kettePem: pemDatei('iss.crt') });
    const erg = [{ nr: 4, ok: true, daten: f }] as never;
    const r = loeseAuf({ zugang: 'sqllnx01', zert_base64: '{{schritt4.zertBase64}}', issuing_base64: '{{schritt4.issuingBase64}}', root_base64: '{{schritt4.rootBase64}}' }, erg);
    expect(r.fehler).toBeUndefined();
    expect(tlsEingabe({ ...(r.wert as Record<string, unknown>), erwartet_root_sha256: rootSha('root.crt') }).thumbprint).toBe(new X509Certificate(z).fingerprint.replace(/:/g, ''));
  });

  it('tls_entfernen: TLS_REMOVED mit belassen und Neustart-Hinweis; anfordern/entfernen nur im Change', async () => {
    const w = skill({ zustand: 'geaendert', belassen: ['/usr/local/share/ca-certificates/ad3033-issuing.crt (nicht von Alfred)'], neustartNoetig: true, aenderungen: ['mssql-conf:tlscert', 'entfernt:tls.crt'] });
    expect((await w.s.execute({ action: 'tls_entfernen', zugang: 'sqllnx01' }, {} as never)).error).toContain('nur als Schritt');
    expect((await w.s.execute({ action: 'tls_anfordern', zugang: 'sqllnx01' }, {} as never)).error).toContain('nur als Schritt');
    const r = await w.s.execute({ action: 'tls_entfernen', zugang: 'sqllnx01' }, imChange);
    expect(r.display).toContain('TLS_REMOVED sqllnx01: mssql-conf:tlscert, entfernt:tls.crt; belassen (nicht von Alfred): /usr/local/share/ca-certificates/ad3033-issuing.crt');
    expect(r.display).toContain('Neustart von SQL Server nötig');
    expect(w.aufrufe[0]!.eingabe).toBeUndefined();
  });

  it('Change: tls_anfordern nur mit festem Grund ohne Rückweg; tls_einspielen Rückweg genau tls_entfernen auf demselben Zugang; selbstgeprüft', () => {
    const sk = new LinuxSqlSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
    const ctx = { skill: (n: string) => (n === 'linux_sql' ? sk : undefined) as never, asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
    const plan = (schritte: unknown[]) => ({ titel: 'TLS sqllnxcfg', begruendung: 'I8e Etappe 3 L4', typ: 'normal', risiko: 'mittel', ausfallMinuten: 0, betroffen: ['sqllnxcfg'], ohneSicherungGrund: 'eigener Rückweg (tls_entfernen)', schritte });
    const f = (s: unknown[]) => pruefeChangePlan(plan(s) as never, ctx as never).fehler;
    const anf = (rueckweg?: unknown) => ({ titel: 'Anforderung', art: 'aktion', skill: 'linux_sql', aktion: 'tls_anfordern', parameter: { zugang: 'sqllnxcfg' }, zeitlimitS: 300, ...(rueckweg ? { rueckweg } : {}) });
    expect(f([anf()]).some(x => x.includes(`rueckweg {keiner: „${TLS_ANFORDERN_GRUND}“}`))).toBe(true);
    expect(f([anf({ keiner: 'egal' })]).some(x => x.includes('hat keinen Rückweg'))).toBe(true);
    expect(f([anf({ skill: 'linux_sql', aktion: 'tls_entfernen', parameter: { zugang: 'sqllnxcfg' } })]).some(x => x.includes('hat keinen Rückweg'))).toBe(true);
    expect(f([anf({ keiner: TLS_ANFORDERN_GRUND })])).toEqual([]);
    const ein = (rueckweg: unknown) => ({ titel: 'Einspielen', art: 'aktion', skill: 'linux_sql', aktion: 'tls_einspielen', parameter: { zugang: 'sqllnxcfg', erwartet_root_sha256: 'ab'.repeat(32), zert_base64: '{{schritt1.zertBase64}}', issuing_base64: '{{schritt1.issuingBase64}}', root_base64: '{{schritt1.rootBase64}}' }, zeitlimitS: 300, rueckweg });
    const vor = { titel: 'Status', art: 'aktion', skill: 'linux_sql', aktion: 'status', parameter: { zugang: 'sqllnxcfg' }, zeitlimitS: 200 };
    expect(f([vor, ein({ keiner: 'x' })]).some(x => x.includes('rueckweg linux_sql.tls_entfernen (zugang)'))).toBe(true);
    expect(f([vor, ein({ skill: 'linux_sql', aktion: 'tls_entfernen', parameter: { zugang: 'sqllnx01' } })]).some(x => x.includes('tls_entfernen muss auf demselben Zugang laufen'))).toBe(true);
  });
});

describe('linux_sql status — AD/Keytab- und TLS-Text (Task 6)', () => {
  const tls = { zertifikat: TLS_CRT, thumbprint: 'AB'.repeat(20), gueltigBis: '2027-11-19T12:00:00Z', restTage: 365, erzwungen: true, pruefSchalter: true };
  it('fester Wortlaut je Lage', () => {
    expect(adText({ beigetreten: true, keytab: { kvno: 4, spns: 6, aktuell: true, adKvno: 4 } })).toBe('AD beigetreten; Kerberos-Keytab kvno 4 (6 SPNs, aktuell)');
    expect(adText({ beigetreten: true, keytab: { kvno: 4, spns: 6, aktuell: false, adKvno: 5 } })).toBe('AD beigetreten; Kerberos-Keytab kvno 4 (6 SPNs, veraltet, AD-kvno 5)');
    expect(adText({ beigetreten: true, keytab: { kvno: 4, spns: 6, aktuell: null } })).toBe('AD beigetreten; Kerberos-Keytab kvno 4 (6 SPNs, ungeprüft)');
    expect(adText({ beigetreten: false, keytab: null })).toBe('AD nicht beigetreten; kein Kerberos-Keytab');
    expect(adText({ beigetreten: true, keytab: { kvno: null, spns: 0, aktuell: null, fehler: 'nicht lesbar' } })).toBe('AD beigetreten; Kerberos-Keytab nicht lesbar');
    expect(tlsText(tls)).toBe(`TLS gültig bis 2027-11-19 (365 Tage, Thumbprint ${'AB'.repeat(20)}); TLS erzwungen; Zertifikatsprüfung an`);
    expect(tlsText({ zertifikat: null, erzwungen: false, pruefSchalter: false })).toBe('TLS nicht eingerichtet; TLS nicht erzwungen; Zertifikatsprüfung aus');
    expect(tlsText({ ...tls, restTage: -2 })).toContain('TLS ABGELAUFEN seit 2027-11-19');
    expect(tlsText({ zertifikat: TLS_CRT, erzwungen: false })).toContain(`TLS-Zertifikat nicht lesbar (${TLS_CRT})`);
    expect(tlsText(undefined)).toBe('TLS unbekannt');
  });
  it('Statustext hängt AD und TLS an; genau eine Vorlage passt; positive Stücke bestehen die Planprüfung, negative nicht', () => {
    const st: LinuxSqlStatus = { zustand: 'gelesen', installiert: false, platz: [], ad: { beigetreten: true, keytab: { kvno: 4, spns: 6, aktuell: true } }, tls };
    const text = linuxSqlStatusText('sqllnx01', st);
    expect(text).toBe(`sqllnx01: SQL Server nicht installiert; eingehängt: keine Plattenziele; Sicherung: nicht eingerichtet; Zeit unbekannt; AD beigetreten; Kerberos-Keytab kvno 4 (6 SPNs, aktuell); TLS gültig bis 2027-11-19 (365 Tage, Thumbprint ${'AB'.repeat(20)}); TLS erzwungen; Zertifikatsprüfung an`);
    const vorlagen = FESTE_AUSGABEN['linux_sql.status']!.split(' | ');
    const alsMuster = (v: string) => new RegExp(`^${v.split(/\{[a-z]+\}/).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?')}$`);
    expect(vorlagen.filter(v => alsMuster(v).test(text))).toHaveLength(1);
    const sk = new LinuxSqlSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
    const ctx = { skill: (n: string) => (n === 'linux_sql' ? sk : undefined) as never, asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
    const plan = (erwartet: string) => ({ titel: 'Prüfen', begruendung: 'I8e Etappe 3 L4 Beweis', typ: 'normal', risiko: 'low', ausfallMinuten: 0, betroffen: ['sqllnx01'],
      schritte: [{ titel: 'Abschluss', art: 'pruefung', pruefung: { typ: 'skill', skill: 'linux_sql', aktion: 'status', parameter: { zugang: 'sqllnx01' }, erwartet } }] });
    for (const e of ['TLS erzwungen', 'TLS gültig bis', 'AD beigetreten', '6 SPNs, aktuell', 'Zertifikatsprüfung an']) {
      expect(text).toContain(e);
      expect(pruefeChangePlan(plan(e) as never, ctx as never).fehler, e).toEqual([]);
    }
    for (const e of ['TLS nicht erzwungen', 'TLS nicht eingerichtet']) expect(pruefeChangePlan(plan(e) as never, ctx as never).fehler.length, e).toBeGreaterThan(0);
    // ohne AD-/TLS-Daten (ältere Bausteine) bleibt der Text wie bisher
    expect(linuxSqlStatusText('x', { zustand: 'gelesen', installiert: false, platz: [] })).toBe('x: SQL Server nicht installiert; eingehängt: keine Plattenziele; Sicherung: nicht eingerichtet; Zeit unbekannt');
  });
  it('PY_STATUS liest TLS ohne Schlüssel (nur network.tlscert, Fingerabdruck, Ablauf)', () => {
    const teil = PY_STATUS.slice(PY_STATUS.indexOf('import datetime as _dt'), PY_STATUS.indexOf('r["tls"] = tls'));
    expect(teil).toContain('"-fingerprint", "-sha1", "-enddate"');
    expect(teil).not.toMatch(/tlskey|tls\.key|rsa|pkey/);
    expect(PY_STATUS).toContain('/etc/alfred/sqllnx-tls-pruefen');
  });
});
