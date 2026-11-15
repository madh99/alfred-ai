/**
 * Betriebsdokument (D-BETRIEB) — lesende Sammler. Jeder Sammler fängt seine eigenen Fehler und liefert `{ stand, fehler }`; ein Fehler
 * macht nur die betroffenen Kapitel „nicht belegt“. Nur bestehende Lesewege (Spec §5.2): Proxmox über `execute` (list_vms, api_raw GET,
 * list_backup_jobs) und alleBackupsDaten(); UniFi über firewallLesen() und list_dns_records; Tresor nur liste() (nie Werte);
 * pfSense/MikroTik/NPM/Cloudflare nur aus der CMDB (tägliche Erfassung), keine Live-Zugriffe.
 */
import type {
  CmdbAsset, CmdbAssetRelation, CmdbChangeRequest, CmdbDocType, CmdbDocument, CmdbLinkedEntityType, CmdbProblem, ProblemStatus, SkillResult,
} from '@alfred/types';
import { schwaerze } from '../../fernzugriff/kaefig.js';
import { MAX_ASSET_IDS, pruefeBetriebParameter, type BetriebParameter } from './betrieb-parameter.js';
import { QUELLEN_GRENZE } from './sammler.js';

export interface Quelle<T> { daten?: T; stand: string; fehler?: string; /** belegte Einschränkung (z. B. Liste abgeschnitten), kein Fehler */ hinweis?: string }

export interface ProxmoxVm {
  vmid: number; node: string; name?: string; status?: string; cores?: number; speicherMiB?: number; platten: string[]; ostype?: string; ips: string[];
  agentFehler?: string;
  /** Konfiguration dieser VM nicht lesbar (die übrigen VMs bleiben belegt) */
  fehler?: string;
}

export interface SicherungsJob { id: string; zeitplan: string; speicher: string; enthaelt: number[]; ausgenommen: number[]; aktiv: boolean; alle: boolean; pool?: string }
export interface SicherungDaten { jobs: SicherungsJob[]; letzte: Record<number, string | undefined>; unerreichbar: Array<{ speicher: string; grund: string }> }

/** Rückgabe von UniFiSkill.firewallLesen() (Task 1) — strukturell, damit core nicht vom Skill-Typ abhängt */
export interface FirewallStand {
  zonen: Array<{ id: string; name: string; netzIds: string[] }>;
  netze: Array<{ id: string; name: string; vlan?: number; subnetz?: string; zoneId?: string }>;
  policies: Array<{ id: string; name: string; aktiv: boolean | 'unbekannt'; index?: number; bedingung: string; aktion: string; quelleZone: string; zielZone: string; quelle: string; ziel: string; ports: string; protokoll: string; herkunft: string }>;
}
export interface UnifiDaten extends FirewallStand { dnsWeiterleitungen: Array<{ domain: string; server: string }> }

export interface TresorEintrag { name: string; herkunft: string; zweck?: string }
export interface FernzugangEintrag { name: string; host: string; benutzer: string; status: string; system?: string; cmdbAssetId?: string }
export interface JobEintrag { key: string; beschreibung?: string; takt?: string; letzterLauf?: { start: string; ok?: boolean; fehler?: string } }
export interface WartungDaten {
  fenster: Array<{ name: string; regel: string; art: string }>;
  vorlagen: Array<{ key: string; titel?: string; status?: string; letzterLauf?: string }>;
}
export interface AbnahmeVerweis { docId: string; version: number; pruefsummen: string[] }
export interface BeziehungenDaten {
  relationen: CmdbAssetRelation[];
  /** Namen der Gegenüber außerhalb der Instanz (für Diagramm und Abhängigkeiten) */
  fremde: Record<string, { name: string; assetType: string; status: string }>;
}
export interface NetzBestand {
  /** je source_skill: max(last_seen_at) oder „keine Daten erfasst“ */
  stand: Record<string, string>;
  firewallRegeln: Array<{ quelle: 'pfsense' | 'mikrotik'; name: string; aktion: string; schnittstelle: string; von: string; nach: string; protokoll: string; grund: string }>;
  netze: Array<{ quelle: 'pfsense' | 'mikrotik'; name: string; subnetz: string; schnittstelle?: string }>;
  proxyHosts: Array<{ domains: string[]; ziel: string; port: number; schema: string; zertifikat?: string }>;
  dnsEintraege: Array<{ name: string; typ: string; wert: string }>;
}

