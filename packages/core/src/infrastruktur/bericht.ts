/**
 * Spec Infrastruktur-Vorhaben, I1 — Bestandsbericht aus den Sammlern und der CMDB, mit festen Regeln für Auffälligkeiten
 * (ohne Modell): Container unhealthy/beendet, Platten voll, Sicherheitsupdates offen, Betriebssystem ohne Support, VMs ohne oder mit
 * alter Sicherung, nicht erreichbare Backup-Speicher, Proxy-Ziele ohne Dienst. Der Bericht ist die Grundlage für den Architektur-
 * Vorschlag (I2); er ändert nichts.
 */
import type { HostBestand } from './sammler.js';

export interface VmEintrag { name: string; typ: string; status: string; ip?: string; node?: string; vmid?: number }
export interface ProxyEintrag { domains: string[]; forwardHost: string; forwardPort: number; assetId?: string }
/** Öffentlicher DNS-Eintrag (Cloudflare) — Owner 22.10.: „öffentlich verfügbare Domains … Cloudflare eingebunden?“ */
export interface DnsEintrag { fqdn: string; typ: string; inhalt: string; proxied?: boolean; zone: string; assetId?: string }
export interface DomainStand { domain: string; proxy: ProxyEintrag; eintrag?: DnsEintrag; zone?: string }

/** Je Proxy-Domain: der passende Cloudflare-Eintrag (A/AAAA/CNAME, auch Wildcard) und ob die Domain in einer Cloudflare-Zone liegt. */
export function domainsMitDns(proxy: ProxyEintrag[], dns: DnsEintrag[]): DomainStand[] {
  const zonen = [...new Set(dns.map(d => d.zone.toLowerCase()))].sort((a, b) => b.length - a.length);
  const web = dns.filter(d => ['A', 'AAAA', 'CNAME'].includes(d.typ.toUpperCase()));
  const aus: DomainStand[] = [];
  for (const p of proxy) for (const d0 of p.domains) {
    const d = d0.toLowerCase();
    const zone = zonen.find(z => d === z || d.endsWith(`.${z}`));
    const eintrag = web.find(x => x.fqdn.toLowerCase() === d) ?? (zone ? web.find(x => x.fqdn.toLowerCase() === `*.${d.slice(d.indexOf('.') + 1)}`) : undefined);
    aus.push({ domain: d0, proxy: p, ...(eintrag ? { eintrag } : {}), ...(zone ? { zone } : {}) });
  }
  return aus;
}
export function dnsText(s: DomainStand): string {
  if (!s.zone) return 'nicht in Cloudflare';
  if (!s.eintrag) return `Cloudflare-Zone ${s.zone}, kein Eintrag`;
  return `Cloudflare ${s.eintrag.proxied ? 'Proxy' : 'nur DNS'}: ${s.eintrag.typ} ${s.eintrag.inhalt}${s.eintrag.fqdn.startsWith('*.') ? ' (Wildcard)' : ''}`;
}
export interface NetzEintrag { quelle: string; name: string; vlan?: string | number; subnet?: string }
export interface BackupStand {
  jeVm: Record<number, { name?: string; neueste?: string; anzahl: number; speicher: string[] }>;
  ohne: Array<{ vmid: number; name?: string }>;
  unerreichbar: Array<{ speicher: string; grund: string }>;
}
/** I4b Teil 3 — `schluessel` ist stabil über Läufe (für Problems ohne Doppelte), `kategorie` steuert die Übernahme ins ITSM */
export type BefundKategorie = 'container' | 'platte' | 'updates' | 'os' | 'paketverwaltung' | 'erfassung' | 'sicherung' | 'proxy';
export interface Auffaelligkeit { schwere: 'hoch' | 'mittel' | 'niedrig'; bereich: string; text: string; schluessel?: string; kategorie?: BefundKategorie; zugang?: string }

export const BACKUP_ALT_TAGE = 7;
export const PLATTE_VOLL_PROZENT = 85;

