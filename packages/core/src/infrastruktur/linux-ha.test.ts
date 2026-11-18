import { describe, it, expect, beforeEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  haVorbereitenSkript, haStatusSkript, haErgebnis, hostfwNft, hostsBlock, pruefeHaVorbereiten, pruefeKnoten,
  HA_KNOTEN, HA_VERSIONEN, HA_PORTS, HA_SQL_ZUSATZQUELLEN, HA_BEFEHLE, LINUX_HA_BAUSTEINE, PY_HA_STATUS, PY_KW_GLEICH, HOSTFW_UNIT,
  haClusterSkript, haClusterEntfernenSkript, pruefeHaCluster, pruefeHaClusterEntfernen, PY_CRM_LAGE, PY_CLUSTER_FUNK,
  haFencingPruefenSkript, haFencingBelegenSkript, pruefeHaFencing, pruefeHaFencingBelegen, fencetestNft, fencingBelegGueltig, PY_FENCING, PY_FENCING_FUNK,
  HA_FENCING_TEST_DATEI, HA_FENCING_BELEG_DATEI, WARTE_WATCHDOG_SKRIPT, SBD_DROPIN_INHALT, HA_SBD_DROPIN,
  type HaVorbereitenParameter, type HaClusterParameter, type FencingBeleg, type FencingLage,
} from './linux-ha.js';
import {
  haAgEndpunktSkript, haAgReplikatSkript, haAgAbschlussSkript, haAgEntfernenSkript, pruefeHaAgEndpunkt, pruefeHaAgReplikat, pruefeHaAgAbschluss, pruefeHaAgEntfernen,
  istOeffentlichesZertifikat, PY_AG_PCS, HA_AG_BEFEHLE, type HaAgEndpunktParameter, type HaAgReplikatParameter, type HaAgAbschlussParameter, type HaAgEntfernenParameter,
  haAgFailoverSkript, pruefeHaAgFailover, PY_AG_STATUS_FUNK, type HaAgFailoverParameter,
} from './linux-ha.js';
import { linuxBausteinBekannt, linuxBausteinSkript } from '../fernzugriff/linux-bausteine.js';
import { schwaerze, GEHEIM_NAME } from '../fernzugriff/kaefig.js';

// I8e Paket 2 Task 2 — HA-Grundlage je Knoten (linux_ha.ha_vorbereiten), feste Bash-Bausteine

