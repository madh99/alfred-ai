import { describe, it, expect } from 'vitest';
import { PfSenseSkill } from '../built-in/pfsense.js';

// v1608 — Realfall 23.10. (pgAdmin → 10.0.0.14): Regeln und statische Routen über die REST-API v2, nur im Change, wiederholbar, nachgelesen
function welt() {
  const s = new PfSenseSkill({ baseUrl: 'https://pf', apiKey: 'k' } as never);
  const regeln: Array<Record<string, unknown>> = [{ id: 0, descr: 'alt', interface: ['opt1'], source: 'opt1', destination: '10.0.0.14', protocol: 'tcp' }];
  const routen: Array<Record<string, unknown>> = [{ id: 0, network: '172.20.20.0/26', gateway: 'MAIN_LAN_DHCP' }];
  const aufrufe: string[] = [];
  (s as unknown as { pfFetch: (p: string, o?: RequestInit) => Promise<unknown> }).pfFetch = async (p, o) => {
    const m = o?.method ?? 'GET';
    aufrufe.push(`${m} ${p}`);
    const body = o?.body ? JSON.parse(String(o.body)) : undefined;
    if (p === '/interfaces' || p === '/interface') return { data: [{ id: 'opt1', if: 'vtnet2', descr: 'MAIN_LAN' }, { id: 'opt2', if: 'vtnet3', descr: 'SERVER_LAN' }] };
    if (p.startsWith('/firewall/rules')) return { data: regeln };
    if (p === '/firewall/rule' && m === 'POST') { regeln.push({ id: regeln.length, ...body }); return { data: body }; }
    if (p.startsWith('/firewall/rule?id=') && m === 'DELETE') { const id = Number(p.split('=')[1]); regeln.splice(regeln.findIndex(r => r.id === id), 1); regeln.forEach((r, i) => { r.id = i; }); return { data: {} }; }
    if (p.endsWith('/apply')) return { data: { applied: true } };
    if (p.startsWith('/routing/gateways')) return { data: [{ name: 'MAIN_LAN_DHCP' }, { name: 'WANGW' }] };
    if (p.startsWith('/routing/static_routes')) return { data: routen };
    if (p === '/routing/static_route' && m === 'POST') { routen.push({ id: routen.length, ...body }); return { data: body }; }
    if (p.startsWith('/routing/static_route?id=') && m === 'DELETE') { routen.splice(Number(p.split('=')[1]), 1); return { data: {} }; }
    throw new Error(`unerwartet ${m} ${p}`);
  };
  return { s, regeln, routen, aufrufe };
}
const imChange = { ausChange: true } as never;
const regel = { action: 'create_rule', interface: 'MAIN_LAN', protocol: 'tcp', source: '10.203.24.2', destination: '10.0.0.14', destination_port: '5432', description: 'pgAdmin docker-dev-01 zu PGSql-P01' };

describe('pfSense-Änderungen (v1608)', () => {
  it('ohne Change: nichts ändern', async () => {
    const w = welt();
    for (const a of ['create_rule', 'delete_rule', 'create_static_route', 'delete_static_route', 'create_vlan']) {
      const r = await w.s.execute({ ...regel, action: a }, {} as never);
      expect(r.success, a).toBe(false);
      expect(r.error).toMatch(/freigegebenen Changes/);
    }
    expect(w.aufrufe.filter(a => !a.startsWith('GET'))).toEqual([]);
  });

  it('Regel im v2-Format anlegen, anwenden, nachlesen; wiederholbar; Rückweg über die Beschreibung', async () => {
    const w = welt();
    const r = await w.s.execute(regel, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.regeln.at(-1)).toMatchObject({ type: 'pass', interface: ['opt1'], ipprotocol: 'inet', protocol: 'tcp', source: '10.203.24.2', destination: '10.0.0.14', destination_port: '5432', descr: 'pgAdmin docker-dev-01 zu PGSql-P01' });
    expect(w.aufrufe).toContain('POST /firewall/apply');
    expect((await w.s.execute(regel, imChange)).display).toMatch(/bereits genau so/);
    expect((await w.s.execute({ ...regel, destination_port: '5433' }, imChange)).error).toMatch(/anderen Werten/);
    const d = await w.s.execute({ action: 'delete_rule', description: regel.description }, imChange);
    expect(d.success, d.error).toBe(true);
    expect(w.aufrufe.some(a => a.startsWith('DELETE /firewall/rule?id=1'))).toBe(true);
    expect(w.regeln.map(x => x.descr)).toEqual(['alt']);
    expect((await w.s.execute({ action: 'delete_rule', description: regel.description }, imChange)).display).toMatch(/nicht \(mehr\)/);
  });

  it('Interface und Gateway müssen existieren', async () => {
    const w = welt();
    expect((await w.s.execute({ ...regel, interface: 'GIBTSNICHT' }, imChange)).error).toMatch(/unbekannt/);
    expect((await w.s.execute({ action: 'create_static_route', network: '10.203.24.0/28', gateway: 'FALSCH' }, imChange)).error).toMatch(/Gateway „FALSCH“ unbekannt/);
  });

  it('statische Route anlegen/entfernen mit routing/apply, wiederholbar', async () => {
    const w = welt();
    const r = await w.s.execute({ action: 'create_static_route', network: '10.203.24.0/28', gateway: 'MAIN_LAN_DHCP', description: 'Rückweg Docker-Dev' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.routen.at(-1)).toMatchObject({ network: '10.203.24.0/28', gateway: 'MAIN_LAN_DHCP', disabled: false });
    expect(w.aufrufe).toContain('POST /routing/apply');
    expect((await w.s.execute({ action: 'create_static_route', network: '10.203.24.0/28', gateway: 'MAIN_LAN_DHCP' }, imChange)).display).toMatch(/bereits vorhanden/);
    expect((await w.s.execute({ action: 'delete_static_route', network: '10.203.24.0/28' }, imChange)).success).toBe(true);
    expect(w.routen.map(x => x.network)).toEqual(['172.20.20.0/26']);
  });
});
