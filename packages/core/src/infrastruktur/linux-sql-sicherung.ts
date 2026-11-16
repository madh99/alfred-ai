/**
 * I8e Paket 1, Task 4 (Vorhaben c7e02aff v2) — Sicherung der Linux-SQL-Einzelinstanz und Wiederherstellungs-Beweis:
 *
 * - SQL-Agent-Jobs (T-SQL in msdb): FULL täglich 00:30, DIFF alle 6 h ab 06:30, LOG alle 15 min ab 00:05 — alle über die Prozedur
 *   msdb.dbo.alfred_sicherung (WITH CHECKSUM, COMPRESSION) nach /var/opt/mssql/backup/<db>/. Dateinamen tragen die Kette:
 *   <db>_FULL_<utc>.bak, <db>_DIFF_<utc>_<full-utc>.bak, <db>_LOG_<utc>_<vorgänger-utc>.trn. Sicherungen einer Datenbank laufen
 *   nacheinander (sp_getapplock); eine fremde Basis (Vollsicherung eines anderen Werkzeugs) oder eine Lücke in der Protokollkette
 *   bricht den Job ab (Befund), statt eine unbrauchbare Kette weiterzuschreiben.
 * - Kopie nach fs01: systemd-Timer alfred-sqllnx-kopie.timer (alle 15 min) startet ein FEST installiertes Skript (KOPIE_SH + PY_KETTE).
 *   Es hängt //<server>/<freigabe> mit SMB 3.1.1, NTLMSSP und Verschlüsselung (seal, schließt die Signierung ein, die fs01 laut
 *   Grundlinie verlangt) ein, kopiert unter Temp-Namen, liest zurück und vergleicht SHA-256, benennt erst bei Gleichheit um und
 *   überschreibt nie eine andere Datei. Das Manifest auf fs01 (<rechner>/alfred-sqllnx-manifest.json) listet, was dieser Baustein
 *   angelegt hat — nur diese Dateien werden je gelöscht.
 * - Aufbewahrung: 7 Tage + 4 Sonntags-Ketten, nur ganze, vollständige Ketten; nie die neueste vollständige; ist irgendeine Kette
 *   einer Datenbank unvollständig, wird für diese Datenbank nichts gelöscht. Budget (Standard 64 GiB) überschritten → Fehler, nie
 *   Löschen, um Platz zu schaffen.
 * - Einziges dauerhaftes Geheimnis auf der VM: /etc/alfred/sqllnx-cifs.cred (0600 root) für den Timer. Bausteine, die selbst auf
 *   fs01 zugreifen (sicherungen, wiederherstellen), schreiben die Zugangsdaten aus der Eingabe in /run/alfred-c-… (0600) und
 *   entfernen sie im Aufräumen (trap).
 * - Wiederherstellungs-Beweis: letzte vollständige Kette FULL (+ letzte DIFF) + LOGs aus der fs01-KOPIE (zurückgeholt und gegen das
 *   Manifest geprüft), unter alfred_wh_… mit MOVE, NORECOVERY bis zum Schluss, dann RECOVERY, DBCC CHECKDB, Prüfdaten-Vergleich →
 *   RESTORE_VERIFIED nur wenn alles stimmt; die Ziel-Datenbank wird danach (und bei jedem Fehler) entfernt.
 */
import { registriereLinuxBaustein } from '../fernzugriff/linux-bausteine.js';
import { sqlKopf, SQL_HILFE, SA_LESEN, shQ, PRUEFDATEN_SHA256, PRUEFDATEN_ZEILEN, SQLLNX_KOPIE_STATUS, SQLLNX_ZUGANGSDATEI } from './linux-sql.js';

export const LINUX_SQL_SICHERUNG_BAUSTEINE = {
  einrichten: 'sql.sicherung_einrichten', jetzt: 'sql.sicherung_jetzt', liste: 'sql.sicherungen', wiederherstellen: 'sql.wiederherstellen',
} as const;
/** Zeitgrenzen für linuxSkript (am Host bis timeoutMs − 20 s) */
export const LINUX_SQL_SICHERUNG_ZEIT_MS = { einrichten: 1_200_000, jetzt: 3_000_000, liste: 300_000, wiederherstellen: 3_500_000 } as const;

/** cifs-utils aus noble-updates/noble-security (geprüft 16.11.2026 per apt-cache madison auf Ubuntu 24.04.5) */
export const CIFS_UTILS_VERSION = '2:7.0-2ubuntu0.6';
/** SMB 3.1.1, NTLMSSP, Verschlüsselung (seal ⊃ Signierung), ohne Seiten-Cache (Zurücklesen kommt vom Server), nur root */
export const CIFS_OPTIONEN = 'vers=3.1.1,sec=ntlmssp,seal,cache=none,uid=0,gid=0,file_mode=0600,dir_mode=0700,nosuid,nodev,noexec';
export const ZUGANGSDATEI_FEST = SQLLNX_ZUGANGSDATEI;
export const KOPIE_KONF = '/etc/alfred/sqllnx-kopie.json';
export const KOPIE_STATUS = SQLLNX_KOPIE_STATUS;
export const KOPIE_CACHE = '/var/lib/alfred/sqllnx-kopie-cache.json';
export const KETTE_PY_PFAD = '/usr/local/lib/alfred/sqllnx_kette.py';
export const KOPIE_SH_PFAD = '/usr/local/lib/alfred/sqllnx-kopie.sh';
export const KOPIE_DIENST = 'alfred-sqllnx-kopie';
const SICHERUNG_WURZEL = '/var/opt/mssql/backup';
const JOB_BESCHREIBUNG = 'Alfred I8e';

// ── Validatoren ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const obj = (p: unknown): Record<string, unknown> => (p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : {});
const pruefe = (f: string | undefined) => { if (f) throw new Error(f); };
const SERVER = /^(?=.{3,120}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const FREIGABE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}\$?$/;
const KONTO = /^[A-Za-z][A-Za-z0-9-]{2,19}$/;
const DOMAENE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;
const CIFS_V = /^\d{1,2}:[0-9A-Za-z.+~]{1,20}-[0-9A-Za-z.+~]{1,30}$/;
const DB_NAME = /^[A-Za-z][A-Za-z0-9_]{2,63}$/;
const SYSTEM_DBS = new Set(['master', 'model', 'msdb', 'tempdb']);
/** Ziel des Restore-Beweises: immer alfred_wh_… (die Agent-Jobs sichern diese Namen nie) */
export const WH_ZIEL = /^alfred_wh_[A-Za-z0-9_]{1,53}$/;

export interface SicherungEinrichtenParameter { server: string; freigabe: string; konto: string; domaene: string; budgetGiB: number; cifsVersion?: string }
export interface SicherungJetztParameter { art: 'FULL' | 'DIFF' | 'LOG'; datenbank: string }
export interface WiederherstellenParameter { datenbank: string; ziel: string }

export function pruefeSicherungEinrichten(p: unknown): string | undefined {
  const x = obj(p);
  if (typeof x.server !== 'string' || !SERVER.test(x.server)) return 'server: vollständiger DNS-Name in Kleinbuchstaben, z. B. fs01.ad.3033.at';
  if (typeof x.freigabe !== 'string' || !FREIGABE.test(x.freigabe)) return 'freigabe: Freigabename (Buchstaben, Ziffern, _ -, optional $), z. B. SQLLinuxBackup$';
  if (typeof x.konto !== 'string' || !KONTO.test(x.konto)) return 'konto: sAMAccountName des Dienstkontos, z. B. svc-sqllnx-backup';
  if (typeof x.domaene !== 'string' || !DOMAENE.test(x.domaene)) return 'domaene: NetBIOS- oder DNS-Name der Domäne, z. B. AD3033';
  if (typeof x.budgetGiB !== 'number' || !Number.isInteger(x.budgetGiB) || x.budgetGiB < 1 || x.budgetGiB > 1024) return 'budgetGiB: ganze Zahl 1–1024';
  if (x.cifsVersion !== undefined && !(typeof x.cifsVersion === 'string' && CIFS_V.test(x.cifsVersion))) return `cifsVersion: apt-Version wie ${CIFS_UTILS_VERSION}`;
  return undefined;
}

export function pruefeSicherungJetzt(p: unknown): string | undefined {
  const x = obj(p);
  if (x.art !== 'FULL' && x.art !== 'DIFF' && x.art !== 'LOG') return 'art: FULL, DIFF oder LOG';
  return pruefeDb(x.datenbank);
}

function pruefeDb(d: unknown): string | undefined {
  if (typeof d !== 'string' || !DB_NAME.test(d) || SYSTEM_DBS.has(d.toLowerCase()) || d.toLowerCase().startsWith('alfred_wh_')) {
    return 'datenbank: Buchstabe, dann Buchstaben/Ziffern/_ (3–64 Zeichen), keine Systemdatenbank, nicht alfred_wh_…';
  }
  return undefined;
}

export function pruefeWiederherstellen(p: unknown): string | undefined {
  const x = obj(p);
  const f = pruefeDb(x.datenbank); if (f) return f;
  if (typeof x.ziel !== 'string' || !WH_ZIEL.test(x.ziel)) return 'ziel: alfred_wh_ und Buchstaben/Ziffern/_ (höchstens 63 Zeichen), z. B. alfred_wh_pruefdb01';
  return undefined;
}

// ── T-SQL: Prozedur und Agent-Jobs ─────────────────────────────────────────────────────────────────────────────────────────────

