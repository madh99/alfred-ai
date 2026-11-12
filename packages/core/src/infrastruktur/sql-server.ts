/**
 * I8d (Architektur 3ca3873e v3) — SQL Server auf Windows über feste Bausteine: Medien laden und prüfen, Installation (gMSA, getrennte
 * Platten, TempDB, IFI), Konfiguration, HADR, Endpunkte, Verfügbarkeitsgruppe mit Listener, geplanter Failover (nie FORCE_ALLOW_DATA_LOSS),
 * Prüfdaten, Sicherungen und Sicherungsjobs, Wiederherstellungstest mit DBCC CHECKDB.
 *
 * T-SQL läuft lokal über System.Data.SqlClient (Shared Memory „lpc:.“) mit dem Token des Fernzugangs; Alfreds lokales Konto ist bei der
 * Installation Sysadmin. Sicherungen und Wiederherstellungen schreibt/liest der Datenbankdienst selbst (gMSA) — kein Doppel-Hop. Die
 * Installation läuft als Domänenkonto mit Kennwort-Anmeldung (Architektur: „Setup mit geprüftem PASSWORD-Logon-Task“).
 * Bezeichner werden geprüft und in [] gesetzt, Werte als N'…' mit verdoppelten Anführungszeichen.
 */
import { IPV4, kopf, psText, neustart } from './windows-ad.js';
import { alsDomaenenkonto, KONTO } from './windows-cluster.js';

export const BEZEICHNER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SERVER = /^[A-Za-z0-9][A-Za-z0-9-]{0,14}$/;
/** v1789 — benannte Instanz (Standardinstanz MSSQLSERVER) */
export const INSTANZ = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;
/** Replikat-Servername: SQL01 oder SQL01\\INSTANZ */
const REPLIKAT = /^[A-Za-z0-9][A-Za-z0-9-]{0,14}(\\[A-Za-z][A-Za-z0-9_]{0,15})?$/;
const FQDN = /^(?=.{3,120}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;
const LOKAL_PFAD = /^[BD-Z]:\\[A-Za-z0-9 ._\\-]{1,150}$/;
const UNC = /^\\\\[A-Za-z0-9.-]{1,120}\\[A-Za-z0-9_$-]{1,40}(\\[A-Za-z0-9 ._-]{1,60}){0,3}$/;
/** Medien nur von Microsoft */
const MEDIEN_URL = /^https:\/\/(go\.microsoft\.com|download\.microsoft\.com|aka\.ms|catalog\.s\.download\.windowsupdate\.com)\/[A-Za-z0-9/._?=&%-]{1,400}$/;

/** T-SQL-Literal N'…' */
export const nText = (s: string) => `N'${s.replace(/'/g, "''")}'`;
const pfadOk = (p: string) => (LOKAL_PFAD.test(p) || UNC.test(p)) && !p.includes('..');

/** PowerShell-Funktion Sql: führt T-SQL lokal aus und liefert alle Zeilen aller Ergebnismengen */
export const SQL_FN = [
  "function Sql([string]$q, [int]$t = 120, [string]$db = 'master') {",
  "  $cn = New-Object System.Data.SqlClient.SqlConnection ('Server=' + $srv + ';Database=' + $db + ';Integrated Security=SSPI;Application Name=Alfred;Connect Timeout=30;Pooling=false')",
  '  $cn.Open()',
  '  try {',
  '    $cmd = $cn.CreateCommand(); $cmd.CommandText = $q; $cmd.CommandTimeout = $t',
  '    $rd = $cmd.ExecuteReader(); $rows = @()',
  '    do { while ($rd.Read()) { $o = [ordered]@{}; for ($i = 0; $i -lt $rd.FieldCount; $i++) { $o[$rd.GetName($i)] = $(if ($rd.IsDBNull($i)) { $null } else { $rd.GetValue($i) }) }; $rows += [pscustomobject]$o } } while ($rd.NextResult())',
  '    $rd.Close()',
  '    return $rows',
  '  } finally { $cn.Close() }',
  '}',
].join('\n');

/** für T-SQL in doppelten PowerShell-Anführungszeichen: ` " $ maskieren */
export const psDq = (s: string) => s.replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$');
/** v1789 — Instanz aus $p.instanz: Dienstnamen und lokale Verbindung (Standardinstanz oder benannte) */
export const INSTANZ_VOR = [
  "$inst = $(if ($p.instanz) { [string]$p.instanz } else { 'MSSQLSERVER' })",
  "$svc = $(if ($inst -eq 'MSSQLSERVER') { 'MSSQLSERVER' } else { 'MSSQL$' + $inst })",
  "$agt = $(if ($inst -eq 'MSSQLSERVER') { 'SQLSERVERAGENT' } else { 'SQLAgent$' + $inst })",
  "$srv = $(if ($inst -eq 'MSSQLSERVER') { 'lpc:.' } else { 'lpc:.\\' + $inst })",
];
const skript = (p: unknown, zeilen: string[], mitEingabe = false) => [...kopf(p, mitEingabe), ...INSTANZ_VOR, SQL_FN, ...zeilen].join('\n');
const nurInstanz = (instanz?: string) => (instanz ? { instanz } : {});

// ── Lesen ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SqlStatus {
  rechner: string; instanz?: string; installiert: boolean; version?: string; stufe?: string; cu?: string; edition?: string; hadr?: boolean;
  maxSpeicherMb?: number; maxdop?: number; kostenschwelle?: number; tempdbDateien?: number; ifi?: boolean;
  dienste?: Array<{ name: string; zustand: string; konto: string }>;
  datenbanken?: Array<{ name: string; zustand: string; modell: string; mb: number }>;
  ags?: Array<{ name: string; replikat: string; rolle: string; modus: string; failover: string; gesundheit: string; verbunden: string }>;
  agDbs?: Array<{ db: string; replikat: string; zustand: string }>;
  listener?: Array<{ name: string; port: number; ip: string }>;
  fehler?: string;
}

export function sqlStatusSkript(instanz?: string): string {
  return skript(nurInstanz(instanz), [
    '$r = [ordered]@{ rechner = $env:COMPUTERNAME; instanz = $inst; installiert = [bool](Get-Service -Name $svc -ErrorAction SilentlyContinue) }',
    'if ($r.installiert) {',
    '  try {',
    "    $s = (Sql \"SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(40)) v, CAST(SERVERPROPERTY('ProductLevel') AS nvarchar(40)) l, CAST(SERVERPROPERTY('ProductUpdateLevel') AS nvarchar(40)) u, CAST(SERVERPROPERTY('Edition') AS nvarchar(80)) e, CAST(SERVERPROPERTY('IsHadrEnabled') AS int) h\")[0]",
    '    $r.version = $s.v; $r.stufe = $s.l; $r.cu = $s.u; $r.edition = $s.e; $r.hadr = ($s.h -eq 1)',
    "    foreach ($c in (Sql \"SELECT name, CAST(value_in_use AS int) w FROM sys.configurations WHERE name IN ('max server memory (MB)', 'max degree of parallelism', 'cost threshold for parallelism')\")) { switch ($c.name) { 'max server memory (MB)' { $r.maxSpeicherMb = $c.w } 'max degree of parallelism' { $r.maxdop = $c.w } 'cost threshold for parallelism' { $r.kostenschwelle = $c.w } } }",
    "    $r.tempdbDateien = [int](Sql 'SELECT COUNT(*) n FROM tempdb.sys.database_files WHERE type = 0')[0].n",
    "    $d = @(Sql \"SELECT servicename n, status_desc z, service_account k, instant_file_initialization_enabled i FROM sys.dm_server_services\")",
    "    $r.dienste = @($d | ForEach-Object { [ordered]@{ name = [string]$_.n; zustand = [string]$_.z; konto = [string]$_.k } }); $r.ifi = [bool]@($d | Where-Object { $_.i -eq 'Y' }).Count",
    "    $r.datenbanken = @(Sql \"SELECT d.name n, d.state_desc z, d.recovery_model_desc m, CAST(SUM(f.size) * 8 / 1024 AS int) mb FROM sys.databases d JOIN sys.master_files f ON f.database_id = d.database_id WHERE d.database_id > 4 GROUP BY d.name, d.state_desc, d.recovery_model_desc ORDER BY d.name\" | ForEach-Object { [ordered]@{ name = [string]$_.n; zustand = [string]$_.z; modell = [string]$_.m; mb = [int]$_.mb } })",
    '    if ($r.hadr) {',
    "      $r.ags = @(Sql \"SELECT ag.name a, ar.replica_server_name r, ISNULL(rs.role_desc, '?') o, ar.availability_mode_desc m, ar.failover_mode_desc f, ISNULL(rs.synchronization_health_desc, '?') g, ISNULL(rs.connected_state_desc, '?') c FROM sys.availability_groups ag JOIN sys.availability_replicas ar ON ar.group_id = ag.group_id LEFT JOIN sys.dm_hadr_availability_replica_states rs ON rs.replica_id = ar.replica_id ORDER BY ag.name, ar.replica_server_name\" | ForEach-Object { [ordered]@{ name = [string]$_.a; replikat = [string]$_.r; rolle = [string]$_.o; modus = [string]$_.m; failover = [string]$_.f; gesundheit = [string]$_.g; verbunden = [string]$_.c } })",
    "      $r.agDbs = @(Sql \"SELECT DB_NAME(s.database_id) d, ar.replica_server_name r, s.synchronization_state_desc z FROM sys.dm_hadr_database_replica_states s JOIN sys.availability_replicas ar ON ar.replica_id = s.replica_id ORDER BY 1, 2\" | ForEach-Object { [ordered]@{ db = [string]$_.d; replikat = [string]$_.r; zustand = [string]$_.z } })",
    "      $r.listener = @(Sql \"SELECT l.dns_name n, l.port p, ISNULL(i.ip_address, '') i FROM sys.availability_group_listeners l LEFT JOIN sys.availability_group_listener_ip_addresses i ON i.listener_id = l.listener_id\" | ForEach-Object { [ordered]@{ name = [string]$_.n; port = [int]$_.p; ip = [string]$_.i } })",
    '    }',
    '  } catch { $r.fehler = $_.Exception.Message }',
    '}',
    'Ergebnis $r',
  ]);
}

