/**
 * Ruling R33 (I8e Etappe 3, Paket L6) — SQL Server Management Studio mit sqlcmd und ODBC Driver 18 auf einem Windows-Zugang (Admin-Clients
 * sqladmw11/sqladm25): Mitglieder von SQL-Linux-Admins verbinden sich dort per Kerberos und erzwungenem TLS mit dem Linux-AG-Listener.
 *
 * Feste Quellen nur von Microsoft (gleiche Prüfung MEDIEN_URL wie sql_medien_laden), jede Datei vor dem Start auf eine gültige
 * Microsoft-Signatur geprüft (SIGNIERT_FN, Authenticode „Valid“ + „O=Microsoft Corporation“). Still installiert in fester Reihenfolge:
 * (a) ODBC Driver 18 for SQL Server (msodbcsql.msi, IACCEPTMSODBCSQLLICENSETERMS=YES), (b) Microsoft Command Line Utilities for SQL
 * Server (ODBC-sqlcmd, braucht den Treiber; IACCEPTMSSQLCMDLNUTILSLICENSETERMS=YES), (c) SSMS 22 über den Bootstrapper vs_SSMS.exe
 * (--installPath fest, --quiet --norestart --wait). Kein Neustart durch den Baustein (Exit 3010 wird gemeldet).
 *
 * Wiederholbar: Vorhandenes bleibt („vorhanden“), nur Fehlendes wird geladen. Was dieser Baustein installiert hat, steht im Merker
 * %ProgramData%\Alfred\ssms\installiert.json (vor dem Start eingetragen, Produktcodes danach) — der Rückweg ssms_entfernen nimmt genau
 * das zurück, nie etwas, das schon vorher da war (z. B. sqlcmd/ODBC einer SQL-Server-Installation auf sql01).
 * Selbstprüfung: Ssms.exe (FileVersion), sqlcmd -? (Version) an einem der festen ODBC-Pfade der Anmeldeprobe (R32), ODBC-Treiber-
 * Version aus der Registry (Treiber-DLL) — Erfolg nur, wenn alle drei belegt sind.
 */
import { kopf, psText } from './windows-ad.js';
import { SIGNIERT_FN } from './sql-server.js';
import { SQLCMD_PFADE } from './windows-ad-linux.js';

/**
 * Ruling R33 — Quellen (Microsoft Learn, Stand 20.11.2026): ODBC Driver 18.7.1.1 x64 („Download ODBC Driver for SQL Server“), Microsoft
 * Command Line Utilities x64 17.0.4055.5 („Download and install the sqlcmd utility“), SSMS 22 Release-Kanal („Install SSMS“ / „Command-
 * line parameters“; der Bootstrapper installiert immer den neuesten Stand des Kanals). Die fwlink-Kennungen sind je Version fest.
 */
export const SSMS_QUELLEN = {
  odbc: 'https://go.microsoft.com/fwlink/?linkid=2378279',
  sqlcmd: 'https://go.microsoft.com/fwlink/?linkid=2370127',
  ssms: 'https://aka.ms/ssms/22/release/vs_SSMS.exe',
} as const;
/**
 * Ruling R42 (Realfall 2d2c5d5b Schritt 14): die befristete Web-Freigabe war auf dem Gateway 30–45 s nach dem Anlegen noch nicht
 * wirksam — Verbindungsfehler ohne Serverantwort werden bis zu 10× im Abstand von 30 s wiederholt (≈ 5 min); eine HTTP-Antwort
 * (z. B. 404) bricht sofort ab, ebenso jeder andere Fehler. Die Signaturprüfung danach bleibt unverändert.
 */
export const SSMS_LADEN_VERSUCHE = 10;
export const SSMS_LADEN_ABSTAND_S = 30;
/** Ruling R33 — fester Installationsort (Standard von SSMS 22, Release-Kanal); Ssms.exe darunter in Common7\IDE */
export const SSMS_INSTALLATIONSPFAD = 'C:\\Program Files\\Microsoft SQL Server Management Studio 22\\Release';
export const SSMS_EXE = `${SSMS_INSTALLATIONSPFAD}\\Common7\\IDE\\SSMS.exe`;
export const ODBC_TREIBER = 'ODBC Driver 18 for SQL Server';
/** Ruling R33 — ODBC-sqlcmd nur an den festen Pfaden der Anmeldeprobe (R32, Ruling R2) — ohne go-sqlcmd */
export const SQLCMD_ODBC_PFADE: readonly string[] = SQLCMD_PFADE.slice(1);
/** Ruling R33 — Baustein-Zeitgrenzen und Mindest-zeitlimitS der Change-Schritte (Zeitgrenze + 60 s) */
export const SSMS_ZEIT_MS = { installieren: 3_600_000, entfernen: 1_200_000 } as const;
export const SSMS_MIN_ZEITLIMIT_S: Readonly<Record<string, number>> = { ssms_installieren: 3660, ssms_entfernen: 1260 };

