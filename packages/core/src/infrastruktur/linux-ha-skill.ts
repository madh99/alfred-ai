/**
 * I8e Paket 2 — Skill „linux_ha“: Hochverfügbarkeit für SQL Server 2025 auf Linux (Pacemaker, diskless SBD, Verfügbarkeitsgruppe)
 * über die festen Bash-Bausteine aus linux-ha.ts (Transport `FernzugriffSkill.linuxSkript`). Alles außer „status“ nur als Schritt eines
 * freigegebenen Changes. Das hacluster-Kennwort erzeugt der Skill einmalig im Tresor (`sqllnx-ha-hacluster`, gleich für alle Knoten) und
 * gibt es nur über die Standardeingabe (erste Zeile, JSON) weiter.
 *
 * Erweiterung (Tasks 3–6): neue Aktion in LESEND bzw. NUR_IM_CHANGE, LINUX_HA_MIN_ZEITLIMIT_S, `pruefeEingabe`, `ausfuehren` (switch);
 * Status-Teile über `linuxHaStatusTeile` ergänzen (fester Wortlaut, FESTE_AUSGABEN['linux_ha.status'] in change-schritte.ts nachziehen).
 */
import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import {
  LINUX_HA_BAUSTEINE, LINUX_HA_ZEIT_MS, HA_KNOTEN, HA_SQL_ZUSATZQUELLEN, HA_VERSIONEN, HA_PAKETE, HA_HACLUSTER_TRESOR, haErgebnis, pruefeHaVorbereiten,
  HA_CLUSTER_NAME, HA_SBD_TIMEOUT_S, HA_STONITH_WD_TIMEOUT_S, HA_WATCHDOG_DEV, pruefeHaCluster, pruefeHaClusterEntfernen,
  HA_FENCING_ARTEN, HA_FENCING_SPERRE_S, HA_FENCING_VERZOEGERUNG_S, HA_FENCING_MAX_ALTER_S, HA_FENCING_HAENGER_KNOTEN, pruefeHaFencing, pruefeHaFencingBelegen, fencingBelegGueltig,
  type HaKnoten, type HaRolle, type HaVorbereitenParameter, type HaClusterParameter, type HaClusterEntfernenParameter,
  type HaFencingArt, type HaFencingParameter, type HaFencingBelegenParameter, type FencingLage, type FencingBeleg, type FencingTest,
  HA_PM_FENSTER_S, HA_AG_NAME, HA_AG_VIP, HA_AG_KONFIG_KNOTEN, HA_AG_ROLLEN, HA_AG_RESSOURCE, HA_AG_KLON, HA_AG_VIP_RESSOURCE, HA_PACEMAKER_TRESOR, haMasterkeyTresor, istOeffentlichesZertifikat,
  pruefeHaAgBesetzung, pruefeHaAgAbschluss, pruefeHaAgEntfernen, pruefeHaAgFailover, type HaAgFailoverParameter,
  type HaAgBesetzung, type HaAgEndpunktParameter, type HaAgReplikatParameter, type HaAgAbschlussParameter, type HaAgEntfernenParameter,
} from './linux-ha.js';
import { linuxSqlKennwort, saName, type LinuxSqlDeps } from './linux-sql-skill.js';

const sek = (ms: number) => Math.ceil(ms / 1000);
/** Mindest-zeitlimitS je Aktion: Baustein-Zeitgrenze + 60 s Puffer */
export const LINUX_HA_MIN_ZEITLIMIT_S: Readonly<Record<string, number>> = {
  status: sek(LINUX_HA_ZEIT_MS.status) + 60,
  ha_vorbereiten: sek(LINUX_HA_ZEIT_MS.vorbereiten) + 60,
  cluster_anlegen: sek(LINUX_HA_ZEIT_MS.cluster) + 60,
  cluster_entfernen: sek(LINUX_HA_ZEIT_MS.clusterEntfernen) + 60,
  fencing_pruefen: sek(LINUX_HA_ZEIT_MS.fencingPruefen) + 60,
  fencing_belegen: sek(LINUX_HA_ZEIT_MS.fencingBelegen) + 60,
  // Task 5: zehn Bausteine nacheinander (Status ×3, Endpunkt ×3, Replikat ×3, Abschluss) — je Baustein 60 s Puffer
  ag_anlegen: sek(3 * LINUX_HA_ZEIT_MS.status + 3 * LINUX_HA_ZEIT_MS.agEndpunkt + 3 * LINUX_HA_ZEIT_MS.agReplikat + LINUX_HA_ZEIT_MS.agAbschluss) + 10 * 60,
  ag_entfernen: sek(3 * LINUX_HA_ZEIT_MS.agEntfernen) + 3 * 60,
  // Task 6: Status ×3 (Gate), Failover-Baustein auf dem Ziel — je Baustein 60 s Puffer
  ag_failover: sek(3 * LINUX_HA_ZEIT_MS.status + LINUX_HA_ZEIT_MS.agFailover) + 4 * 60,
};

export type LinuxHaDeps = LinuxSqlDeps;

export const LINUX_HA_LESEND = new Set(['status']);
export const LINUX_HA_NUR_IM_CHANGE = new Set(['ha_vorbereiten', 'cluster_anlegen', 'cluster_entfernen', 'fencing_pruefen', 'fencing_belegen', 'ag_anlegen', 'ag_entfernen', 'ag_failover']);
/** Task 4 — fencing_pruefen hat keinen Rückweg; nur mit genau diesem Grund (change-schritte.ts, OHNE_RUECKWEG_NUR_MIT_GRUND) */
export const FENCING_OHNE_RUECKWEG_GRUND = 'Testknoten setzt sich selbst zurück; Beleg folgt mit fencing_belegen';
const ZUGANG = /^[a-z0-9][a-z0-9.-]{0,62}$/i;
// Ruling R29 — die Change-Planprüfung (change-schritte verweise/ersetzeVerweise) ersetzt {{…}} vor pruefeEingabe durch den Wert „verweis“
const istVerweis = (v: unknown) => typeof v === 'string' && (v.includes('{{') || v.trim() === 'verweis');

// ── Status ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LinuxHaStatus {
  zustand: string;
  watchdog?: Array<{ geraet: string; kennung: string | null; treiber?: string | null }>;
  pciEsb?: boolean;
  halter?: Array<{ pid: number; name: string | null; exe: string | null }>;
  pakete?: Record<string, { version: string | null; gehalten: boolean }>;
  soll?: Record<string, string>;
  hadr?: string | null; sqlDienst?: string;
  firewall?: { tabelle: boolean; dienst: string; aktiviert: string };
  hosts?: boolean; runtimeWatchdog?: string | null; pcsd?: string;
  /** Ruling R10: Block in der alten Form (nur Kurznamen, ohne FQDN) — ha_vorbereiten stellt ihn um */
  hostsVeraltet?: boolean;
  /** Live-Fix (c2e4f56d): sbd-Drop-in und Warteskript vorhanden und unverändert */
  sbdWartetAufWatchdog?: boolean;
  /** Fix-Runde 1: Loopback-Zeilen mit eigenem Namen, ersetzte Originale, zusätzliche 1433-Quellen (Ruling R4) */
  hostsLoopback?: string[]; hostsEntfernt?: string[]; sql1433Zusatz?: string[];
  /** Task 3: Cluster aus corosync.conf, crm_mon-XML, pcs stonith sbd status, stonith-watchdog-timeout */
  cluster?: LinuxHaCluster;
  /** Task 4: Fencing-Test und -Beleg dieses Knotens, boot_id, Identität im Cluster */
  fencing?: FencingLage;
  /** Task 6: AG-Lage (Pacemaker und SQL über die Zugangsdatei des Resource-Agents) */
  ag?: LinuxHaAg;
}

/** Task 6 — AG-Teil des Status (PY_HA_STATUS → r.ag) */
export interface LinuxHaAg {
  art: 'keine' | 'eingerichtet';
  ressource?: boolean; name?: string | null; requiredSyncRessource?: string | null;
  /** Knoten mit Promoted bzw. gestarteter VIP (crm_mon); null = nicht lesbar */
  promoted?: string[] | null; vip?: string[] | null;
  /** rsc_location an ag_cluster, ag_cluster-clone, ag_vip (CIB); null = nicht lesbar */
  standort?: Array<{ id: string | null; rsc: string | null; knoten: string | null; rolle: string | null }> | null;
  sql?: { name: string | null; requiredSync: number | null; datenbanken: number | null; replikate: Array<{ name: string | null; rolle: string | null; modus: string | null; verbunden: string | null; dbs: number; sync: number }> } | null;
  sqlFehler?: string | null;
}

/**
 * AG-Teil des Status (fester Wortlaut): „AG sqllnxag01: Promoted sqllnx01, VIP sqllnx01, required_sync Ressource 0 / SQL 0, Replikate
 * sqllnx01 PRIMARY / sqllnx02 SECONDARY SYNCHRONIZED 1/1, Standort-Bedingungen 0“; offene Bedingungen „Standort-Bedingungen OFFEN: <id>
 * (<knoten>, <rolle>)“ (z. B. eine cli-prefer aus pcs resource move); ohne AG „AG nicht eingerichtet“. Positive Stücke ohne Verneinung
 * (Planprüfung VERNEINUNG): „Standort-Bedingungen 0“ erwarten, „OFFEN“ als nichtEnthalten
 */
export function agText(a: LinuxHaAg): string {
  if (a.art !== 'eingerichtet') return 'AG nicht eingerichtet';
  const kn = (l: string[] | null | undefined) => (!l ? 'unbekannt' : l.length ? l.join('+') : 'keiner');
  const sql = a.sql;
  const reps = !sql ? (a.sqlFehler ? `SQL nicht lesbar (${a.sqlFehler})` : 'SQL ohne Zugangsdatei')
    : `Replikate ${sql.replikate.filter(r => r.modus !== 'CONFIGURATION_ONLY').map(r => `${r.name ?? '?'} ${r.rolle ?? '?'}${r.dbs > 0 && r.rolle !== 'PRIMARY' ? ` ${r.sync === r.dbs ? 'SYNCHRONIZED' : 'NICHT SYNCHRONIZED'} ${r.sync}/${r.dbs}` : ''}`).join(' / ') || 'keine'}`;
  const st = a.standort;
  const standort = !st ? 'Standort-Bedingungen unbekannt' : !st.length ? 'Standort-Bedingungen 0'
    : `Standort-Bedingungen OFFEN: ${st.map(x => `${x.id ?? '?'} (${x.knoten ?? '?'}${x.rolle ? `, ${x.rolle}` : ''})`).join(', ')}`;
  return `AG ${a.name ?? sql?.name ?? '?'}: Promoted ${kn(a.promoted)}, VIP ${kn(a.vip)}, required_sync Ressource ${a.requiredSyncRessource ?? '?'} / SQL ${sql?.requiredSync ?? '?'}, ${reps}, ${standort}`;
}

/** „2026-11-17T14:03:12Z“ → „2026-11-17 14:03 UTC“ */
const zeitText = (z: unknown) => { const m = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d)/.exec(String(z ?? '')); return m ? `${m[1]} ${m[2]} UTC` : String(z ?? '?'); };

/**
 * Fencing-Teil des Status (fester Wortlaut): „Fencing belegt (trennung, 2026-11-17 14:03 UTC, Reset 18 s, Rejoin 41 s)“; sonst „Fencing Test
 * <art> ausgelöst, Reset ausstehend“ (gleiche boot_id, Test ≤ 30 min), „Fencing Test <art> vom … ohne Reset (boot_id unverändert)“, „Fencing
 * Test <art> vom … erfolgt, Beleg ausstehend (fencing_belegen)“, „Fencing nicht belegt“, „Fencing Beleg ungültig (<Grund>)“, „Fencing unbekannt“
 */
