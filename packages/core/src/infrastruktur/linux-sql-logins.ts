/**
 * I8e Folge-Etappe (Spec docs/specs/2026-11-22-i8e-alfred-logins-sa.md §7.3/§7.4) — Bausteine für Alfreds eigene SQL-Logins und `sa`:
 * - alfred_logins_anlegen: alfred_admin (sysadmin) und alfred_status (nur lesen) anlegen; Selbstprüfung mit Anmeldung als beide und
 *   Rechte-Nachweis (alfred_status: kein sysadmin, kein CONTROL SERVER/ALTER ANY LOGIN, kein Schreiben in msdb; Lesen belegt).
 * - alfred_logins_entfernen: Rückweg, nur als sa und nur ohne Host-Marke (sa aktiv).
 * - sa_schalten: sa ab-/einschalten, nur als alfred_admin mit sysadmin-Beleg im selben Lauf; Host-Marke SA_SPERRE setzen/entfernen.
 * - sa_kennwort_setzen: Notfallweg — Knoten im Pacemaker-Standby, Dienst stoppen, mssql-conf set-sa-password mit dem vorhandenen
 *   Tresor-Kennwort (nur Prozessumgebung), starten, Anmeldung als sa belegen.
 * Kennwörter nur als JSON in der ersten stdin-Zeile, nur in SQLCMDPASSWORD bzw. MSSQL_SA_PASSWORD des einen Prozesses.
 */
import { registriereLinuxBaustein } from '../fernzugriff/linux-bausteine.js';
import { LINUX_SQL_BAUSTEINE, SQL_HILFE, SA_LESEN, sqlKopf, shQ } from './linux-sql.js';

/** Rechte von alfred_status über public hinaus (Zuordnung zu den Status-Abfragen: Test „jede Status-Abfrage hat ein Recht“) */
export const ALFRED_STATUS_RECHTE = ['VIEW SERVER STATE', 'VIEW ANY DEFINITION', 'SELECT ON msdb.dbo.backupset'] as const;
/** Inhalt der Host-Marke SA_SPERRE (Eigentumsnachweis: nur diese Marke entfernt sa_schalten an=true) */
export const SA_MARKE_TEXT = 'ALFRED-SA-AUS (linux_sql sa_schalten)';

const kennwortLesen = (feld: string, v: string, was: string) => [
  `${v}=$(feld ${feld}) || abbruch "${was} enthält nicht druckbare Zeichen"`,
  `[ -n "$${v}" ] || abbruch "${was} fehlt in der Eingabe (JSON-Feld ${feld})"`,
  `[[ "$${v}" =~ ^[[:print:]]+$ ]] || abbruch "${was} enthält nicht druckbare Zeichen"`,
];

// ── alfred_logins_anlegen ──────────────────────────────────────────────────────────────────────────────────────────────────────

function loginTeil(n: 'alfred_admin' | 'alfred_status', ph: string, z: string, nurNeu: boolean): string[] {
  return [
    `IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'${n}' AND type <> 'S') THROW 50002, N'${n} ist kein SQL-Login', 1;`,
    ...(nurNeu ? [`IF EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = N'${n}') THROW 50006, N'Login ${n} besteht schon, Kennwort nicht im Tresor - nichts geändert; bitte bewusst entscheiden', 1;`] : []),
    `IF EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = N'${n}') AND PWDCOMPARE(N'${ph}', (SELECT password_hash FROM sys.sql_logins WHERE name = N'${n}')) = 0`,
    `  THROW 50005, N'Login ${n} besteht mit anderem Kennwort - nicht still zurückgesetzt; bitte bewusst entscheiden', 1;`,
    `IF NOT EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = N'${n}')`,
    `BEGIN CREATE LOGIN [${n}] WITH PASSWORD = N'${ph}', CHECK_POLICY = ON, CHECK_EXPIRATION = OFF, DEFAULT_DATABASE = [master]; SET ${z} = N'angelegt'; END`,
    `IF (SELECT is_disabled FROM sys.server_principals WHERE name = N'${n}') = 1 BEGIN ALTER LOGIN [${n}] ENABLE; IF ${z} = N'schon' SET ${z} = N'geaendert'; END`,
  ];
}