const MUSTER_ODBC = 'Microsoft ODBC Driver 18 for SQL Server*';
const MUSTER_SQLCMD = 'Microsoft Command Line Utilities*for SQL Server*';
const UNINSTALL = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

/** gemeinsame Funktionen: Fundorte und Versionen der drei Teile, Produktcodes, Merker */
const SSMS_VOR = [
  "$basis = Join-Path $env:ProgramData 'Alfred\\ssms'; $merk = Join-Path $basis 'installiert.json'; $dl = Join-Path $basis 'download'",
  `$odbcKey = ${psText(`HKLM:\\SOFTWARE\\ODBC\\ODBCINST.INI\\${ODBC_TREIBER}`)}`,
  `$ssmsPfad = ${psText(SSMS_INSTALLATIONSPFAD)}; $ssmsExe = ${psText(SSMS_EXE)}`,
  `$sqlcmdPfade = @(${SQLCMD_ODBC_PFADE.map(psText).join(', ')})`,
  `$uninst = ${psText(UNINSTALL)}`,
  "function Odbc { $k = Get-ItemProperty -LiteralPath $odbcKey -ErrorAction SilentlyContinue; if (-not $k -or -not $k.Driver -or -not (Test-Path -LiteralPath ([string]$k.Driver))) { return $null }; $v = ([string](Get-Item -LiteralPath ([string]$k.Driver)).VersionInfo.FileVersion).Trim(); [ordered]@{ dll = [string]$k.Driver; version = $v } }",
  // sqlcmd -? nennt „Version 17.0.4055.5 NT“; Fehlerausgabe in den Text statt Ausnahme
  "function SqlcmdFund { foreach ($x in $sqlcmdPfade) { if (Test-Path -LiteralPath $x) { $ErrorActionPreference = 'Continue'; $t = & $x '-?' 2>&1 | Out-String; $ErrorActionPreference = 'Stop'; $v = $(if ($t -match 'Version\\s+(\\d+(\\.\\d+)+)') { $Matches[1] } else { '' }); return [ordered]@{ pfad = $x; version = $v } } }; return $null }",
  "function Ssms { if (-not (Test-Path -LiteralPath $ssmsExe)) { return $null }; $i = (Get-Item -LiteralPath $ssmsExe).VersionInfo; [ordered]@{ pfad = $ssmsExe; version = $(if ($i.FileMajorPart -gt 0) { '{0}.{1}.{2}.{3}' -f $i.FileMajorPart, $i.FileMinorPart, $i.FileBuildPart, $i.FilePrivatePart } else { '' }); dateiVersion = ([string]$i.FileVersion).Trim(); produktVersion = ([string]$i.ProductVersion).Trim() } }",
  "function Produkte([string]$muster) { @(Get-ChildItem -LiteralPath $uninst -ErrorAction SilentlyContinue | ForEach-Object { $x = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue; if ([string]$x.DisplayName -like $muster -and $_.PSChildName -match '^\\{[0-9A-Fa-f-]{36}\\}$') { [string]$_.PSChildName } }) }",
  'function Merker { if (Test-Path -LiteralPath $merk) { [IO.File]::ReadAllText($merk) | ConvertFrom-Json } else { $null } }',
];

/**
 * Ruling R33 — ssms_installieren (ändernd, nur im Change). Lädt nur Fehlendes, prüft jede Datei vor dem Start auf die Microsoft-Signatur,
 * trägt vor jeder Installation in den Merker ein, was dieser Baustein installiert. Ergebnis { neu, vorhanden, odbc, sqlcmd, ssms, … }.
 */
