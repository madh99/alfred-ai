/**
 * Netz-Aktionen für Infrastruktur-Changes (Owner 22.10.2026: „VLANs soll Alfred selbst anlegen und selbst entscheiden, ob auf UniFi
 * oder pfSense“) — reine Regeln für neue Netze: VLAN frei, Subnetz ohne Überschneidung, Gateway und DHCP-Bereich aus dem Subnetz.
 */

export function ipZahl(ip: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return undefined;
  const t = m.slice(1).map(Number);
  if (t.some(x => x > 255)) return undefined;
  return (((t[0]! << 24) >>> 0) + (t[1]! << 16) + (t[2]! << 8) + t[3]!) >>> 0;
}
export const zahlIp = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/** „10.203.21.0/28“ oder „10.203.21.1/28“ → Netz, Präfix, Gateway (erste Adresse), Broadcast */
export function subnetz(cidr: string): { netz: number; laenge: number; gateway: number; broadcast: number } | undefined {
  const [ip, l] = cidr.trim().split('/');
  const laenge = Number(l);
  const n = ip ? ipZahl(ip) : undefined;
  if (n === undefined || !Number.isInteger(laenge) || laenge < 8 || laenge > 30) return undefined;
  const groesse = 2 ** (32 - laenge);
  const netz = Math.floor(n / groesse) * groesse;
  const gegeben = n !== netz && n !== netz + groesse - 1 ? n : netz + 1;
  return { netz, laenge, gateway: gegeben, broadcast: netz + groesse - 1 };
}
export const ueberschneidet = (a: { netz: number; broadcast: number }, b: { netz: number; broadcast: number }) => a.netz <= b.broadcast && b.netz <= a.broadcast;

export interface NetzNeu { name: string; vlan: number; subnet: string; dhcp?: boolean; dhcpStart?: string; dhcpStop?: string }
export interface NetzVorhanden { name: string; vlan?: number | string; subnet?: string; purpose?: string }

/** Fehler für ein neues Netz gegen die vorhandenen (leer = in Ordnung). */
export function neuesNetzFehler(n: NetzNeu, vorhanden: NetzVorhanden[]): string[] {
  const f: string[] = [];
  if (!/^[\w .-]{2,40}$/.test(n.name)) f.push('name: 2–40 Zeichen (Buchstaben, Ziffern, Leerzeichen, . _ -)');
  if (vorhanden.some(v => v.name.toLowerCase() === n.name.toLowerCase())) f.push(`Netz „${n.name}“ gibt es schon`);
  if (!Number.isInteger(n.vlan) || n.vlan < 2 || n.vlan > 4094) f.push('vlan: 2–4094');
  else if (vorhanden.some(v => Number(v.vlan) === n.vlan)) f.push(`VLAN ${n.vlan} ist schon vergeben (${vorhanden.filter(v => Number(v.vlan) === n.vlan).map(v => v.name).join(', ')})`);
  const s = subnetz(n.subnet);
  if (!s) f.push('subnet: z. B. 10.203.21.0/28 (Präfix 8–30)');
  else {
    for (const v of vorhanden) { const b = v.subnet ? subnetz(v.subnet) : undefined; if (b && ueberschneidet(s, b)) f.push(`Subnetz ${n.subnet} überschneidet sich mit ${v.name} (${v.subnet})`); }
    for (const [k, w] of [['dhcp_start', n.dhcpStart], ['dhcp_stop', n.dhcpStop]] as const) {
      if (!w) continue;
      const z = ipZahl(w);
      if (z === undefined || z <= s.netz || z >= s.broadcast || z === s.gateway) f.push(`${k} ${w} liegt nicht im Subnetz oder ist das Gateway`);
    }
  }
  return f;
}

/** Gateway „a.b.c.d/len“ und DHCP-Bereich (Standard: alles nach dem Gateway bis vor Broadcast). */
export function netzWerte(n: NetzNeu): { ipSubnet: string; gateway: string; dhcpStart: string; dhcpStop: string } {
  const s = subnetz(n.subnet)!;
  return {
    ipSubnet: `${zahlIp(s.gateway)}/${s.laenge}`, gateway: zahlIp(s.gateway),
    dhcpStart: n.dhcpStart ?? zahlIp(s.gateway === s.netz + 1 ? s.netz + 2 : s.netz + 1),
    dhcpStop: n.dhcpStop ?? zahlIp(s.broadcast - 1),
  };
}

/** Hostname für lokales DNS (UniFi) */
export const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * Owner 22.10. („feste IP planen“): Die Sicherungsablage backupshare (Samba, 192.168.1.111) hat keine Reservierung — eine feste IP
 * ist nur zulässig, wenn sie im Subnetz eines Netzes liegt (nicht Gateway/Netz/Broadcast) und kein anderes Gerät sie reserviert hat.
 */
export interface FestIpClient { _id?: string; mac: string; name?: string; hostname?: string; use_fixedip?: boolean; fixed_ip?: string; last_ip?: string; ip?: string; network_id?: string }
export interface FestIpNetz { _id: string; name: string; ip_subnet?: string }
export function festeIpPruefung(mac: string, ip: string, clients: FestIpClient[], netze: FestIpNetz[]): { fehler: string[]; hinweise: string[]; netz?: FestIpNetz; client?: FestIpClient; schonGesetzt: boolean } {
  const fehler: string[] = [], hinweise: string[] = [];
  const m = mac.trim().toLowerCase();
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m)) fehler.push('mac: aa:bb:cc:dd:ee:ff');
  const z = ipZahl(ip);
  if (z === undefined) fehler.push('ip: IPv4-Adresse ohne Präfix, z. B. 192.168.1.111');
  const netz = z === undefined ? undefined : netze.find(n => { const s = n.ip_subnet ? subnetz(n.ip_subnet) : undefined; return !!s && z > s.netz && z < s.broadcast; });
  if (z !== undefined && !netz) fehler.push(`${ip} liegt in keinem Netz der UniFi`);
  else if (netz && z !== undefined && z === subnetz(netz.ip_subnet!)!.gateway) fehler.push(`${ip} ist das Gateway von ${netz.name}`);
  const client = clients.find(c => c.mac.toLowerCase() === m);
  const schonGesetzt = !!client?.use_fixedip && client.fixed_ip === ip && (!netz || client.network_id === netz._id);
  if (client?.use_fixedip && client.fixed_ip && client.fixed_ip !== ip) fehler.push(`${m} hat schon die feste IP ${client.fixed_ip} — erst entfernen (clear_fixed_ip)`);
  for (const c of clients) {
    if (c.mac.toLowerCase() === m) continue;
    const name = c.name || c.hostname || c.mac;
    if (c.use_fixedip && c.fixed_ip === ip) fehler.push(`${ip} ist schon für ${name} (${c.mac}) reserviert`);
    else if ((c.ip ?? c.last_ip) === ip) hinweise.push(`${name} (${c.mac}) hatte zuletzt ${ip} — nur ein alter Eintrag, keine Reservierung`);
  }
  return { fehler, hinweise, ...(netz ? { netz } : {}), ...(client ? { client } : {}), schonGesetzt };
}
