/**
 * I8e Paket 1 (Vorhaben c7e02aff v2) — Skill „linux_sql“: SQL Server 2025 Enterprise Developer auf Ubuntu 24.04 über die festen
 * Bash-Bausteine aus linux-sql.ts (Transport `FernzugriffSkill.linuxSkript`). Alles außer „status“ nur als Schritt eines
 * freigegebenen Changes. Kennwörter (sa, SQL-Logins) erzeugt der Skill einmalig im Tresor (`sqllnx-<zugang>-sa`,
 * `sqllnx-<zugang>-<login>`) und gibt sie nur über die Standardeingabe (erste Zeile, JSON) weiter — nie als Parameter, Zweck,
 * Ergebnis oder Fehlermeldung.
 */
import { randomInt } from 'node:crypto';
import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import {
  LINUX_SQL_BAUSTEINE, LINUX_SQL_ZEIT_MS, LINUX_SQL_ZIELE, PRUEFDATEN_SHA256, PRUEFDATEN_ZEILEN, sqlErgebnis,
  pruefePlatten, pruefeInstallation, pruefeKonfig, pruefeTempdb, pruefeMaxSpeicher, pruefeLogin, pruefePruefdaten,
  type LinuxSqlZiel, type PlattenParameter, type InstallParameter, type KonfigParameter, type TempdbParameter, type LoginParameter,
} from './linux-sql.js';
import { NAME as TRESOR_NAME } from './tresor.js';

export interface LinuxSqlDeps {
  /** Fernzugriff: registrierter Linux-Baustein auf einem Zugang (Geheimnisse nur in `eingabe`, eine Zeile JSON) */
  skript: (zugang: string, baustein: string, parameter: unknown, eingabe: string | undefined, timeoutMs: number, zweck: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  tresor?: { namen: () => Promise<Set<string>>; lies: (name: string, wofuer: string) => Promise<string>; setze: (name: string, wert: string, zweck: string) => Promise<void> };
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
}

/** lesende Aktionen (auch außerhalb eines Changes) */
export const LESEND = new Set(['status']);
const NUR_IM_CHANGE = new Set(['platten_einrichten', 'installieren', 'konfigurieren', 'login_anlegen', 'pruefdaten_anlegen']);
const ZUGANG = /^[a-z0-9][a-z0-9.-]{0,62}$/i;
const ROLLEN: Record<string, string[]> = { dbcreator: ['dbcreator'], sysadmin: ['sysadmin'], lesen: [] };
const KURZZIEL: Record<string, LinuxSqlZiel> = { data: '/var/opt/mssql/data', log: '/var/opt/mssql/log', tempdb: '/var/opt/mssql/tempdb', backup: '/var/opt/mssql/backup' };
/** Festlegungen v2: Prozesslimit 12 GiB, max server memory 10 GiB; tempdb je Kern (max. 8) */
const STANDARD = { speicherLimitMB: 12_288, maxServerMemoryMB: 10_240, tempdbMB: 1024, tempdbWachstumMB: 512, tempdbLogMB: 2048 };

// ── Kennwörter ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const GROSS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const KLEIN = 'abcdefghijkmnopqrstuvwxyz';
const ZIFFER = '23456789';
/** druckbares ASCII ohne " \ ' Leerzeichen $ (kein Quoting-Grenzfall in Shell, JSON-Schwärzung oder T-SQL) */
const SONDER = '!#%&()*+,-./:;<=>?@[]^_`{|}~';
export const KENNWORT_ALPHABET = GROSS + KLEIN + ZIFFER + SONDER;
const zeichen = (aus: string) => aus[randomInt(aus.length)]!;
/** 24 Zeichen, mindestens je ein Groß-, Kleinbuchstabe, Ziffer, Sonderzeichen (SQL-Server-Kennwortrichtlinie); gleichverteilt gemischt */
export function linuxSqlKennwort(): string {
  const z = [zeichen(GROSS), zeichen(KLEIN), zeichen(ZIFFER), zeichen(SONDER), ...Array.from({ length: 20 }, () => zeichen(KENNWORT_ALPHABET))];
  for (let i = z.length - 1; i > 0; i--) { const j = randomInt(i + 1); [z[i], z[j]] = [z[j]!, z[i]!]; }
  return z.join('');
}

export const saName = (zugang: string) => `sqllnx-${zugang.toLowerCase()}-sa`;
/** Fix 1 — Tresor-Regel schon beim Planen und vor jedem Fernaufruf prüfen (langer Zugangsname → Name über 61 Zeichen) */
function pruefeTresorName(n: string): string {
  if (!TRESOR_NAME.test(n)) throw new Error(`Tresor-Name ${n.slice(0, 80)} ist ungültig (höchstens 61 Zeichen) — kürzeren Zugangs- bzw. Login-Namen wählen`);
  return n;
}
export function loginTresorName(zugang: string, login: string): string {
  return pruefeTresorName(`sqllnx-${zugang.toLowerCase()}-${login.toLowerCase()}`);
}

// ── Status ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LinuxSqlStatus {
  zustand: string; installiert?: boolean; pakete?: Record<string, string | null>; dienst?: string; aktiviert?: string;
  konfig?: Record<string, string | null>; platz?: Array<{ pfad: string; eingehaengt: boolean; gesamtMB: number; freiMB: number }>;
  sql?: { version?: string; stufe?: string; cu?: string | null; edition?: string; engineEdition?: number; maxSpeicherMb?: number; kerne?: number;
    tempdb?: Array<{ name: string; typ: string }> | null; datenbanken?: Array<{ name: string }> | null } | null;
  sqlHinweis?: string; sqlFehler?: string;
}