/** Support-Ende (Herausgeber-Angaben, Stand 10/2026): Debian ≤ 11 und Ubuntu < 22.04 ohne Support; Ubuntu ohne LTS kurzlebig. */
export function osSupport(os: HostBestand['os'], jetzt = new Date()): { ok: boolean; text?: string } {
  if (!os?.id) return { ok: true };
  const v = Number.parseFloat(os.version ?? '');
  if (os.id === 'debian' && Number.isFinite(v)) {
    const ende: Record<number, string> = { 10: '2024-06-30', 11: '2026-08-31', 12: '2028-06-30', 13: '2030-06-30' };
    const e = ende[Math.floor(v)];
    if (Math.floor(v) < 10 || (e && jetzt.toISOString().slice(0, 10) > e)) return { ok: false, text: `${os.name}: Support endete ${e ?? 'vor 2024'}` };
  }
  if (os.id === 'ubuntu' && /^\d{2}\.\d{2}$/.test(os.version ?? '')) {
    const [jj, mm] = os.version!.split('.').map(Number) as [number, number];
    const lts = mm === 4 && jj % 2 === 0;
    if (!lts) return { ok: false, text: `${os.name}: keine LTS-Version (kurzer Support)` };
    if (jetzt.getFullYear() > 2000 + jj + 5 || (jetzt.getFullYear() === 2000 + jj + 5 && jetzt.getMonth() >= 4)) return { ok: false, text: `${os.name}: Standard-Support (5 Jahre) beendet` };
  }
  // v1627 — Rocky/Alma folgen RHEL (Ende der Wartung je Hauptversion); Fedora: jede Version gut 13 Monate (Stand 10/2026: ≤ 42 beendet)
  if ((os.id === 'rocky' || os.id === 'almalinux' || os.id === 'rhel') && Number.isFinite(v)) {
    const ende: Record<number, string> = { 8: '2029-05-31', 9: '2032-05-31', 10: '2035-05-31' };
    const e = ende[Math.floor(v)];
    if (Math.floor(v) < 8 || (e && jetzt.toISOString().slice(0, 10) > e)) return { ok: false, text: `${os.name}: Support endete ${e ?? 'vor 2024'}` };
  }
  if (os.id === 'fedora' && Number.isFinite(v) && v <= 42) return { ok: false, text: `${os.name}: Support beendet (Fedora-Versionen werden nur gut 13 Monate gepflegt)` };
  return { ok: true };
}

