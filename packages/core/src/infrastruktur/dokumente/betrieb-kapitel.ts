// Betriebsdokument: Komponenten-Bildung und die Kapitel Netz, Identitäten, Sicherung, Überwachung, Betrieb (rein, ohne I/O).
// Jeder Text aus einer Quelle läuft durch schwaerze(); fehlende Daten werden „nicht belegt“ mit Grund, nie weggelassen.
import type { CmdbAsset } from '@alfred/types';
import { schwaerze } from '../../fernzugriff/kaefig.js';
import { zeitText } from './beweis.js';
import { imNetz, ipTokens, ipZahl, vmVon, type Gesammelt, type ProxmoxVm, type Quelle } from './betrieb-quellen.js';
import type { BetriebParameter } from './betrieb-parameter.js';
import type { Block } from './modell.js';

/** geschwärzt und danach gekürzt */
export const g = (s: unknown, max?: number): string => {
  if (s === undefined || s === null || s === '') return '—';
  const t = schwaerze(String(s)).text;
  return max !== undefined && t.length > max ? t.slice(0, max) + '…' : t;
};
export const id8 = (id: string) => id.slice(0, 8);
/** Sammler-Fehler als nichtBelegt-Block (Grund = Quelle + geschwärzter Fehler) */
export const nichtLesbar = (quelle: string, q: Quelle<unknown>, zusatz = ''): Block => ({ art: 'nichtBelegt', grund: `${quelle} nicht lesbar: ${g(q.fehler, 300)}${zusatz}` });
const hinweis = (q: Quelle<unknown>): Block[] => (q.hinweis ? [{ art: 'absatz', text: `Hinweis: ${g(q.hinweis, 400)}` }] : []);

/** Owner-Regel: Domänencontroller (Rolle AD-Domain-Services im Windows-Bestand) bewusst ohne PBS-Sicherung und ohne Snapshots */
export const DC_ROLLE = 'AD-Domain-Services';

export interface Komponente {
  name: string;
  assets: CmdbAsset[];
  vm?: CmdbAsset;
  server?: CmdbAsset;
  vmid?: number;
  node?: string;
  live?: ProxmoxVm;
  ips: string[];
  rollen: string[];
  dc: boolean;
}

const istNutzIp = (ip: string) => ipZahl(ip) !== undefined && !ip.startsWith('127.') && !ip.startsWith('169.254.');
const strListe = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Ein Name = eine Komponente (VM aus Proxmox + Server aus dem Fernzugang); Reihenfolge wie in den Parametern */
export function komponenten(gs: Gesammelt): Komponente[] {
  const gruppen = new Map<string, CmdbAsset[]>();
  for (const a of gs.assets.daten?.gefunden ?? []) {
    const k = a.name.toLowerCase();
    gruppen.set(k, [...(gruppen.get(k) ?? []), a]);
  }
  const live = gs.proxmox.daten ?? [];
  return [...gruppen.values()].map(assets => {
    const vm = assets.find(a => a.assetType === 'vm' && a.sourceSkill === 'proxmox') ?? assets.find(a => a.assetType === 'vm');
    const server = assets.find(a => a.assetType === 'server');
    const v = vm ? vmVon(vm) : undefined;
    const l = v ? live.find(x => x.vmid === v.vmid) : undefined;
    const rollen = [...new Set(assets.flatMap(a => strListe(a.attributes.roles)))];
    const ips = [...new Set([...assets.map(a => a.ipAddress ?? ''), ...(l?.ips ?? [])].filter(istNutzIp))];
    return {
      name: assets[0]!.name, assets, ...(vm ? { vm } : {}), ...(server ? { server } : {}),
      ...(v ? { vmid: v.vmid, node: l?.node ?? (v.node || undefined) } : {}), ...(l ? { live: l } : {}),
      ips, rollen, dc: rollen.includes(DC_ROLLE),
    };
  });
}

const gib = (bytes: unknown) => (Number.isFinite(Number(bytes)) && Number(bytes) > 0 ? `${Math.round((Number(bytes) / 1024 ** 3) * 10) / 10} GiB` : undefined);

