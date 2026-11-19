/**
 * I8e Etappe 3 Task 6 (Spec docs/specs/2026-11-19-i8e-linux-sql-ad-tls.md 7.4) — TLS für SQL Server auf den Linux-Hosts (auch sqllnxcfg).
 *
 *  - tls_anfordern: RSA-3072-Schlüssel AUF dem Host (`tls.key.neu`, mssql:mssql 0400; ein vorhandener unbenutzter wird wiederverwendet)
 *    und daraus die Anforderung (CN = <host>.ad.3033.at, SANs genau nach linuxTlsSans). Ergebnis nur öffentlich: csrPem, csrSha256 und
 *    csrBase64 (DER, für den Verweis {{schrittN.csrBase64}} → windows_pki fremd_csr_ausstellen csr_base64). Keine Konfiguration.
 *  - tls_einspielen: Zertifikat + Kette (öffentlich) über stdin { zertifikat, kette }. Erst alles prüfen, nichts ändern: Kette Issuing →
 *    Root (`openssl verify`), Zertifikat → Kette mit Zweck sslserver, Modulus Zertifikat = Modulus des Schlüssels auf dem Host
 *    (Review Focus 4), RSA 3072, Subject genau CN=<fqdn>, SANs exakt, Restlaufzeit > 30 Tage, keine fremden Dateien/mssql.conf-Werte.
 *    Dann: Manifest (SHA-256 der Dateien, die Alfred schreibt), CA-Dateien + update-ca-certificates, `.neu` → tls.key, Zertifikat →
 *    tls.crt (atomar: Zwischendatei im selben Ordner, Rechte vor dem Inhalt, mv), mssql-conf network.tlscert/tlskey/tlsprotocols. KEIN
 *    forceencryption (Task 8) und KEIN Neustart (neustartNoetig im Ergebnis; der Change startet rollierend neu).
 *  - tls_entfernen (Rückweg von tls_einspielen): bei network.forceencryption 1 Abbruch ohne Änderung (ohne Zertifikat startete SQL Server
 *    nicht); mssql-conf-Werte nur, wenn es Alfreds sind; Dateien nur, wenn ihr SHA-256 im Manifest steht; `tls.key.neu` nur mit 0400
 *    mssql:mssql. Fremdes bleibt (belassen). Abbruch, solange die Zertifikatsprüfung (Task 7) an ist.
 *  - tls_pruefung_schalten (Task 7): Schalter TLS_PRUEF_SCHALTER für Alfreds eigene SQL-Verbindungen (sql_ziel in linux-sql.ts) — an nur
 *    mit gültigem, genutztem Zertifikat und gelungener Probe `sqlcmd -N -S <fqdn>`; aus = Rückweg.
 *  - tls_erzwingen (Task 8): network.forceencryption 1 nur mit eingespieltem TLS, Zertifikatsprüfung an und fehlerfreiem Pacemaker auf
 *    diesem Knoten (PY_PM_PRUEFUNG aus linux-ha.ts); KEIN Neustart; an=false = Rückweg (ohne Vorbedingung).
 *
 * Der private Schlüssel erscheint nie in Ergebnis, Log, Fehlertext oder Tresor: auf ihn laufen nur `openssl rsa -noout -modulus` und
 * `openssl pkey -pubout` (öffentlicher Teil); die Eingabe-Prüfung weist jeden „PRIVATE“-Block zurück.
 */
import { X509Certificate, createHash } from 'node:crypto';
import { registriereLinuxBaustein } from '../fernzugriff/linux-bausteine.js';
import {
  LINUX_SQL_BAUSTEINE, PY_CONF, shQ, sqlKopf, AD_DOMAENE_LINUX, SQL_HILFE, SA_LESEN, TLS_PRUEF_SCHALTER,
  TLS_SECRETS, TLS_CRT, TLS_KEY, TLS_KEY_NEU, TLS_CA_ORDNER, TLS_CA_ROOT, TLS_CA_ISSUING, TLS_MANIFEST, TLS_MANIFEST_KOPF, TLS_PROTOKOLLE,
} from './linux-sql.js';
import { MSSQL_CONF_PROGRAMM, MSSQL_CONF_DATEI } from './linux-sql-ad.js';
import { linuxTlsSans } from './windows-sqltls-linux.js';
import { HA_CRM_FEHLER_ARGS, PY_PM_PRUEFUNG } from './linux-ha.js';

export { TLS_PRUEF_SCHALTER, TLS_SECRETS, TLS_CRT, TLS_KEY, TLS_KEY_NEU, TLS_CA_ORDNER, TLS_CA_ROOT, TLS_CA_ISSUING, TLS_MANIFEST, TLS_MANIFEST_KOPF, TLS_PROTOKOLLE };

export const TLS_BITS = 3072;
/** Mindest-Restlaufzeit beim Einspielen (Tage) */
export const TLS_MIN_TAGE = 30;
/** Vertrauensspeicher von Ubuntu (update-ca-certificates) */
export const TLS_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
/** Hosts mit TLS (Global Constraints: auch der Konfig-Knoten) */
export const TLS_HOSTS: readonly string[] = ['sqllnx01', 'sqllnx02', 'sqllnxcfg'];
/**
 * Ruling R20 — Eigentum von network.forceencryption 1: tls_erzwingen schreibt diese Datei (root 0600, nur Kopfzeile) VOR dem Setzen;
 * tls_erzwingen an=false nimmt den Wert nur mit diesem Vermerk zurück, ein vorher (ohne Alfred) gesetztes 1 bleibt (belassen).
 */
export const TLS_ERZWUNGEN_MARKE = '/etc/alfred/sqllnx-tls-erzwungen';
export const TLS_ERZWUNGEN_KOPF = '# Alfred I8e — linux_sql tls_erzwingen hat network.forceencryption 1 gesetzt (nicht von Hand ändern)';

/**
 * tls_anfordern ändert keine Konfiguration (nur ein neuer, unbenutzter Schlüssel und die Anforderung) — kein Rückweg, nur mit genau
 * diesem Grund (change-schritte.ts OHNE_RUECKWEG_NUR_MIT_GRUND, Text gleich; ein Test hält beide gleich)
 */
export const TLS_ANFORDERN_GRUND = 'nur Schlüssel tls.key.neu und Anforderung, keine Konfiguration — tls_entfernen räumt den unbenutzten Schlüssel ab';

export interface TlsParameter { cn: string; sans: string[] }
/** Ruling R17: tls_einspielen zusätzlich mit der fest vorgegebenen Root (SHA-256 der DER) */
export interface TlsEinspielenParameter extends TlsParameter { rootSha256: string }

/** CN und SANs je Host aus linuxTlsSans (eine Quelle mit windows_pki fremd_csr_ausstellen) */
export function tlsParameter(host: string): TlsParameter {
  const h = host.trim().toLowerCase();
  const sans = linuxTlsSans(h);
  if (!sans) throw new Error(`TLS nur für ${TLS_HOSTS.join(', ')} (nicht ${host.slice(0, 40)})`);
  return { cn: `${h}.${AD_DOMAENE_LINUX}`, sans };
}

export function pruefeTls(p: unknown): string | undefined {
  const x = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const cn = typeof x.cn === 'string' ? x.cn : '';
  const host = cn.endsWith(`.${AD_DOMAENE_LINUX}`) ? cn.slice(0, -(AD_DOMAENE_LINUX.length + 1)) : '';
  const soll = linuxTlsSans(host);
  if (!soll) return `cn: ${TLS_HOSTS.map(h => `${h}.${AD_DOMAENE_LINUX}`).join(', ')}`;
  if (!Array.isArray(x.sans) || x.sans.length !== soll.length || x.sans.some((s, i) => s !== soll[i])) return `sans: genau ${soll.join(', ')}`;
  return undefined;
}

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+?)-----END CERTIFICATE-----/g;
const STRIKT_B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const pem = (der: Buffer) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;

