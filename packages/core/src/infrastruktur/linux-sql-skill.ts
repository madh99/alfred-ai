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
import {
  LINUX_SQL_SICHERUNG_BAUSTEINE, LINUX_SQL_SICHERUNG_ZEIT_MS, FS01_FQDN, pruefeSicherungEinrichten, pruefeSicherungJetzt, pruefeWiederherstellen,
  type SicherungEinrichtenParameter, type SicherungJetztParameter, type WiederherstellenParameter,
} from './linux-sql-sicherung.js';

/**
 * Fix-Welle I-1 — Mindest-zeitlimitS je Aktion (Sekunden): Baustein-Zeitgrenzen (am Host läuft jeder Baustein bis zu seiner Grenze)
 * + 60 s Puffer; konfigurieren = Summe der bis zu vier Bausteine (Status, mssql-conf, tempdb, max server memory).
 */
const sek = (ms: number) => Math.ceil(ms / 1000);
export const LINUX_SQL_MIN_ZEITLIMIT_S: Readonly<Record<string, number>> = {
  status: sek(LINUX_SQL_ZEIT_MS.status) + 60,
  platten_einrichten: sek(LINUX_SQL_ZEIT_MS.platten) + 60,
  installieren: sek(LINUX_SQL_ZEIT_MS.installation) + 60,
  // Nachtrag: bis zu vier Bausteine nacheinander — je Baustein 60 s Puffer
  konfigurieren: sek(LINUX_SQL_ZEIT_MS.status + LINUX_SQL_ZEIT_MS.konfiguration + LINUX_SQL_ZEIT_MS.tempdb + LINUX_SQL_ZEIT_MS.maxspeicher) + 4 * 60,
  login_anlegen: sek(LINUX_SQL_ZEIT_MS.login) + 60,
  pruefdaten_anlegen: sek(LINUX_SQL_ZEIT_MS.pruefdaten) + 60,
  sicherung_einrichten: sek(LINUX_SQL_SICHERUNG_ZEIT_MS.einrichten) + 60,
  sicherung_jetzt: sek(LINUX_SQL_SICHERUNG_ZEIT_MS.jetzt) + 60,
  sicherungen: sek(LINUX_SQL_SICHERUNG_ZEIT_MS.liste) + 60,
  wiederherstellen_pruefen: sek(LINUX_SQL_SICHERUNG_ZEIT_MS.wiederherstellen) + 60,
  kettengrenzen_uebernehmen: sek(LINUX_SQL_SICHERUNG_ZEIT_MS.grenzen) + 60,
};

export interface LinuxSqlDeps {
  /** Fernzugriff: registrierter Linux-Baustein auf einem Zugang (Geheimnisse nur in `eingabe`, eine Zeile JSON) */
  skript: (zugang: string, baustein: string, parameter: unknown, eingabe: string | undefined, timeoutMs: number, zweck: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  tresor?: { namen: () => Promise<Set<string>>; lies: (name: string, wofuer: string) => Promise<string>; setze: (name: string, wert: string, zweck: string) => Promise<void> };
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
}

/** lesende Aktionen (auch außerhalb eines Changes) */
export const LESEND = new Set(['status', 'sicherungen']);
const NUR_IM_CHANGE = new Set(['platten_einrichten', 'installieren', 'konfigurieren', 'login_anlegen', 'pruefdaten_anlegen',
  // I8e Task 4 — Sicherung nach fs01 und Wiederherstellungs-Beweis
  'sicherung_einrichten', 'sicherung_jetzt', 'wiederherstellen_pruefen',
  // Fix-Welle M-1 — Kettengrenzen nach Prüfung aus der Kopie auf fs01 übernehmen
  'kettengrenzen_uebernehmen']);
/** Standard-Tresor-Eintrag des fs01-Dienstkontos (windows_ad dienstkonto_anlegen konto svc-sqllnx-backup) */
export const SICHERUNG_KONTO_TRESOR = 'ad-svc-sqllnx-backup';
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
  /** I8e Task 4 — Zugangsdatei (nur Rechte), Kopier-Timer, letzter Kopierlauf */
  sicherung?: { zugangsdatei?: string; timer?: string; letzteKopie?: { zeit?: string | null; ok?: boolean; fehler?: string; alterMin?: number | null } | null } | null;
  /** Fix-Welle M-5/M-6 — Reste (alte tempdb-Dateien, Wegwerf-Ordner, Zugangsdateien): nur gemeldet, nie gelöscht */
  reste?: string[];
}

/** Zustand eines Berichtsalters: ok, zu alt (> 45 min oder unbekannt), Uhrzeit abweichend (aus der Zukunft, > 5 min) */
const altersText = (alterMin: number | null | undefined) => (typeof alterMin !== 'number' ? 'ZU ALT' : alterMin < -5 ? 'UHRZEIT ABWEICHEND' : alterMin > 45 ? 'ZU ALT' : undefined);
const resteText = (r: string[] | undefined) => (r?.length ? `; Reste: ${r.slice(0, 5).join(', ')}${r.length > 5 ? ` (+${r.length - 5})` : ''}` : '');

