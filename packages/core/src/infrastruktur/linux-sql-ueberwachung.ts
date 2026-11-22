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

export function linuxSqlBefunde(zugang: string, status: Pick<LinuxSqlStatus, 'tls' | 'ad' | 'anmeldung' | 'saMarke'> | null | undefined): Auffaelligkeit[] {
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
  for (const z of zugaenge) {
    const r = await status(z).catch((err: Error) => ({ success: false, error: err.message }) as Awaited<ReturnType<LinuxSqlStatusAufruf>>);
    if (!r.success || !r.data || typeof r.data !== 'object') { fehler.push(`${z}: ${(r.error ?? 'kein Status').slice(0, 160)}`); continue; }
    const s = r.data as LinuxSqlStatus;
    if (s.installiert === false) { uebersprungen.push(z); continue; }
    const luecke = linuxSqlStatusLueckenhaft(s);
    if (luecke) { fehler.push(`${z}: Status unvollständig — ${luecke}`); befunde.push(...linuxSqlBefunde(z, s)); continue; }
    befunde.push(...linuxSqlBefunde(z, s));
    erfasst.add(z);
  }
  return { befunde, erfasst, fehler, uebersprungen };
}
