import { describe, it, expect } from 'vitest';
import { auffaelligkeiten, bestandsbericht, osSupport } from './bericht.js';
import type { HostBestand } from './sammler.js';

// I1 — Bestandsbericht und feste Regeln für Auffälligkeiten
const jetzt = new Date('2026-10-22T10:00:00Z');
const host = (teil: Partial<HostBestand>): HostBestand => ({ zugang: 'dockerhost', host: '192.168.1.211', dateisysteme: [], dienste: [], ports: [], container: [], compose: [], volumes: [], fehler: [], ...teil });

describe('I1 Bestandsbericht', () => {
  it('Betriebssystem-Support (Stand 10/2026)', () => {
    expect(osSupport({ name: 'Debian 11', id: 'debian', version: '11' }, jetzt).ok).toBe(false);
    expect(osSupport({ name: 'Debian 12', id: 'debian', version: '12' }, jetzt).ok).toBe(true);
    expect(osSupport({ name: 'Ubuntu 20.04', id: 'ubuntu', version: '20.04' }, jetzt).ok).toBe(false);
    expect(osSupport({ name: 'Ubuntu 24.04', id: 'ubuntu', version: '24.04' }, jetzt).ok).toBe(true);
    expect(osSupport({ name: 'Ubuntu 25.04', id: 'ubuntu', version: '25.04' }, jetzt)).toMatchObject({ ok: false, text: expect.stringContaining('keine LTS') });
  });
  it('Regeln: unhealthy, Platte, Updates, Sicherung, Proxy ohne Dienst — nach Schwere sortiert', () => {
    const a = auffaelligkeiten({
      hosts: [host({
        container: [
          { name: 'noah-frontend', image: 'x', zustand: 'running', status: 'Up 8 days (unhealthy)', gesundheit: 'unhealthy', ports: '', netze: [], mounts: [] },
          { name: 'elastic_ramanujan', image: 'busybox', zustand: 'exited', status: 'Exited (255) 6 months ago', ports: '', netze: [], mounts: [] },
          { name: 'job', image: 'x', zustand: 'exited', status: 'Exited (0) 2 days ago', ports: '', netze: [], mounts: [] },
        ],
        dateisysteme: [{ mount: '/', groesse: '98G', belegt: '90G', prozent: 92 }], updates: { anzahl: 12, sicherheit: 3 },
        ports: [{ adresse: '0.0.0.0', port: 8123 }],
      })],
      vms: [{ name: 'dsc01t', typ: 'vm', status: 'active', vmid: 106 }, { name: 'workVM', typ: 'vm', status: 'active', vmid: 100 }, { name: 'alt', typ: 'vm', status: 'inactive', vmid: 200 }],
      proxy: [{ domains: ['ha.example.at'], forwardHost: '192.168.1.211', forwardPort: 8123 }, { domains: ['tot.example.at'], forwardHost: '192.168.1.211', forwardPort: 9999 }],
      backups: { jeVm: { 106: { neueste: '2026-01-10T01:10:22Z', anzahl: 1, speicher: ['backupshare'] }, 100: { anzahl: 0, speicher: [] } }, ohne: [{ vmid: 100, name: 'workVM' }, { vmid: 200, name: 'alt' }], unerreichbar: [{ speicher: 'pbs-unas', grund: 'nicht aktiv (nicht erreichbar)' }] },
    }, jetzt);
    const t = a.map(x => `${x.schwere}|${x.text}`);
    expect(t).toEqual(expect.arrayContaining([
      'hoch|Container noah-frontend ist unhealthy (Up 8 days (unhealthy))',
      'niedrig|Container elastic_ramanujan beendet mit Fehler (Exited (255) 6 months ago) — aufräumen oder reparieren',
      'mittel|/ zu 92 % belegt (90G von 98G)',
      'mittel|3 Sicherheitsupdates offen (12 Updates gesamt)',
      'hoch|Backup-Speicher pbs-unas nicht aktiv (nicht erreichbar)',
      'hoch|VM/CT 100 (workVM) hat keine Sicherung',
      'mittel|tot.example.at → 192.168.1.211:9999: auf dockerhost lauscht dort kein Dienst',
    ]));
    expect(t.some(x => x.includes('VM/CT 106') && x.includes('vor 285 Tagen'))).toBe(true);
    expect(t.some(x => x.includes('job'))).toBe(false); // sauber beendet (Exit 0)
    expect(t.some(x => x.includes('VM/CT 200'))).toBe(false); // ausgeschaltet
    expect(a[0]!.schwere).toBe('hoch');
  });
  it('Bericht enthält Überblick, Hosts mit Container-Tabelle, VMs, Netze, Proxy', () => {
    const r = bestandsbericht({
      hosts: [host({ os: { name: 'Ubuntu 24.04 LTS', id: 'ubuntu', version: '24.04' }, container: [{ name: 'synapse', image: 'matrixdotorg/synapse', zustand: 'running', status: 'Up', gesundheit: 'healthy', ports: '', netze: ['matrix'], mounts: ['synapse_data'], composeProjekt: 'matrix', composeDienst: 'synapse' }] })],
      vms: [{ name: 'docker-host', typ: 'vm', status: 'active', vmid: 120, node: 'pve', ip: '192.168.1.211' }], proxy: [{ domains: ['matrix.example.at'], forwardHost: '192.168.1.211', forwardPort: 8008 }],
      netze: [{ quelle: 'unifi', name: 'Default', subnet: '192.168.1.0/24' }, { quelle: 'pfsense', name: 'IoT', vlan: 30 }],
    }, jetzt);
    for (const s of ['# Bestandsbericht', '## Auffälligkeiten', '## Host dockerhost (192.168.1.211)', '| synapse | matrixdotorg/synapse | running (healthy) | matrix/synapse | matrix | synapse_data |', '## Proxmox VMs/Container', '**pfsense:** IoT (VLAN 30)', 'matrix.example.at → 192.168.1.211:8008']) expect(r.markdown).toContain(s);
    expect(r.kurz).toContain('1 Container');
  });
});

