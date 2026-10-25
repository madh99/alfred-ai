import { describe, it, expect } from 'vitest';
import { PfSenseSkill } from '../built-in/pfsense.js';

// v1670 — Owner 25.10.: Matrix-Videoanrufe von außen → Port-Weiterleitungen (NAT) auf der pfSense, nur im Change, Rückweg über die Beschreibung
function welt() {
  const s = new PfSenseSkill({ baseUrl: 'https://pf', apiKey: 'k' } as never);
  const nat: Array<Record<string, unknown>> = [{ id: 0, interface: 'opt8', protocol: 'tcp', destination: 'opt8:ip', destination_port: '443', target: '172.17.0.10', local_port: '443', descr: '', associated_rule_id: 'nat_alt' }];
  const regeln: Array<Record<string, unknown>> = [{ id: 0, descr: 'NAT alt', associated_rule_id: 'nat_alt' }];
  const aufrufe: string[] = [];
  (s as unknown as { pfFetch: (p: string, o?: RequestInit) => Promise<unknown> }).pfFetch = async (p, o) => {
    const m = o?.method ?? 'GET';
    aufrufe.push(`${m} ${p}`);
    const body = o?.body ? JSON.parse(String(o.body)) : undefined;
    if (p === '/interfaces' || p === '/interface') return { data: [{ id: 'opt8', if: 'vtnet9', descr: 'WAN_GLASFASER' }, { id: 'opt1', if: 'vtnet2', descr: 'MAIN_LAN' }] };
    if (p.startsWith('/firewall/nat/port_forwards')) return { data: nat };
    if (p === '/firewall/nat/port_forward' && m === 'POST') { const rid = `nat_${nat.length}`; nat.push({ id: nat.length, ...body, associated_rule_id: rid }); regeln.push({ id: regeln.length, descr: `NAT ${body.descr}`, associated_rule_id: rid }); return { data: body }; }
    if (p.startsWith('/firewall/nat/port_forward?id=') && m === 'DELETE') { nat.splice(nat.findIndex(x => x.id === Number(p.split('=')[1])), 1); return { data: {} }; }
    if (p.startsWith('/firewall/rules')) return { data: regeln };
    if (p.startsWith('/firewall/rule?id=') && m === 'DELETE') { regeln.splice(regeln.findIndex(r => r.id === Number(p.split('=')[1])), 1); return { data: {} }; }
    if (p.endsWith('/apply')) return { data: { applied: true } };
    throw new Error(`unerwartet ${m} ${p}`);
  };
  return { s, nat, regeln, aufrufe };
}
const imChange = { ausChange: true } as never;
const fw = { action: 'create_port_forward', interface: 'opt8', protocol: 'udp', destination_port: '65246:65248', target: '10.203.27.2', description: 'Matrix LiveKit RTC UDP' };

describe('v1670 pfSense-Port-Weiterleitungen', () => {
  it('nur im Change; anlegen mit verknüpfter Regel, Bereich a:b, local_port = erster Port; wiederholbar; Löschen räumt die Regel mit weg', async () => {
    const w = welt();
    expect((await w.s.execute(fw, {} as never)).success).toBe(false);
    const r = await w.s.execute(fw, imChange);
    expect(r.success).toBe(true);
    const post = w.aufrufe.find(a => a.startsWith('POST /firewall/nat/port_forward'));
    expect(post).toBeDefined();
    expect(w.nat.at(-1)).toMatchObject({ interface: 'opt8', destination: 'opt8:ip', destination_port: '65246:65248', target: '10.203.27.2', local_port: '65246', associated_rule_id: 'nat_1' });
    expect((await w.s.execute(fw, imChange)).display).toContain('bereits genau so vorhanden');
    for (const falsch of [{ target: '8.8.8.8' }, { destination_port: '65246-65248' }, { protocol: 'gre' }, { description: 'x' }, { interface: 'gibtsnicht' }]) {
      expect((await w.s.execute({ ...fw, description: 'Probe Weiterleitung', ...falsch }, imChange)).success).toBe(false);
    }
    expect((await w.s.execute({ ...fw, description: 'Doppelt 443', destination_port: '443', protocol: 'tcp' }, imChange)).error).toContain('schon weitergeleitet');
    const d = await w.s.execute({ action: 'delete_port_forward', description: 'Matrix LiveKit RTC UDP' }, imChange);
    expect(d.success).toBe(true);
    expect(w.nat.map(x => x.id)).toEqual([0]);
    expect(w.regeln.map(x => x.associated_rule_id)).toEqual(['nat_alt']);
  });
});
