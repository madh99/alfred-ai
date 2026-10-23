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
  it('v1623 Realfall 23.10.: VM-Asset ohne IP → Zugang über den Namen, Dienste und Proxy werden erkannt', () => {
    const r = sollIst({ architektur: arch, quellHosts: ['dockerhost'],
      vms: [{ assetId: 'v1', name: 'docker-dev-01', node: 'pve3', status: 'active', cpus: 4, ramBytes: 8 * GiB }],
      zugaenge: [{ name: 'dockerhost', host: '192.168.1.211' }, { name: 'docker-dev-01', host: '10.203.24.2' }],
      netze: [{ quelle: 'unifi', name: 'Docker-Dev', vlan: 824 }],
      proxy: [{ domains: ['wp.dev.at'], forwardHost: '10.203.24.2', forwardPort: 8080 }],
      hosts: [host('dockerhost', '192.168.1.211', [['homeassistant', 'ha']]), host('docker-dev-01', '10.203.24.2', [['wp', 'wp-dev', '0.0.0.0:8080->80/tcp'], ['pga', 'pgadmin']])] });
    expect(r.abweichungen).toEqual([]);
    expect(sollIstText('x', r)).toContain('✓ wp-dev läuft auf docker-dev-01');
    expect(sollIstText('x', r)).toContain('✓ Proxy wp.dev.at → docker-dev-01');
  });
  it('v1623 Realfall pgAdmin: Einheit „pgadmin4“ läuft am Ziel als Projekt „pgadmin“ mit demselben Image → erkannt; fremdes Image nicht', () => {
    const a: Architektur = { ...arch, gruppen: [{ ...arch.gruppen[0]!, einheiten: ['pgadmin4', 'postgreDEV'] }] };
    const alt: HostBestand = { ...host('dockerhost', '192.168.1.211', []), container: [
      { name: 'pgadmin4-pgadmin-1', image: 'dpage/pgadmin4:latest', zustand: 'exited', status: 'Exited', ports: '', netze: [], mounts: [], composeProjekt: 'pgadmin4' },
      { name: 'postgreDEV', image: 'postgres:15', zustand: 'running', status: 'Up', ports: '', netze: [], mounts: [], composeProjekt: 'postgreDEV' }] };
    const neu: HostBestand = { ...host('docker-dev-01', '10.203.24.2', []), container: [
      { name: 'pgadmin-pilot', image: 'dpage/pgadmin4:latest@sha256:abc', zustand: 'running', status: 'Up', ports: '', netze: [], mounts: [], composeProjekt: 'pgadmin' },
      { name: 'andere-db', image: 'postgres:15', zustand: 'running', status: 'Up', ports: '', netze: [], mounts: [], composeProjekt: 'andere' }] };
    const r = sollIst({ architektur: a, quellHosts: ['dockerhost'], vms: [{ assetId: 'v1', name: 'docker-dev-01', node: 'pve3', status: 'active', cpus: 4, ramBytes: 8 * GiB }],
      zugaenge: [{ name: 'dockerhost', host: '192.168.1.211' }, { name: 'docker-dev-01', host: '10.203.24.2' }], netze: [{ quelle: 'unifi', name: 'Docker-Dev', vlan: 824 }], proxy: [], hosts: [alt, neu] });
    const t = sollIstText('x', r);
    expect(t).toContain('✓ pgadmin4 läuft auf docker-dev-01');
    expect(t).toContain('· postgreDEV noch auf dockerhost');
  });
  it('geplante Assets je neuer VM', () => {
    expect(geplanteAssets('v-1', arch)).toEqual([{ name: 'docker-dev-01', assetType: 'vm', sourceId: 'vorhaben:v-1:docker-dev-01', attributes: expect.objectContaining({ knoten: 'pve3', vcpu: 4, ramGb: 8, netz: 'Docker-Dev' }) }]);
  });
});

describe('I4b Soll/Ist — bleibt (Realfall: gestoppte Altbestände)', () => {
  it('gestoppte Container in „bleibt“ sind erfüllt, fehlende nicht', () => {
    const a: Architektur = { ...arch, gruppen: [{ name: 'Alt', zweck: 'z', begruendung: 'b', einheiten: ['iobroker', 'weg'], ziel: 'bleibt' }], netze: [], reihenfolge: [] };
    const h = host('dockerhost', '192.168.1.211', [['iobroker', 'iobroker']]);
    h.container[0]!.zustand = 'exited';
    const r = sollIst({ architektur: a, vms: [], zugaenge: [], netze: [], proxy: [], hosts: [h], quellHosts: ['dockerhost'] });
    expect(r.gruppen[0]!.punkte).toEqual([{ ok: true, text: 'iobroker bleibt wie geplant (gestoppt)' }, { ok: false, text: 'weg ist am bisherigen Ort nicht mehr vorhanden' }]);
  });
});
