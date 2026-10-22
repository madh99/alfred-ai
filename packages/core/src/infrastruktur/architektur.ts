/**
 * Spec Infrastruktur-Vorhaben, I2 (Owner 22.10.2026 „I2 wie vorgeschlagen umsetzen“) — Zielarchitektur als feste Vorlage.
 *
 * Das Modell liefert die Architektur als Struktur (Gruppen, Ziel-VMs, Netze, Reihenfolge, Risiken …). Prüfung und Dokument sind
 * deterministisch: jede Einheit des Bestands (Compose-Projekt, einzelner Container, der Host selbst) muss genau einer Gruppe
 * zugeordnet sein, Knoten/Speicher/Netze müssen existieren, Größen und Distributionen sind begrenzt, jede neue VM steht in der
 * Reihenfolge. Zahlen im Dokument (RAM gemessen, Datenmengen, betroffene Proxy-Einträge, Knoten-Reserven) kommen aus dem Bestand,
 * nie aus dem Modell. Nichts wird ausgeführt — Changes entstehen erst nach der Owner-Entscheidung (I3).
 */
import type { HostBestand } from './sammler.js';
import { groesseBytes } from './sammler.js';
import { dnsText, domainsMitDns, type DnsEintrag, type NetzEintrag, type ProxyEintrag, type VmEintrag } from './bericht.js';

export const DISTRIBUTIONEN = ['debian-12', 'debian-13', 'ubuntu-24.04', 'rocky-9', 'alma-9', 'alpine-3', 'windows-server-2022', 'windows-server-2025'] as const;
export const NETZ_GERAETE = ['unifi', 'pfsense', 'mikrotik'] as const;
/** Firewall-Zonen außer Netzen und Gruppen (I2-Nachschärfung 22.10.: Freitext-Zonen sind für Changes nicht verwendbar) */
/** Feste Zonen: proxy = konkrete NPM-IP; alfred = der Server, auf dem Alfred läuft (Verwaltung, Datenübertragung); gateway = Gateway des eigenen Netzes (DNS/NTP) — Architektur v3 cf82f3f2, Owner 22.10. */
export const ZONEN_WORTE = ['internet', 'vpn', 'proxy', 'alfred', 'gateway', 'alle'] as const;
export const PROTOKOLLE = ['tcp', 'udp', 'tcp+udp', 'icmp', 'alle'] as const;
/** Owner 22.10. (5b-10): Altes mindestens 7 Tage stehen lassen */
export const ALT_BEHALTEN_TAGE = 7;

export interface Einheit {
  name: string;
  art: 'compose' | 'container' | 'host';
  host: string;
  container: Array<{ name: string; image: string; zustand: string; gesundheit?: string; ramBytes?: number }>;
  volumes: Array<{ name: string; groesse: string; bytes: number }>;
  bindMounts: string[];
  ports: number[];
  netze: string[];
  proxy: string[];
  ramBytes: number;
  datenBytes: number;
}
export interface KnotenStand { name: string; online: boolean; cpus?: number; ramGesamt: number; ramBelegt: number }
export interface SpeicherStand {
  name: string; typ?: string; gesamt: number; belegt: number;
  /** Proxmox-Inhaltsarten, z. B. „images,rootdir“ */
  inhalt?: string;
  /** Kapazität je Knoten, auf dem der Speicher aktiv ist (fehlt: unbekannt) */
  knoten?: Record<string, { gesamt: number; belegt: number }>;
}

export interface PlanungsGrundlage {
  hosts: Array<{ zugang: string; host: string; os?: string; cpus?: number; ramGesamt?: number; ramBelegt?: number; erfasst?: string }>;
  einheiten: Einheit[];
  /** Proxy-Einträge auf die Hosts, die keiner Einheit über einen veröffentlichten Port zugeordnet werden konnten (z. B. Host-Netz) */
  proxyOhneZuordnung: string[];
  knoten: KnotenStand[];
  speicher: SpeicherStand[];
  netze: NetzEintrag[];
  vms: VmEintrag[];
  /** Domain → öffentliches DNS (Cloudflare), z. B. „Cloudflare Proxy: A 84.x“ */
  dns: Record<string, string>;
}

