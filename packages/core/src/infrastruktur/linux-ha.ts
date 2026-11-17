/**
 * I8e Paket 2 (SQL Server 2025 AG auf Linux mit Pacemaker + diskless SBD) — feste Bash-Bausteine des Skills „linux_ha“.
 * Task 2: HA-Grundlage je Knoten (`ha.vorbereiten`) und lesender Status (`ha.status`). Tasks 3–6 (Cluster, Fencing-Beweis, AG,
 * Failover) hängen weitere Bausteine an LINUX_HA_BAUSTEINE / LINUX_HA_ZEIT_MS an und registrieren sie unten im Register.
 *
 * Regeln (wie Paket 1, linux-sql.ts):
 * - Parameter streng geprüft und nur über `shQ` im Text; der geprüfte Satz steht als `ALFRED_P` im Kopf (`sqlKopf(…, 'ALFRED-HA')`).
 * - Geheimnisse (hacluster-Kennwort) nur als JSON in der ersten stdin-Zeile (`ALFRED_EINGABE`), gelesen mit `feld`; an chpasswd über eine
 *   Pipe aus dem printf-Builtin (nie Befehlszeile, nie Ausgabe).
 * - Genau eine Ergebniszeile `ALFRED-HA {json}`; Fehler → `{"zustand":"fehler","fehler":…}` und Exit 1. Idempotent (`schon`), Selbstprüfung.
 * - Watchdog: SBD ist einziger Besitzer. Vor jeder Änderung bricht der Baustein ab, wenn kein i6300ESB (PCI 8086:25ab) in der VM steckt,
 *   ein vorhandenes Watchdog-Gerät nicht von i6300esb stammt oder ein anderer Prozess als sbd ein /dev/watchdog* offen hält. Die Kennung
 *   prüft er nach `modprobe i6300esb` noch einmal (Linux drivers/watchdog/i6300esb.c: identity = ESB_MODULE_NAME „i6300ESB timer“;
 *   verglichen wird ohne Groß-/Kleinschreibung auf „i6300esb“). Kein softdog-Ersatz.
 */
import { registriereLinuxBaustein } from '../fernzugriff/linux-bausteine.js';
import { sqlKopf, shQ } from './linux-sql.js';

// ── Feste Werte ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface HaKnoten { name: string; ip: string }
export type HaRolle = 'daten' | 'konfig';
export interface HaVersionen { pacemaker: string; corosync: string; pcs: string; sbd: string; resourceAgents: string; mssqlHa: string }

/** gelesen auf sqllnx01 (Ubuntu 24.04, apt-cache madison, 17.11.2026); mssql-server-ha = installierte mssql-server-Version (CU1) */
export const HA_VERSIONEN: Readonly<HaVersionen> = {
  pacemaker: '2.1.6-5ubuntu2', corosync: '3.1.7-1ubuntu3.2', pcs: '0.11.7-1ubuntu1.1', sbd: '1.5.2-2ubuntu2',
  resourceAgents: '1:4.13.0-1ubuntu4.2', mssqlHa: '17.0.4006.2-1',
};
/** Paketnamen zu HaVersionen (Reihenfolge = Installationsliste) */
export const HA_PAKETE: ReadonlyArray<[keyof HaVersionen, string]> = [
  ['pacemaker', 'pacemaker'], ['corosync', 'corosync'], ['pcs', 'pcs'], ['sbd', 'sbd'], ['resourceAgents', 'resource-agents-base'], ['mssqlHa', 'mssql-server-ha'],
];
/** Global Constraints I8e Paket 2: die drei Knoten im VLAN 830 */
export const HA_KNOTEN: readonly HaKnoten[] = [
  { name: 'sqllnx01', ip: '10.203.30.10' }, { name: 'sqllnx02', ip: '10.203.30.11' }, { name: 'sqllnxcfg', ip: '10.203.30.12' },
];
/** nur die Peers dürfen diese Ports (SQL, AG-Endpunkt, pcsd, Pacemaker-Remote, DLM; Corosync knet) — sonst nichts verändert */
export const HA_PORTS = { tcp: [1433, 2224, 3121, 5022, 21064], udp: [5405] } as const;
/**
 * Ruling R4 (Architektur v2 §4: „ausschließlich Probe 192.168.1.223 → VIP / befristet Einzelinstanz“): TCP 1433 zusätzlich zu den
 * Knoten nur von diesen Quellen; alle anderen Ports bleiben auf die Knoten beschränkt.
 */
export const HA_SQL_ZUSATZQUELLEN: readonly string[] = ['192.168.1.223'];
export const HA_NFT_TABELLE = 'alfred_ha';
export const HA_HOSTFW_DATEI = '/etc/alfred/hostfw.nft';
export const HA_HOSTFW_DIENST = 'alfred-hostfw.service';
export const HA_HOSTFW_UNIT = `/etc/systemd/system/${HA_HOSTFW_DIENST}`;
export const HA_HOSTS_ANFANG = '# ALFRED-HA ANFANG (fest erzeugt, I8e Paket 2 — nicht von Hand ändern)';
export const HA_HOSTS_ENDE = '# ALFRED-HA ENDE';
/** Fix-Runde 1: Loopback-Zeilen mit dem eigenen Namen (cloud-init „127.0.1.1 <fqdn> <hostname>“) — Original bleibt als Kommentar erhalten */
export const HA_HOSTS_ENTFERNT = '# ALFRED-HA ENTFERNT (Loopback mit eigenem Namen):';
export const HA_MODPROBE_DATEI = '/etc/modprobe.d/alfred-watchdog.conf';
export const HA_MODULES_LOAD_DATEI = '/etc/modules-load.d/alfred-watchdog.conf';
export const HA_SYSTEMD_DATEI = '/etc/systemd/system.conf.d/alfred-watchdog.conf';
/** Tresor-Eintrag des hacluster-Kennworts (für alle drei Knoten gleich) */
export const HA_HACLUSTER_TRESOR = 'sqllnx-ha-hacluster';

