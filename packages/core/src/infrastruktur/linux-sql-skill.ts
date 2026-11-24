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
  LINUX_SQL_BAUSTEINE, LINUX_SQL_ZEIT_MS, LINUX_SQL_ZIELE, ZEITQUELLE_DCS, ZEITQUELLE_DROPIN, TEMPDB_PFAD_DATEN, type TempdbPfad, PRUEFDATEN_SHA256, PRUEFDATEN_ZEILEN, sqlErgebnis,
  pruefePlatten, pruefeInstallation, pruefeKonfig, pruefeTempdb, pruefeMaxSpeicher, pruefeLogin, pruefePruefdaten,
  type LinuxSqlZiel, type PlattenParameter, type InstallParameter, type KonfigParameter, type TempdbParameter, type LoginParameter,
} from './linux-sql.js';
import { NAME as TRESOR_NAME } from './tresor.js';
import { sicherungsLageText, type SicherungsLage } from './sql-sicherung-lage.js';
import {
  LINUX_SQL_SICHERUNG_BAUSTEINE, LINUX_SQL_SICHERUNG_ZEIT_MS, FS01_FQDN, pruefeSicherungEinrichten, pruefeSicherungJetzt, pruefeWiederherstellen,
  type SicherungEinrichtenParameter, type SicherungJetztParameter, type WiederherstellenParameter,
} from './linux-sql-sicherung.js';
import {
  LINUX_AD, LINUX_AD_PAKETE, AD_NIE_BEITRETEN, pruefeAdBeitreten, pruefeAdVerlassen, type AdBeitretenParameter,
  KERBEROS_KONTO_TRESOR, KERBEROS_SPNS, KERBEROS_HOSTS, SQL_KEYTAB, SQL_KERBEROS_KONTO, kerberosParameter, pruefeKerberos, type KerberosParameter,
  AD_LOGINS_DATEI, AD_LOGIN_DB_ROLLEN, adLoginName, pruefeAdLogin, type AdLoginParameter,
} from './linux-sql-ad.js';
import { joinTresorName } from './windows-ad-linux.js';
import { tlsParameter, tlsEingabe, erwarteteRoot, TLS_ANFORDERN_GRUND, TLS_HOSTS, TLS_CRT, TLS_CRT_ALT, TLS_KEY, TLS_KEY_NEU, TLS_MIN_TAGE, TLS_BITS, TLS_PROTOKOLLE, TLS_PRUEF_SCHALTER, pruefeTlsPruefung, pruefeTlsErzwingen, type TlsParameter, type TlsPruefungParameter, type TlsErzwingenParameter } from './linux-sql-tls.js';
import { csrSha256, pruefeCsrForm } from './windows-sqltls-linux.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pruefeSaSchalten } from './linux-sql-logins.js';
import { pruefeSqlUpdate, SQL_UPDATE_OHNE_RUECKWEG } from './linux-sql-update.js';
import { SA_SPERRE } from './linux-sql.js';
import { saName, sqlAnmeldung, alfredLoginTresor, ADMIN_LOGIN, STATUS_LOGIN, type SqlLogin } from './linux-sql-anmeldung.js';

/**
 * Fix-Welle I-1 — Mindest-zeitlimitS je Aktion (Sekunden): Baustein-Zeitgrenzen (am Host läuft jeder Baustein bis zu seiner Grenze)
 * + 60 s Puffer; konfigurieren = Summe der bis zu vier Bausteine (Status, mssql-conf, tempdb, max server memory).
 */
const sek = (ms: number) => Math.ceil(ms / 1000);
/** I8e Folge-Etappe (Review I5): Login des laufenden execute-Aufrufs (für den Ergebnis-Zusatz), je Aufruf getrennt */
const ANMELDE_KONTEXT = new AsyncLocalStorage<{ login?: SqlLogin }>();
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
  reste_entfernen: sek(LINUX_SQL_ZEIT_MS.resteEntfernen) + 60,
  ad_beitreten: sek(LINUX_SQL_ZEIT_MS.adBeitreten) + 60,
  ad_verlassen: sek(LINUX_SQL_ZEIT_MS.adVerlassen) + 60,
  zeitquelle_einrichten: sek(LINUX_SQL_ZEIT_MS.zeitquelleEinrichten) + 60,
  zeitquelle_entfernen: sek(LINUX_SQL_ZEIT_MS.zeitquelleEntfernen) + 60,
  kerberos_einrichten: sek(LINUX_SQL_ZEIT_MS.kerberosEinrichten) + 60,
  kerberos_entfernen: sek(LINUX_SQL_ZEIT_MS.kerberosEntfernen) + 60,
  tls_anfordern: sek(LINUX_SQL_ZEIT_MS.tlsAnfordern) + 60,
  tls_einspielen: sek(LINUX_SQL_ZEIT_MS.tlsEinspielen) + 60,
  tls_entfernen: sek(LINUX_SQL_ZEIT_MS.tlsEntfernen) + 60,
  tls_pruefung_schalten: sek(LINUX_SQL_ZEIT_MS.tlsPruefungSchalten) + 60,
  tls_erzwingen: sek(LINUX_SQL_ZEIT_MS.tlsErzwingen) + 60,
  tls_pfad_umstellen: sek(LINUX_SQL_ZEIT_MS.tlsPfadUmstellen) + 60,
  ad_login: sek(LINUX_SQL_ZEIT_MS.adLogin) + 60,
  ad_login_entfernen: sek(LINUX_SQL_ZEIT_MS.adLoginEntfernen) + 60,
  alfred_logins_anlegen: sek(LINUX_SQL_ZEIT_MS.alfredLoginsAnlegen) + 60,
  alfred_logins_entfernen: sek(LINUX_SQL_ZEIT_MS.alfredLoginsEntfernen) + 60,
  sa_schalten: sek(LINUX_SQL_ZEIT_MS.saSchalten) + 60,
  jobverlauf_recht: sek(LINUX_SQL_ZEIT_MS.jobverlaufRecht) + 60,
  aktualisieren: sek(LINUX_SQL_ZEIT_MS.aktualisieren) + 60,
  sa_kennwort_setzen: sek(LINUX_SQL_ZEIT_MS.saKennwortSetzen) + 60,
};

export interface LinuxSqlDeps {
  /** Fernzugriff: registrierter Linux-Baustein auf einem Zugang (Geheimnisse nur in `eingabe`, eine Zeile JSON) */
  skript: (zugang: string, baustein: string, parameter: unknown, eingabe: string | undefined, timeoutMs: number, zweck: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  tresor?: {
    namen: () => Promise<Set<string>>; lies: (name: string, wofuer: string) => Promise<string>; setze: (name: string, wert: string, zweck: string) => Promise<void>;
    /** I8e Etappe 3 Task 4 — verbrauchtes Einmal-Kennwort (ad-join-<name>) nach gelungenem Beitritt entfernen */
    entferne?: (name: string) => Promise<boolean>;
  };
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
}

/** lesende Aktionen (auch außerhalb eines Changes) */
export const LESEND = new Set(['status', 'sicherungen']);
const NUR_IM_CHANGE = new Set(['platten_einrichten', 'installieren', 'konfigurieren', 'login_anlegen', 'pruefdaten_anlegen',
  // I8e Task 4 — Sicherung nach fs01 und Wiederherstellungs-Beweis
  'sicherung_einrichten', 'sicherung_jetzt', 'wiederherstellen_pruefen',
  // Fix-Welle M-1 — Kettengrenzen nach Prüfung aus der Kopie auf fs01 übernehmen
  'kettengrenzen_uebernehmen',
  // Owner 19.11.2026 — alte tempdb-Dateien entfernen (fail-closed, jede Datei gemeldet)
  'reste_entfernen',
  // I8e Etappe 3 Task 4 — Domänenbeitritt mit Einmal-Kennwort und lokaler Rückweg
  'ad_beitreten', 'ad_verlassen',
  // Ruling R11 — Zeitquelle an den DCs (alle drei Hosts) und Rückweg
  'zeitquelle_einrichten', 'zeitquelle_entfernen',
  // I8e Etappe 3 Task 5 — Keytab der SQL-Instanz (Kennwort svc-sqllnx nur über stdin) und Rückweg
  'kerberos_einrichten', 'kerberos_entfernen',
  // I8e Etappe 3 Task 6 — TLS: Schlüssel + Anforderung auf dem Host, Zertifikat geprüft einspielen, Rückweg
  'tls_anfordern', 'tls_einspielen', 'tls_entfernen',
  // I8e Etappe 3 Task 7 — Zertifikatsprüfung bei Alfreds eigenen SQL-Verbindungen je Host schalten (Rückweg = an umgekehrt)
  'tls_pruefung_schalten',
  // I8e Etappe 3 Task 8 — Verschlüsselung erzwingen (Rückweg = an umgekehrt), AD-Gruppen-Logins und Rückweg
  'tls_erzwingen', 'ad_login', 'ad_login_entfernen',
  // Microsoft #979 — öffentliches Zertifikat aus secrets in den eigenen Ordner (Rückweg an umgekehrt)
  'tls_pfad_umstellen',
  // I8e Folge-Etappe — eigene Alfred-Logins (Rückweg entfernen), sa schalten (Rückweg an umgekehrt), Notfallweg sa-Kennwort setzen
  'alfred_logins_anlegen', 'alfred_logins_entfernen', 'sa_schalten', 'sa_kennwort_setzen', 'jobverlauf_recht',
  // Owner 23./24.11. — SQL-Server-Update (CU) je Knoten im Standby, rollierend (kein Rückweg: Downgrade wird nicht unterstützt)
  'aktualisieren']);
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

export { saName };
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
    tempdb?: Array<{ name: string; typ: string }> | null;
    /** Überwachung 23.11.: Alter der letzten Sicherung in Minuten (DATEDIFF auf dem Server, zeitzonenfrei; null = nie), gruppe = group_database_id (AG) */
    datenbanken?: Array<{ name: string; modell?: string; zustand?: string; gruppe?: string | null; alterVollMin?: number | null; alterLogMin?: number | null }> | null;
    /** I8e Folge-Etappe: sa abgeschaltet (0/1), vorhandene Alfred-Logins */
    saAbgeschaltet?: number | null; alfredLogins?: Array<{ name: string }> | null } & SicherungsLage | null;
  sqlHinweis?: string; sqlFehler?: string;
  /** I8e Folge-Etappe: Login der Status-Anmeldung und ob sie gelang (Überwachung); Host-Marke SA_SPERRE vorhanden */
  anmeldung?: { login: string; ok: boolean } | null;
  saMarke?: boolean;
  /** Überwachung 23.11.: SQL Server Agent aus der letzten Zeile von sqlagent.out — laeuft false bei „terminated“/„cannot start“, null = unlesbar */
  agent?: { laeuft: boolean | null; letzteZeile?: string; fehler?: string } | null;
  /** Owner 23.11.: neueste mssql-server-Version der Paketquelle (apt-cache policy, trotz hold) */
  update?: { kandidat: string | null; fehler?: string } | null;
  /** I8e Task 4 — Zugangsdatei (nur Rechte), Kopier-Timer, letzter Kopierlauf */
  sicherung?: { zugangsdatei?: string; timer?: string; letzteKopie?: { zeit?: string | null; ok?: boolean; fehler?: string; alterMin?: number | null } | null } | null;
  /** Fix-Welle M-5/M-6 — Reste (alte tempdb-Dateien, Wegwerf-Ordner, Zugangsdateien): nur gemeldet, nie gelöscht */
  reste?: string[];
  /** Nachtrag 2 (M-B): vom Baustein-Kopf entfernte alte Zugangsdateien (/run/alfred-c-*, älter als 120 min) */
  alteZugangsdateienEntfernt?: number;
  /** Ruling R11 — Zeitquelle: Alfreds timesyncd-Drop-in, NTPSynchronized (yes/no), Server von systemd-timesyncd, Server ist ein DC */
  zeit?: { dropin?: string; synchronisiert?: string | null; server?: string | null; dc?: boolean } | null;
  /**
   * I8e Etappe 3 Task 5 — AD-Daten (Text in Task 6): beigetreten; SQL-Keytab mit höchster kvno, Zahl der MSSQLSvc-SPNs in dieser kvno,
   * aktuell = kvno gleich der AD-kvno (null, wenn ohne Kennwort kein Ticket zu bekommen war)
   */
  ad?: { beigetreten?: boolean; keytab?: { kvno: number | null; spns: number; aktuell: boolean | null; adKvno?: number | null; fehler?: string } | null } | null;
  /**
   * I8e Etappe 3 Task 6 — TLS: Zertifikat aus mssql.conf network.tlscert (SHA-1-Thumbprint, Ablauf, Resttage), erzwungen =
   * network.forceencryption 1, pruefSchalter = Schalterdatei der Zertifikatsprüfung (Task 7) vorhanden
   */
  tls?: { zertifikat?: string | null; thumbprint?: string | null; gueltigBis?: string | null; restTage?: number | null; erzwungen?: boolean; pruefSchalter?: boolean } | null;
}

/**
 * Task 6 — AD-/Keytab-Teil des Statustexts (Daten aus Task 5). Positiv prüfbar „AD beigetreten“ und „Kerberos-Keytab kvno <n> (6 SPNs,
 * aktuell)“; „veraltet“ (Review Focus 2), „ungeprüft“ (kein Ticket ohne Kennwort) und „kein Kerberos-Keytab“ nur für nichtEnthalten.
 */
export function adText(a: LinuxSqlStatus['ad']): string {
  if (!a) return 'AD unbekannt';
  const bei = a.beigetreten ? 'AD beigetreten' : 'AD nicht beigetreten';
  const k = a.keytab;
  if (!k) return `${bei}; kein Kerberos-Keytab`;
  if (k.fehler || k.kvno === null) return `${bei}; Kerberos-Keytab nicht lesbar`;
  const stand = k.aktuell === true ? 'aktuell' : k.aktuell === false ? `veraltet, AD-kvno ${k.adKvno ?? '?'}` : 'ungeprüft';
  return `${bei}; Kerberos-Keytab kvno ${k.kvno} (${k.spns} SPNs, ${stand})`;
}

/**
 * Task 6 — TLS-Teil des Statustexts: „TLS gültig bis <datum> (<n> Tage, Thumbprint <tp>)“ bzw. „TLS ABGELAUFEN …“, „TLS-Zertifikat
 * nicht lesbar …“, „TLS nicht eingerichtet“; dann „TLS erzwungen“ / „TLS nicht erzwungen“ und „Zertifikatsprüfung an“ / „… aus“.
 * Positive Stücke in FESTE_AUSGABEN['linux_sql.status'].
 */
