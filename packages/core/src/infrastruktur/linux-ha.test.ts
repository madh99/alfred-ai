import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  haVorbereitenSkript, haStatusSkript, haErgebnis, hostfwNft, hostsBlock, pruefeHaVorbereiten, pruefeKnoten,
  HA_KNOTEN, HA_VERSIONEN, HA_PORTS, HA_SQL_ZUSATZQUELLEN, LINUX_HA_BAUSTEINE, PY_HA_STATUS, PY_KW_GLEICH, HOSTFW_UNIT,
  haClusterSkript, haClusterEntfernenSkript, pruefeHaCluster, pruefeHaClusterEntfernen, PY_CRM_LAGE, PY_CLUSTER_FUNK,
  type HaVorbereitenParameter, type HaClusterParameter,
} from './linux-ha.js';
import { linuxBausteinBekannt, linuxBausteinSkript } from '../fernzugriff/linux-bausteine.js';

// I8e Paket 2 Task 2 — HA-Grundlage je Knoten (linux_ha.ha_vorbereiten), feste Bash-Bausteine

const P: HaVorbereitenParameter = { knoten: [...HA_KNOTEN], rolle: 'daten', versionen: { ...HA_VERSIONEN } };
const PC: HaClusterParameter = { cluster: 'sqllnxcl01', knoten: [...HA_KNOTEN], sbd_timeout_s: 10, stonith_timeout_s: 20 };
const BASH = (() => { const r = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }); return r.status === 0 && /^\d+\./.test(r.stdout.trim()); })();
const PYTHON = ['python3', 'python'].find(p => spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3');

describe('I8e Paket 2 — linux-ha Register und Validatoren', () => {
  it('Bausteine sind beim Laden registriert und liefern denselben Text wie die Erzeuger', () => {
    for (const k of Object.values(LINUX_HA_BAUSTEINE)) expect(linuxBausteinBekannt(k)).toBe(true);
    expect(linuxBausteinSkript(LINUX_HA_BAUSTEINE.vorbereiten, P)).toBe(haVorbereitenSkript(P));
    expect(linuxBausteinSkript(LINUX_HA_BAUSTEINE.status, {})).toBe(haStatusSkript());
    expect(linuxBausteinSkript(LINUX_HA_BAUSTEINE.cluster, PC)).toBe(haClusterSkript(PC));
    expect(linuxBausteinSkript(LINUX_HA_BAUSTEINE.clusterEntfernen, { cluster: 'sqllnxcl01', knoten: HA_KNOTEN })).toBe(haClusterEntfernenSkript({ cluster: 'sqllnxcl01', knoten: [...HA_KNOTEN] }));
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
    expect(HA_VERSIONEN).toEqual({ pacemaker: '2.1.6-5ubuntu2', corosync: '3.1.7-1ubuntu3.2', pcs: '0.11.7-1ubuntu1.1', sbd: '1.5.2-2ubuntu2', resourceAgents: '1:4.13.0-1ubuntu4.2', mssqlHa: '17.0.4006.2-1' });
  });
  it('Skript ohne Geheimnis im Text; fremde Eingabefelder landen nie im Skript; Kennwort nur aus stdin (feld hacluster)', () => {
    const s = haVorbereitenSkript({ ...P, hacluster: 'Geheim-Wert-42' } as never);
    expect(s).not.toContain('Geheim-Wert-42');
    expect(s).not.toContain('"hacluster":');
    expect(s).toContain('KW=$(feld hacluster)');
    expect(s).toContain("printf 'hacluster:%s\\n' \"$KW\" | chpasswd");
    expect(s).toContain(`ALFRED_P='${JSON.stringify({ knoten: HA_KNOTEN, rolle: 'daten', versionen: HA_VERSIONEN })}'`);
    // Pakete fest, mssql-server-ha = SQL-Version, Kernel-Module passend zum laufenden Kernel
    for (const pv of ['pacemaker=2.1.6-5ubuntu2', 'corosync=3.1.7-1ubuntu3.2', 'pcs=0.11.7-1ubuntu1.1', 'sbd=1.5.2-2ubuntu2', 'resource-agents-base=1:4.13.0-1ubuntu4.2', 'mssql-server-ha=17.0.4006.2-1']) expect(s).toContain(`'${pv}'`);
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
    for (const s of [haVorbereitenSkript(P), haVorbereitenSkript({ ...P, rolle: 'konfig' }), haStatusSkript(), haClusterSkript(PC), haClusterEntfernenSkript(PC)]) {
      const r = spawnSync('bash', ['-n'], { input: s, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    }
  });
  it.skipIf(!PYTHON)('Python-Programme parsen', () => {
    for (const prog of [PY_HA_STATUS, PY_KW_GLEICH, PY_CRM_LAGE, PY_CLUSTER_FUNK]) {
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
modprobe() { log "modprobe $*"; if [ -f "$T/pci_ok" ]; then mkdir -p "$WD_SYS/watchdog0"; cat "$T/kennung" >"$WD_SYS/watchdog0/identity"; fi; }
udevadm() { :; }
sleep() { :; }
journalctl() { :; }
ss() { echo LISTEN; }
systemctl() {
  local u=§{@: -1}
  case "$1" in
    show) cat "$T/rw"; return 0 ;;
    is-active|is-enabled) [ -f "$T/svc/$u.$1" ]; return ;;
  esac
  log "systemctl $*"
  case "$1" in
    enable) touch "$T/svc/$u.is-enabled"; if [ "$2" = --now ]; then touch "$T/svc/$u.is-active"; fi ;;
    disable) rm -f "$T/svc/$u.is-enabled" "$T/svc/$u.is-active" ;;
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
    expect(a.log).toContain('apt-get -o DPkg::Lock::Timeout=300 install -y -q --no-install-recommends -o Dpkg::Options::=--force-confold pacemaker=2.1.6-5ubuntu2 corosync=3.1.7-1ubuntu3.2 pcs=0.11.7-1ubuntu1.1 sbd=1.5.2-2ubuntu2 resource-agents-base=1:4.13.0-1ubuntu4.2 mssql-server-ha=17.0.4006.2-1 linux-modules-extra-6.8.0-147-generic');
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
    const vorher = String.raw`for pv in 'pacemaker=2.1.6-5ubuntu2' 'corosync=3.1.7-1ubuntu3.2' 'pcs=0.11.7-1ubuntu1.1' 'sbd=1.5.2-2ubuntu2' 'resource-agents-base=1:4.13.0-1ubuntu4.2' 'mssql-server-ha=17.0.4006.2-1'; do printf 'hold ok installed|%s' "§{pv#*=}" >"$T/dpkg/§{pv%%=*}"; done
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
  it('Konfig-Knoten: gleiche Grundlage, Rolle im Ergebnis', () => {
    const w = laeufe('echo sqllnxcfg >"$T/name"; printf "127.0.0.1 localhost\\n127.0.1.1 sqllnxcfg.ad.3033.at sqllnxcfg\\n" >"$T/hosts"', 1, { ...P, rolle: 'konfig' });
    expect(w.laeufe[0]!.rc, w.laeufe[0]!.aus).toBe(0);
    expect(w.laeufe[0]!.ergebnis).toMatchObject({ zustand: 'geaendert', knoten: 'sqllnxcfg', rolle: 'konfig' });
  });
  // Task 3, Carry-over a: Teil-Lauf (Pakete schon installiert, Debian aktivierte die Dienste) — die Wiederholung schaltet sie trotzdem ab
  const PAKETE_DA = String.raw`for pv in 'pacemaker=2.1.6-5ubuntu2' 'corosync=3.1.7-1ubuntu3.2' 'pcs=0.11.7-1ubuntu1.1' 'sbd=1.5.2-2ubuntu2' 'resource-agents-base=1:4.13.0-1ubuntu4.2' 'mssql-server-ha=17.0.4006.2-1'; do printf 'hold ok installed|%s' "§{pv#*=}" >"$T/dpkg/§{pv%%=*}"; done
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
    "cluster setup") log "pcs $*"; local k; for k in $ALLE; do if [ -f "$T/conf/$k" ]; then echo "Error: $k: Cluster configuration files found, the host seems to be in a cluster already, use --force to override"; return 1; fi; done; shift 2; pcs_setup "$@"; return 0 ;;
    "stonith sbd")
      case "$3" in
        enable) log "pcs $*"; touch "$T/sbd_en" "$T/svc/sbd.is-enabled"; echo "§{4#watchdog=}" >"$T/sbd_wd"; echo "§{5#SBD_WATCHDOG_TIMEOUT=}" >"$T/sbd_t" ;;
        disable) log "pcs $*"; rm -f "$T/sbd_en" "$T/svc/sbd.is-enabled" ;;
        status) echo 'SBD STATUS'; echo '<node name>: <installed> | <enabled> | <running>'; local k e r; for k in $ALLE; do e=' NO'; r=' NO'; if [ -f "$T/sbd_en" ]; then e=YES; if [ -f "$T/laeuft" ]; then r=YES; fi; fi; echo "$k: YES | $e | $r"; done ;;
        config) [ -f "$T/sbd_en" ] || { echo 'Error: SBD is not enabled'; return 1; }; printf 'SBD_DELAY_START=no\nSBD_STARTMODE=always\nSBD_WATCHDOG_TIMEOUT=%s\n\nWatchdogs:\n' "$(cat "$T/sbd_t")"; local k; for k in $ALLE; do echo "  $k: $(cat "$T/sbd_wd")"; done ;;
      esac
      return 0 ;;
    "cluster enable") log "pcs $*"; touch "$T/svc/corosync.is-enabled" "$T/svc/pacemaker.is-enabled"; return 0 ;;
    "cluster start") log "pcs $*"; [ ! -f "$T/start_scheitert" ] || { echo 'Error: unable to start'; return 1; }; touch "$T/laeuft" "$T/svc/corosync.is-active" "$T/svc/pacemaker.is-active"; [ ! -f "$T/sbd_en" ] || touch "$T/svc/sbd.is-active"; return 0 ;;
    "cluster stop") log "pcs $*"; rm -f "$T/laeuft" "$T/svc/corosync.is-active" "$T/svc/pacemaker.is-active" "$T/svc/sbd.is-active"; return 0 ;;
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
async function cluster(texte: string[], setup = '', zwischen: string[] = []): Promise<{ laeufe: ClLauf[]; zustand: string }> {
  const teile = texte.map((t, i) => {
    // Ersetzung als Funktion: CL_STUBS enthält „$'“ (bei einem Ersetzungstext ein Sondermuster)
    const text = t.replace('# ALFRED-ABLAUF', () => `${CL_STUBS}\n# ALFRED-ABLAUF`);
    return `${zwischen[i] ?? ''}\n( ${text}\n) >"$T/aus${i}" 2>&1; echo "RC${i}=$?" >>"$T/rc"; mv "$T/log" "$T/log${i}" 2>/dev/null || : >"$T/log${i}"`;
  });
  const huelle = [
    'T=$(mktemp -d)', `PY=$(command -v ${PYTHON})`, CL_BASIS, setup, "ALFRED_EINGABE=''", ...teile,
    'cat "$T/rc"',
    ...texte.map((_, i) => `echo "---AUS${i}"; cat "$T/aus${i}"; echo "---LOG${i}"; cat "$T/log${i}"`),
    'echo ---ZUSTAND; (cd "$T" && ls conf svc prop 2>/dev/null; for f in conf/*; do [ -f "$f" ] && grep -H cluster_name "$f"; done); echo ---ENDE',
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
    expect(b.ergebnis).toMatchObject({ zustand: 'geaendert', aenderungen: ['sbd-neu-eingerichtet'] });
    expect(b.log.trim().split('\n')).toEqual(['pcs cluster stop --all', expect.stringMatching(/^pcs stonith sbd enable .* SBD_WATCHDOG_TIMEOUT=10$/), 'pcs cluster start --all --wait=180']);
    expect(c.rc).toBe(1);
    expect(String(c.ergebnis?.fehler)).toContain("SBD weicht ab (SBD_WATCHDOG_TIMEOUT '15' statt 10), der Cluster trägt aber 2 Ressourcen");
    expect(c.log.trim()).toBe('');
  });
  it('Selbstprüfung: nur 2/3 Knoten online → Abbruch (kein „geaendert“ ohne Beleg)', async () => {
    const a = (await cluster([ANLEGEN], 'echo 2 >"$T/online"')).laeufe[0]!;
    expect(a.rc).toBe(1);
    expect(String(a.ergebnis?.fehler)).toContain('nach dem Start 2/3 Knoten online');
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
});