export const LINUX_HA_BAUSTEINE = { vorbereiten: 'ha.vorbereiten', status: 'ha.status' } as const;
/** Zeitgrenzen für `linuxSkript(…, timeoutMs, …)` — am Host läuft das Skript bis timeoutMs − 20 s */
export const LINUX_HA_ZEIT_MS = { vorbereiten: 1_500_000, status: 90_000 } as const;

// ── Hilfen ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const obj = (p: unknown): Record<string, unknown> => (p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : {});
const pruefe = (f: string | undefined) => { if (f) throw new Error(f); };
const HOSTNAME = /^[a-z][a-z0-9-]{0,62}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
/** Debian-Paketversion (Epoche optional) — ohne Quoting-Zeichen */
const DEB_VERSION = /^(\d{1,3}:)?\d[A-Za-z0-9.+~-]{0,60}$/;

/** letzte Ergebniszeile `ALFRED-HA {json}` aus der Ausgabe */
export function haErgebnis<T = Record<string, unknown>>(aus: string): T | undefined {
  const zeilen = aus.split(/\r?\n/).filter(z => z.startsWith('ALFRED-HA '));
  if (!zeilen.length) return undefined;
  try { return JSON.parse(zeilen[zeilen.length - 1]!.slice('ALFRED-HA '.length)) as T; } catch { return undefined; }
}

export function pruefeKnoten(k: unknown): string | undefined {
  if (!Array.isArray(k) || k.length !== 3) return 'knoten: genau drei Einträge {name, ip}';
  const namen = new Set<string>(); const ips = new Set<string>();
  for (const [i, e] of k.entries()) {
    const x = obj(e);
    if (typeof x.name !== 'string' || !HOSTNAME.test(x.name)) return `knoten[${i}].name: Kurzname (klein, Buchstaben/Ziffern/-)`;
    if (typeof x.ip !== 'string' || !IPV4.test(x.ip)) return `knoten[${i}].ip: IPv4-Adresse`;
    if (namen.has(x.name)) return `knoten: Name ${x.name} doppelt`;
    if (ips.has(x.ip)) return `knoten: IP ${x.ip} doppelt`;
    namen.add(x.name); ips.add(x.ip);
  }
  return undefined;
}

export function pruefeVersionen(v: unknown): string | undefined {
  const x = obj(v);
  for (const [k] of HA_PAKETE) if (typeof x[k] !== 'string' || !DEB_VERSION.test(x[k] as string)) return `versionen.${k}: Debian-Paketversion wie ${HA_VERSIONEN[k]}`;
  if (!/^17\.0\.\d{4}\.\d{1,3}-\d{1,3}$/.test(x.mssqlHa as string)) return 'versionen.mssqlHa: Version von mssql-server wie 17.0.4006.2-1';
  return undefined;
}

export interface HaVorbereitenParameter { knoten: HaKnoten[]; rolle: HaRolle; versionen: HaVersionen }

export function pruefeHaVorbereiten(p: unknown): string | undefined {
  const x = obj(p);
  const fk = pruefeKnoten(x.knoten); if (fk) return fk;
  if (x.rolle !== 'daten' && x.rolle !== 'konfig') return 'rolle: daten oder konfig';
  return pruefeVersionen(x.versionen);
}

/** nft-Regelsatz: nur Peers × feste Ports; andere Quellen genau für diese Ports verworfen; Grundregel accept (SSH u. a. unberührt) */
export function hostfwNft(knoten: readonly HaKnoten[], sqlQuellen: readonly string[] = HA_SQL_ZUSATZQUELLEN): string {
  pruefe(pruefeKnoten(knoten));
  if (!sqlQuellen.length || sqlQuellen.some(q => !IPV4.test(q))) throw new Error('sqlQuellen: mindestens eine IPv4-Adresse');
  const tcp = HA_PORTS.tcp.join(', '); const udp = HA_PORTS.udp.join(', ');
  return [
    '# Alfred I8e Paket 2 — Host-Firewall (fest erzeugt, nicht von Hand ändern)',
    `table inet ${HA_NFT_TABELLE}`,
    `delete table inet ${HA_NFT_TABELLE}`,
    `table inet ${HA_NFT_TABELLE} {`,
    '\tset ha_peers4 {',
    '\t\ttype ipv4_addr',
    `\t\telements = { ${knoten.map(k => k.ip).join(', ')} }`,
    '\t}',
    '\tset sql_quellen4 {',
    '\t\ttype ipv4_addr',
    `\t\telements = { ${sqlQuellen.join(', ')} }`,
    '\t}',
    '\tchain eingang {',
    '\t\ttype filter hook input priority -10; policy accept;',
    '\t\tiifname "lo" accept',
    `\t\tip saddr @ha_peers4 tcp dport { ${tcp} } accept`,
    '\t\tip saddr @sql_quellen4 tcp dport 1433 accept',
    `\t\tip saddr @ha_peers4 udp dport { ${udp} } accept`,
    `\t\ttcp dport { ${tcp} } drop`,
    `\t\tudp dport { ${udp} } drop`,
    '\t}',
    '}',
  ].join('\n');
}