const PROZEDUR_TEXT = `CREATE OR ALTER PROCEDURE dbo.alfred_sicherung @art nvarchar(4), @db sysname = NULL, @streng bit = 0
AS
BEGIN
  -- alfred-fassung @@FASSUNG@@ — von linux_sql sicherung_einrichten angelegt (I8e); Änderungen nur über den Baustein
  SET NOCOUNT ON;
  IF @art NOT IN (N'FULL', N'DIFF', N'LOG') THROW 50010, N'art: FULL, DIFF oder LOG', 1;
  DECLARE @wurzel nvarchar(100) = N'${SICHERUNG_WURZEL}/';
  DECLARE @n sysname, @dbid int, @guid uniqueidentifier, @modell nvarchar(60), @zeit nchar(14), @ordner nvarchar(400), @datei nvarchar(600),
          @bezug nchar(14), @dev nvarchar(600), @pre nvarchar(600), @f numeric(25,0), @dbl numeric(25,0), @lf numeric(25,0), @sql nvarchar(max),
          @sperre nvarchar(200), @rc int, @fehler nvarchar(max) = N'', @msg nvarchar(2048), @grund nvarchar(400);
  DECLARE @r TABLE (zeile nvarchar(800));
  DECLARE d CURSOR LOCAL FAST_FORWARD FOR
    SELECT name FROM sys.databases
    WHERE database_id > 4 AND state = 0 AND is_read_only = 0 AND source_database_id IS NULL
      AND LEN(name) BETWEEN 3 AND 64 AND name LIKE N'[A-Za-z]%' AND name NOT LIKE N'%[^A-Za-z0-9_]%'
      AND name NOT LIKE N'alfred[_]wh[_]%' AND (@db IS NULL OR name = @db)
    ORDER BY name;
  OPEN d;
  FETCH NEXT FROM d INTO @n;
  WHILE @@FETCH_STATUS = 0
  BEGIN
    SET @sperre = N'alfred_sicherung_' + @n;
    BEGIN TRY
      EXEC @rc = sp_getapplock @Resource = @sperre, @LockMode = N'Exclusive', @LockOwner = N'Session', @LockTimeout = 7200000;
      IF @rc < 0 THROW 50012, N'Sperre der Datenbank nicht erhalten (andere Sicherung läuft seit 2 h)', 1;
      BEGIN TRY
        SET @grund = NULL; SET @bezug = NULL;
        SELECT @dbid = database_id, @modell = recovery_model_desc FROM sys.databases WHERE name = @n;
        SELECT @guid = database_guid, @f = last_log_backup_lsn FROM sys.database_recovery_status WHERE database_id = @dbid;
        SET @dbl = (SELECT differential_base_lsn FROM sys.master_files WHERE database_id = @dbid AND file_id = 1);
        IF @art = N'LOG' AND @modell <> N'FULL' SET @grund = N'Wiederherstellungsmodell ' + @modell + N' (LOG nur bei FULL)';
        ELSE IF @art = N'DIFF' AND @dbl IS NULL SET @grund = N'noch keine Vollsicherung';
        ELSE IF @art = N'LOG' AND @f IS NULL SET @grund = N'noch keine Vollsicherung (Protokollkette beginnt erst danach)';
        IF @grund IS NULL AND @art = N'DIFF'
        BEGIN
          SET @dev = NULL;
          SELECT TOP (1) @dev = mf.physical_device_name FROM msdb.dbo.backupset b JOIN msdb.dbo.backupmediafamily mf ON mf.media_set_id = b.media_set_id
            WHERE b.database_guid = @guid AND b.type = 'D' AND b.is_copy_only = 0 AND b.checkpoint_lsn = @dbl ORDER BY b.backup_set_id DESC;
          SET @pre = @wurzel + @n + N'/' + @n + N'_FULL_';
          IF @dev IS NULL OR LEFT(@dev, LEN(@pre)) <> @pre OR LEN(@dev) <> LEN(@pre) + 18
            THROW 50014, N'Basis der Differenzsicherung ist keine Alfred-Vollsicherung (fremde Vollsicherung?) - erst FULL ueber den Baustein', 1;
          SET @bezug = SUBSTRING(@dev, LEN(@pre) + 1, 14);
        END
        IF @grund IS NULL AND @art = N'LOG'
        BEGIN
          SET @dev = NULL; SET @lf = NULL;
          SELECT TOP (1) @dev = mf.physical_device_name, @lf = b.last_lsn FROM msdb.dbo.backupset b JOIN msdb.dbo.backupmediafamily mf ON mf.media_set_id = b.media_set_id
            WHERE b.database_guid = @guid AND b.type = 'L' AND b.is_copy_only = 0 ORDER BY b.backup_set_id DESC;
          IF @dev IS NULL
            SELECT TOP (1) @dev = mf.physical_device_name, @lf = @f FROM msdb.dbo.backupset b JOIN msdb.dbo.backupmediafamily mf ON mf.media_set_id = b.media_set_id
              WHERE b.database_guid = @guid AND b.type = 'D' AND b.is_copy_only = 0 AND b.first_lsn <= @f AND b.last_lsn >= @f ORDER BY b.backup_set_id DESC;
          IF @dev IS NULL OR @lf <> @f
            THROW 50015, N'Protokollkette unterbrochen: die letzte Protokollsicherung endet nicht am Beginn der neuen - erst FULL ueber den Baustein', 1;
          SET @pre = @wurzel + @n + N'/' + @n + N'_';
          IF LEFT(@dev, LEN(@pre)) = @pre AND SUBSTRING(@dev, LEN(@pre) + 1, 4) = N'LOG_' SET @bezug = SUBSTRING(@dev, LEN(@pre) + 5, 14);
          ELSE IF LEFT(@dev, LEN(@pre)) = @pre AND SUBSTRING(@dev, LEN(@pre) + 1, 5) = N'FULL_' SET @bezug = SUBSTRING(@dev, LEN(@pre) + 6, 14);
          ELSE THROW 50016, N'Vorgaenger der Protokollsicherung ist keine Alfred-Sicherung (fremde Sicherung?) - erst FULL ueber den Baustein', 1;
        END
        IF @bezug IS NOT NULL AND @bezug NOT LIKE N'[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
          THROW 50017, N'Bezug der Sicherung nicht lesbar', 1;
        IF @grund IS NOT NULL
        BEGIN
          IF @streng = 1 THROW 50018, @grund, 1;
          INSERT @r VALUES (N'ALFRED-UEBERSPRUNGEN|' + @n + N'|' + @grund);
        END
        ELSE
        BEGIN
          -- mindestens 1 s nach der vorigen Sicherung dieser Datenbank (Sperre): Zeitstempel steigen streng, Reihenfolge = Ablauf
          WAITFOR DELAY '00:00:01';
          SET @zeit = FORMAT(SYSUTCDATETIME(), N'yyyyMMddHHmmss');
          SET @ordner = @wurzel + @n;
          EXEC master.sys.xp_create_subdir @ordner;
          SET @datei = @ordner + N'/' + @n + N'_' + @art + N'_' + @zeit + ISNULL(N'_' + @bezug, N'') + CASE WHEN @art = N'LOG' THEN N'.trn' ELSE N'.bak' END;
          IF EXISTS (SELECT 1 FROM msdb.dbo.backupmediafamily WHERE physical_device_name = @datei) THROW 50019, N'Sicherungsdatei gibt es schon', 1;
          SET @sql = CASE @art
            WHEN N'FULL' THEN N'BACKUP DATABASE ' + QUOTENAME(@n) + N' TO DISK = @d WITH CHECKSUM, COMPRESSION, NAME = N''alfred'', DESCRIPTION = N''${JOB_BESCHREIBUNG}'''
            WHEN N'DIFF' THEN N'BACKUP DATABASE ' + QUOTENAME(@n) + N' TO DISK = @d WITH DIFFERENTIAL, CHECKSUM, COMPRESSION, NAME = N''alfred'', DESCRIPTION = N''${JOB_BESCHREIBUNG}'''
            ELSE N'BACKUP LOG ' + QUOTENAME(@n) + N' TO DISK = @d WITH CHECKSUM, COMPRESSION, NAME = N''alfred'', DESCRIPTION = N''${JOB_BESCHREIBUNG}''' END;
          EXEC sp_executesql @sql, N'@d nvarchar(600)', @d = @datei;
          INSERT @r VALUES (N'ALFRED|' + @datei);
        END
      END TRY
      BEGIN CATCH
        SET @fehler += @n + N': ' + ERROR_MESSAGE() + N'; ';
      END CATCH
      EXEC sp_releaseapplock @Resource = @sperre, @LockOwner = N'Session';
    END TRY
    BEGIN CATCH
      SET @fehler += @n + N': ' + ERROR_MESSAGE() + N'; ';
    END CATCH
    FETCH NEXT FROM d INTO @n;
  END
  CLOSE d; DEALLOCATE d;
  SELECT zeile FROM @r;
  IF @fehler <> N'' BEGIN SET @msg = LEFT(N'Sicherung ' + @art + N' fehlgeschlagen: ' + @fehler, 2048); THROW 50011, @msg, 1; END
  IF @streng = 1 AND NOT EXISTS (SELECT 1 FROM @r WHERE zeile LIKE N'ALFRED|%') THROW 50013, N'Datenbank nicht gefunden oder nicht sicherbar (online, nicht schreibgeschuetzt, Name Buchstaben/Ziffern/_)', 1;
END`;

