import { describe, it, expect } from 'vitest';
import { architekturDokument, grundlageText, hostPorts, planungsGrundlage, pruefeArchitektur } from './architektur.js';
import { groesseBytes, leseStats, LINUX_BEFEHLE } from './sammler.js';
import { befehlsklasse } from '../fernzugriff/regeln.js';
import type { HostBestand } from './sammler.js';

// I2 — Planungsgrundlage, deterministische Prüfung der Architektur, Dokument nach fester Vorlage
const GiB = 1024 ** 3;
const dockerhost: HostBestand = {
  zugang: 'dockerhost', host: '192.168.1.211', os: { name: 'Ubuntu 22.04.5 LTS', id: 'ubuntu', version: '22.04' }, cpus: 8, ram: { gesamt: 32 * GiB, belegt: 20 * GiB },
  dateisysteme: [], dienste: ['docker'], ports: [{ adresse: '0.0.0.0', port: 22 }], fehler: [], erfasst: '2026-10-22T03:00:00Z',
  container: [
    { name: 'synapse', image: 'matrixdotorg/synapse:latest', zustand: 'running', status: 'Up 3 days (healthy)', gesundheit: 'healthy', ports: '0.0.0.0:8008->8008/tcp, :::8008->8008/tcp', netze: ['matrix_default'], mounts: ['matrix_data'], composeProjekt: 'matrix', composeDienst: 'synapse', ramBytes: 900 * 1024 ** 2 },
    { name: 'matrix-db', image: 'postgres:16', zustand: 'running', status: 'Up 3 days', ports: '', netze: ['matrix_default'], mounts: ['matrix_pg'], composeProjekt: 'matrix', composeDienst: 'db', ramBytes: 300 * 1024 ** 2 },
    { name: 'homeassistant', image: 'ghcr.io/home-assistant/home-assistant:stable', zustand: 'running', status: 'Up 2 days', ports: '', netze: ['host'], mounts: ['/opt/ha/config'], composeProjekt: 'ha', ramBytes: 1.2 * GiB },
    { name: 'dashy', image: 'lissy93/dashy', zustand: 'running', status: 'Up 1 day', ports: '0.0.0.0:4000->8080/tcp', netze: ['bridge'], mounts: [], ramBytes: 80 * 1024 ** 2 },
  ],
  compose: [], volumes: [{ name: 'matrix_data', groesse: '12.5GB' }, { name: 'matrix_pg', groesse: '3.1GB' }],
};
const grundlage = () => planungsGrundlage({
  hosts: [dockerhost],
  knoten: [{ name: 'pve', online: true, cpus: 32, ramGesamt: 128 * GiB, ramBelegt: 100 * GiB }, { name: 'pve1', online: true, cpus: 16, ramGesamt: 64 * GiB, ramBelegt: 60 * GiB }],
  speicher: [{ name: 'local-zfs', typ: 'zfspool', gesamt: 1000 * GiB, belegt: 400 * GiB }],
  netze: [{ quelle: 'unifi', name: 'Default', vlan: 1, subnet: '192.168.1.0/24' }, { quelle: 'unifi', name: 'IoT', vlan: 20 }],
  proxy: [{ domains: ['matrix.example.at'], forwardHost: '192.168.1.211', forwardPort: 8008 }, { domains: ['ha.example.at'], forwardHost: '192.168.1.211', forwardPort: 8123 }],
  vms: [{ name: 'docker-host', typ: 'vm', status: 'active', vmid: 120 }],
});
const gueltig = () => ({
  zusammenfassung: 'Der dockerhost trägt alle Dienste; Matrix bekommt eine eigene VM im Server-VLAN, der Rest bleibt vorerst.',
  gruppen: [
    { name: 'Matrix', zweck: 'Chat-Server', begruendung: 'größter Datenbestand, eigenes Wartungsfenster', einheiten: ['matrix'], ziel: 'vm', vmName: 'matrix', knoten: 'PVE', vcpu: 2, ramGb: 4, diskGb: 60, speicher: 'local-zfs', distribution: 'debian-12', distributionBegruendung: 'langer Support, Docker-Pakete offiziell', netz: 'Server' },
    { name: 'Rest', zweck: 'bleibt vorerst', begruendung: 'später', einheiten: ['ha', 'Dashy'], ziel: 'bleibt' },
    { name: 'Alt', zweck: 'Altsystem', begruendung: 'nach Migration', einheiten: ['dockerhost'], ziel: 'bleibt' },
  ],
  netze: [{ name: 'Server', vlan: 30, subnetz: '192.168.30.0/24', geraet: 'unifi', zweck: 'Server-Dienste', neu: true }],
  firewall: [{ von: 'Server', nach: 'internet', erlaubt: 'ausgehend 443', begruendung: 'Updates, Föderation' }],
  proxyDns: 'NPM-Ziel auf die neue IP umstellen.', sicherung: 'Snapshot vor jedem Change, PBS täglich.', updates: 'unattended-upgrades an.',
  reihenfolge: [{ gruppe: 'Matrix', ausfallMinuten: 20 }],
  risiken: [{ risiko: 'Datenbank inkonsistent', massnahme: 'Dienst stoppen vor letztem Abgleich' }],
  offeneEntscheidungen: ['VLAN-ID 30 bestätigen'],
});