export function komponentenZeile(k: Komponente): string[] {
  const vmA = k.vm?.attributes ?? {}; const sA = k.server?.attributes ?? {};
  const speicher = k.live?.platten.length ? k.live.platten.join(', ') : gib(vmA.maxdisk) ? `${gib(vmA.maxdisk)} (CMDB)` : '—';
  const ressourcen = k.live?.cores !== undefined && k.live.speicherMiB !== undefined
    ? `${k.live.cores} vCPU / ${Math.round((k.live.speicherMiB / 1024) * 10) / 10} GiB`
    : vmA.cpus !== undefined ? `${String(vmA.cpus)} vCPU / ${gib(vmA.maxmem) ?? '?'} (CMDB)`
      : sA.cpus !== undefined ? `${String(sA.cpus)} vCPU / ${gib(sA.ram_total) ?? '?'} (Server)` : '—';
  const os = sA.os ? `${String(sA.os)}${sA.os_version ? ` (${String(sA.os_version)})` : ''}` : k.live?.ostype ? `Proxmox-ostype ${k.live.ostype}` : '—';
  const lizenz = sA.license_status ? `${String(sA.license_status)}${sA.license_expires ? ` bis ${String(sA.license_expires)}` : ''}` : '—';
  const status = [...new Set(k.assets.map(a => a.status))].join('/') + (k.live?.status ? `; Proxmox ${k.live.status}` : '');
  return [
    g(k.name), k.assets.map(a => `${a.assetType} (${a.sourceSkill ?? '?'})`).join(', '), k.vmid !== undefined ? String(k.vmid) : '—', g(k.node),
    g(speicher), ressourcen, g(os), k.ips.join(', ') || '—', k.server ? g(k.rollen.join(', ')) : 'nicht belegt (kein Windows-Bestand)', g(lizenz), g(status),
  ];
}

/** Hinweise zu Kapitel 3: Agent, Konfiguration, umbenannte/fehlende VMs, fehlende IP */
export function komponentenHinweise(ks: Komponente[], proxmoxOk: boolean): string[] {
  const aus: string[] = [];
  for (const k of ks) {
    if (k.live?.agentFehler) aus.push(`${g(k.name)}: ${g(k.live.agentFehler, 300)}`);
    if (k.live?.fehler) aus.push(`${g(k.name)}: ${g(k.live.fehler, 300)}`);
    if (k.live?.name && k.live.name.toLowerCase() !== k.name.toLowerCase()) aus.push(`${g(k.name)}: VMID ${k.vmid} heißt in Proxmox „${g(k.live.name)}“ — Zuordnung prüfen`);
    if (proxmoxOk && k.vmid !== undefined && !k.live) aus.push(`${g(k.name)}: VMID ${k.vmid} nicht abgefragt`);
    if (k.vm && k.vmid === undefined) aus.push(`${g(k.name)}: VM-Asset ohne VMID in der CMDB`);
    if (!k.ips.length) aus.push(`${g(k.name)}: keine IP erfasst (weder CMDB noch Gast-Agent)${k.assets.some(a => a.status === 'inactive') ? ' — CMDB-Status inactive' : ''}`);
  }
  return aus;
}

const aktivText = (p: { aktiv: boolean | 'unbekannt'; bedingung: string }) => {
  const b = p.bedingung ? `, nur bei: ${p.bedingung}` : '';
  return p.aktiv === true ? `ja${b}` : p.aktiv === false ? `nein${b}` : `unbekannt (API liefert keinen Zustand)${b}`;
};

