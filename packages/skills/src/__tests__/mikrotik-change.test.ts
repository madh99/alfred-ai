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

// v1618 — Zertifikat-Pinning: bei falschem Fingerabdruck werden keine Zugangsdaten gesendet
describe('MikroTik: Zertifikat-Pinning', () => {
  it('Vergleich ignoriert Doppelpunkte und Groß/Klein', async () => {
    const { fingerabdruckGleich } = await import('../built-in/mikrotik.js');
    expect(fingerabdruckGleich('4A:6E:C2:4B', '4a6ec24b')).toBe(true);
    expect(fingerabdruckGleich('4A:6E:C2:4B', '4A:6E:C2:4C')).toBe(false);
    expect(fingerabdruckGleich('', '4A')).toBe(false);
  });
});
