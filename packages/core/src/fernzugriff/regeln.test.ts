import { describe, it, expect } from 'vitest';
import { befehlsklasse, kuerzeMitte, fernBefehl, leseKeyscan, fingerabdruck, knownHostsZeilen, gueltigerHost, gueltigerBenutzer, einrichtungsBefehle } from './regeln.js';

// v1539 — Fernzugriff: Befehlsklassen und Host-Schlüssel (Realfall 21.10.: „zpool status“ auf pve)
describe('v1539 Befehlsklassen', () => {
  it('lesende Befehle laufen ohne Rückfrage', () => {
    for (const b of ['zpool status', 'sudo zpool status', 'zpool status -v rpool', 'pvecm status', 'qm list', 'pct config 105', 'df -h', 'free -h', 'journalctl -u pveproxy -n 50 --no-pager', 'systemctl status pvedaemon', 'smartctl -a /dev/nvme0n1', 'cat /proc/mdstat', 'pvesh get /cluster/resources --output-format json']) {
      expect(befehlsklasse(b), b).toBe('lesen');
    }
  });
  it('verkettete, umgeleitete oder unbekannte Befehle brauchen Bestätigung', () => {
    for (const b of ['zpool status; reboot', 'zpool status | sh', 'cat /etc/pve/priv/authkey.key', 'qm start 105', 'systemctl restart pveproxy', 'apt upgrade -y', 'zpool scrub rpool', 'echo $(id)', 'reboot']) {
      expect(befehlsklasse(b), b).toBe('bestaetigen');
    }
  });
  it('v1541 journalctl: Zeit nur im festen Format, verändernde Optionen nie als „lesen“', () => {
    for (const b of ['journalctl --since today -n 100', 'journalctl -u pveproxy --since "2026-10-21 08:00" --no-pager', 'journalctl --since -2h -p err']) expect(befehlsklasse(b), b).toBe('lesen');
    for (const b of ['journalctl --since x --rotate', 'journalctl --since "1 --vacuum-time=1s"', 'journalctl --vacuum-size=1M', 'journalctl --flush', 'journalctl -D /var/log/x', 'journalctl --file /root/x', 'journalctl --until yesterday --setup-keys']) expect(befehlsklasse(b), b).toBe('bestaetigen');
  });
  it('v1542 F1: Diagnose aus dem Realfall 21.10. ohne Rückfrage', () => {
    for (const b of ['smartctl -a /dev/disk/by-id/nvme-Fanxiang_S501Q_2TB_FXS501Q242220497_1', 'smartctl --scan-open', 'smartctl -x /dev/nvme0n1', 'lsblk -o NAME,SIZE,MODEL,SERIAL,MOUNTPOINTS', 'ls -l /dev/disk/by-id/nvme-*', 'pvesm list backupshare --content backup --vmid 106', 'pvesm list backupshare --content import', 'docker compose version', 'getent hosts archive.ubuntu.com', 'nvme smart-log /dev/nvme0', 'qm listsnapshot 106', 'zpool events -v', 'zfs list -r -o name,used,avail,refer,mountpoint zfs-nvme002']) {
      expect(befehlsklasse(b), b).toBe('lesen');
    }
  });
  it('v1542 F2: Ketten aus Lesebefehlen und Pipes zu Filtern sind lesen, sonst Bestätigung', () => {
    for (const b of ['zpool status -v zfs-nvme002; lsblk -o NAME,SIZE,MODEL,SERIAL,MOUNTPOINTS; smartctl --scan-open', 'zpool list && zfs list', 'journalctl -k -n 500 --no-pager | grep -i nvme | tail -n 50', 'ls -l /dev/disk/by-id/nvme-* | wc -l', 'qm list | sort -k 3 | head -20', 'zpool status;']) {
      expect(befehlsklasse(b), b).toBe('lesen');
    }
    for (const b of ['zpool status; qm start 106', 'zpool status | sh', 'zpool status | tee /etc/x', 'zpool status > /tmp/x', 'zpool status || reboot', 'zpool status & reboot', 'grep -f /etc/shadow x', 'zpool list | grep "a;b"', 'zpool list | xargs rm', 'qm list; ;', '; zpool list']) {
      expect(befehlsklasse(b), b).toBe('bestaetigen');
    }
    expect(befehlsklasse('zpool list; zpool destroy tank')).toBe('nie');
  });
  it('v1542 F3: Kürzen behält Anfang und Ende', () => {
    const t = Array.from({ length: 2000 }, (_, i) => `zeile ${i}`).join('\n');
    const k = kuerzeMitte(t, 1000);
    expect(k.length).toBeLessThan(1100);
    expect(k.startsWith('zeile 0')).toBe(true);
    expect(k.endsWith('zeile 1999')).toBe(true);
    expect(k).toContain('in der Mitte ausgelassen');
    expect(kuerzeMitte('kurz', 10)).toBe('kurz');
  });
  it('v1545 Docker: lesende Befehle sofort, verändernde und volles inspect mit Bestätigung', () => {
    for (const b of ['docker ps', 'docker ps -a --no-trunc', 'docker logs --tail 200 homeassistant', 'docker logs --since 1h -t homeassistant', 'docker stats --no-stream', 'docker inspect --format "{{.State.Status}} {{.RestartCount}}" homeassistant', 'docker images', 'docker system df -v', 'docker compose ls', 'docker compose -p homeassistant ps', 'docker top homeassistant', 'docker ps | grep home', 'docker info']) {
      expect(befehlsklasse(b), b).toBe('lesen');
    }
    for (const b of ['docker restart homeassistant', 'docker stop homeassistant', 'docker rm -f x', 'docker inspect homeassistant', 'docker compose config', 'docker logs -f homeassistant', 'docker exec homeassistant ls', 'docker compose -p homeassistant up -d', 'docker ps -f status=exited', 'docker inspect --format "{{json .Config.Env}}$(id)" x', 'docker inspect --format "{{json .Config.Env}}" homeassistant', 'docker inspect --format "{{.Config.Env}}" x']) {
      expect(befehlsklasse(b), b).toBe('bestaetigen');
    }
    expect(befehlsklasse('docker system prune -af')).not.toBe('lesen');
    // v1546 — Sicherheitsprüfung: Ersetzung in --format nie lesen; inspect nur mit erlaubten Feldern
    for (const b of ['docker ps --format "$(id)"', 'docker ps --format "`id`"', 'docker stats --no-stream --format "$HOME"', 'docker ps --format "{{.Command}}"', 'docker inspect --format "{{json .Config}}" homeassistant', 'docker inspect --format "{{json .}}" homeassistant', 'docker inspect --format "{{.Config}}" x', 'docker inspect --format "{{.Config.Labels}}" x']) {
      expect(befehlsklasse(b), b).toBe('bestaetigen');
    }
    for (const b of ['docker ps --format "{{.Names}} {{.Status}}"', 'docker ps --format "table {{.Names}}, {{.Ports}}"', 'docker stats --no-stream --format "{{.Name}}: {{.CPUPerc}} {{.MemUsage}}"', 'docker inspect --format "{{.State.Health.Status}}" homeassistant', 'docker inspect --format "{{json .NetworkSettings.Ports}}" homeassistant']) {
      expect(befehlsklasse(b), b).toBe('lesen');
    }
  });
  it('v1548 K2/K3: Befehle aus dem Realfall 22.10. 01:09 (dockerhost) sind lesen', () => {
    // genau so vom Modell geschickt (im JSON stand \\t, im Befehl also Backslash + t)
    expect(befehlsklasse(String.raw`docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'`)).toBe('lesen');
    expect(befehlsklasse('docker ps | tail -n +22')).toBe('lesen');
    expect(befehlsklasse('docker ps -a | head -n 20')).toBe('lesen');
    expect(befehlsklasse(String.raw`docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'`)).toBe('lesen');
    expect(befehlsklasse(`docker inspect --format '{{.State.Health.Status}}' homeassistant`)).toBe('lesen');
    // weiterhin gesperrt: Ersetzung in '…' gibt es nicht, aber $, Backtick, Backslash bleiben verdächtig; Env nie
    for (const b of [`docker ps --format '{{.Names}}'$(id)`, `docker ps --format '$(id)'`, `docker inspect --format '{{json .Config}}' x`, String.raw`docker ps --format '{{.Names}}\n'`, `docker ps --format '{{.Command}}'`]) {
      expect(befehlsklasse(b), b).toBe('bestaetigen');
    }
  });
  it('zerstörerische Befehle nie, auch versteckt in einer Kette', () => {
    for (const b of ['zpool destroy tank', 'mkfs.ext4 /dev/sdb1', 'wipefs -a /dev/sdb', 'dd if=/dev/zero of=/dev/sda', 'rm -rf /', 'rm -rf /etc', 'qm list; zpool labelclear /dev/sdb', 'pvecm delnode pve2', 'zfs destroy -r rpool/data', '']) {
      expect(befehlsklasse(b), b).toBe('nie');
    }
    expect(befehlsklasse('rm -rf /tmp/alfred-test')).toBe('bestaetigen');
  });
  it('sudo -n, komplexe Befehle in sh -c mit sicherem Quoting', () => {
    expect(fernBefehl('zpool status', true)).toBe('sudo -n zpool status');
    expect(fernBefehl("journalctl -n 5 | grep 'x'", true)).toBe(`sudo -n sh -c 'journalctl -n 5 | grep '\\''x'\\'''`);
    expect(fernBefehl('sudo df -h', false)).toBe('df -h');
  });
});