const P: HaVorbereitenParameter = { knoten: [...HA_KNOTEN], rolle: 'daten', versionen: { ...HA_VERSIONEN } };
const PC: HaClusterParameter = { cluster: 'sqllnxcl01', knoten: [...HA_KNOTEN], sbd_timeout_s: 10, stonith_timeout_s: 20 };
const BASH = (() => { const r = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }); return r.status === 0 && /^\d+\./.test(r.stdout.trim()); })();
const PYTHON = ['python3', 'python'].find(p => spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3');

// Live-Fix: die Bash-Läufe blockieren den Worker synchron (spawnSync); vor jedem Test einmal an die Ereignisschleife abgeben, sonst
// läuft vitest-RPC (onTaskUpdate, 60 s) über mehrere Tests hinweg in die Zeitgrenze
beforeEach(async () => { await new Promise(r => setTimeout(r, 0)); });

describe('I8e Paket 2 — linux-ha Register und Validatoren', () => {
  it('Bausteine sind beim Laden registriert und liefern denselben Text wie die Erzeuger', () => {
    for (const k of Object.values(LINUX_HA_BAUSTEINE)) expect(linuxBausteinBekannt(k)).toBe(true);
    expect(linuxBausteinSkript(LINUX_HA_BAUSTEINE.vorbereiten, P)).toBe(haVorbereitenSkript(P));
    expect(linuxBausteinSkript(LINUX_HA_BAUSTEINE.status, {})).toBe(haStatusSkript());
    expect(linuxBausteinSkript(LINUX_HA_BAUSTEINE.cluster, PC)).toBe(haClusterSkript(PC));
    expect(linuxBausteinSkript(LINUX_HA_BAUSTEINE.clusterEntfernen, { cluster: 'sqllnxcl01', knoten: HA_KNOTEN })).toBe(haClusterEntfernenSkript({ cluster: 'sqllnxcl01', knoten: [...HA_KNOTEN] }));
    expect(linuxBausteinSkript(LINUX_HA_BAUSTEINE.fencingPruefen, { cluster: 'sqllnxcl01', knoten: HA_KNOTEN, art: 'trennung' })).toBe(haFencingPruefenSkript({ cluster: 'sqllnxcl01', knoten: [...HA_KNOTEN], art: 'trennung' }));
    expect(linuxBausteinSkript(LINUX_HA_BAUSTEINE.fencingBelegen, { cluster: 'sqllnxcl01', knoten: HA_KNOTEN })).toBe(haFencingBelegenSkript({ cluster: 'sqllnxcl01', knoten: [...HA_KNOTEN] }));
    expect(() => linuxBausteinSkript(LINUX_HA_BAUSTEINE.fencingPruefen, { cluster: 'sqllnxcl01', knoten: HA_KNOTEN, art: 'reboot' })).toThrow(/art: trennung oder haenger/);
    expect(() => linuxBausteinSkript(LINUX_HA_BAUSTEINE.cluster, { ...PC, stonith_timeout_s: 19 })).toThrow(/2 × sbd_timeout_s/);
    expect(() => linuxBausteinSkript(LINUX_HA_BAUSTEINE.vorbereiten, { ...P, rolle: 'x' })).toThrow(/rolle/);
  });
  it('Knoten: genau drei, Kurzname, IPv4, ohne Dubletten; Versionen ohne Quoting-Zeichen', () => {
    expect(pruefeKnoten(HA_KNOTEN)).toBeUndefined();
    expect(pruefeKnoten(HA_KNOTEN.slice(0, 2))).toContain('drei');
    expect(pruefeKnoten([...HA_KNOTEN.slice(0, 2), { name: 'x; rm -rf /', ip: '10.0.0.1' }])).toContain('name');
    expect(pruefeKnoten([...HA_KNOTEN.slice(0, 2), { name: 'sqllnx09', ip: '10.0.0.256' }])).toContain('ip');
    expect(pruefeKnoten([...HA_KNOTEN.slice(0, 2), { name: 'sqllnx01', ip: '10.0.0.9' }])).toContain('doppelt');
    expect(pruefeKnoten([...HA_KNOTEN.slice(0, 2), { name: 'sqllnx09', ip: '10.203.30.10' }])).toContain('doppelt');
    expect(pruefeHaVorbereiten({ ...P, versionen: { ...HA_VERSIONEN, pcs: "0.11'; id" } })).toContain('versionen.pcs');
    expect(pruefeHaVorbereiten({ ...P, versionen: { ...HA_VERSIONEN, mssqlHa: '16.0.1000.6-1' } })).toContain('mssqlHa');
    expect(pruefeHaVorbereiten({ ...P, rolle: 'konfig' })).toBeUndefined();
    expect(HA_VERSIONEN).toEqual({ pacemaker: '2.1.6-5ubuntu2', pacemakerCli: '2.1.6-5ubuntu2', corosync: '3.1.7-1ubuntu3.2', pcs: '0.11.7-1ubuntu1.1', sbd: '1.5.2-2ubuntu2', resourceAgents: '1:4.13.0-1ubuntu4.2', mssqlHa: '17.0.4006.2-1' });
  });
  it('Skript ohne Geheimnis im Text; fremde Eingabefelder landen nie im Skript; Kennwort nur aus stdin (feld hacluster)', () => {
    const s = haVorbereitenSkript({ ...P, hacluster: 'Geheim-Wert-42' } as never);
    expect(s).not.toContain('Geheim-Wert-42');
    expect(s).not.toContain('"hacluster":');
    expect(s).toContain('KW=$(feld hacluster)');
    expect(s).toContain("printf 'hacluster:%s\\n' \"$KW\" | chpasswd");
    expect(s).toContain(`ALFRED_P='${JSON.stringify({ knoten: HA_KNOTEN, rolle: 'daten', versionen: HA_VERSIONEN })}'`);
    // Pakete fest, mssql-server-ha = SQL-Version, Kernel-Module passend zum laufenden Kernel
    for (const pv of ['pacemaker=2.1.6-5ubuntu2', 'pacemaker-cli-utils=2.1.6-5ubuntu2', 'corosync=3.1.7-1ubuntu3.2', 'pcs=0.11.7-1ubuntu1.1', 'sbd=1.5.2-2ubuntu2', 'resource-agents-base=1:4.13.0-1ubuntu4.2', 'mssql-server-ha=17.0.4006.2-1']) expect(s).toContain(`'${pv}'`);
    expect(s).toContain('MOD_EXTRA="linux-modules-extra-$(uname -r)"');
  });
  it('nft-Regeln: genau Peers × Ports, andere Quellen nur für diese Ports verworfen, Grundregel accept, SSH unberührt', () => {
    const t = hostfwNft(HA_KNOTEN);
    const regeln = t.split('\n').map(z => z.trim()).filter(z => /(accept|drop)$/.test(z));
    expect(regeln).toEqual([
      'iifname "lo" accept',
      'ip saddr @ha_peers4 tcp dport { 1433, 2224, 3121, 5022, 21064 } accept',
      'ip saddr @sql_quellen4 tcp dport 1433 accept',
      'ip saddr @ha_peers4 udp dport { 5405 } accept',
      'tcp dport { 1433, 2224, 3121, 5022, 21064 } drop',
      'udp dport { 5405 } drop',
    ]);
    expect(t).toContain('elements = { 10.203.30.10, 10.203.30.11, 10.203.30.12 }');
    // Ruling R4: 1433 zusätzlich nur von der Probe 192.168.1.223 (Architektur v2 §4), alle anderen Ports nur die Knoten
    expect(HA_SQL_ZUSATZQUELLEN).toEqual(['192.168.1.223']);
    expect(t).toContain('\tset sql_quellen4 {\n\t\ttype ipv4_addr\n\t\telements = { 192.168.1.223 }\n\t}');
    expect(t.split('192.168.1.223')).toHaveLength(2);
    expect(() => hostfwNft(HA_KNOTEN, ['1.2.3'])).toThrow(/sqlQuellen/);
    expect(t).toContain('type filter hook input priority -10; policy accept;');
    expect(t).not.toMatch(/\b22\b/);
    expect(t.match(/table inet alfred_ha/g)).toHaveLength(3); // anlegen, löschen, neu (atomar ersetzt)
    expect([...HA_PORTS.tcp, ...HA_PORTS.udp]).not.toContain(22);
    expect(HOSTFW_UNIT).toContain('ExecStart=/usr/sbin/nft -f /etc/alfred/hostfw.nft');
    expect(HOSTFW_UNIT).toContain('ExecStop=-/usr/sbin/nft delete table inet alfred_ha');
    expect(HOSTFW_UNIT).not.toMatch(/nftables\.service|ufw/);
    expect(hostsBlock(HA_KNOTEN).split('\n').slice(1, 4)).toEqual(['10.203.30.10 sqllnx01', '10.203.30.11 sqllnx02', '10.203.30.12 sqllnxcfg']);
  });
  it.skipIf(!BASH)('bash -n: beide Skripte syntaktisch gültig', () => {
    for (const s of [haVorbereitenSkript(P), haVorbereitenSkript({ ...P, rolle: 'konfig' }), haStatusSkript(), haClusterSkript(PC), haClusterEntfernenSkript(PC),
      haFencingPruefenSkript({ cluster: 'sqllnxcl01', knoten: [...HA_KNOTEN], art: 'trennung' }), haFencingPruefenSkript({ cluster: 'sqllnxcl01', knoten: [...HA_KNOTEN], art: 'haenger' }), haFencingBelegenSkript(PC)]) {
      const r = spawnSync('bash', ['-n'], { input: s, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    }
  });
  it('Live-Fix: HA_BEFEHLE deckt jedes Programm der erzeugten Skripte ab (und nennt nichts, was kein Skript nutzt)', () => {
    const skripte = [haVorbereitenSkript(P), haStatusSkript(), haClusterSkript(PC), haClusterEntfernenSkript(PC),
      haFencingPruefenSkript({ cluster: 'sqllnxcl01', knoten: [...HA_KNOTEN], art: 'trennung' }), haFencingPruefenSkript({ cluster: 'sqllnxcl01', knoten: [...HA_KNOTEN], art: 'haenger' }), haFencingBelegenSkript(PC),
      ...AG_SKRIPTE()].join('\n');
    // bekannte Programme außerhalb des Grundsystems (Pacemaker/Corosync/SBD-Werkzeuge, Paketverwaltung, Netz, systemd, SQL)
    const KANDIDATEN = ['pcs', 'crm_mon', 'crm_attribute', 'crm_resource', 'crm_node', 'crm_verify', 'crm_simulate', 'crm_failcount', 'crm_standby', 'crm_shadow', 'crm_report', 'crm_ticket', 'crm_diff',
      'cibadmin', 'stonith_admin', 'attrd_updater', 'fence_watchdog', 'corosync-quorumtool', 'corosync-cmapctl', 'corosync-cfgtool', 'corosync-keygen', 'corosync-cpgtool', 'sbd', 'wdctl',
      'nft', 'iptables', 'systemd-run', 'journalctl', 'chpasswd', 'modprobe', 'udevadm', 'getent', 'ss', 'timeout', 'setsid', 'flock', 'python3',
      'apt-get', 'apt-cache', 'apt-mark', 'dpkg-query', 'mssql-conf', 'sqlcmd'];
    const benutzt = KANDIDATEN.filter(k => new RegExp(`(?<![\\w.-])${k.replace(/[-]/g, '\\-')}(?![\\w.-])`).test(skripte));
    const basis = [...HA_BEFEHLE, ...HA_AG_BEFEHLE].map(b => b.split('/').pop()!);
    expect(benutzt.filter(b => !basis.includes(b)), 'benutzt, aber nicht in HA_BEFEHLE').toEqual([]);
    expect(basis.filter(b => !benutzt.includes(b)), 'in HA_BEFEHLE, aber von keinem Skript benutzt').toEqual([]);
    expect(basis).toContain('crm_mon');
    expect(HA_VERSIONEN.pacemakerCli).toBe(HA_VERSIONEN.pacemaker);
    expect(haVorbereitenSkript(P)).toContain("'pacemaker-cli-utils=2.1.6-5ubuntu2'");
  });
  it.skipIf(!PYTHON)('Python-Programme parsen', () => {
    for (const prog of [PY_HA_STATUS, PY_KW_GLEICH, PY_CRM_LAGE, PY_CLUSTER_FUNK, PY_FENCING, PY_FENCING_FUNK]) {
      const r = spawnSync(PYTHON!, ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: prog, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    }
  });
  it.skipIf(!PYTHON)('PY_KW_GLEICH ausgeführt: gleich → 0, anders/gesperrt → 1, crypt fehlt → 2 (Modul über PYTHONPATH ersetzt)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-kw-'));
    try {
      // Ersatz-crypt mit der Semantik von crypt.crypt(kennwort, hash) == hash (Salz = alles bis zum letzten „$“)
      const modul = join(dir, 'mit'); const ohne = join(dir, 'ohne');
      mkdirSync(modul); mkdirSync(ohne);
      writeFileSync(join(modul, 'crypt.py'), 'import hashlib\ndef crypt(kw, h):\n    s = h.rsplit("$", 1)[0]\n    return s + "$" + hashlib.sha256((s + kw).encode()).hexdigest()\n');
      writeFileSync(join(ohne, 'crypt.py'), 'raise ImportError("crypt entfernt (Python 3.13)")\n');
      const salz = '$y$j9T$abcdefghijklmnop';
      const hash = `${salz}$${createHash('sha256').update(`${salz}Hk-Richtig-1!`).digest('hex')}`;
      const shadow = join(dir, 'shadow');
      const lauf = (kw: string, pfad: string, zeile = `hacluster:${hash}:19000:0:99999:7:::`) => {
        writeFileSync(shadow, `root:*:19000:0:99999:7:::\n${zeile}\n`);
        return spawnSync(PYTHON!, ['-c', PY_KW_GLEICH, shadow], { input: `${kw}\n`, encoding: 'utf8', env: { ...process.env, PYTHONPATH: pfad } }).status;
      };
      expect(lauf('Hk-Richtig-1!', modul)).toBe(0);
      expect(lauf('Hk-Falsch-1!', modul)).toBe(1);
      expect(lauf('Hk-Richtig-1!', modul, 'hacluster:!:19000::::::')).toBe(1);
      expect(lauf('Hk-Richtig-1!', modul, 'hacluster:*:19000::::::')).toBe(1);
      expect(lauf('Hk-Richtig-1!', ohne)).toBe(2);
      // Task 3 (Carry-over b): shadow nicht lesbar, crypt wirft, crypt kennt das Verfahren nicht (None) → 2 = sichtbarer Abbruch
      const wirft = join(dir, 'wirft'); const nichts = join(dir, 'nichts');
      mkdirSync(wirft); mkdirSync(nichts);
      writeFileSync(join(wirft, 'crypt.py'), 'def crypt(kw, h):\n    raise OSError("invalid salt")\n');
      writeFileSync(join(nichts, 'crypt.py'), 'def crypt(kw, h):\n    return None\n');
      expect(lauf('Hk-Richtig-1!', wirft)).toBe(2);
      expect(lauf('Hk-Richtig-1!', nichts)).toBe(2);
      expect(spawnSync(PYTHON!, ['-c', PY_KW_GLEICH, join(dir, 'gibt-es-nicht')], { input: 'x\n', encoding: 'utf8', env: { ...process.env, PYTHONPATH: modul } }).status).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  // mit echtem crypt (Linux, Python ≤ 3.12) zusätzlich ein echter yescrypt-Hash
  const ECHT = PYTHON && spawnSync(PYTHON, ['-c', 'import warnings; warnings.simplefilter("ignore"); import crypt, sys; sys.exit(0 if crypt.crypt("x", "$y$j9T$abcdefghijklmnop$") else 1)'], { encoding: 'utf8' }).status === 0;
  it.skipIf(!ECHT)('PY_KW_GLEICH mit echtem yescrypt-Hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-kw-'));
    try {
      const h = spawnSync(PYTHON!, ['-c', 'import warnings; warnings.simplefilter("ignore"); import crypt; print(crypt.crypt("Hk-Echt-2#", "$y$j9T$abcdefghijklmnop$"))'], { encoding: 'utf8' }).stdout.trim();
      writeFileSync(join(dir, 'shadow'), `hacluster:${h}:19000:0:99999:7:::\n`);
      const lauf = (kw: string) => spawnSync(PYTHON!, ['-c', PY_KW_GLEICH, join(dir, 'shadow')], { input: `${kw}\n`, encoding: 'utf8' }).status;
      expect(lauf('Hk-Echt-2#')).toBe(0);
      expect(lauf('Hk-Echt-3#')).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('haErgebnis liest die letzte ALFRED-HA-Zeile', () => {
    expect(haErgebnis('x\nALFRED-HA {"zustand":"a"}\nALFRED-SQL {"zustand":"b"}\nALFRED-HA {"zustand":"c"}\n')).toEqual({ zustand: 'c' });
    expect(haErgebnis('ALFRED-SQL {"zustand":"b"}')).toBeUndefined();
  });
});

// ── Skript mit nachgebildetem Rechner ausführen (bash) ──────────────────────────────────────────────────────────────────────────
const STUBS = String.raw`
HOSTS="$T/hosts"; HOSTS_VORLAGE="$T/hosts.tmpl"; WD_SYS="$T/wd"; PCI_SYS="$T/pci"; PROC="$T/proc"; SHADOW="$T/shadow"; POLICY_RC="$T/policy-rc.d"; TMP_BASIS="$T"
MSSQL_CONF="$T/mssql.conf"; MSSQLCONF=mssqlconf_stub; COROSYNC_CONF="$T/corosync.conf"
crypt_da() { [ ! -f "$T/ohne_crypt" ]; }
befehl_da() { [ ! -f "$T/fehlt_§{1##*/}" ]; }
# wie Ubuntu 24.04 (Paket corosync): Standardkonfiguration „debian“ mit einem Knoten auf Loopback
debian_conf() { printf 'totem {
	version: 2
	cluster_name: debian
	crypto_cipher: none
	crypto_hash: none
}

nodelist {
	node {
		name: node1
		nodeid: 1
		ring0_addr: 127.0.0.1
	}
}
'; }
MODPROBE_CONF="$T/etc/modprobe.d/a.conf"; MODLOAD_CONF="$T/etc/modules-load.d/a.conf"; SYSTEMD_CONF="$T/etc/systemd/a.conf"
FW_DATEI="$T/etc/alfred/hostfw.nft"; UNIT_DATEI="$T/etc/systemd/system/alfred-hostfw.service"
log() { echo "$*" >>"$T/log"; }
feld() { printf '%s' 'Hk-Geheim-123456!'; }
json_text() { local x; x=$(cat); printf '"%s"' "§{x//\"/}"; }
eigener_name() { cat "$T/name"; }
uname() { echo 6.8.0-147-generic; }
dpkg-query() { local f="$T/dpkg/§{@: -1}"; [ -f "$f" ] || return 1; case "$*" in *Version*) cat "$f" ;; *) cut -d'|' -f1 "$f" ;; esac; }
apt-get() { log "apt-get $*"; local a; if [[ " $* " == *" install "* ]]; then for a in "$@"; do case "$a" in -*|install|DPkg*|Dpkg*) ;; *=*) printf 'install ok installed|%s' "§{a#*=}" >"$T/dpkg/§{a%%=*}"; case "§{a%%=*}" in pacemaker|corosync|sbd) touch "$T/svc/§{a%%=*}.is-enabled"; debian_conf >"$COROSYNC_CONF" ;; esac ;; linux-modules-extra-*) printf 'install ok installed|1' >"$T/dpkg/$a" ;; esac; done; fi; }
apt-cache() { local pk=§{@: -1} pv; for pv in "§{PAKETE[@]}"; do if [ "§{pv%%=*}" = "$pk" ]; then echo " $pk | §{pv#*=} | http://x noble/main"; fi; done; case "$pk" in linux-modules-extra-*) echo " $pk | 6.8.0-147.147 | http://x" ;; esac; }
apt-mark() { log "apt-mark $*"; local pk=§{@: -1}; printf 'hold ok installed|%s' "$(cut -d'|' -f2 "$T/dpkg/$pk")" >"$T/dpkg/$pk"; }
id() { return 0; }
# ausdrückliches modprobe lädt trotz Ubuntu-Sperrliste; mit $T/dev_wd_pfad erscheint dort das Gerät (Symlink auf /dev/null = Zeichengerät)
modprobe() { log "modprobe $*"; if [ -f "$T/pci_ok" ]; then mkdir -p "$WD_SYS/watchdog0"; cat "$T/kennung" >"$WD_SYS/watchdog0/identity"; if [ -f "$T/dev_wd_pfad" ]; then ln -sf /dev/null "$(cat "$T/dev_wd_pfad")"; fi; fi; }
udevadm() { :; }
sleep() { :; }
# Journal: mit _SYSTEMD_INVOCATION_ID=<id> nur die Einträge dieser Ausführung ($T/journal_inv_<id>), sonst das ganze sbd-Journal
journalctl() { local a; for a in "$@"; do case "$a" in _SYSTEMD_INVOCATION_ID=*) cat "$T/journal_inv_§{a#*=}" 2>/dev/null || true; return 0 ;; esac; done; cat "$T/journal_sbd" 2>/dev/null || true; }
# Rechte des Warteskripts nachgebildet ($T/warte_nicht_ausfuehrbar = Rechte falsch)
ist_ausfuehrbar() { [ -f "$1" ] && [ ! -f "$T/warte_nicht_ausfuehrbar" ]; }
rechte_setzen() { log "chmod 0755 §{1##*/}"; rm -f "$T/warte_nicht_ausfuehrbar"; }
# Live-Fix (c2e4f56d): sbd-Drop-in/Warteskript im Testverzeichnis; pcs nur für die Rückholung eines Knotens (corosync zieht sbd mit)
SBD_DROPIN="$T/etc/systemd/system/sbd.service.d/alfred-watchdog.conf"; WARTE_DATEI="$T/etc/alfred-lib/warte-watchdog"; SBD_KONF="$T/sbd_default"; WARTE_RUNDEN=3
pcs() {
  log "pcs $*"
  case "$1 $2" in
    "cluster stop") rm -f "$T/svc/corosync.is-active" "$T/svc/pacemaker.is-active" ;;
    "cluster start") touch "$T/svc/corosync.is-active" "$T/svc/pacemaker.is-active"; if [ -f "$T/svc/sbd.is-enabled" ] && "$WARTE_DATEI" "$SBD_KONF" 1 2>/dev/null; then touch "$T/svc/sbd.is-active"; fi ;;
  esac
}
ss() { echo LISTEN; }
systemctl() {
  local u=§{@: -1}
  case "$1" in
    show) case "$3" in
        InvocationID) cat "$T/sbd_inv" 2>/dev/null || true ;;
        TimeoutStartUSec) cat "$T/sbd_timeout" 2>/dev/null || echo '1min 30s' ;;
        *) cat "$T/rw" ;;
      esac; return 0 ;;
    is-active|is-enabled|is-failed) [ -f "$T/svc/$u.$1" ]; return ;;
  esac
  log "systemctl $*"
  case "$1" in
    enable) touch "$T/svc/$u.is-enabled"; if [ "$2" = --now ]; then touch "$T/svc/$u.is-active"; fi ;;
    disable) rm -f "$T/svc/$u.is-enabled" "$T/svc/$u.is-active" ;;
    reset-failed) rm -f "$T/svc/$u.is-failed" ;;
    restart|start) touch "$T/svc/$u.is-active"; if [ "$u" = "$FW_DIENST" ]; then touch "$T/nft_geladen"; fi ;;
  esac
  return 0
}
nft() { case "$*" in "list table"*) [ -f "$T/nft_geladen" ]; return ;; "-c -f"*) return 0 ;; esac; log "nft $*"; }
chpasswd() { log chpasswd; cat >"$T/kw_gesetzt"; }
kennwort_gleich() { if [ -f "$T/crypt_rc" ]; then return "$(cat "$T/crypt_rc")"; fi; [ -f "$T/kw_gesetzt" ] && [ "$(cat "$T/kw_gesetzt")" = "hacluster:$KW" ]; }
mssqlconf_stub() { log "mssql-conf $*"; printf '[hadr]\nhadrenabled = 1\n' >>"$MSSQL_CONF"; }
# wie glibc: jeder Treffer aus /etc/hosts, Loopback zuerst (RFC 6724), Format „<ip> STREAM <name>“
getent() { awk -v n="§{@: -1}" '$1 !~ /^#/ { for (i = 2; i <= NF; i++) { if ($i ~ /^#/) break; if ($i == n) { if ($1 ~ /^127\./) l = l $1 " STREAM " n "\n"; else a = a $1 " STREAM " n "\n"; break } } } END { printf "%s%s", l, a }' "$HOSTS"; }
fd_ziel() { cat "$1"; }
prozess_name() { cat "$PROC/$1/comm" 2>/dev/null || true; }
prozess_exe() { cat "$PROC/$1/exe" 2>/dev/null || true; }
`.replaceAll('§{', '${');

/** frischer Rechner: SQL Server installiert (CU1, gehalten), i6300ESB in der VM, Modul noch nicht geladen */
const FRISCH = String.raw`
mkdir -p "$T/dpkg" "$T/svc" "$T/pci/0000:00:04.0" "$T/proc/1/fd" "$T/wd"
printf 'hold ok installed|17.0.4006.2-1' >"$T/dpkg/mssql-server"
echo 0x8086 >"$T/pci/0000:00:04.0/vendor"; echo 0x25ab >"$T/pci/0000:00:04.0/device"; touch "$T/pci_ok"
echo 'i6300ESB timer' >"$T/kennung"; echo 0 >"$T/rw"; echo sqllnx02 >"$T/name"
printf '127.0.0.1 localhost\n127.0.1.1 sqllnx02.ad.3033.at sqllnx02\n' >"$T/hosts"
printf '## template:jinja\n127.0.1.1 {{fqdn}} {{hostname}}\n' >"$T/hosts.tmpl"
touch "$T/svc/mssql-server.is-active"
printf '[network]\ntcpport = 1433\n' >"$T/mssql.conf"
echo /dev/null >"$T/proc/1/fd/0"; echo systemd >"$T/proc/1/comm"; echo /usr/lib/systemd/systemd >"$T/proc/1/exe"
`;

interface Lauf { rc: number; ergebnis?: Record<string, unknown>; aus: string; log: string }
function laeufe(setup: string, n = 2, p: HaVorbereitenParameter = P): { laeufe: Lauf[]; hosts: string; vorlage: string; fw: string; dateien: string } {
  const text = haVorbereitenSkript(p).replace('# ALFRED-ABLAUF', `${STUBS}\n# ALFRED-ABLAUF`);
  const teile = Array.from({ length: n }, (_, i) => `( ${text}\n) >"$T/aus${i}" 2>&1; echo "RC${i}=$?" >>"$T/rc"; mv "$T/log" "$T/log${i}" 2>/dev/null || : >"$T/log${i}"`);
  const huelle = [
    'T=$(mktemp -d)', FRISCH, setup, "ALFRED_EINGABE=''",
    ...teile,
    'cat "$T/rc"',
    ...Array.from({ length: n }, (_, i) => `echo "---AUS${i}"; cat "$T/aus${i}"; echo "---LOG${i}"; cat "$T/log${i}"`),
    'echo ---HOSTS; cat "$T/hosts"; echo ---VORLAGE; cat "$T/hosts.tmpl"; echo ---FW; cat "$T/etc/alfred/hostfw.nft" 2>/dev/null; echo ---DATEIEN; (cd "$T" && find etc policy-rc.d corosync.conf* -type f 2>/dev/null | sort); echo ---ENDE',
    'rm -rf "$T"',
  ].join('\n');
  const r = spawnSync('bash', [], { input: huelle, encoding: 'utf8' });
  const o = r.stdout;
  const zwischen = (a: string, b: string) => o.split(`${a}\n`)[1]?.split(`${b}\n`)[0] ?? '';
  const ls: Lauf[] = Array.from({ length: n }, (_, i) => {
    const aus = zwischen(`---AUS${i}`, `---LOG${i}`);
    return { rc: Number(new RegExp(`RC${i}=(\\d+)`).exec(o)?.[1] ?? -1), ergebnis: haErgebnis(aus), aus, log: zwischen(`---LOG${i}`, i + 1 < n ? `---AUS${i + 1}` : '---HOSTS') };
  });
  return { laeufe: ls, hosts: zwischen('---HOSTS', '---VORLAGE'), vorlage: zwischen('---VORLAGE', '---FW'), fw: zwischen('---FW', '---DATEIEN'), dateien: zwischen('---DATEIEN', '---ENDE') };
}

describe.skipIf(!BASH)('I8e Paket 2 — ha_vorbereiten ausgeführt (nachgebildeter Rechner)', { timeout: 120_000 }, () => {
  it('erster Lauf richtet alles ein, zweiter Lauf meldet „schon“ ohne einen ändernden Befehl', () => {
    const w = laeufe('');
    const [a, b] = w.laeufe as [Lauf, Lauf];
    expect(a.rc, a.aus).toBe(0);
    expect(a.ergebnis).toMatchObject({ zustand: 'geaendert', knoten: 'sqllnx02', rolle: 'daten', watchdog: 'i6300ESB timer', hadr: true, firewall: 'aktiv', neustartSql: true,
      pakete: { pacemaker: '2.1.6-5ubuntu2', 'mssql-server-ha': '17.0.4006.2-1', 'resource-agents-base': '1:4.13.0-1ubuntu4.2' } });
    expect(a.ergebnis!.aenderungen).toEqual(expect.arrayContaining(['pakete', 'halten:pcs', 'i6300esb-geladen', 'softdog-gesperrt', 'systemd-runtimewatchdog', 'firewall-regeln', 'firewall-dienst', 'hacluster-kennwort', 'pcsd', 'hadr']));
    expect(a.log).toContain('apt-get -o DPkg::Lock::Timeout=300 install -y -q --no-install-recommends -o Dpkg::Options::=--force-confold pacemaker=2.1.6-5ubuntu2 pacemaker-cli-utils=2.1.6-5ubuntu2 corosync=3.1.7-1ubuntu3.2 pcs=0.11.7-1ubuntu1.1 sbd=1.5.2-2ubuntu2 resource-agents-base=1:4.13.0-1ubuntu4.2 mssql-server-ha=17.0.4006.2-1 linux-modules-extra-6.8.0-147-generic');
    expect(a.log).toContain('modprobe i6300esb');
    expect(a.log).toContain('mssql-conf set hadr.hadrenabled 1');
    expect(a.aus).toContain('ALFRED-HACLUSTER-GESETZT');
    expect(a.aus).not.toContain('Hk-Geheim');
    // hosts: Block oben (eigener Name löst zur Knoten-IP auf), cloud-init-Vorlage nach der Kopfzeile
    expect(w.hosts.split('\n').slice(0, 5)).toEqual([expect.stringContaining('# ALFRED-HA ANFANG'), '10.203.30.10 sqllnx01', '10.203.30.11 sqllnx02', '10.203.30.12 sqllnxcfg', '# ALFRED-HA ENDE']);
    // eigener Name nicht mehr auf Loopback (glibc sortiert 127.0.1.1 vor 10.x) — Original als markierter Kommentar
    expect(w.hosts).toContain('# ALFRED-HA ENTFERNT (Loopback mit eigenem Namen): 127.0.1.1 sqllnx02.ad.3033.at sqllnx02');
    expect(w.hosts.split('\n').filter(z => z.startsWith('127.0.1.1'))).toEqual([]);
    expect(w.hosts).toContain('127.0.0.1 localhost');
    expect(w.vorlage.split('\n')[0]).toBe('## template:jinja');
    expect(w.vorlage.split('\n')[1]).toContain('# ALFRED-HA ANFANG');
    expect(w.vorlage).toContain('# ALFRED-HA ENTFERNT (Loopback mit eigenem Namen): 127.0.1.1 {{fqdn}} {{hostname}}');
    expect(w.vorlage.split('\n').filter(z => z.startsWith('127.0.1.1'))).toEqual([]);
    expect(a.ergebnis!.sql1433).toEqual(['10.203.30.10', '10.203.30.11', '10.203.30.12', '192.168.1.223']);
    // frische Installation: Debian aktiviert die Cluster-Dienste → deaktiviert und geprüft
    expect(a.log).toContain('systemctl disable --now pacemaker');
    expect(a.ergebnis!.aenderungen).toEqual(expect.arrayContaining(['aus:pacemaker', 'aus:corosync', 'aus:sbd', 'corosync-standard-beiseite']));
    // Carry-over a: Dienste gleich nach der Installation aus (vor hosts/Watchdog), Debian-Standardkonfiguration beiseitegelegt
    expect(a.log.indexOf('systemctl disable --now sbd')).toBeLessThan(a.log.indexOf('modprobe i6300esb'));
    expect(w.dateien).not.toMatch(/(^|\n)corosync\.conf\n/);
    expect(w.dateien).toMatch(/(^|\n)corosync\.conf\.alfred-debian-\d{14}\n/);
    expect(w.fw.trim()).toBe(hostfwNft(HA_KNOTEN));
    expect(w.dateien).not.toContain('policy-rc.d'); // eigene policy-rc.d wieder entfernt
    expect(b.rc, b.aus).toBe(0);
    expect(b.ergebnis).toMatchObject({ zustand: 'schon', neustartSql: false, aenderungen: [] });
    expect(b.log.trim()).toBe('');
    expect(b.aus).not.toContain('ALFRED-HACLUSTER-GESETZT');
  });

  const ohneAenderung = (w: ReturnType<typeof laeufe>, muster: RegExp) => {
    const a = w.laeufe[0]!;
    expect(a.rc).toBe(1);
    expect(a.ergebnis?.zustand).toBe('fehler');
    expect(String(a.ergebnis?.fehler)).toMatch(muster);
    expect(String(a.ergebnis?.fehler)).toContain('nichts geändert');
    expect(a.log.trim()).toBe('');
    expect(w.hosts).toBe('127.0.0.1 localhost\n127.0.1.1 sqllnx02.ad.3033.at sqllnx02\n');
    expect(w.dateien.trim()).toBe('');
  };
  it('Abbruch vor jeder Änderung: kein i6300ESB in der VM', () => {
    ohneAenderung(laeufe('rm -rf "$T/pci/0000:00:04.0" "$T/pci_ok"', 1), /kein i6300ESB-Watchdog.*set_vm_watchdog/);
  });
  it('Abbruch vor jeder Änderung: vorhandenes Watchdog-Gerät stammt nicht von i6300esb (z. B. softdog)', () => {
    ohneAenderung(laeufe('mkdir -p "$T/wd/watchdog0"; echo "Software Watchdog" >"$T/wd/watchdog0/identity"', 1), /watchdog0 stammt von 'Software Watchdog'.*kein softdog-Ersatz/);
  });
  it('Abbruch vor jeder Änderung: ein anderer Prozess hält /dev/watchdog offen (watchdog-Dienst, systemd)', () => {
    const geraet = 'mkdir -p "$T/wd/watchdog0"; echo "i6300ESB timer" >"$T/wd/watchdog0/identity"';
    ohneAenderung(laeufe(`${geraet}; mkdir -p "$T/proc/77/fd"; echo /dev/watchdog >"$T/proc/77/fd/3"; echo watchdog >"$T/proc/77/comm"; echo /usr/sbin/watchdog >"$T/proc/77/exe"`, 1), /offen gehalten von watchdog\(77\)/);
    ohneAenderung(laeufe(`${geraet}; echo /dev/watchdog0 >"$T/proc/1/fd/9"`, 1), /offen gehalten von systemd\(1\)/);
  });
  it('sbd als Besitzer ist erlaubt (Wiederholung nach der Fencing-Einrichtung)', () => {
    const w = laeufe('mkdir -p "$T/wd/watchdog0" "$T/proc/88/fd"; echo "i6300ESB timer" >"$T/wd/watchdog0/identity"; echo /dev/watchdog0 >"$T/proc/88/fd/4"; echo sbd >"$T/proc/88/comm"; echo /usr/sbin/sbd >"$T/proc/88/exe"', 1);
    expect(w.laeufe[0]!.rc, w.laeufe[0]!.aus).toBe(0);
    expect(w.laeufe[0]!.log).not.toContain('modprobe');
    // ein fremdes Programm namens sbd zählt nicht
    ohneAenderung(laeufe('mkdir -p "$T/wd/watchdog0" "$T/proc/88/fd"; echo "i6300ESB timer" >"$T/wd/watchdog0/identity"; echo /dev/watchdog0 >"$T/proc/88/fd/4"; echo sbd >"$T/proc/88/comm"; echo /tmp/sbd >"$T/proc/88/exe"', 1), /offen gehalten von sbd\(88\)/);
  });
  it('Abbruch vor jeder Änderung: falscher Rechner, abweichende SQL- oder Paketversion, beschädigter hosts-Block', () => {
    ohneAenderung(laeufe('echo fremd01 >"$T/name"', 1), /fremd01 gehört nicht zu den Knoten/);
    ohneAenderung(laeufe('printf "hold ok installed|17.0.4010.1-1" >"$T/dpkg/mssql-server"', 1), /mssql-server ist in Version '17.0.4010.1-1'/);
    ohneAenderung(laeufe('printf "install ok installed|0.11.8-1" >"$T/dpkg/pcs"', 1), /pcs ist in Version 0.11.8-1 installiert/);
    const w = laeufe('printf "# ALFRED-HA ANFANG (fest erzeugt, I8e Paket 2 — nicht von Hand ändern)\\n10.0.0.1 x\\n" >>"$T/hosts.tmpl"', 1);
    expect(w.laeufe[0]!.rc).toBe(1);
    expect(String(w.laeufe[0]!.ergebnis?.fehler)).toContain('Block beschädigt');
    expect(w.laeufe[0]!.log.trim()).toBe('');
  });
  it('Kennung nach modprobe falsch → Abbruch, Watchdog-Konfiguration nicht als fertig gemeldet', () => {
    const w = laeufe('echo "iTCO_wdt" >"$T/kennung"', 1);
    expect(w.laeufe[0]!.rc).toBe(1);
    expect(String(w.laeufe[0]!.ergebnis?.fehler)).toMatch(/stammt von 'iTCO_wdt'.*nach dem Laden des Moduls/);
    expect(w.laeufe[0]!.log).not.toMatch(/chpasswd|nft|mssql-conf/);
  });
  it('Loopback-Zeile mit weiteren Namen bleibt ohne den eigenen Namen; ein fremder Eintrag für einen Knoten fällt in der Selbstprüfung auf', () => {
    const w = laeufe('printf "127.0.0.1 localhost\\n127.0.1.1 sqllnx02 druckerhost # Kommentar\\n" >"$T/hosts"', 1);
    expect(w.laeufe[0]!.rc, w.laeufe[0]!.aus).toBe(0);
    expect(w.hosts).toContain('# ALFRED-HA ENTFERNT (Loopback mit eigenem Namen): 127.0.1.1 sqllnx02 druckerhost # Kommentar\n127.0.1.1 druckerhost\n');
    const f = laeufe('printf "127.0.0.1 localhost\\n192.168.5.5 sqllnx01\\n" >"$T/hosts"', 1);
    expect(f.laeufe[0]!.rc).toBe(1);
    expect(String(f.laeufe[0]!.ergebnis?.fehler)).toContain("sqllnx01 löst zu '10.203.30.10 192.168.5.5' auf, erwartet 10.203.30.10");
  });
  it('Wiederholung auf einem Cluster-Knoten (Pakete und corosync.conf da, Dienste laufen): Cluster-Dienste bleiben unberührt', () => {
    const vorher = String.raw`for pv in 'pacemaker=2.1.6-5ubuntu2' 'pacemaker-cli-utils=2.1.6-5ubuntu2' 'corosync=3.1.7-1ubuntu3.2' 'pcs=0.11.7-1ubuntu1.1' 'sbd=1.5.2-2ubuntu2' 'resource-agents-base=1:4.13.0-1ubuntu4.2' 'mssql-server-ha=17.0.4006.2-1'; do printf 'hold ok installed|%s' "§{pv#*=}" >"$T/dpkg/§{pv%%=*}"; done
printf 'install ok installed|1' >"$T/dpkg/linux-modules-extra-6.8.0-147-generic"; printf 'totem {
    cluster_name: sqllnxcl01
    transport: knet
}
nodelist {
    node {
        ring0_addr: 10.203.30.10
        name: sqllnx01
        nodeid: 1
    }
}
' >"$T/corosync.conf"
for d in pacemaker corosync sbd; do touch "$T/svc/$d.is-enabled" "$T/svc/$d.is-active"; done`.replaceAll('§{', '${');
    const w = laeufe(vorher, 1);
    expect(w.laeufe[0]!.rc, w.laeufe[0]!.aus).toBe(0);
    expect(w.laeufe[0]!.log).not.toMatch(/disable|stop (pacemaker|corosync|sbd)/);
    expect(w.laeufe[0]!.log).not.toContain('apt-get');
  });
  it('python3 ohne crypt: Abbruch vor jeder Änderung; Vergleich nicht möglich (Exit 2) → sichtbarer Abbruch statt chpasswd', () => {
    const a = laeufe('touch "$T/ohne_crypt"', 1);
    expect(a.laeufe[0]!.rc).toBe(1);
    expect(String(a.laeufe[0]!.ergebnis?.fehler)).toContain('crypt fehlt');
    expect(a.laeufe[0]!.log.trim()).toBe('');
    const b = laeufe('echo 2 >"$T/crypt_rc"', 1);
    expect(b.laeufe[0]!.rc).toBe(1);
    expect(String(b.laeufe[0]!.ergebnis?.fehler)).toContain('hacluster-Kennwort nicht prüfbar (python3 crypt, Exit 2)');
    expect(b.laeufe[0]!.log).not.toContain('chpasswd');
  });
  // Final-Review I-1: ein Abbruch nach einer Änderung nennt sie (wie R8 bei der AG); vor jeder Änderung bleibt die Meldung ohne Liste
  it('I-1: Abbruch nach Änderungen (Pakete installiert, dann Kennwort nicht prüfbar) → „bisher geändert: …“; Abbruch davor ohne Liste', () => {
    const b = laeufe('echo 2 >"$T/crypt_rc"', 1).laeufe[0]!;
    const f = String(b.ergebnis?.fehler);
    expect(b.rc).toBe(1);
    expect(f).toMatch(/^hacluster-Kennwort nicht prüfbar \(python3 crypt, Exit 2\) — bisher geändert: [^"]*\bpakete\b/);
    expect(f).toContain('halten:pcs');
    expect(b.aus.split('\n').filter(z => z.startsWith('ALFRED-HA ')).length).toBe(1);
    const a = laeufe('touch "$T/ohne_crypt"', 1).laeufe[0]!;
    expect(String(a.ergebnis?.fehler)).not.toContain('bisher geändert');
  });
  it('Konfig-Knoten: gleiche Grundlage, Rolle im Ergebnis', () => {
    const w = laeufe('echo sqllnxcfg >"$T/name"; printf "127.0.0.1 localhost\\n127.0.1.1 sqllnxcfg.ad.3033.at sqllnxcfg\\n" >"$T/hosts"', 1, { ...P, rolle: 'konfig' });
    expect(w.laeufe[0]!.rc, w.laeufe[0]!.aus).toBe(0);
    expect(w.laeufe[0]!.ergebnis).toMatchObject({ zustand: 'geaendert', knoten: 'sqllnxcfg', rolle: 'konfig' });
  });
  // Live-Fix (Change 710116b4): crm_mon fehlte — pacemaker-cli-utils nicht installiert
  it('Live-Fix: Knoten aus einem früheren Lauf ohne pacemaker-cli-utils → Wiederholung installiert nur dieses Paket, kein SQL-Neustart, Cluster-Dienste unberührt; danach „schon“', () => {
    const ohneCli = String.raw`for pv in 'pacemaker=2.1.6-5ubuntu2' 'corosync=3.1.7-1ubuntu3.2' 'pcs=0.11.7-1ubuntu1.1' 'sbd=1.5.2-2ubuntu2' 'resource-agents-base=1:4.13.0-1ubuntu4.2' 'mssql-server-ha=17.0.4006.2-1'; do printf 'hold ok installed|%s' "§{pv#*=}" >"$T/dpkg/§{pv%%=*}"; done
printf 'install ok installed|1' >"$T/dpkg/linux-modules-extra-6.8.0-147-generic"
printf 'totem {\n\tcluster_name: sqllnxcl01\n}\n' >"$T/corosync.conf"; printf '[hadr]\nhadrenabled = 1\n' >>"$T/mssql.conf"
for d in pacemaker corosync sbd pcsd; do touch "$T/svc/$d.is-enabled" "$T/svc/$d.is-active"; done`.replaceAll('§{', '${');
    const w = laeufe(ohneCli, 2);
    const [a, b] = w.laeufe as [Lauf, Lauf];
    expect(a.rc, a.aus).toBe(0);
    const installs = a.log.split('\n').filter(z => z.includes(' install '));
    expect(installs).toEqual(['apt-get -o DPkg::Lock::Timeout=300 install -y -q --no-install-recommends -o Dpkg::Options::=--force-confold pacemaker-cli-utils=2.1.6-5ubuntu2']);
    expect(a.log).toContain('apt-mark -o DPkg::Lock::Timeout=300 hold pacemaker-cli-utils');
    expect(a.log).not.toMatch(/mssql-conf|restart mssql-server|disable|stop (pacemaker|corosync|sbd)|restart (pacemaker|corosync|sbd|pcsd)/);
    expect(a.ergebnis).toMatchObject({ neustartSql: false, pakete: { 'pacemaker-cli-utils': '2.1.6-5ubuntu2' } });
    expect(a.ergebnis!.aenderungen).toEqual(expect.arrayContaining(['pakete', 'halten:pacemaker-cli-utils']));
    expect(b.rc, b.aus).toBe(0);
    expect(b.ergebnis).toMatchObject({ zustand: 'schon', aenderungen: [] });
    expect(b.log.trim()).toBe('');
  });
  it('Live-Fix: fehlt nach der Installation ein Programm der HA-Bausteine → sichtbarer Abbruch mit Namen', () => {
    const w = laeufe('touch "$T/fehlt_crm_mon" "$T/fehlt_mssql-conf"', 1);
    expect(w.laeufe[0]!.rc).toBe(1);
    expect(String(w.laeufe[0]!.ergebnis?.fehler)).toContain('nach der Installation fehlen Programme der HA-Bausteine: crm_mon, /opt/mssql/bin/mssql-conf');
    expect(w.laeufe[0]!.log).not.toMatch(/chpasswd|mssql-conf set|nft -f/);
  });
  // Task 3, Carry-over a: Teil-Lauf (Pakete schon installiert, Debian aktivierte die Dienste) — die Wiederholung schaltet sie trotzdem ab
  const PAKETE_DA = String.raw`for pv in 'pacemaker=2.1.6-5ubuntu2' 'pacemaker-cli-utils=2.1.6-5ubuntu2' 'corosync=3.1.7-1ubuntu3.2' 'pcs=0.11.7-1ubuntu1.1' 'sbd=1.5.2-2ubuntu2' 'resource-agents-base=1:4.13.0-1ubuntu4.2' 'mssql-server-ha=17.0.4006.2-1'; do printf 'hold ok installed|%s' "§{pv#*=}" >"$T/dpkg/§{pv%%=*}"; done
printf 'install ok installed|1' >"$T/dpkg/linux-modules-extra-6.8.0-147-generic"`.replaceAll('§{', '${');
  it('Wiederholung nach abgebrochenem Erstlauf: Debian-Standardkonfiguration gilt als „kein Cluster“ → Dienste aus, Konfiguration beiseite', () => {
    const debian = String.raw`printf 'totem {\n\tversion: 2\n\tcluster_name: debian\n}\n\nnodelist {\n\tnode {\n\t\tname: node1\n\t\tnodeid: 1\n\t\tring0_addr: 127.0.0.1\n\t}\n}\n' >"$T/corosync.conf"`;
    const w = laeufe(`${PAKETE_DA}\n${debian}; for d in pacemaker corosync sbd; do touch "$T/svc/$d.is-enabled"; done; touch "$T/svc/corosync.is-active"`, 2);
    const [a, b] = w.laeufe as [Lauf, Lauf];
    expect(a.rc, a.aus).toBe(0);
    expect(a.log).not.toContain('apt-get');
    for (const d of ['pacemaker', 'corosync', 'sbd']) expect(a.log).toContain(`systemctl disable --now ${d}`);
    expect(a.ergebnis!.aenderungen).toEqual(expect.arrayContaining(['aus:pacemaker', 'aus:corosync', 'aus:sbd', 'corosync-standard-beiseite']));
    expect(w.dateien).toMatch(/(^|\n)corosync\.conf\.alfred-debian-\d{14}\n/);
    expect(w.dateien).not.toMatch(/(^|\n)corosync\.conf\n/);
    // ohne corosync.conf: weiterhin „kein Cluster“, aber nichts mehr zu tun
    expect(b.rc, b.aus).toBe(0);
    expect(b.ergebnis).toMatchObject({ zustand: 'schon', aenderungen: [] });
  });
  it('eingerichteter fremder Cluster (eigener Name, echte Adressen): Cluster-Dienste und corosync.conf bleiben unberührt', () => {
    const fremd = String.raw`printf 'totem {\n    cluster_name: anderes\n}\nnodelist {\n    node {\n        ring0_addr: 10.9.9.9\n        name: x1\n    }\n}\n' >"$T/corosync.conf"; for d in pacemaker corosync sbd; do touch "$T/svc/$d.is-enabled" "$T/svc/$d.is-active"; done`;
    const w = laeufe(`${PAKETE_DA}\n${fremd}`, 1);
    expect(w.laeufe[0]!.rc, w.laeufe[0]!.aus).toBe(0);
    expect(w.laeufe[0]!.log).not.toMatch(/disable/);
    expect(w.dateien).toMatch(/(^|\n)corosync\.conf\n/);
  });
  // ── Live-Fix (Change c2e4f56d): sbd startete vor /dev/watchdog ──
  const CLUSTER_KNOTEN = String.raw`printf 'totem {\n    cluster_name: sqllnxcl01\n}\nnodelist {\n    node {\n        ring0_addr: 10.203.30.12\n        name: sqllnxcfg\n        nodeid: 3\n    }\n}\n' >"$T/corosync.conf"
printf '[hadr]\nhadrenabled = 1\n' >>"$T/mssql.conf"; printf 'SBD_WATCHDOG_DEV=/dev/null\nSBD_WATCHDOG_TIMEOUT=10\n' >"$T/sbd_default"
for d in pacemaker corosync sbd pcsd; do touch "$T/svc/$d.is-enabled"; done; touch "$T/svc/corosync.is-active" "$T/svc/pcsd.is-active"`;
  const INV = '4f1c2b0d9e8a47b6a1c3d5e7f9012345';
  const WD_MELDUNG = "sbd[612]: error: watchdog_init_fd: Seems as if '/dev/watchdog' isn't a valid watchdog-device: No such file or directory";
  /** Fix-Runde B: sbd failed, letzte Ausführung INV scheiterte am fehlenden Gerät (dieselbe Meldung auch im ganzen Journal des Starts) */
  const SBD_FEHLT = `touch "$T/svc/sbd.is-failed"; echo ${INV} >"$T/sbd_inv"; printf '%s\\n' "${WD_MELDUNG}" >"$T/journal_inv_${INV}"; cp "$T/journal_inv_${INV}" "$T/journal_sbd"`;
  it('Live-Fix: Drop-in (After=systemd-modules-load, ExecStartPre=Warteskript) und Warteskript fest geschrieben, daemon-reload nur bei Änderung; zweiter Lauf „schon“', () => {
    const w = laeufe('', 2);
    const [a, b] = w.laeufe as [Lauf, Lauf];
    expect(a.rc, a.aus).toBe(0);
    expect(a.ergebnis!.aenderungen).toEqual(expect.arrayContaining(['sbd-warteskript', 'sbd-wartet-auf-watchdog', 'systemd-neu-geladen-sbd']));
    expect(a.ergebnis).toMatchObject({ sbdWartetAufWatchdog: true, sbdZurueckgeholt: false });
    expect(a.log).toContain('systemctl daemon-reload');
    expect(w.dateien).toContain('etc/systemd/system/sbd.service.d/alfred-watchdog.conf');
    expect(w.dateien).toContain('etc/alfred-lib/warte-watchdog');
    expect(b.ergebnis).toMatchObject({ zustand: 'schon', aenderungen: [] });
    expect(b.log.trim()).toBe('');
    expect(SBD_DROPIN_INHALT.split('\n')).toEqual(expect.arrayContaining(['[Unit]', 'Wants=systemd-modules-load.service', 'After=systemd-modules-load.service', '[Service]', 'ExecStartPre=/usr/local/lib/alfred/warte-watchdog']));
    expect(HA_SBD_DROPIN).toBe('/etc/systemd/system/sbd.service.d/alfred-watchdog.conf');
  });
  it('Live-Fix: Warteskript — Gerät aus /etc/default/sbd (auch in Anführungszeichen) als Zeichengerät → 0; fehlt es → nach der Wartezeit Exit 1 mit Meldung', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-wd-'));
    try {
      const konf = join(dir, 'sbd');
      const lauf = (inhalt: string | undefined, grenze = '1') => { if (inhalt === undefined) rmSync(konf, { force: true }); else writeFileSync(konf, inhalt); return spawnSync('sh', ['-c', WARTE_WATCHDOG_SKRIPT, 'warte', konf.replace(/\\/g, '/'), grenze, 'true'], { encoding: 'utf8' }); }; // modprobe nachgebildet: lädt, Gerät bleibt aus
      expect(lauf('SBD_WATCHDOG_DEV=/dev/null\n').status).toBe(0);
      expect(lauf('# Kommentar\nSBD_WATCHDOG_DEV="/dev/null"\n').status).toBe(0);
      expect(lauf("SBD_WATCHDOG_DEV='/dev/null'\n").status).toBe(0);
      const f = lauf('SBD_WATCHDOG_DEV=/dev/alfred-gibt-es-nicht\n');
      expect(f.status).toBe(1);
      expect(f.stderr).toContain('Watchdog-Gerät /dev/alfred-gibt-es-nicht nach 1 s nicht vorhanden — sbd startet nicht');
      expect(lauf('SBD_WATCHDOG_DEV=/dev/alfred-x\nSBD_WATCHDOG_DEV=/dev/null\n').status).toBe(0); // letzter Eintrag gilt
      expect(lauf(undefined).stderr).toContain('Watchdog-Gerät /dev/watchdog nach 1 s'); // ohne Konfiguration: /dev/watchdog
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('Live-Fix: sbd scheiterte am fehlenden Watchdog-Gerät, Gerät jetzt da → nur DIESER Knoten: reset-failed, pcs cluster stop/start (lokal), danach sbd und pacemaker aktiv', () => {
    const w = laeufe(`${PAKETE_DA}\n${CLUSTER_KNOTEN}\n${SBD_FEHLT}\necho sqllnxcfg >"$T/name"; printf "127.0.0.1 localhost\\n" >"$T/hosts"`, 2);
    const [a, b] = w.laeufe as [Lauf, Lauf];
    expect(a.rc, a.aus).toBe(0);
    const befehle = a.log.split('\n').filter(z => /reset-failed|^pcs /.test(z));
    expect(befehle).toEqual(['systemctl reset-failed sbd', 'pcs cluster stop', 'pcs cluster start --wait=120']); // ohne --all
    expect(a.ergebnis!.aenderungen).toEqual(expect.arrayContaining(['sbd-reset-failed', 'cluster-hier-gestoppt', 'cluster-hier-gestartet']));
    expect(a.ergebnis).toMatchObject({ sbdZurueckgeholt: true });
    // danach gesund: nichts mehr anfassen
    expect(b.rc, b.aus).toBe(0);
    expect(b.ergebnis).toMatchObject({ zustand: 'schon', sbdZurueckgeholt: false, aenderungen: [] });
    expect(b.log).not.toMatch(/pcs |reset-failed/);
  });
  it('Live-Fix: gesundes sbd nie angefasst; anderer Grund, laufender Pacemaker oder weiter fehlendes Gerät → sichtbarer Abbruch ohne pcs', () => {
    const gesund = laeufe(`${PAKETE_DA}\n${CLUSTER_KNOTEN}\n${SBD_FEHLT}\ntouch "$T/svc/sbd.is-active" "$T/svc/pacemaker.is-active"; echo sqllnxcfg >"$T/name"; printf "127.0.0.1 localhost\\n" >"$T/hosts"`, 1);
    expect(gesund.laeufe[0]!.rc, gesund.laeufe[0]!.aus).toBe(0);
    expect(gesund.laeufe[0]!.log).not.toMatch(/pcs |reset-failed/);
    const f = (zusatz: string, muster: RegExp) => {
      const w = laeufe(`${PAKETE_DA}\n${CLUSTER_KNOTEN}\necho sqllnxcfg >"$T/name"; printf "127.0.0.1 localhost\\n" >"$T/hosts"\n${zusatz}`, 1);
      const a = w.laeufe[0]!;
      expect(a.rc).toBe(1);
      expect(String(a.ergebnis?.fehler)).toMatch(muster);
      expect(a.log).not.toMatch(/pcs |reset-failed/);
    };
    f(`${SBD_FEHLT}; printf 'sbd: anderer Fehler\\n' >"$T/journal_inv_${INV}"`, new RegExp(`sbd ist auf sqllnxcfg gescheitert, die letzte Ausführung \\(${INV}\\) nennt aber nicht das fehlende Watchdog-Gerät — nicht automatisch`));
    f(`${SBD_FEHLT}; touch "$T/svc/pacemaker.is-active"`, /Pacemaker aber schon — nicht automatisch/);
    f(`${SBD_FEHLT}; printf 'SBD_WATCHDOG_DEV=/dev/alfred-gibt-es-nicht\\n' >"$T/sbd_default"`, /es fehlt noch immer — nichts am Cluster geändert/);
    // Fix-Runde B: Auslöser eingegrenzt
    // absichtlich gestoppt (inactive, NICHT failed), alte Meldung im Journal dieses Starts → keine Rückholung, Selbstprüfung bricht sichtbar ab
    f(`printf '%s\\n' "${WD_MELDUNG}" >"$T/journal_sbd"`, /Selbstprüfung: sbd läuft auf sqllnxcfg nicht \(Cluster eingerichtet, SBD aktiviert\)/);
    // failed, alte Meldung im Journal des Starts, die LETZTE Ausführung scheiterte anders → Abbruch ohne pcs
    f(`${SBD_FEHLT}; echo 0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a >"$T/sbd_inv"; printf 'sbd: Konfiguration ungültig\\n' >"$T/journal_inv_0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a"`, /letzte Ausführung \(0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a\) nennt aber nicht das fehlende Watchdog-Gerät/);
    // InvocationID nicht lesbar → nicht automatisch
    f(`${SBD_FEHLT}; : >"$T/sbd_inv"`, /die letzte Ausführung \(InvocationID ''\) ist nicht lesbar — nicht automatisch/);
  });
  // ── Live-Fix 2 (c2e4f56d, zweiter Reset 16:20:27): i6300esb ist auf Ubuntus Sperrliste — modules-load.d lädt es nie ──
  it('Live-Fix 2: Knoten im heutigen Zustand (sbd vom Warteskript gescheitert, Modul nicht geladen, Gerät fehlt) → erst modprobe (Gerät erscheint), dann Rückholung nur dieses Knotens', () => {
    const heute = [
      `${PAKETE_DA}\n${CLUSTER_KNOTEN}\n${SBD_FEHLT}`,
      `printf '%s\\n' 'alfred: Watchdog-Gerät /dev/watchdog nach 60 s nicht vorhanden — sbd startet nicht' >"$T/journal_inv_${INV}"`,
      // Gerät fehlt, bis i6300esb geladen ist (kein watchdog0 in /sys); SBD_WATCHDOG_DEV zeigt auf das nachgebildete Gerät
      `printf 'SBD_WATCHDOG_DEV=%s\\n' "$T/dev_wd" >"$T/sbd_default"; echo "$T/dev_wd" >"$T/dev_wd_pfad"; rm -rf "$T/wd/watchdog0"`,
      `echo sqllnxcfg >"$T/name"; printf "127.0.0.1 localhost\\n" >"$T/hosts"`,
    ].join('\n');
    const w = laeufe(heute, 2);
    const [a, b] = w.laeufe as [Lauf, Lauf];
    expect(a.rc, a.aus).toBe(0);
    const zeilen = a.log.split('\n');
    const pos = (t: string) => zeilen.findIndex(z => z.startsWith(t));
    expect(pos('modprobe i6300esb')).toBeGreaterThanOrEqual(0);
    expect(pos('modprobe i6300esb')).toBeLessThan(pos('systemctl reset-failed sbd'));
    expect(pos('systemctl reset-failed sbd')).toBeLessThan(pos('pcs cluster stop'));
    expect(pos('pcs cluster stop')).toBeLessThan(pos('pcs cluster start --wait=120'));
    expect(a.ergebnis!.aenderungen).toEqual(expect.arrayContaining(['i6300esb-geladen', 'sbd-reset-failed', 'cluster-hier-gestoppt', 'cluster-hier-gestartet']));
    expect(a.ergebnis).toMatchObject({ sbdZurueckgeholt: true });
    expect(b.ergebnis).toMatchObject({ zustand: 'schon', aenderungen: [] });
  });
  it('Live-Fix 2: alte modules-load.d-Datei (wirkungslos wegen Sperrliste) wird entfernt; Ubuntus Sperrdateien bleiben unberührt; Status hängt nicht daran', () => {
    const w = laeufe('mkdir -p "$T/etc/modules-load.d"; printf "# Alfred I8e Paket 2: Hardware-Watchdog für SBD\\ni6300esb\\n" >"$T/etc/modules-load.d/a.conf"', 2);
    const [a, b] = w.laeufe as [Lauf, Lauf];
    expect(a.rc, a.aus).toBe(0);
    expect(a.ergebnis!.aenderungen).toEqual(expect.arrayContaining(['modules-load-entfernt']));
    expect(w.dateien).not.toContain('modules-load.d');
    expect(b.ergebnis).toMatchObject({ zustand: 'schon', aenderungen: [] });
    const text = haVorbereitenSkript(P);
    expect(text).not.toMatch(/blacklist_linux|\/lib\/modprobe\.d|\/etc\/modprobe\.d\/blacklist/); // keine fremde Sperrdatei angefasst
    expect(PY_HA_STATUS).not.toContain('/etc/modules-load.d/');
    expect(PY_HA_STATUS).toContain('/etc/systemd/system/sbd.service.d/alfred-watchdog.conf');
  });
  it.skipIf(!BASH)('Live-Fix 2: Warteskript lädt i6300esb ausdrücklich (ohne -b, kein Alias) — Sperrliste nachgebildet: nur der ausdrückliche Name lädt; Fehlschlag sichtbar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-mp-'));
    try {
      const p = (x: string) => join(dir, x).replace(/\\/g, '/');
      const konf = p('sbd'); const wd = p('wd'); const log = p('modprobe.log'); const fake = p('modprobe');
      // wie kmod mit Sperrliste: -b/--use-blacklist oder Alias → gesperrt; ausdrücklicher Name i6300esb → geladen, Gerät erscheint
      writeFileSync(fake, `#!/bin/sh\necho "$*" >>"${log}"\ncase "$*" in *-b*|*--use-blacklist*|pci:*) echo "modprobe: i6300esb deny-listed" >&2; exit 1 ;; esac\n[ "$1" = i6300esb ] || exit 1\n[ -f "${p('kaputt')}" ] && exit 1\nln -sf /dev/null "${wd}"\nexit 0\n`, { mode: 0o755 });
      writeFileSync(konf, `SBD_WATCHDOG_DEV=${wd}\n`);
      const lauf = () => spawnSync('sh', ['-c', WARTE_WATCHDOG_SKRIPT, 'warte', konf, '2', fake], { encoding: 'utf8' });
      const geladen = lauf();
      expect(geladen.status, geladen.stderr).toBe(0);
      expect(readFileSync(log, 'utf8').trim()).toBe('i6300esb');
      // Gerät schon da → kein modprobe
      rmSync(log); const da = lauf();
      expect(da.status).toBe(0);
      expect(existsSync(log)).toBe(false);
      // modprobe scheitert → sofort sichtbar, mit Meldung (zählt als Watchdog-Fehler der letzten Ausführung)
      rmSync(wd); writeFileSync(p('kaputt'), '');
      const f = lauf();
      expect(f.status).toBe(1);
      expect(f.stderr).toContain(`alfred: Watchdog-Gerät ${wd} fehlt und modprobe i6300esb ist fehlgeschlagen — sbd startet nicht`);
      expect(WARTE_WATCHDOG_SKRIPT).not.toMatch(/modprobe[^\n]*-b|use-blacklist/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('Fix-Runde B: letzte Ausführung scheiterte am Warteskript (Gerät kam nach 60 s) → Rückholung; Start-Zeitlimit von sbd ≥ 75 s sonst sichtbarer Abbruch; nur Rechte falsch → nur chmod', () => {
    const basis = `${PAKETE_DA}\n${CLUSTER_KNOTEN}\necho sqllnxcfg >"$T/name"; printf "127.0.0.1 localhost\\n" >"$T/hosts"`;
    const warte = laeufe(`${basis}\n${SBD_FEHLT}; printf '%s\\n' 'alfred: Watchdog-Gerät /dev/watchdog nach 60 s nicht vorhanden — sbd startet nicht' >"$T/journal_inv_${INV}"`, 1);
    expect(warte.laeufe[0]!.rc, warte.laeufe[0]!.aus).toBe(0);
    expect(warte.laeufe[0]!.ergebnis).toMatchObject({ sbdZurueckgeholt: true });
    // TimeoutStartUSec: Standard 1min 30s besteht (alle anderen Tests); 45s scheitert sichtbar mit dem Wert; 1min 15s und infinity bestehen
    const zeit = (wert: string) => laeufe(`touch "$T/svc/sbd.is-active"; echo '${wert}' >"$T/sbd_timeout"`, 1).laeufe[0]!;
    const kurz = zeit('45s');
    expect(kurz.rc).toBe(1);
    expect(String(kurz.ergebnis?.fehler)).toContain("sbd.service TimeoutStartUSec ist '45s' — erwartet mindestens 75 s");
    expect(zeit('1min 15s').rc).toBe(0);
    expect(zeit('infinity').rc).toBe(0);
    expect(zeit('1min 14s').rc).toBe(1);
    expect(String(zeit('irgendwas').ergebnis?.fehler)).toContain("TimeoutStartUSec ist 'irgendwas'");
    // Inhalt richtig, nur die Rechte falsch → nur chmod, kein daemon-reload
    const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const rechte = laeufe(`mkdir -p "$T/etc/alfred-lib" "$T/etc/systemd/system/sbd.service.d"; printf '%s\\n' ${q(WARTE_WATCHDOG_SKRIPT)} >"$T/etc/alfred-lib/warte-watchdog"; printf '%s\\n' ${q(SBD_DROPIN_INHALT)} >"$T/etc/systemd/system/sbd.service.d/alfred-watchdog.conf"; touch "$T/warte_nicht_ausfuehrbar"`, 1).laeufe[0]!;
    expect(rechte.rc, rechte.aus).toBe(0);
    expect(rechte.log).toContain('chmod 0755 warte-watchdog');
    expect(rechte.ergebnis!.aenderungen).toEqual(expect.arrayContaining(['sbd-warteskript-rechte']));
    expect(rechte.ergebnis!.aenderungen).not.toEqual(expect.arrayContaining(['sbd-warteskript']));
    expect(rechte.ergebnis!.aenderungen).not.toEqual(expect.arrayContaining(['systemd-neu-geladen-sbd']));
  });
});

// ── Task 3: Cluster und diskless SBD ────────────────────────────────────────────────────────────────────────────────────────────

describe('I8e Paket 2 — cluster_anlegen Validatoren', () => {
  it('stonith_timeout_s ≥ 2 × sbd_timeout_s; ganze Sekunden; Clustername; genau drei Knoten', () => {
    expect(pruefeHaCluster(PC)).toBeUndefined();
    expect(pruefeHaCluster({ ...PC, stonith_timeout_s: 19 })).toContain('mindestens 2 × sbd_timeout_s sein (20)');
    expect(pruefeHaCluster({ ...PC, sbd_timeout_s: 15, stonith_timeout_s: 30 })).toBeUndefined();
    expect(pruefeHaCluster({ ...PC, sbd_timeout_s: 15, stonith_timeout_s: 29 })).toContain('(30)');
    expect(pruefeHaCluster({ ...PC, stonith_timeout_s: 21 })).toBeUndefined();
    expect(pruefeHaCluster({ ...PC, sbd_timeout_s: 4 })).toContain('sbd_timeout_s');
    expect(pruefeHaCluster({ ...PC, sbd_timeout_s: 61, stonith_timeout_s: 200 })).toContain('sbd_timeout_s');
    expect(pruefeHaCluster({ ...PC, sbd_timeout_s: 10.5 })).toContain('sbd_timeout_s');
    expect(pruefeHaCluster({ ...PC, stonith_timeout_s: '20' })).toContain('stonith_timeout_s');
    expect(pruefeHaCluster({ ...PC, stonith_timeout_s: 601 })).toContain('bis 600');
    expect(pruefeHaCluster({ ...PC, cluster: 'x; rm' })).toContain('cluster');
    expect(pruefeHaCluster({ ...PC, cluster: 'debian' })).toContain('Debian');
    expect(pruefeHaCluster({ ...PC, knoten: HA_KNOTEN.slice(0, 2) })).toContain('drei');
    expect(pruefeHaClusterEntfernen({ cluster: 'sqllnxcl01', knoten: HA_KNOTEN })).toBeUndefined();
  });
  it('Skripttext: kein Kennwort, Kennwort nur über die Pipe aus printf an pcs host auth, feste Adressen, diskless SBD, kein --force bei setup', () => {
    const s = haClusterSkript({ ...PC, hacluster: 'Geheim-Wert-42' } as never);
    expect(s).not.toContain('Geheim-Wert-42');
    expect(s).toContain('KW=$(feld hacluster)');
    expect(s).toContain(`printf '%s\\n' "$KW" | pcs host auth "\${KNOTEN_ADDR[@]}" -u hacluster`);
    expect(s).not.toMatch(/pcs host auth[^\n]*-p\b/);
    expect(s).toContain("KNOTEN_ADDR=('sqllnx01' 'addr=10.203.30.10' 'sqllnx02' 'addr=10.203.30.11' 'sqllnxcfg' 'addr=10.203.30.12')");
    expect(s).toContain('pcs cluster setup "$CLUSTER" "${KNOTEN_ADDR[@]}" transport knet');
    expect(s).toContain('pcs stonith sbd enable "watchdog=$WD_DEV" "SBD_WATCHDOG_TIMEOUT=$SBD_T"');
    const befehle = s.split('\n').filter(z => !z.trim().startsWith('#')).join('\n');
    expect(befehle).not.toMatch(/sbd[^\n]* create|device=/);
    expect(befehle).not.toMatch(/cluster setup[^\n]*--force/);
    expect(s).not.toMatch(/property set[^\n]*have-watchdog/);
    expect(s).toContain("WD_DEV='/dev/watchdog'");
    expect(s).toContain('SBD_T=10');
    expect(s).toContain('STONITH_T=20');
    expect(s).toContain(`ALFRED_P='${JSON.stringify({ cluster: 'sqllnxcl01', knoten: HA_KNOTEN, sbd_timeout_s: 10, stonith_timeout_s: 20 })}'`);
  });
});

// crm_mon --output-as=xml (pacemaker 2.1.6), gekürzt auf die gelesenen Teile; Ressource mit eigenem <node> darf nicht mitzählen
const CRM_XML = `<pacemaker-result api-version="2.30" request="crm_mon -1 --output-as=xml">
  <summary>
    <stack type="corosync" pacemakerd-state="running"/>
    <current_dc present="true" version="2.1.6-6fdc9deea29" name="sqllnx01" id="1" with_quorum="true" mixed_version="false"/>
    <last_update time="Tue Nov 17 10:00:00 2026"/>
    <nodes_configured number="3"/>
    <resources_configured number="1" disabled="0" blocked="0"/>
    <cluster_options stonith-enabled="true" symmetric-cluster="true" no-quorum-policy="stop" maintenance-mode="false" stop-all-resources="false" stonith-timeout-ms="60000" priority-fencing-delay-ms="0"/>
  </summary>
  <nodes>
    <node name="sqllnx01" id="1" online="true" standby="false" standby_onfail="false" maintenance="false" pending="false" unclean="false" health="green" feature_set="3.17.4" shutdown="false" expected_up="true" is_dc="true" resources_running="1" type="member"/>
    <node name="sqllnx02" id="2" online="true" standby="false" standby_onfail="false" maintenance="false" pending="false" unclean="false" health="green" feature_set="3.17.4" shutdown="false" expected_up="true" is_dc="false" resources_running="0" type="member"/>
    <node name="sqllnxcfg" id="3" online="false" standby="false" standby_onfail="false" maintenance="false" pending="false" unclean="false" health="green" feature_set="3.17.4" shutdown="false" expected_up="true" is_dc="false" resources_running="0" type="member"/>
  </nodes>
  <resources>
    <resource id="probe" resource_agent="ocf:heartbeat:Dummy" role="Started" active="true" orphaned="false" blocked="false" failed="false" failure_ignored="false" nodes_running_on="1">
      <node name="sqllnx01" id="1" cached="true"/>
    </resource>
  </resources>
  <status code="0" message="OK"/>
</pacemaker-result>`;
// altes crm_mon --as-xml (Wurzel crm_mon), ohne Quorum, stonith aus
const CRM_XML_ALT = `<?xml version="1.0"?>
<crm_mon version="2.1.6">
  <summary>
    <current_dc present="true" version="2.1.6" name="sqllnx02" id="2" with_quorum="false"/>
    <nodes_configured number="3"/>
    <resources_configured number="0" disabled="0" blocked="0"/>
    <cluster_options stonith-enabled="false" symmetric-cluster="true" no-quorum-policy="stop"/>
  </summary>
  <nodes>
    <node name="sqllnx02" id="2" online="true" standby="false" unclean="false" type="member"/>
    <node name="sqllnx01" id="1" online="true" standby="false" unclean="true" type="member"/>
    <node name="sqllnxcfg" id="3" online="false" standby="false" unclean="false" type="member"/>
  </nodes>
</crm_mon>`;

describe.skipIf(!PYTHON)('I8e Paket 2 — crm_mon-XML lesen (PY_CRM_LAGE)', () => {
  const lage = (xml: string) => spawnSync(PYTHON!, ['-c', PY_CRM_LAGE], { input: xml, encoding: 'utf8' });
  it('pacemaker 2.1 --output-as=xml: Knoten, online (sortiert), Quorum, stonith-enabled, Ressourcen; Ressourcen-<node> zählt nicht', () => {
    const r = lage(CRM_XML);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('3 2 1 1 1 sqllnx01,sqllnx02');
  });
  it('altes --as-xml: unclean zählt nicht als online; ohne Quorum, stonith aus', () => {
    expect(lage(CRM_XML_ALT).stdout.trim()).toBe('3 1 0 0 0 sqllnx02');
  });
  it('Live-Fix (c2e4f56d): ein Knoten mit pending="true" (corosync-Mitglied, Pacemaker noch nicht beigetreten) zählt nicht als online', () => {
    expect(lage(CRM_XML.replace('name="sqllnx02" id="2" online="true" standby="false" standby_onfail="false" maintenance="false" pending="false"', 'name="sqllnx02" id="2" online="true" standby="false" standby_onfail="false" maintenance="false" pending="true"')).stdout.trim()).toBe('3 1 1 1 1 sqllnx01');
  });
  it('kaputtes XML → Exit 2 (Bash wertet das als „nichts online“)', () => {
    expect(lage('<pacemaker-result><summary>').status).toBe(2);
  });
  it('Status-Teile (PY_CLUSTER_FUNK): corosync.conf von pcs, Debian-Standard, pcs stonith sbd status', () => {
    const py = (code: string, input: string) => JSON.parse(spawnSync(PYTHON!, ['-c', `import json, sys\n${PY_CLUSTER_FUNK}\n${code}`], { input, encoding: 'utf8' }).stdout);
    const pcsConf = 'totem {\n    version: 2\n    cluster_name: sqllnxcl01\n    transport: knet\n    crypto_cipher: aes256\n}\n\nnodelist {\n    node {\n        ring0_addr: 10.203.30.10\n        name: sqllnx01\n        nodeid: 1\n    }\n\n    node {\n        ring0_addr: 10.203.30.11\n        name: sqllnx02\n        nodeid: 2\n    }\n}\n\nquorum {\n    provider: corosync_votequorum\n}\n';
    expect(py('print(json.dumps(konf(sys.stdin.read())))', pcsConf)).toEqual(['sqllnxcl01', [{ name: 'sqllnx01', ip: '10.203.30.10' }, { name: 'sqllnx02', ip: '10.203.30.11' }]]);
    expect(py('print(json.dumps(konf(sys.stdin.read())))', 'totem {\n\tcluster_name: debian # Standard\n}\nnodelist {\n\tnode {\n\t\tname: node1\n\t\tring0_addr: 127.0.0.1\n\t}\n}\n')).toEqual(['debian', [{ name: 'node1', ip: '127.0.0.1' }]]);
    const sbd = 'SBD STATUS\n<node name>: <installed> | <enabled> | <running>\nsqllnx01: YES | YES | YES\nsqllnx02: YES | YES |  NO\nsqllnxcfg: YES |  NO |  NO\n';
    expect(py('print(json.dumps(sbd_lesen(sys.stdin.read())))', sbd)).toEqual({
      sqllnx01: { installiert: true, aktiviert: true, laeuft: true }, sqllnx02: { installiert: true, aktiviert: true, laeuft: false }, sqllnxcfg: { installiert: true, aktiviert: false, laeuft: false } });
  });
});

// ── Cluster-Bausteine mit nachgebildetem Dreier-Cluster ausführen (bash + python) ───────────────────────────────────────────────
const CL_STUBS = String.raw`
COROSYNC_CONF="$T/conf/$(cat "$T/name")"; CIB_DATEI="$T/cib.xml"; WD_SYS="$T/wd"; WD_DEV="$T/dev_watchdog"; WARTE_RUNDEN=3
ALLE="sqllnx01 sqllnx02 sqllnxcfg"
log() { echo "$*" >>"$T/log"; }
feld() { cat "$T/kw_eingabe"; }
json_text() { local x; x=$(cat); printf '"%s"' "§{x//\"/}"; }
python3() { "$PY" "$@"; }
eigener_name() { cat "$T/name"; }
sleep() { :; }
dpkg-query() { local f="$T/dpkg/§{@: -1}"; [ -f "$f" ] || return 1; case "$*" in *Version*) cat "$f" ;; *) cut -d'|' -f1 "$f" ;; esac; }
port_offen() { [ ! -f "$T/pcsd_aus/$1" ]; }
systemctl() { local u=§{@: -1}; case "$1" in is-active|is-enabled) [ -f "$T/svc/$u.$1" ]; return ;; esac; log "systemctl $*"; }
# corosync.conf wie pcs 0.11 sie schreibt: „pcs cluster setup <name> <knoten> addr=<ip> … transport knet“
pcs_setup() {
  local name=$1 txt k i=1; shift
  txt=$(printf 'totem {\n    version: 2\n    cluster_name: %s\n    transport: knet\n}\n\nnodelist {' "$name")
  while [ $# -gt 0 ] && [ "$1" != transport ]; do txt+=$(printf '\n    node {\n        ring0_addr: %s\n        name: %s\n        nodeid: %s\n    }\n' "§{2#addr=}" "$1" "$i"); i=$((i + 1)); shift 2; done
  txt+=$'\n}'
  for k in $ALLE; do printf '%s\n' "$txt" >"$T/conf/$k"; done
}
pcs() {
  case "$1 $2" in
    "host auth") local kw; IFS= read -r kw || true; log "pcs host auth §{*:3}"; if [ "$kw" != "$(cat "$T/kw_soll")" ]; then echo 'Password: Error: Unable to authenticate to sqllnx01'; return 1; fi; touch "$T/auth"; echo 'Password: sqllnx01: Authorized'; return 0 ;;
    "status pcsd") shift 2; local k; for k in "$@"; do if [ -f "$T/auth" ]; then echo "  $k: Online"; else echo "  $k: Unable to authenticate"; fi; done; return 0 ;;
    "cluster corosync") if [ -f "$T/auth" ] && [ -f "$T/conf/$3" ]; then cat "$T/conf/$3"; return 0; fi; echo "Error: Unable to get corosync.conf from $3" >&2; return 1 ;;
    "cluster setup") log "pcs $*"; local k; if [ -f "$T/setup_scheitert" ]; then echo 'totem { cluster_name: sqllnxcl01 }' >"$T/conf/sqllnx02"; echo 'Error: Unable to send corosync.conf to sqllnxcfg'; return 1; fi; for k in $ALLE; do if [ -f "$T/conf/$k" ]; then echo "Error: $k: Cluster configuration files found, the host seems to be in a cluster already, use --force to override"; return 1; fi; done; shift 2; pcs_setup "$@"; return 0 ;;
    "stonith sbd")
      case "$3" in
        enable) log "pcs $*"; touch "$T/sbd_en" "$T/svc/sbd.is-enabled"; echo "§{4#watchdog=}" >"$T/sbd_wd"; echo "§{5#SBD_WATCHDOG_TIMEOUT=}" >"$T/sbd_t" ;;
        disable) log "pcs $*"; [ ! -f "$T/sbd_aus_scheitert" ] || { echo 'Error: disable kaputt'; return 1; }; rm -f "$T/sbd_en" "$T/svc/sbd.is-enabled" ;;
        status) echo 'SBD STATUS'; echo '<node name>: <installed> | <enabled> | <running>'; local k e r; for k in $ALLE; do e=' NO'; r=' NO'; if [ -f "$T/sbd_en" ]; then e=YES; if [ -f "$T/laeuft" ]; then r=YES; fi; fi; echo "$k: YES | $e | $r"; done ;;
        config) [ -f "$T/sbd_en" ] || { echo 'Error: SBD is not enabled'; return 1; }; printf 'SBD_DELAY_START=no\nSBD_STARTMODE=always\nSBD_WATCHDOG_TIMEOUT=%s\n\nWatchdogs:\n' "$(cat "$T/sbd_t")"; local k; for k in $ALLE; do echo "  $k: $(cat "$T/sbd_wd")"; done ;;
      esac
      return 0 ;;
    "cluster enable") log "pcs $*"; touch "$T/svc/corosync.is-enabled" "$T/svc/pacemaker.is-enabled"; return 0 ;;
    "cluster start") log "pcs $*"; [ ! -f "$T/start_scheitert" ] || { echo 'Error: unable to start'; return 1; }; touch "$T/laeuft" "$T/svc/corosync.is-active" "$T/svc/pacemaker.is-active"; [ ! -f "$T/sbd_en" ] || touch "$T/svc/sbd.is-active"; return 0 ;;
    "cluster stop") log "pcs $*"; [ ! -f "$T/stop_scheitert" ] || { rm -f "$T/svc/pacemaker.is-active"; echo 'Error: unable to stop all nodes'; return 1; }; rm -f "$T/laeuft" "$T/svc/corosync.is-active" "$T/svc/pacemaker.is-active" "$T/svc/sbd.is-active"; return 0 ;;
    "cluster destroy") log "pcs $*"; rm -f "$T/conf/"* "$T/laeuft" "$T/prop/"*; local d; for d in corosync pacemaker sbd; do rm -f "$T/svc/$d.is-active" "$T/svc/$d.is-enabled"; done; return 0 ;;
    "property set") log "pcs $*"; local kv=$3; echo "§{kv#*=}" >"$T/prop/§{kv%%=*}"; return 0 ;;
  esac
  echo "pcs-Stub kennt '$*' nicht" >&2; return 99
}
crm_mon() {
  [ -f "$T/laeuft" ] || { echo 'crm_mon: Error: cluster is not available on this node' >&2; return 102; }
  local on=3 i=0 k o q=true se=true res=0
  [ ! -f "$T/online" ] || on=$(cat "$T/online"); [ "$on" -ge 2 ] || q=false
  [ ! -f "$T/prop/stonith-enabled" ] || se=$(cat "$T/prop/stonith-enabled")
  [ ! -f "$T/ressourcen" ] || res=$(cat "$T/ressourcen")
  echo '<pacemaker-result api-version="2.30" request="crm_mon -1 --output-as=xml">'
  echo "  <summary><current_dc present=\"true\" name=\"sqllnx01\" id=\"1\" with_quorum=\"$q\"/><nodes_configured number=\"3\"/><resources_configured number=\"$res\" disabled=\"0\" blocked=\"0\"/><cluster_options stonith-enabled=\"$se\" no-quorum-policy=\"stop\"/></summary>"
  echo '  <nodes>'
  for k in $ALLE; do i=$((i + 1)); o=false; [ "$i" -gt "$on" ] || o=true; echo "    <node name=\"$k\" id=\"$i\" online=\"$o\" unclean=\"false\" type=\"member\"/>"; done
  echo '  </nodes>'
  echo '</pacemaker-result>'
}
corosync-quorumtool() { local on=3; [ -f "$T/laeuft" ] || return 1; [ ! -f "$T/online" ] || on=$(cat "$T/online"); printf 'Quorum information\n------------------\nQuorate:          Yes\n\nVotequorum information\n----------------------\nExpected votes:   3\nHighest expected: 3\nTotal votes:      %s\nQuorum:           2\nFlags:            Quorate\n' "$on"; }
crm_attribute() {
  local n=''; while [ $# -gt 0 ]; do if [ "$1" = -n ]; then n=$2; fi; shift; done
  [ -f "$T/laeuft" ] || return 1
  if [ "$n" = have-watchdog ]; then if [ -f "$T/sbd_en" ]; then echo true; else echo false; fi; return 0; fi
  [ -f "$T/prop/$n" ] || return 6; cat "$T/prop/$n"
}
`.replaceAll('§{', '${');

/** drei vorbereitete Knoten (ha_vorbereiten gelaufen), ausgeführt auf sqllnx01; noch kein Cluster, pcs noch nicht angemeldet */
const CL_BASIS = String.raw`
mkdir -p "$T/dpkg" "$T/svc" "$T/conf" "$T/prop" "$T/pcsd_aus" "$T/wd/watchdog0"
for pv in 'pacemaker=2.1.6-5ubuntu2' 'corosync=3.1.7-1ubuntu3.2' 'pcs=0.11.7-1ubuntu1.1' 'sbd=1.5.2-2ubuntu2'; do printf 'hold ok installed|%s' "§{pv#*=}" >"$T/dpkg/§{pv%%=*}"; done
echo 'i6300ESB timer' >"$T/wd/watchdog0/identity"; touch "$T/dev_watchdog"; echo sqllnx01 >"$T/name"
printf '%s' 'Hk-Geheim-123456!' >"$T/kw_eingabe"; printf '%s' 'Hk-Geheim-123456!' >"$T/kw_soll"
`.replaceAll('§{', '${');

interface ClLauf { rc: number; ergebnis?: Record<string, unknown>; aus: string; log: string }
async function cluster(texte: string[], setup = '', zwischen: string[] = [], ende = ''): Promise<{ laeufe: ClLauf[]; zustand: string }> {
  const teile = texte.map((t, i) => {
    // Ersetzung als Funktion: CL_STUBS enthält „$'“ (bei einem Ersetzungstext ein Sondermuster)
    const text = t.replace('# ALFRED-ABLAUF', () => `${CL_STUBS}\n# ALFRED-ABLAUF`);
    return `${zwischen[i] ?? ''}\n( ${text}\n) >"$T/aus${i}" 2>&1; echo "RC${i}=$?" >>"$T/rc"; mv "$T/log" "$T/log${i}" 2>/dev/null || : >"$T/log${i}"`;
  });
  const huelle = [
    'T=$(mktemp -d)', `PY=$(command -v ${PYTHON})`, CL_BASIS, setup, "ALFRED_EINGABE=''", ...teile,
    'cat "$T/rc"',
    ...texte.map((_, i) => `echo "---AUS${i}"; cat "$T/aus${i}"; echo "---LOG${i}"; cat "$T/log${i}"`),
    `echo ---ZUSTAND; (cd "$T" && ls conf svc prop 2>/dev/null; for f in conf/*; do [ -f "$f" ] && grep -H cluster_name "$f"; done); ${ende || ':'}; echo ---ENDE`,
    'rm -rf "$T"',
  ].join('\n');
  // asynchron: ein langer spawnSync blockiert den Vitest-Worker (RPC-Zeitüberschreitung „onTaskUpdate“)
  const r = await new Promise<{ stdout: string; stderr: string }>((ok, fehler) => {
    const k = spawn('bash', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    k.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    k.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    k.on('error', fehler);
    k.on('close', () => ok({ stdout, stderr }));
    k.stdin.end(huelle);
  });
  const o = r.stdout;
  const zw =(a: string, b: string) => o.split(`${a}\n`)[1]?.split(`${b}\n`)[0] ?? '';
  const laeufe = texte.map((_, i) => {
    const aus = zw(`---AUS${i}`, `---LOG${i}`);
    return { rc: Number(new RegExp(`RC${i}=(\\d+)`).exec(o)?.[1] ?? -1), ergebnis: haErgebnis(aus), aus, log: zw(`---LOG${i}`, i + 1 < texte.length ? `---AUS${i + 1}` : '---ZUSTAND') };
  });
  return { laeufe, zustand: zw('---ZUSTAND', '---ENDE') };
}

const ANLEGEN = haClusterSkript(PC);
const ENTFERNEN = haClusterEntfernenSkript({ cluster: 'sqllnxcl01', knoten: [...HA_KNOTEN] });

describe.skipIf(!BASH || !PYTHON)('I8e Paket 2 — cluster_anlegen / cluster_entfernen ausgeführt (nachgebildeter Cluster)', { timeout: 180_000 }, () => {
  it('erster Lauf: Anmeldung (Kennwort nur über stdin), setup knet, diskless SBD, starten, Eigenschaften — zweiter Lauf „schon“ ohne ändernden Befehl', async () => {
    const w = (await cluster([ANLEGEN, ANLEGEN]));
    const [a, b] = w.laeufe as [ClLauf, ClLauf];
    expect(a.rc, a.aus).toBe(0);
    expect(a.ergebnis).toMatchObject({ zustand: 'geaendert', cluster: 'sqllnxcl01', ausgefuehrtAuf: 'sqllnx01', knoten: ['sqllnx01', 'sqllnx02', 'sqllnxcfg'], online: 3, quorum: '3/3',
      stonith: true, sbd: '3/3', sbdTimeoutS: 10, stonithWatchdogTimeoutS: 20, haveWatchdog: true, noQuorumPolicy: 'stop',
      aenderungen: ['pcs-anmeldung', 'cluster-angelegt', 'sbd-diskless', 'cluster-aktiviert', 'cluster-gestartet', 'stonith-watchdog-timeout', 'stonith-enabled'] });
    expect(a.log.trim().split('\n')).toEqual([
      'pcs host auth sqllnx01 addr=10.203.30.10 sqllnx02 addr=10.203.30.11 sqllnxcfg addr=10.203.30.12 -u hacluster',
      'pcs cluster setup sqllnxcl01 sqllnx01 addr=10.203.30.10 sqllnx02 addr=10.203.30.11 sqllnxcfg addr=10.203.30.12 transport knet',
      expect.stringMatching(/^pcs stonith sbd enable watchdog=\S+dev_watchdog SBD_WATCHDOG_TIMEOUT=10$/),
      'pcs cluster enable --all',
      'pcs cluster start --all --wait=180',
      'pcs property set stonith-watchdog-timeout=20',
      'pcs property set stonith-enabled=true',
    ]);
    // Kennwort nie im Befehlsprotokoll, nie in der Ausgabe (der Stub prüft es auf stdin)
    expect(a.log + a.aus + b.aus).not.toContain('Hk-Geheim');
    expect(w.zustand).toContain('conf/sqllnxcfg:    cluster_name: sqllnxcl01');
    expect(b.rc, b.aus).toBe(0);
    expect(b.ergebnis).toMatchObject({ zustand: 'schon', aenderungen: [] });
    expect(b.log.trim()).toBe('');
  });
  it('falsches Kennwort: pcs host auth scheitert sichtbar, nichts am Cluster', async () => {
    const w = (await cluster([ANLEGEN], `printf '%s' 'Hk-Anders-1' >"$T/kw_soll"`));
    const a = w.laeufe[0]!;
    expect(a.rc).toBe(1);
    expect(String(a.ergebnis?.fehler)).toContain('pcs host auth (hacluster) fehlgeschlagen');
    expect(a.log).not.toMatch(/cluster setup/);
    expect(a.aus).not.toContain('Hk-Geheim');
  });
  const ohneAenderung = (a: ClLauf, muster: RegExp) => {
    expect(a.rc).toBe(1);
    expect(a.ergebnis?.zustand).toBe('fehler');
    expect(String(a.ergebnis?.fehler)).toMatch(muster);
    expect(String(a.ergebnis?.fehler)).toContain('nichts geändert');
    expect(a.log.trim()).toBe('');
  };
  it('anderer Cluster auf diesem Knoten (anderer Name oder andere Knoten) → Abbruch ohne Änderung', async () => {
    const fremd = (name: string, ip: string) => `printf 'totem {\\n    cluster_name: ${name}\\n}\\nnodelist {\\n    node {\\n        ring0_addr: ${ip}\\n        name: sqllnx01\\n    }\\n}\\n' >"$T/conf/sqllnx01"`;
    ohneAenderung((await cluster([ANLEGEN], fremd('anderer', '10.203.30.10'))).laeufe[0]!, /anderer Cluster eingerichtet: anderer \(sqllnx01=10\.203\.30\.10\)/);
    ohneAenderung((await cluster([ANLEGEN], fremd('sqllnxcl01', '10.203.30.10'))).laeufe[0]!, /anderer Cluster eingerichtet: sqllnxcl01 \(sqllnx01=10\.203\.30\.10\) — erwartet sqllnxcl01 mit sqllnx01=10\.203\.30\.10 sqllnx02=/);
  });
  it('anderer Cluster oder Debian-Standard auf einem anderen Knoten → Abbruch vor pcs cluster setup', async () => {
    const fremd = `touch "$T/auth"; printf 'totem {\\n    cluster_name: altcl\\n}\\nnodelist {\\n    node {\\n        ring0_addr: 10.203.30.11\\n        name: sqllnx02\\n    }\\n}\\n' >"$T/conf/sqllnx02"`;
    ohneAenderung((await cluster([ANLEGEN], fremd)).laeufe[0]!, /auf sqllnx02 ist ein anderer Cluster eingerichtet: altcl/);
    const deb = `touch "$T/auth"; printf 'totem {\\n    cluster_name: debian\\n}\\nnodelist {\\n    node {\\n        name: node1\\n        ring0_addr: 127.0.0.1\\n    }\\n}\\n' >"$T/conf/sqllnxcfg"`;
    ohneAenderung((await cluster([ANLEGEN], deb)).laeufe[0]!, /auf sqllnxcfg liegt noch die Debian-Standardkonfiguration/);
    // nicht angemeldet: nur die Anmeldung ist gelaufen, die Meldung sagt das
    const ohneAuth = (await cluster([ANLEGEN], fremd.replace('touch "$T/auth"; ', ''))).laeufe[0]!;
    expect(ohneAuth.rc).toBe(1);
    expect(String(ohneAuth.ergebnis?.fehler)).toContain('am Cluster nichts geändert (nur pcs-Anmeldung erneuert)');
    expect(ohneAuth.log.trim().split('\n')).toEqual([expect.stringMatching(/^pcs host auth /)]);
  });
  it('Debian-Standard hier, pcsd unerreichbar, falscher Rechner, Paketversion, fremder Watchdog → Abbruch ohne Änderung', async () => {
    ohneAenderung((await cluster([ANLEGEN], `printf 'totem {\\n    cluster_name: debian\\n}\\n' >"$T/conf/sqllnx01"`)).laeufe[0]!, /Debian-Standardkonfiguration — vorher ha_vorbereiten auf sqllnx01 wiederholen/);
    ohneAenderung((await cluster([ANLEGEN], 'touch "$T/pcsd_aus/10.203.30.12"')).laeufe[0]!, /pcsd auf sqllnxcfg \(10\.203\.30\.12:2224\) nicht erreichbar/);
    ohneAenderung((await cluster([ANLEGEN], 'echo fremd01 >"$T/name"')).laeufe[0]!, /fremd01 gehört nicht zu den Knoten/);
    ohneAenderung((await cluster([ANLEGEN], 'printf "hold ok installed|0.11.8-1" >"$T/dpkg/pcs"')).laeufe[0]!, /pcs ist in Version '0\.11\.8-1' vorhanden, erwartet 0\.11\.7-1ubuntu1\.1/);
    ohneAenderung((await cluster([ANLEGEN], 'echo "Software Watchdog" >"$T/wd/watchdog0/identity"')).laeufe[0]!, /stammt von 'Software Watchdog'.*kein softdog-Ersatz/);
    ohneAenderung((await cluster([ANLEGEN], 'rm -f "$T/dev_watchdog"')).laeufe[0]!, /dev_watchdog fehlt auf sqllnx01/);
    ohneAenderung((await cluster([ANLEGEN], ': >"$T/kw_eingabe"')).laeufe[0]!, /hacluster-Kennwort fehlt in der Eingabe/);
  });
  it('bestehender Cluster mit Abweichungen: nur diese sichtbar behoben (stonith-watchdog-timeout, gestoppter Cluster)', async () => {
    const w = (await cluster([ANLEGEN, ANLEGEN, ANLEGEN], '', ['', 'echo 30s >"$T/prop/stonith-watchdog-timeout"', 'rm -f "$T/laeuft"']));
    const [, b, c] = w.laeufe as [ClLauf, ClLauf, ClLauf];
    expect(b.rc, b.aus).toBe(0);
    expect(b.ergebnis).toMatchObject({ zustand: 'geaendert', aenderungen: ['stonith-watchdog-timeout'] });
    expect(b.log.trim()).toBe('pcs property set stonith-watchdog-timeout=20');
    expect(c.rc, c.aus).toBe(0);
    expect(c.ergebnis).toMatchObject({ zustand: 'geaendert', aenderungen: ['cluster-gestartet'] });
    expect(c.log.trim()).toBe('pcs cluster start --all --wait=180');
  });
  it('SBD weicht ab: ohne Ressourcen Neustart mit SBD-Neueinrichtung; mit Ressourcen sichtbarer Abbruch', async () => {
    const w = (await cluster([ANLEGEN, ANLEGEN, ANLEGEN], '', ['', 'echo 15 >"$T/sbd_t"', 'echo 15 >"$T/sbd_t"; echo 2 >"$T/ressourcen"']));
    const [, b, c] = w.laeufe as [ClLauf, ClLauf, ClLauf];
    expect(b.rc, b.aus).toBe(0);
    // Task 4 (Carry-over 3): Stopp und Start des ganzen Clusters stehen in den Änderungen
    expect(b.ergebnis).toMatchObject({ zustand: 'geaendert', aenderungen: ['cluster-gestoppt', 'sbd-neu-eingerichtet', 'cluster-gestartet'] });
    expect(b.log.trim().split('\n')).toEqual(['pcs cluster stop --all', expect.stringMatching(/^pcs stonith sbd enable .* SBD_WATCHDOG_TIMEOUT=10$/), 'pcs cluster start --all --wait=180']);
    expect(c.rc).toBe(1);
    expect(String(c.ergebnis?.fehler)).toContain("SBD weicht ab (SBD_WATCHDOG_TIMEOUT '15' statt 10), der Cluster trägt aber 2 Ressourcen");
    expect(c.log.trim()).toBe('');
  });
  it('Selbstprüfung: nur 2/3 Knoten online → Abbruch (kein „geaendert“ ohne Beleg)', async () => {
    const a = (await cluster([ANLEGEN], 'echo 2 >"$T/online"')).laeufe[0]!;
    expect(a.rc).toBe(1);
    expect(String(a.ergebnis?.fehler)).toContain('nach dem Start 2/3 Knoten online');
    // Final-Review I-1: der Abbruch nennt, was bis dahin geändert wurde
    expect(String(a.ergebnis?.fehler)).toContain('Rückweg cluster_entfernen — bisher geändert: pcs-anmeldung,cluster-angelegt,sbd-diskless,cluster-aktiviert,cluster-gestartet');
  });
  it('I-1: cluster_anlegen — Start scheitert nach setup und SBD → „bisher geändert: …“; nur pcs-Anmeldung erneuert → ohne Liste (Text sagt es schon)', async () => {
    const a = (await cluster([ANLEGEN], 'touch "$T/start_scheitert"')).laeufe[0]!;
    expect(a.rc).toBe(1);
    expect(String(a.ergebnis?.fehler)).toMatch(/^pcs cluster start --all fehlgeschlagen: .* — Rückweg cluster_entfernen — bisher geändert: pcs-anmeldung,cluster-angelegt,sbd-diskless,cluster-aktiviert,cluster-gestartet-versucht$/);
    expect(a.aus.split('\n').filter(z => z.startsWith('ALFRED-HA ')).length).toBe(1);
    const fremd = `printf 'totem {\\n    cluster_name: altcl\\n}\\nnodelist {\\n    node {\\n        ring0_addr: 10.203.30.11\\n        name: sqllnx02\\n    }\\n}\\n' >"$T/conf/sqllnx02"`;
    const nurAnmeldung = (await cluster([ANLEGEN], fremd)).laeufe[0]!;
    expect(String(nurAnmeldung.ergebnis?.fehler)).toContain('am Cluster nichts geändert (nur pcs-Anmeldung erneuert)');
    expect(String(nurAnmeldung.ergebnis?.fehler)).not.toContain('bisher geändert');
  });
  // Ruling R12: der scheiternde ändernde Befehl kann selbst schon geändert haben → „<name>-versucht“ (ohne vorheriges aend)
  it('R12: pcs cluster setup scheitert mit Teilstand → „bisher geändert: pcs-anmeldung,cluster-angelegt-versucht“ (→ teilweise, Rückweg cluster_entfernen)', async () => {
    const w = await cluster([ANLEGEN], 'touch "$T/setup_scheitert"');
    const a = w.laeufe[0]!;
    expect(a.rc).toBe(1);
    expect(String(a.ergebnis?.fehler)).toMatch(/^pcs cluster setup fehlgeschlagen: .*; ein Teilstand geht mit cluster_entfernen zurück — bisher geändert: pcs-anmeldung,cluster-angelegt-versucht$/);
    expect(w.zustand).toContain('conf/sqllnx02:'); // der Teilstand ist wirklich da
  });
  it('R12: pcs cluster stop --all scheitert (ohne vorheriges aend) → „bisher geändert: cluster-gestoppt-versucht“; Erfolg unverändert', async () => {
    const b = (await cluster([ANLEGEN, ENTFERNEN], '', ['', 'touch "$T/stop_scheitert"'])).laeufe[1]!;
    expect(b.rc).toBe(1);
    expect(String(b.ergebnis?.fehler)).toMatch(/^pcs cluster stop --all fehlgeschlagen: .* — bisher geändert: cluster-gestoppt-versucht$/);
    expect(b.log.trim().split('\n')).toEqual(['pcs cluster stop --all']);
    const ok = (await cluster([ANLEGEN, ENTFERNEN])).laeufe[1]!;
    expect(ok.ergebnis).toMatchObject({ zustand: 'geaendert', aenderungen: ['cluster-gestoppt', 'sbd-aus', 'cluster-entfernt'] });
    expect(ok.aus).not.toContain('versucht');
  });
  it('I-1: cluster_entfernen — SBD-Abschaltung scheitert nach dem Stopp → „bisher geändert: cluster-gestoppt“', async () => {
    const b = (await cluster([ANLEGEN, ENTFERNEN], '', ['', 'touch "$T/sbd_aus_scheitert"'])).laeufe[1]!;
    expect(b.rc).toBe(1);
    expect(String(b.ergebnis?.fehler)).toMatch(/^pcs stonith sbd disable fehlgeschlagen: .* — Cluster ist gestoppt — bisher geändert: cluster-gestoppt,sbd-aus-versucht$/);
    expect(b.log.trim().split('\n')).toEqual(['pcs cluster stop --all', 'pcs stonith sbd disable']);
  });
  it('cluster_entfernen: stoppt sauber, SBD aus, destroy --all; zweiter Lauf „schon“; mit Ressourcen oder fremdem Cluster Abbruch ohne Änderung', async () => {
    const w = (await cluster([ANLEGEN, ENTFERNEN, ENTFERNEN]));
    const [a, b, c] = w.laeufe as [ClLauf, ClLauf, ClLauf];
    expect(a.rc, a.aus).toBe(0);
    expect(b.rc, b.aus).toBe(0);
    expect(b.ergebnis).toMatchObject({ zustand: 'geaendert', cluster: 'sqllnxcl01', aenderungen: ['cluster-gestoppt', 'sbd-aus', 'cluster-entfernt'] });
    expect(b.log.trim().split('\n')).toEqual(['pcs cluster stop --all', 'pcs stonith sbd disable', 'pcs cluster destroy --all --force']);
    expect(c.rc, c.aus).toBe(0);
    expect(c.ergebnis).toMatchObject({ zustand: 'schon', aenderungen: [] });
    expect(c.log.trim()).toBe('');
    expect(w.zustand).not.toContain('cluster_name');
    const r = (await cluster([ANLEGEN, ENTFERNEN], '', ['', 'echo 1 >"$T/ressourcen"'])).laeufe[1]!;
    ohneAenderung(r, /trägt 1 Ressourcen — vorher die Ressourcen \(Verfügbarkeitsgruppe\) entfernen/);
    const f = (await cluster([ENTFERNEN], `printf 'totem {\\n    cluster_name: anderer\\n}\\nnodelist {\\n    node {\\n        ring0_addr: 10.1.1.1\\n        name: a\\n    }\\n}\\n' >"$T/conf/sqllnx01"`)).laeufe[0]!;
    ohneAenderung(f, /anderer Cluster eingerichtet: anderer/);
  });
  // Task 4, Carry-over 1: Pacemaker hier aus → nur weiter, wenn belegt ist, dass der Cluster überall steht (SBD aktiviert 3/3, läuft 0/3)
  it('cluster_entfernen: Pacemaker hier aus, Cluster anderswo aktiv → Abbruch ohne Änderung; überall gestoppt → ohne Stopp entfernt; Ressourcen in der CIB → Abbruch', async () => {
    const anders = (await cluster([ANLEGEN, ENTFERNEN], '', ['', 'rm -f "$T/svc/pacemaker.is-active"'])).laeufe[1]!;
    ohneAenderung(anders, /Pacemaker ist auf sqllnx01 nicht aktiv, und dass der Cluster auf allen Knoten steht, ist nicht belegt \(SBD installiert 3\/3, aktiviert 3\/3, läuft 3\/3\)/);
    const alleAus = 'rm -f "$T/laeuft" "$T/svc/pacemaker.is-active" "$T/svc/corosync.is-active" "$T/svc/sbd.is-active"';
    const w = await cluster([ANLEGEN, ENTFERNEN], '', ['', alleAus]);
    const b = w.laeufe[1]!;
    expect(b.rc, b.aus).toBe(0);
    expect(b.log.trim().split('\n')).toEqual(['pcs stonith sbd disable', 'pcs cluster destroy --all --force']);
    expect(b.ergebnis).toMatchObject({ zustand: 'geaendert', aenderungen: ['sbd-aus', 'cluster-entfernt'] });
    const cib = (await cluster([ANLEGEN, ENTFERNEN], '', ['', `${alleAus}; echo '<primitive id="ag"/>' >"$T/cib.xml"`])).laeufe[1]!;
    ohneAenderung(cib, /trägt 1 Ressourcen/);
  });
  // Task 4, Carry-over 2: destroy --all nur, wenn jeder andere Knoten den eigenen Cluster oder keine corosync.conf trägt
  it('cluster_entfernen: anderer Knoten mit fremder oder unlesbarer corosync.conf → Abbruch vor jeder Änderung', async () => {
    const fremd = (await cluster([ANLEGEN, ENTFERNEN], '', ['', 'sed -i "s/cluster_name: sqllnxcl01/cluster_name: altcl/" "$T/conf/sqllnx02"'])).laeufe[1]!;
    ohneAenderung(fremd, /auf sqllnx02 ist ein anderer Cluster eingerichtet: altcl/);
    // pcs liefert für einen Knoten ohne corosync.conf einen Fehler — „leer“ ist so nicht von „nicht erreichbar“ zu unterscheiden → Abbruch
    const weg = (await cluster([ANLEGEN, ENTFERNEN], '', ['', 'rm -f "$T/conf/sqllnxcfg"'])).laeufe[1]!;
    ohneAenderung(weg, /corosync\.conf von sqllnxcfg nicht lesbar \(pcs cluster corosync sqllnxcfg\) — ohne sie kein destroy --all/);
    const deb = (await cluster([ANLEGEN, ENTFERNEN], '', ['', `printf 'totem {\\n    cluster_name: debian\\n}\\n' >"$T/conf/sqllnxcfg"`])).laeufe[1]!;
    ohneAenderung(deb, /auf sqllnxcfg liegt die Debian-Standardkonfiguration statt sqllnxcl01/);
  });
});

// ── Task 4: Fencing-Beweis ──────────────────────────────────────────────────────────────────────────────────────────────────────

const PF = { cluster: 'sqllnxcl01', knoten: [...HA_KNOTEN] };
const PRUEFEN_T = haFencingPruefenSkript({ ...PF, art: 'trennung' });
const PRUEFEN_H = haFencingPruefenSkript({ ...PF, art: 'haenger' });
const BELEGEN = haFencingBelegenSkript(PF);

describe('I8e Paket 2 Task 4 — Fencing-Bausteine (Text, Validatoren)', () => {
  it('Validatoren: art trennung|haenger, Cluster und drei Knoten', () => {
    expect(pruefeHaFencing({ ...PF, art: 'trennung' })).toBeUndefined();
    expect(pruefeHaFencing({ ...PF, art: 'haenger' })).toBeUndefined();
    expect(pruefeHaFencing({ ...PF, art: 'reboot' })).toContain('art: trennung oder haenger');
    expect(pruefeHaFencing({ ...PF, knoten: HA_KNOTEN.slice(0, 2), art: 'trennung' })).toContain('drei');
    expect(pruefeHaFencingBelegen({ ...PF, cluster: 'x; rm' })).toContain('cluster');
    expect(pruefeHaFencingBelegen(PF)).toBeUndefined();
  });
  it('nft-Testregel: eigene Tabelle, nur UDP 5405 in beide Richtungen, ohne Persistenz (Datei in /run, keine Unit, kein /etc)', () => {
    const t = fencetestNft();
    expect(t.split('\n').map(z => z.trim()).filter(z => z.endsWith('drop'))).toEqual(['udp dport { 5405 } drop', 'udp sport { 5405 } drop', 'udp dport { 5405 } drop', 'udp sport { 5405 } drop']);
    expect(t).toContain('type filter hook input priority -20; policy accept;');
    expect(t).toContain('type filter hook output priority -20; policy accept;');
    expect(t.match(/table inet alfred_fencetest/g)).toHaveLength(3);
    expect(t).not.toMatch(/tcp|alfred_ha/);
    expect(PRUEFEN_T).toContain('REGEL_DATEI=/run/alfred-fencetest.nft');
    expect(PRUEFEN_T).not.toMatch(/\/etc\/alfred\/[^ ]*fencetest|systemctl enable/);
  });
  it('Skripttext: Test-Datei (0600, sync) vor dem Auslösen; Auslöser entkoppelt mit AccuracySec=1s; Aufheben vor dem Auslöser geplant; Pfade fest', () => {
    const ablauf = PRUEFEN_T.split('# ALFRED-ABLAUF')[1]!;
    const datei = ablauf.indexOf('schreibe_privat "$TEST_DATEI"');
    expect(datei).toBeGreaterThan(0);
    expect(ablauf.indexOf('systemd-run --unit="$EINHEIT-ende"')).toBeGreaterThan(datei);
    expect(ablauf.indexOf('systemd-run --unit="$EINHEIT" --on-active="$VERZ_S"')).toBeGreaterThan(ablauf.indexOf('systemd-run --unit="$EINHEIT-ende"'));
    for (const z of ablauf.split('\n').filter(x => x.includes('systemd-run --unit'))) expect(z).toContain('--timer-property=AccuracySec=1s');
    expect(PRUEFEN_T).toContain('chmod 0600 "$1.alfred-neu"');
    expect(PRUEFEN_T).toMatch(/mv -f "\$1\.alfred-neu" "\$1"; sync; \}/);
    expect(PRUEFEN_T).toContain(`TEST_DATEI='${HA_FENCING_TEST_DATEI}'`);
    expect(BELEGEN).toContain(`BELEG_DATEI='${HA_FENCING_BELEG_DATEI}'`);
    expect(HA_FENCING_TEST_DATEI).toBe('/var/lib/alfred/ha/fencing-test.json');
    expect(HA_FENCING_BELEG_DATEI).toBe('/var/lib/alfred/ha/fencing-beleg.json');
    expect(PRUEFEN_H).toContain('/bin/sh -c "sync; echo c > $SYSRQ_TRIGGER"');
    expect(PRUEFEN_T).toContain('SPERRE_S=120');
    expect(PRUEFEN_T).toContain('VERZ_S=10');
    expect(BELEGEN).toContain('MAX_ALTER_S=1800');
    // fencing_belegen braucht kein Geheimnis
    expect(BELEGEN.split('# ALFRED-ABLAUF')[1]).not.toContain('kennwort_lesen');
    expect(PRUEFEN_T).not.toMatch(/kernel\.sysrq=|>\s*"?\$SYSRQ_DATEI/); // sysrq wird nie umgestellt
  });
});

// Beleg-Gültigkeit: TS (fencingBelegGueltig) und Python (fencing_grund) liefern für dieselben Fälle denselben Grund
const ID = { cluster: 'sqllnxcl01', knoten: 'sqllnx01', nodeid: '1', konfHash: 'h1' };
const BL: FencingBeleg = { art: 'trennung', zeit: '2026-11-17T14:03:41Z', resetS: 18, rejoinS: 41, bootId: 'b-neu', bootIdVorher: 'a-alt', testZeit: '2026-11-17T14:00:00Z', cluster: 'sqllnxcl01', knoten: 'sqllnx01', nodeid: '1', konfHash: 'h1' };
const TS0 = { art: 'trennung', bootIdVorher: 'a-alt', zeit: '2026-11-17T14:00:00Z', zeitS: 1, ausloeseS: 4, sperreS: 120, knoten: 'sqllnx01', cluster: 'sqllnxcl01' };
const FAELLE: Array<[string, unknown, unknown, unknown]> = [
  ['gültig ohne Test-Datei', BL, null, ID],
  ['gültig mit passendem Test', BL, TS0, ID],
  ['kein Beleg', null, TS0, ID],
  ['unlesbar', 'unlesbar', TS0, ID],
  ['Art', { ...BL, art: 'reboot' }, null, ID],
  ['Messwert', { ...BL, rejoinS: undefined }, null, ID],
  ['negativ', { ...BL, resetS: -1 }, null, ID],
  ['kein Reset', { ...BL, bootId: 'a-alt' }, null, ID],
  ['Identität fehlt', BL, null, null],
  ['authkey fehlt', BL, null, { ...ID, konfHash: null }],
  ['anderer Cluster im Beleg', { ...BL, cluster: 'altcl' }, null, { ...ID, cluster: 'altcl' }],
  ['Cluster heute anders', BL, null, { ...ID, cluster: 'neucl' }],
  ['nodeid anders', BL, null, { ...ID, nodeid: '2' }],
  ['neu eingerichtet', BL, null, { ...ID, konfHash: 'h2' }],
  ['Test unlesbar', BL, 'unlesbar', ID],
  ['neuerer Test', BL, { ...TS0, zeit: '2026-11-17T15:00:00Z' }, ID],
];

describe('I8e Paket 2 Task 4 — fencingBelegGueltig (für Task 5)', () => {
  it('Regeln und Wortlaut', () => {
    const g = (b: unknown, t: unknown, i: unknown) => fencingBelegGueltig(b as FencingBeleg, { identitaet: i as never, test: t as never });
    expect(g(BL, null, ID)).toBeUndefined();
    expect(g(BL, TS0, ID)).toBeUndefined();
    expect(g(null, null, ID)).toBe('kein Fencing-Beleg');
    expect(g({ ...BL, bootId: 'a-alt' }, null, ID)).toBe('Beleg ohne Reset (boot_id gleich)');
    expect(g(BL, null, { ...ID, konfHash: 'h2' })).toBe('Cluster seit dem Beleg neu eingerichtet (corosync.conf/authkey/SBD-Konfiguration anders)');
    expect(g(BL, null, { ...ID, nodeid: '2' })).toBe('Beleg für Knoten sqllnx01 (nodeid 1), hier sqllnx01 (nodeid 2)');
    expect(g({ ...BL, cluster: 'altcl' }, null, { ...ID, cluster: 'altcl' })).toBe('Beleg für Cluster altcl, erwartet sqllnxcl01');
    expect(g(BL, { ...TS0, zeit: '2026-11-17T15:00:00Z' }, ID)).toBe('neuerer Fencing-Test vom 2026-11-17T15:00:00Z ohne Beleg');
    expect(fencingBelegGueltig(BL, undefined)).toBe('Cluster-Identität nicht lesbar (corosync.conf/authkey/SBD-Konfiguration)');
  });
  it.skipIf(!PYTHON)('Python (fencing_grund in den Bausteinen) und TS liefern für alle Fälle denselben Grund', () => {
    const prog = `${PY_FENCING_FUNK}\nimport sys\nfor b, t, i in json.loads(sys.stdin.read()):\n    print(fencing_grund(b, t, i, "sqllnxcl01"))`;
    const r = spawnSync(PYTHON!, ['-c', prog], { input: JSON.stringify(FAELLE.map(([, b, t, i]) => [b ?? null, t ?? null, i ?? null])), encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    expect(r.status, r.stderr).toBe(0);
    const py = r.stdout.replace(/\r/g, '').split('\n').slice(0, FAELLE.length);
    const ts = FAELLE.map(([, b, t, i]) => fencingBelegGueltig(JSON.parse(JSON.stringify(b ?? null)) as FencingBeleg, { identitaet: i as never, test: (t ?? null) as never }) ?? '');
    expect(py).toEqual(ts);
    expect(ts.filter(x => x === '')).toHaveLength(2);
    expect(new Set(ts.filter(Boolean)).size).toBeGreaterThanOrEqual(12);
  });
  // Fix-Runde 1: nicht endliche Messwerte (json lädt NaN/Infinity aus einer Datei) sind ungültig — in Python wie in TS
  it.skipIf(!PYTHON)('nicht endliche Messwerte (NaN, Infinity, -Infinity) → „Beleg ohne Messwert …“ in Python und TS', () => {
    const roh = ['NaN', 'Infinity', '-Infinity'];
    const prog = `${PY_FENCING_FUNK}\nimport sys\nfor x in sys.argv[1:]:\n    b = json.loads(${JSON.stringify(JSON.stringify(BL))})\n    b["resetS"] = json.loads(x)\n    print(fencing_grund(b, None, ${JSON.stringify(ID).replace(/null/g, 'None')}, "sqllnxcl01"))`;
    const r = spawnSync(PYTHON!, ['-c', prog, ...roh], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.replace(/\r/g, '').trim().split('\n')).toEqual(roh.map(() => 'Beleg ohne Messwert resetS'));
    for (const v of [NaN, Infinity, -Infinity]) expect(fencingBelegGueltig({ ...BL, resetS: v }, { identitaet: ID })).toBe('Beleg ohne Messwert resetS');
  });
  it.skipIf(!PYTHON)('Identität: nodeid des eigenen Namens aus der corosync.conf von pcs, konfHash über corosync.conf + authkey; ohne authkey kein Hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-fen-'));
    try {
      const conf = join(dir, 'corosync.conf'); const key = join(dir, 'authkey');
      writeFileSync(conf, 'totem {\n    cluster_name: sqllnxcl01\n}\nnodelist {\n    node {\n        ring0_addr: 10.203.30.10\n        name: sqllnx01\n        nodeid: 1\n    }\n    node {\n        ring0_addr: 10.203.30.12\n        name: sqllnxcfg\n        nodeid: 3\n    }\n}\n');
      const sbd = join(dir, 'sbd');
      writeFileSync(key, Buffer.from([1, 2, 3, 0, 255]));
      writeFileSync(sbd, 'SBD_WATCHDOG_DEV=/dev/watchdog\nSBD_WATCHDOG_TIMEOUT=10\n');
      const id = (ich: string) => JSON.parse(spawnSync(PYTHON!, ['-c', `${PY_FENCING_FUNK}\nimport sys\nprint(json.dumps(fencing_ident(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4])))`, conf, key, sbd, ich], { encoding: 'utf8' }).stdout);
      const a = id('sqllnxcfg');
      expect(a).toMatchObject({ cluster: 'sqllnxcl01', knoten: 'sqllnxcfg', nodeid: '3' });
      expect(a.konfHash).toMatch(/^[0-9a-f]{64}$/);
      // Fix-Runde 1: SBD neu eingerichtet (/etc/default/sbd anders) → anderer Hash
      writeFileSync(sbd, 'SBD_WATCHDOG_DEV=/dev/watchdog\nSBD_WATCHDOG_TIMEOUT=15\n');
      const b = id('sqllnxcfg').konfHash;
      expect(b).not.toBe(a.konfHash);
      writeFileSync(key, Buffer.from([1, 2, 3, 0, 254]));
      expect(id('sqllnxcfg').konfHash).not.toBe(b); // neuer authkey (pcs cluster setup) → anderer Hash
      rmSync(sbd);
      expect(id('sqllnx01')).toMatchObject({ nodeid: '1', konfHash: null });
      writeFileSync(sbd, 'x');
      rmSync(key);
      expect(id('sqllnx01')).toMatchObject({ nodeid: '1', konfHash: null });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// nachgebildeter Knoten für die Fencing-Bausteine (zusätzlich zu CL_STUBS): Pfade im Testverzeichnis, Zeit/boot_id/Journal als Dateien
const FEN_STUBS = String.raw`
HA_DIR="$T/ha"; TEST_DATEI="$T/ha/fencing-test.json"; BELEG_DATEI="$T/ha/fencing-beleg.json"; AUTHKEY="$T/authkey"; BOOT_ID_DATEI="$T/boot_id"
SYSRQ_TRIGGER="$T/sysrq-trigger"; SYSRQ_DATEI="$T/sysrq"; PANIC_DATEI="$T/panic"; KEXEC_CRASH="$T/kexec"; REGEL_DATEI="$T/fencetest.nft"; PROC="$T/proc"
SBD_KONF="$T/sbd_default"
# Windows-Python schreibt sonst in der ANSI-Codepage (auf den Knoten: UTF-8-Modus unter LC_ALL=C, PEP 540)
export PYTHONIOENCODING=utf-8
# Uhr: mit $T/jetzt_schritt rückt sie bei jedem Lesen um so viele Sekunden vor (Phase 1/2 dauern auf echten Knoten Sekunden)
jetzt() { local j; j=$(cat "$T/jetzt"); if [ -f "$T/jetzt_schritt" ]; then echo $((j + $(cat "$T/jetzt_schritt"))) >"$T/jetzt"; fi; echo "$j"; }
corosync-cmapctl() { [ -f "$T/token_ms" ] || return 1; echo "runtime.config.totem.token (u32) = $(cat "$T/token_ms")"; }
# shutdown_spur nachgebildet kaputt: „absturz“ = Exit 1 ohne Ausgabe, „leer“ = Exit 0 ohne Ausgabe (Fix-Runde 2: fail closed)
if [ -f "$T/spur_kaputt" ]; then fpy() { if [ "$1" = shutdown_spur ]; then cat >/dev/null; [ "$(cat "$T/spur_kaputt")" = leer ]; return; fi; python3 -c "$PY_FENCING" "$@"; }; fi
# Beleg beim Schreiben verfälschen (nachgebildeter Fehler für die Selbstprüfung)
if [ -f "$T/beleg_kaputt" ]; then schreibe_privat() { mkdir -p "$(dirname "$1")"; if [ "$1" = "$BELEG_DATEI" ]; then printf '%s\n' '{"art":"x"}' >"$1"; else printf '%s\n' "$2" >"$1"; fi; }; fi
fd_ziel() { cat "$1"; }
prozess_exe() { cat "$PROC/$1/exe" 2>/dev/null || true; }
sync() { :; }
nft() { case "$1 $2" in "-c -f") return 0 ;; esac; log "nft $*"; }
systemd-run() { local u='' a; for a in "$@"; do case "$a" in --unit=*) u=§{a#--unit=} ;; esac; done; log "systemd-run $*"; [ -f "$T/run_scheitert" ] && return 1; [ -f "$T/timer_inaktiv" ] && return 0; touch "$T/svc/$u.timer.is-active"; }
journalctl() { case "$*" in *"-b -1"*) cat "$T/j_vorher" 2>/dev/null || return 1 ;; *"-u corosync"*) cat "$T/j_corosync" 2>/dev/null || return 1 ;; *) return 1 ;; esac; }
`.replaceAll('§{', '${');
const J = 1795000000;
const ALT = 'aaaaaaaa-1111-2222-3333-444444444444';
const NEU = 'bbbbbbbb-1111-2222-3333-444444444444';
const FEN_BASIS = String.raw`
mkdir -p "$T/proc/42/fd"; echo /dev/watchdog >"$T/proc/42/fd/3"; echo sbd >"$T/proc/42/comm"; echo /usr/sbin/sbd >"$T/proc/42/exe"
printf 'cpu 1 2 3\nbtime 1794990000\n' >"$T/proc/stat"
echo ${ALT} >"$T/boot_id"; echo ${J} >"$T/jetzt"; printf 'k3y\001b1n' >"$T/authkey"; echo 176 >"$T/sysrq"; echo 0 >"$T/panic"; echo 0 >"$T/kexec"; touch "$T/sysrq-trigger"
printf 'SBD_WATCHDOG_DEV=/dev/watchdog\nSBD_WATCHDOG_TIMEOUT=10\n' >"$T/sbd_default"; echo 3000 >"$T/token_ms"
`;
/** Spuren eines geordneten Herunterfahrens (wie systemd 255 sie schreibt) — je eine Zeile für das Journal des getesteten Starts */
const SHUTDOWN = {
  reboot: (boot: string, s: number) => `{"_BOOT_ID":"${boot}","__REALTIME_TIMESTAMP":"${s * 1_000_000}","_PID":"1","UNIT":"reboot.target","SYSLOG_IDENTIFIER":"systemd","MESSAGE":"Reached target reboot.target - System Reboot."}`,
  journald: (boot: string, s: number) => `{"_BOOT_ID":"${boot}","__REALTIME_TIMESTAMP":"${s * 1_000_000}","_PID":"377","SYSLOG_IDENTIFIER":"systemd-journald","MESSAGE":"Journal stopped"}`,
  logind: (boot: string, s: number) => `{"_BOOT_ID":"${boot}","__REALTIME_TIMESTAMP":"${s * 1_000_000}","SYSLOG_IDENTIFIER":"systemd-logind","MESSAGE":"System is rebooting."}`,
};
/** Reset nachgebildet: neue boot_id, Kernel-Start resetS nach der Auslösung (J + 10), Journal des getesteten Starts, corosync-Quorum nach 41,4 s */
const reset = (o: { resetS?: number; jetzt?: number; vorherBoot?: string; quorum?: boolean; shutdown?: keyof typeof SHUTDOWN } = {}) => {
  const bt = J + 10 + (o.resetS ?? 18);
  const vb = (o.vorherBoot ?? ALT).replaceAll('-', '');
  return [
    `rm -f "$T/jetzt_schritt"; echo ${NEU} >"$T/boot_id"; printf 'cpu 1\\nbtime ${bt}\\n' >"$T/proc/stat"; echo ${o.jetzt ?? J + 200} >"$T/jetzt"`,
    `printf '%s\\n' ${o.shutdown ? `'${SHUTDOWN[o.shutdown](vb, J + 12)}' ` : ''}'{"_BOOT_ID":"${vb}","__REALTIME_TIMESTAMP":"${(J + 4) * 1_000_000 + 500_000}","MESSAGE":"letzter Eintrag"}' >"$T/j_vorher"`,
    `printf '%s\\n' '{"__REALTIME_TIMESTAMP":"${(bt + 20) * 1_000_000}","MESSAGE":"[TOTEM ] A new membership (3.2b) was formed. Members joined: 3"}' ${o.quorum === false ? '' : `'{"__REALTIME_TIMESTAMP":"${(bt + 41) * 1_000_000 + 400_000}","MESSAGE":"[QUORUM] This node is within the primary component and will provide service."}'`} >"$T/j_corosync"`,
  ].join('\n');
};
const DATEIEN = 'echo ---BELEG; cat "$T/ha/fencing-beleg.json" 2>/dev/null || echo FEHLT; echo ---TEST; cat "$T/ha/fencing-test.json" 2>/dev/null || echo FEHLT; echo ---NFT; cat "$T/fencetest.nft" 2>/dev/null || echo FEHLT';
const mitFen = (t: string) => t.replace('# ALFRED-ABLAUF', () => `${FEN_STUBS}\n# ALFRED-ABLAUF`);
async function fencing(texte: string[], zwischen: string[] = [], setup = '') {
  const w = await cluster([ANLEGEN, ...texte].map(mitFen), `${FEN_BASIS}\n${setup}`, ['', ...zwischen], DATEIEN);
  const z = (a: string, b?: string) => { const t = w.zustand.split(`${a}\n`)[1] ?? ''; return (b ? t.split(`${b}\n`)[0] : t)!.trim(); };
  // Python-JSON darf NaN enthalten (JSON.parse nicht) → dann nur der Rohtext
  const json = (s: string) => { if (s === 'FEHLT') return undefined; try { return JSON.parse(s) as Record<string, unknown>; } catch { return { roh: s } as Record<string, unknown>; } };
  expect(w.laeufe[0]!.rc, w.laeufe[0]!.aus).toBe(0);
  return { laeufe: w.laeufe.slice(1), beleg: json(z('---BELEG', '---TEST')), test: json(z('---TEST', '---NFT')), nft: z('---NFT') };
}
const keinBeleg = (a: ClLauf, muster: RegExp) => {
  expect(a.rc).toBe(1);
  expect(a.ergebnis?.zustand).toBe('fehler');
  expect(String(a.ergebnis?.fehler)).toMatch(muster);
};

describe.skipIf(!BASH || !PYTHON)('I8e Paket 2 Task 4 — Fencing-Beweis ausgeführt (nachgebildeter Cluster)', { timeout: 240_000 }, () => {
  it('trennung: Test-Datei, Aufheben- und Auslöse-Timer → Reset → Beleg mit Messwerten; Wiederholungen „schon“ ohne ändernden Befehl', async () => {
    const w = await fencing([PRUEFEN_T, BELEGEN, BELEGEN, PRUEFEN_T], ['', reset(), '', '']);
    const [p, b, b2, p2] = w.laeufe as [ClLauf, ClLauf, ClLauf, ClLauf];
    expect(p.rc, p.aus).toBe(0);
    expect(p.ergebnis).toMatchObject({ zustand: 'ausgeloest', art: 'trennung', knoten: 'sqllnx01', cluster: 'sqllnxcl01', bootIdVorher: ALT, ausloesungInS: 10, sperreS: 120,
      einheit: `alfred-fencetest-${J}`, aenderungen: ['fencing-test-datei', 'aufheben-geplant', 'ausloeser-geplant'] });
    expect(p.log.trim().split('\n')).toEqual([
      `systemd-run --unit=alfred-fencetest-${J}-ende --on-active=130 --timer-property=AccuracySec=1s nft delete table inet alfred_fencetest`,
      expect.stringMatching(new RegExp(`^systemd-run --unit=alfred-fencetest-${J} --on-active=10 --timer-property=AccuracySec=1s nft -f \\S+fencetest\\.nft$`)),
    ]);
    expect(w.nft).toBe(fencetestNft());
    expect(w.test).toMatchObject({ art: 'trennung', bootIdVorher: ALT, zeitS: J, ausloeseS: J + 10, minResetS: 13, corosyncTaktMs: 3000, taktQuelle: 'live', sperreS: 120, knoten: 'sqllnx01', cluster: 'sqllnxcl01', nodeid: '1', sysrq: '176', kernelPanic: '0' });
    expect(String(w.test!.zeit)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(String(w.test!.konfHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(p.aus + p.log).not.toContain('Hk-Geheim');
    expect(b.rc, b.aus).toBe(0);
    expect(b.ergebnis).toMatchObject({ zustand: 'geaendert', knoten: 'sqllnx01', aenderungen: ['fencing-beleg'] });
    expect(w.beleg).toMatchObject({ art: 'trennung', resetS: 18, rejoinS: 41, bootId: NEU, bootIdVorher: ALT, testZeit: w.test!.zeit, cluster: 'sqllnxcl01', knoten: 'sqllnx01', nodeid: '1',
      konfHash: w.test!.konfHash, journalLueckeS: 24, minResetS: 13 });
    expect(b.log.trim()).toBe('');
    expect(b2.rc, b2.aus).toBe(0);
    expect(b2.ergebnis).toMatchObject({ zustand: 'schon', aenderungen: [] });
    expect(b2.log.trim()).toBe('');
    // derselbe Schritt noch einmal: gültiger Beleg derselben Art → kein zweiter Reset
    expect(p2.rc, p2.aus).toBe(0);
    expect(p2.ergebnis).toMatchObject({ zustand: 'schon', art: 'trennung', aenderungen: [] });
    expect(p2.log.trim()).toBe('');
  });
  it('kein Beleg ohne geänderte boot_id; laufender Test → kein zweiter Test; nach dem Reset vor dem Beleg → fencing_pruefen „schon“', async () => {
    const w = await fencing([PRUEFEN_T, BELEGEN, PRUEFEN_T], ['', `echo ${J + 200} >"$T/jetzt"`, '']);
    const [, b, p2] = w.laeufe as [ClLauf, ClLauf, ClLauf];
    keinBeleg(b, /kein Reset seit dem Fencing-Test \(trennung\) vom .* boot_id unverändert/);
    expect(w.beleg).toBeUndefined();
    keinBeleg(p2, /läuft noch — Reset ausstehend \(boot_id unverändert\); kein zweiter Test/);
    expect(p2.log.trim()).toBe('');
    // Test ausgelöst, Reset erfolgt, Beleg noch nicht geschrieben: eine Wiederholung des Schritts setzt nicht noch einmal zurück
    const r = await fencing([PRUEFEN_T, PRUEFEN_T], ['', reset()]);
    expect(r.laeufe[1]!.rc, r.laeufe[1]!.aus).toBe(0);
    expect(r.laeufe[1]!.ergebnis).toMatchObject({ zustand: 'schon', hinweis: expect.stringContaining('Beleg mit fencing_belegen') });
    expect(r.laeufe[1]!.log.trim()).toBe('');
  });
  it('kein Beleg: Test älter als 30 min, Neustart vor der Auslösung, Reset zu spät, weiterer Neustart dazwischen, Rejoin fehlt im Journal', async () => {
    const f = async (z: string, muster: RegExp) => { const w = await fencing([PRUEFEN_T, BELEGEN], ['', z]); keinBeleg(w.laeufe[1]!, muster); expect(w.beleg).toBeUndefined(); };
    await f(reset({ jetzt: J + 1801 }), /ist 1801 s alt \(höchstens 1800 s\) — Test wiederholen; kein Beleg/);
    await f(reset({ resetS: -2 }), /vor dem Auslösezeitpunkt .* nicht dem Test zuzuordnen/);
    await f(reset({ resetS: 121 }), /Reset erst 121 s nach der Auslösung \(höchstens 120 s\)/);
    await f(reset({ vorherBoot: 'cccccccc-1111-2222-3333-444444444444' }), /dazwischen lag ein weiterer Neustart/);
    await f(`${reset()}\nrm -f "$T/j_vorher"`, /Journal des vorherigen Starts nicht lesbar/);
    await f(reset({ quorum: false }), /Rejoin-Zeitpunkt nicht im Journal/);
  });
  it('kein Beleg: Knoten nach dem Reset nicht online (kein Quorum), sbd hält den Watchdog nicht', async () => {
    const off = await fencing([PRUEFEN_T, BELEGEN], ['', `${reset()}\necho 1 >"$T/online"`]);
    keinBeleg(off.laeufe[1]!, /sqllnx01 ist nach dem Reset nicht online im Cluster \(online: sqllnx01, Quorum 0\)/);
    expect(off.beleg).toBeUndefined();
    // Live-Fix (c2e4f56d): corosync wieder drin, Pacemaker hier nicht → kein Beleg (Mitgliedschaft in Pacemaker, nicht nur corosync)
    const ohnePm = await fencing([PRUEFEN_T, BELEGEN], ['', `${reset()}\nrm -f "$T/svc/pacemaker.is-active"`]);
    keinBeleg(ohnePm.laeufe[1]!, /sqllnx01 ist nach dem Reset nicht online im Cluster \(online: sqllnx01,sqllnx02,sqllnxcfg, Quorum 1\) — Pacemaker hier: .*kein Beleg/);
    expect(ohnePm.beleg).toBeUndefined();
    const ohneSbd = await fencing([PRUEFEN_T, BELEGEN], ['', `${reset()}\nrm -f "$T/svc/sbd.is-active"`]);
    keinBeleg(ohneSbd.laeufe[1]!, /sbd läuft auf sqllnx01 nach dem Reset nicht — kein Beleg/);
    const wd = await fencing([PRUEFEN_T, BELEGEN], ['', `${reset()}\nrm -rf "$T/proc/42"`]);
    keinBeleg(wd.laeufe[1]!, /sbd hält auf sqllnx01 nach dem Reset kein \/dev\/watchdog offen/);
  });
  it('neu eingerichteter Cluster: Test vorher → kein Beleg; Beleg vorher → ungültig (fencing_belegen verlangt neuen Test)', async () => {
    const w = await fencing([PRUEFEN_T, BELEGEN], ['', `${reset()}\nprintf 'neuer-schluessel' >"$T/authkey"`]);
    keinBeleg(w.laeufe[1]!, /Test vor einer Neueinrichtung des Clusters/);
    const v = await fencing([PRUEFEN_T, BELEGEN, BELEGEN], ['', reset(), `printf 'neuer-schluessel' >"$T/authkey"`]);
    expect(v.laeufe[1]!.rc, v.laeufe[1]!.aus).toBe(0);
    keinBeleg(v.laeufe[2]!, /Test vor einer Neueinrichtung des Clusters/);
  });
  it('fencing_pruefen bricht vor jeder Änderung ab: 2/3 online, Ressourcen, Watchdog nicht bei sbd, sbd aus, haenger auf einem Datenknoten, no-quorum-policy ignore', async () => {
    const f = async (z: string, muster: RegExp, text = PRUEFEN_T) => {
      const w = await fencing([text], [z]);
      const a = w.laeufe[0]!;
      keinBeleg(a, muster);
      expect(String(a.ergebnis?.fehler)).toContain('nichts geändert');
      expect(a.log.trim()).toBe('');
      expect(w.test).toBeUndefined();
    };
    await f('echo 2 >"$T/online"', /Cluster: 2\/3 online .* nur, wenn alle Knoten online sind/);
    await f('echo 1 >"$T/ressourcen"', /trägt 1 Ressourcen — Fencing-Beweis nur vor dem AG-Aufbau/);
    await f('rm -rf "$T/proc/42"', /sbd hält auf sqllnx01 kein \/dev\/watchdog offen/);
    await f('rm -f "$T/svc/sbd.is-active"', /sbd läuft auf sqllnx01 nicht/);
    await f('echo ignore >"$T/prop/no-quorum-policy"', /no-quorum-policy=ignore/);
    await f('', /haenger \(Kernel-Absturz\) nur auf sqllnxcfg .* nicht auf sqllnx01/, PRUEFEN_H);
    await f('rm -f "$T/authkey"', /Cluster-Identität auf sqllnx01 nicht lesbar \(Cluster sqllnxcl01, nodeid 1, authkey fehlt, SBD-Konfiguration lesbar\)/);
  });
  it('Auslöser nicht planbar → sichtbarer Abbruch, Test-Datei wieder entfernt (sonst sperrte sie den Knoten 30 min als „läuft noch“)', async () => {
    const w = await fencing([PRUEFEN_T, PRUEFEN_T], ['touch "$T/run_scheitert"', 'rm -f "$T/run_scheitert"']);
    keinBeleg(w.laeufe[0]!, /Aufheben der Sperre nicht planbar: .* nichts ausgelöst, Test-Datei entfernt/);
    // Final-Review I-1: die (wieder entfernte) Test-Datei steht trotzdem in der Änderungsliste — nichts still
    expect(String(w.laeufe[0]!.ergebnis?.fehler)).toMatch(/Test-Datei entfernt — bisher geändert: fencing-test-datei,aufheben-geplant-versucht$/);
    expect(w.laeufe[1]!.rc, w.laeufe[1]!.aus).toBe(0);
    expect(w.laeufe[1]!.ergebnis).toMatchObject({ zustand: 'ausgeloest' });
  });
  it('I-1: Selbstprüfung nach dem Planen scheitert (Timer nicht aktiv) → Abbruch nennt Test-Datei, Aufheben und Auslöser; Test-Datei bleibt', async () => {
    const w = await fencing([PRUEFEN_T], ['touch "$T/timer_inaktiv"']);
    keinBeleg(w.laeufe[0]!, /^Selbstprüfung: Auslöser alfred-fencetest-\d+\.timer nicht aktiv — bisher geändert: fencing-test-datei,aufheben-geplant,ausloeser-geplant$/);
    expect(w.test).toMatchObject({ art: 'trennung' });
  });
  // ── Fix-Runde 1 ──
  it('Auslösezeit aus der Uhr unmittelbar vor dem Schreiben (die Uhr läuft während Phase 1/2 weiter) → resetS genau', async () => {
    const w = await fencing([PRUEFEN_T, BELEGEN], ['echo 7 >"$T/jetzt_schritt"', reset({ resetS: 25 })]);
    const [p, b] = w.laeufe as [ClLauf, ClLauf];
    expect(p.rc, p.aus).toBe(0);
    expect(w.test).toMatchObject({ zeitS: J + 7, ausloeseS: J + 17 });
    expect(p.ergebnis).toMatchObject({ einheit: `alfred-fencetest-${J + 7}` });
    expect(p.log).toContain(`--unit=alfred-fencetest-${J + 7} --on-active=10 `);
    expect(b.rc, b.aus).toBe(0);
    // btime = J + 10 + 25 = J + 35; Auslösung J + 17 → 18 s (mit der Uhr aus Phase 1 wären es fälschlich 25 s)
    expect(w.beleg).toMatchObject({ resetS: 18 });
    expect(String((w.beleg!.quellen as Record<string, string>).resetS)).toContain('unmittelbar vor dem Schreiben der Test-Datei');
  });
  it('geordnetes Herunterfahren im getesteten Start (systemd reboot.target, journald „Journal stopped“, logind) → kein Beleg', async () => {
    const f = async (art: keyof typeof SHUTDOWN, muster: RegExp) => { const w = await fencing([PRUEFEN_T, BELEGEN], ['', reset({ shutdown: art })]); keinBeleg(w.laeufe[1]!, muster); expect(w.beleg).toBeUndefined(); };
    await f('reboot', /geordnetes Herunterfahren im getesteten Start \(systemd: Reached target reboot\.target - System Reboot\.\) — ein Neustart, kein Fencing-Reset; kein Beleg/);
    await f('journald', /geordnetes Herunterfahren im getesteten Start \(systemd-journald: Journal stopped\)/);
    await f('logind', /geordnetes Herunterfahren im getesteten Start \(systemd-logind: System is rebooting\.\)/);
  });
  it('trennung: Reset schneller als Corosync-Token + SBD_WATCHDOG_TIMEOUT → kein Beleg; Token nicht lesbar → fest 1000 ms; haenger ohne Untergrenze', async () => {
    const zuSchnell = await fencing([PRUEFEN_T, BELEGEN], ['', reset({ resetS: 12 })]);
    keinBeleg(zuSchnell.laeufe[1]!, /Reset schon 12 s nach der Auslösung \(mindestens 13 s = Corosync-Token \+ SBD_WATCHDOG_TIMEOUT\) — nicht die Folge der Trennung; kein Beleg/);
    expect(zuSchnell.test).toMatchObject({ minResetS: 13, corosyncTaktMs: 3000, taktQuelle: 'live' });
    expect(zuSchnell.beleg).toBeUndefined();
    const fest = await fencing([PRUEFEN_T, BELEGEN], ['rm -f "$T/token_ms"', reset({ resetS: 12 })]);
    expect(fest.test).toMatchObject({ minResetS: 11, corosyncTaktMs: 1000, taktQuelle: 'fest' });
    expect(fest.laeufe[1]!.rc, fest.laeufe[1]!.aus).toBe(0);
    expect(fest.beleg).toMatchObject({ resetS: 12, minResetS: 11 });
    const h = await fencing([PRUEFEN_H, BELEGEN], ['echo sqllnxcfg >"$T/name"', reset({ resetS: 5 })]);
    expect(h.test).toMatchObject({ minResetS: 0 });
    expect(h.laeufe[1]!.rc, h.laeufe[1]!.aus).toBe(0);
    expect(h.beleg).toMatchObject({ art: 'haenger', resetS: 5 });
  });
  // ── Fix-Runde 2: fail closed ──
  it('Prüfung auf Herunterfahren abgestürzt oder ohne Antwort → kein Beleg (nur „KEINE“ mit Exit 0 gilt als sauber)', async () => {
    const absturz = await fencing([PRUEFEN_T, BELEGEN], ['', `${reset()}\necho absturz >"$T/spur_kaputt"`]);
    keinBeleg(absturz.laeufe[1]!, /Prüfung auf geordnetes Herunterfahren gescheitert \(Exit 1\) — kein Beleg/);
    expect(absturz.beleg).toBeUndefined();
    const leer = await fencing([PRUEFEN_T, BELEGEN], ['', `${reset()}\necho leer >"$T/spur_kaputt"`]);
    keinBeleg(leer.laeufe[1]!, /Prüfung auf geordnetes Herunterfahren ohne eindeutige Antwort \(''\) — kein Beleg/);
    expect(leer.beleg).toBeUndefined();
  });
  it.skipIf(!PYTHON)('shutdown_spur: sauber → genau „KEINE“, Spur → „SPUR …“, leere Eingabe → „KEINE“', () => {
    const lauf = (input: string) => spawnSync(PYTHON!, ['-c', PY_FENCING, 'shutdown_spur'], { input, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    const sauber = lauf('{"MESSAGE":"irgendwas"}\nkein json\n');
    expect([sauber.status, sauber.stdout.trim()]).toEqual([0, 'KEINE']);
    const spur = lauf(`${SHUTDOWN.journald('x', J)}\n`);
    expect([spur.status, spur.stdout.trim()]).toEqual([0, 'SPUR systemd-journald: Journal stopped']);
    expect(lauf('').stdout.trim()).toBe('KEINE');
  });
  it('trennung-Test ohne gültige Untergrenze minResetS (fehlt, 0, NaN) → kein Beleg', async () => {
    const datei = '"$T/ha/fencing-test.json"';
    for (const [sed, name] of [['s/"minResetS": 13, //', 'fehlt'], ['s/"minResetS": 13/"minResetS": 0/', '0'], ['s/"minResetS": 13/"minResetS": NaN/', 'NaN']] as const) {
      const w = await fencing([PRUEFEN_T, BELEGEN], ['', `${reset()}\nsed -i '${sed}' ${datei}`]);
      keinBeleg(w.laeufe[1]!, /Fencing-Test nicht verwendbar: Test-Datei ohne gültige Untergrenze minResetS \(trennung\) — kein Beleg/);
      expect(w.beleg, name).toBeUndefined();
      if (name === 'fehlt') expect(w.test!.minResetS).toBeUndefined(); // die Änderung hat gegriffen
    }
  });
  it('Beleg besteht die eigene Selbstprüfung nicht → Abbruch und Beleg-Datei entfernt', async () => {
    const w = await fencing([PRUEFEN_T, BELEGEN], ['', `${reset()}\ntouch "$T/beleg_kaputt"`]);
    keinBeleg(w.laeufe[1]!, /Selbstprüfung: geschriebener Beleg ist nicht gültig: Beleg ohne gültige Art — Beleg entfernt/);
    expect(w.beleg).toBeUndefined();
  });
  it('SBD neu eingerichtet (/etc/default/sbd anders) nach dem Beleg → Beleg ungültig, kein „schon“', async () => {
    const w = await fencing([PRUEFEN_T, BELEGEN, BELEGEN], ['', reset(), 'printf "SBD_WATCHDOG_TIMEOUT=15\\n" >"$T/sbd_default"']);
    expect(w.laeufe[1]!.rc, w.laeufe[1]!.aus).toBe(0);
    keinBeleg(w.laeufe[2]!, /Test vor einer Neueinrichtung des Clusters oder von SBD/);
  });
  it('haenger auf sqllnxcfg: sysrq c entkoppelt, Beleg nach Reset; kernel.panic ≠ 0 oder kdump → Abbruch ohne Änderung', async () => {
    const cfg = 'echo sqllnxcfg >"$T/name"';
    const w = await fencing([PRUEFEN_H, BELEGEN], [cfg, reset()]);
    const [p, b] = w.laeufe as [ClLauf, ClLauf];
    expect(p.rc, p.aus).toBe(0);
    expect(p.ergebnis).toMatchObject({ zustand: 'ausgeloest', art: 'haenger', knoten: 'sqllnxcfg', sperreS: 0, aenderungen: ['fencing-test-datei', 'ausloeser-geplant'] });
    expect(p.log.trim().split('\n')).toEqual([expect.stringMatching(new RegExp(`^systemd-run --unit=alfred-fencetest-${J} --on-active=10 --timer-property=AccuracySec=1s /bin/sh -c sync; echo c > \\S+sysrq-trigger$`))]);
    expect(w.nft).toBe('FEHLT');
    expect(b.rc, b.aus).toBe(0);
    expect(w.beleg).toMatchObject({ art: 'haenger', knoten: 'sqllnxcfg', nodeid: '3', resetS: 18, rejoinS: 41 });
    for (const [z, m] of [['echo 10 >"$T/panic"', /kernel\.panic ist '10'/], ['echo 1 >"$T/kexec"', /kdump-Kernel geladen/]] as const) {
      const x = await fencing([PRUEFEN_H], [`${cfg}; ${z}`]);
      keinBeleg(x.laeufe[0]!, m);
      expect(x.laeufe[0]!.log.trim()).toBe('');
      expect(x.test).toBeUndefined();
    }
    // nach dem trennung-Beleg darf sqllnxcfg noch den haenger-Test machen (andere Art); danach gilt der haenger-Beleg
    const beide = await fencing([PRUEFEN_T, BELEGEN, PRUEFEN_H], [cfg, reset(), `echo ${J + 300} >"$T/jetzt"`]);
    expect(beide.laeufe[2]!.rc, beide.laeufe[2]!.aus).toBe(0);
    expect(beide.laeufe[2]!.ergebnis).toMatchObject({ zustand: 'ausgeloest', art: 'haenger' });
  });
});

// ── Live-Fix (Change c2e4f56d): die Schwärzung im Fernzugriff darf keine Ergebniszeile verändern ──────────────────────────────
// Realfall: „tokenMs“/„tokenQuelle“ trafen GEHEIM_NAME (TOKEN) → Werte „[geschwärzt]“ → ALFRED-HA-Zeile kein JSON mehr → „gescheitert (Exit 0)“.

/** jede ALFRED-HA-Zeile übersteht schwaerze unverändert und bleibt JSON */
const ueberstehtSchwaerzung = (aus: string, wo: string) => {
  const zeilen = aus.split(/\r?\n/).filter(z => z.startsWith('ALFRED-HA '));
  expect(zeilen.length, `${wo}: keine ALFRED-HA-Zeile`).toBeGreaterThan(0);
  const nach = schwaerze(aus).text.split(/\r?\n/).filter(z => z.startsWith('ALFRED-HA '));
  expect(nach, wo).toEqual(zeilen);
  for (const z of nach) expect(() => JSON.parse(z.slice('ALFRED-HA '.length)), `${wo}: ${z.slice(0, 200)}`).not.toThrow();
};
/** alle Schlüssel (rekursiv) eines Ergebnisobjekts */
const schluessel = (o: unknown, aus: Set<string> = new Set()): Set<string> => {
  if (Array.isArray(o)) for (const x of o) schluessel(x, aus);
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { aus.add(k); schluessel(v, aus); }
  return aus;
};
/** Python-Ausgabe wie auf dem Knoten (json.dumps mit „, “ und „: “ — Leerzeichen nach dem Doppelpunkt wie im Realfall) */
const pyJson = (o: unknown) => spawnSync(PYTHON!, ['-c', 'import json, sys; print(json.dumps(json.loads(sys.stdin.read())))'], { input: JSON.stringify(o), encoding: 'utf8' }).stdout.trim();

describe('I8e Paket 2 — Live-Fix: Ergebnisfelder ohne Geheimnis-Namen', { timeout: 240_000 }, () => {
  it('Muster bestätigt: ein Feld „tokenMs“ würde geschwärzt und zerstörte die JSON-Zeile (Grund des Live-Fehlers)', () => {
    const alt = 'ALFRED-HA {"zustand": "ausgeloest", "test": {"tokenMs": 3000, "tokenQuelle": "live"}}';
    const s = schwaerze(alt);
    expect(s.anzahl).toBeGreaterThan(0);
    expect(() => JSON.parse(s.text.slice('ALFRED-HA '.length))).toThrow();
  });
  it('statisch: kein ausgegebener Schlüssel in Status-Programm, Fencing-Werkzeug oder Bash-Bausteinen trifft GEHEIM_NAME', () => {
    const texte = [PY_HA_STATUS, PY_FENCING, haVorbereitenSkript(P), haClusterSkript(PC), haClusterEntfernenSkript(PC), PRUEFEN_T, PRUEFEN_H, BELEGEN, haStatusSkript()];
    const namen = new Set<string>();
    for (const t of texte) {
      for (const m of t.matchAll(/\\?"([A-Za-z_][A-Za-z0-9_]*)\\?"\s*:/g)) namen.add(m[1]!); // {"k": …} und \"k\": im Bash-Ergebnis
      for (const m of t.matchAll(/\b[A-Za-z_]\w*\["([A-Za-z_][A-Za-z0-9_]*)"\]\s*=/g)) namen.add(m[1]!); // r["k"] = …
    }
    // feste Feldlisten der Sicht auf Test und Beleg
    for (const liste of ['TEST_FELDER', 'BELEG_FELDER', 'QUELLEN_FELDER']) {
      const z = PY_FENCING.split('\n').find(x => x.startsWith(`${liste} = (`))!;
      expect(z, liste).toBeDefined();
      for (const m of z.matchAll(/"([A-Za-z_]\w*)"/g)) namen.add(m[1]!);
    }
    expect(namen.size).toBeGreaterThan(60);
    for (const n of ['zustand', 'corosyncTaktMs', 'taktQuelle', 'minResetS', 'konfHash', 'fencing', 'sperreAktiv']) expect(namen).toContain(n);
    // Ausnahme: _BOOT_ID/__REALTIME_TIMESTAMP/MESSAGE sind gelesene Journal-Felder, keine Ausgabe — sie treffen ohnehin nicht
    expect([...namen].filter(n => GEHEIM_NAME.test(n))).toEqual([]);
  });
  it.skipIf(!BASH)('ha_vorbereiten: Ergebniszeilen überstehen schwaerze', () => {
    const w = laeufe('');
    for (const [i, l] of w.laeufe.entries()) { ueberstehtSchwaerzung(l.aus, `vorbereiten ${i}`); expect([...schluessel(l.ergebnis)].filter(n => GEHEIM_NAME.test(n))).toEqual([]); }
  });
  it.skipIf(!BASH || !PYTHON)('cluster_anlegen/-entfernen und alle Fencing-Ergebnisse (ausgeloest, schon, Beleg, Fehler) überstehen schwaerze; Schlüssel ohne Geheimnis-Namen', async () => {
    const c = await cluster([ANLEGEN, ANLEGEN, ENTFERNEN, ENTFERNEN]);
    for (const [i, l] of c.laeufe.entries()) { expect(l.rc, l.aus).toBe(0); ueberstehtSchwaerzung(l.aus, `cluster ${i}`); }
    const f = await fencing([PRUEFEN_T, BELEGEN, BELEGEN, PRUEFEN_T, BELEGEN], ['', reset(), '', '', `printf 'x' >"$T/sbd_default"`]);
    const h = await fencing([PRUEFEN_H, PRUEFEN_H], ['echo sqllnxcfg >"$T/name"', '']);
    const alle = [...f.laeufe, ...h.laeufe];
    expect(alle.map(l => l.ergebnis?.zustand)).toEqual(['ausgeloest', 'geaendert', 'schon', 'schon', 'fehler', 'ausgeloest', 'fehler']);
    for (const [i, l] of alle.entries()) {
      ueberstehtSchwaerzung(l.aus, `fencing ${i}`);
      expect([...schluessel(l.ergebnis)].filter(n => GEHEIM_NAME.test(n)), `fencing ${i}`).toEqual([]);
    }
    expect((f.laeufe[0]!.ergebnis!.test as Record<string, unknown>)).toMatchObject({ corosyncTaktMs: 3000, taktQuelle: 'live' });
  });
  it.skipIf(!BASH || !PYTHON)('alte Test-Datei (tokenMs/tokenQuelle, wie auf sqllnxcfg): wird gelesen, nur unter den neuen Namen ausgegeben, Zeile übersteht schwaerze', async () => {
    const alt = `sed -i 's/"corosyncTaktMs"/"tokenMs"/; s/"taktQuelle"/"tokenQuelle"/; s/}$/, "fremdesFeld": {"password": "x"}}/' "$T/ha/fencing-test.json"`;
    const w = await fencing([PRUEFEN_T, PRUEFEN_T, BELEGEN], ['', `${alt}\n${reset()}`, '']);
    expect(w.test).toMatchObject({ tokenMs: 3000, tokenQuelle: 'live' }); // die Datei hat wirklich die alten Namen
    const [, schon, beleg] = w.laeufe as [ClLauf, ClLauf, ClLauf];
    expect(schon.rc, schon.aus).toBe(0);
    expect(schon.ergebnis).toMatchObject({ zustand: 'schon', test: { corosyncTaktMs: 3000, taktQuelle: 'live', minResetS: 13 } });
    expect(Object.keys(schon.ergebnis!.test as object)).not.toContain('fremdesFeld');
    expect(beleg.rc, beleg.aus).toBe(0);
    for (const l of [schon, beleg]) { ueberstehtSchwaerzung(l.aus, l.ergebnis!.zustand as string); expect([...schluessel(l.ergebnis)].filter(n => GEHEIM_NAME.test(n))).toEqual([]); }
  });
  it.skipIf(!PYTHON)('Status: Fencing-Teil nur mit festen Feldern (alte und fremde Schlüssel weg) — ganze Statuszeile übersteht schwaerze', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-sicht-'));
    try {
      const td = join(dir, 'test.json'); const bd = join(dir, 'beleg.json');
      writeFileSync(td, JSON.stringify({ art: 'trennung', bootIdVorher: ALT, zeit: '2026-11-17T14:00:00Z', zeitS: J, ausloeseS: J + 10, sperreS: 120, minResetS: 13, tokenMs: 3000, tokenQuelle: 'live', knoten: 'sqllnxcfg', cluster: 'sqllnxcl01', nodeid: '3', konfHash: 'h', passwort: 'geheim-1234', liste: [1] }));
      writeFileSync(bd, '{"art": "trennung", "resetS": NaN, "rejoinS": 41, "quellen": {"resetS": "btime", "apiKey": "abc12345"}, "secret": "x"}');
      const prog = `${PY_FENCING_FUNK}\nimport sys\nprint(json.dumps({"test": sicht_test(lies_json(sys.argv[1])), "beleg": sicht_beleg(lies_json(sys.argv[2])), "fehlt": sicht_beleg(lies_json(sys.argv[3]))}))`;
      const r = spawnSync(PYTHON!, ['-c', prog, td, bd, join(dir, 'gibtsnicht')], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      const f = JSON.parse(r.stdout) as { test: Record<string, unknown>; beleg: Record<string, unknown>; fehlt: unknown };
      expect(f.test).toMatchObject({ corosyncTaktMs: 3000, taktQuelle: 'live', minResetS: 13, nodeid: '3' });
      expect(Object.keys(f.test).sort()).toEqual(['art', 'ausloeseS', 'bootIdVorher', 'cluster', 'corosyncTaktMs', 'kernelPanic', 'knoten', 'konfHash', 'minResetS', 'nodeid', 'sperreS', 'sysrq', 'taktQuelle', 'zeit', 'zeitS']);
      expect(f.beleg).toMatchObject({ art: 'trennung', resetS: null, rejoinS: 41, quellen: { resetS: 'btime', rejoinS: null } });
      expect(JSON.stringify(f)).not.toMatch(/passwort|secret|apiKey|tokenMs|liste/);
      expect(f.fehlt).toBeNull();
      // ganze Statuszeile wie PY_HA_STATUS sie ausgibt (python json.dumps), mit Cluster- und Fencing-Teil
      const status = { zustand: 'gelesen', watchdog: [{ geraet: 'watchdog0', kennung: 'i6300ESB timer', treiber: 'i6300esb' }], pciEsb: true, halter: [{ pid: 812, name: 'sbd', exe: '/usr/sbin/sbd' }],
        pakete: { pacemaker: { version: '2.1.6-5ubuntu2', gehalten: true } }, soll: { pacemaker: '2.1.6-5ubuntu2' }, hadr: '1', sqlDienst: 'active', firewall: { tabelle: true, dienst: 'active', aktiviert: 'enabled' },
        hosts: true, hostsLoopback: [], hostsEntfernt: ['# ALFRED-HA ENTFERNT (Loopback mit eigenem Namen): 127.0.1.1 sqllnxcfg'], sql1433Zusatz: ['192.168.1.223'], runtimeWatchdog: '0', pcsd: 'active',
        cluster: { art: 'eingerichtet', name: 'sqllnxcl01', knoten: HA_KNOTEN, crm: { knoten: 3, online: ['sqllnx01', 'sqllnx02', 'sqllnxcfg'], quorum: true, stonith: true, ressourcen: 0 },
          sbd: { sqllnx01: { installiert: true, aktiviert: true, laeuft: true } }, stonithWatchdogTimeout: '20' },
        fencing: { bootId: NEU, jetztS: J + 200, test: f.test, beleg: f.beleg, identitaet: { cluster: 'sqllnxcl01', knoten: 'sqllnxcfg', nodeid: '3', konfHash: 'h' }, sperreAktiv: false } };
      ueberstehtSchwaerzung(`ALFRED-HA ${pyJson(status)}`, 'status');
      expect([...schluessel(status)].filter(n => GEHEIM_NAME.test(n))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── Task 5: Verfügbarkeitsgruppe (ag_anlegen / ag_entfernen) ────────────────────────────────────────────────────────────────────

const BES = { primaer: 'sqllnx01', sekundaer: 'sqllnx02', konfig: 'sqllnxcfg' };
const DER = (f: string) => `30820010${f.repeat(16)}`;
const PEERS: Record<string, HaAgReplikatParameter['peers']> = {
  sqllnx01: [{ name: 'sqllnx02', zertifikat: DER('B2'), fingerabdruck: '2'.repeat(40) }, { name: 'sqllnxcfg', zertifikat: DER('C3'), fingerabdruck: '3'.repeat(40) }],
  sqllnx02: [{ name: 'sqllnx01', zertifikat: DER('A1'), fingerabdruck: '1'.repeat(40) }, { name: 'sqllnxcfg', zertifikat: DER('C3'), fingerabdruck: '3'.repeat(40) }],
  sqllnxcfg: [{ name: 'sqllnx01', zertifikat: DER('A1'), fingerabdruck: '1'.repeat(40) }, { name: 'sqllnx02', zertifikat: DER('B2'), fingerabdruck: '2'.repeat(40) }],
};
const ROLLE_VON = { sqllnx01: 'primaer', sqllnx02: 'sekundaer', sqllnxcfg: 'konfig' } as const;
const AG_EP = (k: keyof typeof ROLLE_VON = 'sqllnx01'): HaAgEndpunktParameter => ({ cluster: 'sqllnxcl01', ag: 'sqllnxag01', besetzung: { ...BES }, rolle: ROLLE_VON[k], knoten: [...HA_KNOTEN] });
const AG_RP = (k: keyof typeof ROLLE_VON = 'sqllnx01'): HaAgReplikatParameter => ({ ag: 'sqllnxag01', besetzung: { ...BES }, rolle: ROLLE_VON[k], knoten: [...HA_KNOTEN], peers: PEERS[k]!.map(x => ({ ...x })), datenbanken: ['pruefdb01'] });
const AG_AB: HaAgAbschlussParameter = { ag: 'sqllnxag01', besetzung: { ...BES }, knoten: [...HA_KNOTEN], datenbanken: ['alfredpruef'], vip: { ip: '10.203.30.13', praefix: 27 } };
const AG_EN = (k: keyof typeof ROLLE_VON = 'sqllnx01'): HaAgEntfernenParameter => ({ ag: 'sqllnxag01', besetzung: { ...BES }, rolle: ROLLE_VON[k], knoten: [...HA_KNOTEN], ressourcen: k === 'sqllnx01' });
function AG_SKRIPTE(): string[] {
  return (['sqllnx01', 'sqllnx02', 'sqllnxcfg'] as const).flatMap(k => [haAgEndpunktSkript(AG_EP(k)), haAgReplikatSkript(AG_RP(k)), haAgEntfernenSkript(AG_EN(k))]).concat(haAgAbschlussSkript(AG_AB));
}

describe('I8e Paket 2 Task 5 — AG-Bausteine (Text, Validatoren)', () => {
  it('registriert; Validatoren: Besetzung aus den festen Knoten, Konfig = sqllnxcfg, Peers = die beiden anderen mit öffentlichem Zertifikat, Datenbanken, VIP', () => {
    expect(linuxBausteinSkript(LINUX_HA_BAUSTEINE.agEndpunkt, AG_EP())).toBe(haAgEndpunktSkript(AG_EP()));
    expect(linuxBausteinSkript(LINUX_HA_BAUSTEINE.agReplikat, AG_RP('sqllnx02'))).toBe(haAgReplikatSkript(AG_RP('sqllnx02')));
    expect(linuxBausteinSkript(LINUX_HA_BAUSTEINE.agAbschluss, AG_AB)).toBe(haAgAbschlussSkript(AG_AB));
    expect(linuxBausteinSkript(LINUX_HA_BAUSTEINE.agEntfernen, AG_EN())).toBe(haAgEntfernenSkript(AG_EN()));
    expect(pruefeHaAgEndpunkt(AG_EP())).toBeUndefined();
    expect(pruefeHaAgEndpunkt({ ...AG_EP(), besetzung: { ...BES, konfig: 'sqllnx02', sekundaer: 'sqllnxcfg' } })).toContain('konfig: sqllnxcfg');
    expect(pruefeHaAgEndpunkt({ ...AG_EP(), besetzung: { ...BES, sekundaer: 'sqllnx01' } })).toContain('verschieden');
    expect(pruefeHaAgEndpunkt({ ...AG_EP(), rolle: 'zeuge' as never })).toContain('rolle');
    expect(pruefeHaAgEndpunkt({ ...AG_EP(), ag: "ag'; --" })).toContain('ag:');
    expect(pruefeHaAgReplikat(AG_RP('sqllnx02'))).toBeUndefined();
    expect(pruefeHaAgReplikat({ ...AG_RP('sqllnx02'), peers: PEERS.sqllnx01! })).toContain('peers');
    expect(pruefeHaAgReplikat({ ...AG_RP(), peers: [{ ...PEERS.sqllnx01![0]!, zertifikat: '1EF1B5B0' + '00'.repeat(20) }, PEERS.sqllnx01![1]!] })).toContain('öffentliches Zertifikat');
    expect(pruefeHaAgReplikat({ ...AG_RP(), peers: [{ ...PEERS.sqllnx01![0]!, fingerabdruck: 'xyz' }, PEERS.sqllnx01![1]!] })).toContain('fingerabdruck');
    expect(pruefeHaAgAbschluss(AG_AB)).toBeUndefined();
    for (const d of [[], ['tempdb'], ['a b'], ['alfredpruef', 'alfredpruef']]) expect(pruefeHaAgAbschluss({ ...AG_AB, datenbanken: d })).toContain('datenbanken');
    expect(pruefeHaAgAbschluss({ ...AG_AB, vip: { ip: '10.203.30.256', praefix: 27 } })).toContain('vip');
    expect(pruefeHaAgEntfernen(AG_EN())).toBeUndefined();
    expect(pruefeHaAgEntfernen({ ...AG_EN(), ressourcen: 'ja' as never })).toContain('ressourcen');
    // DER: 30 82 LLLL + genau LLLL Bytes, Großbuchstaben-Hex; PVK-Blob, PEM, Rest danach, kleingeschrieben → nein
    expect(istOeffentlichesZertifikat(DER('A1'))).toBe(true);
    for (const x of ['1EF1B5B0' + '00'.repeat(20), '-----BEGIN PRIVATE KEY-----', `${DER('A1')}00`, '30820010AB', DER('a1'), '', 'ZZ']) expect(istOeffentlichesZertifikat(x), x).toBe(false);
  });

  it('nur öffentliche Zertifikate verlassen einen Knoten: Endpunkt exportiert nur CERTENCODED, nie privaten Schlüssel; Import nur FROM BINARY', () => {
    const alle = AG_SKRIPTE().join('\n');
    for (const verboten of ['CERTPRIVATEKEY', 'PRIVATE KEY', 'BACKUP CERTIFICATE', 'BACKUP MASTER KEY', 'BACKUP SERVICE MASTER KEY', 'FROM FILE']) expect(alle, verboten).not.toContain(verboten);
    const ep = haAgEndpunktSkript(AG_EP());
    expect(ep).toContain('CONVERT(varchar(8000), CERTENCODED(c.certificate_id), 2)');
    const rp = haAgReplikatSkript(AG_RP());
    expect(rp).toContain(`CREATE CERTIFICATE [alfred_ag_sqllnx02] AUTHORIZATION [alfred_ag_sqllnx02] FROM BINARY = 0x${DER('B2')}`);
    expect(rp).toContain('GRANT CONNECT ON ENDPOINT::[alfred_hadr] TO [alfred_ag_sqllnx02]');
    expect(rp).not.toContain(DER('A1')); // das eigene Zertifikat kommt nie zurück
    // Geheimnisse nie im Text, nur über stdin (feld)
    const mit = haAgEndpunktSkript({ ...AG_EP(), sa: 'Sa-Geheim-1', pacemaker: 'Pm-Geheim-2' } as never);
    expect(mit).not.toMatch(/Sa-Geheim-1|Pm-Geheim-2/);
    for (const f of ['sa', 'hauptschluessel', 'pacemaker']) expect(mit).toContain(`geheim_lesen ${f} `);
  });

  it('required_synchronized_secondaries_to_commit = 0 an beiden Stellen (CREATE AVAILABILITY GROUP und pcs-Ressource) und in der Selbstprüfung', () => {
    // T-SQL steht als Shell-Literal im Skript (' → '''); für den Vergleich zurückübersetzt
    const un = (t: string) => t.replaceAll(`'\\''`, "'");
    const rp = un(haAgReplikatSkript(AG_RP()));
    expect(rp).toContain('CREATE AVAILABILITY GROUP [sqllnxag01] WITH (CLUSTER_TYPE = EXTERNAL, REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT = 0, AUTOMATED_BACKUP_PREFERENCE = PRIMARY) FOR REPLICA ON');
    expect(rp).toContain("N''sqllnx01'' WITH (ENDPOINT_URL = N''TCP://10.203.30.10:5022'', AVAILABILITY_MODE = SYNCHRONOUS_COMMIT, FAILOVER_MODE = EXTERNAL, SEEDING_MODE = AUTOMATIC)");
    expect(rp).toContain("N''sqllnx02'' WITH (ENDPOINT_URL = N''TCP://10.203.30.11:5022'', AVAILABILITY_MODE = SYNCHRONOUS_COMMIT, FAILOVER_MODE = EXTERNAL, SEEDING_MODE = AUTOMATIC)");
    expect(rp).toContain("N''sqllnxcfg'' WITH (ENDPOINT_URL = N''TCP://10.203.30.12:5022'', AVAILABILITY_MODE = CONFIGURATION_ONLY)");
    expect(rp).toContain('SET (REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT = 0)');
    const sek = un(haAgReplikatSkript(AG_RP('sqllnx02')));
    expect(sek).toContain("EXEC (N'ALTER AVAILABILITY GROUP [sqllnxag01] JOIN WITH (CLUSTER_TYPE = EXTERNAL)')");
    expect(sek).toContain("EXEC (N'ALTER AVAILABILITY GROUP [sqllnxag01] GRANT CREATE ANY DATABASE')");
    const cfg = un(haAgReplikatSkript(AG_RP('sqllnxcfg')));
    expect(cfg).toContain('JOIN WITH (CLUSTER_TYPE = EXTERNAL)');
    expect(cfg).not.toContain('GRANT CREATE ANY DATABASE');
    const ab = haAgAbschlussSkript(AG_AB);
    expect(ab).toContain('pcs resource create "$AG_RES" ocf:mssql:ag "ag_name=$AG" required_synchronized_secondaries_to_commit=0 meta failure-timeout=60s promotable notify=true');
    expect(ab).toContain('pcs resource create "$VIP_RES" ocf:heartbeat:IPaddr2 "ip=$VIP_IP" "cidr_netmask=$VIP_PRAEFIX" op monitor interval=30s --disabled');
    expect(ab).toContain('pcs constraint colocation add "$VIP_RES" with Promoted "$AG_KLON" INFINITY');
    expect(ab).toContain('pcs constraint order promote "$AG_KLON" then start "$VIP_RES"');
    expect(ab).toContain('abbruch "Selbstprüfung: REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT in SQL ist');
    expect(ab).toContain('abbruch "Selbstprüfung: required_synchronized_secondaries_to_commit an der Ressource');
  });

  it.skipIf(!BASH)('bash -n: alle AG-Skripte syntaktisch gültig', () => {
    for (const s of AG_SKRIPTE()) { const r = spawnSync('bash', ['-n'], { input: s, encoding: 'utf8' }); expect(r.status, r.stderr).toBe(0); }
  });
  it.skipIf(!PYTHON)('PY_AG_PCS parst; crm_mon-Lage (Promoted/Master, VIP Started) und Constraints (Promoted/Master, INFINITY)', () => {
    const py = (args: string[], input: string) => spawnSync(PYTHON!, ['-c', PY_AG_PCS, ...args], { input, encoding: 'utf8' });
    const mon = '<pacemaker-result><resources><clone id="ag_cluster-clone" multi_state="true"><resource id="ag_cluster" role="Promoted" active="true" failed="false"><node name="sqllnx01" id="1"/></resource>'
      + '<resource id="ag_cluster" role="Unpromoted" active="true"><node name="sqllnx02" id="2"/></resource></clone><resource id="ag_vip" role="Started" active="true"><node name="sqllnx01" id="1"/></resource></resources></pacemaker-result>';
    expect(py(['lage', 'ag_cluster', 'ag_vip'], mon).stdout.trim()).toBe('sqllnx01 sqllnx01');
    expect(py(['lage', 'ag_cluster', 'ag_vip'], mon.replace('"Promoted"', '"Master"').replace('role="Started"', 'role="Stopped"')).stdout.trim()).toBe('sqllnx01 -');
    expect(py(['lage', 'ag_cluster', 'ag_vip'], 'kaputt').status).toBe(2);
    const reg = '<constraints><rsc_colocation id="c1" rsc="ag_vip" with-rsc="ag_cluster-clone" with-rsc-role="Promoted" score="INFINITY"/><rsc_order id="o1" first="ag_cluster-clone" first-action="promote" then="ag_vip" then-action="start"/></constraints>';
    expect(py(['regeln', 'ag_vip', 'ag_cluster-clone'], reg).stdout.trim()).toBe('1 1');
    expect(py(['regeln', 'ag_vip', 'ag_cluster-clone'], reg.replace('Promoted', 'Started').replace('promote', 'start')).stdout.trim()).toBe('0 0');
  });
  it('Ergebnisfelder ohne Geheimnis-Namen (Schwärzung im Fernzugriff)', () => {
    const namen = new Set<string>();
    for (const t of AG_SKRIPTE()) for (const m of t.matchAll(/\\?"([A-Za-z_][A-Za-z0-9_]*)\\?"\s*:/g)) namen.add(m[1]!);
    for (const n of ['zustand', 'zertifikat', 'fingerabdruck', 'requiredSyncSql', 'requiredSyncRessource', 'datenbanken']) expect(namen).toContain(n);
    expect([...namen].filter(n => GEHEIM_NAME.test(n))).toEqual([]);
  });
});

/** AG-Bausteine mit nachgebildetem sqlcmd (Antwort je „-- ALFRED-SCHRITT <name>“), pcs, crm_resource, crm_mon, cibadmin, ip */
const AG_STUBS = String.raw`
PM_DATEI="$T/secrets/passwd"; AG_MERK="$T/merk/ag-entfernen.txt"; WARTE_RUNDEN=3; SYNC_RUNDEN=3
befehl_da() { [ ! -f "$T/fehlt_§{1##*/}" ]; }
log() { echo "$*" >>"$T/log"; }
python3() { PYTHONUTF8=1 "$PY" "$@"; }
eigener_name() { cat "$T/name"; }
sleep() { :; }
fpy() { [ ! -f "$T/fpy_kaputt" ] || return 1; [ ! -f "$T/fencing_grund" ] || cat "$T/fencing_grund"; return 0; }
datei_rechte() { cat "$T/rechte" 2>/dev/null || echo '0 600'; }
chown() { :; }
sql() {
  local t; t=$(grep -o 'ALFRED-SCHRITT [a-z_]*' <<<"$1" | head -n 1 | cut -d' ' -f2)
  echo "§{t:-bereit}" >>"$T/sqllog"
  [ -n "$t" ] || return 0
  printf '%s\n' "$1" >"$T/tsql_$t"
  if [ -f "$T/sqlfehler_$t" ]; then cat "$T/sqlfehler_$t"; return 1; fi
  [ -f "$T/sql/$t" ] || { echo "kein SQL-Stub $t"; return 1; }
  cat "$T/sql/$t"
}
ip() { if [ -f "$T/res_ag_vip" ] && [ ! -f "$T/meta_ag_vip_target-role" ]; then echo "2: eth0    inet 10.203.30.10/27 brd 10.203.30.31 scope global eth0"; echo "2: eth0    inet 10.203.30.13/27 brd 10.203.30.31 scope global secondary eth0"; fi; }
crm_resource() {
  local r='' g='' m=0 q=0
  while [ $# -gt 0 ]; do case "$1" in --resource) r=$2; shift ;; --get-parameter) g=$2; shift ;; --meta) m=1 ;; --query-xml) q=1 ;; esac; shift; done
  [ -f "$T/res_$r" ] || { echo "resource $r not found" >&2; return 6; }
  [ "$q" = 0 ] || { echo "<primitive id=\"$r\"/>"; return 0; }
  if [ "$m" = 1 ]; then [ -f "$T/meta_§{r}_$g" ] || return 6; cat "$T/meta_§{r}_$g"; return 0; fi
  [ -f "$T/param_§{r}_$g" ] || return 6; cat "$T/param_§{r}_$g"
}
pcs() {
  log "pcs $*"
  [ ! -f "$T/pcs_scheitert" ] || { echo 'Error: pcs kaputt'; return 1; }
  case "$1 $2" in
    "resource create") local r=$3 a; shift 4; for a in "$@"; do case "$a" in meta|op|promotable) break ;; *=*) echo "§{a#*=}" >"$T/param_§{r}_§{a%%=*}" ;; esac; done
      touch "$T/res_$r"; case " $* " in *" --disabled "*) echo Stopped >"$T/meta_§{r}_target-role" ;; esac; return 0 ;;
    "resource update") [ -f "$T/update_wirkungslos" ] || { local a=$4; echo "§{a#*=}" >"$T/param_§{3}_§{a%%=*}"; }; return 0 ;;
    "resource enable") rm -f "$T/meta_§{3}_target-role"; return 0 ;;
    "resource delete") rm -f "$T/res_$3" "$T/param_§{3}_"* "$T/meta_§{3}_"*; return 0 ;;
    "constraint colocation") touch "$T/kolo"; return 0 ;;
    "constraint order") touch "$T/ordn"; return 0 ;;
  esac
  echo "pcs-Stub kennt '$*' nicht" >&2; return 99
}
cibadmin() { echo '<constraints>'; [ ! -f "$T/kolo" ] || echo '<rsc_colocation id="c" rsc="ag_vip" with-rsc="ag_cluster-clone" with-rsc-role="Promoted" score="INFINITY"/>'; [ ! -f "$T/ordn" ] || echo '<rsc_order id="o" first="ag_cluster-clone" first-action="promote" then="ag_vip" then-action="start"/>'; echo '</constraints>'; }
crm_mon() {
  local p; p=$(cat "$T/promoted" 2>/dev/null || cat "$T/name")
  echo '<pacemaker-result><summary><current_dc present="true" with_quorum="true"/><resources_configured number="0"/><cluster_options stonith-enabled="true"/></summary><nodes>'
  echo '<node name="sqllnx01" online="true" type="member"/><node name="sqllnx02" online="true" type="member"/><node name="sqllnxcfg" online="true" type="member"/></nodes><resources>'
  [ ! -f "$T/res_ag_cluster" ] || echo "<clone id=\"ag_cluster-clone\"><resource id=\"ag_cluster\" role=\"Promoted\" active=\"true\"><node name=\"$p\"/></resource></clone>"
  if [ -f "$T/res_ag_vip" ] && [ ! -f "$T/meta_ag_vip_target-role" ]; then echo "<resource id=\"ag_vip\" role=\"Started\" active=\"true\"><node name=\"$p\"/></resource>"; fi
  echo '</resources></pacemaker-result>'
}
`.replaceAll('§{', '${');

interface AgLauf { rc: number; ergebnis?: Record<string, unknown>; aus: string; log: string; sqllog: string[] }
const shQTest = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Läufe nacheinander in EINEM Verzeichnis; `zwischen[i]` vor Lauf i (Shell, $T gesetzt); `ende` liest Dateien nach dem letzten Lauf */
async function agLaeufe(texte: string[], eingabe: Record<string, string>, zwischen: string[] = [], ende = ''): Promise<{ laeufe: AgLauf[]; ende: string }> {
  const teile = texte.map((t, i) => {
    const text = t.replace('# ALFRED-ABLAUF', () => `${AG_STUBS}\n# ALFRED-ABLAUF`);
    return `${zwischen[i] ?? ''}\n( ${text}\n) >"$T/aus${i}" 2>&1; echo "RC${i}=$?" >>"$T/rc"; mv "$T/log" "$T/log${i}" 2>/dev/null || : >"$T/log${i}"; mv "$T/sqllog" "$T/sqllog${i}" 2>/dev/null || : >"$T/sqllog${i}"`;
  });
  const huelle = [
    'T=$(mktemp -d)', `PY=$(command -v ${PYTHON})`, 'mkdir -p "$T/sql" "$T/secrets"; echo sqllnx01 >"$T/name"', `ALFRED_EINGABE=${shQTest(JSON.stringify(eingabe))}`, ...teile,
    'cat "$T/rc"',
    ...texte.map((_, i) => `echo "---AUS${i}"; cat "$T/aus${i}"; echo "---LOG${i}"; cat "$T/log${i}"; echo "---SQL${i}"; cat "$T/sqllog${i}"`),
    `echo ---ENDE; ${ende || ':'}; echo ---SCHLUSS`, 'rm -rf "$T"',
  ].join('\n');
  const r = await new Promise<{ stdout: string }>((ok, fehler) => {
    const k = spawn('bash', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    k.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    k.stderr.resume();
    k.on('error', fehler);
    k.on('close', () => ok({ stdout }));
    k.stdin.end(huelle);
  });
  const o = r.stdout;
  const zw = (a: string, b: string) => o.split(`${a}\n`)[1]?.split(`${b}\n`)[0] ?? '';
  const laeufe = texte.map((_, i) => {
    const aus = zw(`---AUS${i}`, `---LOG${i}`);
    const sql = zw(`---SQL${i}`, i + 1 < texte.length ? `---AUS${i + 1}` : '---ENDE');
    return { rc: Number(new RegExp(`RC${i}=(\\d+)`).exec(o)?.[1] ?? -1), ergebnis: haErgebnis(aus), aus, log: zw(`---LOG${i}`, `---SQL${i}`), sqllog: sql.split('\n').filter(Boolean) };
  });
  return { laeufe, ende: zw('---ENDE', '---SCHLUSS') };
}
const sqlStub = (werte: Record<string, string>) => Object.entries(werte).map(([k, v]) => `printf '%s\\n' ${shQTest(v)} >"$T/sql/${k}"`).join('\n');
const GEHEIM = { sa: 'Sa-Wert-1111', hauptschluessel: 'Mk-Wert-2222', pacemaker: 'Pm-Wert-3333' };
const FP1 = 'A'.repeat(40);
const EP_NEU = sqlStub({ ep_pruefen: 'ALFRED|ok', ep_masterkey: 'ALFRED|1', ep_login: 'ALFRED|1| pacemaker-login pacemaker-view-server-state', ep_endpunkt: 'ALFRED| zertifikat endpunkt', ep_selbst: `ALFRED|${FP1}|${DER('A1')}` });
const EP_SCHON = sqlStub({ ep_masterkey: 'ALFRED|0', ep_login: 'ALFRED|0|', ep_endpunkt: 'ALFRED|' });
const AB_NEU = sqlStub({ ab_pruefen: 'ALFRED|ok', ab_dbs: 'ALFRED| db-alfredpruef', ab_sync: 'ALFRED|1|alfredpruef=SYNCHRONIZED',
  ab_selbst: 'ALFRED|EXTERNAL|0|PRIMARY|PRIMARY|SECONDARY|CONNECTED|CONFIGURATION_ONLY|1|alfredpruef=SYNCHRONIZED' });

describe.skipIf(!BASH || !PYTHON)('I8e Paket 2 Task 5 — AG-Bausteine ausgeführt (nachgebildetes sqlcmd/pcs)', { timeout: 180_000 }, () => {
  it('Endpunkt: ohne gültigen Fencing-Beleg (oder nicht prüfbar, oder falscher Rechner) Abbruch VOR jeder SQL-Zeile', async () => {
    const w = await agLaeufe([haAgEndpunktSkript(AG_EP()), haAgEndpunktSkript(AG_EP()), haAgEndpunktSkript(AG_EP())], GEHEIM,
      [`${EP_NEU}\necho 'kein Fencing-Beleg' >"$T/fencing_grund"`, 'rm -f "$T/fencing_grund"; touch "$T/fpy_kaputt"', 'rm -f "$T/fpy_kaputt"; echo sqllnx02 >"$T/name"'], 'ls "$T/secrets"');
    const [a, b, c] = w.laeufe as [AgLauf, AgLauf, AgLauf];
    expect(a.rc).toBe(1);
    expect(a.ergebnis).toMatchObject({ zustand: 'fehler' });
    expect(String(a.ergebnis!.fehler)).toContain('Fencing auf sqllnx01 nicht belegt: kein Fencing-Beleg');
    expect(String(a.ergebnis!.fehler)).toContain('keine SQL-Zeile ausgeführt');
    expect(String(b.ergebnis!.fehler)).toContain('Fencing-Beleg auf sqllnx01 nicht prüfbar');
    expect(String(c.ergebnis!.fehler)).toContain('Zugang zeigt auf sqllnx02, erwartet sqllnx01');
    for (const l of [a, b, c]) { expect(l.sqllog).toEqual([]); expect(l.aus).not.toMatch(/ALFRED-(MASTERKEY|PACEMAKER)-GESETZT/); }
    expect(w.ende.trim()).toBe('');
  });

  it('Endpunkt: erster Lauf legt an (Marken, Zugangsdatei mit Login + Kennwort, öffentliches Zertifikat im Ergebnis); zweiter Lauf „schon“', async () => {
    const ep = haAgEndpunktSkript(AG_EP());
    const w = await agLaeufe([ep, ep], GEHEIM, [EP_NEU, EP_SCHON], 'cat "$T/secrets/passwd"; echo "---TSQL"; cat "$T/tsql_ep_masterkey" "$T/tsql_ep_login"');
    const [a, b] = w.laeufe as [AgLauf, AgLauf];
    expect(a.rc, a.aus).toBe(0);
    expect(a.sqllog).toEqual(['bereit', 'ep_pruefen', 'ep_masterkey', 'ep_login', 'ep_endpunkt', 'ep_selbst']);
    expect(a.aus).toContain('ALFRED-MASTERKEY-GESETZT');
    expect(a.aus).toContain('ALFRED-PACEMAKER-GESETZT');
    expect(a.ergebnis).toEqual({ zustand: 'geaendert', knoten: 'sqllnx01', rolle: 'primaer', endpunkt: 'TCP://10.203.30.10:5022', fingerabdruck: FP1, zertifikat: DER('A1'),
      aenderungen: ['masterkey', 'pacemaker-login', 'pacemaker-view-server-state', 'zertifikat', 'endpunkt', 'pacemaker-zugangsdatei'] });
    const [datei, tsql] = w.ende.split('---TSQL\n') as [string, string];
    expect(datei).toBe('alfred_pacemaker\nPm-Wert-3333\n');
    // Kennwörter nur im T-SQL über stdin an sqlcmd (hier: der Stub), nie in der Ausgabe
    expect(tsql).toContain("CREATE MASTER KEY ENCRYPTION BY PASSWORD = N'Mk-Wert-2222'");
    expect(tsql).toContain("CREATE LOGIN [alfred_pacemaker] WITH PASSWORD = N'Pm-Wert-3333'");
    for (const g of Object.values(GEHEIM)) expect(a.aus + b.aus).not.toContain(g);
    expect(b.rc, b.aus).toBe(0);
    expect(b.ergebnis).toMatchObject({ zustand: 'schon', aenderungen: [] });
    expect(b.aus).not.toMatch(/GESETZT/);
    ueberstehtSchwaerzung(a.aus, 'endpunkt'); ueberstehtSchwaerzung(b.aus, 'endpunkt schon');
  });

  it('Endpunkt: Zugangsdatei mit falschen Rechten fällt in der Selbstprüfung auf; SQL-Fehler geschwärzt und sichtbar', async () => {
    const ep = haAgEndpunktSkript(AG_EP());
    const w = await agLaeufe([ep, ep], GEHEIM, [`${EP_SCHON}\n${sqlStub({ ep_pruefen: 'ALFRED|ok', ep_selbst: `ALFRED|${FP1}|${DER('A1')}` })}\nprintf 'alfred_pacemaker\\nPm-Wert-3333\\n' >"$T/secrets/passwd"; echo '0 644' >"$T/rechte"`,
      `rm -f "$T/rechte"; printf 'Msg 50107, Level 16\\nLogin alfred_pacemaker mit Pm-Wert-3333 abgelehnt\\n' >"$T/sqlfehler_ep_pruefen"`]);
    const [a, b] = w.laeufe as [AgLauf, AgLauf];
    // die (gestubbten) Rechte bleiben 0644 → die Datei wird ersetzt, die Selbstprüfung liest weiter 0644 → Abbruch statt „ok“
    expect(a.ergebnis!.zustand).toBe('fehler');
    expect(String(a.ergebnis!.fehler)).toContain('Zugangsdatei');
    expect(b.rc).toBe(1);
    expect(String(b.ergebnis!.fehler)).toContain('Login alfred_pacemaker mit [geschwärzt] abgelehnt');
    expect(b.aus).not.toContain('Pm-Wert-3333');
  });

  it('Abschluss: Datenbank aufnehmen, Seeding abwarten, ag_cluster (required_sync 0, promotable), VIP deaktiviert → Constraints → aktivieren; zweiter Lauf „schon“ ohne pcs-Änderung', async () => {
    const ab = haAgAbschlussSkript(AG_AB);
    const w = await agLaeufe([ab, ab], { sa: GEHEIM.sa }, [AB_NEU, sqlStub({ ab_dbs: 'ALFRED|' })]);
    const [a, b] = w.laeufe as [AgLauf, AgLauf];
    expect(a.rc, a.aus).toBe(0);
    expect(a.log.split('\n').filter(Boolean)).toEqual([
      'pcs resource create ag_cluster ocf:mssql:ag ag_name=sqllnxag01 required_synchronized_secondaries_to_commit=0 meta failure-timeout=60s promotable notify=true',
      'pcs resource create ag_vip ocf:heartbeat:IPaddr2 ip=10.203.30.13 cidr_netmask=27 op monitor interval=30s --disabled',
      'pcs constraint colocation add ag_vip with Promoted ag_cluster-clone INFINITY',
      'pcs constraint order promote ag_cluster-clone then start ag_vip',
      'pcs resource enable ag_vip',
    ]);
    expect(a.ergebnis).toEqual({ zustand: 'geaendert', ag: 'sqllnxag01', primaer: 'sqllnx01', sekundaer: 'sqllnx02', konfig: 'sqllnxcfg', clusterTyp: 'EXTERNAL', requiredSyncSql: 0, requiredSyncRessource: '0',
      sicherungVorgabe: 'PRIMARY', datenbanken: [{ name: 'alfredpruef', zustand: 'SYNCHRONIZED' }], vip: '10.203.30.13/27', vipAuf: 'sqllnx01', promotedAuf: 'sqllnx01',
      aenderungen: ['db-alfredpruef', 'ressource-ag', 'ressource-vip', 'kolokation', 'reihenfolge', 'vip-aktiviert'] });
    expect(b.rc, b.aus).toBe(0);
    expect(b.ergebnis).toMatchObject({ zustand: 'schon', aenderungen: [] });
    expect(b.log).toBe('');
    ueberstehtSchwaerzung(a.aus, 'abschluss');
  });

  it('Abschluss: Ressource mit required_sync ≠ 0 → sichtbar auf 0 gesetzt; wirkt das nicht oder meldet SQL ≠ 0 → Selbstprüfung bricht ab; Seeding bleibt aus → Abbruch vor Pacemaker', async () => {
    const ab = haAgAbschlussSkript(AG_AB);
    const w = await agLaeufe([ab, ab, ab, ab], { sa: GEHEIM.sa }, [
      AB_NEU,
      `${sqlStub({ ab_dbs: 'ALFRED|' })}\necho 1 >"$T/param_ag_cluster_required_synchronized_secondaries_to_commit"`,
      `echo 2 >"$T/param_ag_cluster_required_synchronized_secondaries_to_commit"; touch "$T/update_wirkungslos"`,
      `rm -f "$T/update_wirkungslos"; ${sqlStub({ ab_selbst: 'ALFRED|EXTERNAL|1|PRIMARY|PRIMARY|SECONDARY|CONNECTED|CONFIGURATION_ONLY|1|alfredpruef=SYNCHRONIZED' })}`,
    ]);
    const [, b, c, d] = w.laeufe as [AgLauf, AgLauf, AgLauf, AgLauf];
    expect(b.ergebnis).toMatchObject({ zustand: 'geaendert', aenderungen: ['ressource-required-sync-0'], requiredSyncRessource: '0' });
    expect(b.log).toContain('pcs resource update ag_cluster required_synchronized_secondaries_to_commit=0');
    expect(c.ergebnis!.zustand).toBe('fehler');
    expect(String(c.ergebnis!.fehler)).toContain("Selbstprüfung: required_synchronized_secondaries_to_commit an der Ressource ag_cluster ist '2', erwartet 0");
    expect(String(d.ergebnis!.fehler)).toContain('Selbstprüfung: REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT in SQL ist 1, erwartet 0');
    const s = await agLaeufe([ab], { sa: GEHEIM.sa }, [`${AB_NEU}\n${sqlStub({ ab_sync: 'ALFRED|0|alfredpruef=NOT SYNCHRONIZING' })}`]);
    expect(String(s.laeufe[0]!.ergebnis!.fehler)).toContain('nicht SYNCHRONIZED');
    expect(s.laeufe[0]!.log).toBe('');
  });

  it('Entfernen (Primär): Ressourcen weg, dann AG/Endpunkte; Zugangsdatei entfernt; Datenbanken bleiben; nicht Primär mit Ressourcen → Abbruch ohne Änderung', async () => {
    const en = haAgEntfernenSkript(AG_EN());
    const vorher = `touch "$T/res_ag_cluster" "$T/res_ag_vip"; printf 'x\\n' >"$T/secrets/passwd"; ${sqlStub({ en_lage: 'ALFRED|PRIMARY|alfredpruef', en_drop: 'ALFRED| ag-entfernt',
      en_aufraeumen: 'ALFRED| endpunkt-entfernt zertifikat-entfernt pacemaker-login-entfernt', en_selbst: 'ALFRED|0|alfredpruef=ONLINE' })}`;
    const w = await agLaeufe([en, en], { sa: GEHEIM.sa }, [vorher, `cp "$T/tsql_en_drop" "$T/drop_a"; ${sqlStub({ en_lage: 'ALFRED|-|-', en_waisen: 'ALFRED|-', en_drop: 'ALFRED|', en_aufraeumen: 'ALFRED|', en_selbst: 'ALFRED|0|-' })}`], 'ls "$T/secrets"; cat "$T/drop_a"');
    const [a, b] = w.laeufe as [AgLauf, AgLauf];
    expect(a.rc, a.aus).toBe(0);
    expect(a.log.split('\n').filter(Boolean)).toEqual(['pcs resource delete ag_vip', 'pcs resource delete ag_cluster']);
    expect(a.sqllog).toEqual(['bereit', 'en_lage', 'en_drop', 'en_aufraeumen', 'en_selbst']);
    expect(a.ergebnis).toMatchObject({ zustand: 'geaendert', knoten: 'sqllnx01', datenbanken: [{ name: 'alfredpruef', zustand: 'ONLINE' }],
      aenderungen: ['ressource-vip-entfernt', 'ressource-ag-entfernt', 'ag-entfernt', 'endpunkt-entfernt', 'zertifikat-entfernt', 'pacemaker-login-entfernt', 'pacemaker-zugangsdatei-entfernt'] });
    expect(b.ergebnis).toMatchObject({ zustand: 'schon', aenderungen: [], datenbanken: [] });
    expect(w.ende).toContain("IF 'PRIMARY' = 'PRIMARY'"); // Rolle vor dem Entfernen der Ressourcen bestimmt die Wiederherstellung
    expect(w.ende).not.toContain('passwd');
    const n = await agLaeufe([en], { sa: GEHEIM.sa }, [`touch "$T/res_ag_cluster"; ${sqlStub({ en_lage: 'ALFRED|SECONDARY|alfredpruef' })}`]);
    expect(String(n.laeufe[0]!.ergebnis!.fehler)).toContain('sqllnx01 ist nicht Primär von sqllnxag01 (SECONDARY)');
    expect(n.laeufe[0]!.log).toBe('');
    // Primär: eine Datenbank bleibt nach DROP nicht ONLINE → sichtbarer Abbruch (nicht still)
    const r = await agLaeufe([en], { sa: GEHEIM.sa }, [sqlStub({ en_lage: 'ALFRED|PRIMARY|alfredpruef', en_drop: 'ALFRED| ag-entfernt', en_aufraeumen: 'ALFRED|', en_selbst: 'ALFRED|0|alfredpruef=RESTORING' })]);
    expect(String(r.laeufe[0]!.ergebnis!.fehler)).toContain('alfredpruef=RESTORING');
  });
});

// ── Task 5 Fix-Runde 1: abgebrochene T-SQL-Blöcke, wiederholtes Entfernen, sqlcmd nur in den AG-Bausteinen ─────────────────────────
describe('I8e Paket 2 Task 5 Fix-Runde 1 — Text', () => {
  it('I2: jede Änderung in einem ändernden T-SQL-Block meldet sich per PRINT ALFRED-ERLEDIGT; JOIN und GRANT getrennt', () => {
    const un = (t: string) => t.replaceAll(`'\\''`, "'");
    for (const t of AG_SKRIPTE().map(un)) {
      const sets = [...t.matchAll(/SET @a \+= '[^']*';/g)].length;
      expect(sets).toBeGreaterThan(0);
      expect([...t.matchAll(/PRINT 'ALFRED-ERLEDIGT /g)].length).toBeGreaterThanOrEqual(sets);
    }
    const sek = un(haAgReplikatSkript(AG_RP('sqllnx02')));
    expect(sek).toContain("JOIN WITH (CLUSTER_TYPE = EXTERNAL)'); END TRY BEGIN CATCH THROW; END CATCH; PRINT 'ALFRED-ERLEDIGT beigetreten'; BEGIN TRY EXEC (N'ALTER AVAILABILITY GROUP [sqllnxag01] GRANT CREATE ANY DATABASE'); END TRY BEGIN CATCH THROW; END CATCH; PRINT 'ALFRED-ERLEDIGT seeding-erlaubt';");
    const en = un(haAgEntfernenSkript(AG_EN()));
    expect(en).toContain("BEGIN TRY EXEC (N'DROP AVAILABILITY GROUP [sqllnxag01]'); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' ag-entfernt'; PRINT 'ALFRED-ERLEDIGT ag-entfernt';");
    expect(en).toContain("PRINT 'ALFRED-ERLEDIGT db-online-' + CAST(@n AS varchar(128));");
  });
  it('I4: sqlcmd steht nicht mehr in HA_BEFEHLE (ha_vorbereiten prüft es nicht), sondern in HA_AG_BEFEHLE der AG-Bausteine', () => {
    expect(HA_BEFEHLE).not.toContain('/opt/mssql-tools18/bin/sqlcmd');
    expect(HA_AG_BEFEHLE).toEqual(['/opt/mssql-tools18/bin/sqlcmd']);
    expect(haVorbereitenSkript(P)).not.toContain('sqlcmd');
    for (const t of AG_SKRIPTE()) expect(t).toContain("AG_BEFEHLE=('/opt/mssql-tools18/bin/sqlcmd')");
  });
});

describe.skipIf(!BASH || !PYTHON)('I8e Paket 2 Task 5 Fix-Runde 1 — ausgeführt', { timeout: 180_000 }, () => {
  it('I4: sqlcmd fehlt → Abbruch vor jeder SQL-Zeile mit Hinweis auf linux_sql installieren', async () => {
    const w = await agLaeufe([haAgEndpunktSkript(AG_EP()), haAgAbschlussSkript(AG_AB)], GEHEIM, ['touch "$T/fehlt_sqlcmd"']);
    for (const l of w.laeufe) {
      expect(l.rc).toBe(1);
      expect(String(l.ergebnis!.fehler)).toContain('/opt/mssql-tools18/bin/sqlcmd fehlt auf sqllnx01 — vorher linux_sql installieren (mssql-tools18); keine SQL-Zeile ausgeführt');
      expect(l.sqllog).toEqual([]);
    }
  });

  it('I2: Block bricht nach wirksamen Anweisungen ab → genau diese stehen im Fehler (nie „nichts geändert“), neue Kennwörter melden ihre Marke', async () => {
    const fehler = (schritt: string, zeilen: string[]) => `printf '%s\\n' ${zeilen.map(shQTest).join(' ')} >"$T/sqlfehler_${schritt}"`;
    const rp = await agLaeufe([haAgReplikatSkript(AG_RP())], { sa: GEHEIM.sa }, [
      `${sqlStub({ rp_pruefen: 'ALFRED|ok' })}\n${fehler('rp_aendern', ['ALFRED-ERLEDIGT login-sqllnx02', 'ALFRED-ERLEDIGT benutzer-sqllnx02', 'Msg 15151, Level 16', 'Cannot grant CONNECT'])}`]);
    const f = String(rp.laeufe[0]!.ergebnis!.fehler);
    expect(f).toContain('Replikat (primaer) auf sqllnx01: Msg 15151, Level 16 Cannot grant CONNECT');
    expect(f).toContain('bisher geändert: login-sqllnx02,benutzer-sqllnx02');
    expect(f).toContain('am ersten Fehler beendet — die vorher als erledigt gemeldeten Änderungen bleiben wirksam (keine Transaktion), danach lief nichts mehr');
    expect(f).not.toContain('ALFRED-ERLEDIGT');
    expect(f).not.toContain('nichts geändert');
    // en_drop: DROP AG wirksam, RESTORE scheitert
    const en = await agLaeufe([haAgEntfernenSkript(AG_EN())], { sa: GEHEIM.sa }, [
      `${sqlStub({ en_lage: 'ALFRED|PRIMARY|alfredpruef' })}\n${fehler('en_drop', ['ALFRED-ERLEDIGT ag-entfernt', 'Msg 3101, Level 16', 'Exclusive access could not be obtained'])}`]);
    const e = String(en.laeufe[0]!.ergebnis!.fehler);
    expect(e).toContain('bisher geändert: ag-entfernt');
    expect(e).not.toContain('nichts geändert');
    // auch ohne gemeldete Anweisung: „bisher keine Änderung gemeldet“ + Hinweis, nie „nichts geändert“
    const leer = await agLaeufe([haAgAbschlussSkript(AG_AB)], { sa: GEHEIM.sa }, [`${AB_NEU}\n${fehler('ab_dbs', ['Msg 1475, Level 16', 'database cannot be added'])}`]);
    const l = String(leer.laeufe[0]!.ergebnis!.fehler);
    expect(l).toContain('bisher keine Änderung gemeldet; Block „Datenbanken in sqllnxag01 aufnehmen“ am ersten Fehler beendet');
    expect(l).not.toContain('nichts geändert');
    // Endpunkt: Pacemaker-Login angelegt, GRANT scheitert → Marke trotzdem (Kennwort kommt in den Tresor)
    const ep = await agLaeufe([haAgEndpunktSkript(AG_EP())], GEHEIM, [`${EP_NEU}\n${fehler('ep_login', ['ALFRED-ERLEDIGT pacemaker-login', 'Msg 4613, Level 16', 'Grantor does not have GRANT permission'])}`]);
    expect(ep.laeufe[0]!.aus).toContain('ALFRED-PACEMAKER-GESETZT');
    expect(String(ep.laeufe[0]!.ergebnis!.fehler)).toContain('bisher geändert: masterkey,pacemaker-login');
  });

  it('I3: Entfernen bricht nach DROP ab → Wiederholung kennt Rolle und Datenbanken aus der Merkdatei, holt RESTORING zurück bzw. bricht sichtbar ab; ohne Merkdatei Rückfallnetz', async () => {
    const en = haAgEntfernenSkript(AG_EN());
    const w = await agLaeufe([en, en, en], { sa: GEHEIM.sa }, [
      `${sqlStub({ en_lage: 'ALFRED|PRIMARY|alfredpruef' })}\nprintf 'ALFRED-ERLEDIGT ag-entfernt\\nMsg 3101\\n' >"$T/sqlfehler_en_drop"`,
      // Wiederholung: AG weg (Lage „-|-“), Datenbank noch RESTORING → Abbruch mit Namen
      `rm -f "$T/sqlfehler_en_drop"; cp "$T/merk/ag-entfernen.txt" "$T/merk_a"; ${sqlStub({ en_lage: 'ALFRED|-|-', en_waisen: 'ALFRED|-', en_drop: 'ALFRED|', en_aufraeumen: 'ALFRED|', en_selbst: 'ALFRED|0|alfredpruef=RESTORING' })}`,
      // dritte: RESTORE gelang (db-online) → ok, Datenbank genannt, Merkdatei weg
      `cp "$T/tsql_en_drop" "$T/drop_b"; ${sqlStub({ en_drop: 'ALFRED| db-online-alfredpruef', en_selbst: 'ALFRED|0|alfredpruef=ONLINE' })}`,
    ], 'cat "$T/merk_a"; echo ---DROP; cat "$T/drop_b"; echo ---MERK; ls "$T/merk"');
    const [a, b, c] = w.laeufe as [AgLauf, AgLauf, AgLauf];
    expect(a.rc).toBe(1);
    expect(String(b.ergebnis!.fehler)).toContain('Datenbanken auf dem bisherigen Primär nicht alle ONLINE: alfredpruef=RESTORING');
    expect(c.rc, c.aus).toBe(0);
    expect(c.ergebnis).toMatchObject({ zustand: 'geaendert', rolleVorher: 'PRIMARY', datenbanken: [{ name: 'alfredpruef', zustand: 'ONLINE' }], aenderungen: ['db-online-alfredpruef'] });
    const [merk, rest] = w.ende.split('---DROP\n') as [string, string];
    expect(merk.trim()).toBe('PRIMARY|alfredpruef');
    expect(rest).toContain("IF 'PRIMARY' = 'PRIMARY'");
    expect(rest).toContain("WHERE s.name IN (N'alfredpruef')");
    expect(rest.split('---MERK\n')[1]!.trim()).toBe('');
    // ohne Merkdatei: RESTORING-Datenbank ohne AG auf dem Primär → Abbruch, nie still „schon“
    const o = await agLaeufe([en], { sa: GEHEIM.sa }, [sqlStub({ en_lage: 'ALFRED|-|-', en_waisen: 'ALFRED|alfredpruef', en_drop: 'ALFRED|', en_aufraeumen: 'ALFRED|', en_selbst: 'ALFRED|0|-' })]);
    expect(String(o.laeufe[0]!.ergebnis!.fehler)).toContain('Datenbanken ohne AG im Zustand RESTORING (alfredpruef)');
  });
});

// ── Task 5 Fix-Runde 2 (B): jede gemeldete Änderung steht hinter einer TRY/CATCH-THROW-geschützten Anweisung ─────────────────────────
describe('I8e Paket 2 Task 5 Fix-Runde 2 — PRINT ALFRED-ERLEDIGT nur nach geschützter Anweisung', () => {
  it('statisch: vor jedem PRINT ALFRED-ERLEDIGT steht im selben Block „END CATCH;“ (höchstens noch SET-Zuweisungen dazwischen), jedes CATCH wirft weiter', () => {
    const un = (t: string) => t.replaceAll(`'\\''`, "'");
    let gesamt = 0;
    for (const t of AG_SKRIPTE().map(un)) {
      for (const z of t.split('\n').filter(x => x.includes("PRINT 'ALFRED-ERLEDIGT"))) {
        const teile = z.split("PRINT 'ALFRED-ERLEDIGT").slice(0, -1);
        for (const vor of teile) {
          gesamt++;
          expect(vor, z).toMatch(/BEGIN TRY .+ END TRY BEGIN CATCH THROW; END CATCH;(?: SET @\w+ \+?= [^;]+;)* $/);
          // Fix-Runde 3: vor dem BEGIN TRY dieses Abschnitts steht keine ändernde Anweisung (Textliterale wie SET @sql = N'CREATE …' ausgenommen)
          const davor = vor.slice(0, vor.lastIndexOf('BEGIN TRY')).replace(/N?'(?:[^']|'')*'/g, "''");
          expect(davor, z).not.toMatch(/\b(CREATE|ALTER|GRANT|DROP|RESTORE|EXEC|DENY|REVOKE)\b/);
        }
      }
      // kein CATCH, das einen Fehler schluckt (nur THROW weiter); Prüf-CATCH der Selbstprüfung/Master-Key-Prüfung ausgenommen
      for (const m of t.matchAll(/BEGIN CATCH (.*?) END CATCH/g)) expect(m[1], m[0]).toMatch(/^(THROW;|THROW 50108, .*|SET @f \+= .*)$/);
    }
    expect(gesamt).toBeGreaterThan(40);
  });
});

// ── Task 6: Geplantes Failover (ag_failover) ─────────────────────────────────────────────────────────────────────────────────────

const FO = (ziel = 'sqllnx02', vorher = 'sqllnx01'): HaAgFailoverParameter => ({ ag: 'sqllnxag01', ziel, vorher, knoten: [...HA_KNOTEN] });
/** zusätzliche Stubs NACH denen von agLaeufe: pcs move/clear, CIB mit Standort-Bedingungen, Uhr, sqlcmd je nach Promoted-Knoten */
const FO_STUBS = String.raw`
pcs() {
  log "pcs $*"
  case "$1 $2" in
    "resource move") [ ! -f "$T/move_scheitert" ] || { echo 'Error: move kaputt'; return 1; }
      [ ! -f "$T/move_scheitert_nach" ] || { echo "$4" >"$T/promoted"; echo 'Error: cannot verify the resource will not move back'; return 1; }
      echo "$4" >"$T/cli_prefer"; [ -f "$T/move_haengt" ] || { echo "$4" >"$T/promoted"; echo 1012 >"$T/uhr"; }; return 0 ;;
    "resource clear") [ ! -f "$T/clear_scheitert" ] || { echo 'Error: clear kaputt'; return 1; }; [ -f "$T/clear_wirkungslos" ] || rm -f "$T/cli_prefer"; return 0 ;;
  esac
  echo "pcs-Stub kennt '$*' nicht" >&2; return 99
}
cibadmin() {
  [ ! -f "$T/cib_kaputt" ] || return 1
  echo '<constraints>'
  [ ! -f "$T/cli_prefer" ] || echo "<rsc_location id=\"cli-prefer-ag_cluster-clone\" rsc=\"ag_cluster-clone\" role=\"Promoted\" node=\"$(cat "$T/cli_prefer")\" score=\"INFINITY\"/>"
  [ ! -f "$T/fremd" ] || echo '<rsc_location id="loc-handarbeit" rsc="ag_vip" node="sqllnx01" score="100"/>'
  echo '<rsc_colocation id="c" rsc="ag_vip" with-rsc="ag_cluster-clone" with-rsc-role="Promoted" score="INFINITY"/></constraints>'
}
jetzt() { cat "$T/uhr" 2>/dev/null || echo 1000; }
sql() {
  local t; t=$(grep -o 'ALFRED-SCHRITT [a-z_]*' <<<"$1" | head -n 1 | cut -d' ' -f2)
  echo "§{t:-bereit}" >>"$T/sqllog"
  [ -n "$t" ] || return 0
  if [ -f "$T/sqlfehler_$t" ]; then cat "$T/sqlfehler_$t"; return 1; fi
  if [ "$(cat "$T/promoted" 2>/dev/null)" = "$(cat "$T/name")" ] && [ -f "$T/sql/§{t}_primaer" ]; then cat "$T/sql/§{t}_primaer"; return 0; fi
  [ -f "$T/sql/$t" ] || { echo "kein SQL-Stub $t"; return 1; }
  cat "$T/sql/$t"
}
`.replaceAll('§{', '${');
const mitFo = (t: string, extra = '') => t.replace('# ALFRED-ABLAUF', () => `# ALFRED-ABLAUF\n${FO_STUBS}\n${extra}`);
const FO_SEK = 'ALFRED|SECONDARY|0|1|1|CONNECTED|-|-|0|alfredpruef=SYNCHRONIZED|-';
const FO_PRIM = 'ALFRED|PRIMARY|0|1|1|CONNECTED|SECONDARY|CONNECTED|1|alfredpruef=SYNCHRONIZED|alfredpruef=SYNCHRONIZED';
/** Ausgangslage: Lauf auf sqllnx02 (Ziel), Promoted auf sqllnx01, Ressourcen da, required_sync 0 an der Ressource */
const FO_VOR = (sql: Record<string, string> = {}) => [
  'echo sqllnx02 >"$T/name"; echo sqllnx01 >"$T/promoted"; touch "$T/res_ag_cluster" "$T/res_ag_vip"',
  'echo sqllnxag01 >"$T/param_ag_cluster_ag_name"; echo 0 >"$T/param_ag_cluster_required_synchronized_secondaries_to_commit"',
  'echo 10.203.30.13 >"$T/param_ag_vip_ip"; echo 27 >"$T/param_ag_vip_cidr_netmask"',
  sqlStub({ fo_lage: FO_SEK, fo_lage_primaer: FO_PRIM, ...sql }),
].join('\n');

describe('I8e Paket 2 Task 6 — ag_failover (Text, Validatoren)', () => {
  it('registriert; Validator: Ziel und bisheriger Primär verschiedene Datenreplikate (nie sqllnxcfg), AG-Name geprüft', () => {
    expect(linuxBausteinSkript(LINUX_HA_BAUSTEINE.agFailover, FO())).toBe(haAgFailoverSkript(FO()));
    expect(pruefeHaAgFailover(FO())).toBeUndefined();
    expect(pruefeHaAgFailover(FO('sqllnx01', 'sqllnx02'))).toBeUndefined();
    expect(pruefeHaAgFailover(FO('sqllnxcfg', 'sqllnx01'))).toContain('CONFIGURATION_ONLY');
    expect(pruefeHaAgFailover(FO('sqllnx01', 'sqllnxcfg'))).toContain('CONFIGURATION_ONLY');
    expect(pruefeHaAgFailover(FO('sqllnx02', 'sqllnx02'))).toContain('verschieden');
    expect(pruefeHaAgFailover(FO('sqllnx09', 'sqllnx01'))).toContain('ziel');
    expect(pruefeHaAgFailover({ ...FO(), ag: "x'; --" })).toContain('ag:');
  });
  it('Text: pcs resource move <Klon> <Ziel> --promoted, danach pcs resource clear; required_sync an beiden Stellen geprüft; nur sa über stdin', () => {
    const s = haAgFailoverSkript(FO());
    expect(s).toContain('pcs resource move "$AG_KLON" "$ICH" --promoted');
    expect(s).toContain('pcs resource clear "$AG_KLON"');
    expect(s).toContain("AG_KLON='ag_cluster-clone'");
    expect(s).toContain('required_synchronized_secondaries_to_commit');
    expect(s).toContain('REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT in SQL');
    expect(s).toContain('geheim_lesen sa SA');
    expect(s).not.toMatch(/geheim_lesen (hauptschluessel|pacemaker)/);
  });
  it.skipIf(!BASH)('bash -n', () => {
    for (const p of [FO(), FO('sqllnx01', 'sqllnx02')]) { const r = spawnSync('bash', ['-n'], { input: haAgFailoverSkript(p), encoding: 'utf8' }); expect(r.status, r.stderr).toBe(0); }
  });
  it.skipIf(!PYTHON)('PY_AG_PCS standort: cli-prefer/cli-ban gezählt, fremde Standort-Bedingungen getrennt, andere Ressourcen ignoriert', () => {
    const py = (input: string) => spawnSync(PYTHON!, ['-c', PY_AG_PCS, 'standort', 'ag_cluster', 'ag_cluster-clone', 'ag_vip'], { input, encoding: 'utf8' });
    const cib = '<constraints><rsc_location id="cli-prefer-ag_cluster-clone" rsc="ag_cluster-clone" role="Promoted" node="sqllnx02" score="INFINITY"/>'
      + '<rsc_location id="cli-ban-ag_cluster-clone-on-sqllnx01" rsc="ag_cluster-clone" node="sqllnx01" score="-INFINITY"/><rsc_location id="loc-x" rsc="ag_vip" node="sqllnx01" score="100"/>'
      + '<rsc_location id="loc-anders" rsc="anderes" node="sqllnx01" score="100"/></constraints>';
    expect(py(cib).stdout.trim()).toBe('2 1 cli-prefer-ag_cluster-clone@sqllnx02,cli-ban-ag_cluster-clone-on-sqllnx01@sqllnx01,loc-x@sqllnx01');
    expect(py('<constraints/>').stdout.trim()).toBe('0 0 -');
    expect(py('kaputt').status).toBe(2);
  });
  it('Ergebnisfelder ohne Geheimnis-Namen', () => {
    const namen = new Set<string>();
    for (const m of haAgFailoverSkript(FO()).matchAll(/\\?"([A-Za-z_][A-Za-z0-9_]*)\\?"\s*:/g)) namen.add(m[1]!);
    for (const n of ['zustand', 'primaer', 'vorher', 'dauerS', 'vipAuf', 'requiredSyncSql', 'requiredSyncRessource', 'standortBedingungen']) expect(namen).toContain(n);
    expect([...namen].filter(n => GEHEIM_NAME.test(n))).toEqual([]);
  });
});

describe.skipIf(!BASH || !PYTHON)('I8e Paket 2 Task 6 — ag_failover ausgeführt (nachgebildetes sqlcmd/pcs)', { timeout: 180_000 }, () => {
  const fo = mitFo(haAgFailoverSkript(FO()));

  it('Abbruchzweige vor jeder Änderung: Ziel nicht SYNCHRONIZED, required_sync ≠ 0 (SQL/Ressource), Cluster nicht 3/3, Primär woanders, Ziel nicht SECONDARY, fremde Standort-Bedingung, CIB unlesbar', async () => {
    const faelle: Array<[string, string, string?]> = [
      [FO_VOR({ fo_lage: 'ALFRED|SECONDARY|0|1|0|CONNECTED|-|-|0|alfredpruef=SYNCHRONIZING|-' }), 'nicht SYNCHRONIZED (0/1: alfredpruef=SYNCHRONIZING)'],
      [FO_VOR({ fo_lage: 'ALFRED|SECONDARY|1|1|1|CONNECTED|-|-|0|alfredpruef=SYNCHRONIZED|-' }), 'REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT in SQL ist 1, erwartet 0'],
      [`${FO_VOR()}\necho 1 >"$T/param_ag_cluster_required_synchronized_secondaries_to_commit"`, "required_synchronized_secondaries_to_commit an ag_cluster ist '1', erwartet 0"],
      [`${FO_VOR()}\necho sqllnxcfg >"$T/promoted"`, "Promoted auf 'sqllnxcfg', erwartet sqllnx01"],
      [FO_VOR({ fo_lage: 'ALFRED|RESOLVING|0|1|1|DISCONNECTED|-|-|0|alfredpruef=SYNCHRONIZED|-' }), 'sqllnx02 ist RESOLVING/DISCONNECTED, erwartet SECONDARY/CONNECTED'],
      [`${FO_VOR()}\ntouch "$T/fremd"`, 'fremde Standort-Bedingungen an ag_cluster-clone/ag_vip (loc-handarbeit@sqllnx01)'],
      [`${FO_VOR()}\ntouch "$T/cib_kaputt"`, 'Standort-Bedingungen (CIB) nicht lesbar'],
      [`${FO_VOR()}\nrm -f "$T/res_ag_cluster"`, 'Pacemaker-Ressource ag_cluster fehlt'],
      [FO_VOR(), 'Cluster: 2/3 online', 'cluster_lage() { LO=2; LQ=1; }'],
    ];
    for (const [vor, grund, extra] of faelle) {
      const w = await agLaeufe([extra ? mitFo(haAgFailoverSkript(FO()), extra) : fo], { sa: GEHEIM.sa }, [vor]);
      const l = w.laeufe[0]!;
      expect(l.rc, grund).toBe(1);
      expect(String(l.ergebnis!.fehler), grund).toContain(grund);
      expect(String(l.ergebnis!.fehler), grund).toContain('nichts geändert');
      expect(l.log, grund).toBe(''); // kein pcs-Aufruf
    }
  });

  it('Failover: move → Primär = Ziel → clear; Ergebnis mit Dauer, neuem Primär, VIP-Ort; zweiter Lauf „schon“ ohne pcs', async () => {
    const w = await agLaeufe([fo, fo], { sa: GEHEIM.sa }, [FO_VOR()]);
    const [a, b] = w.laeufe as [AgLauf, AgLauf];
    expect(a.rc, a.aus).toBe(0);
    expect(a.log.split('\n').filter(Boolean)).toEqual(['pcs resource move ag_cluster-clone sqllnx02 --promoted', 'pcs resource clear ag_cluster-clone']);
    expect(a.ergebnis).toEqual({ zustand: 'geaendert', ag: 'sqllnxag01', primaer: 'sqllnx02', vorher: 'sqllnx01', dauerS: 12, vip: '10.203.30.13/27', vipAuf: 'sqllnx02', promotedAuf: 'sqllnx02',
      requiredSyncSql: 0, requiredSyncRessource: '0', altRolle: 'SECONDARY', datenbanken: [{ name: 'alfredpruef', zustand: 'SYNCHRONIZED' }], standortBedingungen: 0,
      aenderungen: ['failover-angestossen', 'standort-bedingung-entfernt'] });
    expect(b.rc, b.aus).toBe(0);
    expect(b.ergebnis).toMatchObject({ zustand: 'schon', primaer: 'sqllnx02', vorher: 'sqllnx02', dauerS: 0, aenderungen: [], standortBedingungen: 0 });
    expect(b.log).toBe('');
    ueberstehtSchwaerzung(a.aus, 'failover'); ueberstehtSchwaerzung(b.aus, 'failover schon');
    expect(a.aus + b.aus).not.toContain(GEHEIM.sa);
  });

  it('clear auch bei Zeitüberschreitung und bei gescheitertem move — die Meldung sagt es; scheitert clear, steht die verbliebene Bedingung im Fehler', async () => {
    const w = await agLaeufe([fo], { sa: GEHEIM.sa }, [`${FO_VOR()}\ntouch "$T/move_haengt"`], 'ls "$T"');
    const a = w.laeufe[0]!;
    expect(a.rc).toBe(1);
    expect(a.log.split('\n').filter(Boolean)).toEqual(['pcs resource move ag_cluster-clone sqllnx02 --promoted', 'pcs resource clear ag_cluster-clone']);
    const f = String(a.ergebnis!.fehler);
    expect(f).toContain('Zeitüberschreitung');
    expect(f).toContain("Promoted auf 'sqllnx01'");
    expect(f).toContain('Standort-Bedingung mit pcs resource clear ag_cluster-clone entfernt');
    expect(f).toContain('bisher geändert: failover-angestossen,standort-bedingung-entfernt');
    expect(w.ende).not.toContain('cli_prefer');
    const m = await agLaeufe([fo], { sa: GEHEIM.sa }, [`${FO_VOR()}\ntouch "$T/move_scheitert"`]);
    expect(m.laeufe[0]!.log.split('\n').filter(Boolean)).toEqual(['pcs resource move ag_cluster-clone sqllnx02 --promoted', 'pcs resource clear ag_cluster-clone']);
    expect(String(m.laeufe[0]!.ergebnis!.fehler)).toContain('pcs resource move ag_cluster-clone sqllnx02 --promoted fehlgeschlagen: Error: move kaputt');
    expect(String(m.laeufe[0]!.ergebnis!.fehler)).toContain('pcs resource clear ag_cluster-clone ausgeführt');
    // Fix-Runde 1 (I1): nachgelesen ohne Wirkung (Promoted weiter auf sqllnx01, keine Bedingung entstanden) → nichts geändert
    expect(String(m.laeufe[0]!.ergebnis!.fehler)).toContain('ohne Wirkung (Promoted weiter auf sqllnx01, keine Standort-Bedingung entstanden)');
    expect(String(m.laeufe[0]!.ergebnis!.fehler)).toMatch(/nichts geändert$/);
    // move scheitert NACH dem Verschieben (pcs 0.11): Primärwechsel wird als Änderung gemeldet
    const n = await agLaeufe([fo], { sa: GEHEIM.sa }, [`${FO_VOR()}\ntouch "$T/move_scheitert_nach"`]);
    const nf = String(n.laeufe[0]!.ergebnis!.fehler);
    expect(n.laeufe[0]!.log.split('\n').filter(Boolean)).toEqual(['pcs resource move ag_cluster-clone sqllnx02 --promoted', 'pcs resource clear ag_cluster-clone']);
    expect(nf).toContain('cannot verify the resource will not move back');
    expect(nf).toContain("Promoted jetzt auf 'sqllnx02' — Failover möglicherweise erfolgt");
    expect(nf).toContain('bisher geändert: failover-angestossen,primaer-gewechselt');
    const c = await agLaeufe([fo], { sa: GEHEIM.sa }, [`${FO_VOR()}\ntouch "$T/move_haengt" "$T/clear_scheitert"`], 'cat "$T/cli_prefer"');
    const cf = String(c.laeufe[0]!.ergebnis!.fehler);
    expect(cf).toContain('pcs resource clear ag_cluster-clone fehlgeschlagen (Error: clear kaputt)');
    expect(cf).toContain('cli-prefer-ag_cluster-clone@sqllnx02');
    expect(cf).toContain('von Hand: pcs resource clear ag_cluster-clone');
    expect(c.ende.trim()).toBe('sqllnx02'); // die Bedingung besteht wirklich noch — und der Fehler sagt es
    // Primär erreicht, aber clear scheitert → kein Erfolg, Bedingung genannt
    const d = await agLaeufe([fo], { sa: GEHEIM.sa }, [`${FO_VOR()}\ntouch "$T/clear_scheitert"`]);
    expect(d.laeufe[0]!.rc).toBe(1);
    expect(String(d.laeufe[0]!.ergebnis!.fehler)).toContain('Failover auf sqllnx02 nach 12 s, aber: pcs resource clear ag_cluster-clone fehlgeschlagen');
    // clear läuft, Bedingung bleibt trotzdem → Fehler, nie still
    const e = await agLaeufe([fo], { sa: GEHEIM.sa }, [`${FO_VOR()}\ntouch "$T/clear_wirkungslos"`]);
    expect(e.laeufe[0]!.rc).toBe(1);
    expect(String(e.laeufe[0]!.ergebnis!.fehler)).toContain('bestehen weiter');
    // jeder andere Abbruch nach dem move gibt zuerst frei und sagt es (Hülle um abbruch)
    const h = await agLaeufe([mitFo(haAgFailoverSkript(FO()), 'warte_primaer() { abbruch "Testabbruch nach dem move"; }')], { sa: GEHEIM.sa }, [FO_VOR()]);
    expect(h.laeufe[0]!.log.split('\n').filter(Boolean)).toEqual(['pcs resource move ag_cluster-clone sqllnx02 --promoted', 'pcs resource clear ag_cluster-clone']);
    expect(String(h.laeufe[0]!.ergebnis!.fehler)).toBe('Testabbruch nach dem move — Standort-Bedingung mit pcs resource clear ag_cluster-clone entfernt');
    // unerwartetes Ende (set -u) nach dem move: der EXIT-Trap räumt die Standort-Bedingung trotzdem ab
    const u = await agLaeufe([mitFo(haAgFailoverSkript(FO()), 'warte_primaer() { echo "$GIBTS_NICHT"; }')], { sa: GEHEIM.sa }, [FO_VOR()], 'ls "$T"');
    expect(u.laeufe[0]!.rc).not.toBe(0);
    expect(u.laeufe[0]!.log.split('\n').filter(Boolean)).toEqual(['pcs resource move ag_cluster-clone sqllnx02 --promoted', 'pcs resource clear ag_cluster-clone']);
    // Fix-Runde 1 (I1): die Fehlerzeile des Traps nennt das Ergebnis der Freigabe und den Stand (→ teilweise im Skill)
    const uf = String(u.laeufe[0]!.ergebnis!.fehler);
    expect(uf).toContain('unerwarteter Abbruch (Exit 1) nach pcs resource move');
    expect(uf).toContain('Standort-Bedingung mit pcs resource clear ag_cluster-clone entfernt');
    expect(uf).toContain('bisher geändert: failover-angestossen,standort-bedingung-entfernt');
    expect(u.laeufe[0]!.aus.split('\n').filter((z: string) => z.startsWith('ALFRED-HA ')).length).toBe(1);
    expect(u.ende).not.toContain('cli_prefer');
    // … und scheitert dort auch clear: verbliebene Bedingung mit Handbefehl
    const uc = await agLaeufe([mitFo(haAgFailoverSkript(FO()), 'warte_primaer() { echo "$GIBTS_NICHT"; }')], { sa: GEHEIM.sa }, [`${FO_VOR()}\ntouch "$T/clear_scheitert"`]);
    const ucf = String(uc.laeufe[0]!.ergebnis!.fehler);
    expect(ucf).toContain('unerwarteter Abbruch');
    expect(ucf).toContain('pcs resource clear ag_cluster-clone fehlgeschlagen (Error: clear kaputt)');
    expect(ucf).toContain('cli-prefer-ag_cluster-clone@sqllnx02');
    expect(ucf).toContain('von Hand: pcs resource clear ag_cluster-clone');
    expect(ucf).toContain('bisher geändert: failover-angestossen');
    // SIGTERM (z. B. Zeitgrenze am Host) nach dem move: EXIT-Trap läuft, gibt frei, meldet
    const t = await agLaeufe([mitFo(haAgFailoverSkript(FO()), 'warte_primaer() { kill -TERM "$BASHPID"; sleep 1; }')], { sa: GEHEIM.sa }, [FO_VOR()], 'ls "$T"');
    expect(t.laeufe[0]!.log.split('\n').filter(Boolean)).toEqual(['pcs resource move ag_cluster-clone sqllnx02 --promoted', 'pcs resource clear ag_cluster-clone']);
    expect(String(t.laeufe[0]!.ergebnis!.fehler)).toContain('unerwarteter Abbruch (Exit 143) nach pcs resource move');
    expect(t.ende).not.toContain('cli_prefer');
  });

  it('Ziel schon Primär: ohne move; liegengebliebene cli-prefer wird freigegeben und als Änderung gemeldet; Gegenstelle nicht synchron → Abbruch (nicht „ok“)', async () => {
    const schon = `${FO_VOR()}\necho sqllnx02 >"$T/promoted"; echo sqllnx02 >"$T/cli_prefer"`;
    const w = await agLaeufe([fo], { sa: GEHEIM.sa }, [schon], 'ls "$T"');
    const a = w.laeufe[0]!;
    expect(a.rc, a.aus).toBe(0);
    expect(a.log.split('\n').filter(Boolean)).toEqual(['pcs resource clear ag_cluster-clone']);
    expect(a.ergebnis).toMatchObject({ zustand: 'geaendert', primaer: 'sqllnx02', dauerS: 0, aenderungen: ['standort-bedingung-entfernt'], standortBedingungen: 0 });
    expect(w.ende).not.toContain('cli_prefer');
    const n = await agLaeufe([fo], { sa: GEHEIM.sa }, [FO_VOR({ fo_lage_primaer: 'ALFRED|PRIMARY|0|1|1|CONNECTED|SECONDARY|CONNECTED|0|alfredpruef=SYNCHRONIZED|alfredpruef=NOT SYNCHRONIZING' })]);
    const f = String(n.laeufe[0]!.ergebnis!.fehler);
    expect(n.laeufe[0]!.rc).toBe(1);
    expect(f).toContain('sqllnx01 ist SECONDARY/CONNECTED, Datenbanken 0/1 SYNCHRONIZED (alfredpruef=NOT SYNCHRONIZING)');
    expect(f).toContain('bisher geändert: failover-angestossen,standort-bedingung-entfernt');
  });

  // Final-Review M-3: CIB beim Freigeben vorher unlesbar → nicht „Standort-Bedingung entfernt“ behaupten, aber weiter als Änderung zählen
  it('freigeben: Standort-Bedingungen vor dem clear unlesbar → „pcs resource clear ausgeführt (vorher nicht lesbar)“, als Änderung gemeldet', async () => {
    // 1. Aufruf: Prüfung vor dem move (lesbar), 2. Aufruf: freigeben „vorher“ (unlesbar), danach wieder lesbar
    const zweiterKaputt = String.raw`eval "$(declare -f cibadmin | sed '1s/^cibadmin /cibadmin_echt /')"
cibadmin() { local n; n=$(( $(cat "$T/cib_n" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$T/cib_n"; [ "$n" != 2 ] || return 1; cibadmin_echt "$@"; }`;
    const w = await agLaeufe([mitFo(haAgFailoverSkript(FO()), zweiterKaputt)], { sa: GEHEIM.sa }, [FO_VOR()]);
    const a = w.laeufe[0]!;
    expect(a.rc, a.aus).toBe(0);
    expect(a.log.split('\n').filter(Boolean)).toEqual(['pcs resource move ag_cluster-clone sqllnx02 --promoted', 'pcs resource clear ag_cluster-clone']);
    expect(a.ergebnis).toMatchObject({ zustand: 'geaendert', primaer: 'sqllnx02', standortBedingungen: 0, aenderungen: ['failover-angestossen', 'pcs-resource-clear-vorher-unlesbar'] });
    // im Abbruch steht der Wortlaut der Freigabe
    const h = await agLaeufe([mitFo(haAgFailoverSkript(FO()), `${zweiterKaputt}\nwarte_primaer() { abbruch "Testabbruch nach dem move"; }`)], { sa: GEHEIM.sa }, [FO_VOR()]);
    expect(String(h.laeufe[0]!.ergebnis!.fehler)).toBe('Testabbruch nach dem move — pcs resource clear ag_cluster-clone ausgeführt (vorher nicht lesbar)');
  });

  it('Status: AG-Teil aus Pacemaker (Promoted, VIP, required_sync, Standort-Bedingungen) und SQL über die Zugangsdatei — Kennwort nur in der Umgebung von sqlcmd', () => {
    expect(PY_HA_STATUS).toContain('SQLCMDPASSWORD');
    expect(PY_HA_STATUS).toContain('/var/opt/mssql/secrets/passwd');
    expect(PY_HA_STATUS).toMatch(/r\["ag"\] = /);
    // nie als Argument
    expect(PY_HA_STATUS).not.toMatch(/"-P"/);
    expect(PY_HA_STATUS).toContain(PY_AG_STATUS_FUNK);
  });

  it('Status ausgeführt (lauf/lies/sqlcmd nachgebildet): Promoted, VIP, Standort-Bedingungen, required_sync, Replikate; unlesbar bleibt unbekannt (null), Kennwort nie in der Ausgabe', () => {
    const MON = '<pacemaker-result><resources><clone id="ag_cluster-clone"><resource id="ag_cluster" role="Promoted" active="true"><node name="sqllnx02"/></resource>'
      + '<resource id="ag_cluster" role="Unpromoted" active="true"><node name="sqllnx01"/></resource></clone><resource id="ag_vip" role="Started" active="true"><node name="sqllnx02"/></resource></resources></pacemaker-result>';
    const CIB = '<constraints><rsc_location id="cli-prefer-ag_cluster-clone" rsc="ag_cluster-clone" role="Promoted" node="sqllnx02" score="INFINITY"/><rsc_location id="x" rsc="fremd" node="a" score="1"/></constraints>';
    const SQL = 'ALFRED|G|sqllnxag01|0|1\nALFRED|R|sqllnx01|SECONDARY|SYNCHRONOUS_COMMIT|CONNECTED|1|1\nALFRED|R|sqllnx02|PRIMARY|SYNCHRONOUS_COMMIT|CONNECTED|1|1\nALFRED|R|sqllnxcfg|SECONDARY|CONFIGURATION_ONLY|CONNECTED|0|0\n';
    const lauf = (o: { res?: boolean; mon?: string | null; cib?: string | null; datei?: string | null; sql?: { rc: number; aus: string } }) => {
      const prog = [
        'import json, os, re, subprocess, sys, xml.etree.ElementTree as ET',
        `O = json.loads(${JSON.stringify(JSON.stringify(o))})`,
        'def lauf(*a):',
        '    if a[0] == "crm_resource" and "--query-xml" in a: return (0 if O.get("res") else 6), ""',
        '    if a[0] == "crm_resource": return 0, {"ag_name": "sqllnxag01", "required_synchronized_secondaries_to_commit": "0"}[a[-1]]',
        '    if a[0] == "crm_mon": return (0, O["mon"]) if O.get("mon") is not None else (1, "")',
        '    if a[0] == "cibadmin": return (0, O["cib"]) if O.get("cib") is not None else (1, "")',
        '    return 1, ""',
        'def lies(p):',
        '    return O.get("datei")',
        PY_AG_STATUS_FUNK,
        'os.path.exists = lambda p: O.get("datei") is not None',
        'class E: pass',
        'def sqlcmd_lauf(login, kw):',
        '    e = E(); e.returncode = O["sql"]["rc"]; e.stdout = O["sql"]["aus"].replace("KW", kw); e.stderr = ""; return e',
        'print(json.dumps(ag_lage()))',
      ].join('\n');
      const r = spawnSync(PYTHON!, ['-c', prog], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
      expect(r.status, r.stderr).toBe(0);
      return { ag: JSON.parse(r.stdout) as Record<string, unknown>, roh: r.stdout };
    };
    const voll = lauf({ res: true, mon: MON, cib: CIB, datei: 'alfred_pacemaker\nKw-Geheim-9999\n', sql: { rc: 0, aus: SQL } });
    expect(voll.ag).toEqual({ art: 'eingerichtet', ressource: true, name: 'sqllnxag01', requiredSyncRessource: '0', promoted: ['sqllnx02'], vip: ['sqllnx02'],
      standort: [{ id: 'cli-prefer-ag_cluster-clone', rsc: 'ag_cluster-clone', knoten: 'sqllnx02', rolle: 'Promoted' }],
      sql: { name: 'sqllnxag01', requiredSync: 0, datenbanken: 1, replikate: [
        { name: 'sqllnx01', rolle: 'SECONDARY', modus: 'SYNCHRONOUS_COMMIT', verbunden: 'CONNECTED', dbs: 1, sync: 1 },
        { name: 'sqllnx02', rolle: 'PRIMARY', modus: 'SYNCHRONOUS_COMMIT', verbunden: 'CONNECTED', dbs: 1, sync: 1 },
        { name: 'sqllnxcfg', rolle: 'SECONDARY', modus: 'CONFIGURATION_ONLY', verbunden: 'CONNECTED', dbs: 0, sync: 0 }] }, sqlFehler: null });
    // nichts lesbar: unbekannt (null), nie „keine Bedingung“ oder „ok“; SQL-Fehler mit geschwärztem Kennwort
    const kaputt = lauf({ res: true, mon: '<kaputt', cib: null, datei: 'alfred_pacemaker\nKw-Geheim-9999\n', sql: { rc: 1, aus: 'Login failed for KW' } });
    expect(kaputt.ag).toMatchObject({ promoted: null, vip: null, standort: null, sql: null });
    expect(String(kaputt.ag.sqlFehler)).toContain('Login failed for [geschwärzt]');
    expect(kaputt.roh).not.toContain('Kw-Geheim-9999');
    // ohne Ressource und ohne Zugangsdatei: keine AG
    expect(lauf({ res: false, datei: null }).ag).toEqual({ art: 'keine' });
    // Ressource, aber keine Zugangsdatei: SQL ohne Zugangsdatei (null/null)
    expect(lauf({ res: true, mon: MON, cib: '<constraints/>', datei: null }).ag).toMatchObject({ standort: [], sql: null, sqlFehler: null });
    for (const [k] of Object.entries(voll.ag)) expect(GEHEIM_NAME.test(k), k).toBe(false);
  });
});

// ── K1: zurückgebliebene RESTORING-Kopie auf dem Sekundär vor dem Beitritt sichtbar entfernen ────────────────────────────────────
describe('I8e Paket 2 K1 — alte Sekundär-Kopie (Text, Validator)', () => {
  const un = (t: string) => t.replaceAll(`'\\''`, "'");
  /** T-SQL-Block eines Replikat-Skripts (Shell-Literal zurückübersetzt) */
  const block = (k: keyof typeof ROLLE_VON, name: 'pruefen' | 'aendern' | 'selbst') => {
    const t = un(haAgReplikatSkript(AG_RP(k)));
    const rest = t.slice(t.indexOf(`-- ALFRED-SCHRITT rp_${name}`));
    return rest.slice(0, rest.search(/\r?\nT_[A-Z]+=|\r?\n# ALFRED-ABLAUF/));
  };

  it('Validator: datenbanken Pflicht und geprüft (alle Rollen); Skript gibt sie im Kopf mit aus', () => {
    for (const k of ['sqllnx01', 'sqllnx02', 'sqllnxcfg'] as const) {
      expect(pruefeHaAgReplikat(AG_RP(k))).toBeUndefined();
      const { datenbanken: _d, ...ohne } = AG_RP(k);
      expect(pruefeHaAgReplikat(ohne)).toContain('datenbanken');
      for (const d of [[], ['tempdb'], ['a b'], ["x'; DROP"], ['pruefdb01', 'PRUEFDB01']]) expect(pruefeHaAgReplikat({ ...AG_RP(k), datenbanken: d }), JSON.stringify(d)).toContain('datenbanken');
    }
    expect(() => haAgReplikatSkript({ ...AG_RP('sqllnx02'), datenbanken: ['master'] })).toThrow(/datenbanken/);
    expect(haAgReplikatSkript(AG_RP('sqllnxcfg'))).toContain('"datenbanken":["pruefdb01"]');
  });

  it('Primär rp_pruefen: dieselben Bereitschaftsprüfungen wie ab_pruefen, Abbruch „nichts geändert“; kein DROP DATABASE bei Primär und Konfig', () => {
    const p = block('sqllnx01', 'pruefen');
    const ab = un(haAgAbschlussSkript({ ...AG_AB, datenbanken: ['pruefdb01'] }));
    for (const z of [
      "INSERT @dbs (n) VALUES (N'pruefdb01');",
      "N' fehlt;' FROM @dbs d WHERE DB_ID(d.n) IS NULL;",
      "WHERE s.state_desc <> N'ONLINE';",
      "WHERE s.recovery_model_desc <> N'FULL';",
      'WHERE r.last_log_backup_lsn IS NULL;',
      "WHERE g.name <> N'sqllnxag01';",
      "N'Datenbanken nicht bereit:' + @f + N' - Wiederherstellungsmodell und Sicherung werden nie still geändert; nichts geändert'; THROW 50211, @m, 1;",
    ]) { expect(p, z).toContain(z); expect(ab, z).toContain(z.replace('THROW 50211', 'THROW 50303')); }
    for (const k of ['sqllnx01', 'sqllnxcfg'] as const) expect(un(haAgReplikatSkript(AG_RP(k)))).not.toContain('DROP DATABASE');
    expect(block('sqllnx02', 'pruefen')).not.toContain('last_log_backup_lsn');
    expect(block('sqllnxcfg', 'pruefen')).not.toContain('pruefdb01');
    expect(un(haAgReplikatSkript(AG_RP('sqllnxcfg')))).not.toContain('alte Kopie');
  });

  it('Sekundär rp_pruefen: andere AG und jeder Zustand außer RESTORING ohne AG → Abbruch „nie still gelöscht“', () => {
    const p = block('sqllnx02', 'pruefen');
    expect(p).toContain("N'pruefdb01 gehört auf sqllnx02 zur Verfügbarkeitsgruppe ' + ISNULL(g.name, N'?') + N'; nichts geändert'");
    expect(p).toContain("WHERE s.name = N'pruefdb01' AND s.replica_id IS NOT NULL AND ISNULL(g.name, N'') <> N'sqllnxag01'");
    expect(p).toContain("IF EXISTS (SELECT 1 FROM sys.databases WHERE name = N'pruefdb01' AND replica_id IS NULL AND state_desc <> N'RESTORING')");
    expect(p).toContain("N'pruefdb01 besteht auf sqllnx02 als ' + state_desc + N' außerhalb der AG - nie still gelöscht; nichts geändert'");
    expect(p).not.toContain('DROP');
  });

  it('Sekundär rp_aendern: DROP DATABASE nur bei RESTORING ohne AG, mit Marke, VOR dem JOIN; rp_selbst prüft die Restkopie', () => {
    const a = block('sqllnx02', 'aendern');
    const drop = "IF EXISTS (SELECT 1 FROM sys.databases WHERE name = N'pruefdb01' AND state_desc = N'RESTORING' AND replica_id IS NULL) BEGIN BEGIN TRY EXEC (N'DROP DATABASE [pruefdb01]'); END TRY BEGIN CATCH THROW; END CATCH; SET @a += ' alte-kopie-entfernt-pruefdb01'; PRINT 'ALFRED-ERLEDIGT alte-kopie-entfernt-pruefdb01'; END";
    expect(a).toContain(drop);
    expect(a.split('DROP DATABASE').length).toBe(2);
    expect(a.indexOf('DROP DATABASE [pruefdb01]')).toBeLessThan(a.indexOf('JOIN WITH'));
    expect(un(haAgReplikatSkript(AG_RP('sqllnx02'))).split('DROP DATABASE').length).toBe(2);
    expect(block('sqllnx02', 'selbst')).toContain("IF EXISTS (SELECT 1 FROM sys.databases WHERE name = N'pruefdb01' AND state_desc = N'RESTORING' AND replica_id IS NULL) SET @f += N' alte Kopie pruefdb01 (RESTORING ohne AG) besteht noch;';");
  });
});

describe.skipIf(!BASH || !PYTHON)('I8e Paket 2 K1 — alte Sekundär-Kopie ausgeführt', { timeout: 180_000 }, () => {
  it('Sekundär: Marke alte-kopie-entfernt-pruefdb01 landet in aenderungen; Abbruch nach dem DROP ist „teilweise“ (bisher geändert)', async () => {
    const sek = haAgReplikatSkript(AG_RP('sqllnx02'));
    const fehler = `printf '%s\\n' 'ALFRED-ERLEDIGT alte-kopie-entfernt-pruefdb01' 'Msg 47106, Level 16' 'Cannot join availability group' >"$T/sqlfehler_rp_aendern"`;
    const w = await agLaeufe([sek, sek], { sa: GEHEIM.sa }, [
      `echo sqllnx02 >"$T/name"; ${sqlStub({ rp_pruefen: 'ALFRED|ok', rp_aendern: 'ALFRED|alte-kopie-entfernt-pruefdb01 beigetreten seeding-erlaubt pacemaker-ag-rechte', rp_selbst: 'ALFRED|SECONDARY' })}`,
      fehler], 'cat "$T/tsql_rp_aendern"');
    const [a, b] = w.laeufe as [AgLauf, AgLauf];
    expect(a.rc, a.aus).toBe(0);
    expect(a.sqllog).toEqual(['bereit', 'rp_pruefen', 'rp_aendern', 'rp_selbst']);
    expect(a.ergebnis).toEqual({ zustand: 'geaendert', knoten: 'sqllnx02', rolle: 'sekundaer', lokaleRolle: 'SECONDARY', aenderungen: ['alte-kopie-entfernt-pruefdb01', 'beigetreten', 'seeding-erlaubt', 'pacemaker-ag-rechte'] });
    expect(b.rc).toBe(1);
    const f = String(b.ergebnis!.fehler);
    expect(f).toContain('bisher geändert: alte-kopie-entfernt-pruefdb01');
    expect(f).not.toContain('nichts geändert');
    expect(w.ende).toContain("EXEC (N'DROP DATABASE [pruefdb01]')");
  });
});