export function ssmsInstallierenSkript(): string {
  return [
    ...kopf({}, false),
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    "if (-not [Environment]::Is64BitOperatingSystem) { throw 'nur 64-Bit-Windows (x64-Pakete) - nichts geändert' }",
    ...SSMS_VOR,
    SIGNIERT_FN,
    `$quellen = @{ odbc = ${psText(SSMS_QUELLEN.odbc)}; sqlcmd = ${psText(SSMS_QUELLEN.sqlcmd)}; ssms = ${psText(SSMS_QUELLEN.ssms)} }`,
    'New-Item -ItemType Directory -Path $dl -Force | Out-Null',
    '$m = Merker',
    '$mm = [ordered]@{ odbc = $(if ($m) { $m.odbc } else { $null }); sqlcmd = $(if ($m) { $m.sqlcmd } else { $null }); ssms = $(if ($m) { $m.ssms } else { $null }); zeit = $null }',
    "function Merken { $mm.zeit = (Get-Date).ToString('s'); [IO.File]::WriteAllText($merk, ($mm | ConvertTo-Json -Depth 5 -Compress), (New-Object System.Text.UTF8Encoding $false)) }",
    '$r = [ordered]@{ rechner = $env:COMPUTERNAME; neu = @(); vorhanden = @(); neustartNoetig = $false; downloads = @() }',
    // Laden: Microsoft-Quelle → Datei → Signatur Microsoft (sonst gelöscht und Abbruch, nichts gestartet)
    `function Laden([string]$teil, [string]$endung) { $f = Join-Path $dl ($teil + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + $endung); for ($v = 1; ; $v++) { try { Invoke-WebRequest -UseBasicParsing -Uri $quellen[$teil] -OutFile $f; break } catch [System.Net.WebException] { if ($v -ge ${SSMS_LADEN_VERSUCHE} -or $_.Exception.Response) { throw }; Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds ${SSMS_LADEN_ABSTAND_S} } }; try { $sig = Signiert $f } catch { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue; throw }; $r.downloads += [ordered]@{ teil = $teil; signatur = $sig; sha256 = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower() }; $f }`,
    "function Msi([string]$f, [string]$lizenz, [string]$teil) { $log = Join-Path $basis ($teil + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log'); $pr = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', ('\"' + $f + '\"'), '/qn', '/norestart', $lizenz, '/L*v', ('\"' + $log + '\"')) -Wait -PassThru; if ($pr.ExitCode -eq 3010) { $r.neustartNoetig = $true } elseif ($pr.ExitCode -ne 0) { throw ($teil + ': msiexec Exit ' + $pr.ExitCode + ' (Protokoll ' + $log + ')') } }",
    // (a) ODBC Driver 18
    'if (-not (Odbc)) {',
    `  $vor = Produkte ${psText(MUSTER_ODBC)}`,
    "  $f = Laden 'odbc' '.msi'",
    '  $mm.odbc = [ordered]@{ produkte = @() }; Merken',
    "  Msi $f 'IACCEPTMSODBCSQLLICENSETERMS=YES' 'odbc'",
    `  $mm.odbc = [ordered]@{ produkte = @(Produkte ${psText(MUSTER_ODBC)} | Where-Object { $vor -notcontains $_ }) }; Merken; $r.neu += 'odbc'`,
    "} else { $r.vorhanden += 'odbc' }",
    // (b) Befehlszeilenwerkzeuge (ODBC-sqlcmd) — an einem der festen Pfade, sonst Abbruch mit dem tatsächlichen Fundort
    'if (-not (SqlcmdFund)) {',
    "  if (-not (Odbc)) { throw 'sqlcmd braucht ODBC Driver 18 - fehlt nach der Installation' }",
    `  $vor = Produkte ${psText(MUSTER_SQLCMD)}`,
    "  $f = Laden 'sqlcmd' '.msi'",
    '  $mm.sqlcmd = [ordered]@{ produkte = @() }; Merken',
    "  Msi $f 'IACCEPTMSSQLCMDLNUTILSLICENSETERMS=YES' 'sqlcmd'",
    `  $mm.sqlcmd = [ordered]@{ produkte = @(Produkte ${psText(MUSTER_SQLCMD)} | Where-Object { $vor -notcontains $_ }) }; Merken; $r.neu += 'sqlcmd'`,
    "  if (-not (SqlcmdFund)) { $wo = @(Get-ChildItem -LiteralPath 'C:\\Program Files\\Microsoft SQL Server' -Recurse -Filter 'SQLCMD.EXE' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }); throw ('Selbstprüfung: sqlcmd nach der Installation nicht an den festen Pfaden (' + ($sqlcmdPfade -join '; ') + ') - gefunden: ' + $(if ($wo.Count) { $wo -join '; ' } else { 'nirgends' })) }",
    "} else { $r.vorhanden += 'sqlcmd' }",
    // (c) SSMS 22 — Bootstrapper still, fester Pfad, wartet bis fertig
    'if (-not (Ssms)) {',
    "  $f = Laden 'ssms' '.exe'",
    '  $mm.ssms = [ordered]@{ installPath = $ssmsPfad }; Merken',
    "  $pr = Start-Process -FilePath $f -ArgumentList @('--installPath', ('\"' + $ssmsPfad + '\"'), '--quiet', '--norestart', '--wait') -Wait -PassThru",
    "  if ($pr.ExitCode -eq 3010) { $r.neustartNoetig = $true } elseif ($pr.ExitCode -ne 0) { $lg = @(Get-ChildItem -LiteralPath $env:TEMP -Filter 'ssms_*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 3 | ForEach-Object { $_.Name }); throw ('ssms: vs_SSMS.exe Exit ' + $pr.ExitCode + ' (Protokolle in %TEMP%: ' + ($lg -join ', ') + ')') }",
    "  $r.neu += 'ssms'",
    "} else { $r.vorhanden += 'ssms' }",
    // Selbstprüfung: alle drei mit belegter Version
    '$o = Odbc; $q = SqlcmdFund; $s = Ssms',
    "$fehlt = @(); if (-not $o -or -not $o.version) { $fehlt += 'ODBC 18' }; if (-not $q -or -not $q.version) { $fehlt += 'sqlcmd' }; if (-not $s -or -not $s.version) { $fehlt += 'SSMS' }",
    "if ($fehlt.Count) { throw ('Selbstprüfung: ' + ($fehlt -join ', ') + ' ohne belegte Version') }",
    '$q.signatur = Signiert $q.pfad',
    '$r.odbc = $o; $r.sqlcmd = $q; $r.ssms = $s',
    'Remove-Item -LiteralPath $dl -Recurse -Force -ErrorAction SilentlyContinue',
    'Ergebnis $r',
  ].join('\n');
}