export function kapitelNetz(gs: Gesammelt, ks: Komponente[]): Block[] {
  const bloecke: Block[] = [];
  const ips = [...new Set(ks.flatMap(k => k.ips))];
  const u = gs.unifi;
  if (u.fehler || !u.daten) {
    bloecke.push(nichtLesbar('UniFi', u, ' — Netze, Zonen, Policies und DNS-Weiterleitungen nicht belegt (Trunk-Ports haben ohnehin keine Lesequelle)'));
  } else {
    const d = u.daten;
    const netze = d.netze.filter(n => n.subnetz && ips.some(ip => imNetz(n.subnetz!, ip)));
    const zoneVon = (n: typeof netze[number]) => d.zonen.find(z => z.id === n.zoneId || z.netzIds.includes(n.id))?.name;
    const zonen = new Set(netze.map(zoneVon).filter((x): x is string => !!x));
    bloecke.push(netze.length
      ? { art: 'tabelle', kopf: ['Netz', 'VLAN', 'Subnetz', 'Zone', 'Asset-IPs'], zeilen: netze.map(n => [g(n.name), n.vlan !== undefined ? String(n.vlan) : '—', g(n.subnetz), g(zoneVon(n)), ips.filter(ip => imNetz(n.subnetz!, ip)).join(', ')]) }
      : { art: 'absatz', text: 'Kein UniFi-Netz enthält eine IP der Komponenten.' });
    const textNenntIp = (t: string) => ipTokens(t).some(tok => ips.some(ip => imNetz(tok, ip)));
    const pol = d.policies.filter(p => zonen.has(p.quelleZone) || zonen.has(p.zielZone) || textNenntIp(`${p.quelle} ${p.ziel}`));
    if (pol.length) {
      bloecke.push({ art: 'absatz', text: 'UniFi-Policies dieser Zonen bzw. mit einer Asset-IP — je Zonenpaar in Auswertungsreihenfolge (die erste passende Regel gewinnt):' });
      bloecke.push({
        art: 'tabelle', kopf: ['Nr', 'Name', 'Richtung', 'Quelle', 'Ziel', 'Ports', 'Protokoll', 'Aktion', 'Aktiv', 'Herkunft', 'ID'],
        zeilen: pol.map(p => [p.index !== undefined ? String(p.index) : '—', g(p.name), `${g(p.quelleZone)} → ${g(p.zielZone)}`, g(p.quelle), g(p.ziel), g(p.ports), g(p.protokoll), g(p.aktion), g(aktivText(p)), g(p.herkunft), g(p.id)]),
      });
    } else bloecke.push({ art: 'absatz', text: 'Keine UniFi-Policy betrifft diese Zonen oder Asset-IPs.' });
    if (u.hinweis) bloecke.push({ art: 'nichtBelegt', grund: g(u.hinweis, 400) });
    bloecke.push(d.dnsWeiterleitungen.length
      ? { art: 'tabelle', kopf: ['Domäne', 'DNS-Server', 'aktiv', 'Komponente'], zeilen: d.dnsWeiterleitungen.map(w => [g(w.domain), g(w.server), w.aktiv ? 'ja' : 'nein (deaktiviert)', g(ks.filter(k => k.ips.includes(w.server)).map(k => k.name).join(', '))]) }
      : { art: 'absatz', text: u.hinweis ? 'Keine lokalen DNS-Weiterleitungen gelesen.' : 'Keine DNS-Weiterleitungen in UniFi.' });
    bloecke.push({ art: 'nichtBelegt', grund: 'Trunk-Ports: keine Lesequelle (Switch-Port-Profile werden nicht gesammelt)' });
  }
  bloecke.push({ art: 'absatz', text: 'Owner-Entscheidung: Die Proxmox-Cluster-Firewall bleibt auf „Any“.' });

  const nb = gs.netzBestand;
  const standText = (s: Record<string, string>) => Object.entries(s).map(([k, v]) => `${k} ${v}`).join(', ');
  if (nb.fehler || !nb.daten) {
    bloecke.push(nichtLesbar('CMDB-Netzbestand (pfSense/MikroTik/NPM/Cloudflare)', nb));
  } else {
    const d = nb.daten;
    if (!d.netze.length && !d.firewallRegeln.length && !d.proxyHosts.length && !d.dnsEintraege.length) {
      bloecke.push({ art: 'absatz', text: `keine Einträge in pfSense/MikroTik/NPM/Cloudflare betreffen diese Assets (Datenstand ${g(standText(d.stand))})` });
    } else {
      bloecke.push({ art: 'absatz', text: `Aus der CMDB (tägliche Erfassung von pfSense, MikroTik, NPM, Cloudflare), Datenstand ${g(standText(d.stand))}:` });
      if (d.netze.length) bloecke.push({ art: 'tabelle', kopf: ['Quelle', 'Netz', 'Subnetz', 'Schnittstelle'], zeilen: d.netze.map(n => [n.quelle, g(n.name), g(n.subnetz), g(n.schnittstelle)]) });
      if (d.firewallRegeln.length) bloecke.push({ art: 'tabelle', kopf: ['Quelle', 'Regel', 'Aktion', 'Schnittstelle', 'Von', 'Nach', 'Protokoll', 'Grund der Zuordnung'], zeilen: d.firewallRegeln.map(r => [r.quelle, g(r.name), g(r.aktion), g(r.schnittstelle), g(r.von), g(r.nach), g(r.protokoll), g(r.grund)]) });
      if (d.proxyHosts.length) bloecke.push({ art: 'tabelle', kopf: ['Domains (NPM)', 'Ziel', 'Port', 'Schema', 'Zertifikat'], zeilen: d.proxyHosts.map(p => [g(p.domains.join(', ')), g(p.ziel), String(p.port), g(p.schema), g(p.zertifikat ?? 'keines zugeordnet')]) });
      if (d.dnsEintraege.length) bloecke.push({ art: 'tabelle', kopf: ['DNS-Name (Cloudflare)', 'Typ', 'Wert', 'Grund der Zuordnung'], zeilen: d.dnsEintraege.map(e => [g(e.name), g(e.typ), g(e.wert), g(e.grund)]) });
    }
  }
  return bloecke;
}

