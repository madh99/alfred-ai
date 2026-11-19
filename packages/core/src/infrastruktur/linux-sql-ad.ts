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
import { sqlKopf, shQ, LINUX_SQL_BAUSTEINE, ZEITQUELLE_DCS, ZEITQUELLE_DROPIN, ZEITQUELLE_KOPF } from './linux-sql.js';

// ── Feste Werte (Global Constraints I8e Etappe 3) ──────────────────────────────────────────────────────────────────────────────────

export const LINUX_AD = {
  domaene: 'ad.3033.at', realm: 'AD.3033.AT', netbios: 'AD3033', ou: 'Server', dcs: ['10.203.29.2', '10.203.29.3'],
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
/** Kopfzeile der von Alfred geschriebenen sssd.conf — eine andere vorhandene sssd.conf wird nie überschrieben oder entfernt */
export const AD_SSSD_KOPF = '# Alfred I8e — linux_sql ad_beitreten (nicht von Hand ändern)';
/** Kopfzeile der von Alfred geschriebenen krb5.conf (Fix-Runde 1, Ruling R13) */
export const AD_KRB5_KOPF = '# Alfred I8e — linux_sql ad_beitreten (krb5.conf, nicht von Hand ändern)';
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
# Ruling R11: statt eigener SNTP-Probe — Zeitquelle an den DCs eingerichtet (Alfreds Drop-in), synchronisiert, Offset < 60 s
ZQ_FEHLT="Zeitquelle zuerst einrichten (linux_sql zeitquelle_einrichten) — nichts geändert"
zq_eigen || abbruch "$ZQ_FEHLT ($ZQ_DROPIN fehlt oder ist nicht von Alfred)"
SYNC=$(zeit_sync); OFF=$(zeit_offset_ms "$(zeit_status)")
[ "$SYNC" = yes ] || abbruch "$ZQ_FEHLT (NTPSynchronized §{SYNC:-unbekannt})"
[ -n "$OFF" ] || abbruch "$ZQ_FEHLT (keine Messung in timedatectl timesync-status)"
[ "$(betrag "$OFF")" -lt "$UHR_MAX_MS" ] || abbruch "$ZQ_FEHLT (Offset $OFF ms, höchstens ±$UHR_MAX_MS ms)"
UHR_V=$(awk -v m="$OFF" 'BEGIN { printf "%+.3f", m / 1000 }')
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

// ── Register ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

registriereLinuxBaustein<AdBeitretenParameter>(LINUX_SQL_BAUSTEINE.adBeitreten, adBeitretenSkript);
registriereLinuxBaustein<AdVerlassenParameter>(LINUX_SQL_BAUSTEINE.adVerlassen, adVerlassenSkript);
registriereLinuxBaustein(LINUX_SQL_BAUSTEINE.zeitquelleEinrichten, () => zeitquelleEinrichtenSkript());
registriereLinuxBaustein(LINUX_SQL_BAUSTEINE.zeitquelleEntfernen, () => zeitquelleEntfernenSkript());
