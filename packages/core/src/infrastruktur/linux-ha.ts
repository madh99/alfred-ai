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

/** Task 3: Cluster-Name und Zeitwerte (Owner-Entscheidung 3: SBD_WATCHDOG_TIMEOUT 10, stonith-watchdog-timeout 20, Token pcs-Standard) */
export const HA_CLUSTER_NAME = 'sqllnxcl01';
export const HA_SBD_TIMEOUT_S = 10;
export const HA_STONITH_WD_TIMEOUT_S = 20;
/** einziger Watchdog-Pfad für SBD (i6300esb, ha_vorbereiten) */
export const HA_WATCHDOG_DEV = '/dev/watchdog';

/**
 * Task 4 — Fencing-Beweis je Knoten (Owner-Entscheidung 2): (a) trennung = Corosync (UDP 5405) auf dem Testknoten 120 s sperren
 * (nft-Tabelle ohne Persistenz, Aufheben per Timer und spätestens durch den Reset) → Quorumverlust → SBD setzt den Knoten über den
 * i6300esb zurück; (b) einmalig auf sqllnxcfg haenger = Kernel-Absturz (sysrq c) → der Hardware-Watchdog setzt zurück.
 */
export const HA_FENCING_ARTEN = ['trennung', 'haenger'] as const;
export type HaFencingArt = typeof HA_FENCING_ARTEN[number];
export const HA_FENCING_DIR = '/var/lib/alfred/ha';
export const HA_FENCING_TEST_DATEI = `${HA_FENCING_DIR}/fencing-test.json`;
export const HA_FENCING_BELEG_DATEI = `${HA_FENCING_DIR}/fencing-beleg.json`;
/** Sperrdauer der Corosync-Trennung */
export const HA_FENCING_SPERRE_S = 120;
/** Auslösung so viele Sekunden nach dem Schreiben der Test-Datei (SSH-Aufruf kehrt vorher sauber zurück) */
export const HA_FENCING_VERZOEGERUNG_S = 3;
/** ein Test ist höchstens so lange belegbar */
export const HA_FENCING_MAX_ALTER_S = 1800;
/** der Reset muss spätestens so lange nach der Auslösung erfolgen (trennung: während der Sperre), sonst gilt er nicht als Testfolge */
export const HA_FENCING_RESET_MAX_S = 120;
/** haenger (Kernel-Absturz) nur hier — Owner-Entscheidung 2 */
export const HA_FENCING_HAENGER_KNOTEN = 'sqllnxcfg';
export const HA_FENCETEST_TABELLE = 'alfred_fencetest';
/** corosync meldet so das (Wieder-)Erlangen des Quorums — Quelle der Rejoin-Zeit */
export const HA_COROSYNC_QUORUM_TEXT = 'This node is within the primary component and will provide service';

export const LINUX_HA_BAUSTEINE = {
  vorbereiten: 'ha.vorbereiten', status: 'ha.status', cluster: 'ha.cluster_anlegen', clusterEntfernen: 'ha.cluster_entfernen',
  fencingPruefen: 'ha.fencing_pruefen', fencingBelegen: 'ha.fencing_belegen',
} as const;
/** Zeitgrenzen für `linuxSkript(…, timeoutMs, …)` — am Host läuft das Skript bis timeoutMs − 20 s */
export const LINUX_HA_ZEIT_MS = { vorbereiten: 1_500_000, status: 90_000, cluster: 900_000, clusterEntfernen: 600_000, fencingPruefen: 180_000, fencingBelegen: 300_000 } as const;

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

/**
 * python3: stimmt das Kennwort (stdin) mit dem hacluster-Hash in argv[1] (/etc/shadow) überein? 0 ja, 1 nein, 2 nicht prüfbar
 * (crypt fehlt, shadow nicht lesbar, crypt wirft oder kennt das Hash-Verfahren nicht) — 2 führt im Baustein zum sichtbaren Abbruch
 */
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
  'try:',
  '    with open(sys.argv[1]) as f:',
  '        for z in f:',
  '            t = z.rstrip("\\n").split(":")',
  '            if t[0] == "hacluster" and len(t) > 1:',
  '                h = t[1]',
  'except Exception:',
  '    sys.exit(2)',
  'if not h or h[0] in "!*":',
  '    sys.exit(1)',
  'try:',
  '    e = crypt.crypt(kw, h)',
  'except Exception:',
  '    sys.exit(2)',
  'if e is None:',
  '    sys.exit(2)',
  'sys.exit(0 if e == h else 1)',
].join('\n');

/** Bash-Text mit „§{“ statt „${“ (String.raw ohne Escape-Salat) */
const sh = (s: string) => s.replaceAll('§{', '${');

/**
 * Task 3 — corosync.conf lesen (gemeinsam für ha_vorbereiten und die Cluster-Bausteine). Debian/Ubuntu liefert mit dem Paket corosync
 * eine Standardkonfiguration (`cluster_name: debian`, Knoten nur auf 127.0.0.1) — sie gilt als „kein Cluster eingerichtet“.
 */
const KONF_HILFEN = sh(String.raw`# corosync.conf-Text ($1) → Clustername
# (ohne awk-exit: unter pipefail könnte printf sonst SIGPIPE melden)
konf_name() { printf '%s\n' "$1" | awk '{ sub(/#.*/, "") } $1 == "cluster_name:" && !g { print $2; g = 1 }'; }
# corosync.conf-Text ($1) → „name=ring0_addr“ je Knoten, sortiert, durch Leerzeichen getrennt
konf_knoten() { printf '%s\n' "$1" | awk '{ sub(/#.*/, "") } $1 == "node" && $2 == "{" { k = 1; n = ""; a = ""; next } k && $1 == "name:" { n = $2 } k && $1 == "ring0_addr:" { a = $2 } k && $1 == "}" { k = 0; print n "=" a }' | sort | tr '\n' ' ' | sed 's/ $//'; }
# Debian-Standard: Name „debian“, jeder Knoten (falls überhaupt einer) auf Loopback
konf_debian() { local x lo=1; [ "$(konf_name "$1")" = debian ] || return 1; for x in $(konf_knoten "$1"); do case "$x" in *=127.*) ;; *) lo=0 ;; esac; done; [ "$lo" = 1 ]; }
# kein Cluster eingerichtet: leer (oder fehlend) oder Debian-Standard
konf_frei() { [ -z "$(printf '%s' "$1" | tr -d '[:space:]')" ] || konf_debian "$1"; }
# leer | debian | alfred | fremd:<name> (<knoten>) — alfred = Name $CLUSTER und genau die Knoten $KNOTEN_SOLL
konf_art() {
  local n kn
  if [ -z "$(printf '%s' "$1" | tr -d '[:space:]')" ]; then echo leer; return 0; fi
  if konf_debian "$1"; then echo debian; return 0; fi
  n=$(konf_name "$1"); kn=$(konf_knoten "$1")
  if [ "$n" = "$CLUSTER" ] && [ "$kn" = "$KNOTEN_SOLL" ]; then echo alfred; return 0; fi
  echo "fremd:§{n:-ohne Namen} (§{kn:-ohne Knoten})"
}`);

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
# ── Cluster-Dienste: gleich nach der Installation aus, solange kein Cluster eingerichtet ist ──
# Task 3 (Ruling a): „kein Cluster“ = keine corosync.conf oder die Debian-Standardkonfiguration (cluster_name debian, nur Loopback) — gilt
# auch bei der Wiederholung nach einem abgebrochenen Erstlauf; ist ein Cluster eingerichtet (sqllnxcl01 oder ein anderer), bleiben die
# Dienste unberührt. Die Debian-Standardkonfiguration wird beiseitegelegt: pcs cluster setup verweigert Knoten mit corosync.conf
# (ohne --force, das Alfred nie setzt).
if [ ! -e "$COROSYNC_CONF" ] || konf_frei "$(cat "$COROSYNC_CONF")"; then
  for d in pacemaker corosync sbd; do
    if systemctl is-enabled --quiet "$d" || systemctl is-active --quiet "$d"; then
      aus=$(systemctl disable --now "$d" 2>&1) || abbruch "$d lässt sich nicht stoppen/deaktivieren (noch kein Cluster eingerichtet): $(kurz "$aus")"
      aend "aus:$d"
    fi
    ! systemctl is-active --quiet "$d" || abbruch "$d läuft noch, obwohl kein Cluster eingerichtet ist"
  done
  if [ -e "$COROSYNC_CONF" ]; then mv -f "$COROSYNC_CONF" "$COROSYNC_CONF.alfred-debian-$(date +%Y%m%d%H%M%S)"; aend corosync-standard-beiseite; fi
fi
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
# ── pcsd läuft (hinter der Firewall); die Cluster-Dienste regelt der Block nach der Installation ──
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
    KONF_HILFEN,
    VORBEREITEN_HILFEN,
    '# ALFRED-ABLAUF',
    VORBEREITEN_KOERPER,
  ].join('\n');
}

// ── Cluster (Task 3): cluster_anlegen / cluster_entfernen ────────────────────────────────────────────────────────────────────

export interface HaClusterParameter { cluster: string; knoten: HaKnoten[]; sbd_timeout_s: number; stonith_timeout_s: number }
export interface HaClusterEntfernenParameter { cluster: string; knoten: HaKnoten[] }

const CLUSTER_NAME = /^[a-z][a-z0-9-]{2,30}$/;

export function pruefeClusterName(c: unknown): string | undefined {
  if (typeof c !== 'string' || !CLUSTER_NAME.test(c)) return 'cluster: Name aus Kleinbuchstaben/Ziffern/- (3–31 Zeichen), z. B. sqllnxcl01';
  if (c === 'debian') return 'cluster: „debian“ ist der Name der Debian-Standardkonfiguration';
  return undefined;
}

/** Validator: Knoten, SBD_WATCHDOG_TIMEOUT 5–60 s, stonith-watchdog-timeout ganze Sekunden ≥ 2 × SBD_WATCHDOG_TIMEOUT und ≤ 600 s */
export function pruefeHaCluster(p: unknown): string | undefined {
  const x = obj(p);
  const fc = pruefeClusterName(x.cluster); if (fc) return fc;
  const fk = pruefeKnoten(x.knoten); if (fk) return fk;
  const n = x.sbd_timeout_s; const m = x.stonith_timeout_s;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 5 || n > 60) return 'sbd_timeout_s: ganze Sekunden 5–60 (Owner-Entscheidung: 10)';
  if (typeof m !== 'number' || !Number.isInteger(m) || m > 600) return 'stonith_timeout_s: ganze Sekunden bis 600 (Owner-Entscheidung: 20)';
  if (m < 2 * n) return `stonith_timeout_s ${m} zu klein — stonith-watchdog-timeout muss mindestens 2 × sbd_timeout_s sein (${2 * n})`;
  return undefined;
}

