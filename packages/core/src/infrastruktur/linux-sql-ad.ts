/**
 * I8e Etappe 3 Task 4 (Spec docs/specs/2026-11-19-i8e-linux-sql-ad-tls.md, Abschnitt 7.2/10) — Domänenbeitritt der Linux-SQL-Hosts
 * (sqllnx01/sqllnx02, nie sqllnxcfg) über realmd/sssd/adcli, OHNE AD-Admin-Anmeldung auf dem Host:
 * windows_ad computerkonto_vorbereiten legt NAME$ in OU Server mit einem Einmal-Kennwort an (Tresor ad-join-<name>); dieser Baustein
 * meldet sich mit genau diesem Kennwort als Computerkonto an (`adcli join --login-type=computer --stdin-password`, laut adcli(8)
 * gleichwertig zu `--one-time-password`, aber ohne Kennwort in der Befehlszeile) — adcli setzt danach ein eigenes Maschinenkennwort,
 * das Einmal-Kennwort ist verbraucht.
 *
 * Regeln wie linux-sql.ts: Kopf `sqlKopf`, Ergebniszeile `ALFRED-SQL {json}`, Eingabe nur über "$ALFRED_EINGABE" (JSON-Feld `einmal`),
 * Einmal-Kennwort nur per Pipe aus dem Shell-Builtin printf an adcli (nie argv, nie Ausgabe; adcli-Fehlertext wird geschwärzt).
 * Erst prüfen (nichts geändert; fremde sssd.conf/krb5.conf/Keytab → Abbruch), dann ändern: Pakete in fester Version + hold, PAM ohne
 * sss, krb5.conf (Alfred-Kopf), Beitritt, sssd.conf (0600 root, nur NSS, access_provider = deny), NSS, sssd.
 * Selbstprüfung: realm list, id svc-sqllnx@…, getent group sql-linux-admins@…, host/<fqdn> im Keytab, adcli testjoin, kein pam_sss.
 * Rückweg `adVerlassenSkript`: nur lokal (kein Admin-Konto am Host) und nur Alfreds eigene Einrichtung (Fremdes bleibt, steht in
 * `belassen`); das Computerkonto entfernt der Change danach mit windows_ad computerkonto_entfernen.
 */
import { registriereLinuxBaustein } from '../fernzugriff/linux-bausteine.js';
import {
  sqlKopf, shQ, SQL_HILFE, SA_LESEN, LINUX_SQL_BAUSTEINE, ZEITQUELLE_DCS, ZEITQUELLE_DROPIN, ZEITQUELLE_KOPF, AD_SSSD_KOPF, AD_KRB5_KOPF, SQL_KEYTAB, SQL_KERBEROS_KONTO, PY_CONF, AD_DOMAENE_LINUX,
} from './linux-sql.js';

export { AD_SSSD_KOPF, AD_KRB5_KOPF, SQL_KEYTAB, SQL_KERBEROS_KONTO };

// ── Feste Werte (Global Constraints I8e Etappe 3) ──────────────────────────────────────────────────────────────────────────────────

export const LINUX_AD = {
  domaene: AD_DOMAENE_LINUX, realm: 'AD.3033.AT', netbios: 'AD3033', ou: 'Server', dcs: ['10.203.29.2', '10.203.29.3'],
} as const;
/** Spec 10: der Konfig-Knoten tritt nie bei (kein Keytab, keine SPNs, keine AD-Logins) */
export const AD_NIE_BEITRETEN = 'sqllnxcfg';
/** Selbstprüfung: Dienstkonto der SQL-Instanzen und Admin-Gruppe (windows_ad, Etappe 3 Task 2) */
export const AD_PRUEF_KONTO = 'svc-sqllnx';
export const AD_PRUEF_GRUPPE = 'sql-linux-admins';

/**
 * Feste Paketversionen (Spec 7.2: realmd sssd sssd-tools adcli krb5-user libnss-sss libpam-sss) — gelesen per apt-cache madison auf
 * einer Ubuntu-24.04-VM (noble/noble-updates, at.archive.ubuntu.com) am 19.11.2026. Der Change kann sie per Parameter pakete
 * überschreiben; ist eine Version nicht in der Paketquelle, bricht der Baustein ab und nennt die verfügbaren.
 */
export const LINUX_AD_PAKETE: Readonly<Record<string, string>> = {
  realmd: '0.17.1-3build2', sssd: '2.9.4-1.1ubuntu6.9', 'sssd-tools': '2.9.4-1.1ubuntu6.9', adcli: '0.9.2-1ubuntu2',
  'krb5-user': '1.20.1-6ubuntu2.10', 'libnss-sss': '2.9.4-1.1ubuntu6.9', 'libpam-sss': '2.9.4-1.1ubuntu6.9',
};

export const AD_SSSD_CONF = '/etc/sssd/sssd.conf';
export const AD_KRB5_CONF = '/etc/krb5.conf';
export const AD_KEYTAB = '/etc/krb5.keytab';
export const AD_NSSWITCH = '/etc/nsswitch.conf';
// AD_SSSD_KOPF (sssd.conf — eine andere vorhandene wird nie überschrieben oder entfernt) und AD_KRB5_KOPF (Fix-Runde 1, Ruling R13)
// stehen in linux-sql.ts (der Status liest sie) und werden oben wieder exportiert
/**
 * Fix-Runde 1 (R13): „Paketvorgabe“ einer krb5.conf ohne Alfred-Kopf = die Vorlage von krb5-config (postinst kopiert sie nach
 * /etc/krb5.conf und ändert nur default_realm bzw. ergänzt rdns = false) — gleich der Vorlage, wenn man default_realm- und rdns-Zeilen
 * und Leerzeichen am Zeilenende nicht mitvergleicht. Nur diese ersetzt ad_beitreten (Sicherung AD_KRB5_ALT, ad_verlassen stellt sie
 * wieder her); jede andere krb5.conf ohne Kopf ist fremd → Abbruch, nichts geändert.
 */
export const AD_KRB5_VORLAGE = '/usr/share/kerberos-configs/krb5.conf.template';
export const AD_KRB5_ALT = '/etc/krb5.conf.alfred-vorher';
export const AD_PAM_D = '/etc/pam.d';
/** höchste zulässige Uhrzeitabweichung (Offset der Zeitquelle an den DCs, R11) in Sekunden (Kerberos verträgt 300 s; Plan: < 60 s) */
export const AD_UHR_MAX_S = 60;

export interface AdBeitretenParameter { domaene: string; realm: string; ou: string; computername: string; dcs: string[]; pakete: Record<string, string> }

const COMPUTERNAME = /^[a-z][a-z0-9-]{0,14}$/i;
const DEB_VERSION = /^(\d{1,3}:)?\d[A-Za-z0-9.+~-]{0,60}$/;
const obj = (p: unknown): Record<string, unknown> => (p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : {});

export function pruefeAdBeitreten(p: unknown): string | undefined {
  const x = obj(p);
  if (x.domaene !== LINUX_AD.domaene) return `domaene: nur ${LINUX_AD.domaene}`;
  if (x.realm !== LINUX_AD.realm) return `realm: nur ${LINUX_AD.realm}`;
  if (x.ou !== LINUX_AD.ou) return `ou: nur ${LINUX_AD.ou} (dort legt windows_ad computerkonto_vorbereiten das Konto an)`;
  if (!Array.isArray(x.dcs) || x.dcs.length !== LINUX_AD.dcs.length || x.dcs.some((d, i) => d !== LINUX_AD.dcs[i])) return `dcs: nur ${LINUX_AD.dcs.join(', ')}`;
  if (typeof x.computername !== 'string' || !COMPUTERNAME.test(x.computername)) return 'computername: Rechnername ohne $ (Buchstabe, dann Buchstaben/Ziffern/-, höchstens 15 Zeichen), z. B. sqllnx01';
  if (x.computername.toLowerCase() === AD_NIE_BEITRETEN) return `${AD_NIE_BEITRETEN} tritt nicht bei (Spec 10)`;
  const pk = obj(x.pakete);
  const soll = Object.keys(LINUX_AD_PAKETE).sort().join(',');
  if (Object.keys(pk).sort().join(',') !== soll) return `pakete: genau ${Object.keys(LINUX_AD_PAKETE).join(', ')}`;
  for (const [n, v] of Object.entries(pk)) if (typeof v !== 'string' || !DEB_VERSION.test(v)) return `pakete.${n}: Debian-Paketversion wie ${LINUX_AD_PAKETE[n]}`;
  return undefined;
}

export interface AdVerlassenParameter { computername: string }
export function pruefeAdVerlassen(p: unknown): string | undefined {
  const x = obj(p);
  return typeof x.computername === 'string' && COMPUTERNAME.test(x.computername) ? undefined : 'computername: Rechnername ohne $ (höchstens 15 Zeichen), z. B. sqllnx01';
}

/** Kennung des Rechners in beiden Skripten (Keytab-Prüfung) */
function kennung(computername: string): string[] {
  const klein = computername.toLowerCase();
  const name = computername.toUpperCase();
  return [
    `DOM=${shQ(LINUX_AD.domaene)}`, `REALM=${shQ(LINUX_AD.realm)}`, `NAME=${shQ(name)}`, `KLEIN=${shQ(klein)}`, `FQDN=${shQ(`${klein}.${LINUX_AD.domaene}`)}`,
    `KONTO_PRINCIPAL=${shQ(`${name}$@${LINUX_AD.realm}`)}`,
  ];
}

// ── Gemeinsame Hilfen ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Bash-Text mit „§{“ statt „${“ (String.raw ohne Escape-Salat, wie linux-ha.ts) */
const sh = (s: string) => s.replaceAll('§{', '${');
/** Stubs für Tests setzen hier ein (nach allen Hilfsfunktionen und Pfaden, vor dem Ablauf) */
const MARKE = '# ALFRED-ABLAUF';

/**
 * Ruling R11 — systemd-timesyncd lesen (gemeinsam für zeitquelle_einrichten und die Vorbedingung von ad_beitreten). Offset aus
 * `timedatectl timesync-status` (Zeile „Offset: +1.234ms“, systemd format_timespan: d, h, min, s, ms, us, ns) → ganze Millisekunden mit
 * Vorzeichen; leer = keine Messung (noch keine Antwort eines Servers) oder unbekannte Form. Ohne Pipe in grep/sed-q (pipefail/SIGPIPE).
 */
const ZEIT_HILFEN = sh(String.raw`ZQ_DROPIN=${shQ(ZEITQUELLE_DROPIN)}
ZQ_KOPF=${shQ(ZEITQUELLE_KOPF)}
zq_eigen() { [ -f "$ZQ_DROPIN" ] && [ "$(head -n 1 "$ZQ_DROPIN")" = "$ZQ_KOPF" ]; }
zeit_sync() { timedatectl show -p NTPSynchronized --value 2>/dev/null || true; }
zeit_server() { timedatectl show-timesync -p ServerAddress --value 2>/dev/null || true; }
zeit_status() { timedatectl timesync-status 2>/dev/null || true; }
zeit_offset_ms() {
  local z
  z=$(sed -n '/^[[:space:]]*Offset:/ { s/^[[:space:]]*Offset:[[:space:]]*//p; q; }' <<<"$1")
  [ -n "$z" ] || return 0
  awk '{ s = 1; v = $0
    if (substr(v, 1, 1) == "-") { s = -1; v = substr(v, 2) } else if (substr(v, 1, 1) == "+") v = substr(v, 2)
    n = split(v, t, " "); ms = 0
    for (i = 1; i <= n; i++) {
      if (!match(t[i], /^[0-9.]+/)) exit
      x = substr(t[i], 1, RLENGTH) + 0; u = substr(t[i], RLENGTH + 1)
      if (u == "d") ms += x * 86400000; else if (u == "h") ms += x * 3600000; else if (u == "min") ms += x * 60000
      else if (u == "s") ms += x * 1000; else if (u == "ms") ms += x; else if (u == "us") ms += x / 1000; else if (u == "ns") ms += x / 1000000
      else if (u == "" && x == 0) ms += 0; else exit
    }
    printf "%d\n", s * int(ms + 0.5) }' <<<"$z"
}
# Betrag einer ganzen Zahl mit Vorzeichen
betrag() { printf '%s' "§{1#-}"; }`);