export function auffaelligkeiten(e: { hosts: HostBestand[]; vms: VmEintrag[]; proxy: ProxyEintrag[]; backups?: BackupStand; dns?: DnsEintrag[] }, jetzt = new Date()): Auffaelligkeit[] {
  const a: Auffaelligkeit[] = [];
  for (const h of e.hosts) {
    for (const c of h.container) {
      const k = { kategorie: 'container' as const, zugang: h.zugang };
      if (c.gesundheit === 'unhealthy') a.push({ schwere: 'hoch', bereich: h.zugang, text: `Container ${c.name} ist unhealthy (${c.status})`, schluessel: `container-unhealthy:${h.zugang}:${c.name}`, ...k });
      else if (c.zustand === 'restarting') a.push({ schwere: 'hoch', bereich: h.zugang, text: `Container ${c.name} startet ständig neu (${c.status})`, schluessel: `container-neustart:${h.zugang}:${c.name}`, ...k });
      else if (c.zustand === 'exited' && !/Exited \(0\)/.test(c.status)) a.push({ schwere: 'niedrig', bereich: h.zugang, text: `Container ${c.name} beendet mit Fehler (${c.status}) — aufräumen oder reparieren`, schluessel: `container-beendet:${h.zugang}:${c.name}`, ...k });
    }
    for (const f of h.dateisysteme) if (f.prozent >= PLATTE_VOLL_PROZENT) a.push({ schwere: f.prozent >= 95 ? 'hoch' : 'mittel', bereich: h.zugang, text: `${f.mount} zu ${f.prozent} % belegt (${f.belegt} von ${f.groesse})`, schluessel: `platte:${h.zugang}:${f.mount}`, kategorie: 'platte', zugang: h.zugang });
    if (h.updates?.sicherheit) a.push({ schwere: 'mittel', bereich: h.zugang, text: `${h.updates.sicherheit} Sicherheitsupdates offen (${h.updates.anzahl} Updates gesamt)`, schluessel: `updates:${h.zugang}`, kategorie: 'updates', zugang: h.zugang });
    const os = osSupport(h.os, jetzt);
    if (!os.ok) a.push({ schwere: 'mittel', bereich: h.zugang, text: os.text!, schluessel: `os:${h.zugang}:${h.os?.id ?? ''}${h.os?.version ?? ''}`, kategorie: 'os', zugang: h.zugang });
    // I1 (Realfall 22.10. dockerhost: „Problem with MergeList …“) — gestörte Paketverwaltung ist ein Befund, kein bloßer Erfassungsfehler
    const apt = h.fehler.find(f => f.startsWith('updates:') && /MergeList|Hash Sum mismatch|Could not get lock|dpkg was interrupted|NO_PUBKEY|EXPKEYSIG/i.test(f));
    if (apt) a.push({ schwere: 'mittel', bereich: h.zugang, text: `Paketverwaltung gestört — Updates nicht prüfbar (${apt.replace(/^updates:\s*/, '').replace(/\s+/g, ' ').slice(0, 120)})`, schluessel: `paketverwaltung:${h.zugang}`, kategorie: 'paketverwaltung', zugang: h.zugang });
    const rest = h.fehler.filter(f => f !== apt);
    if (rest.length) a.push({ schwere: 'niedrig', bereich: h.zugang, text: `Nicht erfasst: ${rest.map(f => f.split(':')[0]).join(', ')}`, schluessel: `erfassung:${h.zugang}`, kategorie: 'erfassung', zugang: h.zugang });
  }
  if (e.backups) {
    for (const u of e.backups.unerreichbar) a.push({ schwere: 'hoch', bereich: 'Sicherung', text: `Backup-Speicher ${u.speicher} ${u.grund}`, schluessel: `sicherung-speicher:${u.speicher}`, kategorie: 'sicherung' });
    const laufend = new Set(e.vms.filter(v => v.status === 'active' && v.vmid !== undefined).map(v => v.vmid!));
    for (const o of e.backups.ohne) if (laufend.has(o.vmid)) a.push({ schwere: 'hoch', bereich: 'Sicherung', text: `VM/CT ${o.vmid}${o.name ? ` (${o.name})` : ''} hat keine Sicherung`, schluessel: `sicherung-fehlt:${o.vmid}`, kategorie: 'sicherung' });
    for (const [id, s] of Object.entries(e.backups.jeVm)) {
      if (!laufend.has(Number(id)) || !s.neueste) continue;
      const tage = Math.floor((jetzt.getTime() - Date.parse(s.neueste)) / 86_400_000);
      if (tage > BACKUP_ALT_TAGE) a.push({ schwere: tage > 30 ? 'hoch' : 'mittel', bereich: 'Sicherung', text: `VM/CT ${id}${s.name ? ` (${s.name})` : ''}: neueste Sicherung vor ${tage} Tagen`, schluessel: `sicherung-alt:${id}`, kategorie: 'sicherung' });
    }
  }
  // Proxy-Ziele auf einem erfassten Host ohne lauschenden Port
  const hostNachIp = new Map(e.hosts.map(h => [h.host, h] as const));
  for (const p of e.proxy) {
    const h = hostNachIp.get(p.forwardHost);
    if (h && h.ports.length && !h.ports.some(x => x.port === p.forwardPort)) a.push({ schwere: 'mittel', bereich: 'Proxy', text: `${p.domains[0] ?? '?'} → ${p.forwardHost}:${p.forwardPort}: auf ${h.zugang} lauscht dort kein Dienst`, schluessel: `proxy:${p.domains[0] ?? ''}:${p.forwardHost}:${p.forwardPort}`, kategorie: 'proxy', zugang: h.zugang });
  }
  // Proxy-Domain in einer Cloudflare-Zone ohne öffentlichen Eintrag (die Domain ist im Internet nicht erreichbar)
  if (e.dns?.length) for (const s of domainsMitDns(e.proxy, e.dns)) if (s.zone && !s.eintrag) a.push({ schwere: 'mittel', bereich: 'DNS', text: `${s.domain}: NPM-Eintrag vorhanden, aber kein DNS-Eintrag in der Cloudflare-Zone ${s.zone}`, schluessel: `proxy-dns:${s.domain.toLowerCase()}`, kategorie: 'proxy' });
  const rang = { hoch: 0, mittel: 1, niedrig: 2 } as const;
  return a.sort((x, y) => rang[x.schwere] - rang[y.schwere]);
}

const gb = (b?: number) => (b ? `${(b / 1024 ** 3).toFixed(1)} GB` : '—');