export interface BetriebQuellen {
  assets(o: string, ids: string[]): Promise<Quelle<{ gefunden: CmdbAsset[]; fehlend: string[] }>>;
  beziehungen(o: string, ids: string[]): Promise<Quelle<BeziehungenDaten>>;
  proxmox(o: string, vms: Array<{ node: string; vmid: number }>): Promise<Quelle<ProxmoxVm[]>>;
  sicherung(o: string, vmids: number[]): Promise<Quelle<SicherungDaten>>;
  unifi(o: string): Promise<Quelle<UnifiDaten>>;
  tresor(o: string): Promise<Quelle<TresorEintrag[]>>;
  fernzugaenge(o: string): Promise<Quelle<FernzugangEintrag[]>>;
  jobs(o: string, keys: string[]): Promise<Quelle<JobEintrag[]>>;
  /** Wartungsfenster, die für diese Assets gelten (global oder Asset-Überschneidung), und die angegebenen Standard-Vorlagen */
  wartung(o: string, vorlagen: string[], assetIds?: string[]): Promise<Quelle<WartungDaten>>;
  /** nur offene */
  problems(o: string, assetIds: string[]): Promise<Quelle<CmdbProblem[]>>;
  /** Vereinigung (Assets, Vorhaben, zusätzliche IDs wie der Restore-Change), nach createdAt */
  changes(o: string, assetIds: string[], vorhabenId?: string, weitere?: string[]): Promise<Quelle<CmdbChangeRequest[]>>;
  abnahmen(o: string, changeIds: string[]): Promise<Quelle<Record<string, AbnahmeVerweis>>>;
  dokument(o: string, id: string): Promise<Quelle<{ id: string; titel: string; version: number }>>;
  netzBestand(o: string, ziele: { ips: string[]; namen: string[] }): Promise<Quelle<NetzBestand>>;
}

export interface BetriebQuellenDeps {
  cmdb: {
    getAssetById(o: string, id: string): Promise<CmdbAsset | null>;
    getRelationsForAsset(o: string, id: string): Promise<CmdbAssetRelation[]>;
    listAssets(o: string, f: { sourceSkill?: string }): Promise<CmdbAsset[]>;
  };
  itsm: { listChangeRequests(o: string, f: { limit: number }): Promise<CmdbChangeRequest[]> };
  problems: { listProblems(o: string, f: { status?: ProblemStatus; limit?: number }): Promise<CmdbProblem[]> };
  dokumente: {
    getDocumentById(o: string, id: string): Promise<CmdbDocument | null>;
    getDocumentsForEntity(o: string, typ: CmdbLinkedEntityType, id: string): Promise<CmdbDocument[]>;
    listDocuments(o: string, f: { docType?: CmdbDocType; limit?: number }): Promise<CmdbDocument[]>;
  };
  tresor: { liste(o: string): Promise<Array<{ name: string; herkunft: string; zweck?: string }>> };
  fernzugaenge: { liste(o: string): Promise<Array<{ name: string; host: string; benutzer: string; status: string; system?: string; cmdbAssetId?: string }>> };
  jobRuns: { letzterLauf(key: string): Promise<{ startedAt: string; finishedAt?: string; ok?: boolean; fehler?: string } | undefined> };
  jobDefinitionen: () => Array<{ key: string; beschreibung: string; takt: { art: 'taeglich'; um: string } | { art: 'woechentlich'; tag: number; um: string } | { art: 'intervall'; minuten: number } }>;
  wartung: {
    kalender(o: string): Promise<Array<{ art: string; name: string; geltung: unknown; regel: unknown; aktiv: boolean }>>;
    standardStand(o: string): Promise<Array<{ vorlage: string; status: string }>>;
  };
  standard: () => Array<{ key: string; titel: string }>;
  proxmox: (input: Record<string, unknown>) => Promise<SkillResult>;
  proxmoxBackups: () => Promise<{ jeVm: Record<number, { neueste?: string; anzahl: number }>; unerreichbar: Array<{ speicher: string; grund: string }> }>;
  unifiLesen: () => Promise<FirewallStand>;
  unifiDns: () => Promise<SkillResult>;
  /** Wartungsregel lesbar (wartung.ts regelText); ohne Angabe JSON */
  regelText?: (regel: unknown) => string;
}

const fehlerText = (e: unknown) => schwaerze(e instanceof Error ? e.message : String(e)).text.slice(0, 300);
const OFFEN: ProblemStatus[] = ['logged', 'analyzing', 'root_cause_identified', 'fix_in_progress'];
const ABNAHME_SUCHE = 200;
const WOCHENTAG = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

