import { describe, it, expect } from 'vitest';
import { leseOs, leseRam, leseDf, leseDienste, lesePorts, leseAptUpdates, leseDocker, leseComposeZuordnung, leseComposeLs, leseVolumes, sammleLinux, LINUX_BEFEHLE, composeBefehl } from './sammler.js';
import { befehlsklasse } from '../fernzugriff/regeln.js';

// I1 — feste Sammler und ihre Parser (Ausgaben wie auf Debian 12 / Docker 27)
describe('I1 Sammler', () => {
  it('alle festen Befehle laufen als Lesebefehl (ohne Käfig)', () => {
    for (const b of [...Object.values(LINUX_BEFEHLE), composeBefehl(['homeassistant', 'synapse'])]) expect(befehlsklasse(b), b).toBe('lesen');
  });
  it('Betriebssystem, RAM, Dateisysteme', () => {
    expect(leseOs('PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_ID="12"')).toEqual({ name: 'Debian GNU/Linux 12 (bookworm)', id: 'debian', version: '12' });
    expect(leseRam('               total        used        free\nMem:     16768368640  9123456000  1234\nSwap: 0 0 0')).toEqual({ gesamt: 16768368640, belegt: 9123456000 });
    const df = leseDf('Filesystem Type Size Used Avail Use% Mounted on\nudev devtmpfs 7.8G 0 7.8G 0% /dev\n/dev/sda1 ext4 98G 81G 13G 87% /\ntmpfs tmpfs 1.6G 1M 1.6G 1% /run\n/dev/sdb1 ext4 492G 120G 347G 26% /data');
    expect(df).toEqual([{ mount: '/', groesse: '98G', belegt: '81G', prozent: 87, typ: 'ext4' }, { mount: '/data', groesse: '492G', belegt: '120G', prozent: 26, typ: 'ext4' }]);
  });
  it('Dienste, Ports, Updates', () => {
    expect(leseDienste('  UNIT LOAD ACTIVE SUB DESCRIPTION\n  docker.service loaded active running Docker\n● ssh.service loaded active running OpenSSH\n  cron.service loaded active exited x')).toEqual(['docker', 'ssh']);
    const p = lesePorts('State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\nLISTEN 0 4096 0.0.0.0:8123 0.0.0.0:* users:(("docker-proxy",pid=1,fd=4))\nLISTEN 0 128 [::]:22 [::]:* users:(("sshd",pid=2,fd=3))');
    expect(p).toEqual([{ adresse: '[::]', port: 22, prozess: 'sshd' }, { adresse: '0.0.0.0', port: 8123, prozess: 'docker-proxy' }]);
    expect(leseAptUpdates('Listing...\nopenssl/stable-security 3.0.15 amd64 [upgradable from: 3.0.14]\ncurl/stable 7.88 amd64 [upgradable from: 7.87]')).toEqual({ anzahl: 2, sicherheit: 1 });
  });
  it('Docker: Container mit Gesundheit, Netzen, Mounts; Compose-Zuordnung; Projekte; Volumes', () => {
    const c = leseDocker('homeassistant\tghcr.io/home-assistant/home-assistant:stable\trunning\tUp 8 days\t\thost\t/config\nnoah-frontend\tnoah/frontend:1\trunning\tUp 8 days (unhealthy)\t0.0.0.0:3000->3000/tcp\tnoah_default\tnoah_data,/etc/localtime\nelastic_ramanujan\tbusybox\texited\tExited (255) 6 months ago\t\tbridge\t');
    expect(c).toHaveLength(3);
    expect(c[1]).toMatchObject({ name: 'noah-frontend', gesundheit: 'unhealthy', netze: ['noah_default'], mounts: ['noah_data', '/etc/localtime'] });
    expect(c[2]!.zustand).toBe('exited');
    const z = leseComposeZuordnung('/homeassistant,,\n/noah-frontend,noah,frontend');
    expect(z.get('noah-frontend')).toEqual({ projekt: 'noah', dienst: 'frontend' });
    expect(z.get('homeassistant')).toEqual({});
    expect(leseComposeLs('NAME STATUS CONFIG FILES\nnoah running(2) /opt/noah/docker-compose.yml\nmatrix running(3), exited(1) /opt/matrix/compose.yml')).toEqual([
      { name: 'noah', status: 'running(2)', dateien: '/opt/noah/docker-compose.yml' }, { name: 'matrix', status: 'running(3), exited(1)', dateien: '/opt/matrix/compose.yml' }]);
    expect(leseVolumes('Images space usage:\n\nx\n\nLocal Volumes space usage:\n\nVOLUME NAME LINKS SIZE\nnoah_data 1 1.2GB\npgdata 1 4.5GB\n\nBuild cache usage: 0B')).toEqual([{ name: 'noah_data', groesse: '1.2GB' }, { name: 'pgdata', groesse: '4.5GB' }]);
  });
  it('sammleLinux: Docker nur mit Docker-Dienst, Fehler je Teil statt Abbruch', async () => {
    const antworten: Record<string, string> = {
      [LINUX_BEFEHLE.os]: 'PRETTY_NAME="Ubuntu 24.04 LTS"\nID=ubuntu', [LINUX_BEFEHLE.dienste]: '  docker.service loaded active running Docker',
      [LINUX_BEFEHLE.docker]: 'web\tnginx:1\trunning\tUp 1 day\t\tbridge\t',
    };
    const b = await sammleLinux('dockerhost', '192.168.1.211', async (cmd) => { if (cmd in antworten) return antworten[cmd]!; if (cmd.startsWith('docker inspect')) return '/web,site,web'; throw new Error('Exit 1'); });
    expect(b.os?.name).toBe('Ubuntu 24.04 LTS');
    expect(b.container[0]).toMatchObject({ name: 'web', composeProjekt: 'site', composeDienst: 'web' });
    expect(b.fehler.length).toBeGreaterThan(0); // z. B. ram/df/ports lieferten Fehler
  });
});
