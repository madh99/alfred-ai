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
