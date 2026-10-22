/**
 * v1386 — UniFi-Firewall auf dem Zonen-Modell (Network 9+/11, offizielles Integration-API v1). Das alte Regelmodell
 * (`rest/firewallrule`, create_firewall_rule) ist auf der UDM leer und wirkungslos (Realfall 12.10.: Shelly-mDNS-Antworten
 * aus dem DeviceLAN von „Block 817_LAN" geblockt — eine Ausnahme mit dem alten Modell hätte nichts bewirkt).
 *
 * Reihenfolge zählt (erste passende Regel gewinnt) und gilt je Zonenpaar: Eine neue Policy hängt das API hinten an, also
 * hinter eine vorhandene Sperre; darum setzt `neueReihenfolge` sie gezielt vor die genannte Policy.
 * Die IDs des Integration-API unterscheiden sich von denen des internen API — Namen werden hier aufgelöst.
 */

export interface Zone { id: string; name: string }
export interface Netz { id: string; name: string; zoneId?: string; vlanId?: number }
export interface Policy {
  id: string; name: string; enabled: boolean; index?: number;
  action: { type: string; allowReturnTraffic?: boolean };
  source: { zoneId: string; trafficFilter?: Record<string, unknown> };
  destination: { zoneId: string; trafficFilter?: Record<string, unknown> };
  ipProtocolScope?: { ipVersion: string; protocolFilter?: Record<string, unknown> };
  loggingEnabled?: boolean;
  metadata?: { origin?: string };
}
export interface Reihenfolge { beforeSystemDefined: string[]; afterSystemDefined: string[] }

export interface RegelWunsch {
  name: string;
  aktion: 'ALLOW' | 'BLOCK' | 'REJECT';
  quelleZone?: string; quelleNetz?: string; quellePort?: string;
  zielZone?: string; zielNetz?: string; zielPort?: string;
  /** Pilot cf82f3f2 (22.10.) — einzelne Adressen, Subnetze (CIDR) oder Bereiche a-b, kommagetrennt; statt eines Netzes */
  quelleIps?: string; zielIps?: string;
  /** Antworten auf erlaubte Verbindungen ausdrücklich zulassen (sonst kann eine BLOCK-Regel der Gegenrichtung sie treffen) */
  rueckverkehr?: boolean;
  protokoll?: string; // TCP | UDP | TCP_UDP | ICMP | alle
  ipVersion?: 'IPV4' | 'IPV6' | 'IPV4_AND_IPV6';
  logging?: boolean;
}

const gleich = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function findeZone(zonen: Zone[], name: string): Zone {
  const z = zonen.find(x => gleich(x.name, name) || x.id === name);
  if (!z) throw new Error(`Zone „${name}" unbekannt — vorhanden: ${zonen.map(x => x.name).join(', ')}`);
  return z;
}
function findeNetz(netze: Netz[], name: string): Netz {
  const n = netze.find(x => gleich(x.name, name) || x.id === name || (x.vlanId !== undefined && String(x.vlanId) === name.trim()));
  if (!n) throw new Error(`Netz „${name}" unbekannt — Name, ID oder VLAN-Nummer angeben`);
  return n;
}

/** „5353", „80,443", „8000-8100" → Port-Filter des API. */
export function portFilter(spez: string): Record<string, unknown> {
  const items = spez.split(',').map(t => t.trim()).filter(Boolean).map((t) => {
    const m = t.match(/^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/);
    if (!m) throw new Error(`Port „${t}" ungültig (Zahl oder Bereich a-b)`);
    const a = Number(m[1]); const b = m[2] ? Number(m[2]) : undefined;
    for (const x of [a, b]) if (x !== undefined && (x < 1 || x > 65535)) throw new Error(`Port ${x} außerhalb 1–65535`);
    if (b !== undefined && b < a) throw new Error(`Portbereich ${t} rückwärts`);
    return b === undefined ? { type: 'PORT_NUMBER', value: a } : { type: 'PORT_NUMBER_RANGE', start: a, stop: b };
  });
  if (!items.length) throw new Error('Port fehlt');
  return { type: 'PORTS', matchOpposite: false, items };
}