const HILFEN = sh(String.raw`export DEBIAN_FRONTEND=noninteractive
TMP_BASIS=/run
SSSD_CONF=${shQ(AD_SSSD_CONF)}
KRB5_CONF=${shQ(AD_KRB5_CONF)}
KEYTAB=${shQ(AD_KEYTAB)}
NSS=${shQ(AD_NSSWITCH)}
SSS_DB=/var/lib/sss/db
SSS_MC=/var/lib/sss/mc
KRB5_VORLAGE=${shQ(AD_KRB5_VORLAGE)}
KRB5_ALT=${shQ(AD_KRB5_ALT)}
PAM_D=${shQ(AD_PAM_D)}
SSSD_KOPF=${shQ(AD_SSSD_KOPF)}
KRB5_KOPF=${shQ(AD_KRB5_KOPF)}
# Realfall 17.11. (6279a86a): gehaltene Pakete melden „hold ok installed“ — installiert ist jeder Status „<wunsch> ok installed“
paket_version() { dpkg-query -W -f='§{Status}|§{Version}' "$1" 2>/dev/null | awk -F'|' '$1 ~ / ok installed$/ { print $2 }' || true; }
paket_gehalten() { [ "$(dpkg-query -W -f='§{Status}' "$1" 2>/dev/null || true)" = 'hold ok installed' ]; }
kurz() { printf "%s" "$1" | tail -n 6 | tr "\r\n" "  "; }
GEAENDERT=0; AJ=''
aend() { GEAENDERT=1; AJ+="§{AJ:+,}\"$1\""; }
# 0 = Datei hat genau diesen Modus und gehört root:root
rechte_ok() { [ "$(stat -c '%a %U %G' "$1" 2>/dev/null || true)" = "$2 root root" ]; }
# Datei (Inhalt $3, Modus $2) nur bei Abweichung ersetzen — temporär im Zielordner, Rechte vor dem Inhalt, dann mv; 0 = geändert
schreibe_datei() {
  if [ -f "$1" ] && [ "$(cat "$1")" = "$3" ] && rechte_ok "$1" "$2"; then return 1; fi
  mkdir -p "$(dirname "$1")"
  local t; t=$(mktemp "$1.alfred-XXXXXX")
  chmod "0$2" "$t"; chown root:root "$t"
  printf '%s\n' "$3" >"$t"
  mv -f "$t" "$1"
  return 0
}
nss_hat() { grep -Eq "^$1:([^#]*[[:space:]])?sss([[:space:]]|$)" "$NSS"; }
# pipefail: nie „Programm | grep -q“ (SIGPIPE beim frühen Ende von grep) — erst lesen, dann suchen
realm_hat() { local a; a=$(realm list --name-only 2>/dev/null | tr 'A-Z' 'a-z' || true); grep -qxF -- "$DOM" <<<"$a"; }
klein() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
keytab_principals() { klist -k "$KEYTAB" 2>/dev/null | awk 'NR > 3 && NF >= 2 { print $2 }' | sort -u || true; }
keytab_hat() { local p; p=$(klein "$(keytab_principals)"); grep -qxF -- "$(klein "$1")" <<<"$p"; }
# Principals im Keytab, die nicht zu diesem Rechner gehören (adcli schreibt NAME$, host/ und RestrictedKrbHost/ je Kurzname und FQDN)
keytab_fremd() {
  local p e z
  p=$(klein "$(keytab_principals)")
  e=$(klein "$NAME\$@$REALM
host/$FQDN@$REALM
host/$NAME@$REALM
restrictedkrbhost/$FQDN@$REALM
restrictedkrbhost/$NAME@$REALM")
  while IFS= read -r z; do if [ -n "$z" ] && ! grep -qxF -- "$z" <<<"$e"; then printf '%s\n' "$z"; fi; done <<<"$p"
}
# 0 = Keytab lesbar und enthält nur Principals dieses Rechners
keytab_nur_eigen() { command -v klist >/dev/null 2>&1 && klist -k "$KEYTAB" >/dev/null 2>&1 && [ -z "$(keytab_fremd)" ]; }
sssd_eigen() { [ "$(head -n 1 "$SSSD_CONF")" = "$SSSD_KOPF" ]; }
krb5_eigen() { [ "$(head -n 1 "$KRB5_CONF")" = "$KRB5_KOPF" ]; }
krb5_norm() { { grep -Ev '^[[:space:]]*(default_realm|rdns)[[:space:]]*=' "$1" || true; } | sed -E 's/[[:space:]]+$//'; }
krb5_vorgabe() { [ -f "$KRB5_VORLAGE" ] && [ "$(krb5_norm "$KRB5_CONF")" = "$(krb5_norm "$KRB5_VORLAGE")" ]; }
# 0 = keine ältere Sicherung oder sie ist byte-gleich mit der jetzigen krb5.conf
krb5_alt_passt() { [ ! -e "$KRB5_ALT" ] || cmp -s -- "$KRB5_ALT" "$KRB5_CONF"; }
# Fix-Runde 1 (R13): pam_sss in einer common-*-Datei (pam-auth-update-Profil sss)
pam_sss_aktiv() { local f; for f in "$PAM_D"/common-*; do if [ -f "$f" ] && grep -q pam_sss "$f"; then return 0; fi; done; return 1; }
pam_ohne_sss() {
  if pam_sss_aktiv; then
    local a; a=$(pam-auth-update --disable sss 2>&1) || abbruch "pam-auth-update --disable sss fehlgeschlagen: $(kurz "$a")"
    aend pam-ohne-sss
  fi
  ! pam_sss_aktiv || abbruch "pam_sss steht nach pam-auth-update --disable sss noch in $PAM_D/common-*"
}`);

/**
 * Ruling R11 — Vorbedingung von ad_beitreten und kerberos_einrichten: statt eigener SNTP-Probe die Zeitquelle an den DCs eingerichtet
 * (Alfreds Drop-in), synchronisiert, |Offset| < UHR_MAX_MS; setzt UHR_V (Sekunden mit Vorzeichen). Braucht ZEIT_HILFEN und UHR_MAX_MS.
 */
const ZEIT_VORBEDINGUNG = sh(String.raw`ZQ_FEHLT="Zeitquelle zuerst einrichten (linux_sql zeitquelle_einrichten) — nichts geändert"
zq_eigen || abbruch "$ZQ_FEHLT ($ZQ_DROPIN fehlt oder ist nicht von Alfred)"
SYNC=$(zeit_sync); OFF=$(zeit_offset_ms "$(zeit_status)")
[ "$SYNC" = yes ] || abbruch "$ZQ_FEHLT (NTPSynchronized §{SYNC:-unbekannt})"
[ -n "$OFF" ] || abbruch "$ZQ_FEHLT (keine Messung in timedatectl timesync-status)"
[ "$(betrag "$OFF")" -lt "$UHR_MAX_MS" ] || abbruch "$ZQ_FEHLT (Offset $OFF ms, höchstens ±$UHR_MAX_MS ms)"
UHR_V=$(awk -v m="$OFF" 'BEGIN { printf "%+.3f", m / 1000 }')`);

// ── Beitritt ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// pipefail: nie „Programm | grep -q“ — grep endet beim ersten Treffer, der Schreiber bekommt SIGPIPE und die Pipeline gilt als gescheitert;
// darum erst die Ausgabe lesen, dann suchen
const BEITRETEN_HILFEN = sh(String.raw`srv_ok() { local a; a=$(host -t SRV "_ldap._tcp.$DOM" 2>/dev/null || true); grep -q 'has SRV record' <<<"$a"; }
ptr_von() { host "$1" 2>/dev/null | sed -n 's/.* domain name pointer \(.*\)\.$/\1/p' | head -n 1 | tr 'A-Z' 'a-z' || true; }
# Quelladresse Richtung dc01 = die Adresse, unter der der Host die DCs erreicht (PTR muss auf den FQDN zeigen)
eigene_ip() { ip -4 route get "$DC1" 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1 || true; }
beigetreten() { [ -f "$KEYTAB" ] && keytab_hat "$KONTO_PRINCIPAL" && adcli testjoin --domain="$DOM" >/dev/null 2>&1; }
schwarz() { local t="$1"; if [ -n "§{EINMAL:-}" ]; then t=§{t//"$EINMAL"/[geschwärzt]}; fi; printf '%s' "$t"; }`);

const BEITRETEN_KOERPER = sh(String.raw`EINMAL=$(feld einmal) || abbruch "Einmal-Kennwort enthält nicht druckbare Zeichen"
[ -z "$EINMAL" ] || [[ "$EINMAL" =~ ^[[:graph:]]+$ ]] || abbruch "Einmal-Kennwort enthält nicht druckbare Zeichen"
# ── Phase 1: prüfen — bis hierhin wird nichts geändert ──
hf=$(hostname -f 2>/dev/null | tr 'A-Z' 'a-z' || true)
[ "$hf" = "$FQDN" ] || abbruch "hostname -f liefert '§{hf:-nichts}', erwartet $FQDN — hosts-Block/DNS fehlt; nichts geändert"
command -v host >/dev/null 2>&1 || abbruch "host fehlt (Paket bind9-host) — DNS nicht prüfbar; nichts geändert"
srv_ok || abbruch "SRV _ldap._tcp.$DOM nicht auflösbar (DNS zeigt nicht auf die DCs) — nichts geändert"
IP=$(eigene_ip)
[ -n "$IP" ] || abbruch "keine eigene IPv4-Adresse Richtung $DC1 (ip route get) — nichts geändert"
PTR=$(ptr_von "$IP")
[ "$PTR" = "$FQDN" ] || abbruch "PTR von $IP ist '§{PTR:-keiner}', erwartet $FQDN (windows_ad dns_ptr) — nichts geändert"
${ZEIT_VORBEDINGUNG}
for pv in "§{PAKETE[@]}"; do
  pk=§{pv%%=*}; sv=§{pv#*=}; iv=$(paket_version "$pk")
  [ -z "$iv" ] || [ "$iv" = "$sv" ] || abbruch "$pk ist in Version $iv installiert, erwartet $sv — der Beitritt ändert keine vorhandene Version; nichts geändert"
done
if [ -s "$KEYTAB" ]; then
  command -v klist >/dev/null 2>&1 || abbruch "$KEYTAB vorhanden, klist fehlt — Inhalt nicht prüfbar; nichts geändert"
  klist -k "$KEYTAB" >/dev/null 2>&1 || abbruch "$KEYTAB nicht lesbar (klist -k) — nichts geändert"
  fr=$(keytab_fremd)
  [ -z "$fr" ] || abbruch "$KEYTAB enthält fremde Principals ($(printf '%s' "$fr" | head -n 3 | tr '\n' ' ')) — nichts geändert"
fi
if [ -f "$SSSD_CONF" ] && ! sssd_eigen; then
  abbruch "$SSSD_CONF ist nicht von Alfred (andere Konfiguration) — nichts geändert"
fi
if [ -f "$KRB5_CONF" ] && ! krb5_eigen && ! krb5_vorgabe; then
  abbruch "$KRB5_CONF ist fremd (weder von Alfred noch die unveränderte Vorgabe von krb5-config) — nichts geändert"
fi
# Fix-Runde 2: eine ältere Sicherung wird nie still beibehalten, wenn die zu ersetzende Vorgabe anders aussieht
if [ -f "$KRB5_CONF" ] && ! krb5_eigen && ! krb5_alt_passt; then
  abbruch "$KRB5_ALT: ältere Sicherung weicht von der jetzigen $KRB5_CONF ab — nichts geändert"
fi
command -v pam-auth-update >/dev/null 2>&1 || abbruch "pam-auth-update fehlt (libpam-runtime) — PAM nicht steuerbar; nichts geändert"
# ── Phase 2: Pakete (feste Versionen, gehalten) ──
FEHLEND=()
for pv in "§{PAKETE[@]}"; do if [ -z "$(paket_version "§{pv%%=*}")" ]; then FEHLEND+=("$pv"); fi; done
if [ "§{#FEHLEND[@]}" -gt 0 ]; then
  ALFRED_TMP=$(mktemp -d "$TMP_BASIS/alfred-ad.XXXXXX")
  apt-get -o DPkg::Lock::Timeout=300 update -q >"$ALFRED_TMP/apt.log" 2>&1 || abbruch "apt-get update fehlgeschlagen: $(kurz "$(cat "$ALFRED_TMP/apt.log")") — nichts installiert"
  for pv in "§{FEHLEND[@]}"; do
    pk=§{pv%%=*}; sv=§{pv#*=}
    vs=$(apt-cache madison "$pk" | awk -F'|' '{ gsub(/ /, "", $2); print $2 }')
    grep -qxF "$sv" <<<"$vs" || abbruch "$pk=$sv ist in der Paketquelle nicht verfügbar (verfügbar: $(printf '%s' "$vs" | tr '\n' ' ')) — Version per Parameter pakete angeben; nichts installiert"
  done
  if ! apt-get -o DPkg::Lock::Timeout=300 install -y -q --no-install-recommends -o Dpkg::Options::=--force-confold "§{FEHLEND[@]}" >"$ALFRED_TMP/apt.log" 2>&1; then
    abbruch "apt-get install fehlgeschlagen: $(kurz "$(cat "$ALFRED_TMP/apt.log")")"
  fi
  aend pakete
fi
for pv in "§{PAKETE[@]}"; do
  pk=§{pv%%=*}; sv=§{pv#*=}; iv=$(paket_version "$pk")
  [ "$iv" = "$sv" ] || abbruch "$pk hat nach der Installation Version '§{iv:-keine}', erwartet $sv"
  if ! paket_gehalten "$pk"; then apt-mark -o DPkg::Lock::Timeout=300 hold "$pk" >/dev/null; aend "halten:$pk"; fi
done
for b in adcli realm klist sssd; do command -v "$b" >/dev/null 2>&1 || abbruch "$b fehlt nach der Installation"; done
# Fix-Runde 1 (R13): libpam-sss ist Pflicht-Abhängigkeit von sssd-common und schaltet pam_sss per pam-auth-update ein. SQL Server braucht
# nur NSS; pam_sss mit „[default=bad …]“ in common-account kann bei gestopptem sssd lokales sudo/SSH sperren → Profil sss aus
pam_ohne_sss
# ── Phase 3: Kerberos und Beitritt ──
if [ -f "$KRB5_CONF" ] && ! krb5_eigen; then
  # nach der Installation kann krb5-config die Vorlage neu angelegt haben — nur diese wird ersetzt (Sicherung für ad_verlassen)
  krb5_vorgabe || abbruch "$KRB5_CONF ist fremd (weder von Alfred noch die unveränderte Vorgabe von krb5-config) — Beitritt abgebrochen"
  krb5_alt_passt || abbruch "$KRB5_ALT: ältere Sicherung weicht von der jetzigen $KRB5_CONF ab — krb5.conf nicht ersetzt"
  if [ ! -e "$KRB5_ALT" ]; then cp -p -- "$KRB5_CONF" "$KRB5_ALT"; aend krb5-vorgabe-gesichert; fi
fi
if schreibe_datei "$KRB5_CONF" 644 "$KRB5_SOLL"; then aend krb5.conf; fi
if beigetreten; then
  JOIN=schon
else
  [ -n "$EINMAL" ] || abbruch "nicht beigetreten und kein Einmal-Kennwort (Tresor ad-join-$KLEIN fehlt — vorher windows_ad computerkonto_vorbereiten name $KLEIN)"
  [ -n "$ALFRED_TMP" ] || ALFRED_TMP=$(mktemp -d "$TMP_BASIS/alfred-ad.XXXXXX")
  # Einmal-Kennwort nur über die Pipe aus dem Builtin printf (kein eigener Prozess mit dem Kennwort in der Befehlszeile)
  if ! printf '%s' "$EINMAL" | adcli join --domain="$DOM" --domain-realm="$REALM" --domain-ou="$OU_DN" --computer-name="$NAME" --host-fqdn="$FQDN" \
       --host-keytab="$KEYTAB" --login-type=computer --stdin-password --verbose >"$ALFRED_TMP/adcli.log" 2>&1; then
    abbruch "adcli join fehlgeschlagen: $(schwarz "$(kurz "$(cat "$ALFRED_TMP/adcli.log")")")"
  fi
  rm -f -- "$ALFRED_TMP/adcli.log"
  aend beitritt
  JOIN=neu
  keytab_hat "$KONTO_PRINCIPAL" || abbruch "nach dem Beitritt fehlt $KONTO_PRINCIPAL in $KEYTAB"
fi
chmod 0600 "$KEYTAB"; chown root:root "$KEYTAB"
# ── Phase 4: sssd und NSS ──
SSSD_NEU=0
if schreibe_datei "$SSSD_CONF" 600 "$SSSD_SOLL"; then aend sssd.conf; SSSD_NEU=1; fi
for db in passwd group; do
  if ! nss_hat "$db"; then sed -E -i "/^$db:/ s/[[:space:]]*$/ sss/" "$NSS"; aend "nsswitch:$db"; fi
  nss_hat "$db" || abbruch "$NSS: $db ohne sss (Zeile fehlt?)"
done
if ! systemctl is-enabled --quiet sssd; then systemctl enable sssd >/dev/null 2>&1 || abbruch "sssd lässt sich nicht aktivieren"; aend "sssd-aktiviert"; fi
if [ "$SSSD_NEU" = 1 ] || [ "$JOIN" = neu ] || ! systemctl is-active --quiet sssd; then
  aus=$(systemctl restart sssd 2>&1) || abbruch "sssd startet nicht: $(kurz "$aus")"
  aend sssd-gestartet
fi
# ── Selbstprüfung ──
systemctl is-active --quiet sssd || abbruch "Selbstprüfung: sssd läuft nicht"
realm_hat || abbruch "Selbstprüfung: realm list zeigt $DOM nicht"
keytab_hat "host/$FQDN@$REALM" || abbruch "Selbstprüfung: host/$FQDN@$REALM fehlt in $KEYTAB"
adcli testjoin --domain="$DOM" >/dev/null 2>&1 || abbruch "Selbstprüfung: adcli testjoin scheitert (Maschinenkennwort im Keytab passt nicht zum AD)"
ok=0; for i in $(seq 1 30); do if id "$PRUEF_KONTO@$DOM" >/dev/null 2>&1; then ok=1; break; fi; sleep 2; done
[ "$ok" = 1 ] || abbruch "Selbstprüfung: id $PRUEF_KONTO@$DOM löst nicht auf (60 s)"
getent group "$PRUEF_GRUPPE@$DOM" >/dev/null 2>&1 || abbruch "Selbstprüfung: getent group $PRUEF_GRUPPE@$DOM löst nicht auf"
! pam_sss_aktiv || abbruch "Selbstprüfung: pam_sss steht in $PAM_D/common-*"
krb5_eigen || abbruch "Selbstprüfung: $KRB5_CONF ohne Alfred-Kopf"
if [ "$GEAENDERT" = 1 ]; then Z=geaendert; else Z=schon; fi
ergebnis "{\"zustand\":\"$Z\",\"domaene\":\"$DOM\",\"computerkonto\":\"$KONTO_ANZEIGE\",\"sssd\":\"aktiv\",\"fqdn\":\"$FQDN\",\"ip\":\"$IP\",\"uhrAbweichungS\":\"$UHR_V\",\"beitritt\":\"$JOIN\",\"aenderungen\":[$AJ]}"`);