/** Fassung = kurzer Hash des Prozedurtexts und der Zeitpläne: ändert sich etwas, werden Prozedur und Jobs neu angelegt */
function fassung(t: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

interface Job { name: string; art: 'FULL' | 'DIFF' | 'LOG'; plan: string }
/** Agent-Zeitpläne (Serverzeit): FULL täglich 00:30, DIFF 06:30/12:30/18:30, LOG alle 15 min ab 00:05 */
const JOBS: Job[] = [
  { name: 'alfred-sqllnx-full', art: 'FULL', plan: '@freq_type = 4, @freq_interval = 1, @freq_subday_type = 1, @freq_subday_interval = 0, @active_start_time = 3000' },
  { name: 'alfred-sqllnx-diff', art: 'DIFF', plan: '@freq_type = 4, @freq_interval = 1, @freq_subday_type = 8, @freq_subday_interval = 6, @active_start_time = 63000, @active_end_time = 235959' },
  { name: 'alfred-sqllnx-log', art: 'LOG', plan: '@freq_type = 4, @freq_interval = 1, @freq_subday_type = 4, @freq_subday_interval = 15, @active_start_time = 500, @active_end_time = 235959' },
];
const FASSUNG = fassung(PROZEDUR_TEXT + JSON.stringify(JOBS));
/** Prozedur msdb.dbo.alfred_sicherung (für Tests und Bericht) */
export const SICHERUNG_PROZEDUR = PROZEDUR_TEXT.replace('@@FASSUNG@@', FASSUNG);

/**
 * Prozedur und drei Agent-Jobs in msdb, idempotent: fremde Jobs gleichen Namens → THROW vor jeder Änderung; eigene Jobs mit anderer
 * Fassung werden neu angelegt; abgeschaltete eigene Jobs wieder eingeschaltet. Letzte Zeile: ALFRED|<zustand>|<jobs ok>|<proc ok>|<agent>.
 */
export function sicherungJobsTsql(): string {
  const besch = `${JOB_BESCHREIBUNG} ${FASSUNG}`;
  const namen = JOBS.map(j => `N'${j.name}'`).join(', ');
  return [
    'SET NOCOUNT ON;',
    "DECLARE @z nvarchar(20) = N'schon', @jid uniqueidentifier, @besch nvarchar(512), @proc nvarchar(max);",
    `IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name IN (${namen}) AND ISNULL(description, N'') NOT LIKE N'${JOB_BESCHREIBUNG}%')`,
    "  THROW 50020, N'Ein Job alfred-sqllnx-* ist kein Alfred-Job - nichts geaendert', 1;",
    `IF OBJECT_ID(N'msdb.dbo.alfred_sicherung', N'P') IS NULL OR CHARINDEX(N'alfred-fassung ${FASSUNG}', OBJECT_DEFINITION(OBJECT_ID(N'msdb.dbo.alfred_sicherung'))) = 0`,
    'BEGIN',
    `  SET @proc = N'${SICHERUNG_PROZEDUR.replace(/'/g, "''")}';`,
    '  EXEC msdb.sys.sp_executesql @proc;',
    "  SET @z = N'geaendert';",
    'END',
    ...JOBS.flatMap(j => [
      `SET @jid = NULL; SET @besch = NULL; SELECT @jid = job_id, @besch = description FROM msdb.dbo.sysjobs WHERE name = N'${j.name}';`,
      `IF @jid IS NOT NULL AND @besch <> N'${besch}' BEGIN EXEC msdb.dbo.sp_delete_job @job_id = @jid, @delete_unused_schedule = 1; SET @jid = NULL; END`,
      'IF @jid IS NULL',
      'BEGIN',
      `  EXEC msdb.dbo.sp_add_job @job_name = N'${j.name}', @enabled = 1, @description = N'${besch}', @owner_login_name = N'sa', @job_id = @jid OUTPUT;`,
      `  EXEC msdb.dbo.sp_add_jobstep @job_id = @jid, @step_name = N'sichern', @subsystem = N'TSQL', @database_name = N'msdb', @command = N'EXEC dbo.alfred_sicherung @art = N''${j.art}'';', @retry_attempts = 0;`,
      `  EXEC msdb.dbo.sp_add_jobschedule @job_id = @jid, @name = N'${j.name}', @enabled = 1, ${j.plan};`,
      "  EXEC msdb.dbo.sp_add_jobserver @job_id = @jid, @server_name = N'(local)';",
      "  SET @z = N'geaendert';",
      'END',
      "ELSE IF (SELECT enabled FROM msdb.dbo.sysjobs WHERE job_id = @jid) = 0 BEGIN EXEC msdb.dbo.sp_update_job @job_id = @jid, @enabled = 1; SET @z = N'geaendert'; END",
    ]),
    'SELECT N\'ALFRED|\' + @z',
    `  + N'|' + CAST((SELECT COUNT(*) FROM msdb.dbo.sysjobs j WHERE j.name IN (${namen}) AND j.enabled = 1 AND j.description = N'${besch}'`,
    '      AND EXISTS (SELECT 1 FROM msdb.dbo.sysjobschedules js JOIN msdb.dbo.sysschedules s ON s.schedule_id = js.schedule_id WHERE js.job_id = j.job_id AND s.enabled = 1)',
    '      AND EXISTS (SELECT 1 FROM msdb.dbo.sysjobservers sv WHERE sv.job_id = j.job_id)) AS nvarchar(5))',
    `  + N'|' + CASE WHEN CHARINDEX(N'alfred-fassung ${FASSUNG}', ISNULL(OBJECT_DEFINITION(OBJECT_ID(N'msdb.dbo.alfred_sicherung')), N'')) > 0 THEN N'1' ELSE N'0' END`,
    "  + N'|' + CAST((SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE program_name LIKE N'SQLAgent%') AS nvarchar(5));",
  ].join('\n');
}

/** Prüfdaten-Abfrage des Restore-Beweises — derselbe Ausdruck wie im Baustein sql.pruefdaten (Test vergleicht) */
export const PRUEF_SELECT = "SELECT N'ALFRED|' + CAST(COUNT(*) AS nvarchar(10)) + N'|' + CONVERT(nvarchar(64), HASHBYTES(N'SHA2_256', STRING_AGG(CAST(CONCAT(id, N'|', wert, N'|', zahl) AS nvarchar(max)), N';') WITHIN GROUP (ORDER BY id)), 2) FROM dbo.alfred_pruefung;";

// ── Python: Ketten, Kopie, Aufbewahrung, Auswahl ───────────────────────────────────────────────────────────────────────────────

/** Fest installiert als /usr/local/lib/alfred/sqllnx_kette.py; in den Bausteinen eingebettet. Enthält kein Geheimnis. */
export const PY_KETTE = String.raw`# Alfred I8e - Sicherungsketten der Linux-SQL-Einzelinstanz: Kopie nach fs01 mit SHA-256-Prüfung, Aufbewahrung nur
# vollständiger Ketten, Budget, Auswahl für den Wiederherstellungs-Beweis. Von linux_sql sicherung_einrichten installiert.
import datetime, hashlib, json, os, re, sys, time

DATEI = re.compile(r'^(FULL|DIFF|LOG)_(\d{14})(?:_(\d{14}))?\.(bak|trn)$')
DB = re.compile(r'^[A-Za-z][A-Za-z0-9_]{2,63}$')
HOST = re.compile(r'^[a-z0-9][a-z0-9-]{0,62}$')
SERVER = re.compile(r'^(?=.{3,120}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$')
FREIGABE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,39}\$?$')
KONTO = re.compile(r'^[A-Za-z][A-Za-z0-9-]{2,19}$')
DOMAENE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$')
MANIFEST = 'alfred-sqllnx-manifest.json'
BLOCK = 4 << 20
TAG = 86400
SCHREIBRUHE = 60


class Fehler(Exception):
    pass


def zeit_ok(z):
    try:
        datetime.datetime.strptime(z, '%Y%m%d%H%M%S')
        return True
    except ValueError:
        return False


def sekunden(z):
    return datetime.datetime.strptime(z, '%Y%m%d%H%M%S').replace(tzinfo=datetime.timezone.utc).timestamp()


def iso(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def zerlege(db, name):
    if not DB.match(db) or not name.startswith(db + '_'):
        return None
    m = DATEI.match(name[len(db) + 1:])
    if not m:
        return None
    art, zeit, bezug, ext = m.groups()
    if (art == 'FULL') != (bezug is None) or (art == 'LOG') != (ext == 'trn'):
        return None
    if not zeit_ok(zeit) or (bezug is not None and not zeit_ok(bezug)):
        return None
    return {'art': art, 'zeit': zeit, 'bezug': bezug}


def rel_ok(rel):
    teile = rel.split('/') if isinstance(rel, str) else []
    return len(teile) == 2 and zerlege(teile[0], teile[1]) is not None


def sha(pfad):
    h = hashlib.sha256()
    with open(pfad, 'rb') as f:
        for b in iter(lambda: f.read(BLOCK), b''):
            h.update(b)
    return h.hexdigest()


def lies_json(pfad, leer):
    try:
        with open(pfad, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return leer


def schreibe_json(pfad, daten):
    tmp = pfad + '.alfred-neu'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(daten, f, indent=1, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, pfad)


def konf_lesen(pfad):
    k = lies_json(pfad, None)
    if not isinstance(k, dict):
        raise Fehler('Konfiguration %s fehlt oder ist beschädigt' % pfad)
    for feld, muster in (('server', SERVER), ('freigabe', FREIGABE), ('konto', KONTO), ('domaene', DOMAENE)):
        if not isinstance(k.get(feld), str) or not muster.match(k[feld]):
            raise Fehler('Konfiguration %s: Feld %s ungültig' % (pfad, feld))
    b = k.get('budgetBytes')
    if not isinstance(b, int) or isinstance(b, bool) or b < 1 or b > (1 << 44):
        raise Fehler('Konfiguration %s: budgetBytes ungültig' % pfad)
    return k


def konf_feld(pfad, feld):
    k = konf_lesen(pfad)
    if feld == 'unc':
        return '//%s/%s' % (k['server'], k['freigabe'])
    if feld in ('server', 'freigabe', 'konto', 'domaene', 'budgetBytes'):
        return str(k[feld])
    raise Fehler('unbekanntes Feld %s' % feld)


def ketten(dateien):
    """dateien {name: info} einer Datenbank -> (ketten, waisen). Kette = Vollsicherung + DIFF/LOG bis zur nächsten Vollsicherung."""
    voll = sorted((i['zeit'], n) for n, i in dateien.items() if i['art'] == 'FULL')
    ks = [{'full': n, 'zeit': z, 'diffs': [], 'logs': [], 'fehler': []} for z, n in voll]
    waisen = []
    for n, i in sorted(dateien.items(), key=lambda x: (x[1]['zeit'], x[0])):
        if i['art'] == 'FULL':
            continue
        k = None
        for kk in ks:
            if kk['zeit'] < i['zeit']:
                k = kk
        if k is None:
            waisen.append(n)
        elif i['art'] == 'DIFF':
            k['diffs'].append(n)
            if i['bezug'] != k['zeit']:
                k['fehler'].append('%s: Basis %s ist nicht die Vollsicherung %s' % (n, i['bezug'], k['zeit']))
        else:
            k['logs'].append(n)
    for idx, k in enumerate(ks):
        vor = None
        for n in k['logs']:
            b = dateien[n]['bezug']
            if vor is None:
                if b > k['zeit']:
                    k['fehler'].append('%s: Vorgänger %s fehlt' % (n, b))
            elif b != dateien[vor]['zeit']:
                k['fehler'].append('%s: Lücke, Vorgänger %s fehlt' % (n, b))
            vor = n
        if vor is not None and idx + 1 < len(ks) and ks[idx + 1]['logs']:
            b = dateien[ks[idx + 1]['logs'][0]]['bezug']
            if b != dateien[vor]['zeit']:
                k['fehler'].append('Ende: Protokollsicherung %s fehlt' % b)
    return ks, waisen


def satz(k, dateien):
    """Wiederherstellungssatz einer vollständigen Kette: FULL, letzte DIFF mit folgendem LOG (sonst ohne DIFF), LOGs danach."""
    if k['fehler']:
        return None
    for d in sorted(k['diffs'], key=lambda n: dateien[n]['zeit'], reverse=True) + [None]:
        ab = dateien[d]['zeit'] if d else k['zeit']
        logs = [n for n in k['logs'] if dateien[n]['zeit'] > ab]
        if logs:
            return {'kette': k['zeit'], 'full': k['full'], 'diff': d, 'logs': logs}
    return None


def aufbewahrung(ks, waisen, jetzt):
    """-> (zu löschende Ketten, Grund für das Aussetzen). Nur ganze vollstaendige Ketten, nie die neueste, nichts bei Lücken."""
    if waisen:
        return [], 'Dateien ohne Vollsicherung (%s) - Aufbewahrung ausgesetzt, nichts gelöscht' % ', '.join(waisen[:3])
    for k in ks:
        if k['fehler']:
            return [], 'unvollständige Kette %s (%s) - Aufbewahrung ausgesetzt, nichts gelöscht' % (k['zeit'], '; '.join(k['fehler'][:2]))
    if not ks:
        return [], None
    behalten = {ks[-1]['zeit']}
    for idx, k in enumerate(ks):
        ende = sekunden(ks[idx + 1]['zeit']) if idx + 1 < len(ks) else jetzt
        if ende >= jetzt - 7 * TAG:
            behalten.add(k['zeit'])
    sonntage = [k['zeit'] for k in ks if k['zeit'] not in behalten and datetime.datetime.strptime(k['zeit'], '%Y%m%d%H%M%S').weekday() == 6]
    behalten.update(sonntage[-4:])
    return [k for k in ks if k['zeit'] not in behalten], None


def manifest_lesen(ziel, host):
    m = lies_json(os.path.join(ziel, MANIFEST), None)
    if m is None:
        return None
    if not isinstance(m, dict) or m.get('host') != host or not isinstance(m.get('dateien'), dict) or not isinstance(m.get('entfernen', []), list):
        raise Fehler('Manifest %s/%s gehört nicht zu %s oder ist beschädigt - nichts geändert' % (host, MANIFEST, host))
    for rel in list(m['dateien']) + list(m.get('entfernen', [])):
        if not rel_ok(rel):
            raise Fehler('Manifest enthält den ungültigen Eintrag %r - nichts geändert' % str(rel)[:80])
    return m


def je_db(man):
    erg = {}
    for rel, e in man['dateien'].items():
        db, n = rel.split('/')
        info = zerlege(db, n)
        info['bytes'] = e.get('bytes')
        info['sha256'] = e.get('sha256')
        erg.setdefault(db, {})[n] = info
    return erg


def vorhanden_pruefen(ziel, db, dd, ks):
    for k in ks:
        for n in [k['full']] + k['diffs'] + k['logs']:
            fp = os.path.join(ziel, db, n)
            if not os.path.isfile(fp) or os.path.getsize(fp) != dd[n]['bytes']:
                k['fehler'].append('%s fehlt auf fs01 oder Größe weicht ab' % n)


def belegung(pfad):
    s = 0
    for wurzel, _, dateien in os.walk(pfad):
        for n in dateien:
            try:
                s += os.path.getsize(os.path.join(wurzel, n))
            except OSError:
                pass
    return s


def offen():
    s = set()
    if not os.path.isdir('/proc'):
        return s
    for pid in os.listdir('/proc'):
        if not pid.isdigit():
            continue
        d = '/proc/%s/fd' % pid
        try:
            for fd in os.listdir(d):
                try:
                    s.add(os.readlink(os.path.join(d, fd)))
                except OSError:
                    pass
        except OSError:
            pass
    return s


def lokale(lokal):
    erg = {}
    for db in sorted(os.listdir(lokal)):
        p = os.path.join(lokal, db)
        if not DB.match(db) or os.path.islink(p) or not os.path.isdir(p):
            continue
        for n in sorted(os.listdir(p)):
            i = zerlege(db, n)
            fp = os.path.join(p, n)
            if i and os.path.isfile(fp) and not os.path.islink(fp):
                erg.setdefault(db, {})[n] = i
    return erg


def kopiere(src, ziel, db, n):
    zdir = os.path.join(ziel, db)
    os.makedirs(zdir, exist_ok=True)
    final = os.path.join(zdir, n)
    tmp = os.path.join(zdir, '.' + n + '.alfred-tmp')
    h = hashlib.sha256()
    try:
        with open(src, 'rb') as q, open(tmp, 'wb') as z:
            for b in iter(lambda: q.read(BLOCK), b''):
                h.update(b)
                z.write(b)
            z.flush()
            os.fsync(z.fileno())
        quelle = h.hexdigest()
        zurueck = sha(tmp)
        if zurueck != quelle:
            raise Fehler('%s/%s: Prüfsumme der Kopie auf fs01 weicht ab (%s statt %s) - Kopie verworfen' % (db, n, zurueck[:16], quelle[:16]))
        if os.path.exists(final):
            if sha(final) != quelle:
                raise Fehler('%s/%s: auf fs01 liegt schon eine andere Datei gleichen Namens - nie überschrieben' % (db, n))
        else:
            os.rename(tmp, final)
        return quelle
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def entferne(ziel, mpfad, man, rels, erg):
    man['entfernen'] = rels
    schreibe_json(mpfad, man)
    for rel in rels:
        db, n = rel.split('/')
        fp = os.path.join(ziel, db, n)
        if os.path.isfile(fp):
            os.remove(fp)
        man['dateien'].pop(rel, None)
        erg['geloescht'].append(rel)
    man['entfernen'] = []
    schreibe_json(mpfad, man)


def kopie(lokal, mnt, host, konf_pfad, status_pfad, cache_pfad, jetzt):
    erg = {'zeit': iso(time.time()), 'ok': False, 'kopiert': [], 'geloescht': [], 'lokalEntfernt': [], 'hinweise': [], 'fehler': None}
    cache = lies_json(cache_pfad, {})
    try:
        if not HOST.match(host):
            raise Fehler('Rechnername %r ungültig' % host)
        budget = konf_lesen(konf_pfad)['budgetBytes']
        erg['budgetBytes'] = budget
        ziel = os.path.join(mnt, host)
        os.makedirs(ziel, exist_ok=True)
        mpfad = os.path.join(ziel, MANIFEST)
        man = manifest_lesen(ziel, host)
        if man is None:
            man = {'fassung': 1, 'host': host, 'dateien': {}, 'entfernen': []}
            schreibe_json(mpfad, man)
        # 1) angefangenes Entfernen abschließen (Absicht steht vorher im Manifest)
        if man.get('entfernen'):
            entferne(ziel, mpfad, man, list(man['entfernen']), erg)
        # 2) Aufbewahrung auf fs01 - nur Dateien aus dem Manifest, nur ganze vollstaendige Ketten
        for db, dd in sorted(je_db(man).items()):
            ks, waisen = ketten(dd)
            vorhanden_pruefen(ziel, db, dd, ks)
            weg, grund = aufbewahrung(ks, waisen, jetzt)
            if grund:
                erg['hinweise'].append('%s: %s' % (db, grund))
            if weg:
                entferne(ziel, mpfad, man, [db + '/' + n for k in weg for n in k['logs'] + k['diffs'] + [k['full']]], erg)
        # 3) kopieren, älteste zuerst; Budget vor jeder Datei
        belegt = belegung(mnt)
        off = offen()
        lok = lokale(lokal)
        for _, db, n in sorted((i['zeit'], db, n) for db, dd in lok.items() for n, i in dd.items()):
            rel = db + '/' + n
            src = os.path.join(lokal, db, n)
            st = os.stat(src)
            if src in off or time.time() - st.st_mtime < SCHREIBRUHE:
                erg['hinweise'].append('%s wird noch geschrieben - beim nächsten Lauf' % rel)
                continue
            c = cache.get(rel)
            frisch = isinstance(c, dict) and c.get('bytes') == st.st_size and c.get('mtime_ns') == st.st_mtime_ns and c.get('sha256')
            if rel in man['dateien']:
                if not frisch:
                    c = {'bytes': st.st_size, 'mtime_ns': st.st_mtime_ns, 'sha256': sha(src)}
                if c['sha256'] != man['dateien'][rel]['sha256']:
                    raise Fehler('%s: lokale Datei weicht von der geprüften Kopie auf fs01 ab - nichts überschrieben' % rel)
                c['fs01'] = True
                cache[rel] = c
                continue
            if belegt + st.st_size > budget:
                raise Fehler('Budget überschritten: belegt %d + %s (%d Bytes) > %d Bytes - nichts gelöscht, Kopie angehalten (Befund)' % (belegt, rel, st.st_size, budget))
            h = kopiere(src, ziel, db, n)
            man['dateien'][rel] = {'sha256': h, 'bytes': st.st_size, 'kopiert': iso(time.time())}
            schreibe_json(mpfad, man)
            cache[rel] = {'bytes': st.st_size, 'mtime_ns': st.st_mtime_ns, 'sha256': h, 'fs01': True}
            belegt += st.st_size
            erg['kopiert'].append(rel)
        # 4) lokal: nur auf fs01 geprüfte Dateien vor der vorletzten Vollsicherung entfernen
        for db, dd in lok.items():
            vz = sorted(i['zeit'] for i in dd.values() if i['art'] == 'FULL')
            if len(vz) < 2:
                continue
            for n, i in sorted(dd.items()):
                rel = db + '/' + n
                c = cache.get(rel) or {}
                if i['zeit'] < vz[-2] and c.get('fs01') and rel in man['dateien'] and c.get('sha256') == man['dateien'][rel]['sha256']:
                    os.remove(os.path.join(lokal, db, n))
                    cache.pop(rel, None)
                    erg['lokalEntfernt'].append(rel)
        erg['ok'] = True
    except (Fehler, OSError, ValueError, KeyError, TypeError) as e:
        erg['fehler'] = str(e)
    finally:
        try:
            erg['belegtBytes'] = belegung(mnt)
        except OSError:
            pass
        cache = {r: c for r, c in cache.items() if rel_ok(r) and os.path.isfile(os.path.join(lokal, *r.split('/')))}
        schreibe_json(cache_pfad, cache)
        schreibe_json(status_pfad, erg)
    print('ALFRED-KOPIE ' + json.dumps(erg, ensure_ascii=True))
    return 0 if erg['ok'] else 1


def hole(mnt, host, db, ziel_dir):
    if not DB.match(db) or not HOST.match(host):
        raise Fehler('Datenbank- oder Rechnername ungültig')
    ziel = os.path.join(mnt, host)
    man = manifest_lesen(ziel, host)
    if man is None:
        raise Fehler('auf fs01 gibt es kein Manifest für %s - zuerst sicherung_einrichten und sichern' % host)
    dd = je_db(man).get(db, {})
    for n, i in sorted(dd.items()):
        fp = os.path.join(ziel, db, n)
        if not os.path.isfile(fp) or os.path.getsize(fp) != i['bytes']:
            raise Fehler('%s/%s: auf fs01 fehlt die Datei oder ihre Größe weicht vom Manifest ab' % (db, n))
    ks, _ = ketten(dd)
    s = None
    for k in reversed(ks):
        s = satz(k, dd)
        if s:
            break
    if not s:
        gruende = '; '.join(f for k in ks for f in k['fehler'])[:300] or 'keine Vollsicherung oder kein LOG nach der letzten Sicherung'
        raise Fehler('keine vollständige Kette mit Protokollsicherung für %s auf fs01 (%s)' % (db, gruende))
    namen = [('FULL', s['full'])] + ([('DIFF', s['diff'])] if s['diff'] else []) + [('LOG', n) for n in s['logs']]
    for art, n in namen:
        q = os.path.join(ziel, db, n)
        z = os.path.join(ziel_dir, n)
        h = hashlib.sha256()
        with open(q, 'rb') as a, open(z, 'wb') as b:
            for blk in iter(lambda: a.read(BLOCK), b''):
                h.update(blk)
                b.write(blk)
        os.chmod(z, 0o600)
        if h.hexdigest() != dd[n]['sha256']:
            raise Fehler('%s/%s: Prüfsumme der fs01-Kopie weicht vom Manifest ab' % (db, n))
    for art, n in namen:
        print('ALFRED-DATEI|%s|%s' % (art, n))
    print('ALFRED-HOLE ' + json.dumps(s, ensure_ascii=True))
    return 0


def liste(lokal, mnt, host, cache_pfad, status_pfad, konf_pfad):
    erg = {'zustand': 'gelesen', 'host': host, 'status': lies_json(status_pfad, None)}
    k = konf_lesen(konf_pfad)
    erg['ziel'] = '//%s/%s' % (k['server'], k['freigabe'])
    erg['budgetBytes'] = k['budgetBytes']
    erg['belegtBytes'] = belegung(mnt)
    cache = lies_json(cache_pfad, {})
    ziel = os.path.join(mnt, host)
    man = manifest_lesen(ziel, host) or {'dateien': {}}
    dbs = {}
    for db, dd in sorted(je_db(man).items()):
        ks, waisen = ketten(dd)
        vorhanden_pruefen(ziel, db, dd, ks)
        dbs[db] = {'ketten': [{'full': x['zeit'], 'diffs': len(x['diffs']), 'logs': len(x['logs']), 'vollstaendig': not x['fehler'], 'fehler': x['fehler'][:3]} for x in ks],
                   'waisen': waisen[:5], 'fs01Dateien': len(dd), 'fs01Bytes': sum(i['bytes'] or 0 for i in dd.values())}
    for db, dd in lokale(lokal).items():
        d = dbs.setdefault(db, {'ketten': [], 'waisen': [], 'fs01Dateien': 0, 'fs01Bytes': 0})
        offen_ = abweichend = 0
        for n in dd:
            rel = db + '/' + n
            c = cache.get(rel) or {}
            if rel not in man['dateien']:
                offen_ += 1
            elif c.get('sha256') and c['sha256'] != man['dateien'][rel]['sha256']:
                abweichend += 1
        d.update(lokalDateien=len(dd), lokalBytes=sum(os.path.getsize(os.path.join(lokal, db, n)) for n in dd), nochNichtAufFs01=offen_, hashAbweichend=abweichend)
    erg['datenbanken'] = dbs
    print('ALFRED-LISTE ' + json.dumps(erg, ensure_ascii=True))
    return 0


def geprueft(cache_pfad, rel):
    c = lies_json(cache_pfad, {}).get(rel) or {}
    print('ALFRED-GEPRUEFT ' + json.dumps({'sha256': c.get('sha256'), 'fs01': bool(c.get('fs01'))}))
    return 0 if c.get('fs01') else 1


def status_fehler(status_pfad, text):
    schreibe_json(status_pfad, {'zeit': iso(time.time()), 'ok': False, 'fehler': text[:500], 'kopiert': [], 'geloescht': [], 'hinweise': []})
    return 0


def main(argv):
    jetzt = time.time()
    if len(argv) >= 2 and argv[-2] == '--jetzt':
        jetzt = float(argv[-1])
        argv = argv[:-2]
    try:
        m, a = (argv[0], argv[1:]) if argv else ('', [])
        if m == 'kopie' and len(a) == 6:
            return kopie(*a, jetzt=jetzt)
        if m == 'hole' and len(a) == 4:
            return hole(*a)
        if m == 'liste' and len(a) == 6:
            return liste(*a)
        if m == 'geprueft' and len(a) == 2:
            return geprueft(*a)
        if m == 'konf' and len(a) == 2:
            print(konf_feld(*a))
            return 0
        if m == 'status-fehler' and len(a) == 2:
            return status_fehler(*a)
        raise Fehler('unbekannter Aufruf %s' % m)
    except (Fehler, OSError, ValueError, KeyError, TypeError) as e:
        print('ALFRED-FEHLER ' + json.dumps({'fehler': str(e)}, ensure_ascii=True))
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
`;

// ── Fest installiertes Kopier-Skript und systemd-Einheiten ─────────────────────────────────────────────────────────────────────

/** /usr/local/lib/alfred/sqllnx-kopie.sh — vom Timer gestartet; liest die Zugangsdatei nur als Pfad (mount.cifs credentials=) */
export const KOPIE_SH = `#!/bin/bash
# Alfred I8e - Kopie der SQL-Sicherungen nach fs01 (installiert von linux_sql sicherung_einrichten; diese Datei enthaelt kein Geheimnis)
set -euo pipefail
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
KONF=${KOPIE_KONF}
CRED=${ZUGANGSDATEI_FEST}
PY=${KETTE_PY_PFAD}
STATUS=${KOPIE_STATUS}
CACHE=${KOPIE_CACHE}
LOKAL=${SICHERUNG_WURZEL}
OPTIONEN='${CIFS_OPTIONEN}'
MNT=''
aufraeumen() { if [ -n "$MNT" ]; then umount "$MNT" 2>/dev/null || umount -l "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true; fi; }
trap aufraeumen EXIT
fehler() { python3 -I "$PY" status-fehler "$STATUS" "$1" >/dev/null 2>&1 || true; echo "Alfred-Kopie: $1" >&2; exit 1; }
install -d -m 0700 -o root -g root /var/lib/alfred
exec 9>/run/alfred-sqllnx-kopie.lock
flock -w 3600 9 || fehler "eine andere Kopie laeuft noch (1 h gewartet)"
{ [ -f "$CRED" ] && [ "$(stat -c '%u:%a' "$CRED")" = 0:600 ]; } || fehler "Zugangsdatei $CRED fehlt oder ist nicht 0600/root"
mountpoint -q "$LOKAL" || fehler "$LOKAL ist nicht eingehaengt"
UNC=$(python3 -I "$PY" konf "$KONF" unc) || fehler "Konfiguration $KONF unlesbar: $UNC"
RECHNER=$(hostname -s | tr 'A-Z' 'a-z')
MNT=$(mktemp -d /run/alfred-sqllnx-m.XXXXXX)
aus=$(mount -t cifs "$UNC" "$MNT" -o "credentials=$CRED,$OPTIONEN" 2>&1) || fehler "fs01 nicht einhaengbar ($UNC): $aus"
python3 -I "$PY" kopie "$LOKAL" "$MNT" "$RECHNER" "$KONF" "$STATUS" "$CACHE"`;

export const KOPIE_DIENST_UNIT = `[Unit]
Description=Alfred: SQL-Sicherungen nach fs01 kopieren und Aufbewahrung (I8e)
After=network-online.target mssql-server.service
Wants=network-online.target
RequiresMountsFor=${SICHERUNG_WURZEL}

[Service]
Type=oneshot
ExecStart=${KOPIE_SH_PFAD}
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=4h`;

export const KOPIE_TIMER_UNIT = `[Unit]
Description=Alfred: SQL-Sicherungen alle 15 min nach fs01 kopieren (I8e)

[Timer]
OnCalendar=*:07/15
Persistent=true
RandomizedDelaySec=60
Unit=${KOPIE_DIENST}.service

[Install]
WantedBy=timers.target`;

// ── Gemeinsame Bash-Teile ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** vor der Marke (Tests ersetzen Funktionen danach): Pfade, Python, Konfiguration, fs01 einhängen, Aufräumen */
const FS01_HILFE = (ziel?: string) => [
  'RUN_DIR=/run',
  `SICHERUNG_WURZEL=${SICHERUNG_WURZEL}`,
  `KONF_DATEI=${KOPIE_KONF}`,
  `CACHE=${KOPIE_CACHE}`,
  `STATUS_DATEI=${KOPIE_STATUS}`,
  `OPTIONEN=${shQ(CIFS_OPTIONEN)}`,
  `PY_KETTE=${shQ(PY_KETTE)}`,
  'kette_py() { python3 -I -c "$PY_KETTE" "$@"; }',
  'konf_feld() { kette_py konf "$KONF_DATEI" "$1"; }',
  "rechnername() { hostname -s | tr 'A-Z' 'a-z'; }",
  "ZUGANGSDATEI=''; MNT=''; WH_ANGELEGT=0",
  // Zugangsdaten nur aus der Eingabe, nur per printf (Builtin) in eine mktemp-Datei (0600) unter /run; entfernt im Aufräumen
  'zugang_schreiben() {',
  '  local kw konto domaene',
  '  kw=$(feld kennwort) || abbruch "fs01-Kennwort enthält nicht druckbare Zeichen"',
  '  [ -n "$kw" ] || abbruch "fs01-Kennwort fehlt in der Eingabe (JSON-Feld kennwort)"',
  '  { konto=$(konf_feld konto) && domaene=$(konf_feld domaene); } || abbruch "Konfiguration $KONF_DATEI unlesbar (zuerst sicherung_einrichten)"',
  '  ZUGANGSDATEI=$(mktemp "$RUN_DIR/alfred-c-XXXXXXXXXXXX")',
  '  chmod 0600 "$ZUGANGSDATEI"',
  "  printf 'username=%s\\npassword=%s\\ndomain=%s\\n' \"$konto\" \"$kw\" \"$domaene\" >\"$ZUGANGSDATEI\"",
  '}',
  'fs01_einhaengen() {',
  '  local server freigabe aus',
  '  { server=$(konf_feld server) && freigabe=$(konf_feld freigabe); } || abbruch "Konfiguration $KONF_DATEI unlesbar (zuerst sicherung_einrichten)"',
  '  zugang_schreiben',
  '  MNT=$(mktemp -d "$RUN_DIR/alfred-sqllnx-m.XXXXXX")',
  '  aus=$(mount -t cifs "//$server/$freigabe" "$MNT" -o "credentials=$ZUGANGSDATEI,$OPTIONEN${1:+,$1}" 2>&1) || abbruch "fs01 nicht einhängbar (//$server/$freigabe): $(kurz "$aus")"',
  '}',
  'fs01_aushaengen() { if [ -n "$MNT" ]; then umount "$MNT" 2>/dev/null || umount -l "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true; MNT=\'\'; fi; [ -z "$ZUGANGSDATEI" ] || rm -f -- "$ZUGANGSDATEI"; ZUGANGSDATEI=\'\'; }',
  `alfred_aufraeumen() { [ -z "$ZUGANGSDATEI" ] || rm -f -- "$ZUGANGSDATEI"; ZUGANGSDATEI=''; fs01_aushaengen;${ziel ? ` if [ "$WH_ANGELEGT" = 1 ]; then sql "IF DB_ID(N'${ziel}') IS NOT NULL DROP DATABASE [${ziel}]" >/dev/null 2>&1 || true; fi;` : ''} }`,
];

const ZUSTAND_ZUGANGSDATEI = `zugangsdatei_zustand() { if [ -f "$1" ]; then if [ "$(stat -c '%u:%a' "$1")" = 0:600 ]; then echo 'vorhanden (0600)'; else echo "Rechte $(stat -c '%u:%a' "$1")"; fi; else echo fehlt; fi; }`;

// ── sicherung_einrichten ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * cifs-utils (feste Ubuntu-Version), Prozedur + Agent-Jobs, Kopier-Skript, Konfiguration, feste Zugangsdatei (0600 root, aus der
 * Eingabe), systemd-Dienst + Timer; Selbstprüfung: Jobs aktiv mit Zeitplan, Agent läuft, Timer aktiv, ein Kopierlauf mit der festen
 * Zugangsdatei gelingt (Einhängen, Manifest, Budget). Eingabe: { sa, kennwort }. Zeit: LINUX_SQL_SICHERUNG_ZEIT_MS.einrichten
 */
