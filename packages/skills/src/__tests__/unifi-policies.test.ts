import { describe, it, expect } from 'vitest';
import { baueRegel, neueReihenfolge, portFilter, policyZeile, type Zone, type Netz, type Policy } from '../built-in/unifi-policies.js';

// v1386 — Zonen-Firewall; Realfall 12.10.: mDNS-Antworten der Shellys (DeviceLAN, Quellport 5353) an die UDM geblockt
const zonen: Zone[] = [{ id: 'z-int', name: 'Internal' }, { id: 'z-gw', name: 'Gateway' }, { id: 'z-ext', name: 'External' }];
const netze: Netz[] = [{ id: 'n-dev', name: 'DeviceLAN', zoneId: 'z-int', vlanId: 817 }, { id: 'n-kid', name: 'KinderLan', zoneId: 'z-int', vlanId: 815 }];

describe('UniFi-Policies', () => {
  it('mDNS-Ausnahme: Quellnetz mit Quellport, Zone aus dem Netz, UDP', () => {
    const b = baueRegel({ name: 'A_mDNS_DeviceLAN', aktion: 'ALLOW', quelleNetz: '817', quellePort: '5353', zielZone: 'gateway', protokoll: 'udp' }, zonen, netze);
    expect(b).toEqual({
      enabled: true, name: 'A_mDNS_DeviceLAN',
      action: { type: 'ALLOW', allowReturnTraffic: false },
      source: { zoneId: 'z-int', trafficFilter: { type: 'NETWORK', networkFilter: { networkIds: ['n-dev'], matchOpposite: false }, portFilter: { type: 'PORTS', matchOpposite: false, items: [{ type: 'PORT_NUMBER', value: 5353 }] } } },
      destination: { zoneId: 'z-gw' },
      ipProtocolScope: { ipVersion: 'IPV4', protocolFilter: { type: 'NAMED_PROTOCOL', matchOpposite: false, protocol: { name: 'UDP' } } },
      loggingEnabled: false,
    });
  });

  it('Ports, Bereiche und Fehler', () => {
    expect(portFilter('80, 443,8000-8100')).toEqual({ type: 'PORTS', matchOpposite: false, items: [{ type: 'PORT_NUMBER', value: 80 }, { type: 'PORT_NUMBER', value: 443 }, { type: 'PORT_NUMBER_RANGE', start: 8000, stop: 8100 }] });
    expect(() => portFilter('70000')).toThrow(/außerhalb/);
    expect(() => portFilter('90-80')).toThrow(/rückwärts/);
    expect(() => baueRegel({ name: 'x', aktion: 'ALLOW', quelleNetz: 'DeviceLAN', zielZone: 'Gateway', zielPort: '53' }, zonen, netze)).toThrow(/Protokoll/);
    expect(() => baueRegel({ name: 'x', aktion: 'ALLOW', quelleNetz: 'Gibtsnicht', zielZone: 'Gateway' }, zonen, netze)).toThrow(/unbekannt/);
    expect(() => baueRegel({ name: 'x', aktion: 'DROP' as never, quelleZone: 'Internal', zielZone: 'Gateway' }, zonen, netze)).toThrow(/ALLOW, BLOCK/);
    expect(baueRegel({ name: 'dns', aktion: 'ALLOW', quelleZone: 'Internal', zielZone: 'Gateway', zielPort: '53', protokoll: 'TCP_UDP' }, zonen, netze).ipProtocolScope).toEqual({ ipVersion: 'IPV4', protocolFilter: { type: 'PRESET', preset: { name: 'TCP_UDP' } } });
  });

  it('Reihenfolge: direkt vor die Sperre, auch wenn das API hinten angehängt hat', () => {
    const r = { beforeSystemDefined: ['a', 'dns', 'block817', 'kinder', 'neu'], afterSystemDefined: ['spaet'] };
    expect(neueReihenfolge(r, 'neu', 'block817')).toEqual({ beforeSystemDefined: ['a', 'dns', 'neu', 'block817', 'kinder'], afterSystemDefined: ['spaet'] });
    expect(neueReihenfolge(r, 'neu', 'spaet')).toEqual({ beforeSystemDefined: ['a', 'dns', 'block817', 'kinder'], afterSystemDefined: ['neu', 'spaet'] });
    expect(() => neueReihenfolge(r, 'neu', 'fremd')).toThrow(/Zonenpaar/);
    expect(neueReihenfolge(r, 'neu')).toEqual(r);
  });

  it('lesbare Zeile', () => {
    const p: Policy = { id: 'p1', name: 'Block 817_LAN', enabled: true, action: { type: 'BLOCK' }, source: { zoneId: 'z-int', trafficFilter: { type: 'NETWORK', networkFilter: { networkIds: ['n-dev'], matchOpposite: false } } }, destination: { zoneId: 'z-gw', trafficFilter: { type: 'IP_ADDRESS', ipAddressFilter: { type: 'TRAFFIC_MATCHING_LIST', trafficMatchingListId: 'x' } } }, ipProtocolScope: { ipVersion: 'IPV4' } };
    expect(policyZeile(p, zonen, netze, 7)).toBe('7. BLOCK „Block 817_LAN" — Internal [Netz DeviceLAN] → Gateway [IP-Liste], alle · p1');
  });
});