// ── IPv4 ──────────────────────────────────────────────────────
export function ipZahl(ip: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return undefined;
  const t = m.slice(1).map(Number);
  if (t.some(x => x > 255)) return undefined;
  return ((t[0]! * 2 ** 24) + (t[1]! << 16) + (t[2]! << 8) + t[3]!) >>> 0;
}
/** „10.203.29.1/27“ (auch mit Host-Anteil) enthält ip? Ohne Präfix: gleiche Adresse. */
export function imNetz(cidr: string, ip: string): boolean {
  const [a, l] = cidr.trim().split('/');
  const n = a ? ipZahl(a) : undefined; const x = ipZahl(ip);
  if (n === undefined || x === undefined) return false;
  const laenge = l === undefined ? 32 : Number(l);
  if (!Number.isInteger(laenge) || laenge < 0 || laenge > 32) return false;
  const groesse = 2 ** (32 - laenge);
  return Math.floor(n / groesse) === Math.floor(x / groesse);
}
/** IPv4-Adressen und CIDR-Angaben in einem Text */
export function ipTokens(text: string): string[] {
  return text.match(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?(?![\d.])/g) ?? [];
}
/** nennt der Text eine der IPs (genau oder als enthaltendes Netz)? Liefert die Begründung. */
function nenntIp(text: string, ips: string[]): string | undefined {
  for (const t of ipTokens(text)) {
    const ip = ips.find(i => imNetz(t, i));
    if (ip) return t.includes('/') ? `Netz ${t} enthält ${ip}` : `nennt ${ip}`;
  }
  return undefined;
}
const istNutzIp = (ip: string) => ipZahl(ip) !== undefined && !ip.startsWith('127.') && !ip.startsWith('169.254.');

// ── netzBestand (rein, testbar) ──────────────────────────────
const NETZ_QUELLEN = ['pfsense', 'mikrotik', 'nginx_proxy_manager', 'cloudflare_dns'] as const;
type NetzQuelle = typeof NETZ_QUELLEN[number];
const txt = (v: unknown): string => {
  if (v === undefined || v === null || v === '') return '';
  if (Array.isArray(v)) return v.map(txt).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.any !== undefined) return 'beliebig';
    const teil = o.address ?? o.network ?? o.addr;
    if (teil !== undefined) return `${o.not ? 'nicht ' : ''}${txt(teil)}${o.port ? `:${txt(o.port)}` : ''}`;
    return JSON.stringify(v);
  }
  return String(v);
};
const liste = (v: unknown): string[] => (Array.isArray(v) ? v.map(x => String(x)) : typeof v === 'string' && v ? v.split(',').map(s => s.trim()) : []);
const ohnePunkt = (s: string) => s.trim().toLowerCase().replace(/\.$/, '');