/** systemd-Unit, die die Tabelle vor Netz und Cluster-/SQL-Diensten lädt; nftables.service und ufw bleiben unberührt */
export const HOSTFW_UNIT = [
  '[Unit]',
  `Description=Alfred Host-Firewall (nft-Tabelle inet ${HA_NFT_TABELLE})`,
  'DefaultDependencies=no',
  'Wants=network-pre.target',
  'Before=network-pre.target shutdown.target corosync.service pacemaker.service pcsd.service mssql-server.service',
  'After=local-fs.target',
  'Conflicts=shutdown.target',
  '',
  '[Service]',
  'Type=oneshot',
  'RemainAfterExit=yes',
  `ExecStart=/usr/sbin/nft -f ${HA_HOSTFW_DATEI}`,
  `ExecReload=/usr/sbin/nft -f ${HA_HOSTFW_DATEI}`,
  `ExecStop=-/usr/sbin/nft delete table inet ${HA_NFT_TABELLE}`,
  '',
  '[Install]',
  'WantedBy=multi-user.target',
].join('\n');

export function hostsBlock(knoten: readonly HaKnoten[]): string {
  pruefe(pruefeKnoten(knoten));
  return [HA_HOSTS_ANFANG, ...knoten.map(k => `${k.ip} ${k.name}`), HA_HOSTS_ENDE].join('\n');
}

/** python3: stimmt das Kennwort (stdin) mit dem hacluster-Hash in argv[1] (/etc/shadow) überein? 0 ja, 1 nein, 2 crypt fehlt */
export const PY_KW_GLEICH = [
  'import sys, warnings',
  'warnings.simplefilter("ignore")',
  'try:',
  '    import crypt',
  'except Exception:',
  '    sys.exit(2)',
  'kw = sys.stdin.read()',
  'if kw.endswith("\\n"):',
  '    kw = kw[:-1]',
  'h = ""',
  'with open(sys.argv[1]) as f:',
  '    for z in f:',
  '        t = z.rstrip("\\n").split(":")',
  '        if t[0] == "hacluster" and len(t) > 1:',
  '            h = t[1]',
  'if not h or h[0] in "!*":',
  '    sys.exit(1)',
  'sys.exit(0 if crypt.crypt(kw, h) == h else 1)',
].join('\n');

// ── ha_vorbereiten ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Pfade und Werkzeuge — als Variablen vor der Marke, damit Tests sie umbiegen können */
const VORBEREITEN_PFADE = [
  'HOSTS=/etc/hosts',
  'HOSTS_VORLAGE=/etc/cloud/templates/hosts.debian.tmpl',
  'WD_SYS=/sys/class/watchdog',
  'PCI_SYS=/sys/bus/pci/devices',
  'PROC=/proc',
  'SHADOW=/etc/shadow',
  'POLICY_RC=/usr/sbin/policy-rc.d',
  'TMP_BASIS=/run',
  'MSSQL_CONF=/var/opt/mssql/mssql.conf',
  'MSSQLCONF=/opt/mssql/bin/mssql-conf',
  'COROSYNC_CONF=/etc/corosync/corosync.conf',
  `MODPROBE_CONF=${shQ(HA_MODPROBE_DATEI)}`,
  `MODLOAD_CONF=${shQ(HA_MODULES_LOAD_DATEI)}`,
  `SYSTEMD_CONF=${shQ(HA_SYSTEMD_DATEI)}`,
  `FW_DATEI=${shQ(HA_HOSTFW_DATEI)}`,
  `UNIT_DATEI=${shQ(HA_HOSTFW_UNIT)}`,
  `FW_DIENST=${shQ(HA_HOSTFW_DIENST.replace(/\.service$/, ''))}`,
  `NFT_TABELLE=${shQ(HA_NFT_TABELLE)}`,
];