export function bestandsbericht(e: { hosts: HostBestand[]; vms: VmEintrag[]; proxy: ProxyEintrag[]; netze: NetzEintrag[]; backups?: BackupStand; dns?: DnsEintrag[] }, jetzt = new Date()): { markdown: string; auffaelligkeiten: Auffaelligkeit[]; kurz: string } {
  const auff = auffaelligkeiten(e, jetzt);
  const datum = jetzt.toLocaleString('de-AT', { timeZone: 'Europe/Vienna', dateStyle: 'medium', timeStyle: 'short' });
  const z: string[] = [`# Bestandsbericht ${datum}`, '', '_Erstellt von Alfred (Bestandsaufnahme I1, nur lesend). Grundlage für den Architektur-Vorschlag._', ''];
  const laufend = e.vms.filter(v => v.status === 'active');
  z.push('## Überblick', '', `- Proxmox: ${e.vms.length} VMs/Container (${laufend.length} laufend)`, `- Hosts mit Fernzugang erfasst: ${e.hosts.length}`,
    `- Container auf erfassten Hosts: ${e.hosts.reduce((s, h) => s + h.container.length, 0)}`, `- Reverse-Proxy-Einträge: ${e.proxy.length}`, `- Netze/VLANs: ${e.netze.length}`,
    `- Auffälligkeiten: ${auff.filter(x => x.schwere === 'hoch').length} hoch, ${auff.filter(x => x.schwere === 'mittel').length} mittel, ${auff.filter(x => x.schwere === 'niedrig').length} niedrig`, '');
  z.push('## Auffälligkeiten', '');
  if (!auff.length) z.push('Keine.');
  for (const x of auff) z.push(`- **${x.schwere}** · ${x.bereich}: ${x.text}`);
  z.push('');
  for (const h of e.hosts) {
    z.push(`## Host ${h.zugang} (${h.host})`, '');
    z.push(`- System: ${h.os?.name ?? '—'}${h.kernel ? `, Kernel ${h.kernel}` : ''}${h.cpus ? `, ${h.cpus} CPUs` : ''}${h.ram ? `, RAM ${gb(h.ram.belegt)} von ${gb(h.ram.gesamt)}` : ''}`);
    if (h.updates) z.push(`- Updates: ${h.updates.anzahl} (davon Sicherheit ${h.updates.sicherheit})`);
    if (h.dateisysteme.length) z.push(`- Dateisysteme: ${h.dateisysteme.map(f => `${f.mount} ${f.prozent} % von ${f.groesse}`).join('; ')}`);
    if (h.dienste.length) z.push(`- Dienste (${h.dienste.length}): ${h.dienste.slice(0, 40).join(', ')}${h.dienste.length > 40 ? ' …' : ''}`);
    if (h.ports.length) z.push(`- Offene Ports: ${h.ports.map(p => `${p.port}${p.prozess ? ` (${p.prozess})` : ''}`).join(', ')}`);
    if (h.container.length) {
      z.push('', `| Container | Image | Zustand | Compose | Netze | Volumes/Mounts |`, '|---|---|---|---|---|---|');
      for (const c of [...h.container].sort((a, b) => (a.composeProjekt ?? '~').localeCompare(b.composeProjekt ?? '~') || a.name.localeCompare(b.name))) {
        z.push(`| ${c.name} | ${c.image} | ${c.zustand}${c.gesundheit ? ` (${c.gesundheit})` : ''} | ${c.composeProjekt ? `${c.composeProjekt}/${c.composeDienst ?? ''}` : '—'} | ${c.netze.join(', ')} | ${c.mounts.slice(0, 4).join(', ')}${c.mounts.length > 4 ? ' …' : ''} |`);
      }
    }
    if (h.compose.length) z.push('', `Compose-Projekte: ${h.compose.map(p => `${p.name} (${p.status}, ${p.dateien})`).join('; ')}`);
    if (h.volumes.length) z.push(`Volumes: ${h.volumes.map(v => `${v.name} ${v.groesse}`).join(', ')}`);
    z.push('');
  }
  if (e.vms.length) {
    z.push('## Proxmox VMs/Container', '', '| Name | Typ | Knoten | Status | IP | Neueste Sicherung |', '|---|---|---|---|---|---|');
    for (const v of [...e.vms].sort((a, b) => (a.vmid ?? 0) - (b.vmid ?? 0))) {
      const b = v.vmid !== undefined ? e.backups?.jeVm[v.vmid] : undefined;
      z.push(`| ${v.vmid ?? ''} ${v.name} | ${v.typ} | ${v.node ?? ''} | ${v.status} | ${v.ip ?? ''} | ${b?.neueste ? b.neueste.slice(0, 10) : '—'} |`);
    }
    z.push('');
  }
  if (e.netze.length) {
    z.push('## Netze und VLANs', '');
    for (const q of [...new Set(e.netze.map(n => n.quelle))]) z.push(`- **${q}:** ${e.netze.filter(n => n.quelle === q).map(n => `${n.name}${n.vlan !== undefined && n.vlan !== '' ? ` (VLAN ${n.vlan})` : ''}${n.subnet ? ` ${n.subnet}` : ''}`).join('; ')}`);
    z.push('');
  }
  if (e.proxy.length) {
    z.push('## Reverse-Proxy (NPM) und öffentliches DNS (Cloudflare)', '', '| Domain | NPM-Ziel | DNS |', '|---|---|---|');
    for (const s of domainsMitDns(e.proxy, e.dns ?? [])) z.push(`| ${s.domain} | ${s.proxy.forwardHost}:${s.proxy.forwardPort} | ${e.dns?.length ? dnsText(s) : '—'} |`);
    z.push('');
  }
  const kurz = `${e.vms.length} VMs/CT, ${e.hosts.length} Hosts, ${e.hosts.reduce((s, h) => s + h.container.length, 0)} Container, ${e.proxy.length} Proxy-Einträge; Auffälligkeiten: ${auff.filter(x => x.schwere === 'hoch').length} hoch, ${auff.filter(x => x.schwere === 'mittel').length} mittel`;
  return { markdown: z.join('\n'), auffaelligkeiten: auff, kurz };
}
