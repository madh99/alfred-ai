import { describe, it, expect } from 'vitest';
import {
  SICHERUNGEN_JSON, JOBS_JSON, JOBS_VORSPANN, SICHERUNG_LAGE_TSQL, alterWort, jobMeldungKurz, sicherungsLageText, sicherungsLageLesen,
} from './sql-sicherung-lage.js';
import { STATUS_TSQL } from './linux-sql.js';
import { sqlStatusSkript, sqlStatusText } from './sql-server.js';
import { linuxSqlStatusText } from './linux-sql-skill.js';
import { SICHERUNG_PROZEDUR } from './linux-sql-sicherung.js';

// Owner 24.11. — Sicherungslage (letzte Sicherungen, Jobverlauf) für Linux und Windows
describe('Sicherungslage: T-SQL', () => {
  it('liest nur: backupset, sysjobs, sysjobhistory, sys.databases — kein Schreiben', () => {
    const t = SICHERUNG_LAGE_TSQL;
    for (const o of ['msdb.dbo.backupset', 'msdb.dbo.sysjobs', 'msdb.dbo.sysjobhistory']) expect(t).toContain(o);
    expect(t).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|GRANT|BACKUP|sp_start_job)\b/i);
  });

  it('Jobverlauf nur mit Recht (dynamisch) — ohne Recht kein Verweis, der den Status bricht', () => {
    expect(JOBS_VORSPANN).toMatch(/HAS_PERMS_BY_NAME\(N'msdb\.dbo\.sysjobs'/);
    expect(JOBS_VORSPANN).toMatch(/HAS_PERMS_BY_NAME\(N'msdb\.dbo\.sysjobhistory'/);
    expect(JOBS_VORSPANN).toContain('IF @jobsLesbar = 1 EXEC sp_executesql');
    // im dynamischen Text sind die Anführungszeichen verdoppelt
    expect(JOBS_VORSPANN).toContain("NCHAR(13), N'' ''");
    // außerhalb des dynamischen Teils kein Verweis auf den Jobverlauf
    const statisch = STATUS_TSQL.replace(/EXEC sp_executesql N'(?:[^']|'')*'/, '');
    expect(statisch).not.toContain('FROM msdb.dbo.sysjobhistory');
    expect(STATUS_TSQL).toContain('FROM msdb.dbo.sysjobhistory');
  });

  it('Linux-Status trägt Sicherungen und Jobs; Windows-Abfrage liefert eine Spalte j', () => {
    expect(STATUS_TSQL).toContain(`${SICHERUNGEN_JSON} AS sicherungen, JSON_QUERY(@jobs) AS jobs, @jobsLesbar AS jobsLesbar`);
    expect(SICHERUNG_LAGE_TSQL).toMatch(/AS j;$/);
    expect(JOBS_JSON).toContain('TOP (3)');
  });

  it('Windows-Status ruft die Lage in eigenem try (Fehler bricht den Status nicht)', () => {
    const s = sqlStatusSkript();
    expect(s).toContain('try { $r.sicherungsLage = [string](Sql "');
    expect(s).toContain('$r.sicherungsLageFehler = $_.Exception.Message');
    // PowerShell: $ im T-SQL maskiert (keine Variablen-Einsetzung)
    expect(s).not.toMatch(/Sql "[^"]*[^`]\$jobs/);
  });

  it('Linux-Prozedur meldet ihre Zeilen per PRINT mit Vorsatz (Jobverlauf), nie mit ALFRED| am Zeilenanfang', () => {
    expect(SICHERUNG_PROZEDUR).toContain("PRINT N'Alfred-Sicherung: ' + LEFT(@aus, 3800);");
    expect(SICHERUNG_PROZEDUR.indexOf('SELECT zeile FROM @r;')).toBeLessThan(SICHERUNG_PROZEDUR.indexOf('PRINT N'));
  });
});

describe('Sicherungslage: Text', () => {
  it('alterWort', () => {
    expect(alterWort(12)).toBe('vor 12 min');
    expect(alterWort(300)).toBe('vor 5 h');
    expect(alterWort(87 * 60)).toBe('vor 4 d');
    expect(alterWort(null)).toBe('?');
    expect(alterWort(-10)).toBe('in der Zukunft (Uhrzeit prüfen)');
  });

  it('Jobmeldung: Alfreds Zeilen haben Vorrang, fremder Erfolgstext erscheint nicht, Fehlertext gekürzt', () => {
    const m = 'Executed as user: NT SERVICE\\SQLAgent. Alfred-Sicherung: ALFRED-ERZWUNGEN|pruefdb01|FULL statt LOG: Protokollkette auf diesem Rechner unterbrochen (Rollenwechsel) ; ALFRED|/var/opt/mssql/backup/alfred/pruefdb01/pruefdb01_FULL_20261124070501.bak [SQLSTATE 01000] (Message 0).  The step succeeded.';
    expect(jobMeldungKurz({ status: 1, meldung: m })).toBe('ALFRED-ERZWUNGEN|pruefdb01|FULL statt LOG: Protokollkette auf diesem Rechner unterbrochen (Rollenwechsel); ALFRED|/var/opt/mssql/backup/alfred/pruefdb01/pruefdb01_FULL_20261124070501.bak');
    expect(jobMeldungKurz({ status: 1, meldung: 'Executed as user: X. irgendwas Fremdes. The step succeeded.' })).toBe('');
    expect(jobMeldungKurz({ status: 0, meldung: 'Executed as user: X. Sicherung LOG fehlgeschlagen: pruefdb01: Platte voll' })).toBe('Sicherung LOG fehlgeschlagen: pruefdb01: Platte voll');
  });

  it('v1953 — Realfall 25.11.: VSS-Snapshot getrennt von der FULL-Datei (je Datenbank, Art und is_snapshot), copy-only weiter ausgeschlossen', () => {
    expect(SICHERUNGEN_JSON).toContain('CAST(b.is_snapshot AS int) AS snapshot');
    expect(SICHERUNGEN_JSON).toContain('GROUP BY x.database_name, x.type, x.is_snapshot)');
    expect(SICHERUNGEN_JSON).toContain('x.is_copy_only = 0');
    const t = sicherungsLageText({ sicherungen: [
      { db: 'i8d_ag01', typ: 'FULL', alterMin: 400, server: 'sql02', snapshot: 0 },
      { db: 'i8d_ag01', typ: 'FULL', alterMin: 190, server: 'sql02', snapshot: 1 },
    ], jobsLesbar: 1, jobs: [] });
    expect(t).toBe('letzte Sicherungen i8d_ag01: FULL vor 7 h (sql02), FULL vor 3 h (sql02, Snapshot); Agent-Jobs: keine');
    expect(sicherungsLageText({ sicherungen: [{ db: 'd', typ: 'FULL', alterMin: 5, snapshot: 1 }], jobsLesbar: 1, jobs: [] })).toContain('FULL vor 5 min (Snapshot)');
  });

  it('Gesamttext: Sicherungen je Datenbank mit Server, Jobs mit letztem Lauf', () => {
    const t = sicherungsLageText({
      sicherungen: [
        { db: 'pruefdb01', typ: 'FULL', alterMin: 58, server: 'sqllnx02' },
        { db: 'pruefdb01', typ: 'LOG', alterMin: 3, server: 'sqllnx02' },
      ],
      jobsLesbar: 1,
      jobs: [
        { name: 'alfred-sqllnx-log', aktiv: 1, laeufe: [{ alterMin: 3, status: 1, meldung: 'Alfred-Sicherung: ALFRED|/x/pruefdb01_LOG_1_2.trn [SQLSTATE 01000]' }] },
        { name: 'alfred-sqllnx-diff', aktiv: 0, laeufe: null },
      ],
    });
    expect(t).toBe('letzte Sicherungen pruefdb01: FULL vor 58 min (sqllnx02), LOG vor 3 min (sqllnx02); Agent-Jobs alfred-sqllnx-log: vor 3 min ok — ALFRED|/x/pruefdb01_LOG_1_2.trn; alfred-sqllnx-diff (aus): noch kein Lauf');
  });

  it('ohne Leserecht: Hinweis statt Fehler; ohne Sicherungen: „keine in msdb“', () => {
    const t = sicherungsLageText({ sicherungen: null, jobs: null, jobsLesbar: 0 });
    expect(t).toBe('letzte Sicherungen: keine in msdb; Jobverlauf nicht lesbar (Leserecht auf msdb-Jobs fehlt — bei Linux alfred_logins_anlegen erneut per Change)');
    expect(sicherungsLageText(null)).toBe('');
  });

  it('Lesen: gültiges JSON → Objekt, sonst null', () => {
    expect(sicherungsLageLesen('{"jobsLesbar":1,"jobs":[]}')).toEqual({ jobsLesbar: 1, jobs: [] });
    expect(sicherungsLageLesen('kaputt')).toBeNull();
    expect(sicherungsLageLesen(undefined)).toBeNull();
  });

  it('Windows-Statustext hängt die Lage an bzw. meldet den Fehler', () => {
    const basis = { rechner: 'SQL01', installiert: true, version: '17.0', stufe: 'RTM', edition: 'Developer', hadr: false, datenbanken: [] };
    expect(sqlStatusText({ ...basis, sicherungsLage: '{"sicherungen":[{"db":"d1","typ":"FULL","alterMin":30,"server":"SQL01"}],"jobsLesbar":1,"jobs":[]}' }))
      .toContain('letzte Sicherungen d1: FULL vor 30 min (SQL01); Agent-Jobs: keine');
    expect(sqlStatusText({ ...basis, sicherungsLageFehler: 'Timeout' })).toContain('Sicherungslage nicht lesbar: Timeout');
  });

  it('Linux-Statustext hängt die Lage hinter Logins/Agent an, nur wenn die SQL-Sicht sie liefert', () => {
    const s = {
      zustand: 'gelesen', installiert: true, dienst: 'active', aktiviert: 'enabled', konfig: { sqlagent: 'true' }, agent: { laeuft: true },
      sql: { version: '17.0', saAbgeschaltet: 1, alfredLogins: [{ name: 'alfred_status' }], sicherungen: [{ db: 'p', typ: 'FULL' as const, alterMin: 5, server: 's' }], jobsLesbar: 0, jobs: null },
    };
    expect(linuxSqlStatusText('sqllnx02', s)).toMatch(/Agent läuft; letzte Sicherungen p: FULL vor 5 min \(s\); Jobverlauf nicht lesbar/);
    const ohne = { ...s, sql: { version: '17.0', saAbgeschaltet: 1, alfredLogins: [] } };
    expect(linuxSqlStatusText('sqllnx02', ohne)).not.toContain('letzte Sicherungen');
  });
});