function protokollScope(protokoll: string | undefined, ipVersion: string, mitPort: boolean): Record<string, unknown> {
  const p = (protokoll ?? '').trim().toUpperCase();
  if (!p || p === 'ALLE' || p === 'ALL' || p === 'ANY') {
    if (mitPort) throw new Error('Ports brauchen ein Protokoll (TCP, UDP oder TCP_UDP)');
    return { ipVersion };
  }
  if (p === 'TCP_UDP' || p === 'TCP/UDP') return { ipVersion, protocolFilter: { type: 'PRESET', preset: { name: 'TCP_UDP' } } };
  if (!['TCP', 'UDP', 'ICMP'].includes(p)) throw new Error(`Protokoll „${protokoll}" — erlaubt: TCP, UDP, TCP_UDP, ICMP, alle`);
  if (p === 'ICMP' && mitPort) throw new Error('ICMP hat keine Ports');
  return { ipVersion, protocolFilter: { type: 'NAMED_PROTOCOL', matchOpposite: false, protocol: { name: p } } };
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
/** „192.168.1.92“, „10.203.24.0/28“, „10.0.0.5-10.0.0.9“ (kommagetrennt) → IP-Filter des API */
export function ipFilter(spez: string): Record<string, unknown> {
  const items = spez.split(',').map(t => t.trim()).filter(Boolean).map((t) => {
    const sub = /^(.+)\/(\d{1,2})$/.exec(t);
    if (sub) { if (!IPV4.test(sub[1]!) || Number(sub[2]) > 32) throw new Error(`Subnetz „${t}" ungültig`); return { type: 'SUBNET', value: t }; }
    const rng = /^(.+?)\s*-\s*(.+)$/.exec(t);
    if (rng) { if (!IPV4.test(rng[1]!) || !IPV4.test(rng[2]!)) throw new Error(`Bereich „${t}" ungültig`); return { type: 'IP_ADDRESS_RANGE', start: rng[1], stop: rng[2] }; }
    if (!IPV4.test(t)) throw new Error(`IP-Adresse „${t}" ungültig`);
    return { type: 'IP_ADDRESS', value: t };
  });
  if (!items.length) throw new Error('IP-Adresse fehlt');
  return { type: 'IP_ADDRESSES', matchOpposite: false, items };
}

function seite(netzName: string | undefined, port: string | undefined, netze: Netz[], ips?: string): Record<string, unknown> | undefined {
  if (netzName && ips) throw new Error('Netz und IP-Adressen nicht gleichzeitig auf einer Seite — eins von beiden');
  if (ips) return { type: 'IP_ADDRESS', ipAddressFilter: ipFilter(ips), ...(port ? { portFilter: portFilter(port) } : {}) };
  if (netzName) {
    const n = findeNetz(netze, netzName);
    return { type: 'NETWORK', networkFilter: { networkIds: [n.id], matchOpposite: false }, ...(port ? { portFilter: portFilter(port) } : {}) };
  }
  if (port) return { type: 'PORT', portFilter: portFilter(port) };
  return undefined;
}

/** Wunsch → Body für POST firewall/policies. Quellzone ergibt sich aus dem Quellnetz, wenn nicht genannt. */
export function baueRegel(w: RegelWunsch, zonen: Zone[], netze: Netz[]): Record<string, unknown> {
  if (!w.name?.trim()) throw new Error('name fehlt');
  if (!['ALLOW', 'BLOCK', 'REJECT'].includes(w.aktion)) throw new Error('aktion muss ALLOW, BLOCK oder REJECT sein');
  const zoneFuer = (zone: string | undefined, netz: string | undefined, rolle: string): Zone => {
    if (zone) return findeZone(zonen, zone);
    const n = netz ? findeNetz(netze, netz) : undefined;
    const z = n?.zoneId ? zonen.find(x => x.id === n.zoneId) : undefined;
    if (!z) throw new Error(`${rolle}zone fehlt (Name der Zone oder ein Netz mit Zone)`);
    return z;
  };
  const qz = zoneFuer(w.quelleZone, w.quelleNetz, 'Quell');
  const zz = zoneFuer(w.zielZone, w.zielNetz, 'Ziel');
  const qf = seite(w.quelleNetz, w.quellePort, netze, w.quelleIps);
  const zf = seite(w.zielNetz, w.zielPort, netze, w.zielIps);
  return {
    enabled: true, name: w.name.trim(),
    // Realfall 22.10. (d72cbb06): zum Gateway lehnt die UDM „Rückverkehr zulassen“ ab (cant-allow-return-traffic)
    action: w.aktion === 'ALLOW' ? { type: 'ALLOW', allowReturnTraffic: w.rueckverkehr === true && zz.name.toLowerCase() !== 'gateway' } : { type: w.aktion },
    source: { zoneId: qz.id, ...(qf ? { trafficFilter: qf } : {}) },
    destination: { zoneId: zz.id, ...(zf ? { trafficFilter: zf } : {}) },
    ipProtocolScope: protokollScope(w.protokoll, w.ipVersion ?? 'IPV4', !!(w.quellePort || w.zielPort)),
    loggingEnabled: w.logging === true,
  };
}

/** Neue Policy direkt vor `vorId` einsortieren (in der Liste, die `vorId` enthält); ohne `vorId` unverändert. */
export function neueReihenfolge(r: Reihenfolge, neueId: string, vorId?: string): Reihenfolge {
  const ohne = (l: string[]) => l.filter(x => x !== neueId);
  const vorher = ohne(r.beforeSystemDefined); const nachher = ohne(r.afterSystemDefined);
  if (!vorId) return { beforeSystemDefined: [...r.beforeSystemDefined], afterSystemDefined: [...r.afterSystemDefined] };
  const einfuegen = (l: string[]) => { const i = l.indexOf(vorId); return i < 0 ? undefined : [...l.slice(0, i), neueId, ...l.slice(i)]; };
  const v = einfuegen(vorher);
  if (v) return { beforeSystemDefined: v, afterSystemDefined: nachher };
  const n = einfuegen(nachher);
  if (n) return { beforeSystemDefined: vorher, afterSystemDefined: n };
  throw new Error('Die Policy, vor die eingefügt werden soll, liegt nicht im selben Zonenpaar');
}

function filterText(f: Record<string, unknown> | undefined, netze: Netz[]): string {
  if (!f) return 'alles';
  const teile: string[] = [];
  const nf = f.networkFilter as { networkIds?: string[]; matchOpposite?: boolean } | undefined;
  if (nf?.networkIds) teile.push(`${nf.matchOpposite ? 'nicht ' : ''}Netz ${nf.networkIds.map(id => netze.find(n => n.id === id)?.name ?? id.slice(0, 8)).join('/')}`);
  const ipf = f.ipAddressFilter as { type?: string; items?: Array<{ value?: string }>; trafficMatchingListId?: string } | undefined;
  if (ipf) teile.push(ipf.items ? `IP ${ipf.items.map(i => i.value).join(',')}` : 'IP-Liste');
  const pf = f.portFilter as { items?: Array<{ value?: number; start?: number; stop?: number }>; type?: string } | undefined;
  if (pf) teile.push(pf.items ? `Port ${pf.items.map(i => i.value ?? `${i.start}-${i.stop}`).join(',')}` : 'Port-Liste');
  const mf = f.macAddressFilter as { macAddresses?: string[] } | undefined;
  if (mf?.macAddresses) teile.push(`MAC ${mf.macAddresses.length}`);
  return teile.join(' ') || String(f.type ?? '?').toLowerCase();
}

/** Eine Zeile je Policy für die Ausgabe (Position = Reihenfolge im Zonenpaar, falls bekannt). */
export function policyZeile(p: Policy, zonen: Zone[], netze: Netz[], pos?: number): string {
  const zn = (id: string) => zonen.find(z => z.id === id)?.name ?? id.slice(0, 8);
  const pr = p.ipProtocolScope?.protocolFilter as { protocol?: { name?: string }; preset?: { name?: string } } | undefined;
  const proto = pr?.protocol?.name ?? pr?.preset?.name ?? 'alle';
  return `${pos !== undefined ? `${pos}. ` : ''}${p.enabled ? '' : '(aus) '}${p.action.type} „${p.name || '(ohne Name)'}" — ${zn(p.source.zoneId)} [${filterText(p.source.trafficFilter, netze)}] → ${zn(p.destination.zoneId)} [${filterText(p.destination.trafficFilter, netze)}], ${proto}${p.metadata?.origin === 'SYSTEM_DEFINED' ? ', System' : ''} · ${p.id}`;
}