export function alfredLoginsVorlage(nurNeu: boolean): string {
  return [
    'SET NOCOUNT ON; -- ALFRED-LOGINS-ANLEGEN',
    "DECLARE @za nvarchar(20) = N'schon', @zs nvarchar(20) = N'schon';",
    // alfred_status in keiner Serverrolle (außer public) — sonst nie still entfernt, Abbruch vor jeder Änderung
    "IF EXISTS (SELECT 1 FROM sys.server_role_members m JOIN sys.server_principals l ON l.principal_id = m.member_principal_id WHERE l.name = N'alfred_status')",
    "  THROW 50003, N'alfred_status ist Mitglied einer Serverrolle - nicht still entfernt; bitte bewusst entscheiden', 1;",
    ...loginTeil('alfred_admin', '@@KA@@', '@za', nurNeu),
    "IF ISNULL(IS_SRVROLEMEMBER(N'sysadmin', N'alfred_admin'), 0) <> 1 BEGIN ALTER SERVER ROLE [sysadmin] ADD MEMBER [alfred_admin]; IF @za = N'schon' SET @za = N'geaendert'; END",
    ...loginTeil('alfred_status', '@@KS@@', '@zs', nurNeu),
    'GRANT VIEW SERVER STATE TO [alfred_status];',
    'GRANT VIEW ANY DEFINITION TO [alfred_status];',
    "EXEC (N'USE [msdb]; IF USER_ID(N''alfred_status'') IS NULL CREATE USER [alfred_status] FOR LOGIN [alfred_status]; GRANT SELECT ON dbo.backupset TO [alfred_status];');",
    // kein Serverrecht über den Rechtesatz hinaus (CONNECT SQL kommt mit CREATE LOGIN)
    "IF EXISTS (SELECT 1 FROM sys.server_permissions p JOIN sys.server_principals l ON l.principal_id = p.grantee_principal_id WHERE l.name = N'alfred_status' AND p.permission_name NOT IN (N'CONNECT SQL', N'VIEW SERVER STATE', N'VIEW ANY DEFINITION'))",
    "  THROW 50007, N'alfred_status hat zusätzliche Serverrechte - nicht still entfernt; bitte bewusst entscheiden', 1;",
    "SELECT N'ALFRED|' + @za + N'|' + @zs;",
  ].join('\n');
}
/** als alfred_admin: sysadmin? */
const PRUEF_ADMIN = "SET NOCOUNT ON; -- ALFRED-PRUEF-ADMIN\nSELECT N'ALFRED|' + CAST(ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0) AS nvarchar(1));";
/** als alfred_status: sysadmin | CONTROL SERVER | ALTER ANY LOGIN | INSERT backupset | VIEW SERVER STATE | SELECT backupset — Soll 0|0|0|0|1|1 */
const PRUEF_STATUS = [
  'SET NOCOUNT ON; -- ALFRED-PRUEF-STATUS',
  "SELECT N'ALFRED|' + CAST(ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0) AS nvarchar(1))",
  "  + N'|' + CAST(ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, N'CONTROL SERVER'), 0) AS nvarchar(1))",
  "  + N'|' + CAST(ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, N'ALTER ANY LOGIN'), 0) AS nvarchar(1))",
  "  + N'|' + CAST(ISNULL(HAS_PERMS_BY_NAME(N'msdb.dbo.backupset', N'OBJECT', N'INSERT'), 0) AS nvarchar(1))",
  "  + N'|' + CAST(ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW SERVER STATE'), 0) AS nvarchar(1))",
  "  + N'|' + CAST(ISNULL(HAS_PERMS_BY_NAME(N'msdb.dbo.backupset', N'OBJECT', N'SELECT'), 0) AS nvarchar(1));",
].join('\n');
export const STATUS_RECHTE_SOLL = '0|0|0|0|1|1';