/**
 * Ruling R33 — Rückweg ssms_entfernen: nimmt nur zurück, was der Merker nennt, in umgekehrter Reihenfolge (SSMS über den Visual Studio
 * Installer, dann Befehlszeilenwerkzeuge, dann ODBC per msiexec /x). Selbstprüfung je Teil (Ssms.exe weg, Produktcodes weg, Treiber-
 * Schlüssel weg — ein stilles msiexec mit Exit 0 kann den Treiber stehen lassen). Der Visual Studio Installer selbst bleibt.
 */
export function ssmsEntfernenSkript(): string {
  return [
    ...kopf({}, false),
    ...SSMS_VOR,
    '$m = Merker',
    '$r = [ordered]@{ rechner = $env:COMPUTERNAME; entfernt = @(); unveraendert = @(); neustartNoetig = $false }',
    "function MsiWeg([string]$teil, $eintrag, [string]$muster) { $codes = @(@($eintrag.produkte) | Where-Object { $_ }); if (-not $codes.Count) { $codes = @(Produkte $muster) }; foreach ($c in $codes) { if (-not (Test-Path -LiteralPath (Join-Path $uninst $c))) { continue }; $pr = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/x', $c, '/qn', '/norestart') -Wait -PassThru; if ($pr.ExitCode -eq 3010) { $r.neustartNoetig = $true } elseif ($pr.ExitCode -ne 0 -and $pr.ExitCode -ne 1605) { throw ($teil + ': msiexec /x ' + $c + ' Exit ' + $pr.ExitCode) } }; $rest = @($codes | Where-Object { Test-Path -LiteralPath (Join-Path $uninst $_) }); if ($rest.Count) { throw ('Selbstprüfung: ' + $teil + ' nach dem Entfernen noch installiert (' + ($rest -join ', ') + ')') } }",
    'if ($m -and $m.ssms) {',
    '  if (Test-Path -LiteralPath $ssmsExe) {',
    "    $setup = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\\Installer\\setup.exe'",
    "    if (-not (Test-Path -LiteralPath $setup)) { throw ('ssms: Visual Studio Installer fehlt (' + $setup + ')') }",
    "    $pr = Start-Process -FilePath $setup -ArgumentList @('uninstall', '--installPath', ('\"' + [string]$m.ssms.installPath + '\"'), '--quiet', '--norestart') -WorkingDirectory $env:TEMP -Wait -PassThru",
    "    if ($pr.ExitCode -eq 3010) { $r.neustartNoetig = $true } elseif ($pr.ExitCode -ne 0) { throw ('ssms: setup.exe uninstall Exit ' + $pr.ExitCode) }",
    '  }',
    "  if (Test-Path -LiteralPath $ssmsExe) { throw ('Selbstprüfung: SSMS nach dem Entfernen noch vorhanden (' + $ssmsExe + ')') }",
    "  $r.entfernt += 'ssms'",
    "} elseif (Ssms) { $r.unveraendert += 'ssms' }",
    `if ($m -and $m.sqlcmd) { MsiWeg 'sqlcmd' $m.sqlcmd ${psText(MUSTER_SQLCMD)}; $r.entfernt += 'sqlcmd' } elseif (SqlcmdFund) { $r.unveraendert += 'sqlcmd' }`,
    'if ($m -and $m.odbc) {',
    `  MsiWeg 'odbc' $m.odbc ${psText(MUSTER_ODBC)}`,
    "  if (Test-Path -LiteralPath $odbcKey) { throw ('Selbstprüfung: ' + $odbcKey + ' nach dem Entfernen noch vorhanden (Abhängigkeit eines anderen Programms?)') }",
    "  $r.entfernt += 'odbc'",
    "} elseif (Odbc) { $r.unveraendert += 'odbc' }",
    'if (Test-Path -LiteralPath $merk) { Remove-Item -LiteralPath $merk -Force }',
    'Ergebnis $r',
  ].join('\n');
}