describe('v1539 Host-Schlüssel', () => {
  // öffentlicher Testschlüssel (ed25519), Fingerabdruck mit ssh-keygen -lf gegengeprüft
  const k = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
  it('liest ssh-keyscan, ignoriert Kommentare und Unbekanntes', () => {
    const r = leseKeyscan(`# 192.168.1.22:22 SSH-2.0-OpenSSH_9.2p1\n192.168.1.22 ssh-ed25519 ${k}\n192.168.1.22 bogus xyz\n`);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ typ: 'ssh-ed25519', schluessel: k });
    expect(r[0]!.fingerabdruck).toBe(fingerabdruck(k));
    expect(r[0]!.fingerabdruck).toBe('SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU'); // = ssh-keygen -lf
  });
  it('known_hosts-Zeilen, Port in Klammern', () => {
    const s = leseKeyscan(`h ssh-ed25519 ${k}`);
    expect(knownHostsZeilen('192.168.1.22', 22, s)).toBe(`192.168.1.22 ssh-ed25519 ${k}\n`);
    expect(knownHostsZeilen('pve', 2222, s)).toBe(`[pve]:2222 ssh-ed25519 ${k}\n`);
  });
  it('Host und Benutzer ohne Optionen-Einschleusung', () => {
    expect(gueltigerHost('192.168.1.22')).toBe(true);
    expect(gueltigerHost('pve.local')).toBe(true);
    expect(gueltigerHost('-oProxyCommand=x')).toBe(false);
    expect(gueltigerHost('a b')).toBe(false);
    expect(gueltigerBenutzer('alfred')).toBe(true);
    expect(gueltigerBenutzer('-l')).toBe(false);
  });
  it('Einrichtung: Benutzer und Schlüssel; die sudo-Regel richtet der Owner selbst ein', () => {
    const t = einrichtungsBefehle(`ssh-ed25519 ${k} alfred@alfred1`);
    expect(t).toContain('useradd -m -s /bin/bash alfred');
    expect(t).toContain(`ssh-ed25519 ${k} alfred@alfred1`);
    expect(t).toContain('sudo-Regel');
  });
});

// Realfall 22.10. (pgAdmin-Umzug Schritt 5): YAML-Einrückung in printf-Argumenten ging durch das Zusammenfassen verloren
describe('normalisiereBefehl', () => {
  it('fasst Leerzeichen nur außerhalb von Anführungszeichen zusammen', async () => {
    const { normalisiereBefehl } = await import('./regeln.js');
    expect(normalisiereBefehl("  sudo -n printf '%s\n'  'services:' '  pgadmin:' '    image: x'   > /srv/a.yaml ")).toBe("printf '%s\n' 'services:' '  pgadmin:' '    image: x' > /srv/a.yaml");
    expect(normalisiereBefehl('echo  "a   b"   c')).toBe('echo "a   b" c');
    expect(normalisiereBefehl('docker   ps\n  -a')).toBe('docker ps -a');
  });
});
