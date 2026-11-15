import { describe, it, expect } from 'vitest';
import type { CmdbAsset, CmdbAssetRelation, CmdbChangeRequest, CmdbProblem } from '@alfred/types';
import { baueBetrieb } from './betrieb-builder.js';
import { betriebQuellen, ordneNetzBestand, sammleBetrieb, type BetriebQuellenDeps, type Gesammelt, type NetzBestand } from './betrieb-quellen.js';
import { pruefeDokument } from './arten.js';
import { alsMarkdown } from './markdown.js';
import type { BetriebParameter } from './betrieb-parameter.js';
import type { Block, Dokument } from './modell.js';

// Fixtures nach dem PKI-Bestand (15.11.): pkiroot01 netzlos ohne Agent, pkiiss01, fs01, dc01, dc02 — je VM (proxmox) + Server (fernzugriff)
const JETZT = '2026-11-15T12:00:00.000Z';
const STAND = '2026-11-15T11:59:00.000Z';
const GiB = 1024 ** 3;

function asset(id: string, name: string, assetType: 'vm' | 'server', extra: Partial<CmdbAsset> = {}): CmdbAsset {
  return {
    id, userId: 'u', assetType, name, sourceSkill: assetType === 'vm' ? 'proxmox' : 'fernzugriff', status: 'active', attributes: {},
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-15T05:31:00.000Z', ...extra,
  } as CmdbAsset;
}
const vm = (id: string, name: string, vmid: number, ip?: string, extra: Partial<CmdbAsset> = {}) =>
  asset(id, name, 'vm', { ...(ip ? { ipAddress: ip } : {}), attributes: { vmid, node: 'pve', cpus: 2, maxmem: 4 * GiB, maxdisk: 60 * GiB }, ...extra });
const srv = (id: string, name: string, ip: string, roles: string[]) =>
  asset(id, name, 'server', { ipAddress: ip, attributes: { os: 'Microsoft Windows Server 2025 Standard', os_version: '10.0.26100', roles, domain: 'ad.3033.at', license_status: 'testversion', license_expires: '2027-05-01', services: 112, cpus: 2, ram_total: 4 * GiB } });

const ASSETS: CmdbAsset[] = [
  vm('a-root-vm', 'pkiroot01', 820, undefined, { status: 'inactive' }),
  vm('a-iss-vm', 'pkiiss01', 821, '10.203.29.10'), srv('a-iss-srv', 'pkiiss01', '10.203.29.10', ['ADCS-Cert-Authority']),
  vm('a-fs-vm', 'fs01', 822, '10.203.29.12'), srv('a-fs-srv', 'fs01', '10.203.29.12', ['FS-FileServer']),
  vm('a-dc1-vm', 'dc01', 823, '10.203.29.4'), srv('a-dc1-srv', 'dc01', '10.203.29.4', ['AD-Domain-Services', 'DNS']),
  vm('a-dc2-vm', 'dc02', 824, '10.203.29.5'), srv('a-dc2-srv', 'dc02', '10.203.29.5', ['AD-Domain-Services', 'DNS']),
];
const P: BetriebParameter = { assets: ASSETS.map(a => a.id), vorhabenId: 'vh-pki-1', architekturDocId: 'arch1234-0000', jobs: ['pki-betrieb'], standardVorlagen: ['k'], restoreChangeId: 'rest5678-0000' };

function change(id: string, title: string, nSchritte: number, extra: Partial<CmdbChangeRequest> = {}): CmdbChangeRequest {
  const schritte = Array.from({ length: nSchritte }, (_, i) => ({ nr: i + 1, titel: `Schritt ${i + 1} von ${title}`, art: 'aktion', skill: 'windows_pki', aktion: 'pruefen', pruefung: { typ: 'ausgabe', erwartet: 'OK' }, zeitlimitS: 60, beiFehler: 'anhalten' }));
  return {
    id, userId: 'u', title, type: 'normal', status: 'completed', riskLevel: 'low', affectedAssetIds: ['a-iss-vm'], affectedServiceIds: [], schritte,
    createdAt: '2026-11-10T08:00:00.000Z', updatedAt: '2026-11-10T09:00:00.000Z', completedAt: '2026-11-10T09:00:00.000Z',
    lauf: { phase: 'fertig', schritt: nSchritte, start: '2026-11-10T08:10:00.000Z', ende: '2026-11-10T09:00:00.000Z', ergebnisse: schritte.map(s => ({ nr: s.nr, ok: true })), verlauf: [] },
    ...extra,
  } as CmdbChangeRequest;
}
const aufbau = change('aufb1234-0000', 'PKI aufbauen', 3, {
  lauf: { phase: 'fertig', schritt: 3, start: '2026-11-10T08:10:00.000Z', ergebnisse: [], verlauf: [
    { zeit: '2026-11-10T08:20:00.000Z', art: 'halt', schritt: 2, text: 'Prüfung gescheitert' },
    { zeit: '2026-11-10T08:25:00.000Z', art: 'wiederholen', schritt: 2, text: 'Owner: wiederholen' },
  ] },
});
const restore = change('rest5678-0000', 'Restore-Probe pkiiss01', 2, { createdAt: '2026-11-12T08:00:00.000Z', completedAt: '2026-11-12T09:00:00.000Z', result: 'Restore ok, Dienst antwortet' });
const SUMME = 'a'.repeat(64);
const problem = { id: 'prob0001-0000', userId: 'u', title: 'Sperrliste läuft in 10 Tagen ab', status: 'logged', priority: 'medium', affectedAssetIds: ['a-iss-srv'], affectedServiceIds: [], linkedIncidentIds: [], isKnownError: false, detectedBy: 'auto', detectedAt: '2026-11-14T06:00:00.000Z', createdAt: '2026-11-14T06:00:00.000Z', updatedAt: '2026-11-14T06:00:00.000Z' } as CmdbProblem;
const rel = (id: string, s: string, t: string, relationType: CmdbAssetRelation['relationType']) => ({ id, userId: 'u', sourceAssetId: s, targetAssetId: t, relationType, autoDiscovered: true, attributes: {}, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }) as CmdbAssetRelation;