export function sicherungEinrichtenSkript(p: SicherungEinrichtenParameter): string {
  pruefe(pruefeSicherungEinrichten(p));
  const cifs = p.cifsVersion ?? CIFS_UTILS_VERSION;
  const konf = JSON.stringify({ fassung: 1, server: p.server, freigabe: p.freigabe, konto: p.konto, domaene: p.domaene, budgetBytes: p.budgetGiB * 2 ** 30 });
  return [
    ...sqlKopf(LINUX_SQL_SICHERUNG_BAUSTEINE.einrichten, { server: p.server, freigabe: p.freigabe, konto: p.konto, domaene: p.domaene, budgetGiB: p.budgetGiB, cifsVersion: cifs }),
    ...SQL_HILFE,
    `SICHERUNG_WURZEL=${SICHERUNG_WURZEL}`,
    `CIFS_V=${shQ(cifs)}`,
    `ZUGANG_FEST=${shQ(ZUGANGSDATEI_FEST)}`,
    `KONF_INHALT=${shQ(konf)}`,
    `KONTO=${shQ(p.konto)}`,
    `DOMAENE=${shQ(p.domaene)}`,
    `JOBS_TSQL=${shQ(sicherungJobsTsql())}`,
    `PY_KETTE=${shQ(PY_KETTE)}`,
    `KOPIE_SH=${shQ(KOPIE_SH)}`,
    `DIENST=${shQ(KOPIE_DIENST_UNIT)}`,
    `TIMER=${shQ(KOPIE_TIMER_UNIT)}`,
    "paket_version() { dpkg-query -W -f='${Status}|${Version}' \"$1\" 2>/dev/null | awk -F'|' '$1 == \"install ok installed\" { print $2 }' || true; }",
    // Datei nur bei abweichendem Inhalt oder Rechten ersetzen (mktemp im Zielordner, dann mv); $3 = Inhalt
    'schreibe_wenn_anders() {',
    '  if [ "$(cat "$1" 2>/dev/null || true)" != "$3" ] || [ "$(stat -c \'%u:%a\' "$1" 2>/dev/null || true)" != "0:$2" ]; then',
    '    local t; t=$(mktemp "$(dirname "$1")/.alfred-neu.XXXXXX")',
    '    printf \'%s\\n\' "$3" >"$t"; chmod "$2" "$t"; chown root:root "$t"; mv -f "$t" "$1"; GEAENDERT=1',
    '  fi',
    '}',
    ZUSTAND_ZUGANGSDATEI,
    ...SA_LESEN,
    'KW=$(feld kennwort) || abbruch "fs01-Kennwort enthält nicht druckbare Zeichen"',
    '[ -n "$KW" ] || abbruch "fs01-Kennwort fehlt in der Eingabe (JSON-Feld kennwort)"',
    '[[ "$KW" =~ ^[[:print:]]+$ ]] || abbruch "fs01-Kennwort enthält nicht druckbare Zeichen"',
    'mountpoint -q "$SICHERUNG_WURZEL" || abbruch "$SICHERUNG_WURZEL ist kein eigener Einhängepunkt (Platten-Schritt fehlt) — nichts geändert"',
    'bereit || abbruch "SQL Server antwortet nicht als sa — nichts geändert"',
    'a=$(alfred_zeile "$(sql "SET NOCOUNT ON; SELECT N\'ALFRED|\' + CAST(COUNT(*) AS nvarchar(5)) FROM sys.dm_exec_sessions WHERE program_name LIKE N\'SQLAgent%\'")")',
    'a=${a#ALFRED|}',
    '{ [[ "$a" =~ ^[0-9]+$ ]] && [ "$a" -gt 0 ]; } || abbruch "SQL-Agent läuft nicht (linux_sql konfigurieren mit agent=true) — nichts geändert"',
    'GEAENDERT=0',
    'export DEBIAN_FRONTEND=noninteractive',
    'iv=$(paket_version cifs-utils)',
    'if [ -z "$iv" ]; then',
    '  ALFRED_TMP=$(mktemp -d /run/alfred-sql.XXXXXX)',
    '  apt-get -o DPkg::Lock::Timeout=300 update -q >"$ALFRED_TMP/apt.log" 2>&1 || abbruch "apt-get update fehlgeschlagen: $(kurz "$(cat "$ALFRED_TMP/apt.log")")"',
    '  apt-cache madison cifs-utils | awk -F\'|\' \'{ gsub(/ /, "", $2); print $2 }\' | grep -qxF "$CIFS_V" || abbruch "cifs-utils=$CIFS_V ist in der Paketquelle nicht verfügbar — nichts installiert"',
    '  apt-get -o DPkg::Lock::Timeout=300 install -y -q --no-install-recommends "cifs-utils=$CIFS_V" >"$ALFRED_TMP/apt.log" 2>&1 || abbruch "apt-get install cifs-utils fehlgeschlagen: $(kurz "$(cat "$ALFRED_TMP/apt.log")")"',
    '  apt-mark -o DPkg::Lock::Timeout=300 hold cifs-utils >/dev/null',
    '  GEAENDERT=1',
    'elif [ "$iv" != "$CIFS_V" ]; then',
    '  abbruch "cifs-utils ist in Version $iv installiert, erwartet $CIFS_V — nichts geändert"',
    'fi',
    'command -v mount.cifs >/dev/null || abbruch "mount.cifs fehlt nach der Installation"',
    // Prozedur und Agent-Jobs (fremde Jobs gleichen Namens → Abbruch vor jeder Änderung)
    'aus=$(sql "$JOBS_TSQL" 2>&1) || abbruch "Agent-Jobs: $(kurz "$aus")"',
    'IFS="|" read -r _ jz jobs proc agent <<<"$(alfred_zeile "$aus")"',
    '{ [ "$jobs" = 3 ] && [ "$proc" = 1 ]; } || abbruch "nach dem Einrichten: $jobs von 3 Agent-Jobs aktiv mit Zeitplan, Prozedur $proc — erwartet 3, 1"',
    '[ "$jz" = schon ] || GEAENDERT=1',
    // Dateien (Inhalt fest; Konfiguration ohne Geheimnis; Zugangsdatei 0600 root aus der Eingabe)
    'install -d -m 0755 -o root -g root /usr/local/lib/alfred',
    'install -d -m 0700 -o root -g root /etc/alfred /var/lib/alfred',
    `schreibe_wenn_anders ${KETTE_PY_PFAD} 644 "$PY_KETTE"`,
    `schreibe_wenn_anders ${KOPIE_SH_PFAD} 755 "$KOPIE_SH"`,
    `schreibe_wenn_anders ${KOPIE_KONF} 600 "$KONF_INHALT"`,
    // printf ist ein Builtin: das Kennwort erscheint in keiner Befehlszeile
    'schreibe_wenn_anders "$ZUGANG_FEST" 600 "$(printf \'username=%s\\npassword=%s\\ndomain=%s\' "$KONTO" "$KW" "$DOMAENE")"',
    'unset KW',
    'vor=$GEAENDERT; GEAENDERT=0',
    `schreibe_wenn_anders /etc/systemd/system/${KOPIE_DIENST}.service 644 "$DIENST"`,
    `schreibe_wenn_anders /etc/systemd/system/${KOPIE_DIENST}.timer 644 "$TIMER"`,
    '[ "$GEAENDERT" = 0 ] || systemctl daemon-reload',
    '[ "$vor" = 0 ] || GEAENDERT=1',
    `if ! systemctl is-enabled --quiet ${KOPIE_DIENST}.timer || ! systemctl is-active --quiet ${KOPIE_DIENST}.timer; then`,
    `  systemctl enable --now ${KOPIE_DIENST}.timer >/dev/null 2>&1 || abbruch "Timer ${KOPIE_DIENST}.timer lässt sich nicht aktivieren"`,
    '  GEAENDERT=1',
    'fi',
    // Selbstprüfung: ein Kopierlauf mit der festen Zugangsdatei (Einhängen, Manifest, Budget, Kopie vorhandener Sicherungen)
    // läuft der Timer gerade, schließt sich start seinem Lauf an (älterer Beginn) → höchstens ein zweiter Lauf
    'for i in 1 2; do',
    "  beginn=$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    `  systemctl start ${KOPIE_DIENST}.service >/dev/null 2>&1 || true`,
    "  " + "st=$(python3 -I -c 'import json,sys\ns=json.load(open(sys.argv[1]))\nif str(s.get(\"zeit\",\"\")) < sys.argv[2]: print(\"FEHLER|kein neuer Kopierlauf\")\nelif s.get(\"ok\"): print(\"ok|%d|%d\" % (s.get(\"belegtBytes\", 0), s.get(\"budgetBytes\", 0)))\nelse: print(\"FEHLER|\" + str(s.get(\"fehler\"))[:300])' " + KOPIE_STATUS + ' "$beginn" 2>/dev/null || echo "FEHLER|kein Status")',
    '  [ "${st%%|*}" != ok ] || break',
    'done',
    '[ "${st%%|*}" = ok ] || abbruch "Probe-Kopie nach fs01 gescheitert: ${st#*|}"',
    'IFS="|" read -r _ belegt budget <<<"$st"',
    'zd=$(zugangsdatei_zustand "$ZUGANG_FEST")',
    '[ "$zd" = "vorhanden (0600)" ] || abbruch "Zugangsdatei $ZUGANG_FEST: $zd"',
    `systemctl is-active --quiet ${KOPIE_DIENST}.timer || abbruch "Timer ${KOPIE_DIENST}.timer ist nicht aktiv"`,
    'if [ "$GEAENDERT" = 1 ]; then Z=geaendert; else Z=schon; fi',
    `ergebnis "{\\"zustand\\":\\"$Z\\",\\"jobs\\":$jobs,\\"agent\\":$agent,\\"timer\\":\\"aktiv\\",\\"zugangsdatei\\":\\"$zd\\",\\"ziel\\":\\"//${p.server}/${p.freigabe}\\",\\"budgetBytes\\":$budget,\\"belegtBytes\\":$belegt,\\"cifsUtils\\":\\"$CIFS_V\\"}"`,
  ].join('\n');
}