describe('I1 Nachschärfung nach dem ersten Lauf (22.10.)', () => {
  it('gestörte Paketverwaltung ist ein Befund; Containername „vaultwarden“ ist kein Geheimnis-Pfad', async () => {
    const a = auffaelligkeiten({ hosts: [host({ fehler: ['updates: Exit 100: E: Problem with MergeList /var/lib/apt/lists/download.docker.com_linux_ubuntu_dists_jammy_stable_binary-amd64_Packages', 'ram: Exit 1'] })], vms: [], proxy: [] }, jetzt);
    expect(a.map(x => x.text)).toEqual(expect.arrayContaining([expect.stringContaining('Paketverwaltung gestört'), 'Nicht erfasst: ram']));
    const { geheimnisGrund } = await import('../fernzugriff/kaefig.js');
    const { composeBefehl } = await import('./sammler.js');
    expect(geheimnisGrund(composeBefehl(['vaultwarden', 'mariadb-vaultwarden', 'synapse']))).toBeUndefined();
    expect(geheimnisGrund('cat /opt/vaultwarden/data/db.sqlite3')).toBeDefined();
    expect(geheimnisGrund('ls /srv/secrets/')).toBeDefined();
  });
});

describe('I4b Teil 3 — Befunde als Problems', () => {
  it('nur hoch/mittel ohne Sicherung, ohne Doppelte, verschwundene Befunde nur bei vollständiger Erfassung lösen', async () => {
    const { befundeAlsProblems } = await import('./befund-problems.js');
    const a = auffaelligkeiten({
      hosts: [host({ container: [{ name: 'noah', image: 'x', zustand: 'running', status: 'Up (unhealthy)', gesundheit: 'unhealthy', ports: '', netze: [], mounts: [] }], dateisysteme: [{ mount: '/', groesse: '98G', belegt: '96G', prozent: 98 }], fehler: ['ram: Exit 1'] })],
      vms: [{ name: 'vm', typ: 'vm', status: 'active', vmid: 1 }], proxy: [],
      backups: { jeVm: {}, ohne: [{ vmid: 1, name: 'vm' }], unerreichbar: [] },
    }, jetzt);
    const db: Array<{ id: string; title: string; status: string; detectionMethod?: string }> = [{ id: 'p-alt', title: 'alt', status: 'logged', detectionMethod: 'infrastruktur-bestand:platte:anderer:/' }, { id: 'p-weg', title: 'weg', status: 'logged', detectionMethod: 'infrastruktur-bestand:container-unhealthy:dockerhost:alt' }];
    const geloest: string[] = [];
    const z = { liste: async () => db, anlegen: async (d: { title: string; detectionMethod: string }) => { const id = `p${db.length}`; db.push({ id, title: d.title, status: 'logged', detectionMethod: d.detectionMethod }); return id; }, loese: async (id: string) => { geloest.push(id); } };
    // dockerhost mit Erfassungsfehler → nichts von ihm als gelöst markieren
    const r1 = await befundeAlsProblems(a, z, { docId: 'd', datum: 'heute' }, { hosts: new Set(), alle: false });
    expect(r1.neu.length).toBe(2); // unhealthy + Platte; Sicherung und „Nicht erfasst“ nicht
    expect(db.filter(p => p.title.includes('Sicherung'))).toEqual([]);
    expect(geloest).toEqual([]);
    const r2 = await befundeAlsProblems(a, z, { docId: 'd', datum: 'heute' }, { hosts: new Set(['dockerhost']), alle: false });
    expect(r2).toMatchObject({ neu: [], bekannt: 2 });
    expect(geloest).toEqual(['p-weg']); // anderer Host nicht erfasst → p-alt bleibt
  });
});