const leererNetzBestand: NetzBestand = { stand: { pfsense: '2026-11-15T04:31:00.000Z', mikrotik: 'keine Daten erfasst', nginx_proxy_manager: '2026-11-15T04:31:00.000Z', cloudflare_dns: '2026-11-15T04:31:00.000Z' }, firewallRegeln: [], netze: [], proxyHosts: [], dnsEintraege: [] };

function gesammelt(): Gesammelt {
  return {
    assets: { stand: STAND, daten: { gefunden: ASSETS, fehlend: [] } },
    beziehungen: { stand: STAND, daten: { relationen: [rel('r1', 'a-iss-vm', 'a-pve', 'hosted_on'), rel('r2', 'a-iss-srv', 'a-dc1-srv', 'depends_on'), rel('r3', 'a-app', 'a-fs-srv', 'depends_on')], fremde: { 'a-pve': { name: 'pve', assetType: 'server', status: 'active' }, 'a-app': { name: 'finanz-app', assetType: 'application', status: 'active' } } } },
    proxmox: { stand: STAND, daten: [
      { vmid: 820, node: 'pve', name: 'pkiroot01', status: 'running', cores: 2, speicherMiB: 4096, platten: ['scsi0 local-zfs 60G'], ostype: 'win11', ips: [], agentFehler: 'Gast-Agent antwortet nicht: QEMU guest agent is not running' },
      { vmid: 821, node: 'pve2', name: 'pkiiss01', status: 'running', cores: 4, speicherMiB: 8192, platten: ['scsi0 local-zfs 80G', 'tpmstate0 local-zfs 4M'], ostype: 'win11', ips: ['10.203.29.10'] },
      { vmid: 822, node: 'pve', name: 'fs01', status: 'running', cores: 2, speicherMiB: 4096, platten: ['scsi0 local-zfs 60G'], ips: ['10.203.29.12'] },
      { vmid: 823, node: 'pve', name: 'dc01', status: 'running', cores: 2, speicherMiB: 4096, platten: ['scsi0 local-zfs 60G'], ips: ['10.203.29.4'] },
      { vmid: 824, node: 'pve2', name: 'dc02', status: 'running', cores: 2, speicherMiB: 4096, platten: ['scsi0 local-zfs 60G'], ips: ['10.203.29.5'] },
    ] },
    sicherung: { stand: STAND, daten: { jobs: [{ id: 'backup-pki', zeitplan: '21:00', speicher: 'pbs-pve2', enthaelt: [820, 821, 822], ausgenommen: [823, 824], aktiv: true, alle: false }], letzte: { 820: '2026-11-14T20:10:00.000Z', 821: '2026-11-14T20:20:00.000Z', 822: '2026-11-14T20:30:00.000Z' }, unerreichbar: [] } },
    unifi: { stand: STAND, daten: {
      zonen: [{ id: 'z1', name: 'AD', netzIds: ['n1'] }, { id: 'z2', name: 'Internal', netzIds: ['n0'] }],
      netze: [{ id: 'n1', name: 'AD-Identity', vlan: 829, subnetz: '10.203.29.0/27', zoneId: 'z1' }, { id: 'n0', name: 'Default', subnetz: '192.168.1.0/24', zoneId: 'z2' }],
      policies: [
        { id: 'pol00000001', name: 'AD-Dienste von Internal', aktiv: true, index: 1, bedingung: '', aktion: 'ALLOW', quelleZone: 'Internal', zielZone: 'AD', quelle: 'beliebig', ziel: 'Netz AD-Identity', ports: '53, 88, 389', protokoll: 'TCP/UDP', herkunft: 'USER_DEFINED' },
        { id: 'pol00000002', name: 'Updates nachts', aktiv: 'unbekannt', index: 2, bedingung: 'Zeitplan Mo–Fr 02:00–04:00', aktion: 'ALLOW', quelleZone: 'AD', zielZone: 'External', quelle: 'beliebig', ziel: 'beliebig', ports: '443', protokoll: 'TCP', herkunft: 'USER_DEFINED' },
        { id: 'pol00000003', name: 'Fremd', aktiv: true, index: 3, bedingung: '', aktion: 'BLOCK', quelleZone: 'Internal', zielZone: 'External', quelle: 'beliebig', ziel: 'beliebig', ports: 'beliebig', protokoll: 'alle', herkunft: 'USER_DEFINED' },
      ],
      dnsWeiterleitungen: [{ domain: 'ad.3033.at', server: '10.203.29.4' }, { domain: 'andere.lan', server: '192.168.1.53' }],
    } },
    tresor: { stand: STAND, daten: [{ name: 'pkiiss01-admin', herkunft: 'pki-lab', zweck: 'kennwort=Geheim123' }, { name: 'fremd-dienst', herkunft: 'manuell' }] },
    fernzugaenge: { stand: STAND, daten: [{ name: 'pkiiss01', host: '10.203.29.10', benutzer: 'alfred', status: 'aktiv', system: 'windows', cmdbAssetId: 'a-iss-srv' }, { name: 'docker01', host: '192.168.1.40', benutzer: 'madh', status: 'aktiv' }] },
    jobs: { stand: STAND, daten: [{ key: 'pki-betrieb', beschreibung: 'PKI Etappe 5 — Zertifikate, Sperrlisten, CA-Sicherungen', takt: 'täglich 06:00', letzterLauf: { start: '2026-11-15T05:00:00.000Z', ok: true } }] },
    wartung: { stand: STAND, daten: { fenster: [{ name: 'Sonntag früh', regel: 'So 02:00–05:00', art: 'fenster' }], vorlagen: [{ key: 'k', titel: 'Windows-Updates', status: 'freigegeben', letzterLauf: '2026-11-09T02:00:00.000Z' }] } },
    problems: { stand: STAND, daten: [problem] },
    changes: { stand: STAND, daten: [aufbau, restore] },
    abnahmen: { stand: STAND, daten: { [aufbau.id]: { docId: 'd0c12345-0000', version: 2, pruefsummen: [SUMME] } } },
    architektur: { stand: STAND, daten: { id: 'arch1234-0000', titel: 'PKI Architektur', version: 3 } },
    netzBestand: { stand: STAND, daten: leererNetzBestand },
  };
}