export function tlsText(t: LinuxSqlStatus['tls']): string {
  if (!t) return 'TLS unbekannt';
  const datum = (t.gueltigBis ?? '').slice(0, 10);
  let z: string;
  if (t.thumbprint && t.gueltigBis && typeof t.restTage === 'number') {
    z = t.restTage < 0 ? `TLS ABGELAUFEN seit ${datum} (Thumbprint ${t.thumbprint})` : `TLS gültig bis ${datum} (${t.restTage} Tage, Thumbprint ${t.thumbprint})`;
  } else if (t.zertifikat) z = `TLS-Zertifikat nicht lesbar (${t.zertifikat.slice(0, 120)})`;
  else z = 'TLS nicht eingerichtet';
  return `${z}; ${t.erzwungen ? 'TLS erzwungen' : 'TLS nicht erzwungen'}; Zertifikatsprüfung ${t.pruefSchalter ? 'an' : 'aus'}`;
}

/**
 * Ruling R11 — Zeitteil des Statustexts (fester Wortlaut; positives Stück „Zeit synchron (DC)“ in FESTE_AUSGABEN['linux_sql.status']).
 * Jede Form beginnt mit „Zeit “.
 */
export function zeitText(z: LinuxSqlStatus['zeit']): string {
  if (!z) return 'Zeit unbekannt';
  const server = z.server ?? 'keiner';
  if (z.dropin === 'alfred' && z.synchronisiert === 'yes' && z.dc) return `Zeit synchron (DC) — Server ${server}`;
  if (z.dropin === 'alfred') return `Zeit NICHT synchron (Zeitquelle DC eingerichtet; NTPSynchronized ${z.synchronisiert ?? 'unbekannt'}, Server ${server})`;
  return `Zeit ohne DC-Zeitquelle (Drop-in ${z.dropin ?? 'unbekannt'}; NTPSynchronized ${z.synchronisiert ?? 'unbekannt'}, Server ${server})`;
}

/** Nachtrag 2 (M-B): Anzeige der entfernten alten Zugangsdateien (nur ab 1) */
const altZugangText = (n: unknown) => (typeof n === 'number' && n > 0 ? `; alte Zugangsdateien entfernt: ${n}` : '');

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
  // Ruling R11: Zeitquelle und Synchronisierung am Ende („; Zeit …“)
  // Task 6: AD/Keytab und TLS danach („; AD …; TLS …“) — nur, wenn der Status sie liefert (PY_STATUS liefert sie immer)
  const adTls = `${s.ad !== undefined ? `; ${adText(s.ad)}` : ''}${s.tls !== undefined ? `; ${tlsText(s.tls)}` : ''}`;
  const sich = `${sicherungText(s)}${resteText(s.reste)}${altZugangText(s.alteZugangsdateienEntfernt)}; ${zeitText(s.zeit)}${adTls}`;
  if (!s.installiert) return `${zugang}: SQL Server nicht installiert; ${eingehaengt}; ${sich}`;
  const dienst = `Dienst ${s.dienst === 'active' ? 'aktiv' : s.dienst ?? 'unbekannt'}, ${s.aktiviert === 'enabled' ? 'aktiviert' : s.aktiviert ?? 'unbekannt'}`;
  const limit = `Speicherlimit ${s.konfig?.memorylimitmb ?? '-'} MB`;
  const q = s.sql;
  if (!q) return `${zugang}: SQL Server ${s.pakete?.['mssql-server'] ?? '?'} (Paket); ${dienst}; ${limit}; SQL-Sicht: ${(s.sqlHinweis ?? s.sqlFehler ?? 'keine').slice(0, 200)}; ${eingehaengt}; ${sich}`;
  const dateien = (q.tempdb ?? []).filter(t => t.typ === 'ROWS').length;
  const dbs = (q.datenbanken ?? []).map(d => d.name).filter(n => !SYSTEM_DBS.has(n.toLowerCase()));
  return `${zugang}: SQL Server ${q.version ?? '?'} ${q.cu ?? q.stufe ?? ''} ${q.edition ?? ''}; ${dienst}; ${limit}; max server memory ${q.maxSpeicherMb ?? '-'} MB; tempdb ${dateien} Datendateien; Datenbanken: ${dbs.length ? dbs.join(', ') : 'keine eigenen'}; ${eingehaengt}; ${sich}${saText(s)}`;
}

/**
 * I8e Folge-Etappe — sa- und Login-Teil am Ende des Statustexts (nur wenn der Status sie liefert): „sa aus (gesperrt)“ = abgeschaltet
 * mit Host-Marke (positiv prüfbar), „sa aus (ohne Host-Marke)“, „sa aktiv“; „Alfred-Logins alfred_admin, alfred_status“ bzw. „keine“.
 */
function saText(s: LinuxSqlStatus): string {
  const q = s.sql;
  if (!q || q.saAbgeschaltet === undefined) return '';
  const sa = q.saAbgeschaltet === 1 ? (s.saMarke ? 'sa aus (gesperrt)' : 'sa aus (ohne Host-Marke)') : q.saAbgeschaltet === 0 ? 'sa aktiv' : 'sa unbekannt';
  const l = (q.alfredLogins ?? []).map(x => x.name).sort();
  return `; ${sa}; Alfred-Logins ${l.length ? l.join(', ') : 'keine'}${agentText(s)}${lageText(s)}`;
}

/** Owner 24.11.: Sicherungslage (letzte Sicherungen, Jobverlauf) am Ende — nur, wenn die SQL-Sicht sie liefert */
function lageText(s: LinuxSqlStatus): string {
  const q = s.sql;
  if (!q || (q.sicherungen === undefined && q.jobsLesbar === undefined)) return '';
  return `; ${sicherungsLageText(q)}`;
}

/** Überwachung 23.11.: Agent-Zustand nur bei eingeschaltetem Agent („GESTOPPT“ positiv prüfbar per nichtEnthalten) */
function agentText(s: LinuxSqlStatus): string {
  if (!/^(true|1|yes)$/i.test(String(s.konfig?.sqlagent ?? '').trim()) || !s.agent) return '';
  return s.agent.laeuft === true ? '; Agent läuft' : s.agent.laeuft === false ? '; Agent GESTOPPT' : '; Agent unbekannt';
}

