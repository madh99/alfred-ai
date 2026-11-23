/**
 * I8e Etappe 3 Task 9 — Ablaufwarnung für die Linux-SQL-Server: TLS-Zertifikat (mssql.conf network.tlscert) und Kerberos-Keytab.
 * Datenquelle ist die feste Lese-Aktion `linux_sql status` (tls.restTage, ad.keytab.aktuell); Befunde der Kategorie `ueberwachung`
 * (wie die Windows-Zertifikatsbefunde, wiederkehrend, lösen sich selbst, sobald die Bedingung entfällt):
 *   - ueberwachung:<zugang>:tls     ≤ 30 Tage mittel, ≤ 7 Tage hoch, abgelaufen hoch
 *   - ueberwachung:<zugang>:keytab  aktuell === false hoch; null (ungeprüft, kein Ticket ohne Kennwort) → weder Befund noch „ok“
 * Nur lesend; kein Modell.
 */
import type { Auffaelligkeit } from './bericht.js';
import type { LinuxSqlStatus } from './linux-sql-skill.js';

/** Zertifikatswarnung wie bei Windows: ab 30 Tagen vor Ablauf, ab 7 Tagen hoch */
export const LINUX_SQL_TLS_WARN_TAGE = 30;
export const LINUX_SQL_TLS_HOCH_TAGE = 7;

/** Owner 23.11.: LOG-Sicherung älter als 2 h, FULL älter als 26 h → hoch (Jobs: LOG alle 15 min, FULL täglich 00:30) */
export const LINUX_SQL_LOG_MAX_MIN = 120;
export const LINUX_SQL_VOLL_MAX_MIN = 26 * 60;
const SYSTEM_DB = new Set(['master', 'model', 'msdb', 'tempdb']);

export function linuxSqlBefunde(zugang: string, status: Pick<LinuxSqlStatus, 'tls' | 'ad' | 'anmeldung' | 'saMarke' | 'agent' | 'konfig'> | null | undefined): Auffaelligkeit[] {
  const a: Auffaelligkeit[] = [];
  const k = (teil: string) => ({ bereich: zugang, schluessel: `ueberwachung:${zugang}:${teil}`, kategorie: 'ueberwachung' as const, zugang });
  const t = status?.tls;
  if (t && t.thumbprint && typeof t.restTage === 'number' && t.restTage <= LINUX_SQL_TLS_WARN_TAGE) {
    const bis = t.gueltigBis ? `, gültig bis ${t.gueltigBis.slice(0, 10)}` : '';
    const wann = t.restTage < 0 ? `ist seit ${-t.restTage} Tagen abgelaufen` : `läuft in ${t.restTage} Tagen ab`;
    a.push({ schwere: t.restTage <= LINUX_SQL_TLS_HOCH_TAGE ? 'hoch' : 'mittel', text: `TLS-Zertifikat ${zugang} ${wann} (Thumbprint ${t.thumbprint.slice(0, 12)}…${bis})`, ...k('tls') });
  }
  if (status?.ad?.keytab?.aktuell === false) {
    const kt = status.ad.keytab;
    a.push({ schwere: 'hoch', text: `Keytab ${zugang} veraltet (kvno ${kt.kvno ?? '?'}, AD-kvno ${kt.adKvno ?? '?'}) — Kerberos-Anmeldungen schlagen nach dem Kennwortwechsel des Dienstkontos fehl`, ...k('keytab') });
  }
  // I8e Folge-Etappe (Spec 2026-11-22 §7.3): nach der Umstellung liest der Status als alfred_status — scheitert das, ist die SQL-Sicht
  // unlesbar. Review I3: ebenso jede gescheiterte Anmeldung bei gesetzter Host-Marke (sa abgeschaltet, z. B. Alfred-Einträge fehlen)
  const an = status?.anmeldung;
  if (an && an.ok === false && (an.login === 'alfred_status' || status?.saMarke === true)) {
    a.push({ schwere: 'hoch', text: `${zugang}: SQL-Anmeldung als ${an.login} gescheitert — Status und Prüfungen ohne SQL-Sicht (Dienst aktiv? Kennwort im Tresor, Login aktiv?)`, ...k('anmeldung') });
  }
  // Realfall 23.11.: Agent seit 20./21.11. gestoppt, keine geplante Sicherung, kein Befund
  const agentAn = /^(true|1|yes)$/i.test(String(status?.konfig?.sqlagent ?? '').trim());
  if (agentAn && status?.agent?.laeuft === false) {
    a.push({ schwere: 'hoch', text: `${zugang}: SQL Server Agent läuft nicht — geplante Sicherungen und Jobs fallen aus (sqlagent.out: ${(status.agent.letzteZeile ?? '?').slice(0, 160)})`, ...k('agent') });
  }
  return a;
}