export function sqlStatusText(s: SqlStatus): string {
  const rechner = s.instanz && s.instanz.toUpperCase() !== 'MSSQLSERVER' ? `${s.rechner}\\${s.instanz}` : s.rechner;
  if (!s.installiert) return `${rechner}: SQL Server nicht installiert`;
  if (s.fehler && !s.version) return `${rechner}: SQL Server installiert, Abfrage scheitert: ${s.fehler}`;
  const t: string[] = [`${rechner}: SQL Server ${s.version} (${s.stufe}${s.cu ? `-${s.cu}` : ''}) ${s.edition}`];
  t.push(`HADR ${s.hadr ? 'an' : 'aus'}; max Speicher ${s.maxSpeicherMb} MB, MAXDOP ${s.maxdop}, Kostenschwelle ${s.kostenschwelle}; TempDB ${s.tempdbDateien} Dateien; IFI ${s.ifi ? 'an' : 'aus'}`);
  if (s.dienste?.length) t.push(`Dienste ${s.dienste.map(d => `${d.name} ${d.zustand} (${d.konto})`).join(', ')}`);
  t.push(`Datenbanken ${s.datenbanken?.length ? s.datenbanken.map(d => `${d.name} ${d.zustand} ${d.modell} ${d.mb} MB`).join(', ') : 'keine'}`);
  if (s.ags?.length) {
    const namen = [...new Set(s.ags.map(a => a.name))];
    for (const n of namen) t.push(`AG ${n}: ${s.ags.filter(a => a.name === n).map(a => `${a.replikat} ${a.rolle} ${a.gesundheit} ${a.modus === 'SYNCHRONOUS_COMMIT' ? 'synchron' : 'asynchron'} ${a.failover === 'AUTOMATIC' ? 'automatisch' : 'manuell'}`).join(', ')}`);
  }
  if (s.agDbs?.length) t.push(`AG-Datenbanken ${s.agDbs.map(d => `${d.db}@${d.replikat} ${d.zustand}`).join(', ')}`);
  if (s.listener?.length) t.push(`Listener ${s.listener.map(l => `${l.name}:${l.port} ${l.ip}`).join(', ')}`);
  if (s.fehler) t.push(`Abfrage: ${s.fehler}`);
  return t.join('; ');
}

export function pruefdatenLesenSkript(p: { datenbank: string }): string {
  return skript(p, [
    "$x = (Sql \"IF OBJECT_ID(N'dbo.alfred_pruef') IS NULL SELECT CAST(0 AS int) n, CAST(NULL AS int) m, CAST(NULL AS sysname) s, CAST(NULL AS datetime2) z ELSE SELECT COUNT(*) n, MAX(id) m, (SELECT TOP 1 server FROM dbo.alfred_pruef ORDER BY id DESC) s, MAX(zeit) z FROM dbo.alfred_pruef\" 60 $p.datenbank)[0]",
    "Ergebnis @{ datenbank = $p.datenbank; zeilen = [int]$x.n; letzteId = $x.m; letzterServer = [string]$x.s; letzteZeit = $(if ($x.z) { $x.z.ToString('s') } else { '' }) }",
  ]);
}

// ── Medien und Installation ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export function pruefeMedien(o: Record<string, unknown>): { url: string; art: 'installation' | 'cu'; sha256?: string } | string {
  const url = String(o.url ?? '').trim(); const art = String(o.art ?? 'installation').trim(); const sha = String(o.sha256 ?? '').trim().toLowerCase();
  if (!MEDIEN_URL.test(url)) return 'url: Download von Microsoft (https://go.microsoft.com, download.microsoft.com, aka.ms oder Microsoft Update-Katalog)';
  if (art !== 'installation' && art !== 'cu') return 'art: installation (SSEI-Downloader oder ISO) oder cu (kumulatives Update)';
  if (sha && !/^[0-9a-f]{64}$/.test(sha)) return 'sha256: 64 Hex-Zeichen';
  return { url, art, ...(sha ? { sha256: sha } : {}) };
}

/**
 * Medien nach C:\SQLMedia laden: Microsoft-Signatur (Authenticode, „O=Microsoft Corporation“) und optional SHA-256 prüfen. Installation:
 * SSEI-Downloader holt das ISO (/ACTION=Download /MEDIATYPE=ISO), der ISO-Inhalt kommt nach C:\SQLMedia\setup (setup.exe ebenfalls
 * signaturgeprüft). CU: nach C:\SQLMedia\CU (Slipstream bei der Installation).
 */
export function medienSkript(p: { url: string; art: 'installation' | 'cu'; sha256?: string }): string {
  return skript(p, [
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    "$basis = 'C:\\SQLMedia'; $ziel = $(if ($p.art -eq 'cu') { Join-Path $basis 'CU' } else { Join-Path $basis 'download' })",
    'New-Item -ItemType Directory -Path $ziel -Force | Out-Null',
    "$datei = Join-Path $ziel ('alfred-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.bin')",
    'Invoke-WebRequest -UseBasicParsing -Uri $p.url -OutFile $datei',
    "$hash = (Get-FileHash -Path $datei -Algorithm SHA256).Hash.ToLower()",
    "if ($p.sha256 -and $hash -ne $p.sha256) { Remove-Item $datei -Force; throw ('SHA-256 stimmt nicht: ' + $hash) }",
    "function Signiert($f) { $s = Get-AuthenticodeSignature -FilePath $f; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw ('Signatur nicht gültig/nicht Microsoft: ' + $f + ' ' + $s.Status + ' ' + $s.SignerCertificate.Subject) }; [string]$s.SignerCertificate.Subject }",
    "$fs = [IO.File]::OpenRead($datei); $kopf = New-Object byte[] 2; [void]$fs.Read($kopf, 0, 2); $fs.Close()",
    "$istExe = ($kopf[0] -eq 0x4D -and $kopf[1] -eq 0x5A)",
    "$r = [ordered]@{ art = $p.art; sha256 = $hash; groesseMb = [math]::Round((Get-Item $datei).Length / 1MB, 1) }",
    "if ($istExe) { $exe = [IO.Path]::ChangeExtension($datei, '.exe'); Move-Item $datei $exe -Force; $datei = $exe; $r.signatur = Signiert $datei; $r.version = [string](Get-Item $datei).VersionInfo.ProductVersion; $r.produkt = [string](Get-Item $datei).VersionInfo.FileDescription }",
    "if ($p.art -eq 'cu') { if (-not $istExe) { throw 'CU ist keine signierte .exe' }; $r.datei = $datei; Ergebnis $r; exit 0 }",
    '$iso = $null',
    // v1795 — ein ISO aus einem früheren Lauf wiederverwenden (setup.exe wird unten ohnehin auf die Microsoft-Signatur geprüft)
    "if ($istExe) { $isoDir = Join-Path $basis 'iso'; New-Item -ItemType Directory -Path $isoDir -Force | Out-Null; $alt = @(Get-ChildItem $isoDir -Filter *.iso -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending); if ($alt.Count) { $iso = $alt[0]; $r.isoWiederverwendet = $true } else { $pr = Start-Process -FilePath $datei -ArgumentList @('/ACTION=Download', ('/MEDIAPATH=' + $isoDir), '/MEDIATYPE=ISO', '/QUIET', '/LANGUAGE=en-US') -Wait -PassThru; if ($pr.ExitCode -ne 0) { throw ('SSEI-Download Exit ' + $pr.ExitCode) }; $iso = @(Get-ChildItem $isoDir -Filter *.iso | Sort-Object LastWriteTime -Descending)[0] } }",
    "else { $iso = Get-Item ([IO.Path]::ChangeExtension($datei, '.iso')) -ErrorAction SilentlyContinue; if (-not $iso) { Move-Item $datei ([IO.Path]::ChangeExtension($datei, '.iso')) -Force; $iso = Get-Item ([IO.Path]::ChangeExtension($datei, '.iso')) } }",
    "if (-not $iso) { throw 'kein ISO nach dem Download' }",
    "$r.iso = $iso.Name; $r.isoSha256 = (Get-FileHash -Path $iso.FullName -Algorithm SHA256).Hash.ToLower()",
    '$m = Mount-DiskImage -ImagePath $iso.FullName -PassThru',
    'try {',
    "  $lw = [string]($m | Get-Volume).DriveLetter + ':\\'",
    "  $setup = Join-Path $basis 'setup'; if (Test-Path $setup) { Remove-Item $setup -Recurse -Force }",
    // v1795 — Realfall 11.11. E2 3857bbd0: ohne vorhandenen Zielordner legte Copy-Item die erste Datei als „setup“ an, danach
    // „Container cannot be copied onto existing leaf item“ (E:\\redist). Ordner zuerst anlegen.
    '  New-Item -ItemType Directory -Path $setup -Force | Out-Null',
    '  Copy-Item -Path ($lw + \'*\') -Destination $setup -Recurse -Force',
    '} finally { Dismount-DiskImage -ImagePath $iso.FullName | Out-Null }',
    "$se = Join-Path $setup 'setup.exe'",
    "$r.setupSignatur = Signiert $se; $r.setupVersion = [string](Get-Item $se).VersionInfo.ProductVersion",
    'Ergebnis $r',
  ]);
}

export interface Installation {
  instanz?: string; ausKonto?: string;
  engine_konto: string; agent_konto: string; sysadmins: string[]; daten: string; log: string; tempdb: string; sicherung: string;
  tempdb_dateien: number; tempdb_mb: number; tempdb_log_mb: number; max_speicher_mb: number; maxdop: number; pid?: string;
}