function sssdSoll(fqdn: string, name: string): string {
  const d = LINUX_AD.domaene;
  return [
    AD_SSSD_KOPF,
    // Fix-Runde 1 (R13): nur NSS (SID-/Namensauflösung für SQL Server), kein PAM-Responder
    '[sssd]', 'config_file_version = 2', 'services = nss', `domains = ${d}`, '',
    `[domain/${d}]`,
    'id_provider = ad', 'auth_provider = ad', 'chpass_provider = ad',
    // Spec 7.2 / Ruling R12: keine Anmeldung von Domänenbenutzern am Host (leere simple-Listen hießen laut sssd-simple(5) „alle“)
    'access_provider = deny',
    `ad_domain = ${d}`, `krb5_realm = ${LINUX_AD.realm}`,
    // Hostname bleibt kurz (Spec 10) — sssd muss Computername und Principal ausdrücklich kennen
    `ad_hostname = ${fqdn}`, `ldap_sasl_authid = ${name}$@${LINUX_AD.realm}`, `krb5_keytab = ${AD_KEYTAB}`,
    'realmd_tags = manages-system joined-with-adcli',
    'use_fully_qualified_names = True', 'ldap_id_mapping = True', 'cache_credentials = False',
    // PTR pflegt windows_ad dns_ptr — sssd ändert kein DNS
    'dyndns_update = False',
    'fallback_homedir = /home/%u@%d', 'default_shell = /usr/sbin/nologin',
  ].join('\n');
}

const KRB5_SOLL = [
  AD_KRB5_KOPF,
  '[libdefaults]',
  `    default_realm = ${LINUX_AD.realm}`,
  '    dns_lookup_realm = false',
  '    dns_lookup_kdc = true',
  '    rdns = false',
  '    udp_preference_limit = 0',
].join('\n');

/**
 * Domänenbeitritt (Eingabe stdin `{ einmal }`, fehlt bei schon beigetretenem Host nicht schädlich). Ablauf: prüfen (hostname -f = FQDN,
 * SRV, PTR, Zeitquelle an den DCs eingerichtet und synchron (Offset < 60 s, R11), keine abweichende Paketversion, kein fremder Keytab, keine fremde sssd.conf) → Pakete fest + hold →
 * krb5.conf → adcli join als Computerkonto → sssd.conf, NSS, sssd → Selbstprüfung. Zeit: LINUX_SQL_ZEIT_MS.adBeitreten
 */
export function adBeitretenSkript(p: AdBeitretenParameter): string {
  const f = pruefeAdBeitreten(p); if (f) throw new Error(f);
  const klein = p.computername.toLowerCase();
  const name = p.computername.toUpperCase();
  const fqdn = `${klein}.${p.domaene}`;
  const ouDn = `OU=${p.ou},${p.domaene.split('.').map(t => `DC=${t}`).join(',')}`;
  const pakete = Object.keys(LINUX_AD_PAKETE).map(n => `${n}=${p.pakete[n]}`);
  return [
    ...sqlKopf(LINUX_SQL_BAUSTEINE.adBeitreten, { domaene: p.domaene, realm: p.realm, ou: p.ou, computername: klein, dcs: p.dcs, pakete: Object.fromEntries(Object.keys(LINUX_AD_PAKETE).map(n => [n, p.pakete[n]])) }),
    HILFEN,
    ...kennung(p.computername),
    `OU_DN=${shQ(ouDn)}`,
    `DC1=${shQ(p.dcs[0]!)}`,
    // JSON-Text (Backslash verdoppelt): AD3033\\SQLLNX01$
    `KONTO_ANZEIGE=${shQ(`${LINUX_AD.netbios}\\\\${name}$`)}`,
    `PRUEF_KONTO=${shQ(AD_PRUEF_KONTO)}`,
    `PRUEF_GRUPPE=${shQ(AD_PRUEF_GRUPPE)}`,
    `UHR_MAX_MS=${AD_UHR_MAX_S * 1000}`,
    `PAKETE=(${pakete.map(shQ).join(' ')})`,
    ZEIT_HILFEN,
    `SSSD_SOLL=${shQ(sssdSoll(fqdn, name))}`,
    `KRB5_SOLL=${shQ(KRB5_SOLL)}`,
    BEITRETEN_HILFEN,
    MARKE,
    BEITRETEN_KOERPER,
  ].join('\n');
}

// ── Verlassen (Rückweg, nur lokal) ───────────────────────────────────────────────────────────────────────────────────────────────

const VERLASSEN_KOERPER = sh(String.raw`BELASSEN=''
belassen() { BELASSEN+="§{BELASSEN:+,}$(printf '%s' "$1" | json_text)"; }
# Fix-Runde 1: nur Alfreds eigene Einrichtung zurücknehmen — eine fremde sssd.conf (ad_beitreten hätte sie nie angefasst) bleibt samt
# sssd, NSS, PAM und Zwischenspeicher unverändert und steht im Ergebnis
EIGEN=1
if [ -f "$SSSD_CONF" ] && ! sssd_eigen; then EIGEN=0; belassen "$SSSD_CONF (nicht von Alfred) — sssd, NSS und PAM unverändert"; fi
if [ "$EIGEN" = 1 ]; then
  # Fix-Runde 2 (R13): ZUERST PAM und NSS ohne sss, DANN sssd stoppen — bricht der Lauf dazwischen ab, steht nie ein
  # „[default=bad …] pam_sss.so“ bei gestopptem sssd (lokales sudo/SSH, auch Alfreds eigener Zugang, bliebe sonst gesperrt)
  pam_ohne_sss
  # NSS: sss aus allen Zeilen nehmen (libnss-sss trägt es in passwd, group, shadow, netgroup, services, sudoers ein)
  if [ -f "$NSS" ] && grep -Eq "^[a-z]+:([^#]*[[:space:]])?sss([[:space:]]|$)" "$NSS"; then
    sed -E -i '/^[a-z]+:/ { s/[[:space:]]+sss([[:space:]]|$)/\1/g; s/[[:space:]]+sss([[:space:]]|$)/\1/g }' "$NSS"
    aend nsswitch
  fi
  if systemctl is-active --quiet sssd || systemctl is-enabled --quiet sssd; then
    aus=$(systemctl disable --now sssd 2>&1) || abbruch "sssd lässt sich nicht stoppen/deaktivieren: $(kurz "$aus")"
    aend sssd-aus
  fi
  if [ -e "$SSSD_CONF" ]; then rm -f -- "$SSSD_CONF"; aend sssd.conf; fi
  # Zwischenspeicher von sssd (Benutzer/Gruppen der Domäne) leeren
  for d in "$SSS_DB" "$SSS_MC"; do
    if [ -d "$d" ] && [ -n "$(find "$d" -maxdepth 1 -type f -print -quit)" ]; then find "$d" -maxdepth 1 -type f -delete; aend "cache:$(basename "$d")"; fi
  done
fi
# Maschinenschlüssel nur, wenn er ausschließlich diesem Rechner gehört (Computerkonto im AD: windows_ad computerkonto_entfernen)
if [ -e "$KEYTAB" ]; then
  if keytab_nur_eigen; then rm -f -- "$KEYTAB"; aend keytab
  else belassen "$KEYTAB (enthält fremde Principals oder ist nicht lesbar: $(keytab_fremd | head -n 3 | tr '\n' ' '))"; fi
fi
# krb5.conf nur mit Alfred-Kopf: gesicherte Paketvorgabe zurück, sonst entfernen
if [ -f "$KRB5_CONF" ] && krb5_eigen; then
  if [ -f "$KRB5_ALT" ]; then mv -f -- "$KRB5_ALT" "$KRB5_CONF"; aend krb5-vorgabe-zurueck; else rm -f -- "$KRB5_CONF"; aend krb5.conf; fi
fi
# ── Selbstprüfung ──
if [ "$EIGEN" = 1 ]; then
  ! systemctl is-active --quiet sssd || abbruch "Selbstprüfung: sssd läuft noch"
  ! systemctl is-enabled --quiet sssd || abbruch "Selbstprüfung: sssd ist noch aktiviert"
  [ ! -e "$SSSD_CONF" ] || abbruch "Selbstprüfung: $SSSD_CONF besteht noch"
  if [ -f "$NSS" ] && grep -Eq "^[a-z]+:([^#]*[[:space:]])?sss([[:space:]]|$)" "$NSS"; then abbruch "Selbstprüfung: $NSS enthält noch sss"; fi
  ! pam_sss_aktiv || abbruch "Selbstprüfung: pam_sss steht noch in $PAM_D/common-*"
  if command -v realm >/dev/null 2>&1 && realm_hat; then abbruch "Selbstprüfung: realm list zeigt $DOM noch"; fi
fi
if [ -e "$KEYTAB" ] && keytab_nur_eigen; then abbruch "Selbstprüfung: $KEYTAB besteht noch"; fi
if [ -f "$KRB5_CONF" ] && krb5_eigen; then abbruch "Selbstprüfung: $KRB5_CONF von Alfred besteht noch"; fi
if [ "$GEAENDERT" = 1 ]; then Z=geaendert; else Z=schon; fi
if [ "$EIGEN" = 1 ]; then S=aus; else S=fremd; fi
ergebnis "{\"zustand\":\"$Z\",\"domaene\":\"$DOM\",\"sssd\":\"$S\",\"belassen\":[$BELASSEN],\"aenderungen\":[$AJ]}"`);

/**
 * Rückweg von adBeitretenSkript, NUR lokal (kein Admin-Konto am Host) und nur für Alfreds eigene Einrichtung: bei Alfreds sssd.conf
 * (oder keiner) sssd stoppen + deaktivieren, sssd.conf entfernen, Zwischenspeicher leeren, sss aus nsswitch.conf und PAM nehmen; Keytab
 * nur, wenn er ausschließlich Principals dieses Rechners enthält; krb5.conf nur mit Alfred-Kopf (gesicherte Paketvorgabe zurück).
 * Fremdes bleibt und steht in `belassen`. Pakete bleiben (gehalten). Das Computerkonto entfernt der Change danach mit
 * windows_ad computerkonto_entfernen. Zeit: LINUX_SQL_ZEIT_MS.adVerlassen
 */
export function adVerlassenSkript(p: AdVerlassenParameter): string {
  const f = pruefeAdVerlassen(p); if (f) throw new Error(f);
  return [
    ...sqlKopf(LINUX_SQL_BAUSTEINE.adVerlassen, { computername: p.computername.toLowerCase() }),
    HILFEN,
    ...kennung(p.computername),
    MARKE,
    VERLASSEN_KOERPER,
  ].join('\n');
}

// ── Zeitquelle an den DCs (Ruling R11) ──────────────────────────────────────────────────────────────────────────────────────────

