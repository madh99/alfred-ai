import { describe, it, expect } from 'vitest';
import { UniFiSkill } from '../built-in/unifi.js';

// Realfall 15.11. (Change 288c3716): nach delete_zone lag PKI-Lab in „Internal“; delete_network ließ die ID in network_ids stehen →
// Integration-API /firewall/zones und /firewall/policies global 422 network-does-not-exist
function welt(o: { putIgnoriert?: boolean } = {}) {
  const s = new UniFiSkill({ baseUrl: 'https://udm', apiKey: 'k', verifyTls: false } as never);
  const netze = [{ _id: 'nAD', name: 'AD-Identity', vlan: 829, vlan_enabled: true, purpose: 'corporate' }, { _id: 'nLab', name: 'PKI-Lab', vlan: 832, vlan_enabled: true, purpose: 'corporate' }];
  const zonen = [
    { _id: 'zInt', name: 'Internal', zone_key: 'internal', network_ids: ['nDefault', 'nLab', 'nAlt'] },
    { _id: 'zAd', name: 'AD-Identity', network_ids: ['nAD'] },
  ];
  netze.push({ _id: 'nDefault', name: 'Default', vlan: 0, vlan_enabled: false, purpose: 'corporate' } as never);
  const puts: Array<{ pfad: string; body: Record<string, unknown> }> = [];
  (s as unknown as { request: (m: string, p: string) => Promise<unknown> }).request = async (m, p) => {
    if (p === 'rest/networkconf' && m === 'GET') return netze;
    if (p === 'stat/sta') return [];
    if (p.startsWith('rest/networkconf/') && m === 'DELETE') { const id = p.split('/')[2]; netze.splice(netze.findIndex(n => n._id === id), 1); return []; }
    throw new Error(`unerwartet ${m} ${p}`);
  };
  (s as unknown as { v2: (m: string, p: string, b?: unknown) => Promise<unknown> }).v2 = async (m, p, b) => {
    if (m === 'GET' && p === 'firewall/zone') return JSON.parse(JSON.stringify(zonen));
    if (m === 'PUT' && p.startsWith('firewall/zone/')) {
      puts.push({ pfad: p, body: b as Record<string, unknown> });
      if (!o.putIgnoriert) { const z = zonen.find(x => x._id === p.split('/')[2])!; z.network_ids = (b as { network_ids: string[] }).network_ids; }
      return {};
    }
    throw new Error(`unerwartet v2 ${m} ${p}`);
  };
  return { s, zonen, puts };
}
const imChange = { ausChange: true } as never;

describe('UniFi: verwaiste Netzverweise in Zonen (Realfall 15.11.)', () => {
  it('nur im Change', async () => {
    const r = await welt().s.execute({ action: 'remove_orphan_zone_networks' }, {} as never);
    expect(r.error).toContain('freigegebenen Changes');
  });
  it('entfernt nur die genannte verwaiste ID, Zone sonst unverändert', async () => {
    const w = welt();
    const r = await w.s.execute({ action: 'remove_orphan_zone_networks', network_id: 'nAlt' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.puts).toHaveLength(1);
    expect(w.puts[0]!.body).toMatchObject({ _id: 'zInt', name: 'Internal', zone_key: 'internal', network_ids: ['nDefault', 'nLab'] });
  });
  it('vorhandene Netze werden nie entfernt; ohne Verwaiste kein Schreiben', async () => {
    const w = welt();
    const r = await w.s.execute({ action: 'remove_orphan_zone_networks', network_id: 'nLab' }, imChange);
    expect(r.success).toBe(true);
    expect(w.puts).toHaveLength(0);
  });
  it('Schreiben ohne Wirkung → Fehler statt Erfolg', async () => {
    const w = welt({ putIgnoriert: true });
    const r = await w.s.execute({ action: 'remove_orphan_zone_networks' }, imChange);
    expect(r.success).toBe(false);
    expect(r.error).toContain('noch vorhanden');
  });
  it('delete_network bereinigt den Verweis der gelöschten ID gleich mit', async () => {
    const w = welt();
    const r = await w.s.execute({ action: 'delete_network', network_name: 'PKI-Lab' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.zonen[0]!.network_ids).toEqual(['nDefault', 'nAlt']);
    expect(r.display).toContain('Internal');
  });
});