const VORBEREITEN_HILFEN = `export DEBIAN_FRONTEND=noninteractive
# Realfall 17.11. (6279a86a): gehaltene Pakete melden „hold ok installed“ — installiert ist jeder Status „<wunsch> ok installed“
paket_version() { dpkg-query -W -f='\${Status}|\${Version}' "$1" 2>/dev/null | awk -F'|' '$1 ~ / ok installed$/ { print $2 }' || true; }
paket_gehalten() { [ "$(dpkg-query -W -f='\${Status}' "$1" 2>/dev/null || true)" = 'hold ok installed' ]; }
kurz() { printf "%s" "$1" | tail -n 6 | tr "\\r\\n" "  "; }
inhalt_gleich() { [ -f "$1" ] && [ "$(cat "$1")" = "$2" ]; }
schreibe() { mkdir -p "$(dirname "$1")"; printf '%s\\n' "$3" >"$1.alfred-neu"; chmod "$2" "$1.alfred-neu"; mv -f "$1.alfred-neu" "$1"; }
fd_ziel() { readlink "$1" 2>/dev/null || true; }
prozess_name() { cat "$PROC/$1/comm" 2>/dev/null || true; }
prozess_exe() { readlink "$PROC/$1/exe" 2>/dev/null || true; }
eigener_name() { hostname -s; }
kennwort_gleich() { python3 -c "$PY_KW_GLEICH" "$SHADOW" <<<"$KW"; }
hadr_wert() { awk -F'=' '/^\\[/ { s = ($0 == "[hadr]") } s && $1 ~ /^[ \\t]*hadrenabled[ \\t]*$/ { gsub(/[ \\t\\r]/, "", $2); print $2 }' "$MSSQL_CONF" 2>/dev/null | tail -n 1 || true; }
ist_esb() { local r=1; shopt -s nocasematch; if [[ "$1" == *i6300esb* ]]; then r=0; fi; shopt -u nocasematch; return $r; }
# PCI 8086:25ab = Intel 6300ESB Watchdog (Proxmox: watchdog model=i6300esb)
pci_esb() { local d; for d in "$PCI_SYS"/*; do if [ "$(cat "$d/vendor" 2>/dev/null || true)" = 0x8086 ] && [ "$(cat "$d/device" 2>/dev/null || true)" = 0x25ab ]; then return 0; fi; done; return 1; }
# jedes vorhandene Watchdog-Gerät muss von i6300esb stammen ($1 = Zusatz für die Meldung)
pruefe_wd() {
  local d id
  for d in "$WD_SYS"/watchdog*; do
    [ -e "$d" ] || continue
    id=$(cat "$d/identity" 2>/dev/null || true)
    ist_esb "$id" || abbruch "Watchdog-Gerät \${d##*/} stammt von '\${id:-unbekannt}', erwartet i6300esb (i6300ESB timer)$1; kein softdog-Ersatz ohne Owner-Entscheidung"
  done
}
# Prozesse mit offenem /dev/watchdog* außer sbd selbst (Wiederholung nach Task 4)
fremde_halter() {
  local f z pid n e aus=''
  for f in "$PROC"/[0-9]*/fd/*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    z=$(fd_ziel "$f")
    case "$z" in /dev/watchdog|/dev/watchdog[0-9]*) ;; *) continue ;; esac
    pid=\${f#"$PROC"/}; pid=\${pid%%/*}
    n=$(prozess_name "$pid"); e=$(prozess_exe "$pid")
    if [ "$n" = sbd ] && [ "$e" = /usr/sbin/sbd ]; then continue; fi
    case " $aus " in *" $n($pid) "*) ;; *) aus+="\${aus:+ }$n($pid)" ;; esac
  done
  printf '%s' "$aus"
}
# hosts: Block (ohne alten Block) an den Anfang — in einer cloud-init-Vorlage nach der Kopfzeile „## template:jinja“
# Fix-Runde 1: Loopback-Zeilen (127.*) verlieren den eigenen Kurznamen, jede FQDN „<name>.…“ und die cloud-init-Platzhalter
# {{fqdn}}/{{hostname}} (glibc liefert alle Treffer und sortiert 127.0.1.1 vor 10.x; corosync/pcs dürfen den eigenen Namen nie auf
# Loopback auflösen). Das Original bleibt als markierter Kommentar stehen; bleiben andere Namen, bleibt die Zeile mit ihnen.
hosts_neu() { HB="$HOSTS_BLOCK" awk -v a="$H_ANFANG" -v e="$H_ENDE" -v ich="$ICH" -v ent="$H_ENTFERNT" '
function eigen(n) { return n == ich || index(n, ich ".") == 1 || n == "{{fqdn}}" || n == "{{hostname}}" }
NR == 1 && /^## template:/ { print; next }
!d { print ENVIRON["HB"]; d = 1 }
$0 == a { s = 1; next }
$0 == e { s = 0; next }
s { next }
$1 ~ /^127\\./ {
  k = ""; w = 0
  for (i = 2; i <= NF; i++) { if ($i ~ /^#/) break; if (eigen($i)) w = 1; else k = k " " $i }
  if (w) { print ent " " $0; if (k != "") print $1 k; next }
}
{ print }
END { if (!d) print ENVIRON["HB"] }' "$1"; }
# ohne -W: das Modul crypt fehlt ab Python 3.13 — dann sichtbarer Abbruch statt „jedes Mal chpasswd“
crypt_da() { python3 -c 'import warnings; warnings.simplefilter("ignore"); import crypt' >/dev/null 2>&1; }
# 0 gleich, 1 verschieden; alles andere (2 = crypt fehlt) → Abbruch
kw_vergleich() { local rc=0; kennwort_gleich || rc=$?; [ "$rc" -le 1 ] || abbruch "hacluster-Kennwort nicht prüfbar (python3 crypt, Exit $rc)"; return "$rc"; }
marken_ok() { local a e; a=$(grep -cxF "$H_ANFANG" "$1" || true); e=$(grep -cxF "$H_ENDE" "$1" || true); [ "$a" = "$e" ] && [ "$a" -le 1 ]; }
GEAENDERT=0; AJ=''
aend() { GEAENDERT=1; AJ+="\${AJ:+,}\\"$1\\""; }
POLICY_EIGEN=0
alfred_aufraeumen() { if [ "$POLICY_EIGEN" = 1 ]; then rm -f -- "$POLICY_RC"; fi; }`;

