import { describe, it, expect } from 'vitest';
import { UniFiSkill } from '../built-in/unifi.js';

// Realfall 15.11. (Change 288c3716): nach delete_zone lag PKI-Lab in „Internal“; delete_network ließ die ID in network_ids stehen →
// Integration-API /firewall/zones und /firewall/policies global 422 network-does-not-exist
const AD = 'aaaaaaaaaaaaaaaaaaaaaaaa', LAB = '855e212f-4c48-4b10-b559-f6b8e5fca822', DEF = 'dddddddddddddddddddddddd', ALT = 'eeeeeeee-0000-4000-8000-000000000001';
function welt(o: { putIgnoriert?: boolean; netzListeLeer?: boolean } = {}) {
  const s = new UniFiSkill({ baseUrl: 'https://udm', apiKey: 'k', verifyTls: false } as never);
  const netze = [
    { _id: AD, name: 'AD-Identity', vlan: 829, vlan_enabled: true, purpose: 'corporate' },
    { _id: LAB, name: 'PKI-Lab', vlan: 832, vlan_enabled: true, purpose: 'corporate' },
    { _id: DEF, name: 'Default', vlan: 0, vlan_enabled: false, purpose: 'corporate' },
  ];
  const zonen = [
    { _id: 'zInt', name: 'Internal', zone_key: 'internal', attr_no_edit: true, attr_hidden_id: 'internal', network_ids: [DEF, LAB, ALT] },
    { _id: 'zAd', name: 'AD-Identity', network_ids: [AD] },
  ];
  const puts: Array<{ pfad: string; body: Record<string, unknown> }> = [];
  (s as unknown as { request: (m: string, p: string) => Promise<unknown> }).request = async (m, p) => {
    if (p === 'rest/networkconf' && m === 'GET') return o.netzListeLeer ? [] : netze;
    if (p === 'stat/sta') return [];
    if (p.startsWith('rest/networkconf/') && m === 'DELETE') { const id = p.split('/')[2]; netze.splice(netze.findIndex(n => n._id === id), 1); return []; }
    throw new Error(`unerwartet ${m} ${p}`);
  };
  (s as unknown as { v2: (m: string, p: string, b?: unknown) => Promise<unknown> }).v2 = async (m, p, b) => {
    if (m === 'GET' && p === 'firewall/zone') return JSON.parse(JSON.stringify(zonen));
    if (m === 'PUT' && p.startsWith('firewall/zone/')) {
      puts.push({ pfad: p, body: b as Record<string, unknown> });
      // Realfall 16.11. (a500a79d): die UDM lehnt schreibgeschützte Felder ab — HTTP 400 „Unrecognized field attr_no_edit“
      const fremd = Object.keys(b as Record<string, unknown>).find(k => k.startsWith('attr_'));
      if (fremd) throw new Error(`UniFi v2 ${p} HTTP 400: JSON parse error: Unrecognized field "${fremd}"`);
      if (!o.putIgnoriert) { const z = zonen.find(x => x._id === p.split('/')[2])!; z.network_ids = (b as { network_ids: string[] }).network_ids; }
      return {};
    }
    throw new Error(`unerwartet v2 ${m} ${p}`);
  };
  return { s, zonen, puts };
}
const imChange = { ausChange: true } as never;

describe('UniFi: verwaiste Netzverweise in Zonen (Realfall 15.11.)', () => {
  it('nur im Change; delete_network ebenso', async () => {
    expect((await welt().s.execute({ action: 'remove_orphan_zone_networks', network_id: ALT }, {} as never)).error).toContain('freigegebenen Changes');
    expect((await welt().s.execute({ action: 'delete_network', network_name: 'PKI-Lab' }, {} as never)).error).toContain('freigegebenen Changes');
  });
  it('ohne genau eine ID keine Änderung', async () => {
    const w = welt();
    expect((await w.s.execute({ action: 'remove_orphan_zone_networks' }, imChange)).success).toBe(false);
    expect(w.puts).toHaveLength(0);
  });
  it('entfernt nur die genannte verwaiste ID, Zone sonst unverändert', async () => {
    const w = welt();
    const r = await w.s.execute({ action: 'remove_orphan_zone_networks', network_id: ALT }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.puts).toHaveLength(1);
    expect(w.puts[0]!.body).toMatchObject({ _id: 'zInt', name: 'Internal', zone_key: 'internal', network_ids: [DEF, LAB] });
  });
  it('vorhandenes Netz wird nie entfernt', async () => {
    const w = welt();
    const r = await w.s.execute({ action: 'remove_orphan_zone_networks', network_id: LAB }, imChange);
    expect(r.success).toBe(true);
    expect(w.puts).toHaveLength(0);
  });
  it('leere Netzliste → fail-closed, nichts geschrieben (Review v1871)', async () => {
    const w = welt({ netzListeLeer: true });
    const r = await w.s.execute({ action: 'remove_orphan_zone_networks', network_id: ALT }, imChange);
    expect(r.success).toBe(false);
    expect(w.puts).toHaveLength(0);
  });
  it('Schreiben ohne Wirkung → Fehler statt Erfolg', async () => {
    const w = welt({ putIgnoriert: true });
    const r = await w.s.execute({ action: 'remove_orphan_zone_networks', network_id: ALT }, imChange);
    expect(r.success).toBe(false);
    expect(r.error).toContain('nicht wie erwartet');
  });
  it('delete_network bereinigt den Verweis der gelöschten ID gleich mit', async () => {
    const w = welt();
    const r = await w.s.execute({ action: 'delete_network', network_name: 'PKI-Lab' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.zonen[0]!.network_ids).toEqual([DEF, ALT]);
    expect(r.display).toContain('Internal');
  });
});
