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
import { sqlKopf, shQ, SQL_HILFE, PY_SQL_ZIEL } from './linux-sql.js';

// ── Feste Werte ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface HaKnoten { name: string; ip: string }
export type HaRolle = 'daten' | 'konfig';
export interface HaVersionen { pacemaker: string; pacemakerCli: string; corosync: string; pcs: string; sbd: string; resourceAgents: string; mssqlHa: string }

/** gelesen auf sqllnx01 (Ubuntu 24.04, apt-cache madison, 17.11.2026); mssql-server-ha = installierte mssql-server-Version (CU1) */
export const HA_VERSIONEN: Readonly<HaVersionen> = {
  // Live-Fix (Change 710116b4): crm_mon, crm_attribute, cibadmin, stonith_admin … liegen auf Ubuntu 24.04 in pacemaker-cli-utils
  // (mit --no-install-recommends nicht mitinstalliert) — gleiche Version wie pacemaker
  pacemaker: '2.1.6-5ubuntu2', pacemakerCli: '2.1.6-5ubuntu2', corosync: '3.1.7-1ubuntu3.2', pcs: '0.11.7-1ubuntu1.1', sbd: '1.5.2-2ubuntu2',
  resourceAgents: '1:4.13.0-1ubuntu4.2', mssqlHa: '17.0.4006.2-1',
};
/** Paketnamen zu HaVersionen (Reihenfolge = Installationsliste) */
export const HA_PAKETE: ReadonlyArray<[keyof HaVersionen, string]> = [
  ['pacemaker', 'pacemaker'], ['pacemakerCli', 'pacemaker-cli-utils'], ['corosync', 'corosync'], ['pcs', 'pcs'], ['sbd', 'sbd'], ['resourceAgents', 'resource-agents-base'], ['mssqlHa', 'mssql-server-ha'],
];
/**
 * Live-Fix — jedes Programm außerhalb des Grundsystems, das ein linux_ha-Baustein aufruft (Skripte und eingebettete Python-Programme).
 * ha_vorbereiten prüft nach der Installation, dass alle da sind; der Test liest die erzeugten Skripte und verlangt Vollständigkeit.
 */
export const HA_BEFEHLE: readonly string[] = [
  'pcs', 'crm_mon', 'crm_attribute', 'corosync-quorumtool', 'corosync-cmapctl', 'sbd', 'nft', 'systemd-run', 'journalctl',
  'chpasswd', 'modprobe', 'udevadm', 'getent', 'ss', 'timeout', 'python3', 'apt-get', 'apt-cache', 'apt-mark', 'dpkg-query', '/opt/mssql/bin/mssql-conf',
  // Task 5 (Verfügbarkeitsgruppe): Ressourcen-Parameter und Constraints lesen (pacemaker-cli-utils, von ha_vorbereiten installiert)
  'crm_resource', 'cibadmin',
];
/**
 * Task 5 — Programme nur der AG-Bausteine, die NICHT ha_vorbereiten installiert: sqlcmd (mssql-tools18, von linux_sql installieren auf
 * jedem Knoten, auch sqllnxcfg). Geprüft nur in den ag_*-Bausteinen vor der ersten SQL-Zeile — ha_vorbereiten bleibt davon unabhängig.
 */
export const HA_AG_BEFEHLE: readonly string[] = ['/opt/mssql-tools18/bin/sqlcmd'];
/** Zugangsdatei des Resource-Agents ocf:mssql:ag (Zeile 1 Login, Zeile 2 Kennwort), 0600 root */
export const HA_PACEMAKER_DATEI = '/var/opt/mssql/secrets/passwd';
/** Task 5 — Pacemaker-Ressourcen der AG (promotable Klon wie von ag_anlegen angelegt); Task 6: hier oben, weil PY_HA_STATUS sie liest */
export const HA_AG_RESSOURCE = 'ag_cluster';
export const HA_AG_KLON = `${HA_AG_RESSOURCE}-clone`;
export const HA_AG_VIP_RESSOURCE = 'ag_vip';
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
/**
 * Ruling R10 (I8e Etappe 3, L1-Fakten 19.11.2026): `hostname -f` lieferte auf sqllnx01/02 nur den Kurznamen, weil der Block nur
 * „<ip> <name>“ enthielt. Jede Zeile lautet jetzt „<ip> <name>.<HA_DOMAENE> <name>“ — FQDN zuerst (kanonischer Name), Kurzname als Alias.
 * Hostnamen, Corosync-/Pacemaker-Knotennamen und AG-Replikanamen bleiben kurz. Gleich LINUX_AD.domaene (linux-sql-ad.ts, Test prüft das).
 */
export const HA_DOMAENE = 'ad.3033.at';
/** Fix-Runde 1: Loopback-Zeilen mit dem eigenen Namen (cloud-init „127.0.1.1 <fqdn> <hostname>“) — Original bleibt als Kommentar erhalten */
export const HA_HOSTS_ENTFERNT = '# ALFRED-HA ENTFERNT (Loopback mit eigenem Namen):';
export const HA_MODPROBE_DATEI = '/etc/modprobe.d/alfred-watchdog.conf';
/**
 * Frühere Datei (bis Live-Fix 2 zu c2e4f56d): i6300esb über modules-load.d — wirkungslos, weil Ubuntu Watchdog-Treiber sperrt (blacklist in
 * /lib/modprobe.d/blacklist_linux_*.conf) und systemd-modules-load die Sperre auch für ausdrücklich genannte Module anwendet
 * („Module 'i6300esb' is deny-listed (by kmod)“). ha_vorbereiten entfernt sie; geladen wird das Modul vom Warteskript.
 */
export const HA_MODULES_LOAD_DATEI = '/etc/modules-load.d/alfred-watchdog.conf';
export const HA_SYSTEMD_DATEI = '/etc/systemd/system.conf.d/alfred-watchdog.conf';
/**
 * Live-Fix (Change c2e4f56d, sqllnxcfg nach dem Fencing-Reset): sbd.service scheiterte nach dem Neustart, weil /dev/watchdog fehlte — Ursache
 * (zweiter Reset, 16:20:27): systemd-modules-load lädt i6300esb nicht („deny-listed (by kmod)“). Drop-in: sbd startet erst nach dem
 * Warteskript; das lädt i6300esb ausdrücklich per modprobe (ohne -b wendet modprobe die blacklist-Einträge nicht auf ausdrücklich genannte
 * Module an — modprobe(8) zu --use-blacklist, modprobe.d(5) zu blacklist: nur Aliase) und wartet ≤ 60 s auf das Gerät aus /etc/default/sbd.
 * Ubuntus Sperrdateien bleiben unberührt.
 */
export const HA_SBD_DROPIN = '/etc/systemd/system/sbd.service.d/alfred-watchdog.conf';
export const HA_WARTE_WATCHDOG = '/usr/local/lib/alfred/warte-watchdog';
export const HA_WARTE_WATCHDOG_S = 60;
/** sbd.service muss mindestens so lange starten dürfen (TimeoutStartUSec): Wartezeit + 15 s Spielraum — systemd-Standard ist 90 s */
export const HA_SBD_START_MIN_S = HA_WARTE_WATCHDOG_S + 15;
/** sbd-Meldung, wenn das Watchdog-Gerät beim Start fehlt (sbd 1.5, watchdog_init_fd) — nur dann repariert ha_vorbereiten selbst */
export const HA_SBD_WATCHDOG_FEHLT = "isn't a valid watchdog-device";
/**
 * /bin/sh-Skript (fest): lädt i6300esb ausdrücklich (falls das Gerät fehlt) und wartet bis HA_WARTE_WATCHDOG_S s auf das Gerät aus
 * SBD_WATCHDOG_DEV. Nur für Tests: $1 = Konfiguration, $2 = Sekunden, $3 = modprobe-Programm.
 */
export const WARTE_WATCHDOG_SKRIPT = [
  '#!/bin/sh',
  '# Alfred I8e Paket 2 (fest erzeugt, nicht von Hand ändern): sbd startet erst, wenn das Watchdog-Gerät da ist',
  '# i6300esb steht auf Ubuntus Sperrliste (modules-load.d lädt es nicht); modprobe mit ausdrücklichem Namen lädt es trotzdem',
  'KONF=${1:-/etc/default/sbd}',
  `GRENZE=\${2:-${HA_WARTE_WATCHDOG_S}}`,
  'MODPROBE=${3:-/usr/sbin/modprobe}',
  // letzter Eintrag gilt; Anführungszeichen (" und ') und Leerraum entfernt
  'GERAET=$(awk -F= \'/^[[:space:]]*SBD_WATCHDOG_DEV[[:space:]]*=/ { v = $2; gsub(/[[:space:]"\\047]/, "", v); d = v } END { print d }\' "$KONF" 2>/dev/null)',
  '[ -n "$GERAET" ] || GERAET=/dev/watchdog',
  'if [ ! -c "$GERAET" ] && ! "$MODPROBE" i6300esb; then',
  '  echo "alfred: Watchdog-Gerät $GERAET fehlt und modprobe i6300esb ist fehlgeschlagen — sbd startet nicht" >&2',
  '  exit 1',
  'fi',
  'i=0',
  'while [ "$i" -lt "$GRENZE" ]; do',
  '  if [ -c "$GERAET" ]; then exit 0; fi',
  '  i=$((i + 1))',
  '  sleep 1',
  'done',
  'echo "alfred: Watchdog-Gerät $GERAET nach $GRENZE s nicht vorhanden — sbd startet nicht" >&2',
  'exit 1',
].join('\n');
export const SBD_DROPIN_INHALT = [
  '# Alfred I8e Paket 2 (fest erzeugt, nicht von Hand ändern): sbd erst, wenn das Warteskript i6300esb geladen hat und das Gerät da ist',
  '[Unit]',
  'Wants=systemd-modules-load.service',
  'After=systemd-modules-load.service',
  '',
  '[Service]',
  `ExecStartPre=${HA_WARTE_WATCHDOG}`,
].join('\n');
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
/** Auslösung so viele Sekunden nach dem Schreiben der Test-Datei (SSH-Aufruf kehrt vorher sauber zurück; Fix-Runde 1: 3 → 10) */
export const HA_FENCING_VERZOEGERUNG_S = 10;
/**
 * Fix-Runde 1 — fester Corosync-Token (ms), wenn corosync-cmapctl ihn nicht liefert: kleinster sinnvoller Wert (1 s), damit die Untergrenze
 * resetS ≥ Token + SBD_WATCHDOG_TIMEOUT einen echten Beweis nie fälschlich verwirft (pcs/corosync-3-Standard liegt bei 3000 ms und mehr)
 */
export const HA_COROSYNC_TOKEN_MS_FEST = 1000;
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
  agEndpunkt: 'ha.ag_endpunkt', agReplikat: 'ha.ag_replikat', agAbschluss: 'ha.ag_abschluss', agEntfernen: 'ha.ag_entfernen',
  agFailover: 'ha.ag_failover',
} as const;
/** Zeitgrenzen für `linuxSkript(…, timeoutMs, …)` — am Host läuft das Skript bis timeoutMs − 20 s */
export const LINUX_HA_ZEIT_MS = {
  vorbereiten: 1_500_000, status: 90_000, cluster: 900_000, clusterEntfernen: 600_000, fencingPruefen: 180_000, fencingBelegen: 300_000,
  // Task 5: Endpunkt je Knoten, Replikat je Knoten (Zertifikate, AG anlegen/beitreten), Abschluss auf dem Primär (Datenbanken, Seeding,
  // Pacemaker-Ressourcen), Entfernen je Knoten
  agEndpunkt: 180_000, agReplikat: 240_000, agAbschluss: 900_000, agEntfernen: 300_000,
  // Task 6: Prüfen, pcs resource move, Warten auf Primär/VIP/Gegenstelle (je bis 120 s), pcs resource clear, Selbstprüfung
  agFailover: 600_000,
} as const;

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
  return [HA_HOSTS_ANFANG, ...knoten.map(k => `${k.ip} ${k.name}.${HA_DOMAENE} ${k.name}`), HA_HOSTS_ENDE].join('\n');
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
 * Final-Review I-1 (wie R8 bei der AG): Hülle um `abbruch` aus sqlKopf — ein Abbruch nach einer gemeldeten Änderung (aend → GEAENDERT/AJ)
 * hängt „ — bisher geändert: <AJ>“ an; der Skill gibt den Fehler dann mit Daten zurück (teilweise → Rückweg). `ausnahme` ist eine
 * zusätzliche Bedingung, unter der die Liste entfällt (Cluster: nur die pcs-Anmeldung erneuert — das sagt der Text schon über stand()).
 * Gleiche Technik wie der Failover-Baustein (dort mit der Freigabe der Standort-Bedingung).
 * Ruling R12: ein ändernder Befehl kann scheitern, nachdem er schon etwas geändert hat (pcs cluster setup schreibt corosync.conf auf
 * einzelne Knoten, pcs cluster stop --all stoppt einen Teil). Darum steht vor jedem solchen Befehl `versuch <name>`: scheitert er,
 * nennt der Abbruch „<name>-versucht“ in „bisher geändert“ (→ Daten → teilweise → Rückweg). Das folgende `aend` leert die Marke,
 * die Erfolgsausgabe bleibt unverändert. Die Ausnahme (nur pcs-Anmeldung) gilt nur für die Liste ohne offenen Versuch.
 */
const abbruchMitAenderungen = (ausnahme = '') => sh(String.raw`VERSUCHT=''
versuch() { VERSUCHT=$1; }
eval "$(declare -f aend | sed '1s/^aend /aend_basis /')"
aend() { VERSUCHT=''; aend_basis "$1"; }
eval "$(declare -f abbruch | sed '1s/^abbruch /abbruch_basis /')"
abbruch() {
  local l; l=$(printf '%s' "$AJ" | tr -d '"')
  if [ -n "$VERSUCHT" ]; then l+="§{l:+,}$VERSUCHT-versucht"; fi
  if { [ "$GEAENDERT" = 1 ]${ausnahme}; } || [ -n "$VERSUCHT" ]; then set -- "$1 — bisher geändert: $l"; fi
  abbruch_basis "$1"
}`);

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
  `SBD_DROPIN=${shQ(HA_SBD_DROPIN)}`,
  `WARTE_DATEI=${shQ(HA_WARTE_WATCHDOG)}`,
  'SBD_KONF=/etc/default/sbd',
  'WARTE_RUNDEN=60',
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
eigener_fqdn() { hostname -f; }
befehl_da() { command -v "$1" >/dev/null 2>&1; }
ist_ausfuehrbar() { [ -x "$1" ]; }
rechte_setzen() { chmod 0755 "$1"; }
# systemd-Zeitspanne („1min 30s“, „90s“, „infinity“) → ganze Sekunden; unbekannt → -1
zeitspanne_s() { awk '{ if ($0 == "infinity") { print 999999; exit } t = 0; for (i = 1; i <= NF; i++) { if (!match($i, /^[0-9.]+/)) { print -1; exit } n = substr($i, 1, RLENGTH) + 0; u = substr($i, RLENGTH + 1); if (u == "h") t += n * 3600; else if (u == "min") t += n * 60; else if (u == "s") t += n; else if (u == "ms") t += n / 1000; else if (u == "us") t += n / 1000000; else { print -1; exit } } if (NF == 0) { print -1; exit } printf "%d\\n", t }' <<<"$1"; }
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
# Zeilen zwischen den Markierungen (leer = kein Block)
hosts_block_inhalt() { awk -v a="$H_ANFANG" -v e="$H_ENDE" '$0 == a { s = 1; next } $0 == e { s = 0; next } s { print }' "$1"; }
# ohne -W: das Modul crypt fehlt ab Python 3.13 — dann sichtbarer Abbruch statt „jedes Mal chpasswd“
crypt_da() { python3 -c 'import warnings; warnings.simplefilter("ignore"); import crypt' >/dev/null 2>&1; }
# 0 gleich, 1 verschieden; alles andere (2 = crypt fehlt) → Abbruch
kw_vergleich() { local rc=0; kennwort_gleich || rc=$?; [ "$rc" -le 1 ] || abbruch "hacluster-Kennwort nicht prüfbar (python3 crypt, Exit $rc)"; return "$rc"; }
marken_ok() { local a e; a=$(grep -cxF "$H_ANFANG" "$1" || true); e=$(grep -cxF "$H_ENDE" "$1" || true); [ "$a" = "$e" ] && [ "$a" -le 1 ]; }
GEAENDERT=0; AJ=''
aend() { GEAENDERT=1; AJ+="\${AJ:+,}\\"$1\\""; }
${abbruchMitAenderungen()}
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
  versuch pakete
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
# Live-Fix: jedes Programm, das die linux_ha-Bausteine aufrufen, muss jetzt da sein (HA_BEFEHLE)
FEHLT=''; for b in "\${HA_BEFEHLE[@]}"; do if ! befehl_da "$b"; then FEHLT+="\${FEHLT:+, }$b"; fi; done
[ -z "$FEHLT" ] || abbruch "nach der Installation fehlen Programme der HA-Bausteine: $FEHLT"
# ── Cluster-Dienste: gleich nach der Installation aus, solange kein Cluster eingerichtet ist ──
# Task 3 (Ruling a): „kein Cluster“ = keine corosync.conf oder die Debian-Standardkonfiguration (cluster_name debian, nur Loopback) — gilt
# auch bei der Wiederholung nach einem abgebrochenen Erstlauf; ist ein Cluster eingerichtet (sqllnxcl01 oder ein anderer), bleiben die
# Dienste unberührt. Die Debian-Standardkonfiguration wird beiseitegelegt: pcs cluster setup verweigert Knoten mit corosync.conf
# (ohne --force, das Alfred nie setzt).
if [ ! -e "$COROSYNC_CONF" ] || konf_frei "$(cat "$COROSYNC_CONF")"; then
  for d in pacemaker corosync sbd; do
    if systemctl is-enabled --quiet "$d" || systemctl is-active --quiet "$d"; then
      versuch "aus:$d"; aus=$(systemctl disable --now "$d" 2>&1) || abbruch "$d lässt sich nicht stoppen/deaktivieren (noch kein Cluster eingerichtet): $(kurz "$aus")"
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
    # Ruling R10: ein vorhandener Block in anderer Form (bis Etappe 3: nur Kurznamen) wird ersetzt und eigens gemeldet
    alt=$(hosts_block_inhalt "$f")
    cp -p "$f" "$f.alfred-$(date +%Y%m%d%H%M%S)"
    printf '%s\\n' "$neu" >"$f.alfred-neu"; chmod --reference="$f" "$f.alfred-neu" 2>/dev/null || chmod 0644 "$f.alfred-neu"; mv -f "$f.alfred-neu" "$f"
    if [ -n "$alt" ] && [ "$alt" != "$H_SOLL_ZEILEN" ]; then aend "hosts-fqdn:$f"; else aend "hosts:$f"; fi
  fi
done
# ── Watchdog: Modul fest laden, softdog sperren, Kennung und Besitzer nach dem Laden erneut prüfen ──
# Live-Fix 2 (c2e4f56d): modules-load.d lädt i6300esb nie (Ubuntu-Sperrliste, systemd-modules-load „deny-listed (by kmod)“) — die eigene
# Datei von früher ist irreführend und wird entfernt; beim Start lädt das Warteskript im sbd-Drop-in das Modul ausdrücklich
if [ -e "$MODLOAD_CONF" ]; then rm -f -- "$MODLOAD_CONF"; aend modules-load-entfernt; fi
inhalt_gleich "$MODPROBE_CONF" "$MODPROBE_SOLL" || { schreibe "$MODPROBE_CONF" 0644 "$MODPROBE_SOLL"; aend softdog-gesperrt; }
if [ ! -e "$WD_SYS/watchdog0" ]; then
  versuch i6300esb-geladen; aus=$(modprobe i6300esb 2>&1) || abbruch "modprobe i6300esb fehlgeschlagen: $(kurz "$aus")"
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
if [ "$rw" != 0 ]; then versuch systemd-neu-geladen; systemctl daemon-reexec || abbruch "systemctl daemon-reexec fehlgeschlagen"; aend systemd-neu-geladen; rw=$(systemctl show -p RuntimeWatchdogUSec --value 2>/dev/null || true); fi
[ "$rw" = 0 ] || abbruch "systemd RuntimeWatchdogUSec ist '$rw', erwartet 0 (aus)"
# ── Live-Fix (c2e4f56d): sbd startet erst nach dem Watchdog-Modul und wenn das Gerät da ist (Wartezeit fest, sichtbarer Fehler danach) ──
DR_NEU=0
inhalt_gleich "$WARTE_DATEI" "$WARTE_SOLL" || { schreibe "$WARTE_DATEI" 0755 "$WARTE_SOLL"; DR_NEU=1; aend sbd-warteskript; }
# nur die Rechte falsch → nur die Rechte richten (kein daemon-reload nötig)
ist_ausfuehrbar "$WARTE_DATEI" || { rechte_setzen "$WARTE_DATEI"; aend sbd-warteskript-rechte; }
inhalt_gleich "$SBD_DROPIN" "$SBD_DROPIN_SOLL" || { schreibe "$SBD_DROPIN" 0644 "$SBD_DROPIN_SOLL"; DR_NEU=1; aend sbd-wartet-auf-watchdog; }
if [ "$DR_NEU" = 1 ]; then versuch systemd-neu-geladen-sbd; systemctl daemon-reload || abbruch "systemctl daemon-reload nach dem sbd-Drop-in fehlgeschlagen"; aend systemd-neu-geladen-sbd; fi
# ── Host-Firewall: eigene Tabelle inet alfred_ha über alfred-hostfw.service ──
FW_NEU=0
if ! inhalt_gleich "$FW_DATEI" "$NFT_SOLL"; then
  mkdir -p "$(dirname "$FW_DATEI")"
  printf '%s\\n' "$NFT_SOLL" >"$FW_DATEI.alfred-neu"; chmod 0644 "$FW_DATEI.alfred-neu"
  aus=$(nft -c -f "$FW_DATEI.alfred-neu" 2>&1) || { rm -f -- "$FW_DATEI.alfred-neu"; abbruch "nft lehnt den Regelsatz ab: $(kurz "$aus")"; }
  mv -f "$FW_DATEI.alfred-neu" "$FW_DATEI"; FW_NEU=1; aend firewall-regeln
fi
if ! inhalt_gleich "$UNIT_DATEI" "$UNIT_SOLL"; then schreibe "$UNIT_DATEI" 0644 "$UNIT_SOLL"; systemctl daemon-reload; FW_NEU=1; aend firewall-dienst; fi
if ! systemctl is-enabled --quiet "$FW_DIENST"; then versuch firewall-aktiviert; systemctl enable "$FW_DIENST" >/dev/null 2>&1 || abbruch "$FW_DIENST lässt sich nicht aktivieren"; aend firewall-aktiviert; fi
if [ "$FW_NEU" = 1 ] || ! systemctl is-active --quiet "$FW_DIENST" || ! nft list table inet "$NFT_TABELLE" >/dev/null 2>&1; then
  versuch firewall-geladen; systemctl restart "$FW_DIENST" || abbruch "$FW_DIENST startet nicht: $(kurz "$(journalctl -u "$FW_DIENST" -n 6 --no-pager 2>&1 || true)")"
  aend firewall-geladen
fi
# ── hacluster-Kennwort (aus stdin; nur bei Abweichung) ──
if ! kw_vergleich; then
  versuch hacluster-kennwort; printf 'hacluster:%s\\n' "$KW" | chpasswd || abbruch "chpasswd für hacluster fehlgeschlagen"
  printf 'ALFRED-HACLUSTER-GESETZT\\n'
  aend hacluster-kennwort
fi
# ── pcsd läuft (hinter der Firewall); die Cluster-Dienste regelt der Block nach der Installation ──
if ! systemctl is-enabled --quiet pcsd || ! systemctl is-active --quiet pcsd; then
  versuch pcsd; systemctl enable --now pcsd >/dev/null 2>&1 || abbruch "pcsd lässt sich nicht starten"
  aend pcsd
fi
# ── SQL Server: HADR an (Neustart nur bei Änderung) ──
NS=false
if [ "$(hadr_wert)" != 1 ]; then
  versuch hadr; aus=$("$MSSQLCONF" set hadr.hadrenabled 1 2>&1) || abbruch "mssql-conf set hadr.hadrenabled fehlgeschlagen: $(kurz "$aus")"
  systemctl restart mssql-server || abbruch "Neustart von mssql-server fehlgeschlagen"
  ok=0; for i in $(seq 1 60); do if ss -Htln 'sport = :1433' | grep -q .; then ok=1; break; fi; sleep 2; done
  [ "$ok" = 1 ] || abbruch "SQL Server lauscht nach dem Neustart nicht auf 1433 (120 s)"
  NS=true; aend hadr
