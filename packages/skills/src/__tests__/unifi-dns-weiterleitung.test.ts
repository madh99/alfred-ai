import { describe, it, expect } from 'vitest';
import { UniFiSkill } from '../built-in/unifi.js';

// I8c — Owner 07.11.: bedingte DNS-Weiterleitung der AD-Zone ad.3033.at an den Domänencontroller (Integration-API FORWARD_DOMAIN)
function welt(ipZurueck?: string) {
  const s = new UniFiSkill({ baseUrl: 'https://udm', apiKey: 'k', verifyTls: false } as never);
  const pol: Array<Record<string, unknown>> = [{ id: 'a1', type: 'A_RECORD', domain: 'pve.dohnal.co', ipv4Address: '172.20.20.4', enabled: true }];
  const v2: Array<Record<string, unknown>> = [{ _id: 'v1', key: 'pve.dohnal.co', value: '172.20.20.4', record_type: 'A', enabled: true }];
  const aufrufe: Array<{ m: string; p: string; b?: unknown }> = [];
  const x = s as unknown as { integ: (m: string, p: string, b?: unknown) => Promise<unknown>; v2: (m: string, p: string, b?: unknown) => Promise<unknown> };
  x.integ = async (m, p, b) => {
    aufrufe.push({ m, p, b });
    if (p.startsWith('/sites?')) return { data: [{ id: 'S', internalReference: 'default' }] };
    if (m === 'GET' && p.startsWith('/sites/S/dns/policies')) return { data: pol.map(e => ({ ...e })), totalCount: pol.length };
    if (m === 'POST' && p === '/sites/S/dns/policies') { const n: Record<string, unknown> = { id: 'f1', ...(b as object) }; if (ipZurueck) n.ipAddress = ipZurueck; pol.push(n); return n; }
    if (m === 'DELETE' && p.startsWith('/sites/S/dns/policies/')) { pol.splice(pol.findIndex(y => y.id === p.split('/').pop()), 1); return {}; }
    throw new Error(`unerwartet ${m} ${p}`);
  };
  x.v2 = async (m, p) => { if (m === 'GET' && p === 'static-dns') return v2.map(e => ({ ...e })); throw new Error(`unerwartet v2 ${m} ${p}`); };
  return { s, pol, aufrufe };
}

describe('I8c UniFi DNS-Weiterleitung', () => {
  it('anlegen mit Rücklesen, in der Liste sichtbar, doppelt abgewiesen, löschen über die Domäne', async () => {
    const w = welt();
    const r = await w.s.execute({ action: 'create_dns_record', hostname: 'AD.3033.at', ip: '10.203.29.2', record_type: 'FORWARD' }, {} as never);
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(w.aufrufe.find(a => a.m === 'POST')!.b).toEqual({ type: 'FORWARD_DOMAIN', enabled: true, domain: 'ad.3033.at', ipAddress: '10.203.29.2' });
    expect((await w.s.execute({ action: 'list_dns_records' }, {} as never)).display).toContain('| ad.3033.at | FORWARD | 10.203.29.2 | ja |');
    expect((await w.s.execute({ action: 'create_dns_record', hostname: 'ad.3033.at', ip: '10.203.29.3', record_type: 'FORWARD' }, {} as never)).error).toContain('gibt es schon');
    expect((await w.s.execute({ action: 'create_dns_record', hostname: 'ad.3033.at', ip: 'dc01', record_type: 'FORWARD' }, {} as never)).error).toContain('IPv4');
    expect((await w.s.execute({ action: 'delete_dns_record', hostname: 'ad.3033.at' }, {} as never)).success).toBe(true);
    expect(w.pol.map(p => p.id)).toEqual(['a1']);
  });
  it('liest die Steuerung etwas anderes zurück, ist das ein Fehler (Feldnamen nicht offiziell belegt)', async () => {
    const w = welt('0.0.0.0');
    const r = await w.s.execute({ action: 'create_dns_record', hostname: 'ad.3033.at', ip: '10.203.29.2', record_type: 'FORWARD' }, {} as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain('nicht wie erwartet lesbar');
  });
});