export function alfredLoginsAnlegenSkript(p: { nurNeu?: boolean }): string {
  const nurNeu = p.nurNeu === true;
  return [
    ...sqlKopf(LINUX_SQL_BAUSTEINE.alfredLoginsAnlegen, { nurNeu }),
    ...SQL_HILFE,
    ...SA_LESEN,
    ...kennwortLesen('admin', 'KA', 'Kennwort alfred_admin'),
    ...kennwortLesen('status', 'KS', 'Kennwort alfred_status'),
    "Q1=\"'\"",
    'KA_SQL=${KA//"$Q1"/"$Q1$Q1"}',
    'KS_SQL=${KS//"$Q1"/"$Q1$Q1"}',
    `VORLAGE=${shQ(alfredLoginsVorlage(nurNeu))}`,
    'TSQL=${VORLAGE//@@KA@@/"$KA_SQL"}',
    'TSQL=${TSQL//@@KS@@/"$KS_SQL"}',
    'bereit || abbruch "SQL Server antwortet nicht als $SQL_LOGIN"',
    'aus=$(sql "$TSQL" 2>&1) || { unset TSQL; abbruch "Alfred-Logins: $(kurz "$aus")"; }',
    'unset TSQL',
    'IFS="|" read -r _ ZA ZS <<<"$(alfred_zeile "$aus")"',
    '[ -n "$ZA" ] && [ -n "$ZS" ] || abbruch "Alfred-Logins: keine Ergebniszeile"',
    // Marke für den Skill: ab hier gelten die Kennwörter (auch wenn die Selbstprüfung scheitert → trotzdem in den Tresor)
    "printf 'ALFRED-LOGIN-GESETZT\\n'",
    `PRUEF_ADMIN=${shQ(PRUEF_ADMIN)}`,
    `PRUEF_STATUS=${shQ(PRUEF_STATUS)}`,
    'a=$(SA="$KA"; SQL_LOGIN=alfred_admin; sql "$PRUEF_ADMIN" 2>&1) || abbruch "Anmeldung als alfred_admin fehlgeschlagen: $(sql_fehlerzeile "$a")"',
    '[ "$(alfred_zeile "$a")" = "ALFRED|1" ] || abbruch "alfred_admin ist nicht sysadmin ($(alfred_zeile "$a"))"',
    's=$(SA="$KS"; SQL_LOGIN=alfred_status; sql "$PRUEF_STATUS" 2>&1) || abbruch "Anmeldung als alfred_status fehlgeschlagen: $(sql_fehlerzeile "$s")"',
    `[ "$(alfred_zeile "$s")" = "ALFRED|${STATUS_RECHTE_SOLL}" ] || abbruch "alfred_status: Rechte weichen ab ($(alfred_zeile "$s"), Soll ${STATUS_RECHTE_SOLL}: sysadmin|CONTROL SERVER|ALTER ANY LOGIN|INSERT backupset|VIEW SERVER STATE|SELECT backupset)"`,
    'Z=schon; { [ "$ZA" = schon ] && [ "$ZS" = schon ]; } || Z=angelegt',
    '{ [ "$ZA" = angelegt ] || [ "$ZS" = angelegt ]; } || [ "$Z" = schon ] || Z=geaendert',
    'ergebnis "{\\"zustand\\":\\"$Z\\",\\"admin\\":\\"$ZA\\",\\"status\\":\\"$ZS\\"}"',
  ].join('\n');
}

// ── alfred_logins_entfernen (Rückweg) ──────────────────────────────────────────────────────────────────────────────────────────

export function alfredLoginsEntfernenSkript(): string {
  const tsql = [
    'SET NOCOUNT ON; -- ALFRED-LOGINS-ENTFERNEN',
    "IF (SELECT is_disabled FROM sys.server_principals WHERE name = N'sa') <> 0 THROW 50010, N'sa ist abgeschaltet - zuerst sa_schalten an=true', 1;",
    "EXEC (N'USE [msdb]; IF USER_ID(N''alfred_status'') IS NOT NULL DROP USER [alfred_status];');",
    "IF EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = N'alfred_status') DROP LOGIN [alfred_status];",
    "IF EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = N'alfred_admin') DROP LOGIN [alfred_admin];",
    "SELECT N'ALFRED|' + CAST((SELECT COUNT(*) FROM sys.server_principals WHERE name IN (N'alfred_admin', N'alfred_status')) AS nvarchar(5));",
  ].join('\n');
  return [
    ...sqlKopf(LINUX_SQL_BAUSTEINE.alfredLoginsEntfernen, {}),
    ...SQL_HILFE,
    ...SA_LESEN,
    // nur als sa (login_lesen sperrt sa bei gesetzter Host-Marke → sa ist dann abgeschaltet, Rückweg erst nach sa_schalten an=true)
    '[ "$SQL_LOGIN" = sa ] || abbruch "alfred_logins_entfernen nur als sa — nichts geändert"',
    'bereit || abbruch "SQL Server antwortet nicht als sa — nichts geändert"',
    `TSQL=${shQ(tsql)}`,
    'aus=$(sql "$TSQL" 2>&1) || abbruch "Alfred-Logins entfernen: $(kurz "$aus")"',
    '[ "$(alfred_zeile "$aus")" = "ALFRED|0" ] || abbruch "Alfred-Logins nach dem Entfernen noch vorhanden ($(alfred_zeile "$aus"))"',
    'ergebnis "{\\"zustand\\":\\"geaendert\\"}"',
  ].join('\n');
}

