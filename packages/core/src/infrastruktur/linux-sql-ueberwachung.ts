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

export function linuxSqlBefunde(zugang: string, status: Pick<LinuxSqlStatus, 'tls' | 'ad'> | null | undefined): Auffaelligkeit[] {
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
  return a;
}

export type LinuxSqlStatusAufruf = (zugang: string) => Promise<{ success: boolean; data?: unknown; error?: string }>;

/**
 * Ein Lauf über die Linux-SQL-Zugänge: je Host `status` lesen. Erfasst (= Befunde dürfen als gelöst gelten) ist nur ein Host, dessen
 * Status gelesen werden konnte; Fehlschlag → Eintrag in fehler, Befunde bleiben unberührt.
 */
export async function linuxSqlUeberwachung(zugaenge: string[], status: LinuxSqlStatusAufruf): Promise<{ befunde: Auffaelligkeit[]; erfasst: Set<string>; fehler: string[] }> {
  const befunde: Auffaelligkeit[] = []; const erfasst = new Set<string>(); const fehler: string[] = [];
  for (const z of zugaenge) {
    const r = await status(z).catch((err: Error) => ({ success: false, error: err.message }) as Awaited<ReturnType<LinuxSqlStatusAufruf>>);
    if (!r.success || !r.data || typeof r.data !== 'object') { fehler.push(`${z}: ${(r.error ?? 'kein Status').slice(0, 160)}`); continue; }
    befunde.push(...linuxSqlBefunde(z, r.data as LinuxSqlStatus));
    erfasst.add(z);
  }
  return { befunde, erfasst, fehler };
}

/** Linux-Fernzugänge, die SQL-Server-Knoten sein können (Namensschema sqllnx*) */
export const LINUX_SQL_ZUGANG = /^sqllnx/i;