export function pruefeHaClusterEntfernen(p: unknown): string | undefined {
  const x = obj(p);
  return pruefeClusterName(x.cluster) ?? pruefeKnoten(x.knoten);
}

/** python3: crm_mon-XML (pacemaker 2.1 `--output-as=xml`, auch das alte `--as-xml`) → Knoten, online, Quorum, stonith-enabled, Ressourcen */
export const PY_CRM_FUNK = String.raw`import xml.etree.ElementTree as ET
def crm_lage(t):
    r = ET.fromstring(t)
    s = r.find("summary")
    def wert(name, attr):
        e = s.find(name) if s is not None else None
        return e.get(attr) if e is not None else None
    nodes = r.find("nodes")
    kn = [n for n in (nodes.findall("node") if nodes is not None else []) if n.get("type", "member") == "member"]
    online = sorted(n.get("name") for n in kn if n.get("online") == "true" and n.get("unclean", "false") != "true")
    try:
        res = int(wert("resources_configured", "number") or 0)
    except ValueError:
        res = -1
    return {"knoten": len(kn), "online": online, "quorum": wert("current_dc", "with_quorum") == "true", "stonith": wert("cluster_options", "stonith-enabled") == "true", "ressourcen": res}`;

/** Ausgabe für Bash: „<knoten> <online> <quorum 0|1> <stonith 0|1> <ressourcen> <online-namen,…|->“; Exit 2 bei unlesbarem XML */
export const PY_CRM_LAGE = `${PY_CRM_FUNK}
import sys
try:
    l = crm_lage(sys.stdin.read())
except Exception:
    sys.exit(2)
print(l["knoten"], len(l["online"]), 1 if l["quorum"] else 0, 1 if l["stonith"] else 0, l["ressourcen"], ",".join(l["online"]) or "-")`;

/**
 * python3 für den Status: crm_lage, dazu konf(t) → (Clustername, [{name, ip}]) aus corosync.conf und sbd_lesen(t) → {knoten: {installiert,
 * aktiviert, laeuft}} aus `pcs stonith sbd status` („<knoten>: YES | YES | YES“; Kopfzeilen werden übersprungen)
 */
export const PY_CLUSTER_FUNK = `${PY_CRM_FUNK}
${String.raw`def konf(t):
    name = None
    kn = []
    k = False
    n = a = None
    for z in t.splitlines():
        w = z.split("#")[0].split()
        if not w:
            continue
        if w[0] == "cluster_name:" and len(w) > 1 and name is None:
            name = w[1]
        elif w[0] == "node" and w[1:2] == ["{"]:
            k = True
            n = a = None
        elif k and w[0] == "name:" and len(w) > 1:
            n = w[1]
        elif k and w[0] == "ring0_addr:" and len(w) > 1:
            a = w[1]
        elif k and w[0] == "}":
            k = False
            kn.append({"name": n, "ip": a})
    return name, kn
def sbd_lesen(t):
    sb = {}
    for z in t.splitlines():
        nn, _, rest = z.partition(":")
        f = [v.strip() for v in rest.split("|")]
        if len(f) == 3 and nn.strip() and not nn.strip().startswith("<"):
            sb[nn.strip()] = {"installiert": f[0] == "YES", "aktiviert": f[1] == "YES", "laeuft": f[2] == "YES"}
    return sb`}`;

/** Pfade und Werkzeuge der Cluster-Bausteine — vor der Marke, damit Tests sie umbiegen können */
const CLUSTER_PFADE = [
  'COROSYNC_CONF=/etc/corosync/corosync.conf',
  'CIB_DATEI=/var/lib/pacemaker/cib/cib.xml',
  'WD_SYS=/sys/class/watchdog',
  // warte_online: Runden à 2 s (120 s)
  'WARTE_RUNDEN=60',
  `WD_DEV=${shQ(HA_WATCHDOG_DEV)}`,
];

const CLUSTER_HILFEN = sh(String.raw`paket_version() { dpkg-query -W -f='§{Status}|§{Version}' "$1" 2>/dev/null | awk -F'|' '$1 ~ / ok installed$/ { print $2 }' || true; }
kurz() { printf "%s" "$1" | tail -n 6 | tr "\r\n" "  "; }
ist_esb() { local r=1; shopt -s nocasematch; if [[ "$1" == *i6300esb* ]]; then r=0; fi; shopt -u nocasematch; return $r; }
eigener_name() { hostname -s; }
port_offen() { timeout 5 bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$1" "$2" >/dev/null 2>&1; }
schwaerze() { local t="$1"; if [ -n "§{KW:-}" ]; then t=§{t//"$KW"/[geschwärzt]}; fi; printf '%s' "$t"; }
GEAENDERT=0; AJ=''
aend() { GEAENDERT=1; AJ+="§{AJ:+,}\"$1\""; }
stand() { if [ "$GEAENDERT" = 1 ]; then printf 'am Cluster nichts geändert (nur pcs-Anmeldung erneuert)'; else printf 'nichts geändert'; fi; }
# alle Knoten melden „Online“ (pcsd erreichbar, lokale pcs-Anmeldung gültig)
pcsd_online() { local s k; s=$(pcs status pcsd "§{KNOTEN_NAME[@]}" 2>&1 || true); for k in "§{KNOTEN_NAME[@]}"; do grep -qE "^[[:space:]]*$k: Online[[:space:]]*$" <<<"$s" || return 1; done; }
# pcs liest das Kennwort ohne -p von der Standardeingabe (kein Terminal: utils.get_terminal_password → input()); nie auf der Befehlszeile
anmelden() { local aus; aus=$(printf '%s\n' "$KW" | pcs host auth "§{KNOTEN_ADDR[@]}" -u hacluster 2>&1) || abbruch "pcs host auth (hacluster) fehlgeschlagen: $(kurz "$(schwaerze "$aus")") — Kennwort aus dem Tresor sqllnx-ha-hacluster, gesetzt von ha_vorbereiten; $(stand)"; }
# Lage aus crm_mon: LK Knoten, LO online, LQ Quorum (1/0), LS stonith-enabled (1/0), LR Ressourcen, LN Online-Namen (Komma)
lage() { local x l=''; if x=$(crm_mon -1 --output-as=xml 2>/dev/null); then l=$(python3 -c "$PY_CRM_LAGE" <<<"$x" 2>/dev/null || true); fi; read -r LK LO LQ LS LR LN <<<"§{l:-0 0 0 0 0 -}"; }
warte_online() { local i; for i in $(seq 1 "$WARTE_RUNDEN"); do lage; if [ "$LO" = "$ANZAHL" ] && [ "$LQ" = 1 ]; then return 0; fi; sleep 2; done; return 1; }
stimmen() { corosync-quorumtool -s 2>/dev/null | awk -F: '/^Total votes/ { gsub(/[ \t]/, "", $2); t = $2 } /^Expected votes/ { gsub(/[ \t]/, "", $2); e = $2 } END { print t "/" e }' || true; }
eigenschaft() { crm_attribute -t crm_config -n "$1" -G -q 2>/dev/null || true; }
sekunden() { if [[ "$1" =~ ^([0-9]+)s?$ ]]; then printf '%s' "§{BASH_REMATCH[1]}"; else printf '%s' "$1"; fi; }
cib_ressourcen() { local n=0; if [ -f "$CIB_DATEI" ]; then n=$(grep -c '<primitive' "$CIB_DATEI" || true); fi; printf '%s' "§{n:-0}"; }
sbd_status() { pcs stonith sbd status 2>&1 || true; }
# Anzahl Knoten mit YES in Spalte $2 (1 installiert, 2 aktiviert, 3 läuft) der Ausgabe $1 („<knoten>: YES | YES | YES“)
sbd_zahl() { local n=0 k; for k in "§{KNOTEN_NAME[@]}"; do if printf '%s\n' "$1" | awk -v k="$k" -v sp="$2" '{ i = index($0, ":"); if (!i) next; nm = substr($0, 1, i - 1); gsub(/[ \t]/, "", nm); if (nm != k) next; split(substr($0, i + 1), f, "|"); v = f[sp]; gsub(/[ \t]/, "", v); if (v == "YES") ok = 1 } END { exit !ok }'; then n=$((n + 1)); fi; done; printf '%s' "$n"; }
# SBD wie gefordert: diskless (keine Devices), Watchdog $WD_DEV je Knoten, SBD_WATCHDOG_TIMEOUT, auf allen aktiviert — Abweichungen in SBD_ABW
sbd_soll() {
  local c s k t
  SBD_ABW=''
  c=$(pcs stonith sbd config 2>&1 || true)
  t=$(awk -F= '$1 == "SBD_WATCHDOG_TIMEOUT" { print $2 }' <<<"$c" | tr -d ' \r' | tail -n 1)
  [ "$t" = "$SBD_T" ] || SBD_ABW+="§{SBD_ABW:+, }SBD_WATCHDOG_TIMEOUT '§{t:-fehlt}' statt $SBD_T"
  if grep -q '^Devices:' <<<"$c"; then SBD_ABW+="§{SBD_ABW:+, }SBD mit Devices (nicht diskless)"; fi
  for k in "§{KNOTEN_NAME[@]}"; do grep -qE "^[[:space:]]+$k: $WD_DEV[[:space:]]*$" <<<"$c" || SBD_ABW+="§{SBD_ABW:+, }Watchdog $k nicht $WD_DEV"; done
  s=$(sbd_zahl "$(sbd_status)" 2)
  [ "$s" = "$ANZAHL" ] || SBD_ABW+="§{SBD_ABW:+, }SBD aktiviert auf $s/$ANZAHL"
  [ -z "$SBD_ABW" ]
}
# hacluster-Kennwort aus der ersten stdin-Zeile (JSON-Feld hacluster)
kennwort_lesen() {
  KW=$(feld hacluster) || abbruch "hacluster-Kennwort enthält nicht druckbare Zeichen — nichts geändert"
  [ -n "$KW" ] || abbruch "hacluster-Kennwort fehlt in der Eingabe (erste stdin-Zeile, JSON-Feld hacluster) — nichts geändert"
  [[ "$KW" =~ ^[[:print:]]+$ ]] || abbruch "hacluster-Kennwort enthält nicht druckbare Zeichen — nichts geändert"
}
# eigener Kurzname muss einer der Knoten sein
knoten_pruefen() {
  local i
  ICH=$(eigener_name); IDX=-1
  for i in "§{!KNOTEN_NAME[@]}"; do if [ "§{KNOTEN_NAME[$i]}" = "$ICH" ]; then IDX=$i; fi; done
  [ "$IDX" -ge 0 ] || abbruch "Rechner $ICH gehört nicht zu den Knoten §{KNOTEN_NAME[*]} — nichts geändert"
}`);