const alterText = (min: number | null | undefined) => (min === null || min === undefined ? 'nie' : min < 120 ? `vor ${min} min` : `vor ${Math.floor(min / 60)} h`);

/**
 * Überwachung 23.11. — Sicherungsalter je Datenbank über alle Replikate: jedes Replikat führt in msdb nur die eigenen Sicherungen,
 * daher zählt je AG-Datenbank (group_database_id; ohne AG Host+Name) das jüngste Alter. Geprüft nur, wenn auf einem der Hosts die
 * Sicherung eingerichtet ist (Zugangsdatei vorhanden). LOG nur bei Wiederherstellungsmodell FULL/BULK_LOGGED. Schlüssel am ersten Host.
 */
export function linuxSqlSicherungsBefunde(status: ReadonlyMap<string, Partial<LinuxSqlStatus>>): Auffaelligkeit[] {
  type G = { name: string; hosts: string[]; eingerichtet: boolean; voll: number | null; log: number | null; logPflicht: boolean };
  const gruppen = new Map<string, G>();
  const juenger = (a: number | null, b: number | null | undefined) => (b === null || b === undefined ? a : a === null ? b : Math.min(a, b));
  for (const [host, s] of status) {
    const eingerichtet = String(s.sicherung?.zugangsdatei ?? '').startsWith('vorhanden');
    for (const d of s.sql?.datenbanken ?? []) {
      if (SYSTEM_DB.has(d.name.toLowerCase())) continue;
      const key = d.gruppe ? `ag:${d.gruppe}` : `${host}/${d.name}`;
      const g = gruppen.get(key) ?? { name: d.name, hosts: [], eingerichtet: false, voll: null, log: null, logPflicht: false };
      g.hosts.push(host); g.eingerichtet ||= eingerichtet;
      g.voll = juenger(g.voll, d.alterVollMin); g.log = juenger(g.log, d.alterLogMin);
      g.logPflicht ||= /^(FULL|BULK_LOGGED)$/i.test(d.modell ?? '');
      gruppen.set(key, g);
    }
  }
  const a: Auffaelligkeit[] = [];
  for (const g of gruppen.values()) {
    if (!g.eingerichtet) continue;
    const z = [...g.hosts].sort()[0]!;
    const k = (teil: string) => ({ bereich: z, schluessel: `ueberwachung:${z}:sicherung:${g.name}:${teil}`, kategorie: 'ueberwachung' as const, zugang: z });
    const wo = g.hosts.length > 1 ? ` (${[...g.hosts].sort().join(', ')})` : '';
    if (g.voll === null || g.voll > LINUX_SQL_VOLL_MAX_MIN) a.push({ schwere: 'hoch', text: `Datenbank ${g.name}${wo}: letzte FULL-Sicherung ${alterText(g.voll)} (Soll ≤ 26 h)`, ...k('voll') });
    if (g.logPflicht && (g.log === null || g.log > LINUX_SQL_LOG_MAX_MIN)) a.push({ schwere: 'hoch', text: `Datenbank ${g.name}${wo}: letzte LOG-Sicherung ${alterText(g.log)} (Soll ≤ 2 h)`, ...k('log') });
  }
  return a;
}


export type LinuxSqlStatusAufruf = (zugang: string) => Promise<{ success: boolean; data?: unknown; error?: string }>;

/** Alle aktiven Linux-Fernzugänge (nicht Windows) werden gelesen; ob SQL Server darauf läuft, sagt erst der Status (installiert). */
export function linuxSqlZugaenge(zugaenge: Array<{ name: string; system?: string }>): string[] {
  return zugaenge.filter(z => z.system !== 'windows').map(z => z.name);
}