/** DER-Zertifikate aus PEM-Text (genau `anzahl` Blöcke, nichts daneben, nie „PRIVATE“) */
function pemBloecke(feld: string, v: unknown, anzahl: number): Buffer[] {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${feld}: PEM fehlt`);
  if (v.length > 65_536) throw new Error(`${feld}: größer als 64 KB`);
  if (/PRIVATE/i.test(v)) throw new Error(`${feld}: enthält einen privaten Schlüssel — abgewiesen`);
  if (v.replace(PEM_BLOCK, '').trim()) throw new Error(`${feld}: Text außerhalb der Zertifikatsblöcke`);
  const bl = [...v.matchAll(PEM_BLOCK)].map(m => Buffer.from(m[1]!.replace(/\s/g, ''), 'base64'));
  if (bl.length !== anzahl) throw new Error(`${feld}: ${bl.length} Zertifikatsblöcke, erwartet ${anzahl}`);
  return bl;
}
function derAusBase64(feld: string, v: unknown): Buffer {
  if (typeof v !== 'string' || v.length < 100 || v.length > 65_536 || !STRIKT_B64.test(v)) throw new Error(`${feld}: DER-Zertifikat als Base64 (eine Zeile)`);
  return Buffer.from(v, 'base64');
}

export interface TlsEingabe { zertifikat: string; kette: string; thumbprint: string; rootSha256: string }
/**
 * Eingabe von tls_einspielen: `zertifikat` + `kette` (PEM, Kette = Issuing-CA und Root) ODER `zert_base64` + `issuing_base64` +
 * `root_base64` (DER, je ein Zertifikat — die Form, die Change-Verweise als ganzen Wert tragen). Mit Node geprüft: Root selbstsigniert,
 * Issuing von der Root, Zertifikat von der Issuing-CA. Liefert PEM für stdin und den SHA-1-Thumbprint zum Gegenprüfen des Ergebnisses.
 */
export function tlsEingabe(input: Record<string, unknown>): TlsEingabe {
  let zert: Buffer; let kette: Buffer[];
  const b64 = ['zert_base64', 'issuing_base64', 'root_base64'].filter(k => input[k] !== undefined);
  if (b64.length) {
    if (b64.length !== 3) throw new Error('zert_base64, issuing_base64 und root_base64 nur zusammen');
    if (input.zertifikat !== undefined || input.kette !== undefined) throw new Error('entweder zertifikat + kette (PEM) oder zert_base64 + issuing_base64 + root_base64');
    zert = derAusBase64('zert_base64', input.zert_base64);
    kette = [derAusBase64('issuing_base64', input.issuing_base64), derAusBase64('root_base64', input.root_base64)];
  } else {
    zert = pemBloecke('zertifikat', input.zertifikat, 1)[0]!;
    kette = pemBloecke('kette', input.kette, 2);
  }
  let x: X509Certificate; let k: X509Certificate[];
  try { x = new X509Certificate(zert); k = kette.map(d => new X509Certificate(d)); } catch { throw new Error('zertifikat/kette: kein lesbares X.509-Zertifikat'); }
  const root = k.find(c => c.subject === c.issuer && c.verify(c.publicKey));
  const iss = k.find(c => c !== root);
  if (!root || !iss) throw new Error('kette: erwartet Issuing-CA und Root (selbstsigniert)');
  if (!iss.checkIssued(root) || !iss.verify(root.publicKey)) throw new Error('kette: Issuing-CA ist nicht von der Root ausgestellt');
  if (!x.checkIssued(iss) || !x.verify(iss.publicKey)) throw new Error('zertifikat: nicht von der Issuing-CA der Kette ausgestellt');
  // Ruling R17: die Root ist fest vorgegeben (SHA-256 der DER) — eine andere selbstsignierte Root wird nie systemweit vertraut
  const soll = erwarteteRoot(input.erwartet_root_sha256);
  const ist = createHash('sha256').update(Buffer.from(root.raw)).digest('hex');
  if (ist !== soll) throw new Error(`kette: Root mit SHA-256 ${ist} statt erwartet ${soll} — nichts eingespielt`);
  return { zertifikat: pem(Buffer.from(x.raw)), kette: pem(Buffer.from(iss.raw)) + pem(Buffer.from(root.raw)), thumbprint: x.fingerprint.replace(/:/g, '').toUpperCase(), rootSha256: soll };
}

/** Ruling R17 — erwartet_root_sha256: Pflicht, fester Wert (kein Verweis), 64 Hex = SHA-256 der Root-DER */
export function erwarteteRoot(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error('erwartet_root_sha256: SHA-256 (64 Hex) der DER der AD3033-Root als fester Wert — Pflicht für tls_einspielen');
  return s;
}

/** Bash-Text mit „§{“ statt „${“ (String.raw ohne Escape-Salat, wie linux-sql-ad.ts) */
const sh = (s: string) => s.replaceAll('§{', '${');
/** Stubs für Tests setzen hier ein (nach allen Hilfsfunktionen und Pfaden, vor dem Ablauf) */
const MARKE = '# ALFRED-ABLAUF';

/**
 * python3: stdin = Eingabe-JSON { zertifikat, kette }; schreibt zert.pem, kette1.pem, kette2.pem (normalisiert, LF) nach argv[1].
 * Genau ein Zertifikat bzw. genau zwei in der Kette, nur CERTIFICATE-Blöcke, kein Text daneben, höchstens 64 KB, nie „PRIVATE“.
 * Meldungen nennen nie den Inhalt.
 */
export const PY_TLS_EINGABE = String.raw`import base64, json, os, re, sys
BLOCK = re.compile(r"-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+?)-----END CERTIFICATE-----")
def fehler(t):
    sys.stderr.write(t + "\n")
    sys.exit(2)
try:
    d = json.loads(sys.stdin.read() or "{}")
except Exception:
    fehler("Eingabe ist kein JSON")
if not isinstance(d, dict):
    fehler("Eingabe ist kein JSON-Objekt")
def bloecke(name, anzahl):
    v = d.get(name)
    if not isinstance(v, str) or not v.strip():
        fehler(name + " fehlt (PEM)")
    if len(v) > 65536:
        fehler(name + " ist größer als 64 KB")
    if "PRIVATE" in v.upper():
        fehler(name + " enthält einen privaten Schlüssel — abgewiesen")
    funde = list(BLOCK.finditer(v))
    if BLOCK.sub("", v).strip():
        fehler(name + ": Text außerhalb der Zertifikatsblöcke")
    if len(funde) != anzahl:
        fehler(name + ": %d Zertifikatsblöcke, erwartet %d" % (len(funde), anzahl))
    aus = []
    for m in funde:
        try:
            der = base64.b64decode(re.sub(r"\s", "", m.group(1)), validate=True)
        except Exception:
            fehler(name + ": kein gültiges Base64")
        if len(der) < 64 or der[0] != 0x30:
            fehler(name + ": keine DER-Struktur")
        t = base64.b64encode(der).decode()
        aus.append("-----BEGIN CERTIFICATE-----\n" + "\n".join(t[i:i + 64] for i in range(0, len(t), 64)) + "\n-----END CERTIFICATE-----\n")
    return aus
z = bloecke("zertifikat", 1)
k = bloecke("kette", 2)
for n, inhalt in (("zert.pem", z[0]), ("kette1.pem", k[0]), ("kette2.pem", k[1])):
    with open(os.path.join(sys.argv[1], n), "w", newline="\n") as f:
        f.write(inhalt)`;

function werte(p?: TlsParameter): string[] {
  return [
    'TMP_BASIS=/run',
    `SECRETS=${shQ(TLS_SECRETS)}`,
    `CRT=${shQ(TLS_CRT)}`,
    `KEY=${shQ(TLS_KEY)}`,
    `KEY_NEU=${shQ(TLS_KEY_NEU)}`,
    `CA_DIR=${shQ(TLS_CA_ORDNER)}`,
    `CA_ROOT=${shQ(TLS_CA_ROOT)}`,
    `CA_ISS=${shQ(TLS_CA_ISSUING)}`,
    `CA_BUNDLE=${shQ(TLS_CA_BUNDLE)}`,
    `MANIFEST=${shQ(TLS_MANIFEST)}`,
    `MANIFEST_KOPF=${shQ(TLS_MANIFEST_KOPF)}`,
    `PROTOKOLLE=${shQ(TLS_PROTOKOLLE)}`,
    `BITS=${TLS_BITS}`,
    `MIN_TAGE=${TLS_MIN_TAGE}`,
    `MSSQLCONF=${shQ(MSSQL_CONF_PROGRAMM)}`,
    `MSSQL_CONF=${shQ(MSSQL_CONF_DATEI)}`,
    `PY_CONF=${shQ(PY_CONF)}`,
    // Task 7: Schalter der Zertifikatsprüfung (gleicher Name wie in SQL_HILFE)
    `TLS_SCHALTER=${shQ(TLS_PRUEF_SCHALTER)}`,
    ...(p ? [
      `CN=${shQ(p.cn)}`,
      `SANS=(${p.sans.map(shQ).join(' ')})`,
      `SAN_CNF=${shQ(p.sans.map(s => `DNS:${s}`).join(','))}`,
      `SANS_JSON=${shQ(JSON.stringify(p.sans))}`,
    ] : []),
  ];
}

const HILFEN = sh(String.raw`paket_version() { dpkg-query -W -f='§{Status}|§{Version}' "$1" 2>/dev/null | awk -F'|' '$1 ~ / ok installed$/ { print $2 }' || true; }
kurz() { printf "%s" "$1" | tail -n 6 | tr "\r\n" "  "; }
GEAENDERT=0; AJ=''; SQL_AEND=0
aend() { GEAENDERT=1; AJ+="§{AJ:+,}\"$1\""; }
lies() { python3 -c "$PY_CONF" "$1" "$2"; }
rechte() { stat -c '%a %U %G' "$1" 2>/dev/null || true; }
# nur öffentliche Teile: Modulus (Zertifikat/Anforderung/Schlüssel) und Schlüssellänge über den öffentlichen Schlüssel — nie -text auf
# den privaten Schlüssel; pipefail: jede Stufe mit „|| true“, erst lesen, dann suchen
mod_zert() { { openssl x509 -noout -modulus -in "$1" 2>/dev/null || true; } | sed -n 's/^Modulus=//p'; }
mod_req() { { openssl req -noout -modulus -in "$1" 2>/dev/null || true; } | sed -n 's/^Modulus=//p'; }
mod_key() { { openssl rsa -noout -modulus -in "$1" 2>/dev/null || true; } | sed -n 's/^Modulus=//p'; }
bits_key() { { openssl pkey -in "$1" -pubout 2>/dev/null || true; } | { openssl pkey -pubin -noout -text 2>/dev/null || true; } | sed -n 's/.*Public-Key: (\([0-9]*\) bit).*/\1/p' | sed -n 1p; }
bits_zert() { { openssl x509 -noout -text -in "$1" 2>/dev/null || true; } | sed -n 's/.*Public-Key: (\([0-9]*\) bit).*/\1/p' | sed -n 1p; }
schluessel_ok() { [ -n "$(mod_key "$1")" ] && [ "$(bits_key "$1")" = "$BITS" ]; }
sha() { sha256sum -- "$1" | awk '{ print $1 }'; }
SAN_SOLL=$(printf 'dns:%s\n' "§{SANS[@]:-}" | tr 'A-Z' 'a-z' | sort)
# SAN-Liste (klein, sortiert, je Zeile „dns:<name>“; andere Typen bleiben sichtbar und passen nie)
san_liste() { tr -d ' \r' | tr ',' '\n' | sed '/^$/d' | tr 'A-Z' 'a-z' | sort; }
san_zert() { { openssl x509 -noout -ext subjectAltName -in "$1" 2>/dev/null || true; } | sed -n '2,$p' | san_liste; }
san_req() { { openssl req -noout -text -in "$1" 2>/dev/null || true; } | awk '/X509v3 Subject Alternative Name/ { getline; print; exit }' | san_liste; }
manifest_eigen() { [ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] && [ "$(head -n 1 "$MANIFEST")" = "$MANIFEST_KOPF" ] && [ "$(rechte "$MANIFEST")" = '600 root root' ]; }
# 0 = Datei gehört Alfred: reguläre Datei, im Manifest mit genau diesem SHA-256 (eine Zeile „<sha256>  <pfad>“)
alfreds() {
  { [ -f "$1" ] && [ ! -L "$1" ]; } || return 1
  manifest_eigen || return 1
  local s; s=$(sha "$1")
  awk -v p="$1" -v s="$s" 'NR > 1 && $1 == s && $2 == p { f = 1 } END { exit !f }' "$MANIFEST"
}
WEG=()
# Zwischendatei im Zielordner (gleiches Dateisystem), Besitzer und Rechte vor dem Inhalt; $1 Ziel, $2 Quelle, $3 Modus, $4 Besitzer
vorbereiten() { local t; t=$(mktemp "$(dirname "$1")/.alfred-tls-XXXXXX"); WEG+=("$t"); chown "$4" "$t"; chmod "$3" "$t"; cat -- "$2" >"$t"; ZW=$t; }
schreibe() { vorbereiten "$@"; mv -f -- "$ZW" "$1"; }
alfred_aufraeumen() {
  local w; for w in "§{WEG[@]:-}"; do [ -z "$w" ] || rm -f -- "$w"; done
  [ -z "§{NEU_DIR:-}" ] || rm -rf -- "$NEU_DIR"
}
BELASSEN=''
belassen() { BELASSEN+="§{BELASSEN:+,}$(printf '%s' "$1" | json_text)"; }`);

// ── tls_anfordern ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const ANFORDERN_KOERPER = sh(String.raw`# ── Phase 1: prüfen — bis hierhin wird nichts geändert ──
[ -n "$(paket_version mssql-server)" ] || abbruch "mssql-server ist nicht installiert — nichts geändert"
id mssql >/dev/null 2>&1 || abbruch "Benutzer mssql fehlt — nichts geändert"
for b in openssl sha256sum base64; do command -v "$b" >/dev/null 2>&1 || abbruch "$b fehlt — nichts geändert"; done
SCHL_NEU=false
if [ -e "$KEY_NEU" ] || [ -L "$KEY_NEU" ]; then
  # ein unbenutzter Schlüssel aus einem früheren Lauf: nur, wenn er Alfreds Form hat (Rechte, RSA 3072) — sonst nichts anfassen
  { [ -f "$KEY_NEU" ] && [ ! -L "$KEY_NEU" ]; } || abbruch "$KEY_NEU ist keine reguläre Datei — nichts geändert"
  [ "$(rechte "$KEY_NEU")" = '400 mssql mssql' ] || abbruch "$KEY_NEU hat Rechte $(rechte "$KEY_NEU") statt 400 mssql mssql — nicht von Alfred? Nichts geändert"
  schluessel_ok "$KEY_NEU" || abbruch "$KEY_NEU ist kein RSA-$BITS-Schlüssel — nichts geändert (tls_entfernen entfernt ihn)"
fi
ALFRED_TMP=$(mktemp -d "$TMP_BASIS/alfred-tls.XXXXXX"); chmod 0700 "$ALFRED_TMP"
# ── Phase 2: Schlüssel nur, wenn keiner wartet (entsteht in einem eigenen Ordner neben dem Ziel, 0400 mssql:mssql vor dem mv) ──
if [ ! -e "$KEY_NEU" ]; then
  if [ ! -d "$SECRETS" ]; then mkdir -p "$SECRETS"; chown mssql:mssql "$SECRETS"; chmod 0700 "$SECRETS"; aend secrets-ordner; fi
  NEU_DIR=$(mktemp -d "$SECRETS/.alfred-tls-XXXXXX")
  ( umask 077; openssl genpkey -algorithm RSA -pkeyopt "rsa_keygen_bits:$BITS" -out "$NEU_DIR/tls.key" >"$ALFRED_TMP/gen.log" 2>&1 ) || abbruch "openssl genpkey fehlgeschlagen: $(kurz "$(cat "$ALFRED_TMP/gen.log")") — nichts geändert"
  chown mssql:mssql "$NEU_DIR/tls.key"; chmod 0400 "$NEU_DIR/tls.key"
  schluessel_ok "$NEU_DIR/tls.key" || abbruch "Selbstprüfung: neuer Schlüssel ist kein RSA-$BITS — nichts geändert"
  mv -f -- "$NEU_DIR/tls.key" "$KEY_NEU"
  rm -rf -- "$NEU_DIR"; NEU_DIR=''
  aend schluessel-neu; SCHL_NEU=true
fi
# ── Phase 3: Anforderung (öffentlich; aus demselben Schlüssel und Namen immer dieselbe — wiederholbar) ──
printf '[req]\ndistinguished_name = dn\nprompt = no\nreq_extensions = ext\n[dn]\nCN = %s\n[ext]\nsubjectAltName = %s\n' "$CN" "$SAN_CNF" >"$ALFRED_TMP/req.cnf"
CSR="$ALFRED_TMP/anforderung.pem"
openssl req -new -sha256 -key "$KEY_NEU" -config "$ALFRED_TMP/req.cnf" -out "$CSR" >"$ALFRED_TMP/req.log" 2>&1 || abbruch "openssl req fehlgeschlagen: $(kurz "$(cat "$ALFRED_TMP/req.log")")"
# ── Selbstprüfung der Anforderung ──
openssl req -noout -verify -in "$CSR" >/dev/null 2>&1 || abbruch "Selbstprüfung: Signatur der Anforderung ungültig"
[ "$(mod_req "$CSR")" = "$(mod_key "$KEY_NEU")" ] || abbruch "Selbstprüfung: Anforderung gehört nicht zu $KEY_NEU"
S=$({ openssl req -noout -subject -nameopt RFC2253 -in "$CSR" 2>/dev/null || true; } | tr -d '\r')
[ "$S" = "subject=CN=$CN" ] || abbruch "Selbstprüfung: Subject der Anforderung $S statt CN=$CN"
[ "$(san_req "$CSR")" = "$SAN_SOLL" ] || abbruch "Selbstprüfung: SANs der Anforderung $(san_req "$CSR" | tr '\n' ' ') statt §{SANS[*]}"
grep -q 'PRIVATE' "$CSR" && abbruch "Selbstprüfung: Anforderung enthält einen privaten Block"
openssl req -in "$CSR" -outform DER -out "$ALFRED_TMP/anforderung.der" >/dev/null 2>&1 || abbruch "Anforderung nicht als DER lesbar"
SHA=$(sha "$ALFRED_TMP/anforderung.der")
B64=$(base64 -w0 <"$ALFRED_TMP/anforderung.der")
PEM=$(json_text <"$CSR")
if [ "$GEAENDERT" = 1 ]; then Z=geaendert; else Z=schon; fi
ergebnis "{\"zustand\":\"$Z\",\"cn\":\"$CN\",\"sans\":$SANS_JSON,\"bits\":$BITS,\"schluessel\":\"$KEY_NEU\",\"schluesselNeu\":$SCHL_NEU,\"csrPem\":$PEM,\"csrSha256\":\"$SHA\",\"csrBase64\":\"$B64\",\"aenderungen\":[$AJ]}"`);

/**
 * Schlüssel (falls kein unbenutzter `tls.key.neu` existiert) und Anforderung auf dem Host. Ergebnis { zustand, cn, sans, bits,
 * schluessel, schluesselNeu, csrPem, csrSha256, csrBase64, aenderungen } — nur Öffentliches. Zeit: LINUX_SQL_ZEIT_MS.tlsAnfordern
 */
export function tlsAnfordernSkript(p: TlsParameter): string {
  const f = pruefeTls(p); if (f) throw new Error(f);
  return [
    ...sqlKopf(LINUX_SQL_BAUSTEINE.tlsAnfordern, { cn: p.cn, sans: [...p.sans] }),
    ...werte(p),
    HILFEN,
    MARKE,
    ANFORDERN_KOERPER,
  ].join('\n');
}

// ── tls_einspielen ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const EINSPIELEN_KOERPER = sh(String.raw`# ── Phase 1: prüfen — bis hierhin wird nichts geändert (Review Focus 4: jede Abweichung → Abbruch, alte Konfiguration bleibt) ──
[ -n "$(paket_version mssql-server)" ] || abbruch "mssql-server ist nicht installiert — nichts geändert"
[ -x "$MSSQLCONF" ] || abbruch "$MSSQLCONF fehlt — nichts geändert"
id mssql >/dev/null 2>&1 || abbruch "Benutzer mssql fehlt — nichts geändert"
for b in openssl sha256sum update-ca-certificates; do command -v "$b" >/dev/null 2>&1 || abbruch "$b fehlt — nichts geändert"; done
ALFRED_TMP=$(mktemp -d "$TMP_BASIS/alfred-tls.XXXXXX"); chmod 0700 "$ALFRED_TMP"
python3 -c "$PY_TLS_EINGABE" "$ALFRED_TMP" <<<"$ALFRED_EINGABE" >"$ALFRED_TMP/eingabe.log" 2>&1 || abbruch "Eingabe abgewiesen: $(kurz "$(cat "$ALFRED_TMP/eingabe.log")") — nichts geändert"
Z="$ALFRED_TMP/zert.pem"
ROOT=''; ISS=''
for k in "$ALFRED_TMP/kette1.pem" "$ALFRED_TMP/kette2.pem"; do
  sh_=$({ openssl x509 -noout -subject_hash -in "$k" 2>/dev/null || true; } | tr -d '\r'); ih=$({ openssl x509 -noout -issuer_hash -in "$k" 2>/dev/null || true; } | tr -d '\r')
  [ -n "$sh_" ] || abbruch "Kette: Zertifikat nicht lesbar — nichts geändert"
  if [ "$sh_" = "$ih" ]; then [ -z "$ROOT" ] || abbruch "Kette: zwei selbstsignierte Zertifikate, erwartet Issuing-CA und Root — nichts geändert"; ROOT=$k
  else [ -z "$ISS" ] || abbruch "Kette: keine Root (selbstsigniert), erwartet Issuing-CA und Root — nichts geändert"; ISS=$k; fi
done
# Ruling R17: nur die fest vorgegebene Root (SHA-256 der DER)
openssl x509 -in "$ROOT" -outform DER -out "$ALFRED_TMP/root.der" >/dev/null 2>&1 || abbruch "Kette: Root nicht lesbar — nichts geändert"
RS=$(sha "$ALFRED_TMP/root.der")
[ "$RS" = "$ROOT_SHA" ] || abbruch "Kette: Root mit SHA-256 $RS statt erwartet $ROOT_SHA — nichts geändert"
a=$(openssl verify -CAfile "$ROOT" "$ISS" 2>&1) || abbruch "Kette: Issuing-CA ist nicht von der Root ausgestellt ($(kurz "$a")) — nichts geändert"
a=$(openssl verify -purpose sslserver -CAfile "$ROOT" -untrusted "$ISS" "$Z" 2>&1) || abbruch "Zertifikat: nicht über Issuing-CA bis zur Root prüfbar oder nicht für Server-Authentifizierung ($(kurz "$a")) — nichts geändert"
MZ=$(mod_zert "$Z")
[ -n "$MZ" ] || abbruch "Zertifikat ohne RSA-Schlüssel oder nicht lesbar — nichts geändert"
QUELLE=''
if [ -f "$KEY_NEU" ] && [ "$(mod_key "$KEY_NEU")" = "$MZ" ]; then QUELLE=neu
elif [ -f "$KEY" ] && [ "$(mod_key "$KEY")" = "$MZ" ]; then QUELLE=aktiv
else abbruch "Zertifikat passt nicht zum Schlüssel auf dem Host ($KEY_NEU bzw. $KEY) — falsche Antwort oder alte Anforderung? Nichts geändert, bisherige TLS-Konfiguration bleibt"; fi
if [ "$QUELLE" = neu ]; then
  [ "$(rechte "$KEY_NEU")" = '400 mssql mssql' ] || abbruch "$KEY_NEU hat Rechte $(rechte "$KEY_NEU") statt 400 mssql mssql — nichts geändert"
  SCHL_QUELLE=$KEY_NEU
else SCHL_QUELLE=$KEY; fi
[ "$(bits_zert "$Z")" = "$BITS" ] || abbruch "Zertifikat mit $(bits_zert "$Z")-Bit-Schlüssel statt RSA $BITS — nichts geändert"
S=$({ openssl x509 -noout -subject -nameopt RFC2253 -in "$Z" 2>/dev/null || true; } | tr -d '\r')
[ "$S" = "subject=CN=$CN" ] || abbruch "Zertifikat: $S statt CN=$CN — nichts geändert"
SAN_IST=$(san_zert "$Z")
[ "$SAN_IST" = "$SAN_SOLL" ] || abbruch "Zertifikat: SANs $(printf '%s' "$SAN_IST" | tr '\n' ' ')statt genau §{SANS[*]} — nichts geändert"
ENDE=$({ openssl x509 -noout -enddate -in "$Z" 2>/dev/null || true; } | sed -n 's/^notAfter=//p' | tr -d '\r')
BIS_S=$(date -u -d "$ENDE" +%s 2>/dev/null || true)
[[ "$BIS_S" =~ ^[0-9]+$ ]] || abbruch "Ablaufdatum des Zertifikats nicht lesbar ($ENDE) — nichts geändert"
BIS=$(date -u -d "@$BIS_S" +%Y-%m-%dT%H:%M:%SZ); REST=$(( (BIS_S - $(date -u +%s)) / 86400 ))
openssl x509 -noout -checkend $(( MIN_TAGE * 86400 )) -in "$Z" >/dev/null 2>&1 || abbruch "Zertifikat läuft in weniger als $MIN_TAGE Tagen ab (gültig bis $BIS) — nichts geändert"
TP=$({ openssl x509 -noout -fingerprint -sha1 -in "$Z" 2>/dev/null || true; } | sed -n 's/^[^=]*=//p' | tr -d ':\r' | tr 'a-f' 'A-F')
[[ "$TP" =~ ^[0-9A-F]{40}$ ]] || abbruch "Thumbprint des Zertifikats nicht lesbar — nichts geändert"
# fremde Konfiguration oder Dateien → nichts anfassen
for kv in "tlscert=$CRT" "tlskey=$KEY"; do
  k=§{kv%%=*}; s=§{kv#*=}; v=$(lies network "$k")
  [ -z "$v" ] || [ "$v" = "$s" ] || abbruch "mssql.conf network.$k = $v (nicht Alfreds Pfad $s) — fremde TLS-Konfiguration, nichts geändert"
done
if [ -e "$MANIFEST" ] || [ -L "$MANIFEST" ]; then manifest_eigen || abbruch "$MANIFEST ist vorhanden und nicht von Alfred — nichts geändert"; fi
# $1 Ziel, $2 neuer Inhalt (leer = wird ersetzt): vorhanden und weder gleich noch Alfreds (Manifest) → Abbruch
fremd_pruefen() {
  { [ -e "$1" ] || [ -L "$1" ]; } || return 0
  { [ -f "$1" ] && [ ! -L "$1" ]; } || abbruch "$1 ist keine reguläre Datei — nichts geändert"
  if [ -n "$2" ] && cmp -s -- "$1" "$2"; then return 0; fi
  alfreds "$1" || abbruch "$1 ist vorhanden und nicht von Alfred (nicht mit diesem Inhalt im Manifest $MANIFEST) — nichts geändert"
}
# Ruling R17: eine vorhandene Root wird nie ersetzt (auch nicht Alfreds) — eine andere Root ist ein eigener Vorgang
if [ -e "$CA_ROOT" ] || [ -L "$CA_ROOT" ]; then
  { [ -f "$CA_ROOT" ] && [ ! -L "$CA_ROOT" ]; } || abbruch "$CA_ROOT ist keine reguläre Datei — nichts geändert"
  cmp -s -- "$CA_ROOT" "$ROOT" || abbruch "Root weicht von der eingespielten ab ($CA_ROOT) — nichts geändert"
fi
fremd_pruefen "$CA_ISS" "$ISS"
fremd_pruefen "$CRT" "$Z"
if [ "$QUELLE" = neu ]; then fremd_pruefen "$KEY" ''; fi
# ── Phase 2: Manifest zuerst (SHA-256 der Inhalte, die gleich an den Zielen stehen; Zeilen noch vorhandener alter Alfred-Dateien
# bleiben bis zum Ende) — so entfernt tls_entfernen auch nach einem Abbruch mitten im Einspielen genau Alfreds Dateien ──
printf '%s\n%s  %s\n%s  %s\n%s  %s\n%s  %s\n' "$MANIFEST_KOPF" "$(sha "$Z")" "$CRT" "$(sha "$SCHL_QUELLE")" "$KEY" "$(sha "$ROOT")" "$CA_ROOT" "$(sha "$ISS")" "$CA_ISS" >"$ALFRED_TMP/manifest"
cp -- "$ALFRED_TMP/manifest" "$ALFRED_TMP/manifest-lauf"
for f in "$CRT" "$KEY" "$CA_ROOT" "$CA_ISS"; do if alfreds "$f"; then printf '%s  %s\n' "$(sha "$f")" "$f" >>"$ALFRED_TMP/manifest-lauf"; fi; done
awk '!d[$0]++' "$ALFRED_TMP/manifest-lauf" >"$ALFRED_TMP/manifest-lauf2"
manifest_setzen() {
  if manifest_eigen && cmp -s -- "$1" "$MANIFEST"; then return 0; fi
  [ -d "§{MANIFEST%/*}" ] || { mkdir -p "§{MANIFEST%/*}"; chmod 0755 "§{MANIFEST%/*}"; }
  schreibe "$MANIFEST" "$1" 0600 root:root; MANIFEST_AEND=1
}
MANIFEST_AEND=0
manifest_setzen "$ALFRED_TMP/manifest-lauf2"
# ── Phase 3: Vertrauen (CA-Dateien, update-ca-certificates) ──
[ -d "$CA_DIR" ] || { mkdir -p "$CA_DIR"; chmod 0755 "$CA_DIR"; }
CA_NEU=0
if ! cmp -s -- "$ROOT" "$CA_ROOT"; then schreibe "$CA_ROOT" "$ROOT" 0644 root:root; aend ca-root; CA_NEU=1; fi
if ! cmp -s -- "$ISS" "$CA_ISS"; then schreibe "$CA_ISS" "$ISS" 0644 root:root; aend ca-issuing; CA_NEU=1; fi
vertraut() { openssl verify -purpose sslserver -CAfile "$CA_BUNDLE" -untrusted "$CA_ISS" "$Z" >/dev/null 2>&1; }
if [ "$CA_NEU" = 1 ] || ! vertraut; then
  a=$(update-ca-certificates 2>&1) || abbruch "update-ca-certificates fehlgeschlagen: $(kurz "$a") — Zertifikat nicht eingespielt (Rückweg tls_entfernen)"
  aend vertrauensspeicher
fi
vertraut || abbruch "Selbstprüfung: Zertifikat gegen den Vertrauensspeicher $CA_BUNDLE nicht prüfbar — Zertifikat nicht eingespielt (Rückweg tls_entfernen)"
# ── Phase 4: Zertifikat und Schlüssel (Zertifikat zuerst als Zwischendatei, dann Schlüssel und Zertifikat je per mv) ──
if [ ! -d "$SECRETS" ]; then mkdir -p "$SECRETS"; chown mssql:mssql "$SECRETS"; chmod 0700 "$SECRETS"; aend secrets-ordner; fi
CRT_ZW=''
if ! cmp -s -- "$Z" "$CRT"; then vorbereiten "$CRT" "$Z" 0444 mssql:mssql; CRT_ZW=$ZW; fi
# Fix-Runde 1: scheitert das zweite mv, kommen der neue Schlüssel nach .neu und der alte (Kopie im privaten Lauf-Ordner) zurück
KEY_ALT=''
if [ "$QUELLE" = neu ]; then
  if [ -f "$KEY" ]; then KEY_ALT="$ALFRED_TMP/tls.key.alt"; cp -p -- "$KEY" "$KEY_ALT"; fi
  mv -f -- "$KEY_NEU" "$KEY"; aend schluessel; SQL_AEND=1
fi
if [ -n "$CRT_ZW" ]; then
  if ! mv -f -- "$CRT_ZW" "$CRT"; then
    if [ "$QUELLE" = neu ]; then
      mv -f -- "$KEY" "$KEY_NEU" || abbruch "$CRT nicht ersetzt und Schlüssel nicht zurückgestellt — Rückweg tls_entfernen"
      if [ -n "$KEY_ALT" ]; then { vorbereiten "$KEY" "$KEY_ALT" 0400 mssql:mssql && mv -f -- "$ZW" "$KEY"; } || abbruch "$CRT nicht ersetzt, alter Schlüssel nicht zurückgestellt — Rückweg tls_entfernen"; fi
    fi
    abbruch "$CRT nicht ersetzt — Schlüssel zurückgestellt ($KEY_NEU wartet weiter), Zertifikat und Schlüssel unverändert; CA-Dateien/Manifest ggf. schon geschrieben (Rückweg tls_entfernen)"
  fi
  aend zertifikat; SQL_AEND=1
fi
if [ "$(rechte "$KEY")" != '400 mssql mssql' ]; then chown mssql:mssql "$KEY"; chmod 0400 "$KEY"; aend schluessel-rechte; SQL_AEND=1; fi
if [ "$(rechte "$CRT")" != '444 mssql mssql' ]; then chown mssql:mssql "$CRT"; chmod 0444 "$CRT"; aend zertifikat-rechte; SQL_AEND=1; fi
# ── Phase 5: mssql-conf (nur bei Abweichung; wirkt erst nach dem Neustart — der läuft rollierend per Change, nicht hier) ──
setze_conf() {
  [ "$(lies network "$1")" != "$2" ] || return 0
  local aus; aus=$("$MSSQLCONF" set "network.$1" "$2" 2>&1) || abbruch "mssql-conf set network.$1 fehlgeschlagen: $(kurz "$aus") — Rückweg tls_entfernen"
  aend "mssql-conf:$1"; SQL_AEND=1
}
setze_conf tlscert "$CRT"
setze_conf tlskey "$KEY"
setze_conf tlsprotocols "$PROTOKOLLE"
# ── Selbstprüfung ──
cmp -s -- "$Z" "$CRT" || abbruch "Selbstprüfung: $CRT ist nicht das geprüfte Zertifikat"
[ "$(mod_key "$KEY")" = "$MZ" ] || abbruch "Selbstprüfung: $KEY passt nicht zu $CRT"
[ "$(rechte "$KEY")" = '400 mssql mssql' ] || abbruch "Selbstprüfung: $KEY ist nicht 0400 mssql:mssql"
[ "$(rechte "$CRT")" = '444 mssql mssql' ] || abbruch "Selbstprüfung: $CRT ist nicht 0444 mssql:mssql"
cmp -s -- "$ROOT" "$CA_ROOT" && cmp -s -- "$ISS" "$CA_ISS" || abbruch "Selbstprüfung: CA-Dateien weichen ab"
vertraut || abbruch "Selbstprüfung: Zertifikat gegen den Vertrauensspeicher nicht prüfbar"
for kv in "tlscert=$CRT" "tlskey=$KEY" "tlsprotocols=$PROTOKOLLE"; do
  k=§{kv%%=*}; s=§{kv#*=}; [ "$(lies network "$k")" = "$s" ] || abbruch "Selbstprüfung: mssql.conf network.$k ist nicht $s"
done
# Manifest jetzt nur mit den eingespielten Dateien
manifest_setzen "$ALFRED_TMP/manifest"
[ "$MANIFEST_AEND" = 0 ] || aend manifest
for f in "$CRT" "$KEY" "$CA_ROOT" "$CA_ISS"; do alfreds "$f" || abbruch "Selbstprüfung: $f steht nicht mit diesem Inhalt im Manifest $MANIFEST"; done
# 0 = SQL Server muss neu starten: in diesem Lauf an Schlüssel/Zertifikat/mssql.conf geändert, Dienst nicht aktiv oder Dateien jünger als der Dienststart
neustart_noetig() {
  [ "$SQL_AEND" = 0 ] || return 0
  systemctl is-active --quiet mssql-server || return 0
  local t s=0 f
  t=$(systemctl show -p ActiveEnterTimestamp --value mssql-server 2>/dev/null || true)
  if [ -n "$t" ]; then s=$(date -d "$t" +%s 2>/dev/null || echo 0); fi
  for f in "$CRT" "$KEY" "$MSSQL_CONF"; do [ ! -f "$f" ] || [ "$(stat -c %Y "$f")" -lt "$s" ] || return 0; done
  return 1
}
if neustart_noetig; then NN=true; else NN=false; fi
if [ "$GEAENDERT" = 1 ]; then ZU=geaendert; else ZU=schon; fi
ergebnis "{\"zustand\":\"$ZU\",\"cn\":\"$CN\",\"sans\":$SANS_JSON,\"bits\":$BITS,\"thumbprint\":\"$TP\",\"gueltigBis\":\"$BIS\",\"restTage\":$REST,\"schluessel\":\"$QUELLE\",\"zertifikat\":\"$CRT\",\"neustartNoetig\":$NN,\"aenderungen\":[$AJ]}"`);

/**
 * Zertifikat + Kette (stdin { zertifikat, kette }, PEM) prüfen und einspielen — siehe Dateikopf. Ergebnis { zustand, cn, sans, bits,
 * thumbprint, gueltigBis, restTage, schluessel (neu|aktiv), zertifikat, neustartNoetig, aenderungen }. Zeit: LINUX_SQL_ZEIT_MS.tlsEinspielen
 */
export function tlsEinspielenSkript(p: TlsEinspielenParameter): string {
  const f = pruefeTls(p); if (f) throw new Error(f);
  const rootSha256 = erwarteteRoot(p.rootSha256);
  return [
    ...sqlKopf(LINUX_SQL_BAUSTEINE.tlsEinspielen, { cn: p.cn, sans: [...p.sans], rootSha256 }),
    ...werte(p),
    `ROOT_SHA=${shQ(rootSha256)}`,
    `PY_TLS_EINGABE=${shQ(PY_TLS_EINGABE)}`,
    HILFEN,
    MARKE,
    EINSPIELEN_KOERPER,
  ].join('\n');
}

// ── tls_entfernen ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const ENTFERNEN_KOERPER = sh(String.raw`# ohne Zertifikat startet SQL Server mit erzwungener Verschlüsselung nicht — dann zuerst das Erzwingen zurücknehmen
if [ -x "$MSSQLCONF" ] && [ "$(lies network forceencryption)" = 1 ]; then abbruch "mssql.conf network.forceencryption = 1 — zuerst das Erzwingen zurücknehmen (ohne Zertifikat startet SQL Server nicht); nichts geändert"; fi
# Task 7: ohne Zertifikat scheiterte jede Verbindung Alfreds mit gesetztem Schalter — zuerst tls_pruefung_schalten an=false
if [ -e "$TLS_SCHALTER" ] || [ -L "$TLS_SCHALTER" ]; then abbruch "Zertifikatsprüfung ist an ($TLS_SCHALTER) — zuerst tls_pruefung_schalten an=false; nichts geändert"; fi
SQL_AEND=0; CA_WEG=0
# mssql-conf nur, wenn die Werte Alfreds sind; fremde Werte bleiben (belassen)
if [ -x "$MSSQLCONF" ]; then
  for kv in "tlscert=$CRT" "tlskey=$KEY" "tlsprotocols=$PROTOKOLLE"; do
    k=§{kv%%=*}; s=§{kv#*=}; v=$(lies network "$k")
    if [ "$v" = "$s" ]; then
      aus=$("$MSSQLCONF" unset "network.$k" 2>&1) || abbruch "mssql-conf unset network.$k fehlgeschlagen: $(kurz "$aus")"
      aend "mssql-conf:$k"; SQL_AEND=1
    elif [ -n "$v" ]; then belassen "network.$k = $v (nicht Alfreds Wert)"; fi
  done
fi
# Dateien nur mit dem SHA-256 aus Alfreds Manifest
for f in "$CRT" "$KEY" "$CA_ROOT" "$CA_ISS"; do
  { [ -e "$f" ] || [ -L "$f" ]; } || continue
  if alfreds "$f"; then
    rm -f -- "$f"; aend "entfernt:§{f##*/}"
    case "$f" in "$CA_ROOT"|"$CA_ISS") CA_WEG=1 ;; *) SQL_AEND=1 ;; esac
  else belassen "$f (nicht von Alfred oder seit dem Einspielen verändert)"; fi
done
# unbenutzter Schlüssel aus tls_anfordern (Alfreds Form: reguläre Datei, 0400 mssql:mssql)
if [ -e "$KEY_NEU" ] || [ -L "$KEY_NEU" ]; then
  if [ -f "$KEY_NEU" ] && [ ! -L "$KEY_NEU" ] && [ "$(rechte "$KEY_NEU")" = '400 mssql mssql' ]; then rm -f -- "$KEY_NEU"; aend "entfernt:§{KEY_NEU##*/}"
  else belassen "$KEY_NEU (nicht 0400 mssql:mssql)"; fi
fi
if [ "$CA_WEG" = 1 ]; then a=$(update-ca-certificates --fresh 2>&1) || abbruch "update-ca-certificates fehlgeschlagen: $(kurz "$a")"; aend vertrauensspeicher; fi
if manifest_eigen; then rm -f -- "$MANIFEST"; aend manifest; fi
# ── Selbstprüfung ──
if [ -x "$MSSQLCONF" ]; then
  [ "$(lies network tlscert)" != "$CRT" ] || abbruch "Selbstprüfung: network.tlscert zeigt noch auf $CRT"
  [ "$(lies network tlskey)" != "$KEY" ] || abbruch "Selbstprüfung: network.tlskey zeigt noch auf $KEY"
fi
[ ! -e "$MANIFEST" ] || ! manifest_eigen || abbruch "Selbstprüfung: $MANIFEST ist noch da"
if [ "$GEAENDERT" = 1 ]; then ZU=geaendert; else ZU=schon; fi
if [ "$SQL_AEND" = 1 ]; then NN=true; else NN=false; fi
ergebnis "{\"zustand\":\"$ZU\",\"belassen\":[$BELASSEN],\"neustartNoetig\":$NN,\"aenderungen\":[$AJ]}"`);

/**
 * Rückweg von tls_einspielen (siehe Dateikopf). Ergebnis { zustand, belassen, neustartNoetig, aenderungen }. KEIN Neustart.
 * Zeit: LINUX_SQL_ZEIT_MS.tlsEntfernen
 */
export function tlsEntfernenSkript(): string {
  return [
    ...sqlKopf(LINUX_SQL_BAUSTEINE.tlsEntfernen, {}),
    ...werte(),
    HILFEN,
    MARKE,
    ENTFERNEN_KOERPER,
  ].join('\n');
}

// ── tls_pruefung_schalten (Task 7) ─────────────────────────────────────────────────────────────────────────────────────────────────

/** an=true mit dem FQDN des Hosts (= CN des Zertifikats, Name der Probe-Verbindung); an=false ohne weitere Angaben */
export interface TlsPruefungParameter { an: boolean; cn?: string }

export function pruefeTlsPruefung(p: unknown): string | undefined {
  const x = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  if (typeof x.an !== 'boolean') return 'an: true oder false';
  if (!x.an) return x.cn === undefined ? undefined : 'cn: nur mit an=true';
  return TLS_HOSTS.some(h => x.cn === `${h}.${AD_DOMAENE_LINUX}`) ? undefined : `cn: ${TLS_HOSTS.map(h => `${h}.${AD_DOMAENE_LINUX}`).join(', ')}`;
}

/** Probe: Anmeldung als sa über -N gegen den FQDN, Verschlüsselung der eigenen Verbindung laut SQL Server */
const PRUEF_PROBE = "SET NOCOUNT ON; SELECT N'ALFRED|' + CAST(c.encrypt_option AS nvarchar(10)) FROM sys.dm_exec_connections c WHERE c.session_id = @@SPID";

const SCHALTEN_AN_KOERPER = sh(String.raw`# ── Phase 1: prüfen — bis hierhin wird nichts geändert (Review Focus 1: Zertifikat fehlt/abgelaufen/nicht prüfbar → Abbruch) ──
command -v openssl >/dev/null 2>&1 || abbruch "openssl fehlt — Schalter nicht gesetzt"
[ -x "$SQLCMD" ] || abbruch "$SQLCMD fehlt — Schalter nicht gesetzt"
if [ -e "$TLS_SCHALTER" ] || [ -L "$TLS_SCHALTER" ]; then { [ -f "$TLS_SCHALTER" ] && [ ! -L "$TLS_SCHALTER" ]; } || abbruch "$TLS_SCHALTER ist keine reguläre Datei — nichts geändert"; fi
{ [ -f "$CRT" ] && [ ! -L "$CRT" ]; } || abbruch "$CRT fehlt — zuerst tls_einspielen; Schalter nicht gesetzt"
alfreds "$CRT" || abbruch "$CRT steht nicht mit diesem Inhalt in Alfreds Manifest $MANIFEST (nicht von tls_einspielen) — Schalter nicht gesetzt"
[ "$(lies network tlscert)" = "$CRT" ] || abbruch "mssql.conf network.tlscert ist nicht $CRT — Schalter nicht gesetzt"
openssl x509 -noout -checkend 0 -in "$CRT" >/dev/null 2>&1 || abbruch "$CRT ist abgelaufen oder nicht lesbar — Schalter nicht gesetzt"
a=$(openssl verify -purpose sslserver -verify_hostname "$CN" -CAfile "$CA_BUNDLE" -untrusted "$CA_ISS" "$CRT" 2>&1) || abbruch "$CRT: Kette gegen den Vertrauensspeicher $CA_BUNDLE nicht prüfbar oder $CN nicht im Zertifikat ($(kurz "$a")) — Schalter nicht gesetzt"
# Probe genau so, wie Alfred mit Schalter verbindet (-N, Zertifikat und Name geprüft, ohne Vertrauen auf jedes Zertifikat)
SQL_ZIEL=(-N -S "$CN")
a=$(sqlcmd_sa "$PROBE_Q" 2>&1) || abbruch "$SQL_TLS_FEHLER — Probe -N -S $CN als sa: $(sql_fehlerzeile "$a"); Schalter nicht gesetzt"
[ "$(alfred_zeile "$a")" = 'ALFRED|TRUE' ] || abbruch "Probe: Verbindung zu $CN laut SQL Server nicht verschlüsselt ($(kurz "$a")) — Schalter nicht gesetzt"
# ── Phase 2: Schalter (Zwischendatei im selben Ordner, Rechte vor dem Inhalt, mv) ──
ALFRED_TMP=$(mktemp -d "$TMP_BASIS/alfred-tls.XXXXXX"); chmod 0700 "$ALFRED_TMP"
printf '%s\n' "$CN" >"$ALFRED_TMP/schalter"
ALT=''
if [ -f "$TLS_SCHALTER" ]; then cp -- "$TLS_SCHALTER" "$ALFRED_TMP/schalter.alt"; ALT=1; fi
if ! cmp -s -- "$ALFRED_TMP/schalter" "$TLS_SCHALTER"; then
  [ -d "§{TLS_SCHALTER%/*}" ] || { mkdir -p "§{TLS_SCHALTER%/*}"; chmod 0755 "§{TLS_SCHALTER%/*}"; }
  schreibe "$TLS_SCHALTER" "$ALFRED_TMP/schalter" 0644 root:root; aend schalter
elif [ "$(rechte "$TLS_SCHALTER")" != '644 root root' ]; then
  chown root:root "$TLS_SCHALTER"; chmod 0644 "$TLS_SCHALTER"; aend schalter-rechte
fi
# ── Selbstprüfung über denselben Weg wie jede Verbindung Alfreds (sql_ziel + sql); scheitert sie, kommt der vorige Zustand zurück ──
zurueck() {
  if [ "$GEAENDERT" = 1 ]; then
    if [ -n "$ALT" ]; then schreibe "$TLS_SCHALTER" "$ALFRED_TMP/schalter.alt" 0644 root:root; else rm -f -- "$TLS_SCHALTER"; fi
    abbruch "$1 — Schalter zurückgenommen (voriger Zustand)"
  fi
  abbruch "$1"
}
cmp -s -- "$ALFRED_TMP/schalter" "$TLS_SCHALTER" || zurueck "Selbstprüfung: $TLS_SCHALTER enthält nicht $CN"
[ "$(rechte "$TLS_SCHALTER")" = '644 root root' ] || zurueck "Selbstprüfung: $TLS_SCHALTER ist nicht 0644 root:root"
sql_ziel || zurueck "Selbstprüfung: $SQL_ZIEL_FEHLER"
{ [ -n "$SQL_TLS" ] && [ "§{SQL_ZIEL[*]}" = "-N -S $CN" ]; } || zurueck "Selbstprüfung: Verbindungsziel §{SQL_ZIEL[*]} statt -N -S $CN"
a=$(sql "$PROBE_Q" 2>&1) || zurueck "Selbstprüfung: $SQL_TLS_FEHLER: $(sql_fehlerzeile "$a")"
[ "$(alfred_zeile "$a")" = 'ALFRED|TRUE' ] || zurueck "Selbstprüfung: Verbindung zu $CN nicht verschlüsselt"
if [ "$GEAENDERT" = 1 ]; then ZU=geaendert; else ZU=schon; fi
ergebnis "{\"zustand\":\"$ZU\",\"schalter\":\"an\",\"fqdn\":\"$CN\",\"verschluesselt\":true,\"datei\":\"$TLS_SCHALTER\",\"aenderungen\":[$AJ]}"`);

const SCHALTEN_AUS_KOERPER = sh(String.raw`# Rückweg: Schalter weg — Alfreds Verbindungen gehen wieder ohne Zertifikatsprüfung an localhost
if [ -e "$TLS_SCHALTER" ] || [ -L "$TLS_SCHALTER" ]; then
  { [ -f "$TLS_SCHALTER" ] || [ -L "$TLS_SCHALTER" ]; } || abbruch "$TLS_SCHALTER ist keine Datei — nichts geändert"
  rm -f -- "$TLS_SCHALTER"; aend schalter-entfernt
fi
# ── Selbstprüfung ──
{ [ ! -e "$TLS_SCHALTER" ] && [ ! -L "$TLS_SCHALTER" ]; } || abbruch "Selbstprüfung: $TLS_SCHALTER ist noch da"
{ sql_ziel && [ -z "$SQL_TLS" ]; } || abbruch "Selbstprüfung: Alfreds Verbindungen lesen noch einen Schalter"
if [ "$GEAENDERT" = 1 ]; then ZU=geaendert; else ZU=schon; fi
ergebnis "{\"zustand\":\"$ZU\",\"schalter\":\"aus\",\"datei\":\"$TLS_SCHALTER\",\"aenderungen\":[$AJ]}"`);

/**
 * Task 7 — Zertifikatsprüfung bei Alfreds eigenen SQL-Verbindungen dieses Hosts schalten (Schalterdatei TLS_PRUEF_SCHALTER, root 0644,
 * Inhalt = FQDN). an=true (sa über stdin) nur, wenn tls.crt Alfreds ist (Manifest), von mssql.conf genutzt wird, nicht abgelaufen ist,
 * gegen den Vertrauensspeicher mit Namen prüfbar ist und die Probe `sqlcmd -N -S <fqdn>` verschlüsselt gelingt; Selbstprüfung über
 * sql_ziel + sql (sonst voriger Zustand zurück). an=false entfernt den Schalter (Rückweg). Ergebnis { zustand, schalter, fqdn?,
 * verschluesselt?, datei, aenderungen }. Zeit: LINUX_SQL_ZEIT_MS.tlsPruefungSchalten
 */
export function tlsPruefungSchaltenSkript(p: TlsPruefungParameter): string {
  const f = pruefeTlsPruefung(p); if (f) throw new Error(f);
  if (!p.an) {
    return [...sqlKopf(LINUX_SQL_BAUSTEINE.tlsPruefungSchalten, { an: false }), ...werte(), ...SQL_HILFE, HILFEN, MARKE, SCHALTEN_AUS_KOERPER].join('\n');
  }
  return [
    ...sqlKopf(LINUX_SQL_BAUSTEINE.tlsPruefungSchalten, { an: true, cn: p.cn }),
    ...werte(),
    `CN=${shQ(p.cn!)}`,
    `PROBE_Q=${shQ(PRUEF_PROBE)}`,
    ...SQL_HILFE,
    HILFEN,
    ...SA_LESEN,
    SCHALTEN_AN_KOERPER,
  ].join('\n');
}

// ── tls_erzwingen (Task 8) ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * an=true mit Host (= Pacemaker-Knotenname = hostname -s) und FQDN (CN, Inhalt des Prüfschalters); an=false ohne weitere Angaben.
 * Pacemaker unter TLS (Recherche Task 8): der Ressourcen-Agent ocf:mssql:ag (ag-helper, go-mssqldb) verbindet immer mit encrypt=true und
 * TrustServerCertificate=true — forceencryption ändert für ihn nichts; die Vorbedingung verlangt trotzdem einen fehlerfreien Knoten.
 */
export interface TlsErzwingenParameter { an: boolean; host?: string; cn?: string }

export function pruefeTlsErzwingen(p: unknown): string | undefined {
  const x = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  if (typeof x.an !== 'boolean') return 'an: true oder false';
  if (!x.an) return x.host === undefined && x.cn === undefined ? undefined : 'host/cn: nur mit an=true';
  if (typeof x.host !== 'string' || !TLS_HOSTS.includes(x.host)) return `host: ${TLS_HOSTS.join(', ')}`;
  return x.cn === `${x.host}.${AD_DOMAENE_LINUX}` ? undefined : `cn: ${x.host}.${AD_DOMAENE_LINUX}`;
}

/** Task 8 (Ruling R20): Vermerk, dass Alfred network.forceencryption gesetzt hat — nur in tls_erzwingen (nicht in werte()) */
const ERZ_WERTE = [`ERZ_MARKE=${shQ(TLS_ERZWUNGEN_MARKE)}`, `ERZ_KOPF=${shQ(TLS_ERZWUNGEN_KOPF)}`];
const ERZWINGEN_NEUSTART = sh(String.raw`# R20: 0 = Vermerk ist Alfreds (reguläre Datei, Kopfzeile, 0600 root:root)
erz_eigen() { [ -f "$ERZ_MARKE" ] && [ ! -L "$ERZ_MARKE" ] && [ "$(head -n 1 "$ERZ_MARKE")" = "$ERZ_KOPF" ] && [ "$(rechte "$ERZ_MARKE")" = '600 root root' ]; }
# 0 = SQL Server muss neu starten: in diesem Lauf geändert, Dienst nicht aktiv oder mssql.conf jünger als der Dienststart
neustart_noetig() {
  [ "$SQL_AEND" = 0 ] || return 0
  systemctl is-active --quiet mssql-server || return 0
  local t s=0
  t=$(systemctl show -p ActiveEnterTimestamp --value mssql-server 2>/dev/null || true)
  if [ -n "$t" ]; then s=$(date -d "$t" +%s 2>/dev/null || echo 0); fi
  [ ! -f "$MSSQL_CONF" ] || [ "$(stat -c %Y "$MSSQL_CONF")" -lt "$s" ] || return 0
  return 1
}`);

const ERZWINGEN_AN_KOERPER = sh(String.raw`NICHT='Verschlüsselung nicht erzwungen, nichts geändert'
# ── Phase 1: prüfen — bis hierhin wird nichts geändert ──
[ -x "$MSSQLCONF" ] || abbruch "$MSSQLCONF fehlt — $NICHT"
for b in openssl crm_mon python3 timeout; do command -v "$b" >/dev/null 2>&1 || abbruch "$b fehlt — $NICHT"; done
ICH=$(hostname -s 2>/dev/null || true)
[ "$ICH" = "$HOST" ] || abbruch "Host meldet sich als $ICH, erwartet $HOST (Pacemaker-Knoten) — $NICHT"
if [ -e "$ERZ_MARKE" ] || [ -L "$ERZ_MARKE" ]; then erz_eigen || abbruch "$ERZ_MARKE ist vorhanden und nicht von Alfred — $NICHT"; fi
# (1) TLS von Alfred eingespielt (Task 6): Zertifikat und Schlüssel laut Manifest, von mssql.conf genutzt, gültig, Kette + Name prüfbar
{ [ -f "$CRT" ] && [ ! -L "$CRT" ]; } || abbruch "$CRT fehlt — zuerst tls_einspielen; $NICHT"
alfreds "$CRT" || abbruch "$CRT steht nicht mit diesem Inhalt in Alfreds Manifest $MANIFEST (nicht von tls_einspielen) — $NICHT"
alfreds "$KEY" || abbruch "$KEY steht nicht mit diesem Inhalt in Alfreds Manifest $MANIFEST — $NICHT"
[ "$(lies network tlscert)" = "$CRT" ] || abbruch "mssql.conf network.tlscert ist nicht $CRT — $NICHT"
[ "$(lies network tlskey)" = "$KEY" ] || abbruch "mssql.conf network.tlskey ist nicht $KEY — $NICHT"
openssl x509 -noout -checkend 0 -in "$CRT" >/dev/null 2>&1 || abbruch "$CRT ist abgelaufen oder nicht lesbar — $NICHT"
a=$(openssl verify -purpose sslserver -verify_hostname "$CN" -CAfile "$CA_BUNDLE" -untrusted "$CA_ISS" "$CRT" 2>&1) || abbruch "$CRT: Kette gegen den Vertrauensspeicher $CA_BUNDLE nicht prüfbar oder $CN nicht im Zertifikat ($(kurz "$a")) — $NICHT"
# (2) Prüfschalter (Task 7) an, mit genau diesem Host
{ [ -f "$TLS_SCHALTER" ] && [ ! -L "$TLS_SCHALTER" ]; } || abbruch "Zertifikatsprüfung ist nicht an ($TLS_SCHALTER fehlt) — zuerst tls_pruefung_schalten an=true; $NICHT"
sql_ziel || abbruch "$SQL_ZIEL_FEHLER — $NICHT"
[ "§{SQL_ZIEL[*]}" = "-N -S $CN" ] || abbruch "Schalter $TLS_SCHALTER nennt nicht $CN (Verbindungsziel §{SQL_ZIEL[*]}) — $NICHT"
# Verbindung genau so, wie Alfred verbindet (-N, Zertifikat und Name geprüft): SQL Server liefert das eingespielte Zertifikat
bereit || abbruch "SQL Server antwortet nicht als sa — $NICHT"
a=$(sql "$PROBE_Q" 2>&1) || abbruch "Probe über $CN: $(sql_fehlerzeile "$a") — $NICHT"
[ "$(alfred_zeile "$a")" = 'ALFRED|TRUE' ] || abbruch "Probe: Verbindung zu $CN laut SQL Server nicht verschlüsselt — $NICHT"
# (3) Pacemaker auf diesem Knoten fehlerfrei: online, Quorum, Ressource bekannt, Fehlerzähler 0, keine Fehlaktion im Fenster
ALFRED_TMP=$(mktemp -d "$TMP_BASIS/alfred-tls.XXXXXX"); chmod 0700 "$ALFRED_TMP"
timeout 30 crm_mon "§{CRM_FEHLER_ARGS[@]}" >"$ALFRED_TMP/crm.xml" 2>"$ALFRED_TMP/crm.err" || abbruch "crm_mon nicht lesbar ($(kurz "$(cat "$ALFRED_TMP/crm.err")")) — Pacemaker-Lage unbekannt; $NICHT"
PM=$(python3 -c "$PY_PM_PRUEFUNG" "$ICH" "$ALFRED_TMP/crm.xml" 2>"$ALFRED_TMP/pm.err") || abbruch "Pacemaker auf $ICH nicht fehlerfrei: $(kurz "$(cat "$ALFRED_TMP/pm.err")") — $NICHT"
[[ "$PM" == '{'*'}' ]] || abbruch "Pacemaker-Prüfung ohne Ergebnis — $NICHT"
# ── Phase 2: mssql-conf nur bei Abweichung (wirkt erst nach dem Neustart — der läuft rollierend per Change, nicht hier) ──
SQL_AEND=0
if [ "$(lies network forceencryption)" != 1 ]; then
  # R20: Eigentum VOR dem Setzen vermerken (bricht danach etwas ab, nimmt der Rückweg den Wert trotzdem zurück)
  if ! erz_eigen; then
    [ -d "§{ERZ_MARKE%/*}" ] || { mkdir -p "§{ERZ_MARKE%/*}"; chmod 0755 "§{ERZ_MARKE%/*}"; }
    printf '%s\n' "$ERZ_KOPF" >"$ALFRED_TMP/erz"; schreibe "$ERZ_MARKE" "$ALFRED_TMP/erz" 0600 root:root; aend vermerk
  fi
  aus=$("$MSSQLCONF" set network.forceencryption 1 2>&1) || abbruch "mssql-conf set network.forceencryption 1 fehlgeschlagen: $(kurz "$aus") — Vermerk $ERZ_MARKE bleibt (Rückweg tls_erzwingen an=false)"
  aend mssql-conf:forceencryption; SQL_AEND=1
fi
# ── Selbstprüfung ──
[ "$(lies network forceencryption)" = 1 ] || abbruch "Selbstprüfung: mssql.conf network.forceencryption ist nicht 1"
# vorher schon 1 ohne Alfreds Vermerk: nicht Alfreds Wert (der Rückweg lässt ihn stehen)
if erz_eigen; then VA=true; else VA=false; fi
if neustart_noetig; then NN=true; else NN=false; fi
if [ "$GEAENDERT" = 1 ]; then ZU=geaendert; else ZU=schon; fi
ergebnis "{\"zustand\":\"$ZU\",\"erzwungen\":true,\"vonAlfred\":$VA,\"fqdn\":\"$CN\",\"neustartNoetig\":$NN,\"pacemaker\":$PM,\"aenderungen\":[$AJ]}"`);

const ERZWINGEN_AUS_KOERPER = sh(String.raw`# Rückweg: keine Vorbedingung (Zurücknehmen muss immer gehen) — nur Alfreds Wert (Vermerk, R20) entfernen; Fremdes bleibt (belassen)
[ -x "$MSSQLCONF" ] || abbruch "$MSSQLCONF fehlt — nichts geändert"
SQL_AEND=0
V=$(lies network forceencryption)
if [ -n "$V" ] && [ "$V" != 0 ]; then
  if erz_eigen; then
    aus=$("$MSSQLCONF" unset network.forceencryption 2>&1) || abbruch "mssql-conf unset network.forceencryption fehlgeschlagen: $(kurz "$aus")"
    aend mssql-conf:forceencryption; SQL_AEND=1
  else belassen "network.forceencryption = $V (nicht von Alfred gesetzt, kein Vermerk $ERZ_MARKE)"; fi
fi
# Vermerk erst nach dem Zurücknehmen entfernen; ein fremder bleibt
if [ -e "$ERZ_MARKE" ] || [ -L "$ERZ_MARKE" ]; then
  if erz_eigen; then V=$(lies network forceencryption); if [ -z "$V" ] || [ "$V" = 0 ]; then rm -f -- "$ERZ_MARKE"; aend vermerk-entfernt; fi
  else belassen "$ERZ_MARKE (nicht von Alfred)"; fi
fi
# ── Selbstprüfung ──
V=$(lies network forceencryption)
if [ "$SQL_AEND" = 1 ]; then { [ -z "$V" ] || [ "$V" = 0 ]; } || abbruch "Selbstprüfung: mssql.conf network.forceencryption ist noch $V"; fi
! erz_eigen || abbruch "Selbstprüfung: Vermerk $ERZ_MARKE ist noch da"
if [ "$V" = 1 ]; then ER=true; else ER=false; fi
if neustart_noetig; then NN=true; else NN=false; fi
if [ "$GEAENDERT" = 1 ]; then ZU=geaendert; else ZU=schon; fi
ergebnis "{\"zustand\":\"$ZU\",\"erzwungen\":$ER,\"belassen\":[$BELASSEN],\"neustartNoetig\":$NN,\"aenderungen\":[$AJ]}"`);

/**
 * Task 8 — network.forceencryption setzen (an=true) bzw. zurücknehmen (an=false, Rückweg); KEIN Neustart (neustartNoetig im Ergebnis,
 * der Change startet rollierend neu). an=true (sa über stdin) nur, wenn (1) TLS von Alfred eingespielt ist (Manifest, mssql.conf, gültig,
 * Kette + Name), (2) Alfreds Zertifikatsprüfung an ist (Schalter mit genau diesem FQDN, Probe -N verschlüsselt) und (3) Pacemaker auf
 * diesem Knoten fehlerfrei ist (PY_PM_PRUEFUNG: online, Quorum, ag_cluster bekannt, Fehlerzähler 0, keine Fehlaktion in 30 min) — sonst
 * Abbruch ohne mssql-conf-Aufruf. Ruling R20: vor dem Setzen Vermerk TLS_ERZWUNGEN_MARKE; an=false nimmt nur einen vermerkten Wert zurück
 * (sonst belassen). Ergebnis { zustand, erzwungen, vonAlfred?, fqdn?, belassen?, neustartNoetig, pacemaker?, aenderungen }.
 * Zeit: LINUX_SQL_ZEIT_MS.tlsErzwingen
 */
export function tlsErzwingenSkript(p: TlsErzwingenParameter): string {
  const f = pruefeTlsErzwingen(p); if (f) throw new Error(f);
  if (!p.an) {
    return [...sqlKopf(LINUX_SQL_BAUSTEINE.tlsErzwingen, { an: false }), ...werte(), ...ERZ_WERTE, HILFEN, ERZWINGEN_NEUSTART, MARKE, ERZWINGEN_AUS_KOERPER].join('\n');
  }
  return [
    ...sqlKopf(LINUX_SQL_BAUSTEINE.tlsErzwingen, { an: true, host: p.host, cn: p.cn }),
    ...werte(),
    ...ERZ_WERTE,
    `HOST=${shQ(p.host!)}`,
    `CN=${shQ(p.cn!)}`,
    `PROBE_Q=${shQ(PRUEF_PROBE)}`,
    `CRM_FEHLER_ARGS=(${HA_CRM_FEHLER_ARGS.map(shQ).join(' ')})`,
    `PY_PM_PRUEFUNG=${shQ(PY_PM_PRUEFUNG)}`,
    ...SQL_HILFE,
    HILFEN,
    ERZWINGEN_NEUSTART,
    ...SA_LESEN,
    ERZWINGEN_AN_KOERPER,
  ].join('\n');
}

// ── Register ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

registriereLinuxBaustein<TlsParameter>(LINUX_SQL_BAUSTEINE.tlsAnfordern, tlsAnfordernSkript);
registriereLinuxBaustein<TlsEinspielenParameter>(LINUX_SQL_BAUSTEINE.tlsEinspielen, tlsEinspielenSkript);
registriereLinuxBaustein(LINUX_SQL_BAUSTEINE.tlsEntfernen, () => tlsEntfernenSkript());
registriereLinuxBaustein<TlsPruefungParameter>(LINUX_SQL_BAUSTEINE.tlsPruefungSchalten, tlsPruefungSchaltenSkript);
registriereLinuxBaustein<TlsErzwingenParameter>(LINUX_SQL_BAUSTEINE.tlsErzwingen, tlsErzwingenSkript);