/** höchster Betrag des Offsets nach der Einrichtung (Nachweis) und Wartezeit auf die Synchronisierung */
export const ZEITQUELLE_OFFSET_MAX_MS = 1000;
export const ZEITQUELLE_WARTE_S = 120;
/** systemd-timesyncd-Programm (Ubuntu 24.04: Paket systemd-timesyncd) */
export const ZEITQUELLE_TIMESYNCD = '/usr/lib/systemd/systemd-timesyncd';
/** Drop-in-Ordner von timesyncd (timesyncd.conf(5)) — ein fremdes Drop-in mit NTP=/FallbackNTP= würde die DCs ergänzen oder ersetzen */
export const ZEITQUELLE_DROPIN_ORDNER: readonly string[] = ['/etc/systemd/timesyncd.conf.d', '/run/systemd/timesyncd.conf.d', '/usr/lib/systemd/timesyncd.conf.d'];
/** andere Zeitdienste — läuft einer, wäre systemd-timesyncd wirkungslos (Abbruch ohne Änderung) */
export const ZEITQUELLE_FREMDE_DIENSTE: readonly string[] = ['chrony', 'chronyd', 'ntp', 'ntpd', 'ntpsec', 'openntpd'];

/**
 * Inhalt des Drop-ins: Kopfzeile, `NTP=` leert eine Liste aus timesyncd.conf (NTP= ist laut timesyncd.conf(5) kumulativ), dann genau
 * die DCs; `FallbackNTP=` leer — kein Rückfall auf ntp.ubuntu.com
 */
export function zeitquelleDropin(): string {
  return [ZEITQUELLE_KOPF, '[Time]', 'NTP=', `NTP=${ZEITQUELLE_DCS.join(' ')}`, 'FallbackNTP='].join('\n');
}

const ZEIT_PRUEF_HILFEN = sh(String.raw`ist_dc() { local d; [ -n "$1" ] || return 1; for d in "§{DCS[@]}"; do if [ "$d" = "$1" ]; then return 0; fi; done; return 1; }`);

const EINRICHTEN_KOERPER = sh(String.raw`# ── Phase 1: prüfen — bis hierhin wird nichts geändert ──
command -v timedatectl >/dev/null 2>&1 || abbruch "timedatectl fehlt — nichts geändert"
[ -x "$TIMESYNCD" ] || abbruch "systemd-timesyncd fehlt ($TIMESYNCD, Paket systemd-timesyncd) — nichts geändert"
for d in "§{FREMDE_DIENSTE[@]}"; do
  if systemctl is-active --quiet "$d"; then abbruch "andere Zeitquelle aktiv — nichts geändert ($d läuft; systemd-timesyncd wäre wirkungslos)"; fi
done
if [ -e "$ZQ_DROPIN" ] && ! zq_eigen; then abbruch "$ZQ_DROPIN ist nicht von Alfred (andere Kopfzeile) — nichts geändert"; fi
for dir in "§{DROPIN_ORDNER[@]}"; do
  for f in "$dir"/*.conf; do
    [ -f "$f" ] || continue
    [ "$f" != "$ZQ_DROPIN" ] || continue
    if grep -Eq '^[[:space:]]*(NTP|FallbackNTP)[[:space:]]*=' "$f"; then abbruch "fremdes Drop-in $f setzt NTP/FallbackNTP (würde die DCs ergänzen oder ersetzen) — nichts geändert"; fi
  done
done
# ── Phase 2: Drop-in, NTP an, Dienst neu starten ──
NEU=0
if [ ! -f "$ZQ_DROPIN" ] || [ "$(cat "$ZQ_DROPIN")" != "$ZQ_SOLL" ]; then
  mkdir -p "$(dirname "$ZQ_DROPIN")"
  t=$(mktemp "$ZQ_DROPIN.alfred-XXXXXX")
  chmod 0644 "$t"
  printf '%s\n' "$ZQ_SOLL" >"$t"
  mv -f "$t" "$ZQ_DROPIN"
  aend dropin; NEU=1
fi
ntp=$(timedatectl show -p NTP --value 2>/dev/null || true)
if [ "$ntp" != yes ]; then
  aus=$(timedatectl set-ntp true 2>&1) || abbruch "timedatectl set-ntp true fehlgeschlagen: $(kurz "$aus") — Drop-in bleibt (Rückweg zeitquelle_entfernen)"
  aend ntp-an; NEU=1
fi
if [ "$NEU" = 1 ] || ! systemctl is-active --quiet systemd-timesyncd || ! ist_dc "$(zeit_server)"; then
  aus=$(systemctl restart systemd-timesyncd 2>&1) || abbruch "systemd-timesyncd startet nicht: $(kurz "$aus") — Drop-in bleibt (Rückweg zeitquelle_entfernen)"
  aend timesyncd-neu-gestartet
fi
# ── Nachweis: binnen WARTE_S synchronisiert mit einem DC, |Offset| < OFFSET_MAX_MS ──
SYNC=''; SERVER=''; ST=''; OFF=''
for i in $(seq 1 "$WARTE_RUNDEN"); do
  SYNC=$(zeit_sync); SERVER=$(zeit_server); ST=$(zeit_status); OFF=$(zeit_offset_ms "$ST")
  if [ "$SYNC" = yes ] && ist_dc "$SERVER" && [ -n "$OFF" ] && [ "$(betrag "$OFF")" -lt "$OFFSET_MAX_MS" ]; then break; fi
  sleep 2
done
LAGE="NTPSynchronized §{SYNC:-unbekannt}, Server §{SERVER:-keiner}, Offset §{OFF:-keine Messung}§{OFF:+ ms}; timesync-status: $(kurz "$ST")"
{ [ "$SYNC" = yes ] && ist_dc "$SERVER"; } || abbruch "nach $WARTE_S s nicht mit einem DC synchronisiert ($LAGE) — Drop-in bleibt (Rückweg zeitquelle_entfernen)"
[ -n "$OFF" ] || abbruch "nach $WARTE_S s keine Messung des DCs ($LAGE) — Drop-in bleibt (Rückweg zeitquelle_entfernen)"
[ "$(betrag "$OFF")" -lt "$OFFSET_MAX_MS" ] || abbruch "Offset zum DC nach $WARTE_S s zu groß (höchstens ±$OFFSET_MAX_MS ms; $LAGE) — Drop-in bleibt (Rückweg zeitquelle_entfernen)"
# ── Selbstprüfung ──
{ zq_eigen && [ "$(cat "$ZQ_DROPIN")" = "$ZQ_SOLL" ]; } || abbruch "Selbstprüfung: $ZQ_DROPIN nicht wie erzeugt"
systemctl is-active --quiet systemd-timesyncd || abbruch "Selbstprüfung: systemd-timesyncd läuft nicht"
if [ "$GEAENDERT" = 1 ]; then Z=geaendert; else Z=schon; fi
ergebnis "{\"zustand\":\"$Z\",\"server\":\"$SERVER\",\"offsetMs\":$OFF,\"synchronisiert\":true,\"aenderungen\":[$AJ]}"`);

/** Kopf und Hilfen beider Zeitquellen-Skripte */
function zeitKopf(baustein: string): string[] {
  return [
    ...sqlKopf(baustein, { dcs: [...ZEITQUELLE_DCS] }),
    HILFEN,
    ZEIT_HILFEN,
    `DCS=(${ZEITQUELLE_DCS.map(shQ).join(' ')})`,
    ZEIT_PRUEF_HILFEN,
  ];
}

/**
 * Ruling R11 — Zeitquelle an den DCs (alle drei Hosts, auch sqllnxcfg): prüfen (timedatectl und systemd-timesyncd vorhanden, kein anderer
 * Zeitdienst aktiv, kein fremdes Drop-in mit NTP=/FallbackNTP=, ZEITQUELLE_DROPIN fremd → Abbruch ohne Änderung) → Drop-in
 * (zeitquelleDropin) → NTP an → systemd-timesyncd neu starten → Nachweis binnen 120 s: NTPSynchronized=yes, Server ist ein DC,
 * |Offset| < 1 s. Kein Erfolg → Abbruch mit gelesenem Status, Drop-in bleibt (Rückweg zeitquelleEntfernenSkript). Wiederholbar („schon“
 * ohne Neustart, wenn alles stimmt). Zeit: LINUX_SQL_ZEIT_MS.zeitquelleEinrichten
 */
export function zeitquelleEinrichtenSkript(): string {
  return [
    ...zeitKopf(LINUX_SQL_BAUSTEINE.zeitquelleEinrichten),
    `ZQ_SOLL=${shQ(zeitquelleDropin())}`,
    `TIMESYNCD=${shQ(ZEITQUELLE_TIMESYNCD)}`,
    `DROPIN_ORDNER=(${ZEITQUELLE_DROPIN_ORDNER.map(shQ).join(' ')})`,
    `FREMDE_DIENSTE=(${ZEITQUELLE_FREMDE_DIENSTE.map(shQ).join(' ')})`,
    `WARTE_S=${ZEITQUELLE_WARTE_S}`,
    `WARTE_RUNDEN=${ZEITQUELLE_WARTE_S / 2}`,
    `OFFSET_MAX_MS=${ZEITQUELLE_OFFSET_MAX_MS}`,
    MARKE,
    EINRICHTEN_KOERPER,
  ].join('\n');
}

const ENTFERNEN_KOERPER = sh(String.raw`BELASSEN=''
if [ -e "$ZQ_DROPIN" ]; then
  if zq_eigen; then rm -f -- "$ZQ_DROPIN"; aend dropin-entfernt
  else BELASSEN=$(printf '%s' "$ZQ_DROPIN (nicht von Alfred)" | json_text); fi
fi
if [ "$GEAENDERT" = 1 ]; then
  aus=$(systemctl restart systemd-timesyncd 2>&1) || abbruch "systemd-timesyncd startet nach dem Entfernen des Drop-ins nicht: $(kurz "$aus") — bisher geändert: Drop-in entfernt"
  aend timesyncd-neu-gestartet
fi
# ── Selbstprüfung ──
! zq_eigen || abbruch "Selbstprüfung: $ZQ_DROPIN besteht noch"
if [ "$GEAENDERT" = 1 ]; then Z=geaendert; else Z=schon; fi
ergebnis "{\"zustand\":\"$Z\",\"belassen\":[$BELASSEN],\"aenderungen\":[$AJ]}"`);

/**
 * Rückweg von zeitquelleEinrichtenSkript: entfernt NUR Alfreds Drop-in (Kopfzeile) und startet systemd-timesyncd neu; eine fremde Datei
 * an derselben Stelle bleibt und steht in `belassen`. NTP bleibt an (timesyncd nutzt dann wieder die Ubuntu-Vorgabe). Zeit:
 * LINUX_SQL_ZEIT_MS.zeitquelleEntfernen
 */
export function zeitquelleEntfernenSkript(): string {
  return [...zeitKopf(LINUX_SQL_BAUSTEINE.zeitquelleEntfernen), MARKE, ENTFERNEN_KOERPER].join('\n');
}

// ── Kerberos: Keytab der SQL-Instanz (Task 5) ───────────────────────────────────────────────────────────────────────────────────

/** Hosts mit Keytab (Spec 10: nie sqllnxcfg) und Listener — SPNs je Name mit und ohne Port (Global Constraints: 6 SPNs) */
export const KERBEROS_HOSTS: readonly string[] = ['sqllnx01', 'sqllnx02'];
export const KERBEROS_LISTENER = 'sqllnxag01';
export const KERBEROS_SPNS: readonly string[] = [...KERBEROS_HOSTS, KERBEROS_LISTENER]
  .flatMap(h => [`MSSQLSvc/${h}.${AD_DOMAENE_LINUX}:1433`, `MSSQLSvc/${h}.${AD_DOMAENE_LINUX}`]);
/** nur AES (Global Constraints) — RC4 nie */
export const KERBEROS_ENCTYPES: readonly string[] = ['aes256-cts-hmac-sha1-96', 'aes128-cts-hmac-sha1-96'];
/** Tresor-Eintrag mit dem Kennwort von svc-sqllnx (windows_ad dienstkonto_anlegen) */
export const KERBEROS_KONTO_TRESOR = `ad-${SQL_KERBEROS_KONTO}`;
export const MSSQL_CONF_PROGRAMM = '/opt/mssql/bin/mssql-conf';
export const MSSQL_CONF_DATEI = '/var/opt/mssql/mssql.conf';

export interface KerberosParameter { konto: string; realm: string; spns: string[]; computername: string }

export function kerberosParameter(computername: string): KerberosParameter {
  return { konto: SQL_KERBEROS_KONTO, realm: LINUX_AD.realm, spns: [...KERBEROS_SPNS], computername: computername.trim().toLowerCase() };
}

export function pruefeKerberos(p: unknown): string | undefined {
  const x = obj(p);
  if (x.konto !== SQL_KERBEROS_KONTO) return `konto: nur ${SQL_KERBEROS_KONTO}`;
  if (x.realm !== LINUX_AD.realm) return `realm: nur ${LINUX_AD.realm}`;
  if (!Array.isArray(x.spns) || x.spns.length !== KERBEROS_SPNS.length || x.spns.some((s, i) => s !== KERBEROS_SPNS[i])) return `spns: genau ${KERBEROS_SPNS.join(', ')}`;
  if (typeof x.computername !== 'string' || !COMPUTERNAME.test(x.computername)) return 'computername: Rechnername ohne $, z. B. sqllnx01';
  if (x.computername.toLowerCase() === AD_NIE_BEITRETEN) return `${AD_NIE_BEITRETEN} bekommt keinen Keytab (Spec 10)`;
  if (!KERBEROS_HOSTS.includes(x.computername.toLowerCase())) return `computername: nur ${KERBEROS_HOSTS.join(' oder ')} (Hosts mit SPN MSSQLSvc/<name>.${LINUX_AD.domaene}:1433)`;
  return undefined;
}

