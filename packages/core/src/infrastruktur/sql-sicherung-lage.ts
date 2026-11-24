/**
 * Owner 24.11. — Sicherungslage lesen, für SQL Server auf Linux (linux_sql) und Windows (sql_server) mit derselben Abfrage:
 * - je Datenbank die letzte FULL-, DIFF- und LOG-Sicherung (msdb.dbo.backupset) mit Alter und dem Server, der sie geschrieben hat
 *   (jedes Replikat führt in msdb nur die eigenen Sicherungen);
 * - je Agent-Job die letzten Läufe der Jobschritte (msdb.dbo.sysjobhistory) mit Ergebnis und Meldung.
 * Realfall 24.11.: nach dem Failover erzwang der LOG-Job auf dem neuen Primär eine FULL-Sicherung — Alfred sah weder den Joblauf noch,
 * was er getan hatte (Lesekäfig ohne Netz, alfred_status ohne Recht auf den Jobverlauf).
 * Nur lesen. Unter Linux liest alfred_status (SELECT auf backupset, sysjobs, sysjobhistory); fehlt das Recht auf den Jobverlauf
 * (Login vor diesem Stand angelegt), meldet der Status das, statt zu scheitern.
 */

/** Ausdruck (Unterabfrage, FOR JSON): letzte Sicherung je Datenbank und Art — Benutzerdatenbanken, ohne Wegwerf-Kopien alfred_wh_* */
export const SICHERUNGEN_JSON = [
  '(SELECT b.database_name AS db,',
  "   CASE b.type WHEN 'D' THEN N'FULL' WHEN 'I' THEN N'DIFF' ELSE N'LOG' END AS typ,",
  '   CONVERT(nvarchar(19), b.backup_finish_date, 126) AS ende,',
  '   DATEDIFF(MINUTE, b.backup_finish_date, GETDATE()) AS alterMin,',
  '   b.server_name AS server, CAST(b.is_copy_only AS int) AS kopie',
  ' FROM msdb.dbo.backupset b',
  ' WHERE b.backup_set_id IN (SELECT MAX(x.backup_set_id) FROM msdb.dbo.backupset x',
  "   WHERE x.type IN ('D', 'I', 'L') AND x.is_copy_only = 0 AND x.database_name NOT LIKE N'alfred[_]wh[_]%'",
  '     AND x.database_name IN (SELECT d.name FROM sys.databases d WHERE d.database_id > 4)',
  '   GROUP BY x.database_name, x.type)',
  ' ORDER BY b.database_name, b.type FOR JSON PATH)',
].join('\n');

/** Ausdruck (Unterabfrage, FOR JSON): je Job die letzten 3 Schritt-Einträge (step_id > 0) — Zeit aus run_date/run_time (Serverzeit) */
export const JOBS_JSON = [
  '(SELECT j.name, CAST(j.enabled AS int) AS aktiv,',
  '   (SELECT TOP (3) CONVERT(nvarchar(19), z.t, 126) AS zeit, DATEDIFF(MINUTE, z.t, GETDATE()) AS alterMin,',
  '      h.run_status AS status, h.step_id AS schritt,',
  "      LEFT(REPLACE(REPLACE(h.message, NCHAR(13), N' '), NCHAR(10), N' '), 1000) AS meldung",
  '    FROM msdb.dbo.sysjobhistory h',
  '    CROSS APPLY (SELECT DATEADD(SECOND, h.run_time / 10000 * 3600 + h.run_time / 100 % 100 * 60 + h.run_time % 100,',
  '      CONVERT(datetime, CONVERT(char(8), h.run_date), 112)) AS t) z',
  '    WHERE h.job_id = j.job_id AND h.step_id > 0 ORDER BY h.instance_id DESC FOR JSON PATH) AS laeufe',
  ' FROM msdb.dbo.sysjobs j ORDER BY j.name FOR JSON PATH)',
].join('\n');

/** Rechte, die der Jobverlauf braucht (Linux: alfred_status) — HAS_PERMS_BY_NAME vorab, damit ein fehlendes Recht nicht den Status bricht */
export const JOBS_RECHTE_TSQL = "ISNULL(HAS_PERMS_BY_NAME(N'msdb.dbo.sysjobs', N'OBJECT', N'SELECT'), 0) * ISNULL(HAS_PERMS_BY_NAME(N'msdb.dbo.sysjobhistory', N'OBJECT', N'SELECT'), 0)";

/**
 * Vorspann für eine Statusabfrage: @jobs (JSON oder NULL) und @jobsLesbar (0/1). Der Jobverlauf läuft als dynamisches SQL nur mit Recht —
 * ein statischer Verweis auf sysjobhistory scheiterte ohne Recht für die ganze Anweisung.
 */