const SYSTEM_DBS = new Set(['master', 'model', 'msdb', 'tempdb']);
/** Fester Wortlaut — Stücke stehen in FESTE_AUSGABEN['linux_sql.status'] (change-schritte.ts); bei Änderungen dort nachziehen */
export function linuxSqlStatusText(zugang: string, s: LinuxSqlStatus): string {
  const ein = (s.platz ?? []).filter(p => p.eingehaengt && (LINUX_SQL_ZIELE as readonly string[]).includes(p.pfad)).map(p => p.pfad.split('/').pop());
  const eingehaengt = `eingehängt: ${ein.length ? ein.join(', ') : 'keine Plattenziele'}`;
  if (!s.installiert) return `${zugang}: SQL Server nicht installiert; ${eingehaengt}`;
  const dienst = `Dienst ${s.dienst === 'active' ? 'aktiv' : s.dienst ?? 'unbekannt'}, ${s.aktiviert === 'enabled' ? 'aktiviert' : s.aktiviert ?? 'unbekannt'}`;
  const limit = `Speicherlimit ${s.konfig?.memorylimitmb ?? '-'} MB`;
  const q = s.sql;
  if (!q) return `${zugang}: SQL Server ${s.pakete?.['mssql-server'] ?? '?'} (Paket); ${dienst}; ${limit}; SQL-Sicht: ${(s.sqlHinweis ?? s.sqlFehler ?? 'keine').slice(0, 200)}; ${eingehaengt}`;
  const dateien = (q.tempdb ?? []).filter(t => t.typ === 'ROWS').length;
  const dbs = (q.datenbanken ?? []).map(d => d.name).filter(n => !SYSTEM_DBS.has(n.toLowerCase()));
  return `${zugang}: SQL Server ${q.version ?? '?'} ${q.cu ?? q.stufe ?? ''} ${q.edition ?? ''}; ${dienst}; ${limit}; max server memory ${q.maxSpeicherMb ?? '-'} MB; tempdb ${dateien} Datendateien; Datenbanken: ${dbs.length ? dbs.join(', ') : 'keine eigenen'}; ${eingehaengt}`;
}

// ── Parameter ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const ganzzahl = (v: unknown): unknown => (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v);
const istVerweis = (v: unknown) => typeof v === 'string' && v.includes('{{');