export interface ArchitekturGruppe {
  name: string; zweck: string; begruendung: string;
  einheiten: string[];
  ziel: 'vm' | 'lxc' | 'bleibt' | 'stilllegen';
  vmName?: string; knoten?: string; vcpu?: number; ramGb?: number; diskGb?: number; speicher?: string;
  distribution?: string; distributionBegruendung?: string;
  netz?: string;
  verwaltung?: 'fernzugriff' | 'satellit';
}
export interface ArchitekturNetz { name: string; vlan?: number; subnetz?: string; geraet: string; zweck: string; neu: boolean }
export interface Architektur {
  zusammenfassung: string;
  gruppen: ArchitekturGruppe[];
  netze: ArchitekturNetz[];
  firewall: Array<{ von: string; nach: string; protokoll: string; ports: string; begruendung: string }>;
  proxyDns: string;
  sicherung: string;
  updates: string;
  reihenfolge: Array<{ gruppe: string; ausfallMinuten?: number; voraussetzung?: string }>;
  risiken: Array<{ risiko: string; massnahme: string }>;
  offeneEntscheidungen: string[];
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;
export const gb = (b: number) => `${(b / GB).toFixed(b >= 10 * GB ? 0 : 1).replace('.', ',')} GB`;
const mb = (b: number) => (b >= GB ? gb(b) : `${Math.round(b / MB)} MB`);

/** Veröffentlichte Host-Ports aus „0.0.0.0:8123->8123/tcp, :::8123->8123/tcp“. */
export function hostPorts(ports: string): number[] {
  const aus = new Set<number>();
  for (const m of ports.matchAll(/(?:^|[\s,])(?:[\d.]+|\[?[0-9a-f:]*\]?):(\d+)(?:-(\d+))?->/gi)) {
    const von = Number(m[1]); const bis = m[2] ? Number(m[2]) : von;
    for (let p = von; p <= Math.min(bis, von + 50); p++) aus.add(p);
  }
  return [...aus].sort((a, b) => a - b);
}

/** Einheiten (Compose-Projekt, einzelner Container, Host) und Ressourcen-Stand als Grundlage für Planung und Prüfung. */
export function planungsGrundlage(e: { hosts: HostBestand[]; knoten: KnotenStand[]; speicher: SpeicherStand[]; netze: NetzEintrag[]; proxy: ProxyEintrag[]; vms: VmEintrag[]; dns?: DnsEintrag[] }): PlanungsGrundlage {
  const einheiten: Einheit[] = [];
  const proxyOhne: string[] = [];
  for (const h of e.hosts) {
    const volGroesse = new Map(h.volumes.map(v => [v.name, v]));
    const gruppen = new Map<string, HostBestand['container']>();
    for (const c of h.container) {
      const k = c.composeProjekt ? `compose:${c.composeProjekt}` : `container:${c.name}`;
      gruppen.set(k, [...(gruppen.get(k) ?? []), c]);
    }
    const hostZiele = new Set([h.host.toLowerCase(), h.zugang.toLowerCase()]);
    const proxyAufHost = e.proxy.filter(p => hostZiele.has(p.forwardHost.toLowerCase()));
    const zugeordnet = new Set<ProxyEintrag>();
    for (const [k, cs] of gruppen) {
      const art = k.startsWith('compose:') ? 'compose' : 'container';
      const ports = [...new Set(cs.flatMap(c => hostPorts(c.ports)))].sort((a, b) => a - b);
      const volumes = [...new Set(cs.flatMap(c => c.mounts))].filter(m => volGroesse.has(m)).map(m => { const v = volGroesse.get(m)!; return { name: v.name, groesse: v.groesse, bytes: groesseBytes(v.groesse) ?? 0 }; });
      const proxy = proxyAufHost.filter(p => ports.includes(p.forwardPort));
      proxy.forEach(p => zugeordnet.add(p));
      einheiten.push({
        name: k.slice(k.indexOf(':') + 1), art, host: h.zugang,
        container: cs.map(c => ({ name: c.name, image: c.image, zustand: c.zustand, ...(c.gesundheit ? { gesundheit: c.gesundheit } : {}), ...(c.ramBytes !== undefined ? { ramBytes: c.ramBytes } : {}) })),
        volumes, bindMounts: [...new Set(cs.flatMap(c => c.mounts))].filter(m => m.startsWith('/')),
        ports, netze: [...new Set(cs.flatMap(c => c.netze))], proxy: proxy.flatMap(p => p.domains),
        ramBytes: cs.reduce((s, c) => s + (c.ramBytes ?? 0), 0), datenBytes: volumes.reduce((s, v) => s + v.bytes, 0),
      });
    }
    einheiten.push({ name: h.zugang, art: 'host', host: h.zugang, container: [], volumes: [], bindMounts: [], ports: h.ports.map(p => p.port), netze: [], proxy: [], ramBytes: h.ram?.belegt ?? 0, datenBytes: 0 });
    for (const p of proxyAufHost) if (!zugeordnet.has(p)) proxyOhne.push(`${p.domains.join(', ')} → ${p.forwardHost}:${p.forwardPort}`);
  }
  return {
    hosts: e.hosts.map(h => ({ zugang: h.zugang, host: h.host, ...(h.os ? { os: h.os.name } : {}), ...(h.cpus ? { cpus: h.cpus } : {}), ...(h.ram ? { ramGesamt: h.ram.gesamt, ramBelegt: h.ram.belegt } : {}), ...(h.erfasst ? { erfasst: h.erfasst } : {}) })),
    einheiten, proxyOhneZuordnung: proxyOhne, knoten: e.knoten, speicher: e.speicher, netze: e.netze, vms: e.vms,
    dns: e.dns?.length ? Object.fromEntries(domainsMitDns(e.proxy, e.dns).map(s => [s.domain, dnsText(s)])) : {},
  };
}

/** Kompakte Darstellung der Grundlage für das Modell und den Owner. */
export function grundlageText(g: PlanungsGrundlage): string {
  const z: string[] = ['## Planungsgrundlage', ''];
  for (const h of g.hosts) z.push(`- **${h.zugang}** (${h.host}): ${h.os ?? 'OS unbekannt'}, ${h.cpus ?? '?'} CPUs, RAM ${h.ramGesamt ? `${gb(h.ramBelegt ?? 0)} von ${gb(h.ramGesamt)} belegt` : 'unbekannt'}${h.erfasst ? `, erfasst ${h.erfasst.slice(0, 16).replace('T', ' ')} UTC` : ''}`);
  z.push('', '### Einheiten (jede genau einer Gruppe zuordnen — auch der Host selbst)', '', '| Einheit | Art | Host | Container | RAM gemessen | Daten (Volumes) | Ports | Proxy-Domains | Bind-Mounts |', '|---|---|---|---|---|---|---|---|---|');
  for (const e of g.einheiten) {
    const zust = e.container.filter(c => c.zustand !== 'running').length;
    z.push(`| ${e.name} | ${e.art} | ${e.host} | ${e.art === 'host' ? '—' : `${e.container.length}${zust ? ` (${zust} nicht laufend)` : ''}: ${e.container.map(c => c.image.replace(/@sha256:.*/, '')).slice(0, 4).join(', ')}`} | ${mb(e.ramBytes)} | ${e.datenBytes ? gb(e.datenBytes) : '—'} | ${e.ports.slice(0, 8).join(', ') || '—'} | ${e.proxy.join(', ') || '—'} | ${e.bindMounts.length ? e.bindMounts.slice(0, 3).join(', ') + (e.bindMounts.length > 3 ? ' …' : '') : '—'} |`);
  }
  if (g.proxyOhneZuordnung.length) z.push('', `Proxy-Einträge auf diese Hosts ohne Zuordnung (Host-Netz oder kein Dienst): ${g.proxyOhneZuordnung.join('; ')}`);
  const domains = [...new Set(g.einheiten.flatMap(e => e.proxy))];
  if (domains.length && Object.keys(g.dns).length) z.push('', '### Öffentliches DNS der Domains (Cloudflare)', '', ...domains.map(d => `- ${d}: ${g.dns[d] ?? 'unbekannt'}`), '', 'Zeigt ein Eintrag auf die WAN-Adresse (NPM), ändert sich beim Umzug nur das NPM-Ziel; zeigt er direkt auf den Host, ist auch ein DNS-Schritt (cloudflare_dns update_record) nötig.');
  z.push('', '### Proxmox-Knoten', '', ...g.knoten.map(k => `- ${k.name}${k.online ? '' : ' (offline)'}: ${k.cpus ?? '?'} CPUs, RAM ${gb(k.ramBelegt)} von ${gb(k.ramGesamt)} belegt, frei ${gb(Math.max(0, k.ramGesamt - k.ramBelegt))}`));
  z.push('', '### Speicher (für VM-/CT-Disks: Inhalt images bzw. rootdir)', '', ...g.speicher.map(s => `- ${s.name}${s.typ ? ` (${s.typ}${s.inhalt ? `; ${s.inhalt}` : ''})` : ''}: ${s.knoten ? Object.entries(s.knoten).map(([k, w]) => `${k} ${gb(w.belegt)}/${gb(w.gesamt)}`).join(', ') : `${gb(s.belegt)} von ${gb(s.gesamt)} belegt`}`));
  z.push('', '### Netze/VLANs (vorhanden)', '', ...g.netze.map(n => `- ${n.name} (${n.quelle}${n.vlan !== undefined && n.vlan !== null && n.vlan !== '' ? `, VLAN ${n.vlan}` : ''}${n.subnet ? `, ${n.subnet}` : ''})`));
  z.push('', `Erlaubte Distributionen: ${DISTRIBUTIONEN.join(', ')}. Netz-Geräte: ${NETZ_GERAETE.join(', ')}. Firewall-Zonen: Netze, Gruppen oder ${ZONEN_WORTE.join(', ')}; Protokolle ${PROTOKOLLE.join(', ')}.`);
  return z.join('\n');
}

const txt = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const zahl = (v: unknown): number | undefined => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : undefined; };
const liste = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Prüft die vom Modell gelieferte Architektur gegen die Grundlage. `fehler` → nicht speicherbar (das Modell muss nachbessern),
 * `hinweise` → stehen im Dokument (z. B. knappe Ressourcen). `architektur` ist die bereinigte Fassung (Namen wie im Bestand).
 */