const CLUSTER_ANLEGEN_KOERPER = sh(String.raw`kennwort_lesen
# ── Phase 1: prüfen — bis hierhin wird nichts geändert ──
knoten_pruefen
for pv in "§{PAKETE[@]}"; do
  pk=§{pv%%=*}; iv=$(paket_version "$pk")
  [ "$iv" = "§{pv#*=}" ] || abbruch "$pk ist in Version '§{iv:-nicht installiert}' vorhanden, erwartet §{pv#*=} — vorher ha_vorbereiten auf $ICH; nichts geändert"
done
for c in pcs crm_mon crm_attribute corosync-quorumtool python3; do command -v "$c" >/dev/null 2>&1 || abbruch "$c fehlt auf $ICH — vorher ha_vorbereiten; nichts geändert"; done
[ -e "$WD_DEV" ] || abbruch "$WD_DEV fehlt auf $ICH — vorher ha_vorbereiten (i6300esb); kein softdog-Ersatz; nichts geändert"
wid=$(cat "$WD_SYS/watchdog0/identity" 2>/dev/null || true)
ist_esb "$wid" || abbruch "Watchdog auf $ICH stammt von '§{wid:-unbekannt}', erwartet i6300esb — kein softdog-Ersatz ohne Owner-Entscheidung; nichts geändert"
KONF=''; if [ -f "$COROSYNC_CONF" ]; then KONF=$(cat "$COROSYNC_CONF"); fi
ART=$(konf_art "$KONF")
case "$ART" in
  leer|alfred) ;;
  debian) abbruch "$COROSYNC_CONF auf $ICH ist noch die Debian-Standardkonfiguration — vorher ha_vorbereiten auf $ICH wiederholen (legt sie beiseite); nichts geändert" ;;
  *) abbruch "auf $ICH ist ein anderer Cluster eingerichtet: §{ART#fremd:} — erwartet $CLUSTER mit $KNOTEN_SOLL; nichts geändert" ;;
esac
for i in "§{!KNOTEN_NAME[@]}"; do
  port_offen "§{KNOTEN_IP[$i]}" 2224 || abbruch "pcsd auf §{KNOTEN_NAME[$i]} (§{KNOTEN_IP[$i]}:2224) nicht erreichbar — dort ha_vorbereiten (pcsd aktiv, Firewall alfred_ha); nichts geändert"
done
# ── Phase 2: pcs-Anmeldung an allen Knoten (nur wenn nötig) ──
if ! pcsd_online; then
  anmelden; aend pcs-anmeldung
  pcsd_online || abbruch "pcs meldet nach der Anmeldung nicht alle Knoten Online: $(kurz "$(pcs status pcsd "§{KNOTEN_NAME[@]}" 2>&1 || true)") — $(stand)"
fi
if [ "$ART" = leer ]; then
  # andere Knoten: keine Debian-Standard- oder fremde Konfiguration (pcs cluster setup prüft ohne --force zusätzlich selbst und bricht ab)
  for k in "§{KNOTEN_NAME[@]}"; do
    [ "$k" != "$ICH" ] || continue
    a=leer; if t=$(pcs cluster corosync "$k" 2>/dev/null); then a=$(konf_art "$t"); fi
    case "$a" in
      leer) ;;
      debian) abbruch "auf $k liegt noch die Debian-Standardkonfiguration von corosync — dort ha_vorbereiten wiederholen; $(stand)" ;;
      alfred) abbruch "auf $k ist $CLUSTER schon eingerichtet, auf $ICH nicht (Teilstand) — erst cluster_entfernen mit zugang $k, dann cluster_anlegen; $(stand)" ;;
      *) abbruch "auf $k ist ein anderer Cluster eingerichtet: §{a#fremd:} — $(stand)" ;;
    esac
  done
  # ── neu anlegen: knet über die festen Adressen, diskless SBD (kein sbd create), dann aktivieren und starten ──
  aus=$(pcs cluster setup "$CLUSTER" "§{KNOTEN_ADDR[@]}" transport knet 2>&1) || abbruch "pcs cluster setup fehlgeschlagen: $(kurz "$aus") — pcs prüft vor dem Anlegen; ein Teilstand geht mit cluster_entfernen zurück"
  aend cluster-angelegt
  aus=$(pcs stonith sbd enable "watchdog=$WD_DEV" "SBD_WATCHDOG_TIMEOUT=$SBD_T" 2>&1) || abbruch "pcs stonith sbd enable fehlgeschlagen: $(kurz "$aus") — Rückweg cluster_entfernen"
  aend sbd-diskless
  aus=$(pcs cluster enable --all 2>&1) || abbruch "pcs cluster enable --all fehlgeschlagen: $(kurz "$aus") — Rückweg cluster_entfernen"
  aend cluster-aktiviert
  aus=$(pcs cluster start --all --wait=180 2>&1) || abbruch "pcs cluster start --all fehlgeschlagen: $(kurz "$aus") — Rückweg cluster_entfernen"
  aend cluster-gestartet
  warte_online || abbruch "nach dem Start $LO/$ANZAHL Knoten online, Quorum $LQ — erwartet alle Knoten mit Quorum; Rückweg cluster_entfernen"
else
  # ── bestehender Cluster gleichen Namens mit denselben Knoten: nur Abweichungen beheben, jede sichtbar ──
  lage
  if ! systemctl is-enabled --quiet corosync || ! systemctl is-enabled --quiet pacemaker; then
    aus=$(pcs cluster enable --all 2>&1) || abbruch "pcs cluster enable --all fehlgeschlagen: $(kurz "$aus")"
    aend cluster-aktiviert
  fi
  if [ "$LO" != "$ANZAHL" ] || [ "$LQ" != 1 ]; then
    aus=$(pcs cluster start --all --wait=180 2>&1) || abbruch "pcs cluster start --all fehlgeschlagen: $(kurz "$aus")"
    aend cluster-gestartet
    warte_online || abbruch "nach dem Start $LO/$ANZAHL Knoten online, Quorum $LQ — erwartet alle Knoten mit Quorum"
  fi
  if ! sbd_soll; then
    # SBD ändern wirkt erst nach einem Neustart des ganzen Clusters — nur ohne Ressourcen (keine AG), sonst sichtbarer Abbruch
    [ "$LR" = 0 ] || abbruch "SBD weicht ab ($SBD_ABW), der Cluster trägt aber $LR Ressourcen — SBD ändern braucht einen Neustart des ganzen Clusters; nicht automatisch"
    # Task 4 (Carry-over 3): Stopp und Start des ganzen Clusters stehen in den Änderungen (Owner-Regel: nichts still)
    aus=$(pcs cluster stop --all 2>&1) || abbruch "pcs cluster stop --all fehlgeschlagen: $(kurz "$aus")"
    aend cluster-gestoppt
    aus=$(pcs stonith sbd enable "watchdog=$WD_DEV" "SBD_WATCHDOG_TIMEOUT=$SBD_T" 2>&1) || abbruch "pcs stonith sbd enable fehlgeschlagen: $(kurz "$aus") — Cluster ist gestoppt"
    aend sbd-neu-eingerichtet
    aus=$(pcs cluster start --all --wait=180 2>&1) || abbruch "pcs cluster start --all fehlgeschlagen: $(kurz "$aus") — Cluster ist gestoppt"
    aend cluster-gestartet
    warte_online || abbruch "nach dem SBD-Neustart $LO/$ANZAHL Knoten online, Quorum $LQ"
  fi
fi
# ── Eigenschaften: stonith-watchdog-timeout (diskless SBD) und stonith-enabled; have-watchdog setzt Pacemaker selbst (nur gelesen) ──
if [ "$(sekunden "$(eigenschaft stonith-watchdog-timeout)")" != "$STONITH_T" ]; then
  aus=$(pcs property set "stonith-watchdog-timeout=$STONITH_T" 2>&1) || abbruch "pcs property set stonith-watchdog-timeout=$STONITH_T fehlgeschlagen: $(kurz "$aus")"
  aend stonith-watchdog-timeout
fi
if [ "$(eigenschaft stonith-enabled)" != true ]; then
  aus=$(pcs property set stonith-enabled=true 2>&1) || abbruch "pcs property set stonith-enabled=true fehlgeschlagen: $(kurz "$aus")"
  aend stonith-enabled
fi
# ── Selbstprüfung ──
warte_online || abbruch "Selbstprüfung: $LO/$ANZAHL Knoten online, Quorum $LQ"
[ "$LK" = "$ANZAHL" ] || abbruch "Selbstprüfung: Pacemaker kennt $LK Knoten, erwartet $ANZAHL"
[ "$LN" = "$NAMEN_SOLL" ] || abbruch "Selbstprüfung: online sind $LN, erwartet $NAMEN_SOLL"
st=$(stimmen); [ "$st" = "$ANZAHL/$ANZAHL" ] || abbruch "Selbstprüfung: Quorum-Stimmen '$st', erwartet $ANZAHL/$ANZAHL"
[ "$LS" = 1 ] || abbruch "Selbstprüfung: stonith-enabled ist nicht true"
ss=$(sbd_status); n=$(sbd_zahl "$ss" 3)
[ "$n" = "$ANZAHL" ] || abbruch "Selbstprüfung: SBD läuft auf $n/$ANZAHL Knoten: $(kurz "$ss")"
sbd_soll || abbruch "Selbstprüfung: SBD weicht ab: $SBD_ABW"
systemctl is-active --quiet sbd || abbruch "Selbstprüfung: sbd läuft auf $ICH nicht"
hw=$(eigenschaft have-watchdog); [ "$hw" = true ] || abbruch "Selbstprüfung: have-watchdog ist '§{hw:-nicht gesetzt}', erwartet true (SBD mit Watchdog aktiv)"
swt=$(sekunden "$(eigenschaft stonith-watchdog-timeout)"); [ "$swt" = "$STONITH_T" ] || abbruch "Selbstprüfung: stonith-watchdog-timeout ist '$swt', erwartet $STONITH_T"
nq=$(eigenschaft no-quorum-policy); [ "$nq" != ignore ] || abbruch "Selbstprüfung: no-quorum-policy=ignore widerspricht dem Dreierquorum — nicht automatisch geändert"
[ "$(konf_art "$(cat "$COROSYNC_CONF" 2>/dev/null || true)")" = alfred ] || abbruch "Selbstprüfung: $COROSYNC_CONF auf $ICH beschreibt nicht $CLUSTER mit $KNOTEN_SOLL"
if [ "$GEAENDERT" = 1 ]; then Z=geaendert; else Z=schon; fi
ergebnis "{\"zustand\":\"$Z\",\"cluster\":\"$CLUSTER\",\"ausgefuehrtAuf\":\"$ICH\",\"knoten\":$KNOTEN_JSON,\"online\":$LO,\"quorum\":\"$st\",\"stonith\":true,\"sbd\":\"$n/$ANZAHL\",\"sbdTimeoutS\":$SBD_T,\"stonithWatchdogTimeoutS\":$STONITH_T,\"haveWatchdog\":true,\"noQuorumPolicy\":$(printf '%s' "§{nq:-stop}" | json_text),\"aenderungen\":[$AJ]}"`);