export const JOBS_VORSPANN = [
  `DECLARE @jobs nvarchar(max) = NULL, @jobsLesbar int = ${JOBS_RECHTE_TSQL};`,
  `IF @jobsLesbar = 1 EXEC sp_executesql N'SET @j = ${JOBS_JSON.replace(/'/g, "''")};', N'@j nvarchar(max) OUTPUT', @j = @jobs OUTPUT;`,
].join('\n');

/** Windows (sql_server, integrierte Anmeldung mit vollem Recht): eine Zeile, Spalte j = JSON der Lage */
export const SICHERUNG_LAGE_TSQL = [
  'SET NOCOUNT ON;',
  JOBS_VORSPANN,
  `SELECT (SELECT ${SICHERUNGEN_JSON} AS sicherungen, JSON_QUERY(@jobs) AS jobs, @jobsLesbar AS jobsLesbar`,
  '  FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES) AS j;',
].join('\n');

export interface SicherungEintrag { db: string; typ: 'FULL' | 'DIFF' | 'LOG'; ende?: string; alterMin?: number | null; server?: string; kopie?: number }
export interface JobLauf { zeit?: string; alterMin?: number | null; status?: number; schritt?: number; meldung?: string | null }
export interface JobLage { name: string; aktiv?: number; laeufe?: JobLauf[] | null }
export interface SicherungsLage { sicherungen?: SicherungEintrag[] | null; jobs?: JobLage[] | null; jobsLesbar?: number | null }

/** Alter in Worten: „vor 12 min“, „vor 5 h“, „vor 3 d“; unbekannt → „?“ */
export function alterWort(min: number | null | undefined): string {
  if (typeof min !== 'number' || !Number.isFinite(min)) return '?';
  if (min < 0) return 'in der Zukunft (Uhrzeit prüfen)';
  if (min < 120) return `vor ${min} min`;
  if (min < 48 * 60) return `vor ${Math.round(min / 60)} h`;
  return `vor ${Math.round(min / 1440)} d`;
}

const JOB_STATUS: Record<number, string> = { 0: 'FEHLER', 1: 'ok', 2: 'Wiederholung', 3: 'abgebrochen', 4: 'läuft' };

/**
 * Meldung eines Jobschritts, kurz: Alfreds eigene Zeilen (ALFRED|…, ALFRED-UEBERSPRUNGEN|…, ALFRED-ERZWUNGEN|…) haben Vorrang;
 * sonst nur bei Fehlern der Text (gekürzt) — bei Erfolg fremder Jobs nichts, damit kein beliebiger Jobtext im Status landet.
 */
export function jobMeldungKurz(l: JobLauf): string {
  const m = String(l.meldung ?? '');
  const alfred = m.match(/ALFRED(?:-[A-Z]+)?\|[^[;]*/g)?.map(s => s.trim()).filter(Boolean) ?? [];
  if (alfred.length) return alfred.slice(0, 3).join('; ').slice(0, 300);
  if (l.status === 0) return m.replace(/^Executed as user: [^.]*\.\s*/, '').slice(0, 200);
  return '';
}

/** Text der Sicherungslage (eine Zeile, „; “-getrennt) — für die Statusanzeige beider Skills */
export function sicherungsLageText(l: SicherungsLage | null | undefined): string {
  if (!l) return '';
  const teile: string[] = [];
  const s = l.sicherungen ?? [];
  if (s.length) {
    const dbs = [...new Set(s.map(x => x.db))];
    teile.push(`letzte Sicherungen ${dbs.map(d => `${d}: ${s.filter(x => x.db === d).map(x => `${x.typ} ${alterWort(x.alterMin)}${x.server ? ` (${x.server})` : ''}`).join(', ')}`).join('; ')}`);
  } else teile.push('letzte Sicherungen: keine in msdb');
  if (l.jobsLesbar !== 1) teile.push('Jobverlauf nicht lesbar (Leserecht auf msdb-Jobs fehlt — bei Linux alfred_logins_anlegen erneut per Change)');
  else if (!l.jobs?.length) teile.push('Agent-Jobs: keine');
  else {
    teile.push(`Agent-Jobs ${l.jobs.map(j => {
      const x = j.laeufe?.[0];
      const kopf = `${j.name}${j.aktiv === 0 ? ' (aus)' : ''}`;
      if (!x) return `${kopf}: noch kein Lauf`;
      const m = jobMeldungKurz(x);
      return `${kopf}: ${alterWort(x.alterMin)} ${JOB_STATUS[x.status ?? -1] ?? `Status ${x.status}`}${m ? ` — ${m}` : ''}`;
    }).join('; ')}`);
  }
  return teile.join('; ');
}

/** JSON der Lage aus einer Zeichenkette lesen (Windows liefert sie als Text) — unlesbar → null */
export function sicherungsLageLesen(json: unknown): SicherungsLage | null {
  if (typeof json !== 'string' || !json.trim()) return null;
  try {
    const o = JSON.parse(json) as unknown;
    return o && typeof o === 'object' ? o as SicherungsLage : null;
  } catch {
    return null;
  }
}
