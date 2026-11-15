import { describe, it, expect } from 'vitest';
import { UniFiSkill } from '../built-in/unifi.js';
import { filterLesbar, netzadresse, protokollLesbar } from '../built-in/unifi-policies.js';

const NETZ_SQL = 'bbbbbbbbbbbbbbbbbbbbbbbb', ZONE_SQL = 'zSql';
function welt(apiKey: string | null = 'k') {
  const s = new UniFiSkill({ baseUrl: 'https://udm', ...(apiKey ? { apiKey } : { username: 'u', password: 'p' }), verifyTls: false } as never);
  const aufrufe: string[] = [];
  const x = s as unknown as Record<string, unknown>;
  x.request = async (m: string, p: string) => {
    aufrufe.push(`${m} ${p}`);
    if (m === 'GET' && p === 'rest/networkconf') return [{ _id: NETZ_SQL, name: 'SQL-Lab', vlan: 832, vlan_enabled: true, ip_subnet: '10.203.32.1/27' }, { _id: 'cccccccccccccccccccccccc', name: 'Ohne-Subnetz', vlan_enabled: false }];
    throw new Error(`unerwartet ${m} ${p}`);
  };
  x.v2 = async (m: string, p: string) => {
    aufrufe.push(`${m} v2 ${p}`);
    if (m === 'GET' && p === 'firewall/zone') return [{ _id: ZONE_SQL, name: 'SQL', network_ids: [NETZ_SQL] }];
    throw new Error(`unerwartet v2 ${m} ${p}`);
  };
  x.integ = async (m: string, p: string) => {
    aufrufe.push(`${m} integ ${p}`);
    if (m !== 'GET') throw new Error(`unerwartet ${m} ${p}`);
    if (p.startsWith('/sites?')) return { data: [{ id: 'sid', internalReference: 'default' }] };
    if (p.includes('/firewall/zones')) return { data: [{ id: 'iZ1', name: 'SQL' }, { id: 'iZ2', name: 'Internal' }] };
    if (p.includes('/networks')) return { data: [{ id: 'iN1', name: 'SQL-Lab' }] };
    if (p.includes('/firewall/policies')) return { data: [
      { id: 'p1', name: 'Web an SQL', enabled: true, action: { type: 'ALLOW' },
        source: { zoneId: 'iZ2', trafficFilter: { type: 'IP_ADDRESS', ipAddressFilter: { type: 'IP_ADDRESSES', items: [{ type: 'IP_ADDRESS', value: '10.203.30.2' }] } } },
        destination: { zoneId: 'iZ1', trafficFilter: { type: 'PORT', portFilter: { type: 'PORTS', items: [{ type: 'PORT_NUMBER', value: 1433 }] } } },
        ipProtocolScope: { ipVersion: 'IPV4', protocolFilter: { type: 'NAMED_PROTOCOL', protocol: { name: 'TCP' } } }, metadata: { origin: 'USER_DEFINED' } },
      { id: 'p2', name: 'Seltsam', enabled: false, action: { type: 'BLOCK' },
        source: { zoneId: 'iZ2', trafficFilter: { type: 'NEUARTIG', foo: 1 } }, destination: { zoneId: 'unbekannt' }, metadata: { origin: 'SYSTEM_DEFINED' } },
    ] };
    throw new Error(`unerwartet integ ${p}`);
  };
  return { s, aufrufe };
}