function plattenParameter(input: Record<string, unknown>): PlattenParameter {
  const roh = Array.isArray(input.platten) ? input.platten : [];
  const p = { platten: roh.map(e => {
    const x = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    const ziel = typeof x.ziel === 'string' ? KURZZIEL[x.ziel.trim().toLowerCase()] ?? x.ziel.trim() : x.ziel;
    return { scsi: ganzzahl(x.scsi), groesseGiB: ganzzahl(x.groesse_gib ?? x.groesseGiB), ziel };
  }) } as unknown as PlattenParameter;
  const f = pruefePlatten(p); if (f) throw new Error(f);
  return p;
}

function installParameter(input: Record<string, unknown>): InstallParameter {
  const p: InstallParameter = { version: String(input.version ?? '').trim(), edition: 'EnterpriseDeveloper' };
  if (Array.isArray(input.einhaengepunkte)) p.einhaengepunkte = input.einhaengepunkte.map(x => (typeof x === 'string' ? KURZZIEL[x.trim().toLowerCase()] ?? x.trim() : x)) as LinuxSqlZiel[];
  const f = pruefeInstallation(p); if (f) throw new Error(f);
  return p;
}

interface KonfigWerte { konfig: KonfigParameter; maxMb: number; tempdb: Omit<TempdbParameter, 'dateien'> & { dateien?: number } }
function konfigWerte(input: Record<string, unknown>): KonfigWerte {
  const konfig: KonfigParameter = {
    speicherLimitMB: ganzzahl(input.speicher_limit_mb ?? STANDARD.speicherLimitMB) as number,
    datenPfad: KURZZIEL.data!, logPfad: KURZZIEL.log!, sicherungsPfad: KURZZIEL.backup!, agent: input.agent === undefined ? true : input.agent === true,
  };
  const maxMb = ganzzahl(input.max_server_memory_mb ?? STANDARD.maxServerMemoryMB) as number;
  const fk = pruefeKonfig(konfig); if (fk) throw new Error(fk.replace('speicherLimitMB', 'speicher_limit_mb'));
  const fm = pruefeMaxSpeicher({ mb: maxMb }); if (fm) throw new Error(`max_server_memory_mb: ${fm}`);
  if (maxMb >= konfig.speicherLimitMB) throw new Error(`max_server_memory_mb (${maxMb}) muss unter speicher_limit_mb (${konfig.speicherLimitMB}) liegen — sonst stößt SQL Server an das Prozesslimit`);
  const tempdb = {
    groesseMB: ganzzahl(input.tempdb_mb ?? STANDARD.tempdbMB) as number, wachstumMB: ganzzahl(input.tempdb_wachstum_mb ?? STANDARD.tempdbWachstumMB) as number,
    logGroesseMB: ganzzahl(input.tempdb_log_mb ?? STANDARD.tempdbLogMB) as number,
    ...(input.tempdb_dateien !== undefined ? { dateien: ganzzahl(input.tempdb_dateien) as number } : {}),
  };
  const ft = pruefeTempdb({ dateien: tempdb.dateien ?? 1, ...tempdb }); if (ft) throw new Error(`tempdb: ${ft}`);
  return { konfig, maxMb, tempdb };
}

function loginParameter(input: Record<string, unknown>): LoginParameter {
  const rolle = String(input.rolle ?? '').trim();
  if (!(rolle in ROLLEN)) throw new Error('rolle: dbcreator, sysadmin oder lesen');
  const p: LoginParameter = { name: String(input.login ?? '').trim(), serverrollen: ROLLEN[rolle]! };
  const f = pruefeLogin(p); if (f) throw new Error(f.replace(/^name/, 'login'));
  return p;
}

function pruefdatenParameter(input: Record<string, unknown>): { datenbank: string } {
  const p = { datenbank: String(input.datenbank ?? '').trim() };
  const f = pruefePruefdaten(p); if (f) throw new Error(f);
  return p;
}