/** Ordnet den CMDB-Bestand der Netzquellen den Asset-IPs/-Namen zu (Regeln siehe Task-Brief). */
export function ordneNetzBestand(bestand: Partial<Record<NetzQuelle, CmdbAsset[]>>, ziele: { ips: string[]; namen: string[] }): NetzBestand {
  const ips = ziele.ips.filter(istNutzIp);
  const namen = new Set(ziele.namen.map(ohnePunkt));
  const stand: Record<string, string> = {};
  for (const q of NETZ_QUELLEN) {
    const a = (bestand[q] ?? []).filter(x => x.status !== 'decommissioned');
    const max = a.reduce<string | undefined>((m, x) => { const t = x.lastSeenAt ?? x.updatedAt; return !m || (t && t > m) ? t : m; }, undefined);
    stand[q] = max ?? 'keine Daten erfasst';
  }
  const aktiv = (q: NetzQuelle) => (bestand[q] ?? []).filter(x => x.status !== 'decommissioned');
  const markeStatus = (a: CmdbAsset) => (a.status !== 'active' ? ` (CMDB-Status ${a.status})` : '');

  const netze: NetzBestand['netze'] = [];
  for (const q of ['pfsense', 'mikrotik'] as const) {
    for (const a of aktiv(q).filter(x => x.assetType === 'network')) {
      const subnetz = txt(a.attributes.subnet ?? a.attributes.address);
      if (!subnetz || !ips.some(i => imNetz(subnetz, i))) continue;
      const schnittstelle = txt(a.attributes.interface);
      netze.push({ quelle: q, name: a.name + markeStatus(a), subnetz, ...(schnittstelle ? { schnittstelle } : {}) });
    }
  }

  const firewallRegeln: NetzBestand['firewallRegeln'] = [];
  for (const q of ['pfsense', 'mikrotik'] as const) {
    for (const a of aktiv(q).filter(x => x.assetType === 'firewall_rule')) {
      const at = a.attributes;
      const schnittstellen = q === 'pfsense' ? liste(at.interface) : [txt(at.chain)].filter(Boolean);
      const von = txt(q === 'pfsense' ? at.source : at.src) || 'beliebig';
      const nach = txt(q === 'pfsense' ? (at.destination ?? at.destination_address) : at.dst) || 'beliebig';
      let grund = nenntIp(JSON.stringify(at), ips);
      if (!grund && q === 'pfsense') {
        for (const n of netze.filter(x => x.quelle === 'pfsense' && x.schnittstelle)) {
          const s = n.schnittstelle!.toLowerCase();
          if (schnittstellen.some(x => x.toLowerCase() === s)) { grund = `Schnittstelle ${n.schnittstelle} (Netz ${n.name} ${n.subnetz})`; break; }
          const vonS = von.toLowerCase(), nachS = nach.toLowerCase();
          if (vonS === s || vonS === `${s}ip`) { grund = `Quelle ${von} = Netz ${n.name} ${n.subnetz}`; break; }
          if (nachS === s || nachS === `${s}ip`) { grund = `Ziel ${nach} = Netz ${n.name} ${n.subnetz}`; break; }
        }
      }
      if (!grund) continue;
      const aktion = (txt(q === 'pfsense' ? at.type : at.action) || '?') + (at.disabled === true || at.disabled === 'true' ? ' (deaktiviert)' : '');
      const port = q === 'mikrotik' && at.port ? ` Port ${txt(at.port)}` : '';
      firewallRegeln.push({ quelle: q, name: a.name + markeStatus(a), aktion, schnittstelle: schnittstellen.join(', ') || '—', von, nach, protokoll: (txt(at.protocol) || 'beliebig') + port, grund });
    }
  }

  const zertifikate = aktiv('nginx_proxy_manager').filter(x => x.assetType === 'certificate');
  const passt = (muster: string, domain: string) => {
    const m = ohnePunkt(muster), d = ohnePunkt(domain);
    return m === d || (m.startsWith('*.') && d.endsWith(m.slice(1)) && !d.slice(0, -(m.length - 1)).includes('.'));
  };
  const proxyHosts: NetzBestand['proxyHosts'] = [];
  for (const a of aktiv('nginx_proxy_manager').filter(x => x.assetType === 'proxy_host')) {
    const at = a.attributes;
    const ziel = txt(at.forward_host);
    if (!ziel || !(ips.includes(ziel) || namen.has(ohnePunkt(ziel)))) continue;
    const domains = liste(at.domain_names).length ? liste(at.domain_names) : [a.name];
    const z = zertifikate.find(c => liste(c.attributes.domain_names).some(m => domains.some(d => passt(m, d))));
    proxyHosts.push({
      domains, ziel, port: Number(at.forward_port ?? 0), schema: txt(at.forward_scheme) || '?',
      ...(z ? { zertifikat: `${z.name}${z.attributes.expires_on ? ` (gültig bis ${txt(z.attributes.expires_on)})` : ''}` } : {}),
    });
  }

  const proxyDomains = new Set(proxyHosts.flatMap(p => p.domains.map(ohnePunkt)));
  const dnsEintraege: NetzBestand['dnsEintraege'] = [];
  for (const a of aktiv('cloudflare_dns').filter(x => x.assetType === 'dns_record')) {
    const wert = txt(a.attributes.content);
    const w = ohnePunkt(wert);
    if (!wert || !(ips.includes(wert) || namen.has(w) || proxyDomains.has(w))) continue;
    dnsEintraege.push({ name: a.fqdn ?? a.name, typ: txt(a.attributes.type) || '?', wert });
  }
  return { stand, firewallRegeln, netze, proxyHosts, dnsEintraege };
}

// ── Sammler ──────────────────────────────────────────────────
const taktText = (t: ReturnType<BetriebQuellenDeps['jobDefinitionen']>[number]['takt']): string =>
  t.art === 'taeglich' ? `täglich ${t.um}` : t.art === 'woechentlich' ? `wöchentlich ${WOCHENTAG[t.tag] ?? t.tag} ${t.um}` : `alle ${t.minuten} min`;

/** Platten aus der Proxmox-Konfiguration: „scsi0 local-zfs 60G“; CD-Laufwerke zählen nicht */
function platten(cfg: Record<string, unknown>): string[] {
  const aus: string[] = [];
  for (const [k, v] of Object.entries(cfg)) {
    if (!/^(scsi|virtio|sata|ide|efidisk|tpmstate)\d+$/.test(k) || typeof v !== 'string' || /media=cdrom/.test(v)) continue;
    const speicher = v.split(':')[0] ?? '?';
    const groesse = /(?:^|,)size=([^,]+)/.exec(v)?.[1];
    aus.push(`${k} ${speicher}${groesse ? ` ${groesse}` : ''}`);
  }
  return aus.sort();
}