fi
# ── Live-Fix (c2e4f56d): Knoten mit eingerichtetem Cluster und aktiviertem SBD — sbd muss laufen. Ein gesundes sbd wird nie angefasst.
# Zurückgeholt wird NUR, wenn sbd im Zustand failed ist und die LETZTE Ausführung von sbd (Journal-Feld _SYSTEMD_INVOCATION_ID =
# InvocationID der Unit, systemd ≥ 236) genau am fehlenden Watchdog-Gerät scheiterte (sbd-Meldung oder die des Warteskripts) und das Gerät
# jetzt da ist: dann NUR DIESEN Knoten — reset-failed, pcs cluster stop/start lokal (corosync zieht sbd beim Start mit; Pacemaker läuft hier
# nicht). Ein absichtlich gestoppter Knoten (inactive, nicht failed) und jede andere Ursache → nichts automatisch; die Selbstprüfung bricht
# dann sichtbar ab (sbd muss laufen, sobald der Cluster eingerichtet ist).
SBD_REPARIERT=false
if [ -e "$COROSYNC_CONF" ] && ! konf_frei "$(cat "$COROSYNC_CONF")" && systemctl is-enabled --quiet sbd && ! systemctl is-active --quiet sbd && systemctl is-failed --quiet sbd; then
  inv=$(systemctl show -p InvocationID --value sbd 2>/dev/null || true)
  [[ "$inv" =~ ^[0-9a-f]{32}$ ]] || abbruch "sbd ist auf $ICH gescheitert, die letzte Ausführung (InvocationID '$inv') ist nicht lesbar — nicht automatisch"
  sj=$(journalctl -b 0 "_SYSTEMD_INVOCATION_ID=$inv" --no-pager -o cat 2>/dev/null || true)
  { grep -qF "$SBD_WD_FEHLT" <<<"$sj" || grep -qF "$WARTE_FEHLT" <<<"$sj"; } || abbruch "sbd ist auf $ICH gescheitert, die letzte Ausführung ($inv) nennt aber nicht das fehlende Watchdog-Gerät — nicht automatisch: $(kurz "$sj")"
  ! systemctl is-active --quiet pacemaker || abbruch "sbd läuft auf $ICH nicht, Pacemaker aber schon — nicht automatisch (kein Stopp eines laufenden Pacemaker)"
  "$WARTE_DATEI" "$SBD_KONF" 5 || abbruch "sbd scheiterte am fehlenden Watchdog-Gerät, und es fehlt noch immer — nichts am Cluster geändert"
  systemctl reset-failed sbd >/dev/null 2>&1 || true
  aend sbd-reset-failed
  versuch cluster-hier-gestoppt; aus=$(pcs cluster stop 2>&1) || abbruch "pcs cluster stop (nur $ICH) fehlgeschlagen: $(kurz "$aus")"
  aend cluster-hier-gestoppt
  versuch cluster-hier-gestartet; aus=$(pcs cluster start --wait=120 2>&1) || abbruch "pcs cluster start (nur $ICH) fehlgeschlagen: $(kurz "$aus")"
  aend cluster-hier-gestartet
  ok=0; for i in $(seq 1 "$WARTE_RUNDEN"); do if systemctl is-active --quiet sbd && systemctl is-active --quiet pacemaker; then ok=1; break; fi; sleep 2; done
  [ "$ok" = 1 ] || abbruch "nach pcs cluster start laufen sbd/pacemaker auf $ICH nicht — sbd: $(systemctl is-active sbd 2>/dev/null || true), pacemaker: $(systemctl is-active pacemaker 2>/dev/null || true)"
  SBD_REPARIERT=true
fi
# ── Selbstprüfung ──
for i in "\${!KNOTEN_NAME[@]}"; do
  # alle Adressen (glibc liefert jeden Treffer aus /etc/hosts) — genau die Knoten-IP, kein Loopback
  a=$(getent ahostsv4 "\${KNOTEN_NAME[$i]}" | awk '{ print $1 }' | sort -u | tr '\\n' ' ' | sed 's/ $//' || true)
  [ "$a" = "\${KNOTEN_IP[$i]}" ] || abbruch "hosts: \${KNOTEN_NAME[$i]} löst zu '\${a:-nichts}' auf, erwartet \${KNOTEN_IP[$i]}"
  # Ruling R10: kanonischer Name (erstes Feld nach der Adresse) ist der FQDN
  c=$(getent hosts "\${KNOTEN_NAME[$i]}" | awk 'NR == 1 { print $2 }' || true)
  [ "$c" = "\${KNOTEN_NAME[$i]}.$DOMAENE" ] || abbruch "hosts: kanonischer Name von \${KNOTEN_NAME[$i]} ist '\${c:-keiner}', erwartet \${KNOTEN_NAME[$i]}.$DOMAENE"
done
hf=$(eigener_fqdn 2>/dev/null || true)
[ "$hf" = "$ICH.$DOMAENE" ] || abbruch "hostname -f liefert '\${hf:-nichts}', erwartet $ICH.$DOMAENE"
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
{ inhalt_gleich "$WARTE_DATEI" "$WARTE_SOLL" && ist_ausfuehrbar "$WARTE_DATEI" && inhalt_gleich "$SBD_DROPIN" "$SBD_DROPIN_SOLL"; } || abbruch "sbd-Drop-in oder Warteskript nicht wie erzeugt ($SBD_DROPIN, $WARTE_DATEI)"
# sbd.service muss die Wartezeit überstehen: TimeoutStartUSec ≥ SBD_START_MIN_S (systemd-Standard 90 s; live ohne TimeoutSec in der Unit)
sto=$(systemctl show -p TimeoutStartUSec --value sbd 2>/dev/null || true); sts=$(zeitspanne_s "$sto")
[ "$sts" -ge "$SBD_START_MIN_S" ] || abbruch "sbd.service TimeoutStartUSec ist '\${sto:-leer}' — erwartet mindestens $SBD_START_MIN_S s (Wartezeit des Warteskripts + Spielraum)"
if [ -e "$COROSYNC_CONF" ] && ! konf_frei "$(cat "$COROSYNC_CONF")" && systemctl is-enabled --quiet sbd; then
  systemctl is-active --quiet sbd || abbruch "Selbstprüfung: sbd läuft auf $ICH nicht (Cluster eingerichtet, SBD aktiviert)"
fi
if [ "$GEAENDERT" = 1 ]; then Z=geaendert; else Z=schon; fi
ergebnis "{\\"zustand\\":\\"$Z\\",\\"knoten\\":\\"$ICH\\",\\"rolle\\":\\"$ROLLE\\",\\"watchdog\\":$(printf '%s' "$WD_ID" | json_text),\\"pakete\\":{$PJ},\\"hadr\\":true,\\"firewall\\":\\"aktiv\\",\\"sql1433\\":$SQL1433_JSON,\\"pcsd\\":\\"aktiv\\",\\"sbdWartetAufWatchdog\\":true,\\"sbdZurueckgeholt\\":$SBD_REPARIERT,\\"neustartSql\\":$NS,\\"aenderungen\\":[$AJ]}"`;

/**
 * HA-Grundlage je Knoten, idempotent: hosts-Block der drei Knoten (FQDN zuerst, R10), Pakete fest und gehalten (pacemaker, corosync, pcs, sbd,
 * resource-agents-base, mssql-server-ha = SQL-Version, linux-modules-extra des laufenden Kernels), i6300esb laden (beim Start lädt es das Warteskript im sbd-Drop-in; modules-load.d wirkt wegen Ubuntus Sperrliste nicht und wird entfernt),
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
    `HA_BEFEHLE=(${HA_BEFEHLE.map(shQ).join(' ')})`,
    `H_ANFANG=${shQ(HA_HOSTS_ANFANG)}`,
    `H_ENDE=${shQ(HA_HOSTS_ENDE)}`,
    `HOSTS_BLOCK=${shQ(hostsBlock(k))}`,
    `H_SOLL_ZEILEN=${shQ(hostsBlock(k).split('\n').slice(1, -1).join('\n'))}`,
    `DOMAENE=${shQ(HA_DOMAENE)}`,
    `NFT_SOLL=${shQ(hostfwNft(k))}`,
    `SQL1433_JSON=${shQ(JSON.stringify([...k.map(x => x.ip), ...HA_SQL_ZUSATZQUELLEN]))}`,
    `H_ENTFERNT=${shQ(HA_HOSTS_ENTFERNT)}`,
    `UNIT_SOLL=${shQ(HOSTFW_UNIT)}`,
    `MODPROBE_SOLL=${shQ('# Alfred I8e Paket 2: SBD ist einziger Watchdog-Besitzer — kein softdog\nblacklist softdog')}`,
    `SYSTEMD_SOLL=${shQ('# Alfred I8e Paket 2: SBD ist einziger Watchdog-Besitzer\n[Manager]\nRuntimeWatchdogSec=off')}`,
    `WARTE_SOLL=${shQ(WARTE_WATCHDOG_SKRIPT)}`,
    `SBD_DROPIN_SOLL=${shQ(SBD_DROPIN_INHALT)}`,
    `SBD_WD_FEHLT=${shQ(HA_SBD_WATCHDOG_FEHLT)}`,
    `WARTE_FEHLT=${shQ('alfred: Watchdog-Gerät')}`,
    `SBD_START_MIN_S=${HA_SBD_START_MIN_S}`,
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
    online = sorted(n.get("name") for n in kn if n.get("online") == "true" and n.get("unclean", "false") != "true" and n.get("pending", "false") != "true")
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

/**
 * I8e Etappe 3 Task 8 — Pacemaker-Fehler dieses Knotens (Spec 4 Anti-Ziel: Fehl-Failover nach forceencryption). Zeitfenster für
 * fehlgeschlagene Aktionen (Sekunden); der Fehlerzähler der AG-Ressource zählt ohne Fenster (er verfällt nur mit pcs resource cleanup).
 */
export const HA_PM_FENSTER_S = 1800;
/**
 * Eigener crm_mon-Aufruf für Fehlaktionen (failures) und Fehlerzähler (node_history/resource_history fail-count) — getrennt vom Lage-Aufruf
 * (`crm_mon -1 --output-as=xml`), damit ein unbekannter Schalter nie die Lage-Prüfung von ag_anlegen/ag_failover kostet.
 */
export const HA_CRM_FEHLER_ARGS: readonly string[] = ['-1', '--output-as=xml', '--include=failcounts,failures'];

/**
 * python3: pm_fehler(x, ich, jetzt) aus dem crm_mon-XML (HA_CRM_FEHLER_ARGS) → { knoten, online, quorum, ressource (ag_cluster bekannt),
 * fehlerzaehler (ag_cluster auf diesem Knoten, nur mit last-failure im Fenster oder unlesbarer Zeit — fail-closed; INFINITY/unlesbar
 * = 1000000), fehlerzaehlerAlt (ältere, zählen nicht — Ruling R19: linux_ha räumt Fehlerzähler nie auf, ohne Fenster sperrten die
 * rollierenden Neustarts tls_erzwingen auf Dauer), fehlaktionen (dieser Knoten, im Fenster oder Zeit unlesbar — fail-closed), aeltere }. pm_maengel(f) → Liste der Gründe (leer = gesund). Braucht crm_lage (PY_CRM_FUNK).
 * Zeitformen: Epoche, „2026-11-19 10:00:00 +01:00“ (pacemaker 2.1), „Thu Nov 19 10:00:00 2026“ (ctime, lokale Zeit).
 */
export const PY_PM_FEHLER_FUNK = String.raw`import calendar, re, time
import xml.etree.ElementTree as ET
PM_RESSOURCE = ${JSON.stringify(HA_AG_RESSOURCE)}
PM_FENSTER = ${HA_PM_FENSTER_S}
def pm_wort(v):
    return re.sub(r"[^A-Za-z0-9_.:#+-]", "_", v or "")[:80] or None
def pm_zeit(t):
    t = " ".join((t or "").split())
    if re.match(r"^\d{9,11}$", t):
        return int(t)
    m = re.match(r"^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.\d+)?\s?(Z|[+-]\d\d:?\d\d)?$", t)
    if m:
        w = tuple(int(m.group(i)) for i in range(1, 7))
        z = m.group(7)
        if not z:
            return int(time.mktime(w + (0, 0, -1)))
        s = calendar.timegm(w + (0, 0, 0))
        if z != "Z":
            v = 1 if z[0] == "+" else -1
            s -= v * (int(z[1:3]) * 3600 + int(z[-2:]) * 60)
        return s
    try:
        return int(time.mktime(time.strptime(t, "%a %b %d %H:%M:%S %Y")))
    except Exception:
        return None
def pm_ist_ag(rid):
    return rid == PM_RESSOURCE or (rid or "").startswith(PM_RESSOURCE + ":")
def pm_fehler(x, ich, jetzt):
    r = ET.fromstring(x)
    l = crm_lage(x)
    f = {"knoten": ich, "online": ich in l["online"], "quorum": l["quorum"], "ressource": any(pm_ist_ag(e.get("id")) for e in r.iter("resource")),
         "fehlerzaehler": 0, "fehlerzaehlerAlt": 0, "fehlaktionen": [], "aeltere": 0, "fensterS": PM_FENSTER}
    for nh in r.iter("node_history"):
        for nd in nh.findall("node"):
            if nd.get("name") != ich:
                continue
            for rh in nd.findall("resource_history"):
                if not pm_ist_ag(rh.get("id")):
                    continue
                fc = (rh.get("fail-count") or "0").strip()
                try:
                    n = 1000000 if fc.upper() == "INFINITY" else int(fc)
                except ValueError:
                    n = 1000000
                if n <= 0:
                    continue
                z = pm_zeit(rh.get("last-failure"))
                if z is None or jetzt - z <= PM_FENSTER:
                    f["fehlerzaehler"] = max(f["fehlerzaehler"], n)
                else:
                    f["fehlerzaehlerAlt"] = max(f["fehlerzaehlerAlt"], n)
    for e in r.iter("failure"):
        if e.get("node") != ich:
            continue
        z = pm_zeit(e.get("last-rc-change"))
        if z is None or jetzt - z <= PM_FENSTER:
            f["fehlaktionen"].append({"aktion": pm_wort(e.get("op_key") or e.get("task")), "status": pm_wort(e.get("exitstatus") or e.get("status")), "zeit": z})
        else:
            f["aeltere"] += 1
    return f
