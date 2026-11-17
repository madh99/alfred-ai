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
} from './linux-ha.js';
import { linuxSqlKennwort, type LinuxSqlDeps } from './linux-sql-skill.js';

const sek = (ms: number) => Math.ceil(ms / 1000);
/** Mindest-zeitlimitS je Aktion: Baustein-Zeitgrenze + 60 s Puffer */
export const LINUX_HA_MIN_ZEITLIMIT_S: Readonly<Record<string, number>> = {
  status: sek(LINUX_HA_ZEIT_MS.status) + 60,
  ha_vorbereiten: sek(LINUX_HA_ZEIT_MS.vorbereiten) + 60,
  cluster_anlegen: sek(LINUX_HA_ZEIT_MS.cluster) + 60,
  cluster_entfernen: sek(LINUX_HA_ZEIT_MS.clusterEntfernen) + 60,
  fencing_pruefen: sek(LINUX_HA_ZEIT_MS.fencingPruefen) + 60,
  fencing_belegen: sek(LINUX_HA_ZEIT_MS.fencingBelegen) + 60,
};

export type LinuxHaDeps = LinuxSqlDeps;

export const LINUX_HA_LESEND = new Set(['status']);
export const LINUX_HA_NUR_IM_CHANGE = new Set(['ha_vorbereiten', 'cluster_anlegen', 'cluster_entfernen', 'fencing_pruefen', 'fencing_belegen']);
/** Task 4 — fencing_pruefen hat keinen Rückweg; nur mit genau diesem Grund (change-schritte.ts, OHNE_RUECKWEG_NUR_MIT_GRUND) */
export const FENCING_OHNE_RUECKWEG_GRUND = 'Testknoten setzt sich selbst zurück; Beleg folgt mit fencing_belegen';
const ZUGANG = /^[a-z0-9][a-z0-9.-]{0,62}$/i;
const istVerweis = (v: unknown) => typeof v === 'string' && v.includes('{{');

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
  /** Live-Fix (c2e4f56d): sbd-Drop-in und Warteskript vorhanden und unverändert */
  sbdWartetAufWatchdog?: boolean;
  /** Fix-Runde 1: Loopback-Zeilen mit eigenem Namen, ersetzte Originale, zusätzliche 1433-Quellen (Ruling R4) */
  hostsLoopback?: string[]; hostsEntfernt?: string[]; sql1433Zusatz?: string[];
  /** Task 3: Cluster aus corosync.conf, crm_mon-XML, pcs stonith sbd status, stonith-watchdog-timeout */
  cluster?: LinuxHaCluster;
  /** Task 4: Fencing-Test und -Beleg dieses Knotens, boot_id, Identität im Cluster */
  fencing?: FencingLage;
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
  const fwText = !fw ? 'Firewall alfred_ha unbekannt' : fw.tabelle && fw.dienst === 'active' && fw.aktiviert === 'enabled' ? `Firewall alfred_ha aktiv (1433: Knoten${s.sql1433Zusatz?.length ? ` + ${s.sql1433Zusatz.join(', ')}` : ''})`
    : `Firewall alfred_ha ${fw.tabelle ? 'geladen' : 'nicht geladen'}, Dienst ${fw.dienst}, ${fw.aktiviert}`;
  return [
    watchdogText(s),
    paketeText(s),
    s.hadr === '1' ? 'HADR an' : 'HADR aus',
    fwText,
    s.hostsLoopback?.length ? `hosts-Block mit eigenem Namen auf Loopback (${s.hostsLoopback.join(' / ').slice(0, 120)})` : s.hosts ? 'hosts-Block vorhanden' : 'hosts-Block fehlt',
    s.runtimeWatchdog === '0' ? 'RuntimeWatchdog aus' : `RuntimeWatchdog AN (${s.runtimeWatchdog ?? 'unbekannt'})`,
    // Live-Fix (c2e4f56d): sbd wartet beim Start auf das Watchdog-Gerät (Drop-in + Warteskript von ha_vorbereiten)
    s.sbdWartetAufWatchdog === true ? 'sbd wartet auf Watchdog' : s.sbdWartetAufWatchdog === false ? 'sbd ohne Watchdog-Wartezeit (Drop-in fehlt)' : 'sbd Watchdog-Wartezeit unbekannt',
    s.pcsd === 'active' ? 'pcsd aktiv' : `pcsd ${s.pcsd ?? 'unbekannt'}`,
    clusterText(s.cluster),
    fencingText(s.fencing),
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

// ── Skill ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export class LinuxHaSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'linux_ha',
    category: 'infrastructure',
    description:
      'Hochverfügbarkeit für SQL Server 2025 auf Ubuntu 24.04 (I8e Paket 2: Pacemaker, diskless SBD mit Hardware-Watchdog i6300esb, Verfügbarkeitsgruppe) über feste, geprüfte Bash-Bausteine auf Linux-Fernzugängen (zugang = Name des Fernzugangs, z. B. sqllnx02). '
      + 'status (lesend, auch außerhalb von Changes; ohne Tresor): Watchdog (Kennung, Besitzer), Pakete, HADR, Host-Firewall, hosts-Block, systemd-RuntimeWatchdog, pcsd, Cluster — '
      + 'Wortlaut „<zugang>: Watchdog i6300esb frei; Pakete fest; HADR an; Firewall alfred_ha aktiv (1433: Knoten + 192.168.1.223); hosts-Block vorhanden; RuntimeWatchdog aus; sbd wartet auf Watchdog; pcsd aktiv; Cluster sqllnxcl01: 3/3 online, Quorum ja, STONITH an, SBD aktiv 3/3, stonith-watchdog-timeout 20s“ (Abweichungen: „Watchdog fehlt …“, „Watchdog FREMD …“, „Watchdog i6300esb BELEGT von …“, „Watchdog i6300esb bei sbd“, „Pakete abweichend: …“, „HADR aus“, „Cluster nicht eingerichtet“, „Quorum nein“ …), als Prüfung z. B. erwartet „Pakete fest“, „Firewall alfred_ha aktiv“ oder „3/3 online, Quorum ja, STONITH an, SBD aktiv 3/3“. '
      + `NUR als Schritt freigegebener Changes: ha_vorbereiten (zugang, rolle daten|konfig, knoten optional — Standard ${HA_KNOTEN.map(k => `${k.name} ${k.ip}`).join(', ')}) — nach linux_sql installieren auf jedem der drei Knoten: `
      + `hosts-Block der drei Knoten, Pakete fest und gehalten (${HA_PAKETE.map(([s, n]) => `${n} ${HA_VERSIONEN[s]}`).join(', ')}, linux-modules-extra des laufenden Kernels), i6300esb laden, softdog gesperrt, systemd-RuntimeWatchdog aus, `
      + `hacluster-Kennwort aus dem Tresor (${HA_HACLUSTER_TRESOR}, erzeugt Alfred einmalig), HADR an (SQL-Neustart nur bei Änderung), nft-Tabelle inet alfred_ha (alfred-hostfw.service: nur die drei Knoten dürfen TCP 1433, 2224, 3121, 5022, 21064 und UDP 5405, TCP 1433 zusätzlich ${HA_SQL_ZUSATZQUELLEN.join(', ')}, sonst unverändert, SSH bleibt), pcsd läuft, Cluster-Dienste bleiben bis zur Cluster-Einrichtung aus. `
      + 'Bricht VOR jeder Änderung ab, wenn die VM keinen i6300ESB hat (vorher proxmox set_vm_watchdog model i6300esb bzw. provision_vm watchdog i6300esb, dann Kaltstart stop_vm/start_vm), ein Watchdog-Gerät nicht von i6300esb stammt oder ein anderer Prozess als sbd /dev/watchdog offen hält — kein softdog-Ersatz. '
      + `Wiederholbar („nichts zu tun“), prüft sich selbst. Mindest-zeitlimitS: ${Object.entries(LINUX_HA_MIN_ZEITLIMIT_S).map(([a, s]) => `${a} ${s} s`).join(', ')}. `
      + `cluster_anlegen (zugang = EIN Knoten, auf dem es läuft; cluster Standard ${HA_CLUSTER_NAME}; knoten optional, nur ${HA_KNOTEN.map(k => k.name).join(', ')}; sbd_timeout_s Standard ${HA_SBD_TIMEOUT_S}; stonith_timeout_s Standard ${HA_STONITH_WD_TIMEOUT_S}, mindestens 2 × sbd_timeout_s) — nach ha_vorbereiten auf allen drei Knoten: `
      + `pcs-Anmeldung als hacluster (Kennwort aus dem Tresor, nur über die Standardeingabe), pcs cluster setup mit knet über die festen IPs, diskless SBD (Watchdog ${HA_WATCHDOG_DEV}, kein SBD-Device), Cluster auf allen aktiviert und gestartet, stonith-enabled=true, stonith-watchdog-timeout; `
      + 'prüft sich selbst (alle Knoten online, Quorum 3/3, sbd läuft auf allen, have-watchdog=true). Gleicher Cluster schon da → nur Abweichungen beheben; anderer Cluster oder Debian-Standardkonfiguration → Abbruch ohne Änderung. '
      + 'Rückweg von cluster_anlegen ist cluster_entfernen (zugang, cluster): Cluster sauber stoppen, SBD aus, pcs cluster destroy --all — nur ohne Ressourcen. cluster_anlegen braucht immer diesen Rückweg. '
      + `Fencing-Beweis je Knoten (nach cluster_anlegen, vor dem AG-Aufbau; der AG-Aufbau verlangt gültige Belege auf allen drei Knoten): fencing_pruefen (zugang = Testknoten, art trennung|haenger) prüft ohne Änderung (Cluster 3/3 online mit Quorum, STONITH an, keine Ressourcen, sbd hält den i6300esb), schreibt die Test-Datei und löst in ${HA_FENCING_VERZOEGERUNG_S} s aus — trennung: Corosync (UDP 5405) ${HA_FENCING_SPERRE_S} s gesperrt (ohne Persistenz) → SBD setzt den Knoten zurück; haenger (nur ${HA_FENCING_HAENGER_KNOTEN}): Kernel-Absturz (sysrq c) → Hardware-Watchdog; Ergebnis „ausgeloest“ vor dem Reset. `
      + `Rückweg von fencing_pruefen: keiner, nur mit dem Grund „${FENCING_OHNE_RUECKWEG_GRUND}“. Danach ein warten-Schritt (sekunden ca. 45, zeitlimitS ca. 600) mit Prüfung linux_ha.status (zugang = Testknoten) erwartet „3/3 online“, nichtEnthalten „Reset ausstehend“, dann fencing_belegen (zugang): Beleg nur bei neuer boot_id, Test ≤ 30 min, Knoten wieder online, Reset- und Rejoin-Zeit aus btime und Journal; sonst Fehler ohne Beleg; Status zeigt „Fencing belegt (…)“. `
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
      }
    } catch (err) { return { success: false, error: schwaerze((err as Error).message, geheim).slice(0, 800) }; }
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

  private tresor() { if (!this.d.tresor) throw new Error('Tresor nicht verfügbar'); return this.d.tresor; }

  private async vorbereiten(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
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
    if (neu && (ok || gesetzt)) await t.setze(HA_HACLUSTER_TRESOR, kw, 'Kennwort des Pacemaker-Benutzers hacluster (sqllnx01, sqllnx02, sqllnxcfg)');
    const r = this.pruefeLauf<{ zustand: string; knoten?: string; watchdog?: string; pakete?: Record<string, string>; sql1433?: string[]; neustartSql?: boolean; aenderungen?: string[] }>(zugang, 'HA-Grundlage vorbereiten', roh);
    this.d.protokoll?.('I8e HA-Grundlage', { zugang, zustand: r.zustand, rolle: p.rolle, aenderungen: r.aenderungen, kennwortNeu: neu });
    const text = `HA-Grundlage auf ${zugang} (${p.rolle}): Watchdog ${r.watchdog ?? '?'}, Pakete fest (${Object.entries(r.pakete ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}), HADR an, Firewall alfred_ha aktiv (1433 nur ${(r.sql1433 ?? []).join(', ')}), pcsd aktiv; hacluster-Kennwort im Tresor (${HA_HACLUSTER_TRESOR})`;
    if (r.zustand === 'schon') return { success: true, data: r, display: `${text} — nichts zu tun` };
    return { success: true, data: r, display: `✅ ${text}${r.neustartSql ? '; SQL Server neu gestartet (HADR)' : ''} — geändert: ${(r.aenderungen ?? []).join(', ')}` };
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
    const p = clusterParameter(input);
    const kw = await this.hacluster(zugang, 'Cluster anlegen', geheim);
    const r = await this.lauf<{ zustand: string; cluster?: string; knoten?: string[]; online?: number; quorum?: string; sbd?: string; aenderungen?: string[] }>(
      zugang, LINUX_HA_BAUSTEINE.cluster, p, 'Cluster anlegen', LINUX_HA_ZEIT_MS.cluster, { hacluster: kw });
    this.d.protokoll?.('I8e Cluster', { zugang, cluster: p.cluster, zustand: r.zustand, aenderungen: r.aenderungen });
    const text = `Cluster ${p.cluster} (${(r.knoten ?? p.knoten.map(k => k.name)).join(', ')}, ausgeführt auf ${zugang}): ${r.online ?? '?'}/${p.knoten.length} online, Quorum ${r.quorum ?? '?'}, STONITH an, `
      + `SBD diskless (Watchdog ${HA_WATCHDOG_DEV}, SBD_WATCHDOG_TIMEOUT ${p.sbd_timeout_s} s) aktiv ${r.sbd ?? '?'}, stonith-watchdog-timeout ${p.stonith_timeout_s} s, have-watchdog true`;
    if (r.zustand === 'schon') return { success: true, data: r, display: `${text} — nichts zu tun` };
    return { success: true, data: r, display: `✅ ${text} — geändert: ${(r.aenderungen ?? []).join(', ')}` };
  }

  private async clusterEntfernen(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const p = clusterEntfernenParameter(input);
    const kw = await this.hacluster(zugang, 'Cluster entfernen', geheim);
    const r = await this.lauf<{ zustand: string; aenderungen?: string[] }>(zugang, LINUX_HA_BAUSTEINE.clusterEntfernen, p, 'Cluster entfernen', LINUX_HA_ZEIT_MS.clusterEntfernen, { hacluster: kw });
    this.d.protokoll?.('I8e Cluster entfernt', { zugang, cluster: p.cluster, zustand: r.zustand, aenderungen: r.aenderungen });
    const text = `Cluster ${p.cluster} auf ${p.knoten.map(k => k.name).join(', ')} entfernt (SBD aus, Cluster-Dienste aus, keine corosync.conf von ${p.cluster} mehr)`;
    if (r.zustand === 'schon') return { success: true, data: r, display: `${text} — nichts zu tun` };
    return { success: true, data: r, display: `✅ ${text} — geändert: ${(r.aenderungen ?? []).join(', ')}` };
  }

  /** Fencing-Beweis Teil 1: hacluster-Kennwort nur für die pcs-Anmeldung (pcs stonith sbd status über alle Knoten) */
  private async fencingPruefen(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const p = fencingParameter(input);
    const kw = await this.hacluster(zugang, 'Fencing-Test', geheim);
    const r = await this.lauf<{ zustand: string; art?: string; knoten?: string; bootIdVorher?: string; hinweis?: string; beleg?: FencingBeleg; aenderungen?: string[] }>(
      zugang, LINUX_HA_BAUSTEINE.fencingPruefen, p, `Fencing-Test ${p.art}`, LINUX_HA_ZEIT_MS.fencingPruefen, { hacluster: kw });
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
}

/** Geheimnisse wörtlich aus Fehlermeldungen entfernen (zusätzlich zur Schwärzung im Transport) */
function schwaerze(t: string, geheim: string[]): string {
  return geheim.filter(g => g.length >= 4).reduce((a, g) => a.split(g).join('[geschwärzt]'), t);
}