// ── Skill ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export class LinuxSqlSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'linux_sql',
    category: 'infrastructure',
    description:
      'SQL Server 2025 Enterprise Developer auf Ubuntu 24.04 (I8e) über feste, geprüfte Bash-Bausteine auf Linux-Fernzugängen (zugang = Name des Fernzugangs, z. B. sqllnx01). '
      + 'status (lesend, auch außerhalb von Changes): Pakete, Dienst, mssql.conf, Platten; mit sa aus dem Tresor zusätzlich Version/CU/Edition, max server memory, tempdb, Datenbanken, letzte Sicherungen — '
      + 'Wortlaut „<zugang>: SQL Server <version> <cu> <edition>; Dienst aktiv, aktiviert; Speicherlimit <mb> MB; max server memory <mb> MB; tempdb <n> Datendateien; Datenbanken: <liste>; eingehängt: data, log, tempdb, backup“, als Prüfung z. B. erwartet „Dienst aktiv, aktiviert“. '
      + 'NUR als Schritte freigegebener Changes (Reihenfolge): platten_einrichten (zugang, platten = [{scsi, groesse_gib, ziel: data|log|tempdb|backup}], z. B. scsi1 160 data, scsi2 80 log, scsi3 64 tempdb, scsi4 128 backup aus provision_vm extra_disks [160,80,64,128]) — nur leere Platten exakter Größe, XFS, fstab per UUID; '
      + 'installieren (zugang, version = apt-Version ab CU1 wie 17.0.4006.2-1) — signierte Microsoft-Quelle, feste Versionen, sa-Kennwort erzeugt Alfred im Tresor (sqllnx-<zugang>-sa); '
      + 'konfigurieren (zugang, speicher_limit_mb Standard 12288, max_server_memory_mb Standard 10240, tempdb_dateien Standard Kerne max. 8, agent Standard true) — mssql-conf, tempdb auf der TempDB-Platte, max server memory; '
      + 'login_anlegen (zugang, login, rolle dbcreator|sysadmin|lesen) — SQL-Login, Kennwort im Tresor (sqllnx-<zugang>-<login>), „lesen“ = ohne Serverrolle; '
      + `pruefdaten_anlegen (zugang, datenbank) — Datenbank (FULL) mit Prüftabelle dbo.alfred_pruefung (${PRUEFDATEN_ZEILEN} feste Zeilen, Prüfsumme im Ergebnis) für den Restore-Beweis. `
      + 'Alle Aktionen sind wiederholbar („nichts zu tun“) und prüfen ihr Ergebnis selbst. Ohne Rückweg nur beim Neuaufbau: derselbe Change stellt die VM vorher mit proxmox.provision_vm bereit (Rückweg = VM löschen) oder ohneSicherungGrund ist gesetzt — sonst vorher sichern und rueckweg angeben.',
    riskLevel: 'admin',
    version: '1.0.0',
    timeoutMs: 1_800_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...LESEND, ...NUR_IM_CHANGE] },
        zugang: { type: 'string', description: 'Name des Linux-Fernzugangs (z. B. sqllnx01)' },
        platten: { type: 'array', items: { type: 'object', properties: { scsi: { type: 'number' }, groesse_gib: { type: 'number' }, ziel: { type: 'string', enum: ['data', 'log', 'tempdb', 'backup'] } } }, description: 'platten_einrichten: Zusatzplatten nach SCSI-Position' },
        version: { type: 'string', description: 'installieren: apt-Version von mssql-server, z. B. 17.0.4006.2-1' },
        einhaengepunkte: { type: 'array', items: { type: 'string' }, description: 'installieren: Plattenziele, die vor dem Setup eingehängt sein müssen (Standard alle vier; data Pflicht)' },
        speicher_limit_mb: { type: 'number' }, max_server_memory_mb: { type: 'number' },
        tempdb_dateien: { type: 'number', description: 'Standard: Kerne, höchstens 8' }, tempdb_mb: { type: 'number' }, tempdb_wachstum_mb: { type: 'number' }, tempdb_log_mb: { type: 'number' },
        agent: { type: 'boolean' },
        login: { type: 'string', description: 'login_anlegen: Name des SQL-Logins' },
        rolle: { type: 'string', enum: ['dbcreator', 'sysadmin', 'lesen'] },
        datenbank: { type: 'string', description: 'pruefdaten_anlegen: Name der Prüfdatenbank' },
      },
      required: ['action', 'zugang'],
    },
  };

  constructor(private readonly d: LinuxSqlDeps) { super(); }

  /** Planprüfung (rein, ohne Tresor und Fernaufruf); Verweise {{…}} bleiben bis zur Laufzeit ungeprüft */
  pruefeEingabe(input: Record<string, unknown>): string | undefined {
    const action = String(input.action ?? '');
    if (!istVerweis(input.zugang) && !ZUGANG.test(String(input.zugang ?? '').trim())) return 'zugang: Name des Linux-Fernzugangs';
    if (Object.values(input).some(istVerweis)) return undefined;
    try {
      if (['installieren', 'konfigurieren', 'login_anlegen', 'pruefdaten_anlegen'].includes(action)) pruefeTresorName(saName(String(input.zugang).trim()));
      if (action === 'platten_einrichten') plattenParameter(input);
      else if (action === 'installieren') installParameter(input);
      else if (action === 'konfigurieren') konfigWerte(input);
      else if (action === 'login_anlegen') { const p = loginParameter(input); loginTresorName(String(input.zugang), p.name); }
      else if (action === 'pruefdaten_anlegen') pruefdatenParameter(input);
    } catch (err) { return (err as Error).message.slice(0, 200); }
    return undefined;
  }

  async execute(input: Record<string, unknown>, context?: SkillContext): Promise<SkillResult> {
    const action = String(input.action ?? '');
    const zugang = String(input.zugang ?? '').trim();
    if (!LESEND.has(action) && !NUR_IM_CHANGE.has(action)) return { success: false, error: `Unbekannte Aktion ${action}` };
    if (NUR_IM_CHANGE.has(action) && (context as { ausChange?: boolean } | undefined)?.ausChange !== true) return { success: false, error: `${action} läuft nur als Schritt eines freigegebenen Changes` };
    if (!ZUGANG.test(zugang)) return { success: false, error: 'zugang: Name des Linux-Fernzugangs' };
    const geheim: string[] = [];
    try {
      switch (action) {
        case 'status': { const s = await this.status(zugang, geheim); return { success: true, data: s, display: linuxSqlStatusText(zugang, s) }; }
        case 'platten_einrichten': return await this.platten(zugang, input);
        case 'installieren': return await this.installieren(zugang, input, geheim);
        case 'konfigurieren': return await this.konfigurieren(zugang, input, geheim);
        case 'login_anlegen': return await this.login(zugang, input, geheim);
        case 'pruefdaten_anlegen': return await this.pruefdaten(zugang, input, geheim);
      }
    } catch (err) { return { success: false, error: schwaerze((err as Error).message, geheim).slice(0, 800) }; }
    return { success: false, error: 'Unbekannte Aktion' };
  }

  private async lauf<T extends Record<string, unknown>>(zugang: string, baustein: string, parameter: unknown, zweck: string, timeoutMs: number, eingabe?: Record<string, string>): Promise<T> {
    const r = await this.d.skript(zugang, baustein, parameter, eingabe ? JSON.stringify(eingabe) : undefined, timeoutMs, zweck);
    const e = sqlErgebnis<T>(r.stdout);
    if (r.code !== 0 || !e || e.zustand === 'fehler') {
      const grund = e && typeof e.fehler === 'string' ? e.fehler : `${r.stderr}\n${r.stdout}`.replace(/\s+/g, ' ').trim().slice(-500);
      throw new Error(`${zweck} auf ${zugang} gescheitert (Exit ${r.code}): ${grund || 'keine Ausgabe'}`);
    }
    return e;
  }

  private tresor() { if (!this.d.tresor) throw new Error('Tresor nicht verfügbar'); return this.d.tresor; }

  /** vorhandenen Eintrag lesen oder einmalig erzeugen */
  private async kennwort(name: string, wofuer: string, zweck: string, geheim: string[]): Promise<{ wert: string; neu: boolean }> {
    const t = this.tresor();
    if ((await t.namen()).has(name)) { const wert = await t.lies(name, wofuer); geheim.push(wert); return { wert, neu: false }; }
    const wert = linuxSqlKennwort(); geheim.push(wert);
    await t.setze(name, wert, zweck);
    return { wert, neu: true };
  }

  private async sa(zugang: string, wofuer: string, geheim: string[]): Promise<string> {
    const t = this.tresor(); const name = pruefeTresorName(saName(zugang));
    if (!(await t.namen()).has(name)) throw new Error(`Tresor-Eintrag ${name} fehlt — zuerst installieren`);
    const wert = await t.lies(name, wofuer); geheim.push(wert);
    return wert;
  }

  private async status(zugang: string, geheim: string[]): Promise<LinuxSqlStatus> {
    let eingabe: Record<string, string> | undefined;
    if (this.d.tresor) {
      const name = saName(zugang);
      if ((await this.d.tresor.namen()).has(name)) { const sa = await this.d.tresor.lies(name, `SQL-Status ${zugang}`); geheim.push(sa); eingabe = { sa }; }
    }
    return this.lauf<LinuxSqlStatus & Record<string, unknown>>(zugang, LINUX_SQL_BAUSTEINE.status, {}, 'SQL-Status', LINUX_SQL_ZEIT_MS.status, eingabe);
  }

  private async platten(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const p = plattenParameter(input);
    const r = await this.lauf<{ zustand: string; platten?: Array<{ geraet: string; ziel: string; aktion: string }> }>(zugang, LINUX_SQL_BAUSTEINE.platten, p, 'SQL-Platten einrichten', LINUX_SQL_ZEIT_MS.platten);
    const liste = (r.platten ?? []).map(x => `${x.geraet} → ${x.ziel} (${x.aktion})`).join(', ');
    this.d.protokoll?.('I8e SQL-Platten', { zugang, zustand: r.zustand });
    return { success: true, data: r, display: r.zustand === 'schon' ? `SQL-Platten auf ${zugang} schon eingerichtet: ${liste} — nichts zu tun` : `✅ SQL-Platten auf ${zugang}: ${liste}` };
  }

  private async installieren(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const p = installParameter(input);
    const name = pruefeTresorName(saName(zugang));
    const k = await this.kennwort(name, `SQL-Installation ${zugang}`, `sa-Kennwort von SQL Server auf ${zugang.toLowerCase()} (Linux)`, geheim);
    const r = await this.lauf<{ zustand: string; version?: string; edition?: string }>(zugang, LINUX_SQL_BAUSTEINE.installation, p, 'SQL Server installieren', LINUX_SQL_ZEIT_MS.installation, { sa: k.wert });
    this.d.protokoll?.('I8e SQL Server installiert', { zugang, zustand: r.zustand, version: r.version, saNeu: k.neu });
    const text = `SQL Server ${r.version ?? p.version} (${r.edition ?? 'Enterprise Developer'}) auf ${zugang}, Dienst aktiv; sa-Kennwort im Tresor (${name})`;
    return { success: true, data: { ...r, saTresor: name }, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text}` };
  }

  private async konfigurieren(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const w = konfigWerte(input);
    const sa = await this.sa(zugang, `SQL-Konfiguration ${zugang}`, geheim);
    let dateien = w.tempdb.dateien;
    if (dateien === undefined) {
      const s = await this.lauf<LinuxSqlStatus & Record<string, unknown>>(zugang, LINUX_SQL_BAUSTEINE.status, {}, 'SQL-Status (Kerne)', LINUX_SQL_ZEIT_MS.status, { sa });
      const kerne = s.sql?.kerne;
      if (typeof kerne !== 'number' || kerne < 1) throw new Error(`Kernzahl von ${zugang} nicht lesbar (${s.sqlHinweis ?? s.sqlFehler ?? 'keine SQL-Sicht'}) — tempdb_dateien angeben`);
      dateien = Math.min(8, kerne);
    }
    const tempdb: TempdbParameter = { ...w.tempdb, dateien };
    const ft = pruefeTempdb(tempdb); if (ft) throw new Error(`tempdb: ${ft}`);
    const k = await this.lauf<{ zustand: string; neustart?: boolean }>(zugang, LINUX_SQL_BAUSTEINE.konfiguration, w.konfig, 'SQL-Konfiguration (mssql-conf)', LINUX_SQL_ZEIT_MS.konfiguration);
    const t = await this.lauf<{ zustand: string; dateien?: number }>(zugang, LINUX_SQL_BAUSTEINE.tempdb, tempdb, 'tempdb einrichten', LINUX_SQL_ZEIT_MS.tempdb, { sa });
    const m = await this.lauf<{ zustand: string; maxSpeicherMb?: number }>(zugang, LINUX_SQL_BAUSTEINE.maxspeicher, { mb: w.maxMb }, 'max server memory', LINUX_SQL_ZEIT_MS.maxspeicher, { sa });
    const schon = [k, t, m].every(x => x.zustand === 'schon');
    const text = `SQL-Konfiguration auf ${zugang}: Speicherlimit ${w.konfig.speicherLimitMB} MB, max server memory ${m.maxSpeicherMb ?? w.maxMb} MB, tempdb ${t.dateien ?? dateien} Datendateien, Agent ${w.konfig.agent ? 'an' : 'aus'}${k.neustart ? ', Dienst neu gestartet' : ''}`;
    return { success: true, data: { konfiguration: k, tempdb: t, maxSpeicher: m }, display: schon ? `${text} — nichts zu tun` : `✅ ${text}` };
  }

  private async login(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const p = loginParameter(input);
    const name = loginTresorName(zugang, p.name);
    const sa = await this.sa(zugang, `SQL-Login ${p.name} auf ${zugang}`, geheim);
    const k = await this.kennwort(name, `SQL-Login ${p.name} auf ${zugang}`, `Kennwort des SQL-Logins ${p.name} auf ${zugang.toLowerCase()} (Linux)`, geheim);
    const r = await this.lauf<{ zustand: string }>(zugang, LINUX_SQL_BAUSTEINE.login, p, `SQL-Login ${p.name}`, LINUX_SQL_ZEIT_MS.login, { sa, kennwort: k.wert });
    const text = `SQL-Login ${p.name} auf ${zugang} (${p.serverrollen?.length ? p.serverrollen.join(', ') : 'ohne Serverrolle'}), Kennwort im Tresor (${name})`;
    return { success: true, data: { ...r, login: p.name, serverrollen: p.serverrollen, tresor: name }, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text} — ${r.zustand}` };
  }

  private async pruefdaten(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const p = pruefdatenParameter(input);
    const sa = await this.sa(zugang, `Prüfdaten ${p.datenbank} auf ${zugang}`, geheim);
    const r = await this.lauf<{ zustand: string; zeilen?: number; pruefsumme?: string }>(zugang, LINUX_SQL_BAUSTEINE.pruefdaten, p, `Prüfdaten ${p.datenbank}`, LINUX_SQL_ZEIT_MS.pruefdaten, { sa });
    if (r.zeilen !== PRUEFDATEN_ZEILEN || r.pruefsumme !== PRUEFDATEN_SHA256) throw new Error(`Prüfdaten ${p.datenbank}: ${String(r.zeilen)} Zeilen, Prüfsumme ${String(r.pruefsumme).slice(0, 64)} — erwartet ${PRUEFDATEN_ZEILEN}, ${PRUEFDATEN_SHA256}`);
    const text = `Prüfdaten in ${p.datenbank} auf ${zugang}: dbo.alfred_pruefung, ${r.zeilen} Zeilen, Prüfsumme ${r.pruefsumme}`;
    return { success: true, data: r, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text}` };
  }
}

/** Geheimnisse wörtlich aus Fehlermeldungen entfernen (zusätzlich zur Schwärzung im Transport) */
function schwaerze(t: string, geheim: string[]): string {
  return geheim.filter(g => g.length >= 4).reduce((a, g) => a.split(g).join('[geschwärzt]'), t);
}