/**
 * Neue Fassung = gespeicherte Fassung + Änderungen (Realfall 22.10.: Version 3 von cf82f3f2 = Version 2 + 15 Firewall-Regeln; das Modell
 * musste die ganze Architektur neu ausgeben, der Aufruf kam abgeschnitten und leer an). Oberste Felder werden ersetzt, Firewall-Regeln
 * können einzeln hinzukommen oder wegfallen. Das Ergebnis wird danach ganz normal geprüft.
 */
export function mitAenderungen(basis: unknown, aenderungen: unknown): { roh: Record<string, unknown> } | { fehler: string } {
  if (!basis || typeof basis !== 'object') return { fehler: 'Es gibt noch keine gespeicherte Fassung — die Architektur vollständig senden' };
  if (!aenderungen || typeof aenderungen !== 'object' || Array.isArray(aenderungen)) return { fehler: 'aenderungen muss ein Objekt sein' };
  const a = aenderungen as Record<string, unknown>;
  const roh = JSON.parse(JSON.stringify(basis)) as Record<string, unknown>;
  for (const [k, w] of Object.entries(a)) if (k !== 'firewall_hinzu' && k !== 'firewall_entfernen' && k !== 'einheit_verschieben' && w !== undefined) roh[k] = w;
  // Owner 22.10. (MongoDB/Joomla-DB nicht mehr gebraucht): einzelne Einheiten in eine andere Gruppe verschieben, ohne alle Gruppen neu zu senden
  if (Array.isArray(a.einheit_verschieben)) {
    const gruppen = Array.isArray(roh.gruppen) ? (roh.gruppen as Array<Record<string, unknown>>) : [];
    for (const v of a.einheit_verschieben as Array<Record<string, unknown>>) {
      const einheit = String(v?.einheit ?? ''); const nach = String(v?.nach_gruppe ?? '');
      const ziel = gruppen.find(g => String(g.name ?? '').toLowerCase() === nach.toLowerCase());
      if (!einheit || !ziel) return { fehler: `einheit_verschieben: Einheit „${einheit}“ oder Gruppe „${nach}“ unbekannt` };
      const quelle = gruppen.find(g => Array.isArray(g.einheiten) && (g.einheiten as string[]).includes(einheit));
      if (!quelle) return { fehler: `einheit_verschieben: Einheit „${einheit}“ ist keiner Gruppe zugeordnet` };
      quelle.einheiten = (quelle.einheiten as string[]).filter(x => x !== einheit);
      ziel.einheiten = [...((ziel.einheiten as string[] | undefined) ?? []), einheit];
    }
  }
  const gleich = (x: Record<string, unknown>, y: Record<string, unknown>) => ['von', 'nach', 'protokoll'].every(f => String(x[f] ?? '').toLowerCase() === String(y[f] ?? '').toLowerCase()) && String(x.ports ?? '').replace(/\s/g, '') === String(y.ports ?? '').replace(/\s/g, '');
  let fw = Array.isArray(roh.firewall) ? (roh.firewall as Array<Record<string, unknown>>) : [];
  if (Array.isArray(a.firewall_entfernen)) fw = fw.filter(r => !(a.firewall_entfernen as Array<Record<string, unknown>>).some(e => e && gleich(r, e)));
  if (Array.isArray(a.firewall_hinzu)) for (const r of a.firewall_hinzu as Array<Record<string, unknown>>) if (r && !fw.some(x => gleich(x, r))) fw.push(r);
  roh.firewall = fw;
  return { roh };
}

