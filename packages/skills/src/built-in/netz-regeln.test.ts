import { describe, it, expect } from 'vitest';
import { neuesNetzFehler, netzWerte, subnetz, zahlIp, HOSTNAME, festeIpPruefung } from './netz-regeln.js';

// Netz-Aktionen (Owner 22.10.: Alfred legt VLANs selbst an)
describe('Netz-Regeln', () => {
  it('Subnetz → Gateway, DHCP-Bereich', () => {
    const s = subnetz('10.203.21.0/28')!;
    expect(zahlIp(s.gateway)).toBe('10.203.21.1');
    expect(zahlIp(s.broadcast)).toBe('10.203.21.15');
    expect(netzWerte({ name: 'x', vlan: 821, subnet: '10.203.21.0/28' })).toEqual({ ipSubnet: '10.203.21.1/28', gateway: '10.203.21.1', dhcpStart: '10.203.21.2', dhcpStop: '10.203.21.14' });
    expect(netzWerte({ name: 'x', vlan: 821, subnet: '10.203.21.5/28' }).gateway).toBe('10.203.21.5');
    expect(subnetz('10.0.0.0/31')).toBeUndefined();
  });
  it('Fehler: Name/VLAN doppelt, Überschneidung, DHCP außerhalb', () => {
    const vorhanden = [{ name: 'Default', vlan: 1, subnet: '192.168.1.1/24' }, { name: 'IoT', vlan: 20, subnet: '10.20.0.1/24' }];
    expect(neuesNetzFehler({ name: 'Docker-Dev', vlan: 824, subnet: '10.203.24.0/28' }, vorhanden)).toEqual([]);
    const f = neuesNetzFehler({ name: 'iot', vlan: 20, subnet: '192.168.1.128/25', dhcpStart: '10.0.0.5' }, vorhanden).join('\n');
    expect(f).toContain('gibt es schon');
    expect(f).toContain('VLAN 20 ist schon vergeben');
    expect(f).toContain('überschneidet sich mit Default');
    expect(f).toContain('dhcp_start 10.0.0.5 liegt nicht im Subnetz');
    expect(neuesNetzFehler({ name: 'x', vlan: 1, subnet: 'quatsch' }, [])).toEqual(expect.arrayContaining(['vlan: 2–4094', 'subnet: z. B. 10.203.21.0/28 (Präfix 8–30)']));
  });
  it('Hostnamen', () => {
    expect(HOSTNAME.test('matrix.home.arpa')).toBe(true);
    expect(HOSTNAME.test('a b')).toBe(false);
  });
});

describe('festeIpPruefung (Owner 22.10.: backupshare fest auf .111)', () => {
  const netze = [{ _id: 'n1', name: 'Default', ip_subnet: '192.168.1.1/24' }, { _id: 'n2', name: 'Docker-Dev', ip_subnet: '10.203.24.1/28' }];
  const samba = { _id: 'u1', mac: '9a:3a:59:3b:b9:4f', name: 'backupshare', last_ip: '192.168.1.111' };
  it('freie Adresse im Default-Netz → Netz gefunden, kein Fehler; alter fremder Eintrag nur als Hinweis', () => {
    const r = festeIpPruefung('9A:3A:59:3B:B9:4F', '192.168.1.111', [samba, { mac: 'aa:aa:aa:aa:aa:01', name: 'SKY', last_ip: '192.168.1.111' }], netze);
    expect(r.fehler).toEqual([]);
    expect(r.netz?._id).toBe('n1');
    expect(r.client?._id).toBe('u1');
    expect(r.hinweise[0]).toContain('SKY');
    expect(r.schonGesetzt).toBe(false);
  });
  it('fremde Reservierung, Gateway, außerhalb aller Netze → Fehler', () => {
    expect(festeIpPruefung(samba.mac, '192.168.1.111', [samba, { mac: 'aa:aa:aa:aa:aa:01', use_fixedip: true, fixed_ip: '192.168.1.111' }], netze).fehler[0]).toContain('reserviert');
    expect(festeIpPruefung(samba.mac, '192.168.1.1', [samba], netze).fehler[0]).toContain('Gateway');
    expect(festeIpPruefung(samba.mac, '172.16.0.5', [samba], netze).fehler[0]).toContain('keinem Netz');
    expect(festeIpPruefung(samba.mac, '192.168.1.255', [samba], netze).fehler[0]).toContain('keinem Netz');
  });
  it('andere feste IP am selben Gerät → erst entfernen; gleiche → schon gesetzt', () => {
    expect(festeIpPruefung(samba.mac, '192.168.1.111', [{ ...samba, use_fixedip: true, fixed_ip: '192.168.1.50', network_id: 'n1' }], netze).fehler[0]).toContain('clear_fixed_ip');
    expect(festeIpPruefung(samba.mac, '192.168.1.111', [{ ...samba, use_fixedip: true, fixed_ip: '192.168.1.111', network_id: 'n1' }], netze).schonGesetzt).toBe(true);
  });
  it('unbekanntes Gerät ist erlaubt (wird angelegt), falsche MAC nicht', () => {
    expect(festeIpPruefung('9a:3a:59:3b:b9:40', '192.168.1.112', [], netze)).toMatchObject({ fehler: [], schonGesetzt: false });
    expect(festeIpPruefung('9a3a', '192.168.1.112', [], netze).fehler[0]).toContain('mac');
  });
});
