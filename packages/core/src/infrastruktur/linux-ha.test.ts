import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  haVorbereitenSkript, haStatusSkript, haErgebnis, hostfwNft, hostsBlock, pruefeHaVorbereiten, pruefeKnoten,
  HA_KNOTEN, HA_VERSIONEN, HA_PORTS, LINUX_HA_BAUSTEINE, PY_HA_STATUS, PY_KW_GLEICH, HOSTFW_UNIT,
  type HaVorbereitenParameter,
} from './linux-ha.js';
import { linuxBausteinBekannt, linuxBausteinSkript } from '../fernzugriff/linux-bausteine.js';

// I8e Paket 2 Task 2 — HA-Grundlage je Knoten (linux_ha.ha_vorbereiten), feste Bash-Bausteine

const P: HaVorbereitenParameter = { knoten: [...HA_KNOTEN], rolle: 'daten', versionen: { ...HA_VERSIONEN } };
const BASH = (() => { const r = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }); return r.status === 0 && /^\d+\./.test(r.stdout.trim()); })();
const PYTHON = ['python3', 'python'].find(p => spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3');

describe('I8e Paket 2 — linux-ha Register und Validatoren', () => {
  it('Bausteine sind beim Laden registriert und liefern denselben Text wie die Erzeuger', () => {
    for (const k of Object.values(LINUX_HA_BAUSTEINE)) expect(linuxBausteinBekannt(k)).toBe(true);
    expect(linuxBausteinSkript(LINUX_HA_BAUSTEINE.vorbereiten, P)).toBe(haVorbereitenSkript(P));
    expect(linuxBausteinSkript(LINUX_HA_BAUSTEINE.status, {})).toBe(haStatusSkript());
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
      'ip saddr @ha_peers4 udp dport { 5405 } accept',
      'tcp dport { 1433, 2224, 3121, 5022, 21064 } drop',
      'udp dport { 5405 } drop',
    ]);
    expect(t).toContain('elements = { 10.203.30.10, 10.203.30.11, 10.203.30.12 }');
    expect(t).toContain('type filter hook input priority -10; policy accept;');
    expect(t).not.toMatch(/\b22\b/);
    expect(t.match(/table inet alfred_ha/g)).toHaveLength(3); // anlegen, löschen, neu (atomar ersetzt)
    expect([...HA_PORTS.tcp, ...HA_PORTS.udp]).not.toContain(22);
    expect(HOSTFW_UNIT).toContain('ExecStart=/usr/sbin/nft -f /etc/alfred/hostfw.nft');
    expect(HOSTFW_UNIT).not.toMatch(/nftables\.service|ufw/);
    expect(hostsBlock(HA_KNOTEN).split('\n').slice(1, 4)).toEqual(['10.203.30.10 sqllnx01', '10.203.30.11 sqllnx02', '10.203.30.12 sqllnxcfg']);
  });
  it.skipIf(!BASH)('bash -n: beide Skripte syntaktisch gültig', () => {
    for (const s of [haVorbereitenSkript(P), haVorbereitenSkript({ ...P, rolle: 'konfig' }), haStatusSkript()]) {
      const r = spawnSync('bash', ['-n'], { input: s, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    }
  });
  it.skipIf(!PYTHON)('Python-Programme parsen', () => {
    for (const prog of [PY_HA_STATUS, PY_KW_GLEICH]) {
      const r = spawnSync(PYTHON!, ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: prog, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    }
  });
  it('haErgebnis liest die letzte ALFRED-HA-Zeile', () => {
    expect(haErgebnis('x\nALFRED-HA {"zustand":"a"}\nALFRED-SQL {"zustand":"b"}\nALFRED-HA {"zustand":"c"}\n')).toEqual({ zustand: 'c' });
    expect(haErgebnis('ALFRED-SQL {"zustand":"b"}')).toBeUndefined();
  });
});

// ── Skript mit nachgebildetem Rechner ausführen (bash) ──────────────────────────────────────────────────────────────────────────
const STUBS = String.raw`
HOSTS="$T/hosts"; HOSTS_VORLAGE="$T/hosts.tmpl"; WD_SYS="$T/wd"; PCI_SYS="$T/pci"; PROC="$T/proc"; SHADOW="$T/shadow"; POLICY_RC="$T/policy-rc.d"; TMP_BASIS="$T"
MSSQL_CONF="$T/mssql.conf"; MSSQLCONF=mssqlconf_stub
MODPROBE_CONF="$T/etc/modprobe.d/a.conf"; MODLOAD_CONF="$T/etc/modules-load.d/a.conf"; SYSTEMD_CONF="$T/etc/systemd/a.conf"
FW_DATEI="$T/etc/alfred/hostfw.nft"; UNIT_DATEI="$T/etc/systemd/system/alfred-hostfw.service"
log() { echo "$*" >>"$T/log"; }
feld() { printf '%s' 'Hk-Geheim-123456!'; }
json_text() { local x; x=$(cat); printf '"%s"' "§{x//\"/}"; }
eigener_name() { cat "$T/name"; }
uname() { echo 6.8.0-147-generic; }
dpkg-query() { local f="$T/dpkg/§{@: -1}"; [ -f "$f" ] || return 1; case "$*" in *Version*) cat "$f" ;; *) cut -d'|' -f1 "$f" ;; esac; }
apt-get() { log "apt-get $*"; local a; if [[ " $* " == *" install "* ]]; then for a in "$@"; do case "$a" in -*|install|DPkg*|Dpkg*) ;; *=*) printf 'install ok installed|%s' "§{a#*=}" >"$T/dpkg/§{a%%=*}" ;; linux-modules-extra-*) printf 'install ok installed|1' >"$T/dpkg/$a" ;; esac; done; fi; }
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
kennwort_gleich() { [ -f "$T/kw_gesetzt" ] && [ "$(cat "$T/kw_gesetzt")" = "hacluster:$KW" ]; }
mssqlconf_stub() { log "mssql-conf $*"; printf '[hadr]\nhadrenabled = 1\n' >>"$MSSQL_CONF"; }
getent() { awk -v n="§{@: -1}" '$1 !~ /^#/ { for (i = 2; i <= NF; i++) if ($i == n) { print $1; exit } }' "$HOSTS"; }
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
printf '127.0.0.1 localhost\n127.0.1.1 sqllnx02\n' >"$T/hosts"
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
    'echo ---HOSTS; cat "$T/hosts"; echo ---VORLAGE; cat "$T/hosts.tmpl"; echo ---FW; cat "$T/etc/alfred/hostfw.nft" 2>/dev/null; echo ---DATEIEN; (cd "$T" && find etc policy-rc.d -type f 2>/dev/null | sort); echo ---ENDE',
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
    expect(a.ergebnis!.aenderungen).toEqual(expect.arrayContaining(['pakete', 'halten:pcs', 'i6300esb-geladen', 'softdog-gesperrt', 'systemd-runtimewatchdog', 'firewall-regeln', 'firewall-dienst', 'hacluster-kennwort', 'cluster-dienste-aus', 'pcsd', 'hadr']));
    expect(a.log).toContain('apt-get -o DPkg::Lock::Timeout=300 install -y -q --no-install-recommends -o Dpkg::Options::=--force-confold pacemaker=2.1.6-5ubuntu2 corosync=3.1.7-1ubuntu3.2 pcs=0.11.7-1ubuntu1.1 sbd=1.5.2-2ubuntu2 resource-agents-base=1:4.13.0-1ubuntu4.2 mssql-server-ha=17.0.4006.2-1 linux-modules-extra-6.8.0-147-generic');
    expect(a.log).toContain('modprobe i6300esb');
    expect(a.log).toContain('systemctl disable --now sbd');
    expect(a.log).toContain('mssql-conf set hadr.hadrenabled 1');
    expect(a.aus).toContain('ALFRED-HACLUSTER-GESETZT');
    expect(a.aus).not.toContain('Hk-Geheim');
    // hosts: Block oben (eigener Name löst zur Knoten-IP auf), cloud-init-Vorlage nach der Kopfzeile
    expect(w.hosts.split('\n').slice(0, 5)).toEqual([expect.stringContaining('# ALFRED-HA ANFANG'), '10.203.30.10 sqllnx01', '10.203.30.11 sqllnx02', '10.203.30.12 sqllnxcfg', '# ALFRED-HA ENDE']);
    expect(w.hosts).toContain('127.0.1.1 sqllnx02');
    expect(w.vorlage.split('\n')[0]).toBe('## template:jinja');
    expect(w.vorlage.split('\n')[1]).toContain('# ALFRED-HA ANFANG');
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
    expect(w.hosts).toBe('127.0.0.1 localhost\n127.0.1.1 sqllnx02\n');
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
  it('Konfig-Knoten: gleiche Grundlage, Rolle im Ergebnis', () => {
    const w = laeufe('echo sqllnxcfg >"$T/name"', 1, { ...P, rolle: 'konfig' });
    expect(w.laeufe[0]!.rc, w.laeufe[0]!.aus).toBe(0);
    expect(w.laeufe[0]!.ergebnis).toMatchObject({ zustand: 'geaendert', knoten: 'sqllnxcfg', rolle: 'konfig' });
  });
});