export function pruefeInstallation(o: Record<string, unknown>): Installation | string {
  const liste = (v: unknown) => (Array.isArray(v) ? v.map(x => String(x).trim()) : typeof v === 'string' ? v.split(',').map(s => s.trim()) : []).filter(Boolean);
  const n = (v: unknown, std: number) => (v === undefined || v === null || v === '' ? std : Number(v));
  const p: Installation = {
    engine_konto: String(o.engine_konto ?? '').trim(), agent_konto: String(o.agent_konto ?? '').trim(), sysadmins: liste(o.sysadmins),
    daten: String(o.daten ?? '').trim(), log: String(o.log ?? '').trim(), tempdb: String(o.tempdb ?? '').trim(), sicherung: String(o.sicherung ?? '').trim(),
    tempdb_dateien: n(o.tempdb_dateien, 4), tempdb_mb: n(o.tempdb_mb, 1024), tempdb_log_mb: n(o.tempdb_log_mb, 2048), max_speicher_mb: n(o.max_speicher_mb, 12288), maxdop: n(o.maxdop, 4),
    ...(o.pid ? { pid: String(o.pid).trim().toUpperCase() } : {}),
  };
  if (!KONTO.test(p.engine_konto) || !p.engine_konto.endsWith('$') || !KONTO.test(p.agent_konto) || !p.agent_konto.endsWith('$')) return 'engine_konto/agent_konto: gMSA im Format NETBIOS\\name$ (Architektur: keine Domänen-Admins als SQL-Dienste)';
  if (!p.sysadmins.length || p.sysadmins.length > 6 || p.sysadmins.some(k => !KONTO.test(k))) return 'sysadmins: 1–6 Konten NETBIOS\\name (z. B. AD3033\\alfred); Alfreds lokales Konto kommt automatisch dazu';
  for (const [k, v] of [['daten', p.daten], ['log', p.log], ['tempdb', p.tempdb], ['sicherung', p.sicherung]] as const) if (!LOKAL_PFAD.test(v) || v.includes('..')) return `${k}: Ordner auf einer Datenplatte (B oder D–Z), z. B. D:\\SQLData`;
  if (new Set([p.daten, p.log, p.tempdb].map(x => x[0])).size !== 3) return 'daten, log und tempdb auf getrennten Platten (Architektur v3)';
  if (!Number.isInteger(p.tempdb_dateien) || p.tempdb_dateien < 1 || p.tempdb_dateien > 8) return 'tempdb_dateien: 1–8 (je Kern, höchstens 8)';
  if (!Number.isInteger(p.tempdb_mb) || p.tempdb_mb < 8 || p.tempdb_mb > 262144 || !Number.isInteger(p.tempdb_log_mb) || p.tempdb_log_mb < 8 || p.tempdb_log_mb > 262144) return 'tempdb_mb/tempdb_log_mb: 8–262144';
  if (!Number.isInteger(p.max_speicher_mb) || p.max_speicher_mb < 1024 || !Number.isInteger(p.maxdop) || p.maxdop < 0 || p.maxdop > 64) return 'max_speicher_mb ≥ 1024, maxdop 0–64';
  if (p.pid && !/^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$/.test(p.pid)) return 'pid: Produktschlüssel XXXXX-XXXXX-XXXXX-XXXXX-XXXXX (Developer: ohne)';
  return p;
}

/**
 * Unbeaufsichtigte Installation (Datenbankmodul + Agent) aus C:\SQLMedia\setup als Domänenkonto mit Kennwort-Anmeldung: gMSA-Dienste,
 * IFI, getrennte Daten/Log/TempDB/Sicherung, TempDB-Dateien, max. Speicher, MAXDOP, nur TCP; CU aus C:\SQLMedia\CU per Slipstream.
 * Ergebnis aus Summary.txt; Exit 3010 → Neustart (der Skill wartet).
 */
export function installierenSkript(p: Installation): string {
  const rumpf = [
    "$setup = 'C:\\SQLMedia\\setup\\setup.exe'",
    "if (-not (Test-Path $setup)) { throw 'C:\\SQLMedia\\setup\\setup.exe fehlt — zuerst medien_laden' }",
    ...INSTANZ_VOR.slice(0, 2),
    "if (Get-Service -Name $svc -ErrorAction SilentlyContinue) { return [ordered]@{ zustand = 'schon'; code = 0; instanz = $inst } }",
    'foreach ($o in @($p.daten, $p.log, $p.tempdb, $p.sicherung)) { New-Item -ItemType Directory -Path $o -Force | Out-Null }',
    // Alfreds lokales Fernzugangskonto (Vorlagen-Fabrik) für die Verwaltung per Shared Memory — nur wenn es das Konto gibt
    "$admins = @($p.sysadmins) + @(if (Get-LocalUser -Name alfred -ErrorAction SilentlyContinue) { $env:COMPUTERNAME + '\\alfred' }) | Select-Object -Unique",
    "$cu = 'C:\\SQLMedia\\CU'; $mitCu = (Test-Path $cu) -and @(Get-ChildItem $cu -Filter *.exe).Count",
    "$a = @('/Q', '/ACTION=Install', '/IACCEPTSQLSERVERLICENSETERMS', '/FEATURES=SQLENGINE', ('/INSTANCENAME=' + $inst),",
    "  ('/SQLSVCACCOUNT=\"' + $p.engine_konto + '\"'), '/SQLSVCSTARTUPTYPE=Automatic', ('/AGTSVCACCOUNT=\"' + $p.agent_konto + '\"'), '/AGTSVCSTARTUPTYPE=Automatic',",
    "  ('/SQLSYSADMINACCOUNTS=' + (($admins | ForEach-Object { '\"' + $_ + '\"' }) -join ' ')), '/SQLSVCINSTANTFILEINIT=True',",
    "  ('/SQLUSERDBDIR=\"' + $p.daten + '\"'), ('/SQLUSERDBLOGDIR=\"' + $p.log + '\"'), ('/SQLTEMPDBDIR=\"' + $p.tempdb + '\"'), ('/SQLTEMPDBLOGDIR=\"' + $p.tempdb + '\"'), ('/SQLBACKUPDIR=\"' + $p.sicherung + '\"'),",
    "  ('/SQLTEMPDBFILECOUNT=' + $p.tempdb_dateien), ('/SQLTEMPDBFILESIZE=' + $p.tempdb_mb), '/SQLTEMPDBFILEGROWTH=256', ('/SQLTEMPDBLOGFILESIZE=' + $p.tempdb_log_mb), '/SQLTEMPDBLOGFILEGROWTH=256',",
    "  ('/SQLMAXMEMORY=' + $p.max_speicher_mb), ('/SQLMAXDOP=' + $p.maxdop), '/TCPENABLED=1', '/NPENABLED=0')",
    "if ($mitCu) { $a += @('/UPDATEENABLED=True', ('/UPDATESOURCE=\"' + $cu + '\"')) } else { $a += '/UPDATEENABLED=False' }",
    "if ($p.pid) { $a += ('/PID=' + $p.pid) }",
    '$pr = Start-Process -FilePath $setup -ArgumentList $a -Wait -PassThru -NoNewWindow',
    "$sum = @(Get-ChildItem 'C:\\Program Files\\Microsoft SQL Server\\*\\Setup Bootstrap\\Log\\Summary.txt' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)",
    "$zeilen = $(if ($sum.Count) { @(Get-Content $sum[0].FullName -TotalCount 40 | Where-Object { $_ -match '^\\s*(Final result|Exit code|Exit message|Exit facility code|Requested action)' } | ForEach-Object { $_.Trim() }) } else { @() })",
    "if ($pr.ExitCode -ne 0 -and $pr.ExitCode -ne 3010) { throw ('Setup Exit ' + $pr.ExitCode + ': ' + ($zeilen -join ' | ')) }",
    "[ordered]@{ zustand = 'installiert'; code = $pr.ExitCode; neustart = ($pr.ExitCode -eq 3010); mitCu = [bool]$mitCu; summary = $zeilen }",
  ];
  const s = alsDomaenenkonto(p, rumpf, 5400);
  // Neustart nach Setup-Exit 3010 erst, wenn das Ergebnis geschrieben ist
  return s.replace(/\nErgebnis \$w$/, `\nErgebnis $w\nif ($w.neustart) { ${neustart('SQL-Server-Installation')} }`);
}

export function pruefeKonfiguration(o: Record<string, unknown>): { max_speicher_mb?: number; maxdop?: number; kostenschwelle?: number } | string {
  const r: { max_speicher_mb?: number; maxdop?: number; kostenschwelle?: number } = {};
  if (o.max_speicher_mb !== undefined) { const v = Number(o.max_speicher_mb); if (!Number.isInteger(v) || v < 1024) return 'max_speicher_mb ≥ 1024'; r.max_speicher_mb = v; }
  if (o.maxdop !== undefined) { const v = Number(o.maxdop); if (!Number.isInteger(v) || v < 0 || v > 64) return 'maxdop 0–64'; r.maxdop = v; }
  if (o.kostenschwelle !== undefined) { const v = Number(o.kostenschwelle); if (!Number.isInteger(v) || v < 0 || v > 32767) return 'kostenschwelle 0–32767'; r.kostenschwelle = v; }
  if (!Object.keys(r).length) return 'mindestens eines von max_speicher_mb, maxdop, kostenschwelle';
  return r;
}

