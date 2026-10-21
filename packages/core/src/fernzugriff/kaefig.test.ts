import { describe, it, expect } from 'vitest';
import { geheimnisGrund, kaefigBefehl, kaefigEigenschaften, werteSelbsttest, kaefigGrenze } from './kaefig.js';

// v1549 (S1/S2) — Lese-Käfig und Geheimnis-Sperre
describe('v1549 Geheimnis-Sperre', () => {
  it('Geheimnisse werden erkannt', () => {
    for (const b of ['cat /etc/shadow', 'grep root /etc/gshadow', 'cat /root/.ssh/id_ed25519', 'cat /etc/ssh/ssh_host_ed25519_key', 'cat /opt/app/.env', 'cat /srv/app/.env.production', 'cat /etc/ssl/private/server.key',
      'ls /etc/pve/priv', 'cat /root/.pgpass', 'cat /var/www/wp-config.php', 'ls /opt/vaultwarden/data', 'cat /proc/1/environ', 'printenv', 'docker inspect homeassistant', 'docker compose config', 'pg_dumpall', 'cat /home/madh/.docker/config.json']) {
      expect(geheimnisGrund(b), b).toBeDefined();
    }
  });
  it('normale Analysen sind frei', () => {
    for (const b of ['cat /etc/nginx/nginx.conf', 'tail -n 200 /var/log/syslog', 'grep -ri error /var/log/nginx/', 'cat /etc/ssh/ssh_host_ed25519_key.pub', 'cat /root/.ssh/authorized_keys', 'du -sh /var/*', 'find /var -size +1G', 'ss -tlnp', 'docker inspect --format "{{.State.Status}}" x', 'cat /etc/environment.d/README', 'ls -la /etc/ssh']) {
      expect(geheimnisGrund(b), b).toBeUndefined();
    }
  });
});

describe('v1549 Lese-Käfig', () => {
  it('Eigenschaften: schreibgeschützt, nur Leserecht, ohne Sockets/Netz, mit Grenzen', () => {
    const p = kaefigEigenschaften('alfred', 60);
    for (const e of ['User=alfred', 'CapabilityBoundingSet=CAP_DAC_READ_SEARCH', 'AmbientCapabilities=CAP_DAC_READ_SEARCH', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=read-only', 'PrivateTmp=yes', 'PrivateDevices=yes', 'RestrictAddressFamilies=AF_NETLINK AF_INET AF_INET6', 'IPAddressDeny=any', 'RuntimeMaxSec=60', 'TasksMax=64']) {
      expect(p).toContain(e);
    }
    expect(kaefigEigenschaften('alfred', 99_999)).toContain('RuntimeMaxSec=900');
  });
  it('Befehl wird sicher in sh -c gequotet', () => {
    const b = kaefigBefehl("grep 'a b' /var/log/syslog | tail -n 5", 'alfred', 30);
    expect(b.startsWith('sudo -n systemd-run --quiet --pipe --wait --collect --service-type=exec ')).toBe(true);
    expect(b).toContain(`-p 'RestrictAddressFamilies=AF_NETLINK AF_INET AF_INET6'`);
    expect(b.endsWith(`-- /bin/sh -c 'grep '\\''a b'\\'' /var/log/syslog | tail -n 5'`)).toBe(true);
  });
  it('Selbsttest: nur ohne jeden Verstoß und mit Lesen ok', () => {
    expect(werteSelbsttest('PROBE_LESEN_OK\nPROBE_ENDE\n', 0)).toMatchObject({ ok: true });
    expect(werteSelbsttest('PROBE_SCHREIBEN /etc\nPROBE_LESEN_OK\nPROBE_ENDE', 0)).toMatchObject({ ok: false, grund: expect.stringContaining('SCHREIBEN /etc') });
    expect(werteSelbsttest('PROBE_DOCKER\nPROBE_LESEN_OK\nPROBE_ENDE', 0)).toMatchObject({ ok: false });
    expect(werteSelbsttest('PROBE_ENDE', 0)).toMatchObject({ ok: false, grund: expect.stringContaining('Lesen') });
    expect(werteSelbsttest('Failed to start transient service unit', 1)).toMatchObject({ ok: false, grund: expect.stringContaining('systemd-run') });
  });
  it('Grenze des Käfigs wird erkannt', () => {
    expect(kaefigGrenze('touch: cannot touch \'/etc/x\': Read-only file system')).toBe(true);
    expect(kaefigGrenze('Cannot connect to the Docker daemon at unix:///var/run/docker.sock')).toBe(true);
    expect(kaefigGrenze('grep: x: No such file or directory')).toBe(false);
  });
});

// v1551 — Sicherheitsprüfung: Sperrliste umgehbar → Pfade im Käfig unsichtbar + Ausgabe geschwärzt; curl nur an den Host selbst
describe('v1551 Nachschärfung', () => {
  it('Käfig macht Geheimnis-Pfade unsichtbar und prüft das im Selbsttest', async () => {
    const { GEHEIM_PFADE, KAEFIG_SELBSTTEST } = await import('./kaefig.js');
    const p = kaefigEigenschaften('alfred', 60).find(x => x.startsWith('InaccessiblePaths='))!;
    for (const g of ['/etc/shadow', '/root/.ssh', '/etc/ssh/ssh_host_ed25519_key', '/etc/pve/priv', '/etc/ssl/private']) { expect(GEHEIM_PFADE).toContain(g); expect(p).toContain(`-${g}`); }
    expect(KAEFIG_SELBSTTEST).toContain('PROBE_GEHEIMNIS');
    expect(werteSelbsttest('PROBE_GEHEIMNIS /etc/shadow\nPROBE_LESEN_OK\nPROBE_ENDE', 0)).toMatchObject({ ok: false });
  });
  it('Schwärzung: Schlüssel, Hashes, KEY=Wert, URL-Zugangsdaten, Bearer — egal wie gelesen', async () => {
    const { schwaerze } = await import('./kaefig.js');
    const roh = [
      'root:$6$abcdefgh$Xyz0123456789abcdefghijkl:19000:0:99999:7:::',
      '-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAA', '-----END OPENSSH PRIVATE KEY-----',
      'POSTGRES_PASSWORD=sehrgeheim123', 'export API_KEY="abcd1234efgh"', 'DB_HOST=db', 'url: postgres://app:geheim99@db:5432/app',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdefghijkl', 'normale zeile token ok',
    ].join('\n');
    const r = schwaerze(roh);
    for (const g of ['$6$abcdefgh', 'b3BlbnNzaC1rZXktdjEAAAAA', 'sehrgeheim123', 'abcd1234efgh', 'geheim99', 'eyJhbGciOiJIUzI1NiJ9abcdefghijkl']) expect(r.text).not.toContain(g);
    expect(r.text).toContain('DB_HOST=db');
    expect(r.text).toContain('normale zeile token ok');
    expect(r.anzahl).toBe(6);
  });
  it('curl ohne Rückfrage nur an den Host selbst, ohne Query und ohne -L', async () => {
    const { befehlsklasse } = await import('./regeln.js');
    for (const b of ['curl -sI http://localhost:8123', 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/health', 'curl -skI https://[::1]:8006']) expect(befehlsklasse(b), b).toBe('lesen');
    for (const b of ['curl -s http://169.254.169.254/latest/meta-data', 'curl -sI http://192.168.1.1', 'curl -s http://localhost:8080/admin?reboot=1', 'curl -sL http://localhost/', 'curl -s http://localhost.evil.com/']) expect(befehlsklasse(b), b).toBe('bestaetigen');
  });
});