describe('UniFi firewallLesen', () => {
  it('Zone liefert ihre Netz-IDs', async () => {
    const r = await welt().s.firewallLesen();
    expect(r.zonen[0]).toEqual({ id: ZONE_SQL, name: 'SQL', netzIds: [NETZ_SQL] });
  });
  it('Netz: VLAN, Netzadresse statt Gateway, Zone', async () => {
    const r = await welt().s.firewallLesen();
    expect(r.netze[0]).toMatchObject({ id: NETZ_SQL, name: 'SQL-Lab', vlan: 832, subnetz: '10.203.32.0/27', zoneId: ZONE_SQL });
  });
  it('Policy: Quelle-IP, Ziel-Port 1433, TCP, Zonennamen, Herkunft', async () => {
    const p = (await welt().s.firewallLesen()).policies[0]!;
    expect(p).toMatchObject({ aktiv: true, aktion: 'ALLOW', quelleZone: 'Internal', zielZone: 'SQL', protokoll: 'TCP', herkunft: 'USER_DEFINED', ziel: 'beliebig' });
    expect(p.quelle).toContain('10.203.30.2');
    expect(p.ports).toContain('1433');
  });
  it('unbekannte Filterform wird als JSON-Kurzfassung gezeigt, nicht verschluckt', async () => {
    const p = (await welt().s.firewallLesen()).policies[1]!;
    expect(p.aktiv).toBe(false);
    expect(p.quelle).toContain('NEUARTIG');
    expect(p.zielZone).toBe('?unbekannt:unbekannt');
  });
  it('ohne API-Schlüssel: Fehler mit Hinweis auf die Integration-API', async () => {
    await expect(welt(null).s.firewallLesen()).rejects.toThrow('Integration-API');
  });
  it('nur lesende Aufrufe (keine PUT/POST/DELETE, keine Dateien)', async () => {
    const w = welt();
    await w.s.firewallLesen();
    expect(w.aufrufe.length).toBeGreaterThan(0);
    expect(w.aufrufe.every(a => a.startsWith('GET'))).toBe(true);
  });
  it('netzadresse rechnet Gateway-Form auf die Netzadresse', () => {
    expect(netzadresse('192.168.1.1/24')).toBe('192.168.1.0/24');
    expect(netzadresse('10.203.24.17/28')).toBe('10.203.24.16/28');
    expect(netzadresse('kaputt')).toBe('kaputt');
  });
  it('netzadresse: /32 bleibt die Adresse, /0 wird 0.0.0.0/0', () => {
    expect(netzadresse('10.1.2.3/32')).toBe('10.1.2.3/32');
    expect(netzadresse('10.1.2.3/0')).toBe('0.0.0.0/0');
  });
  it('Netz ohne ip_subnet/VLAN: keine Felder erfunden', async () => {
    const n = (await welt().s.firewallLesen()).netze[1]!;
    expect(n.subnetz).toBeUndefined();
    expect(n.vlan).toBeUndefined();
  });
  it('Negation bleibt bei Netz, MAC, Domain, IP und Ports sichtbar', () => {
    const f = filterLesbar({ type: 'X', networkFilter: { networkIds: ['a'], matchOpposite: true }, macAddressFilter: { macAddresses: ['aa'], matchOpposite: true }, domainFilter: { domains: ['x.de'], matchOpposite: true }, ipAddressFilter: { items: [{ value: '1.2.3.4' }], matchOpposite: true }, portFilter: { items: [{ value: 53 }], matchOpposite: true } }, id => id);
    expect(f.adresse).toContain('nicht Netz a');
    expect(f.adresse).toContain('nicht MAC aa');
    expect(f.adresse).toContain('nicht Domain x.de');
    expect(f.adresse).toContain('nicht 1.2.3.4');
    expect(f.ports).toBe('nicht 53');
  });
  it('leere Listen heißen (leer), nicht beliebig', () => {
    const f = filterLesbar({ type: 'IP_ADDRESS', ipAddressFilter: { items: [] }, portFilter: { items: [] } }, id => id);
    expect(f.adresse).toBe('(leer)');
    expect(f.ports).toBe('(leer)');
  });
  it('Protokoll: unbekannte Form als JSON, Negation sichtbar, ohne Filter alle', () => {
    expect(protokollLesbar({ protocolFilter: { type: 'NEU', x: 1 } })).toContain('NEU');
    expect(protokollLesbar({ protocolFilter: { protocol: { name: 'TCP' }, matchOpposite: true } })).toBe('nicht TCP');
    expect(protokollLesbar({})).toBe('alle');
  });
});