/** gemeinsame Werte und Hilfen von kerberos_einrichten und kerberos_entfernen */
const KERBEROS_HILFEN = sh(String.raw`lies() { python3 -c "$PY_CONF" "$1" "$2"; }
SOLL_KLEIN=$(printf '%s\n' "§{SOLL[@]}" | tr 'A-Z' 'a-z')
# Einträge „kvno principal enctype“ (Principal und Enctype klein) aus klist -k -e; 1 = nicht lesbar
kt_eintraege() { local a; a=$(klist -k -e "$1" 2>/dev/null) || return 1; awk '$1 ~ /^[0-9]+$/ && NF >= 3 { e = $3; gsub(/[()]/, "", e); print $1 " " tolower($2) " " tolower(e) }' <<<"$a"; }
# Principals, die nicht in Alfreds Keytab gehören (nur SPNs von svc-sqllnx und das Konto selbst)
kt_fremd() { local k p r; while read -r k p r; do if [ -n "$p" ] && ! grep -qxF -- "$p" <<<"$SOLL_KLEIN"; then printf '%s\n' "$p"; fi; done <<<"$1" | sort -u; }
kt_hoechste() { awk 'BEGIN { m = 0 } { if ($1 + 0 > m) m = $1 + 0 } END { print m }' <<<"$1"; }
# 0 = jeder erwartete Principal mit jedem Enctype in kvno $2
kt_vollstaendig() { local p e; for p in "§{SOLL[@]}"; do for e in "§{ENCTYPES[@]}"; do grep -qxF -- "$2 $(klein "$p") $e" <<<"$1" || return 1; done; done; }
kt_rechte_ok() { [ "$(stat -c '%a %U %G' "$1" 2>/dev/null || true)" = '400 mssql mssql' ]; }
kvno_aus() { sed -n 's/.*kvno = \([0-9][0-9]*\).*/\1/p' <<<"$1" | sed -n 1p; }`);

const KERBEROS_EINRICHTEN_HILFEN = sh(String.raw`schwarz_kw() { local t="$1"; if [ -n "§{KW:-}" ]; then t=§{t//"$KW"/[geschwärzt]}; fi; printf '%s' "$t"; }
# Selbstprüfung eines Keytabs: kinit -k als svc-sqllnx (eigener Zwischenspeicher), dann kvno -k — der Schlüssel im Keytab muss das
# Dienstticket von MSSQLSvc/<fqdn>:1433 entschlüsseln; PKV = kvno, die das AD dabei nennt; danach kdestroy
kt_pruefen() {
  local cc="FILE:$ALFRED_TMP/cc-k" a
  PKV=''; PRUEF_FEHLER=''
  if ! a=$(KRB5CCNAME="$cc" kinit -k -t "$1" "$KONTO@$REALM" 2>&1); then PRUEF_FEHLER="kinit -k -t … $KONTO@$REALM scheitert: $(kurz "$a")"; return 1; fi
  if ! a=$(KRB5CCNAME="$cc" kvno -k "$1" "$SPN_PRUEF@$REALM" 2>&1); then
    PRUEF_FEHLER="kvno -k … $SPN_PRUEF@$REALM scheitert (Schlüssel passt nicht zum AD): $(kurz "$a")"; kdestroy -c "$cc" >/dev/null 2>&1 || true; return 1
  fi
  PKV=$(kvno_aus "$a")
  # R15: auch das Dienstticket des Listeners (die AG-Anmeldungen laufen über sqllnxag01) muss der Keytab entschlüsseln
  if ! a=$(KRB5CCNAME="$cc" kvno -k "$1" "$SPN_LISTENER@$REALM" 2>&1); then
    PRUEF_FEHLER="kvno -k … $SPN_LISTENER@$REALM scheitert (Schlüssel passt nicht zum AD): $(kurz "$a")"; kdestroy -c "$cc" >/dev/null 2>&1 || true; return 1
  fi
  local lkv; lkv=$(kvno_aus "$a")
  if [ "$lkv" != "$PKV" ]; then PRUEF_FEHLER="kvno -k $SPN_LISTENER nennt kvno §{lkv:-keine}, $SPN_PRUEF kvno §{PKV:-keine}"; kdestroy -c "$cc" >/dev/null 2>&1 || true; return 1; fi
  kdestroy -c "$cc" >/dev/null 2>&1 || true
}
# ktutil-Befehle (nur Builtins: das Kennwort erscheint in keiner Befehlszeile und in keiner Datei): ältere Einträge lesen, Einträge der
# AD-kvno ersetzen, je Principal und Enctype addent mit dem Salz des Kontos, Kennwort als folgende Zeile, neuer Keytab
kt_befehle() {
  local s p e
  if [ -e "$SQL_KT" ]; then printf 'rkt %s\n' "$SQL_KT"; for s in $SLOTS; do printf 'delent %s\n' "$s"; done; fi
  for p in "§{SOLL[@]}"; do for e in "§{ENCTYPES[@]}"; do
    printf 'addent -password -p %s -k %s -e %s -s %s\n%s\n' "$p" "$ADKV" "$e" "$SALT" "$KW"
  done; done
  printf 'wkt %s\nquit\n' "$NEU"
}
setze_conf() {
  [ "$(lies network "$1")" != "$2" ] || return 0
  local aus; aus=$("$MSSQLCONF" set "network.$1" "$2" 2>&1) || abbruch "mssql-conf set network.$1 fehlgeschlagen: $(kurz "$aus") — Keytab bleibt (Rückweg kerberos_entfernen)"
  aend "mssql-conf:$1"
}
# 0 = SQL Server muss neu starten: in diesem Lauf geändert, Dienst nicht aktiv oder Keytab/mssql.conf jünger als der Dienststart
neustart_noetig() {
  [ "$GEAENDERT" = 0 ] || return 0
  systemctl is-active --quiet mssql-server || return 0
  local t s=0
  t=$(systemctl show -p ActiveEnterTimestamp --value mssql-server 2>/dev/null || true)
  if [ -n "$t" ]; then s=$(date -d "$t" +%s 2>/dev/null || echo 0); fi
  [ "$(stat -c %Y "$SQL_KT")" -lt "$s" ] || return 0
  [ ! -f "$MSSQL_CONF" ] || [ "$(stat -c %Y "$MSSQL_CONF")" -lt "$s" ] || return 0
  return 1
}
# AD-kvno jetzt (Ticket aus dem Kennwort-TGT dieses Laufs)
ad_kvno_jetzt() { local a; a=$(KRB5CCNAME="$CC" kvno "$SPN_PRUEF@$REALM" 2>&1) || return 1; kvno_aus "$a"; }
alfred_aufraeumen() {
  [ -z "§{NEU_DIR:-}" ] || rm -rf -- "$NEU_DIR"
  if [ -n "§{CC:-}" ]; then kdestroy -c "$CC" >/dev/null 2>&1 || true; fi
}`);

const KERBEROS_EINRICHTEN_KOERPER = sh(String.raw`KW=$(feld kennwort) || abbruch "Kennwort von $KONTO enthält nicht druckbare Zeichen"
[ -n "$KW" ] || abbruch "kein Kennwort von $KONTO in der Eingabe (Tresor $KONTO_TRESOR) — nichts geändert"
# ── Phase 1: prüfen — bis hierhin wird nichts geändert ──
[ -n "$(paket_version mssql-server)" ] || abbruch "mssql-server ist nicht installiert — nichts geändert"
[ -x "$MSSQLCONF" ] || abbruch "$MSSQLCONF fehlt — nichts geändert"
id mssql >/dev/null 2>&1 || abbruch "Benutzer mssql fehlt — nichts geändert"
for b in kinit kvno klist ktutil kdestroy realm; do command -v "$b" >/dev/null 2>&1 || abbruch "$b fehlt (krb5-user/realmd aus ad_beitreten) — nichts geändert"; done
NICHT_BEI="nicht in $DOM beigetreten — zuerst linux_sql ad_beitreten; nichts geändert"
{ [ -f "$SSSD_CONF" ] && sssd_eigen; } || abbruch "$NICHT_BEI ($SSSD_CONF fehlt oder ist nicht von Alfred)"
{ [ -f "$KRB5_CONF" ] && krb5_eigen; } || abbruch "$NICHT_BEI ($KRB5_CONF fehlt oder ist nicht von Alfred)"
realm_hat || abbruch "$NICHT_BEI (realm list zeigt $DOM nicht)"
${ZEIT_VORBEDINGUNG}
ALFRED_TMP=$(mktemp -d "$TMP_BASIS/alfred-kt.XXXXXX"); chmod 0700 "$ALFRED_TMP"
CC="FILE:$ALFRED_TMP/cc"
# TGT mit dem Kennwort (nur über die Pipe aus dem Builtin printf); der Trace nennt das Salz des Kontos aus etype-info2 des KDC
if ! printf '%s\n' "$KW" | KRB5CCNAME="$CC" KRB5_TRACE="$ALFRED_TMP/trace" kinit "$KONTO@$REALM" >"$ALFRED_TMP/kinit.log" 2>&1; then
  abbruch "kinit $KONTO@$REALM mit dem Kennwort aus dem Tresor scheitert: $(schwarz_kw "$(kurz "$(cat "$ALFRED_TMP/kinit.log")")") — nichts geändert"
fi
if ! a=$(KRB5CCNAME="$CC" kvno "$SPN_PRUEF@$REALM" 2>&1); then
  abbruch "kvno $SPN_PRUEF@$REALM scheitert: $(kurz "$a") — SPN am Konto $KONTO? (windows_ad spn_setzen); nichts geändert"
fi
ADKV=$(kvno_aus "$a")
[[ "$ADKV" =~ ^[1-9][0-9]{0,5}$ ]] || abbruch "AD-kvno von $SPN_PRUEF nicht lesbar ($(kurz "$a")) — nichts geändert"
# AD-Salz (REALM + sAMAccountName) gilt für alle Schlüssel des Kontos, auch für die SPNs — gelesen aus dem KDC, sonst nach dieser Regel
SALT=$(sed -n 's/.*salt "\([^"]*\)".*/\1/p' "$ALFRED_TMP/trace" 2>/dev/null | sed -n 1p || true); SALZ=kdc
rm -f -- "$ALFRED_TMP/trace"
if [ -z "$SALT" ] || ! [[ "$SALT" =~ ^[[:graph:]]+$ ]]; then SALT="$REALM$KONTO"; SALZ=regel; fi
ALT=''; AK=''
if [ -e "$SQL_KT" ]; then
  ALT=$(kt_eintraege "$SQL_KT") || abbruch "$SQL_KT nicht lesbar (klist -k) — nichts geändert"
  fr=$(kt_fremd "$ALT")
  [ -z "$fr" ] || abbruch "$SQL_KT enthält fremde Principals ($(printf '%s' "$fr" | sed -n 1,3p | tr '\n' ' ')) — nichts geändert"
  AH=$(kt_hoechste "$ALT")
  [ "$AH" -le "$ADKV" ] || abbruch "Keytab-kvno $AH, AD-kvno $ADKV — $SQL_KT ist neuer als das AD (Konto $KONTO neu angelegt?) — nichts geändert"
  for k in $(awk '{ print $1 }' <<<"$ALT" | sort -un); do if [ "$k" -lt "$ADKV" ]; then AK+="§{AK:+,}$k"; fi; done
fi
# ── Phase 2: Keytab (bestehende Einträge niedrigerer kvno bleiben, Spec 7.7) ──
KT=schon
if [ -n "$ALT" ] && kt_vollstaendig "$ALT" "$ADKV" && kt_pruefen "$SQL_KT" && [ "$PKV" = "$ADKV" ]; then
  :
else
  KT=neu
  KT_DIR=§{SQL_KT%/*}
  if [ ! -d "$KT_DIR" ]; then mkdir -p "$KT_DIR"; chown mssql:mssql "$KT_DIR"; chmod 0700 "$KT_DIR"; aend secrets-ordner; fi
  NEU_DIR=$(mktemp -d "$KT_DIR/.alfred-kt-XXXXXX"); NEU="$NEU_DIR/mssql.keytab"
  SLOTS=''
  if [ -e "$SQL_KT" ]; then
    l=$(printf 'rkt %s\nlist\nquit\n' "$SQL_KT" | ktutil 2>&1) || abbruch "ktutil liest $SQL_KT nicht: $(kurz "$l") — nichts geändert"
    SLOTS=$(awk -v k="$ADKV" '$1 ~ /^[0-9]+$/ && $2 == k { print $1 }' <<<"$l" | sort -rn)
  fi
  kt_befehle | ktutil >"$ALFRED_TMP/ktutil.log" 2>&1 || abbruch "ktutil fehlgeschlagen: $(schwarz_kw "$(kurz "$(cat "$ALFRED_TMP/ktutil.log")")") — $SQL_KT unverändert"
  KTLOG=$(schwarz_kw "$(kurz "$(cat "$ALFRED_TMP/ktutil.log")")"); rm -f -- "$ALFRED_TMP/ktutil.log"
  [ -s "$NEU" ] || abbruch "ktutil hat keinen Keytab geschrieben: $KTLOG — $SQL_KT unverändert"
  chown mssql:mssql "$NEU"; chmod 0400 "$NEU"
  NE=$(kt_eintraege "$NEU") || abbruch "neuer Keytab nicht lesbar (klist -k): $KTLOG — $SQL_KT unverändert"
  kt_vollstaendig "$NE" "$ADKV" || abbruch "Selbstprüfung: im neuen Keytab fehlen Einträge mit kvno $ADKV (§{#SOLL[@]} Principals × aes256/aes128): $KTLOG — $SQL_KT unverändert"
  [ -z "$(kt_fremd "$NE")" ] || abbruch "Selbstprüfung: neuer Keytab enthält fremde Principals — $SQL_KT unverändert"
  while IFS= read -r z; do
    if [ -n "$z" ] && [ "§{z%% *}" -lt "$ADKV" ] && ! grep -qxF -- "$z" <<<"$NE"; then abbruch "Selbstprüfung: älterer Eintrag ($z) fehlt im neuen Keytab — $SQL_KT unverändert"; fi
  done <<<"$ALT"
  if ! kt_pruefen "$NEU"; then
    # Review Focus 2: hat das AD inzwischen eine andere kvno (Kennwort während des Laufs gewechselt), beide Zahlen nennen
    JETZT=$(ad_kvno_jetzt || true)
    [ -z "$JETZT" ] || [ "$JETZT" = "$ADKV" ] || abbruch "Keytab-kvno $ADKV, AD-kvno $JETZT — Kennwort von $KONTO während des Laufs geändert? $SQL_KT und mssql-conf unverändert"
    abbruch "Selbstprüfung: $PRUEF_FEHLER — $SQL_KT und mssql-conf unverändert"
  fi
  [ "$PKV" = "$ADKV" ] || abbruch "Keytab-kvno $ADKV, AD-kvno §{PKV:-unbekannt} — Kennwort von $KONTO während des Laufs geändert? $SQL_KT und mssql-conf unverändert"
  mv -f -- "$NEU" "$SQL_KT"
  aend keytab
fi
if ! kt_rechte_ok "$SQL_KT"; then chown mssql:mssql "$SQL_KT"; chmod 0400 "$SQL_KT"; aend keytab-rechte; fi
# ── Phase 3: mssql-conf (nur bei Abweichung; wirkt erst nach dem Neustart — der läuft rollierend per Change, nicht hier) ──
setze_conf kerberoskeytabfile "$SQL_KT"
setze_conf privilegedadaccount "$KONTO"
# ── Selbstprüfung ──
E=$(kt_eintraege "$SQL_KT") || abbruch "Selbstprüfung: $SQL_KT nicht lesbar"
kt_vollstaendig "$E" "$ADKV" || abbruch "Selbstprüfung: $SQL_KT ohne alle Einträge mit kvno $ADKV"
EH=$(kt_hoechste "$E")
[ "$EH" = "$ADKV" ] || abbruch "Keytab-kvno $EH, AD-kvno $ADKV"
kt_rechte_ok "$SQL_KT" || abbruch "Selbstprüfung: $SQL_KT ist nicht 0400 mssql:mssql"
[ "$(lies network kerberoskeytabfile)" = "$SQL_KT" ] || abbruch "Selbstprüfung: mssql.conf network.kerberoskeytabfile ist nicht $SQL_KT"
[ "$(lies network privilegedadaccount)" = "$KONTO" ] || abbruch "Selbstprüfung: mssql.conf network.privilegedadaccount ist nicht $KONTO"
kdestroy -c "$CC" >/dev/null 2>&1 || true
if neustart_noetig; then NN=true; else NN=false; fi
if [ "$GEAENDERT" = 1 ]; then Z=geaendert; else Z=schon; fi
ergebnis "{\"zustand\":\"$Z\",\"kvno\":$ADKV,\"spns\":§{#SPNS[@]},\"principals\":§{#SOLL[@]},\"keytab\":\"$SQL_KT\",\"keytabNeu\":$([ "$KT" = neu ] && echo true || echo false),\"aeltereKvno\":[$AK],\"salz\":\"$SALZ\",\"fqdn\":\"$FQDN\",\"neustartNoetig\":$NN,\"aenderungen\":[$AJ]}"`);