export function fencingText(f: FencingLage | undefined): string {
  if (!f) return 'Fencing unbekannt';
  // Fix-Runde 1: eine geladene Test-Sperre (nft inet alfred_fencetest) steht sichtbar dahinter
  const t0 = fencingStand(f);
  return f.sperreAktiv ? `${t0} — Corosync-Sperre alfred_fencetest AKTIV` : t0;
}

function fencingStand(f: FencingLage): string {
  const t = f.test && typeof f.test === 'object' ? f.test as FencingTest : undefined;
  const frisch = !!t && typeof f.jetztS === 'number' && f.jetztS - t.zeitS <= HA_FENCING_MAX_ALTER_S;
  if (t && f.bootId && t.bootIdVorher === f.bootId) return frisch ? `Fencing Test ${t.art} ausgelöst, Reset ausstehend` : `Fencing Test ${t.art} vom ${zeitText(t.zeit)} ohne Reset (boot_id unverändert)`;
  const grund = fencingBelegGueltig(f.beleg, f);
  if (!grund) { const b = f.beleg as FencingBeleg; return `Fencing belegt (${b.art}, ${zeitText(b.zeit)}, Reset ${b.resetS} s, Rejoin ${b.rejoinS} s)`; }
  const b = f.beleg && typeof f.beleg === 'object' ? f.beleg as FencingBeleg : undefined;
  if (t && frisch && b?.testZeit !== t.zeit) return `Fencing Test ${t.art} vom ${zeitText(t.zeit)} erfolgt, Beleg ausstehend (fencing_belegen)`;
  if (!f.beleg) return 'Fencing nicht belegt';
  return `Fencing Beleg ungültig (${grund})`;
}

export interface LinuxHaCluster {
  art: 'keiner' | 'debian' | 'eingerichtet';
  name?: string | null;
  knoten?: Array<{ name: string | null; ip: string | null }>;
  crm?: { knoten: number; online: string[]; quorum: boolean; stonith: boolean; ressourcen: number } | null;
  sbd?: Record<string, { installiert: boolean; aktiviert: boolean; laeuft: boolean }> | null;
  stonithWatchdogTimeout?: string | null;
  /** Task 8: Fehlaktionen (Fenster) und Fehlerzähler der AG-Ressource dieses Knotens (PY_PM_FEHLER_FUNK); null = nicht lesbar */
  fehler?: PacemakerFehler | null;
}

export interface PacemakerFehler {
  knoten: string; online: boolean; quorum: boolean; ressource: boolean; fehlerzaehler: number; fehlerzaehlerAlt?: number;
  fehlaktionen: Array<{ aktion: string | null; status: string | null; zeit: number | null }>; aeltere: number; fensterS: number;
}

/**
 * Task 8 — Pacemaker-Fehler dieses Knotens (fester Wortlaut): „Pacemaker ohne Fehlaktionen (30 min), Fehlerzähler ag_cluster 0 (30 min)“;
 * sonst „Pacemaker FEHLER: <n> Fehlaktionen in 30 min (<aktionen>), Fehlerzähler ag_cluster <n> (30 min)“. Ruling R19: der Fehlerzähler zählt
 * nur mit letztem Fehler im Fenster; ältere stehen als „älterer Fehlerzähler <n>“ dahinter bzw. „Pacemaker-Fehler unbekannt (crm_mon nicht
 * lesbar)“. Die Ressource selbst nennt clusterText/agText; hier zählt nur, ob seit dem Fenster etwas schiefging.
 */
export function pacemakerFehlerText(f: PacemakerFehler | null | undefined): string {
  if (!f) return 'Pacemaker-Fehler unbekannt (crm_mon nicht lesbar)';
  const min = Math.round((f.fensterS ?? HA_PM_FENSTER_S) / 60);
  const alt = `${f.aeltere ? `, ältere Fehlaktionen ${f.aeltere}` : ''}${f.fehlerzaehlerAlt ? `, älterer Fehlerzähler ${f.fehlerzaehlerAlt}` : ''}`;
  if (!f.fehlaktionen.length && !f.fehlerzaehler) return `Pacemaker ohne Fehlaktionen (${min} min), Fehlerzähler ${HA_AG_RESSOURCE} 0 (${min} min)${alt}`;
  const akt = f.fehlaktionen.slice(0, 5).map(a => `${a.aktion ?? '?'}${a.status ? ` ${a.status}` : ''}`).join(', ');
  return `Pacemaker FEHLER: ${f.fehlaktionen.length} Fehlaktionen in ${min} min${akt ? ` (${akt})` : ''}, Fehlerzähler ${HA_AG_RESSOURCE} ${f.fehlerzaehler} (${min} min)${alt}`;
}

/** „Cluster sqllnxcl01: 3/3 online, Quorum ja, STONITH an, SBD aktiv 3/3, stonith-watchdog-timeout 20s“ (fester Wortlaut) */
export function clusterText(c: LinuxHaCluster | undefined): string {
  if (!c) return 'Cluster unbekannt';
  if (c.art === 'keiner') return 'Cluster nicht eingerichtet';
  if (c.art === 'debian') return 'Cluster nicht eingerichtet (Debian-Standardkonfiguration)';
  const name = c.name ?? '?';
  const namen = (c.knoten ?? []).map(k => k.name).filter((n): n is string => !!n);
  const n = namen.length;
  if (!c.crm) return `Cluster ${name}: Pacemaker hier nicht aktiv (${n} Knoten konfiguriert)`;
  const sbd = c.sbd ? `SBD aktiv ${namen.filter(k => c.sbd![k]?.laeuft).length}/${n}` : 'SBD unbekannt';
  const w = c.stonithWatchdogTimeout;
  const swt = !w ? 'nicht gesetzt' : /^\d+$/.test(w) ? `${w}s` : w;
  return `Cluster ${name}: ${c.crm.online.filter(k => namen.includes(k)).length}/${n} online, Quorum ${c.crm.quorum ? 'ja' : 'nein'}, STONITH ${c.crm.stonith ? 'an' : 'aus'}, ${sbd}, stonith-watchdog-timeout ${swt}`;
}

const istEsb = (k: string | null | undefined) => !!k && /i6300esb/i.test(k);
const sbd = (h: { name: string | null; exe: string | null }) => h.name === 'sbd' && h.exe === '/usr/sbin/sbd';

function watchdogText(s: LinuxHaStatus): string {
  const g = s.watchdog ?? [];
  if (!g.length) return s.pciEsb ? 'Watchdog fehlt (i6300ESB in der VM, Modul nicht geladen)' : 'Watchdog fehlt (kein i6300ESB in der VM)';
  const fremd = g.find(x => !istEsb(x.kennung));
  if (fremd) return `Watchdog FREMD (${fremd.geraet}: ${fremd.kennung ?? 'unbekannt'})`;
  const h = s.halter ?? [];
  const andere = h.filter(x => !sbd(x));
  if (andere.length) return `Watchdog i6300esb BELEGT von ${andere.map(x => `${x.name ?? '?'}(${x.pid})`).join(' ')}`;
  return h.length ? 'Watchdog i6300esb bei sbd' : 'Watchdog i6300esb frei';
}

function paketeText(s: LinuxHaStatus): string {
  const p = s.pakete ?? {}; const soll = s.soll ?? {};
  const ab: string[] = [];
  for (const [pk, v] of Object.entries(soll)) {
    const ist = p[pk];
    if (!ist?.version) ab.push(`${pk} fehlt`);
    else if (ist.version !== v) ab.push(`${pk} ${ist.version} (soll ${v})`);
    else if (!ist.gehalten) ab.push(`${pk} nicht gehalten`);
  }
  const extra = Object.entries(p).find(([k]) => k.startsWith('linux-modules-extra-'));
  if (extra && !extra[1].version) ab.push(`${extra[0]} fehlt`);
  return ab.length ? `Pakete abweichend: ${ab.join(', ')}` : 'Pakete fest';
}

/** Teile des festen Wortlauts (Tasks 3–6 hängen z. B. „Cluster …“ an) */
export function linuxHaStatusTeile(s: LinuxHaStatus): string[] {
  const fw = s.firewall;
  // Ruling R22: geladene Zusatzquellen für 1433 ≠ HA_SQL_ZUSATZQUELLEN → „veraltet“ (nicht „aktiv“), ha_vorbereiten stellt um
  const zusatz = s.sql1433Zusatz;
  const zusatzAbweichend = zusatz !== undefined && (new Set(zusatz).size !== new Set(HA_SQL_ZUSATZQUELLEN).size || HA_SQL_ZUSATZQUELLEN.some(q => !zusatz.includes(q)));
  const fwText = !fw ? 'Firewall alfred_ha unbekannt'
    : fw.tabelle && fw.dienst === 'active' && fw.aktiviert === 'enabled'
      ? zusatzAbweichend
        ? `Firewall alfred_ha veraltet (1433: Knoten${zusatz.length ? ` + ${zusatz.join(', ')}` : ''}; Soll Knoten + ${HA_SQL_ZUSATZQUELLEN.join(', ')} — ha_vorbereiten stellt um)`
        : `Firewall alfred_ha aktiv (1433: Knoten${zusatz?.length ? ` + ${HA_SQL_ZUSATZQUELLEN.join(', ')}` : ''})`
      : `Firewall alfred_ha ${fw.tabelle ? 'geladen' : 'nicht geladen'}, Dienst ${fw.dienst}, ${fw.aktiviert}`;
  return [
    watchdogText(s),
    paketeText(s),
    s.hadr === '1' ? 'HADR an' : 'HADR aus',
    fwText,
    s.hostsLoopback?.length ? `hosts-Block mit eigenem Namen auf Loopback (${s.hostsLoopback.join(' / ').slice(0, 120)})` : s.hosts ? 'hosts-Block vorhanden' : s.hostsVeraltet ? 'hosts-Block veraltet (ohne FQDN — ha_vorbereiten stellt um)' : 'hosts-Block fehlt',
    s.runtimeWatchdog === '0' ? 'RuntimeWatchdog aus' : `RuntimeWatchdog AN (${s.runtimeWatchdog ?? 'unbekannt'})`,
    // Live-Fix (c2e4f56d): sbd wartet beim Start auf das Watchdog-Gerät (Drop-in + Warteskript von ha_vorbereiten)
    s.sbdWartetAufWatchdog === true ? 'sbd wartet auf Watchdog' : s.sbdWartetAufWatchdog === false ? 'sbd ohne Watchdog-Wartezeit (Drop-in fehlt)' : 'sbd Watchdog-Wartezeit unbekannt',
    s.pcsd === 'active' ? 'pcsd aktiv' : `pcsd ${s.pcsd ?? 'unbekannt'}`,
    clusterText(s.cluster),
    // Task 8: nur, wenn der Status die Fehler gelesen hat (eingerichteter Cluster) — davor bleibt der Text wie bisher
    ...(s.cluster?.art === 'eingerichtet' && s.cluster.fehler !== undefined ? [pacemakerFehlerText(s.cluster.fehler)] : []),
    fencingText(s.fencing),
    // Task 6: AG-Teil am Ende, sobald eine AG eingerichtet ist (Ressource oder Zugangsdatei) — davor bleibt der Text wie bisher;
    // Stücke wie „3/3 online“, „Fencing belegt“ bleiben unverändert
    ...(s.ag?.art === 'eingerichtet' ? [agText(s.ag)] : []),
  ];
}

/** Fester Wortlaut — Stücke stehen in FESTE_AUSGABEN['linux_ha.status'] (change-schritte.ts); bei Änderungen dort nachziehen */
export function linuxHaStatusText(zugang: string, s: LinuxHaStatus): string {
  return `${zugang}: ${linuxHaStatusTeile(s).join('; ')}`;
}