export function kapitelIdentitaeten(gs: Gesammelt, ks: Komponente[]): Block[] {
  const bloecke: Block[] = [];
  const domaenen = ks.filter(k => k.server?.attributes.domain).map(k => `${g(k.name)}: Domäne ${g(k.server!.attributes.domain)}`);
  if (domaenen.length) bloecke.push({ art: 'liste', punkte: domaenen });
  const dienste = ks.filter(k => typeof k.server?.attributes.services === 'number').map(k => `${g(k.name)} ${String(k.server!.attributes.services)}`);
  bloecke.push({ art: 'nichtBelegt', grund: `Dienstkonten/gMSA und Gruppen: keine Lesequelle — der Windows-Bestand der CMDB führt keine Anmeldekonten der Dienste${dienste.length ? ` (nur die Anzahl der Dienste: ${dienste.join(', ')})` : ''}` });

  const namen = ks.map(k => k.name.toLowerCase());
  if (gs.tresor.fehler || !gs.tresor.daten) bloecke.push(nichtLesbar('Tresor', gs.tresor));
  else {
    const t = gs.tresor.daten.filter(e => namen.some(n => e.name.toLowerCase().includes(n))).sort((a, b) => a.name.localeCompare(b.name));
    // nur Name und Herkunft — Werte und Zweck nie (Zweck ist Freitext und kann Geheimes enthalten)
    bloecke.push(t.length
      ? { art: 'tabelle', kopf: ['Tresor-Eintrag (nur Name)', 'Herkunft'], zeilen: t.map(e => [g(e.name), g(e.herkunft)]) }
      : { art: 'absatz', text: 'Kein Tresor-Eintrag trägt den Namen einer Komponente.' });
  }
  const ids = new Set(ks.flatMap(k => k.assets.map(a => a.id)));
  if (gs.fernzugaenge.fehler || !gs.fernzugaenge.daten) bloecke.push(nichtLesbar('Fernzugänge', gs.fernzugaenge));
  else {
    const f = gs.fernzugaenge.daten.filter(z => (z.cmdbAssetId && ids.has(z.cmdbAssetId)) || namen.includes(z.name.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name) || a.host.localeCompare(b.host));
    bloecke.push(f.length
      ? { art: 'tabelle', kopf: ['Fernzugang', 'Host', 'Benutzer', 'System', 'Status'], zeilen: f.map(z => [g(z.name), g(z.host), g(z.benutzer), g(z.system ?? 'linux'), g(z.status)]) }
      : { art: 'absatz', text: 'Kein Fernzugang ist einer Komponente zugeordnet.' });
  }
  return bloecke;
}