const VORBEREITEN_KOERPER = `KW=$(feld hacluster) || abbruch "hacluster-Kennwort enthält nicht druckbare Zeichen"
[ -n "$KW" ] || abbruch "hacluster-Kennwort fehlt in der Eingabe (erste stdin-Zeile, JSON-Feld hacluster)"
[[ "$KW" =~ ^[[:print:]]+$ ]] || abbruch "hacluster-Kennwort enthält nicht druckbare Zeichen"
MOD_EXTRA="linux-modules-extra-$(uname -r)"
# ── Phase 1: prüfen — bis hierhin wird nichts geändert ──
ICH=$(eigener_name)
IDX=-1; for i in "\${!KNOTEN_NAME[@]}"; do if [ "\${KNOTEN_NAME[$i]}" = "$ICH" ]; then IDX=$i; fi; done
[ "$IDX" -ge 0 ] || abbruch "Rechner $ICH gehört nicht zu den Knoten \${KNOTEN_NAME[*]} — nichts geändert"
command -v nft >/dev/null 2>&1 || abbruch "nft fehlt (Paket nftables) — nichts geändert"
crypt_da || abbruch "python3-Modul crypt fehlt — hacluster-Kennwort nicht prüfbar; nichts geändert"
iv=$(paket_version mssql-server)
[ "$iv" = "$V_SQL" ] || abbruch "mssql-server ist in Version '\${iv:-nicht installiert}' vorhanden, erwartet $V_SQL (mssql-server-ha muss dieselbe Version haben; vorher linux_sql.installieren) — nichts geändert"
for pv in "\${PAKETE[@]}"; do
  pk=\${pv%%=*}; sv=\${pv#*=}; iv=$(paket_version "$pk")
  [ -z "$iv" ] || [ "$iv" = "$sv" ] || abbruch "$pk ist in Version $iv installiert, erwartet $sv — Vorbereitung ändert keine vorhandene Version; nichts geändert"
done
pci_esb || abbruch "kein i6300ESB-Watchdog (PCI 8086:25ab) in der VM — vorher proxmox set_vm_watchdog (model i6300esb) und Kaltstart (stop_vm/start_vm); nichts geändert"
pruefe_wd " — nichts geändert"
h=$(fremde_halter)
[ -z "$h" ] || abbruch "Watchdog wird offen gehalten von $h — SBD muss einziger Besitzer sein (kein systemd-RuntimeWatchdog, kein watchdog-Dienst); nichts geändert"
for f in "$HOSTS" "$HOSTS_VORLAGE"; do
  if [ -f "$f" ]; then marken_ok "$f" || abbruch "$f: ALFRED-HA-Block beschädigt (Anfang/Ende ungleich) — nichts geändert"; fi
done
# ── Phase 2: Pakete (feste Versionen, gehalten) ──
FEHLEND=()
for pv in "\${PAKETE[@]}"; do if [ -z "$(paket_version "\${pv%%=*}")" ]; then FEHLEND+=("$pv"); fi; done
[ -n "$(paket_version "$MOD_EXTRA")" ] || FEHLEND+=("$MOD_EXTRA")
# Fix-Runde 1: „frisch“ nur, wenn keins der drei Cluster-Pakete da ist und es noch keine corosync.conf gibt (vor der Installation gemerkt)
FRISCH_CLUSTER=1
for pk in pacemaker corosync sbd; do if [ -n "$(paket_version "$pk")" ]; then FRISCH_CLUSTER=0; fi; done
if [ -e "$COROSYNC_CONF" ]; then FRISCH_CLUSTER=0; fi
if [ "\${#FEHLEND[@]}" -gt 0 ]; then
  ALFRED_TMP=$(mktemp -d "$TMP_BASIS/alfred-ha.XXXXXX")
  apt-get -o DPkg::Lock::Timeout=300 update -q >"$ALFRED_TMP/apt.log" 2>&1 || abbruch "apt-get update fehlgeschlagen: $(kurz "$(cat "$ALFRED_TMP/apt.log")")"
  for pv in "\${FEHLEND[@]}"; do
    pk=\${pv%%=*}
    vs=$(apt-cache madison "$pk" | awk -F'|' '{ gsub(/ /, "", $2); print $2 }')
    if [ "$pk" = "$pv" ]; then
      [ -n "$vs" ] || abbruch "$pk (passend zum laufenden Kernel) ist in der Paketquelle nicht verfügbar — nichts installiert"
    else
      grep -qxF "\${pv#*=}" <<<"$vs" || abbruch "$pv ist in der Paketquelle nicht verfügbar — nichts installiert"
    fi
  done
  # Dienste der neuen Pakete nicht starten (Debian startet corosync/pacemaker sonst mit Standardkonfiguration); Cluster richtet Task 3 ein
  if [ ! -e "$POLICY_RC" ]; then printf '#!/bin/sh\\nexit 101\\n' >"$POLICY_RC"; chmod 0755 "$POLICY_RC"; POLICY_EIGEN=1; fi
  if ! ACCEPT_EULA=Y apt-get -o DPkg::Lock::Timeout=300 install -y -q --no-install-recommends -o Dpkg::Options::=--force-confold "\${FEHLEND[@]}" >"$ALFRED_TMP/apt.log" 2>&1; then
    abbruch "apt-get install fehlgeschlagen: $(kurz "$(cat "$ALFRED_TMP/apt.log")")"
  fi
  alfred_aufraeumen; POLICY_EIGEN=0
  aend pakete
fi
for pv in "\${PAKETE[@]}"; do
  pk=\${pv%%=*}; sv=\${pv#*=}; iv=$(paket_version "$pk")
  [ "$iv" = "$sv" ] || abbruch "$pk hat nach der Installation Version '\${iv:-keine}', erwartet $sv"
  if ! paket_gehalten "$pk"; then apt-mark -o DPkg::Lock::Timeout=300 hold "$pk" >/dev/null; aend "halten:$pk"; fi
done
id hacluster >/dev/null 2>&1 || abbruch "Benutzer hacluster fehlt nach der Installation von pacemaker"
# ── hosts (drei Knoten, markierter Block oben; cloud-init-Vorlage ebenso, sonst überschreibt cloud-init /etc/hosts beim Start) ──
for f in "$HOSTS" "$HOSTS_VORLAGE"; do
  [ -f "$f" ] || continue
  neu=$(hosts_neu "$f")
  if [ "$(cat "$f")" != "$neu" ]; then
    cp -p "$f" "$f.alfred-$(date +%Y%m%d%H%M%S)"
    printf '%s\\n' "$neu" >"$f.alfred-neu"; chmod --reference="$f" "$f.alfred-neu" 2>/dev/null || chmod 0644 "$f.alfred-neu"; mv -f "$f.alfred-neu" "$f"
    aend "hosts:$f"
  fi
done
# ── Watchdog: Modul fest laden, softdog sperren, Kennung und Besitzer nach dem Laden erneut prüfen ──
inhalt_gleich "$MODLOAD_CONF" "$MODLOAD_SOLL" || { schreibe "$MODLOAD_CONF" 0644 "$MODLOAD_SOLL"; aend modules-load; }
inhalt_gleich "$MODPROBE_CONF" "$MODPROBE_SOLL" || { schreibe "$MODPROBE_CONF" 0644 "$MODPROBE_SOLL"; aend softdog-gesperrt; }
if [ ! -e "$WD_SYS/watchdog0" ]; then
  aus=$(modprobe i6300esb 2>&1) || abbruch "modprobe i6300esb fehlgeschlagen: $(kurz "$aus")"
  aend i6300esb-geladen
  udevadm settle >/dev/null 2>&1 || true
  for i in $(seq 1 10); do if [ -e "$WD_SYS/watchdog0" ]; then break; fi; sleep 1; done
fi
[ -e "$WD_SYS/watchdog0" ] || abbruch "nach modprobe i6300esb kein Watchdog-Gerät (watchdog0)"
pruefe_wd " — nach dem Laden des Moduls (Pakete/hosts eingerichtet, Watchdog-Konfiguration unvollständig)"
h=$(fremde_halter); [ -z "$h" ] || abbruch "Watchdog wird nach dem Laden offen gehalten von $h — SBD muss einziger Besitzer sein"
WD_ID=$(cat "$WD_SYS/watchdog0/identity" 2>/dev/null || true)
# ── systemd: kein Runtime-Watchdog (SBD ist einziger Besitzer) ──
inhalt_gleich "$SYSTEMD_CONF" "$SYSTEMD_SOLL" || { schreibe "$SYSTEMD_CONF" 0644 "$SYSTEMD_SOLL"; aend systemd-runtimewatchdog; }
rw=$(systemctl show -p RuntimeWatchdogUSec --value 2>/dev/null || true)
if [ "$rw" != 0 ]; then systemctl daemon-reexec || abbruch "systemctl daemon-reexec fehlgeschlagen"; aend systemd-neu-geladen; rw=$(systemctl show -p RuntimeWatchdogUSec --value 2>/dev/null || true); fi
[ "$rw" = 0 ] || abbruch "systemd RuntimeWatchdogUSec ist '$rw', erwartet 0 (aus)"
# ── Host-Firewall: eigene Tabelle inet alfred_ha über alfred-hostfw.service ──
FW_NEU=0
if ! inhalt_gleich "$FW_DATEI" "$NFT_SOLL"; then
  mkdir -p "$(dirname "$FW_DATEI")"
  printf '%s\\n' "$NFT_SOLL" >"$FW_DATEI.alfred-neu"; chmod 0644 "$FW_DATEI.alfred-neu"
  aus=$(nft -c -f "$FW_DATEI.alfred-neu" 2>&1) || { rm -f -- "$FW_DATEI.alfred-neu"; abbruch "nft lehnt den Regelsatz ab: $(kurz "$aus")"; }
  mv -f "$FW_DATEI.alfred-neu" "$FW_DATEI"; FW_NEU=1; aend firewall-regeln
fi
if ! inhalt_gleich "$UNIT_DATEI" "$UNIT_SOLL"; then schreibe "$UNIT_DATEI" 0644 "$UNIT_SOLL"; systemctl daemon-reload; FW_NEU=1; aend firewall-dienst; fi
if ! systemctl is-enabled --quiet "$FW_DIENST"; then systemctl enable "$FW_DIENST" >/dev/null 2>&1 || abbruch "$FW_DIENST lässt sich nicht aktivieren"; aend firewall-aktiviert; fi
if [ "$FW_NEU" = 1 ] || ! systemctl is-active --quiet "$FW_DIENST" || ! nft list table inet "$NFT_TABELLE" >/dev/null 2>&1; then
  systemctl restart "$FW_DIENST" || abbruch "$FW_DIENST startet nicht: $(kurz "$(journalctl -u "$FW_DIENST" -n 6 --no-pager 2>&1 || true)")"
  aend firewall-geladen
fi
# ── hacluster-Kennwort (aus stdin; nur bei Abweichung) ──
if ! kw_vergleich; then
  printf 'hacluster:%s\\n' "$KW" | chpasswd || abbruch "chpasswd für hacluster fehlgeschlagen"
  printf 'ALFRED-HACLUSTER-GESETZT\\n'
  aend hacluster-kennwort
fi
# ── Dienste: frisch installierte Cluster-Dienste bleiben aus (Task 3), pcsd läuft (hinter der Firewall) ──
# nie bei einer Wiederholung: dann laufen die Cluster-Dienste ab Task 3 gewollt
if [ "$FRISCH_CLUSTER" = 1 ]; then
  for d in pacemaker corosync sbd; do
    if systemctl is-enabled --quiet "$d" || systemctl is-active --quiet "$d"; then
      aus=$(systemctl disable --now "$d" 2>&1) || abbruch "$d lässt sich nach der frischen Installation nicht stoppen/deaktivieren: $(kurz "$aus")"
      aend "aus:$d"
    fi
    ! systemctl is-active --quiet "$d" || abbruch "$d läuft nach der frischen Installation noch"
  done
fi
if ! systemctl is-enabled --quiet pcsd || ! systemctl is-active --quiet pcsd; then
  systemctl enable --now pcsd >/dev/null 2>&1 || abbruch "pcsd lässt sich nicht starten"
  aend pcsd
fi
# ── SQL Server: HADR an (Neustart nur bei Änderung) ──
NS=false
if [ "$(hadr_wert)" != 1 ]; then
  aus=$("$MSSQLCONF" set hadr.hadrenabled 1 2>&1) || abbruch "mssql-conf set hadr.hadrenabled fehlgeschlagen: $(kurz "$aus")"
  systemctl restart mssql-server || abbruch "Neustart von mssql-server fehlgeschlagen"
  ok=0; for i in $(seq 1 60); do if ss -Htln 'sport = :1433' | grep -q .; then ok=1; break; fi; sleep 2; done
  [ "$ok" = 1 ] || abbruch "SQL Server lauscht nach dem Neustart nicht auf 1433 (120 s)"
  NS=true; aend hadr
fi
# ── Selbstprüfung ──
for i in "\${!KNOTEN_NAME[@]}"; do
  # alle Adressen (glibc liefert jeden Treffer aus /etc/hosts) — genau die Knoten-IP, kein Loopback
  a=$(getent ahostsv4 "\${KNOTEN_NAME[$i]}" | awk '{ print $1 }' | sort -u | tr '\\n' ' ' | sed 's/ $//' || true)
  [ "$a" = "\${KNOTEN_IP[$i]}" ] || abbruch "hosts: \${KNOTEN_NAME[$i]} löst zu '\${a:-nichts}' auf, erwartet \${KNOTEN_IP[$i]}"
done
PJ=''
for pv in "\${PAKETE[@]}"; do
  pk=\${pv%%=*}; iv=$(paket_version "$pk")
  { [ "$iv" = "\${pv#*=}" ] && paket_gehalten "$pk"; } || abbruch "$pk: Version '$iv' oder nicht gehalten (erwartet \${pv#*=}, hold)"
  PJ+="\${PJ:+,}\\"$pk\\":\\"$iv\\""
done
pruefe_wd " (Selbstprüfung)"
h=$(fremde_halter); [ -z "$h" ] || abbruch "Watchdog offen gehalten von $h (Selbstprüfung)"
nft list table inet "$NFT_TABELLE" >/dev/null 2>&1 || abbruch "nft-Tabelle inet $NFT_TABELLE fehlt"
{ systemctl is-active --quiet "$FW_DIENST" && systemctl is-enabled --quiet "$FW_DIENST"; } || abbruch "$FW_DIENST nicht aktiv und aktiviert"
kw_vergleich || abbruch "hacluster-Kennwort stimmt nach dem Setzen nicht"
systemctl is-active --quiet pcsd || abbruch "pcsd läuft nicht"
[ "$(hadr_wert)" = 1 ] || abbruch "mssql.conf: hadr.hadrenabled ist '$(hadr_wert)', erwartet 1"
systemctl is-active --quiet mssql-server || abbruch "mssql-server läuft nicht"
if [ "$GEAENDERT" = 1 ]; then Z=geaendert; else Z=schon; fi
ergebnis "{\\"zustand\\":\\"$Z\\",\\"knoten\\":\\"$ICH\\",\\"rolle\\":\\"$ROLLE\\",\\"watchdog\\":$(printf '%s' "$WD_ID" | json_text),\\"pakete\\":{$PJ},\\"hadr\\":true,\\"firewall\\":\\"aktiv\\",\\"sql1433\\":$SQL1433_JSON,\\"pcsd\\":\\"aktiv\\",\\"neustartSql\\":$NS,\\"aenderungen\\":[$AJ]}"`;