// ── sicherung_jetzt ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Eine Sicherung über die Prozedur (gleiche Kette wie die Agent-Jobs), danach Kopie anstoßen und auf fs01 bestätigen. Eingabe: { sa } */
export function sicherungJetztSkript(p: SicherungJetztParameter): string {
  pruefe(pruefeSicherungJetzt(p));
  const db = p.datenbank;
  return [
    ...sqlKopf(LINUX_SQL_SICHERUNG_BAUSTEINE.jetzt, { art: p.art, datenbank: db }),
    ...SQL_HILFE,
    `CACHE=${KOPIE_CACHE}`,
    `PY_KETTE=${shQ(PY_KETTE)}`,
    'kette_py() { python3 -I -c "$PY_KETTE" "$@"; }',
    `pruefe_datei() { [[ "$1" =~ ^${SICHERUNG_WURZEL}/${db}/${db}_${p.art}_[0-9]{14}(_[0-9]{14})?\\.(bak|trn)$ ]] && [ -f "$1" ]; }`,
    // die Kopie nimmt Dateien erst nach 60 s Schreibruhe
    'warte_schreibruhe() { local a; a=$(( $(date +%s) - $(stat -c %Y "$1") )); if [ "$a" -lt 61 ]; then sleep $(( 61 - a )); fi; }',
    ...SA_LESEN,
    `systemctl cat ${KOPIE_DIENST}.service >/dev/null 2>&1 || abbruch "Kopie nach fs01 ist nicht eingerichtet (zuerst sicherung_einrichten) — nichts gesichert"`,
    'bereit || abbruch "SQL Server antwortet nicht als sa"',
    `aus=$(sql "EXEC msdb.dbo.alfred_sicherung @art = N'${p.art}', @db = N'${db}', @streng = 1;" 2>&1) || abbruch "Sicherung ${p.art} von ${db}: $(kurz "$aus")"`,
    'datei=$(alfred_zeile "$aus"); datei=${datei#ALFRED|}',
    'pruefe_datei "$datei" || abbruch "Sicherung meldet unerwartete Datei: $(kurz "$datei")"',
    `rel=\${datei#${SICHERUNG_WURZEL}/}`,
    'warte_schreibruhe "$datei"',
    'ok=0; g=\'\'',
    'for i in 1 2; do',
    `  systemctl start ${KOPIE_DIENST}.service >/dev/null 2>&1 || true`,
    '  if g=$(kette_py geprueft "$CACHE" "$rel"); then ok=1; break; fi',
    'done',
    '[ "$ok" = 1 ] || abbruch "Kopie von $rel nach fs01 nicht bestätigt (Status des Kopierlaufs: sicherungen)"',
    'sha=$(sed -n \'s/.*"sha256": *"\\([0-9a-f]\\{64\\}\\)".*/\\1/p\' <<<"$g")',
    `ergebnis "{\\"zustand\\":\\"geaendert\\",\\"art\\":\\"${p.art}\\",\\"datenbank\\":\\"${db}\\",\\"datei\\":\\"$datei\\",\\"sha256\\":\\"$sha\\",\\"fs01\\":true}"`,
  ].join('\n');
}