export function kapitelSicherung(gs: Gesammelt, ks: Komponente[], p: BetriebParameter): Block[] {
  const bloecke: Block[] = [];
  const s = gs.sicherung;
  const dcs = ks.filter(k => k.dc);
  // Snapshot-Stand je VM aus Proxmox (nur gelesen, nie angenommen)
  const snap = (k: Komponente): string | undefined => (k.live?.snapshots && !k.live.snapshotFehler ? (k.live.snapshots.length ? k.live.snapshots.join(', ') : 'keine') : undefined);
  if (s.fehler || !s.daten) bloecke.push(nichtLesbar('Proxmox-Sicherung', s));
  else {
    const d = s.daten;
    const umfang = (j: typeof d.jobs[number]) => (j.alle ? 'alle VMs außer Ausnahmen' : j.pool ? `Pool ${g(j.pool)}` : 'ausgewählte VMs') + (j.node ? ` auf Node ${g(j.node)}` : '');
    if (d.jobs.length) {
      bloecke.push({ art: 'tabelle', kopf: ['Sicherungsjob', 'Zeitplan', 'Speicher', 'aktiv', 'Umfang'], zeilen: d.jobs.map(j => [g(j.id), g(j.zeitplan), g(j.speicher), j.aktiv ? 'ja' : 'nein', umfang(j)]) });
    }
    const offen: string[] = [];
    const zeilen = ks.map(k => {
      if (k.vmid === undefined) return [g(k.name), '—', '—', '—', '—', '—', 'keine VM — PBS-Sicherung nicht anwendbar'];
      const vmid = k.vmid;
      const drin = d.jobs.filter(j => j.aktiv && j.enthaelt.includes(vmid));
      const aus = d.jobs.filter(j => j.ausgenommen.includes(vmid));
      // Zugehörigkeit nicht belegt (Pool nicht lesbar, Node unbekannt): nie als Lücke werten
      const ungeprueft = d.jobs.filter(j => j.aktiv).flatMap(j => j.ungeprueft.filter(u => u.vmid === vmid).map(u => u.grund));
      if (!drin.length && ungeprueft.length) offen.push(`${g(k.name)}: ${ungeprueft.map(x => g(x, 200)).join('; ')}`);
      const s8 = snap(k);
      let bewertung: string;
      if (k.dc) {
        bewertung = drin.length ? 'gesichert — abweichend von der Owner-Regel (DCs ohne PBS-Sicherung)'
          : ungeprueft.length ? 'nicht belegt: Job-Zugehörigkeit nicht geprüft (Owner-Regel: DCs ohne PBS-Sicherung)' : 'bewusst ohne PBS-Sicherung (Owner-Entscheidung)';
        if (s8 && s8 !== 'keine') bewertung += ' — Snapshots vorhanden, abweichend von der Owner-Regel';
      } else if (drin.length) bewertung = 'gesichert';
      else if (ungeprueft.length) bewertung = 'nicht belegt: Job-Zugehörigkeit nicht geprüft';
      else if (!k.server) bewertung = 'Rolle nicht belegt (kein Windows-Bestand) — in keinem aktiven Sicherungsjob';
      else bewertung = 'Lücke: in keinem aktiven Sicherungsjob';
      return [g(k.name), String(vmid), g(drin.map(j => j.id).join(', ')), g(aus.map(j => j.id).join(', ')), zeitText(d.letzte[vmid]), g(s8 ?? 'nicht gelesen'), bewertung];
    });
    bloecke.push({ art: 'tabelle', kopf: ['Komponente', 'VMID', 'Sicherungsjob', 'Ausgenommen in', 'Letzte Sicherung', 'Snapshots', 'Bewertung'], zeilen });
    if (offen.length) bloecke.push({ art: 'nichtBelegt', grund: `Sicherungsjob-Zugehörigkeit nicht geprüft — ${offen.join(' | ')}` });
    bloecke.push(...hinweis(s));
  }
  if (dcs.length) {
    bloecke.push({ art: 'absatz', text: `Owner-Regel: Domänencontroller (${dcs.map(k => g(k.name)).join(', ')}) erhalten keine PBS-Sicherung und keine Snapshots.` });
    const ungelesen = dcs.filter(k => snap(k) === undefined);
    if (ungelesen.length) bloecke.push({ art: 'nichtBelegt', grund: `Snapshot-Stand nicht gelesen: ${ungelesen.map(k => `${g(k.name)}${k.live?.snapshotFehler ? ` (${g(k.live.snapshotFehler, 200)})` : ''}`).join(', ')}` });
  }
  bloecke.push({ art: 'nichtBelegt', grund: 'Systemstatus- und SQL-Sicherungen: keine Lesequelle im Betriebsdokument' });

  if (!p.restoreChangeId) bloecke.push({ art: 'nichtBelegt', grund: 'Restore-Beweis: kein Restore-Change angegeben' });
  else if (gs.changes.fehler || !gs.changes.daten) bloecke.push(nichtLesbar('Changes', gs.changes, ` — Restore-Beweis ${id8(p.restoreChangeId)} nicht belegt`));
  else {
    const c = gs.changes.daten.find(x => x.id === p.restoreChangeId);
    bloecke.push(c
      ? { art: 'tabelle', kopf: ['Restore-Beweis', 'Titel', 'Status', 'Ende', 'Ergebnis'], zeilen: [[id8(c.id), g(c.title), c.status, zeitText((c.lauf as { ende?: string } | undefined)?.ende ?? c.completedAt), g(c.result, 300)]] }
      : { art: 'nichtBelegt', grund: `Restore-Beweis: Change ${id8(p.restoreChangeId)} nicht gefunden` });
  }
  return bloecke;
}