/**
 * HA-Grundlage je Knoten, idempotent: hosts-Block der drei Knoten, Pakete fest und gehalten (pacemaker, corosync, pcs, sbd,
 * resource-agents-base, mssql-server-ha = SQL-Version, linux-modules-extra des laufenden Kernels), i6300esb laden + modules-load.d,
 * softdog gesperrt, systemd RuntimeWatchdogSec aus, hacluster-Kennwort aus stdin, HADR an (Neustart nur bei Änderung), nft-Tabelle
 * inet alfred_ha über alfred-hostfw.service. Zeit: LINUX_HA_ZEIT_MS.vorbereiten
 */
export function haVorbereitenSkript(p: HaVorbereitenParameter): string {
  pruefe(pruefeHaVorbereiten(p));
  const k = p.knoten.map(x => ({ name: x.name, ip: x.ip }));
  const v = Object.fromEntries(HA_PAKETE.map(([s]) => [s, p.versionen[s]])) as unknown as HaVersionen;
  return [
    ...sqlKopf(LINUX_HA_BAUSTEINE.vorbereiten, { knoten: k, rolle: p.rolle, versionen: v }, 'ALFRED-HA'),
    `KNOTEN_NAME=(${k.map(x => shQ(x.name)).join(' ')})`,
    `KNOTEN_IP=(${k.map(x => shQ(x.ip)).join(' ')})`,
    `ROLLE=${shQ(p.rolle)}`,
    `V_SQL=${shQ(v.mssqlHa)}`,
    `PAKETE=(${HA_PAKETE.map(([s, n]) => shQ(`${n}=${v[s]}`)).join(' ')})`,
    `H_ANFANG=${shQ(HA_HOSTS_ANFANG)}`,
    `H_ENDE=${shQ(HA_HOSTS_ENDE)}`,
    `HOSTS_BLOCK=${shQ(hostsBlock(k))}`,
    `NFT_SOLL=${shQ(hostfwNft(k))}`,
    `SQL1433_JSON=${shQ(JSON.stringify([...k.map(x => x.ip), ...HA_SQL_ZUSATZQUELLEN]))}`,
    `H_ENTFERNT=${shQ(HA_HOSTS_ENTFERNT)}`,
    `UNIT_SOLL=${shQ(HOSTFW_UNIT)}`,
    `MODLOAD_SOLL=${shQ('# Alfred I8e Paket 2: Hardware-Watchdog für SBD\ni6300esb')}`,
    `MODPROBE_SOLL=${shQ('# Alfred I8e Paket 2: SBD ist einziger Watchdog-Besitzer — kein softdog\nblacklist softdog')}`,
    `SYSTEMD_SOLL=${shQ('# Alfred I8e Paket 2: SBD ist einziger Watchdog-Besitzer\n[Manager]\nRuntimeWatchdogSec=off')}`,
    `PY_KW_GLEICH=${shQ(PY_KW_GLEICH)}`,
    ...VORBEREITEN_PFADE,
    VORBEREITEN_HILFEN,
    '# ALFRED-ABLAUF',
    VORBEREITEN_KOERPER,
  ].join('\n');
}