export function pruefeArchitektur(roh: unknown, g: PlanungsGrundlage): { fehler: string[]; hinweise: string[]; architektur: Architektur } {
  const f: string[] = []; const h: string[] = [];
  const r = (roh && typeof roh === 'object' ? roh : {}) as Record<string, unknown>;
  const a: Architektur = {
    zusammenfassung: txt(r.zusammenfassung), gruppen: [], netze: [], firewall: [], proxyDns: txt(r.proxyDns), sicherung: txt(r.sicherung), updates: txt(r.updates),
    reihenfolge: [], risiken: [], offeneEntscheidungen: liste(r.offeneEntscheidungen).map(txt).filter(Boolean),
  };
  if (a.zusammenfassung.length < 20) f.push('zusammenfassung fehlt (Ausgangslage und Ziel in einigen Sätzen)');
  if (!a.sicherung) f.push('sicherung fehlt (Sicherungskonzept der Zielarchitektur)');
  if (!a.updates) f.push('updates fehlt (Updatestrategie)');

  // Netze
  const vorhandeneNetze = new Map(g.netze.map(n => [n.name.toLowerCase(), n]));
  const belegteVlans = new Set(g.netze.map(n => Number(n.vlan)).filter(n => Number.isInteger(n) && n > 0));
  for (const [i, n0] of liste(r.netze).entries()) {
    const n = (n0 ?? {}) as Record<string, unknown>;
    const netz: ArchitekturNetz = { name: txt(n.name), geraet: txt(n.geraet).toLowerCase(), zweck: txt(n.zweck), neu: n.neu === true || n.neu === 'true' };
    const vlan = zahl(n.vlan); if (vlan !== undefined) netz.vlan = vlan;
    if (txt(n.subnetz)) netz.subnetz = txt(n.subnetz);
    if (!netz.name) { f.push(`netze[${i}]: name fehlt`); continue; }
    if (a.netze.some(x => x.name.toLowerCase() === netz.name.toLowerCase())) f.push(`Netz „${netz.name}“ doppelt`);
    if (!(NETZ_GERAETE as readonly string[]).includes(netz.geraet)) f.push(`Netz „${netz.name}“: geraet muss ${NETZ_GERAETE.join('/')} sein`);
    if (netz.vlan !== undefined && (!Number.isInteger(netz.vlan) || netz.vlan < 1 || netz.vlan > 4094)) f.push(`Netz „${netz.name}“: VLAN ${netz.vlan} ungültig (1–4094)`);
    if (netz.neu && netz.vlan !== undefined && belegteVlans.has(netz.vlan)) f.push(`Netz „${netz.name}“: VLAN ${netz.vlan} ist bereits vergeben (${g.netze.filter(x => Number(x.vlan) === netz.vlan).map(x => `${x.name}/${x.quelle}`).join(', ')})`);
    if (!netz.neu && !vorhandeneNetze.has(netz.name.toLowerCase())) f.push(`Netz „${netz.name}“ ist als vorhanden markiert, existiert aber nicht (neu: true setzen oder vorhandenen Namen verwenden)`);
    if (netz.subnetz && !/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$|^[0-9a-f:]+\/\d{1,3}$/i.test(netz.subnetz)) f.push(`Netz „${netz.name}“: Subnetz „${netz.subnetz}“ ungültig`);
    if (!netz.zweck) f.push(`Netz „${netz.name}“: zweck fehlt`);
    a.netze.push(netz);
  }
  const netzBekannt = (name: string) => a.netze.some(n => n.name.toLowerCase() === name.toLowerCase()) || vorhandeneNetze.has(name.toLowerCase());

  // Gruppen und Zuordnung der Einheiten
  const einheitNach = new Map(g.einheiten.map(e => [e.name.toLowerCase(), e]));
  const zugeordnet = new Map<string, string>();
  const knotenNamen = new Map(g.knoten.map(k => [k.name.toLowerCase(), k]));
  const speicherNamen = new Map(g.speicher.map(s => [s.name.toLowerCase(), s]));
  const vmNamen = new Set(g.vms.map(v => v.name.toLowerCase()));
  for (const [i, g0] of liste(r.gruppen).entries()) {
    const x = (g0 ?? {}) as Record<string, unknown>;
    const gr: ArchitekturGruppe = { name: txt(x.name), zweck: txt(x.zweck), begruendung: txt(x.begruendung), einheiten: [], ziel: txt(x.ziel) as ArchitekturGruppe['ziel'] };
    const n = gr.name || `gruppen[${i}]`;
    if (!gr.name) f.push(`gruppen[${i}]: name fehlt`);
    if (a.gruppen.some(y => y.name.toLowerCase() === gr.name.toLowerCase())) f.push(`Gruppe „${n}“ doppelt`);
    if (!gr.zweck) f.push(`Gruppe „${n}“: zweck fehlt`);
    if (!gr.begruendung) f.push(`Gruppe „${n}“: begruendung fehlt`);
    if (!['vm', 'lxc', 'bleibt', 'stilllegen'].includes(gr.ziel)) f.push(`Gruppe „${n}“: ziel muss vm, lxc, bleibt oder stilllegen sein`);
    for (const e0 of liste(x.einheiten)) {
      const e = einheitNach.get(txt(e0).toLowerCase());
      if (!e) { f.push(`Gruppe „${n}“: Einheit „${txt(e0)}“ gibt es im Bestand nicht`); continue; }
      if (zugeordnet.has(e.name)) { f.push(`Einheit „${e.name}“ ist zwei Gruppen zugeordnet (${zugeordnet.get(e.name)}, ${n})`); continue; }
      zugeordnet.set(e.name, n); gr.einheiten.push(e.name);
    }
    if (!gr.einheiten.length) f.push(`Gruppe „${n}“: keine Einheiten`);
    if (gr.ziel === 'vm' || gr.ziel === 'lxc') {
      gr.vmName = txt(x.vmName); gr.knoten = txt(x.knoten); gr.distribution = txt(x.distribution).toLowerCase(); gr.distributionBegruendung = txt(x.distributionBegruendung); gr.netz = txt(x.netz);
      const vcpu = zahl(x.vcpu), ram = zahl(x.ramGb), disk = zahl(x.diskGb);
      if (vcpu !== undefined) gr.vcpu = vcpu; if (ram !== undefined) gr.ramGb = ram; if (disk !== undefined) gr.diskGb = disk;
      if (txt(x.speicher)) gr.speicher = txt(x.speicher);
      gr.verwaltung = txt(x.verwaltung) === 'satellit' ? 'satellit' : 'fernzugriff';
      if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(gr.vmName)) f.push(`Gruppe „${n}“: vmName „${gr.vmName}“ ungültig (Kleinbuchstaben, Ziffern, Bindestrich)`);
      else if (vmNamen.has(gr.vmName)) f.push(`Gruppe „${n}“: VM-Name „${gr.vmName}“ ist bereits vergeben`);
      else if (a.gruppen.some(y => y.vmName === gr.vmName)) f.push(`Gruppe „${n}“: VM-Name „${gr.vmName}“ doppelt`);
      const k = knotenNamen.get(gr.knoten.toLowerCase());
      if (!k) f.push(`Gruppe „${n}“: Knoten „${gr.knoten}“ unbekannt (${g.knoten.map(y => y.name).join(', ')})`); else gr.knoten = k.name;
      if (gr.vcpu === undefined || !Number.isInteger(gr.vcpu) || gr.vcpu < 1 || gr.vcpu > 64) f.push(`Gruppe „${n}“: vcpu 1–64 angeben`);
      if (gr.ramGb === undefined || gr.ramGb < 0.5 || gr.ramGb > 512) f.push(`Gruppe „${n}“: ramGb 0,5–512 angeben`);
      if (gr.diskGb === undefined || gr.diskGb < 4 || gr.diskGb > 8192) f.push(`Gruppe „${n}“: diskGb 4–8192 angeben`);
      if (!(DISTRIBUTIONEN as readonly string[]).includes(gr.distribution)) f.push(`Gruppe „${n}“: distribution muss eine von ${DISTRIBUTIONEN.join(', ')} sein`);
      else if (gr.ziel === 'lxc' && gr.distribution.startsWith('windows')) f.push(`Gruppe „${n}“: Windows geht nicht als LXC`);
      if (!gr.distributionBegruendung) f.push(`Gruppe „${n}“: distributionBegruendung fehlt (warum diese Distribution)`);
      if (!gr.netz) f.push(`Gruppe „${n}“: netz fehlt (Netz/VLAN der neuen ${gr.ziel.toUpperCase()})`);
      else if (!netzBekannt(gr.netz)) f.push(`Gruppe „${n}“: Netz „${gr.netz}“ ist weder vorhanden noch unter netze geplant`);
      if (gr.speicher) {
        const s = speicherNamen.get(gr.speicher.toLowerCase());
        if (!s) f.push(`Gruppe „${n}“: Speicher „${gr.speicher}“ unbekannt oder nicht aktiv (${g.speicher.map(y => y.name).join(', ') || 'keine bekannt'})`);
        else {
          gr.speicher = s.name;
          if (s.knoten && k && !s.knoten[k.name]) f.push(`Gruppe „${n}“: Speicher „${s.name}“ ist auf Knoten ${k.name} nicht verfügbar (nur ${Object.keys(s.knoten).join(', ')})`);
          const brauche = gr.ziel === 'lxc' ? 'rootdir' : 'images';
          if (s.inhalt && !s.inhalt.split(',').map(x => x.trim()).includes(brauche)) f.push(`Gruppe „${n}“: Speicher „${s.name}“ nimmt keine ${gr.ziel === 'lxc' ? 'CT' : 'VM'}-Disks auf (Inhalt ${s.inhalt})`);
        }
      }
      // Größen gegen den gemessenen Bedarf (nur Hinweise)
      const es = gr.einheiten.map(e => einheitNach.get(e.toLowerCase())!).filter(e => e.art !== 'host');
      const ramBedarf = es.reduce((s, e) => s + e.ramBytes, 0);
      const datenBedarf = es.reduce((s, e) => s + e.datenBytes, 0);
      if (gr.ramGb !== undefined && ramBedarf && gr.ramGb * GB < ramBedarf * 1.25 + 0.5 * GB) h.push(`Gruppe „${n}“: ${gr.ramGb} GB RAM sind knapp — gemessen ${gb(ramBedarf)} (+25 % Reserve + 0,5 GB System empfohlen)`);
      if (gr.diskGb !== undefined && gr.diskGb * GB < datenBedarf * 1.5 + 10 * GB) h.push(`Gruppe „${n}“: ${gr.diskGb} GB Disk sind knapp — Volumes ${gb(datenBedarf)} (+50 % und 10 GB für System/Images empfohlen)${es.some(e => e.bindMounts.length) ? '; Bind-Mounts nicht mitgerechnet' : ''}`);
    } else if (gr.ziel === 'stilllegen' && gr.einheiten.some(e => einheitNach.get(e.toLowerCase())?.art === 'host')) {
      h.push(`Gruppe „${n}“: Hosts werden frühestens ${ALT_BEHALTEN_TAGE} Tage nach erfolgreicher Migration und nur über einen eigenen Change stillgelegt (Owner 22.10.)`);
    }
    a.gruppen.push(gr);
  }
  if (!a.gruppen.length) f.push('gruppen fehlt');
  const offen = g.einheiten.filter(e => !zugeordnet.has(e.name)).map(e => e.name);
  if (offen.length) f.push(`Nicht zugeordnete Einheiten (jede genau einer Gruppe zuordnen, auch mit ziel bleibt/stilllegen): ${offen.join(', ')}`);

  // Ressourcen je Knoten (Hinweis)
  for (const k of g.knoten) {
    const neu = a.gruppen.filter(x => x.knoten === k.name && x.ramGb).reduce((s, x) => s + x.ramGb! * GB, 0);
    if (!neu) continue;
    const frei = Math.max(0, k.ramGesamt - k.ramBelegt);
    if (neu > frei * 0.9) h.push(`Knoten ${k.name}: geplant ${gb(neu)} RAM, frei nur ${gb(frei)} — erst nach Abbau des Altsystems oder auf andere Knoten verteilen`);
  }
  for (const s of g.speicher) {
    // Je Knoten, wenn bekannt (lokale Speicher haben je Knoten eigene Kapazität); geteilte Speicher zählen einmal
    const orte = s.knoten && s.typ !== 'rbd' && s.typ !== 'cifs' && s.typ !== 'nfs' && s.typ !== 'pbs' ? Object.entries(s.knoten).map(([k, w]) => ({ ort: `${s.name} auf ${k}`, knoten: k as string | undefined, ...w })) : [{ ort: s.name, knoten: undefined as string | undefined, gesamt: s.gesamt, belegt: s.belegt }];
    for (const o of orte) {
      const neu = a.gruppen.filter(x => x.speicher === s.name && x.diskGb && (!o.knoten || x.knoten === o.knoten)).reduce((t, x) => t + x.diskGb! * GB, 0);
      if (neu && neu > (o.gesamt - o.belegt) * 0.9) h.push(`Speicher ${o.ort}: geplant ${gb(neu)}, frei nur ${gb(Math.max(0, o.gesamt - o.belegt))}`);
    }
    if (s.gesamt && s.belegt / s.gesamt >= 0.85 && a.gruppen.some(x => x.speicher === s.name)) h.push(`Speicher ${s.name} ist bereits zu ${Math.round((s.belegt / s.gesamt) * 100)} % belegt`);
  }

  // Firewall — strukturiert (Zone → Zone, Protokoll, Ports), damit I3 daraus Regeln als Change-Schritte bilden kann
  const zone = (z: string): string | undefined => {
    const k = z.toLowerCase();
    const netz = a.netze.find(n => n.name.toLowerCase() === k) ?? (vorhandeneNetze.get(k) ? { name: vorhandeneNetze.get(k)!.name } : undefined);
    if (netz) return netz.name;
    const gr = a.gruppen.find(y => y.name.toLowerCase() === k);
    if (gr) return gr.name;
    return (ZONEN_WORTE as readonly string[]).includes(k) ? k : undefined;
  };
  for (const [i, w0] of liste(r.firewall).entries()) {
    const w = (w0 ?? {}) as Record<string, unknown>;
    const regel = { von: txt(w.von), nach: txt(w.nach), protokoll: txt(w.protokoll).toLowerCase() || 'tcp', ports: txt(w.ports).replace(/\s+/g, '').toLowerCase(), begruendung: txt(w.begruendung) };
    const von = zone(regel.von), nach = zone(regel.nach);
    if (!von) f.push(`firewall[${i}]: von „${regel.von}“ ist weder Netz noch Gruppe noch ${ZONEN_WORTE.join('/')} — eine Zone je Regel`);
    if (!nach) f.push(`firewall[${i}]: nach „${regel.nach}“ ist weder Netz noch Gruppe noch ${ZONEN_WORTE.join('/')} — eine Zone je Regel`);
    if (!(PROTOKOLLE as readonly string[]).includes(regel.protokoll)) f.push(`firewall[${i}]: protokoll muss ${PROTOKOLLE.join('/')} sein`);
    const portsOk = regel.ports === 'alle' || (/^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/.test(regel.ports) && regel.ports.split(/[,-]/).every(p => Number(p) >= 1 && Number(p) <= 65535));
    if (regel.protokoll !== 'icmp' && !portsOk) f.push(`firewall[${i}]: ports „${regel.ports}“ ungültig (z. B. 443, 8008,8448, 10000-20000 oder alle)`);
    if (!regel.begruendung) f.push(`firewall[${i}]: begruendung fehlt`);
    if (von && nach) a.firewall.push({ ...regel, von, nach, ...(regel.protokoll === 'icmp' ? { ports: '—' } : {}) });
  }
  if (a.netze.some(n => n.neu) && !a.firewall.length) f.push('firewall fehlt: neue Netze brauchen Regeln zwischen den Zonen');
  // Subnetze dürfen sich weder mit vorhandenen noch untereinander überschneiden (IPv4)
  const bereich = (cidr?: string): [number, number] | undefined => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr ?? '');
    if (!m) return undefined;
    const ip = ((Number(m[1]) << 24) >>> 0) + (Number(m[2]) << 16) + (Number(m[3]) << 8) + Number(m[4]);
    const len = Number(m[5]); const groesse = 2 ** (32 - len);
    const start = Math.floor(ip / groesse) * groesse;
    return [start, start + groesse - 1];
  };
  const belegt = g.netze.map(n => ({ name: `${n.name}/${n.quelle}`, b: bereich(n.subnet) })).filter(x => x.b);
  for (const n of a.netze.filter(x => x.neu)) {
    const b = bereich(n.subnetz);
    if (!b) continue;
    for (const x of [...belegt, ...a.netze.filter(y => y !== n && y.neu).map(y => ({ name: y.name, b: bereich(y.subnetz) }))]) {
      if (x.b && b[0] <= x.b[1] && x.b[0] <= b[1]) { f.push(`Netz „${n.name}“: Subnetz ${n.subnetz} überschneidet sich mit ${x.name}`); break; }
    }
  }

  // Reihenfolge
  const neueVms = a.gruppen.filter(x => x.ziel === 'vm' || x.ziel === 'lxc').map(x => x.name.toLowerCase());
  const gesehen = new Set<string>();
  for (const [i, s0] of liste(r.reihenfolge).entries()) {
    const s = (s0 ?? {}) as Record<string, unknown>;
    const gr = a.gruppen.find(x => x.name.toLowerCase() === txt(s.gruppe).toLowerCase());
    if (!gr) { f.push(`reihenfolge[${i}]: Gruppe „${txt(s.gruppe)}“ unbekannt`); continue; }
    if (gesehen.has(gr.name.toLowerCase())) { f.push(`reihenfolge: Gruppe „${gr.name}“ doppelt`); continue; }
    gesehen.add(gr.name.toLowerCase());
    const aus = zahl(s.ausfallMinuten);
    a.reihenfolge.push({ gruppe: gr.name, ...(aus !== undefined ? { ausfallMinuten: aus } : {}), ...(txt(s.voraussetzung) ? { voraussetzung: txt(s.voraussetzung) } : {}) });
  }
  const fehlt = neueVms.filter(x => !gesehen.has(x));
  if (fehlt.length) f.push(`reihenfolge: es fehlen die Gruppen ${a.gruppen.filter(x => fehlt.includes(x.name.toLowerCase())).map(x => x.name).join(', ')}`);

  // Risiken
  for (const r0 of liste(r.risiken)) { const x = (r0 ?? {}) as Record<string, unknown>; if (txt(x.risiko)) a.risiken.push({ risiko: txt(x.risiko), massnahme: txt(x.massnahme) || '—' }); }
  if (!a.risiken.length) f.push('risiken fehlt (mindestens ein Risiko mit Gegenmaßnahme)');
  return { fehler: f, hinweise: h, architektur: a };
}