/** sp_configure; Ergebnis nennt die vorherigen Werte (Rückweg: konfigurieren mit diesen) */
export function konfigurierenSkript(p: { max_speicher_mb?: number; maxdop?: number; kostenschwelle?: number }): string {
  const namen: Array<[keyof typeof p, string]> = [['max_speicher_mb', 'max server memory (MB)'], ['maxdop', 'max degree of parallelism'], ['kostenschwelle', 'cost threshold for parallelism']];
  const setzen = namen.filter(([k]) => p[k] !== undefined).map(([k, n]) => `EXEC sp_configure ${nText(n)}, ${p[k]};`).join(' ');
  return skript(p, [
    `$alt = @(Sql "SELECT name, CAST(value_in_use AS int) w FROM sys.configurations WHERE name IN (${namen.map(([, n]) => nText(n)).join(', ')})")`,
    `Sql "EXEC sp_configure N'show advanced options', 1; RECONFIGURE; ${setzen} RECONFIGURE;" | Out-Null`,
    `$neu = @(Sql "SELECT name, CAST(value_in_use AS int) w FROM sys.configurations WHERE name IN (${namen.map(([, n]) => nText(n)).join(', ')})")`,
    "$k = @{ 'max server memory (MB)' = 'max_speicher_mb'; 'max degree of parallelism' = 'maxdop'; 'cost threshold for parallelism' = 'kostenschwelle' }",
    '$v = [ordered]@{}; foreach ($x in $alt) { $v[$k[$x.name]] = $x.w }',
    '$n = [ordered]@{}; foreach ($x in $neu) { $n[$k[$x.name]] = $x.w }',
    'Ergebnis @{ vorher = $v; nachher = $n }',
  ]);
}

/**
 * HADR einschalten wie Enable-SqlAlwaysOn: Registry HADR_Enabled = 1 UND Clusterzugriff für das Dienstkonto der Instanz
 * (NT SERVICE\MSSQLSERVER bzw. NT SERVICE\MSSQL$<inst>). v1799 — Realfall 11.11. F2 863292a9 Schritt 9: nur mit dem Registry-
 * Schalter blieb SQL bei „Waiting for local Windows Server Failover Clustering service to start“ (HadrManagerStatus 0), weil der
 * Dienst-SID in Get-ClusterAccess fehlte. Danach Dienstneustart; fertig erst, wenn HADR an und der HADR-Manager gestartet ist (1).
 * v1800 — Realfall 11.11. F2 863292a9 Schritt 11: CREATE AVAILABILITY GROUP mit Fehler 41105, weil der Cluster-Ressourcentyp
 * „SQL Server Availability Group“ nicht registriert war (Get-ClusterResourceType ohne SQL-Eintrag). Die Aktion registriert ihn
 * jetzt mit hadrres.dll aus dem Binn-Verzeichnis der Instanz (ohne Neustart), wenn er fehlt.
 * v1801 — Realfall F2 Schritt 11 (12.11.): Add-ClusterResourceType greift auf \\<knoten>\admin$ aller Knoten zu; über die
 * SSH-Anmeldung (S4U, ohne Netz-Anmeldedaten) „Access denied“. Dieses Skript meldet deshalb nur ressourcentyp „fehlt“ + dll;
 * registriert wird mit ressourcentypSkript als Domänenkonto (Kennwort-Anmeldung).
 * v1802 — Realfall F2 Schritt 12 (12.11.): nach der Registrierung CREATE AVAILABILITY GROUP mit Fehler 35222 („does not have
 * permissions to access the WSFC cluster … restart the SQL Server service“) — SQL lief seit vor der Registrierung. neustart = true
 * startet den Dienst auch im Schon-Fall neu und wartet wieder auf HadrManagerStatus 1.
 * v1803 — Realfall F2 Schritt 14: trotz Neustart wieder 35222; Clusterprotokoll „s_ApiOpenKey: HadrAgNameToIdMap failed with
 * error 5“. Eingeschaltet wird jetzt wie im SQL Server Configuration Manager über WMI HADRServiceSettings.ChangeHADRService
 * (bei neustart erst aus, dann ein — so verlangen es die Fehlertexte 41105/35222); Registry-Schalter nur, wenn die Klasse fehlt.
 * Wiederholbar: ist alles da, „schon“.
 */
export function hadrSkript(instanz?: string, neustart = false): string {
  return skript({ ...nurInstanz(instanz), ...(neustart ? { neustart: true } : {}) }, [
    "if (-not (Get-Service -Name ClusSvc -ErrorAction SilentlyContinue | Where-Object Status -eq 'Running')) { throw 'Clusterdienst läuft nicht — erst den Failover-Cluster anlegen' }",
    'Import-Module FailoverClusters',
    "$konto = 'NT SERVICE\\' + $svc",
    '$sid = (New-Object System.Security.Principal.NTAccount $konto).Translate([System.Security.Principal.SecurityIdentifier]).Value',
    '$hatZugriff = [bool]@(Get-ClusterAccess | Where-Object { ([string]$_.IdentityReference -ieq $konto -or [string]$_.IdentityReference -eq $sid) -and [string]$_.ClusterRights -eq \'Full\' }).Count',
    "$instId = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\Instance Names\\SQL').$inst",
    "$rtName = 'SQL Server Availability Group'",
    '$hatTyp = [bool](Get-ClusterResourceType -Name $rtName -ErrorAction SilentlyContinue)',
    "function DllPfad { $bin = [string](Get-ItemProperty ('HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\' + $instId + '\\Setup')).SQLBinRoot; $dll = Join-Path $bin 'hadrres.dll'; if (-not (Test-Path $dll)) { throw ('hadrres.dll fehlt: ' + $dll) }; return $dll }",
    "$s = (Sql \"SELECT CAST(SERVERPROPERTY('IsHadrEnabled') AS int) h, CAST(SERVERPROPERTY('HadrManagerStatus') AS int) m\")[0]",
    "if ($s.h -eq 1 -and $s.m -eq 1 -and $hatZugriff -and -not $p.neustart) { if ($hatTyp) { Ergebnis @{ zustand = 'schon'; konto = $konto; ressourcentyp = 'schon' }; exit 0 }; Ergebnis @{ zustand = 'schon'; konto = $konto; ressourcentyp = 'fehlt'; dll = (DllPfad) }; exit 0 }",
    "$r = [ordered]@{ konto = $konto; zugriff = $(if ($hatZugriff) { 'schon' } else { 'neu' }) }",
    'if (-not $hatZugriff) { Grant-ClusterAccess -User $konto -Full | Out-Null }',
    "$ns = 'root\\Microsoft\\SqlServer\\ComputerManagement' + ($instId -replace '^MSSQL(\\d+)\\..*$', '$1')",
    "function Hs { @(Get-CimInstance -Namespace $ns -ClassName HADRServiceSettings -ErrorAction SilentlyContinue | Where-Object { [string]$_.InstanceName -eq $inst }) }",
    "function Hadr([uint32]$an) { $x = Invoke-CimMethod -InputObject @(Hs)[0] -MethodName ChangeHADRService -Arguments @{ HADRServiceEnabled = $an }; if ($x.ReturnValue -ne 0) { throw ('ChangeHADRService(' + $an + ') ReturnValue ' + $x.ReturnValue) } }",
    "if (@(Hs).Count) { if ($p.neustart -and @(Hs)[0].HADRServiceEnabled) { Hadr 0; $r.ausUndEin = $true }; Hadr 1; $r.weg = 'wmi' } else {",
    "  $k = 'HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\' + $instId + '\\MSSQLServer\\HADR'",
    '  if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }',
    "  Set-ItemProperty -Path $k -Name 'HADR_Enabled' -Value 1 -Type DWord; $r.weg = 'registry'",
    '}',
    'Restart-Service -Name $svc -Force',
    "Start-Service -Name $agt -ErrorAction SilentlyContinue",
    '$bis = (Get-Date).AddMinutes(5); $h = 0; $m = 0',
    "do { Start-Sleep -Seconds 5; try { $x = (Sql \"SELECT CAST(SERVERPROPERTY('IsHadrEnabled') AS int) h, CAST(SERVERPROPERTY('HadrManagerStatus') AS int) m\")[0]; $h = $x.h; $m = $x.m } catch { } } while (($h -ne 1 -or $m -ne 1) -and (Get-Date) -lt $bis)",
    "if ($h -ne 1 -or $m -ne 1) { throw ('HADR nach dem Neustart nicht bereit (IsHadrEnabled ' + $h + ', HadrManagerStatus ' + $m + ' — 1 = gestartet)') }",
    "if (Get-ClusterResourceType -Name $rtName -ErrorAction SilentlyContinue) { $r.ressourcentyp = 'schon' } else { $r.ressourcentyp = 'fehlt'; $r.dll = (DllPfad) }",
    "$r.zustand = $(if ($s.h -eq 1 -and $p.neustart) { 'neu gestartet' } else { 'eingeschaltet' }); $r.instanz = $instId; $r.hadrManager = 'gestartet'",
    'Ergebnis $r',
  ]);
}

/**
 * Cluster-Ressourcentyp „SQL Server Availability Group“ registrieren (v1801). Add-ClusterResourceType prüft clussvc.exe auf allen
 * Knoten über admin$ — deshalb als Domänenkonto mit Kennwort-Anmeldung (Doppel-Hop). dll = Pfad von hadrres.dll aus hadrSkript.
 * Wiederholbar: ist der Typ da, „schon“.
 */
