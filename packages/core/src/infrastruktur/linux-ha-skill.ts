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
  type HaKnoten, type HaRolle, type HaVorbereitenParameter,
} from './linux-ha.js';
import { linuxSqlKennwort, type LinuxSqlDeps } from './linux-sql-skill.js';

const sek = (ms: number) => Math.ceil(ms / 1000);
/** Mindest-zeitlimitS je Aktion: Baustein-Zeitgrenze + 60 s Puffer */
export const LINUX_HA_MIN_ZEITLIMIT_S: Readonly<Record<string, number>> = {
  status: sek(LINUX_HA_ZEIT_MS.status) + 60,
  ha_vorbereiten: sek(LINUX_HA_ZEIT_MS.vorbereiten) + 60,
};

export type LinuxHaDeps = LinuxSqlDeps;

export const LINUX_HA_LESEND = new Set(['status']);
export const LINUX_HA_NUR_IM_CHANGE = new Set(['ha_vorbereiten']);
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
  /** Fix-Runde 1: Loopback-Zeilen mit eigenem Namen, ersetzte Originale, zusätzliche 1433-Quellen (Ruling R4) */
  hostsLoopback?: string[]; hostsEntfernt?: string[]; sql1433Zusatz?: string[];
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
    s.pcsd === 'active' ? 'pcsd aktiv' : `pcsd ${s.pcsd ?? 'unbekannt'}`,
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

// ── Skill ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export class LinuxHaSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'linux_ha',
    category: 'infrastructure',
    description:
      'Hochverfügbarkeit für SQL Server 2025 auf Ubuntu 24.04 (I8e Paket 2: Pacemaker, diskless SBD mit Hardware-Watchdog i6300esb, Verfügbarkeitsgruppe) über feste, geprüfte Bash-Bausteine auf Linux-Fernzugängen (zugang = Name des Fernzugangs, z. B. sqllnx02). '
      + 'status (lesend, auch außerhalb von Changes; ohne Tresor): Watchdog (Kennung, Besitzer), Pakete, HADR, Host-Firewall, hosts-Block, systemd-RuntimeWatchdog, pcsd — '
      + 'Wortlaut „<zugang>: Watchdog i6300esb frei; Pakete fest; HADR an; Firewall alfred_ha aktiv (1433: Knoten + 192.168.1.223); hosts-Block vorhanden; RuntimeWatchdog aus; pcsd aktiv“ (Abweichungen: „Watchdog fehlt …“, „Watchdog FREMD …“, „Watchdog i6300esb BELEGT von …“, „Watchdog i6300esb bei sbd“, „Pakete abweichend: …“, „HADR aus“ …), als Prüfung z. B. erwartet „Pakete fest“ oder „Firewall alfred_ha aktiv“. '
      + `NUR als Schritt freigegebener Changes: ha_vorbereiten (zugang, rolle daten|konfig, knoten optional — Standard ${HA_KNOTEN.map(k => `${k.name} ${k.ip}`).join(', ')}) — nach linux_sql installieren auf jedem der drei Knoten: `
      + `hosts-Block der drei Knoten, Pakete fest und gehalten (${HA_PAKETE.map(([s, n]) => `${n} ${HA_VERSIONEN[s]}`).join(', ')}, linux-modules-extra des laufenden Kernels), i6300esb laden, softdog gesperrt, systemd-RuntimeWatchdog aus, `
      + `hacluster-Kennwort aus dem Tresor (${HA_HACLUSTER_TRESOR}, erzeugt Alfred einmalig), HADR an (SQL-Neustart nur bei Änderung), nft-Tabelle inet alfred_ha (alfred-hostfw.service: nur die drei Knoten dürfen TCP 1433, 2224, 3121, 5022, 21064 und UDP 5405, TCP 1433 zusätzlich ${HA_SQL_ZUSATZQUELLEN.join(', ')}, sonst unverändert, SSH bleibt), pcsd läuft, Cluster-Dienste bleiben bis zur Cluster-Einrichtung aus. `
      + 'Bricht VOR jeder Änderung ab, wenn die VM keinen i6300ESB hat (vorher proxmox set_vm_watchdog model i6300esb bzw. provision_vm watchdog i6300esb, dann Kaltstart stop_vm/start_vm), ein Watchdog-Gerät nicht von i6300esb stammt oder ein anderer Prozess als sbd /dev/watchdog offen hält — kein softdog-Ersatz. '
      + `Wiederholbar („nichts zu tun“), prüft sich selbst. Mindest-zeitlimitS: ${Object.entries(LINUX_HA_MIN_ZEITLIMIT_S).map(([a, s]) => `${a} ${s} s`).join(', ')}. `
      + 'Ohne Rückweg nur beim Neuaufbau (derselbe Change stellt die VM vorher mit proxmox.provision_vm bereit) oder mit ohneSicherungGrund — sonst vorher sichern und rueckweg angeben.',
    riskLevel: 'admin',
    version: '1.0.0',
    timeoutMs: 3_600_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...LINUX_HA_LESEND, ...LINUX_HA_NUR_IM_CHANGE] },
        zugang: { type: 'string', description: 'Name des Linux-Fernzugangs (z. B. sqllnx02)' },
        rolle: { type: 'string', enum: ['daten', 'konfig'], description: 'ha_vorbereiten: daten (Datenreplikat) oder konfig (CONFIGURATION_ONLY, sqllnxcfg)' },
        knoten: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, ip: { type: 'string' } } }, description: 'ha_vorbereiten: genau drei Knoten {name, ip} (Standard sqllnx01/02/cfg)' },
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
}

/** Geheimnisse wörtlich aus Fehlermeldungen entfernen (zusätzlich zur Schwärzung im Transport) */
function schwaerze(t: string, geheim: string[]): string {
  return geheim.filter(g => g.length >= 4).reduce((a, g) => a.split(g).join('[geschwärzt]'), t);
}