// ── Parameter ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function vorbereitenParameter(input: Record<string, unknown>): HaVorbereitenParameter {
  const roh = input.knoten === undefined ? HA_KNOTEN : input.knoten;
  const knoten = (Array.isArray(roh) ? roh : []).map(e => {
    const x = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    return { name: typeof x.name === 'string' ? x.name.trim().toLowerCase() : x.name, ip: typeof x.ip === 'string' ? x.ip.trim() : x.ip };
  }) as HaKnoten[];
  const p: HaVorbereitenParameter = { knoten, rolle: String(input.rolle ?? '').trim() as HaRolle, versionen: { ...HA_VERSIONEN } };
  const f = pruefeHaVorbereiten(p); if (f) throw new Error(f);
  return p;
}

/**
 * Cluster-Knoten: Namen aus HA_KNOTEN (Global Constraints, feste IPs) — als Name oder {name, ip} genau wie dort; immer alle drei, in der
 * Reihenfolge von HA_KNOTEN (nodeid 1–3 stabil)
 */
function clusterKnoten(roh: unknown): HaKnoten[] {
  if (roh === undefined) return HA_KNOTEN.map(k => ({ ...k }));
  if (!Array.isArray(roh)) throw new Error(`knoten: Liste der Knotennamen (${HA_KNOTEN.map(k => k.name).join(', ')})`);
  const namen = roh.map(e => {
    const n = typeof e === 'string' ? e : e && typeof e === 'object' ? (e as Record<string, unknown>).name : undefined;
    const k = HA_KNOTEN.find(x => typeof n === 'string' && x.name === n.trim().toLowerCase());
    if (!k) throw new Error(`knoten: nur ${HA_KNOTEN.map(x => x.name).join(', ')} (feste IPs ${HA_KNOTEN.map(x => x.ip).join(', ')})`);
    const ip = e && typeof e === 'object' ? (e as Record<string, unknown>).ip : undefined;
    if (ip !== undefined && ip !== k.ip) throw new Error(`knoten: ${k.name} hat die feste IP ${k.ip}`);
    return k.name;
  });
  if (namen.length !== HA_KNOTEN.length || new Set(namen).size !== HA_KNOTEN.length) throw new Error(`knoten: genau die drei Knoten ${HA_KNOTEN.map(k => k.name).join(', ')}`);
  return HA_KNOTEN.map(k => ({ ...k }));
}

const clusterName = (input: Record<string, unknown>) => (input.cluster === undefined ? HA_CLUSTER_NAME : typeof input.cluster === 'string' ? input.cluster.trim() : input.cluster) as string;

function clusterParameter(input: Record<string, unknown>): HaClusterParameter {
  const zahl = (v: unknown, std: number) => (v === undefined ? std : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v) as number;
  const p: HaClusterParameter = {
    cluster: clusterName(input), knoten: clusterKnoten(input.knoten),
    sbd_timeout_s: zahl(input.sbd_timeout_s, HA_SBD_TIMEOUT_S), stonith_timeout_s: zahl(input.stonith_timeout_s, HA_STONITH_WD_TIMEOUT_S),
  };
  const f = pruefeHaCluster(p); if (f) throw new Error(f);
  return p;
}

function clusterEntfernenParameter(input: Record<string, unknown>): HaClusterEntfernenParameter {
  const p: HaClusterEntfernenParameter = { cluster: clusterName(input), knoten: clusterKnoten(input.knoten) };
  const f = pruefeHaClusterEntfernen(p); if (f) throw new Error(f);
  return p;
}

function fencingParameter(input: Record<string, unknown>): HaFencingParameter {
  const art = (typeof input.art === 'string' ? input.art.trim().toLowerCase() : input.art) as HaFencingArt;
  const p: HaFencingParameter = { cluster: clusterName(input), knoten: clusterKnoten(input.knoten), art };
  const f = pruefeHaFencing(p); if (f) throw new Error(f);
  return p;
}

function fencingBelegenParameter(input: Record<string, unknown>): HaFencingBelegenParameter {
  const p: HaFencingBelegenParameter = { cluster: clusterName(input), knoten: clusterKnoten(input.knoten) };
  const f = pruefeHaFencingBelegen(p); if (f) throw new Error(f);
  return p;
}

/**
 * Task 5 — Besetzung der AG: zugang = Primär (zugang_primaer), sekundaer Standard = der andere Datenknoten, konfig Standard sqllnxcfg.
 * Zugangsnamen sind die Knotennamen (jeder Baustein prüft hostname -s und @@SERVERNAME gegen den erwarteten Knoten).
 */
function agBesetzung(zugang: string, input: Record<string, unknown>): HaAgBesetzung {
  const n = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v) as string;
  const primaer = zugang.trim().toLowerCase();
  const konfig = input.konfig === undefined ? HA_AG_KONFIG_KNOTEN : n(input.konfig);
  const sekundaer = input.sekundaer === undefined ? (HA_KNOTEN.map(k => k.name).find(x => x !== primaer && x !== konfig) ?? '') : n(input.sekundaer);
  const b = { primaer, sekundaer, konfig };
  const f = pruefeHaAgBesetzung(b, HA_KNOTEN); if (f) throw new Error(f);
  return b;
}

const agName = (input: Record<string, unknown>) => (input.ag === undefined ? HA_AG_NAME : typeof input.ag === 'string' ? input.ag.trim() : input.ag) as string;

/** Planbare Eingabe von ag_anlegen → Parameter des Abschluss-Bausteins (prüft ag, Besetzung, Datenbanken, VIP) */
function agAnlegenParameter(zugang: string, input: Record<string, unknown>): HaAgAbschlussParameter {
  const besetzung = agBesetzung(zugang, input);
  const v = input.vip === undefined ? HA_AG_VIP : input.vip;
  const m = typeof v === 'string' ? /^\s*(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})\s*$/.exec(v) : null;
  if (!m) throw new Error(`vip: IPv4/Präfix wie ${HA_AG_VIP}`);
  const dbs = Array.isArray(input.datenbanken) ? input.datenbanken.map(d => (typeof d === 'string' ? d.trim() : d)) : input.datenbanken;
  const p: HaAgAbschlussParameter = { ag: agName(input), besetzung, knoten: HA_KNOTEN.map(k => ({ ...k })), datenbanken: dbs as string[], vip: { ip: m[1]!, praefix: Number(m[2]) } };
  const f = pruefeHaAgAbschluss(p); if (f) throw new Error(f);
  return p;
}

function agEntfernenBesetzung(zugang: string, input: Record<string, unknown>): { ag: string; besetzung: HaAgBesetzung } {
  const besetzung = agBesetzung(zugang, input);
  const ag = agName(input);
  const f = pruefeHaAgEntfernen({ ag, besetzung, rolle: 'primaer', knoten: HA_KNOTEN.map(k => ({ ...k })), ressourcen: true }); if (f) throw new Error(f);
  return { ag, besetzung };
}

/** Task 6 — Failover: zugang = bisheriger Primär, ziel = neuer Primär (beides Datenreplikate, verschieden); läuft auf dem Ziel */
function agFailoverParameter(zugang: string, input: Record<string, unknown>): HaAgFailoverParameter {
  const ziel = (typeof input.ziel === 'string' ? input.ziel.trim().toLowerCase() : input.ziel) as string;
  const p: HaAgFailoverParameter = { ag: agName(input), ziel, vorher: zugang.trim().toLowerCase(), knoten: HA_KNOTEN.map(k => ({ ...k })) };
  const f = pruefeHaAgFailover(p); if (f) throw new Error(f);
  return p;
}

/** Fix-Runde 1 (I1): abgeschlossene Läufe und neue Tresor-Einträge eines AG-Laufs — auch für die Fehlermeldung bei Abbruch */
interface AgSpur { laeufe: Array<{ z: string; zustand: string; aenderungen?: string[]; datenbanken?: Array<{ name: string; zustand: string }> }>; tresor: string[] }

/**
 * Fix-Runde 2 (A1): Fehlertexte von ag_anlegen/ag_entfernen dürfen länger sein als die üblichen 800 Zeichen — die Spur aller Knoten
 * (bis zu zehn Läufe mit Änderungslisten) steht vorn und muss vollständig bleiben; gekürzt wird nur der Grund am Ende.
 */
export const AG_FEHLER_MAX = 2400;
const AG_AKTIONEN = new Set(['ag_anlegen', 'ag_entfernen', 'ag_failover']);
/** Fix-Runde 3 (C): Länge des Grunds vorn im Fehlertext — der Change-Motor speichert 500 Zeichen, die Spur folgt dahinter */
export const AG_GRUND_KURZ = 220;
/** so viel speichert der Change-Motor vom Fehler eines Skills (change-motor.ts: String(r.error).slice(0, 500)) */
export const AG_MOTOR_FEHLER = 500;
/** Grund auf höchstens `max` Zeichen: Anfang (was scheiterte) + Ende (dort nennt der Knoten seine eigenen Teiländerungen, „bisher geändert: …“) */
export function grundKurz(g: string, max: number = AG_GRUND_KURZ): string {
  if (g.length <= max) return g;
  const vorn = Math.ceil((max - 3) * 0.55);
  return `${g.slice(0, vorn)} … ${g.slice(-(max - 3 - vorn))}`;
}
/** Fehler eines AG-Laufs mit der vollständigen Spur als Daten (execute gibt sie als `data` zurück) */
export class AgFehler extends Error {
  daten?: { abgebrochen: string; grund: string; laeufe: Array<{ knoten: string; zustand: string; aenderungen: string[] }>; tresorNeu: string[] };
}

/** sa-Tresoreinträge der Zugänge vorhanden — sonst Abbruch vor jedem Fernaufruf */
function saPruefen(namen: Set<string>, zugaenge: string[]): void {
  for (const z of zugaenge) if (!namen.has(saName(z))) throw new Error(`Tresor-Eintrag ${saName(z)} fehlt — linux_sql installieren auf ${z} legt ihn an; nichts geändert`);
}

/** „sqllnx01: a, b; sqllnx02: c“ — nur Läufe mit Änderungen */
const jeKnoten = (liste: Array<{ z: string; aenderungen?: string[] }>) => liste.filter(x => x.aenderungen?.length).map(x => `${x.z}: ${x.aenderungen!.join(', ')}`).join('; ');

