import { describe, it, expect } from 'vitest';
import { UniFiSkill } from '../built-in/unifi.js';

// v1386 — Firewall-Änderungen nur mit Einmal-Freigabe nach Owner-Bestätigung
function aufbau(weitere: unknown[] = []) {
  const s = new UniFiSkill({ baseUrl: 'https://udm', apiKey: 'k', verifyTls: false } as never);
  const aufrufe: Array<{ method: string; url: string; body?: unknown }> = [];
  let reihen = { beforeSystemDefined: ['dns', 'block'], afterSystemDefined: [] as string[] };
  const antwort = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
  (s as unknown as { rawFetch: (u: string, i: RequestInit) => Promise<Response> }).rawFetch = async (url, init) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    aufrufe.push({ method, url, body });
    if (url.includes('/sites?')) return antwort({ data: [{ id: 'S', internalReference: 'default' }] });
    if (url.includes('/firewall/zones')) return antwort({ data: [{ id: 'z-int', name: 'Internal' }, { id: 'z-gw', name: 'Gateway' }] });
    if (url.includes('/networks')) return antwort({ data: [{ id: 'n-dev', name: 'DeviceLAN', zoneId: 'z-int', vlanId: 817 }] });
    if (url.includes('/firewall/policies/ordering')) {
      if (method === 'PUT') { reihen = body.orderedFirewallPolicyIds; return antwort({}); }
      return antwort({ orderedFirewallPolicyIds: reihen });
    }
    if (url.includes('/firewall/policies') && method === 'POST') { reihen.beforeSystemDefined.push('neu'); return antwort({ id: 'neu', ...body }); }
    if (url.includes('/firewall/policies')) return antwort({ data: [
      { id: 'dns', name: 'A_DNS', enabled: true, action: { type: 'ALLOW' }, source: { zoneId: 'z-int' }, destination: { zoneId: 'z-gw' } },
      { id: 'block', name: 'Block 817_LAN', enabled: true, action: { type: 'BLOCK' }, source: { zoneId: 'z-int' }, destination: { zoneId: 'z-gw' } },
      ...weitere,
    ] });
    return antwort({ message: 'unbekannt' }, 404);
  };
  const fragen: Array<{ beschreibung: string; params: Record<string, unknown> }> = [];
  s.setBestaetigung(async (o) => { fragen.push(o); return true; });
  const schreibend = () => aufrufe.filter(a => a.method !== 'GET');
  return { s, fragen, schreibend, reihen: () => reihen };
}

const wunsch = { action: 'create_firewall_policy', policy_name: 'A_mDNS_DeviceLAN', policy_action: 'ALLOW', source_network: 'DeviceLAN', source_port: '5353', destination_zone: 'Gateway', policy_protocol: 'UDP', before_policy: 'Block 817_LAN' };

describe('Firewall-Freigabe', () => {
  it('ohne Freigabe: nur Bestätigung, keine Änderung; mit Freigabe: anlegen und vor die Sperre setzen', async () => {
    const { s, fragen, schreibend, reihen } = aufbau();
    const r1 = await s.execute(wunsch, {} as never);
    expect(r1.success).toBe(true);
    expect(schreibend()).toHaveLength(0);
    expect(fragen[0]!.beschreibung).toMatch(/ALLOW „A_mDNS_DeviceLAN" — Internal \[Netz DeviceLAN Port 5353\] → Gateway \[alles\], UDP.*VOR „Block 817_LAN"/);
    const r2 = await s.execute(fragen[0]!.params, {} as never);
    expect(r2.success, r2.error).toBe(true);
    expect(schreibend().map(a => a.method)).toEqual(['POST', 'PUT']);
    expect(reihen().beforeSystemDefined).toEqual(['dns', 'neu', 'block']);
    expect(r2.display).toMatch(/Position 2, direkt vor „Block 817_LAN" \(zurückgelesen\)/);
    // Freigabe ist verbraucht
    await s.execute(fragen[0]!.params, {} as never);
    expect(schreibend()).toHaveLength(2);
  });

  it('geratene oder fremde Freigabe ändert nichts', async () => {
    const { s, fragen, schreibend } = aufbau();
    await s.execute({ ...wunsch, freigabe: 'geraten' }, {} as never);
    expect(schreibend()).toHaveLength(0);
    // Freigabe für einen anderen Inhalt gilt nicht
    await s.execute(wunsch, {} as never);
    await s.execute({ ...fragen.at(-1)!.params, source_port: '1-65535' }, {} as never);
    expect(schreibend()).toHaveLength(0);
  });

  it('Systemregeln und Mehrdeutiges werden nicht angefasst; altes create_firewall_rule verweist auf Policies', async () => {
    const { s, schreibend } = aufbau();
    const r = await s.execute({ action: 'create_firewall_rule', rule_name: 'x' }, {} as never);
    expect(r.error).toMatch(/create_firewall_policy/);
    const d = await s.execute({ action: 'delete_firewall_policy', policy_id: 'gibtsnicht' }, {} as never);
    expect(d.success).toBe(false);
    expect(schreibend()).toHaveLength(0);
  });

  it('v1603 Realfall 4f2642ab: Ausnahme ohne before_policy kommt automatisch vor die eigene Sperre', async () => {
    const { s, fragen } = aufbau();
    const { before_policy: _b, ...ohne } = wunsch;
    await s.execute(ohne, {} as never);
    expect(fragen[0]!.beschreibung).toMatch(/VOR „Block 817_LAN" \(automatisch vor die Sperre\)/);
  });

  it('v1603: Sperre ohne Filter in der Gegenrichtung verwirft die Antworten → ALLOW nicht anlegen', async () => {
    const { s, fragen, schreibend } = aufbau([{ id: 'gegen', name: 'cf82-dev-block-from-internal', enabled: true, action: { type: 'BLOCK' }, source: { zoneId: 'z-gw' }, destination: { zoneId: 'z-int' } }]);
    const r = await s.execute(wunsch, {} as never);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Gegenrichtung sperrt „cf82-dev-block-from-internal" \(gegen\).*enabled=false/);
    expect(fragen).toHaveLength(0);
    expect(schreibend()).toHaveLength(0);
    // abgeschaltete Sperre stört nicht
    const b = aufbau([{ id: 'gegen', name: 'x', enabled: false, action: { type: 'BLOCK' }, source: { zoneId: 'z-gw' }, destination: { zoneId: 'z-int' } }]);
    expect((await b.s.execute(wunsch, {} as never)).success).toBe(true);
  });
});