/** I8e Task 4 — Sicherungsteil des Statustexts (fester Wortlaut; Stücke in FESTE_AUSGABEN['linux_sql.status']) */
function sicherungText(s: LinuxSqlStatus): string {
  const x = s.sicherung;
  if (!x || (x.zugangsdatei === 'fehlt' && x.timer !== 'active')) return 'Sicherung: nicht eingerichtet';
  const k = x.letzteKopie;
  return `Sicherung: Zugangsdatei ${x.zugangsdatei ?? 'unbekannt'}, Kopie-Timer ${x.timer === 'active' ? 'aktiv' : x.timer ?? 'unbekannt'}, letzte Kopie ${k ? `${k.zeit ?? '?'} ${altersText(k.alterMin) ?? (k.ok ? 'ok' : `FEHLER ${(k.fehler ?? '').slice(0, 160)}`)}` : 'noch keine'}`;
}

const SYSTEM_DBS = new Set(['master', 'model', 'msdb', 'tempdb']);
/** Fester Wortlaut — Stücke stehen in FESTE_AUSGABEN['linux_sql.status'] (change-schritte.ts); bei Änderungen dort nachziehen */
export function linuxSqlStatusText(zugang: string, s: LinuxSqlStatus): string {
  const ein = (s.platz ?? []).filter(p => p.eingehaengt && (LINUX_SQL_ZIELE as readonly string[]).includes(p.pfad)).map(p => p.pfad.split('/').pop());
  const eingehaengt = `eingehängt: ${ein.length ? ein.join(', ') : 'keine Plattenziele'}`;
  const sich = sicherungText(s) + resteText(s.reste);
  if (!s.installiert) return `${zugang}: SQL Server nicht installiert; ${eingehaengt}; ${sich}`;
  const dienst = `Dienst ${s.dienst === 'active' ? 'aktiv' : s.dienst ?? 'unbekannt'}, ${s.aktiviert === 'enabled' ? 'aktiviert' : s.aktiviert ?? 'unbekannt'}`;
  const limit = `Speicherlimit ${s.konfig?.memorylimitmb ?? '-'} MB`;
  const q = s.sql;
  if (!q) return `${zugang}: SQL Server ${s.pakete?.['mssql-server'] ?? '?'} (Paket); ${dienst}; ${limit}; SQL-Sicht: ${(s.sqlHinweis ?? s.sqlFehler ?? 'keine').slice(0, 200)}; ${eingehaengt}; ${sich}`;
  const dateien = (q.tempdb ?? []).filter(t => t.typ === 'ROWS').length;
  const dbs = (q.datenbanken ?? []).map(d => d.name).filter(n => !SYSTEM_DBS.has(n.toLowerCase()));
  return `${zugang}: SQL Server ${q.version ?? '?'} ${q.cu ?? q.stufe ?? ''} ${q.edition ?? ''}; ${dienst}; ${limit}; max server memory ${q.maxSpeicherMb ?? '-'} MB; tempdb ${dateien} Datendateien; Datenbanken: ${dbs.length ? dbs.join(', ') : 'keine eigenen'}; ${eingehaengt}; ${sich}`;
}

// ── Sicherungen (I8e Task 4) ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LinuxSqlSicherungen {
  zustand: string; host?: string; ziel?: string; budgetBytes?: number; belegtBytes?: number | null; timer?: string; zugangsdatei?: string;
  status?: { zeit?: string; ok?: boolean; fehler?: string | null; befunde?: string[]; frisch?: boolean; alterMin?: number | null } | null;
  reste?: string[];
  datenbanken?: Record<string, { ketten: Array<{ full: string; diffs: number; logs: number; vollstaendig: boolean; fehler?: string[] }>; waisen?: string[];
    fs01Dateien: number; fs01Bytes?: number; fehlend?: number; lokalDateien?: number; lokalBytes?: number; ausstehend?: number }>;
}
const gib = (b: number | null | undefined) => (typeof b === 'number' ? (b / 2 ** 30).toFixed(1) : '?');
/**
 * Hash-Zustand je Datenbank (Fix-Runde 1): „Hash ok“ nur, wenn der letzte Kopierlauf gelang, mindestens eine Datei auf fs01 liegt, nichts
 * aussteht und nichts fehlt; „vollständig auf fs01“ zusätzlich nur mit lauter vollständigen Ketten.
 */
