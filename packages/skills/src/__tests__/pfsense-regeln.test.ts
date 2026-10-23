import { describe, it, expect } from 'vitest';
import { regelSeite, regelPasstZuInterface, regelZeile } from '../built-in/pfsense.js';

// v1606 — Realfall 23.10.: pfSense REST-API v2 liefert Quelle/Ziel als Text und Interfaces als Liste; ?interface= wirkte nicht
describe('pfSense-Regeln lesen (v2 und v1)', () => {
  it('Quelle/Ziel: v2-Text, v1-Objekt, Negation', () => {
    expect(regelSeite('192.168.1.0/24')).toBe('192.168.1.0/24');
    expect(regelSeite('opt1')).toBe('opt1');
    expect(regelSeite('')).toBe('any');
    expect(regelSeite({ address: '10.0.0.14' })).toBe('10.0.0.14');
    expect(regelSeite({ network: 'lan', not: true })).toBe('!lan');
    expect(regelSeite(undefined)).toBe('any');
  });

  it('Interface-Filter über interne ID oder Beschreibung (MAIN_LAN → opt1)', () => {
    const ifs = [{ id: 'opt1', if: 'vtnet2', descr: 'MAIN_LAN' }, { id: 'opt3', if: 'vtnet3', descr: 'SERVER_LAN' }];
    expect(regelPasstZuInterface({ interface: ['opt1'] }, 'MAIN_LAN', ifs)).toBe(true);
    expect(regelPasstZuInterface({ interface: ['opt3'] }, 'MAIN_LAN', ifs)).toBe(false);
    expect(regelPasstZuInterface({ interface: 'opt1,opt3' }, 'opt3', ifs)).toBe(true);
    expect(regelPasstZuInterface({ interface: ['wan'] }, 'wan', [])).toBe(true);
  });

  it('Zeile zeigt echte Quelle, Ziel, Port und Interfaces', () => {
    const z = regelZeile({ id: 7, type: 'pass', interface: ['opt1'], protocol: 'tcp', source: '192.168.1.0/24', destination: '10.0.0.14', destination_port: '5432', descr: 'LAN zu Postgres' }, 0);
    expect(z).toBe('| 7 | pass | opt1 | tcp | 192.168.1.0/24 | 10.0.0.14:5432 | LAN zu Postgres |');
    expect(regelZeile({ source: { address: '1.2.3.4' }, destination: { network: 'any', port: '443' }, interface: 'lan', disabled: true }, 3)).toBe('| 3 | pass (aus) | lan | any | 1.2.3.4 | any:443 |  |');
  });
});

describe('v1613 Portweiterleitungen lesen', () => {
  it('zeigt außen → innen mit Status', async () => {
    const { PfSenseSkill } = await import('../built-in/pfsense.js');
    const s = new PfSenseSkill({ baseUrl: 'https://pf', apiKey: 'k' } as never);
    (s as unknown as { pfFetch: (p: string) => Promise<unknown> }).pfFetch = async (p) => {
      if (p === '/firewall/nat/port_forwards') return { data: [{ id: 0, interface: 'wan', protocol: 'tcp', source: 'any', destination: 'wan:ip', destination_port: '443', target: '172.17.0.10', local_port: '443', descr: 'NPM HTTPS' }, { id: 1, interface: 'wan', protocol: 'tcp', source: 'any', destination: 'wan:ip', destination_port: '21115:21119', target: '192.168.1.211', disabled: true, descr: 'Rustdesk' }] };
      throw new Error(p);
    };
    const r = await s.execute({ action: 'list_port_forwards' }, {} as never);
    expect(r.success).toBe(true);
    expect(r.display).toContain('| 0 | an | wan | tcp | any | wan:ip:443 | 172.17.0.10:443 | NPM HTTPS |');
    expect(r.display).toContain('| 1 | AUS | wan | tcp | any | wan:ip:21115:21119 | 192.168.1.211:21115:21119 | Rustdesk |');
  });
});