// ── sa_schalten ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const SA_PRUEF = "SET NOCOUNT ON; -- ALFRED-SA-PRUEF\nSELECT N'ALFRED|' + CAST(ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0) AS nvarchar(1)) + N'|' + CAST((SELECT is_disabled FROM sys.server_principals WHERE name = N'sa') AS nvarchar(1));";

export function pruefeSaSchalten(p: { an?: unknown }): string | undefined {
  return typeof p.an === 'boolean' ? undefined : 'an: true oder false (sa einschalten bzw. abschalten)';
}

export function saSchaltenSkript(p: { an: boolean }): string {
  const f = pruefeSaSchalten(p); if (f) throw new Error(f);
  return [
    ...sqlKopf(LINUX_SQL_BAUSTEINE.saSchalten, { an: p.an }),
    ...SQL_HILFE,
    `SA_MARKE_TEXT=${shQ(SA_MARKE_TEXT)}`,
    `SA_PRUEF=${shQ(SA_PRUEF)}`,
    ...SA_LESEN,
    '[ "$SQL_LOGIN" = alfred_admin ] || abbruch "sa_schalten nur als alfred_admin — zuerst alfred_logins_anlegen; nichts geändert"',
    'bereit || abbruch "SQL Server antwortet nicht als alfred_admin — nichts geändert"',
    'lage() { local a; a=$(sql "$SA_PRUEF" 2>&1) || abbruch "sa-Lage nicht lesbar: $(kurz "$a")"; IFS="|" read -r _ SYS DIS <<<"$(alfred_zeile "$a")"; }',
    'lage',
    '[ "$SYS" = 1 ] || abbruch "alfred_admin ist nicht sysadmin — sa bleibt unverändert"',
    '[ "$DIS" = 0 ] || [ "$DIS" = 1 ] || abbruch "sa-Lage unbekannt ($DIS) — nichts geändert"',
    'Z=schon',
    ...(p.an ? [
      // Einschalten: fremde Marke nie entfernen
      'if [ -e "$SA_SPERRE" ] && [ "$(cat "$SA_SPERRE" 2>/dev/null)" != "$SA_MARKE_TEXT" ]; then abbruch "Marke $SA_SPERRE stammt nicht von Alfred — nichts geändert"; fi',
      'if [ "$DIS" = 1 ]; then a=$(sql "ALTER LOGIN [sa] ENABLE;" 2>&1) || abbruch "sa einschalten fehlgeschlagen: $(kurz "$a")"; Z=geaendert; fi',
      'if [ -e "$SA_SPERRE" ]; then rm -f -- "$SA_SPERRE"; Z=geaendert; fi',
      'lage',
      '[ "$DIS" = 0 ] || abbruch "sa ist nach ENABLE nicht aktiv"',
      '[ ! -e "$SA_SPERRE" ] || abbruch "Marke $SA_SPERRE noch vorhanden"',
      'ergebnis "{\\"zustand\\":\\"$Z\\",\\"sa\\":\\"aktiv\\"}"',
    ] : [
      'if [ "$DIS" = 0 ]; then a=$(sql "ALTER LOGIN [sa] DISABLE;" 2>&1) || abbruch "sa abschalten fehlgeschlagen: $(kurz "$a")"; Z=geaendert; fi',
      'if [ "$(cat "$SA_SPERRE" 2>/dev/null)" != "$SA_MARKE_TEXT" ]; then',
      '  mkdir -p -- "$(dirname "$SA_SPERRE")"; printf "%s\\n" "$SA_MARKE_TEXT" >"$SA_SPERRE.neu"; chmod 0644 "$SA_SPERRE.neu"; mv -f -- "$SA_SPERRE.neu" "$SA_SPERRE"; Z=geaendert',
      'fi',
      'lage',
      '[ "$DIS" = 1 ] || abbruch "sa ist nach DISABLE nicht abgeschaltet"',
      '[ "$(cat "$SA_SPERRE" 2>/dev/null)" = "$SA_MARKE_TEXT" ] || abbruch "Marke $SA_SPERRE nicht geschrieben"',
      'ergebnis "{\\"zustand\\":\\"$Z\\",\\"sa\\":\\"aus\\"}"',
    ]),
  ].join('\n');
}