function hashText(st: LinuxSqlSicherungen['status'], d: NonNullable<LinuxSqlSicherungen['datenbanken']>[string], timer: string | undefined): string {
  if (!st) return 'Hash unbekannt (kein Kopierlauf)';
  // Fix-Runde 2 (Sicherheit): der Bericht des Timers zählt nur frisch (≤ 45 min) und mit aktivem Timer
  if (timer !== 'active') return 'Hash unbekannt (Kopie-Timer nicht aktiv)';
  if (!st.ok) return 'Hash unbekannt (letzter Kopierlauf fehlgeschlagen)';
  if (typeof st.alterMin === 'number' && st.alterMin < -5) return `Hash unbekannt (Uhrzeit abweichend: ${st.zeit ?? '?'})`;
  if (st.frisch !== true) return `Hash unbekannt (Kopierlauf zu alt: ${st.zeit ?? '?'})`;
  if (!d.fs01Dateien) return 'Hash unbekannt (nichts auf fs01)';
  if (d.fehlend) return `FEHLT auf fs01: ${d.fehlend}`;
  if (d.ausstehend) return `ausstehend: ${d.ausstehend}`;
  const voll = d.ketten.length > 0 && d.ketten.every(k => k.vollstaendig) && !d.waisen?.length;
  return voll ? 'Hash ok' : 'Hash ok, Ketten unvollständig';
}
/** Fester Wortlaut — Stücke in FESTE_AUSGABEN['linux_sql.sicherungen'] (change-schritte.ts) */
export function linuxSqlSicherungenText(zugang: string, r: LinuxSqlSicherungen): string {
  const st = r.status;
  const kopie = st ? `${st.zeit ?? '?'} ${st.ok ? 'ok' : `FEHLER: ${String(st.fehler ?? (st.befunde ?? []).join('; ')).slice(0, 300)}`}` : 'noch keine';
  const budget = typeof r.budgetBytes === 'number' ? String(Math.round(r.budgetBytes / 2 ** 30)) : '?';
  const dbs = Object.entries(r.datenbanken ?? {}).map(([db, d]) => {
    const voll = d.ketten.filter(k => k.vollstaendig).length;
    const letzte = d.ketten.length ? d.ketten[d.ketten.length - 1]!.full : 'keine';
    // Fix-Welle M-9: das positive Prüfstück nennt die Datenbank („<db>: vollständig auf fs01“)
    const h = hashText(st, d, r.timer);
    return `${db}: ${d.ketten.length} Ketten (${voll} vollständig), letzte FULL ${letzte}, lokal ${d.lokalDateien ?? 0}, fs01 ${d.fs01Dateien}, ${h}${h === 'Hash ok' ? ` — ${db}: vollständig auf fs01` : ''}`;
  });
  return `${zugang}: Sicherung nach ${r.ziel ?? '?'} (belegt ${gib(r.belegtBytes)} GiB von ${budget} GiB); Kopie zuletzt ${kopie}; Zugangsdatei ${r.zugangsdatei ?? 'unbekannt'}; Kopie-Timer ${r.timer === 'active' ? 'aktiv' : r.timer ?? 'unbekannt'}; ${dbs.length ? dbs.join('; ') : 'keine Datenbanken gesichert'}${resteText(r.reste)}`;
}

/** \\server.fqdn\Freigabe$ → { server, freigabe } */
const ZIEL_FREIGABE = /^\\\\([A-Za-z0-9.-]{3,120})\\([A-Za-z0-9_-]{1,40}\$?)$/;
/** Fix-Runde 1 (Sicherheit): nur Tresor-Einträge der fs01-Dienstkonten dieses Bausteins */
const KONTO_TRESOR = /^ad-svc-sqllnx-[a-z0-9-]{1,40}$/;
function sicherungEinrichtenParameter(input: Record<string, unknown>): { p: SicherungEinrichtenParameter; kontoTresor: string } {
  const zf = String(input.ziel_freigabe ?? '').trim();
  const m = ZIEL_FREIGABE.exec(zf);
  if (!m) throw new Error('ziel_freigabe: UNC-Pfad mit vollständigem Servernamen, z. B. \\\\fs01.ad.3033.at\\SQLLinuxBackup$');
  const server = m[1]!.toLowerCase(); const freigabe = m[2]!;
  if (server !== FS01_FQDN) throw new Error(`ziel_freigabe: nur der Dateiserver ${FS01_FQDN} (kein anderer Server)`);
  const kontoTresor = kontoTresorName(input);
  const k = String(input.konto ?? '').trim();
  let konto: string; let domaene: string;
  if (k) {
    const km = /^(?:([A-Za-z0-9][A-Za-z0-9.-]{0,62})\\)?([^\\]+)$/.exec(k);
    if (!km) throw new Error('konto: „name“ oder „NETBIOS\\name“ des Dienstkontos');
    konto = km[2]!; domaene = km[1] ?? server.slice(server.indexOf('.') + 1);
    // der Tresor-Eintrag gehört genau zu diesem Konto (ad-<konto>, wie windows_ad dienstkonto_anlegen)
    if (`ad-${konto.toLowerCase()}` !== kontoTresor) throw new Error(`konto_tresor: muss ad-${konto.toLowerCase()} sein (Tresor-Eintrag des Kontos ${konto})`);
  } else {
    konto = kontoTresor.slice(3); domaene = server.slice(server.indexOf('.') + 1);
  }
  // Fix-Runde 2: Standard 63 GiB — 1 GiB unter dem harten FSRM-Kontingent (64 GiB), damit Alfred das Budget meldet, bevor das Kontingent
  // Schreibvorgänge (auch das Manifest) abweist
  const budgetGiB = ganzzahl(input.budget_gib ?? 63) as number;
  const p: SicherungEinrichtenParameter = { server, freigabe, konto, domaene, budgetGiB };
  if (input.cifs_version !== undefined) p.cifsVersion = String(input.cifs_version).trim();
  const f = pruefeSicherungEinrichten(p);
  if (f) throw new Error(f.replace(/^budgetGiB/, 'budget_gib').replace(/^cifsVersion/, 'cifs_version').replace(/^server/, 'ziel_freigabe (Server)').replace(/^freigabe/, 'ziel_freigabe (Freigabe)'));
  return { p, kontoTresor };
}

