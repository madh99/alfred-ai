import { describe, it, expect } from 'vitest';
import { neuesNetzFehler, netzWerte, subnetz, zahlIp, HOSTNAME } from './netz-regeln.js';

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