const kap = (d: Dokument, id: string) => d.kapitel.find(k => k.id === id)!;
const text = (bs: Block[]) => JSON.stringify(bs);
const nichtBelegt = (bs: Block[]) => bs.filter((b): b is Extract<Block, { art: 'nichtBelegt' }> => b.art === 'nichtBelegt');
const tabellen = (bs: Block[]) => bs.filter((b): b is Extract<Block, { art: 'tabelle' }> => b.art === 'tabelle');
const zeileMit = (bs: Block[], s: string) => tabellen(bs).flatMap(t => t.zeilen).find(z => z.includes(s));

describe('Betriebsdokument (D-BETRIEB)', () => {
  it('(a) gültig, 13 Kapitel, Kopf mit Quellen und Verweisen', () => {
    const d = baueBetrieb('pki', P, gesammelt(), { zweck: 'Zwei-stufige PKI für ad.3033.at' }, JETZT);
    expect(pruefeDokument(d)).toEqual([]);
    expect(d.kapitel).toHaveLength(13);
    expect(d.kopf.art).toBe('betrieb');
    expect(d.kopf.ordner).toBe('pki');
    expect(d.kopf.erzeugt).toBe(JETZT);
    expect(d.kopf.verweise).toEqual(expect.arrayContaining(['vorhaben:vh-pki-1', 'dokument:arch1234', 'change:aufb1234', 'change:rest5678']));
    expect(d.kopf.quellen.map(q => q.quelle)).toEqual(expect.arrayContaining(['cmdb', 'proxmox', 'sicherung', 'unifi', 'tresor', 'netzBestand']));
    // Kapitel 2: Mermaid aus Beziehungen, Verweis auf das Architektur-Dokument
    const k2 = kap(d, 'architektur').bloecke;
    const m = k2.find(b => b.art === 'mermaid') as Extract<Block, { art: 'mermaid' }>;
    expect(m.text.startsWith('graph LR')).toBe(true);
    expect(m.text).toContain('hosted_on');
    expect(m.text).toContain('"pve"');
    expect(text(k2)).toContain('PKI Architektur');
    expect(text(k2)).toContain('arch1234');
    // Kapitel 6: wovon abhängig / was davon abhängt
    expect(text(kap(d, 'abhaengigkeiten').bloecke)).toContain('finanz-app');
    expect(alsMarkdown(d)).toContain('Zwei-stufige PKI');
  });

  it('(b) Kapitel 3: Komponente aus VM + Server, pkiroot01 ohne IP, Agent-Fehler als Hinweis, Proxmox ohne Fehler im Kopf', () => {
    const d = baueBetrieb('pki', P, gesammelt(), {}, JETZT);
    const k3 = kap(d, 'komponenten').bloecke;
    const iss = zeileMit(k3, 'pkiiss01')!;
    expect(iss).toContain('821');
    expect(iss).toContain('pve2');
    expect(iss.join(' ')).toContain('Windows Server 2025');
    expect(iss.join(' ')).toContain('ADCS-Cert-Authority');
    expect(iss.join(' ')).toContain('testversion');
    // genau eine Zeile je Komponente (VM und Server gleichen Namens zusammengefasst)
    expect(tabellen(k3)[0]!.zeilen.filter(z => z[0] === 'pkiiss01')).toHaveLength(1);
    const kopf = tabellen(k3)[0]!.kopf;
    const root = zeileMit(k3, 'pkiroot01')!;
    expect(root[kopf.indexOf('IP')]).toBe('—');
    expect(text(k3)).toContain('QEMU guest agent is not running');
    const q = d.kopf.quellen.find(x => x.quelle === 'proxmox')!;
    expect(q.fehler).toBeUndefined();
  });

  it('(c) UniFi-Fehler: Kapitel 4 genau ein nichtBelegt mit UniFi, Kapitel 3 und 8 unverändert', () => {
    const g = gesammelt();
    const ok = baueBetrieb('pki', P, g, {}, JETZT);
    g.unifi = { stand: STAND, fehler: 'Firewall lesen braucht den UniFi-API-Schlüssel token=abc123geheim' };
    const d = baueBetrieb('pki', P, g, {}, JETZT);
    const nb = nichtBelegt(kap(d, 'netz').bloecke);
    expect(nb).toHaveLength(1);
    expect(nb[0]!.grund).toContain('UniFi');
    expect(alsMarkdown(d)).not.toContain('abc123geheim');
    expect(kap(d, 'komponenten')).toEqual(kap(ok, 'komponenten'));
    expect(kap(d, 'sicherung')).toEqual(kap(ok, 'sicherung'));
    expect(d.kopf.quellen.find(x => x.quelle === 'unifi')!.fehler).toContain('UniFi');
  });

  it('(c2) UniFi gelesen: Netz, Zone, betroffene Policies (Bedingung und unbekannter Zustand sichtbar), DNS-Weiterleitung markiert', () => {
    const d = baueBetrieb('pki', P, gesammelt(), {}, JETZT);
    const k4 = kap(d, 'netz').bloecke;
    const netz = zeileMit(k4, 'AD-Identity')!;
    expect(netz).toEqual(expect.arrayContaining(['829', '10.203.29.0/27', 'AD']));
    expect(zeileMit(k4, 'pol00000001')).toBeDefined();
    const bedingt = zeileMit(k4, 'pol00000002')!.join(' ');
    expect(bedingt).toContain('unbekannt');
    expect(bedingt).toContain('Zeitplan');
    expect(zeileMit(k4, 'pol00000003')).toBeUndefined();
    expect(zeileMit(k4, 'ad.3033.at')!.join(' ')).toContain('dc01');
    expect(text(k4)).toContain('Trunk-Ports');
  });

  it('(d) fehlendes Asset → Kapitel 3 nichtBelegt mit der ID', () => {
    const g = gesammelt();
    g.assets = { stand: STAND, daten: { gefunden: ASSETS, fehlend: ['alt-asset'] } };
    const d = baueBetrieb('pki', P, g, {}, JETZT);
    expect(nichtBelegt(kap(d, 'komponenten').bloecke).some(b => b.grund.includes('alt-asset'))).toBe(true);
  });

  it('(e) Tresor: nur Name (und Herkunft), Zweck mit Geheimnis nie im Dokument; nur Einträge der Assets', () => {
    const d = baueBetrieb('pki', P, gesammelt(), {}, JETZT);
    const md = alsMarkdown(d);
    expect(md).toContain('pkiiss01-admin');
    expect(md).not.toContain('Geheim123');
    expect(md).not.toContain('fremd-dienst');
    const k5 = kap(d, 'identitaeten').bloecke;
    expect(zeileMit(k5, 'alfred')).toBeDefined();
    expect(text(k5)).not.toContain('docker01');
    expect(nichtBelegt(k5).some(b => /Dienstkonten/.test(b.grund))).toBe(true);
  });

  it('(f) 60 Changes mit je 30 Schritten bleiben unter 500 000 Zeichen, Kapitel 11 eine Zeile je Change', () => {
    const g = gesammelt();
    const viele = Array.from({ length: 60 }, (_, i) => change(`c${String(i).padStart(7, '0')}-0000`, `Change Nummer ${i} mit einem längeren Titel für die Historie`, 30));
    g.changes = { stand: STAND, daten: viele };
    const d = baueBetrieb('pki', P, g, {}, JETZT);
    expect(alsMarkdown(d).length).toBeLessThan(500_000);
    expect(tabellen(kap(d, 'historie').bloecke)[0]!.zeilen).toHaveLength(60);
  });

  it('(g) DCs ohne PBS-Job: Owner-Entscheidung statt Lücke', () => {
    const d = baueBetrieb('pki', P, gesammelt(), {}, JETZT);
    const k8 = kap(d, 'sicherung').bloecke;
    const dc = zeileMit(k8, 'dc01')!.join(' ');
    expect(dc).toContain('bewusst ohne PBS-Sicherung (Owner-Entscheidung)');
    expect(dc).not.toMatch(/Lücke/);
    expect(zeileMit(k8, 'pkiiss01')!.join(' ')).toContain('backup-pki');
    expect(text(k8)).toContain('Snapshots');
    // Restore-Beweis
    expect(text(k8)).toContain('rest5678');
    expect(text(k8)).toContain('Restore ok');
  });

  it('(g2) Nicht-DC ohne Job ist eine Lücke', () => {
    const g = gesammelt();
    g.sicherung = { stand: STAND, daten: { jobs: [], letzte: {}, unerreichbar: [] } };
    const d = baueBetrieb('pki', P, g, {}, JETZT);
    expect(zeileMit(kap(d, 'sicherung').bloecke, 'fs01')!.join(' ')).toMatch(/Lücke/);
  });

  it('(h) Kapitel 7: nichtBelegt V3 und Change-Reihenfolge mit Schritten', () => {
    const d = baueBetrieb('pki', P, gesammelt(), {}, JETZT);
    const k7 = kap(d, 'wiederaufbau').bloecke;
    expect(nichtBelegt(k7).some(b => b.grund.includes('V3'))).toBe(true);
    const t = text(k7);
    expect(t.indexOf('PKI aufbauen')).toBeGreaterThan(-1);
    expect(t.indexOf('PKI aufbauen')).toBeLessThan(t.indexOf('Restore-Probe'));
    expect(t).toContain('windows_pki.pruefen');
  });

  it('(i) Kapitel 12: Abnahme-Dokument mit Prüfsumme bzw. nichtBelegt kein Abnahmeprotokoll', () => {
    const d = baueBetrieb('pki', P, gesammelt(), {}, JETZT);
    const k12 = kap(d, 'beweise').bloecke;
    expect(zeileMit(k12, 'aufb1234')!.join(' ')).toContain('d0c12345');
    expect(text(k12)).toContain(SUMME);
    expect(nichtBelegt(k12).some(b => b.grund.includes('kein Abnahmeprotokoll') && b.grund.includes('rest5678'))).toBe(true);
    expect(d.anhaenge).toEqual([]);
  });

  it('Kapitel 9, 10, 13: Jobs, Schwellen nichtBelegt, Vorlagen, Fenster, Problems, Halte', () => {
    const d = baueBetrieb('pki', P, gesammelt(), { abweichungen: 'Root-CA bleibt offline' }, JETZT);
    const k9 = kap(d, 'ueberwachung').bloecke;
    expect(zeileMit(k9, 'pki-betrieb')).toBeDefined();
    expect(nichtBelegt(k9).some(b => b.grund.includes('Schwellen'))).toBe(true);
    const k10 = kap(d, 'betrieb').bloecke;
    expect(zeileMit(k10, 'k')!.join(' ')).toContain('freigegeben');
    expect(zeileMit(k10, 'Sonntag früh')).toBeDefined();
    expect(text(k10)).toContain('prob0001');
    const k13 = kap(d, 'abweichungen').bloecke;
    const halt = zeileMit(k13, 'aufb1234')!;
    expect(halt).toEqual(expect.arrayContaining(['1']));
    expect(text(k13)).toContain('Root-CA bleibt offline');
    expect(text(k13)).toContain('prob0001');
  });

  it('Sammlerfehler in allen Quellen: Dokument bleibt gültig, Fehler geschwärzt im Kopf', () => {
    const g = gesammelt();
    const f = { stand: STAND, fehler: 'Verbindung abgelehnt password=Hunter2xx' };
    const kaputt: Gesammelt = { ...g, beziehungen: f, proxmox: f, sicherung: f, unifi: f, tresor: f, fernzugaenge: f, jobs: f, wartung: f, problems: f, changes: f, abnahmen: f, architektur: f, netzBestand: f };
    const d = baueBetrieb('pki', P, kaputt, {}, JETZT);
    expect(pruefeDokument(d)).toEqual([]);
    expect(alsMarkdown(d)).not.toContain('Hunter2xx');
    expect(d.kopf.quellen.filter(q => q.fehler).length).toBeGreaterThanOrEqual(12);
  });
});