export interface SsmsInstalliert {
  rechner: string; neu: string[]; vorhanden: string[]; neustartNoetig: boolean;
  /** Ruling R43 (Realfall 2d2c5d5b): version aus den Zahlenteilen der Datei — FileVersion von SSMS 22 lautet „22.12.12412.261 built by: stable“ */
  ssms?: { pfad: string; version: string; dateiVersion?: string; produktVersion?: string } | null;
  sqlcmd?: { pfad: string; version: string; signatur?: string } | null;
  odbc?: { dll: string; version: string } | null;
  downloads?: Array<{ teil: string; signatur: string; sha256?: string }>;
}
const VERSION = /^\d+(\.\d+)+$/;
/** Ruling R33 — feste Ergebniszeile; Erfolg nur, wenn alle drei Versionen belegt sind (zweite Prüfung neben der Selbstprüfung im Skript) */
export function ssmsText(zugang: string, r: SsmsInstalliert): { ok: boolean; text: string } {
  const v = (x?: { version?: string } | null) => String(x?.version ?? '').trim();
  const fehlt = [!VERSION.test(v(r.ssms)) && 'SSMS', !VERSION.test(v(r.sqlcmd)) && 'sqlcmd', !VERSION.test(v(r.odbc)) && 'ODBC 18'].filter((x): x is string => !!x);
  if (fehlt.length) return { ok: false, text: `${zugang}: Selbstprüfung — ${fehlt.join(', ')} ohne belegte Version (SSMS ${v(r.ssms) || '—'}, sqlcmd ${v(r.sqlcmd) || '—'}, ODBC 18 ${v(r.odbc) || '—'})` };
  const neu = r.neu ?? []; const vorhanden = r.vorhanden ?? [];
  const rest = neu.length ? ` — neu: ${neu.join(', ')}${vorhanden.length ? `; vorhanden: ${vorhanden.join(', ')}` : ''}` : ' — alles vorhanden, nichts neu';
  return { ok: true, text: `SSMS_INSTALLIERT ${zugang}: SSMS ${v(r.ssms)}, sqlcmd ${v(r.sqlcmd)}, ODBC 18 ${v(r.odbc)}${rest}${r.neustartNoetig ? ' — Neustart ausstehend (Exit 3010, kein Neustart durch Alfred)' : ''}` };
}