/**
 * Ruling R21 (unlesbar ist nicht ok): nur ein vollständig gelesener Status zählt als Erfassung. Rückgabe: Grund der Lücke oder null.
 * Pflicht: installiert true, ad-Objekt vorhanden; tls-Objekt vorhanden und, wenn ein Zertifikat konfiguriert ist, mit Thumbprint und
 * Restlaufzeit lesbar; ein vorhandenes Keytab muss lesbar (kein fehler) und seine Aktualität geprüft sein (aktuell nicht null).
 */
export function linuxSqlStatusLueckenhaft(s: Partial<LinuxSqlStatus>): string | null {
  if (s.installiert !== true) return 'SQL Server nicht als installiert gemeldet';
  if (!s.ad || typeof s.ad !== 'object') return 'AD-Teil des Status fehlt';
  if (!s.tls || typeof s.tls !== 'object') return 'TLS-Teil des Status fehlt';
  if (s.tls.zertifikat && (!s.tls.thumbprint || typeof s.tls.restTage !== 'number')) return `TLS-Zertifikat ${s.tls.zertifikat} nicht lesbar`;
  // Überwachung 23.11.: bei eingerichteter Sicherung ist das Sicherungsalter nur mit SQL-Sicht prüfbar (unlesbar ist nicht ok)
  if (String(s.sicherung?.zugangsdatei ?? '').startsWith('vorhanden') && !s.sql) return `SQL-Sicht fehlt — Sicherungsalter nicht prüfbar (${(s.sqlFehler ?? s.sqlHinweis ?? 'keine Angabe').slice(0, 80)})`;
  const kt = s.ad.keytab;
  if (kt && (kt.fehler || typeof kt.aktuell !== 'boolean')) return `Keytab nicht prüfbar (${kt.fehler ?? 'Aktualität unbekannt, kein Ticket ohne Kennwort'})`;
  return null;
}

/**
 * Ein Lauf über die übergebenen Linux-Zugänge: je Host status lesen. Hosts ohne SQL Server (installiert false) werden übersprungen
 * (weder erfasst noch Fehler, ihre Befunde bleiben unberührt). Erfasst ist nur ein vollständig gelesener Host; sonst Eintrag in
 * fehler, Befunde bleiben offen.
 */
export async function linuxSqlUeberwachung(zugaenge: string[], status: LinuxSqlStatusAufruf): Promise<{ befunde: Auffaelligkeit[]; erfasst: Set<string>; fehler: string[]; uebersprungen: string[] }> {
  const befunde: Auffaelligkeit[] = []; const erfasst = new Set<string>(); const fehler: string[] = []; const uebersprungen: string[] = [];
  const gelesen = new Map<string, LinuxSqlStatus>();
  for (const z of zugaenge) {
    const r = await status(z).catch((err: Error) => ({ success: false, error: err.message }) as Awaited<ReturnType<LinuxSqlStatusAufruf>>);
    if (!r.success || !r.data || typeof r.data !== 'object') { fehler.push(`${z}: ${(r.error ?? 'kein Status').slice(0, 160)}`); continue; }
    const s = r.data as LinuxSqlStatus;
    if (s.installiert === false) { uebersprungen.push(z); continue; }
    const luecke = linuxSqlStatusLueckenhaft(s);
    if (luecke) { fehler.push(`${z}: Status unvollständig — ${luecke}`); befunde.push(...linuxSqlBefunde(z, s)); continue; }
    befunde.push(...linuxSqlBefunde(z, s));
    erfasst.add(z); gelesen.set(z, s);
  }
  // fail-closed: fehlt ein Host, könnte er das jüngste Replikat sein → Sicherungsalter in diesem Lauf nicht auswerten, und Hosts mit
  // eingerichteter Sicherung gelten nicht als erfasst (ihre Sicherungsbefunde bleiben offen statt fälschlich gelöst)
  if (fehler.length) {
    const betroffen = [...gelesen].filter(([, s]) => String(s.sicherung?.zugangsdatei ?? '').startsWith('vorhanden')).map(([z]) => z);
    for (const z of betroffen) erfasst.delete(z);
    if (betroffen.length) fehler.push(`Sicherungsalter nicht ausgewertet — nicht alle SQL-Hosts vollständig lesbar (offen bleiben: ${betroffen.join(', ')})`);
  } else {
    befunde.push(...linuxSqlSicherungsBefunde(gelesen));
  }
  return { befunde, erfasst, fehler, uebersprungen };
}