// ── Status ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** python3-Statusprogramm (ohne Geheimnis): Watchdog (Kennung, Treiber, Besitzer), Pakete, HADR, Firewall, hosts, RuntimeWatchdog, pcsd */
export const PY_HA_STATUS = [
  'import glob, json, os, re, subprocess',
  `SOLL = ${JSON.stringify(Object.fromEntries(HA_PAKETE.map(([s, n]) => [n, HA_VERSIONEN[s]])))}`,
  `KNOTEN = ${JSON.stringify(HA_KNOTEN)}`,
  `ANFANG = ${JSON.stringify(HA_HOSTS_ANFANG)}`,
  `TABELLE = ${JSON.stringify(HA_NFT_TABELLE)}`,
  `DIENST = ${JSON.stringify(HA_HOSTFW_DIENST)}`,
  'def lauf(*a):',
  '    try:',
  '        p = subprocess.run(list(a), capture_output=True, text=True, timeout=30)',
  '        return p.returncode, p.stdout.strip()',
  '    except Exception:',
  '        return 1, ""',
  'def lies(p):',
  '    try:',
  '        with open(p) as f:',
  '            return f.read().strip()',
  '    except Exception:',
  '        return None',
  'r = {"zustand": "gelesen"}',
  // Watchdog: Geräte mit Kennung, PCI-Gerät, Besitzer (/proc/*/fd)
  'wd = []',
  'for d in sorted(glob.glob("/sys/class/watchdog/watchdog*")):',
  '    t = os.path.realpath(os.path.join(d, "device", "driver")) if os.path.exists(os.path.join(d, "device", "driver")) else ""',
  '    wd.append({"geraet": os.path.basename(d), "kennung": lies(os.path.join(d, "identity")), "treiber": os.path.basename(t) or None})',
  'r["watchdog"] = wd',
  'r["pciEsb"] = any(lies(os.path.join(d, "vendor")) == "0x8086" and lies(os.path.join(d, "device")) == "0x25ab" for d in glob.glob("/sys/bus/pci/devices/*"))',
  'halter = []',
  'for f in glob.glob("/proc/[0-9]*/fd/*"):',
  '    try:',
  '        z = os.readlink(f)',
  '    except OSError:',
  '        continue',
  '    if re.match(r"^/dev/watchdog[0-9]*$", z):',
  '        pid = f.split("/")[2]',
  '        e = None',
  '        try:',
  '            e = os.readlink("/proc/%s/exe" % pid)',
  '        except OSError:',
  '            pass',
  '        h = {"pid": int(pid), "name": lies("/proc/%s/comm" % pid), "exe": e}',
  '        if h not in halter:',
  '            halter.append(h)',
  'r["halter"] = halter',
  // Pakete: Version und gehalten (Realfall 17.11.: „hold ok installed“ zählt als installiert)
  'pakete = {}',
  'for pk in list(SOLL) + ["mssql-server", "linux-modules-extra-" + os.uname().release]:',
  '    c, v = lauf("dpkg-query", "-W", "-f=${Status}|${Version}", pk)',
  '    st, _, ver = v.partition("|")',
  '    pakete[pk] = {"version": ver if c == 0 and st.endswith(" ok installed") else None, "gehalten": c == 0 and st == "hold ok installed"}',
  'r["pakete"] = pakete',
  'r["soll"] = SOLL',
  'import configparser',
  'cp = configparser.ConfigParser(interpolation=None)',
  'try:',
  '    cp.read("/var/opt/mssql/mssql.conf")',
  'except Exception:',
  '    pass',
  'r["hadr"] = cp.get("hadr", "hadrenabled", fallback=None)',
  'r["sqlDienst"] = lauf("systemctl", "is-active", "mssql-server")[1] or "unbekannt"',
  'r["firewall"] = {"tabelle": lauf("nft", "list", "table", "inet", TABELLE)[0] == 0, "dienst": lauf("systemctl", "is-active", DIENST)[1] or "unbekannt", "aktiviert": lauf("systemctl", "is-enabled", DIENST)[1] or "unbekannt"}',
  'hosts = lies("/etc/hosts") or ""',
  'r["hosts"] = ANFANG in hosts.splitlines() and all(("%s %s" % (k["ip"], k["name"])) in hosts.splitlines() for k in KNOTEN)',
  // Fix-Runde 1: eigener Name auf Loopback (cloud-init 127.0.1.1) und die vom Baustein ersetzten Originale
  'ich = os.uname().nodename.split(".")[0]',
  'def namen(z):',
  '    t = z.split("#")[0].split()',
  '    return t[1:] if t else []',
  'r["hostsLoopback"] = [z for z in hosts.splitlines() if z.split() and z.split()[0].startswith("127.") and any(n == ich or n.startswith(ich + ".") for n in namen(z))]',
  `r["hostsEntfernt"] = [z for z in hosts.splitlines() if z.startswith(${JSON.stringify(HA_HOSTS_ENTFERNT)})]`,
  'c, t = lauf("nft", "list", "set", "inet", TABELLE, "sql_quellen4")',
  'r["sql1433Zusatz"] = re.findall(r"\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b", t.split("elements", 1)[1]) if c == 0 and "elements" in t else []',
  'r["runtimeWatchdog"] = lauf("systemctl", "show", "-p", "RuntimeWatchdogUSec", "--value")[1] or None',
  'r["pcsd"] = lauf("systemctl", "is-active", "pcsd")[1] or "unbekannt"',
  'print("ALFRED-HA " + json.dumps(r))',
].join('\n');

/** lesender Status; Zeit: LINUX_HA_ZEIT_MS.status */
export function haStatusSkript(): string {
  return [
    ...sqlKopf(LINUX_HA_BAUSTEINE.status, {}, 'ALFRED-HA'),
    `PY_HA_STATUS=${shQ(PY_HA_STATUS)}`,
    'python3 -c "$PY_HA_STATUS"',
    'ALFRED_ZEILE=1',
  ].join('\n');
}

// ── Register ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

registriereLinuxBaustein<HaVorbereitenParameter>(LINUX_HA_BAUSTEINE.vorbereiten, haVorbereitenSkript);
registriereLinuxBaustein(LINUX_HA_BAUSTEINE.status, () => haStatusSkript());