// ── sicherungen (lesend) ───────────────────────────────────────────────────────────────────────────────────────────────────────

const MSDB_TSQL = [
  'SET NOCOUNT ON;',
  'SELECT (SELECT j.name, CAST(j.enabled AS int) AS aktiv,',
  '   (SELECT TOP (1) h.run_status AS ergebnis, h.run_date AS datum, h.run_time AS zeit FROM msdb.dbo.sysjobhistory h WHERE h.job_id = j.job_id AND h.step_id = 0 ORDER BY h.instance_id DESC FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS letzterLauf',
  "  FROM msdb.dbo.sysjobs j WHERE j.name LIKE N'alfred-sqllnx-%' ORDER BY j.name FOR JSON PATH) AS jobs,",
  ' (SELECT b.database_name AS datenbank, b.type AS art, MAX(b.backup_finish_date) AS zuletzt, COUNT(*) AS anzahl',
  '  FROM msdb.dbo.backupset b JOIN msdb.dbo.backupmediafamily mf ON mf.media_set_id = b.media_set_id',
  `  WHERE mf.physical_device_name LIKE N'${SICHERUNG_WURZEL}/%' GROUP BY b.database_name, b.type ORDER BY b.database_name, b.type FOR JSON PATH) AS historie`,
  'FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES;',
].join('\n');