const CLUSTER_ENTFERNEN_KOERPER = sh(String.raw`kennwort_lesen
# ── Phase 1: prüfen — bis hierhin wird nichts geändert ──
knoten_pruefen
command -v pcs >/dev/null 2>&1 || abbruch "pcs fehlt auf $ICH — nichts geändert"
KONF=''; if [ -f "$COROSYNC_CONF" ]; then KONF=$(cat "$COROSYNC_CONF"); fi
ART=$(konf_art "$KONF")
case "$ART" in
  leer|debian|alfred) ;;
  *) abbruch "auf $ICH ist ein anderer Cluster eingerichtet: §{ART#fremd:} — cluster_entfernen entfernt nur $CLUSTER mit $KNOTEN_SOLL; nichts geändert" ;;
esac
# ── pcs-Anmeldung (nur bei Bedarf); danach die Prüfungen über alle Knoten — alle vor der ersten Änderung am Cluster ──
if ! pcsd_online; then anmelden; aend pcs-anmeldung; fi
LO=0
if [ "$ART" = alfred ]; then
  # Task 4 (Carry-over 2): destroy --all nur, wenn jeder andere Knoten $CLUSTER oder keine corosync.conf trägt
  for k in "§{KNOTEN_NAME[@]}"; do
    [ "$k" != "$ICH" ] || continue
    t=$(pcs cluster corosync "$k" 2>/dev/null) || abbruch "corosync.conf von $k nicht lesbar (pcs cluster corosync $k) — ohne sie kein destroy --all; $(stand)"
    a=$(konf_art "$t")
    case "$a" in
      leer|alfred) ;;
      debian) abbruch "auf $k liegt die Debian-Standardkonfiguration statt $CLUSTER — destroy --all entfernt nur $CLUSTER; $(stand)" ;;
      *) abbruch "auf $k ist ein anderer Cluster eingerichtet: §{a#fremd:} — destroy --all entfernt nur $CLUSTER; $(stand)" ;;
    esac
  done
  # Task 4 (Carry-over 1): Ressourcen nur über einen laufenden Pacemaker prüfbar — sonst muss belegt sein, dass der Cluster auf allen Knoten
  # steht: SBD auf allen installiert und aktiviert, läuft auf keinem (sbd.service ist PartOf/RequiredBy corosync — kein Cluster ohne sbd)
  if systemctl is-active --quiet pacemaker; then
    lage
    [ "$LO" -gt 0 ] || abbruch "Pacemaker läuft auf $ICH, crm_mon liefert aber keine Lage — Ressourcen nicht prüfbar; $(stand)"
    RES=$LR
  else
    ss=$(sbd_status); si=$(sbd_zahl "$ss" 1); se=$(sbd_zahl "$ss" 2); sl=$(sbd_zahl "$ss" 3)
    { [ "$si" = "$ANZAHL" ] && [ "$se" = "$ANZAHL" ] && [ "$sl" = 0 ]; } || abbruch "Pacemaker ist auf $ICH nicht aktiv, und dass der Cluster auf allen Knoten steht, ist nicht belegt (SBD installiert $si/$ANZAHL, aktiviert $se/$ANZAHL, läuft $sl/$ANZAHL) — Ressourcen nicht prüfbar; cluster_entfernen auf einem Knoten mit laufendem Pacemaker ausführen; $(stand)"
    RES=$(cib_ressourcen)
  fi
  [ "$RES" = 0 ] || abbruch "Cluster $CLUSTER trägt $RES Ressourcen — vorher die Ressourcen (Verfügbarkeitsgruppe) entfernen; $(stand)"
fi
# ── Phase 2 ──
if [ "$ART" = alfred ]; then
  # erst sauber stoppen (Pacemaker beendet sich geordnet → SBD setzt keinen Knoten zurück), dann SBD aus, dann entfernen
  if [ "$LO" -gt 0 ] || systemctl is-active --quiet pacemaker || systemctl is-active --quiet corosync; then
    aus=$(pcs cluster stop --all 2>&1) || abbruch "pcs cluster stop --all fehlgeschlagen: $(kurz "$aus")"
    aend cluster-gestoppt
  fi
  aus=$(pcs stonith sbd disable 2>&1) || abbruch "pcs stonith sbd disable fehlgeschlagen: $(kurz "$aus") — Cluster ist gestoppt"
  aend sbd-aus
  # pcs 0.11 fragt vor destroy nach; --force ersetzt nur diese Rückfrage
  aus=$(pcs cluster destroy --all --force 2>&1) || abbruch "pcs cluster destroy --all fehlgeschlagen: $(kurz "$aus")"
  aend cluster-entfernt
fi
# ── Selbstprüfung (auch bei „schon“): $CLUSTER auf keinem Knoten mehr, Cluster-Dienste hier aus ──
if [ -f "$COROSYNC_CONF" ] && [ "$(konf_name "$(cat "$COROSYNC_CONF")")" = "$CLUSTER" ]; then abbruch "Selbstprüfung: $COROSYNC_CONF auf $ICH beschreibt noch $CLUSTER"; fi
for d in pacemaker corosync sbd; do
  ! systemctl is-active --quiet "$d" || abbruch "Selbstprüfung: $d läuft auf $ICH noch"
  ! systemctl is-enabled --quiet "$d" || abbruch "Selbstprüfung: $d ist auf $ICH noch aktiviert"
done
REST=''
for k in "§{KNOTEN_NAME[@]}"; do
  [ "$k" != "$ICH" ] || continue
  if t=$(pcs cluster corosync "$k" 2>/dev/null) && [ "$(konf_name "$t")" = "$CLUSTER" ]; then REST+=" $k"; fi
done
[ -z "$REST" ] || abbruch "Selbstprüfung: auf$REST liegt noch die corosync.conf von $CLUSTER (Teilstand) — dort pcs cluster destroy"
if [ "$GEAENDERT" = 1 ]; then Z=geaendert; else Z=schon; fi
ergebnis "{\"zustand\":\"$Z\",\"cluster\":\"$CLUSTER\",\"ausgefuehrtAuf\":\"$ICH\",\"knoten\":$KNOTEN_JSON,\"aenderungen\":[$AJ]}"`);

function clusterKopf(baustein: string, p: Record<string, unknown>, knoten: readonly HaKnoten[], cluster: string): string[] {
  const k = knoten.map(x => ({ name: x.name, ip: x.ip }));
  const sortiert = [...k].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [
    ...sqlKopf(baustein, p, 'ALFRED-HA'),
    `CLUSTER=${shQ(cluster)}`,
    `KNOTEN_NAME=(${k.map(x => shQ(x.name)).join(' ')})`,
    `KNOTEN_IP=(${k.map(x => shQ(x.ip)).join(' ')})`,
    // pcs host auth / cluster setup: „<name> addr=<ip>“ — Corosync knet und pcsd nur über die festen Adressen (keine Namensauflösung)
    `KNOTEN_ADDR=(${k.map(x => `${shQ(x.name)} ${shQ(`addr=${x.ip}`)}`).join(' ')})`,
    `KNOTEN_SOLL=${shQ(sortiert.map(x => `${x.name}=${x.ip}`).join(' '))}`,
    `NAMEN_SOLL=${shQ(sortiert.map(x => x.name).join(','))}`,
    `KNOTEN_JSON=${shQ(JSON.stringify(k.map(x => x.name)))}`,
    `ANZAHL=${k.length}`,
    `PY_CRM_LAGE=${shQ(PY_CRM_LAGE)}`,
    ...CLUSTER_PFADE,
    KONF_HILFEN,
    CLUSTER_HILFEN,
  ];
}

/**
 * Pacemaker-Cluster mit diskless SBD, auf EINEM Knoten (zugang) ausgeführt: pcs host auth (hacluster aus stdin) an allen Knoten,
 * pcs cluster setup <cluster> … transport knet, pcs stonith sbd enable watchdog=/dev/watchdog SBD_WATCHDOG_TIMEOUT=<n> (diskless, kein
 * sbd create), Cluster auf allen aktivieren und starten, stonith-watchdog-timeout=<m>, stonith-enabled=true. Idempotent: derselbe Cluster
 * mit denselben Knoten → nur Abweichungen beheben (`schon`, wenn keine); ein anderer Cluster → Abbruch ohne Änderung. Selbstprüfung:
 * alle Knoten online, Quorum n/n, sbd läuft und ist aktiviert auf allen, have-watchdog=true. Rückweg: ha.cluster_entfernen.
 * Zeit: LINUX_HA_ZEIT_MS.cluster
 */
export function haClusterSkript(p: HaClusterParameter): string {
  pruefe(pruefeHaCluster(p));
  const v = HA_VERSIONEN;
  const pakete = HA_PAKETE.filter(([s]) => s === 'pacemaker' || s === 'corosync' || s === 'pcs' || s === 'sbd');
  return [
    ...clusterKopf(LINUX_HA_BAUSTEINE.cluster, { cluster: p.cluster, knoten: p.knoten.map(x => ({ name: x.name, ip: x.ip })), sbd_timeout_s: p.sbd_timeout_s, stonith_timeout_s: p.stonith_timeout_s }, p.knoten, p.cluster),
    `SBD_T=${p.sbd_timeout_s}`,
    `STONITH_T=${p.stonith_timeout_s}`,
    `PAKETE=(${pakete.map(([s, n]) => shQ(`${n}=${v[s]}`)).join(' ')})`,
    '# ALFRED-ABLAUF',
    CLUSTER_ANLEGEN_KOERPER,
  ].join('\n');
}

/**
 * Rückweg von cluster_anlegen: Cluster sauber stoppen (pcs cluster stop --all), SBD aus (pcs stonith sbd disable), pcs cluster destroy
 * --all. Nur für <cluster> mit genau diesen Knoten und ohne Ressourcen; ein anderer Cluster → Abbruch ohne Änderung. Zeit:
 * LINUX_HA_ZEIT_MS.clusterEntfernen
 */
export function haClusterEntfernenSkript(p: HaClusterEntfernenParameter): string {
  pruefe(pruefeHaClusterEntfernen(p));
  return [
    ...clusterKopf(LINUX_HA_BAUSTEINE.clusterEntfernen, { cluster: p.cluster, knoten: p.knoten.map(x => ({ name: x.name, ip: x.ip })) }, p.knoten, p.cluster),
    '# ALFRED-ABLAUF',
    CLUSTER_ENTFERNEN_KOERPER,
  ].join('\n');
}

// ── Fencing-Beweis (Task 4): fencing_pruefen / fencing_belegen ──────────────────────────────────────────────────────────────────

export interface HaFencingParameter { cluster: string; knoten: HaKnoten[]; art: HaFencingArt }
export interface HaFencingBelegenParameter { cluster: string; knoten: HaKnoten[] }

