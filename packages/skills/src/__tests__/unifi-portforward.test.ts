import { describe, it, expect } from 'vitest';
import { UniFiSkill } from '../built-in/unifi.js';

// v1669 — Owner 25.10.: Matrix-Videoanrufe von außen → Port-Weiterleitungen lesen, anlegen, löschen (Ändern nur in Changes)
function welt() {
  const s = new UniFiSkill({ baseUrl: 'https://udm', apiKey: 'k', verifyTls: false } as never);
  const pf: Array<Record<string, unknown>> = [{ _id: 'p1', name: 'alt', proto: 'tcp', dst_port: '443', fwd: '192.168.1.139', fwd_port: '443', src: 'any', enabled: true }];
  const aufrufe: string[] = [];
  (s as unknown as { request: (m: string, p: string, b?: unknown) => Promise<unknown> }).request = async (m, p, b) => {
    aufrufe.push(`${m} ${p}`);
    if (p === 'rest/portforward' && m === 'GET') return pf;
    if (p === 'rest/portforward' && m === 'POST') { const n = { _id: 'p2', ...(b as object) }; pf.push(n); return [n]; }
    if (p.startsWith('rest/portforward/') && m === 'DELETE') { const i = pf.findIndex(x => x._id === p.split('/')[2]); pf.splice(i, 1); return {}; }
    throw new Error(`unerwartet ${m} ${p}`);
  };
  return { s, pf, aufrufe };
}
const imChange = { ausChange: true } as never;

describe('v1669 UniFi Port-Weiterleitungen', () => {
  it('lesen, anlegen (nur im Change, geprüfte Eingaben), löschen per Name', async () => {
    const w = welt();
    expect((await w.s.execute({ action: 'list_port_forwards' }, {} as never)).display).toContain('192.168.1.139:443');
    expect((await w.s.execute({ action: 'create_port_forward', forward_name: 'LiveKit UDP', protocol: 'udp', port: '65246-65248', forward_ip: '10.203.27.2' }, {} as never)).success).toBe(false); // außerhalb eines Changes
    const r = await w.s.execute({ action: 'create_port_forward', forward_name: 'LiveKit UDP', protocol: 'udp', port: '65246-65248', forward_ip: '10.203.27.2' }, imChange);
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ id: 'p2', proto: 'udp', dst_port: '65246-65248', fwd: '10.203.27.2', fwd_port: '65246-65248' });
    for (const falsch of [{ forward_ip: '8.8.8.8' }, { port: '80; rm' }, { protocol: 'gre' }, { forward_name: 'x' }]) {
      expect((await w.s.execute({ action: 'create_port_forward', forward_name: 'Probe Weiterleitung', protocol: 'tcp', port: '7881', forward_ip: '10.203.27.2', ...falsch }, imChange)).success).toBe(false);
    }
    expect((await w.s.execute({ action: 'create_port_forward', forward_name: 'LiveKit UDP', protocol: 'udp', port: '1', forward_ip: '10.203.27.2' }, imChange)).error).toContain('gibt es schon');
    expect((await w.s.execute({ action: 'delete_port_forward', forward_name: 'LiveKit UDP' }, imChange)).success).toBe(true);
    expect(w.pf.map(x => x._id)).toEqual(['p1']);
  });
});