function pruefsummenAus(doc: CmdbDocument): string[] {
  try {
    const s = doc.struktur ? (JSON.parse(doc.struktur) as { anhaenge?: Array<{ name: string; inhalt: string }> }) : undefined;
    const p = s?.anhaenge?.find(a => a.name === 'PRUEFUNG.txt');
    if (p) return p.inhalt.split('\n').map(z => /^([0-9a-f]{64}) {2}rohlauf-/.exec(z)?.[1]).filter((x): x is string => !!x);
  } catch { /* Struktur unlesbar — Markdown versuchen */ }
  return [...doc.content.matchAll(/Prüfsumme \(SHA-256[^)]*\): ([0-9a-f]{64})/g)].map(m => m[1]!);
}
const verweistAuf = (doc: CmdbDocument, changeId: string) => {
  try { return ((JSON.parse(doc.struktur ?? '{}') as { kopf?: { verweise?: string[] } }).kopf?.verweise ?? []).includes(`change:${changeId}`); } catch { return false; }
};

export function betriebQuellen(deps: BetriebQuellenDeps, jetzt: () => string): BetriebQuellen {
  /** jeder Sammler: Fehler → { stand, fehler }, nie werfen */
  const fang = async <T>(f: () => Promise<{ daten: T; hinweis?: string }>): Promise<Quelle<T>> => {
    const stand = jetzt();
    try { const r = await f(); return { daten: r.daten, stand, ...(r.hinweis ? { hinweis: r.hinweis } : {}) }; } catch (e) { return { stand, fehler: fehlerText(e) }; }
  };
  const skill = async (input: Record<string, unknown>): Promise<unknown> => {
    const r = await deps.proxmox(input);
    if (!r.success) throw new Error(r.error ?? `Proxmox ${String(input.action)} fehlgeschlagen`);
    return r.data;
  };
  const alleChanges = async (o: string) => {
    const l = await deps.itsm.listChangeRequests(o, { limit: QUELLEN_GRENZE });
    return { l, abgeschnitten: l.length >= QUELLEN_GRENZE };
  };

  return {
    assets: (o, ids) => fang(async () => {
      const gefunden: CmdbAsset[] = []; const fehlend: string[] = [];
      for (const id of ids) {
        const a = await deps.cmdb.getAssetById(o, id);
        if (!a) fehlend.push(id);
        else if (a.status === 'decommissioned') fehlend.push(`${id} (${a.name}, außer Betrieb)`);
        else gefunden.push(a);
      }
      return { daten: { gefunden, fehlend } };
    }),

    beziehungen: (o, ids) => fang(async () => {
      const m = new Map<string, CmdbAssetRelation>();
      for (const id of ids) for (const r of await deps.cmdb.getRelationsForAsset(o, id)) m.set(r.id, r);
      const relationen = [...m.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const eigene = new Set(ids);
      const fremde: BeziehungenDaten['fremde'] = {};
      for (const r of relationen) {
        for (const x of [r.sourceAssetId, r.targetAssetId]) {
          if (eigene.has(x) || fremde[x]) continue;
          const a = await deps.cmdb.getAssetById(o, x);
          fremde[x] = a ? { name: a.name, assetType: a.assetType, status: a.status } : { name: `?unbekannt:${x.slice(0, 8)}`, assetType: '?', status: 'nicht gefunden' };
        }
      }
      return { daten: { relationen, fremde } };
    }),

    proxmox: (_o, vms) => fang(async () => {
      if (!vms.length) return { daten: [] };
      const liste = (await skill({ action: 'list_vms', type: 'qemu' })) as Array<{ vmid: number; node: string; name?: string; status?: string }> | undefined;
      const live = new Map((liste ?? []).map(v => [Number(v.vmid), v]));
      const aus: ProxmoxVm[] = [];
      for (const vm of vms) {
        const l = live.get(vm.vmid);
        if (!l) { aus.push({ vmid: vm.vmid, node: vm.node, platten: [], ips: [], fehler: `VMID ${vm.vmid} in Proxmox nicht gefunden` }); continue; }
        const node = l.node; // live gewinnt: die VM kann seit der Erfassung migriert sein
        const e: ProxmoxVm = { vmid: vm.vmid, node, ...(l.name ? { name: l.name } : {}), ...(l.status ? { status: l.status } : {}), platten: [], ips: [] };
        try {
          const cfg = ((await skill({ action: 'api_raw', path: `/nodes/${node}/qemu/${vm.vmid}/config` })) ?? {}) as Record<string, unknown>;
          const cores = Number(cfg.cores ?? 1) * Number(cfg.sockets ?? 1);
          if (Number.isFinite(cores)) e.cores = cores;
          if (cfg.memory !== undefined && Number.isFinite(Number(cfg.memory))) e.speicherMiB = Number(cfg.memory);
          if (typeof cfg.ostype === 'string') e.ostype = cfg.ostype;
          e.platten = platten(cfg);
        } catch (err) { e.fehler = `Konfiguration nicht lesbar: ${fehlerText(err)}`; }
        if (l.status !== 'running') e.agentFehler = `VM läuft nicht (${l.status ?? 'Status unbekannt'}) — Gast-Agent nicht abgefragt`;
        else {
          try {
            const n = (await skill({ action: 'api_raw', path: `/nodes/${node}/qemu/${vm.vmid}/agent/network-get-interfaces` })) as { result?: Array<{ name?: string; 'ip-addresses'?: Array<{ 'ip-address'?: string; 'ip-address-type'?: string }> }> } | undefined;
            e.ips = [...new Set((n?.result ?? []).flatMap(i => (i['ip-addresses'] ?? []).filter(a => a['ip-address-type'] === 'ipv4').map(a => a['ip-address'] ?? '')).filter(istNutzIp))];
          } catch (err) { e.agentFehler = `Gast-Agent antwortet nicht: ${fehlerText(err)}`; }
        }
        aus.push(e);
      }
      return { daten: aus };
    }),

    sicherung: (_o, vmids) => fang(async () => {
      const roh = ((await skill({ action: 'list_backup_jobs' })) ?? []) as Array<Record<string, unknown>>;
      const zahlen = (v: unknown) => String(v ?? '').split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
      const jobs: SicherungsJob[] = [];
      for (const j of roh) {
        const alle = Number(j.all ?? 0) === 1;
        const pool = typeof j.pool === 'string' && j.pool ? j.pool : undefined;
        const ausgeschlossen = zahlen(j.exclude);
        const explizit = zahlen(j.vmid);
        const enthaelt = vmids.filter(v => (alle ? !ausgeschlossen.includes(v) : explizit.includes(v)));
        const ausgenommen = vmids.filter(v => ausgeschlossen.includes(v));
        if (!enthaelt.length && !ausgenommen.length && !pool) continue;
        jobs.push({ id: String(j.id ?? '?'), zeitplan: String(j.schedule ?? '—'), speicher: String(j.storage ?? '—'), enthaelt, ausgenommen, aktiv: String(j.enabled ?? '1') !== '0', alle, ...(pool ? { pool } : {}) });
      }
      const b = await deps.proxmoxBackups();
      const letzte: Record<number, string | undefined> = {};
      for (const v of vmids) letzte[v] = b.jeVm[v]?.neueste;
      return { daten: { jobs, letzte, unerreichbar: b.unerreichbar }, ...(b.unerreichbar.length ? { hinweis: `Sicherungsspeicher nicht erreichbar: ${b.unerreichbar.map(u => `${u.speicher} (${u.grund})`).join(', ')}` } : {}) };
    }),

    unifi: () => fang(async () => {
      const fw = await deps.unifiLesen();
      const dns = await deps.unifiDns();
      if (!dns.success) throw new Error(`DNS-Einträge nicht lesbar: ${dns.error ?? 'unbekannt'}`);
      const l = (Array.isArray(dns.data) ? dns.data : []) as Array<{ key?: string; value?: string; record_type?: string }>;
      const dnsWeiterleitungen = l.filter(e => /forward/i.test(e.record_type ?? '')).map(e => ({ domain: String(e.key ?? ''), server: String(e.value ?? '') }));
      return { daten: { ...fw, dnsWeiterleitungen } };
    }),

    tresor: (o) => fang(async () => ({ daten: (await deps.tresor.liste(o)).map(e => ({ name: e.name, herkunft: e.herkunft, ...(e.zweck ? { zweck: e.zweck } : {}) })) })),

    fernzugaenge: (o) => fang(async () => ({
      daten: (await deps.fernzugaenge.liste(o)).map(f => ({ name: f.name, host: f.host, benutzer: f.benutzer, status: f.status, ...(f.system ? { system: f.system } : {}), ...(f.cmdbAssetId ? { cmdbAssetId: f.cmdbAssetId } : {}) })),
    })),

    jobs: (_o, keys) => fang(async () => {
      const defs = new Map(deps.jobDefinitionen().map(d => [d.key, d]));
      const aus: JobEintrag[] = [];
      for (const key of keys) {
        const d = defs.get(key);
        const l = await deps.jobRuns.letzterLauf(key);
        aus.push({ key, ...(d ? { beschreibung: d.beschreibung, takt: taktText(d.takt) } : {}), ...(l ? { letzterLauf: { start: l.startedAt, ...(l.ok !== undefined ? { ok: l.ok } : {}), ...(l.fehler ? { fehler: l.fehler } : {}) } } : {}) });
      }
      return { daten: aus };
    }),

    wartung: (o, vorlagen, assetIds = []) => fang(async () => {
      const kal = await deps.wartung.kalender(o);
      const fenster = kal.filter(e => e.aktiv).filter(e => {
        const g = (e.geltung ?? {}) as { global?: boolean; assetIds?: string[] };
        return g.global === true || (g.assetIds ?? []).some(a => assetIds.includes(a));
      }).map(e => ({ name: e.name, art: e.art, regel: deps.regelText ? deps.regelText(e.regel) : JSON.stringify(e.regel) }));
      const titel = new Map(deps.standard().map(v => [v.key, v.titel]));
      const stand = new Map((await deps.wartung.standardStand(o)).map(s => [s.vorlage, s.status]));
      let changes: CmdbChangeRequest[] = [];
      if (vorlagen.length) changes = (await alleChanges(o)).l;
      const ids = new Set(assetIds);
      const daten: WartungDaten = {
        fenster,
        vorlagen: vorlagen.map(key => {
          // jüngster Standard-Change dieser Vorlage an einem Asset der Instanz (freigegebenUeber = standard:<key>)
          const c = changes.filter(x => x.freigegebenUeber === `standard:${key}` && x.affectedAssetIds.some(a => ids.has(a)))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
          const lauf = c ? ((c.lauf as { start?: string } | undefined)?.start ?? c.startedAt ?? c.createdAt) : undefined;
          return { key, ...(titel.has(key) ? { titel: titel.get(key) } : {}), ...(stand.has(key) ? { status: stand.get(key) } : {}), ...(lauf ? { letzterLauf: lauf } : {}) };
        }),
      };
      return { daten };
    }),

    problems: (o, assetIds) => fang(async () => {
      const ids = new Set(assetIds);
      const m = new Map<string, CmdbProblem>(); const voll: string[] = [];
      for (const status of OFFEN) {
        const l = await deps.problems.listProblems(o, { status, limit: QUELLEN_GRENZE });
        if (l.length >= QUELLEN_GRENZE) voll.push(status);
        for (const p of l) if (p.affectedAssetIds.some(a => ids.has(a))) m.set(p.id, p);
      }
      const daten = [...m.values()].sort((a, b) => a.detectedAt.localeCompare(b.detectedAt));
      return { daten, ...(voll.length ? { hinweis: `Problem-Liste abgeschnitten (Status ${voll.join(', ')}) — es kann weitere offene Problems geben` } : {}) };
    }),

    changes: (o, assetIds, vorhabenId, weitere = []) => fang(async () => {
      const { l, abgeschnitten } = await alleChanges(o);
      const ids = new Set(assetIds); const extra = new Set(weitere);
      const daten = l.filter(c => c.affectedAssetIds.some(a => ids.has(a)) || (vorhabenId !== undefined && c.vorhabenId === vorhabenId) || extra.has(c.id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      return { daten, ...(abgeschnitten ? { hinweis: `Change-Liste abgeschnitten (${QUELLEN_GRENZE}) — es kann weitere Changes geben` } : {}) };
    }),

    abnahmen: (o, changeIds) => fang(async () => {
      const aus: Record<string, AbnahmeVerweis> = {};
      const juengste = (docs: CmdbDocument[]) => [...docs].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.version - a.version)[0];
      const offen: string[] = [];
      for (const id of changeIds) {
        const d = juengste((await deps.dokumente.getDocumentsForEntity(o, 'change_request', id)).filter(x => x.docType === 'abnahme'));
        if (d) aus[id] = { docId: d.id, version: d.version, pruefsummen: pruefsummenAus(d) };
        else offen.push(id);
      }
      let hinweis: string | undefined;
      if (offen.length) {
        // Sammelprotokolle einer Serie hängen am letzten Glied — die übrigen Glieder stehen nur in kopf.verweise
        const l = (await deps.dokumente.listDocuments(o, { docType: 'abnahme', limit: ABNAHME_SUCHE })).filter(x => x.docType === 'abnahme');
        if (l.length >= ABNAHME_SUCHE) hinweis = `Suche nach Sammelprotokollen über die jüngsten ${ABNAHME_SUCHE} Abnahmeprotokolle begrenzt`;
        for (const id of offen) {
          const d = juengste(l.filter(x => verweistAuf(x, id)));
          if (d) aus[id] = { docId: d.id, version: d.version, pruefsummen: pruefsummenAus(d) };
        }
      }
      return { daten: aus, ...(hinweis ? { hinweis } : {}) };
    }),

    dokument: (o, id) => fang(async () => {
      const d = await deps.dokumente.getDocumentById(o, id);
      if (!d) throw new Error(`Dokument ${id.slice(0, 8)} nicht gefunden`);
      return { daten: { id: d.id, titel: d.title, version: d.version } };
    }),

    netzBestand: (o, ziele) => fang(async () => {
      const bestand: Partial<Record<NetzQuelle, CmdbAsset[]>> = {};
      for (const q of NETZ_QUELLEN) bestand[q] = await deps.cmdb.listAssets(o, { sourceSkill: q });
      return { daten: ordneNetzBestand(bestand, ziele) };
    }),
  };
}

// ── Gesamtlauf ───────────────────────────────────────────────
export interface Gesammelt {
  assets: Quelle<{ gefunden: CmdbAsset[]; fehlend: string[] }>;
  beziehungen: Quelle<BeziehungenDaten>;
  proxmox: Quelle<ProxmoxVm[]>;
  sicherung: Quelle<SicherungDaten>;
  unifi: Quelle<UnifiDaten>;
  tresor: Quelle<TresorEintrag[]>;
  fernzugaenge: Quelle<FernzugangEintrag[]>;
  jobs: Quelle<JobEintrag[]>;
  wartung: Quelle<WartungDaten>;
  problems: Quelle<CmdbProblem[]>;
  changes: Quelle<CmdbChangeRequest[]>;
  abnahmen: Quelle<Record<string, AbnahmeVerweis>>;
  /** nur wenn ein Architektur-Dokument angegeben ist */
  architektur?: Quelle<{ id: string; titel: string; version: number }>;
  netzBestand: Quelle<NetzBestand>;
}

/** VM aus dem Asset: attributes.vmid/node (Proxmox-Erfassung) */
export function vmVon(a: CmdbAsset): { vmid: number; node: string } | undefined {
  const vmid = Number(a.attributes.vmid);
  const node = typeof a.attributes.node === 'string' ? a.attributes.node : '';
  return Number.isInteger(vmid) && vmid > 0 ? { vmid, node } : undefined;
}

/** Parameter erneut prüfen (gespeichertes JSON kann älter oder beschädigt sein) */
export function leseBetriebParameter(p: string | BetriebParameter | undefined): BetriebParameter {
  if (p === undefined) throw new Error('Betriebs-Instanz ohne Parameter');
  let roh: unknown = p;
  if (typeof p === 'string') { try { roh = JSON.parse(p); } catch { throw new Error('Parameter der Betriebs-Instanz sind kein gültiges JSON'); } }
  const r = pruefeBetriebParameter(roh, MAX_ASSET_IDS);
  if (typeof r === 'string') throw new Error(`Parameter der Betriebs-Instanz ungültig: ${r}`);
  return r;
}

/** Alle Sammler in Abhängigkeitsreihenfolge: Assets → Proxmox (IPs) → übrige parallel → Abnahmen. Wirft nur bei ungültigen Parametern. */
export async function sammleBetrieb(q: BetriebQuellen, o: string, parameter: string | BetriebParameter | undefined): Promise<{ p: BetriebParameter; g: Gesammelt }> {
  const p = leseBetriebParameter(parameter);
  const assets = await q.assets(o, p.assets);
  const gefunden = assets.daten?.gefunden ?? [];
  const ids = gefunden.map(a => a.id);
  const vms = [...new Map(gefunden.filter(a => a.assetType === 'vm').map(vmVon).filter((v): v is { vmid: number; node: string } => !!v).map(v => [v.vmid, v])).values()];
  const proxmox = await q.proxmox(o, vms);
  const ips = [...new Set([...gefunden.map(a => a.ipAddress ?? ''), ...(proxmox.daten ?? []).flatMap(v => v.ips)].filter(istNutzIp))];
  const namen = [...new Set(gefunden.flatMap(a => [a.name, a.hostname ?? '', a.fqdn ?? '']).filter(Boolean))];
  const [beziehungen, sicherung, unifi, tresor, fernzugaenge, jobs, wartung, problems, changes, netzBestand, architektur] = await Promise.all([
    q.beziehungen(o, ids), q.sicherung(o, vms.map(v => v.vmid)), q.unifi(o), q.tresor(o), q.fernzugaenge(o), q.jobs(o, p.jobs ?? []),
    q.wartung(o, p.standardVorlagen ?? [], ids), q.problems(o, ids), q.changes(o, ids, p.vorhabenId, p.restoreChangeId ? [p.restoreChangeId] : []),
    q.netzBestand(o, { ips, namen }), p.architekturDocId ? q.dokument(o, p.architekturDocId) : Promise.resolve(undefined),
  ]);
  const abnahmen = await q.abnahmen(o, (changes.daten ?? []).map(c => c.id));
  return { p, g: { assets, beziehungen, proxmox, sicherung, unifi, tresor, fernzugaenge, jobs, wartung, problems, changes, abnahmen, netzBestand, ...(architektur ? { architektur } : {}) } };
}