const zelle = (s: string) => s.replace(/\|/g, '/').replace(/\r?\n/g, ' ');

/** Das Architektur-Dokument nach fester Vorlage (Pflichtabschnitte immer in derselben Reihenfolge). */
export function architekturDokument(v: { titel: string; ziel: string; id: string; version: number; bestandDocId?: string }, a: Architektur, g: PlanungsGrundlage, hinweise: string[], jetzt = new Date()): string {
  const einheit = new Map(g.einheiten.map(e => [e.name, e]));
  const nichtHost = g.einheiten.filter(e => e.art !== 'host');
  const z: string[] = [
    `# Zielarchitektur: ${v.titel} (Version ${v.version})`, '',
    `**Vorschlag — nichts ausgeführt.** Vorhaben ${v.id.slice(0, 8)} · Stand ${jetzt.toLocaleString('de-AT', { timeZone: 'Europe/Vienna', dateStyle: 'short', timeStyle: 'short' })}${v.bestandDocId ? ` · Bestandsbericht ${v.bestandDocId}` : ''}`, '',
    '## 1. Ausgangslage und Ziel', '', `**Ziel des Owners:** ${v.ziel}`, '', a.zusammenfassung, '',
    `Bestand: ${g.hosts.map(h => `${h.zugang} (${h.os ?? '?'}, RAM ${h.ramGesamt ? `${gb(h.ramBelegt ?? 0)}/${gb(h.ramGesamt)}` : '?'})`).join(', ')}; ${nichtHost.length} Einheiten mit ${nichtHost.reduce((s, e) => s + e.container.length, 0)} Containern, RAM gemessen ${gb(nichtHost.reduce((s, e) => s + e.ramBytes, 0))}, Daten in Volumes ${gb(nichtHost.reduce((s, e) => s + e.datenBytes, 0))}.`, '',
    '## 2. Zielbild', '', '| Gruppe | Ziel | Größe | Distribution | Netz | Einheiten |', '|---|---|---|---|---|---|',
  ];
  for (const x of a.gruppen) {
    const ziel = x.ziel === 'vm' || x.ziel === 'lxc' ? `${x.ziel.toUpperCase()} ${x.vmName} auf ${x.knoten}` : x.ziel === 'bleibt' ? 'bleibt' : 'stilllegen';
    const groesse = x.vcpu ? `${x.vcpu} vCPU, ${x.ramGb} GB RAM, ${x.diskGb} GB${x.speicher ? ` (${x.speicher})` : ''}` : '—';
    z.push(`| ${zelle(x.name)} | ${ziel} | ${groesse} | ${x.distribution ?? '—'} | ${x.netz ?? '—'} | ${x.einheiten.join(', ')} |`);
  }
  z.push('', '## 3. Gruppen im Einzelnen');
  for (const x of a.gruppen) {
    z.push('', `### ${x.name}`, '', `**Zweck:** ${x.zweck}`, '', `**Begründung:** ${x.begruendung}`);
    if (x.distribution) z.push('', `**Distribution ${x.distribution}:** ${x.distributionBegruendung}`, '', `**Verwaltung:** ${x.verwaltung === 'satellit' ? 'Alfred-Satellit' : 'Fernzugriff (Benutzer alfred, Schlüssel per Cloud-Init)'}`);
    const es = x.einheiten.map(e => einheit.get(e)!).filter(Boolean);
    z.push('', '| Einheit | Container | RAM gemessen | Daten | Ports | Proxy-Domains |', '|---|---|---|---|---|---|');
    for (const e of es) z.push(`| ${e.name}${e.art === 'host' ? ' (Host)' : ''} | ${e.art === 'host' ? '—' : e.container.map(c => `${c.name}${c.gesundheit === 'unhealthy' ? ' ⚠️' : ''}`).join(', ')} | ${mb(e.ramBytes)} | ${e.datenBytes ? gb(e.datenBytes) : '—'} | ${e.ports.slice(0, 10).join(', ') || '—'} | ${e.proxy.join(', ') || '—'} |`);
    const bind = es.flatMap(e => e.bindMounts);
    if (bind.length && x.ziel !== 'bleibt') z.push('', `Bind-Mounts (Daten außerhalb von Volumes, beim Umzug mitnehmen): ${bind.join(', ')}`);
  }
  z.push('', '## 4. Netze, VLANs und Firewall', '');
  if (a.netze.length) { z.push('| Netz | VLAN | Subnetz | Gerät | neu | Zweck |', '|---|---|---|---|---|---|'); for (const n of a.netze) z.push(`| ${n.name} | ${n.vlan ?? '—'} | ${n.subnetz ?? '—'} | ${n.geraet} | ${n.neu ? 'ja' : 'nein'} | ${zelle(n.zweck)} |`); }
  else z.push('Keine Netzänderungen.');
  if (a.firewall.length) { z.push('', 'Firewall (alles andere zwischen den Zonen gesperrt):', '', '| Von | Nach | Protokoll | Ports | Begründung |', '|---|---|---|---|---|'); for (const w of a.firewall) z.push(`| ${zelle(w.von)} | ${zelle(w.nach)} | ${w.protokoll} | ${w.ports} | ${zelle(w.begruendung)} |`); }
  z.push('', '## 5. Reverse-Proxy und DNS', '');
  const umzug = a.gruppen.filter(x => x.ziel === 'vm' || x.ziel === 'lxc');
  const domains = umzug.flatMap(x => x.einheiten.flatMap(e => (einheit.get(e)?.proxy ?? []).map(d => `- ${d} → neu ${x.vmName} (Gruppe ${x.name})${g.dns[d] ? ` · DNS: ${g.dns[d]}` : ''}`)));
  z.push(domains.length ? `Umzustellende Proxy-Einträge (aus dem Bestand):\n${domains.join('\n')}` : 'Keine Proxy-Einträge betroffen (laut Bestand).');
  if (g.proxyOhneZuordnung.length) z.push('', `Ohne eindeutige Zuordnung (manuell prüfen): ${g.proxyOhneZuordnung.join('; ')}`);
  if (a.proxyDns) z.push('', a.proxyDns);
  z.push('', '## 6. Ressourcen je Proxmox-Knoten', '', '| Knoten | RAM gesamt | belegt | neu geplant | danach frei |', '|---|---|---|---|---|');
  for (const k of g.knoten) {
    const neu = a.gruppen.filter(x => x.knoten === k.name && x.ramGb).reduce((s, x) => s + x.ramGb! * GB, 0);
    z.push(`| ${k.name} | ${gb(k.ramGesamt)} | ${gb(k.ramBelegt)} | ${neu ? gb(neu) : '—'} | ${gb(k.ramGesamt - k.ramBelegt - neu)} |`);
  }
  z.push('', '## 7. Sicherung', '', a.sicherung, '', '## 8. Updates', '', a.updates, '', `Neue Hosts: automatische Sicherheitsupdates mit Schalter je Host (Standard an; aus → Alfred meldet anstehende Updates) — Owner 22.10.`);
  z.push('', '## 9. Migrationsreihenfolge', '');
  a.reihenfolge.forEach((s, i) => z.push(`${i + 1}. **${s.gruppe}**${s.ausfallMinuten !== undefined ? ` — erwartete Ausfallzeit ${s.ausfallMinuten} min` : ''}${s.voraussetzung ? ` — Voraussetzung: ${s.voraussetzung}` : ''}`));
  z.push('', `Altsysteme bleiben nach erfolgreicher Migration mindestens ${ALT_BEHALTEN_TAGE} Tage gestoppt stehen; Löschen nur als eigener Change.`);
  z.push('', '## 10. Risiken', '', '| Risiko | Gegenmaßnahme |', '|---|---|', ...a.risiken.map(r => `| ${zelle(r.risiko)} | ${zelle(r.massnahme)} |`));
  z.push('', '## 11. Offene Entscheidungen des Owners', '', ...(a.offeneEntscheidungen.length ? a.offeneEntscheidungen.map(o => `- ${o}`) : ['- keine']));
  z.push('', '## 12. Prüfhinweise', '', ...(hinweise.length ? hinweise.map(x => `- ${x}`) : ['- keine']));
  z.push('', '## Nächster Schritt', '', 'Der Owner entscheidet: annehmen, überarbeiten oder verwerfen. Erst nach „annehmen“ entstehen daraus ITSM-Changes mit Schritten (je Change eigene Freigabe).');
  return z.join('\n');
}