def pm_maengel(f):
    m = []
    if not f["online"]:
        m.append("Knoten %s nicht online" % f["knoten"])
    if not f["quorum"]:
        m.append("kein Quorum")
    if not f["ressource"]:
        m.append("Ressource %s nicht gefunden" % PM_RESSOURCE)
    if f["fehlerzaehler"]:
        m.append("Fehlerzähler %s = %d mit Fehler in %d min (Ursache klären, dann pcs resource cleanup %s)" % (PM_RESSOURCE, f["fehlerzaehler"], PM_FENSTER // 60, PM_RESSOURCE))
    if f["fehlaktionen"]:
        m.append("%d fehlgeschlagene Aktionen in %d min: %s" % (len(f["fehlaktionen"]), PM_FENSTER // 60, ", ".join(str(a["aktion"]) for a in f["fehlaktionen"][:5])))
    return m`;

/**
 * Task 8 — Programm für Bash (tls_erzwingen): argv[1] = eigener Knotenname, argv[2] = Datei mit dem crm_mon-XML (HA_CRM_FEHLER_ARGS).
 * stdout eine JSON-Zeile pm_fehler; Exit 0 = gesund, 3 = Mängel (stderr nennt sie), 2 = XML unlesbar.
 */
export const PY_PM_PRUEFUNG = `${PY_CRM_FUNK}
${PY_PM_FEHLER_FUNK}
${String.raw`import json, sys
try:
    with open(sys.argv[2]) as d:
        f = pm_fehler(d.read(), sys.argv[1], int(time.time()))
except Exception as e:
    sys.stderr.write("crm_mon-XML nicht lesbar (%s)\n" % type(e).__name__)
    sys.exit(2)
print(json.dumps(f))
m = pm_maengel(f)
if m:
    sys.stderr.write("; ".join(m) + "\n")
    sys.exit(3)`}`;

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
${abbruchMitAenderungen(String.raw` && [ "$AJ" != '"pcs-anmeldung"' ]`)}
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
  versuch cluster-angelegt; aus=$(pcs cluster setup "$CLUSTER" "§{KNOTEN_ADDR[@]}" transport knet 2>&1) || abbruch "pcs cluster setup fehlgeschlagen: $(kurz "$aus") — pcs prüft vor dem Anlegen; ein Teilstand geht mit cluster_entfernen zurück"
  aend cluster-angelegt
  versuch sbd-diskless; aus=$(pcs stonith sbd enable "watchdog=$WD_DEV" "SBD_WATCHDOG_TIMEOUT=$SBD_T" 2>&1) || abbruch "pcs stonith sbd enable fehlgeschlagen: $(kurz "$aus") — Rückweg cluster_entfernen"
  aend sbd-diskless
  versuch cluster-aktiviert; aus=$(pcs cluster enable --all 2>&1) || abbruch "pcs cluster enable --all fehlgeschlagen: $(kurz "$aus") — Rückweg cluster_entfernen"
  aend cluster-aktiviert
  versuch cluster-gestartet; aus=$(pcs cluster start --all --wait=180 2>&1) || abbruch "pcs cluster start --all fehlgeschlagen: $(kurz "$aus") — Rückweg cluster_entfernen"
  aend cluster-gestartet
  warte_online || abbruch "nach dem Start $LO/$ANZAHL Knoten online, Quorum $LQ — erwartet alle Knoten mit Quorum; Rückweg cluster_entfernen"
else
  # ── bestehender Cluster gleichen Namens mit denselben Knoten: nur Abweichungen beheben, jede sichtbar ──
  lage
  if ! systemctl is-enabled --quiet corosync || ! systemctl is-enabled --quiet pacemaker; then
    versuch cluster-aktiviert; aus=$(pcs cluster enable --all 2>&1) || abbruch "pcs cluster enable --all fehlgeschlagen: $(kurz "$aus")"
    aend cluster-aktiviert
  fi
  if [ "$LO" != "$ANZAHL" ] || [ "$LQ" != 1 ]; then
    versuch cluster-gestartet; aus=$(pcs cluster start --all --wait=180 2>&1) || abbruch "pcs cluster start --all fehlgeschlagen: $(kurz "$aus")"
    aend cluster-gestartet
    warte_online || abbruch "nach dem Start $LO/$ANZAHL Knoten online, Quorum $LQ — erwartet alle Knoten mit Quorum"
  fi
  if ! sbd_soll; then
    # SBD ändern wirkt erst nach einem Neustart des ganzen Clusters — nur ohne Ressourcen (keine AG), sonst sichtbarer Abbruch
    [ "$LR" = 0 ] || abbruch "SBD weicht ab ($SBD_ABW), der Cluster trägt aber $LR Ressourcen — SBD ändern braucht einen Neustart des ganzen Clusters; nicht automatisch"
    # Task 4 (Carry-over 3): Stopp und Start des ganzen Clusters stehen in den Änderungen (Owner-Regel: nichts still)
    versuch cluster-gestoppt; aus=$(pcs cluster stop --all 2>&1) || abbruch "pcs cluster stop --all fehlgeschlagen: $(kurz "$aus")"
    aend cluster-gestoppt
    versuch sbd-neu-eingerichtet; aus=$(pcs stonith sbd enable "watchdog=$WD_DEV" "SBD_WATCHDOG_TIMEOUT=$SBD_T" 2>&1) || abbruch "pcs stonith sbd enable fehlgeschlagen: $(kurz "$aus") — Cluster ist gestoppt"
    aend sbd-neu-eingerichtet
    versuch cluster-gestartet; aus=$(pcs cluster start --all --wait=180 2>&1) || abbruch "pcs cluster start --all fehlgeschlagen: $(kurz "$aus") — Cluster ist gestoppt"
    aend cluster-gestartet
    warte_online || abbruch "nach dem SBD-Neustart $LO/$ANZAHL Knoten online, Quorum $LQ"
  fi
fi
# ── Eigenschaften: stonith-watchdog-timeout (diskless SBD) und stonith-enabled; have-watchdog setzt Pacemaker selbst (nur gelesen) ──
if [ "$(sekunden "$(eigenschaft stonith-watchdog-timeout)")" != "$STONITH_T" ]; then
  versuch stonith-watchdog-timeout; aus=$(pcs property set "stonith-watchdog-timeout=$STONITH_T" 2>&1) || abbruch "pcs property set stonith-watchdog-timeout=$STONITH_T fehlgeschlagen: $(kurz "$aus")"
  aend stonith-watchdog-timeout
fi
if [ "$(eigenschaft stonith-enabled)" != true ]; then
  versuch stonith-enabled; aus=$(pcs property set stonith-enabled=true 2>&1) || abbruch "pcs property set stonith-enabled=true fehlgeschlagen: $(kurz "$aus")"
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
    versuch cluster-gestoppt; aus=$(pcs cluster stop --all 2>&1) || abbruch "pcs cluster stop --all fehlgeschlagen: $(kurz "$aus")"
    aend cluster-gestoppt
  fi
  versuch sbd-aus; aus=$(pcs stonith sbd disable 2>&1) || abbruch "pcs stonith sbd disable fehlgeschlagen: $(kurz "$aus") — Cluster ist gestoppt"
  aend sbd-aus
  # pcs 0.11 fragt vor destroy nach; --force ersetzt nur diese Rückfrage
  versuch cluster-entfernt; aus=$(pcs cluster destroy --all --force 2>&1) || abbruch "pcs cluster destroy --all fehlgeschlagen: $(kurz "$aus")"
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
export const PY_FENCING_FUNK = String.raw`import hashlib, json, math, re, time
FENCING_ARTEN = ("trennung", "haenger")
def lies_json(p):
    try:
        with open(p) as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except Exception:
        return "unlesbar"
def _bytes(p):
    try:
        with open(p, "rb") as f:
            return f.read()
    except Exception:
        return b""
def fencing_ident(conf, key, sbd, ich):
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
    # Fix-Runde 1: /etc/default/sbd gehört zur Identität — eine SBD-Neueinrichtung macht den Beleg ungültig
    kb = _bytes(key)
    sb = _bytes(sbd)
    return {"cluster": name, "knoten": ich, "nodeid": nodeid, "konfHash": hashlib.sha256(t + b"\0" + kb + b"\0" + sb).hexdigest() if kb and sb else None}
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
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0:
            return "Beleg ohne Messwert " + f
    if not b.get("bootId") or not b.get("bootIdVorher") or b.get("bootId") == b.get("bootIdVorher"):
        return "Beleg ohne Reset (boot_id gleich)"
    if not isinstance(i, dict) or not i.get("konfHash"):
        return "Cluster-Identität nicht lesbar (corosync.conf/authkey/SBD-Konfiguration)"
    if b.get("cluster") != cluster:
        return "Beleg für Cluster %s, erwartet %s" % (_w(b.get("cluster")), cluster)
    if b.get("cluster") != i.get("cluster"):
        return "Beleg für Cluster %s, eingerichtet ist %s" % (_w(b.get("cluster")), _w(i.get("cluster")))
    if b.get("knoten") != i.get("knoten") or b.get("nodeid") != i.get("nodeid"):
        return "Beleg für Knoten %s (nodeid %s), hier %s (nodeid %s)" % (_w(b.get("knoten")), _w(b.get("nodeid")), _w(i.get("knoten")), _w(i.get("nodeid")))
    if b.get("konfHash") != i.get("konfHash"):
        return "Cluster seit dem Beleg neu eingerichtet (corosync.conf/authkey/SBD-Konfiguration anders)"
    if t is not None and not isinstance(t, dict):
        return "Test-Datei unlesbar"
    if isinstance(t, dict) and t.get("zeit") != b.get("testZeit"):
        return "neuerer Fencing-Test vom %s ohne Beleg" % _w(t.get("zeit"))
    return ""
# Live-Fix (Change c2e4f56d): Ergebnisse und Status geben Test und Beleg nur mit diesen festen Feldern aus — Feldnamen ohne Geheimnis-Wörter
# (die Schwärzung im Fernzugriff, kaefig.ts GEHEIM_NAME, ersetzte z. B. den Wert von „tokenMs“ und zerstörte die JSON-Zeile).
# Alte Namen aus vorhandenen Dateien (tokenMs/tokenQuelle) werden gelesen und unter den neuen ausgegeben; nur Skalare.
TEST_FELDER = ("art", "bootIdVorher", "zeit", "zeitS", "ausloeseS", "sperreS", "minResetS", "corosyncTaktMs", "taktQuelle", "knoten", "cluster", "nodeid", "konfHash", "sysrq", "kernelPanic")
BELEG_FELDER = ("art", "zeit", "resetS", "rejoinS", "bootId", "bootIdVorher", "testZeit", "minResetS", "cluster", "knoten", "nodeid", "konfHash", "journalLueckeS")
QUELLEN_FELDER = ("resetS", "rejoinS", "journalLueckeS", "keinShutdown")
ALTE_NAMEN = {"corosyncTaktMs": "tokenMs", "taktQuelle": "tokenQuelle"}
def _skalar(v):
    return v if v is None or isinstance(v, (str, bool, int)) or (isinstance(v, float) and math.isfinite(v)) else None
def _sicht(o, felder):
    if o is None or o == "unlesbar":
        return o
    if not isinstance(o, dict):
        return "unlesbar"
    return {f: _skalar(o.get(f, o.get(ALTE_NAMEN.get(f, ""), None))) for f in felder}
def sicht_test(t):
    return _sicht(t, TEST_FELDER)
def sicht_beleg(b):
    s = _sicht(b, BELEG_FELDER)
    if isinstance(s, dict) and isinstance(b.get("quellen"), dict):
        s["quellen"] = {f: _skalar(b["quellen"].get(f)) for f in QUELLEN_FELDER}
    return s`;

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
        w = [t["art"], str(t["bootIdVorher"]), int(t["zeitS"]), int(t["ausloeseS"]), int(t.get("sperreS") or 0), 0, str(t["zeit"])]
    except Exception:
        return None, "Test-Datei unvollständig"
    if w[0] not in FENCING_ARTEN or not BOOT_ID.match(w[1]) or not re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$", w[6]):
        return None, "Test-Datei mit ungültigen Werten"
    # Fix-Runde 2: trennung ohne gültige Untergrenze (fehlend, 0, nicht endlich) ist kein verwendbarer Test — nie stillschweigend 0
    m = t.get("minResetS")
    if w[0] == "trennung" and (isinstance(m, bool) or not isinstance(m, (int, float)) or not math.isfinite(m) or m <= 0):
        return None, "Test-Datei ohne gültige Untergrenze minResetS (trennung)"
    if w[0] == "trennung":
        w[5] = int(math.ceil(m))
    if t.get("knoten") != ich or t.get("cluster") != cluster:
        return None, "Test gehört zu %s/%s, nicht zu %s/%s" % (_w(t.get("knoten")), _w(t.get("cluster")), ich, cluster)
    if not isinstance(i, dict) or not i.get("konfHash") or t.get("konfHash") != i.get("konfHash"):
        return None, "Test vor einer Neueinrichtung des Clusters oder von SBD (corosync.conf/authkey/SBD-Konfiguration anders)"
    return w, ""
# Fix-Runde 1: Spuren eines geordneten Herunterfahrens im Journal des getesteten Starts — ein Fencing-Reset hinterlässt keine
SHUTDOWN_ZIELE = ("shutdown.target", "reboot.target", "poweroff.target", "halt.target", "kexec.target")
LOGIND_TEXTE = ("System is rebooting.", "System is powering down.", "System is halting.", "System is rebooting with kexec.")
def shutdown_spur(e):
    if not isinstance(e, dict):
        return ""
    m = e.get("MESSAGE")
    m = m if isinstance(m, str) else ""
    ident = e.get("SYSLOG_IDENTIFIER")
    # systemd (PID 1): Ziel des Herunterfahrens gestartet/erreicht („Reached target reboot.target - System Reboot.“)
    if e.get("_PID") == "1" and e.get("UNIT") in SHUTDOWN_ZIELE and (m.startswith("Reached target") or e.get("JOB_TYPE") == "start"):
        return "systemd: " + m[:100]
    # systemd-journald beendet sich nur beim Herunterfahren („Journal stopped“)
    if ident == "systemd-journald" and m.startswith("Journal stopped"):
        return "systemd-journald: " + m[:100]
    if ident == "systemd-logind" and m in LOGIND_TEXTE:
        return "systemd-logind: " + m
    if ident == "systemd-shutdown":
        return "systemd-shutdown: " + m[:100]
    return ""
a = sys.argv
c = a[1] if len(a) > 1 else ""
if c == "ident_ok":
    # conf key sbd ich cluster → konfHash; sonst Grund + Exit 1
    i = fencing_ident(a[2], a[3], a[4], a[5])
    if not i:
        print("corosync.conf nicht lesbar")
        sys.exit(1)
    if i["cluster"] != a[6] or not i["nodeid"] or not i["konfHash"]:
        print("Cluster %s, nodeid %s, authkey %s, SBD-Konfiguration %s" % (_w(i["cluster"]), _w(i["nodeid"]), "lesbar" if _bytes(a[3]) else "fehlt", "lesbar" if _bytes(a[4]) else "fehlt"))
        sys.exit(1)
    print(i["konfHash"])
elif c == "grund":
    # beleg test conf key sbd ich cluster → leer = gültig
    print(fencing_grund(lies_json(a[2]), lies_json(a[3]), fencing_ident(a[4], a[5], a[6], a[7]), a[8]))
elif c == "shutdown_spur":
    # stdin: journalctl -b -1 -o json --since @<Test> → erste Spur eines geordneten Herunterfahrens, sonst ausdrücklich „KEINE“
    # (Fix-Runde 2: nur „KEINE“ mit Exit 0 gilt als sauber — leere Ausgabe oder Absturz nie)
    for z in sys.stdin:
        try:
            s = shutdown_spur(json.loads(z))
        except Exception:
            continue
        if s:
            print("SPUR " + s)
            sys.exit(0)
    print("KEINE")
elif c == "beleg_art":
    b = lies_json(a[2])
    print(b.get("art", "") if isinstance(b, dict) else "")
elif c == "kompakt":
    # test|beleg datei → nur die festen Felder (Live-Fix: nie ein rohes Objekt mit beliebigen Schlüsseln ausgeben)
    print(json.dumps((sicht_test if a[2] == "test" else sicht_beleg)(lies_json(a[3]))))
elif c == "test":
    # datei conf key sbd ich cluster → „art bootIdVorher zeitS ausloeseS sperreS minResetS zeit“
    w, g = test_lesen(a[2], a[6], a[7], fencing_ident(a[3], a[4], a[5], a[6]))
    if w is None:
        print(g)
        sys.exit(1)
    print(*w)
elif c == "test_json":
    # art boot zeitS ausloeseS sperreS minResetS corosyncTaktMs taktQuelle conf key sbd ich sysrq panic
    i = fencing_ident(a[10], a[11], a[12], a[13]) or {}
    zs = int(a[4])
    print(json.dumps({"art": a[2], "bootIdVorher": a[3], "zeit": iso(zs), "zeitS": zs, "ausloeseS": int(a[5]), "sperreS": int(a[6]) or None,
                      "minResetS": int(a[7]), "corosyncTaktMs": int(a[8]) if a[8].isdigit() else None, "taktQuelle": a[9], "knoten": a[13],
                      "cluster": i.get("cluster"), "nodeid": i.get("nodeid"), "konfHash": i.get("konfHash"), "sysrq": a[14], "kernelPanic": a[15]}))
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
    # test boot resetS rejoinS jetzt luecke conf key sbd ich
    t = lies_json(a[2])
    i = fencing_ident(a[8], a[9], a[10], a[11]) or {}
    print(json.dumps({"art": t["art"], "zeit": iso(int(a[6])), "resetS": int(a[4]), "rejoinS": int(a[5]), "bootId": a[3], "bootIdVorher": t["bootIdVorher"],
                      "testZeit": t["zeit"], "minResetS": t.get("minResetS"), "cluster": i.get("cluster"), "knoten": i.get("knoten"), "nodeid": i.get("nodeid"), "konfHash": i.get("konfHash"),
                      "journalLueckeS": int(a[7]),
                      "quellen": {"resetS": "btime (/proc/stat) minus ausloeseS der Test-Datei (Uhrzeit unmittelbar vor dem Schreiben der Test-Datei + Verzögerung, systemd-run --on-active, AccuracySec=1s)",
                                  "rejoinS": "erste corosync-Meldung „" + QUORUM + "“ (journalctl -b 0 -u corosync) minus btime",
                                  "journalLueckeS": "btime minus letzter Eintrag des getesteten Starts (journalctl -b -1, _BOOT_ID = bootIdVorher)",
                                  "keinShutdown": "journalctl -b -1 --since @zeitS ohne reboot/poweroff/halt/kexec/shutdown.target, „Journal stopped“, logind „System is rebooting.“ u. ä., systemd-shutdown"}}))
else:
    sys.exit(3)`}`;

/** Gemeinsame Teile der Fencing-Bausteine — Pfade vor der Marke (Tests biegen sie um) */
const FENCING_PFADE = [
  `HA_DIR=${shQ(HA_FENCING_DIR)}`,
  `TEST_DATEI=${shQ(HA_FENCING_TEST_DATEI)}`,
  `BELEG_DATEI=${shQ(HA_FENCING_BELEG_DATEI)}`,
  'AUTHKEY=/etc/corosync/authkey',
  // Fix-Runde 1: SBD-Konfiguration gehört zur Identität des Belegs
  'SBD_KONF=/etc/default/sbd',
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
# wirksamer Corosync-Token in ms (corosync-cmapctl: „runtime.config.totem.token (u32) = 3000“)
token_ms() { corosync-cmapctl -g runtime.config.totem.token 2>/dev/null | awk -F'= ' 'NF > 1 { gsub(/[ \t\r]/, "", $2); print $2 }' || true; }
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
KH=$(fpy ident_ok "$COROSYNC_CONF" "$AUTHKEY" "$SBD_KONF" "$ICH" "$CLUSTER") || abbruch "Cluster-Identität auf $ICH nicht lesbar ($KH) — nichts geändert"
BOOT=$(boot_id)
[[ "$BOOT" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || abbruch "boot_id nicht lesbar ('$BOOT') — nichts geändert"
JETZT=$(jetzt)
[[ "$JETZT" =~ ^[0-9]+$ ]] || abbruch "Uhrzeit nicht lesbar — nichts geändert"
# laufender oder schon erfolgter Test dieses Knotens (gleicher Cluster)
T_BOOT=''
if [ -f "$TEST_DATEI" ] && tz=$(fpy test "$TEST_DATEI" "$COROSYNC_CONF" "$AUTHKEY" "$SBD_KONF" "$ICH" "$CLUSTER"); then
  read -r T_ART T_BOOT T_ZEIT_S T_AUSL_S T_SPERRE T_MIN T_ZEIT <<<"$tz"
  T_ALTER=$((JETZT - T_ZEIT_S))
  if [ "$T_BOOT" = "$BOOT" ] && [ "$T_ALTER" -le "$MAX_ALTER_S" ]; then abbruch "Fencing-Test ($T_ART) vom $T_ZEIT auf $ICH läuft noch — Reset ausstehend (boot_id unverändert); kein zweiter Test, nichts geändert"; fi
fi
# gültiger Beleg derselben Art → schon (eine Wiederholung des Schritts setzt den Knoten nicht noch einmal zurück)
G=$(fpy grund "$BELEG_DATEI" "$TEST_DATEI" "$COROSYNC_CONF" "$AUTHKEY" "$SBD_KONF" "$ICH" "$CLUSTER")
if [ -z "$G" ] && [ "$(fpy beleg_art "$BELEG_DATEI")" = "$ART" ]; then
  ergebnis "{\"zustand\":\"schon\",\"art\":\"$ART\",\"knoten\":\"$ICH\",\"cluster\":\"$CLUSTER\",\"beleg\":$(fpy kompakt beleg "$BELEG_DATEI"),\"aenderungen\":[]}"
  exit 0
fi
# Test dieser Art ist schon erfolgt (Reset nach dem Test, noch kein Beleg) → schon, Beleg folgt mit fencing_belegen
if [ -n "$T_BOOT" ] && [ "$T_ART" = "$ART" ] && [ "$T_BOOT" != "$BOOT" ] && [ "$T_ALTER" -le "$MAX_ALTER_S" ]; then
  ergebnis "{\"zustand\":\"schon\",\"art\":\"$ART\",\"knoten\":\"$ICH\",\"cluster\":\"$CLUSTER\",\"test\":$(fpy kompakt test "$TEST_DATEI"),\"hinweis\":\"Reset nach dem Test vom $T_ZEIT erfolgt — Beleg mit fencing_belegen\",\"aenderungen\":[]}"
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
# Fix-Runde 1: Untergrenze für den trennung-Reset = Corosync-Token (live, sonst fest $TOKEN_MS_FEST ms) + SBD_WATCHDOG_TIMEOUT — ein schnellerer
# Neustart ist nicht die Folge des Quorumverlusts
TOKEN_MS=$(token_ms); TOKEN_Q=live
if ! [[ "$TOKEN_MS" =~ ^[0-9]+$ ]] || [ "$TOKEN_MS" -lt 1 ]; then TOKEN_MS=$TOKEN_MS_FEST; TOKEN_Q=fest; fi
if [ "$ART" = trennung ]; then MIN_RESET=$(( (TOKEN_MS + 999) / 1000 + SBD_T )); else MIN_RESET=0; fi
# ── Phase 2: pcs-Anmeldung nur bei Bedarf (für pcs stonith sbd status), SBD auf allen Knoten ──
if ! pcsd_online; then anmelden; aend pcs-anmeldung; fi
ss=$(sbd_status); n=$(sbd_zahl "$ss" 3)
[ "$n" = "$ANZAHL" ] || abbruch "SBD läuft auf $n/$ANZAHL Knoten: $(kurz "$ss") — kein Test; $(stand)"
sbd_soll || abbruch "SBD weicht ab: $SBD_ABW — kein Test; $(stand)"
# ── Test-Datei VOR dem Auslösen (0600, sync) — scheitert das Planen des Auslösers, wird sie wieder entfernt (sonst sperrte sie 30 min) ──
TEST_NEU=0; AUSL_GEPLANT=0
alfred_aufraeumen() { if [ "$TEST_NEU" = 1 ] && [ "$AUSL_GEPLANT" = 0 ]; then rm -f -- "$TEST_DATEI"; sync; fi; }
# Fix-Runde 1: Uhrzeit unmittelbar vor dem Schreiben neu lesen — Phase 1/2 (pcs über pcsd) dauern Sekunden; JETZT von oben gilt nur für „läuft noch“
JETZT_T=$(jetzt)
[[ "$JETZT_T" =~ ^[0-9]+$ ]] || abbruch "Uhrzeit nicht lesbar — $(stand)"
AUSL_S=$((JETZT_T + VERZ_S))
if [ "$ART" = trennung ]; then SP=$SPERRE_S; else SP=0; fi
TJ=$(fpy test_json "$ART" "$BOOT" "$JETZT_T" "$AUSL_S" "$SP" "$MIN_RESET" "$TOKEN_MS" "$TOKEN_Q" "$COROSYNC_CONF" "$AUTHKEY" "$SBD_KONF" "$ICH" "$SYSRQ" "$PANIC")
TEST_NEU=1
schreibe_privat "$TEST_DATEI" "$TJ"
aend fencing-test-datei
{ [ "$(cat "$TEST_DATEI")" = "$TJ" ] && fpy test "$TEST_DATEI" "$COROSYNC_CONF" "$AUTHKEY" "$SBD_KONF" "$ICH" "$CLUSTER" >/dev/null; } || abbruch "Test-Datei $TEST_DATEI nach dem Schreiben nicht lesbar — nichts ausgelöst, Test-Datei entfernt"
# ── Auslösen: entkoppelt per systemd-run (AccuracySec=1s — Standard wäre 1 min), der SSH-Aufruf kehrt vorher zurück ──
EINHEIT="alfred-fencetest-$JETZT_T"
if [ "$ART" = trennung ]; then
  printf '%s\n' "$NFT_TEST" >"$REGEL_DATEI"
  aus=$(nft -c -f "$REGEL_DATEI" 2>&1) || abbruch "nft lehnt die Test-Regel ab: $(kurz "$aus") — nichts ausgelöst, Test-Datei entfernt"
  # zuerst das Aufheben planen: die Sperre endet nach $SPERRE_S s auch dann, wenn SBD den Knoten nicht zurücksetzt
  versuch aufheben-geplant; aus=$(systemd-run --unit="$EINHEIT-ende" --on-active="$((VERZ_S + SPERRE_S))" --timer-property=AccuracySec=1s nft delete table inet "$TEST_TABELLE" 2>&1) || abbruch "Aufheben der Sperre nicht planbar: $(kurz "$aus") — nichts ausgelöst, Test-Datei entfernt"
  aend aufheben-geplant
  versuch ausloeser-geplant; aus=$(systemd-run --unit="$EINHEIT" --on-active="$VERZ_S" --timer-property=AccuracySec=1s nft -f "$REGEL_DATEI" 2>&1) || abbruch "Auslöser nicht planbar: $(kurz "$aus") — nichts ausgelöst, Test-Datei entfernt (der Aufheben-Timer läuft ins Leere)"
  AUSL_GEPLANT=1
  aend ausloeser-geplant
else
  versuch ausloeser-geplant; aus=$(systemd-run --unit="$EINHEIT" --on-active="$VERZ_S" --timer-property=AccuracySec=1s /bin/sh -c "sync; echo c > $SYSRQ_TRIGGER" 2>&1) || abbruch "Auslöser nicht planbar: $(kurz "$aus") — nichts ausgelöst, Test-Datei entfernt"
  AUSL_GEPLANT=1
  aend ausloeser-geplant
fi
# ── Selbstprüfung: Timer geplant ──
systemctl is-active --quiet "$EINHEIT.timer" || abbruch "Selbstprüfung: Auslöser $EINHEIT.timer nicht aktiv"
if [ "$ART" = trennung ]; then systemctl is-active --quiet "$EINHEIT-ende.timer" || abbruch "Selbstprüfung: Aufheben $EINHEIT-ende.timer nicht aktiv"; fi
ergebnis "{\"zustand\":\"ausgeloest\",\"art\":\"$ART\",\"knoten\":\"$ICH\",\"cluster\":\"$CLUSTER\",\"bootIdVorher\":\"$BOOT\",\"ausloesungInS\":$VERZ_S,\"sperreS\":$SP,\"einheit\":\"$EINHEIT\",\"test\":$(fpy kompakt test "$TEST_DATEI"),\"aenderungen\":[$AJ]}"`);

const FENCING_BELEGEN_KOERPER = sh(String.raw`# ── Phase 1: prüfen — ohne Beweis kein Beleg ──
knoten_pruefen
for c in crm_mon python3 journalctl; do command -v "$c" >/dev/null 2>&1 || abbruch "$c fehlt auf $ICH — kein Beleg"; done
KONF=''; if [ -f "$COROSYNC_CONF" ]; then KONF=$(cat "$COROSYNC_CONF"); fi
KA=$(konf_art "$KONF")
[ "$KA" = alfred ] || abbruch "auf $ICH ist $CLUSTER mit $KNOTEN_SOLL nicht eingerichtet (corosync.conf: §{KA#fremd:}) — kein Beleg"
[ -f "$TEST_DATEI" ] || abbruch "kein Fencing-Test auf $ICH ($TEST_DATEI fehlt) — vorher fencing_pruefen; kein Beleg"
tz=$(fpy test "$TEST_DATEI" "$COROSYNC_CONF" "$AUTHKEY" "$SBD_KONF" "$ICH" "$CLUSTER") || abbruch "Fencing-Test nicht verwendbar: $tz — kein Beleg"
read -r T_ART T_BOOT T_ZEIT_S T_AUSL_S T_SPERRE T_MIN T_ZEIT <<<"$tz"
# gültiger Beleg genau zu diesem Test → schon
G=$(fpy grund "$BELEG_DATEI" "$TEST_DATEI" "$COROSYNC_CONF" "$AUTHKEY" "$SBD_KONF" "$ICH" "$CLUSTER")
if [ -z "$G" ]; then
  ergebnis "{\"zustand\":\"schon\",\"knoten\":\"$ICH\",\"cluster\":\"$CLUSTER\",\"beleg\":$(fpy kompakt beleg "$BELEG_DATEI"),\"aenderungen\":[]}"
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
# Fix-Runde 1: trennung — schneller als Corosync-Token + SBD_WATCHDOG_TIMEOUT kann der Quorumverlust nicht zurücksetzen
[ "$RESET_S" -ge "$T_MIN" ] || abbruch "Reset schon $RESET_S s nach der Auslösung (mindestens $T_MIN s = Corosync-Token + SBD_WATCHDOG_TIMEOUT) — nicht die Folge der Trennung; kein Beleg"
# der vorherige Start im Journal ist genau der getestete (kein weiterer Neustart dazwischen)
jv=$(journalctl -b -1 -n 1 -o json --no-pager 2>/dev/null | fpy journal_letzt) || abbruch "Journal des vorherigen Starts nicht lesbar (journalctl -b -1; persistentes Journal nötig) — kein Beleg"
read -r J_BOOT J_LETZT_S <<<"$jv"
[ "$J_BOOT" = "§{T_BOOT//-/}" ] || abbruch "vorheriger Start im Journal ist $J_BOOT, getestet wurde §{T_BOOT//-/} — dazwischen lag ein weiterer Neustart; kein Beleg"
LUECKE=$((BT - J_LETZT_S))
# Fix-Runde 1: kein geordnetes Herunterfahren im getesteten Start seit dem Test (manueller Neustart, unattended-upgrades Automatic-Reboot)
jj=$(journalctl -b -1 -o json --no-pager --since "@$T_ZEIT_S" 2>/dev/null) || abbruch "Journal des getesteten Starts ab dem Test nicht lesbar (journalctl -b -1 --since @$T_ZEIT_S) — kein Beleg"
# Fix-Runde 2: fail closed — nur genau „KEINE“ mit Exit 0 (pipefail) gilt als „kein Herunterfahren“
rc=0; sp=$(printf '%s\n' "$jj" | fpy shutdown_spur) || rc=$?
[ "$rc" = 0 ] || abbruch "Prüfung auf geordnetes Herunterfahren gescheitert (Exit $rc) — kein Beleg"
case "$sp" in
  KEINE) ;;
  "SPUR "*) abbruch "geordnetes Herunterfahren im getesteten Start (§{sp#SPUR }) — ein Neustart, kein Fencing-Reset; kein Beleg" ;;
  *) abbruch "Prüfung auf geordnetes Herunterfahren ohne eindeutige Antwort ('$(kurz "$sp")') — kein Beleg" ;;
esac
# ── Cluster: der Knoten ist wieder online (bis WARTE_RUNDEN × 2 s), SBD läuft und hält den Watchdog ──
ok=0
# Live-Fix (c2e4f56d): Pacemaker-Mitgliedschaft, nicht nur corosync — crm_mon zählt nur online="true" ohne unclean/pending, dazu läuft pacemaker hier
for i in $(seq 1 "$WARTE_RUNDEN"); do lage; if [ "$LQ" = 1 ] && [[ ",$LN," == *",$ICH,"* ]] && systemctl is-active --quiet pacemaker; then ok=1; break; fi; sleep 2; done
[ "$ok" = 1 ] || abbruch "$ICH ist nach dem Reset nicht online im Cluster (online: $LN, Quorum $LQ) — Pacemaker hier: $(systemctl is-active pacemaker 2>/dev/null || true); kein Beleg"
systemctl is-active --quiet sbd || abbruch "sbd läuft auf $ICH nach dem Reset nicht — kein Beleg"
sbd_haelt_wd || abbruch "sbd hält auf $ICH nach dem Reset kein /dev/watchdog offen — kein Beleg"
RJ=$(journalctl -b 0 -u corosync -o json --no-pager 2>/dev/null | fpy rejoin "$BT") || abbruch "Rejoin-Zeitpunkt nicht im Journal (corosync seit dem Start ohne „$QUORUM_TEXT“) — kein Beleg"
# ── Beleg schreiben (0600, sync) und selbst prüfen ──
BJ=$(fpy beleg_json "$TEST_DATEI" "$BOOT" "$RESET_S" "$RJ" "$JETZT" "$LUECKE" "$COROSYNC_CONF" "$AUTHKEY" "$SBD_KONF" "$ICH") || abbruch "Beleg nicht erzeugbar — kein Beleg"
# Fix-Runde 1: besteht der geschriebene Beleg die Selbstprüfung nicht, wird er wieder entfernt (kein Beweis → kein Marker)
BELEG_NEU=0; BELEG_OK=0
alfred_aufraeumen() { if [ "$BELEG_NEU" = 1 ] && [ "$BELEG_OK" = 0 ]; then rm -f -- "$BELEG_DATEI"; sync; fi; }
BELEG_NEU=1
schreibe_privat "$BELEG_DATEI" "$BJ"
aend fencing-beleg
G=$(fpy grund "$BELEG_DATEI" "$TEST_DATEI" "$COROSYNC_CONF" "$AUTHKEY" "$SBD_KONF" "$ICH" "$CLUSTER")
[ -z "$G" ] || abbruch "Selbstprüfung: geschriebener Beleg ist nicht gültig: $G — Beleg entfernt"
BELEG_OK=1
ergebnis "{\"zustand\":\"geaendert\",\"knoten\":\"$ICH\",\"cluster\":\"$CLUSTER\",\"beleg\":$(fpy kompakt beleg "$BELEG_DATEI"),\"aenderungen\":[$AJ]}"`);

function fencingKopf(baustein: string, p: Record<string, unknown>, knoten: readonly HaKnoten[], cluster: string): string[] {
  return [
    ...clusterKopf(baustein, p, knoten, cluster),
    `SBD_T=${HA_SBD_TIMEOUT_S}`,
    `STONITH_T=${HA_STONITH_WD_TIMEOUT_S}`,
    `VERZ_S=${HA_FENCING_VERZOEGERUNG_S}`,
    `SPERRE_S=${HA_FENCING_SPERRE_S}`,
    `MAX_ALTER_S=${HA_FENCING_MAX_ALTER_S}`,
    `RESET_MAX_S=${HA_FENCING_RESET_MAX_S}`,
    `TOKEN_MS_FEST=${HA_COROSYNC_TOKEN_MS_FEST}`,
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
  nodeid?: string | null; konfHash?: string | null; sysrq?: string; kernelPanic?: string; minResetS?: number; corosyncTaktMs?: number | null; taktQuelle?: string;
}
export interface FencingBeleg {
  art: HaFencingArt; zeit: string; resetS: number; rejoinS: number; bootId: string; bootIdVorher: string; testZeit: string;
  cluster: string | null; knoten: string | null; nodeid: string | null; konfHash: string | null; journalLueckeS?: number; minResetS?: number; quellen?: Record<string, string>;
}
/** Fencing-Teil des Status eines Knotens (PY_HA_STATUS → r.fencing); Datei fehlt → null, unlesbar → 'unlesbar' */
export interface FencingLage {
  bootId?: string | null; jetztS?: number;
  identitaet?: FencingIdentitaet | null;
  test?: FencingTest | 'unlesbar' | null;
  beleg?: FencingBeleg | 'unlesbar' | null;
  /** Fix-Runde 1: nft-Tabelle inet alfred_fencetest geladen (Corosync-Sperre eines Tests) */
  sperreAktiv?: boolean;
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
  if (!i || typeof i !== 'object' || !i.konfHash) return 'Cluster-Identität nicht lesbar (corosync.conf/authkey/SBD-Konfiguration)';
  // wie Python: fehlend und null sind gleich (None)
  const g = (a: unknown, b2: unknown) => (a ?? null) === (b2 ?? null);
  if (!g(x.cluster, cluster)) return `Beleg für Cluster ${w(x.cluster)}, erwartet ${cluster}`;
  if (!g(x.cluster, i.cluster)) return `Beleg für Cluster ${w(x.cluster)}, eingerichtet ist ${w(i.cluster)}`;
  if (!g(x.knoten, i.knoten) || !g(x.nodeid, i.nodeid)) return `Beleg für Knoten ${w(x.knoten)} (nodeid ${w(x.nodeid)}), hier ${w(i.knoten)} (nodeid ${w(i.nodeid)})`;
  if (!g(x.konfHash, i.konfHash)) return 'Cluster seit dem Beleg neu eingerichtet (corosync.conf/authkey/SBD-Konfiguration anders)';
  const t = lage?.test as unknown;
  if (t !== null && t !== undefined && (typeof t !== 'object' || Array.isArray(t))) return 'Test-Datei unlesbar';
  if (t && !g((t as Record<string, unknown>).zeit, x.testZeit)) return `neuerer Fencing-Test vom ${w((t as Record<string, unknown>).zeit)} ohne Beleg`;
  return undefined;
}

// ── Status ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Task 6: AG-Lage — Pacemaker (Promoted, VIP, required_sync an der Ressource, Standort-Bedingungen) und SQL (Rollen, Sync-Zustand,
 * required_sync) über die Zugangsdatei des Resource-Agents (Login alfred_pacemaker: VIEW SERVER STATE + Rechte auf die AG); das Kennwort
 * steht nur in der Umgebung des einen sqlcmd-Prozesses (wie SQL_HILFE), nie in Argumenten oder Ausgabe
 * Funktionen getrennt vom Aufruf (Tests setzen lauf, lies und sqlcmd_lauf ein).
 */
export const PY_AG_STATUS_FUNK = [
  // I8e Etappe 3 Task 7: Ziel der Verbindung (Schalter der Zertifikatsprüfung, wie linux_sql)
  PY_SQL_ZIEL,
  `AGR, AGK, VIPR, PMDATEI, SQLCMD = ${JSON.stringify(HA_AG_RESSOURCE)}, ${JSON.stringify(HA_AG_KLON)}, ${JSON.stringify(HA_AG_VIP_RESSOURCE)}, ${JSON.stringify(HA_PACEMAKER_DATEI)}, ${JSON.stringify(HA_AG_BEFEHLE[0])}`,
  String.raw`AG_TSQL = """SET NOCOUNT ON;
SELECT 'ALFRED|G|' + g.name + '|' + CAST(g.required_synchronized_secondaries_to_commit AS varchar(5)) + '|' + CAST((SELECT COUNT(*) FROM sys.availability_databases_cluster c WHERE c.group_id = g.group_id) AS varchar(10)) FROM sys.availability_groups g;
SELECT 'ALFRED|R|' + r.replica_server_name + '|' + ISNULL(UPPER(rs.role_desc), '-') + '|' + UPPER(r.availability_mode_desc) + '|' + ISNULL(UPPER(rs.connected_state_desc), '-') + '|'
  + CAST((SELECT COUNT(*) FROM sys.dm_hadr_database_replica_states d WHERE d.replica_id = r.replica_id) AS varchar(10)) + '|'
  + CAST((SELECT COUNT(*) FROM sys.dm_hadr_database_replica_states d WHERE d.replica_id = r.replica_id AND UPPER(d.synchronization_state_desc) = 'SYNCHRONIZED') AS varchar(10))
  FROM sys.availability_replicas r LEFT JOIN sys.dm_hadr_availability_replica_states rs ON rs.replica_id = r.replica_id ORDER BY r.replica_server_name;
"""
def wort(v):
    return re.sub(r"[^A-Za-z0-9_.:-]", "_", v or "")[:80] or None
def sqlcmd_lauf(login, kw):
    return subprocess.run([SQLCMD] + sql_ziel() + ["-b", "-x", "-U", login, "-l", "10", "-h", "-1", "-W", "-w", "65535"], input=AG_TSQL, capture_output=True, text=True, timeout=30, env=dict(os.environ, SQLCMDPASSWORD=kw))
def ag_sql():
    z = (lies(PMDATEI) or "").splitlines()
    if len(z) < 2 or not z[0] or not z[1]:
        return None, None
    try:
        p = sqlcmd_lauf(z[0], z[1])
    except SqlZielFehler as e:
        return None, str(e)
    except Exception as e:
        return None, type(e).__name__
    tf = sql_tls_fehler(p)
    if tf:
        return None, tf.replace(z[1], "[geschwärzt]")
    if p.returncode != 0:
        t = " ".join((p.stdout + " " + p.stderr).replace(z[1], "[geschwärzt]").split())
        return None, t[-160:] or ("Exit %d" % p.returncode)
    s = {"name": None, "requiredSync": None, "datenbanken": None, "replikate": []}
    for zeile in p.stdout.splitlines():
        f = zeile.strip().split("|")
        if f[:2] == ["ALFRED", "G"] and len(f) == 5:
            s.update({"name": wort(f[2]), "requiredSync": int(f[3]) if f[3].isdigit() else None, "datenbanken": int(f[4]) if f[4].isdigit() else None})
        elif f[:2] == ["ALFRED", "R"] and len(f) == 8:
            s["replikate"].append({"name": wort(f[2]), "rolle": wort(f[3]), "modus": wort(f[4]), "verbunden": wort(f[5]), "dbs": int(f[6]) if f[6].isdigit() else 0, "sync": int(f[7]) if f[7].isdigit() else 0})
    return s, None
def ag_lage():
    ag = {"art": "keine"}
    c, _ = lauf("crm_resource", "--resource", AGR, "--query-xml")
    if c == 0 or os.path.exists(PMDATEI):
        ag = {"art": "eingerichtet", "ressource": c == 0, "name": None, "requiredSyncRessource": None, "promoted": None, "vip": None, "standort": None}
        if c == 0:
            for k, n in (("name", "ag_name"), ("requiredSyncRessource", "required_synchronized_secondaries_to_commit")):
                c2, v = lauf("crm_resource", "--resource", AGR, "--get-parameter", n)
                ag[k] = wort(v.splitlines()[-1].strip()) if c2 == 0 and v.strip() else None
        c, x = lauf("crm_mon", "-1", "--output-as=xml")
        if c == 0:
            try:
                pr, vn = [], []
                for e in ET.fromstring(x).iter("resource"):
                    if e.get("active", "true") != "true" or e.get("failed", "false") == "true":
                        continue
                    kn = [n.get("name") for n in e.findall("node") if n.get("name")]
                    if e.get("id") == AGR and e.get("role") in ("Promoted", "Master"):
                        pr += kn
                    if e.get("id") == VIPR and e.get("role") == "Started":
                        vn += kn
                ag["promoted"], ag["vip"] = sorted(set(pr)), sorted(set(vn))
            except Exception:
                pass
        c, x = lauf("cibadmin", "--query", "--scope", "constraints")
        if c == 0:
            try:
                ag["standort"] = [{"id": wort(e.get("id")), "rsc": wort(e.get("rsc")), "knoten": wort(e.get("node")), "rolle": wort(e.get("role"))} for e in ET.fromstring(x).iter("rsc_location") if e.get("rsc") in (AGR, AGK, VIPR)]
            except Exception:
                ag["standort"] = None
        ag["sql"], ag["sqlFehler"] = ag_sql()
    return ag`,
].join('\n');

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
  // Ruling R10: vorhanden = FQDN-Form; der alte Block (nur Kurznamen) gilt als veraltet, nicht als fehlend
  `DOMAENE = ${JSON.stringify(HA_DOMAENE)}`,
  'hz = hosts.splitlines()',
  'r["hosts"] = ANFANG in hz and all(("%s %s.%s %s" % (k["ip"], k["name"], DOMAENE, k["name"])) in hz for k in KNOTEN)',
  'r["hostsVeraltet"] = ANFANG in hz and not r["hosts"] and all(("%s %s" % (k["ip"], k["name"])) in hz for k in KNOTEN)',
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
  // Live-Fix (c2e4f56d): sbd-Drop-in und Warteskript genau wie von ha_vorbereiten erzeugt
  `r["sbdWartetAufWatchdog"] = lies(${JSON.stringify(HA_SBD_DROPIN)}) == ${JSON.stringify(SBD_DROPIN_INHALT.trim())} and lies(${JSON.stringify(HA_WARTE_WATCHDOG)}) == ${JSON.stringify(WARTE_WATCHDOG_SKRIPT.trim())} and os.access(${JSON.stringify(HA_WARTE_WATCHDOG)}, os.X_OK)`,
  'r["pcsd"] = lauf("systemctl", "is-active", "pcsd")[1] or "unbekannt"',
  // Task 3: Cluster — corosync.conf (Name, Knoten), crm_mon-XML, SBD je Knoten (pcs stonith sbd status), stonith-watchdog-timeout
  PY_CLUSTER_FUNK,
  // Task 8: Fehlaktionen/Fehlerzähler (pm_fehler, nutzt crm_lage aus PY_CLUSTER_FUNK)
  PY_PM_FEHLER_FUNK,
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
        # Task 8: Fehlaktionen (30 min) und Fehlerzähler der AG-Ressource dieses Knotens — eigener Aufruf, None = nicht lesbar
        cl["fehler"] = None
        c, x = lauf("crm_mon", *${JSON.stringify(HA_CRM_FEHLER_ARGS)})
        if c == 0:
            try:
                cl["fehler"] = pm_fehler(x, ich, int(time.time()))
            except Exception:
                cl["fehler"] = None
        c, t = lauf("pcs", "stonith", "sbd", "status")
        if c == 0:
            cl["sbd"] = sbd_lesen(t)
        c, v = lauf("crm_attribute", "-t", "crm_config", "-n", "stonith-watchdog-timeout", "-G", "-q")
        cl["stonithWatchdogTimeout"] = v if c == 0 and v else None
r["cluster"] = cl`,
  // Task 4: Fencing-Beweis dieses Knotens — Test, Beleg, boot_id und Identität im Cluster; die Gültigkeit prüft fencingBelegGueltig (TS)
  PY_FENCING_FUNK,
  `r["fencing"] = {"bootId": lies("/proc/sys/kernel/random/boot_id"), "jetztS": int(time.time()), "test": sicht_test(lies_json(${JSON.stringify(HA_FENCING_TEST_DATEI)})), "beleg": sicht_beleg(lies_json(${JSON.stringify(HA_FENCING_BELEG_DATEI)})), "identitaet": fencing_ident("/etc/corosync/corosync.conf", "/etc/corosync/authkey", "/etc/default/sbd", ich), "sperreAktiv": lauf("nft", "list", "table", "inet", ${JSON.stringify(HA_FENCETEST_TABELLE)})[0] == 0}`,
  // Task 6: AG-Lage (PY_AG_STATUS_FUNK)
  PY_AG_STATUS_FUNK,
  'r["ag"] = ag_lage()',
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

// ── Verfügbarkeitsgruppe (Task 5): ag_anlegen / ag_entfernen ─────────────────────────────────────────────────────────────────
//
// Ablauf (orchestriert vom Skill über die drei Zugänge, je Knoten ein Baustein):
//   0. Fencing-Gate im Skill: linux_ha.status auf allen drei Knoten, gültiger Beleg (fencingBelegGueltig) — sonst keine SQL-Zeile.
//   1. ha.ag_endpunkt je Knoten: lokales Fencing-Gate (fpy grund), Master-Key (Tresor), eigenes Endpunkt-Zertifikat, Endpunkt alfred_hadr
//      TCP 5022, Pacemaker-Login (Tresor) + VIEW SERVER STATE, /var/opt/mssql/secrets/passwd (0600 root). Ergebnis: das ÖFFENTLICHE
//      Zertifikat (CERTENCODED, DER als Hex) und sein Fingerabdruck — ein privater Schlüssel verlässt den Knoten nie.
//   2. ha.ag_replikat je Knoten (Primär zuerst): die beiden fremden öffentlichen Zertifikate (FROM BINARY) mit Login/User und CONNECT
//      auf den Endpunkt; Primär: CREATE AVAILABILITY GROUP … CLUSTER_TYPE = EXTERNAL, REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT = 0,
//      AUTOMATED_BACKUP_PREFERENCE = PRIMARY; Sekundär: JOIN + GRANT CREATE ANY DATABASE; Konfig: JOIN; überall Pacemaker-Rechte auf die AG.
//      Primär prüft vorher die Datenbanken wie der Abschluss (vorhanden, ONLINE, FULL, Log-Kette, keine andere AG) — erst danach läuft der
//      Sekundär. Sekundär: eine zurückgebliebene Kopie einer AG-Datenbank im Zustand RESTORING ohne AG (Rest von ag_entfernen) wird vor
//      dem JOIN sichtbar entfernt (alte-kopie-entfernt-<db>) und neu geseedet; jeder andere Zustand außerhalb der AG bricht ohne Änderung ab.
//   3. ha.ag_abschluss auf dem Primär: Datenbanken (FULL, Log-Kette begonnen) aufnehmen, SYNCHRONIZED abwarten, Pacemaker-Ressourcen
//      ag_cluster (ocf:mssql:ag, required_synchronized_secondaries_to_commit=0, promotable) und ag_vip (IPaddr2, erst deaktiviert),
//      Kolokation mit Promoted + Reihenfolge promote → start, VIP aktivieren; Selbstprüfung.
//   Rückweg ha.ag_entfernen je Knoten (Primär zuerst, mit Ressourcen): Ressourcen, AG, Endpunkt, Zertifikate, Logins, Zugangsdatei;
//   Datenbanken bleiben (Primär wieder ONLINE, Sekundär RESTORING — ein späteres ag_anlegen entfernt die Sekundär-Kopie sichtbar und
//   seedet neu), Master-Keys bleiben (Tresor).
//
// T-SQL geht über stdin an sqlcmd (SQL_HILFE, als sa), Kennwörter nur über Platzhalter @@HS@@/@@PM@@, die das Skript aus der
// Eingabe einsetzt (' verdoppelt). Jeder T-SQL-Block beginnt mit „-- ALFRED-SCHRITT <name>“ (Tests stubben sqlcmd danach) und liefert
// genau eine Zeile „ALFRED|…“ — nur Nicht-max-Typen (sqlcmd kürzt varchar(max) ohne -y 0, und -y 0 verträgt sich nicht mit -h -1).

/** Global Constraints: AG sqllnxag01 mit VIP 10.203.30.13/27, CONFIGURATION_ONLY auf sqllnxcfg */
export const HA_AG_NAME = 'sqllnxag01';
export const HA_AG_VIP = '10.203.30.13/27';
export const HA_AG_KONFIG_KNOTEN = 'sqllnxcfg';
export const HA_AG_ENDPUNKT = 'alfred_hadr';
export const HA_AG_PORT = 5022;
/** eigenes Endpunkt-Zertifikat alfred_ag_<knoten>; dasselbe Muster für die importierten Zertifikate, Logins und Benutzer der Peers */
export const HA_AG_ZERT_PRAEFIX = 'alfred_ag_';
export const HA_PACEMAKER_LOGIN = 'alfred_pacemaker';
/** Tresor: Kennwort des Pacemaker-Logins (alle drei Knoten gleich) und Master-Key-Kennwort je Zugang */
export const HA_PACEMAKER_TRESOR = 'sqllnx-ha-pacemaker';
export const haMasterkeyTresor = (zugang: string) => `sqllnx-${zugang.toLowerCase()}-masterkey`;
export const HA_AG_ROLLEN = ['primaer', 'sekundaer', 'konfig'] as const;
export type HaAgRolle = typeof HA_AG_ROLLEN[number];
export interface HaAgBesetzung { primaer: string; sekundaer: string; konfig: string }
/** öffentliches Endpunkt-Zertifikat eines anderen Knotens (DER als Großbuchstaben-Hex) mit Fingerabdruck */
export interface HaAgPeer { name: string; zertifikat: string; fingerabdruck: string }
export interface HaAgEndpunktParameter { cluster: string; ag: string; besetzung: HaAgBesetzung; rolle: HaAgRolle; knoten: HaKnoten[] }
/** datenbanken: die Datenbanken der AG — Primär prüft ihre Bereitschaft, Sekundär entfernt eine alte RESTORING-Kopie ohne AG, Konfig nur geprüft */
export interface HaAgReplikatParameter { ag: string; besetzung: HaAgBesetzung; rolle: HaAgRolle; knoten: HaKnoten[]; peers: HaAgPeer[]; datenbanken: string[] }
export interface HaAgAbschlussParameter { ag: string; besetzung: HaAgBesetzung; knoten: HaKnoten[]; datenbanken: string[]; vip: { ip: string; praefix: number } }
export interface HaAgEntfernenParameter { ag: string; besetzung: HaAgBesetzung; rolle: HaAgRolle; knoten: HaKnoten[]; ressourcen: boolean }

const AG_NAME = /^[a-z][a-z0-9]{2,30}$/;
const AG_DB = /^[A-Za-z][A-Za-z0-9_]{2,63}$/;
const AG_SYSTEM_DBS = new Set(['master', 'model', 'msdb', 'tempdb']);

/**
 * Genau ein DER-Zertifikat als Großbuchstaben-Hex (CERTENCODED, CONVERT(…, 2)): SEQUENCE mit Zwei-Byte-Länge (30 82 LLLL) und genau
 * LLLL Inhaltsbytes. Ein PVK-Blob (CERTPRIVATEKEY, 1EF1B5B0…), PEM oder angehängte Daten sind es nicht.
 */
export function istOeffentlichesZertifikat(hex: unknown): boolean {
  if (typeof hex !== 'string' || hex.length > 8000 || !/^3082[0-9A-F]{4}(?:[0-9A-F]{2})+$/.test(hex)) return false;
  return hex.length === 2 * (4 + parseInt(hex.slice(4, 8), 16));
}

const pruefeAgName = (a: unknown) => (typeof a === 'string' && AG_NAME.test(a) ? undefined : `ag: Name aus Kleinbuchstaben/Ziffern (3–31 Zeichen), z. B. ${HA_AG_NAME}`);
const pruefeAgRolle = (r: unknown) => (HA_AG_ROLLEN.includes(r as HaAgRolle) ? undefined : `rolle: ${HA_AG_ROLLEN.join(', ')}`);

/** Primär, Sekundär, Konfig: drei verschiedene der Knoten; Konfig fest sqllnxcfg (Global Constraints) */
export function pruefeHaAgBesetzung(b: unknown, knoten: unknown): string | undefined {
  const fk = pruefeKnoten(knoten); if (fk) return fk;
  const namen = (knoten as HaKnoten[]).map(k => k.name);
  const x = obj(b);
  for (const r of HA_AG_ROLLEN) if (typeof x[r] !== 'string' || !namen.includes(x[r] as string)) return `besetzung.${r}: einer der Knoten ${namen.join(', ')}`;
  if (new Set(HA_AG_ROLLEN.map(r => x[r])).size !== HA_AG_ROLLEN.length) return 'besetzung: Primär, Sekundär und Konfig müssen verschiedene Knoten sein';
  if (x.konfig !== HA_AG_KONFIG_KNOTEN) return `besetzung.konfig: ${HA_AG_KONFIG_KNOTEN} (CONFIGURATION_ONLY-Replikat, Global Constraints)`;
  return undefined;
}

export function pruefeAgDatenbanken(d: unknown): string | undefined {
  const regel = 'Buchstabe, dann Buchstaben/Ziffern/_ (3–64 Zeichen), keine Systemdatenbank';
  if (!Array.isArray(d) || !d.length || d.length > 20) return `datenbanken: 1–20 Namen (${regel})`;
  for (const n of d) if (typeof n !== 'string' || !AG_DB.test(n) || AG_SYSTEM_DBS.has(n.toLowerCase())) return `datenbanken: „${String(n).slice(0, 40)}“ ungültig (${regel})`;
  if (new Set(d.map(n => (n as string).toLowerCase())).size !== d.length) return 'datenbanken: Name doppelt';
  return undefined;
}

export function pruefeHaAgEndpunkt(p: unknown): string | undefined {
  const x = obj(p);
  return pruefeClusterName(x.cluster) ?? pruefeAgName(x.ag) ?? pruefeHaAgBesetzung(x.besetzung, x.knoten) ?? pruefeAgRolle(x.rolle);
}

export function pruefeHaAgReplikat(p: unknown): string | undefined {
  const x = obj(p);
  const f = pruefeAgName(x.ag) ?? pruefeHaAgBesetzung(x.besetzung, x.knoten) ?? pruefeAgRolle(x.rolle) ?? pruefeAgDatenbanken(x.datenbanken); if (f) return f;
  const ich = (x.besetzung as HaAgBesetzung)[x.rolle as HaAgRolle];
  const soll = (x.knoten as HaKnoten[]).map(k => k.name).filter(n => n !== ich);
  const peers = Array.isArray(x.peers) ? x.peers.map(obj) : [];
  if (peers.length !== soll.length || peers.some((e, i) => e.name !== soll[i])) return `peers: genau die anderen Knoten ${soll.join(', ')} (in dieser Reihenfolge)`;
  for (const e of peers) {
    if (!istOeffentlichesZertifikat(e.zertifikat)) return `peers.${String(e.name)}: kein öffentliches Zertifikat (ein DER-Zertifikat als Hex) — nur öffentliche Endpunkt-Zertifikate verlassen einen Knoten`;
    if (typeof e.fingerabdruck !== 'string' || !/^[0-9A-F]{40,64}$/.test(e.fingerabdruck)) return `peers.${String(e.name)}.fingerabdruck: Großbuchstaben-Hex (40–64 Zeichen)`;
  }
  return undefined;
}

export function pruefeHaAgAbschluss(p: unknown): string | undefined {
  const x = obj(p);
  const f = pruefeAgName(x.ag) ?? pruefeHaAgBesetzung(x.besetzung, x.knoten) ?? pruefeAgDatenbanken(x.datenbanken); if (f) return f;
  const v = obj(x.vip);
  if (typeof v.ip !== 'string' || !IPV4.test(v.ip) || typeof v.praefix !== 'number' || !Number.isInteger(v.praefix) || v.praefix < 8 || v.praefix > 32) return `vip: {ip, praefix} wie ${HA_AG_VIP}`;
  if ((x.knoten as HaKnoten[]).some(k => k.ip === v.ip)) return 'vip: darf keine Knoten-Adresse sein';
  return undefined;
}

export function pruefeHaAgEntfernen(p: unknown): string | undefined {
  const x = obj(p);
  const f = pruefeAgName(x.ag) ?? pruefeHaAgBesetzung(x.besetzung, x.knoten) ?? pruefeAgRolle(x.rolle); if (f) return f;
  if (typeof x.ressourcen !== 'boolean') return 'ressourcen: true (Pacemaker-Ressourcen hier entfernen, nur auf dem Primär) oder false';
  return undefined;
}

// T-SQL-Bausteine (Namen sind geprüft: Knoten [a-z0-9-], AG [a-z0-9], Datenbanken [A-Za-z0-9_] — sicher in [] und N'…')
const zn = (k: string) => `${HA_AG_ZERT_PRAEFIX}${k}`;
const ipVon = (knoten: readonly HaKnoten[], n: string) => knoten.find(k => k.name === n)!.ip;
const agUrl = (knoten: readonly HaKnoten[], n: string) => `TCP://${ipVon(knoten, n)}:${HA_AG_PORT}`;
const EPN = HA_AG_ENDPUNKT;
const PML = HA_PACEMAKER_LOGIN;
const AG_KOPF = (schritt: string) => `-- ALFRED-SCHRITT ${schritt}\nUSE master; SET NOCOUNT ON;`;
const servername = (ich: string) => `IF @@SERVERNAME <> N'${ich}' BEGIN SET @m = N'@@SERVERNAME ist ' + ISNULL(@@SERVERNAME, N'NULL') + N', erwartet ${ich} (Replikatname = Rechnername) - nichts geändert'; THROW 50100, @m, 1; END`;
const endpunktPasst = (ich: string) => `EXISTS (SELECT 1 FROM sys.database_mirroring_endpoints e JOIN sys.tcp_endpoints t ON t.endpoint_id = e.endpoint_id WHERE e.name = N'${EPN}' AND t.port = ${HA_AG_PORT} AND e.role_desc = N'ALL' AND e.connection_auth_desc = N'CERTIFICATE' AND e.certificate_id = CERT_ID(N'${zn(ich)}') AND e.is_encryption_enabled = 1 AND e.encryption_algorithm_desc = N'AES')`;
const vssDa = `EXISTS (SELECT 1 FROM sys.server_permissions p JOIN sys.server_principals l ON l.principal_id = p.grantee_principal_id WHERE l.name = N'${PML}' AND p.class = 100 AND p.permission_name = N'VIEW SERVER STATE' AND p.state IN ('G', 'W'))`;
/** class 108 = AVAILABILITY GROUP: ALTER, CONTROL, VIEW DEFINITION für den Pacemaker-Login */
const pmAgRechte = `(SELECT COUNT(DISTINCT p.permission_name) FROM sys.server_permissions p JOIN sys.server_principals l ON l.principal_id = p.grantee_principal_id WHERE l.name = N'${PML}' AND p.class = 108 AND p.permission_name IN (N'ALTER', N'CONTROL', N'VIEW DEFINITION') AND p.state IN ('G', 'W'))`;
const agDa = (ag: string) => `EXISTS (SELECT 1 FROM sys.availability_groups WHERE name = N'${ag}')`;
const lokaleRolle = (ag: string) => `(SELECT UPPER(rs.role_desc) FROM sys.dm_hadr_availability_replica_states rs JOIN sys.availability_groups g ON g.group_id = rs.group_id WHERE g.name = N'${ag}' AND rs.is_local = 1)`;
const connectDa = (p: string) => `EXISTS (SELECT 1 FROM sys.server_permissions x JOIN sys.server_principals l ON l.principal_id = x.grantee_principal_id JOIN sys.endpoints e ON e.endpoint_id = x.major_id WHERE x.class = 105 AND e.name = N'${EPN}' AND l.name = N'${zn(p)}' AND x.permission_name = N'CONNECT' AND x.state IN ('G', 'W'))`;
const dbTabelle = (dbs: readonly string[]) => `DECLARE @dbs TABLE (n sysname); INSERT @dbs (n) VALUES ${dbs.map(d => `(N'${d}')`).join(', ')};`;
/**
 * Bereitschaft der AG-Datenbanken auf dem Primär (ab_pruefen und rp_pruefen Primär): vorhanden, ONLINE, Wiederherstellungsmodell FULL,
 * Log-Kette begonnen, in keiner anderen AG — sonst THROW <nr> ohne Änderung. Erwartet deklarierte @m nvarchar(2048), @f nvarchar(2000) = N''.
 */
const dbBereitschaft = (ag: string, dbs: readonly string[], nr: number): string[] => [
  dbTabelle(dbs),
  "SELECT @f += N' ' + d.n + N' fehlt;' FROM @dbs d WHERE DB_ID(d.n) IS NULL;",
  "SELECT @f += N' ' + d.n + N' ist ' + s.state_desc COLLATE DATABASE_DEFAULT + N';' FROM @dbs d JOIN sys.databases s ON s.name = d.n COLLATE DATABASE_DEFAULT WHERE s.state_desc <> N'ONLINE';",
  "SELECT @f += N' ' + d.n + N' hat Wiederherstellungsmodell ' + s.recovery_model_desc COLLATE DATABASE_DEFAULT + N' (erwartet FULL);' FROM @dbs d JOIN sys.databases s ON s.name = d.n COLLATE DATABASE_DEFAULT WHERE s.recovery_model_desc <> N'FULL';",
  // Log-Kette begonnen = mindestens eine FULL-Sicherung im Modell FULL (sonst kein automatisches Seeding)
  "SELECT @f += N' ' + d.n + N' ohne FULL-Sicherung (Log-Kette nicht begonnen);' FROM @dbs d JOIN sys.database_recovery_status r ON r.database_id = DB_ID(d.n) WHERE r.last_log_backup_lsn IS NULL;",
  `SELECT @f += N' ' + d.n + N' gehört zur Verfügbarkeitsgruppe ' + g.name COLLATE DATABASE_DEFAULT + N';' FROM @dbs d JOIN sys.availability_databases_cluster c ON c.database_name = d.n COLLATE DATABASE_DEFAULT JOIN sys.availability_groups g ON g.group_id = c.group_id WHERE g.name <> N'${ag}';`,
  `IF @f <> N'' BEGIN SET @m = N'Datenbanken nicht bereit:' + @f + N' - Wiederherstellungsmodell und Sicherung werden nie still geändert; nichts geändert'; THROW ${nr}, @m, 1; END`,
];
/**
 * lokale Kopie ohne AG im Zustand RESTORING (Rest von ag_entfernen auf dem früheren Sekundär) — nur diese wird je entfernt. Steht die
 * Datenbank in sys.availability_databases_cluster einer hier bekannten AG (Seeding/Wiederbeitritt bei einer Wiederholung läuft), ist
 * sie keine alte Kopie und bleibt unberührt — unabhängig davon, ob replica_id schon gesetzt ist.
 */
const alteKopie = (d: string) => `EXISTS (SELECT 1 FROM sys.databases WHERE name = N'${d}' AND state_desc = N'RESTORING' AND replica_id IS NULL) AND NOT EXISTS (SELECT 1 FROM sys.availability_databases_cluster WHERE database_name = N'${d}')`;

function tsqlEndpunkt(ich: string): Record<'pruefen' | 'masterkey' | 'login' | 'endpunkt' | 'selbst', string> {
  const mkDa = "EXISTS (SELECT 1 FROM sys.symmetric_keys WHERE name = N'##MS_DatabaseMasterKey##')";
  return {
    pruefen: [
      AG_KOPF('ep_pruefen'),
      'DECLARE @m nvarchar(2048);',
      servername(ich),
      "IF ISNULL(CAST(SERVERPROPERTY('IsHadrEnabled') AS int), 0) <> 1 THROW 50101, N'HADR ist nicht aktiv - vorher ha_vorbereiten (hadr.hadrenabled); nichts geändert', 1;",
      `IF EXISTS (SELECT 1 FROM sys.database_mirroring_endpoints WHERE name <> N'${EPN}') THROW 50102, N'anderer Spiegelungs-/AG-Endpunkt vorhanden - nicht still ersetzt; nichts geändert', 1;`,
      `IF EXISTS (SELECT 1 FROM sys.tcp_endpoints WHERE port = ${HA_AG_PORT} AND name <> N'${EPN}') THROW 50103, N'TCP ${HA_AG_PORT} ist von einem anderen Endpunkt belegt; nichts geändert', 1;`,
      `IF EXISTS (SELECT 1 FROM sys.certificates WHERE name = N'${zn(ich)}' AND pvt_key_encryption_type = 'NA') THROW 50104, N'Zertifikat ${zn(ich)} ohne privaten Schlüssel (kein eigenes Endpunkt-Zertifikat); nichts geändert', 1;`,
      `IF EXISTS (SELECT 1 FROM sys.database_mirroring_endpoints WHERE name = N'${EPN}') AND NOT ${endpunktPasst(ich)} THROW 50105, N'Endpunkt ${EPN} weicht ab (Port, Rolle, Zertifikat oder Verschlüsselung) - nicht still geändert; nichts geändert', 1;`,
      `IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'${PML}' AND type <> 'S') THROW 50106, N'${PML} ist kein SQL-Login; nichts geändert', 1;`,
      `IF EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = N'${PML}' AND PWDCOMPARE(N'@@PM@@', password_hash) = 0) THROW 50107, N'Login ${PML} besteht mit anderem Kennwort als im Tresor (${HA_PACEMAKER_TRESOR}) - nicht still zurückgesetzt; nichts geändert', 1;`,
      `IF ${mkDa}`,
      'BEGIN',
      "  BEGIN TRY OPEN MASTER KEY DECRYPTION BY PASSWORD = N'@@HS@@'; CLOSE MASTER KEY; END TRY",
      "  BEGIN CATCH THROW 50108, N'Master-Key in master besteht mit anderem Kennwort als im Tresor (sqllnx-<zugang>-masterkey) - nicht still ersetzt; nichts geändert', 1; END CATCH",
      'END',
      "SELECT 'ALFRED|ok';",
    ].join('\n'),
    masterkey: [
      AG_KOPF('ep_masterkey'),
      'DECLARE @neu int = 0;',
      `IF NOT ${mkDa} BEGIN BEGIN TRY CREATE MASTER KEY ENCRYPTION BY PASSWORD = N'@@HS@@'; END TRY BEGIN CATCH THROW; END CATCH; SET @neu = 1; PRINT 'ALFRED-ERLEDIGT masterkey'; END`,
      "SELECT 'ALFRED|' + CAST(@neu AS varchar(1));",
    ].join('\n'),
    login: [
      AG_KOPF('ep_login'),
      "DECLARE @neu int = 0, @a varchar(400) = '';",
      `IF NOT EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = N'${PML}') BEGIN BEGIN TRY CREATE LOGIN [${PML}] WITH PASSWORD = N'@@PM@@', CHECK_POLICY = ON, CHECK_EXPIRATION = OFF, DEFAULT_DATABASE = [master]; SET @neu = 1; END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' pacemaker-login'; PRINT 'ALFRED-ERLEDIGT pacemaker-login'; END`,
      `IF (SELECT is_disabled FROM sys.server_principals WHERE name = N'${PML}') = 1 BEGIN BEGIN TRY ALTER LOGIN [${PML}] ENABLE; END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' pacemaker-login-aktiviert'; PRINT 'ALFRED-ERLEDIGT pacemaker-login-aktiviert'; END`,
      `IF NOT ${vssDa} BEGIN BEGIN TRY GRANT VIEW SERVER STATE TO [${PML}]; END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' pacemaker-view-server-state'; PRINT 'ALFRED-ERLEDIGT pacemaker-view-server-state'; END`,
      "SELECT 'ALFRED|' + CAST(@neu AS varchar(1)) + '|' + LTRIM(@a);",
    ].join('\n'),
    endpunkt: [
      AG_KOPF('ep_endpunkt'),
      "DECLARE @a varchar(400) = '', @sql nvarchar(max);",
      `IF NOT EXISTS (SELECT 1 FROM sys.certificates WHERE name = N'${zn(ich)}') BEGIN BEGIN TRY SET @sql = N'CREATE CERTIFICATE [${zn(ich)}] WITH SUBJECT = N''Alfred AG-Endpunkt ${ich}'', EXPIRY_DATE = ''20361231'''; EXEC (@sql); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' zertifikat'; PRINT 'ALFRED-ERLEDIGT zertifikat'; END`,
      `IF NOT EXISTS (SELECT 1 FROM sys.database_mirroring_endpoints WHERE name = N'${EPN}') BEGIN BEGIN TRY SET @sql = N'CREATE ENDPOINT [${EPN}] STATE = STARTED AS TCP (LISTENER_PORT = ${HA_AG_PORT}, LISTENER_IP = ALL) FOR DATABASE_MIRRORING (ROLE = ALL, AUTHENTICATION = CERTIFICATE [${zn(ich)}], ENCRYPTION = REQUIRED ALGORITHM AES)'; EXEC (@sql); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' endpunkt'; PRINT 'ALFRED-ERLEDIGT endpunkt'; END`,
      `IF (SELECT state_desc FROM sys.database_mirroring_endpoints WHERE name = N'${EPN}') <> N'STARTED' BEGIN BEGIN TRY EXEC (N'ALTER ENDPOINT [${EPN}] STATE = STARTED'); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' endpunkt-gestartet'; PRINT 'ALFRED-ERLEDIGT endpunkt-gestartet'; END`,
      "SELECT 'ALFRED|' + LTRIM(@a);",
    ].join('\n'),
    selbst: [
      AG_KOPF('ep_selbst'),
      "DECLARE @f nvarchar(2000) = N'';",
      `IF NOT ${endpunktPasst(ich)} SET @f += N' Endpunkt ${EPN} fehlt oder weicht ab;';`,
      `IF NOT EXISTS (SELECT 1 FROM sys.database_mirroring_endpoints WHERE name = N'${EPN}' AND state_desc = N'STARTED') SET @f += N' Endpunkt ${EPN} nicht gestartet;';`,
      `IF NOT EXISTS (SELECT 1 FROM sys.certificates WHERE name = N'${zn(ich)}' AND pvt_key_encryption_type <> 'NA') SET @f += N' Zertifikat ${zn(ich)} fehlt;';`,
      `IF NOT EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = N'${PML}' AND is_disabled = 0 AND PWDCOMPARE(N'@@PM@@', password_hash) = 1) SET @f += N' Login ${PML} fehlt, ist gesperrt oder hat ein anderes Kennwort;';`,
      `IF NOT ${vssDa} SET @f += N' VIEW SERVER STATE für ${PML} fehlt;';`,
      "BEGIN TRY OPEN MASTER KEY DECRYPTION BY PASSWORD = N'@@HS@@'; CLOSE MASTER KEY; END TRY BEGIN CATCH SET @f += N' Master-Key nicht mit dem Tresor-Kennwort zu öffnen;'; END CATCH",
      'IF @f <> N\'\' THROW 50109, @f, 1;',
      // nur das öffentliche Zertifikat (CERTENCODED) — nie CERTPRIVATEKEY
      `SELECT 'ALFRED|' + CONVERT(varchar(64), c.thumbprint, 2) + '|' + CONVERT(varchar(8000), CERTENCODED(c.certificate_id), 2) FROM sys.certificates c WHERE c.name = N'${zn(ich)}';`,
    ].join('\n'),
  };
}

function tsqlReplikat(p: HaAgReplikatParameter): Record<'pruefen' | 'aendern' | 'selbst', string> {
  const { ag, besetzung: b, knoten, rolle } = p;
  const ich = b[rolle];
  const daten = (n: string) => `N''${n}'' WITH (ENDPOINT_URL = N''${agUrl(knoten, n)}'', AVAILABILITY_MODE = SYNCHRONOUS_COMMIT, FAILOVER_MODE = EXTERNAL, SEEDING_MODE = AUTOMATIC)`;
  const anlegen = `CREATE AVAILABILITY GROUP [${ag}] WITH (CLUSTER_TYPE = EXTERNAL, REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT = 0, AUTOMATED_BACKUP_PREFERENCE = PRIMARY) FOR REPLICA ON `
    + `${daten(b.primaer)}, ${daten(b.sekundaer)}, N''${b.konfig}'' WITH (ENDPOINT_URL = N''${agUrl(knoten, b.konfig)}'', AVAILABILITY_MODE = CONFIGURATION_ONLY)`;
  const rep = (n: string, bed: string) => `(r.replica_server_name = N'${n}' AND r.endpoint_url = N'${agUrl(knoten, n)}' AND ${bed})`;
  const datenBed = "r.availability_mode_desc = N'SYNCHRONOUS_COMMIT' AND r.failover_mode_desc = N'EXTERNAL' AND r.seeding_mode_desc = N'AUTOMATIC'";
  const reps = `FROM sys.availability_replicas r JOIN sys.availability_groups g ON g.group_id = r.group_id WHERE g.name = N'${ag}'`;
  const pruefen = [
    AG_KOPF('rp_pruefen'),
    "DECLARE @m nvarchar(2048), @f nvarchar(2000) = N'';",
    servername(ich),
    `IF NOT EXISTS (SELECT 1 FROM sys.database_mirroring_endpoints WHERE name = N'${EPN}' AND state_desc = N'STARTED') THROW 50201, N'Endpunkt ${EPN} fehlt oder ist nicht gestartet - erst der Endpunkt-Schritt; nichts geändert', 1;`,
    `IF NOT EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = N'${PML}') THROW 50202, N'Login ${PML} fehlt - erst der Endpunkt-Schritt; nichts geändert', 1;`,
    `IF EXISTS (SELECT 1 FROM sys.availability_groups WHERE name <> N'${ag}') THROW 50203, N'auf ${ich} besteht eine andere Verfügbarkeitsgruppe; nichts geändert', 1;`,
    ...p.peers.flatMap(x => [
      `IF EXISTS (SELECT 1 FROM sys.certificates c WHERE c.name = N'${zn(x.name)}' AND (CONVERT(varchar(64), c.thumbprint, 2) <> '${x.fingerabdruck}' OR c.pvt_key_encryption_type <> 'NA' OR c.principal_id <> ISNULL(DATABASE_PRINCIPAL_ID(N'${zn(x.name)}'), -1))) THROW 50204, N'Zertifikat ${zn(x.name)} besteht mit anderem Fingerabdruck, privatem Schlüssel oder anderem Besitzer - nicht still ersetzt (vorher ag_entfernen); nichts geändert', 1;`,
      `IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'${zn(x.name)}' AND type <> 'S') THROW 50205, N'${zn(x.name)} besteht, ist aber kein SQL-Login; nichts geändert', 1;`,
      `IF EXISTS (SELECT 1 FROM sys.database_principals u WHERE u.name = N'${zn(x.name)}' AND ISNULL(u.sid, 0x00) <> ISNULL(SUSER_SID(N'${zn(x.name)}'), 0x01)) THROW 50206, N'Benutzer ${zn(x.name)} in master gehört nicht zum Login ${zn(x.name)}; nichts geändert', 1;`,
    ]),
    `IF ${agDa(ag)} AND (SELECT UPPER(cluster_type_desc) FROM sys.availability_groups WHERE name = N'${ag}') <> N'EXTERNAL' THROW 50207, N'${ag} besteht mit anderem CLUSTER_TYPE - nicht still geändert; nichts geändert', 1;`,
    ...(rolle === 'primaer' ? [
      `IF ${agDa(ag)} AND ISNULL(${lokaleRolle(ag)}, N'') <> N'PRIMARY' THROW 50208, N'${ich} ist nicht Primär von ${ag}; nichts geändert', 1;`,
      `IF ${agDa(ag)} AND ((SELECT COUNT(*) ${reps}) <> 3 OR (SELECT COUNT(*) ${reps} AND (${rep(b.primaer, datenBed)} OR ${rep(b.sekundaer, datenBed)} OR ${rep(b.konfig, "r.availability_mode_desc = N'CONFIGURATION_ONLY'")})) <> 3)`,
      `  THROW 50209, N'${ag} besteht mit anderen Replikaten (Namen, Endpunkte, Modi) - nicht still geändert; nichts geändert', 1;`,
      // Bereitschaft der Datenbanken VOR jeder Änderung — erst danach läuft der Sekundär (der dort eine alte Kopie entfernen darf)
      ...dbBereitschaft(ag, p.datenbanken, 50211),
    ] : [
      `IF ${agDa(ag)} AND ISNULL(${lokaleRolle(ag)}, N'') = N'PRIMARY' THROW 50210, N'${ich} ist Primär von ${ag} - als ${rolle === 'sekundaer' ? 'Sekundär' : 'Konfig'} nichts geändert', 1;`,
      // Sekundär: je Datenbank der Liste, die hier besteht — in dieser AG oder RESTORING ohne AG (wird in rp_aendern entfernt) ist in Ordnung,
      // eine andere AG oder jeder andere Zustand bricht ab (nie still gelöscht)
      ...(rolle === 'sekundaer' ? p.datenbanken.flatMap(d => [
        `IF EXISTS (SELECT 1 FROM sys.databases s LEFT JOIN sys.availability_replicas r ON r.replica_id = s.replica_id LEFT JOIN sys.availability_groups g ON g.group_id = r.group_id WHERE s.name = N'${d}' AND s.replica_id IS NOT NULL AND ISNULL(g.name, N'') <> N'${ag}')`,
        `  BEGIN SELECT TOP 1 @m = N'${d} gehört auf ${ich} zur Verfügbarkeitsgruppe ' + ISNULL(g.name, N'?') + N'; nichts geändert' FROM sys.databases s LEFT JOIN sys.availability_replicas r ON r.replica_id = s.replica_id LEFT JOIN sys.availability_groups g ON g.group_id = r.group_id WHERE s.name = N'${d}'; THROW 50212, @m, 1; END`,
        `IF EXISTS (SELECT 1 FROM sys.databases WHERE name = N'${d}' AND replica_id IS NULL AND state_desc <> N'RESTORING')`,
        `  BEGIN SELECT TOP 1 @m = N'${d} besteht auf ${ich} als ' + state_desc COLLATE DATABASE_DEFAULT + N' außerhalb der AG - nie still gelöscht; nichts geändert' FROM sys.databases WHERE name = N'${d}'; THROW 50213, @m, 1; END`,
      ]) : []),
    ]),
    "SELECT 'ALFRED|ok';",
  ].join('\n');
  const aendern = [
    AG_KOPF('rp_aendern'),
    "DECLARE @a varchar(4000) = '', @sql nvarchar(max);",
    // Login (Kennwort unbekannt, nie ausgegeben — die Anmeldung läuft nur über das Zertifikat), Benutzer, öffentliches Zertifikat, CONNECT
    ...p.peers.flatMap(x => [
      `IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'${zn(x.name)}') BEGIN BEGIN TRY SET @sql = N'CREATE LOGIN [${zn(x.name)}] WITH PASSWORD = N''Ag!' + REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'') + N'z9'', CHECK_POLICY = OFF'; EXEC (@sql); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' login-${x.name}'; PRINT 'ALFRED-ERLEDIGT login-${x.name}'; END`,
      `IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'${zn(x.name)}') BEGIN BEGIN TRY EXEC (N'CREATE USER [${zn(x.name)}] FOR LOGIN [${zn(x.name)}]'); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' benutzer-${x.name}'; PRINT 'ALFRED-ERLEDIGT benutzer-${x.name}'; END`,
      `IF NOT EXISTS (SELECT 1 FROM sys.certificates WHERE name = N'${zn(x.name)}') BEGIN BEGIN TRY EXEC (N'CREATE CERTIFICATE [${zn(x.name)}] AUTHORIZATION [${zn(x.name)}] FROM BINARY = 0x${x.zertifikat}'); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' zertifikat-${x.name}'; PRINT 'ALFRED-ERLEDIGT zertifikat-${x.name}'; END`,
      `IF NOT ${connectDa(x.name)} BEGIN BEGIN TRY EXEC (N'GRANT CONNECT ON ENDPOINT::[${EPN}] TO [${zn(x.name)}]'); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' connect-${x.name}'; PRINT 'ALFRED-ERLEDIGT connect-${x.name}'; END`,
    ]),
    ...(rolle === 'primaer' ? [
      `IF NOT ${agDa(ag)} BEGIN BEGIN TRY EXEC (N'${anlegen}'); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' ag-angelegt'; PRINT 'ALFRED-ERLEDIGT ag-angelegt'; END`,
      'ELSE',
      'BEGIN',
      `  IF (SELECT required_synchronized_secondaries_to_commit FROM sys.availability_groups WHERE name = N'${ag}') <> 0 BEGIN BEGIN TRY EXEC (N'ALTER AVAILABILITY GROUP [${ag}] SET (REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT = 0)'); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' required-sync-0'; PRINT 'ALFRED-ERLEDIGT required-sync-0'; END`,
      `  IF (SELECT UPPER(automated_backup_preference_desc) FROM sys.availability_groups WHERE name = N'${ag}') <> N'PRIMARY' BEGIN BEGIN TRY EXEC (N'ALTER AVAILABILITY GROUP [${ag}] SET (AUTOMATED_BACKUP_PREFERENCE = PRIMARY)'); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' sicherungsvorgabe-primary'; PRINT 'ALFRED-ERLEDIGT sicherungsvorgabe-primary'; END`,
      'END',
    ] : rolle === 'sekundaer' ? [
      // VOR dem Beitritt: zurückgebliebene Kopie (RESTORING ohne AG) sichtbar entfernen — der Primär hat im selben Lauf die Datenbank
      // ONLINE/FULL/mit Log-Kette gezeigt; das Seeding legt sie neu an. Kein anderer Zustand wird je gelöscht.
      ...p.datenbanken.map(d => `IF ${alteKopie(d)} BEGIN BEGIN TRY EXEC (N'DROP DATABASE [${d}]'); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' alte-kopie-entfernt-${d}'; PRINT 'ALFRED-ERLEDIGT alte-kopie-entfernt-${d}'; END`),
      `IF NOT ${agDa(ag)} BEGIN BEGIN TRY EXEC (N'ALTER AVAILABILITY GROUP [${ag}] JOIN WITH (CLUSTER_TYPE = EXTERNAL)'); END TRY BEGIN CATCH THROW; END CATCH; PRINT 'ALFRED-ERLEDIGT beigetreten'; BEGIN TRY EXEC (N'ALTER AVAILABILITY GROUP [${ag}] GRANT CREATE ANY DATABASE'); END TRY BEGIN CATCH THROW; END CATCH; PRINT 'ALFRED-ERLEDIGT seeding-erlaubt'; SET @a += ' beigetreten seeding-erlaubt'; END`,
      // nach einem abgebrochenen Lauf: Datenbanken der AG fehlen hier noch → Seeding (wieder) erlauben, sichtbar
      `ELSE IF EXISTS (SELECT 1 FROM sys.availability_databases_cluster c JOIN sys.availability_groups g ON g.group_id = c.group_id WHERE g.name = N'${ag}' AND DB_ID(c.database_name) IS NULL)`,
      `  BEGIN BEGIN TRY EXEC (N'ALTER AVAILABILITY GROUP [${ag}] GRANT CREATE ANY DATABASE'); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' seeding-erlaubt'; PRINT 'ALFRED-ERLEDIGT seeding-erlaubt'; END`,
    ] : [
      `IF NOT ${agDa(ag)} BEGIN BEGIN TRY EXEC (N'ALTER AVAILABILITY GROUP [${ag}] JOIN WITH (CLUSTER_TYPE = EXTERNAL)'); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' beigetreten'; PRINT 'ALFRED-ERLEDIGT beigetreten'; END`,
    ]),
    `IF ${agDa(ag)} AND ${pmAgRechte} < 3 BEGIN BEGIN TRY EXEC (N'GRANT ALTER, CONTROL, VIEW DEFINITION ON AVAILABILITY GROUP::[${ag}] TO [${PML}]'); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' pacemaker-ag-rechte'; PRINT 'ALFRED-ERLEDIGT pacemaker-ag-rechte'; END`,
    "SELECT 'ALFRED|' + LTRIM(@a);",
  ].join('\n');
  const selbst = [
    AG_KOPF('rp_selbst'),
    "DECLARE @f nvarchar(2000) = N'';",
    ...p.peers.flatMap(x => [
      `IF NOT EXISTS (SELECT 1 FROM sys.certificates c JOIN sys.database_principals u ON u.principal_id = c.principal_id JOIN sys.server_principals l ON l.sid = u.sid WHERE c.name = N'${zn(x.name)}' AND CONVERT(varchar(64), c.thumbprint, 2) = '${x.fingerabdruck}' AND c.pvt_key_encryption_type = 'NA' AND u.name = N'${zn(x.name)}' AND l.name = N'${zn(x.name)}') SET @f += N' Zertifikat/Benutzer/Login ${zn(x.name)} fehlt oder weicht ab;';`,
      `IF NOT ${connectDa(x.name)} SET @f += N' CONNECT auf ${EPN} für ${zn(x.name)} fehlt;';`,
    ]),
    `IF NOT ${agDa(ag)} SET @f += N' ${ag} fehlt auf ${ich};';`,
    ...(rolle === 'primaer' ? [
      `IF ${agDa(ag)} AND (SELECT required_synchronized_secondaries_to_commit FROM sys.availability_groups WHERE name = N'${ag}') <> 0 SET @f += N' REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT ist nicht 0;';`,
      `IF ${agDa(ag)} AND (SELECT UPPER(automated_backup_preference_desc) FROM sys.availability_groups WHERE name = N'${ag}') <> N'PRIMARY' SET @f += N' AUTOMATED_BACKUP_PREFERENCE ist nicht PRIMARY;';`,
    ] : rolle === 'konfig' ? [
      `IF NOT EXISTS (SELECT 1 ${reps} AND r.replica_server_name = N'${ich}' AND r.availability_mode_desc = N'CONFIGURATION_ONLY') SET @f += N' ${ich} ist kein CONFIGURATION_ONLY-Replikat von ${ag};';`,
    ] : p.datenbanken.map(d => `IF ${alteKopie(d)} SET @f += N' alte Kopie ${d} (RESTORING ohne AG) besteht noch;';`)),
    `IF ${agDa(ag)} AND ${pmAgRechte} < 3 SET @f += N' Rechte von ${PML} auf ${ag} fehlen;';`,
    "IF @f <> N'' THROW 50290, @f, 1;",
    `SELECT 'ALFRED|' + ISNULL(${lokaleRolle(ag)}, '-');`,
  ].join('\n');
  return { pruefen, aendern, selbst };
}

function tsqlAbschluss(p: HaAgAbschlussParameter): Record<'pruefen' | 'dbs' | 'sync' | 'selbst', string> {
  const { ag, besetzung: b, datenbanken } = p;
  // Zustand je Datenbank auf dem Sekundär (OUTER APPLY — eine Unterabfrage in SUM/STRING_AGG lehnt SQL Server ab, Fehler 130)
  const syncAgg = `SELECT @n = SUM(CASE WHEN s.st = N'SYNCHRONIZED' THEN 1 ELSE 0 END), @l = STRING_AGG(CAST(d.n + N'=' + ISNULL(s.st, N'FEHLT') AS varchar(300)), ',') WITHIN GROUP (ORDER BY d.n) `
    + `FROM @dbs d OUTER APPLY (SELECT TOP 1 UPPER(x.synchronization_state_desc) AS st FROM sys.dm_hadr_database_replica_states x JOIN sys.availability_replicas r ON r.replica_id = x.replica_id WHERE x.database_id = DB_ID(d.n) AND r.replica_server_name = N'${b.sekundaer}') s;`;
  const repZustand = (n: string, spalte: string) => `ISNULL((SELECT UPPER(rs.${spalte}) FROM sys.dm_hadr_availability_replica_states rs JOIN sys.availability_replicas r ON r.replica_id = rs.replica_id WHERE r.group_id = g.group_id AND r.replica_server_name = N'${n}'), '-')`;
  return {
    pruefen: [
      AG_KOPF('ab_pruefen'),
      "DECLARE @m nvarchar(2048), @f nvarchar(2000) = N'';",
      servername(b.primaer),
      `IF NOT ${agDa(ag)} THROW 50301, N'${ag} fehlt auf ${b.primaer} - erst der Replikat-Schritt; nichts geändert', 1;`,
      `IF ISNULL(${lokaleRolle(ag)}, N'') <> N'PRIMARY' THROW 50302, N'${b.primaer} ist nicht Primär von ${ag}; nichts geändert', 1;`,
      // dieselben Prüfungen wie rp_pruefen auf dem Primär — der Abschluss kann ohne vorherigen Replikat-Lauf wiederholt werden
      ...dbBereitschaft(ag, datenbanken, 50303),
      "SELECT 'ALFRED|ok';",
    ].join('\n'),
    dbs: [
      AG_KOPF('ab_dbs'),
      "DECLARE @a varchar(2000) = '';",
      ...datenbanken.map(d => `IF NOT EXISTS (SELECT 1 FROM sys.availability_databases_cluster c JOIN sys.availability_groups g ON g.group_id = c.group_id WHERE g.name = N'${ag}' AND c.database_name = N'${d}') BEGIN BEGIN TRY EXEC (N'ALTER AVAILABILITY GROUP [${ag}] ADD DATABASE [${d}]'); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' db-${d}'; PRINT 'ALFRED-ERLEDIGT db-${d}'; END`),
      "SELECT 'ALFRED|' + @a;",
    ].join('\n'),
    sync: [
      AG_KOPF('ab_sync'),
      "DECLARE @n int, @l varchar(4000);",
      dbTabelle(datenbanken),
      syncAgg,
      "SELECT 'ALFRED|' + CAST(ISNULL(@n, 0) AS varchar(10)) + '|' + ISNULL(@l, '-');",
    ].join('\n'),
    selbst: [
      AG_KOPF('ab_selbst'),
      "DECLARE @n int, @l varchar(4000);",
      dbTabelle(datenbanken),
      syncAgg,
      `SELECT 'ALFRED|' + UPPER(g.cluster_type_desc) + '|' + CAST(g.required_synchronized_secondaries_to_commit AS varchar(5)) + '|' + UPPER(g.automated_backup_preference_desc) + '|'`,
      `  + ${repZustand(b.primaer, 'role_desc')} + '|' + ${repZustand(b.sekundaer, 'role_desc')} + '|' + ${repZustand(b.sekundaer, 'connected_state_desc')} + '|'`,
      `  + ISNULL((SELECT UPPER(r.availability_mode_desc) FROM sys.availability_replicas r WHERE r.group_id = g.group_id AND r.replica_server_name = N'${b.konfig}'), '-') + '|'`,
      `  + CAST(ISNULL(@n, 0) AS varchar(10)) + '|' + ISNULL(@l, '-') FROM sys.availability_groups g WHERE g.name = N'${ag}';`,
    ].join('\n'),
  };
}

function tsqlEntfernen(p: HaAgEntfernenParameter): Record<'lage' | 'waisen' | 'drop' | 'aufraeumen' | 'selbst', string> {
  const { ag, besetzung: b, rolle, knoten } = p;
  const ich = b[rolle];
  const peers = knoten.map(k => k.name).filter(n => n !== ich);
  const weg = (art: 'CERTIFICATE' | 'USER' | 'LOGIN', katalog: string, name: string, kennung: string) =>
    `IF EXISTS (SELECT 1 FROM ${katalog} WHERE name = N'${name}') BEGIN BEGIN TRY EXEC (N'DROP ${art} [${name}]'); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' ${kennung}'; PRINT 'ALFRED-ERLEDIGT ${kennung}'; END`;
  return {
    // Fix-Runde 1 (I3): Datenbanken im Zustand RESTORING ohne AG (Wiederholung auf dem Primär ohne Merkdatei — nie still übergehen)
    waisen: [
      AG_KOPF('en_waisen'),
      "SELECT 'ALFRED|' + ISNULL((SELECT STRING_AGG(CAST(name AS varchar(200)), ',') WITHIN GROUP (ORDER BY name) FROM sys.databases WHERE state_desc = N'RESTORING' AND replica_id IS NULL), '-');",
    ].join('\n'),
    lage: [
      AG_KOPF('en_lage'),
      `SELECT 'ALFRED|' + ISNULL(${lokaleRolle(ag)}, CASE WHEN ${agDa(ag)} THEN 'UNBEKANNT' ELSE '-' END) + '|'`,
      `  + ISNULL((SELECT STRING_AGG(CAST(c.database_name AS varchar(200)), ',') WITHIN GROUP (ORDER BY c.database_name) FROM sys.availability_databases_cluster c JOIN sys.availability_groups g ON g.group_id = c.group_id WHERE g.name = N'${ag}'), '-');`,
    ].join('\n'),
    // Rolle VOR dem Entfernen der Pacemaker-Ressourcen (@@ROLLE@@): nur der bisherige Primär holt RESTORING-Datenbanken zurück
    drop: [
      AG_KOPF('en_drop'),
      "DECLARE @a varchar(2000) = '', @n sysname, @sql nvarchar(max);",
      'DECLARE @dbs TABLE (n sysname);',
      `INSERT @dbs (n) SELECT c.database_name FROM sys.availability_databases_cluster c JOIN sys.availability_groups g ON g.group_id = c.group_id WHERE g.name = N'${ag}';`,
      // Fix-Runde 1 (I3): dazu die gemerkten Datenbanken eines früheren, nach DROP abgebrochenen Laufs (@@DBS@@ aus der Merkdatei)
      "INSERT @dbs (n) SELECT s.name FROM sys.databases s WHERE s.name IN (@@DBS@@) AND NOT EXISTS (SELECT 1 FROM @dbs x WHERE x.n = s.name COLLATE DATABASE_DEFAULT);",
      `IF ${agDa(ag)} BEGIN BEGIN TRY EXEC (N'DROP AVAILABILITY GROUP [${ag}]'); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' ag-entfernt'; PRINT 'ALFRED-ERLEDIGT ag-entfernt'; END`,
      "IF '@@ROLLE@@' = 'PRIMARY'",
      'BEGIN',
      "  DECLARE d CURSOR LOCAL FAST_FORWARD FOR SELECT x.n FROM @dbs x JOIN sys.databases s ON s.name = x.n COLLATE DATABASE_DEFAULT WHERE s.state_desc = N'RESTORING' AND s.replica_id IS NULL;",
      '  OPEN d; FETCH NEXT FROM d INTO @n;',
      "  WHILE @@FETCH_STATUS = 0 BEGIN SET @sql = N'RESTORE DATABASE ' + QUOTENAME(@n) + N' WITH RECOVERY'; BEGIN TRY EXEC (@sql); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' db-online-' + CAST(@n AS varchar(128)); PRINT 'ALFRED-ERLEDIGT db-online-' + CAST(@n AS varchar(128)); FETCH NEXT FROM d INTO @n; END",
      '  CLOSE d; DEALLOCATE d;',
      'END',
      "SELECT 'ALFRED|' + LTRIM(@a);",
    ].join('\n'),
    aufraeumen: [
      AG_KOPF('en_aufraeumen'),
      "DECLARE @a varchar(2000) = '';",
      `IF ${agDa(ag)} THROW 50401, N'${ag} besteht noch - Endpunkt und Zertifikate bleiben', 1;`,
      `IF EXISTS (SELECT 1 FROM sys.database_mirroring_endpoints WHERE name = N'${EPN}') BEGIN BEGIN TRY EXEC (N'DROP ENDPOINT [${EPN}]'); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' endpunkt-entfernt'; PRINT 'ALFRED-ERLEDIGT endpunkt-entfernt'; END`,
      ...peers.flatMap(n => [weg('CERTIFICATE', 'sys.certificates', zn(n), `zertifikat-${n}-entfernt`), weg('USER', 'sys.database_principals', zn(n), `benutzer-${n}-entfernt`), weg('LOGIN', 'sys.server_principals', zn(n), `login-${n}-entfernt`)]),
      weg('CERTIFICATE', 'sys.certificates', zn(ich), 'zertifikat-entfernt'),
      weg('LOGIN', 'sys.server_principals', PML, 'pacemaker-login-entfernt'),
      "SELECT 'ALFRED|' + LTRIM(@a);",
    ].join('\n'),
    selbst: [
      AG_KOPF('en_selbst'),
      `SELECT 'ALFRED|' + CAST((SELECT COUNT(*) FROM sys.availability_groups WHERE name = N'${ag}') + (SELECT COUNT(*) FROM sys.database_mirroring_endpoints WHERE name = N'${EPN}')`,
      `  + (SELECT COUNT(*) FROM sys.certificates WHERE name LIKE N'alfred[_]ag[_]%') + (SELECT COUNT(*) FROM sys.database_principals WHERE name LIKE N'alfred[_]ag[_]%')`,
      `  + (SELECT COUNT(*) FROM sys.server_principals WHERE name = N'${PML}' OR name LIKE N'alfred[_]ag[_]%') AS varchar(10)) + '|'`,
      "  + ISNULL((SELECT STRING_AGG(CAST(name COLLATE DATABASE_DEFAULT + N'=' + state_desc COLLATE DATABASE_DEFAULT AS varchar(300)), ',') WITHIN GROUP (ORDER BY name) FROM sys.databases WHERE name IN (@@DBS@@)), '-');",
    ].join('\n'),
  };
}

/** python3: crm_mon-XML → „<Promoted-Knoten> <VIP-Knoten>“ (lage) bzw. CIB-Constraints → „<Kolokation 0|1> <Reihenfolge 0|1>“ (regeln) */
export const PY_AG_PCS = String.raw`import re, sys, xml.etree.ElementTree as ET
c = sys.argv[1]
try:
    r = ET.fromstring(sys.stdin.read())
except Exception:
    sys.exit(2)
if c == "lage":
    ag, vip = sys.argv[2], sys.argv[3]
    prom, vn = set(), set()
    for x in r.iter("resource"):
        if x.get("active", "true") != "true" or x.get("failed", "false") == "true":
            continue
        kn = [n.get("name") for n in x.findall("node") if n.get("name")]
        if x.get("id") == ag and x.get("role") in ("Promoted", "Master"):
            prom.update(kn)
        if x.get("id") == vip and x.get("role") == "Started":
            vn.update(kn)
    print(",".join(sorted(prom)) or "-", ",".join(sorted(vn)) or "-")
elif c == "regeln":
    vip, klon = sys.argv[2], sys.argv[3]
    ko = any(x.get("rsc") == vip and x.get("with-rsc") == klon and x.get("with-rsc-role") in ("Promoted", "Master") and x.get("score") in ("INFINITY", "+INFINITY") for x in r.iter("rsc_colocation"))
    od = any(x.get("first") == klon and x.get("first-action") == "promote" and x.get("then") == vip and x.get("then-action", "start") == "start" for x in r.iter("rsc_order"))
    print(1 if ko else 0, 1 if od else 0)
elif c == "standort":
    # Task 6: Standort-Bedingungen der AG-Ressourcen — „<cli> <andere> <id@knoten,…|->“ (cli-prefer/cli-ban stammen von pcs resource move/ban)
    namen = set(sys.argv[2:])
    cli, andere, liste = 0, 0, []
    for x in r.iter("rsc_location"):
        if x.get("rsc") not in namen:
            continue
        i = re.sub(r"[^A-Za-z0-9_.-]", "_", x.get("id") or "?")
        if i.startswith("cli-prefer-") or i.startswith("cli-ban-"):
            cli += 1
        else:
            andere += 1
        liste.append(i + "@" + re.sub(r"[^A-Za-z0-9_.-]", "_", x.get("node") or "regel"))
    print(cli, andere, ",".join(liste) or "-")
else:
    sys.exit(3)`;

/** Pfade und Wartezeiten der AG-Bausteine — vor der Marke, damit Tests sie umbiegen können */
const AG_PFADE = [
  `PM_DATEI=${shQ(HA_PACEMAKER_DATEI)}`,
  // warte_pacemaker / warte_weg: Runden à 2 s (120 s); warte_sync: Runden à 2 s (300 s, Seeding)
  'WARTE_RUNDEN=60',
  'SYNC_RUNDEN=150',
];

const AG_HILFEN = sh(String.raw`GEAENDERT=0; AJ=''; ZEILE=''; UNSICHER=''
SA=''; HS=''; PM=''; HS_SQL=''; PM_SQL=''
aend() { GEAENDERT=1; AJ+="§{AJ:+,}\"$1\""; }
# Stand für Fehlermeldungen: jede gemeldete Änderung; brach ein ändernder T-SQL-Block ab, steht das dabei (dann nie „nichts geändert“)
stand() {
  local t='nichts geändert'
  if [ "$GEAENDERT" = 1 ]; then t="bisher geändert: $(printf '%s' "$AJ" | tr -d '"')"; elif [ -n "$UNSICHER" ]; then t='bisher keine Änderung gemeldet'; fi
  if [ -n "$UNSICHER" ]; then t+="; $UNSICHER"; fi
  printf '%s' "$t"
}
eigener_name() { hostname -s; }
# Geheimnisse wörtlich aus Fehlertexten entfernen — roh und in der T-SQL-Form (' verdoppelt; beim Tresor-Alphabet ohne ' identisch)
schwaerze_geheim() { local t=$1 g; for g in "$SA" "$HS" "$PM" "$HS_SQL" "$PM_SQL"; do if [ §{#g} -ge 4 ]; then t=§{t//"$g"/[geschwärzt]}; fi; done; printf '%s' "$t"; }
# im abgebrochenen Block schon ausgeführte Anlage mit neuem Kennwort → dieselbe Marke wie im Erfolgsfall (der Skill legt es in den Tresor)
erledigt_marke() { case "$1" in masterkey) echo ALFRED-MASTERKEY-GESETZT ;; pacemaker-login) echo ALFRED-PACEMAKER-GESETZT ;; esac; }
# Geheimnis aus der ersten stdin-Zeile (JSON-Feld $1) in die Variable $2 — nur druckbare Zeichen, nie Befehlszeile oder Ausgabe
geheim_lesen() {
  local v
  v=$(feld "$1") || abbruch "$3 enthält nicht druckbare Zeichen — nichts geändert"
  [ -n "$v" ] || abbruch "$3 fehlt in der Eingabe (erste stdin-Zeile, JSON-Feld $1) — nichts geändert"
  [[ "$v" =~ ^[[:print:]]+$ ]] || abbruch "$3 enthält nicht druckbare Zeichen — nichts geändert"
  printf -v "$2" '%s' "$v"
}
# Kennwörter für T-SQL (' verdoppelt) und Einsetzen in die Vorlagen (@@HS@@ Master-Key, @@PM@@ Pacemaker-Login)
geheim_sql() { local q="'"; HS_SQL=§{HS//"$q"/"$q$q"}; PM_SQL=§{PM//"$q"/"$q$q"}; }
mit_geheim() { local t=$1; t=§{t//@@HS@@/"$HS_SQL"}; t=§{t//@@PM@@/"$PM_SQL"}; printf '%s' "$t"; }
# T-SQL ausführen; Ergebniszeile „ALFRED|…“ in ZEILE, sonst sichtbarer Abbruch (Ausgabe geschwärzt). $3 = aendernd: in den ändernden
# Blöcken steht jede Änderung in BEGIN TRY … END TRY BEGIN CATCH THROW; END CATCH — ein Fehler beendet den ganzen Block (THROW ohne
# äußeres TRY beendet den Batch), bevor ihr PRINT „ALFRED-ERLEDIGT <x>“ läuft; ohne Fehler meldet sich jede Änderung per PRINT. Es gibt
# keine Transaktion: die vorher gemeldeten Änderungen bleiben wirksam und stehen in den Änderungen, danach lief nichts mehr
# (Fix-Runde 2 — ohne TRY/CATCH hätte ein Fehler der Schwere 16 nur die Anweisung beendet und der Block wäre weitergelaufen)
sql_lauf() {
  local a x
  if ! a=$(sql "$1" 2>&1); then
    if [ "§{3:-}" = aendernd ]; then
      for x in $(printf '%s\n' "$a" | sed -n 's/^ALFRED-ERLEDIGT //p' | tr -d '\r'); do aend "$x"; erledigt_marke "$x"; done
      UNSICHER="Block „$2“ am ersten Fehler beendet — die vorher als erledigt gemeldeten Änderungen bleiben wirksam (keine Transaktion), danach lief nichts mehr"
    fi
    abbruch "$2: $(kurz "$(schwaerze_geheim "$(printf '%s\n' "$a" | grep -v '^ALFRED-ERLEDIGT ' || true)")") — $(stand)"
  fi
  ZEILE=$(alfred_zeile "$a")
  [ -n "$ZEILE" ] || abbruch "$2: keine Ergebniszeile: $(kurz "$(schwaerze_geheim "$a")") — $(stand)"
}
befehl_da() { command -v "$1" >/dev/null 2>&1; }
# eigener Rechner = erwarteter Knoten; Programme der AG-Bausteine (sqlcmd aus mssql-tools18) vorhanden — beides vor jeder SQL-Zeile
knoten_ich() {
  local b f=''
  ICH=$(eigener_name); [ "$ICH" = "$ICH_SOLL" ] || abbruch "Zugang zeigt auf $ICH, erwartet $ICH_SOLL ($ROLLE) — keine SQL-Zeile ausgeführt, nichts geändert"
  for b in "§{AG_BEFEHLE[@]}"; do befehl_da "$b" || f+="§{f:+, }$b"; done
  [ -z "$f" ] || abbruch "$f fehlt auf $ICH — vorher linux_sql installieren (mssql-tools18); keine SQL-Zeile ausgeführt, nichts geändert"
}
# Pacemaker: Ressource vorhanden, Parameter/Meta-Attribut lesen, Constraints und Lage (Promoted-Knoten, VIP-Knoten)
ressource_da() { crm_resource --resource "$1" --query-xml >/dev/null 2>&1; }
parameter() { local v; v=$(crm_resource --resource "$1" --get-parameter "$2" 2>/dev/null) || v=''; printf '%s' "$v" | tail -n 1 | tr -d '[:space:]'; }
meta() { local v; v=$(crm_resource --resource "$1" --meta --get-parameter "$2" 2>/dev/null) || v=''; printf '%s' "$v" | tail -n 1 | tr -d '[:space:]'; }
ag_pcs_py() { python3 -c "$PY_AG_PCS" "$@"; }
regeln() { local x; x=$(cibadmin --query --scope constraints 2>/dev/null) || { echo '0 0'; return 0; }; ag_pcs_py regeln "$VIP_RES" "$AG_KLON" <<<"$x" 2>/dev/null || echo '0 0'; }
pm_lage() { local x l='- -'; if x=$(crm_mon -1 --output-as=xml 2>/dev/null); then l=$(ag_pcs_py lage "$AG_RES" "$VIP_RES" <<<"$x" 2>/dev/null || echo '- -'); fi; read -r PROM VIPN <<<"$l"; }
warte_pacemaker() { local i; for i in $(seq 1 "$WARTE_RUNDEN"); do pm_lage; if [ "$PROM" = "$ICH" ] && [ "$VIPN" = "$ICH" ]; then return 0; fi; sleep 2; done; return 1; }
warte_weg() { local i; for i in $(seq 1 "$WARTE_RUNDEN"); do if ! ressource_da "$AG_RES" && ! ressource_da "$VIP_RES"; then return 0; fi; sleep 2; done; return 1; }
cluster_lage() { local x l=''; if x=$(crm_mon -1 --output-as=xml 2>/dev/null); then l=$(python3 -c "$PY_CRM_LAGE" <<<"$x" 2>/dev/null || true); fi; read -r LK LO LQ LS LR LN <<<"§{l:-0 0 0 0 0 -}"; }
vip_lokal() { ip -o -4 addr show 2>/dev/null | grep -qF " $VIP_IP/$VIP_PRAEFIX "; }
# „a=SYNCHRONIZED,b=…“ → JSON-Liste [{name, zustand}] (Namen geprüft, Zustände aus SQL nur [A-Z_ ])
db_json() { local x n s j=''; [ "$1" = - ] || [ -z "$1" ] || { local IFS=','; for x in $1; do n=§{x%%=*}; s=§{x#*=}; [[ "$n" =~ ^[A-Za-z0-9_]+$ ]] || n='?'; [[ "$s" =~ ^[A-Za-z_\ ]+$ ]] || s='?'; j+="§{j:+,}{\"name\":\"$n\",\"zustand\":\"$s\"}"; done; }; printf '[%s]' "$j"; }`);

function agKopf(baustein: string, p: Record<string, unknown>, ag: string, rolle: HaAgRolle | 'failover-ziel', ich: string): string[] {
  return [
    ...sqlKopf(baustein, p, 'ALFRED-HA'),
    ...SQL_HILFE,
    `AG=${shQ(ag)}`,
    `ROLLE=${shQ(rolle)}`,
    `ICH_SOLL=${shQ(ich)}`,
    `PM_LOGIN=${shQ(HA_PACEMAKER_LOGIN)}`,
    `AG_RES=${shQ(HA_AG_RESSOURCE)}`,
    `AG_KLON=${shQ(HA_AG_KLON)}`,
    `VIP_RES=${shQ(HA_AG_VIP_RESSOURCE)}`,
    `PY_AG_PCS=${shQ(PY_AG_PCS)}`,
    `PY_CRM_LAGE=${shQ(PY_CRM_LAGE)}`,
    `AG_BEFEHLE=(${HA_AG_BEFEHLE.map(shQ).join(" ")})`,
    ...AG_PFADE,
    AG_HILFEN,
  ];
}

const AG_ENDPUNKT_KOERPER = sh(String.raw`# ── Phase 1: prüfen — bis hierhin weder eine SQL-Zeile noch eine Änderung ──
knoten_ich
# Fencing-Gate (Task 4): ohne gültigen Beleg dieses Knotens keine SQL-Zeile (der Skill prüft vorher alle drei über linux_ha.status)
G=$(fpy grund "$BELEG_DATEI" "$TEST_DATEI" "$COROSYNC_CONF" "$AUTHKEY" "$SBD_KONF" "$ICH" "$CLUSTER" 2>&1) || abbruch "Fencing-Beleg auf $ICH nicht prüfbar ($(kurz "$G")) — keine SQL-Zeile ausgeführt, nichts geändert"
[ -z "$G" ] || abbruch "Fencing auf $ICH nicht belegt: $G — Verfügbarkeitsgruppe erst nach fencing_pruefen/fencing_belegen auf allen drei Knoten; keine SQL-Zeile ausgeführt, nichts geändert"
geheim_lesen sa SA "sa-Kennwort"
geheim_lesen hauptschluessel HS "Master-Key-Kennwort"
geheim_lesen pacemaker PM "Kennwort des Pacemaker-Logins"
geheim_sql
PM_DIR=$(dirname "$PM_DATEI")
[ -d "$PM_DIR" ] || abbruch "Verzeichnis $PM_DIR fehlt auf $ICH (mssql-server installiert?) — nichts geändert"
bereit || abbruch "SQL Server antwortet auf $ICH nicht als sa — nichts geändert"
sql_lauf "$(mit_geheim "$T_PRUEFEN")" "Prüfung auf $ICH"
# ── Phase 2: Master-Key, Pacemaker-Login, Zertifikat + Endpunkt (je eigener Block: eine Marke steht, sobald das Kennwort gesetzt ist) ──
sql_lauf "$(mit_geheim "$T_MASTERKEY")" "Master-Key auf $ICH" aendernd
IFS='|' read -r _ mk <<<"$ZEILE"
if [ "$mk" = 1 ]; then echo ALFRED-MASTERKEY-GESETZT; aend masterkey; fi
sql_lauf "$(mit_geheim "$T_LOGIN")" "Pacemaker-Login auf $ICH" aendernd
IFS='|' read -r _ pmneu a <<<"$ZEILE"
if [ "$pmneu" = 1 ]; then echo ALFRED-PACEMAKER-GESETZT; fi
for x in $a; do aend "$x"; done
sql_lauf "$T_ENDPUNKT" "Zertifikat und Endpunkt auf $ICH" aendernd
IFS='|' read -r _ a <<<"$ZEILE"
for x in $a; do aend "$x"; done
# Zugangsdatei des Resource-Agents: Login und Kennwort, 0600 root, atomar ersetzt (Inhalt nur über das printf-Builtin)
PM_INHALT=$(printf '%s\n%s' "$PM_LOGIN" "$PM")
if ! pm_datei_ok; then
  (umask 077; printf '%s\n' "$PM_INHALT" >"$PM_DATEI.alfred-neu")
  chown root:root "$PM_DATEI.alfred-neu"; chmod 0600 "$PM_DATEI.alfred-neu"; mv -f "$PM_DATEI.alfred-neu" "$PM_DATEI"
  aend pacemaker-zugangsdatei
fi
# ── Selbstprüfung ──
pm_datei_ok || abbruch "Selbstprüfung: Zugangsdatei $PM_DATEI nicht 0600 root oder mit anderem Inhalt — $(stand)"
sql_lauf "$(mit_geheim "$T_SELBST")" "Selbstprüfung auf $ICH"
IFS='|' read -r _ fp zert <<<"$ZEILE"
[[ "$fp" =~ ^[0-9A-F]{40,64}$ ]] || abbruch "Selbstprüfung: Fingerabdruck von alfred_ag_$ICH nicht lesbar — $(stand)"
[[ "$zert" =~ ^3082[0-9A-F]+$ ]] || abbruch "Selbstprüfung: öffentliches Zertifikat alfred_ag_$ICH nicht lesbar (kein DER) — $(stand)"
if [ "$GEAENDERT" = 1 ]; then Z=geaendert; else Z=schon; fi
ergebnis "{\"zustand\":\"$Z\",\"knoten\":\"$ICH\",\"rolle\":\"$ROLLE\",\"endpunkt\":\"$URL\",\"fingerabdruck\":\"$fp\",\"zertifikat\":\"$zert\",\"aenderungen\":[$AJ]}"`);

/**
 * AG-Schritt 1 je Knoten: lokales Fencing-Gate vor jeder SQL-Zeile, dann Master-Key (Kennwort aus dem Tresor; besteht er mit anderem
 * Kennwort → Abbruch), eigenes Endpunkt-Zertifikat alfred_ag_<knoten>, Endpunkt alfred_hadr (TCP 5022, Zertifikat, AES), Pacemaker-Login
 * mit VIEW SERVER STATE und Zugangsdatei. Ergebnis: öffentliches Zertifikat + Fingerabdruck. Marken ALFRED-MASTERKEY-GESETZT /
 * ALFRED-PACEMAKER-GESETZT, sobald ein neues Kennwort gesetzt ist. Zeit: LINUX_HA_ZEIT_MS.agEndpunkt
 */
export function haAgEndpunktSkript(p: HaAgEndpunktParameter): string {
  pruefe(pruefeHaAgEndpunkt(p));
  const ich = p.besetzung[p.rolle];
  const t = tsqlEndpunkt(ich);
  return [
    ...agKopf(LINUX_HA_BAUSTEINE.agEndpunkt, { cluster: p.cluster, ag: p.ag, besetzung: { ...p.besetzung }, rolle: p.rolle, knoten: p.knoten.map(x => ({ name: x.name, ip: x.ip })) }, p.ag, p.rolle, ich),
    `CLUSTER=${shQ(p.cluster)}`,
    `URL=${shQ(agUrl(p.knoten, ich))}`,
    `PY_FENCING=${shQ(PY_FENCING)}`,
    `T_PRUEFEN=${shQ(t.pruefen)}`, `T_MASTERKEY=${shQ(t.masterkey)}`, `T_LOGIN=${shQ(t.login)}`, `T_ENDPUNKT=${shQ(t.endpunkt)}`, `T_SELBST=${shQ(t.selbst)}`,
    'COROSYNC_CONF=/etc/corosync/corosync.conf',
    ...FENCING_PFADE,
    'fpy() { python3 -c "$PY_FENCING" "$@"; }',
    "datei_rechte() { stat -c '%u %a' \"$1\" 2>/dev/null || true; }",
    'pm_datei_ok() { [ -f "$PM_DATEI" ] && [ "$(datei_rechte "$PM_DATEI")" = \'0 600\' ] && [ "$(cat "$PM_DATEI")" = "$PM_INHALT" ]; }',
    '# ALFRED-ABLAUF',
    AG_ENDPUNKT_KOERPER,
  ].join('\n');
}

const AG_REPLIKAT_KOERPER = sh(String.raw`knoten_ich
geheim_lesen sa SA "sa-Kennwort"
bereit || abbruch "SQL Server antwortet auf $ICH nicht als sa — nichts geändert"
sql_lauf "$T_PRUEFEN" "Prüfung auf $ICH"
sql_lauf "$T_AENDERN" "Replikat ($ROLLE) auf $ICH" aendernd
IFS='|' read -r _ a <<<"$ZEILE"
for x in $a; do aend "$x"; done
# ── Selbstprüfung: Zertifikate/Logins/CONNECT der Peers, AG vorhanden; Rolle Primär bzw. (nach dem Beitritt, ggf. kurz RESOLVING) Sekundär ──
lokal=-
for i in $(seq 1 "$WARTE_RUNDEN"); do
  sql_lauf "$T_SELBST" "Selbstprüfung auf $ICH"
  IFS='|' read -r _ lokal <<<"$ZEILE"
  case "$ROLLE:$lokal" in primaer:PRIMARY|sekundaer:SECONDARY|konfig:*) break ;; esac
  sleep 2
done
case "$ROLLE:$lokal" in
  primaer:PRIMARY|sekundaer:SECONDARY|konfig:*) ;;
  *) abbruch "Selbstprüfung: $ICH hat in $AG die Rolle $lokal (erwartet $([ "$ROLLE" = primaer ] && echo PRIMARY || echo SECONDARY)) — $(stand)" ;;
esac
if [ "$GEAENDERT" = 1 ]; then Z=geaendert; else Z=schon; fi
ergebnis "{\"zustand\":\"$Z\",\"knoten\":\"$ICH\",\"rolle\":\"$ROLLE\",\"lokaleRolle\":\"$lokal\",\"aenderungen\":[$AJ]}"`);

/**
 * AG-Schritt 2 je Knoten (Primär, dann Sekundär, dann Konfig): öffentliche Zertifikate der beiden Peers (FROM BINARY) mit Login + Benutzer
 * und CONNECT auf alfred_hadr; Primär legt die AG an (EXTERNAL, REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT = 0, Sicherung PRIMARY,
 * Datenreplikate SYNCHRONOUS_COMMIT/EXTERNAL/AUTOMATIC, Konfig CONFIGURATION_ONLY), Sekundär tritt bei + GRANT CREATE ANY DATABASE,
 * Konfig tritt bei; überall Pacemaker-Rechte auf die AG. Primär prüft vorher die Bereitschaft der datenbanken (wie ab_pruefen); Sekundär
 * entfernt vor dem Beitritt eine alte Kopie im Zustand RESTORING ohne AG (alte-kopie-entfernt-<db>), jeder andere Zustand → Abbruch.
 * Bestehendes mit Abweichung → Abbruch ohne Änderung. Zeit: LINUX_HA_ZEIT_MS.agReplikat
 */
export function haAgReplikatSkript(p: HaAgReplikatParameter): string {
  pruefe(pruefeHaAgReplikat(p));
  const ich = p.besetzung[p.rolle];
  const t = tsqlReplikat(p);
  return [
    ...agKopf(LINUX_HA_BAUSTEINE.agReplikat, { ag: p.ag, besetzung: { ...p.besetzung }, rolle: p.rolle, knoten: p.knoten.map(x => ({ name: x.name, ip: x.ip })), peers: p.peers.map(x => ({ name: x.name, zertifikat: x.zertifikat, fingerabdruck: x.fingerabdruck })), datenbanken: [...p.datenbanken] }, p.ag, p.rolle, ich),
    `T_PRUEFEN=${shQ(t.pruefen)}`, `T_AENDERN=${shQ(t.aendern)}`, `T_SELBST=${shQ(t.selbst)}`,
    '# ALFRED-ABLAUF',
    AG_REPLIKAT_KOERPER,
  ].join('\n');
}

const AG_ABSCHLUSS_KOERPER = sh(String.raw`knoten_ich
geheim_lesen sa SA "sa-Kennwort"
# ── Phase 1: prüfen — Cluster 3/3 mit Quorum, AG hier Primär, Datenbanken bereit ──
cluster_lage
{ [ "$LO" = 3 ] && [ "$LQ" = 1 ]; } || abbruch "Cluster: $LO/3 online, Quorum $([ "$LQ" = 1 ] && echo ja || echo nein) — erwartet 3/3 mit Quorum; nichts geändert"
bereit || abbruch "SQL Server antwortet auf $ICH nicht als sa — nichts geändert"
sql_lauf "$T_PRUEFEN" "Prüfung auf $ICH"
# ── Phase 2: Datenbanken aufnehmen, Seeding abwarten (vor Pacemaker) ──
sql_lauf "$T_DBS" "Datenbanken in $AG aufnehmen" aendernd
IFS='|' read -r _ a <<<"$ZEILE"
for x in $a; do aend "$x"; done
SYNC_N=0; SYNC_LISTE=-
warte_sync() { local i; for i in $(seq 1 "$SYNC_RUNDEN"); do sql_lauf "$T_SYNC" "Synchronisierung lesen"; IFS='|' read -r _ SYNC_N SYNC_LISTE <<<"$ZEILE"; if [ "$SYNC_N" = "$DB_ANZAHL" ]; then return 0; fi; sleep 2; done; return 1; }
warte_sync || abbruch "Datenbanken auf $SEK nicht SYNCHRONIZED nach $((SYNC_RUNDEN * 2)) s: $SYNC_LISTE — Pacemaker-Ressourcen nicht angelegt; $(stand)"
# ── Phase 3: Pacemaker — ag_cluster (promotable), VIP erst deaktiviert, Constraints, dann VIP aktivieren ──
if ! ressource_da "$AG_RES"; then
  aus=$(pcs resource create "$AG_RES" ocf:mssql:ag "ag_name=$AG" required_synchronized_secondaries_to_commit=0 meta failure-timeout=60s promotable notify=true 2>&1) || abbruch "pcs resource create $AG_RES fehlgeschlagen: $(kurz "$aus") — $(stand); Rückweg ag_entfernen"
  aend ressource-ag
else
  an=$(parameter "$AG_RES" ag_name)
  [ "$an" = "$AG" ] || abbruch "Ressource $AG_RES verwaltet '§{an:-?}' statt $AG — nicht still geändert; $(stand)"
  if [ "$(parameter "$AG_RES" required_synchronized_secondaries_to_commit)" != 0 ]; then
    aus=$(pcs resource update "$AG_RES" required_synchronized_secondaries_to_commit=0 2>&1) || abbruch "pcs resource update $AG_RES fehlgeschlagen: $(kurz "$aus") — $(stand)"
    aend ressource-required-sync-0
  fi
fi
if ! ressource_da "$VIP_RES"; then
  aus=$(pcs resource create "$VIP_RES" ocf:heartbeat:IPaddr2 "ip=$VIP_IP" "cidr_netmask=$VIP_PRAEFIX" op monitor interval=30s --disabled 2>&1) || abbruch "pcs resource create $VIP_RES fehlgeschlagen: $(kurz "$aus") — $(stand); Rückweg ag_entfernen"
  aend ressource-vip
else
  vi=$(parameter "$VIP_RES" ip); vc=$(parameter "$VIP_RES" cidr_netmask)
  { [ "$vi" = "$VIP_IP" ] && [ "$vc" = "$VIP_PRAEFIX" ]; } || abbruch "Ressource $VIP_RES hat ip=§{vi:-?} cidr_netmask=§{vc:-?}, erwartet $VIP_IP/$VIP_PRAEFIX — nicht still geändert; $(stand)"
fi
read -r KO OD <<<"$(regeln)"
if [ "$KO" != 1 ]; then aus=$(pcs constraint colocation add "$VIP_RES" with Promoted "$AG_KLON" INFINITY 2>&1) || abbruch "Kolokation $VIP_RES mit Promoted $AG_KLON fehlgeschlagen: $(kurz "$aus") — $(stand)"; aend kolokation; fi
if [ "$OD" != 1 ]; then aus=$(pcs constraint order promote "$AG_KLON" then start "$VIP_RES" 2>&1) || abbruch "Reihenfolge promote $AG_KLON → start $VIP_RES fehlgeschlagen: $(kurz "$aus") — $(stand)"; aend reihenfolge; fi
read -r KO OD <<<"$(regeln)"
{ [ "$KO" = 1 ] && [ "$OD" = 1 ]; } || abbruch "Constraints nach dem Anlegen nicht in der CIB (Kolokation $KO, Reihenfolge $OD) — $(stand)"
if [ "$(meta "$VIP_RES" target-role)" = Stopped ]; then aus=$(pcs resource enable "$VIP_RES" 2>&1) || abbruch "pcs resource enable $VIP_RES fehlgeschlagen: $(kurz "$aus") — $(stand)"; aend vip-aktiviert; fi
warte_pacemaker || abbruch "Pacemaker: Promoted auf '$PROM', VIP auf '$VIPN' — erwartet beide auf $ICH; $(stand)"
# ── Selbstprüfung: SQL (EXTERNAL, required_sync 0, Sicherung PRIMARY, Rollen, SYNCHRONIZED) und Ressource (required_sync 0), VIP hier ──
sql_lauf "$T_SELBST" "Selbstprüfung auf $ICH"
IFS='|' read -r _ typ rs bp lokal sekrolle sekverb cfgmodus nsync liste <<<"$ZEILE"
[ "$typ" = EXTERNAL ] || abbruch "Selbstprüfung: CLUSTER_TYPE ist $typ, erwartet EXTERNAL — $(stand)"
[ "$rs" = 0 ] || abbruch "Selbstprüfung: REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT in SQL ist $rs, erwartet 0 — $(stand)"
[ "$bp" = PRIMARY ] || abbruch "Selbstprüfung: AUTOMATED_BACKUP_PREFERENCE ist $bp, erwartet PRIMARY — $(stand)"
[ "$lokal" = PRIMARY ] || abbruch "Selbstprüfung: $ICH ist $lokal, erwartet PRIMARY — $(stand)"
{ [ "$sekrolle" = SECONDARY ] && [ "$sekverb" = CONNECTED ]; } || abbruch "Selbstprüfung: $SEK ist $sekrolle/$sekverb, erwartet SECONDARY/CONNECTED — $(stand)"
[ "$cfgmodus" = CONFIGURATION_ONLY ] || abbruch "Selbstprüfung: $KONFIG ist $cfgmodus, erwartet CONFIGURATION_ONLY — $(stand)"
[ "$nsync" = "$DB_ANZAHL" ] || abbruch "Selbstprüfung: auf $SEK nicht alle Datenbanken SYNCHRONIZED: $liste — $(stand)"
rr=$(parameter "$AG_RES" required_synchronized_secondaries_to_commit)
[ "$rr" = 0 ] || abbruch "Selbstprüfung: required_synchronized_secondaries_to_commit an der Ressource $AG_RES ist '§{rr:-nicht gesetzt}', erwartet 0 — $(stand)"
pm_lage
{ [ "$PROM" = "$ICH" ] && [ "$VIPN" = "$ICH" ]; } || abbruch "Selbstprüfung: Promoted auf '$PROM', VIP auf '$VIPN' — erwartet $ICH; $(stand)"
vip_lokal || abbruch "Selbstprüfung: VIP $VIP_IP/$VIP_PRAEFIX ist auf $ICH nicht gebunden — $(stand)"
if [ "$GEAENDERT" = 1 ]; then Z=geaendert; else Z=schon; fi
ergebnis "{\"zustand\":\"$Z\",\"ag\":\"$AG\",\"primaer\":\"$ICH\",\"sekundaer\":\"$SEK\",\"konfig\":\"$KONFIG\",\"clusterTyp\":\"$typ\",\"requiredSyncSql\":$rs,\"requiredSyncRessource\":\"$rr\",\"sicherungVorgabe\":\"$bp\",\"datenbanken\":$(db_json "$liste"),\"vip\":\"$VIP_IP/$VIP_PRAEFIX\",\"vipAuf\":\"$VIPN\",\"promotedAuf\":\"$PROM\",\"aenderungen\":[$AJ]}"`);

/**
 * AG-Schritt 3 auf dem Primär: Cluster 3/3 mit Quorum, AG hier Primär; Datenbanken (vorhanden, ONLINE, FULL, Log-Kette begonnen, in keiner
 * anderen AG — sonst Abbruch ohne Änderung) aufnehmen, SYNCHRONIZED auf dem Sekundär abwarten; dann ag_cluster (ocf:mssql:ag,
 * required_synchronized_secondaries_to_commit=0, promotable), ag_vip (IPaddr2, deaktiviert angelegt), Kolokation mit Promoted,
 * Reihenfolge promote → start, VIP aktivieren. Selbstprüfung wie im Brief. Zeit: LINUX_HA_ZEIT_MS.agAbschluss
 */
export function haAgAbschlussSkript(p: HaAgAbschlussParameter): string {
  pruefe(pruefeHaAgAbschluss(p));
  const t = tsqlAbschluss(p);
  return [
    ...agKopf(LINUX_HA_BAUSTEINE.agAbschluss, { ag: p.ag, besetzung: { ...p.besetzung }, knoten: p.knoten.map(x => ({ name: x.name, ip: x.ip })), datenbanken: [...p.datenbanken], vip: { ip: p.vip.ip, praefix: p.vip.praefix } }, p.ag, 'primaer', p.besetzung.primaer),
    `SEK=${shQ(p.besetzung.sekundaer)}`,
    `KONFIG=${shQ(p.besetzung.konfig)}`,
    `VIP_IP=${shQ(p.vip.ip)}`,
    `VIP_PRAEFIX=${p.vip.praefix}`,
    `DB_ANZAHL=${p.datenbanken.length}`,
    `T_PRUEFEN=${shQ(t.pruefen)}`, `T_DBS=${shQ(t.dbs)}`, `T_SYNC=${shQ(t.sync)}`, `T_SELBST=${shQ(t.selbst)}`,
    '# ALFRED-ABLAUF',
    AG_ABSCHLUSS_KOERPER,
  ].join('\n');
}

const AG_ENTFERNEN_KOERPER = sh(String.raw`knoten_ich
geheim_lesen sa SA "sa-Kennwort"
bereit || abbruch "SQL Server antwortet auf $ICH nicht als sa — nichts geändert"
# Rolle und Datenbanken der AG VOR dem Entfernen der Ressourcen (Pacemaker stuft den Primär beim Löschen herab)
sql_lauf "$T_LAGE" "Lage auf $ICH"
IFS='|' read -r _ RV DBL <<<"$ZEILE"
case "$RV" in PRIMARY|SECONDARY|RESOLVING|UNBEKANNT|-) ;; *) RV=UNBEKANNT ;; esac
# Fix-Runde 1 (I3): Rolle und Datenbanken in einer Merkdatei (0600) festhalten, solange die AG besteht — bricht ein Lauf nach DROP ab,
# kennt die Wiederholung sie noch (sonst sähe sie „keine AG, keine Datenbanken“ und meldete RESTORING-Datenbanken nicht)
MERK_ALT=0
if [ "$RV" != - ]; then
  mkdir -p "$(dirname "$AG_MERK")"; (umask 077; printf '%s|%s\n' "$RV" "$DBL" >"$AG_MERK")
elif [ -f "$AG_MERK" ]; then
  IFS='|' read -r RV DBL <"$AG_MERK" || true
  case "$RV" in PRIMARY|SECONDARY|RESOLVING|UNBEKANNT) ;; *) RV=UNBEKANNT ;; esac
  [[ "$DBL" =~ ^[A-Za-z0-9_,-]*$ ]] || DBL=-
  MERK_ALT=1
fi
DBIN=''
if [ -n "$DBL" ] && [ "$DBL" != - ]; then IFS=',' read -r -a DBA <<<"$DBL"; for n in "§{DBA[@]}"; do if [[ "$n" =~ ^[A-Za-z0-9_]{1,128}$ ]]; then DBIN+="§{DBIN:+, }N'$n'"; fi; done; fi
[ -n "$DBIN" ] || DBIN="N''"
if [ "$RESSOURCEN" = 1 ]; then
  if ressource_da "$AG_RES" || ressource_da "$VIP_RES"; then
    case "$RV" in PRIMARY|-) ;; *) abbruch "$ICH ist nicht Primär von $AG ($RV) — ag_entfernen mit zugang = aktueller Primär (dort zuerst die Pacemaker-Ressourcen); nichts geändert" ;; esac
  fi
  if ressource_da "$VIP_RES"; then aus=$(pcs resource delete "$VIP_RES" 2>&1) || abbruch "pcs resource delete $VIP_RES fehlgeschlagen: $(kurz "$aus") — $(stand)"; aend ressource-vip-entfernt; fi
  if ressource_da "$AG_RES"; then aus=$(pcs resource delete "$AG_RES" 2>&1) || abbruch "pcs resource delete $AG_RES fehlgeschlagen: $(kurz "$aus") — $(stand)"; aend ressource-ag-entfernt; fi
  warte_weg || abbruch "Pacemaker-Ressourcen $AG_RES/$VIP_RES nach dem Entfernen noch vorhanden — $(stand)"
elif ressource_da "$AG_RES" || ressource_da "$VIP_RES"; then
  abbruch "Pacemaker-Ressourcen $AG_RES/$VIP_RES bestehen noch — zuerst ag_entfernen auf dem Primär (entfernt sie); nichts geändert"
fi
T_DROP=§{T_DROP//@@ROLLE@@/"$RV"}
sql_lauf "§{T_DROP//@@DBS@@/"$DBIN"}" "Verfügbarkeitsgruppe auf $ICH entfernen" aendernd
IFS='|' read -r _ a <<<"$ZEILE"
for x in $a; do aend "$x"; done
sql_lauf "$T_AUFRAEUMEN" "Endpunkt, Zertifikate und Logins auf $ICH entfernen" aendernd
IFS='|' read -r _ a <<<"$ZEILE"
for x in $a; do aend "$x"; done
if [ -e "$PM_DATEI" ]; then rm -f -- "$PM_DATEI"; aend pacemaker-zugangsdatei-entfernt; fi
# ── Selbstprüfung: nichts mehr von AG/Endpunkt/alfred_ag_*/alfred_pacemaker; Datenbanken bleiben (Zustand gemeldet) ──
sql_lauf "§{T_SELBST//@@DBS@@/"$DBIN"}" "Selbstprüfung auf $ICH"
IFS='|' read -r _ rest dbz <<<"$ZEILE"
[ "$rest" = 0 ] || abbruch "Selbstprüfung: auf $ICH bestehen noch $rest Objekte (AG, Endpunkt, alfred_ag_-Zertifikate/-Benutzer/-Logins, $PM_LOGIN) — $(stand)"
[ ! -e "$PM_DATEI" ] || abbruch "Selbstprüfung: $PM_DATEI besteht noch — $(stand)"
if [ "$RV" = PRIMARY ] && [ "$dbz" != - ]; then
  for x in §{dbz//,/ }; do [ "§{x#*=}" = ONLINE ] || abbruch "Selbstprüfung: Datenbanken auf dem bisherigen Primär nicht alle ONLINE: $dbz — RESTORE DATABASE … WITH RECOVERY bewusst entscheiden; $(stand)"; done
fi
# Rückfallnetz (I3): Wiederholung auf dem Primär ohne AG und ohne Merkdatei — RESTORING-Datenbanken ohne AG nie still übergehen
if [ "$ROLLE" = primaer ] && [ "$RV" = - ]; then
  sql_lauf "$T_WAISEN" "RESTORING-Datenbanken auf $ICH lesen"
  IFS='|' read -r _ waisen <<<"$ZEILE"
  [ "$waisen" = - ] || abbruch "Selbstprüfung: auf $ICH sind Datenbanken ohne AG im Zustand RESTORING ($waisen) und keine Merkdatei nennt die AG-Datenbanken — vermutlich aus $AG nach abgebrochenem Entfernen; RESTORE DATABASE … WITH RECOVERY bewusst entscheiden; $(stand)"
fi
rm -f -- "$AG_MERK"
if [ "$GEAENDERT" = 1 ]; then Z=geaendert; else Z=schon; fi
ergebnis "{\"zustand\":\"$Z\",\"knoten\":\"$ICH\",\"rolle\":\"$ROLLE\",\"rolleVorher\":\"$RV\",\"datenbanken\":$(db_json "$dbz"),\"aenderungen\":[$AJ]}"`);

/**
 * Rückweg von ag_anlegen je Knoten (zuerst der Primär mit ressourcen=true): Pacemaker-Ressourcen ag_vip und ag_cluster (nur auf dem
 * aktuellen Primär), DROP AVAILABILITY GROUP, auf dem bisherigen Primär RESTORING-Datenbanken WITH RECOVERY zurück; Endpunkt, Zertifikate,
 * Benutzer und Logins alfred_ag_*, Login alfred_pacemaker und die Zugangsdatei entfernen. Datenbanken bleiben (Sekundär: RESTORING,
 * gemeldet), Master-Key bleibt (Tresor). Zeit: LINUX_HA_ZEIT_MS.agEntfernen
 */
export function haAgEntfernenSkript(p: HaAgEntfernenParameter): string {
  pruefe(pruefeHaAgEntfernen(p));
  const ich = p.besetzung[p.rolle];
  const t = tsqlEntfernen(p);
  return [
    ...agKopf(LINUX_HA_BAUSTEINE.agEntfernen, { ag: p.ag, besetzung: { ...p.besetzung }, rolle: p.rolle, knoten: p.knoten.map(x => ({ name: x.name, ip: x.ip })), ressourcen: p.ressourcen }, p.ag, p.rolle, ich),
    `RESSOURCEN=${p.ressourcen ? 1 : 0}`,
    `AG_MERK=${shQ(`${HA_FENCING_DIR}/ag-entfernen-${p.ag}.txt`)}`,
    `T_LAGE=${shQ(t.lage)}`, `T_WAISEN=${shQ(t.waisen)}`, `T_DROP=${shQ(t.drop)}`, `T_AUFRAEUMEN=${shQ(t.aufraeumen)}`, `T_SELBST=${shQ(t.selbst)}`,
    '# ALFRED-ABLAUF',
    AG_ENTFERNEN_KOERPER,
  ].join('\n');
}

// ── Geplantes Failover (Task 6): ag_failover ─────────────────────────────────────────────────────────────────────────────────
//
// Läuft auf dem ZIEL (sa des Ziels über stdin): prüft ohne Änderung (Cluster 3/3 mit Quorum, Ressource ag_cluster mit
// required_synchronized_secondaries_to_commit=0, keine fremde Standort-Bedingung, SQL: REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT = 0,
// Ziel SECONDARY/CONNECTED und alle AG-Datenbanken hier SYNCHRONIZED, Promoted auf dem bisherigen Primär), dann
// `pcs resource move ag_cluster-clone <ziel> --promoted`, wartet bis Promoted = Ziel und die SQL-Rolle hier PRIMARY ist, und gibt die
// Standort-Bedingung mit `pcs resource clear ag_cluster-clone` frei — auch bei Zeitüberschreitung oder gescheitertem move; das Ergebnis
// davon steht immer in der Meldung (eine verbliebene cli-prefer bindet die AG still an einen Knoten). Danach VIP hier, bisheriger
// Primär SECONDARY/CONNECTED und synchron, Selbstprüfung. Ist das Ziel schon Primär: kein move, nur eine liegengebliebene cli-prefer/
// cli-ban freigeben (als Änderung gemeldet) und dieselbe Selbstprüfung. Rückweg = ag_failover zurück (zugang/ziel vertauscht).

export interface HaAgFailoverParameter { ag: string; ziel: string; vorher: string; knoten: HaKnoten[] }

/** Ziel und bisheriger Primär (zugang): zwei verschiedene Datenreplikate — nie das CONFIGURATION_ONLY-Replikat */
export function pruefeHaAgFailover(p: unknown): string | undefined {
  const x = obj(p);
  const f = pruefeAgName(x.ag) ?? pruefeKnoten(x.knoten); if (f) return f;
  const daten = (x.knoten as HaKnoten[]).map(k => k.name).filter(n => n !== HA_AG_KONFIG_KNOTEN);
  for (const [feld, wer] of [['ziel', 'ziel'], ['vorher', 'zugang (bisheriger Primär)']] as const) {
    const v = x[feld];
    if (v === HA_AG_KONFIG_KNOTEN) return `${wer}: ${HA_AG_KONFIG_KNOTEN} ist CONFIGURATION_ONLY (ohne Daten) — nur ${daten.join(' oder ')}`;
    if (typeof v !== 'string' || !daten.includes(v)) return `${wer}: ein Datenreplikat (${daten.join(', ')})`;
  }
  if (x.ziel === x.vorher) return 'ziel und zugang (bisheriger Primär) müssen verschiedene Datenreplikate sein';
  return undefined;
}

/**
 * Lage der AG auf dem Ziel, eine Zeile: „ALFRED|<Rolle hier>|<required_sync>|<AG-Datenbanken>|<davon hier SYNCHRONIZED>|<Verbindung hier>|
 * <Rolle bisheriger Primär>|<dessen Verbindung>|<dessen Datenbanken SYNCHRONIZED>|<Liste hier>|<Liste bisheriger Primär>“ — die Werte des
 * anderen Replikats sieht nur der Primär (auf dem Sekundär „-“/0), also erst nach dem Failover.
 */
function tsqlFailover(p: HaAgFailoverParameter): string {
  const { ag, ziel, vorher } = p;
  const alt = `JOIN sys.availability_replicas ar ON ar.replica_id = x.replica_id WHERE x.group_id = g.group_id AND ar.replica_server_name = N'${vorher}'`;
  const altRep = (spalte: string) => `ISNULL((SELECT UPPER(rs.${spalte}) FROM sys.dm_hadr_availability_replica_states rs JOIN sys.availability_replicas ar ON ar.replica_id = rs.replica_id WHERE rs.group_id = g.group_id AND ar.replica_server_name = N'${vorher}'), '-')`;
  const liste = (wo: string) => `ISNULL((SELECT STRING_AGG(CAST(ISNULL(DB_NAME(x.database_id), N'?') + N'=' + UPPER(x.synchronization_state_desc) AS varchar(300)), ',') WITHIN GROUP (ORDER BY x.database_id) FROM sys.dm_hadr_database_replica_states x ${wo}), '-')`;
  return [
    AG_KOPF('fo_lage'),
    'DECLARE @m nvarchar(2048);',
    servername(ziel),
    `IF NOT ${agDa(ag)} THROW 50501, N'${ag} fehlt auf ${ziel} - kein Failover; nichts geändert', 1;`,
    `SELECT 'ALFRED|' + ISNULL(${lokaleRolle(ag)}, '-') + '|' + CAST(g.required_synchronized_secondaries_to_commit AS varchar(5)) + '|'`,
    "  + CAST((SELECT COUNT(*) FROM sys.availability_databases_cluster c WHERE c.group_id = g.group_id) AS varchar(10)) + '|'",
    "  + CAST((SELECT COUNT(*) FROM sys.dm_hadr_database_replica_states x WHERE x.group_id = g.group_id AND x.is_local = 1 AND UPPER(x.synchronization_state_desc) = N'SYNCHRONIZED') AS varchar(10)) + '|'",
    "  + ISNULL((SELECT UPPER(rs.connected_state_desc) FROM sys.dm_hadr_availability_replica_states rs WHERE rs.group_id = g.group_id AND rs.is_local = 1), '-') + '|'",
    `  + ${altRep('role_desc')} + '|' + ${altRep('connected_state_desc')} + '|'`,
    `  + CAST((SELECT COUNT(*) FROM sys.dm_hadr_database_replica_states x ${alt} AND UPPER(x.synchronization_state_desc) = N'SYNCHRONIZED') AS varchar(10)) + '|'`,
    `  + ${liste('WHERE x.group_id = g.group_id AND x.is_local = 1')} + '|' + ${liste(alt)}`,
    `FROM sys.availability_groups g WHERE g.name = N'${ag}';`,
  ].join('\n');
}

/** Hilfen des Failover-Bausteins — vor der Marke, damit Tests sie umbiegen können */
const FO_HILFEN = sh(String.raw`jetzt() { date +%s; }
MOVE_OFFEN=0; FREIGABE=''; FREI_VOR=x
# Standort-Bedingungen der AG-Ressourcen: SCLI = cli-prefer/cli-ban (von pcs resource move/ban), SANDERE = fremde, SLISTE; unlesbar → x
standort() { local x l; SCLI=x; SANDERE=x; SLISTE=-; if x=$(cibadmin --query --scope constraints 2>/dev/null) && l=$(ag_pcs_py standort "$AG_RES" "$AG_KLON" "$VIP_RES" <<<"$x" 2>/dev/null); then read -r SCLI SANDERE SLISTE <<<"$l"; fi; }
lage_setzen() { IFS='|' read -r _ LOKAL RS NDB NSYNC VERB ALTROLLE ALTVERB NALT LLOKAL LALT <<<"$1"; }
lage_lesen() { sql_lauf "$T_LAGE" "$1"; lage_setzen "$ZEILE"; }
# während des Rollenwechsels: ein SQL-Fehler zählt als „noch nicht“ (kein Abbruch mitten im Warten)
lage_versuch() { local a; a=$(sql "$T_LAGE" 2>&1) || return 1; a=$(alfred_zeile "$a"); [ -n "$a" ] || return 1; lage_setzen "$a"; }
# Standort-Bedingung freigeben: pcs resource clear läuft immer; FREIGABE sagt, was geschah — 1, wenn danach noch eine Bedingung besteht
freigeben() {
  local aus vor
  MOVE_OFFEN=0
  standort; vor=$SCLI; FREI_VOR=$vor
  if ! aus=$(pcs resource clear "$AG_KLON" 2>&1); then
    standort
    FREIGABE="pcs resource clear $AG_KLON fehlgeschlagen ($(kurz "$aus")) — Standort-Bedingung(en) $SLISTE bleiben und binden die AG an einen Knoten; von Hand: pcs resource clear $AG_KLON"
    return 1
  fi
  standort
  if [ "$SCLI" != 0 ]; then FREIGABE="pcs resource clear $AG_KLON lief, aber Standort-Bedingung(en) $SLISTE bestehen weiter oder sind nicht lesbar und binden die AG — von Hand prüfen (pcs constraint location)"; return 1; fi
  # Final-Review M-3: vorher unlesbar → nicht „entfernt“ behaupten, aber weiter als (mögliche) Änderung melden
  if [ "$vor" = 0 ]; then FREIGABE="pcs resource clear $AG_KLON ausgeführt (keine Standort-Bedingung offen)"
  elif [ "$vor" = x ]; then aend pcs-resource-clear-vorher-unlesbar; FREIGABE="pcs resource clear $AG_KLON ausgeführt (vorher nicht lesbar)"
  else aend standort-bedingung-entfernt; FREIGABE="Standort-Bedingung mit pcs resource clear $AG_KLON entfernt"; fi
}
warte_primaer() { local i; for i in $(seq 1 "$WARTE_RUNDEN"); do pm_lage; if [ "$PROM" = "$ICH" ] && lage_versuch && [ "$LOKAL" = PRIMARY ]; then return 0; fi; sleep 2; done; return 1; }
warte_gegenstelle() { local i; for i in $(seq 1 "$WARTE_RUNDEN"); do if lage_versuch && [ "$LOKAL" = PRIMARY ] && [ "$ALTROLLE" = SECONDARY ] && [ "$ALTVERB" = CONNECTED ] && [ "$NALT" = "$NDB" ]; then return 0; fi; sleep 2; done; return 1; }`);

const AG_FAILOVER_KOERPER = sh(String.raw`knoten_ich
geheim_lesen sa SA "sa-Kennwort"
DAUER=0; VORHER=$ALT
# Nach dem Verschieben darf kein Abbruch die Standort-Bedingung still stehen lassen: jeder Abbruch gibt sie zuerst frei und nennt das
# Ergebnis. Fix-Runde 1 (I1): bei einem unerwarteten Ende (set -e/-u, TERM/INT) gibt alfred_aufraeumen (EXIT-Trap) ebenfalls frei und
# schreibt selbst die Fehlerzeile — mit dem Ergebnis der Freigabe und dem Stand (failover-angestossen steht schon vor dem move darin)
eval "$(declare -f abbruch | sed '1s/^abbruch /abbruch_basis /')"
abbruch() { if [ "$MOVE_OFFEN" = 1 ]; then freigeben || true; set -- "$1 — $FREIGABE"; fi; abbruch_basis "$1"; }
alfred_aufraeumen() {
  local t
  [ "$MOVE_OFFEN" = 1 ] || return 0
  freigeben || true
  [ -z "$ALFRED_ZEILE" ] || return 0
  pm_lage || true
  t=$(printf '%s' "unerwarteter Abbruch (Exit §{ALFRED_RC:-?}) nach pcs resource move — Promoted auf '§{PROM:-?}', Failover möglicherweise erfolgt; $FREIGABE; $(stand)" | json_text)
  ergebnis "{\"zustand\":\"fehler\",\"baustein\":\"$ALFRED_BAUSTEIN\",\"fehler\":$t}"
}
# ── Phase 1: prüfen — bis zum Verschieben keine Änderung ──
cluster_lage
{ [ "$LO" = 3 ] && [ "$LQ" = 1 ]; } || abbruch "Cluster: $LO/3 online, Quorum $([ "$LQ" = 1 ] && echo ja || echo nein) — erwartet 3/3 mit Quorum; kein Failover, nichts geändert"
ressource_da "$AG_RES" || abbruch "Pacemaker-Ressource $AG_RES fehlt — erst ag_anlegen; nichts geändert"
an=$(parameter "$AG_RES" ag_name)
[ "$an" = "$AG" ] || abbruch "Ressource $AG_RES verwaltet '§{an:-?}' statt $AG — kein Failover; nichts geändert"
rr=$(parameter "$AG_RES" required_synchronized_secondaries_to_commit)
[ "$rr" = 0 ] || abbruch "required_synchronized_secondaries_to_commit an $AG_RES ist '§{rr:-nicht gesetzt}', erwartet 0 (ag_anlegen setzt es) — kein Failover; nichts geändert"
VIP_IP=$(parameter "$VIP_RES" ip); VIP_PRAEFIX=$(parameter "$VIP_RES" cidr_netmask)
{ [[ "$VIP_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && [[ "$VIP_PRAEFIX" =~ ^[0-9]{1,2}$ ]]; } || abbruch "VIP-Ressource $VIP_RES nicht lesbar (ip '§{VIP_IP}', cidr_netmask '§{VIP_PRAEFIX}') — kein Failover; nichts geändert"
standort
[ "$SCLI" != x ] || abbruch "Standort-Bedingungen (CIB) nicht lesbar — kein Failover; nichts geändert"
[ "$SANDERE" = 0 ] || abbruch "fremde Standort-Bedingungen an $AG_KLON/$VIP_RES ($SLISTE) — nicht still entfernt, kein Failover; nichts geändert"
bereit || abbruch "SQL Server antwortet auf $ICH nicht als sa — nichts geändert"
lage_lesen "AG-Lage auf $ICH"
[ "$RS" = 0 ] || abbruch "REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT in SQL ist $RS, erwartet 0 (ag_anlegen setzt es) — kein Failover; nichts geändert"
pm_lage
if [ "$PROM" = "$ICH" ] && [ "$LOKAL" = PRIMARY ]; then
  # schon Primär: kein move — nur eine liegengebliebene Standort-Bedingung freigeben (als Änderung gemeldet)
  VORHER=$ICH
  if [ "$SCLI" != 0 ]; then freigeben || abbruch "$ICH ist schon Primär, aber: $FREIGABE — $(stand)"; fi
else
  [ "$PROM" = "$ALT" ] || abbruch "Promoted auf '$PROM', erwartet $ALT (zugang = bisheriger Primär) — Lage unklar, kein Failover; nichts geändert"
  { [ "$LOKAL" = SECONDARY ] && [ "$VERB" = CONNECTED ]; } || abbruch "$ICH ist $LOKAL/$VERB, erwartet SECONDARY/CONNECTED — kein Failover; nichts geändert"
  { [[ "$NDB" =~ ^[1-9][0-9]*$ ]] && [ "$NSYNC" = "$NDB" ]; } || abbruch "Ziel $ICH nicht SYNCHRONIZED ($NSYNC/$NDB: $LLOKAL) — geplantes Failover nur auf ein synchronisiertes Ziel; nichts geändert"
  if [ "$SCLI" != 0 ]; then
    freigeben || abbruch "liegengebliebene Standort-Bedingung vor dem Failover: $FREIGABE — $(stand)"
    pm_lage
    [ "$PROM" = "$ALT" ] || abbruch "nach dem Freigeben der liegengebliebenen Standort-Bedingung ist Promoted auf '$PROM' — kein Failover; $(stand)"
  fi
  # ── Phase 2: verschieben, auf den Primär warten, Standort-Bedingung freigeben — auch bei Zeitüberschreitung oder gescheitertem move ──
  # Fix-Runde 1 (I1): ab hier gilt der Lauf als (möglicherweise) ändernd — schon VOR dem move, denn pcs 0.11 kann nach dem Verschieben
  # scheitern (z. B. „cannot verify the resource will not move back“); nur ein nachgelesen wirkungsloser move nimmt das zurück
  AJ_VOR=$AJ; GEAENDERT_VOR=$GEAENDERT
  aend failover-angestossen
  trap 'exit 143' TERM; trap 'exit 130' INT
  T0=$(jetzt); MOVE_OFFEN=1
  if ! aus=$(pcs resource move "$AG_KLON" "$ICH" --promoted 2>&1); then
    frei=0; freigeben || frei=1
    pm_lage
    if [ "$frei" = 0 ] && [ "$FREI_VOR" = 0 ] && [ "$PROM" = "$ALT" ]; then
      AJ=$AJ_VOR; GEAENDERT=$GEAENDERT_VOR
      wirkung="ohne Wirkung (Promoted weiter auf $ALT, keine Standort-Bedingung entstanden)"
    else
      if [ "$PROM" = "$ICH" ]; then aend primaer-gewechselt; fi
      wirkung="Promoted jetzt auf '$PROM' — Failover möglicherweise erfolgt"
    fi
    abbruch "pcs resource move $AG_KLON $ICH --promoted fehlgeschlagen: $(kurz "$aus") — $wirkung; $FREIGABE; $(stand)"
  fi
  if ! warte_primaer; then
    freigeben || true
    abbruch "Zeitüberschreitung: nach $((WARTE_RUNDEN * 2)) s Promoted auf '$PROM', SQL-Rolle auf $ICH '§{LOKAL:-?}' — Failover nicht bestätigt; $FREIGABE; $(stand)"
  fi
  DAUER=$(( $(jetzt) - T0 ))
  freigeben || abbruch "Failover auf $ICH nach $DAUER s, aber: $FREIGABE — $(stand)"
fi
# ── Phase 3: Promoted und VIP hier, bisheriger Primär SECONDARY/CONNECTED und synchron ──
warte_pacemaker || abbruch "Pacemaker: Promoted auf '$PROM', VIP auf '$VIPN' — erwartet beide auf $ICH; $(stand)"
warte_gegenstelle || abbruch "$ALT ist §{ALTROLLE:-?}/§{ALTVERB:-?}, Datenbanken §{NALT:-?}/§{NDB:-?} SYNCHRONIZED (§{LALT:--}) nach $((WARTE_RUNDEN * 2)) s — $ICH ist Primär, die Gegenstelle aber nicht synchron; $(stand)"
# ── Selbstprüfung: SQL (Primär hier, required_sync 0), Ressource (required_sync 0), keine Standort-Bedingung, Promoted + VIP hier ──
lage_lesen "Selbstprüfung auf $ICH"
[ "$LOKAL" = PRIMARY ] || abbruch "Selbstprüfung: $ICH ist $LOKAL, erwartet PRIMARY — $(stand)"
[ "$RS" = 0 ] || abbruch "Selbstprüfung: REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT in SQL ist $RS, erwartet 0 — $(stand)"
rr=$(parameter "$AG_RES" required_synchronized_secondaries_to_commit)
[ "$rr" = 0 ] || abbruch "Selbstprüfung: required_synchronized_secondaries_to_commit an der Ressource $AG_RES ist '§{rr:-nicht gesetzt}', erwartet 0 — $(stand)"
standort
{ [ "$SCLI" = 0 ] && [ "$SANDERE" = 0 ]; } || abbruch "Selbstprüfung: Standort-Bedingungen an $AG_KLON/$VIP_RES offen oder nicht lesbar ($SLISTE) — $(stand)"
pm_lage
{ [ "$PROM" = "$ICH" ] && [ "$VIPN" = "$ICH" ]; } || abbruch "Selbstprüfung: Promoted auf '$PROM', VIP auf '$VIPN' — erwartet $ICH; $(stand)"
vip_lokal || abbruch "Selbstprüfung: VIP $VIP_IP/$VIP_PRAEFIX ist auf $ICH nicht gebunden — $(stand)"
if [ "$GEAENDERT" = 1 ]; then Z=geaendert; else Z=schon; fi
ergebnis "{\"zustand\":\"$Z\",\"ag\":\"$AG\",\"primaer\":\"$ICH\",\"vorher\":\"$VORHER\",\"dauerS\":$DAUER,\"vip\":\"$VIP_IP/$VIP_PRAEFIX\",\"vipAuf\":\"$VIPN\",\"promotedAuf\":\"$PROM\",\"requiredSyncSql\":$RS,\"requiredSyncRessource\":\"$rr\",\"altRolle\":\"$ALTROLLE\",\"datenbanken\":$(db_json "$LALT"),\"standortBedingungen\":0,\"aenderungen\":[$AJ]}"`);

/**
 * Geplantes Failover auf das Ziel (läuft dort; nur sa über stdin): Abbruch ohne Änderung, wenn das Ziel nicht SYNCHRONIZED ist,
 * required_sync in SQL oder an der Ressource ≠ 0, Cluster nicht 3/3 mit Quorum, eine fremde Standort-Bedingung besteht oder Promoted nicht
 * auf dem bisherigen Primär liegt; dann pcs resource move … --promoted, warten, pcs resource clear (immer), Selbstprüfung. Ergebnis: Dauer
 * (move bis Primär = Ziel, s), neuer Primär, VIP-Ort, Zustand der Gegenstelle. Zeit: LINUX_HA_ZEIT_MS.agFailover
 */
export function haAgFailoverSkript(p: HaAgFailoverParameter): string {
  pruefe(pruefeHaAgFailover(p));
  return [
    ...agKopf(LINUX_HA_BAUSTEINE.agFailover, { ag: p.ag, ziel: p.ziel, vorher: p.vorher, knoten: p.knoten.map(x => ({ name: x.name, ip: x.ip })) }, p.ag, 'failover-ziel', p.ziel),
    `ALT=${shQ(p.vorher)}`,
    `T_LAGE=${shQ(tsqlFailover(p))}`,
    FO_HILFEN,
    '# ALFRED-ABLAUF',
    AG_FAILOVER_KOERPER,
  ].join('\n');
}

// ── Register ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

registriereLinuxBaustein<HaVorbereitenParameter>(LINUX_HA_BAUSTEINE.vorbereiten, haVorbereitenSkript);
registriereLinuxBaustein(LINUX_HA_BAUSTEINE.status, () => haStatusSkript());
registriereLinuxBaustein<HaClusterParameter>(LINUX_HA_BAUSTEINE.cluster, haClusterSkript);
registriereLinuxBaustein<HaClusterEntfernenParameter>(LINUX_HA_BAUSTEINE.clusterEntfernen, haClusterEntfernenSkript);
registriereLinuxBaustein<HaFencingParameter>(LINUX_HA_BAUSTEINE.fencingPruefen, haFencingPruefenSkript);
registriereLinuxBaustein<HaFencingBelegenParameter>(LINUX_HA_BAUSTEINE.fencingBelegen, haFencingBelegenSkript);
registriereLinuxBaustein<HaAgEndpunktParameter>(LINUX_HA_BAUSTEINE.agEndpunkt, haAgEndpunktSkript);
registriereLinuxBaustein<HaAgReplikatParameter>(LINUX_HA_BAUSTEINE.agReplikat, haAgReplikatSkript);
registriereLinuxBaustein<HaAgAbschlussParameter>(LINUX_HA_BAUSTEINE.agAbschluss, haAgAbschlussSkript);
registriereLinuxBaustein<HaAgEntfernenParameter>(LINUX_HA_BAUSTEINE.agEntfernen, haAgEntfernenSkript);
registriereLinuxBaustein<HaAgFailoverParameter>(LINUX_HA_BAUSTEINE.agFailover, haAgFailoverSkript);