describe('I2 Planungsgrundlage', () => {
  it('Ports, Größen und docker stats', () => {
    expect(hostPorts('0.0.0.0:8008->8008/tcp, :::8008->8008/tcp, 127.0.0.1:5432->5432/tcp')).toEqual([5432, 8008]);
    expect(hostPorts('8080/tcp')).toEqual([]);
    expect(groesseBytes('12.5GB')).toBe(12_500_000_000);
    expect(groesseBytes('1.5GiB')).toBe(Math.round(1.5 * GiB));
    expect(groesseBytes('0B')).toBe(0);
    expect(leseStats('synapse,1.20%,900MiB / 31.3GiB\ndashy,0.00%,80MiB / 31.3GiB').get('synapse')).toEqual({ cpuProzent: 1.2, ramBytes: 900 * 1024 ** 2 });
    expect(befehlsklasse(LINUX_BEFEHLE.stats)).toBe('lesen');
  });
  it('Einheiten: Compose-Projekte, einzelne Container, Host; Proxy über veröffentlichte Ports, Rest ohne Zuordnung', () => {
    const g = grundlage();
    expect(g.einheiten.map(e => `${e.art}:${e.name}`)).toEqual(['compose:matrix', 'compose:ha', 'container:dashy', 'host:dockerhost']);
    const m = g.einheiten[0]!;
    expect(m.ports).toEqual([8008]);
    expect(m.proxy).toEqual(['matrix.example.at']);
    expect(m.datenBytes).toBe(15_600_000_000);
    expect(m.ramBytes).toBe(1200 * 1024 ** 2);
    expect(g.einheiten[1]!.bindMounts).toEqual(['/opt/ha/config']);
    expect(g.proxyOhneZuordnung).toEqual(['ha.example.at → 192.168.1.211:8123']);
    expect(grundlageText(g)).toContain('| matrix | compose | dockerhost |');
  });
});