// ── sa_kennwort_setzen (Notfallweg) ────────────────────────────────────────────────────────────────────────────────────────────

const PY_STANDBY = [
  'import sys, xml.etree.ElementTree as ET',
  'try:',
  '    r = ET.fromstring(sys.stdin.read())',
  'except Exception:',
  '    print("unlesbar"); sys.exit(0)',
  'for n in r.iter("node"):',
  '    if n.get("name") == sys.argv[1]:',
  '        print("standby" if n.get("standby") == "true" else "aktiv"); sys.exit(0)',
  'print("unbekannt")',
].join('\n');

/** sa abgeschaltet? (0/1) — Prüfung des Notfallwegs als sa */
const SA_LAGE = "SET NOCOUNT ON; -- ALFRED-SA-PRUEF\nSELECT N'ALFRED|' + CAST(is_disabled AS nvarchar(1)) FROM sys.server_principals WHERE name = N'sa';";

export function saKennwortSetzenSkript(): string {
  return [
    ...sqlKopf(LINUX_SQL_BAUSTEINE.saKennwortSetzen, {}),
    ...SQL_HILFE,
    "MSSQL_CONF_BIN='/opt/mssql/bin/mssql-conf'",
    `PY_STANDBY=${shQ(PY_STANDBY)}`,
    '# ALFRED-ABLAUF',
    ...kennwortLesen('sa', 'SA', 'sa-Kennwort'),
    'K=$(hostname -s)',
    'x=$(crm_mon -1 --output-as=xml 2>/dev/null) || abbruch "crm_mon nicht lesbar — Standby von $K nicht belegt; nichts geändert"',
    'st=$(python3 -c "$PY_STANDBY" "$K" <<<"$x")',
    '[ "$st" = standby ] || abbruch "Knoten $K nicht im Standby ($st) — zuerst linux_ha knoten_standby an=true; nichts geändert"',
    'systemctl stop mssql-server || abbruch "mssql-server lässt sich nicht stoppen — nichts geändert"',
    'ALFRED_TMP=$(mktemp -d /run/alfred-sql.XXXXXX 2>/dev/null || mktemp -d)',
    'if ! MSSQL_SA_PASSWORD="$SA" "$MSSQL_CONF_BIN" -n set-sa-password >"$ALFRED_TMP/conf.log" 2>&1; then',
    '  systemctl start mssql-server || true',
    '  abbruch "mssql-conf set-sa-password fehlgeschlagen: $(kurz "$(cat "$ALFRED_TMP/conf.log")") — Dienst wieder gestartet"',
    'fi',
    'systemctl start mssql-server || abbruch "mssql-server startet nicht nach set-sa-password"',
    // Prüfung des Notfallwegs: Anmeldung bewusst als sa, auch bei gesetzter Host-Marke (im Ergebnis vermerkt)
    'SQL_LOGIN=sa',
    'bereit || abbruch "Anmeldung als sa nach set-sa-password gescheitert (120 s) — sa ist weiter nicht nutzbar (abgeschaltet?)"',
    `SA_LAGE=${shQ(SA_LAGE)}`,
    'a=$(sql "$SA_LAGE" 2>&1) || abbruch "sa-Lage nicht lesbar: $(kurz "$a")"',
    'IFS="|" read -r _ D <<<"$(alfred_zeile "$a")"',
    '[ "$D" = 0 ] || [ "$D" = 1 ] || abbruch "sa-Lage unbekannt ($D)"',
    'AB=false; [ "$D" = 1 ] && AB=true',
    'M=false; [ -e "$SA_SPERRE" ] && M=true',
    'ergebnis "{\\"zustand\\":\\"geaendert\\",\\"saAbgeschaltet\\":$AB,\\"marke\\":$M}"',
  ].join('\n');
}

registriereLinuxBaustein<{ nurNeu?: boolean }>(LINUX_SQL_BAUSTEINE.alfredLoginsAnlegen, alfredLoginsAnlegenSkript);
registriereLinuxBaustein(LINUX_SQL_BAUSTEINE.alfredLoginsEntfernen, () => alfredLoginsEntfernenSkript());
registriereLinuxBaustein<{ an: boolean }>(LINUX_SQL_BAUSTEINE.saSchalten, saSchaltenSkript);
registriereLinuxBaustein(LINUX_SQL_BAUSTEINE.saKennwortSetzen, () => saKennwortSetzenSkript());