function kerberosWerte(): string[] {
  return [
    `KONTO=${shQ(SQL_KERBEROS_KONTO)}`,
    `KONTO_TRESOR=${shQ(KERBEROS_KONTO_TRESOR)}`,
    `SQL_KT=${shQ(SQL_KEYTAB)}`,
    `SPNS=(${KERBEROS_SPNS.map(shQ).join(' ')})`,
    `SOLL=(${[...KERBEROS_SPNS, SQL_KERBEROS_KONTO].map(p => shQ(`${p}@${LINUX_AD.realm}`)).join(' ')})`,
    `ENCTYPES=(${KERBEROS_ENCTYPES.map(shQ).join(' ')})`,
    `MSSQLCONF=${shQ(MSSQL_CONF_PROGRAMM)}`,
    `MSSQL_CONF=${shQ(MSSQL_CONF_DATEI)}`,
    `PY_CONF=${shQ(PY_CONF)}`,
  ];
}

/**
 * I8e Etappe 3 Task 5 (Spec 7.3 Nr. 2) — Keytab der SQL-Instanz AUF dem Host aus dem Kennwort von svc-sqllnx (stdin `{ kennwort }`).
 * Prüfen ohne Änderung: mssql-server installiert, beigetreten (Alfreds sssd.conf/krb5.conf, realm list), Zeitquelle (R11). Dann
 * `kinit` mit dem Kennwort (Pipe aus dem Builtin printf, privater Zwischenspeicher in ALFRED_TMP) → `kvno MSSQLSvc/<fqdn>:1433` = AD-kvno;
 * Salz des Kontos aus dem KDC-Trace (etype-info2), sonst AD-Regel REALM + sAMAccountName. ktutil 1.20 (Ubuntu 24.04): `addent -password
 * -p … -k <kvno> -e <enctype> -s <salz>` — `-s` statt `-f`, weil `-f` für jeden SPN eine AS-Anfrage auf den SPN als Client stellt; das
 * Salz ist für alle Schlüssel eines AD-Kontos gleich. Ein vorhandener Keytab: fremde Principals oder höhere kvno als das AD → Abbruch
 * ohne Änderung; Einträge niedrigerer kvno bleiben (Spec 7.7), Einträge der AD-kvno werden ersetzt. Der neue Keytab entsteht in einem
 * eigenen Ordner neben dem Ziel, bekommt mssql:mssql 0400, wird geprüft (klist -k -e: 6 SPNs + Konto × AES256/AES128 mit der AD-kvno;
 * `kinit -k -t`, `kvno -k` → kvno gleich, sonst Abbruch „Keytab-kvno X, AD-kvno Y“ ohne mssql-conf) und erst dann verschoben. mssql-conf
 * network.kerberoskeytabfile/privilegedadaccount nur bei Abweichung. KEIN Neustart (neustartNoetig im Ergebnis). Zeit:
 * LINUX_SQL_ZEIT_MS.kerberosEinrichten
 */
export function kerberosSkript(p: KerberosParameter): string {
  const f = pruefeKerberos(p); if (f) throw new Error(f);
  const klein = p.computername.toLowerCase();
  return [
    ...sqlKopf(LINUX_SQL_BAUSTEINE.kerberosEinrichten, { konto: p.konto, realm: p.realm, spns: [...p.spns], computername: klein }),
    HILFEN,
    ...kennung(klein),
    `SPN_PRUEF=${shQ(`MSSQLSvc/${klein}.${LINUX_AD.domaene}:1433`)}`,
    `SPN_LISTENER=${shQ(`MSSQLSvc/${KERBEROS_LISTENER}.${LINUX_AD.domaene}:1433`)}`,
    `UHR_MAX_MS=${AD_UHR_MAX_S * 1000}`,
    ZEIT_HILFEN,
    ...kerberosWerte(),
    KERBEROS_HILFEN,
    KERBEROS_EINRICHTEN_HILFEN,
    MARKE,
    KERBEROS_EINRICHTEN_KOERPER,
  ].join('\n');
}

const KERBEROS_ENTFERNEN_KOERPER = sh(String.raw`BELASSEN=''
belassen() { BELASSEN+="§{BELASSEN:+,}$(printf '%s' "$1" | json_text)"; }
# mssql-conf nur, wenn die Werte Alfreds sind; fremde Werte bleiben (belassen)
if [ -x "$MSSQLCONF" ]; then
  for kv in "kerberoskeytabfile=$SQL_KT" "privilegedadaccount=$KONTO"; do
    k=§{kv%%=*}; s=§{kv#*=}; v=$(lies network "$k")
    if [ "$v" = "$s" ]; then
      aus=$("$MSSQLCONF" unset "network.$k" 2>&1) || abbruch "mssql-conf unset network.$k fehlgeschlagen: $(kurz "$aus")"
      aend "mssql-conf:$k"
    elif [ -n "$v" ]; then belassen "network.$k = $v (nicht Alfreds Wert)"; fi
  done
fi
# Keytab nur, wenn er ausschließlich SPNs von svc-sqllnx und das Konto enthält
if [ -e "$SQL_KT" ]; then
  E=''
  if command -v klist >/dev/null 2>&1; then E=$(kt_eintraege "$SQL_KT" || true); fi
  if [ -n "$E" ] && [ -z "$(kt_fremd "$E")" ]; then rm -f -- "$SQL_KT"; aend keytab
  else belassen "$SQL_KT (enthält fremde Principals oder ist nicht lesbar: $(kt_fremd "$E" | sed -n 1,3p | tr '\n' ' '))"; fi
fi
# ── Selbstprüfung ──
if [ -x "$MSSQLCONF" ]; then
  [ "$(lies network kerberoskeytabfile)" != "$SQL_KT" ] || abbruch "Selbstprüfung: network.kerberoskeytabfile zeigt noch auf $SQL_KT"
  [ "$(lies network privilegedadaccount)" != "$KONTO" ] || abbruch "Selbstprüfung: network.privilegedadaccount ist noch $KONTO"
fi
if [ "$GEAENDERT" = 1 ]; then Z=geaendert; NN=true; else Z=schon; NN=false; fi
ergebnis "{\"zustand\":\"$Z\",\"belassen\":[$BELASSEN],\"neustartNoetig\":$NN,\"aenderungen\":[$AJ]}"`);

/**
 * Rückweg von kerberosSkript: mssql-conf network.kerberoskeytabfile/privilegedadaccount nur entfernen, wenn sie Alfreds Werte tragen;
 * Keytab nur, wenn er ausschließlich svc-sqllnx/MSSQLSvc-Principals enthält. Fremdes bleibt (belassen). KEIN Neustart
 * (neustartNoetig, sobald etwas geändert wurde). Zeit: LINUX_SQL_ZEIT_MS.kerberosEntfernen
 */
export function kerberosEntfernenSkript(): string {
  return [
    ...sqlKopf(LINUX_SQL_BAUSTEINE.kerberosEntfernen, {}),
    HILFEN,
    ...kerberosWerte(),
    KERBEROS_HILFEN,
    MARKE,
    KERBEROS_ENTFERNEN_KOERPER,
  ].join('\n');
}

// ── ad_login / ad_login_entfernen (Task 8, Spec 7.4 Nr. 5) ───────────────────────────────────────────────────────────────────────────

/** AD-Gruppe (sAMAccountName): Buchstabe/Ziffer, dann Buchstaben, Ziffern, Leerzeichen, . _ - (2–64 Zeichen), nicht auf Leerzeichen/Punkt endend */
export const AD_LOGIN_GRUPPE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}[A-Za-z0-9_-]$/;
export const AD_LOGIN_SERVERROLLEN: readonly string[] = ['sysadmin'];
/** feste Liste der Datenbankrollen (keine benutzerdefinierten Rollen, kein db_securityadmin/db_accessadmin) */
export const AD_LOGIN_DB_ROLLEN: readonly string[] = ['db_datareader', 'db_datawriter', 'db_ddladmin', 'db_owner'];
const AD_LOGIN_DB = /^[A-Za-z][A-Za-z0-9_]{2,63}$/;
const AD_LOGIN_SYSTEM_DBS = new Set(['master', 'model', 'msdb', 'tempdb']);
/**
 * Eigentumsnachweis (SQL-Logins haben keine Beschreibung): jede Anlage durch ad_login steht VOR der Anlage als Zeile in dieser Datei
 * (root 0600, Kopfzeile) — L|<login>, S|<serverrolle>|<login>, U|<db>|<login>, R|<db>|<rolle>|<login>. ad_login_entfernen nimmt nur
 * zurück, was hier steht und noch ein Windows-Gruppen-Objekt ist; Vorhandenes (vor Alfred) bleibt und steht unter „belassen“.
 */
export const AD_LOGINS_DATEI = '/etc/alfred/sqllnx-ad-logins';
export const AD_LOGINS_KOPF = '# Alfred I8e — linux_sql ad_login (von Alfred angelegte AD-Logins und Mitgliedschaften, nicht von Hand ändern)';

export interface AdLoginParameter { gruppe: string; serverrolle?: string; datenbank?: string; datenbankrolle?: string }

/** Login-Name AD3033\<gruppe> */
export const adLoginName = (gruppe: string) => `${LINUX_AD.netbios}\\${gruppe}`;

export function pruefeAdLogin(p: unknown): string | undefined {
  const x = obj(p);
  if (typeof x.gruppe !== 'string' || !AD_LOGIN_GRUPPE.test(x.gruppe)) return 'gruppe: Name der AD-Gruppe (Buchstaben, Ziffern, Leerzeichen, . _ -; 2–64 Zeichen, ohne ] \' \\)';
  if (x.serverrolle !== undefined && (typeof x.serverrolle !== 'string' || !AD_LOGIN_SERVERROLLEN.includes(x.serverrolle))) return `serverrolle: nur ${AD_LOGIN_SERVERROLLEN.join(', ')}`;
  if ((x.datenbank === undefined) !== (x.datenbankrolle === undefined)) return 'datenbank und datenbankrolle nur zusammen';
  if (x.datenbank !== undefined && (typeof x.datenbank !== 'string' || !AD_LOGIN_DB.test(x.datenbank) || AD_LOGIN_SYSTEM_DBS.has(x.datenbank.toLowerCase()))) return 'datenbank: Buchstabe, dann Buchstaben/Ziffern/_ (3–64 Zeichen), keine Systemdatenbank';
  if (x.datenbankrolle !== undefined && (typeof x.datenbankrolle !== 'string' || !AD_LOGIN_DB_ROLLEN.includes(x.datenbankrolle))) return `datenbankrolle: nur ${AD_LOGIN_DB_ROLLEN.join(', ')}`;
  if (x.serverrolle === undefined && x.datenbank === undefined) return 'serverrolle oder datenbank + datenbankrolle angeben';
  const fremd = Object.keys(x).filter(k => !['gruppe', 'serverrolle', 'datenbank', 'datenbankrolle'].includes(k));
  return fremd.length ? `unbekannte Felder: ${fremd.join(', ').slice(0, 80)}` : undefined;
}

/**
 * Lage (nur lesend): „ALFRED|L|<typ|->|<deaktiviert|->|<Mitglied der Serverrolle 0/1>“ und mit Datenbank „ALFRED|D|fehlt|sekundaer|
 * nicht-schreibbar“ bzw. „ALFRED|D|ok|<typ|->|<SID = Login 0/1>|<Mitglied der Datenbankrolle 0/1>“. Katalogspalten in Verkettungen mit
 * COLLATE DATABASE_DEFAULT (Lehre v1898). Datenbankteil über <db>.sys.sp_executesql mit Parametern (Name nie im dynamischen Text).
 */
