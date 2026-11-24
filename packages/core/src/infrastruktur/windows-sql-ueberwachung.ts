/**
 * Realfall 24.11. — Windows-SQL (I8d: sql01/sql02, AG i8d_ag01): die DIFF-Sicherung auf dem Primär scheiterte, die letzte FULL war 4 Tage
 * alt, und es gab KEINEN Befund — überwacht war das Sicherungsalter nur für die Linux-SQL-Server. Gleiches Maß wie dort
 * (FULL ≤ 26 h, LOG ≤ 2 h bei Wiederherstellungsmodell FULL/BULK_LOGGED), Quelle ist die feste Lese-Aktion `sql_server status`
 * (Sicherungslage aus msdb, sql-sicherung-lage.ts). Zusätzlich: der jüngste Lauf eines Alfred-Sicherungsjobs ist fehlgeschlagen → hoch.
 *
 * Fail-closed (R21): jedes Replikat führt in msdb nur die eigenen Sicherungen. Ist ein Replikat einer AG nicht gelesen, wird das Alter
 * ihrer Datenbanken nicht ausgewertet (es könnte die jüngste Sicherung haben) und die gelesenen Replikate gelten nicht als erfasst —
 * ihre Sicherungsbefunde bleiben offen statt fälschlich gelöst. Nur lesend; kein Modell.
 */
import type { Auffaelligkeit } from './bericht.js';
import type { SqlStatus } from './sql-server.js';
import { LINUX_SQL_LOG_MAX_MIN, LINUX_SQL_VOLL_MAX_MIN } from './linux-sql-ueberwachung.js';
import { alterWort, jobMeldungKurz, sicherungsLageLesen, type SicherungsLage } from './sql-sicherung-lage.js';

export const WINDOWS_SQL_JOB_PREFIX = 'Alfred Sicherung ';

export type SqlServerStatusAufruf = (zugang: string) => Promise<{ success: boolean; data?: unknown; error?: string }>;

interface Gelesen { status: SqlStatus; lage: SicherungsLage }

const k = (host: string, teil: string) => ({ bereich: host, schluessel: `ueberwachung:${host}:${teil}`, kategorie: 'ueberwachung' as const, zugang: host });

/** Jüngster Lauf je Alfred-Sicherungsjob fehlgeschlagen (run_status 0) → hoch, mit Alfreds bzw. SQL-Meldung */
export function windowsSqlJobBefunde(host: string, lage: SicherungsLage): Auffaelligkeit[] {
  const a: Auffaelligkeit[] = [];
  for (const j of lage.jobs ?? []) {
    if (!j.name.startsWith(WINDOWS_SQL_JOB_PREFIX) || j.aktiv === 0) continue;
    const x = j.laeufe?.[0];
    if (!x || x.status !== 0) continue;
    const m = jobMeldungKurz(x);
    a.push({ schwere: 'hoch', text: `Agent-Job „${j.name}“ zuletzt fehlgeschlagen (${alterWort(x.alterMin)})${m ? `: ${m}` : ''}`, ...k(host, `job:${j.name}`) });
  }
  return a;
}

/**
 * Sicherungsalter je Datenbank über alle gelesenen Replikate. AG-Datenbanken (agDbs) bilden eine Gruppe über ihre Replikate, sonst
 * Host+Name. Ausgewertet nur, wenn auf einem der Hosts die Alfred-Sicherungsjobs eingerichtet sind. Rückgabe: Befunde und gesperrte
 * Hosts (AG mit nicht gelesenem Replikat).
 */