describe('Sammler (betriebQuellen)', () => {
  const basisDeps = (): BetriebQuellenDeps => ({
    cmdb: { getAssetById: async (_o, id) => ASSETS.find(a => a.id === id) ?? null, getRelationsForAsset: async () => [], listAssets: async () => [] },
    itsm: { listChangeRequests: async () => [] },
    problems: { listProblems: async () => [] },
    dokumente: { getDocumentById: async () => null, getDocumentsForEntity: async () => [], listDocuments: async () => [] },
    tresor: { liste: async () => [] },
    fernzugaenge: { liste: async () => [] },
    jobRuns: { letzterLauf: async () => undefined },
    jobDefinitionen: () => [],
    wartung: { kalender: async () => [], standardStand: async () => [] },
    standard: () => [],
    proxmox: async () => { throw new Error('ECONNREFUSED 192.168.1.10:8006'); },
    proxmoxBackups: async () => { throw new Error('nicht erreichbar'); },
    unifiLesen: async () => { throw new Error('kein Schlüssel'); },
    unifiDns: async () => ({ success: true, data: [] }),
  });

  it('(j) werfender Proxmox-Dep → proxmox() liefert fehler, wirft nicht', async () => {
    const q = betriebQuellen(basisDeps(), () => JETZT);
    const r = await q.proxmox('u', [{ node: 'pve', vmid: 821 }]);
    expect(r.fehler).toContain('ECONNREFUSED');
    expect(r.stand).toBe(JETZT);
    expect(r.daten).toBeUndefined();
    const s = await q.sicherung('u', [821]);
    expect(s.fehler).toBeDefined();
  });

  it('Proxmox: Konfiguration, Platten ohne CD, Agent-Fehler je VM; gestoppte VM ohne Agent-Abfrage', async () => {
    const aufrufe: string[] = [];
    const deps = basisDeps();
    deps.proxmox = async (i) => {
      aufrufe.push(String(i.path ?? i.action));
      if (i.action === 'list_vms') return { success: true, data: [{ vmid: 820, node: 'pve', name: 'pkiroot01', status: 'running' }, { vmid: 821, node: 'pve2', name: 'pkiiss01', status: 'running' }, { vmid: 830, node: 'pve', name: 'aus', status: 'stopped' }] };
      const p = String(i.path);
      if (p.endsWith('/config')) return { success: true, data: { cores: 2, sockets: 2, memory: '8192', ostype: 'win11', scsi0: 'local-zfs:vm-821-disk-0,size=80G', ide2: 'local:iso/x.iso,media=cdrom' } };
      if (p.includes('/820/agent')) return { success: false, error: 'Proxmox API error: QEMU guest agent is not running' };
      return { success: true, data: { result: [{ name: 'lo', 'ip-addresses': [{ 'ip-address': '127.0.0.1', 'ip-address-type': 'ipv4' }] }, { name: 'Ethernet', 'ip-addresses': [{ 'ip-address': '10.203.29.10', 'ip-address-type': 'ipv4' }, { 'ip-address': 'fe80::1', 'ip-address-type': 'ipv6' }] }] } };
    };
    const r = await betriebQuellen(deps, () => JETZT).proxmox('u', [{ node: 'pve', vmid: 820 }, { node: 'pve', vmid: 821 }, { node: 'pve', vmid: 830 }]);
    expect(r.fehler).toBeUndefined();
    const [root, iss, aus] = r.daten!;
    expect(root!.agentFehler).toContain('guest agent');
    expect(iss!.node).toBe('pve2');
    expect(iss!.cores).toBe(4);
    expect(iss!.speicherMiB).toBe(8192);
    expect(iss!.platten).toEqual(['scsi0 local-zfs 80G']);
    expect(iss!.ips).toEqual(['10.203.29.10']);
    expect(aus!.agentFehler).toContain('läuft nicht');
    expect(aufrufe.some(a => a.includes('/830/agent'))).toBe(false);
  });

  it('Sicherung: Job mit all+exclude, Ausnahmen und letzte Sicherung', async () => {
    const deps = basisDeps();
    deps.proxmox = async () => ({ success: true, data: [{ id: 'backup-alle', all: 1, exclude: '823,824', schedule: '21:00', storage: 'pbs-pve2' }, { id: 'fremd', vmid: '100', schedule: '22:00', storage: 'x' }] });
    deps.proxmoxBackups = async () => ({ jeVm: { 821: { neueste: '2026-11-14T20:00:00.000Z', anzahl: 3 } }, unerreichbar: [] });
    const r = await betriebQuellen(deps, () => JETZT).sicherung('u', [821, 823]);
    expect(r.daten!.jobs).toEqual([{ id: 'backup-alle', zeitplan: '21:00', speicher: 'pbs-pve2', enthaelt: [821], ausgenommen: [823], aktiv: true, alle: true }]);
    expect(r.daten!.letzte[821]).toBe('2026-11-14T20:00:00.000Z');
  });

  it('Assets erneut aufgelöst: gelöscht oder außer Betrieb → fehlend', async () => {
    const deps = basisDeps();
    deps.cmdb.getAssetById = async (_o, id) => (id === 'weg' ? null : id === 'alt' ? asset('alt', 'altvm', 'vm', { status: 'decommissioned' }) : ASSETS[1]!);
    const r = await betriebQuellen(deps, () => JETZT).assets('u', ['a-iss-vm', 'weg', 'alt']);
    expect(r.daten!.gefunden.map(a => a.id)).toEqual(['a-iss-vm']);
    expect(r.daten!.fehlend).toEqual(['weg', 'alt (altvm, außer Betrieb)']);
  });

  it('Abnahmen: jüngstes Protokoll am Change, Sammelprotokoll über kopf.verweise, Prüfsummen aus PRUEFUNG.txt', async () => {
    const deps = basisDeps();
    const doc = (id: string, version: number, createdAt: string, verweise: string[]) => ({ id, userId: 'u', docType: 'abnahme', title: 't', content: '', format: 'markdown', version, createdAt,
      struktur: JSON.stringify({ kopf: { verweise }, anhaenge: [{ name: 'PRUEFUNG.txt', inhalt: `${'b'.repeat(64)}  rohlauf-x.json\n` }] }) }) as never;
    deps.dokumente.getDocumentsForEntity = async (_o, _t, id) => (id === 'c1' ? [doc('d-alt', 1, '2026-11-01T00:00:00Z', ['change:c1']), doc('d-neu', 2, '2026-11-02T00:00:00Z', ['change:c1'])] : []);
    deps.dokumente.listDocuments = async () => [doc('d-serie', 1, '2026-11-03T00:00:00Z', ['change:c2', 'change:c3'])];
    const r = await betriebQuellen(deps, () => JETZT).abnahmen('u', ['c1', 'c2', 'c9']);
    expect(r.daten).toEqual({ c1: { docId: 'd-neu', version: 2, pruefsummen: ['b'.repeat(64)] }, c2: { docId: 'd-serie', version: 1, pruefsummen: ['b'.repeat(64)] } });
  });

  it('sammleBetrieb: ungültige gespeicherte Parameter werfen, gültige laufen alle Sammler', async () => {
    const q = betriebQuellen(basisDeps(), () => JETZT);
    await expect(sammleBetrieb(q, 'u', '{"assets":[],"x":1}')).rejects.toThrow(/ungültig/);
    await expect(sammleBetrieb(q, 'u', 'kein json')).rejects.toThrow(/JSON/);
    const { g } = await sammleBetrieb(q, 'u', JSON.stringify({ assets: ['a-iss-vm', 'a-iss-srv'] }));
    expect(g.assets.daten!.gefunden).toHaveLength(2);
    expect(g.proxmox.fehler).toContain('ECONNREFUSED');
    expect(g.unifi.fehler).toContain('kein Schlüssel');
    expect(g.architektur).toBeUndefined();
    // Dokument trotz Fehlern gültig
    expect(pruefeDokument(baueBetrieb('x', { assets: ['a-iss-vm', 'a-iss-srv'] }, g, {}, JETZT))).toEqual([]);
  });
});