function adLoginLage(n: string, p: AdLoginParameter): string {
  return [
    'SET NOCOUNT ON;',
    `DECLARE @n sysname = N'${n}', @srolle sysname = N'${p.serverrolle ?? ''}';`,
    "SELECT N'ALFRED|L|' + ISNULL((SELECT RTRIM(sp.type) COLLATE DATABASE_DEFAULT FROM sys.server_principals sp WHERE sp.name = @n), N'-') + N'|'",
    "  + ISNULL((SELECT CAST(sp.is_disabled AS nvarchar(1)) FROM sys.server_principals sp WHERE sp.name = @n), N'-') + N'|'",
    '  + CAST((SELECT COUNT(*) FROM sys.server_role_members m JOIN sys.server_principals r ON r.principal_id = m.role_principal_id JOIN sys.server_principals l ON l.principal_id = m.member_principal_id WHERE l.name = @n AND r.name = @srolle) AS nvarchar(5));',
    ...(p.datenbank ? [
      `DECLARE @db sysname = N'${p.datenbank}', @drolle sysname = N'${p.datenbankrolle}';`,
      "IF DB_ID(@db) IS NULL SELECT N'ALFRED|D|fehlt';",
      "ELSE IF EXISTS (SELECT 1 FROM sys.dm_hadr_database_replica_states s WHERE s.database_id = DB_ID(@db) AND s.is_local = 1 AND s.is_primary_replica = 0) SELECT N'ALFRED|D|sekundaer';",
      "ELSE IF CAST(DATABASEPROPERTYEX(@db, 'Status') AS nvarchar(30)) <> N'ONLINE' OR CAST(DATABASEPROPERTYEX(@db, 'Updateability') AS nvarchar(30)) <> N'READ_WRITE' SELECT N'ALFRED|D|nicht-schreibbar';",
      'ELSE',
      'BEGIN',
      '  DECLARE @t nvarchar(10), @sid int, @rm int, @proc nvarchar(300) = QUOTENAME(@db) + N\'.sys.sp_executesql\';',
      "  EXEC @proc N'SELECT @t = RTRIM(d.type) COLLATE DATABASE_DEFAULT, @sid = CASE WHEN d.sid = (SELECT s.sid FROM master.sys.server_principals s WHERE s.name = @n) THEN 1 ELSE 0 END FROM sys.database_principals d WHERE d.name = @n; SELECT @rm = COUNT(*) FROM sys.database_role_members m JOIN sys.database_principals r ON r.principal_id = m.role_principal_id JOIN sys.database_principals u ON u.principal_id = m.member_principal_id WHERE u.name = @n AND r.name = @drolle;',",
      "    N'@n sysname, @drolle sysname, @t nvarchar(10) OUTPUT, @sid int OUTPUT, @rm int OUTPUT', @n = @n, @drolle = @drolle, @t = @t OUTPUT, @sid = @sid OUTPUT, @rm = @rm OUTPUT;",
      "  SELECT N'ALFRED|D|ok|' + ISNULL(@t, N'-') + N'|' + CAST(ISNULL(@sid, 0) AS nvarchar(1)) + N'|' + CAST(ISNULL(@rm, 0) AS nvarchar(5));",
      'END',
    ] : []),
  ].join('\n');
}

/** Anlegen (idempotent): fremder Typ/deaktiviert/abweichender Datenbankbenutzer → THROW vor jeder Änderung; dann Login, Rollen, Benutzer */
function adLoginAnlegen(n: string, p: AdLoginParameter): string {
  return [
    'SET NOCOUNT ON; SET XACT_ABORT ON;',
    `DECLARE @n sysname = N'${n}';`,
    `IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = @n AND type <> 'G') THROW 50020, N'Login ${n} besteht und ist kein Windows-Gruppen-Login - nichts geändert', 1;`,
    `IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = @n AND is_disabled = 1) THROW 50021, N'Login ${n} ist deaktiviert - nicht still aktiviert; bitte bewusst entscheiden', 1;`,
    ...(p.datenbank ? [
      `DECLARE @db sysname = N'${p.datenbank}', @proc nvarchar(300) = QUOTENAME(N'${p.datenbank}') + N'.sys.sp_executesql';`,
      "EXEC @proc N'IF EXISTS (SELECT 1 FROM sys.database_principals d WHERE d.name = @n AND (d.type <> ''G'' OR d.sid <> ISNULL((SELECT s.sid FROM master.sys.server_principals s WHERE s.name = @n), d.sid))) THROW 50022, N''Datenbankbenutzer passt nicht zum Login (Typ oder SID) - nichts geändert'', 1;', N'@n sysname', @n = @n;",
    ] : []),
    `IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = @n) CREATE LOGIN [${n}] FROM WINDOWS WITH DEFAULT_DATABASE = [master];`,
    ...(p.serverrolle ? [
      `IF NOT EXISTS (SELECT 1 FROM sys.server_role_members m JOIN sys.server_principals r ON r.principal_id = m.role_principal_id JOIN sys.server_principals l ON l.principal_id = m.member_principal_id WHERE l.name = @n AND r.name = N'${p.serverrolle}') ALTER SERVER ROLE [${p.serverrolle}] ADD MEMBER [${n}];`,
    ] : []),
    ...(p.datenbank ? [
      "EXEC @proc N'IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @n) BEGIN DECLARE @c nvarchar(400) = N''CREATE USER '' + QUOTENAME(@n) + N'' FOR LOGIN '' + QUOTENAME(@n); EXEC (@c); END;",
      " IF NOT EXISTS (SELECT 1 FROM sys.database_role_members m JOIN sys.database_principals r ON r.principal_id = m.role_principal_id JOIN sys.database_principals u ON u.principal_id = m.member_principal_id WHERE u.name = @n AND r.name = @drolle)",
      " BEGIN DECLARE @r nvarchar(400) = N''ALTER ROLE '' + QUOTENAME(@drolle) + N'' ADD MEMBER '' + QUOTENAME(@n); EXEC (@r); END;',",
      `  N'@n sysname, @drolle sysname', @n = @n, @drolle = N'${p.datenbankrolle}';`,
    ] : []),
    "SELECT N'ALFRED|A|ok';",
  ].join('\n');
}

/** Entfernen nur der markierten Objekte (@@DR@@ Datenbankrolle, @@DU@@ Benutzer, @@DS@@ Serverrolle, @@DL@@ Login — je 0/1 aus Bash) */
function adLoginEntfernenTsql(n: string, p: AdLoginParameter): string {
  return [
    'SET NOCOUNT ON; SET XACT_ABORT ON;',
    `DECLARE @n sysname = N'${n}', @dr bit = @@DR@@, @du bit = @@DU@@, @ds bit = @@DS@@, @dl bit = @@DL@@;`,
    ...(p.datenbank ? [
      `DECLARE @proc nvarchar(300) = QUOTENAME(N'${p.datenbank}') + N'.sys.sp_executesql';`,
      'IF @dr = 1 OR @du = 1',
      "  EXEC @proc N'IF @dr = 1 AND EXISTS (SELECT 1 FROM sys.database_role_members m JOIN sys.database_principals r ON r.principal_id = m.role_principal_id JOIN sys.database_principals u ON u.principal_id = m.member_principal_id WHERE u.name = @n AND r.name = @drolle)",
      " BEGIN DECLARE @c nvarchar(400) = N''ALTER ROLE '' + QUOTENAME(@drolle) + N'' DROP MEMBER '' + QUOTENAME(@n); EXEC (@c); END;",
      " IF @du = 1 AND EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @n AND type = ''G'') BEGIN DECLARE @d nvarchar(400) = N''DROP USER '' + QUOTENAME(@n); EXEC (@d); END;',",
      `    N'@n sysname, @drolle sysname, @dr bit, @du bit', @n = @n, @drolle = N'${p.datenbankrolle}', @dr = @dr, @du = @du;`,
    ] : []),
    ...(p.serverrolle ? [
      `IF @ds = 1 AND EXISTS (SELECT 1 FROM sys.server_role_members m JOIN sys.server_principals r ON r.principal_id = m.role_principal_id JOIN sys.server_principals l ON l.principal_id = m.member_principal_id WHERE l.name = @n AND r.name = N'${p.serverrolle}') ALTER SERVER ROLE [${p.serverrolle}] DROP MEMBER [${n}];`,
    ] : []),
    `IF @dl = 1 AND EXISTS (SELECT 1 FROM sys.server_principals WHERE name = @n AND type = 'G') DROP LOGIN [${n}];`,
    "SELECT N'ALFRED|E|ok';",
  ].join('\n');
}

const AD_LOGIN_HILFEN = sh(String.raw`NICHT='nichts geändert'
GEAENDERT=0; AJ=''
aend() { GEAENDERT=1; AJ+="§{AJ:+,}\"$1\""; }
lies() { python3 -c "$PY_CONF" "$1" "$2"; }
# Lage lesen → L_TYP L_AUS L_ROLLE, D_Z D_TYP D_SID D_RM (D_* nur mit Datenbank)
lage() {
  local a l d
  a=$(sql "$LAGE_Q" 2>&1) || abbruch "Lage von $LOGIN nicht lesbar: $(sql_fehlerzeile "$a")"
  l=$(grep '^ALFRED|L|' <<<"$a" | head -n 1 | tr -d '\r' || true)
  IFS='|' read -r _ _ L_TYP L_AUS L_ROLLE <<<"$l"
  [ -n "§{L_TYP:-}" ] || abbruch "Lage von $LOGIN ohne Ergebniszeile: $(kurz "$a")"
  D_Z=''; D_TYP='-'; D_SID=0; D_RM=0
  if [ -n "$DB" ]; then
    d=$(grep '^ALFRED|D|' <<<"$a" | head -n 1 | tr -d '\r' || true)
    IFS='|' read -r _ _ D_Z D_TYP D_SID D_RM <<<"$d"
    [ -n "$D_Z" ] || abbruch "Lage der Datenbank $DB ohne Ergebniszeile: $(kurz "$a")"
  fi
}
# Eigentumsnachweis (AD_LOGINS_DATEI): nur Alfreds Datei (Kopfzeile, reguläre Datei, 0600 root:root)
marker_eigen() { [ -f "$MARKER" ] && [ ! -L "$MARKER" ] && [ "$(head -n 1 "$MARKER")" = "$MARKER_KOPF" ] && [ "$(stat -c '%a %U %G' "$MARKER" 2>/dev/null || true)" = '600 root root' ]; }
marker_pruefen() { if [ -e "$MARKER" ] || [ -L "$MARKER" ]; then marker_eigen || abbruch "$MARKER ist vorhanden und nicht von Alfred — $NICHT"; fi; }
marker_hat() { marker_eigen && grep -qxF -- "$1" "$MARKER"; }
# $1 = dazu|weg, weitere Argumente = Zeilen; schreibt atomar (Zwischendatei im Ordner, Rechte vor dem Inhalt, mv)
marker_setzen() {
  local art=$1 t e; shift
  [ $# -gt 0 ] || return 0
  [ -d "§{MARKER%/*}" ] || { mkdir -p "§{MARKER%/*}"; chmod 0755 "§{MARKER%/*}"; }
  t=$(mktemp "§{MARKER%/*}/.alfred-adl-XXXXXX"); chown root:root "$t"; chmod 0600 "$t"
  { if marker_eigen; then cat -- "$MARKER"; else printf '%s\n' "$MARKER_KOPF"; fi; } >"$t.alt"
  if [ "$art" = dazu ]; then
    cat -- "$t.alt" >"$t"
    for e in "$@"; do grep -qxF -- "$e" "$t" || printf '%s\n' "$e" >>"$t"; done
  else
    cp -- "$t.alt" "$t.rest"
    for e in "$@"; do { grep -vxF -- "$e" "$t.rest" || true; } >"$t.neu"; mv -f -- "$t.neu" "$t.rest"; done
    cat -- "$t.rest" >"$t"; rm -f -- "$t.rest"
  fi
  rm -f -- "$t.alt"
  mv -f -- "$t" "$MARKER"
}
sql_meldung() { local z; z=$(grep -m 1 -E 'Msg [0-9]+|Sqlcmd: Error' <<<"$1" | tr -d '\r' || true); [ -n "$z" ] || z=$(kurz "$1"); printf '%s %s' "$z" "$(grep -v '^Msg ' <<<"$1" | grep -v '^ALFRED|' | head -n 2 | tr '\r\n' '  ' || true)"; }`);

const AD_LOGIN_VORBEDINGUNG = sh(String.raw`# ── Phase 1: prüfen — bis hierhin wird nichts geändert ──
[ "$(hostname -s 2>/dev/null || true)" != "$NIE" ] || abbruch "$NIE bekommt keine AD-Logins (Spec 10) — $NICHT"
# Auflösung von AD-Namen: Host über Alfred beigetreten (sssd.conf mit Alfred-Kopf, sssd aktiv), Gruppe über NSS sichtbar; SQL Server
# selbst löst den Namen über seinen Keytab (network.kerberoskeytabfile, privilegedadaccount) — beides vorher (ad_beitreten, kerberos_einrichten + Neustart)
{ [ -f "$SSSD_CONF" ] && [ "$(head -n 1 "$SSSD_CONF")" = "$SSSD_KOPF" ]; } || abbruch "Host nicht über Alfred beigetreten ($SSSD_CONF ohne Alfred-Kopf) — zuerst ad_beitreten; $NICHT"
systemctl is-active --quiet sssd || abbruch "sssd läuft nicht — AD-Namen nicht auflösbar; $NICHT"
getent group "$GRUPPE_NSS" >/dev/null 2>&1 || abbruch "Gruppe $GRUPPE_NSS im AD nicht auflösbar (getent group) — Gruppe im AD vorhanden (windows_ad gruppe_anlegen), Host beigetreten? $NICHT"
{ [ "$(lies network kerberoskeytabfile)" = "$SQL_KT" ] && [ -f "$SQL_KT" ]; } || abbruch "SQL Server ohne Alfreds Keytab ($SQL_KT in mssql.conf network.kerberoskeytabfile) — zuerst kerberos_einrichten und Neustart; $NICHT"
marker_pruefen
bereit || abbruch "SQL Server antwortet nicht als sa — $NICHT"
lage
[ "$L_TYP" = - ] || [ "$L_TYP" = G ] || abbruch "Login $LOGIN besteht als Typ $L_TYP (kein Windows-Gruppen-Login) — $NICHT"
[ "$L_AUS" != 1 ] || abbruch "Login $LOGIN ist deaktiviert — nicht still aktiviert; $NICHT"
if [ -n "$DB" ]; then
  case "$D_Z" in
    ok) ;;
    fehlt) abbruch "Datenbank $DB fehlt — $NICHT" ;;
    sekundaer) abbruch "Datenbank $DB ist auf $(hostname -s 2>/dev/null || true) Sekundär-Replikat — Datenbankbenutzer auf dem Primär anlegen bzw. entfernen (wird repliziert); hier nur Login/Serverrolle; $NICHT" ;;
    *) abbruch "Datenbank $DB ist nicht ONLINE/READ_WRITE — $NICHT" ;;
  esac
  [ "$D_TYP" = - ] || { [ "$D_TYP" = G ] && [ "$D_SID" = 1 ]; } || abbruch "Datenbankbenutzer $LOGIN in $DB passt nicht zum Login (Typ $D_TYP, SID gleich $D_SID) — $NICHT"
fi`);