export function kapitelUeberwachung(gs: Gesammelt, ks: Komponente[], p: BetriebParameter): Block[] {
  const bloecke: Block[] = [];
  if (!p.jobs?.length) bloecke.push({ art: 'nichtBelegt', grund: 'Überwachungs-Jobs: keine angegeben' });
  else if (gs.jobs.fehler || !gs.jobs.daten) bloecke.push(nichtLesbar('Jobs', gs.jobs));
  else {
    bloecke.push({
      art: 'tabelle', kopf: ['Job', 'Beschreibung', 'Takt', 'Letzter Lauf', 'Ergebnis'],
      zeilen: gs.jobs.daten.map(j => [g(j.key), j.beschreibung ? g(j.beschreibung, 300) : 'nicht registriert', g(j.takt), j.letzterLauf ? zeitText(j.letzterLauf.start) : 'kein Lauf erfasst',
        !j.letzterLauf ? '—' : j.letzterLauf.ok === true ? 'ok' : j.letzterLauf.ok === false ? `Fehler: ${g(j.letzterLauf.fehler, 200)}` : 'nicht abgeschlossen']),
    });
  }
  bloecke.push({ art: 'nichtBelegt', grund: 'Schwellen der Überwachung: nicht strukturiert erfasst (stehen nur in der Job-Beschreibung bzw. im Code)' });
  const mon = ks.filter(k => k.server?.attributes.monitoring && typeof k.server.attributes.monitoring === 'object')
    .map(k => `${g(k.name)}: Windows-Überwachung erfasst (${Object.keys(k.server!.attributes.monitoring as object).map(x => g(x)).join(', ')})`);
  if (mon.length) bloecke.push({ art: 'liste', punkte: mon });
  return bloecke;
}

export function problemTabelle(gs: Gesammelt): Block[] {
  if (gs.problems.fehler || !gs.problems.daten) return [nichtLesbar('Problems', gs.problems)];
  const l = gs.problems.daten;
  return [
    l.length
      ? { art: 'tabelle', kopf: ['Problem', 'Titel', 'Priorität', 'Status', 'Erkannt'], zeilen: l.map(x => [id8(x.id), g(x.title, 200), x.priority, x.status, zeitText(x.detectedAt)]) }
      : { art: 'absatz', text: 'Keine offenen Problems zu diesen Assets.' },
    ...hinweis(gs.problems),
  ];
}

export function kapitelBetrieb(gs: Gesammelt, p: BetriebParameter): Block[] {
  const bloecke: Block[] = [];
  const w = gs.wartung;
  if (w.fehler || !w.daten) bloecke.push(nichtLesbar('Wartung', w));
  else {
    bloecke.push(p.standardVorlagen?.length
      ? { art: 'tabelle', kopf: ['Standard-Vorlage', 'Titel', 'Freigabe', 'Letzter Lauf an diesen Assets'], zeilen: w.daten.vorlagen.map(v => [g(v.key), v.titel ? g(v.titel) : 'unbekannte Vorlage', g(v.status ?? 'nicht angefragt'), v.letzterLauf ? zeitText(v.letzterLauf) : 'kein Lauf erfasst']) }
      : { art: 'nichtBelegt', grund: 'Standard-Vorlagen: keine angegeben' });
    bloecke.push(w.daten.fenster.length
      ? { art: 'tabelle', kopf: ['Wartungsfenster', 'Art', 'Regel'], zeilen: w.daten.fenster.map(f => [g(f.name), g(f.art), g(f.regel)]) }
      : { art: 'absatz', text: 'Kein Wartungsfenster und keine Sperre gilt für diese Assets.' });
  }
  bloecke.push(...problemTabelle(gs));
  return bloecke;
}