export function windowsSqlSicherungsBefunde(gelesen: ReadonlyMap<string, Gelesen>): { befunde: Auffaelligkeit[]; gesperrt: Map<string, string> } {
  type G = { name: string; hosts: Set<string>; replikate: Set<string>; eingerichtet: boolean; voll: number | null; log: number | null; logPflicht: boolean };
  const gruppen = new Map<string, G>();
  const juenger = (a: number | null, b: number | null | undefined) => (typeof b !== 'number' ? a : a === null ? b : Math.min(a, b));
  for (const [host, { status: s, lage }] of gelesen) {
    const eingerichtet = (lage.jobs ?? []).some(j => j.name.startsWith(WINDOWS_SQL_JOB_PREFIX));
    const agDb = new Set((s.agDbs ?? []).map(d => d.db));
    const replikate = new Set((s.ags ?? []).map(r => r.replikat.toLowerCase()));
    for (const d of s.datenbanken ?? []) {
      const key = agDb.has(d.name) ? `ag:${d.name}` : `${host}/${d.name}`;
      const g = gruppen.get(key) ?? { name: d.name, hosts: new Set<string>(), replikate: new Set<string>(), eingerichtet: false, voll: null, log: null, logPflicht: false };
      g.hosts.add(host); g.eingerichtet ||= eingerichtet;
      if (agDb.has(d.name)) for (const r of replikate) g.replikate.add(r);
      for (const e of lage.sicherungen ?? []) {
        if (e.db !== d.name) continue;
        if (e.typ === 'FULL') g.voll = juenger(g.voll, e.alterMin);
        if (e.typ === 'LOG') g.log = juenger(g.log, e.alterMin);
      }
      g.logPflicht ||= /^(FULL|BULK_LOGGED)$/i.test(d.modell ?? '');
      gruppen.set(key, g);
    }
  }
  const befunde: Auffaelligkeit[] = []; const gesperrt = new Map<string, string>();
  const altersText = (min: number | null) => (min === null ? 'nie' : alterWort(min));
  for (const g of gruppen.values()) {
    if (!g.eingerichtet) continue;
    const fehlt = [...g.replikate].filter(r => !gelesen.has(r));
    if (fehlt.length) { for (const h of g.hosts) gesperrt.set(h, `Datenbank ${g.name}: Replikat ${fehlt.join(', ')} nicht gelesen`); continue; }
    const z = [...g.hosts].sort()[0]!;
    const wo = g.hosts.size > 1 ? ` (${[...g.hosts].sort().join(', ')})` : '';
    if (g.voll === null || g.voll > LINUX_SQL_VOLL_MAX_MIN) befunde.push({ schwere: 'hoch', text: `Datenbank ${g.name}${wo}: letzte FULL-Sicherung ${altersText(g.voll)} (Soll ≤ 26 h)`, ...k(z, `sicherung:${g.name}:voll`) });
    if (g.logPflicht && (g.log === null || g.log > LINUX_SQL_LOG_MAX_MIN)) befunde.push({ schwere: 'hoch', text: `Datenbank ${g.name}${wo}: letzte LOG-Sicherung ${altersText(g.log)} (Soll ≤ 2 h)`, ...k(z, `sicherung:${g.name}:log`) });
  }
  return { befunde, gesperrt };
}

/**
 * Ein Lauf über die Windows-Zugänge: je Host `sql_server status`. Ohne SQL Server (installiert false) übersprungen. Erfasst ist nur
 * ein Host mit lesbarer Sicherungslage (R21: unlesbar ist nicht ok — Fehler, Befunde bleiben offen).
 */
export async function windowsSqlUeberwachung(zugaenge: string[], status: SqlServerStatusAufruf): Promise<{ befunde: Auffaelligkeit[]; erfasst: Set<string>; fehler: string[]; uebersprungen: string[] }> {
  const befunde: Auffaelligkeit[] = []; const erfasst = new Set<string>(); const fehler: string[] = []; const uebersprungen: string[] = [];
  const gelesen = new Map<string, Gelesen>();
  for (const z of zugaenge) {
    const r = await status(z).catch((err: Error) => ({ success: false, error: err.message }) as Awaited<ReturnType<SqlServerStatusAufruf>>);
    if (!r.success || !r.data || typeof r.data !== 'object') { fehler.push(`${z}: ${(r.error ?? 'kein Status').slice(0, 160)}`); continue; }
    const s = r.data as SqlStatus;
    if (s.installiert === false) { uebersprungen.push(z); continue; }
    const lage = sicherungsLageLesen(s.sicherungsLage);
    if (s.fehler || !lage) { fehler.push(`${z}: Sicherungslage nicht lesbar — ${(s.fehler ?? s.sicherungsLageFehler ?? 'leer').slice(0, 160)}`); continue; }
    if (lage.jobsLesbar !== 1) { fehler.push(`${z}: Jobverlauf nicht lesbar`); continue; }
    befunde.push(...windowsSqlJobBefunde(z, lage));
    gelesen.set(z, { status: s, lage }); erfasst.add(z);
  }
  const { befunde: sb, gesperrt } = windowsSqlSicherungsBefunde(gelesen);
  befunde.push(...sb);
  for (const [h, grund] of gesperrt) { erfasst.delete(h); fehler.push(`${h}: Sicherungsalter nicht ausgewertet — ${grund}`); }
  return { befunde, erfasst, fehler, uebersprungen };
}