// ── Skill ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export class LinuxHaSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'linux_ha',
    category: 'infrastructure',
    description:
      'Hochverfügbarkeit für SQL Server 2025 auf Ubuntu 24.04 (I8e Paket 2: Pacemaker, diskless SBD mit Hardware-Watchdog i6300esb, Verfügbarkeitsgruppe) über feste, geprüfte Bash-Bausteine auf Linux-Fernzugängen (zugang = Name des Fernzugangs, z. B. sqllnx02). '
      + 'status (lesend, auch außerhalb von Changes; ohne Tresor): Watchdog (Kennung, Besitzer), Pakete, HADR, Host-Firewall, hosts-Block, systemd-RuntimeWatchdog, pcsd, Cluster — '
      + `Wortlaut „<zugang>: Watchdog i6300esb frei; Pakete fest; HADR an; Firewall alfred_ha aktiv (1433: Knoten + ${HA_SQL_ZUSATZQUELLEN.join(', ')}); hosts-Block vorhanden; RuntimeWatchdog aus; sbd wartet auf Watchdog; pcsd aktiv; Cluster sqllnxcl01: 3/3 online, Quorum ja, STONITH an, SBD aktiv 3/3, stonith-watchdog-timeout 20s“ (Abweichungen: „Watchdog fehlt …“, „Watchdog FREMD …“, „Watchdog i6300esb BELEGT von …“, „Watchdog i6300esb bei sbd“, „Pakete abweichend: …“, „HADR aus“, „Firewall alfred_ha veraltet (… Soll …)“ (andere 1433-Zusatzquellen geladen), „hosts-Block veraltet (ohne FQDN …)“, „Cluster nicht eingerichtet“, „Quorum nein“ …), als Prüfung z. B. erwartet „Pakete fest“, „Firewall alfred_ha aktiv“ oder „3/3 online, Quorum ja, STONITH an, SBD aktiv 3/3“. `
      + `NUR als Schritt freigegebener Changes: ha_vorbereiten (zugang, rolle daten|konfig, knoten optional — Standard ${HA_KNOTEN.map(k => `${k.name} ${k.ip}`).join(', ')}) — nach linux_sql installieren auf jedem der drei Knoten: `
      + `hosts-Block der drei Knoten („<ip> <name>.ad.3033.at <name>“, FQDN zuerst — hostname -f liefert den FQDN; ein alter Block nur mit Kurznamen wird ersetzt und als „hosts-Block auf FQDN umgestellt“ gemeldet), Pakete fest und gehalten (${HA_PAKETE.map(([s, n]) => `${n} ${HA_VERSIONEN[s]}`).join(', ')}, linux-modules-extra des laufenden Kernels), i6300esb laden, softdog gesperrt, systemd-RuntimeWatchdog aus, `
      + `hacluster-Kennwort aus dem Tresor (${HA_HACLUSTER_TRESOR}, erzeugt Alfred einmalig), HADR an (SQL-Neustart nur bei Änderung), nft-Tabelle inet alfred_ha (alfred-hostfw.service: nur die drei Knoten dürfen TCP 1433, 2224, 3121, 5022, 21064 und UDP 5405, TCP 1433 zusätzlich ${HA_SQL_ZUSATZQUELLEN.join(', ')}, sonst unverändert, SSH bleibt), pcsd läuft, Cluster-Dienste bleiben bis zur Cluster-Einrichtung aus. `
      + 'Bricht VOR jeder Änderung ab, wenn die VM keinen i6300ESB hat (vorher proxmox set_vm_watchdog model i6300esb bzw. provision_vm watchdog i6300esb, dann Kaltstart stop_vm/start_vm), ein Watchdog-Gerät nicht von i6300esb stammt oder ein anderer Prozess als sbd /dev/watchdog offen hält — kein softdog-Ersatz. '
      + 'sbd startet erst, wenn das Watchdog-Gerät da ist (Drop-in sbd.service, Wartezeit 60 s). Ist der Cluster eingerichtet, muss sbd laufen: ein am fehlenden Watchdog-Gerät gescheitertes sbd (failed, letzte Ausführung) holt ha_vorbereiten nur auf diesem Knoten zurück; auf einem Knoten, dessen Cluster absichtlich gestoppt ist, bricht ha_vorbereiten sichtbar ab (nichts still). '
      + `Wiederholbar („nichts zu tun“), prüft sich selbst. Mindest-zeitlimitS: ${Object.entries(LINUX_HA_MIN_ZEITLIMIT_S).map(([a, s]) => `${a} ${s} s`).join(', ')}. `
      + `cluster_anlegen (zugang = EIN Knoten, auf dem es läuft; cluster Standard ${HA_CLUSTER_NAME}; knoten optional, nur ${HA_KNOTEN.map(k => k.name).join(', ')}; sbd_timeout_s Standard ${HA_SBD_TIMEOUT_S}; stonith_timeout_s Standard ${HA_STONITH_WD_TIMEOUT_S}, mindestens 2 × sbd_timeout_s) — nach ha_vorbereiten auf allen drei Knoten: `
      + `pcs-Anmeldung als hacluster (Kennwort aus dem Tresor, nur über die Standardeingabe), pcs cluster setup mit knet über die festen IPs, diskless SBD (Watchdog ${HA_WATCHDOG_DEV}, kein SBD-Device), Cluster auf allen aktiviert und gestartet, stonith-enabled=true, stonith-watchdog-timeout; `
      + 'prüft sich selbst (alle Knoten online, Quorum 3/3, sbd läuft auf allen, have-watchdog=true). Gleicher Cluster schon da → nur Abweichungen beheben; anderer Cluster oder Debian-Standardkonfiguration → Abbruch ohne Änderung. '
      + 'Rückweg von cluster_anlegen ist cluster_entfernen (zugang, cluster): Cluster sauber stoppen, SBD aus, pcs cluster destroy --all — nur ohne Ressourcen. cluster_anlegen braucht immer diesen Rückweg. '
      + `Fencing-Beweis je Knoten (nach cluster_anlegen, vor dem AG-Aufbau; der AG-Aufbau verlangt gültige Belege auf allen drei Knoten): fencing_pruefen (zugang = Testknoten, art trennung|haenger) prüft ohne Änderung (Cluster 3/3 online mit Quorum, STONITH an, keine Ressourcen, sbd hält den i6300esb), schreibt die Test-Datei und löst in ${HA_FENCING_VERZOEGERUNG_S} s aus — trennung: Corosync (UDP 5405) ${HA_FENCING_SPERRE_S} s gesperrt (ohne Persistenz) → SBD setzt den Knoten zurück; haenger (nur ${HA_FENCING_HAENGER_KNOTEN}): Kernel-Absturz (sysrq c) → Hardware-Watchdog; Ergebnis „ausgeloest“ vor dem Reset. `
      + `Rückweg von fencing_pruefen: keiner, nur mit dem Grund „${FENCING_OHNE_RUECKWEG_GRUND}“. Danach ein warten-Schritt (sekunden ca. 45, zeitlimitS ca. 600) mit Prüfung linux_ha.status (zugang = Testknoten) erwartet „3/3 online“, nichtEnthalten „Reset ausstehend“, dann fencing_belegen (zugang): Beleg nur bei neuer boot_id, Test ≤ 30 min, Knoten wieder online, Reset- und Rejoin-Zeit aus btime und Journal; sonst Fehler ohne Beleg; Status zeigt „Fencing belegt (…)“. `
      + `ag_anlegen (zugang = Primär/zugang_primaer, z. B. sqllnx01; ag Standard ${HA_AG_NAME}; sekundaer Standard der andere Datenknoten; konfig Standard ${HA_AG_KONFIG_KNOTEN}; datenbanken Pflicht — vorhanden, ONLINE, Wiederherstellungsmodell FULL, mindestens eine FULL-Sicherung, sonst Abbruch ohne Änderung; vip Standard ${HA_AG_VIP}) — Verfügbarkeitsgruppe nach dem Fencing-Beweis: `
      + 'liest zuerst linux_ha.status auf allen drei Knoten und bricht VOR jeder SQL-Zeile ab, wenn nicht jeder einen gültigen Fencing-Beleg hat (Cluster 3/3 online mit Quorum); '
      + `dann je Knoten Master-Key (Tresor sqllnx-<zugang>-masterkey), eigenes Endpunkt-Zertifikat, Endpunkt TCP 5022, Pacemaker-Login (Tresor ${HA_PACEMAKER_TRESOR}) und /var/opt/mssql/secrets/passwd (0600 root); nur öffentliche Zertifikate wandern zwischen den Knoten; `
      + 'CREATE AVAILABILITY GROUP mit CLUSTER_TYPE = EXTERNAL, REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT = 0, AUTOMATED_BACKUP_PREFERENCE = PRIMARY (Datenreplikate SYNCHRONOUS_COMMIT, Seeding AUTOMATIC, Konfig CONFIGURATION_ONLY), Beitritt + GRANT CREATE ANY DATABASE (Sekundär: eine zurückgebliebene RESTORING-Kopie einer AG-Datenbank ohne AG wird vor dem Beitritt entfernt (alte-kopie-entfernt-<db>), erst nachdem der Primär im selben Lauf die Datenbank ONLINE, FULL, mit Log-Kette gezeigt hat; jeder andere Zustand bricht ohne Änderung ab), Datenbanken aufnehmen, '
      + `Pacemaker-Ressource ${HA_AG_RESSOURCE} (ocf:mssql:ag, required_synchronized_secondaries_to_commit=0, promotable) und ${HA_AG_VIP_RESSOURCE} (IPaddr2) mit Kolokation Promoted und Reihenfolge promote → start; prüft sich selbst (Primär, Sekundär SYNCHRONIZED, required_sync 0 in SQL und Ressource, VIP auf dem Primär). `
      + 'Rückweg von ag_anlegen ist immer ag_entfernen (zugang = aktueller Primär, ag): Ressourcen, AG, Endpunkte, Endpunkt-Zertifikate, Pacemaker-Login und Zugangsdatei weg; Datenbanken bleiben (Primär ONLINE, Sekundär RESTORING — ein späteres ag_anlegen entfernt die Sekundär-Kopie sichtbar und seedet neu), Master-Keys bleiben. '
      + 'Der DNS-Name der AG (windows_ad dns_eintrag, z. B. sqllnxag01 → 10.203.30.13) ist ein eigener Schritt. fencing_pruefen weist einen Cluster mit Ressourcen (AG) ab. '
      + `ag_failover (zugang = bisheriger Primär, ziel = neuer Primär, beides Datenreplikate; ag Standard ${HA_AG_NAME}) — geplantes Failover: liest linux_ha.status auf allen drei Knoten (3/3 online, Quorum, STONITH, keine Corosync-Sperre, kein ausstehender Reset), `
      + `dann auf dem Ziel: Abbruch ohne Änderung, wenn das Ziel nicht SYNCHRONIZED/CONNECTED ist, REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT in SQL oder required_synchronized_secondaries_to_commit an ${HA_AG_RESSOURCE} nicht 0 ist, eine fremde Standort-Bedingung besteht oder Promoted nicht auf zugang liegt; `
      + `sonst pcs resource move ${HA_AG_KLON} <ziel> --promoted, warten bis Primär = Ziel, immer pcs resource clear (auch bei Zeitüberschreitung — eine verbliebene Standort-Bedingung steht im Fehler), VIP und Gegenstelle SECONDARY/synchron abwarten, Selbstprüfung; `
      + 'Ergebnis Dauer (s), neuer Primär, VIP-Ort. Ziel schon Primär → nichts zu tun (eine liegengebliebene cli-prefer wird sichtbar freigegeben). Rückweg ist immer ag_failover zurück (zugang und ziel vertauscht). '
      + 'Status zeigt dazu „AG <name>: Promoted …, VIP …, required_sync Ressource 0 / SQL 0, Replikate … SYNCHRONIZED …, Standort-Bedingungen 0“ (offen: „Standort-Bedingungen OFFEN: …“ — Prüfung nichtEnthalten „OFFEN“). '
      + 'Sonst ohne Rückweg nur beim Neuaufbau (derselbe Change stellt die VM vorher mit proxmox.provision_vm bereit) oder mit ohneSicherungGrund — sonst vorher sichern und rueckweg angeben.',
    riskLevel: 'admin',
    version: '1.0.0',
    timeoutMs: 3_600_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...LINUX_HA_LESEND, ...LINUX_HA_NUR_IM_CHANGE] },
        zugang: { type: 'string', description: 'Name des Linux-Fernzugangs (z. B. sqllnx02)' },
        rolle: { type: 'string', enum: ['daten', 'konfig'], description: 'ha_vorbereiten: daten (Datenreplikat) oder konfig (CONFIGURATION_ONLY, sqllnxcfg)' },
        knoten: { type: 'array', description: 'ha_vorbereiten: genau drei Knoten {name, ip} (Standard sqllnx01/02/cfg); cluster_anlegen/cluster_entfernen: Knotennamen (nur sqllnx01, sqllnx02, sqllnxcfg — feste IPs)' },
        cluster: { type: 'string', description: `cluster_anlegen/cluster_entfernen: Clustername (Standard ${HA_CLUSTER_NAME})` },
        sbd_timeout_s: { type: 'number', description: `cluster_anlegen: SBD_WATCHDOG_TIMEOUT in s (Standard ${HA_SBD_TIMEOUT_S})` },
        stonith_timeout_s: { type: 'number', description: `cluster_anlegen: stonith-watchdog-timeout in s (Standard ${HA_STONITH_WD_TIMEOUT_S}, mindestens 2 × sbd_timeout_s)` },
        art: { type: 'string', enum: [...HA_FENCING_ARTEN], description: `fencing_pruefen: trennung (Corosync ${HA_FENCING_SPERRE_S} s sperren) oder haenger (Kernel-Absturz, nur ${HA_FENCING_HAENGER_KNOTEN})` },
        ag: { type: 'string', description: `ag_anlegen/ag_entfernen/ag_failover: Name der Verfügbarkeitsgruppe (Standard ${HA_AG_NAME})` },
        sekundaer: { type: 'string', description: 'ag_anlegen/ag_entfernen: Zugang des zweiten Datenreplikats (Standard der andere Datenknoten)' },
        konfig: { type: 'string', description: `ag_anlegen/ag_entfernen: Zugang des CONFIGURATION_ONLY-Replikats (nur ${HA_AG_KONFIG_KNOTEN})` },
        datenbanken: { type: 'array', description: 'ag_anlegen: Datenbanken der AG (auf dem Primär vorhanden, FULL, mit FULL-Sicherung)' },
        vip: { type: 'string', description: `ag_anlegen: virtuelle IP mit Präfix (Standard ${HA_AG_VIP})` },
        ziel: { type: 'string', description: 'ag_failover: neuer Primär (Datenreplikat; zugang = bisheriger Primär)' },
      },
      required: ['action', 'zugang'],
    },
  };

  constructor(private readonly d: LinuxHaDeps) { super(); }

  mindestZeitlimitS(aktion: string): number | undefined { return LINUX_HA_MIN_ZEITLIMIT_S[aktion]; }

  /** Planprüfung (rein, ohne Tresor und Fernaufruf); Verweise {{…}} bleiben bis zur Laufzeit ungeprüft */
  pruefeEingabe(input: Record<string, unknown>): string | undefined {
    const action = String(input.action ?? '');
    if (!istVerweis(input.zugang) && !ZUGANG.test(String(input.zugang ?? '').trim())) return 'zugang: Name des Linux-Fernzugangs';
    if (Object.values(input).some(istVerweis)) return undefined;
    try {
      if (action === 'ha_vorbereiten') vorbereitenParameter(input);
      if (action === 'cluster_anlegen') clusterParameter(input);
      if (action === 'cluster_entfernen') clusterEntfernenParameter(input);
      if (action === 'fencing_pruefen') fencingParameter(input);
      if (action === 'fencing_belegen') fencingBelegenParameter(input);
      if (action === 'ag_anlegen') agAnlegenParameter(String(input.zugang), input);
      if (action === 'ag_entfernen') agEntfernenBesetzung(String(input.zugang), input);
      if (action === 'ag_failover') agFailoverParameter(String(input.zugang), input);
    } catch (err) { return (err as Error).message.slice(0, 200); }
    return undefined;
  }

  async execute(input: Record<string, unknown>, context?: SkillContext): Promise<SkillResult> {
    const action = String(input.action ?? '');
    const zugang = String(input.zugang ?? '').trim();
    if (!LINUX_HA_LESEND.has(action) && !LINUX_HA_NUR_IM_CHANGE.has(action)) return { success: false, error: `Unbekannte Aktion ${action}` };
    if (LINUX_HA_NUR_IM_CHANGE.has(action) && (context as { ausChange?: boolean } | undefined)?.ausChange !== true) return { success: false, error: `${action} läuft nur als Schritt eines freigegebenen Changes` };
    if (!ZUGANG.test(zugang)) return { success: false, error: 'zugang: Name des Linux-Fernzugangs' };
    const geheim: string[] = [];
    try {
      switch (action) {
        case 'status': { const s = await this.lauf<LinuxHaStatus & Record<string, unknown>>(zugang, LINUX_HA_BAUSTEINE.status, {}, 'HA-Status', LINUX_HA_ZEIT_MS.status); return { success: true, data: s, display: linuxHaStatusText(zugang, s) }; }
        case 'ha_vorbereiten': return await this.vorbereiten(zugang, input, geheim);
        case 'cluster_anlegen': return await this.clusterAnlegen(zugang, input, geheim);
        case 'cluster_entfernen': return await this.clusterEntfernen(zugang, input, geheim);
        case 'fencing_pruefen': return await this.fencingPruefen(zugang, input, geheim);
        case 'fencing_belegen': return await this.fencingBelegen(zugang, input);
        case 'ag_anlegen': return await this.agAnlegen(zugang, input, geheim);
        case 'ag_entfernen': return await this.agEntfernen(zugang, input, geheim);
        case 'ag_failover': return await this.agFailover(zugang, input, geheim);
      }
    } catch (err) {
      const daten = err instanceof AgFehler ? err.daten : undefined;
      return { success: false, error: schwaerze((err as Error).message, geheim).slice(0, AG_AKTIONEN.has(action) ? AG_FEHLER_MAX : 800), ...(daten ? { data: daten } : {}) };
    }
    return { success: false, error: 'Unbekannte Aktion' };
  }

  private async lauf<T extends Record<string, unknown>>(zugang: string, baustein: string, parameter: unknown, zweck: string, timeoutMs: number, eingabe?: Record<string, string>): Promise<T> {
    return this.pruefeLauf<T>(zugang, zweck, await this.d.skript(zugang, baustein, parameter, eingabe ? JSON.stringify(eingabe) : undefined, timeoutMs, zweck));
  }

  private pruefeLauf<T extends Record<string, unknown>>(zugang: string, zweck: string, r: { code: number; stdout: string; stderr: string }): T {
    const e = haErgebnis<T>(r.stdout);
    if (r.code !== 0 || !e || e.zustand === 'fehler') {
      const grund = e && typeof e.fehler === 'string' ? e.fehler : `${r.stderr}\n${r.stdout}`.replace(/\s+/g, ' ').trim().slice(-500);
      throw new Error(`${zweck} auf ${zugang} gescheitert (Exit ${r.code}): ${grund || 'keine Ausgabe'}`);
    }
    return e;
  }

  /**
   * Ruling R8 — ein ÄNDERNDER Baustein-Lauf ohne lesbare Ergebniszeile (Zeitgrenze am Host, SIGKILL, Verbindung weg, Exit ≠ 0 ohne Zeile)
   * belegt nicht, dass nichts geändert wurde: fail-closed „möglicherweise geändert: kein Ergebnis …“ (mitSpur hängt dann Daten an →
   * Schritt teilweise → Rückweg). Lesende Läufe (Status, Gate) nutzen weiter pruefeLauf/lauf („nichts geändert“).
   */
  private pruefeAendernd<T extends Record<string, unknown>>(zugang: string, zweck: string, roh: { code: number; stdout: string; stderr: string }, hinweis: string): T {
    try { return this.pruefeLauf<T>(zugang, zweck, roh); } catch (err) {
      const e = haErgebnis<{ fehler?: unknown }>(roh.stdout);
      if (!e) throw new Error(`${(err as Error).message} — möglicherweise geändert: kein Ergebnis ${hinweis}; Lage mit linux_ha.status prüfen`);
      // Final-Review I-1: die Ersatzzeile des EXIT-Traps (set -e/-u, Signal) kennt den Stand nicht — ebenso fail-closed
      const f = typeof e.fehler === 'string' ? e.fehler : '';
      if (f.startsWith('unerwarteter Abbruch (Exit') && !/bisher geändert: |möglicherweise/.test(f)) throw new Error(`${(err as Error).message} — möglicherweise geändert: unerwartetes Ende ${hinweis}; Lage mit linux_ha.status prüfen`);
      throw err;
    }
  }

  /**
   * Final-Review I-1 (wie R8 bei der AG): ein ändernder Einzel-Lauf (ha_vorbereiten, cluster_anlegen, cluster_entfernen, fencing_pruefen),
   * der nach Änderungen abbricht („bisher geändert: …“ aus der Hülle um abbruch) oder ohne Ergebnis endet („möglicherweise geändert“),
   * gibt seine Spur als Daten zurück (mitSpur → AgFehler) — der Change-Motor setzt den Schritt dann auf teilweise, er gehört in den Rückweg.
   */
  private async mitAenderungsSpur(was: string, zugang: string, geheim: string[], lauf: (spur: AgSpur) => Promise<SkillResult>): Promise<SkillResult> {
    const spur: AgSpur = { laeufe: [], tresor: [] };
    try { return await lauf(spur); } catch (err) { throw this.mitSpur(was, zugang, err, spur, geheim); }
  }

  private async laufAendernd<T extends Record<string, unknown>>(zugang: string, baustein: string, parameter: unknown, zweck: string, timeoutMs: number, eingabe: Record<string, string>, hinweis: string): Promise<T> {
    return this.pruefeAendernd<T>(zugang, zweck, await this.d.skript(zugang, baustein, parameter, JSON.stringify(eingabe), timeoutMs, zweck), hinweis);
  }

  private tresor() { if (!this.d.tresor) throw new Error('Tresor nicht verfügbar'); return this.d.tresor; }

  private async vorbereiten(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    return this.mitAenderungsSpur('HA-Grundlage vorbereiten', zugang, geheim, spur => this.vorbereitenLauf(zugang, input, geheim, spur));
  }

  private async vorbereitenLauf(zugang: string, input: Record<string, unknown>, geheim: string[], spur: AgSpur): Promise<SkillResult> {
    const p = vorbereitenParameter(input);
    const t = this.tresor();
    const neu = !(await t.namen()).has(HA_HACLUSTER_TRESOR);
    const kw = neu ? linuxSqlKennwort() : await t.lies(HA_HACLUSTER_TRESOR, `HA-Grundlage ${zugang}`);
    geheim.push(kw);
    const roh = await this.d.skript(zugang, LINUX_HA_BAUSTEINE.vorbereiten, p, JSON.stringify({ hacluster: kw }), LINUX_HA_ZEIT_MS.vorbereiten, 'HA-Grundlage vorbereiten');
    // ein neu erzeugtes Kennwort kommt in den Tresor, sobald es auf dem Knoten gesetzt ist (Marke) oder der Lauf gelang — auch wenn ein
    // späterer Schritt scheitert; scheitert der Lauf davor, erzeugt der nächste Lauf ein neues (hacluster hat dann noch kein bekanntes Kennwort)
    const gesetzt = roh.stdout.split(/\r?\n/).some(z => z.trim() === 'ALFRED-HACLUSTER-GESETZT');
    const ok = roh.code === 0 && !!haErgebnis(roh.stdout) && haErgebnis<{ zustand?: string }>(roh.stdout)?.zustand !== 'fehler';
    if (neu && (ok || gesetzt)) {
      await t.setze(HA_HACLUSTER_TRESOR, kw, 'Kennwort des Pacemaker-Benutzers hacluster (sqllnx01, sqllnx02, sqllnxcfg)');
      spur.tresor.push(HA_HACLUSTER_TRESOR);
    }
    const r = this.pruefeAendernd<{ zustand: string; knoten?: string; watchdog?: string; pakete?: Record<string, string>; sql1433?: string[]; neustartSql?: boolean; aenderungen?: string[] }>(zugang, 'HA-Grundlage vorbereiten', roh,
      'des Vorbereiten-Bausteins (Pakete, Watchdog, Firewall, hacluster-Kennwort, HADR mit SQL-Neustart, pcsd können geändert sein)');
    this.d.protokoll?.('I8e HA-Grundlage', { zugang, zustand: r.zustand, rolle: p.rolle, aenderungen: r.aenderungen, kennwortNeu: neu });
    const text = `HA-Grundlage auf ${zugang} (${p.rolle}): Watchdog ${r.watchdog ?? '?'}, Pakete fest (${Object.entries(r.pakete ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}), HADR an, Firewall alfred_ha aktiv (1433 nur ${(r.sql1433 ?? []).join(', ')}), pcsd aktiv; hacluster-Kennwort im Tresor (${HA_HACLUSTER_TRESOR})`;
    if (r.zustand === 'schon') return { success: true, data: r, display: `${text} — nichts zu tun` };
    // Ruling R10: alter Block (nur Kurznamen) durch die FQDN-Form ersetzt — eigens gemeldet
    const fqdn = (r.aenderungen ?? []).some(a => a.startsWith('hosts-fqdn:')) ? '; hosts-Block auf FQDN umgestellt' : '';
    return { success: true, data: r, display: `✅ ${text}${fqdn}${r.neustartSql ? '; SQL Server neu gestartet (HADR)' : ''} — geändert: ${(r.aenderungen ?? []).join(', ')}` };
  }

  /** hacluster-Kennwort aus dem Tresor — legt ha_vorbereiten an; fehlt es, ist die HA-Grundlage nicht gelegt */
  private async hacluster(zugang: string, zweck: string, geheim: string[]): Promise<string> {
    const t = this.tresor();
    if (!(await t.namen()).has(HA_HACLUSTER_TRESOR)) throw new Error(`hacluster-Kennwort fehlt im Tresor (${HA_HACLUSTER_TRESOR}) — vorher ha_vorbereiten auf allen drei Knoten`);
    const kw = await t.lies(HA_HACLUSTER_TRESOR, `${zweck} ${zugang}`);
    geheim.push(kw);
    return kw;
  }

  private async clusterAnlegen(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    return this.mitAenderungsSpur('Cluster anlegen', zugang, geheim, () => this.clusterAnlegenLauf(zugang, input, geheim));
  }

  private async clusterAnlegenLauf(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const p = clusterParameter(input);
    const kw = await this.hacluster(zugang, 'Cluster anlegen', geheim);
    const r = await this.laufAendernd<{ zustand: string; cluster?: string; knoten?: string[]; online?: number; quorum?: string; sbd?: string; aenderungen?: string[] }>(
      zugang, LINUX_HA_BAUSTEINE.cluster, p, 'Cluster anlegen', LINUX_HA_ZEIT_MS.cluster, { hacluster: kw }, 'des Cluster-Bausteins (pcs cluster setup, SBD, Aktivieren und Start können gelaufen sein)');
    this.d.protokoll?.('I8e Cluster', { zugang, cluster: p.cluster, zustand: r.zustand, aenderungen: r.aenderungen });
    const text = `Cluster ${p.cluster} (${(r.knoten ?? p.knoten.map(k => k.name)).join(', ')}, ausgeführt auf ${zugang}): ${r.online ?? '?'}/${p.knoten.length} online, Quorum ${r.quorum ?? '?'}, STONITH an, `
      + `SBD diskless (Watchdog ${HA_WATCHDOG_DEV}, SBD_WATCHDOG_TIMEOUT ${p.sbd_timeout_s} s) aktiv ${r.sbd ?? '?'}, stonith-watchdog-timeout ${p.stonith_timeout_s} s, have-watchdog true`;
    if (r.zustand === 'schon') return { success: true, data: r, display: `${text} — nichts zu tun` };
    return { success: true, data: r, display: `✅ ${text} — geändert: ${(r.aenderungen ?? []).join(', ')}` };
  }

  private async clusterEntfernen(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    return this.mitAenderungsSpur('Cluster entfernen', zugang, geheim, () => this.clusterEntfernenLauf(zugang, input, geheim));
  }

  private async clusterEntfernenLauf(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const p = clusterEntfernenParameter(input);
    const kw = await this.hacluster(zugang, 'Cluster entfernen', geheim);
    const r = await this.laufAendernd<{ zustand: string; aenderungen?: string[] }>(zugang, LINUX_HA_BAUSTEINE.clusterEntfernen, p, 'Cluster entfernen', LINUX_HA_ZEIT_MS.clusterEntfernen, { hacluster: kw },
      'des Entfernen-Bausteins (Cluster kann gestoppt, SBD aus oder der Cluster entfernt sein)');
    this.d.protokoll?.('I8e Cluster entfernt', { zugang, cluster: p.cluster, zustand: r.zustand, aenderungen: r.aenderungen });
    const text = `Cluster ${p.cluster} auf ${p.knoten.map(k => k.name).join(', ')} entfernt (SBD aus, Cluster-Dienste aus, keine corosync.conf von ${p.cluster} mehr)`;
    if (r.zustand === 'schon') return { success: true, data: r, display: `${text} — nichts zu tun` };
    return { success: true, data: r, display: `✅ ${text} — geändert: ${(r.aenderungen ?? []).join(', ')}` };
  }

  /** Fencing-Beweis Teil 1: hacluster-Kennwort nur für die pcs-Anmeldung (pcs stonith sbd status über alle Knoten) */
  private async fencingPruefen(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    return this.mitAenderungsSpur('Fencing-Test', zugang, geheim, () => this.fencingPruefenLauf(zugang, input, geheim));
  }

  private async fencingPruefenLauf(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const p = fencingParameter(input);
    const kw = await this.hacluster(zugang, 'Fencing-Test', geheim);
    const r = await this.laufAendernd<{ zustand: string; art?: string; knoten?: string; bootIdVorher?: string; hinweis?: string; beleg?: FencingBeleg; aenderungen?: string[] }>(
      zugang, LINUX_HA_BAUSTEINE.fencingPruefen, p, `Fencing-Test ${p.art}`, LINUX_HA_ZEIT_MS.fencingPruefen, { hacluster: kw },
      'des Fencing-Tests (Test-Datei, Aufheben- und Auslöse-Timer können geplant sein — Reset möglich)');
    this.d.protokoll?.('I8e Fencing-Test', { zugang, art: p.art, zustand: r.zustand, bootIdVorher: r.bootIdVorher, aenderungen: r.aenderungen });
    if (r.zustand === 'schon') {
      const was = r.hinweis ?? (r.beleg ? `gültiger Beleg vom ${zeitText(r.beleg.zeit)} (Reset ${r.beleg.resetS} s, Rejoin ${r.beleg.rejoinS} s)` : 'schon erledigt');
      return { success: true, data: r, display: `Fencing-Test ${p.art} auf ${zugang}: ${was} — nichts zu tun` };
    }
    const wie = p.art === 'trennung' ? `Corosync (UDP 5405) ab +${HA_FENCING_VERZOEGERUNG_S} s für ${HA_FENCING_SPERRE_S} s gesperrt` : `Kernel-Absturz (sysrq c) in ${HA_FENCING_VERZOEGERUNG_S} s`;
    return { success: true, data: r, display: `Fencing-Test ${p.art} auf ${zugang} (${r.knoten ?? '?'}) ausgelöst: ${wie}; boot_id vorher ${r.bootIdVorher ?? '?'} — Reset durch ${p.art === 'trennung' ? 'SBD' : 'den Hardware-Watchdog'} erwartet, danach fencing_belegen — geändert: ${(r.aenderungen ?? []).join(', ')}` };
  }

  /** Fencing-Beweis Teil 2: Beleg nach dem Reset (kein Geheimnis nötig) */
  private async fencingBelegen(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const p = fencingBelegenParameter(input);
    const r = await this.lauf<{ zustand: string; knoten?: string; beleg?: FencingBeleg; aenderungen?: string[] }>(zugang, LINUX_HA_BAUSTEINE.fencingBelegen, p, 'Fencing-Beleg', LINUX_HA_ZEIT_MS.fencingBelegen);
    // Form des Belegs (Art, Messwerte, Reset, Cluster) — die Identität hat der Baustein gegen corosync.conf/authkey selbst geprüft
    const b = r.beleg;
    const form = fencingBelegGueltig(b, { identitaet: b ? { cluster: b.cluster, knoten: b.knoten, nodeid: b.nodeid, konfHash: b.konfHash } : null }, p.cluster);
    if (!b || form) throw new Error(`Fencing-Beleg auf ${zugang}: Ergebnis ohne gültigen Beleg (${form ?? 'fehlt'})`);
    this.d.protokoll?.('I8e Fencing-Beleg', { zugang, zustand: r.zustand, art: b.art, resetS: b.resetS, rejoinS: b.rejoinS, bootIdVorher: b.bootIdVorher, bootId: b.bootId });
    const text = `Fencing auf ${zugang} (${b.knoten ?? '?'}) belegt (${b.art}, ${zeitText(b.zeit)}): Reset ${b.resetS} s nach der Auslösung, Rejoin ${b.rejoinS} s nach dem Start (Quorum); boot_id ${b.bootIdVorher} → ${b.bootId}`;
    if (r.zustand === 'schon') return { success: true, data: r, display: `${text} — nichts zu tun` };
    return { success: true, data: r, display: `✅ ${text} — geändert: ${(r.aenderungen ?? []).join(', ')}` };
  }

  /**
   * Fix-Runde 1 (I1): bricht ein AG-Lauf auf Knoten n ab, nennt der Fehler zusätzlich alles, was die abgeschlossenen Läufe davor geändert
   * haben (je Knoten) und neue Tresor-Einträge — der Lauf auf Knoten n nennt seine eigenen Änderungen selbst. Auch protokolliert.
   * Fix-Runde 3 (C): der Change-Motor speichert vom Fehler nur 500 Zeichen (change-motor.ts, Skill-Fehler → fehler) — darum steht der
   * Grund kurz (≤ AG_GRUND_KURZ, Anfang + Ende, wo der Knoten seine eigenen Teiländerungen nennt) VORN, danach die Spur, soweit sie passt.
   * Die vollständige Spur geht strukturiert als `daten` mit (AgFehler): der Motor legt Daten eines gescheiterten Skills als `daten` mit
   * `teilweise: true` am Schritt ab — genau dann, wenn etwas geändert wurde (dann gehört der Schritt auch in den Rückweg ag_entfernen).
   */
  private mitSpur(was: string, zugang: string, err: unknown, spur: AgSpur, geheim: string[]): Error {
    const grund = schwaerze((err as Error).message, geheim);
    const bisher = jeKnoten(spur.laeufe);
    const laeufe = spur.laeufe.map(l => ({ knoten: l.z, zustand: l.zustand, aenderungen: l.aenderungen ?? [] }));
    this.d.protokoll?.(`I8e ${was} abgebrochen`, { zugang, fehler: grund.slice(0, 500), laeufe, tresorNeu: spur.tresor });
    // geändert = ein abgeschlossener Lauf mit Änderungen, ein neuer Tresor-Eintrag oder der abbrechende Knoten meldet eigene Teiländerungen
    const geaendert = laeufe.some(l => l.aenderungen.length) || spur.tresor.length > 0 || /bisher geändert: |am ersten Fehler beendet|möglicherweise geändert/.test(grund);
    const spurText = ` — vorherige Läufe bisher geändert: ${bisher || 'nichts'}${spur.tresor.length ? `; neu im Tresor: ${spur.tresor.join(', ')}` : ''}`;
    const kopf = `${was} abgebrochen — Grund: `;
    // ohne Änderung gibt es keine Spur zu verlieren → Grund ganz; sonst so viel Grund, wie neben der Spur in die 500 Zeichen passt (mind. AG_GRUND_KURZ)
    const budget = geaendert ? Math.max(AG_GRUND_KURZ, AG_MOTOR_FEHLER - kopf.length - spurText.length) : Number.POSITIVE_INFINITY;
    const f = new AgFehler(`${kopf}${grundKurz(grund, budget)}${spurText}`);
    if (geaendert) f.daten = { abgebrochen: was, grund: grund.slice(0, 1500), laeufe, tresorNeu: [...spur.tresor] };
    return f;
  }

  /** sa-Kennwörter der drei Zugänge (Paket 1, linux_sql installieren) — fehlt eines, kein Fernaufruf */
  private async saKennwoerter(zugaenge: string[], zweck: string, geheim: string[]): Promise<Record<string, string>> {
    const t = this.tresor();
    saPruefen(await t.namen(), zugaenge);
    const sa: Record<string, string> = {};
    for (const z of zugaenge) { sa[z] = await t.lies(saName(z), `${zweck} ${z}`); geheim.push(sa[z]!); }
    return sa;
  }

  /**
   * Task 5 — Verfügbarkeitsgruppe über die drei Zugänge: (0) Fencing-Gate über linux_ha.status VOR jeder SQL-Zeile, (1) Endpunkt je
   * Knoten, (2) Replikat je Knoten (Primär, Sekundär, Konfig) mit genau den öffentlichen Zertifikaten der beiden anderen, (3) Abschluss auf
   * dem Primär. Neue Kennwörter (Pacemaker-Login, Master-Key je Knoten) kommen in den Tresor, sobald der Knoten sie gesetzt meldet.
   */
  private async agAnlegen(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const spur: AgSpur = { laeufe: [], tresor: [] };
    try { return await this.agAnlegenLauf(zugang, input, geheim, spur); } catch (err) { throw this.mitSpur('Verfügbarkeitsgruppe anlegen', zugang, err, spur, geheim); }
  }

  private async agAnlegenLauf(zugang: string, input: Record<string, unknown>, geheim: string[], spur: AgSpur): Promise<SkillResult> {
    const ab = agAnlegenParameter(zugang, input);
    const b = ab.besetzung;
    const zugaenge = HA_AG_ROLLEN.map(r => b[r]);
    const t = this.tresor();
    const namen = await t.namen();
    // sa-Einträge vorab (ohne Lesen) — fehlt einer, gar kein Fernaufruf
    saPruefen(namen, zugaenge);
    // ── 0: Fencing-Gate (nur lesend, ohne Geheimnis) — erst wenn alle drei Knoten belegt sind, läuft irgendeine SQL-Zeile ──
    const maengel: string[] = [];
    for (const z of zugaenge) {
      const s = await this.lauf<LinuxHaStatus & Record<string, unknown>>(z, LINUX_HA_BAUSTEINE.status, {}, 'HA-Status vor dem AG-Aufbau', LINUX_HA_ZEIT_MS.status);
      const f = s.fencing;
      const k = f?.identitaet?.knoten;
      if (k && k !== z) { maengel.push(`${z}: Zugang zeigt auf Knoten ${k}`); continue; }
      const g = fencingBelegGueltig(f?.beleg, f, HA_CLUSTER_NAME);
      if (g) { maengel.push(`${z}: ${g}`); continue; }
      const c = s.cluster;
      const alle = HA_KNOTEN.map(x => x.name);
      if (!c || c.art !== 'eingerichtet' || c.name !== HA_CLUSTER_NAME || !c.crm || alle.some(n => !c.crm!.online.includes(n)) || !c.crm.quorum || !c.crm.stonith) maengel.push(`${z}: ${clusterText(c)}`);
    }
    if (maengel.length) throw new Error(`Verfügbarkeitsgruppe ${ab.ag} nicht angelegt — Fencing nicht auf allen drei Knoten belegt bzw. Cluster nicht bereit: ${maengel.join('; ')} — vorher fencing_pruefen/fencing_belegen je Knoten; keine SQL-Zeile ausgeführt, nichts geändert`);
    // ── Kennwörter: sa je Knoten, Pacemaker-Login (einmal für alle), Master-Key je Knoten — neue erst nach dem Setzen in den Tresor ──
    const sa = await this.saKennwoerter(zugaenge, 'AG-Aufbau', geheim);
    let pmNeu = !namen.has(HA_PACEMAKER_TRESOR);
    const pm = pmNeu ? linuxSqlKennwort() : await t.lies(HA_PACEMAKER_TRESOR, `AG-Aufbau ${ab.ag}`);
    geheim.push(pm);
    const mk: Record<string, { wert: string; neu: boolean }> = {};
    for (const z of zugaenge) {
      const neu = !namen.has(haMasterkeyTresor(z));
      mk[z] = { neu, wert: neu ? linuxSqlKennwort() : await t.lies(haMasterkeyTresor(z), `AG-Aufbau ${z}`) };
      geheim.push(mk[z]!.wert);
    }
    const knoten = () => HA_KNOTEN.map(k => ({ ...k }));
    const laeufe = spur.laeufe;
    // ── 1: Endpunkt je Knoten ──
    const ep: Record<string, { zertifikat: string; fingerabdruck: string }> = {};
    for (const rolle of HA_AG_ROLLEN) {
      const z = b[rolle];
      const p: HaAgEndpunktParameter = { cluster: HA_CLUSTER_NAME, ag: ab.ag, besetzung: { ...b }, rolle, knoten: knoten() };
      const roh = await this.d.skript(z, LINUX_HA_BAUSTEINE.agEndpunkt, p, JSON.stringify({ sa: sa[z], hauptschluessel: mk[z]!.wert, pacemaker: pm }), LINUX_HA_ZEIT_MS.agEndpunkt, `AG-Endpunkt ${z}`);
      // wie ha_vorbereiten: ein neues Kennwort kommt in den Tresor, sobald der Knoten es gesetzt meldet (Marke) oder der Lauf gelang
      // (ein bestehender Master-Key/Login mit anderem Kennwort bricht im Baustein vor jeder Änderung ab)
      const marken = new Set(roh.stdout.split(/\r?\n/).map(x => x.trim()));
      const zustand = haErgebnis<{ zustand?: string }>(roh.stdout)?.zustand;
      // R8: ohne Ergebniszeile kann das Kennwort gesetzt sein (Abbruch zwischen Anlage und Marke) — dann ebenfalls in den Tresor; ist es
      // nicht gesetzt, legt der nächste Lauf das Objekt mit genau diesem Kennwort an (kein Schaden), sonst passte es ohnehin
      const ok = (roh.code === 0 && zustand !== undefined && zustand !== 'fehler') || zustand === undefined;
      if (mk[z]!.neu && (ok || marken.has('ALFRED-MASTERKEY-GESETZT'))) { await t.setze(haMasterkeyTresor(z), mk[z]!.wert, `Master-Key-Kennwort (master) von SQL Server auf ${z} (Verfügbarkeitsgruppe ${ab.ag})`); mk[z]!.neu = false; spur.tresor.push(haMasterkeyTresor(z)); }
      if (pmNeu && (ok || marken.has('ALFRED-PACEMAKER-GESETZT'))) { await t.setze(HA_PACEMAKER_TRESOR, pm, `Kennwort des SQL-Logins alfred_pacemaker (Pacemaker-Resource-Agent, ${zugaenge.join(', ')})`); pmNeu = false; spur.tresor.push(HA_PACEMAKER_TRESOR); }
      const r = this.pruefeAendernd<{ zustand: string; zertifikat?: unknown; fingerabdruck?: unknown; aenderungen?: string[] }>(z, `AG-Endpunkt ${z}`, roh, "des Endpunkt-Bausteins (Master-Key, Login, Zertifikat, Endpunkt, Zugangsdatei können angelegt sein)");
      // Fix-Runde 2 (A2): der Lauf hat geändert, auch wenn sein Zertifikat danach abgewiesen wird — erst in die Spur, dann prüfen
      laeufe.push({ z, zustand: r.zustand, aenderungen: r.aenderungen });
      // nur ein öffentliches Zertifikat wird weitergegeben — alles andere bricht vor dem Austausch ab
      if (!istOeffentlichesZertifikat(r.zertifikat) || typeof r.fingerabdruck !== 'string' || !/^[0-9A-F]{40,64}$/.test(r.fingerabdruck)) {
        throw new Error(`${z} lieferte kein öffentliches Endpunkt-Zertifikat (ein DER-Zertifikat als Hex mit Fingerabdruck) — nichts weitergegeben; Rückweg ag_entfernen`);
      }
      ep[z] = { zertifikat: r.zertifikat as string, fingerabdruck: r.fingerabdruck };
    }
    // ── 2: Replikat je Knoten — Primär legt an, Sekundär und Konfig treten bei ──
    for (const rolle of HA_AG_ROLLEN) {
      const z = b[rolle];
      const peers = HA_KNOTEN.map(k => k.name).filter(n => n !== z).map(n => ({ name: n, zertifikat: ep[n]!.zertifikat, fingerabdruck: ep[n]!.fingerabdruck }));
      const p: HaAgReplikatParameter = { ag: ab.ag, besetzung: { ...b }, rolle, knoten: knoten(), peers, datenbanken: [...ab.datenbanken] };
      const r = await this.laufAendernd<{ zustand: string; aenderungen?: string[] }>(z, LINUX_HA_BAUSTEINE.agReplikat, p, `AG-Replikat ${z}`, LINUX_HA_ZEIT_MS.agReplikat, { sa: sa[z]! }, "des Replikat-Bausteins (Zertifikate, Logins, AG oder Beitritt können angelegt sein)");
      laeufe.push({ z, zustand: r.zustand, aenderungen: r.aenderungen });
    }
    // ── 3: Abschluss auf dem Primär — Datenbanken, Seeding, Pacemaker-Ressourcen, Selbstprüfung ──
    const r = await this.laufAendernd<{ zustand: string; clusterTyp?: string; requiredSyncSql?: unknown; requiredSyncRessource?: unknown; sicherungVorgabe?: string; primaer?: string; vipAuf?: string; promotedAuf?: string;
      datenbanken?: Array<{ name: string; zustand: string }>; aenderungen?: string[] }>(b.primaer, LINUX_HA_BAUSTEINE.agAbschluss, ab, `AG-Abschluss ${b.primaer}`, LINUX_HA_ZEIT_MS.agAbschluss, { sa: sa[b.primaer]! }, "des Abschluss-Bausteins (Datenbanken, Pacemaker-Ressourcen können angelegt sein)");
    laeufe.push({ z: b.primaer, zustand: r.zustand, aenderungen: r.aenderungen });
    const dbs = r.datenbanken ?? [];
    const abw = [
      r.clusterTyp !== 'EXTERNAL' && `CLUSTER_TYPE ${String(r.clusterTyp)}`,
      r.requiredSyncSql !== 0 && `REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT in SQL ${String(r.requiredSyncSql)}`,
      r.requiredSyncRessource !== '0' && `required_synchronized_secondaries_to_commit an ${HA_AG_RESSOURCE} ${String(r.requiredSyncRessource)}`,
      r.primaer !== b.primaer && `Primär ${String(r.primaer)}`,
      (r.vipAuf !== b.primaer || r.promotedAuf !== b.primaer) && `VIP auf ${String(r.vipAuf)}, Promoted auf ${String(r.promotedAuf)}`,
      (dbs.length !== ab.datenbanken.length || dbs.some(d => d.zustand !== 'SYNCHRONIZED')) && `Datenbanken ${dbs.map(d => `${d.name} ${d.zustand}`).join(', ') || 'keine gemeldet'}`,
    ].filter(Boolean);
    if (abw.length) throw new Error(`Selbstprüfung der Verfügbarkeitsgruppe ${ab.ag} auf ${b.primaer}: ${abw.join('; ')} — erwartet EXTERNAL, 0 in SQL und Ressource, Primär/VIP/Promoted ${b.primaer}, alle Datenbanken SYNCHRONIZED; Rückweg ag_entfernen`);
    this.d.protokoll?.('I8e Verfügbarkeitsgruppe', { zugang: b.primaer, ag: ab.ag, besetzung: b, datenbanken: ab.datenbanken, laeufe: laeufe.map(l => ({ knoten: l.z, zustand: l.zustand, aenderungen: l.aenderungen })) });
    const text = `Verfügbarkeitsgruppe ${ab.ag} (CLUSTER_TYPE EXTERNAL): Primär ${b.primaer}, ${b.sekundaer} SYNCHRONOUS_COMMIT (${dbs.map(d => `${d.name} ${d.zustand}`).join(', ')}), ${b.konfig} CONFIGURATION_ONLY; `
      + `REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT 0 in SQL und Ressource ${HA_AG_RESSOURCE}; Sicherungsvorgabe ${r.sicherungVorgabe ?? '?'}; VIP ${ab.vip.ip}/${ab.vip.praefix} auf ${r.vipAuf} (Promoted ${r.promotedAuf})`;
    const data = { ...r, besetzung: b, laeufe };
    if (laeufe.every(l => l.zustand === 'schon')) return { success: true, data, display: `${text} — nichts zu tun` };
    return { success: true, data, display: `✅ ${text} — geändert: ${jeKnoten(laeufe)}` };
  }

  /** Rückweg von ag_anlegen: zuerst der Primär (mit den Pacemaker-Ressourcen), dann Sekundär und Konfig — Datenbanken bleiben */
  private async agEntfernen(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const spur: AgSpur = { laeufe: [], tresor: [] };
    try { return await this.agEntfernenLauf(zugang, input, geheim, spur); } catch (err) { throw this.mitSpur('Verfügbarkeitsgruppe entfernen', zugang, err, spur, geheim); }
  }

  private async agEntfernenLauf(zugang: string, input: Record<string, unknown>, geheim: string[], spur: AgSpur): Promise<SkillResult> {
    const { ag, besetzung: b } = agEntfernenBesetzung(zugang, input);
    const zugaenge = HA_AG_ROLLEN.map(r => b[r]);
    const sa = await this.saKennwoerter(zugaenge, 'AG entfernen', geheim);
    const laeufe = spur.laeufe;
    for (const rolle of HA_AG_ROLLEN) {
      const z = b[rolle];
      const p: HaAgEntfernenParameter = { ag, besetzung: { ...b }, rolle, knoten: HA_KNOTEN.map(k => ({ ...k })), ressourcen: rolle === 'primaer' };
      const r = await this.laufAendernd<{ zustand: string; aenderungen?: string[]; datenbanken?: Array<{ name: string; zustand: string }> }>(z, LINUX_HA_BAUSTEINE.agEntfernen, p, `AG entfernen ${z}`, LINUX_HA_ZEIT_MS.agEntfernen, { sa: sa[z]! }, "des Entfernen-Bausteins (Ressourcen, AG, Endpunkt können entfernt sein)");
      laeufe.push({ z, zustand: r.zustand, aenderungen: r.aenderungen, datenbanken: r.datenbanken });
    }
    this.d.protokoll?.('I8e Verfügbarkeitsgruppe entfernt', { zugang: b.primaer, ag, laeufe: laeufe.map(l => ({ knoten: l.z, zustand: l.zustand, aenderungen: l.aenderungen, datenbanken: l.datenbanken })) });
    const dbs = laeufe.filter(l => l.datenbanken?.length).map(l => `${l.z} ${l.datenbanken!.map(d => `${d.name} ${d.zustand}`).join(', ')}`);
    const text = `Verfügbarkeitsgruppe ${ag} entfernt (Pacemaker-Ressourcen ${HA_AG_RESSOURCE}/${HA_AG_VIP_RESSOURCE}, AG, Endpunkte, Endpunkt-Zertifikate, Pacemaker-Login und Zugangsdatei; Master-Keys bleiben); Datenbanken bleiben${dbs.length ? `: ${dbs.join('; ')}` : ''}`;
    if (laeufe.every(l => l.zustand === 'schon')) return { success: true, data: { ag, besetzung: b, laeufe }, display: `${text} — nichts zu tun` };
    return { success: true, data: { ag, besetzung: b, laeufe }, display: `✅ ${text} — geändert: ${jeKnoten(laeufe)}` };
  }

  /**
   * Task 6 — geplantes Failover: (0) Gate über linux_ha.status auf allen drei Knoten (ohne Geheimnis): Cluster 3/3 online mit Quorum und
   * STONITH (Wertung wie ag_anlegen/clusterText), keine Corosync-Sperre, kein ausstehender Reset; (1) Baustein ha.ag_failover auf dem Ziel
   * (nur dessen sa); (2) Ergebnis gegen das Ziel prüfen. Abbruch mit Teiländerungen → Daten (teilweise → Rückweg ag_failover zurück).
   */
  private async agFailover(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const spur: AgSpur = { laeufe: [], tresor: [] };
    try { return await this.agFailoverLauf(zugang, input, geheim, spur); } catch (err) { throw this.mitSpur('Geplantes Failover', zugang, err, spur, geheim); }
  }

  private async agFailoverLauf(zugang: string, input: Record<string, unknown>, geheim: string[], spur: AgSpur): Promise<SkillResult> {
    const p = agFailoverParameter(zugang, input);
    saPruefen(await this.tresor().namen(), [p.ziel]);
    const maengel: string[] = [];
    for (const z of HA_KNOTEN.map(k => k.name)) {
      const s = await this.lauf<LinuxHaStatus & Record<string, unknown>>(z, LINUX_HA_BAUSTEINE.status, {}, 'HA-Status vor dem Failover', LINUX_HA_ZEIT_MS.status);
      // Fix-Runde 1 (M2): unlesbar = Abbruch — fehlt die Fencing-Lage, die Identität im Cluster oder der Sperr-Zustand, gilt nichts als „ok“
      const f = s.fencing;
      if (!f || typeof f !== 'object') { maengel.push(`${z}: Fencing-Lage (Sperre, Reset, Identität) nicht lesbar`); continue; }
      const k = f.identitaet?.knoten;
      if (!k) { maengel.push(`${z}: Identität im Cluster nicht lesbar`); continue; }
      if (k !== z) { maengel.push(`${z}: Zugang zeigt auf Knoten ${k}`); continue; }
      const c = s.cluster;
      if (!c || c.art !== 'eingerichtet' || c.name !== HA_CLUSTER_NAME || !c.crm || HA_KNOTEN.some(x => !c.crm!.online.includes(x.name)) || !c.crm.quorum || !c.crm.stonith) maengel.push(`${z}: ${clusterText(c)}`);
      if (typeof f.sperreAktiv !== 'boolean') maengel.push(`${z}: Corosync-Sperre nicht lesbar`);
      else if (f.sperreAktiv) maengel.push(`${z}: Corosync-Sperre alfred_fencetest AKTIV`);
      const ft = fencingText(f);
      if (ft.includes('Reset ausstehend')) maengel.push(`${z}: ${ft}`);
    }
    if (maengel.length) throw new Error(`Failover von ${p.ag} nach ${p.ziel} nicht gestartet — Cluster nicht bereit: ${maengel.join('; ')} — kein Fernaufruf mit Geheimnis, nichts geändert`);
    const sa = await this.saKennwoerter([p.ziel], 'Failover', geheim);
    // Fix-Runde 1 (M4): Kopf „Failover von <zugang> auf <ziel> gescheitert“ (pruefeLauf hängt „auf <ziel>“ an)
    const zweck = `Failover von ${p.vorher}`;
    const roh = await this.d.skript(p.ziel, LINUX_HA_BAUSTEINE.agFailover, p, JSON.stringify({ sa: sa[p.ziel]! }), LINUX_HA_ZEIT_MS.agFailover, zweck);
    type FoErgebnis = { zustand: string; ag?: string; primaer?: string; vorher?: string; dauerS?: number; vip?: string; vipAuf?: string; promotedAuf?: string; requiredSyncSql?: unknown;
      requiredSyncRessource?: unknown; altRolle?: string; datenbanken?: Array<{ name: string; zustand: string }>; standortBedingungen?: unknown; aenderungen?: string[] };
    // Fix-Runde 1 (I1): ohne Ergebniszeile des Bausteins (Zeitgrenze am Host, Verbindung weg) ist nicht belegt, dass kein move lief —
    // fail-closed als möglicherweise geändert (Daten → teilweise → Rückweg ag_failover zurück, der bei unverändertem Primär „schon“ ist)
    const r = this.pruefeAendernd<FoErgebnis>(p.ziel, zweck, roh, 'des Failover-Bausteins (pcs resource move kann gelaufen sein)');
    spur.laeufe.push({ z: p.ziel, zustand: r.zustand, aenderungen: r.aenderungen });
    const abw = [
      (r.primaer !== p.ziel || r.promotedAuf !== p.ziel) && `Primär ${String(r.primaer)}, Promoted auf ${String(r.promotedAuf)}`,
      r.vipAuf !== p.ziel && `VIP auf ${String(r.vipAuf)}`,
      r.requiredSyncSql !== 0 && `REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT in SQL ${String(r.requiredSyncSql)}`,
      r.requiredSyncRessource !== '0' && `required_synchronized_secondaries_to_commit an ${HA_AG_RESSOURCE} ${String(r.requiredSyncRessource)}`,
      r.standortBedingungen !== 0 && `Standort-Bedingungen offen: ${String(r.standortBedingungen)}`,
    ].filter(Boolean);
    if (abw.length) throw new Error(`Selbstprüfung des Failovers auf ${p.ziel}: ${abw.join('; ')} — erwartet Primär/Promoted/VIP ${p.ziel}, required_sync 0 in SQL und Ressource, keine Standort-Bedingung; Änderungen des Laufs: ${(r.aenderungen ?? []).join(', ') || 'keine'}`);
    this.d.protokoll?.('I8e Geplantes Failover', { zugang, ziel: p.ziel, ag: p.ag, zustand: r.zustand, vorher: r.vorher, dauerS: r.dauerS, vipAuf: r.vipAuf, aenderungen: r.aenderungen });
    const dbs = (r.datenbanken ?? []).map(d => `${d.name} ${d.zustand}`).join(', ') || 'keine Datenbanken gemeldet';
    const lage = `VIP ${r.vip ?? '?'} auf ${r.vipAuf} (Promoted ${r.promotedAuf}); ${p.vorher} ${r.altRolle ?? '?'} (${dbs}); REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT 0 in SQL und Ressource ${HA_AG_RESSOURCE}`;
    if (r.zustand === 'schon') return { success: true, data: r, display: `Verfügbarkeitsgruppe ${p.ag}: ${p.ziel} ist schon Primär; ${lage}; keine Standort-Bedingung offen — nichts zu tun` };
    const kopf = r.vorher === p.ziel ? `${p.ziel} war schon Primär` : `Primär jetzt ${p.ziel} (vorher ${r.vorher ?? p.vorher}) nach ${r.dauerS ?? '?'} s`;
    return { success: true, data: r, display: `✅ Geplantes Failover der Verfügbarkeitsgruppe ${p.ag}: ${kopf}; ${lage}; keine Standort-Bedingung offen (pcs resource clear) — geändert: ${(r.aenderungen ?? []).join(', ')}` };
  }
}

/** Geheimnisse wörtlich aus Fehlermeldungen entfernen (zusätzlich zur Schwärzung im Transport) */
function schwaerze(t: string, geheim: string[]): string {
  return geheim.filter(g => g.length >= 4).reduce((a, g) => a.split(g).join('[geschwärzt]'), t);
}