// ── Sicherungen (I8e Task 4) ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LinuxSqlSicherungen {
  zustand: string; host?: string; ziel?: string; budgetBytes?: number; belegtBytes?: number | null; timer?: string; zugangsdatei?: string;
  status?: { zeit?: string; ok?: boolean; fehler?: string | null; befunde?: string[]; frisch?: boolean; alterMin?: number | null } | null;
  reste?: string[];
  alteZugangsdateienEntfernt?: number;
  datenbanken?: Record<string, { ketten: Array<{ full: string; diffs: number; logs: number; vollstaendig: boolean; fehler?: string[] }>; waisen?: string[];
    fs01Dateien: number; fs01Bytes?: number; fehlend?: number; lokalDateien?: number; lokalBytes?: number; ausstehend?: number; rolle?: string }>;
  /** I8e Paket 2 Task 7: Datenbanken dieses Servers ohne Sicherung auf diesem Rechner (z. B. sekundär) mit ihrer Rolle */
  ohneSicherung?: Record<string, string>;
  rollenFehler?: string;
}
/** I8e Paket 2 Task 7 — Rolle fail-closed: nur bekannte Werte, alles andere „unbekannt“ (nie PRIMARY) */
const AG_ROLLEN = new Set(['PRIMARY', 'SECONDARY', 'RESOLVING', 'keine AG', 'nicht vorhanden']);
const rolleText = (r: unknown) => (typeof r === 'string' && AG_ROLLEN.has(r) ? r : 'unbekannt');
const gib = (b: number | null | undefined) => (typeof b === 'number' ? (b / 2 ** 30).toFixed(1) : '?');
const mib = (b: number | null | undefined) => (typeof b === 'number' ? String(Math.round(b / 2 ** 20)) : '?');
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
    // I8e Paket 2 Task 7: Rolle je Datenbank („<db>: Rolle PRIMARY“ ist ein Prüfstück)
    return `${db}: Rolle ${rolleText(d.rolle)}, ${d.ketten.length} Ketten (${voll} vollständig), letzte FULL ${letzte}, lokal ${d.lokalDateien ?? 0}, fs01 ${d.fs01Dateien}, ${h}${h === 'Hash ok' ? ` — ${db}: vollständig auf fs01` : ''}`;
  });
  for (const [db, rolle] of Object.entries(r.ohneSicherung ?? {})) dbs.push(`${db}: Rolle ${rolleText(rolle)}, keine Sicherungen auf diesem Rechner`);
  const rf = r.rollenFehler ? `; Rolle nicht lesbar: ${String(r.rollenFehler).slice(0, 200)}` : '';
  return `${zugang}: Sicherung nach ${r.ziel ?? '?'} (belegt ${gib(r.belegtBytes)} GiB von ${budget} GiB); Kopie zuletzt ${kopie}; Zugangsdatei ${r.zugangsdatei ?? 'unbekannt'}; Kopie-Timer ${r.timer === 'active' ? 'aktiv' : r.timer ?? 'unbekannt'}; ${dbs.length ? dbs.join('; ') : 'keine Datenbanken gesichert'}${rf}${resteText(r.reste)}${altZugangText(r.alteZugangsdateienEntfernt)}`;
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
// Ruling R29 — die Change-Planprüfung (change-schritte verweise/ersetzeVerweise) ersetzt {{…}} vor pruefeEingabe durch den Wert „verweis“
const istVerweis = (v: unknown) => typeof v === 'string' && (v.includes('{{') || v.trim() === 'verweis');

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
/** Ruling R5 — Layout aus einhaengepunkte: alle vier (Standard) oder nur data (Konfig-Knoten: Log, Sicherung, tempdb auf der Datenplatte) */
function nurDatenLayout(input: Record<string, unknown>): boolean {
  if (input.einhaengepunkte === undefined) return false;
  const e = Array.isArray(input.einhaengepunkte) ? input.einhaengepunkte.map(x => (typeof x === 'string' ? KURZZIEL[x.trim().toLowerCase()] ?? x.trim() : x)) : input.einhaengepunkte;
  const f = pruefeInstallation({ version: '17.0.4006.2-1', edition: 'EnterpriseDeveloper', einhaengepunkte: e });
  if (f) throw new Error(f);
  return (e as string[]).length === 1;
}
function konfigWerte(input: Record<string, unknown>): KonfigWerte {
  const nurDaten = nurDatenLayout(input);
  const konfig: KonfigParameter = {
    speicherLimitMB: ganzzahl(input.speicher_limit_mb ?? STANDARD.speicherLimitMB) as number,
    datenPfad: KURZZIEL.data!, logPfad: nurDaten ? KURZZIEL.data! : KURZZIEL.log!, sicherungsPfad: nurDaten ? KURZZIEL.data! : KURZZIEL.backup!, agent: input.agent === undefined ? true : input.agent as boolean,
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
    ...(nurDaten ? { pfad: TEMPDB_PFAD_DATEN as TempdbPfad } : {}),
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

/** I8e Etappe 3 Task 4 — Beitritts-Parameter: Domäne/Realm/OU/DCs fest, computername Standard = zugang, Paketversionen fest (überschreibbar) */
function adBeitretenParameter(zugang: string, input: Record<string, unknown>): AdBeitretenParameter {
  // Spec 10: der Konfig-Knoten tritt nie bei — auch nicht über einen anderen computernamen
  if (zugang.toLowerCase() === AD_NIE_BEITRETEN) throw new Error(`${AD_NIE_BEITRETEN} tritt nicht bei (Spec 10)`);
  const computername = String(input.computername ?? zugang).trim().toLowerCase();
  const roh = input.pakete === undefined ? {} : input.pakete;
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) throw new Error(`pakete: Objekt { paket: version } (nur ${Object.keys(LINUX_AD_PAKETE).join(', ')})`);
  const fremd = Object.keys(roh).filter(k => !(k in LINUX_AD_PAKETE));
  if (fremd.length) throw new Error(`pakete: unbekannt ${fremd.join(', ').slice(0, 120)} — nur ${Object.keys(LINUX_AD_PAKETE).join(', ')}`);
  const p: AdBeitretenParameter = {
    domaene: LINUX_AD.domaene, realm: LINUX_AD.realm, ou: LINUX_AD.ou, computername, dcs: [...LINUX_AD.dcs],
    pakete: { ...LINUX_AD_PAKETE, ...(roh as Record<string, string>) },
  };
  const f = pruefeAdBeitreten(p); if (f) throw new Error(f);
  pruefeTresorName(joinTresorName(computername));
  return p;
}

/** I8e Etappe 3 Task 5 — Keytab-Parameter: Konto, Realm, SPNs fest; computername Standard = zugang, nie sqllnxcfg (Spec 10) */
function kerberosEingabe(zugang: string, input: Record<string, unknown>): KerberosParameter {
  if (zugang.toLowerCase() === AD_NIE_BEITRETEN) throw new Error(`${AD_NIE_BEITRETEN} bekommt keinen Keytab (Spec 10)`);
  const p = kerberosParameter(String(input.computername ?? zugang));
  const f = pruefeKerberos(p); if (f) throw new Error(f);
  return p;
}

/** I8e Etappe 3 Task 6 — TLS-Parameter: CN/SANs fest je Host (computername Standard = zugang; alle drei Hosts) */
function tlsEingabeParameter(zugang: string, input: Record<string, unknown>): TlsParameter {
  const host = String(input.computername ?? zugang).trim().toLowerCase();
  if (!TLS_HOSTS.includes(host)) throw new Error(`computername: TLS nur für ${TLS_HOSTS.join(', ')} (Standard = zugang)`);
  return tlsParameter(host);
}

/** I8e Etappe 3 Task 8 — AD-Login-Parameter (nie sqllnxcfg, Spec 10); nur die bekannten Felder */
function adLoginParameter(zugang: string, input: Record<string, unknown>): AdLoginParameter {
  if (zugang.trim().toLowerCase() === AD_NIE_BEITRETEN) throw new Error(`${AD_NIE_BEITRETEN} bekommt keine AD-Logins (Spec 10)`);
  if (!KERBEROS_HOSTS.includes(zugang.trim().toLowerCase())) throw new Error(`zugang: AD-Logins nur auf ${KERBEROS_HOSTS.join(', ')} (beigetreten, mit Keytab)`);
  const p: AdLoginParameter = { gruppe: typeof input.gruppe === 'string' ? input.gruppe : '' };
  if (input.serverrolle !== undefined) p.serverrolle = input.serverrolle as string;
  if (input.datenbank !== undefined) p.datenbank = input.datenbank as string;
  if (input.datenbankrolle !== undefined) p.datenbankrolle = input.datenbankrolle as string;
  const f = pruefeAdLogin(p); if (f) throw new Error(f);
  return p;
}

/** I8e Etappe 3 Task 8 — tls_erzwingen: an fest (true/false), Host = zugang (TLS-Host, = Pacemaker-Knoten), FQDN aus tlsParameter */
function tlsErzwingenParameter(zugang: string, input: Record<string, unknown>): TlsErzwingenParameter {
  if (typeof input.an !== 'boolean') throw new Error('an: true oder false');
  const host = zugang.trim().toLowerCase();
  if (!TLS_HOSTS.includes(host)) throw new Error(`zugang: Verschlüsselung erzwingen nur auf ${TLS_HOSTS.join(', ')}`);
  const p: TlsErzwingenParameter = input.an ? { an: true, host, cn: tlsParameter(host).cn } : { an: false };
  const f = pruefeTlsErzwingen(p); if (f) throw new Error(f);
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
      + 'NUR als Schritte freigegebener Changes (Reihenfolge): platten_einrichten (zugang, platten = [{scsi, groesse_gib, ziel: data|log|tempdb|backup}], z. B. scsi1 160 data, scsi2 80 log, scsi3 64 tempdb, scsi4 128 backup aus provision_vm extra_disks [160,80,64,128]; Konfig-Knoten sqllnxcfg nur scsi1 16 data, dann installieren mit einhaengepunkte ["data"]; andere Teilmengen nicht zulässig) — nur leere Platten exakter Größe, XFS, fstab per UUID; '
      + 'installieren (zugang, version = apt-Version ab CU1 wie 17.0.4006.2-1) — signierte Microsoft-Quelle, feste Versionen, sa-Kennwort erzeugt Alfred im Tresor (sqllnx-<zugang>-sa); '
      + 'konfigurieren (zugang, speicher_limit_mb Standard 12288, max_server_memory_mb Standard 10240, tempdb_dateien Standard Kerne max. 8, agent Standard true, einhaengepunkte wie installieren) — mssql-conf, tempdb auf der TempDB-Platte, max server memory; Konfig-Knoten sqllnxcfg mit einhaengepunkte ["data"], speicher_limit_mb 3072, max_server_memory_mb 2048: Daten, Log und Sicherung auf /var/opt/mssql/data, tempdb unter /var/opt/mssql/data/tempdb/; '
      + 'login_anlegen (zugang, login, rolle dbcreator|sysadmin|lesen) — SQL-Login, Kennwort im Tresor (sqllnx-<zugang>-<login>), „lesen“ = ohne Serverrolle; '
      + `pruefdaten_anlegen (zugang, datenbank) — Datenbank (FULL) mit Prüftabelle dbo.alfred_pruefung (${PRUEFDATEN_ZEILEN} feste Zeilen, Prüfsumme im Ergebnis) für den Restore-Beweis. `
      + 'SICHERUNG (I8e Task 4; vorher auf fs01: windows_ad dienstkonto_anlegen konto svc-sqllnx-backup und windows_cluster freigabe_anlegen name SQLLinuxBackup$ pfad S:\\SQLLinuxBackup aendern <NETBIOS>\\svc-sqllnx-backup kontingent_gib 64; Firewall SQL-Zone → fs01 TCP 445): '
      + 'sicherung_einrichten (zugang, ziel_freigabe = \\\\fs01.ad.3033.at\\SQLLinuxBackup$, konto_tresor Standard ad-svc-sqllnx-backup, konto optional „NETBIOS\\name“, budget_gib Standard 63 = 1 GiB unter dem FSRM-Kontingent 64) — SQL-Agent-Jobs FULL täglich 00:30, DIFF alle 6 h, LOG alle 15 min (CHECKSUM, COMPRESSION) nach /var/opt/mssql/backup/<db>/, Kopier-Timer alle 15 min nach fs01 (SMB 3.1.1 verschlüsselt, SHA-256 zurückgelesen, nie überschrieben), Aufbewahrung 7 Tage + 4 Sonntage nur ganzer vollständiger Ketten, Budget-Überschreitung = Fehler ohne Löschen; einzige dauerhafte Zugangsdatei /etc/alfred/sqllnx-cifs.cred (0600 root); prüft sich selbst mit einem Kopierlauf. '
      + 'sicherung_jetzt (zugang, art full|diff|log, datenbank) — eine Sicherung in derselben Kette, danach auf fs01 bestätigt. '
      + 'wiederherstellen_pruefen (zugang, datenbank, ziel_name Standard alfred_wh_<datenbank>) — letzte vollständige Kette FULL+DIFF+LOGs AUS DER fs01-KOPIE unter ziel_name, DBCC CHECKDB, Prüfdaten-Vergleich → „RESTORE_VERIFIED“ nur wenn alles stimmt; ziel_name wird danach entfernt (Schritt-zeitlimitS großzügig, z. B. 3600). '
      + 'sicherungen (lesend, auch außerhalb von Changes; zugang; liest keinen Tresor und nicht fs01 — lokaler Stand und Bericht des letzten Kopierlaufs, der fs01 prüft) — Wortlaut „<zugang>: Sicherung nach //fs01.ad.3033.at/<freigabe> (belegt <x> GiB von <y> GiB); Kopie zuletzt <zeit> ok; Zugangsdatei vorhanden (0600); Kopie-Timer aktiv; <db>: <n> Ketten (<m> vollständig), letzte FULL …, lokal <a>, fs01 <b>, Hash ok, vollständig auf fs01“ (sonst „Hash unbekannt …“, „ausstehend: <n>“, „FEHLT auf fs01: <n>“; Befunde des Kopierlaufs stehen hinter „Kopie zuletzt <zeit> FEHLER:“), als Prüfung z. B. erwartet „vollständig auf fs01“ oder „Kopie-Timer aktiv“. Ziel ist nur fs01.ad.3033.at, konto_tresor nur ad-svc-sqllnx-…. '
      + `Mindest-zeitlimitS je Schritt (Baustein-Zeitgrenzen + 60 s): ${Object.entries(LINUX_SQL_MIN_ZEITLIMIT_S).map(([a, sk]) => `${a} ${sk} s`).join(', ')}. `
      + 'reste_entfernen (nur im Change; zugang) — entfernt alte tempdb-Dateien (temp*.mdf/ndf/ldf direkt in /var/opt/mssql/data), die der Status als „Reste“ meldet; nur Dateien, die nicht in sys.master_files stehen und kein Prozess geöffnet hat; SQL Server muss laufen, sonst Abbruch ohne Löschen; jede gelöschte Datei steht mit Größe im Ergebnis, Dateien in Gebrauch bleiben und werden genannt; kein Rückweg (ohneSicherungGrund). '
      + 'kettengrenzen_uebernehmen (nur im Change; zugang, konto_tresor optional) — nur wenn sicherungen/status „lokale Kettengrenzen fehlen“ meldet: übernimmt nach Prüfung die Grenzen gelöschter Ketten aus der Kopie auf fs01 in die lokale Aufzeichnung und nennt den Unterschied. '
      + 'AD (I8e Etappe 3, nur sqllnx01/sqllnx02 — sqllnxcfg tritt nie bei): ad_beitreten (nur im Change; zugang, computername Standard = zugang, pakete optional { paket: version }) — vorher windows_ad computerkonto_vorbereiten name <computername> (Einmal-Kennwort im Tresor ad-join-<computername>) und dns_ptr; prüft zuerst ohne Änderung hostname -f = <computername>.ad.3033.at, SRV _ldap._tcp.ad.3033.at, PTR der eigenen Adresse, Zeitquelle eingerichtet (zeitquelle_einrichten: Drop-in, NTPSynchronized yes, Offset < 60 s — sonst „Zeitquelle zuerst einrichten“); dann realmd/sssd/adcli/krb5 in fester Version (hold), Beitritt als vorbereitetes Computerkonto (kein AD-Admin auf dem Host, Kennwort nur über stdin), sssd nur für NSS (access_provider = deny, PAM ohne sss — keine Anmeldung von Domänenbenutzern am Host); eine fremde sssd.conf, krb5.conf (außer der unveränderten krb5-config-Vorgabe) oder ein fremder Keytab → Abbruch ohne Änderung; Selbstprüfung realm list, id svc-sqllnx@ad.3033.at, getent group sql-linux-admins@ad.3033.at, Keytab, kein pam_sss; „AD_JOINED“; der Tresor-Eintrag ad-join-<computername> wird danach entfernt (verbraucht) ↔ ad_verlassen (zugang, computername Standard = zugang; nur lokal und nur Alfreds Einrichtung: sssd aus, Alfreds sssd.conf/krb5.conf entfernt bzw. Paketvorgabe zurück, Keytab nur mit ausschließlich eigenen Principals, NSS und PAM ohne sss; Fremdes bleibt und steht unter „belassen“; „AD_LEFT“ — das Computerkonto entfernt der Change danach mit windows_ad computerkonto_entfernen). '
      + `ZEIT (Ruling R11, alle drei Hosts einschließlich sqllnxcfg, vor ad_beitreten): zeitquelle_einrichten (nur im Change; zugang) — systemd-timesyncd mit Drop-in ${ZEITQUELLE_DROPIN} (NTP=${ZEITQUELLE_DCS.join(' ')}, FallbackNTP= leer), Neustart, Nachweis binnen 120 s: NTPSynchronized yes, Server ein DC, Offset unter 1 s → „TIME_SYNCED“; chrony/ntpd aktiv oder fremdes Drop-in mit NTP= → Abbruch ohne Änderung; nicht synchronisiert → Abbruch mit gelesenem Status, Drop-in bleibt ↔ zeitquelle_entfernen (zugang; entfernt nur Alfreds Drop-in, Neustart). Status nennt „Zeit synchron (DC)“ (sonst „Zeit NICHT synchron …“ bzw. „Zeit ohne DC-Zeitquelle …“). `
      + `KERBEROS (I8e Etappe 3, nur sqllnx01/sqllnx02 — sqllnxcfg bekommt keinen Keytab; nach ad_beitreten, vorher windows_ad spn_setzen für ${KERBEROS_SPNS.join(', ')} am Konto ${SQL_KERBEROS_KONTO}): kerberos_einrichten (nur im Change; zugang, computername Standard = zugang) — Kennwort aus dem Tresor ${KERBEROS_KONTO_TRESOR} nur über stdin; liest die kvno per kinit + kvno MSSQLSvc/<fqdn>:1433 aus dem AD, schreibt ${SQL_KEYTAB} (mssql:mssql 0400) mit allen 6 SPNs und ${SQL_KERBEROS_KONTO} je AES256/AES128 in dieser kvno (ältere kvno bleiben; fremde Principals oder eine höhere kvno als das AD → Abbruch ohne Änderung), prüft kinit -k und kvno -k (Abweichung → Abbruch „Keytab-kvno X, AD-kvno Y“, mssql-conf unverändert), setzt mssql-conf network.kerberoskeytabfile und network.privilegedadaccount ${SQL_KERBEROS_KONTO}; KEIN Neustart — „Neustart nötig“ steht in der Anzeige, der Change startet SQL Server rollierend (sqllnx02 → Failover → sqllnx01); „KERBEROS_KEYTAB_OK“ ↔ kerberos_entfernen (zugang; nimmt die mssql-conf-Werte nur zurück, wenn es Alfreds sind, entfernt den Keytab nur mit ausschließlich eigenen Principals; Fremdes steht unter „belassen“; „KERBEROS_REMOVED“). `
      + `TLS (I8e Etappe 3, alle drei Hosts einschließlich sqllnxcfg; CN <host>.ad.3033.at, SANs fest je Host): tls_anfordern (nur im Change; zugang, computername Standard = zugang) — RSA-${TLS_BITS}-Schlüssel ${TLS_KEY_NEU} (0400 mssql:mssql) AUF dem Host (ein vorhandener unbenutzter wird wiederverwendet), Anforderung daraus; Ergebnis nur öffentlich: data.csrPem, data.csrSha256, data.csrBase64 (DER) → weiter mit windows_pki fremd_csr_ausstellen (zugang pkiiss01, cn, sans, csr_base64 = {{schrittN.csrBase64}}, csr_sha256 = {{schrittN.csrSha256}}); „TLS_CSR_READY“; kein Rückweg (rueckweg {keiner: „${TLS_ANFORDERN_GRUND}“}). `
      + `tls_einspielen (nur im Change; zugang, computername Standard = zugang, zertifikat + kette als PEM ODER zert_base64 + issuing_base64 + root_base64 als DER-Base64, erwartet_root_sha256 Pflicht als fester Wert = SHA-256 der Root-DER) — prüft ohne Änderung: Root = erwartet_root_sha256 (eine vorhandene andere Root wird nie ersetzt), Kette Issuing → Root, Zertifikat für Server-Authentifizierung, Zertifikat passt zum Schlüssel auf dem Host (sonst Abbruch, bisherige Konfiguration bleibt), RSA ${TLS_BITS}, CN, SANs exakt, Restlaufzeit > ${TLS_MIN_TAGE} Tage; dann CA-Dateien ad3033-root.crt/ad3033-issuing.crt + update-ca-certificates, ${TLS_KEY} (0400 mssql:mssql), ${TLS_CRT} (0444), mssql-conf network.tlscert/tlskey/tlsprotocols ${TLS_PROTOKOLLE} — NICHT forceencryption und KEIN Neustart (Anzeige „Neustart nötig“, der Change startet rollierend); „TLS_INSTALLED“ ↔ tls_entfernen (zugang; nur Alfreds mssql-conf-Werte und Dateien laut Manifest, unbenutzter tls.key.neu; Abbruch, solange forceencryption 1; „TLS_REMOVED“; Abbruch, solange die Zertifikatsprüfung an ist). Status nennt „TLS gültig bis <datum>“, „TLS erzwungen“ (sonst „TLS nicht erzwungen“), „Zertifikatsprüfung an“, „AD beigetreten“, „Kerberos-Keytab kvno <n> (6 SPNs, aktuell)“. `
      + `tls_pruefung_schalten (nur im Change; zugang = sqllnx01/sqllnx02/sqllnxcfg, an true|false; nach tls_einspielen UND dem rollierenden Neustart) — an=true nur, wenn ${TLS_CRT} Alfreds ist (Manifest), von mssql.conf genutzt wird, nicht abgelaufen ist, Kette + Name gegen den Vertrauensspeicher prüfbar sind und eine Probe-Verbindung als sa mit sqlcmd -N -S <host>.ad.3033.at verschlüsselt gelingt; dann Schalter ${TLS_PRUEF_SCHALTER} (0644 root, Inhalt FQDN) → „TLS_PRUEFUNG_AN“: ab da verbinden alle SQL-Bausteine von linux_sql und linux_ha mit Zertifikatsprüfung, scheitert sie, brechen sie mit „Zertifikatsprüfung fehlgeschlagen“ ab (nie Rückfall ohne Prüfung); rueckweg tls_pruefung_schalten an=false (zugang) → „TLS_PRUEFUNG_AUS“. `
      + `tls_erzwingen (nur im Change; zugang = sqllnx01/sqllnx02/sqllnxcfg, an true|false; nach tls_pruefung_schalten an=true) — an=true nur, wenn TLS von Alfred eingespielt ist (Manifest, mssql.conf, gültig, Kette + Name), die Zertifikatsprüfung an ist (Schalter mit genau diesem FQDN, Probe -N verschlüsselt) und Pacemaker auf diesem Knoten fehlerfrei ist (online, Quorum, ag_cluster bekannt, Fehlerzähler mit Fehler in den letzten 30 min 0, keine fehlgeschlagene Aktion in 30 min, crm_mon --include=failcounts,failures) — sonst Abbruch ohne Änderung; vermerkt sein Eigentum in /etc/alfred/sqllnx-tls-erzwungen und setzt mssql-conf network.forceencryption 1, KEIN Neustart (Anzeige „Neustart nötig“; der Change startet rollierend: Sekundär neu starten, ag_failover, alter Primär neu starten, ag_failover zurück; sqllnxcfg einzeln) → „TLS_ERZWUNGEN“ ↔ rueckweg Pflicht tls_erzwingen an=false (zugang) → „TLS_NICHT_ERZWUNGEN“ (ohne Vorbedingung; nimmt nur einen von Alfred vermerkten Wert zurück, ein vorher gesetztes 1 bleibt: „TLS_ERZWUNGEN_BELASSEN“). Der Pacemaker-Agent ocf:mssql:ag verbindet ohnehin verschlüsselt (encrypt=true, TrustServerCertificate=true) — der Beweis ist trotzdem der Failover hin/zurück ohne Monitor-Fehler (linux_ha status: „Pacemaker ohne Fehlaktionen (30 min), Fehlerzähler ag_cluster 0 (30 min)“). `
      + `tls_pfad_umstellen (nur im Change; zugang = sqllnx01/sqllnx02/sqllnxcfg, an true|false) — Microsoft #979: der SQL Agent von SQL Server 2025 liest network.tlscert selbst und darf nicht in /var/opt/mssql/secrets lesen (Agent beendet sich mit „SSL Provider: The data is invalid“); an=true stellt Alfreds Zertifikat (Manifest) von ${TLS_CRT_ALT} auf ${TLS_CRT} um (bytegleiche Kopie 0444 mssql, Ordner 0755 mssql; eine schon vorhandene gleiche Kopie wird übernommen, eine abweichende nie überschrieben), Schlüssel bleibt; „TLS_PFAD_NEU“; an=false = Rückweg (zurück auf secrets, Kopie entfernt; „TLS_PFAD_ALT“). KEIN Neustart — im Change danach SQL Server im Standby neu starten (Sekundär) bzw. nach dem Failover, dann „Agent läuft“ prüfen. tls_einspielen legt neue Zertifikate immer unter ${TLS_CRT} ab und räumt den alten Pfad ab. `
      + `AD-LOGINS (nur sqllnx01/sqllnx02, nie sqllnxcfg; nach ad_beitreten und kerberos_einrichten + Neustart): ad_login (nur im Change; zugang, gruppe z. B. SQL-Linux-Admins, serverrolle sysadmin und/oder datenbank + datenbankrolle ${AD_LOGIN_DB_ROLLEN.join('/')}) — CREATE LOGIN [AD3033\\<gruppe>] FROM WINDOWS (+ Serverrolle bzw. Datenbankbenutzer + Rolle, Datenbank nur auf dem Primär — Sekundär → Abbruch, der Benutzer wird repliziert); vorher ohne Änderung: Host beigetreten (sssd), getent group <gruppe>@ad.3033.at, Alfreds Keytab in mssql.conf; ein vorhandener Login anderen Typs, ein deaktivierter Login oder ein abweichender Datenbankbenutzer → Abbruch; was fehlt, wird vor der Anlage in ${AD_LOGINS_DATEI} vermerkt; Selbstprüfung über sys.server_principals (Typ G), Serverrollen- und Datenbankrollen-Mitgliedschaft → „AD_LOGIN_OK“ ↔ rueckweg Pflicht ad_login_entfernen (gleiche zugang, gruppe, serverrolle, datenbank, datenbankrolle; entfernt nur Vermerktes, Fremdes steht unter „belassen“; „AD_LOGIN_REMOVED“). Logins sind instanzbezogen: je Replikat ein Schritt. `
      + 'ALFRED-LOGINS UND sa (alle drei Instanzen, je Zugang ein Schritt, nur im Change): alfred_logins_anlegen (zugang) — alfred_admin (sysadmin) und alfred_status (nur lesen: VIEW SERVER STATE, VIEW ANY DEFINITION, SELECT msdb.dbo.backupset), Kennwörter erzeugt Alfred im Tresor (sqllnx-<zugang>-alfred-admin/-alfred-status); danach melden sich ändernde Aktionen als alfred_admin, status als alfred_status an, nie mehr als sa ↔ rueckweg Pflicht alfred_logins_entfernen (zugang; nur solange sa aktiv). '
      + 'sa_schalten (zugang, an false = sa abschalten + Host-Marke, true = einschalten) — nur als alfred_admin ↔ rueckweg Pflicht sa_schalten mit an umgekehrt. '
      + 'jobverlauf_recht (zugang, an true = alfred_status darf msdb.dbo.sysjobs/sysjobhistory lesen, false = Recht entziehen; Logins bleiben) — nur als alfred_admin, für bestehende Hosts statt alfred_logins_anlegen ↔ rueckweg Pflicht jobverlauf_recht mit an umgekehrt. '
      + 'aktualisieren (nur im Change; zugang, version = apt-Version wie 17.0.5065.9-3) — SQL-Server-Update (CU): mssql-server und, falls installiert, mssql-server-ha auf dieselbe Version, danach wieder gehalten; nur als alfred_admin; '
      + 'Voraussetzung bei Pacemaker: Knoten vorher mit linux_ha knoten_standby an=true (keine aktive ag_cluster-Instanz mehr; so ist der Knoten nie Primär), danach knoten_standby an=false; kein Downgrade, Ziel muss in der Paketquelle sein; '
      + 'Selbstprüfung: Dienst aktiv/aktiviert, Anmeldung (Skript-Upgrade bis 10 min), ProductVersion = Ziel, Pakete in Zielversion gehalten, mssql.conf unverändert; Wortlaut „SQL_AKTUALISIERT <zugang>: <von> → <version>“. '
      + 'Reihenfolge rollierend: sqllnxcfg und der Sekundär zuerst, dann ag_failover, dann der bisherige Primär; je Knoten danach linux_ha status mit „SECONDARY SYNCHRONIZED“. Kein Rückweg: rueckweg {keiner: „' + SQL_UPDATE_OHNE_RUECKWEG + '“}. '
      + 'sa_kennwort_setzen (zugang) — Notfallweg: setzt das vorhandene sa-Kennwort aus dem Tresor per mssql-conf set-sa-password (Dienst wird gestoppt und gestartet); Voraussetzung: Pacemaker-Knoten vorher mit linux_ha knoten_standby an=true in Standby. '
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
        version: { type: 'string', description: 'installieren: apt-Version von mssql-server, z. B. 17.0.4006.2-1; aktualisieren: Zielversion, z. B. 17.0.5065.9-3' },
        einhaengepunkte: { type: 'array', items: { type: 'string' }, description: 'installieren/konfigurieren: Plattenziele, die vor dem Setup eingehängt sein müssen (Standard alle vier; sonst nur ["data"] für den Konfig-Knoten sqllnxcfg)' },
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
        computername: { type: 'string', description: 'ad_beitreten/ad_verlassen/kerberos_einrichten/tls_anfordern/tls_einspielen: Name des Rechners ohne $ (Standard = zugang), Beitritt und Keytab nie sqllnxcfg' },
        pakete: { type: 'object', description: `ad_beitreten: optional abweichende apt-Versionen { paket: version } für ${Object.keys(LINUX_AD_PAKETE).join(', ')} (Standard fest)` },
        zertifikat: { type: 'string', description: 'tls_einspielen: Zertifikat (PEM, öffentlich) aus windows_pki fremd_csr_ausstellen' },
        kette: { type: 'string', description: 'tls_einspielen: Issuing-CA und Root (PEM, öffentlich)' },
        zert_base64: { type: 'string', description: 'tls_einspielen: Zertifikat als DER-Base64 (statt zertifikat), z. B. {{schrittN.zertBase64}}' },
        issuing_base64: { type: 'string', description: 'tls_einspielen: Issuing-CA als DER-Base64 (statt kette)' },
        root_base64: { type: 'string', description: 'tls_einspielen: Root-CA als DER-Base64 (statt kette)' },
        erwartet_root_sha256: { type: 'string', description: 'tls_einspielen: Pflicht, fester Wert — SHA-256 (64 Hex) der DER der AD3033-Root; eine andere Root wird abgewiesen' },
        an: { type: 'boolean', description: 'tls_pfad_umstellen: true = Zertifikat in den eigenen Ordner (#979), false = zurück (Rückweg); tls_pruefung_schalten: true = Zertifikatsprüfung an (Schalter setzen), false = aus (Rückweg); tls_erzwingen: true = network.forceencryption 1, false = zurück (Rückweg); sa_schalten: false = sa abschalten, true = einschalten (Rückweg); jobverlauf_recht: true = Leserecht auf den Jobverlauf, false = entziehen (Rückweg)' },
        gruppe: { type: 'string', description: 'ad_login/ad_login_entfernen: AD-Gruppe ohne Domäne, z. B. SQL-Linux-Admins (Login AD3033\\<gruppe>)' },
        serverrolle: { type: 'string', enum: ['sysadmin'], description: 'ad_login/ad_login_entfernen: Serverrolle des Gruppen-Logins' },
        datenbankrolle: { type: 'string', enum: [...AD_LOGIN_DB_ROLLEN], description: 'ad_login/ad_login_entfernen: Rolle in datenbank (nur mit datenbank, nur auf dem Primär)' },
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
    // Spec 10 — auch wenn andere Felder Verweise sind: der Konfig-Knoten tritt nie bei
    if (action === 'ad_beitreten' && [input.zugang, input.computername].some(v => typeof v === 'string' && v.trim().toLowerCase() === AD_NIE_BEITRETEN)) return `${AD_NIE_BEITRETEN} tritt nicht bei (Spec 10)`;
    if (action === 'kerberos_einrichten' && [input.zugang, input.computername].some(v => typeof v === 'string' && v.trim().toLowerCase() === AD_NIE_BEITRETEN)) return `${AD_NIE_BEITRETEN} bekommt keinen Keytab (Spec 10)`;
    // Task 6: Host (CN/SANs) schon beim Planen, auch wenn Zertifikat/Kette noch Verweise sind
    if ((action === 'tls_anfordern' || action === 'tls_einspielen') && !istVerweis(input.zugang) && !istVerweis(input.computername)) {
      try { tlsEingabeParameter(String(input.zugang).trim(), input); } catch (err) { return (err as Error).message.slice(0, 200); }
    }
    // Ruling R17: die erwartete Root ist Pflicht und ein fester Wert (nie aus einem Verweis — sonst bestimmte die Quelle selbst, was vertraut wird)
    // Task 7: an ist ein fester Wahrheitswert (der Rückweg kehrt ihn um); nur auf den TLS-Hosts
    if (action === 'tls_pruefung_schalten') {
      if (!istVerweis(input.an) && typeof input.an !== 'boolean') return 'an: true oder false';
      if (!istVerweis(input.zugang) && !TLS_HOSTS.includes(String(input.zugang).trim().toLowerCase())) return `zugang: Zertifikatsprüfung nur auf ${TLS_HOSTS.join(', ')}`;
    }
    // Task 8: an fest; Host und sqllnxcfg-Sperre schon beim Planen
    if (action === 'tls_erzwingen') {
      if (!istVerweis(input.an) && typeof input.an !== 'boolean') return 'an: true oder false';
      if (!istVerweis(input.zugang) && !TLS_HOSTS.includes(String(input.zugang).trim().toLowerCase())) return `zugang: Verschlüsselung erzwingen nur auf ${TLS_HOSTS.join(', ')}`;
    }
    // #979: an fest (der Rückweg kehrt ihn um); nur auf den TLS-Hosts
    if (action === 'tls_pfad_umstellen') {
      if (!istVerweis(input.an) && typeof input.an !== 'boolean') return 'an: true oder false';
      if (!istVerweis(input.zugang) && !TLS_HOSTS.includes(String(input.zugang).trim().toLowerCase())) return `zugang: Zertifikatspfad nur auf ${TLS_HOSTS.join(', ')}`;
    }
    if ((action === 'ad_login' || action === 'ad_login_entfernen') && typeof input.zugang === 'string' && input.zugang.trim().toLowerCase() === AD_NIE_BEITRETEN) return `${AD_NIE_BEITRETEN} bekommt keine AD-Logins (Spec 10)`;
    if (action === 'tls_einspielen') { try { erwarteteRoot(istVerweis(input.erwartet_root_sha256) ? '' : input.erwartet_root_sha256); } catch (err) { return (err as Error).message.slice(0, 200); } }
    if (Object.values(input).some(istVerweis)) return undefined;
    try {
      if (['installieren', 'konfigurieren', 'login_anlegen', 'pruefdaten_anlegen', 'reste_entfernen'].includes(action)) pruefeTresorName(saName(String(input.zugang).trim()));
      if (action === 'platten_einrichten') plattenParameter(input);
      else if (action === 'installieren') installParameter(input);
      else if (action === 'konfigurieren') konfigWerte(input);
      else if (action === 'login_anlegen') { const p = loginParameter(input); loginTresorName(String(input.zugang), p.name); }
      else if (action === 'pruefdaten_anlegen') pruefdatenParameter(input);
      else if (action === 'sicherung_einrichten') sicherungEinrichtenParameter(input);
      else if (action === 'sicherung_jetzt') sicherungJetztParameter(input);
      else if (action === 'wiederherstellen_pruefen') { wiederherstellenParameter(input); kontoTresorName(input); }
      else if (action === 'kettengrenzen_uebernehmen') kontoTresorName(input);
      else if (action === 'ad_beitreten') adBeitretenParameter(String(input.zugang).trim(), input);
      else if (action === 'ad_verlassen') { const f = pruefeAdVerlassen({ computername: String(input.computername ?? input.zugang).trim() }); if (f) throw new Error(f); }
      else if (action === 'kerberos_einrichten') { kerberosEingabe(String(input.zugang).trim(), input); pruefeTresorName(KERBEROS_KONTO_TRESOR); }
      else if (action === 'tls_einspielen') tlsEingabe(input);
      else if (action === 'tls_erzwingen') { tlsErzwingenParameter(String(input.zugang), input); if (input.an === true) pruefeTresorName(saName(String(input.zugang).trim())); }
      else if (action === 'sa_schalten' || action === 'jobverlauf_recht') { const f = pruefeSaSchalten(input); if (f) throw new Error(f); }
      else if (action === 'aktualisieren') { const f = pruefeSqlUpdate(input); if (f) throw new Error(f); }
      else if (action === 'ad_login' || action === 'ad_login_entfernen') { adLoginParameter(String(input.zugang), input); pruefeTresorName(saName(String(input.zugang).trim())); }
      if (['sicherung_einrichten', 'sicherung_jetzt', 'wiederherstellen_pruefen'].includes(action)) pruefeTresorName(saName(String(input.zugang).trim()));
    } catch (err) { return (err as Error).message.slice(0, 200); }
    return undefined;
  }

  async execute(input: Record<string, unknown>, context?: SkillContext): Promise<SkillResult> {
    // Nachtrag 2 (M-B): entfernte alte Zugangsdateien in jeder Anzeige (status/sicherungen nennen sie schon im festen Wortlaut)
    this.altZugang = 0;
    // I8e Folge-Etappe (Review I5): Login je Aufruf im eigenen Kontext — gleichzeitige Aufrufe (Überwachung + Change) mischen sich nicht
    const lauf: { login?: SqlLogin } = {};
    const r0 = await ANMELDE_KONTEXT.run(lauf, () => this.ausfuehren(input, context));
    // nach der Umstellung nennt jedes Ergebnis das Login (vor der Umstellung bleibt der Wortlaut unverändert)
    const r = r0.success && lauf.login && lauf.login !== 'sa'
      ? { ...r0, display: `${r0.display ?? ''} (angemeldet als ${lauf.login})`, data: r0.data && typeof r0.data === 'object' ? { ...(r0.data as object), login: lauf.login } : r0.data }
      : r0;
    const zusatz = String(input.action ?? '') === 'status' || String(input.action ?? '') === 'sicherungen' ? '' : altZugangText(this.altZugang);
    if (!zusatz) return r;
    return r.success ? { ...r, display: `${r.display ?? ''}${zusatz}` } : { ...r, error: `${r.error ?? ''}${zusatz}` };
  }

  private async ausfuehren(input: Record<string, unknown>, context?: SkillContext): Promise<SkillResult> {
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
        case 'reste_entfernen': return await this.resteEntfernen(zugang, geheim);
        case 'ad_beitreten': return await this.adBeitreten(zugang, input, geheim);
        case 'ad_verlassen': return await this.adVerlassen(zugang, input);
        case 'zeitquelle_einrichten': return await this.zeitquelleEinrichten(zugang);
        case 'zeitquelle_entfernen': return await this.zeitquelleEntfernen(zugang);
        case 'kerberos_einrichten': return await this.kerberosEinrichten(zugang, input, geheim);
        case 'kerberos_entfernen': return await this.kerberosEntfernen(zugang);
        case 'tls_anfordern': return await this.tlsAnfordern(zugang, input);
        case 'tls_einspielen': return await this.tlsEinspielen(zugang, input);
        case 'tls_entfernen': return await this.tlsEntfernen(zugang);
        case 'tls_pruefung_schalten': return await this.tlsPruefungSchalten(zugang, input, geheim);
        case 'tls_erzwingen': return await this.tlsErzwingen(zugang, input, geheim);
        case 'tls_pfad_umstellen': return await this.tlsPfadUmstellen(zugang, input);
        case 'ad_login': return await this.adLogin(zugang, input, geheim);
        case 'ad_login_entfernen': return await this.adLoginEntfernen(zugang, input, geheim);
        case 'alfred_logins_anlegen': return await this.alfredLoginsAnlegen(zugang, geheim);
        case 'alfred_logins_entfernen': return await this.alfredLoginsEntfernen(zugang, geheim);
        case 'sa_schalten': return await this.saSchalten(zugang, input, geheim);
        case 'jobverlauf_recht': return await this.jobverlaufRecht(zugang, input, geheim);
        case 'aktualisieren': return await this.aktualisieren(zugang, input, geheim);
        case 'sa_kennwort_setzen': return await this.saKennwortSetzen(zugang, geheim);
      }
    } catch (err) { return { success: false, error: schwaerze((err as Error).message, geheim).slice(0, 800) }; }
    return { success: false, error: 'Unbekannte Aktion' };
  }

  private async lauf<T extends Record<string, unknown>>(zugang: string, baustein: string, parameter: unknown, zweck: string, timeoutMs: number, eingabe?: Record<string, string>): Promise<T> {
    return this.pruefeLauf<T>(zugang, zweck, await this.d.skript(zugang, baustein, parameter, eingabe ? JSON.stringify(eingabe) : undefined, timeoutMs, zweck));
  }

  /** Nachtrag 2 (M-B): Summe der vom Baustein-Kopf entfernten alten Zugangsdateien im laufenden execute (für die Anzeige) */
  private altZugang = 0;



  private pruefeLauf<T extends Record<string, unknown>>(zugang: string, zweck: string, r: { code: number; stdout: string; stderr: string }): T {
    const e = sqlErgebnis<T>(r.stdout);
    if (e && typeof (e as Record<string, unknown>).alteZugangsdateienEntfernt === 'number') this.altZugang += (e as Record<string, unknown>).alteZugangsdateienEntfernt as number;
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

  /** I8e Folge-Etappe: Login fest nach Art (Spec 2026-11-22 §7.2) — ändernde Bausteine; liefert die Eingabe { sa: <Kennwort>, login } */
  private async sa(zugang: string, wofuer: string, geheim: string[]): Promise<{ sa: string; login: SqlLogin }> {
    pruefeTresorName(saName(zugang));
    const a = await sqlAnmeldung(this.tresor(), zugang, 'aendern', wofuer, geheim);
    { const k = ANMELDE_KONTEXT.getStore(); if (k) k.login = a.login; }
    return a.eingabe;
  }

  private async status(zugang: string, geheim: string[]): Promise<LinuxSqlStatus> {
    let eingabe: Record<string, string> | undefined;
    if (this.d.tresor) {
      const namen = await this.d.tresor.namen();
      const umgestellt = namen.has(alfredLoginTresor(zugang, ADMIN_LOGIN)) || namen.has(alfredLoginTresor(zugang, STATUS_LOGIN));
      // ohne jeden Eintrag wie bisher nur Betriebssystem-Sicht; halb umgestellt → Abbruch (kein Rückfall auf sa)
      if (umgestellt || namen.has(saName(zugang))) {
        const a = await sqlAnmeldung(this.d.tresor, zugang, 'lesen', `SQL-Status ${zugang}`, geheim);
        { const k = ANMELDE_KONTEXT.getStore(); if (k) k.login = a.login; } eingabe = a.eingabe;
      }
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
    const namen = await this.tresor().namen();
    // I8e Folge-Etappe: auf Alfred-Logins umgestellt → Selbstprüfung als alfred_admin, nie ein neues sa-Kennwort (das Skript lehnt eine
    // Neuinstallation mit anderem Login als sa ab)
    const umgestellt = namen.has(alfredLoginTresor(zugang, ADMIN_LOGIN)) || namen.has(alfredLoginTresor(zugang, STATUS_LOGIN));
    // Fix-Welle I-2: ein neues sa-Kennwort kommt erst nach gelungenem Setup in den Tresor (Marke ALFRED-SA-GESETZT, auch wenn ein späterer
    // Schritt scheitert); ist SQL Server schon installiert und fehlt der Tresor-Eintrag, bricht der Baustein ohne Änderung ab
    const k = umgestellt ? { wert: '', neu: false } : await this.vorhandenOderNeu(name, `SQL-Installation ${zugang}`, geheim);
    const eingabe = umgestellt ? await this.sa(zugang, `SQL-Installation ${zugang}`, geheim) : { sa: k.wert, login: 'sa' as const };
    const roh = await this.d.skript(zugang, LINUX_SQL_BAUSTEINE.installation, { ...p, saNeu: k.neu }, JSON.stringify(eingabe), LINUX_SQL_ZEIT_MS.installation, 'SQL Server installieren');
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
      const s = await this.lauf<LinuxSqlStatus & Record<string, unknown>>(zugang, LINUX_SQL_BAUSTEINE.status, {}, 'SQL-Status (Kerne)', LINUX_SQL_ZEIT_MS.status, sa);
      const kerne = s.sql?.kerne;
      if (typeof kerne !== 'number' || kerne < 1) throw new Error(`Kernzahl von ${zugang} nicht lesbar (${s.sqlHinweis ?? s.sqlFehler ?? 'keine SQL-Sicht'}) — tempdb_dateien angeben`);
      dateien = Math.min(8, kerne);
    }
    const tempdb: TempdbParameter = { ...w.tempdb, dateien };
    const ft = pruefeTempdb(tempdb); if (ft) throw new Error(`tempdb: ${ft}`);
    const k = await this.lauf<{ zustand: string; neustart?: boolean }>(zugang, LINUX_SQL_BAUSTEINE.konfiguration, w.konfig, 'SQL-Konfiguration (mssql-conf)', LINUX_SQL_ZEIT_MS.konfiguration);
    const t = await this.lauf<{ zustand: string; dateien?: number; altdateien?: string[] }>(zugang, LINUX_SQL_BAUSTEINE.tempdb, tempdb, 'tempdb einrichten', LINUX_SQL_ZEIT_MS.tempdb, sa);
    const m = await this.lauf<{ zustand: string; maxSpeicherMb?: number }>(zugang, LINUX_SQL_BAUSTEINE.maxspeicher, { mb: w.maxMb }, 'max server memory', LINUX_SQL_ZEIT_MS.maxspeicher, sa);
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
    const r = await this.lauf<{ zustand: string }>(zugang, LINUX_SQL_BAUSTEINE.login, { ...p, nurNeu: k.neu }, `SQL-Login ${p.name}`, LINUX_SQL_ZEIT_MS.login, { ...sa, kennwort: k.wert });
    if (k.neu) await this.tresor().setze(name, k.wert, `Kennwort des SQL-Logins ${p.name} auf ${zugang.toLowerCase()} (Linux)`);
    const text = `SQL-Login ${p.name} auf ${zugang} (${p.serverrollen?.length ? p.serverrollen.join(', ') : 'ohne Serverrolle'}), Kennwort im Tresor (${name})`;
    return { success: true, data: { ...r, login: p.name, serverrollen: p.serverrollen, tresor: name }, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text} — ${r.zustand}` };
  }

  private async pruefdaten(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const p = pruefdatenParameter(input);
    const sa = await this.sa(zugang, `Prüfdaten ${p.datenbank} auf ${zugang}`, geheim);
    const r = await this.lauf<{ zustand: string; zeilen?: number; pruefsumme?: string }>(zugang, LINUX_SQL_BAUSTEINE.pruefdaten, p, `Prüfdaten ${p.datenbank}`, LINUX_SQL_ZEIT_MS.pruefdaten, sa);
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
      zugang, LINUX_SQL_SICHERUNG_BAUSTEINE.einrichten, p, 'Sicherung einrichten', LINUX_SQL_SICHERUNG_ZEIT_MS.einrichten, { ...sa, kennwort });
    if (r.jobs !== 3 || r.zugangsdatei !== 'vorhanden (0600)' || r.timer !== 'aktiv') throw new Error(`Sicherung auf ${zugang}: Nachprüfung fehlgeschlagen (Jobs ${String(r.jobs)}, Zugangsdatei ${String(r.zugangsdatei)}, Timer ${String(r.timer)})`);
    this.d.protokoll?.('I8e Sicherung eingerichtet', { zugang, zustand: r.zustand, ziel: `//${p.server}/${p.freigabe}` });
    const text = `Sicherung auf ${zugang}: 3 Agent-Jobs (FULL täglich, DIFF 6 h, LOG 15 min), Kopie alle 15 min nach //${p.server}/${p.freigabe} als ${p.domaene}\\${p.konto} (Budget ${p.budgetGiB} GiB, belegt ${gib(r.belegtBytes)} GiB); Zugangsdatei ${r.zugangsdatei}; Kopie-Timer aktiv; Probe-Kopie ok`;
    return { success: true, data: r, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text}` };
  }

  private async sicherungJetzt(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const p = sicherungJetztParameter(input);
    const sa = await this.sa(zugang, `Sicherung ${p.art} ${p.datenbank} auf ${zugang}`, geheim);
    const r = await this.lauf<{ zustand: string; datei?: string; sha256?: string; fs01?: boolean; art?: string; erzwungen?: string | null }>(zugang, LINUX_SQL_SICHERUNG_BAUSTEINE.jetzt, p, `Sicherung ${p.art} ${p.datenbank}`, LINUX_SQL_SICHERUNG_ZEIT_MS.jetzt, sa);
    if (r.fs01 !== true || !r.datei) throw new Error(`Sicherung ${p.art} von ${p.datenbank} auf ${zugang}: Kopie auf fs01 nicht bestätigt`);
    // I8e Paket 2 Task 7: in der AG kann die Prozedur statt DIFF/LOG eine FULL erzwingen (Rollenwechsel) — nie still
    const art = r.art === 'FULL' || r.art === 'DIFF' || r.art === 'LOG' ? r.art : p.art;
    const erzw = art !== p.art ? ` (angefordert ${p.art}${r.erzwungen ? ` — ${String(r.erzwungen).slice(0, 200)}` : ''})` : '';
    return { success: true, data: r, display: `✅ Sicherung ${art} von ${p.datenbank} auf ${zugang}${erzw}: ${r.datei} — auf fs01 geprüft (SHA-256 ${String(r.sha256 ?? '').slice(0, 16)}…)` };
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

  /** Owner 19.11.2026 — alte tempdb-Dateien im Datenordner entfernen; jede Datei einzeln genannt, Dateien in Gebrauch bleiben (nie still) */
  private async resteEntfernen(zugang: string, geheim: string[]): Promise<SkillResult> {
    const sa = await this.sa(zugang, `Reste entfernen ${zugang}`, geheim);
    const r = await this.lauf<{ zustand: string; ordner?: string; masterFiles?: number; entfernt?: Array<{ datei: string; bytes: number }>; inGebrauch?: Array<{ datei: string; grund: string }> }>(
      zugang, LINUX_SQL_BAUSTEINE.resteEntfernen, {}, 'alte tempdb-Dateien entfernen', LINUX_SQL_ZEIT_MS.resteEntfernen, sa);
    const weg = (r.entfernt ?? []).map(x => `${x.datei} (${mib(x.bytes)} MiB)`);
    const bleibt = (r.inGebrauch ?? []).map(x => `${x.datei} (${x.grund === 'offen' ? 'geöffnet' : 'in sys.master_files'})`);
    const gebrauch = bleibt.length ? `; in Gebrauch, nicht gelöscht: ${bleibt.join(', ')}` : '';
    this.d.protokoll?.('I8e Reste entfernt', { zugang, entfernt: (r.entfernt ?? []).map(x => x.datei), inGebrauch: (r.inGebrauch ?? []).map(x => x.datei) });
    return {
      success: true, data: r,
      display: weg.length
        ? `✅ Alte tempdb-Dateien auf ${zugang} entfernt (${weg.length}, gegen ${r.masterFiles ?? '?'} Dateien in sys.master_files geprüft): ${weg.join(', ')}${gebrauch}`
        : `Keine alten tempdb-Dateien auf ${zugang} in ${r.ordner ?? '/var/opt/mssql/data'} — nichts zu tun${gebrauch}`,
    };
  }

  // ── I8e Etappe 3 Task 4 — Domänenbeitritt ───────────────────────────────────────────────────────────────────────────────────────

  /**
   * Beitritt mit dem Einmal-Kennwort aus ad-join-<computername> (nur über die Standardeingabe). Fehlt der Eintrag, läuft der Baustein
   * ohne Kennwort: ein schon beigetretener Host meldet „nichts zu tun“, sonst Abbruch. Der Eintrag wird nur nach Erfolg entfernt —
   * danach hat adcli ein eigenes Maschinenkennwort gesetzt, das Einmal-Kennwort gilt nicht mehr.
   */
  private async adBeitreten(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const p = adBeitretenParameter(zugang, input);
    const t = this.tresor();
    const name = pruefeTresorName(joinTresorName(p.computername));
    const da = (await t.namen()).has(name);
    let eingabe: Record<string, string> | undefined;
    if (da) { const einmal = await t.lies(name, `Domänenbeitritt ${p.computername} (Einmal-Kennwort)`); geheim.push(einmal); eingabe = { einmal }; }
    const r = await this.lauf<{ zustand: string; domaene?: string; computerkonto?: string; sssd?: string; beitritt?: string; uhrAbweichungS?: string; fqdn?: string; aenderungen?: string[] }>(
      zugang, LINUX_SQL_BAUSTEINE.adBeitreten, p, 'Domänenbeitritt', LINUX_SQL_ZEIT_MS.adBeitreten, eingabe);
    if (r.sssd !== 'aktiv' || r.domaene !== LINUX_AD.domaene) throw new Error(`Domänenbeitritt ${zugang}: Nachprüfung fehlgeschlagen (Domäne ${String(r.domaene)}, sssd ${String(r.sssd)})`);
    let tresorText: string;
    if (!da) tresorText = `kein Tresor-Eintrag ${name} (Einmal-Kennwort schon verbraucht)`;
    else if (!t.entferne) tresorText = `WARNUNG: Tresor-Eintrag ${name} nicht entfernt (Tresor ohne Entfernen) — das Kennwort ist verbraucht, Eintrag bitte entfernen`;
    else {
      try { tresorText = (await t.entferne(name)) ? `Einmal-Kennwort verbraucht, Tresor-Eintrag ${name} entfernt` : `Tresor-Eintrag ${name} war schon entfernt`; }
      catch (err) { tresorText = `WARNUNG: Tresor-Eintrag ${name} nicht entfernt (${(err as Error).message.slice(0, 120)}) — das Kennwort ist verbraucht, Eintrag bitte entfernen`; }
    }
    this.d.protokoll?.('I8e Domänenbeitritt', { zugang, computername: p.computername, zustand: r.zustand, beitritt: r.beitritt, tresorEntfernt: da && !!t.entferne });
    const text = `AD_JOINED ${r.computerkonto ?? p.computername.toUpperCase()} in ${LINUX_AD.domaene} (${r.fqdn ?? zugang}) — sssd aktiv, realm/id/Gruppe geprüft, Uhrzeit ${r.uhrAbweichungS ?? '?'} s (Zeitquelle DC); ${tresorText}`;
    return { success: true, data: { ...r, tresor: name }, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text}` };
  }

  /** Rückweg nur lokal; das Computerkonto im AD entfernt der Change danach mit windows_ad computerkonto_entfernen */
  private async adVerlassen(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const computername = String(input.computername ?? zugang).trim().toLowerCase();
    const fp = pruefeAdVerlassen({ computername }); if (fp) throw new Error(fp);
    const r = await this.lauf<{ zustand: string; domaene?: string; sssd?: string; belassen?: string[]; aenderungen?: string[] }>(
      zugang, LINUX_SQL_BAUSTEINE.adVerlassen, { computername }, 'Domäne verlassen', LINUX_SQL_ZEIT_MS.adVerlassen);
    if (r.sssd !== 'aus' && r.sssd !== 'fremd') throw new Error(`Domäne verlassen ${zugang}: Nachprüfung fehlgeschlagen (sssd ${String(r.sssd)})`);
    this.d.protokoll?.('I8e Domäne verlassen', { zugang, zustand: r.zustand, belassen: r.belassen ?? [] });
    // Fix-Runde 1: Fremdes (nicht von ad_beitreten) bleibt — nie still, steht in der Anzeige
    const bel = r.belassen?.length ? `; belassen (nicht von Alfred): ${r.belassen.join('; ').slice(0, 400)}` : '';
    const eigen = r.sssd === 'aus' ? 'sssd aus, Alfreds sssd.conf/krb5.conf und Keytab entfernt, NSS und PAM ohne sss' : 'fremde sssd-Einrichtung unverändert';
    const text = `AD_LEFT ${zugang} hat ${LINUX_AD.domaene} lokal verlassen (${eigen})${bel} — Computerkonto im AD entfernt windows_ad computerkonto_entfernen`;
    return { success: true, data: r, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text}` };
  }

  // ── Ruling R11 — Zeitquelle an den DCs ─────────────────────────────────────────────────────────────────────────────────────────

  /** Drop-in, Neustart, Nachweis im Baustein; der Skill prüft das Ergebnis noch einmal (synchron, Server ein DC, |Offset| < 1 s) */
  private async zeitquelleEinrichten(zugang: string): Promise<SkillResult> {
    const r = await this.lauf<{ zustand: string; server?: string; offsetMs?: number; synchronisiert?: boolean; aenderungen?: string[] }>(
      zugang, LINUX_SQL_BAUSTEINE.zeitquelleEinrichten, {}, 'Zeitquelle einrichten', LINUX_SQL_ZEIT_MS.zeitquelleEinrichten);
    if (r.synchronisiert !== true || !ZEITQUELLE_DCS.includes(String(r.server)) || typeof r.offsetMs !== 'number' || Math.abs(r.offsetMs) >= 1000) {
      throw new Error(`Zeitquelle ${zugang}: Nachprüfung fehlgeschlagen (synchronisiert ${String(r.synchronisiert)}, Server ${String(r.server)}, Offset ${String(r.offsetMs)} ms)`);
    }
    this.d.protokoll?.('I8e Zeitquelle', { zugang, zustand: r.zustand, server: r.server, offsetMs: r.offsetMs, aenderungen: r.aenderungen });
    const text = `TIME_SYNCED ${zugang}: systemd-timesyncd synchron mit DC ${r.server} (Offset ${r.offsetMs} ms; Drop-in ${ZEITQUELLE_DROPIN})`;
    return { success: true, data: r, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text} — geändert: ${(r.aenderungen ?? []).join(', ')}` };
  }

  // ── I8e Etappe 3 Task 5 — Keytab der SQL-Instanz ───────────────────────────────────────────────────────────────────────────────

  /** Kennwort von svc-sqllnx nur über stdin; der Skill prüft das Ergebnis noch einmal (kvno, 6 SPNs, mssql-conf ohne Neustart) */
  private async kerberosEinrichten(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const p = kerberosEingabe(zugang, input);
    const t = this.tresor();
    const name = pruefeTresorName(KERBEROS_KONTO_TRESOR);
    if (!(await t.namen()).has(name)) throw new Error(`Tresor-Eintrag ${name} fehlt — Kennwort von ${SQL_KERBEROS_KONTO} (windows_ad dienstkonto_anlegen konto ${SQL_KERBEROS_KONTO})`);
    const kennwort = await t.lies(name, `Keytab ${SQL_KERBEROS_KONTO} auf ${p.computername}`); geheim.push(kennwort);
    const r = await this.lauf<{ zustand: string; kvno?: number; spns?: number; principals?: number; keytab?: string; keytabNeu?: boolean; aeltereKvno?: number[]; salz?: string; neustartNoetig?: boolean; aenderungen?: string[] }>(
      zugang, LINUX_SQL_BAUSTEINE.kerberosEinrichten, p, 'Keytab einrichten', LINUX_SQL_ZEIT_MS.kerberosEinrichten, { kennwort });
    if (typeof r.kvno !== 'number' || !Number.isInteger(r.kvno) || r.kvno < 1 || r.spns !== KERBEROS_SPNS.length || typeof r.neustartNoetig !== 'boolean' || r.keytab !== SQL_KEYTAB) {
      throw new Error(`Keytab ${zugang}: Nachprüfung fehlgeschlagen (kvno ${String(r.kvno)}, SPNs ${String(r.spns)}, neustartNoetig ${String(r.neustartNoetig)})`);
    }
    this.d.protokoll?.('I8e Keytab', { zugang, computername: p.computername, zustand: r.zustand, kvno: r.kvno, aeltereKvno: r.aeltereKvno ?? [], salz: r.salz, neustartNoetig: r.neustartNoetig, aenderungen: r.aenderungen });
    const alt = r.aeltereKvno?.length ? `, ältere kvno ${r.aeltereKvno.join('/')} behalten` : '';
    const neustart = r.neustartNoetig ? 'Neustart von SQL Server nötig (rollierend per Change)' : 'kein Neustart nötig';
    const text = `KERBEROS_KEYTAB_OK ${zugang}: ${SQL_KEYTAB} kvno ${r.kvno} (= AD), ${r.spns} SPNs + ${SQL_KERBEROS_KONTO} je AES256/AES128${alt}; kinit -k und kvno -k gelungen; mssql-conf kerberoskeytabfile/privilegedadaccount gesetzt; ${neustart}`;
    return { success: true, data: { ...r, tresor: name }, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text} — geändert: ${(r.aenderungen ?? []).join(', ')}` };
  }

  /** Rückweg: nur Alfreds mssql-conf-Werte und ein Keytab mit ausschließlich eigenen Principals; Fremdes bleibt (belassen) */
  private async kerberosEntfernen(zugang: string): Promise<SkillResult> {
    const r = await this.lauf<{ zustand: string; belassen?: string[]; neustartNoetig?: boolean; aenderungen?: string[] }>(
      zugang, LINUX_SQL_BAUSTEINE.kerberosEntfernen, {}, 'Keytab entfernen', LINUX_SQL_ZEIT_MS.kerberosEntfernen);
    this.d.protokoll?.('I8e Keytab entfernt', { zugang, zustand: r.zustand, belassen: r.belassen ?? [], neustartNoetig: r.neustartNoetig });
    const bel = r.belassen?.length ? `; belassen (nicht von Alfred): ${r.belassen.join('; ').slice(0, 400)}` : '';
    const neustart = r.neustartNoetig ? ' — Neustart von SQL Server nötig (rollierend per Change)' : '';
    const text = `KERBEROS_REMOVED ${zugang}: ${(r.aenderungen ?? []).join(', ') || 'nichts von Alfred vorhanden'}${bel}${neustart}`;
    return { success: true, data: r, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text}` };
  }

  // ── I8e Etappe 3 Task 6 — TLS ─────────────────────────────────────────────────────────────────────────────────────────────────

  /** Schlüssel + Anforderung auf dem Host; der Skill prüft die Anforderung noch einmal (PEM-Form, SHA-256 = DER, kein privater Block) */
  private async tlsAnfordern(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const p = tlsEingabeParameter(zugang, input);
    const r = await this.lauf<{ zustand: string; cn?: string; sans?: string[]; bits?: number; schluesselNeu?: boolean; csrPem?: string; csrSha256?: string; csrBase64?: string; aenderungen?: string[] }>(
      zugang, LINUX_SQL_BAUSTEINE.tlsAnfordern, p, 'TLS-Anforderung', LINUX_SQL_ZEIT_MS.tlsAnfordern);
    const pem = String(r.csrPem ?? '').replace(/\r\n/g, '\n');
    const form = pruefeCsrForm(pem);
    const b64 = String(r.csrBase64 ?? '');
    const gleich = !form && /^[0-9a-f]{64}$/.test(String(r.csrSha256)) && csrSha256(pem) === r.csrSha256 && pem.replace(/-----[^-]+-----|\s/g, '') === b64;
    if (!gleich || /PRIVATE/i.test(JSON.stringify(r)) || r.cn !== p.cn || JSON.stringify(r.sans) !== JSON.stringify(p.sans) || r.bits !== TLS_BITS) {
      throw new Error(`TLS-Anforderung ${zugang}: Nachprüfung fehlgeschlagen (${form ?? `CN ${String(r.cn)}, SHA-256 ${String(r.csrSha256).slice(0, 64)}`})`);
    }
    this.d.protokoll?.('I8e TLS-Anforderung', { zugang, cn: p.cn, zustand: r.zustand, schluesselNeu: r.schluesselNeu, csrSha256: r.csrSha256 });
    // csrBase64 (DER, striktes Base64) ist die Form, die ein Change-Verweis als ganzen Wert in csr_base64 trägt
    const data = { zustand: r.zustand, cn: p.cn, sans: p.sans, bits: TLS_BITS, schluesselNeu: r.schluesselNeu === true, csrPem: pem, csrSha256: r.csrSha256, csrBase64: b64, aenderungen: r.aenderungen ?? [] };
    const text = `TLS_CSR_READY ${zugang}: Anforderung CN=${p.cn}, SAN ${p.sans.join(', ')}, RSA ${TLS_BITS}, SHA-256 ${r.csrSha256}; Schlüssel ${TLS_KEY_NEU} ${r.schluesselNeu ? 'neu erzeugt' : 'vorhanden, wiederverwendet'} (verlässt den Host nicht); Anforderung in data.csrBase64/csrPem → windows_pki fremd_csr_ausstellen`;
    return { success: true, data, display: `✅ ${text}` };
  }

  /** Zertifikat + Kette prüfen und einspielen; der Skill prüft das Ergebnis noch einmal (Thumbprint, CN, Restlaufzeit, Neustart-Angabe) */
  private async tlsEinspielen(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const p = tlsEingabeParameter(zugang, input);
    const e = tlsEingabe(input);
    const pe = { ...p, rootSha256: e.rootSha256 };
    const r = await this.lauf<{ zustand: string; cn?: string; thumbprint?: string; gueltigBis?: string; restTage?: number; schluessel?: string; neustartNoetig?: boolean; aenderungen?: string[] }>(
      zugang, LINUX_SQL_BAUSTEINE.tlsEinspielen, pe, 'TLS einspielen', LINUX_SQL_ZEIT_MS.tlsEinspielen, { zertifikat: e.zertifikat, kette: e.kette });
    if (r.thumbprint !== e.thumbprint || r.cn !== p.cn || typeof r.restTage !== 'number' || r.restTage < TLS_MIN_TAGE || typeof r.neustartNoetig !== 'boolean' || !r.gueltigBis) {
      throw new Error(`TLS ${zugang}: Nachprüfung fehlgeschlagen (Thumbprint ${String(r.thumbprint)} statt ${e.thumbprint}, CN ${String(r.cn)}, Resttage ${String(r.restTage)}, neustartNoetig ${String(r.neustartNoetig)})`);
    }
    this.d.protokoll?.('I8e TLS eingespielt', { zugang, cn: p.cn, zustand: r.zustand, thumbprint: r.thumbprint, gueltigBis: r.gueltigBis, neustartNoetig: r.neustartNoetig, aenderungen: r.aenderungen });
    const neustart = r.neustartNoetig ? 'Neustart von SQL Server nötig (rollierend per Change)' : 'kein Neustart nötig';
    const text = `TLS_INSTALLED ${zugang}: ${TLS_CRT} Thumbprint ${r.thumbprint}, gültig bis ${r.gueltigBis} (${r.restTage} Tage), CN=${p.cn}, SAN ${p.sans.join(', ')}, passt zu ${TLS_KEY} (0400 mssql:mssql); Kette AD3033 Issuing + Root geprüft und im Vertrauensspeicher; mssql-conf tlscert/tlskey/tlsprotocols ${TLS_PROTOKOLLE} gesetzt, Verschlüsselung NICHT erzwungen; ${neustart}`;
    return { success: true, data: r, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text} — geändert: ${(r.aenderungen ?? []).join(', ')}` };
  }

  /** Rückweg: nur Alfreds mssql-conf-Werte und Dateien laut Manifest; Fremdes bleibt (belassen); Abbruch, solange forceencryption 1 */
  private async tlsEntfernen(zugang: string): Promise<SkillResult> {
    const r = await this.lauf<{ zustand: string; belassen?: string[]; neustartNoetig?: boolean; aenderungen?: string[] }>(
      zugang, LINUX_SQL_BAUSTEINE.tlsEntfernen, {}, 'TLS entfernen', LINUX_SQL_ZEIT_MS.tlsEntfernen);
    this.d.protokoll?.('I8e TLS entfernt', { zugang, zustand: r.zustand, belassen: r.belassen ?? [], neustartNoetig: r.neustartNoetig });
    const bel = r.belassen?.length ? `; belassen (nicht von Alfred): ${r.belassen.join('; ').slice(0, 400)}` : '';
    const neustart = r.neustartNoetig ? ' — Neustart von SQL Server nötig (rollierend per Change)' : '';
    const text = `TLS_REMOVED ${zugang}: ${(r.aenderungen ?? []).join(', ') || 'nichts von Alfred vorhanden'}${bel}${neustart}`;
    return { success: true, data: r, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text}` };
  }

  /**
   * Task 7 — Schalter der Zertifikatsprüfung: an=true mit sa (Probe-Verbindung -N gegen den FQDN), an=false ohne Tresor (Rückweg).
   * Der Skill prüft das Ergebnis noch einmal (Schalter, FQDN, verschlüsselt).
   */
  private async tlsPruefungSchalten(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    if (typeof input.an !== 'boolean') throw new Error('an: true oder false');
    const host = zugang.toLowerCase();
    if (!TLS_HOSTS.includes(host)) throw new Error(`zugang: Zertifikatsprüfung nur auf ${TLS_HOSTS.join(', ')}`);
    const p: TlsPruefungParameter = input.an ? { an: true, cn: tlsParameter(host).cn } : { an: false };
    const f = pruefeTlsPruefung(p); if (f) throw new Error(f);
    const eingabe = p.an ? await this.sa(zugang, `Zertifikatsprüfung ${zugang} (Probe-Verbindung)`, geheim) : undefined;
    const r = await this.lauf<{ zustand: string; schalter?: string; fqdn?: string; verschluesselt?: boolean; datei?: string; aenderungen?: string[] }>(
      zugang, LINUX_SQL_BAUSTEINE.tlsPruefungSchalten, p, `Zertifikatsprüfung ${p.an ? 'an' : 'aus'}`, LINUX_SQL_ZEIT_MS.tlsPruefungSchalten, eingabe);
    const ok = p.an ? r.schalter === 'an' && r.fqdn === p.cn && r.verschluesselt === true && r.datei === TLS_PRUEF_SCHALTER : r.schalter === 'aus' && r.datei === TLS_PRUEF_SCHALTER;
    if (!ok) throw new Error(`Zertifikatsprüfung ${zugang}: Nachprüfung fehlgeschlagen (Schalter ${String(r.schalter)}, FQDN ${String(r.fqdn)}, verschlüsselt ${String(r.verschluesselt)})`);
    this.d.protokoll?.('I8e Zertifikatsprüfung', { zugang, an: p.an, zustand: r.zustand, fqdn: r.fqdn, aenderungen: r.aenderungen });
    const text = p.an
      ? `TLS_PRUEFUNG_AN ${zugang}: Alfreds SQL-Verbindungen gehen mit -N an ${p.cn} und prüfen das Zertifikat (Vertrauensspeicher, Name); Probe als sa verschlüsselt; Schalter ${TLS_PRUEF_SCHALTER} (0644 root, Inhalt ${p.cn}) — kein Rückfall auf -C`
      : `TLS_PRUEFUNG_AUS ${zugang}: Schalter ${TLS_PRUEF_SCHALTER} entfernt — Alfreds SQL-Verbindungen gehen wieder an localhost ohne Zertifikatsprüfung`;
    return { success: true, data: r, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text}` };
  }

  /**
   * Task 8 — network.forceencryption: an=true (sa für die Probe) nur mit eingespieltem TLS, Zertifikatsprüfung an und fehlerfreiem Pacemaker
   * auf diesem Knoten (Baustein); an=false ohne Tresor (Rückweg). KEIN Neustart — der Change startet rollierend neu (linux_ha ag_failover).
   */
  private async tlsErzwingen(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const p = tlsErzwingenParameter(zugang, input);
    const eingabe = p.an ? await this.sa(zugang, `Verschlüsselung erzwingen ${zugang} (Probe-Verbindung)`, geheim) : undefined;
    const r = await this.lauf<{ zustand: string; erzwungen?: boolean; vonAlfred?: boolean; belassen?: string[]; fqdn?: string; neustartNoetig?: boolean; pacemaker?: { fehlerzaehler?: number; fehlaktionen?: unknown[]; online?: boolean; knoten?: string }; aenderungen?: string[] }>(
      zugang, LINUX_SQL_BAUSTEINE.tlsErzwingen, p, `Verschlüsselung ${p.an ? 'erzwingen' : 'nicht erzwingen'}`, LINUX_SQL_ZEIT_MS.tlsErzwingen, eingabe);
    const pm = r.pacemaker;
    const ok = typeof r.neustartNoetig === 'boolean' && (p.an
      ? r.erzwungen === true && r.fqdn === p.cn && !!pm && pm.knoten === p.host && pm.online === true && pm.fehlerzaehler === 0 && Array.isArray(pm.fehlaktionen) && pm.fehlaktionen.length === 0
      : r.erzwungen === false || (r.erzwungen === true && !!r.belassen?.length));
    if (!ok) throw new Error(`Verschlüsselung ${zugang}: Nachprüfung fehlgeschlagen (erzwungen ${String(r.erzwungen)}, FQDN ${String(r.fqdn)}, Pacemaker ${JSON.stringify(pm ?? null).slice(0, 200)})`);
    this.d.protokoll?.('I8e TLS erzwingen', { zugang, an: p.an, zustand: r.zustand, neustartNoetig: r.neustartNoetig, aenderungen: r.aenderungen });
    const neustart = r.neustartNoetig ? 'Neustart von SQL Server nötig (rollierend per Change: Sekundär, Failover, Primär)' : 'kein Neustart nötig';
    const text = p.an
      ? `TLS_ERZWUNGEN ${zugang}: mssql.conf network.forceencryption 1 — Vorbedingungen erfüllt: TLS von Alfred eingespielt, Zertifikatsprüfung an (Probe -N ${p.cn} verschlüsselt), Pacemaker auf ${p.host} online ohne Fehlaktionen (30 min), Fehlerzähler ag_cluster 0 (30 min)${r.vonAlfred === false ? '; Wert war schon vor Alfred gesetzt (kein Vermerk — der Rückweg lässt ihn stehen)' : ''}; ${neustart}`
      : r.erzwungen
        ? `TLS_ERZWUNGEN_BELASSEN ${zugang}: mssql.conf network.forceencryption bleibt 1 — belassen (nicht von Alfred): ${(r.belassen ?? []).join('; ').slice(0, 300)}`
        : `TLS_NICHT_ERZWUNGEN ${zugang}: mssql.conf network.forceencryption zurückgenommen (Standard, unverschlüsselte Verbindungen wieder zulässig)${r.belassen?.length ? `; belassen: ${r.belassen.join('; ').slice(0, 300)}` : ''}; ${neustart}`;
    return { success: true, data: r, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text}` };
  }

  /**
   * Microsoft #979 — network.tlscert aus secrets in TLS_ORDNER (an=true) bzw. zurück (an=false, Rückweg). Kein Tresor, KEIN Neustart —
   * der Change startet SQL Server danach im Standby neu (Sekundär) bzw. nach dem Failover.
   */
  private async tlsPfadUmstellen(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (typeof input.an !== 'boolean') throw new Error('an: true oder false');
    const host = zugang.trim().toLowerCase();
    if (!TLS_HOSTS.includes(host)) throw new Error(`zugang: Zertifikatspfad nur auf ${TLS_HOSTS.join(', ')}`);
    const p = { an: input.an };
    const r = await this.lauf<{ zustand: string; zertifikat?: string; neustartNoetig?: boolean; aenderungen?: string[] }>(
      zugang, LINUX_SQL_BAUSTEINE.tlsPfadUmstellen, p, `Zertifikatspfad ${p.an ? 'umstellen' : 'zurückstellen'}`, LINUX_SQL_ZEIT_MS.tlsPfadUmstellen);
    const soll = p.an ? TLS_CRT : TLS_CRT_ALT;
    if (r.zertifikat !== soll || typeof r.neustartNoetig !== 'boolean') throw new Error(`Zertifikatspfad ${zugang}: Nachprüfung fehlgeschlagen (network.tlscert ${String(r.zertifikat).slice(0, 80)}, erwartet ${soll})`);
    this.d.protokoll?.('I8e TLS-Pfad (#979)', { zugang, an: p.an, zustand: r.zustand, neustartNoetig: r.neustartNoetig, aenderungen: r.aenderungen });
    const neustart = r.neustartNoetig ? 'Neustart von SQL Server nötig (im Standby bzw. nach dem Failover, per Change)' : 'kein Neustart nötig';
    const text = p.an
      ? `TLS_PFAD_NEU ${zugang}: network.tlscert = ${TLS_CRT} (0444 mssql, Ordner 0755 — für den SQL Agent lesbar, Microsoft #979), Schlüssel bleibt ${TLS_KEY}; ${neustart}`
      : `TLS_PFAD_ALT ${zugang}: network.tlscert = ${TLS_CRT_ALT}, Kopie ${TLS_CRT} entfernt — der SQL Agent startet mit diesem Pfad nicht (Microsoft #979); ${neustart}`;
    return { success: true, data: r, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text}` };
  }

  /** Task 8 — AD-Gruppen-Login (sa aus dem Tresor); der Skill prüft das Ergebnis noch einmal (Name, Typ G, Rollen) */
  private async adLogin(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const p = adLoginParameter(zugang, input);
    const sa = await this.sa(zugang, `AD-Login ${adLoginName(p.gruppe)} auf ${zugang}`, geheim);
    const r = await this.lauf<{ zustand: string; login?: string; typ?: string; serverrolle?: string; datenbank?: string; datenbankrolle?: string; aenderungen?: string[] }>(
      zugang, LINUX_SQL_BAUSTEINE.adLogin, p, `AD-Login ${p.gruppe}`, LINUX_SQL_ZEIT_MS.adLogin, sa);
    const n = adLoginName(p.gruppe);
    if (r.login !== n || r.typ !== 'G' || r.serverrolle !== (p.serverrolle ?? '') || r.datenbank !== (p.datenbank ?? '') || r.datenbankrolle !== (p.datenbankrolle ?? '')) {
      throw new Error(`AD-Login ${zugang}: Nachprüfung fehlgeschlagen (Login ${String(r.login)}, Typ ${String(r.typ)}, Serverrolle ${String(r.serverrolle)}, Datenbank ${String(r.datenbank)})`);
    }
    this.d.protokoll?.('I8e AD-Login', { zugang, login: n, zustand: r.zustand, aenderungen: r.aenderungen });
    const rollen = [p.serverrolle ? `Serverrolle ${p.serverrolle}` : '', p.datenbank ? `${p.datenbank}: ${p.datenbankrolle}` : ''].filter(Boolean).join(', ');
    const text = `AD_LOGIN_OK ${zugang}: ${n} (Windows-Gruppe, aktiv) — ${rollen}; Anlagen vermerkt in ${AD_LOGINS_DATEI} (Rückweg ad_login_entfernen)`;
    return { success: true, data: r, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text} — geändert: ${(r.aenderungen ?? []).join(', ')}` };
  }

  /** Task 8 — Rückweg: nur Vermerktes (AD_LOGINS_DATEI), Fremdes bleibt (belassen) */
  private async adLoginEntfernen(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const p = adLoginParameter(zugang, input);
    const sa = await this.sa(zugang, `AD-Login ${adLoginName(p.gruppe)} entfernen auf ${zugang}`, geheim);
    const r = await this.lauf<{ zustand: string; login?: string; belassen?: string[]; aenderungen?: string[] }>(
      zugang, LINUX_SQL_BAUSTEINE.adLoginEntfernen, p, `AD-Login ${p.gruppe} entfernen`, LINUX_SQL_ZEIT_MS.adLoginEntfernen, sa);
    const n = adLoginName(p.gruppe);
    if (r.login !== n) throw new Error(`AD-Login entfernen ${zugang}: Nachprüfung fehlgeschlagen (Login ${String(r.login)})`);
    this.d.protokoll?.('I8e AD-Login entfernt', { zugang, login: n, zustand: r.zustand, belassen: r.belassen ?? [] });
    const bel = r.belassen?.length ? `; belassen (nicht von Alfred): ${r.belassen.join('; ').slice(0, 400)}` : '';
    const text = `AD_LOGIN_REMOVED ${zugang}: ${n} — ${(r.aenderungen ?? []).join(', ') || 'nichts von Alfred vorhanden'}${bel}`;
    return { success: true, data: r, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text}` };
  }

  // ── I8e Folge-Etappe: eigene Alfred-Logins, sa schalten, Notfallweg ───────────────────────────────────────────────────────────

  /** beide Logins anlegen; neue Kennwörter erst nach gelungenem Anlegen (Marke ALFRED-LOGIN-GESETZT) in den Tresor (wie Fix-Welle I-2) */
  private async alfredLoginsAnlegen(zugang: string, geheim: string[]): Promise<SkillResult> {
    const an = await this.sa(zugang, `Alfred-Logins auf ${zugang}`, geheim);
    const nA = pruefeTresorName(alfredLoginTresor(zugang, ADMIN_LOGIN));
    const nS = pruefeTresorName(alfredLoginTresor(zugang, STATUS_LOGIN));
    const ka = await this.vorhandenOderNeu(nA, `Alfred-Logins auf ${zugang}`, geheim);
    const ks = await this.vorhandenOderNeu(nS, `Alfred-Logins auf ${zugang}`, geheim);
    // waehleAnmeldung lässt halbe Umstellungen nicht durch — beide neu oder beide vorhanden
    if (ka.neu !== ks.neu) throw new Error(`Alfred-Logins ${zugang}: Tresor-Einträge uneinheitlich — nichts geändert`);
    const roh = await this.d.skript(zugang, LINUX_SQL_BAUSTEINE.alfredLoginsAnlegen, { nurNeu: ka.neu }, JSON.stringify({ ...an, admin: ka.wert, status: ks.wert }),
      LINUX_SQL_ZEIT_MS.alfredLoginsAnlegen, 'Alfred-Logins anlegen');
    const gesetzt = roh.stdout.split(/\r?\n/).some(z => z.trim() === 'ALFRED-LOGIN-GESETZT');
    if (ka.neu && gesetzt) {
      await this.tresor().setze(nA, ka.wert, `SQL-Login alfred_admin (sysadmin) auf ${zugang.toLowerCase()} (Linux)`);
      await this.tresor().setze(nS, ks.wert, `SQL-Login alfred_status (nur lesen) auf ${zugang.toLowerCase()} (Linux)`);
    }
    const r = this.pruefeLauf<{ zustand: string; admin?: string; status?: string }>(zugang, 'Alfred-Logins anlegen', roh);
    this.d.protokoll?.('I8e Alfred-Logins', { zugang, zustand: r.zustand, neu: ka.neu });
    const text = `Alfred-Logins auf ${zugang}: alfred_admin (sysadmin, ${r.admin}), alfred_status (nur lesen, ${r.status}); Kennwörter im Tresor (${nA}, ${nS})`;
    return { success: true, data: r, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text}` };
  }

  /** Rückweg: nur als sa (aktiv, ohne Host-Marke); danach beide Tresor-Einträge entfernen (Zugang ist wieder auf sa) */
  private async alfredLoginsEntfernen(zugang: string, geheim: string[]): Promise<SkillResult> {
    const t = this.tresor();
    if (!t.entferne) throw new Error('Tresor kann keine Einträge entfernen — Alfred-Logins bleiben; nichts geändert');
    const nSa = pruefeTresorName(saName(zugang));
    if (!(await t.namen()).has(nSa)) throw new Error(`Tresor-Eintrag ${nSa} fehlt — Rückweg nur als sa; nichts geändert`);
    const kw = await t.lies(nSa, `Alfred-Logins entfernen auf ${zugang}`); geheim.push(kw);
    const r = await this.lauf<{ zustand: string }>(zugang, LINUX_SQL_BAUSTEINE.alfredLoginsEntfernen, {}, 'Alfred-Logins entfernen', LINUX_SQL_ZEIT_MS.alfredLoginsEntfernen, { sa: kw, login: 'sa' });
    for (const n of [alfredLoginTresor(zugang, ADMIN_LOGIN), alfredLoginTresor(zugang, STATUS_LOGIN)]) await t.entferne(n);
    this.d.protokoll?.('I8e Alfred-Logins entfernt', { zugang, zustand: r.zustand });
    return { success: true, data: r, display: `✅ Alfred-Logins auf ${zugang} entfernt, Tresor-Einträge entfernt — Anmeldung wieder als sa` };
  }

  /** sa ab-/einschalten — nur als alfred_admin (Zugang umgestellt), sonst Abbruch vor dem Fernaufruf */
  private async saSchalten(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const f = pruefeSaSchalten(input); if (f) throw new Error(f);
    const an = input.an as boolean;
    const e = await this.sa(zugang, `sa ${an ? 'einschalten' : 'abschalten'} auf ${zugang}`, geheim);
    if (e.login !== ADMIN_LOGIN) throw new Error(`sa_schalten auf ${zugang} nur als alfred_admin — zuerst alfred_logins_anlegen; nichts geändert`);
    const r = await this.lauf<{ zustand: string; sa?: string }>(zugang, LINUX_SQL_BAUSTEINE.saSchalten, { an }, `sa ${an ? 'einschalten' : 'abschalten'}`, LINUX_SQL_ZEIT_MS.saSchalten, e);
    const soll = an ? 'aktiv' : 'aus';
    if (r.sa !== soll) throw new Error(`sa_schalten ${zugang}: Nachprüfung fehlgeschlagen (sa ${String(r.sa)}, Soll ${soll})`);
    this.d.protokoll?.('I8e sa geschaltet', { zugang, an, zustand: r.zustand });
    const text = `sa auf ${zugang}: ${soll}${an ? '' : ` (Host-Marke ${SA_SPERRE})`}`;
    return { success: true, data: r, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text}` };
  }

  /** Owner 24.11.: Leserecht von alfred_status auf den Jobverlauf schalten — nur als alfred_admin, Nachweis aus dem msdb-Katalog */
  private async jobverlaufRecht(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const f = pruefeSaSchalten(input); if (f) throw new Error(f);
    const an = input.an as boolean;
    const e = await this.sa(zugang, `Jobverlauf-Recht ${an ? 'geben' : 'nehmen'} auf ${zugang}`, geheim);
    if (e.login !== ADMIN_LOGIN) throw new Error(`jobverlauf_recht auf ${zugang} nur als alfred_admin — nichts geändert`);
    const r = await this.lauf<{ zustand: string; rechte?: number }>(zugang, LINUX_SQL_BAUSTEINE.jobverlaufRecht, { an }, `Jobverlauf-Recht ${an ? 'geben' : 'nehmen'}`, LINUX_SQL_ZEIT_MS.jobverlaufRecht, e);
    const soll = an ? 2 : 0;
    if (r.rechte !== soll) throw new Error(`jobverlauf_recht ${zugang}: Nachprüfung fehlgeschlagen (${String(r.rechte)} Rechte, Soll ${soll})`);
    this.d.protokoll?.('Jobverlauf-Recht geschaltet', { zugang, an, zustand: r.zustand });
    const text = `JOBVERLAUF_RECHT ${an ? 'AN' : 'AUS'} ${zugang}: alfred_status ${an ? 'liest' : 'liest nicht mehr'} msdb.dbo.sysjobs und sysjobhistory (${soll} Rechte im Katalog)`;
    return { success: true, data: r, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text}` };
  }

  /** Owner 23./24.11.: SQL-Server-Update (CU) auf einem Knoten im Standby — nur als alfred_admin, Selbstprüfung im Baustein */
  private async aktualisieren(zugang: string, input: Record<string, unknown>, geheim: string[]): Promise<SkillResult> {
    const f = pruefeSqlUpdate(input); if (f) throw new Error(f);
    const version = String(input.version);
    const e = await this.sa(zugang, `SQL-Server-Update auf ${zugang}`, geheim);
    if (e.login !== ADMIN_LOGIN) throw new Error(`aktualisieren auf ${zugang} nur als alfred_admin — nichts geändert`);
    const r = await this.lauf<{ zustand: string; von?: string; version?: string; paket?: string; ha?: string | null }>(zugang, LINUX_SQL_BAUSTEINE.aktualisieren, { version }, 'SQL-Server-Update', LINUX_SQL_ZEIT_MS.aktualisieren, e);
    if (r.paket !== version || r.version !== version.replace(/-\d+$/, '')) throw new Error(`aktualisieren ${zugang}: Nachprüfung fehlgeschlagen (Paket ${String(r.paket)}, Version ${String(r.version)}, Soll ${version})`);
    this.d.protokoll?.('SQL-Server aktualisiert', { zugang, von: r.von, version: r.version, ha: r.ha, zustand: r.zustand });
    const text = `SQL_AKTUALISIERT ${zugang}: ${r.von ?? '?'} → ${r.version}${r.ha ? ` (mssql-server-ha ${r.ha})` : ''}, Pakete gehalten, mssql.conf unverändert`;
    return { success: true, data: r, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text}` };
  }

  /** Notfallweg: vorhandenes sa-Kennwort aus dem Tresor über mssql-conf setzen (Tresor unverändert); Knoten muss im Standby sein */
  private async saKennwortSetzen(zugang: string, geheim: string[]): Promise<SkillResult> {
    const t = this.tresor();
    const nSa = pruefeTresorName(saName(zugang));
    if (!(await t.namen()).has(nSa)) throw new Error(`Tresor-Eintrag ${nSa} fehlt — der Notfallweg setzt nur das vorhandene sa-Kennwort; nichts geändert`);
    const kw = await t.lies(nSa, `Notfallweg sa-Kennwort auf ${zugang}`); geheim.push(kw);
    const r = await this.lauf<{ zustand: string; saAbgeschaltet?: boolean; marke?: boolean }>(zugang, LINUX_SQL_BAUSTEINE.saKennwortSetzen, {}, 'sa-Kennwort setzen (Notfallweg)', LINUX_SQL_ZEIT_MS.saKennwortSetzen, { sa: kw, login: 'sa' });
    this.d.protokoll?.('I8e Notfallweg sa-Kennwort', { zugang, saAbgeschaltet: r.saAbgeschaltet, marke: r.marke });
    const text = `sa-Kennwort auf ${zugang} aus dem Tresor gesetzt (${nSa} unverändert); Anmeldung als sa gelungen; sa ${r.saAbgeschaltet ? 'weiter abgeschaltet' : 'aktiv'}${r.marke ? `; Host-Marke ${SA_SPERRE} vorhanden` : ''}`;
    return { success: true, data: r, display: `✅ ${text}` };
  }

  /** Rückweg: nur Alfreds Drop-in; eine fremde Datei an derselben Stelle bleibt (belassen, nie still) */
  private async zeitquelleEntfernen(zugang: string): Promise<SkillResult> {
    const r = await this.lauf<{ zustand: string; belassen?: string[]; aenderungen?: string[] }>(
      zugang, LINUX_SQL_BAUSTEINE.zeitquelleEntfernen, {}, 'Zeitquelle entfernen', LINUX_SQL_ZEIT_MS.zeitquelleEntfernen);
    this.d.protokoll?.('I8e Zeitquelle entfernt', { zugang, zustand: r.zustand, belassen: r.belassen ?? [] });
    const bel = r.belassen?.length ? `; belassen (nicht von Alfred): ${r.belassen.join('; ').slice(0, 300)}` : '';
    const text = `Zeitquelle DC auf ${zugang} entfernt (Drop-in ${ZEITQUELLE_DROPIN} weg, systemd-timesyncd neu gestartet)${bel}`;
    return { success: true, data: r, display: r.zustand === 'schon' ? `Kein Alfred-Drop-in ${ZEITQUELLE_DROPIN} auf ${zugang}${bel} — nichts zu tun` : `✅ ${text}` };
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
      zugang, LINUX_SQL_SICHERUNG_BAUSTEINE.wiederherstellen, p, `Wiederherstellungs-Beweis ${p.datenbank}`, LINUX_SQL_SICHERUNG_ZEIT_MS.wiederherstellen, { ...sa, kennwort });
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