export function pruefeHaFencing(p: unknown): string | undefined {
  const x = obj(p);
  const f = pruefeClusterName(x.cluster) ?? pruefeKnoten(x.knoten); if (f) return f;
  if (!HA_FENCING_ARTEN.includes(x.art as HaFencingArt)) return `art: ${HA_FENCING_ARTEN.join(' oder ')} (Owner-Entscheidung 2: trennung je Knoten, haenger einmalig auf ${HA_FENCING_HAENGER_KNOTEN})`;
  return undefined;
}
export function pruefeHaFencingBelegen(p: unknown): string | undefined {
  const x = obj(p);
  return pruefeClusterName(x.cluster) ?? pruefeKnoten(x.knoten);
}

/** Corosync-Trennung: eigene Tabelle, beide Richtungen, nur UDP 5405 — ohne Persistenz (Datei in /run, Aufheben per Timer, weg nach Reset) */
export function fencetestNft(): string {
  const udp = HA_PORTS.udp.join(', ');
  const t = HA_FENCETEST_TABELLE;
  return [
    '# Alfred I8e Paket 2 — Fencing-Test: Corosync (UDP) gesperrt, ohne Persistenz',
    `table inet ${t}`,
    `delete table inet ${t}`,
    `table inet ${t} {`,
    '\tchain ein {',
    '\t\ttype filter hook input priority -20; policy accept;',
    `\t\tudp dport { ${udp} } drop`,
    `\t\tudp sport { ${udp} } drop`,
    '\t}',
    '\tchain aus {',
    '\t\ttype filter hook output priority -20; policy accept;',
    `\t\tudp dport { ${udp} } drop`,
    `\t\tudp sport { ${udp} } drop`,
    '\t}',
    '}',
  ].join('\n');
}

/**
 * python3: Identität des Knotens im Cluster und Gültigkeit eines Belegs — dieselben Regeln (und Wortlaute) wie `fencingBelegGueltig`.
 * Identität = Clustername + nodeid aus corosync.conf + SHA-256 über corosync.conf und /etc/corosync/authkey (pcs cluster setup erzeugt den
 * authkey bei jeder Einrichtung neu → ein neu aufgebauter Cluster macht jeden alten Beleg ungültig; der Schlüssel selbst wird nie gespeichert).
 */
export const PY_FENCING_FUNK = String.raw`import hashlib, json, re, time
FENCING_ARTEN = ("trennung", "haenger")
def lies_json(p):
    try:
        with open(p) as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except Exception:
        return "unlesbar"
def fencing_ident(conf, key, ich):
    try:
        with open(conf, "rb") as f:
            t = f.read()
    except Exception:
        return None
    name = None
    nodeid = None
    k = False
    n = i = None
    for z in t.decode("utf-8", "replace").splitlines():
        w = z.split("#")[0].split()
        if not w:
            continue
        if w[0] == "cluster_name:" and len(w) > 1 and name is None:
            name = w[1]
        elif w[0] == "node" and w[1:2] == ["{"]:
            k = True
            n = i = None
        elif k and w[0] == "name:" and len(w) > 1:
            n = w[1]
        elif k and w[0] == "nodeid:" and len(w) > 1:
            i = w[1]
        elif k and w[0] == "}":
            k = False
            if n == ich:
                nodeid = i
    try:
        with open(key, "rb") as f:
            kb = f.read()
    except Exception:
        kb = b""
    return {"cluster": name, "knoten": ich, "nodeid": nodeid, "konfHash": hashlib.sha256(t + b"\0" + kb).hexdigest() if kb else None}
def _w(v):
    return "?" if v is None else str(v)
def fencing_grund(b, t, i, cluster):
    if b is None:
        return "kein Fencing-Beleg"
    if not isinstance(b, dict):
        return "Beleg unlesbar"
    if b.get("art") not in FENCING_ARTEN:
        return "Beleg ohne gültige Art"
    for f in ("resetS", "rejoinS"):
        v = b.get(f)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0:
            return "Beleg ohne Messwert " + f
    if not b.get("bootId") or not b.get("bootIdVorher") or b.get("bootId") == b.get("bootIdVorher"):
        return "Beleg ohne Reset (boot_id gleich)"
    if not isinstance(i, dict) or not i.get("konfHash"):
        return "Cluster-Identität nicht lesbar (corosync.conf/authkey)"
    if b.get("cluster") != cluster:
        return "Beleg für Cluster %s, erwartet %s" % (_w(b.get("cluster")), cluster)
    if b.get("cluster") != i.get("cluster"):
        return "Beleg für Cluster %s, eingerichtet ist %s" % (_w(b.get("cluster")), _w(i.get("cluster")))
    if b.get("knoten") != i.get("knoten") or b.get("nodeid") != i.get("nodeid"):
        return "Beleg für Knoten %s (nodeid %s), hier %s (nodeid %s)" % (_w(b.get("knoten")), _w(b.get("nodeid")), _w(i.get("knoten")), _w(i.get("nodeid")))
    if b.get("konfHash") != i.get("konfHash"):
        return "Cluster seit dem Beleg neu eingerichtet (corosync.conf/authkey anders)"
    if t is not None and not isinstance(t, dict):
        return "Test-Datei unlesbar"
    if isinstance(t, dict) and t.get("zeit") != b.get("testZeit"):
        return "neuerer Fencing-Test vom %s ohne Beleg" % _w(t.get("zeit"))
    return ""`;

/** python3-Werkzeug der Fencing-Bausteine: `python3 -c "$PY_FENCING" <befehl> …` (Befehle siehe unten; Fehler → Exit 1 mit Grund auf stdout) */
export const PY_FENCING = `${PY_FENCING_FUNK}
${String.raw`import sys
QUORUM = ${JSON.stringify(HA_COROSYNC_QUORUM_TEXT)}
BOOT_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
def iso(s):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(s))
def test_lesen(p, ich, cluster, i):
    t = lies_json(p)
    if not isinstance(t, dict):
        return None, "Test-Datei fehlt oder ist unlesbar"
    try:
        w = [t["art"], str(t["bootIdVorher"]), int(t["zeitS"]), int(t["ausloeseS"]), int(t.get("sperreS") or 0), str(t["zeit"])]
    except Exception:
        return None, "Test-Datei unvollständig"
    if w[0] not in FENCING_ARTEN or not BOOT_ID.match(w[1]) or not re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$", w[5]):
        return None, "Test-Datei mit ungültigen Werten"
    if t.get("knoten") != ich or t.get("cluster") != cluster:
        return None, "Test gehört zu %s/%s, nicht zu %s/%s" % (_w(t.get("knoten")), _w(t.get("cluster")), ich, cluster)
    if not isinstance(i, dict) or not i.get("konfHash") or t.get("konfHash") != i.get("konfHash"):
        return None, "Test vor einer Neueinrichtung des Clusters (corosync.conf/authkey anders)"
    return w, ""
a = sys.argv
c = a[1] if len(a) > 1 else ""
if c == "ident_ok":
    # conf key ich cluster → konfHash; sonst Grund + Exit 1
    i = fencing_ident(a[2], a[3], a[4])
    if not i:
        print("corosync.conf nicht lesbar")
        sys.exit(1)
    if i["cluster"] != a[5] or not i["nodeid"] or not i["konfHash"]:
        print("Cluster %s, nodeid %s, authkey %s" % (_w(i["cluster"]), _w(i["nodeid"]), "lesbar" if i["konfHash"] else "fehlt"))
        sys.exit(1)
    print(i["konfHash"])
elif c == "grund":
    # beleg test conf key ich cluster → leer = gültig
    print(fencing_grund(lies_json(a[2]), lies_json(a[3]), fencing_ident(a[4], a[5], a[6]), a[7]))
elif c == "beleg_art":
    b = lies_json(a[2])
    print(b.get("art", "") if isinstance(b, dict) else "")
elif c == "kompakt":
    print(json.dumps(lies_json(a[2])))
elif c == "test":
    # datei conf key ich cluster → „art bootIdVorher zeitS ausloeseS sperreS zeit“
    w, g = test_lesen(a[2], a[5], a[6], fencing_ident(a[3], a[4], a[5]))
    if w is None:
        print(g)
        sys.exit(1)
    print(*w)
elif c == "test_json":
    # art boot zeitS ausloeseS sperreS conf key ich sysrq panic
    i = fencing_ident(a[7], a[8], a[9]) or {}
    zs = int(a[4])
    print(json.dumps({"art": a[2], "bootIdVorher": a[3], "zeit": iso(zs), "zeitS": zs, "ausloeseS": int(a[5]), "sperreS": int(a[6]) or None, "knoten": a[9],
                      "cluster": i.get("cluster"), "nodeid": i.get("nodeid"), "konfHash": i.get("konfHash"), "sysrq": a[10], "kernelPanic": a[11]}))