export function ressourcentypSkript(p: { dll: string; ausKonto?: string }): string {
  if (!/^[A-Za-z]:\\[^"'`$\r\n]*\\hadrres\.dll$/i.test(p.dll)) throw new Error('dll: Pfad zu hadrres.dll');
  return alsDomaenenkonto(p, [
    'Import-Module FailoverClusters',
    "$rt = 'SQL Server Availability Group'",
    "if (Get-ClusterResourceType -Name $rt -ErrorAction SilentlyContinue) { [ordered]@{ ressourcentyp = 'schon' } } else {",
    '  Add-ClusterResourceType -Name $rt -Dll $p.dll | Out-Null',
    "  if (-not (Get-ClusterResourceType -Name $rt -ErrorAction SilentlyContinue)) { throw ('Cluster-Ressourcentyp ' + $rt + ' nach der Registrierung nicht vorhanden') }",
    "  [ordered]@{ ressourcentyp = 'neu'; dll = $p.dll }",
    '}',
  ], 300);
}

// ── Verfügbarkeitsgruppe ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Endpunkt für die AG-Replikation (Windows-Authentifizierung, AES) + Login/CONNECT für das Partner-Dienstkonto + Rechte für SYSTEM */
export function endpunktSkript(p: { port: number; partner_konto: string }): string {
  const k = `[${p.partner_konto.replace(/]/g, ']]')}]`;
  return skript(p, [
    "$schon = @(Sql \"SELECT name FROM sys.database_mirroring_endpoints\").Count",
    `if (-not $schon) { Sql "CREATE ENDPOINT [Hadr_endpoint] STATE = STARTED AS TCP (LISTENER_PORT = ${p.port}) FOR DATABASE_MIRRORING (ROLE = ALL, AUTHENTICATION = WINDOWS NEGOTIATE, ENCRYPTION = REQUIRED ALGORITHM AES)" | Out-Null }`,
    `Sql "${psDq(`IF SUSER_ID(${nText(p.partner_konto)}) IS NULL CREATE LOGIN ${k} FROM WINDOWS; GRANT CONNECT ON ENDPOINT::[Hadr_endpoint] TO ${k};`)}" | Out-Null`,
    "Sql \"IF SUSER_ID(N'NT AUTHORITY\\SYSTEM') IS NULL CREATE LOGIN [NT AUTHORITY\\SYSTEM] FROM WINDOWS; GRANT ALTER ANY AVAILABILITY GROUP, CONNECT SQL, VIEW SERVER STATE TO [NT AUTHORITY\\SYSTEM];\" | Out-Null",
    "Sql \"IF EXISTS (SELECT 1 FROM sys.server_event_sessions WHERE name = N'AlwaysOn_health') AND NOT EXISTS (SELECT 1 FROM sys.dm_xe_sessions WHERE name = N'AlwaysOn_health') BEGIN ALTER EVENT SESSION [AlwaysOn_health] ON SERVER WITH (STARTUP_STATE = ON); ALTER EVENT SESSION [AlwaysOn_health] ON SERVER STATE = START; END\" | Out-Null",
    "$e = (Sql \"SELECT e.name n, e.state_desc z, t.port p FROM sys.database_mirroring_endpoints e JOIN sys.tcp_endpoints t ON t.endpoint_id = e.endpoint_id\")[0]",
    "Ergebnis @{ zustand = $(if ($schon) { 'schon' } else { 'neu' }); endpunkt = [string]$e.n; endpunktZustand = [string]$e.z; port = [int]$e.p; partner = $p.partner_konto }",
  ]);
}

export function endpunktEntfernenSkript(instanz?: string): string {
  return skript(nurInstanz(instanz), [
    "if (@(Sql \"SELECT 1 x FROM sys.availability_groups\").Count) { throw 'erst die Verfügbarkeitsgruppe entfernen' }",
    "$n = @(Sql \"SELECT name FROM sys.database_mirroring_endpoints\")",
    "foreach ($x in $n) { Sql ('DROP ENDPOINT [' + $x.name + ']') | Out-Null }",
    "Ergebnis @{ zustand = $(if ($n.Count) { 'entfernt' } else { 'nicht vorhanden' }) }",
  ]);
}

export interface Replikat { server: string; fqdn: string }
export interface AgAnlage { name: string; datenbanken: string[]; replikate: Replikat[]; port: number }

export function pruefeAg(o: Record<string, unknown>): AgAnlage | string {
  const name = String(o.name ?? '').trim();
  const dbs = (Array.isArray(o.datenbanken) ? o.datenbanken.map(String) : typeof o.datenbanken === 'string' ? o.datenbanken.split(',') : []).map(s => s.trim()).filter(Boolean);
  const reps = (Array.isArray(o.replikate) ? o.replikate : []).map(r => { const x = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>; return { server: String(x.server ?? '').trim().toUpperCase(), fqdn: String(x.fqdn ?? '').trim().toLowerCase() }; });
  const port = o.port === undefined ? 5022 : Number(o.port);
  if (!BEZEICHNER.test(name)) return 'name: AG-Name (Buchstabe, dann Buchstaben/Ziffern/_), z. B. ag01';
  if (!dbs.length || dbs.length > 10 || dbs.some(d => !BEZEICHNER.test(d))) return 'datenbanken: 1–10 Datenbanknamen';
  if (reps.length < 2 || reps.length > 5 || reps.some(r => !REPLIKAT.test(r.server) || !FQDN.test(r.fqdn) || !r.fqdn.startsWith(`${r.server.split('\\')[0]!.toLowerCase()}.`))) return 'replikate: 2–5 {server: SQL01 bzw. SQL01\\INSTANZ, fqdn: sql01.ad.3033.at}, zuerst das primäre (dieser Rechner)';
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return 'port: Endpunkt-Port (Standard 5022)';
  return { name, datenbanken: dbs, replikate: reps, port };
}

/**
 * AG auf dem primären Replikat (erstes Replikat = dieser Rechner): Datenbanken auf FULL und — falls nie gesichert — eine Vollsicherung
 * ins Standard-Sicherungsverzeichnis; synchron, automatischer Failover, automatisches Seeding, Sicherungsvorzug PRIMARY.
 */
export function agAnlegenSkript(p: AgAnlage): string {
  const reps = p.replikate.map(r => `${nText(r.server)} WITH (ENDPOINT_URL = ${nText(`TCP://${r.fqdn}:${p.port}`)}, AVAILABILITY_MODE = SYNCHRONOUS_COMMIT, FAILOVER_MODE = AUTOMATIC, SEEDING_MODE = AUTOMATIC, SECONDARY_ROLE (ALLOW_CONNECTIONS = NO))`).join(', ');
  return skript(p, [
    `if (@(Sql "SELECT 1 x FROM sys.availability_groups WHERE name = ${nText(p.name)}").Count) { Ergebnis @{ zustand = 'schon'; name = $p.name }; exit 0 }`,
    `if ($env:COMPUTERNAME -ine ${psText(p.replikate[0]!.server.split('\\')[0]!)}) { throw ('primäres Replikat ist ' + ${psText(p.replikate[0]!.server)} + ', nicht ' + $env:COMPUTERNAME) }`,
    "$dir = [string](Sql \"SELECT CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS nvarchar(260)) b\")[0].b",
    '$gesichert = @()',
    'foreach ($d in @($p.datenbanken)) {',
    "  $x = @(Sql (\"SELECT recovery_model_desc m FROM sys.databases WHERE name = N'\" + $d + \"'\"))",
    "  if (-not $x.Count) { throw ('Datenbank ' + $d + ' gibt es nicht') }",
    "  if ($x[0].m -ne 'FULL') { Sql ('ALTER DATABASE [' + $d + '] SET RECOVERY FULL') | Out-Null }",
    "  $b = @(Sql (\"SELECT TOP 1 backup_finish_date f FROM msdb.dbo.backupset WHERE database_name = N'\" + $d + \"' AND type = 'D' AND is_copy_only = 0 ORDER BY backup_finish_date DESC\"))",
    "  if (-not $b.Count) { $f = Join-Path $dir ($d + '_voll_' + (Get-Date -Format 'yyyyMMdd_HHmmss') + '.bak'); Sql (\"BACKUP DATABASE [\" + $d + \"] TO DISK = N'\" + $f + \"' WITH CHECKSUM, COMPRESSION, INIT\") 1800 | Out-Null; $gesichert += $f }",
    '}',
    `Sql "CREATE AVAILABILITY GROUP [${p.name}] WITH (AUTOMATED_BACKUP_PREFERENCE = PRIMARY, DB_FAILOVER = ON, HEALTH_CHECK_TIMEOUT = 30000) FOR DATABASE ${p.datenbanken.map(d => `[${d}]`).join(', ')} REPLICA ON ${psDq(reps)}" 300 | Out-Null`,
    `$r = @(Sql "SELECT ar.replica_server_name r, ISNULL(rs.role_desc, '?') o FROM sys.availability_groups ag JOIN sys.availability_replicas ar ON ar.group_id = ag.group_id LEFT JOIN sys.dm_hadr_availability_replica_states rs ON rs.replica_id = ar.replica_id WHERE ag.name = ${nText(p.name)}")`,
    "Ergebnis @{ zustand = 'neu'; name = $p.name; replikate = @($r | ForEach-Object { [string]$_.r + ' ' + [string]$_.o }); vollsicherungen = $gesichert }",
  ]);
}

/** Sekundäres Replikat: AG beitreten und automatisches Seeding erlauben; wartet bis die Datenbanken hier ankommen */
export function agBeitretenSkript(p: { name: string; datenbanken: string[] }): string {
  return skript(p, [
    `$x = @(Sql "SELECT ISNULL(rs.role_desc, '') o FROM sys.availability_groups ag JOIN sys.dm_hadr_availability_replica_states rs ON rs.group_id = ag.group_id AND rs.is_local = 1 WHERE ag.name = ${nText(p.name)}")`,
    "if ($x.Count -and $x[0].o -eq 'PRIMARY') { throw 'dieser Rechner ist primär — beitreten nur auf dem sekundären' }",
    `if (-not $x.Count) { Sql "ALTER AVAILABILITY GROUP [${p.name}] JOIN" 120 | Out-Null; $z = 'beigetreten' } else { $z = 'schon' }`,
    `Sql "ALTER AVAILABILITY GROUP [${p.name}] GRANT CREATE ANY DATABASE" | Out-Null`,
    '$bis = (Get-Date).AddMinutes(30); $fehlt = @($p.datenbanken)',
    "do { Start-Sleep -Seconds 10; $da = @(Sql \"SELECT DB_NAME(database_id) d, synchronization_state_desc s FROM sys.dm_hadr_database_replica_states WHERE is_local = 1\"); $fehlt = @($p.datenbanken | Where-Object { $n = $_; -not @($da | Where-Object { $_.d -eq $n -and $_.s -eq 'SYNCHRONIZED' }).Count }) } while ($fehlt.Count -and (Get-Date) -lt $bis)",
    "if ($fehlt.Count) { throw ('nach 30 min nicht SYNCHRONIZED: ' + ($fehlt -join ', ')) }",
    "Ergebnis @{ zustand = $z; name = $p.name; synchron = @($p.datenbanken) }",
  ]);
}

export function agEntfernenSkript(p: { name: string }): string {
  return skript(p, [
    `if (-not @(Sql "SELECT 1 x FROM sys.availability_groups WHERE name = ${nText(p.name)}").Count) { Ergebnis @{ zustand = 'nicht vorhanden' }; exit 0 }`,
    `Sql "DROP AVAILABILITY GROUP [${p.name}]" 300 | Out-Null`,
    "Ergebnis @{ zustand = 'entfernt (Datenbanken auf sekundären Replikaten stehen danach im Zustand RESTORING)' }",
  ]);
}

export function pruefeListener(o: Record<string, unknown>): { ag: string; name: string; ip: string; maske: string; port: number } | string {
  const ag = String(o.ag ?? '').trim(); const name = String(o.name ?? '').trim().toLowerCase(); const ip = String(o.ip ?? '').trim(); const maske = String(o.maske ?? '').trim(); const port = o.port === undefined ? 1433 : Number(o.port);
  if (!BEZEICHNER.test(ag)) return 'ag: Name der Verfügbarkeitsgruppe';
  if (!SERVER.test(name)) return 'name: Listener-Name (VCO) höchstens 15 Zeichen, z. B. sqlag01';
  if (!IPV4.test(ip) || !IPV4.test(maske)) return 'ip und maske: IPv4, z. B. 10.203.30.5 und 255.255.255.224';
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'port: Standard 1433';
  return { ag, name, ip, maske, port };
}

export function listenerSkript(p: { ag: string; name: string; ip: string; maske: string; port: number }): string {
  return skript(p, [
    `if (@(Sql "SELECT 1 x FROM sys.availability_group_listeners l JOIN sys.availability_groups ag ON ag.group_id = l.group_id WHERE ag.name = ${nText(p.ag)} AND l.dns_name = ${nText(p.name)}").Count) { $z = 'schon' }`,
    `else { Sql "ALTER AVAILABILITY GROUP [${p.ag}] ADD LISTENER ${nText(p.name)} (WITH IP ((${nText(p.ip)}, ${nText(p.maske)})), PORT = ${p.port})" 300 | Out-Null; $z = 'neu' }`,
    "$l = @(Sql \"SELECT l.dns_name n, l.port p, ISNULL(i.ip_address, '') i, ISNULL(i.state_desc, '') s FROM sys.availability_group_listeners l LEFT JOIN sys.availability_group_listener_ip_addresses i ON i.listener_id = l.listener_id\")",
    "Ergebnis @{ zustand = $z; listener = @($l | ForEach-Object { [string]$_.n + ':' + [string]$_.p + ' ' + [string]$_.i + ' ' + [string]$_.s }) }",
  ]);
}

export function listenerEntfernenSkript(p: { ag: string; name: string }): string {
  return skript(p, [
    `if (-not @(Sql "SELECT 1 x FROM sys.availability_group_listeners WHERE dns_name = ${nText(p.name)}").Count) { Ergebnis @{ zustand = 'nicht vorhanden' }; exit 0 }`,
    `Sql "ALTER AVAILABILITY GROUP [${p.ag}] REMOVE LISTENER ${nText(p.name)}" 300 | Out-Null`,
    "Ergebnis @{ zustand = 'entfernt' }",
  ]);
}

/**
 * Geplanter Failover auf DIESEN Rechner (sekundär, synchron, alle Datenbanken SYNCHRONIZED) — nie FORCE_ALLOW_DATA_LOSS. Wartet, bis
 * der Rechner primär ist, und misst die Dauer.
 */
export interface ListenerTest { server: string; rolle: string; anmeldung: string; konto: string; verschluesselt: boolean; transport: string; adresse: string; port: number; ms: number }

/**
 * v1790 — Owner 11.11.: Clientbeweis über den Listener. Anmeldung als Domänenkonto (Kennwort-Anmeldung, echter Netz-Client mit
 * Kerberos) über TCP an <listener>:<port>, verschlüsselt (Zertifikat vorerst selbstsigniert, daher nicht geprüft). Liest aus der
 * eigenen Verbindung Authentifizierung, Verschlüsselung, Zieladresse sowie Server und Rolle des Replikats dahinter. Ändert nichts.
 */
export function listenerTestSkript(p: { listener: string; port: number }): string {
  return alsDomaenenkonto(p, [
    "$sw = [Diagnostics.Stopwatch]::StartNew()",
    "$cn = New-Object System.Data.SqlClient.SqlConnection ('Server=tcp:' + $p.listener + ',' + $p.port + ';Database=master;Integrated Security=SSPI;Encrypt=True;TrustServerCertificate=True;MultiSubnetFailover=True;Connect Timeout=20;Application Name=Alfred-Listenertest')",
    '$cn.Open()',
    'try {',
    '  $cmd = $cn.CreateCommand()',
    "  $cmd.CommandText = \"SELECT CAST(@@SERVERNAME AS nvarchar(128)) s, c.auth_scheme a, c.encrypt_option e, c.net_transport t, CAST(c.local_net_address AS nvarchar(48)) l, c.local_tcp_port p, SUSER_SNAME() u, (SELECT TOP 1 rs.role_desc FROM sys.dm_hadr_availability_replica_states rs WHERE rs.is_local = 1) r FROM sys.dm_exec_connections c WHERE c.session_id = @@SPID\"",
    '  $rd = $cmd.ExecuteReader(); [void]$rd.Read()',
    "  $w = [ordered]@{ server = [string]$rd['s']; rolle = [string]$rd['r']; anmeldung = [string]$rd['a']; konto = [string]$rd['u']; verschluesselt = ([string]$rd['e'] -eq 'TRUE'); transport = [string]$rd['t']; adresse = [string]$rd['l']; port = [int]$rd['p']; ms = $sw.ElapsedMilliseconds }",
    '  $rd.Close(); $w',
    '} finally { $cn.Close() }',
  ], 120);
}

export function listenerTestText(p: { listener: string; port: number }, r: ListenerTest): string {
  return `Listener ${p.listener}:${p.port} → ${r.server} (${r.rolle || 'ohne AG-Rolle'}), Anmeldung ${r.konto} über ${r.anmeldung}, ${r.verschluesselt ? 'verschlüsselt (Zertifikat nicht geprüft)' : 'UNVERSCHLÜSSELT'}, ${r.transport} ${r.adresse}:${r.port}, ${r.ms} ms`;
}

export function failoverSkript(p: { ag: string }): string {
  return skript(p, [
    `$x = @(Sql "SELECT rs.role_desc o, ar.availability_mode_desc m FROM sys.availability_groups ag JOIN sys.dm_hadr_availability_replica_states rs ON rs.group_id = ag.group_id AND rs.is_local = 1 JOIN sys.availability_replicas ar ON ar.replica_id = rs.replica_id WHERE ag.name = ${nText(p.ag)}")`,
    "if (-not $x.Count) { throw 'dieser Rechner ist kein Replikat der AG' }",
    "if ($x[0].o -eq 'PRIMARY') { Ergebnis @{ zustand = 'schon primär'; primaer = $env:COMPUTERNAME; ms = 0 }; exit 0 }",
    "if ($x[0].m -ne 'SYNCHRONOUS_COMMIT') { throw 'Replikat ist asynchron — geplanter Failover nur auf ein synchrones Replikat' }",
    `$nicht = @(Sql "SELECT DB_NAME(s.database_id) d, s.synchronization_state_desc z FROM sys.dm_hadr_database_replica_states s JOIN sys.availability_groups ag ON ag.group_id = s.group_id WHERE s.is_local = 1 AND ag.name = ${nText(p.ag)} AND s.synchronization_state_desc <> 'SYNCHRONIZED'")`,
    "if ($nicht.Count) { throw ('nicht SYNCHRONIZED: ' + (($nicht | ForEach-Object { [string]$_.d + ' ' + [string]$_.z }) -join ', ') + ' — kein Failover (Datenverlust ausgeschlossen)') }",
    '$sw = [Diagnostics.Stopwatch]::StartNew()',
    `Sql "ALTER AVAILABILITY GROUP [${p.ag}] FAILOVER" 300 | Out-Null`,
    '$bis = (Get-Date).AddMinutes(5)',
    `do { Start-Sleep -Milliseconds 500; $o = [string](Sql "SELECT rs.role_desc o FROM sys.availability_groups ag JOIN sys.dm_hadr_availability_replica_states rs ON rs.group_id = ag.group_id AND rs.is_local = 1 WHERE ag.name = ${nText(p.ag)}")[0].o } while ($o -ne 'PRIMARY' -and (Get-Date) -lt $bis)`,
    "if ($o -ne 'PRIMARY') { throw 'nach dem Failover nicht primär' }",
    "Ergebnis @{ zustand = 'Failover'; primaer = $env:COMPUTERNAME; ms = $sw.ElapsedMilliseconds }",
  ]);
}

// ── Datenbanken, Prüfdaten, Sicherung, Wiederherstellung ────────────────────────────────────────────────────────────────────────────

/** Testdatenbank in den Standardpfaden (Daten/Log-Platte), FULL, gekennzeichnet (erweiterte Eigenschaft alfred = I8d) */
export function datenbankSkript(p: { name: string }): string {
  return skript(p, [
    `if (@(Sql "SELECT 1 x FROM sys.databases WHERE name = ${nText(p.name)}").Count) { $z = 'schon' } else { Sql "CREATE DATABASE [${p.name}]" 300 | Out-Null; $z = 'neu' }`,
    `Sql "ALTER DATABASE [${p.name}] SET RECOVERY FULL" | Out-Null`,
    `Sql "IF NOT EXISTS (SELECT 1 FROM sys.extended_properties WHERE class = 0 AND name = N'alfred') EXEC sp_addextendedproperty @name = N'alfred', @value = N'I8d'" 60 $p.name | Out-Null`,
    `$f = @(Sql "SELECT type_desc t, physical_name f FROM sys.master_files WHERE database_id = DB_ID(${nText(p.name)})")`,
    "Ergebnis @{ zustand = $z; name = $p.name; dateien = @($f | ForEach-Object { [string]$_.t + ' ' + [string]$_.f }) }",
  ]);
}

/** Entfernt nur eine von Alfred angelegte Datenbank, die in keiner AG ist */
export function datenbankEntfernenSkript(p: { name: string }): string {
  return skript(p, [
    `if (-not @(Sql "SELECT 1 x FROM sys.databases WHERE name = ${nText(p.name)}").Count) { Ergebnis @{ zustand = 'nicht vorhanden' }; exit 0 }`,
    `if (@(Sql "SELECT 1 x FROM sys.databases WHERE name = ${nText(p.name)} AND replica_id IS NOT NULL").Count) { throw 'Datenbank ist in einer Verfügbarkeitsgruppe — erst aus der AG entfernen' }`,
    `$st = [string](Sql "SELECT state_desc s FROM sys.databases WHERE name = ${nText(p.name)}")[0].s`,
    `if ($st -eq 'ONLINE') { $m = @(Sql "SELECT value v FROM sys.extended_properties WHERE class = 0 AND name = N'alfred'" 60 $p.name); if (-not $m.Count -or [string]$m[0].v -ne 'I8d') { throw 'Datenbank ist nicht von Alfred angelegt' }; Sql "ALTER DATABASE [${p.name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE" | Out-Null }`,
    `Sql "DROP DATABASE [${p.name}]" 300 | Out-Null`,
    "Ergebnis @{ zustand = 'entfernt'; vorherZustand = $st }",
  ]);
}

export function pruefdatenSchreibenSkript(p: { datenbank: string; notiz: string }): string {
  return skript(p, [
    "Sql \"IF OBJECT_ID(N'dbo.alfred_pruef') IS NULL CREATE TABLE dbo.alfred_pruef (id int IDENTITY(1,1) PRIMARY KEY, zeit datetime2(3) NOT NULL DEFAULT SYSDATETIME(), server sysname NOT NULL DEFAULT @@SERVERNAME, notiz nvarchar(200) NULL)\" 60 $p.datenbank | Out-Null",
    `$x = (Sql "INSERT dbo.alfred_pruef (notiz) OUTPUT inserted.id i, inserted.server s, inserted.zeit z VALUES (${psDq(nText(p.notiz))})" 60 $p.datenbank)[0]`,
    "$n = [int](Sql 'SELECT COUNT(*) n FROM dbo.alfred_pruef' 60 $p.datenbank)[0].n",
    "Ergebnis @{ datenbank = $p.datenbank; id = [int]$x.i; server = [string]$x.s; zeit = $x.z.ToString('s'); zeilen = $n }",
  ]);
}

/** T-SQL einer Sicherung: Unterordner je Datenbank (xp_create_subdir als Dienstkonto), Dateiname <db>_<art>_<zeit>.<bak|dif|trn> */
export function sicherungTsql(ziel: string, art: 'voll' | 'diff' | 'log', datenbankAusdruck: string): string {
  const endung = art === 'voll' ? 'bak' : art === 'diff' ? 'dif' : 'trn';
  const befehl = art === 'log' ? 'BACKUP LOG' : 'BACKUP DATABASE';
  const mit = art === 'diff' ? 'DIFFERENTIAL, CHECKSUM, COMPRESSION, INIT' : 'CHECKSUM, COMPRESSION, INIT';
  return `DECLARE @db sysname = ${datenbankAusdruck}; DECLARE @dir nvarchar(400) = ${nText(ziel)} + N'\\' + @db; EXEC master.sys.xp_create_subdir @dir; `
    + `DECLARE @f nvarchar(500) = @dir + N'\\' + @db + N'_${art}_' + FORMAT(SYSDATETIME(), 'yyyyMMdd_HHmmss') + N'.${endung}'; ${befehl} @db TO DISK = @f WITH ${mit}; SELECT @f f;`;
}

export function pruefeSicherung(o: Record<string, unknown>): { datenbank: string; art: 'voll' | 'diff' | 'log'; ziel: string } | string {
  const datenbank = String(o.datenbank ?? '').trim(); const art = String(o.art ?? '').trim(); const ziel = String(o.ziel ?? '').trim().replace(/\\+$/, '');
  if (!BEZEICHNER.test(datenbank)) return 'datenbank: Name';
  if (art !== 'voll' && art !== 'diff' && art !== 'log') return 'art: voll, diff oder log';
  if (!pfadOk(ziel)) return 'ziel: Ordner (B:\\SQLBackup) oder Freigabe (\\\\fs01.ad.3033.at\\SQLBackup$)';
  return { datenbank, art, ziel };
}

/** Sicherung jetzt (bevorzugtes Replikat wird NICHT erzwungen — Schritt läuft auf dem genannten Rechner), Ergebnis mit Datei und Größe */
export function sicherungSkript(p: { datenbank: string; art: 'voll' | 'diff' | 'log'; ziel: string }): string {
  return skript(p, [
    `$f = [string](Sql "${psDq(sicherungTsql(p.ziel, p.art, nText(p.datenbank)))}" 3600)[0].f`,
    `$b = (Sql "SELECT TOP 1 CAST(compressed_backup_size / 1048576.0 AS decimal(12,1)) mb, has_backup_checksums c FROM msdb.dbo.backupset WHERE database_name = ${nText(p.datenbank)} ORDER BY backup_finish_date DESC")[0]`,
    "Ergebnis @{ datei = $f; mb = [double]$b.mb; pruefsumme = [bool]$b.c; art = $p.art; datenbank = $p.datenbank }",
  ]);
}

export interface SicherungsJobs { datenbanken: string[]; ziel: string; voll_uhrzeit: string; diff_stunden: number; log_minuten: number }

export function pruefeJobs(o: Record<string, unknown>): SicherungsJobs | string {
  const dbs = (Array.isArray(o.datenbanken) ? o.datenbanken.map(String) : typeof o.datenbanken === 'string' ? o.datenbanken.split(',') : []).map(s => s.trim()).filter(Boolean);
  const p: SicherungsJobs = { datenbanken: dbs, ziel: String(o.ziel ?? '').trim().replace(/\\+$/, ''), voll_uhrzeit: String(o.voll_uhrzeit ?? '01:00').trim(), diff_stunden: o.diff_stunden === undefined ? 6 : Number(o.diff_stunden), log_minuten: o.log_minuten === undefined ? 15 : Number(o.log_minuten) };
  if (!dbs.length || dbs.length > 20 || dbs.some(d => !BEZEICHNER.test(d))) return 'datenbanken: 1–20 Namen';
  if (!pfadOk(p.ziel)) return 'ziel: Ordner oder Freigabe';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.voll_uhrzeit)) return 'voll_uhrzeit: HH:MM';
  if (![0, 1, 2, 3, 4, 6, 8, 12].includes(p.diff_stunden)) return 'diff_stunden: 0 (keine), 1, 2, 3, 4, 6, 8 oder 12';
  if (![5, 10, 15, 30, 60].includes(p.log_minuten)) return 'log_minuten: 5, 10, 15, 30 oder 60';
  return p;
}

/**
 * Agent-Jobs „Alfred Sicherung voll/diff/log“ auf diesem Replikat (auf allen Replikaten einrichten): sie sichern nur, wenn dieses Replikat
 * das bevorzugte ist (sys.fn_hadr_backup_is_preferred_replica; AG mit Vorzug PRIMARY) und die Datenbank online ist; diff nur mit Basis,
 * log nur bei FULL. Fehler einer Datenbank lassen den Job scheitern (sichtbar). Kein automatisches Löschen (Architektur v3).
 */
export function jobsSkript(p: SicherungsJobs): string {
  const liste = p.datenbanken.map(nText).join(', ');
  const schritt = (art: 'voll' | 'diff' | 'log', bedingung: string) =>
    `DECLARE @fehler nvarchar(2000) = N''; DECLARE @d sysname; DECLARE c CURSOR LOCAL FAST_FORWARD FOR SELECT name FROM sys.databases WHERE name IN (${liste}); OPEN c; FETCH NEXT FROM c INTO @d; `
    + `WHILE @@FETCH_STATUS = 0 BEGIN IF sys.fn_hadr_backup_is_preferred_replica(@d) = 1 AND DATABASEPROPERTYEX(@d, 'Status') = 'ONLINE' AND (${bedingung}) BEGIN BEGIN TRY ${sicherungTsql(p.ziel, art, '@d').replace('DECLARE @db sysname = @d; ', 'DECLARE @db sysname; SET @db = @d; ').replace(' SELECT @f f;', '')} END TRY BEGIN CATCH SET @fehler += @d + N': ' + ERROR_MESSAGE() + N' '; END CATCH END; FETCH NEXT FROM c INTO @d; END; CLOSE c; DEALLOCATE c; `
    + `IF @fehler <> N'' THROW 50000, @fehler, 1;`;
  const jobs: Array<{ name: string; tsql: string; plan: string }> = [
    { name: 'Alfred Sicherung voll', tsql: schritt('voll', '1 = 1'), plan: `@freq_type = 4, @freq_interval = 1, @active_start_time = ${Number(p.voll_uhrzeit.replace(':', '')) * 100}` },
    ...(p.diff_stunden ? [{ name: 'Alfred Sicherung diff', tsql: schritt('diff', "(SELECT differential_base_lsn FROM sys.master_files WHERE database_id = DB_ID(@d) AND file_id = 1) IS NOT NULL"), plan: `@freq_type = 4, @freq_interval = 1, @freq_subday_type = 8, @freq_subday_interval = ${p.diff_stunden}, @active_start_time = ${(Number(p.voll_uhrzeit.replace(':', '')) * 100 + 3000) % 240000}` }] : []),
    { name: 'Alfred Sicherung log', tsql: schritt('log', "DATABASEPROPERTYEX(@d, 'Recovery') = 'FULL' AND (SELECT differential_base_lsn FROM sys.master_files WHERE database_id = DB_ID(@d) AND file_id = 1) IS NOT NULL"), plan: `@freq_type = 4, @freq_interval = 1, @freq_subday_type = 4, @freq_subday_interval = ${p.log_minuten}, @active_start_time = 0` },
  ];
  const zeilen = jobs.map(j => {
    const sql = `IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = ${nText(j.name)}) EXEC msdb.dbo.sp_delete_job @job_name = ${nText(j.name)}; `
      + `EXEC msdb.dbo.sp_add_job @job_name = ${nText(j.name)}, @owner_login_name = N'sa', @description = N'Alfred I8d'; `
      + `EXEC msdb.dbo.sp_add_jobstep @job_name = ${nText(j.name)}, @step_name = N'Sichern', @subsystem = N'TSQL', @database_name = N'master', @command = ${nText(j.tsql)}; `
      + `EXEC msdb.dbo.sp_add_jobschedule @job_name = ${nText(j.name)}, @name = ${nText(j.name)}, ${j.plan}; `
      + `EXEC msdb.dbo.sp_add_jobserver @job_name = ${nText(j.name)}, @server_name = N'(local)';`;
    return `Sql "${psDq(sql)}" 120 'msdb' | Out-Null`;
  });
  return skript(p, [
    "if (-not (Get-Service -Name $agt -ErrorAction SilentlyContinue | Where-Object Status -eq 'Running')) { throw ('SQL Server Agent (' + $agt + ') läuft nicht') }",
    ...zeilen,
    "$j = @(Sql \"SELECT j.name n, j.enabled e FROM msdb.dbo.sysjobs j WHERE j.name LIKE N'Alfred Sicherung %' ORDER BY j.name\" 60 'msdb')",
    "Ergebnis @{ jobs = @($j | ForEach-Object { [string]$_.n + $(if ($_.e) { ' aktiv' } else { ' aus' }) }); ziel = $p.ziel }",
  ]);
}

export function jobsEntfernenSkript(instanz?: string): string {
  return skript(nurInstanz(instanz), [
    "$j = @(Sql \"SELECT name n FROM msdb.dbo.sysjobs WHERE name LIKE N'Alfred Sicherung %'\" 60 'msdb')",
    "foreach ($x in $j) { Sql (\"EXEC msdb.dbo.sp_delete_job @job_name = N'\" + $x.n + \"'\") 60 'msdb' | Out-Null }",
    "Ergebnis @{ entfernt = @($j | ForEach-Object { [string]$_.n }) }",
  ]);
}

export function pruefeWiederherstellung(o: Record<string, unknown>): { datenbank: string; ordner: string; ziel_name: string; entfernen: boolean } | string {
  const datenbank = String(o.datenbank ?? '').trim(); const ordner = String(o.ordner ?? '').trim().replace(/\\+$/, ''); const ziel = String(o.ziel_name ?? '').trim();
  if (!BEZEICHNER.test(datenbank) || !BEZEICHNER.test(ziel)) return 'datenbank und ziel_name: Datenbanknamen';
  if (datenbank === ziel) return 'ziel_name muss sich von der Quelle unterscheiden (Wiederherstellung neben der AG)';
  if (!pfadOk(ordner)) return 'ordner: Sicherungsordner der Datenbank, z. B. \\\\fs01.ad.3033.at\\SQLBackup$\\alfredtest';
  return { datenbank, ordner, ziel_name: ziel, entfernen: o.entfernen_danach !== false };
}

/**
 * Wiederherstellungstest neben der AG: Dateien listet der Datenbankdienst selbst (xp_dirtree, kein Doppel-Hop); jüngste Vollsicherung,
 * jüngste Differenzielle danach, alle Logs danach; Platz auf Daten-/Log-Platte gegen FILELISTONLY geprüft; RESTORE mit MOVE, danach
 * DBCC CHECKDB und Prüfdaten zählen; optional wieder entfernen.
 */
export function wiederherstellungSkript(p: { datenbank: string; ordner: string; ziel_name: string; entfernen: boolean }): string {
  return skript(p, [
    `if (@(Sql "SELECT 1 x FROM sys.databases WHERE name = ${nText(p.ziel_name)}").Count) { throw ('Zieldatenbank ' + $p.ziel_name + ' gibt es schon') }`,
    `$dateien = @(Sql "CREATE TABLE #d (n nvarchar(400), t int, f int); INSERT #d EXEC master.sys.xp_dirtree ${psDq(nText(p.ordner))}, 1, 1; SELECT n FROM #d WHERE f = 1" 120 | ForEach-Object { [string]$_.n })`,
    "$re = '^' + [regex]::Escape($p.datenbank) + '_(voll|diff|log)_(\\d{8}_\\d{6})\\.(bak|dif|trn)$'",
    "$liste = @($dateien | Where-Object { $_ -match $re } | ForEach-Object { $m = [regex]::Match($_, $re); [pscustomobject]@{ n = $_; art = $m.Groups[1].Value; zeit = $m.Groups[2].Value } } | Sort-Object zeit)",
    "$voll = @($liste | Where-Object art -eq 'voll' | Select-Object -Last 1)",
    "if (-not $voll.Count) { throw ('keine Vollsicherung von ' + $p.datenbank + ' in ' + $p.ordner) }",
    "$diff = @($liste | Where-Object { $_.art -eq 'diff' -and $_.zeit -gt $voll[0].zeit } | Select-Object -Last 1)",
    "$ab = $(if ($diff.Count) { $diff[0].zeit } else { $voll[0].zeit })",
    "$logs = @($liste | Where-Object { $_.art -eq 'log' -and $_.zeit -gt $ab })",
    "$pfad = { param($n) $p.ordner + '\\' + $n }",
    "$fl = @(Sql (\"RESTORE FILELISTONLY FROM DISK = N'\" + (& $pfad $voll[0].n) + \"'\") 600)",
    "$daten = [string](Sql \"SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(260)) d, CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(260)) l\")[0].d",
    "$logp = [string](Sql \"SELECT CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(260)) l\")[0].l",
    "$brauchtD = [double](($fl | Where-Object Type -ne 'L' | Measure-Object -Property Size -Sum).Sum); $brauchtL = [double](($fl | Where-Object Type -eq 'L' | Measure-Object -Property Size -Sum).Sum)",
    // v1805 — Realfall F3 4a7be151 Schritt 19: Get-Volume -DriveLetter lieferte auf sql02 zwei Objekte (Vergleich mit Object[]); DriveInfo ist eindeutig
    "$freiD = [double]([System.IO.DriveInfo]::new($daten.Substring(0, 1))).AvailableFreeSpace; $freiL = [double]([System.IO.DriveInfo]::new($logp.Substring(0, 1))).AvailableFreeSpace",
    "if ($brauchtD * 1.1 -gt $freiD -or $brauchtL * 1.1 -gt $freiL) { throw ('zu wenig Platz: Daten braucht ' + [math]::Round($brauchtD / 1GB, 2) + ' GB (frei ' + [math]::Round($freiD / 1GB, 2) + '), Log ' + [math]::Round($brauchtL / 1GB, 2) + ' GB (frei ' + [math]::Round($freiL / 1GB, 2) + ')') }",
    "$i = 0; $move = @($fl | ForEach-Object { $i++; $z = $(if ($_.Type -eq 'L') { Join-Path $logp ($p.ziel_name + '_' + $i + '.ldf') } else { Join-Path $daten ($p.ziel_name + '_' + $i + '.mdf') }); \"MOVE N'\" + ([string]$_.LogicalName).Replace(\"'\", \"''\") + \"' TO N'\" + $z + \"'\" }) -join ', '",
    "$kette = @($voll[0]) + @($diff) + @($logs)",
    '$sw = [Diagnostics.Stopwatch]::StartNew()',
    "Sql (\"RESTORE DATABASE [\" + $p.ziel_name + \"] FROM DISK = N'\" + (& $pfad $voll[0].n) + \"' WITH \" + $move + \", CHECKSUM, NORECOVERY\") 7200 | Out-Null",
    "if ($diff.Count) { Sql (\"RESTORE DATABASE [\" + $p.ziel_name + \"] FROM DISK = N'\" + (& $pfad $diff[0].n) + \"' WITH CHECKSUM, NORECOVERY\") 7200 | Out-Null }",
    "foreach ($l in $logs) { Sql (\"RESTORE LOG [\" + $p.ziel_name + \"] FROM DISK = N'\" + (& $pfad $l.n) + \"' WITH CHECKSUM, NORECOVERY\") 3600 | Out-Null }",
    "Sql (\"RESTORE DATABASE [\" + $p.ziel_name + \"] WITH RECOVERY\") 600 | Out-Null",
    '$dauer = $sw.Elapsed.TotalSeconds',
    "Sql (\"DBCC CHECKDB ([\" + $p.ziel_name + \"]) WITH NO_INFOMSGS, ALL_ERRORMSGS\") 7200 | Out-Null",
    "$x = (Sql \"IF OBJECT_ID(N'dbo.alfred_pruef') IS NULL SELECT CAST(0 AS int) n, CAST(NULL AS int) m ELSE SELECT COUNT(*) n, MAX(id) m FROM dbo.alfred_pruef\" 60 $p.ziel_name)[0]",
    "if ($p.entfernen) { Sql (\"DROP DATABASE [\" + $p.ziel_name + \"]\") 600 | Out-Null }",
    "Ergebnis @{ quelle = $p.datenbank; ziel = $p.ziel_name; kette = @($kette | ForEach-Object { $_.n }); sekunden = [math]::Round($dauer, 1); checkdb = 'ohne Fehler'; pruefZeilen = [int]$x.n; letzteId = $x.m; entfernt = [bool]$p.entfernen }",
  ]);
}