describe('(k) netzBestand: pfSense, NPM, Cloudflare aus der CMDB', () => {
  const na = (id: string, sourceSkill: string, assetType: string, name: string, attributes: Record<string, unknown>, extra: Partial<CmdbAsset> = {}) =>
    ({ id, userId: 'u', sourceSkill, assetType, name, status: 'active', attributes, lastSeenAt: '2026-11-15T04:31:00.000Z', createdAt: 'x', updatedAt: 'x', ...extra }) as CmdbAsset;
  const bestand = {
    pfsense: [
      na('pf1', 'pfsense', 'network', 'AD-Identity', { interface: 'opt8', subnet: '10.203.29.0/27' }),
      na('pf2', 'pfsense', 'network', 'LAN', { interface: 'lan', subnet: '192.168.1.1/24' }, { lastSeenAt: '2026-11-15T04:32:00.000Z' }),
      na('pf3', 'pfsense', 'firewall_rule', 'AD nach LAN blocken', { type: 'block', interface: ['opt8'], protocol: null, source: 'opt8', destination: 'lan' }),
      na('pf4', 'pfsense', 'firewall_rule', 'LAN intern', { type: 'pass', interface: ['lan'], protocol: 'tcp', source: 'lan', destination: 'lan' }),
    ],
    nginx_proxy_manager: [
      na('np1', 'nginx_proxy_manager', 'proxy_host', 'pki.3033.at', { domain_names: ['pki.3033.at'], forward_host: '10.203.29.10', forward_port: 80, forward_scheme: 'http', ssl_forced: 1 }),
      na('np2', 'nginx_proxy_manager', 'proxy_host', 'andere.3033.at', { domain_names: ['andere.3033.at'], forward_host: '192.168.1.50', forward_port: 5080, forward_scheme: 'http' }),
      na('np3', 'nginx_proxy_manager', 'certificate', 'pki.3033.at', { domain_names: ['pki.3033.at'], expires_on: '2027-02-01' }),
    ],
    cloudflare_dns: [
      na('cf1', 'cloudflare_dns', 'dns_record', 'ado.3033.at (CNAME)', { type: 'CNAME', content: 'pki.3033.at' }, { fqdn: 'ado.3033.at' }),
      na('cf2', 'cloudflare_dns', 'dns_record', 'x.3033.at (A)', { type: 'A', content: '203.0.113.9' }, { fqdn: 'x.3033.at' }),
    ],
  };
  const ziele = { ips: ['10.203.29.10', '10.203.29.4'], namen: ['pkiiss01', 'dc01'] };

  it('ordnet Netz, Regel (mit Grund), Proxy mit Zertifikat und CNAME zu; Fremdes bleibt draußen', () => {
    const nb = ordneNetzBestand(bestand, ziele);
    expect(nb.netze).toEqual([{ quelle: 'pfsense', name: 'AD-Identity', subnetz: '10.203.29.0/27', schnittstelle: 'opt8' }]);
    expect(nb.firewallRegeln).toHaveLength(1);
    expect(nb.firewallRegeln[0]).toMatchObject({ quelle: 'pfsense', name: 'AD nach LAN blocken', aktion: 'block', schnittstelle: 'opt8' });
    expect(nb.firewallRegeln[0]!.grund).toContain('opt8');
    expect(nb.proxyHosts).toEqual([{ domains: ['pki.3033.at'], ziel: '10.203.29.10', port: 80, schema: 'http', zertifikat: 'pki.3033.at (gültig bis 2027-02-01)' }]);
    expect(nb.dnsEintraege).toEqual([{ name: 'ado.3033.at', typ: 'CNAME', wert: 'pki.3033.at' }]);
    expect(nb.stand.pfsense).toBe('2026-11-15T04:32:00.000Z');
    expect(nb.stand.mikrotik).toBe('keine Daten erfasst');
  });

  it('Kapitel 4 zeigt die Zuordnung; Kopf-Quellen nennen je source_skill den Datenstand', async () => {
    const deps: BetriebQuellenDeps = { ...({} as BetriebQuellenDeps), cmdb: { getAssetById: async () => null, getRelationsForAsset: async () => [], listAssets: async (_o, f) => (bestand as Record<string, CmdbAsset[]>)[f.sourceSkill ?? ''] ?? [] } };
    const r = await betriebQuellen(deps, () => JETZT).netzBestand('u', ziele);
    const g = gesammelt();
    g.netzBestand = r;
    const d = baueBetrieb('pki', P, g, {}, JETZT);
    const k4 = kap(d, 'netz').bloecke;
    const regel = zeileMit(k4, 'AD nach LAN blocken')!;
    expect(regel).toEqual(expect.arrayContaining(['pfsense']));
    expect(regel.join(' ')).toContain('Schnittstelle opt8');
    expect(zeileMit(k4, 'pki.3033.at')!.join(' ')).toContain('gültig bis 2027-02-01');
    expect(zeileMit(k4, 'ado.3033.at')).toBeDefined();
    const q = d.kopf.quellen.find(x => x.quelle === 'cmdb:pfsense')!;
    expect(q.stand).toBe('2026-11-15T04:32:00.000Z');
    expect(d.kopf.quellen.find(x => x.quelle === 'cmdb:cloudflare_dns')).toBeDefined();
  });

  it('nichts Passendes → Hinweis mit Datenstand statt leerer Tabellen', () => {
    const d = baueBetrieb('pki', P, gesammelt(), {}, JETZT);
    expect(text(kap(d, 'netz').bloecke)).toContain('keine Einträge in pfSense/MikroTik/NPM/Cloudflare betreffen diese Assets (Datenstand');
  });
});
