import { describe, it, expect } from 'vitest';
import { geplanteAssets, sollIst, sollIstText } from './soll-ist.js';
import type { Architektur } from './architektur.js';
import type { HostBestand } from './sammler.js';

// I4b Teil 5 — Soll/Ist
const GiB = 1024 ** 3;
const arch: Architektur = {
  zusammenfassung: 'x', proxyDns: '', sicherung: 's', updates: 'u', firewall: [], risiken: [], offeneEntscheidungen: [],
  netze: [{ name: 'Docker-Dev', vlan: 824, geraet: 'unifi', zweck: 'Dev', neu: true }],
  gruppen: [
    { name: 'Entwicklung', zweck: 'z', begruendung: 'b', einheiten: ['wp-dev', 'pgadmin'], ziel: 'vm', vmName: 'docker-dev-01', knoten: 'pve3', vcpu: 4, ramGb: 8, diskGb: 160, distribution: 'ubuntu-24.04', netz: 'Docker-Dev' },
    { name: 'Hausautomation', zweck: 'z', begruendung: 'b', einheiten: ['dockerhost', 'ha'], ziel: 'bleibt' },
    { name: 'Alt', zweck: 'z', begruendung: 'b', einheiten: ['iobroker'], ziel: 'stilllegen' },
  ],
  reihenfolge: [{ gruppe: 'Entwicklung' }],
};
const host = (zugang: string, ip: string, cs: Array<[string, string, string?]>): HostBestand => ({ zugang, host: ip, dateisysteme: [], dienste: [], ports: [], fehler: [], compose: [], volumes: [],
  container: cs.map(([name, projekt, ports]) => ({ name, image: 'x', zustand: 'running', status: 'Up', ports: ports ?? '', netze: [], mounts: [], composeProjekt: projekt })) });

describe('I4b Soll/Ist', () => {
  it('vor der Migration: VM und Netz fehlen, Dienste noch alt; bleibt/stilllegen bewertet', () => {
    const r = sollIst({ architektur: arch, vms: [], zugaenge: [{ name: 'dockerhost', host: '192.168.1.211' }], netze: [], proxy: [],
      hosts: [host('dockerhost', '192.168.1.211', [['wp', 'wp-dev', '0.0.0.0:8080->80/tcp'], ['pga', 'pgadmin'], ['homeassistant', 'ha'], ['iobroker', 'iobroker']])], quellHosts: ['dockerhost'] });
    const t = sollIstText('Dockerhost aufteilen', r);
    expect(t).toContain('· VM docker-dev-01 fehlt noch (geplant auf pve3)');
    expect(t).toContain('· Netz Docker-Dev (VLAN 824, unifi) fehlt noch');
    expect(t).toContain('· wp-dev noch auf dockerhost');
    expect(t).toContain('✓ ha läuft wie geplant weiter');
    expect(t).toContain('· iobroker läuft noch');
    expect(r.erfuellt).toBe(1);
  });
  it('nach der Migration: VM auf pve3 mit Größe, VLAN da, Dienste neu, Proxy umgestellt', () => {
    const r = sollIst({ architektur: arch, quellHosts: ['dockerhost'],
      vms: [{ assetId: 'v1', name: 'docker-dev-01', node: 'pve3', status: 'active', ip: '10.203.24.5', cpus: 4, ramBytes: 8 * GiB }],
      zugaenge: [{ name: 'dockerhost', host: '192.168.1.211' }, { name: 'docker-dev-01', host: '10.203.24.5' }],
      netze: [{ quelle: 'unifi', name: 'Docker-Dev', vlan: 824 }],
      proxy: [{ domains: ['wp.dev.at'], forwardHost: '10.203.24.5', forwardPort: 8080 }],
      hosts: [host('dockerhost', '192.168.1.211', [['homeassistant', 'ha']]), host('docker-dev-01', '10.203.24.5', [['wp', 'wp-dev', '0.0.0.0:8080->80/tcp'], ['pga', 'pgadmin']])] });
    expect(r.abweichungen).toEqual(['Alt: iobroker nirgends laufend gefunden'.replace('nirgends laufend gefunden', 'stillgelegt')].filter(() => false));
    expect(r.erfuellt).toBe(r.gesamt);
    expect(sollIstText('x', r)).toContain('✓ Proxy wp.dev.at → docker-dev-01');
  });
  it('geplante Assets je neuer VM', () => {
    expect(geplanteAssets('v-1', arch)).toEqual([{ name: 'docker-dev-01', assetType: 'vm', sourceId: 'vorhaben:v-1:docker-dev-01', attributes: expect.objectContaining({ knoten: 'pve3', vcpu: 4, ramGb: 8, netz: 'Docker-Dev' }) }]);
  });
});