elif c == "journal_letzt":
    # stdin: journalctl -b -1 -n 1 -o json → „<_BOOT_ID> <Sekunden>“
    l = None
    for z in sys.stdin:
        z = z.strip()
        if z:
            try:
                l = json.loads(z)
            except Exception:
                pass
    try:
        print(l["_BOOT_ID"], int(l["__REALTIME_TIMESTAMP"]) // 1000000)
    except Exception:
        sys.exit(1)
elif c == "rejoin":
    # btime; stdin: journalctl -b 0 -u corosync -o json → Sekunden vom Start bis zur ersten Quorum-Meldung
    bt = int(a[2])
    for z in sys.stdin:
        try:
            e = json.loads(z)
        except Exception:
            continue
        m = e.get("MESSAGE") if isinstance(e, dict) else None
        if isinstance(m, str) and QUORUM in m:
            print(max(0, int(round(int(e["__REALTIME_TIMESTAMP"]) / 1000000 - bt))))
            sys.exit(0)
    sys.exit(1)
elif c == "beleg_json":
    # test boot resetS rejoinS jetzt luecke conf key ich
    t = lies_json(a[2])
    i = fencing_ident(a[8], a[9], a[10]) or {}
    print(json.dumps({"art": t["art"], "zeit": iso(int(a[6])), "resetS": int(a[4]), "rejoinS": int(a[5]), "bootId": a[3], "bootIdVorher": t["bootIdVorher"],
                      "testZeit": t["zeit"], "cluster": i.get("cluster"), "knoten": i.get("knoten"), "nodeid": i.get("nodeid"), "konfHash": i.get("konfHash"),
                      "journalLueckeS": int(a[7]),
                      "quellen": {"resetS": "btime (/proc/stat) minus Auslösezeit (Test-Datei, systemd-run --on-active)", "rejoinS": "erste corosync-Meldung „" + QUORUM + "“ (journalctl -b 0 -u corosync) minus btime",
                                  "journalLueckeS": "btime minus letzter Eintrag des getesteten Starts (journalctl -b -1, _BOOT_ID = bootIdVorher)"}}))
else:
    sys.exit(3)`}`;

/** Gemeinsame Teile der Fencing-Bausteine — Pfade vor der Marke (Tests biegen sie um) */
const FENCING_PFADE = [
  `HA_DIR=${shQ(HA_FENCING_DIR)}`,
  `TEST_DATEI=${shQ(HA_FENCING_TEST_DATEI)}`,
  `BELEG_DATEI=${shQ(HA_FENCING_BELEG_DATEI)}`,
  'AUTHKEY=/etc/corosync/authkey',
  'BOOT_ID_DATEI=/proc/sys/kernel/random/boot_id',
  'SYSRQ_TRIGGER=/proc/sysrq-trigger',
  'SYSRQ_DATEI=/proc/sys/kernel/sysrq',
  'PANIC_DATEI=/proc/sys/kernel/panic',
  'KEXEC_CRASH=/sys/kernel/kexec_crash_loaded',
  'REGEL_DATEI=/run/alfred-fencetest.nft',
  'PROC=/proc',
];

const FENCING_HILFEN = sh(String.raw`fpy() { python3 -c "$PY_FENCING" "$@"; }
jetzt() { date +%s; }
boot_id() { cat "$BOOT_ID_DATEI" 2>/dev/null || true; }
# Startzeit des laufenden Kernels (Sekunden seit 1970)
boot_zeit() { awk '$1 == "btime" { print $2 }' "$PROC/stat" 2>/dev/null || true; }
# Stimmen, die corosync für das Quorum verlangt (corosync-quorumtool -s: „Quorum:           2“)
quorum_noetig() { corosync-quorumtool -s 2>/dev/null | awk -F: '/^Quorum:/ { gsub(/[ \t]/, "", $2); print $2 }' || true; }
fd_ziel() { readlink "$1" 2>/dev/null || true; }
prozess_name() { cat "$PROC/$1/comm" 2>/dev/null || true; }
prozess_exe() { readlink "$PROC/$1/exe" 2>/dev/null || true; }
# sbd (/usr/sbin/sbd) hält ein /dev/watchdog* offen = SBD hat den Hardware-Watchdog scharf geschaltet
sbd_haelt_wd() {
  local f z pid
  for f in "$PROC"/[0-9]*/fd/*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    z=$(fd_ziel "$f")
    case "$z" in /dev/watchdog|/dev/watchdog[0-9]*) ;; *) continue ;; esac
    pid=§{f#"$PROC"/}; pid=§{pid%%/*}
    if [ "$(prozess_name "$pid")" = sbd ] && [ "$(prozess_exe "$pid")" = /usr/sbin/sbd ]; then return 0; fi
  done
  return 1
}
# Datei nur für root (0600, Verzeichnis 0700), atomar ersetzt und mit sync auf die Platte — ein harter Reset darf sie nicht verlieren
schreibe_privat() { mkdir -p "$(dirname "$1")"; chmod 0700 "$(dirname "$1")"; (umask 077; printf '%s\n' "$2" >"$1.alfred-neu"); chmod 0600 "$1.alfred-neu"; mv -f "$1.alfred-neu" "$1"; sync; }`);

const FENCING_PRUEFEN_KOERPER = sh(String.raw`kennwort_lesen
# ── Phase 1: prüfen — bis hierhin wird nichts geändert ──
knoten_pruefen
case "$ART" in trennung|haenger) ;; *) abbruch "art '$ART': trennung oder haenger — nichts geändert" ;; esac
for c in pcs crm_mon crm_attribute corosync-quorumtool python3 systemd-run; do command -v "$c" >/dev/null 2>&1 || abbruch "$c fehlt auf $ICH — nichts geändert"; done
if [ "$ART" = trennung ]; then command -v nft >/dev/null 2>&1 || abbruch "nft fehlt auf $ICH — nichts geändert"; fi
if [ "$ART" = haenger ] && [ "$ICH" != "$HAENGER_KNOTEN" ]; then abbruch "haenger (Kernel-Absturz) nur auf $HAENGER_KNOTEN (Owner-Entscheidung 2), nicht auf $ICH — nichts geändert"; fi
KONF=''; if [ -f "$COROSYNC_CONF" ]; then KONF=$(cat "$COROSYNC_CONF"); fi
KA=$(konf_art "$KONF")
[ "$KA" = alfred ] || abbruch "auf $ICH ist $CLUSTER mit $KNOTEN_SOLL nicht eingerichtet (corosync.conf: §{KA#fremd:}) — vorher cluster_anlegen; nichts geändert"
KH=$(fpy ident_ok "$COROSYNC_CONF" "$AUTHKEY" "$ICH" "$CLUSTER") || abbruch "Cluster-Identität auf $ICH nicht lesbar ($KH) — nichts geändert"
BOOT=$(boot_id)
[[ "$BOOT" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || abbruch "boot_id nicht lesbar ('$BOOT') — nichts geändert"
JETZT=$(jetzt)
[[ "$JETZT" =~ ^[0-9]+$ ]] || abbruch "Uhrzeit nicht lesbar — nichts geändert"
# laufender oder schon erfolgter Test dieses Knotens (gleicher Cluster)
T_BOOT=''
if [ -f "$TEST_DATEI" ] && tz=$(fpy test "$TEST_DATEI" "$COROSYNC_CONF" "$AUTHKEY" "$ICH" "$CLUSTER"); then
  read -r T_ART T_BOOT T_ZEIT_S T_AUSL_S T_SPERRE T_ZEIT <<<"$tz"
  T_ALTER=$((JETZT - T_ZEIT_S))
  if [ "$T_BOOT" = "$BOOT" ] && [ "$T_ALTER" -le "$MAX_ALTER_S" ]; then abbruch "Fencing-Test ($T_ART) vom $T_ZEIT auf $ICH läuft noch — Reset ausstehend (boot_id unverändert); kein zweiter Test, nichts geändert"; fi
fi
# gültiger Beleg derselben Art → schon (eine Wiederholung des Schritts setzt den Knoten nicht noch einmal zurück)
G=$(fpy grund "$BELEG_DATEI" "$TEST_DATEI" "$COROSYNC_CONF" "$AUTHKEY" "$ICH" "$CLUSTER")
if [ -z "$G" ] && [ "$(fpy beleg_art "$BELEG_DATEI")" = "$ART" ]; then
  ergebnis "{\"zustand\":\"schon\",\"art\":\"$ART\",\"knoten\":\"$ICH\",\"cluster\":\"$CLUSTER\",\"beleg\":$(fpy kompakt "$BELEG_DATEI"),\"aenderungen\":[]}"
  exit 0
fi
# Test dieser Art ist schon erfolgt (Reset nach dem Test, noch kein Beleg) → schon, Beleg folgt mit fencing_belegen
if [ -n "$T_BOOT" ] && [ "$T_ART" = "$ART" ] && [ "$T_BOOT" != "$BOOT" ] && [ "$T_ALTER" -le "$MAX_ALTER_S" ]; then
  ergebnis "{\"zustand\":\"schon\",\"art\":\"$ART\",\"knoten\":\"$ICH\",\"cluster\":\"$CLUSTER\",\"test\":$(fpy kompakt "$TEST_DATEI"),\"hinweis\":\"Reset nach dem Test vom $T_ZEIT erfolgt — Beleg mit fencing_belegen\",\"aenderungen\":[]}"
  exit 0
fi
# Cluster: alle Knoten online mit Quorum, STONITH an, keine Ressourcen (Beweis vor dem AG-Aufbau), Rest behält ohne den Testknoten das Quorum
lage
{ [ "$LO" = "$ANZAHL" ] && [ "$LQ" = 1 ] && [ "$LN" = "$NAMEN_SOLL" ]; } || abbruch "Cluster: $LO/$ANZAHL online ($LN), Quorum $LQ — Fencing-Test nur, wenn alle Knoten online sind und Quorum besteht; nichts geändert"
[ "$LS" = 1 ] || abbruch "stonith-enabled ist nicht true — ohne STONITH kein Fencing-Test; nichts geändert"
[ "$LR" = 0 ] || abbruch "Cluster trägt $LR Ressourcen — Fencing-Beweis nur vor dem AG-Aufbau (ohne Ressourcen); nichts geändert"
st=$(stimmen); [ "$st" = "$ANZAHL/$ANZAHL" ] || abbruch "Quorum-Stimmen '$st', erwartet $ANZAHL/$ANZAHL — nichts geändert"
qn=$(quorum_noetig)
[[ "$qn" =~ ^[0-9]+$ ]] || abbruch "Quorum-Grenze nicht lesbar (corosync-quorumtool -s) — nichts geändert"
[ "$((ANZAHL - 1))" -ge "$qn" ] || abbruch "ohne $ICH blieben $((ANZAHL - 1)) Stimmen, das Quorum braucht $qn — der Rest des Clusters verlöre das Quorum; nichts geändert"
nq=$(eigenschaft no-quorum-policy); [ "$nq" != ignore ] || abbruch "no-quorum-policy=ignore — der getrennte Knoten setzte sich nicht zurück; nichts geändert"
hw=$(eigenschaft have-watchdog); [ "$hw" = true ] || abbruch "have-watchdog ist '§{hw:-nicht gesetzt}', erwartet true — nichts geändert"
swt=$(sekunden "$(eigenschaft stonith-watchdog-timeout)"); [ "$swt" = "$STONITH_T" ] || abbruch "stonith-watchdog-timeout ist '$swt', erwartet $STONITH_T — nichts geändert"
systemctl is-active --quiet sbd || abbruch "sbd läuft auf $ICH nicht — nichts geändert"
[ -e "$WD_DEV" ] || abbruch "$WD_DEV fehlt auf $ICH — nichts geändert"
wid=$(cat "$WD_SYS/watchdog0/identity" 2>/dev/null || true)
ist_esb "$wid" || abbruch "Watchdog auf $ICH stammt von '§{wid:-unbekannt}', erwartet i6300esb — kein softdog-Ersatz; nichts geändert"
sbd_haelt_wd || abbruch "sbd hält auf $ICH kein /dev/watchdog offen — Watchdog nicht scharf; nichts geändert"
SYSRQ=$(cat "$SYSRQ_DATEI" 2>/dev/null || echo '?'); PANIC=$(cat "$PANIC_DATEI" 2>/dev/null || echo '?')
if [ "$ART" = haenger ]; then
  # /proc/sysrq-trigger ist für root unabhängig von kernel.sysrq erlaubt (Kernel-Doku sysrq.rst) — nichts wird umgestellt
  [ -e "$SYSRQ_TRIGGER" ] || abbruch "$SYSRQ_TRIGGER fehlt (Kernel ohne MAGIC_SYSRQ) — nichts geändert"
  # nur der Hardware-Watchdog darf zurücksetzen: kein automatischer Neustart nach Panik, kein kdump-Kernel
  [ "$PANIC" = 0 ] || abbruch "kernel.panic ist '$PANIC' — der Kernel startete nach dem Absturz selbst neu, der Beweis gälte nicht dem Watchdog; nichts geändert"
  kx=$(cat "$KEXEC_CRASH" 2>/dev/null || echo 0); [ "$kx" = 0 ] || abbruch "kdump-Kernel geladen (kexec_crash_loaded=$kx) — er übernähme den Absturz statt des Watchdogs; nichts geändert"
fi
# ── Phase 2: pcs-Anmeldung nur bei Bedarf (für pcs stonith sbd status), SBD auf allen Knoten ──
if ! pcsd_online; then anmelden; aend pcs-anmeldung; fi
ss=$(sbd_status); n=$(sbd_zahl "$ss" 3)
[ "$n" = "$ANZAHL" ] || abbruch "SBD läuft auf $n/$ANZAHL Knoten: $(kurz "$ss") — kein Test; $(stand)"
sbd_soll || abbruch "SBD weicht ab: $SBD_ABW — kein Test; $(stand)"
# ── Test-Datei VOR dem Auslösen (0600, sync) — scheitert das Planen des Auslösers, wird sie wieder entfernt (sonst sperrte sie 30 min) ──
TEST_NEU=0; AUSL_GEPLANT=0
alfred_aufraeumen() { if [ "$TEST_NEU" = 1 ] && [ "$AUSL_GEPLANT" = 0 ]; then rm -f -- "$TEST_DATEI"; sync; fi; }
AUSL_S=$((JETZT + VERZ_S))
if [ "$ART" = trennung ]; then SP=$SPERRE_S; else SP=0; fi
TJ=$(fpy test_json "$ART" "$BOOT" "$JETZT" "$AUSL_S" "$SP" "$COROSYNC_CONF" "$AUTHKEY" "$ICH" "$SYSRQ" "$PANIC")
TEST_NEU=1
schreibe_privat "$TEST_DATEI" "$TJ"
aend fencing-test-datei
{ [ "$(cat "$TEST_DATEI")" = "$TJ" ] && fpy test "$TEST_DATEI" "$COROSYNC_CONF" "$AUTHKEY" "$ICH" "$CLUSTER" >/dev/null; } || abbruch "Test-Datei $TEST_DATEI nach dem Schreiben nicht lesbar — nichts ausgelöst, Test-Datei entfernt"
# ── Auslösen: entkoppelt per systemd-run (AccuracySec=1s — Standard wäre 1 min), der SSH-Aufruf kehrt vorher zurück ──
EINHEIT="alfred-fencetest-$JETZT"
if [ "$ART" = trennung ]; then
  printf '%s\n' "$NFT_TEST" >"$REGEL_DATEI"
  aus=$(nft -c -f "$REGEL_DATEI" 2>&1) || abbruch "nft lehnt die Test-Regel ab: $(kurz "$aus") — nichts ausgelöst, Test-Datei entfernt"
  # zuerst das Aufheben planen: die Sperre endet nach $SPERRE_S s auch dann, wenn SBD den Knoten nicht zurücksetzt
  aus=$(systemd-run --unit="$EINHEIT-ende" --on-active="$((VERZ_S + SPERRE_S))" --timer-property=AccuracySec=1s nft delete table inet "$TEST_TABELLE" 2>&1) || abbruch "Aufheben der Sperre nicht planbar: $(kurz "$aus") — nichts ausgelöst, Test-Datei entfernt"
  aend aufheben-geplant
  aus=$(systemd-run --unit="$EINHEIT" --on-active="$VERZ_S" --timer-property=AccuracySec=1s nft -f "$REGEL_DATEI" 2>&1) || abbruch "Auslöser nicht planbar: $(kurz "$aus") — nichts ausgelöst, Test-Datei entfernt (der Aufheben-Timer läuft ins Leere)"
  AUSL_GEPLANT=1
  aend ausloeser-geplant
else
  aus=$(systemd-run --unit="$EINHEIT" --on-active="$VERZ_S" --timer-property=AccuracySec=1s /bin/sh -c "sync; echo c > $SYSRQ_TRIGGER" 2>&1) || abbruch "Auslöser nicht planbar: $(kurz "$aus") — nichts ausgelöst, Test-Datei entfernt"
  AUSL_GEPLANT=1
  aend ausloeser-geplant
fi
# ── Selbstprüfung: Timer geplant ──
systemctl is-active --quiet "$EINHEIT.timer" || abbruch "Selbstprüfung: Auslöser $EINHEIT.timer nicht aktiv"
if [ "$ART" = trennung ]; then systemctl is-active --quiet "$EINHEIT-ende.timer" || abbruch "Selbstprüfung: Aufheben $EINHEIT-ende.timer nicht aktiv"; fi
ergebnis "{\"zustand\":\"ausgeloest\",\"art\":\"$ART\",\"knoten\":\"$ICH\",\"cluster\":\"$CLUSTER\",\"bootIdVorher\":\"$BOOT\",\"ausloesungInS\":$VERZ_S,\"sperreS\":$SP,\"einheit\":\"$EINHEIT\",\"test\":$TJ,\"aenderungen\":[$AJ]}"`);

const FENCING_BELEGEN_KOERPER = sh(String.raw`# ── Phase 1: prüfen — ohne Beweis kein Beleg ──
knoten_pruefen
for c in crm_mon python3 journalctl; do command -v "$c" >/dev/null 2>&1 || abbruch "$c fehlt auf $ICH — kein Beleg"; done
KONF=''; if [ -f "$COROSYNC_CONF" ]; then KONF=$(cat "$COROSYNC_CONF"); fi
KA=$(konf_art "$KONF")
[ "$KA" = alfred ] || abbruch "auf $ICH ist $CLUSTER mit $KNOTEN_SOLL nicht eingerichtet (corosync.conf: §{KA#fremd:}) — kein Beleg"
[ -f "$TEST_DATEI" ] || abbruch "kein Fencing-Test auf $ICH ($TEST_DATEI fehlt) — vorher fencing_pruefen; kein Beleg"
tz=$(fpy test "$TEST_DATEI" "$COROSYNC_CONF" "$AUTHKEY" "$ICH" "$CLUSTER") || abbruch "Fencing-Test nicht verwendbar: $tz — kein Beleg"
read -r T_ART T_BOOT T_ZEIT_S T_AUSL_S T_SPERRE T_ZEIT <<<"$tz"
# gültiger Beleg genau zu diesem Test → schon
G=$(fpy grund "$BELEG_DATEI" "$TEST_DATEI" "$COROSYNC_CONF" "$AUTHKEY" "$ICH" "$CLUSTER")
if [ -z "$G" ]; then
  ergebnis "{\"zustand\":\"schon\",\"knoten\":\"$ICH\",\"cluster\":\"$CLUSTER\",\"beleg\":$(fpy kompakt "$BELEG_DATEI"),\"aenderungen\":[]}"
  exit 0
fi
BOOT=$(boot_id)
[[ "$BOOT" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || abbruch "boot_id nicht lesbar ('$BOOT') — kein Beleg"
[ "$BOOT" != "$T_BOOT" ] || abbruch "kein Reset seit dem Fencing-Test ($T_ART) vom $T_ZEIT — boot_id unverändert ($BOOT); kein Beleg"
JETZT=$(jetzt)
[[ "$JETZT" =~ ^[0-9]+$ ]] || abbruch "Uhrzeit nicht lesbar — kein Beleg"
A=$((JETZT - T_ZEIT_S))
{ [ "$A" -ge 0 ] && [ "$A" -le "$MAX_ALTER_S" ]; } || abbruch "Fencing-Test vom $T_ZEIT ist $A s alt (höchstens $MAX_ALTER_S s) — Test wiederholen; kein Beleg"
BT=$(boot_zeit)
[[ "$BT" =~ ^[0-9]+$ ]] || abbruch "Startzeit (btime) nicht lesbar — kein Beleg"
[ "$BT" -ge "$T_AUSL_S" ] || abbruch "Neustart (btime $BT) vor dem Auslösezeitpunkt ($T_AUSL_S) — nicht dem Test zuzuordnen; kein Beleg"
RESET_S=$((BT - T_AUSL_S))
[ "$RESET_S" -le "$RESET_MAX_S" ] || abbruch "Reset erst $RESET_S s nach der Auslösung (höchstens $RESET_MAX_S s) — nicht dem Test zuzuordnen; kein Beleg"
# der vorherige Start im Journal ist genau der getestete (kein weiterer Neustart dazwischen)
jv=$(journalctl -b -1 -n 1 -o json --no-pager 2>/dev/null | fpy journal_letzt) || abbruch "Journal des vorherigen Starts nicht lesbar (journalctl -b -1; persistentes Journal nötig) — kein Beleg"
read -r J_BOOT J_LETZT_S <<<"$jv"
[ "$J_BOOT" = "§{T_BOOT//-/}" ] || abbruch "vorheriger Start im Journal ist $J_BOOT, getestet wurde §{T_BOOT//-/} — dazwischen lag ein weiterer Neustart; kein Beleg"
LUECKE=$((BT - J_LETZT_S))
# ── Cluster: der Knoten ist wieder online (bis WARTE_RUNDEN × 2 s), SBD läuft und hält den Watchdog ──
ok=0
for i in $(seq 1 "$WARTE_RUNDEN"); do lage; if [ "$LQ" = 1 ] && [[ ",$LN," == *",$ICH,"* ]]; then ok=1; break; fi; sleep 2; done
[ "$ok" = 1 ] || abbruch "$ICH ist nach dem Reset nicht online im Cluster (online: $LN, Quorum $LQ) — kein Beleg"
systemctl is-active --quiet sbd || abbruch "sbd läuft auf $ICH nach dem Reset nicht — kein Beleg"
sbd_haelt_wd || abbruch "sbd hält auf $ICH nach dem Reset kein /dev/watchdog offen — kein Beleg"
RJ=$(journalctl -b 0 -u corosync -o json --no-pager 2>/dev/null | fpy rejoin "$BT") || abbruch "Rejoin-Zeitpunkt nicht im Journal (corosync seit dem Start ohne „$QUORUM_TEXT“) — kein Beleg"
# ── Beleg schreiben (0600, sync) und selbst prüfen ──
BJ=$(fpy beleg_json "$TEST_DATEI" "$BOOT" "$RESET_S" "$RJ" "$JETZT" "$LUECKE" "$COROSYNC_CONF" "$AUTHKEY" "$ICH") || abbruch "Beleg nicht erzeugbar — kein Beleg"
schreibe_privat "$BELEG_DATEI" "$BJ"
aend fencing-beleg
G=$(fpy grund "$BELEG_DATEI" "$TEST_DATEI" "$COROSYNC_CONF" "$AUTHKEY" "$ICH" "$CLUSTER")
[ -z "$G" ] || abbruch "Selbstprüfung: geschriebener Beleg ist nicht gültig: $G"
ergebnis "{\"zustand\":\"geaendert\",\"knoten\":\"$ICH\",\"cluster\":\"$CLUSTER\",\"beleg\":$BJ,\"aenderungen\":[$AJ]}"`);

function fencingKopf(baustein: string, p: Record<string, unknown>, knoten: readonly HaKnoten[], cluster: string): string[] {
  return [
    ...clusterKopf(baustein, p, knoten, cluster),
    `SBD_T=${HA_SBD_TIMEOUT_S}`,
    `STONITH_T=${HA_STONITH_WD_TIMEOUT_S}`,
    `VERZ_S=${HA_FENCING_VERZOEGERUNG_S}`,
    `SPERRE_S=${HA_FENCING_SPERRE_S}`,
    `MAX_ALTER_S=${HA_FENCING_MAX_ALTER_S}`,
    `RESET_MAX_S=${HA_FENCING_RESET_MAX_S}`,
    `HAENGER_KNOTEN=${shQ(HA_FENCING_HAENGER_KNOTEN)}`,
    `TEST_TABELLE=${shQ(HA_FENCETEST_TABELLE)}`,
    `QUORUM_TEXT=${shQ(HA_COROSYNC_QUORUM_TEXT)}`,
    `NFT_TEST=${shQ(fencetestNft())}`,
    `PY_FENCING=${shQ(PY_FENCING)}`,
    ...FENCING_PFADE,
    FENCING_HILFEN,
  ];
}

/**
 * Fencing-Beweis Teil 1, auf dem Testknoten (zugang): prüft ohne Änderung (Cluster 3/3 online mit Quorum, STONITH an, keine Ressourcen,
 * Rest behält das Quorum, no-quorum-policy ≠ ignore, have-watchdog, stonith-watchdog-timeout, sbd hält den i6300esb; haenger zusätzlich:
 * nur sqllnxcfg, kernel.panic = 0, kein kdump), SBD 3/3 über pcs, schreibt dann `fencing-test.json` {art, bootIdVorher, zeit, …} (0600,
 * sync) und plant den Auslöser per systemd-run in 3 s: trennung = nft-Tabelle inet alfred_fencetest (UDP 5405 beide Richtungen, ohne
 * Persistenz) mit Aufheben-Timer nach 120 s; haenger = sysrq c. Ergebnis `ausgeloest` vor dem Reset; `schon`, wenn ein gültiger Beleg
 * derselben Art vorliegt oder der Reset nach einem Test dieser Art schon erfolgt ist. Kein Rückweg (der Knoten setzt sich selbst zurück).
 */
export function haFencingPruefenSkript(p: HaFencingParameter): string {
  pruefe(pruefeHaFencing(p));
  return [
    ...fencingKopf(LINUX_HA_BAUSTEINE.fencingPruefen, { cluster: p.cluster, knoten: p.knoten.map(x => ({ name: x.name, ip: x.ip })), art: p.art }, p.knoten, p.cluster),
    `ART=${shQ(p.art)}`,
    '# ALFRED-ABLAUF',
    FENCING_PRUEFEN_KOERPER,
  ].join('\n');
}

/**
 * Fencing-Beweis Teil 2, nach dem Reset auf demselben Knoten: Beleg nur mit Beweis — boot_id ≠ bootIdVorher, Test ≤ 30 min alt, Neustart
 * nach der Auslösung und höchstens 120 s danach, vorheriger Start im Journal = getesteter Start, Knoten wieder online mit Quorum, sbd läuft
 * und hält den Watchdog. Reset = btime − Auslösezeit, Rejoin = erste corosync-Quorum-Meldung − btime. Schreibt `fencing-beleg.json`
 * (0600, sync) mit Clustername, nodeid und konfHash (Identität); gültiger Beleg zu diesem Test → `schon`.
 */
export function haFencingBelegenSkript(p: HaFencingBelegenParameter): string {
  pruefe(pruefeHaFencingBelegen(p));
  return [
    ...fencingKopf(LINUX_HA_BAUSTEINE.fencingBelegen, { cluster: p.cluster, knoten: p.knoten.map(x => ({ name: x.name, ip: x.ip })) }, p.knoten, p.cluster),
    '# ALFRED-ABLAUF',
    FENCING_BELEGEN_KOERPER,
  ].join('\n');
}

// ── Fencing-Beleg: Gültigkeit (rein, für Status und den AG-Aufbau in Task 5) ──────────────────────────────────────────────────

export interface FencingIdentitaet { cluster: string | null; knoten: string | null; nodeid: string | null; konfHash: string | null }
export interface FencingTest {
  art: HaFencingArt; bootIdVorher: string; zeit: string; zeitS: number; ausloeseS: number; sperreS: number | null; knoten: string; cluster: string | null;
  nodeid?: string | null; konfHash?: string | null; sysrq?: string; kernelPanic?: string;
}
export interface FencingBeleg {
  art: HaFencingArt; zeit: string; resetS: number; rejoinS: number; bootId: string; bootIdVorher: string; testZeit: string;
  cluster: string | null; knoten: string | null; nodeid: string | null; konfHash: string | null; journalLueckeS?: number; quellen?: Record<string, string>;
}
/** Fencing-Teil des Status eines Knotens (PY_HA_STATUS → r.fencing); Datei fehlt → null, unlesbar → 'unlesbar' */
export interface FencingLage {
  bootId?: string | null; jetztS?: number;
  identitaet?: FencingIdentitaet | null;
  test?: FencingTest | 'unlesbar' | null;
  beleg?: FencingBeleg | 'unlesbar' | null;
}

const w = (v: unknown) => (v === null || v === undefined ? '?' : String(v));

/**
 * Ist der Fencing-Beleg für die heutige Cluster-Identität des Knotens gültig? undefined = gültig, sonst der Grund (gleicher Wortlaut wie
 * `fencing_grund` in PY_FENCING_FUNK, das die Bausteine verwenden). Gültig nur mit Art, Messwerten, Reset (boot_id ≠ bootIdVorher), Cluster
 * sqllnxcl01 = eingerichteter Cluster, gleicher Knoten und nodeid, gleichem konfHash (corosync.conf + authkey — ein neu eingerichteter
 * Cluster macht ihn ungültig) und ohne neueren, unbelegten Test. Task 5 (AG-Aufbau) verlangt das für alle drei Knoten.
 */
export function fencingBelegGueltig(beleg: FencingBeleg | 'unlesbar' | null | undefined, lage: FencingLage | null | undefined, cluster: string = HA_CLUSTER_NAME): string | undefined {
  const b = beleg as unknown;
  if (b === null || b === undefined) return 'kein Fencing-Beleg';
  if (typeof b !== 'object' || Array.isArray(b)) return 'Beleg unlesbar';
  const x = b as Record<string, unknown>;
  if (!HA_FENCING_ARTEN.includes(x.art as HaFencingArt)) return 'Beleg ohne gültige Art';
  for (const f of ['resetS', 'rejoinS']) { const v = x[f]; if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return `Beleg ohne Messwert ${f}`; }
  if (!x.bootId || !x.bootIdVorher || x.bootId === x.bootIdVorher) return 'Beleg ohne Reset (boot_id gleich)';
  const i = lage?.identitaet;
  if (!i || typeof i !== 'object' || !i.konfHash) return 'Cluster-Identität nicht lesbar (corosync.conf/authkey)';
  // wie Python: fehlend und null sind gleich (None)
  const g = (a: unknown, b2: unknown) => (a ?? null) === (b2 ?? null);
  if (!g(x.cluster, cluster)) return `Beleg für Cluster ${w(x.cluster)}, erwartet ${cluster}`;
  if (!g(x.cluster, i.cluster)) return `Beleg für Cluster ${w(x.cluster)}, eingerichtet ist ${w(i.cluster)}`;
  if (!g(x.knoten, i.knoten) || !g(x.nodeid, i.nodeid)) return `Beleg für Knoten ${w(x.knoten)} (nodeid ${w(x.nodeid)}), hier ${w(i.knoten)} (nodeid ${w(i.nodeid)})`;
  if (!g(x.konfHash, i.konfHash)) return 'Cluster seit dem Beleg neu eingerichtet (corosync.conf/authkey anders)';
  const t = lage?.test as unknown;
  if (t !== null && t !== undefined && (typeof t !== 'object' || Array.isArray(t))) return 'Test-Datei unlesbar';
  if (t && !g((t as Record<string, unknown>).zeit, x.testZeit)) return `neuerer Fencing-Test vom ${w((t as Record<string, unknown>).zeit)} ohne Beleg`;
  return undefined;
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
  // Task 3: Cluster — corosync.conf (Name, Knoten), crm_mon-XML, SBD je Knoten (pcs stonith sbd status), stonith-watchdog-timeout
  PY_CLUSTER_FUNK,
  String.raw`cl = {}
kt = lies("/etc/corosync/corosync.conf")
if not kt:
    cl["art"] = "keiner"
else:
    nm, kn = konf(kt)
    if nm == "debian" and all((x["ip"] or "").startswith("127.") for x in kn):
        cl["art"] = "debian"
    else:
        cl.update({"art": "eingerichtet", "name": nm, "knoten": kn, "crm": None, "sbd": None})
        c, x = lauf("crm_mon", "-1", "--output-as=xml")
        if c == 0:
            try:
                cl["crm"] = crm_lage(x)
            except Exception:
                cl["crm"] = None
        c, t = lauf("pcs", "stonith", "sbd", "status")
        if c == 0:
            cl["sbd"] = sbd_lesen(t)
        c, v = lauf("crm_attribute", "-t", "crm_config", "-n", "stonith-watchdog-timeout", "-G", "-q")
        cl["stonithWatchdogTimeout"] = v if c == 0 and v else None
r["cluster"] = cl`,
  // Task 4: Fencing-Beweis dieses Knotens — Test, Beleg, boot_id und Identität im Cluster; die Gültigkeit prüft fencingBelegGueltig (TS)
  PY_FENCING_FUNK,
  `r["fencing"] = {"bootId": lies("/proc/sys/kernel/random/boot_id"), "jetztS": int(time.time()), "test": lies_json(${JSON.stringify(HA_FENCING_TEST_DATEI)}), "beleg": lies_json(${JSON.stringify(HA_FENCING_BELEG_DATEI)}), "identitaet": fencing_ident("/etc/corosync/corosync.conf", "/etc/corosync/authkey", ich)}`,
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
registriereLinuxBaustein<HaClusterParameter>(LINUX_HA_BAUSTEINE.cluster, haClusterSkript);
registriereLinuxBaustein<HaClusterEntfernenParameter>(LINUX_HA_BAUSTEINE.clusterEntfernen, haClusterEntfernenSkript);
registriereLinuxBaustein<HaFencingParameter>(LINUX_HA_BAUSTEINE.fencingPruefen, haFencingPruefenSkript);
registriereLinuxBaustein<HaFencingBelegenParameter>(LINUX_HA_BAUSTEINE.fencingBelegen, haFencingBelegenSkript);