function sicherungJetztParameter(input: Record<string, unknown>): SicherungJetztParameter {
  const p = { art: String(input.art ?? '').trim().toUpperCase(), datenbank: String(input.datenbank ?? '').trim() } as SicherungJetztParameter;
  const f = pruefeSicherungJetzt(p); if (f) throw new Error(f.replace(/^art: FULL, DIFF oder LOG/, 'art: full, diff oder log'));
  return p;
}

function wiederherstellenParameter(input: Record<string, unknown>): WiederherstellenParameter {
  const datenbank = String(input.datenbank ?? '').trim();
  const p = { datenbank, ziel: input.ziel_name === undefined ? `alfred_wh_${datenbank}`.slice(0, 63) : String(input.ziel_name).trim() };
  const f = pruefeWiederherstellen(p); if (f) throw new Error(f.replace(/^ziel/, 'ziel_name'));
  return p;
}

function kontoTresorName(input: Record<string, unknown>): string {
  const n = String(input.konto_tresor ?? SICHERUNG_KONTO_TRESOR).trim();
  if (!KONTO_TRESOR.test(n) || !TRESOR_NAME.test(n)) throw new Error('konto_tresor: nur ad-svc-sqllnx-… (Tresor-Eintrag des fs01-Dienstkontos, Standard ad-svc-sqllnx-backup)');
  return n;
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
    datenPfad: KURZZIEL.data!, logPfad: KURZZIEL.log!, sicherungsPfad: KURZZIEL.backup!, agent: input.agent === undefined ? true : input.agent as boolean,
  };
  // Fix-Welle M-4: Wahrheitswerte nur als true/false — „false“ als Text würde sonst still als true/false gedeutet
  if (input.agent !== undefined && typeof input.agent !== 'boolean') throw new Error('agent: nur true oder false (Wahrheitswert, kein Text)');
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
      + 'SICHERUNG (I8e Task 4; vorher auf fs01: windows_ad dienstkonto_anlegen konto svc-sqllnx-backup und windows_cluster freigabe_anlegen name SQLLinuxBackup$ pfad S:\\SQLLinuxBackup aendern <NETBIOS>\\svc-sqllnx-backup kontingent_gib 64; Firewall SQL-Zone → fs01 TCP 445): '
      + 'sicherung_einrichten (zugang, ziel_freigabe = \\\\fs01.ad.3033.at\\SQLLinuxBackup$, konto_tresor Standard ad-svc-sqllnx-backup, konto optional „NETBIOS\\name“, budget_gib Standard 63 = 1 GiB unter dem FSRM-Kontingent 64) — SQL-Agent-Jobs FULL täglich 00:30, DIFF alle 6 h, LOG alle 15 min (CHECKSUM, COMPRESSION) nach /var/opt/mssql/backup/<db>/, Kopier-Timer alle 15 min nach fs01 (SMB 3.1.1 verschlüsselt, SHA-256 zurückgelesen, nie überschrieben), Aufbewahrung 7 Tage + 4 Sonntage nur ganzer vollständiger Ketten, Budget-Überschreitung = Fehler ohne Löschen; einzige dauerhafte Zugangsdatei /etc/alfred/sqllnx-cifs.cred (0600 root); prüft sich selbst mit einem Kopierlauf. '
      + 'sicherung_jetzt (zugang, art full|diff|log, datenbank) — eine Sicherung in derselben Kette, danach auf fs01 bestätigt. '
      + 'wiederherstellen_pruefen (zugang, datenbank, ziel_name Standard alfred_wh_<datenbank>) — letzte vollständige Kette FULL+DIFF+LOGs AUS DER fs01-KOPIE unter ziel_name, DBCC CHECKDB, Prüfdaten-Vergleich → „RESTORE_VERIFIED“ nur wenn alles stimmt; ziel_name wird danach entfernt (Schritt-zeitlimitS großzügig, z. B. 3600). '
      + 'sicherungen (lesend, auch außerhalb von Changes; zugang; liest keinen Tresor und nicht fs01 — lokaler Stand und Bericht des letzten Kopierlaufs, der fs01 prüft) — Wortlaut „<zugang>: Sicherung nach //fs01.ad.3033.at/<freigabe> (belegt <x> GiB von <y> GiB); Kopie zuletzt <zeit> ok; Zugangsdatei vorhanden (0600); Kopie-Timer aktiv; <db>: <n> Ketten (<m> vollständig), letzte FULL …, lokal <a>, fs01 <b>, Hash ok, vollständig auf fs01“ (sonst „Hash unbekannt …“, „ausstehend: <n>“, „FEHLT auf fs01: <n>“; Befunde des Kopierlaufs stehen hinter „Kopie zuletzt <zeit> FEHLER:“), als Prüfung z. B. erwartet „vollständig auf fs01“ oder „Kopie-Timer aktiv“. Ziel ist nur fs01.ad.3033.at, konto_tresor nur ad-svc-sqllnx-…. '
      + `Mindest-zeitlimitS je Schritt (Baustein-Zeitgrenzen + 60 s): ${Object.entries(LINUX_SQL_MIN_ZEITLIMIT_S).map(([a, sk]) => `${a} ${sk} s`).join(', ')}. `
      + 'kettengrenzen_uebernehmen (nur im Change; zugang, konto_tresor optional) — nur wenn sicherungen/status „lokale Kettengrenzen fehlen“ meldet: übernimmt nach Prüfung die Grenzen gelöschter Ketten aus der Kopie auf fs01 in die lokale Aufzeichnung und nennt den Unterschied. '
      + 'Alle Aktionen sind wiederholbar („nichts zu tun“) und prüfen ihr Ergebnis selbst. Ohne Rückweg nur beim Neuaufbau: derselbe Change stellt die VM vorher mit proxmox.provision_vm bereit (Rückweg = VM löschen) oder ohneSicherungGrund ist gesetzt — sonst vorher sichern und rueckweg angeben.',
    riskLevel: 'admin',
    version: '1.0.0',
    timeoutMs: 3_600_000,
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
        datenbank: { type: 'string', description: 'pruefdaten_anlegen/sicherung_jetzt/wiederherstellen_pruefen: Name der Datenbank' },
        ziel_freigabe: { type: 'string', description: 'sicherung_einrichten: UNC der fs01-Freigabe, z. B. \\\\fs01.ad.3033.at\\SQLLinuxBackup$' },
        konto_tresor: { type: 'string', description: 'Tresor-Eintrag mit dem Kennwort des fs01-Dienstkontos (Standard ad-svc-sqllnx-backup)' },
        konto: { type: 'string', description: 'sicherung_einrichten: optional Dienstkonto „NETBIOS\\name“ (Standard aus konto_tresor ad-<name>, Domäne aus dem Servernamen)' },
        budget_gib: { type: 'number', description: 'sicherung_einrichten: Budget auf fs01 in GiB (Standard 63, unter dem FSRM-Kontingent 64)' },
        cifs_version: { type: 'string', description: 'sicherung_einrichten: apt-Version von cifs-utils (Standard fest)' },
        art: { type: 'string', enum: ['full', 'diff', 'log'], description: 'sicherung_jetzt: Art der Sicherung' },
        // (kettengrenzen_uebernehmen nutzt zugang und konto_tresor)
        ziel_name: { type: 'string', description: 'wiederherstellen_pruefen: Name der Wegwerf-Datenbank, alfred_wh_… (Standard alfred_wh_<datenbank>)' },
      },
      required: ['action', 'zugang'],
    },
  };

  constructor(private readonly d: LinuxSqlDeps) { super(); }

  /** Fix-Welle I-1: Mindest-zeitlimitS eines Change-Schritts (Planprüfung) */
  mindestZeitlimitS(aktion: string): number | undefined { return LINUX_SQL_MIN_ZEITLIMIT_S[aktion]; }

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
      else if (action === 'sicherung_einrichten') sicherungEinrichtenParameter(input);
      else if (action === 'sicherung_jetzt') sicherungJetztParameter(input);
      else if (action === 'wiederherstellen_pruefen') { wiederherstellenParameter(input); kontoTresorName(input); }
      else if (action === 'kettengrenzen_uebernehmen') kontoTresorName(input);
      if (['sicherung_einrichten', 'sicherung_jetzt', 'wiederherstellen_pruefen'].includes(action)) pruefeTresorName(saName(String(input.zugang).trim()));
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
        case 'sicherung_einrichten': return await this.sicherungEinrichten(zugang, input, geheim);
        case 'sicherung_jetzt': return await this.sicherungJetzt(zugang, input, geheim);
        case 'sicherungen': return await this.sicherungen(zugang);
        case 'wiederherstellen_pruefen': return await this.wiederherstellen(zugang, input, geheim);
        case 'kettengrenzen_uebernehmen': return await this.kettengrenzen(zugang, input, geheim);
      }
    } catch (err) { return { success: false, error: schwaerze((err as Error).message, geheim).slice(0, 800) }; }
    return { success: false, error: 'Unbekannte Aktion' };
  }

  private async lauf<T extends Record<string, unknown>>(zugang: string, baustein: string, parameter: unknown, zweck: string, timeoutMs: number, eingabe?: Record<string, string>): Promise<T> {
    return this.pruefeLauf<T>(zugang, zweck, await this.d.skript(zugang, baustein, parameter, eingabe ? JSON.stringify(eingabe) : undefined, timeoutMs, zweck));
  }

  private pruefeLauf<T extends Record<string, unknown>>(zugang: string, zweck: string, r: { code: number; stdout: string; stderr: string }): T {
    const e = sqlErgebnis<T>(r.stdout);
    if (r.code !== 0 || !e || e.zustand === 'fehler') {
      const grund = e && typeof e.fehler === 'string' ? e.fehler : `${r.stderr}\n${r.stdout}`.replace(/\s+/g, ' ').trim().slice(-500);
      throw new Error(`${zweck} auf ${zugang} gescheitert (Exit ${r.code}): ${grund || 'keine Ausgabe'}`);
    }
    return e;
  }

  private tresor() { if (!this.d.tresor) throw new Error('Tresor nicht verfügbar'); return this.d.tresor; }

  /** vorhandenen Eintrag lesen oder ein neues Kennwort erzeugen — der Aufrufer legt es erst nach Erfolg im Tresor ab (Fix-Welle I-2) */
  private async vorhandenOderNeu(name: string, wofuer: string, geheim: string[]): Promise<{ wert: string; neu: boolean }> {
    const t = this.tresor();
    if ((await t.namen()).has(name)) { const wert = await t.lies(name, wofuer); geheim.push(wert); return { wert, neu: false }; }
    const wert = linuxSqlKennwort(); geheim.push(wert);
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
    // Fix-Welle I-2: ein neues sa-Kennwort kommt erst nach gelungenem Setup in den Tresor (Marke ALFRED-SA-GESETZT, auch wenn ein späterer
    // Schritt scheitert); ist SQL Server schon installiert und fehlt der Tresor-Eintrag, bricht der Baustein ohne Änderung ab
    const k = await this.vorhandenOderNeu(name, `SQL-Installation ${zugang}`, geheim);
    const roh = await this.d.skript(zugang, LINUX_SQL_BAUSTEINE.installation, { ...p, saNeu: k.neu }, JSON.stringify({ sa: k.wert }), LINUX_SQL_ZEIT_MS.installation, 'SQL Server installieren');
    const gesetzt = roh.stdout.split(/\r?\n/).some(z => z.trim() === 'ALFRED-SA-GESETZT');
    const ok = roh.code === 0 && sqlErgebnis<{ zustand?: string }>(roh.stdout)?.zustand !== 'fehler' && !!sqlErgebnis(roh.stdout);
    if (k.neu && (ok || gesetzt)) await this.tresor().setze(name, k.wert, `sa-Kennwort von SQL Server auf ${zugang.toLowerCase()} (Linux)`);
    const r = this.pruefeLauf<{ zustand: string; version?: string; edition?: string }>(zugang, 'SQL Server installieren', roh);
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
    const t = await this.lauf<{ zustand: string; dateien?: number; altdateien?: string[] }>(zugang, LINUX_SQL_BAUSTEINE.tempdb, tempdb, 'tempdb einrichten', LINUX_SQL_ZEIT_MS.tempdb, { sa });
    const m = await this.lauf<{ zustand: string; maxSpeicherMb?: number }>(zugang, LINUX_SQL_BAUSTEINE.maxspeicher, { mb: w.maxMb }, 'max server memory', LINUX_SQL_ZEIT_MS.maxspeicher, { sa });
    const schon = [k, t, m].every(x => x.zustand === 'schon');
    const text = `SQL-Konfiguration auf ${zugang}: Speicherlimit ${w.konfig.speicherLimitMB} MB, max server memory ${m.maxSpeicherMb ?? w.maxMb} MB, tempdb ${t.dateien ?? dateien} Datendateien, Agent ${w.konfig.agent ? 'an' : 'aus'}${k.neustart ? ', Dienst neu gestartet' : ''}${t.altdateien?.length ? `; alte tempdb-Dateien liegen noch (nicht gelöscht): ${t.altdateien.join(', ')}` : ''}`;
    return { success: true, data: { konfiguration: k, tempdb: t, maxSpeicher: m }, display: schon ? `${text} — nichts zu tun` : `✅ ${text}` };
  }

  private async login(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const p = loginParameter(input);
    const name = loginTresorName(zugang, p.name);
    const sa = await this.sa(zugang, `SQL-Login ${p.name} auf ${zugang}`, geheim);
    // Fix-Welle I-2: fehlt der Tresor-Eintrag, darf es den Login noch nicht geben (nurNeu); das Kennwort kommt erst nach Erfolg in den Tresor
    const k = await this.vorhandenOderNeu(name, `SQL-Login ${p.name} auf ${zugang}`, geheim);
    const r = await this.lauf<{ zustand: string }>(zugang, LINUX_SQL_BAUSTEINE.login, { ...p, nurNeu: k.neu }, `SQL-Login ${p.name}`, LINUX_SQL_ZEIT_MS.login, { sa, kennwort: k.wert });
    if (k.neu) await this.tresor().setze(name, k.wert, `Kennwort des SQL-Logins ${p.name} auf ${zugang.toLowerCase()} (Linux)`);
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

  // ── I8e Task 4 — Sicherung ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Kennwort des fs01-Dienstkontos (windows_ad dienstkonto_anlegen) — muss es schon geben */
  private async fs01Kennwort(name: string, wofuer: string, geheim: string[]): Promise<string> {
    const t = this.tresor();
    if (!(await t.namen()).has(name)) throw new Error(`Tresor-Eintrag ${name} fehlt — zuerst auf fs01-Seite windows_ad dienstkonto_anlegen (konto ${name.replace(/^ad-/, '')})`);
    const w = await t.lies(name, wofuer); geheim.push(w);
    return w;
  }

  private async sicherungEinrichten(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const { p, kontoTresor } = sicherungEinrichtenParameter(input);
    const sa = await this.sa(zugang, `Sicherung einrichten ${zugang}`, geheim);
    const kennwort = await this.fs01Kennwort(kontoTresor, `Sicherung ${zugang} → //${p.server}/${p.freigabe}`, geheim);
    const r = await this.lauf<{ zustand: string; jobs?: number; timer?: string; zugangsdatei?: string; ziel?: string; budgetBytes?: number; belegtBytes?: number }>(
      zugang, LINUX_SQL_SICHERUNG_BAUSTEINE.einrichten, p, 'Sicherung einrichten', LINUX_SQL_SICHERUNG_ZEIT_MS.einrichten, { sa, kennwort });
    if (r.jobs !== 3 || r.zugangsdatei !== 'vorhanden (0600)' || r.timer !== 'aktiv') throw new Error(`Sicherung auf ${zugang}: Nachprüfung fehlgeschlagen (Jobs ${String(r.jobs)}, Zugangsdatei ${String(r.zugangsdatei)}, Timer ${String(r.timer)})`);
    this.d.protokoll?.('I8e Sicherung eingerichtet', { zugang, zustand: r.zustand, ziel: `//${p.server}/${p.freigabe}` });
    const text = `Sicherung auf ${zugang}: 3 Agent-Jobs (FULL täglich, DIFF 6 h, LOG 15 min), Kopie alle 15 min nach //${p.server}/${p.freigabe} als ${p.domaene}\\${p.konto} (Budget ${p.budgetGiB} GiB, belegt ${gib(r.belegtBytes)} GiB); Zugangsdatei ${r.zugangsdatei}; Kopie-Timer aktiv; Probe-Kopie ok`;
    return { success: true, data: r, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text}` };
  }

  private async sicherungJetzt(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const p = sicherungJetztParameter(input);
    const sa = await this.sa(zugang, `Sicherung ${p.art} ${p.datenbank} auf ${zugang}`, geheim);
    const r = await this.lauf<{ zustand: string; datei?: string; sha256?: string; fs01?: boolean }>(zugang, LINUX_SQL_SICHERUNG_BAUSTEINE.jetzt, p, `Sicherung ${p.art} ${p.datenbank}`, LINUX_SQL_SICHERUNG_ZEIT_MS.jetzt, { sa });
    if (r.fs01 !== true || !r.datei) throw new Error(`Sicherung ${p.art} von ${p.datenbank} auf ${zugang}: Kopie auf fs01 nicht bestätigt`);
    return { success: true, data: r, display: `✅ Sicherung ${p.art} von ${p.datenbank} auf ${zugang}: ${r.datei} — auf fs01 geprüft (SHA-256 ${String(r.sha256 ?? '').slice(0, 16)}…)` };
  }

  /** Fix-Welle M-1 — lokale Kettengrenzen aus der Kopie auf fs01 übernehmen (nur im Change, nach Prüfung); zeigt den Unterschied */
  private async kettengrenzen(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const name = kontoTresorName(input);
    const kennwort = await this.fs01Kennwort(name, `Kettengrenzen ${zugang} (fs01 lesen)`, geheim);
    type Grenze = { full: string; ersterBezug?: string | null; letztes?: string | null };
    const r = await this.lauf<{ zustand: string; unterschied?: Array<{ datenbank: string; lokal: number; fs01: number; grenzen?: Grenze[] }> }>(zugang, LINUX_SQL_SICHERUNG_BAUSTEINE.grenzen, {}, 'Kettengrenzen übernehmen', LINUX_SQL_SICHERUNG_ZEIT_MS.grenzen, { kennwort });
    // Nachtrag N-1: übernommene Grenzen einzeln nennen; sie sperren nur das erneute Kopieren
    const u = (r.unterschied ?? []).map(x => `${x.datenbank}: lokal ${x.lokal} → fs01 ${x.fs01} (übernommen: ${(x.grenzen ?? []).map(g => `${g.full} (Bezug ${g.ersterBezug ?? '-'}, letztes ${g.letztes ?? '-'})`).join(', ')})`);
    return { success: true, data: r, display: u.length ? `✅ Kettengrenzen auf ${zugang} übernommen: ${u.join('; ')} — sie sperren nur das erneute Kopieren; Ketten bis zur neuesten übernommenen Grenze bleiben unangetastet (Aufbewahrung dort ausgesetzt), lokale Dateien dieser Ketten werden nie auf dieser Grundlage gelöscht` : `Kettengrenzen auf ${zugang} stimmen mit fs01 überein — nichts zu tun` };
  }

  /** Fix-Runde 1 (Sicherheit): lesend ohne Tresor — lokaler Stand und Bericht des letzten Kopierlaufs (der Timer prüft fs01) */
  private async sicherungen(zugang: string): Promise<SkillResult> {
    const r = await this.lauf<LinuxSqlSicherungen & Record<string, unknown>>(zugang, LINUX_SQL_SICHERUNG_BAUSTEINE.liste, {}, 'Sicherungen lesen', LINUX_SQL_SICHERUNG_ZEIT_MS.liste);
    return { success: true, data: r, display: linuxSqlSicherungenText(zugang, r) };
  }

  private async wiederherstellen(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const p = wiederherstellenParameter(input);
    const name = kontoTresorName(input);
    const sa = await this.sa(zugang, `Wiederherstellungs-Beweis ${p.datenbank} auf ${zugang}`, geheim);
    const kennwort = await this.fs01Kennwort(name, `Wiederherstellungs-Beweis ${zugang} (fs01 lesen)`, geheim);
    const r = await this.lauf<{ zustand: string; ergebnis?: string; kette?: string; diff?: boolean; logs?: number; checkdb?: string; zeilen?: number; pruefsumme?: string; entfernt?: boolean }>(
      zugang, LINUX_SQL_SICHERUNG_BAUSTEINE.wiederherstellen, p, `Wiederherstellungs-Beweis ${p.datenbank}`, LINUX_SQL_SICHERUNG_ZEIT_MS.wiederherstellen, { sa, kennwort });
    // RESTORE_VERIFIED nur, wenn auch der Skill alle Bedingungen sieht (Baustein-Ergebnis allein genügt nicht)
    const ok = r.ergebnis === 'RESTORE_VERIFIED' && r.checkdb === 'ohne Befund' && r.zeilen === PRUEFDATEN_ZEILEN && r.pruefsumme === PRUEFDATEN_SHA256 && r.entfernt === true && (r.logs ?? 0) >= 1;
    if (!ok) throw new Error(`Wiederherstellungs-Beweis ${p.datenbank} auf ${zugang} NICHT bestanden: Ergebnis ${String(r.ergebnis)}, CHECKDB ${String(r.checkdb)}, ${String(r.zeilen)} Zeilen, Prüfsumme ${String(r.pruefsumme).slice(0, 64)}, entfernt ${String(r.entfernt)}`);
    this.d.protokoll?.('I8e Restore-Beweis', { zugang, datenbank: p.datenbank, kette: r.kette, ergebnis: r.ergebnis });
    return { success: true, data: r, display: `✅ RESTORE_VERIFIED ${p.datenbank} auf ${zugang}: Kette ${r.kette} aus der fs01-Kopie (FULL${r.diff ? ' + DIFF' : ''} + ${r.logs} LOG) als ${p.ziel}, DBCC CHECKDB ohne Befund, Prüfdaten ${r.zeilen} Zeilen / ${String(r.pruefsumme).slice(0, 16)}… gleich; ${p.ziel} wieder entfernt` };
  }
}

/** Geheimnisse wörtlich aus Fehlermeldungen entfernen (zusätzlich zur Schwärzung im Transport) */
function schwaerze(t: string, geheim: string[]): string {
  return geheim.filter(g => g.length >= 4).reduce((a, g) => a.split(g).join('[geschwärzt]'), t);
}