/** python3: msdb-Historie und Agent-Jobs; stdin = Eingabe-JSON (sa) */
const PY_MSDB = [
  'import json, os, subprocess, sys',
  `TSQL = ${JSON.stringify(MSDB_TSQL)}`,
  'try:',
  '    sa = json.loads(sys.stdin.read() or "{}").get("sa")',
  'except Exception:',
  '    sa = None',
  'if not isinstance(sa, str) or not sa:',
  '    print(json.dumps({"fehler": "ohne sa-Kennwort keine msdb-Sicht"}))',
  '    sys.exit(0)',
  'try:',
  '    p = subprocess.run(["/opt/mssql-tools18/bin/sqlcmd", "-C", "-b", "-x", "-S", "localhost", "-U", "sa", "-l", "30", "-h", "-1", "-y", "0"], input=TSQL, capture_output=True, text=True, timeout=60, env=dict(os.environ, SQLCMDPASSWORD=sa))',
  '    aus = "".join(z.strip() for z in p.stdout.splitlines())',
  '    print(aus if p.returncode == 0 and aus.startswith("{") else json.dumps({"fehler": ((p.stderr or "") + " " + (p.stdout or "")).strip()[-300:]}))',
  'except Exception as e:',
  '    print(json.dumps({"fehler": type(e).__name__}))',
].join('\n');

const PY_ZUSAMMEN = [
  'import json, sys',
  'l = json.loads(sys.argv[1])',
  'try:',
  '    l["msdb"] = json.loads(sys.argv[2])',
  'except Exception:',
  '    l["msdb"] = {"fehler": "msdb-Antwort unlesbar"}',
  'l["timer"] = sys.argv[3]',
  'l["zugangsdatei"] = sys.argv[4]',
  'print("ALFRED-SQL " + json.dumps(l, ensure_ascii=True))',
].join('\n');

/** Lesend: Dateien lokal und auf fs01 (Manifest, Ketten, Größen, Hash-Abgleich), Budget, letzter Kopierlauf, Timer, Zugangsdatei, msdb. Eingabe: { sa, kennwort } */
export function sicherungenSkript(): string {
  return [
    ...sqlKopf(LINUX_SQL_SICHERUNG_BAUSTEINE.liste, {}),
    'kurz() { printf "%s" "$1" | tail -n 6 | tr "\\r\\n" "  "; }',
    ...FS01_HILFE(),
    ZUSTAND_ZUGANGSDATEI,
    `PY_MSDB=${shQ(PY_MSDB)}`,
    `PY_ZUSAMMEN=${shQ(PY_ZUSAMMEN)}`,
    '# ALFRED-ABLAUF',
    'HOST=$(rechnername)',
    '[[ "$HOST" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || abbruch "Rechnername $HOST ungültig"',
    '[ -f "$KONF_DATEI" ] || abbruch "Sicherung ist nicht eingerichtet ($KONF_DATEI fehlt — sicherung_einrichten)"',
    'fs01_einhaengen ro',
    'l=$(kette_py liste "$SICHERUNG_WURZEL" "$MNT" "$HOST" "$CACHE" "$STATUS_DATEI" "$KONF_DATEI") || abbruch "Sicherungen lesen: $(kurz "$l")"',
    'fs01_aushaengen',
    'l=$(grep "^ALFRED-LISTE " <<<"$l" | head -n 1)',
    'm=$(python3 -I -c "$PY_MSDB" <<<"$ALFRED_EINGABE") || m=\'{"fehler":"msdb nicht lesbar"}\'',
    `timer=$(systemctl is-active ${KOPIE_DIENST}.timer 2>/dev/null || true)`,
    `zd=$(zugangsdatei_zustand ${ZUGANGSDATEI_FEST})`,
    'python3 -I -c "$PY_ZUSAMMEN" "${l#ALFRED-LISTE }" "$m" "${timer:-unbekannt}" "$zd"',
    'ALFRED_ZEILE=1',
  ].join('\n');
}