describe('I2 Architektur prüfen', () => {
  it('gültige Architektur: keine Fehler, Namen wie im Bestand, Hinweis auf knappen Knoten', () => {
    const p = pruefeArchitektur(gueltig(), grundlage());
    expect(p.fehler).toEqual([]);
    expect(p.architektur.gruppen[0]!.knoten).toBe('pve');
    expect(p.architektur.gruppen[1]!.einheiten).toEqual(['ha', 'dashy']);
    expect(p.hinweise).toEqual([]);
  });
  it('fehlende Zuordnung, doppelte Einheit, unbekannte Namen, ungültige Größen und fehlende Reihenfolge werden abgewiesen', () => {
    const a = gueltig() as Record<string, any>;
    a.gruppen[1].einheiten = ['ha', 'matrix', 'gibtsnicht'];
    a.gruppen.push({ name: 'Neu', zweck: 'x', begruendung: 'y', einheiten: ['dashy'], ziel: 'lxc', vmName: 'docker-host', knoten: 'pve9', vcpu: 0, ramGb: 1, diskGb: 2, distribution: 'windows-server-2022', distributionBegruendung: 'z', netz: 'Gibtsnicht' });
    a.netze.push({ name: 'Doppelt', vlan: 20, geraet: 'unifi', zweck: 'x', neu: true });
    a.reihenfolge = [];
    const f = pruefeArchitektur(a, grundlage()).fehler.join('\n');
    expect(f).toContain('Einheit „matrix“ ist zwei Gruppen zugeordnet');
    expect(f).toContain('Einheit „gibtsnicht“ gibt es im Bestand nicht');
    expect(f).toContain('VM-Name „docker-host“ ist bereits vergeben');
    expect(f).toContain('Knoten „pve9“ unbekannt');
    expect(f).toContain('vcpu 1–64');
    expect(f).toContain('diskGb 4–8192');
    expect(f).toContain('Windows geht nicht als LXC');
    expect(f).toContain('Netz „Gibtsnicht“ ist weder vorhanden noch unter netze geplant');
    expect(f).toContain('VLAN 20 ist bereits vergeben (IoT/unifi)');
    expect(f).toContain('reihenfolge: es fehlen die Gruppen Matrix, Neu');
    const leer = pruefeArchitektur({}, grundlage()).fehler.join('\n');
    expect(leer).toContain('zusammenfassung fehlt');
    expect(leer).toContain('Nicht zugeordnete Einheiten');
    expect(leer).toContain('risiken fehlt');
  });
  it('Hinweise: zu wenig RAM/Disk gegenüber Messung, Knoten ohne Reserve, Host stilllegen erst nach 7 Tagen', () => {
    const a = gueltig() as Record<string, any>;
    a.gruppen[0].ramGb = 1; a.gruppen[0].diskGb = 20; a.gruppen[0].knoten = 'pve1'; a.gruppen[0].ramGb = 1;
    a.gruppen[2].ziel = 'stilllegen';
    const h = pruefeArchitektur(a, grundlage()).hinweise.join('\n');
    expect(h).toContain('1 GB RAM sind knapp');
    expect(h).toContain('20 GB Disk sind knapp');
    expect(h).toContain('frühestens 7 Tage');
    a.gruppen[0].ramGb = 8;
    expect(pruefeArchitektur(a, grundlage()).hinweise.join('\n')).toContain('Knoten pve1: geplant 8,0 GB RAM, frei nur 4,0 GB');
  });
});

describe('I2 Architektur-Dokument', () => {
  it('feste Pflichtabschnitte, Zahlen aus dem Bestand, umzustellende Proxy-Einträge', () => {
    const g = grundlage();
    const p = pruefeArchitektur(gueltig(), g);
    const md = architekturDokument({ titel: 'Dockerhost aufteilen', ziel: 'prüfe, was man auf neue Docker-VMs verteilen könnte', id: 'abcdef12-0000', version: 1, bestandDocId: 'doc-b' }, p.architektur, g, p.hinweise, new Date('2026-10-22T10:00:00Z'));
    for (const t of ['# Zielarchitektur: Dockerhost aufteilen (Version 1)', '**Vorschlag — nichts ausgeführt.**', '## 1. Ausgangslage und Ziel', '## 2. Zielbild', '## 3. Gruppen im Einzelnen', '## 4. Netze, VLANs und Firewall', '## 5. Reverse-Proxy und DNS', '## 6. Ressourcen je Proxmox-Knoten', '## 7. Sicherung', '## 8. Updates', '## 9. Migrationsreihenfolge', '## 10. Risiken', '## 11. Offene Entscheidungen des Owners', '## 12. Prüfhinweise', '## Nächster Schritt'])
      expect(md).toContain(t);
    expect(md).toContain('| Matrix | VM matrix auf pve | 2 vCPU, 4 GB RAM, 60 GB (local-zfs) | debian-12 | Server | matrix |');
    expect(md).toContain('- matrix.example.at → neu matrix (Gruppe Matrix)');
    expect(md).toContain('Ohne eindeutige Zuordnung (manuell prüfen): ha.example.at → 192.168.1.211:8123');
    expect(md).toContain('| pve | 128 GB | 100 GB | 4,0 GB | 24 GB |');
    expect(md).toContain('1. **Matrix** — erwartete Ausfallzeit 20 min');
    expect(md).toContain('mindestens 7 Tage');
  });
});
