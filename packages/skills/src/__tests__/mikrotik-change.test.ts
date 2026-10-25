import { describe, it, expect } from 'vitest';
import { MikroTikSkill } from '../built-in/mikrotik.js';

// v1617 — nach dem Router-Vorfall 23.10.: schreibende MikroTik-Aktionen nur im freigegebenen Change, Schutz nicht abschaltbar
describe('MikroTik: Schreiben nur im Change', () => {
  const skill = () => new MikroTikSkill({ host: '192.168.1.95', username: 'alfred-api', password: 'x', ssl: true } as never);
  it('ohne Change: jede schreibende Aktion wird abgewiesen, ohne den Router anzusprechen', async () => {
    const s = skill();
    let aufrufe = 0;
    (s as unknown as { api: () => Promise<unknown> }).api = async () => { aufrufe++; return []; };
    for (const a of ['add_nat', 'remove_nat', 'add_firewall', 'disable_firewall', 'set_dns', 'add_address', 'remove_route', 'disable_interface']) {
      const r = await s.execute({ action: a }, {} as never);
      expect(r.success, a).toBe(false);
      expect(r.error).toMatch(/freigegebenen Changes/);
    }
    expect(aufrufe).toBe(0);
  });
  it('configure kann den Schutz nicht abschalten', async () => {
    const s = skill();
    await s.execute({ action: 'configure', confirmation_mode: false }, {} as never);
    expect((await s.execute({ action: 'add_nat' }, {} as never)).success).toBe(false);
  });
  it('im Change wird die Aktion ausgeführt (erreicht die API)', async () => {
    const s = skill();
    let aufrufe = 0;
    (s as unknown as { api: () => Promise<unknown> }).api = async () => { aufrufe++; return { ret: '*1' }; };
    await s.execute({ action: 'add_nat', chain: 'dstnat', protocol: 'tcp', dst_port: '8883', to_addresses: '192.168.1.96', to_ports: '8883', comment: 'test' }, { ausChange: true } as never);
    expect(aufrufe).toBeGreaterThan(0);
  });
});

// v1671 — NAT-/Filterregeln mit allen Bedingungen (Protokoll, Zielport, Schnittstelle, Zustand)
describe('MikroTik: Regeln vollständig', () => {
  it('nat_rules zeigt Protokoll, Zielport, Schnittstelle und Pause; add_nat setzt in-interface', async () => {
    const s = new MikroTikSkill({ host: '192.168.1.95', username: 'alfred-api', password: 'x', ssl: true } as never);
    let gesendet: Record<string, string> | undefined;
    (s as unknown as { api: (c: unknown, m: string, p: string, b?: Record<string, string>) => Promise<unknown> }).api = async (_c, m, p, b) => {
      if (m === 'POST') { gesendet = b; return { ret: '*9' }; }
      if (p === '/ip/firewall/nat') return [{ '.id': '*2', chain: 'dstnat', action: 'dst-nat', protocol: 'tcp', 'dst-port': '443', 'in-interface': 'ether2', 'dst-address': '91.114.43.170', 'to-addresses': '172.31.0.10', 'to-ports': '443', bytes: '1', disabled: 'false' },
        { '.id': '*5', chain: 'dstnat', action: 'dst-nat', 'dst-address': '91.114.43.171', 'to-addresses': '172.31.0.10', disabled: 'true' }];
      return [{ '.id': '*1', chain: 'forward', action: 'accept', 'connection-state': 'established,related', disabled: 'false' }];
    };
    const n = (await s.execute({ action: 'nat_rules' }, {} as never)).display ?? '';
    expect(n).toContain('protocol=tcp');
    expect(n).toContain('dst-port=443');
    expect(n).toContain('in-interface=ether2');
    expect(n).toMatch(/⏸️ \*5/);
    expect(n).not.toContain('bytes=');
    expect((await s.execute({ action: 'firewall_rules' }, {} as never)).display).toContain('connection-state=established,related');
    await s.execute({ action: 'add_nat', protocol: 'udp', port: '65246-65248', in_interface: 'ether2', to_addresses: '172.31.0.10' }, { ausChange: true } as never);
    expect(gesendet).toMatchObject({ protocol: 'udp', 'dst-port': '65246-65248', 'in-interface': 'ether2', 'to-addresses': '172.31.0.10' });
  });
});

// v1618 — Zertifikat-Pinning: bei falschem Fingerabdruck werden keine Zugangsdaten gesendet
describe('MikroTik: Zertifikat-Pinning', () => {
  it('Vergleich ignoriert Doppelpunkte und Groß/Klein', async () => {
    const { fingerabdruckGleich } = await import('../built-in/mikrotik.js');
    expect(fingerabdruckGleich('4A:6E:C2:4B', '4a6ec24b')).toBe(true);
    expect(fingerabdruckGleich('4A:6E:C2:4B', '4A:6E:C2:4C')).toBe(false);
    expect(fingerabdruckGleich('', '4A')).toBe(false);
  });
});