const AD_LOGIN_KOERPER = sh(String.raw`# ── Phase 2: Eigentum VOR der Anlage vermerken (nur, was jetzt fehlt), dann anlegen ──
NEU=()
[ "$L_TYP" != - ] || NEU+=("L|$LOGIN")
if [ -n "$SROLLE" ] && [ "$L_ROLLE" = 0 ]; then NEU+=("S|$SROLLE|$LOGIN"); fi
if [ -n "$DB" ]; then
  [ "$D_TYP" != - ] || NEU+=("U|$DB|$LOGIN")
  [ "$D_RM" != 0 ] || NEU+=("R|$DB|$DROLLE|$LOGIN")
fi
if [ §{#NEU[@]} -gt 0 ]; then
  marker_setzen dazu "§{NEU[@]}"
  for e in "§{NEU[@]}"; do aend "§{e%%|*}"; done
  a=$(sql "$ANLEGEN_Q" 2>&1) || {
    case "$a" in *"Msg 15401"*) abbruch "AD-Gruppe $LOGIN von SQL Server nicht gefunden (Msg 15401) — SQL Server löst AD-Namen über den Keytab auf: kerberos_einrichten + Neustart, Gruppe im AD? Vermerk in $MARKER bleibt (Rückweg ad_login_entfernen)" ;; esac
    abbruch "AD-Login anlegen fehlgeschlagen: $(sql_meldung "$a") — Vermerk in $MARKER bleibt (Rückweg ad_login_entfernen)"
  }
  [ "$(alfred_zeile "$a")" = 'ALFRED|A|ok' ] || abbruch "AD-Login anlegen ohne Ergebniszeile: $(kurz "$a")"
fi
# ── Selbstprüfung über die Kataloge ──
lage
[ "$L_TYP" = G ] || abbruch "Selbstprüfung: $LOGIN ist kein Windows-Gruppen-Login (Typ $L_TYP)"
[ "$L_AUS" = 0 ] || abbruch "Selbstprüfung: $LOGIN ist nicht aktiv"
if [ -n "$SROLLE" ]; then [ "$L_ROLLE" = 1 ] || abbruch "Selbstprüfung: $LOGIN ist nicht Mitglied von $SROLLE"; fi
if [ -n "$DB" ]; then
  { [ "$D_Z" = ok ] && [ "$D_TYP" = G ] && [ "$D_SID" = 1 ]; } || abbruch "Selbstprüfung: Datenbankbenutzer $LOGIN in $DB fehlt oder passt nicht (Typ $D_TYP, SID $D_SID)"
  [ "$D_RM" = 1 ] || abbruch "Selbstprüfung: $LOGIN ist in $DB nicht Mitglied von $DROLLE"
fi
if [ "$GEAENDERT" = 1 ]; then Z=geaendert; else Z=schon; fi
LJ=$(printf '%s' "$LOGIN" | json_text)
ergebnis "{\"zustand\":\"$Z\",\"login\":$LJ,\"typ\":\"G\",\"serverrolle\":\"$SROLLE\",\"datenbank\":\"$DB\",\"datenbankrolle\":\"$DROLLE\",\"aenderungen\":[$AJ]}"`);

const AD_LOGIN_ENTFERNEN_KOERPER = sh(String.raw`BELASSEN=''
belassen() { BELASSEN+="§{BELASSEN:+,}$(printf '%s' "$1" | json_text)"; }
[ "$(hostname -s 2>/dev/null || true)" != "$NIE" ] || abbruch "$NIE hat keine AD-Logins (Spec 10) — $NICHT"
marker_pruefen
bereit || abbruch "SQL Server antwortet nicht als sa — $NICHT"
lage
# nur, was Alfred vermerkt hat UND noch ein Windows-Gruppen-Objekt ist; alles andere bleibt (belassen)
DR=0; DU=0; DS=0; DL=0; WEG=()
if [ -n "$DB" ]; then
  if marker_hat "R|$DB|$DROLLE|$LOGIN" || marker_hat "U|$DB|$LOGIN"; then
    [ "$D_Z" = ok ] || abbruch "Datenbank $DB ist hier nicht schreibbar ($D_Z) — Datenbankbenutzer auf dem Primär entfernen; $NICHT"
  fi
  if marker_hat "R|$DB|$DROLLE|$LOGIN"; then
    if [ "$D_RM" = 1 ] && [ "$D_TYP" = G ]; then DR=1; fi; WEG+=("R|$DB|$DROLLE|$LOGIN")
  elif [ "$D_RM" = 1 ]; then belassen "Mitgliedschaft $DROLLE in $DB (nicht von Alfred)"; fi
  if marker_hat "U|$DB|$LOGIN"; then
    if [ "$D_TYP" = G ]; then DU=1; elif [ "$D_TYP" != - ]; then belassen "Datenbankbenutzer $LOGIN in $DB (Typ $D_TYP, kein Gruppen-Benutzer)"; fi; WEG+=("U|$DB|$LOGIN")
  elif [ "$D_TYP" != - ]; then belassen "Datenbankbenutzer $LOGIN in $DB (nicht von Alfred)"; fi
fi
if [ -n "$SROLLE" ]; then
  if marker_hat "S|$SROLLE|$LOGIN"; then
    if [ "$L_ROLLE" = 1 ] && [ "$L_TYP" = G ]; then DS=1; fi; WEG+=("S|$SROLLE|$LOGIN")
  elif [ "$L_ROLLE" = 1 ]; then belassen "Mitgliedschaft $SROLLE (nicht von Alfred)"; fi
fi
if marker_hat "L|$LOGIN"; then
  if [ "$L_TYP" = G ]; then DL=1; elif [ "$L_TYP" != - ]; then belassen "Login $LOGIN (Typ $L_TYP, kein Windows-Gruppen-Login)"; fi; WEG+=("L|$LOGIN")
elif [ "$L_TYP" != - ]; then belassen "Login $LOGIN (nicht von Alfred angelegt)"; fi
if [ "$DR$DU$DS$DL" != 0000 ]; then
  Q=§{ENTFERNEN_V//@@DR@@/$DR}; Q=§{Q//@@DU@@/$DU}; Q=§{Q//@@DS@@/$DS}; Q=§{Q//@@DL@@/$DL}
  a=$(sql "$Q" 2>&1) || abbruch "AD-Login entfernen fehlgeschlagen: $(sql_meldung "$a")"
  [ "$(alfred_zeile "$a")" = 'ALFRED|E|ok' ] || abbruch "AD-Login entfernen ohne Ergebniszeile: $(kurz "$a")"
  [ "$DR" = 0 ] || aend R; [ "$DU" = 0 ] || aend U; [ "$DS" = 0 ] || aend S; [ "$DL" = 0 ] || aend L
fi
# ── Selbstprüfung ──
lage
[ "$DL" = 0 ] || [ "$L_TYP" = - ] || abbruch "Selbstprüfung: Login $LOGIN besteht noch"
[ "$DS" = 0 ] || [ "$L_ROLLE" = 0 ] || abbruch "Selbstprüfung: $LOGIN ist noch Mitglied von $SROLLE"
[ "$DU" = 0 ] || [ "$D_TYP" = - ] || abbruch "Selbstprüfung: Datenbankbenutzer $LOGIN in $DB besteht noch"
[ "$DR" = 0 ] || [ "$D_RM" = 0 ] || abbruch "Selbstprüfung: $LOGIN ist in $DB noch Mitglied von $DROLLE"
# Vermerke erst nach gelungenem Entfernen löschen
if [ §{#WEG[@]} -gt 0 ]; then marker_setzen weg "§{WEG[@]}"; fi
if [ "$GEAENDERT" = 1 ]; then Z=geaendert; else Z=schon; fi
LJ=$(printf '%s' "$LOGIN" | json_text)
ergebnis "{\"zustand\":\"$Z\",\"login\":$LJ,\"belassen\":[$BELASSEN],\"aenderungen\":[$AJ]}"`);

function adLoginWerte(p: AdLoginParameter): string[] {
  const n = adLoginName(p.gruppe);
  return [
    `LOGIN=${shQ(n)}`,
    `GRUPPE_NSS=${shQ(`${p.gruppe.toLowerCase()}@${LINUX_AD.domaene}`)}`,
    `SROLLE=${shQ(p.serverrolle ?? '')}`,
    `DB=${shQ(p.datenbank ?? '')}`,
    `DROLLE=${shQ(p.datenbankrolle ?? '')}`,
    `NIE=${shQ(AD_NIE_BEITRETEN)}`,
    `MARKER=${shQ(AD_LOGINS_DATEI)}`,
    `MARKER_KOPF=${shQ(AD_LOGINS_KOPF)}`,
    `SSSD_CONF=${shQ(AD_SSSD_CONF)}`,
    `SSSD_KOPF=${shQ(AD_SSSD_KOPF)}`,
    `SQL_KT=${shQ(SQL_KEYTAB)}`,
    `PY_CONF=${shQ(PY_CONF)}`,
    `LAGE_Q=${shQ(adLoginLage(n, p))}`,
  ];
}
/** nur geprüfte Felder in den Kopf (nie das Eingabeobjekt) */
const adLoginKopfP = (p: AdLoginParameter) => ({ gruppe: p.gruppe, ...(p.serverrolle ? { serverrolle: p.serverrolle } : {}), ...(p.datenbank ? { datenbank: p.datenbank, datenbankrolle: p.datenbankrolle } : {}) });

/**
 * Task 8 — `CREATE LOGIN [AD3033\<gruppe>] FROM WINDOWS` (+ Serverrolle sysadmin bzw. Datenbankbenutzer + Datenbankrolle), wiederholbar.
 * Vorbedingung ohne Änderung: nicht sqllnxcfg, Host über Alfred beigetreten (sssd), Gruppe per getent auflösbar, Alfreds Keytab in
 * mssql.conf; ein vorhandener Login anderen Typs, ein deaktivierter Login, ein abweichender Datenbankbenutzer → Abbruch; Datenbank nur auf
 * dem Primär (Sekundär → Abbruch, der Benutzer wird repliziert). Was fehlt, steht vor der Anlage in AD_LOGINS_DATEI (Eigentum für den
 * Rückweg). Selbstprüfung über sys.server_principals (Typ G, aktiv), sys.server_role_members, sys.database_principals (Typ G, SID =
 * Login) und sys.database_role_members. Ergebnis { zustand, login, typ, serverrolle, datenbank, datenbankrolle, aenderungen }.
 * Zeit: LINUX_SQL_ZEIT_MS.adLogin
 */
export function adLoginSkript(p: AdLoginParameter): string {
  const f = pruefeAdLogin(p); if (f) throw new Error(f);
  return [
    ...sqlKopf(LINUX_SQL_BAUSTEINE.adLogin, adLoginKopfP(p)),
    ...adLoginWerte(p),
    `ANLEGEN_Q=${shQ(adLoginAnlegen(adLoginName(p.gruppe), p))}`,
    ...SQL_HILFE,
    AD_LOGIN_HILFEN,
    ...SA_LESEN,
    AD_LOGIN_VORBEDINGUNG,
    AD_LOGIN_KOERPER,
  ].join('\n');
}

/**
 * Rückweg von adLoginSkript (gleiche Parameter): entfernt nur, was in AD_LOGINS_DATEI vermerkt ist UND noch ein Windows-Gruppen-Objekt
 * ist — Datenbankrolle, Datenbankbenutzer (nur auf dem Primär), Serverrolle, Login; Vorhandenes ohne Vermerk bleibt (belassen). Vermerke
 * fallen erst nach gelungener Selbstprüfung weg. Ergebnis { zustand, login, belassen, aenderungen }. Zeit: LINUX_SQL_ZEIT_MS.adLoginEntfernen
 */
export function adLoginEntfernenSkript(p: AdLoginParameter): string {
  const f = pruefeAdLogin(p); if (f) throw new Error(f);
  return [
    ...sqlKopf(LINUX_SQL_BAUSTEINE.adLoginEntfernen, adLoginKopfP(p)),
    ...adLoginWerte(p),
    `ENTFERNEN_V=${shQ(adLoginEntfernenTsql(adLoginName(p.gruppe), p))}`,
    ...SQL_HILFE,
    AD_LOGIN_HILFEN,
    ...SA_LESEN,
    AD_LOGIN_ENTFERNEN_KOERPER,
  ].join('\n');
}

// ── Register ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

registriereLinuxBaustein<AdLoginParameter>(LINUX_SQL_BAUSTEINE.adLogin, adLoginSkript);
registriereLinuxBaustein<AdLoginParameter>(LINUX_SQL_BAUSTEINE.adLoginEntfernen, adLoginEntfernenSkript);
registriereLinuxBaustein<AdBeitretenParameter>(LINUX_SQL_BAUSTEINE.adBeitreten, adBeitretenSkript);
registriereLinuxBaustein<AdVerlassenParameter>(LINUX_SQL_BAUSTEINE.adVerlassen, adVerlassenSkript);
registriereLinuxBaustein(LINUX_SQL_BAUSTEINE.zeitquelleEinrichten, () => zeitquelleEinrichtenSkript());
registriereLinuxBaustein(LINUX_SQL_BAUSTEINE.zeitquelleEntfernen, () => zeitquelleEntfernenSkript());
registriereLinuxBaustein<KerberosParameter>(LINUX_SQL_BAUSTEINE.kerberosEinrichten, kerberosSkript);
registriereLinuxBaustein(LINUX_SQL_BAUSTEINE.kerberosEntfernen, () => kerberosEntfernenSkript());