// ── wiederherstellen_pruefen ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Restore-Beweis aus der fs01-Kopie unter einem neuen Namen. Abbruch ohne Änderung, wenn das Ziel schon besteht; danach wird das Ziel
 * bei jedem Fehler entfernt (trap). RESTORE_VERIFIED nur nach CHECKDB ohne Meldung, gleichen Prüfdaten und entfernter Ziel-DB.
 * Eingabe: { sa, kennwort }. Zeit: LINUX_SQL_SICHERUNG_ZEIT_MS.wiederherstellen
 */
export function wiederherstellenSkript(p: WiederherstellenParameter): string {
  pruefe(pruefeWiederherstellen(p));
  const db = p.datenbank; const z = p.ziel; // geprüft: [A-Za-z0-9_] — sicher in [] und N'…'
  const frei = `SET NOCOUNT ON; SELECT N'ALFRED|' + CASE WHEN DB_ID(N'${z}') IS NULL THEN N'frei' ELSE N'belegt' END`;
  return [
    ...sqlKopf(LINUX_SQL_SICHERUNG_BAUSTEINE.wiederherstellen, { datenbank: db, ziel: z }),
    ...SQL_HILFE,
    'sqls() { SQLCMDPASSWORD="$SA" "$SQLCMD" -C -b -x -S localhost -U sa -l 30 -h -1 -W -w 65535 -s "|" <<<"$1"; }',
    ...FS01_HILFE(z),
    `DB=${shQ(db)}`,
    `ZIEL=${shQ(z)}`,
    `FREI_Q=${shQ(frei)}`,
    `PRUEF_Q=${shQ(`SET NOCOUNT ON; USE [${z}]; ${PRUEF_SELECT}`)}`,
    `SOLL=${PRUEFDATEN_SHA256}`,
    `N_SOLL=${PRUEFDATEN_ZEILEN}`,
    'DATEN=/var/opt/mssql/data; LOGD=/var/opt/mssql/log',
    'r() { local a; a=$(sql "$1" 2>&1) || abbruch "$2: $(kurz "$a")"; }',
    // genau ein Sicherungssatz, Typ (1 FULL, 5 DIFF, 2 LOG) und Datenbank wie erwartet
    'kopf_pruefen() {',
    '  local h n typ dbname',
    '  h=$(sqls "SET NOCOUNT ON; RESTORE HEADERONLY FROM DISK = N\'$1\'" 2>&1) || abbruch "RESTORE HEADERONLY $(basename "$1"): $(kurz "$h")"',
    '  n=$(grep -c . <<<"$h" || true)',
    '  [ "$n" = 1 ] || abbruch "$(basename "$1") enthält $n Sicherungssätze, erwartet 1"',
    '  IFS="|" read -r _ _ typ _ _ _ _ _ _ dbname _ <<<"$h"',
    '  { [ "$typ" = "$2" ] && [ "$dbname" = "$DB" ]; } || abbruch "$(basename "$1"): Sicherungstyp $typ, Datenbank $dbname — erwartet $2, $DB"',
    '}',
    ...SA_LESEN,
    'HOST=$(rechnername)',
    '[[ "$HOST" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || abbruch "Rechnername $HOST ungültig"',
    'mountpoint -q "$SICHERUNG_WURZEL" || abbruch "$SICHERUNG_WURZEL ist kein eigener Einhängepunkt — nichts geändert"',
    'bereit || abbruch "SQL Server antwortet nicht als sa"',
    '[ "$(alfred_zeile "$(sql "$FREI_Q")")" = "ALFRED|frei" ] || abbruch "Datenbank $ZIEL besteht schon — nichts geändert (Rest eines früheren Laufs? bewusst entfernen)"',
    // Kette aus der fs01-KOPIE holen (Manifest-SHA-256 je Datei), nie aus dem lokalen Sicherungsordner
    'fs01_einhaengen ro',
    'ALFRED_TMP=$(mktemp -d "$SICHERUNG_WURZEL/.alfred-wh-XXXXXXXX")',
    'h=$(kette_py hole "$MNT" "$HOST" "$DB" "$ALFRED_TMP") || abbruch "Kette von fs01: $(kurz "$h")"',
    'fs01_aushaengen',
    "FULL=''; DIFF=''; LOGS=()",
    'while IFS="|" read -r tag art name; do',
    '  [ "$tag" = ALFRED-DATEI ] || continue',
    '  [[ "$name" =~ ^${DB}_(FULL|DIFF|LOG)_[0-9]{14}(_[0-9]{14})?\\.(bak|trn)$ ]] || abbruch "unerwarteter Dateiname von fs01: $(kurz "$name")"',
    '  f="$ALFRED_TMP/$name"',
    '  [[ "$f" =~ ^[A-Za-z0-9_./-]+$ ]] && [ -f "$f" ] || abbruch "Datei $name fehlt nach dem Holen"',
    '  case "$art" in FULL) FULL=$f ;; DIFF) DIFF=$f ;; LOG) LOGS+=("$f") ;; *) abbruch "unerwartete Art $art" ;; esac',
    'done <<<"$h"',
    '{ [ -n "$FULL" ] && [ "${#LOGS[@]}" -gt 0 ]; } || abbruch "Kette von fs01 unvollständig geliefert (FULL und mindestens ein LOG nötig)"',
    "KETTE=$(sed -n 's/^ALFRED-HOLE .*\"kette\": *\"\\([0-9]\\{14\\}\\)\".*/\\1/p' <<<\"$h\")",
    'chown -R mssql:mssql "$ALFRED_TMP"; chmod 0700 "$ALFRED_TMP"',
    'kopf_pruefen "$FULL" 1',
    '[ -z "$DIFF" ] || kopf_pruefen "$DIFF" 5',
    'for l in "${LOGS[@]}"; do kopf_pruefen "$l" 2; done',
    // Dateien der Ziel-DB auf die Daten-/Log-Platte, nie über Bestehendes
    'fl=$(sqls "SET NOCOUNT ON; RESTORE FILELISTONLY FROM DISK = N\'$FULL\'" 2>&1) || abbruch "RESTORE FILELISTONLY: $(kurz "$fl")"',
    "MOVE=''; nd=0",
    'while IFS="|" read -r logisch _ typ _; do',
    '  [ -n "$logisch" ] || continue',
    '  [[ "$logisch" =~ ^[A-Za-z0-9_.-]{1,128}$ ]] || abbruch "logischer Dateiname $(kurz "$logisch") wird nicht unterstützt"',
    '  case "$typ" in',
    '    D) nd=$((nd + 1)); if [ "$nd" = 1 ]; then e=mdf; else e=ndf; fi; zd="$DATEN/${ZIEL}_${logisch}.$e" ;;',
    '    L) zd="$LOGD/${ZIEL}_${logisch}.ldf" ;;',
    '    *) abbruch "Dateityp $typ ($logisch) wird nicht unterstützt" ;;',
    '  esac',
    '  [ ! -e "$zd" ] || abbruch "$zd besteht schon — nichts überschrieben"',
    '  MOVE+="${MOVE:+, }MOVE N\'$logisch\' TO N\'$zd\'"',
    'done <<<"$fl"',
    '[ "$nd" -ge 1 ] || abbruch "RESTORE FILELISTONLY ohne Datendatei"',
    'WH_ANGELEGT=1',
    'r "RESTORE DATABASE [$ZIEL] FROM DISK = N\'$FULL\' WITH FILE = 1, $MOVE, NORECOVERY, CHECKSUM" "Wiederherstellen FULL"',
    '[ -z "$DIFF" ] || r "RESTORE DATABASE [$ZIEL] FROM DISK = N\'$DIFF\' WITH FILE = 1, NORECOVERY, CHECKSUM" "Wiederherstellen DIFF"',
    'for l in "${LOGS[@]}"; do r "RESTORE LOG [$ZIEL] FROM DISK = N\'$l\' WITH FILE = 1, NORECOVERY, CHECKSUM" "Wiederherstellen LOG $(basename "$l")"; done',
    'r "RESTORE DATABASE [$ZIEL] WITH RECOVERY" "RECOVERY"',
    'chk=$(sql "DBCC CHECKDB([$ZIEL]) WITH NO_INFOMSGS, ALL_ERRORMSGS" 2>&1) || abbruch "DBCC CHECKDB meldet Fehler: $(kurz "$chk")"',
    '[ -z "$(tr -d \'[:space:]\' <<<"$chk")" ] || abbruch "DBCC CHECKDB meldet: $(kurz "$chk")"',
    'pd=$(alfred_zeile "$(sql "$PRUEF_Q" 2>&1)")',
    'IFS="|" read -r _ zeilen hash <<<"$pd"',
    '{ [ "$zeilen" = "$N_SOLL" ] && [ "$hash" = "$SOLL" ]; } || abbruch "Prüfdaten der Wiederherstellung weichen ab: ${zeilen:-?} Zeilen, Prüfsumme ${hash:-?} (erwartet $N_SOLL, $SOLL)"',
    `r "DROP DATABASE [${z}]" "Ziel-Datenbank entfernen"`,
    '[ "$(alfred_zeile "$(sql "$FREI_Q")")" = "ALFRED|frei" ] || abbruch "Ziel-Datenbank $ZIEL nach dem Entfernen noch vorhanden"',
    'WH_ANGELEGT=0',
    'if [ -n "$DIFF" ]; then D=true; else D=false; fi',
    'ergebnis "{\\"zustand\\":\\"geaendert\\",\\"ergebnis\\":\\"RESTORE_VERIFIED\\",\\"datenbank\\":\\"$DB\\",\\"ziel\\":\\"$ZIEL\\",\\"kette\\":\\"$KETTE\\",\\"diff\\":$D,\\"logs\\":${#LOGS[@]},\\"checkdb\\":\\"ohne Befund\\",\\"zeilen\\":$zeilen,\\"pruefsumme\\":\\"$hash\\",\\"entfernt\\":true}"',
  ].join('\n');
}

// ── Register ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

registriereLinuxBaustein<SicherungEinrichtenParameter>(LINUX_SQL_SICHERUNG_BAUSTEINE.einrichten, sicherungEinrichtenSkript);
registriereLinuxBaustein<SicherungJetztParameter>(LINUX_SQL_SICHERUNG_BAUSTEINE.jetzt, sicherungJetztSkript);
registriereLinuxBaustein(LINUX_SQL_SICHERUNG_BAUSTEINE.liste, () => sicherungenSkript());
registriereLinuxBaustein<WiederherstellenParameter>(LINUX_SQL_SICHERUNG_BAUSTEINE.wiederherstellen, wiederherstellenSkript);
