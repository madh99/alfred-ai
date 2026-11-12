/**
 * I8d (Spec docs/specs/2026-11-01-windows-i8.md, Architektur 3ca3873e v3) — Bausteine für Windows-Failover-Cluster und die
 * Vorbereitung von SQL Server: Datenplatten, Windows-Features, Firewall-Regeln, SMB-Freigaben, gMSA, vorab angelegte Computerobjekte
 * (CNO/VCO), SPNs, Cluster-Validierung, Cluster und Dateifreigabe-Zeuge.
 *
 * Doppel-Hop (Architektur v3: „PASSWORD-Logon-Task, kein S4U/CredSSP“): die SSH-Anmeldung per Schlüssel ist ein S4U-Token ohne
 * Netz-Anmeldedaten (Lehre I8c). Was andere Rechner erreichen muss (Test-Cluster, New-Cluster, Zeuge), läuft als einmalige geplante
 * Aufgabe mit Kennwort-Anmeldung des Domänenkontos <NETBIOS>\alfred: Kennwort nur über die Standardeingabe, Skriptordner nur für SYSTEM
 * und Administratoren, Aufgabe und Dateien werden immer entfernt. Gleiche Form wie windows-ad.ts: Parameter als JSON-Literal, genau eine
 * Ergebniszeile „ALFRED-AD {json}“, Fehler → Exit ≠ 0.
 */
import { IPV4, kopf, psText, neustart, kontoAusdruck } from './windows-ad.js';

const LAUFWERK = /^[BD-Z]$/; // Architektur v3: Sicherungsplatte B:
const NAME_VOLUME = /^[\p{L}\p{N} ._-]{1,32}$/u;
/** Konto im Format NETBIOS\name (Computerkonten und gMSA mit $) */
export const KONTO = /^[A-Za-z0-9][A-Za-z0-9-]{0,14}\\[A-Za-z0-9][A-Za-z0-9 ._-]{0,19}\$?$/;
/** sAMAccountName ohne Domäne (Computer/gMSA mit oder ohne $) */
const SAM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,14}\$?$/;
const COMPUTER = /^[A-Za-z0-9][A-Za-z0-9-]{0,14}$/;
const FREIGABE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}\$?$/;
const PFAD = /^[D-Z]:\\[\p{L}\p{N} ._\\-]{1,200}$/u;
const OU_NAME = /^[\p{L}\p{N} ._-]{1,60}$/u;
const FQDN = /^(?=.{3,120}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;
const SPN = /^[A-Za-z]{2,20}\/[A-Za-z0-9.-]{1,120}(:[0-9]{1,5}|:[A-Za-z0-9_-]{1,40})?$/;
const UNC = /^\\\\[A-Za-z0-9.-]{1,120}\\[A-Za-z0-9_-]{1,40}\$?$/;
const REGEL = /^[\p{L}\p{N} ._-]{1,60}$/u;

/** Erlaubte Windows-Features (Rollen/Werkzeuge für I8d) — alles andere ist ein eigener Auftrag */
export const FEATURES = new Set(['Failover-Clustering', 'RSAT-Clustering-PowerShell', 'RSAT-Clustering-CmdInterface', 'RSAT-AD-PowerShell', 'FS-FileServer', 'NET-Framework-45-Core']);

// ── Ausführung mit Kennwort-Anmeldung (Doppel-Hop) ────────────────────────────────────────────────────────────────────────────────

/**
 * PowerShell-Funktion „MitKonto“ für das äußere Skript: führt $innen (vollständiges Skript, erhält den Ausgabepfad als erstes Argument)
 * als geplante Aufgabe aus — als $benutzer mit $kennwort (Kennwort-Anmeldung, volles Token mit Netz-Anmeldedaten) oder als SYSTEM
 * ($benutzer = 'SYSTEM', Computerkonto im Netz). Ergebnis: das Objekt „wert“ aus der Ausgabedatei; „fehler“ wird zur Ausnahme.
 */
export const MIT_KONTO = [
  'function MitKonto([string]$benutzer, [string]$kennwort, [string]$innen, [int]$sekunden) {',
  "  $id = 'Alfred-' + [guid]::NewGuid().ToString('N').Substring(0, 12)",
  "  $dir = Join-Path $env:ProgramData 'Alfred\\aufgaben'",
  '  New-Item -ItemType Directory -Path $dir -Force | Out-Null',
  '  $acl = New-Object System.Security.AccessControl.DirectorySecurity',
  '  $acl.SetAccessRuleProtection($true, $false)',
  "  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) { $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier $sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }",
  '  Set-Acl -Path $dir -AclObject $acl',
  "  $skript = Join-Path $dir ($id + '.ps1'); $aus = Join-Path $dir ($id + '.json')",
  '  [IO.File]::WriteAllText($skript, $innen, (New-Object System.Text.UTF8Encoding $true))',
  "  $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"' + $skript + '\" \"' + $aus + '\"')",
  "  $s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds ($sekunden + 60)) -MultipleInstances IgnoreNew",
  "  if ($benutzer -eq 'SYSTEM') { Register-ScheduledTask -TaskName $id -TaskPath '\\Alfred\\' -Action $a -Settings $s -User 'SYSTEM' -RunLevel Highest -Force | Out-Null }",
  "  else { Register-ScheduledTask -TaskName $id -TaskPath '\\Alfred\\' -Action $a -Settings $s -User $benutzer -Password $kennwort -RunLevel Highest -Force | Out-Null }",
  '  try {',
  "    Start-ScheduledTask -TaskName $id -TaskPath '\\Alfred\\'",
  '    $bis = (Get-Date).AddSeconds($sekunden)',
  "    do { Start-Sleep -Seconds 3; $t = Get-ScheduledTask -TaskName $id -TaskPath '\\Alfred\\' } while ($t.State -eq 'Running' -and (Get-Date) -lt $bis)",
  "    if ($t.State -eq 'Running') { Stop-ScheduledTask -TaskName $id -TaskPath '\\Alfred\\'; throw ('Aufgabe nach ' + $sekunden + ' s abgebrochen') }",
  "    if (-not (Test-Path $aus)) { $i = Get-ScheduledTaskInfo -TaskName $id -TaskPath '\\Alfred\\'; throw ('Aufgabe ohne Ergebnis (LastTaskResult ' + $i.LastTaskResult + ')') }",
  '    $o = [IO.File]::ReadAllText($aus) | ConvertFrom-Json',
  '    if ($o.fehler) { throw [string]$o.fehler }',
  '    return $o.wert',
  "  } finally { Unregister-ScheduledTask -TaskName $id -TaskPath '\\Alfred\\' -Confirm:$false -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $skript, $aus -Force -ErrorAction SilentlyContinue }",
  '}',
  // NetBIOS-Name der Domäne dieses Mitgliedsservers (das SSH-Konto alfred ist hier lokal)
  "function DomaeneNetbios { $d = @(Get-CimInstance -ClassName Win32_NTDomain | Where-Object { $_.DnsForestName } | Select-Object -First 1); if (-not $d.Count -or -not $d[0].DomainName) { throw 'keiner Domäne beigetreten' }; [string]$d[0].DomainName }",
].join('\n');

/** Inneres Skript für MitKonto: Parameter als JSON-Literal, Rumpf liefert den Wert; Ausgabe als JSON in die Datei aus $args[0] */
export function innenSkript(p: unknown, rumpf: string[]): string {
  return [
    'param([string]$aus)',
    "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'",
    `$p = ${psText(JSON.stringify(p))} | ConvertFrom-Json`,
    'try {',
    '  $wert = @(& {',
    ...rumpf.map(z => `    ${z}`),
    '  })[-1]',
    "  [IO.File]::WriteAllText($aus, (@{ wert = $wert } | ConvertTo-Json -Compress -Depth 8))",
    "} catch { [IO.File]::WriteAllText($aus, (@{ fehler = ($_.Exception.Message + ' (' + $_.InvocationInfo.MyCommand + ')') } | ConvertTo-Json -Compress)) }",
  ].join('\n');
}

/** Domänen-Administrator für AD-Änderungen am DC (wie papierkorbSkript; Kennwort über die Standardeingabe) */
const adCred = "$d = Get-ADDomain; $c = New-Object System.Management.Automation.PSCredential ((" + kontoAusdruck('Administrator', '$d.NetBIOSName') + "), (ConvertTo-SecureString $e.kennwort -AsPlainText -Force))";

// ── Lesen ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ClusterStatus {
  rechner: string; domaene?: string; features: Record<string, boolean>;
  volumes: Array<{ laufwerk: string; name: string; groesseGb: number; freiGb: number; blockKb: number }>;
  freigaben: Array<{ name: string; pfad: string }>;
  cluster?: { name: string; knoten: Array<{ name: string; zustand: string }>; quorum: string; zeuge?: string; ressourcen: Array<{ name: string; typ: string; zustand: string; gruppe: string }> };
  clusterFehler?: string;
}

/** Lesend: Features, Volumes (mit Blockgröße), SMB-Freigaben, Cluster (Knoten, Quorum, Zeuge, Ressourcen) */
export function clusterStatusSkript(): string {
  return [
    ...kopf({}, false),
    '$cs = Get-CimInstance -ClassName Win32_ComputerSystem',
    '$r = [ordered]@{ rechner = $env:COMPUTERNAME; domaene = [string]$cs.Domain; features = [ordered]@{}; volumes = @(); freigaben = @() }',
    `foreach ($f in @(${[...FEATURES].map(psText).join(', ')})) { $w = Get-WindowsFeature -Name $f -ErrorAction SilentlyContinue; $r.features[$f] = [bool]($w -and $w.Installed) }`,
    "foreach ($v in @(Get-CimInstance -ClassName Win32_Volume | Where-Object { $_.DriveLetter -and $_.DriveType -eq 3 })) { $r.volumes += [ordered]@{ laufwerk = ([string]$v.DriveLetter).TrimEnd(':'); name = [string]$v.Label; groesseGb = [math]::Round($v.Capacity / 1GB, 1); freiGb = [math]::Round($v.FreeSpace / 1GB, 1); blockKb = [int]($v.BlockSize / 1024) } }",
    "foreach ($s in @(Get-SmbShare -ErrorAction SilentlyContinue | Where-Object { -not $_.Special -and $_.Name -notin @('ADMIN$', 'IPC$', 'print$') })) { $r.freigaben += [ordered]@{ name = [string]$s.Name; pfad = [string]$s.Path } }",
    'if ($r.features[\'Failover-Clustering\'] -and (Get-Service -Name ClusSvc -ErrorAction SilentlyContinue | Where-Object Status -eq \'Running\')) {',
    '  try {',
    '    Import-Module FailoverClusters',
    '    $cl = Get-Cluster; $q = Get-ClusterQuorum',
    "    $k = [ordered]@{ name = [string]$cl.Name; knoten = @(Get-ClusterNode | ForEach-Object { [ordered]@{ name = [string]$_.Name; zustand = [string]$_.State } }); quorum = [string]$q.QuorumType; ressourcen = @(Get-ClusterResource | ForEach-Object { [ordered]@{ name = [string]$_.Name; typ = [string]$_.ResourceType; zustand = [string]$_.State; gruppe = [string]$_.OwnerGroup } }) }",
    "    if ($q.QuorumResource) { $typ = ([string]$q.QuorumResource.ResourceType) -replace ' ', ''; $k.zeuge = $typ + ' ' + [string]$q.QuorumResource.Name + ' ' + [string]$q.QuorumResource.State; $pa = @(Get-ClusterResource -Name $q.QuorumResource.Name | Get-ClusterParameter -Name SharePath -ErrorAction SilentlyContinue); if ($pa.Count -and $pa[0].Value) { $k.zeuge = $typ + ' ' + [string]$pa[0].Value + ' ' + [string]$q.QuorumResource.State } }",
    // v1798 Realfall F1 229965b1: Server 2025 meldet den Quorumtyp nur als „Majority“ — Zeugentyp (FileShareWitness/CloudWitness/DiskWitness) mit ausgeben
    '    $r.cluster = $k',
    '  } catch { $r.clusterFehler = $_.Exception.Message }',
    '}',
    'Ergebnis $r',
  ].join('\n');
}

export function clusterStatusText(s: ClusterStatus): string {
  const f = Object.entries(s.features ?? {}).filter(([, x]) => x).map(([n]) => n);
  const vol = (s.volumes ?? []).map(v => `${v.laufwerk}: ${v.name || '—'} ${v.groesseGb} GB (${v.blockKb} KB)`);
  const fr = (s.freigaben ?? []).map(x => `${x.name}=${x.pfad}`);
  const c = s.cluster;
  const cl = c ? `Cluster ${c.name}: Knoten ${c.knoten.map(k => `${k.name} ${k.zustand}`).join(', ')}; Quorum ${c.quorum}${c.zeuge ? `, Zeuge ${c.zeuge}` : ''}; Ressourcen ${c.ressourcen.map(x => `${x.name} ${x.zustand}`).join(', ')}` : s.clusterFehler ? `Cluster nicht lesbar: ${s.clusterFehler}` : 'kein Cluster';
  return `${s.rechner}${s.domaene ? ` (${s.domaene})` : ''}: Features ${f.join(', ') || 'keine'}; Volumes ${vol.join(', ') || 'nur C:'}; Freigaben ${fr.join(', ') || 'keine'}; ${cl}`;
}

/** Lesend (SYSTEM = Computerkonto): darf dieser Rechner das Kennwort der gMSA abrufen? Test-ADServiceAccount */
/** v1794 — Realfall 11.11. E 1d741562: Download scheiterte Sekunden nach dem Öffnen der Firewall (Gateway noch nicht provisioniert). */
export const ZIEL_HOST = /^(?=.{3,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;

export function pruefeVerbindung(o: Record<string, unknown>): { ziel: string; port: number; url?: string } | string {
  const ziel = String(o.ziel ?? '').trim().toLowerCase();
  const port = o.port === undefined ? 443 : Number(o.port);
  const url = typeof o.url === 'string' && o.url.trim() ? o.url.trim() : undefined;
  if (!ZIEL_HOST.test(ziel) && !IPV4.test(ziel)) return 'ziel: Hostname oder IPv4, z. B. download.microsoft.com';
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'port: 1–65535 (Standard 443)';
  if (url && (!/^https:\/\/[^\s'"]{3,400}$/.test(url) || new URL(url).hostname.toLowerCase() !== ziel)) return 'url: https-Adresse auf genau diesem ziel (HEAD-Anfrage)';
  return { ziel, port, ...(url ? { url } : {}) };
}

/** Lesend: DNS, TCP-Verbindung (8 s) und optional HTTPS-HEAD vom Windows-Rechner aus — ändert nichts */
export function verbindungSkript(p: { ziel: string; port: number; url?: string }): string {
  return [
    ...kopf(p, false),
    '$r = [ordered]@{ ziel = $p.ziel; port = [int]$p.port; tcp = $false }',
    "try { $r.ip = [string](@([Net.Dns]::GetHostAddresses($p.ziel) | Where-Object { $_.AddressFamily -eq 'InterNetwork' })[0]) } catch { $r.fehler = 'DNS: ' + $_.Exception.InnerException.Message }",
    'if (-not $r.fehler) {',
    '  $c = New-Object System.Net.Sockets.TcpClient; $sw = [Diagnostics.Stopwatch]::StartNew()',
    '  try { $a = $c.BeginConnect($p.ziel, [int]$p.port, $null, $null); if ($a.AsyncWaitHandle.WaitOne(8000) -and $c.Connected) { $c.EndConnect($a); $r.tcp = $true; $r.ms = $sw.ElapsedMilliseconds } else { $r.fehler = \'TCP: keine Verbindung in 8 s\' } } catch { $r.fehler = \'TCP: \' + $_.Exception.InnerException.Message } finally { $c.Close() }',
    '}',
    "if ($r.tcp -and $p.url) { try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $w = Invoke-WebRequest -UseBasicParsing -Method Head -Uri $p.url -TimeoutSec 20; $r.https = [int]$w.StatusCode } catch { $r.https = 0; $r.fehler = 'HTTPS: ' + $_.Exception.Message } }",
    'Ergebnis $r',
  ].join('\n');
}

export function verbindungText(r: { ziel: string; port: number; tcp: boolean; ip?: string; ms?: number; https?: number; fehler?: string }): string {
  const ok = r.tcp && !r.fehler && (r.https === undefined || (r.https >= 200 && r.https < 400));
  return ok ? `Verbindung ${r.ziel}:${r.port} ok (${r.ip ?? '?'}, ${r.ms ?? '?'} ms${r.https !== undefined ? `, HTTPS ${r.https}` : ''})`
    : `Verbindung ${r.ziel}:${r.port} NICHT erreichbar${r.ip ? ` (${r.ip})` : ''}: ${r.fehler ?? `HTTPS ${r.https}`}`;
}

export function gmsaPruefenSkript(p: { name: string }): string {
  const innen = innenSkript(p, [
    'Import-Module ActiveDirectory',
    "$n = $p.name.TrimEnd('$')",
    '[ordered]@{ name = $n; nutzbar = [bool](Test-ADServiceAccount -Identity $n) }',
  ]);
  return [...kopf(p, false), MIT_KONTO, `$w = MitKonto 'SYSTEM' '' ${psText(innen)} 120`, 'Ergebnis $w'].join('\n');
}

// ── Ändern: Platten, Features, Firewall, Freigaben ───────────────────────────────────────────────────────────────────────────────

export interface Platte { groesse_gb: number; laufwerk: string; name: string; block_kb?: number }

export function pruefePlatten(platten: unknown): Platte[] | string {
  if (!Array.isArray(platten) || !platten.length || platten.length > 8) return 'platten: 1–8 Einträge {groesse_gb, laufwerk, name, block_kb 4|64}';
  const l: Platte[] = [];
  for (const x of platten) {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const p: Platte = { groesse_gb: Number(o.groesse_gb), laufwerk: String(o.laufwerk ?? '').trim().toUpperCase(), name: String(o.name ?? '').trim(), block_kb: o.block_kb === undefined ? 4 : Number(o.block_kb) };
    if (!Number.isInteger(p.groesse_gb) || p.groesse_gb < 1 || p.groesse_gb > 8192) return 'platten: groesse_gb ganze Zahl 1–8192';
    if (!LAUFWERK.test(p.laufwerk)) return 'platten: laufwerk ein Buchstabe B oder D–Z';
    if (!NAME_VOLUME.test(p.name)) return 'platten: name = Volumebezeichnung (höchstens 32 Zeichen)';
    if (p.block_kb !== 4 && p.block_kb !== 64) return 'platten: block_kb 4 oder 64 (SQL-Daten/Log/TempDB: 64)';
    l.push(p);
  }
  if (new Set(l.map(p => p.laufwerk)).size !== l.length) return 'platten: Laufwerksbuchstaben doppelt';
  if (new Set(l.map(p => p.groesse_gb)).size !== l.length) return 'platten: Größen müssen verschieden sein (Zuordnung roher Platten über die Größe)';
  return l;
}

/**
 * Datenplatten einrichten: je Eintrag genau eine rohe Platte dieser Größe (±1 GB, nie Platte 0) → GPT, NTFS mit Blockgröße, Bezeichnung,
 * Laufwerksbuchstabe. Belegt ein CD-Laufwerk (Konfigurationslaufwerk) den Buchstaben, bekommt es den letzten freien. Wiederholbar:
 * vorhandenes Volume mit dieser Bezeichnung zählt als „schon“, mit anderer Bezeichnung als Fehler.
 */
export function plattenSkript(p: { platten: Platte[] }): string {
  return [
    ...kopf(p, false),
    '$r = @()',
    'foreach ($x in $p.platten) {',
    "  $lw = $x.laufwerk + ':'",
    "  $cd = @(Get-CimInstance -ClassName Win32_Volume -Filter (\"DriveLetter='\" + $lw + \"'\") | Where-Object { $_.DriveType -eq 5 })",
    "  if ($cd.Count) { $frei = @([char[]](90..68) | ForEach-Object { [string]$_ + ':' } | Where-Object { -not (Test-Path ($_ + '\\')) -and -not (Get-CimInstance -ClassName Win32_Volume -Filter (\"DriveLetter='\" + $_ + \"'\")) -and ($_.Substring(0,1) -notin @($p.platten | ForEach-Object { $_.laufwerk })) } | Select-Object -First 1); if (-not $frei.Count) { throw 'kein freier Buchstabe für das CD-Laufwerk' }; Set-CimInstance -InputObject $cd[0] -Property @{ DriveLetter = $frei[0] } | Out-Null }",
    '  $v = Get-Volume -DriveLetter $x.laufwerk -ErrorAction SilentlyContinue',
    "  if ($v) { if ($v.FileSystemLabel -ne $x.name) { throw ($lw + ' ist schon belegt (' + $v.FileSystemLabel + ')') }; $r += [ordered]@{ laufwerk = $x.laufwerk; zustand = 'schon'; groesseGb = [math]::Round($v.Size / 1GB, 1) }; continue }",
    "  $d = @(Get-Disk | Where-Object { $_.Number -ne 0 -and $_.PartitionStyle -eq 'RAW' -and [math]::Abs($_.Size / 1GB - $x.groesse_gb) -le 1 })",
    "  if ($d.Count -ne 1) { throw ('genau eine rohe Platte mit ' + $x.groesse_gb + ' GB erwartet, gefunden: ' + $d.Count) }",
    '  if ($d[0].IsOffline) { Set-Disk -Number $d[0].Number -IsOffline $false }',
    '  if ($d[0].IsReadOnly) { Set-Disk -Number $d[0].Number -IsReadOnly $false }',
    '  Initialize-Disk -Number $d[0].Number -PartitionStyle GPT | Out-Null',
    '  New-Partition -DiskNumber $d[0].Number -UseMaximumSize -DriveLetter $x.laufwerk | Format-Volume -FileSystem NTFS -AllocationUnitSize ([int]$x.block_kb * 1024) -NewFileSystemLabel $x.name -Confirm:$false | Out-Null',
    '  $v = Get-CimInstance -ClassName Win32_Volume -Filter ("DriveLetter=\'" + $lw + "\'")',
    "  $r += [ordered]@{ laufwerk = $x.laufwerk; zustand = 'neu'; platte = $d[0].Number; groesseGb = [math]::Round($v.Capacity / 1GB, 1); blockKb = [int]($v.BlockSize / 1024) }",
    '}',
    'Ergebnis @{ platten = $r }',
  ].join('\n');
}

export function pruefeFeatures(f: unknown): string[] | string {
  const l = Array.isArray(f) ? f.map(String) : typeof f === 'string' ? f.split(',').map(s => s.trim()).filter(Boolean) : [];
  if (!l.length || l.some(x => !FEATURES.has(x))) return `features: Auswahl aus ${[...FEATURES].join(', ')}`;
  return l;
}

/** Windows-Features installieren; braucht Windows einen Neustart, startet das Skript ihn (der Skill wartet danach) */
/**
 * v1791 — Realfall 11.11. fs01 (I8d B): Platte in Proxmox 100 GB, C: nur 63 GB. Windows-Setup legt die Wiederherstellungspartition
 * (WinRE) HINTER C: an; Cloudbase-Init (ExtendVolumesPlugin) kann C: deshalb nicht vergrößern (SizeMax = aktuelle Größe). Ablauf:
 * Speicher neu einlesen; ist Platz direkt hinter C:, nur vergrößern. Sonst — genau eine Wiederherstellungspartition hinter C: und
 * dahinter freier Platz — WinRE nach C: zurücklegen (reagentc /disable kopiert winre.wim nach C:\Windows\System32\Recovery),
 * nur diese Partition entfernen, C: auf das Maximum vergrößern, WinRE wieder einschalten (liegt dann auf C:). Andere Partitionen
 * und Daten werden nie angefasst; ohne freien Platz geschieht nichts.
 */
export function systemplatteSkript(): string {
  return [
    ...kopf({}, false),
    'Update-HostStorageCache',
    "$c = Get-Partition -DriveLetter C; $vorher = [math]::Round($c.Size / 1GB, 1); $r = [ordered]@{ vorherGb = $vorher; winre = '' }",
    '$max = (Get-PartitionSupportedSize -DriveLetter C).SizeMax',
    "if ($max - $c.Size -gt 1GB) { Resize-Partition -DriveLetter C -Size $max; $r.zustand = 'vergrößert' }",
    'else {',
    '  $d = Get-Disk -Number $c.DiskNumber',
    '  $teile = @(Get-Partition -DiskNumber $c.DiskNumber | Sort-Object Offset)',
    '  $hinter = @($teile | Where-Object { $_.Offset -gt $c.Offset })',
    '  $letzte = $teile[-1]',
    '  $frei = $d.Size - ($letzte.Offset + $letzte.Size)',
    "  if ($frei -lt 1GB) { $r.zustand = 'schon voll' }",
    "  elseif ($hinter.Count -ne 1 -or $hinter[0].Type -ne 'Recovery') { throw ('hinter C: liegt nicht genau eine Wiederherstellungspartition (' + (($hinter | ForEach-Object { [string]$_.PartitionNumber + ':' + [string]$_.Type }) -join ', ') + ') — nichts geändert') }",
    '  else {',
    "    $aus = & reagentc.exe /disable 2>&1 | Out-String; if ($LASTEXITCODE -ne 0) { throw ('reagentc /disable Exit ' + $LASTEXITCODE + ': ' + $aus.Trim()) }",
    "    if (-not (Test-Path 'C:\\Windows\\System32\\Recovery\\winre.wim')) { & reagentc.exe /enable | Out-Null; throw 'winre.wim nach reagentc /disable nicht auf C: — Wiederherstellungspartition bleibt' }",
    '    Remove-Partition -DiskNumber $c.DiskNumber -PartitionNumber $hinter[0].PartitionNumber -Confirm:$false',
    '    $max = (Get-PartitionSupportedSize -DriveLetter C).SizeMax',
    '    Resize-Partition -DriveLetter C -Size $max',
    "    $aus = & reagentc.exe /enable 2>&1 | Out-String; $r.winreEin = ($LASTEXITCODE -eq 0)",
    "    $r.zustand = 'vergrößert (Wiederherstellungspartition entfernt, WinRE auf C:)'",
    '  }',
    '}',
    "$info = & reagentc.exe /info 2>&1 | Out-String; $m = [regex]::Match($info, '(?im)^\\s*Windows RE (status|Status):\\s*(\\S+)'); $r.winre = $(if ($m.Success) { $m.Groups[2].Value } else { '?' })",
    "$r.nachherGb = [math]::Round((Get-Partition -DriveLetter C).Size / 1GB, 1); $r.freiGb = [math]::Round((Get-Volume -DriveLetter C).SizeRemaining / 1GB, 1)",
    'Ergebnis $r',
  ].join('\n');
}

export function featuresSkript(p: { features: string[] }): string {
  return [
    ...kopf(p, false),
    '$x = Install-WindowsFeature -Name @($p.features) -IncludeManagementTools',
    "if (-not $x.Success) { throw ('Install-WindowsFeature ohne Erfolg: ' + [string]$x.ExitCode) }",
    "$neu = [string]$x.RestartNeeded -eq 'Yes'",
    `if ($neu) { ${neustart('Windows-Features (I8d)')} }`,
    "Ergebnis @{ installiert = @($x.FeatureResult | ForEach-Object { [string]$_.Name }); neustart = $neu; exitCode = [string]$x.ExitCode }",
  ].join('\n');
}

export interface FirewallRegel { name: string; protokoll: 'TCP' | 'UDP' | 'ICMPv4'; ports: string[]; von: string[] }

export function pruefeFirewall(o: Record<string, unknown>): FirewallRegel | string {
  const name = String(o.name ?? '').trim();
  const protokoll = String(o.protokoll ?? '').trim().toUpperCase().replace('ICMPV4', 'ICMPv4') as FirewallRegel['protokoll'];
  const liste = (v: unknown) => (Array.isArray(v) ? v.map(x => String(x).trim()) : typeof v === 'string' ? v.split(',').map(s => s.trim()) : []).filter(Boolean);
  const ports = liste(o.ports); const von = liste(o.von);
  if (!REGEL.test(name)) return 'name: Regelname (Buchstaben, Ziffern, Leerzeichen, . _ -), Alfred stellt „Alfred “ voran';
  if (!['TCP', 'UDP', 'ICMPv4'].includes(protokoll)) return 'protokoll: TCP, UDP oder ICMPv4';
  if (protokoll === 'ICMPv4' ? ports.length > 0 : (!ports.length || ports.length > 20 || ports.some(x => !/^\d{1,5}(-\d{1,5})?$/.test(x) || x.split('-').some(n => Number(n) < 1 || Number(n) > 65535)))) return protokoll === 'ICMPv4' ? 'ports: bei ICMPv4 keine' : 'ports: 1–20 Ports oder Bereiche (z. B. 1433, 49152-65535)';
  if (!von.length || von.length > 16 || von.some(x => !IPV4.test(x.split('/')[0]!) || (x.includes('/') && !/^\d{1,2}$/.test(x.split('/')[1]!)))) return 'von: 1–16 IPv4-Adressen oder Netze (exakte Gegenstellen, nie „Any“)';
  return { name, protokoll, ports, von };
}

/** Eingehende Regel „Alfred <name>“ (Profil Any, nur die genannten Gegenstellen); vorhandene gleichnamige Regel wird ersetzt */
export function firewallSkript(p: FirewallRegel): string {
  return [
    ...kopf(p, false),
    "$id = 'Alfred-' + ($p.name -replace '[^A-Za-z0-9._-]', '-')",
    '$alt = Get-NetFirewallRule -Name $id -ErrorAction SilentlyContinue',
    'if ($alt) { Remove-NetFirewallRule -Name $id }',
    "$a = @{ Name = $id; DisplayName = ('Alfred ' + $p.name); Direction = 'Inbound'; Action = 'Allow'; Profile = 'Any'; Protocol = $p.protokoll; RemoteAddress = @($p.von); Description = 'Alfred I8d' }",
    "if ($p.protokoll -eq 'ICMPv4') { $a.IcmpType = '8' } else { $a.LocalPort = @($p.ports) }",
    'New-NetFirewallRule @a | Out-Null',
    "Ergebnis @{ regel = $id; zustand = $(if ($alt) { 'ersetzt' } else { 'neu' }) }",
  ].join('\n');
}

/** Entfernt nur Regeln, die Alfred angelegt hat (Name „Alfred-…“) */
export function firewallEntfernenSkript(p: { name: string }): string {
  return [
    ...kopf(p, false),
    "$id = 'Alfred-' + ($p.name -replace '[^A-Za-z0-9._-]', '-')",
    "if (Get-NetFirewallRule -Name $id -ErrorAction SilentlyContinue) { Remove-NetFirewallRule -Name $id; $z = 'entfernt' } else { $z = 'nicht vorhanden' }",
    'Ergebnis @{ regel = $id; zustand = $z }',
  ].join('\n');
}

export interface Freigabe { name: string; pfad: string; vollzugriff: string[]; aendern: string[] }

export function pruefeFreigabe(o: Record<string, unknown>): Freigabe | string {
  const liste = (v: unknown) => (Array.isArray(v) ? v.map(x => String(x).trim()) : typeof v === 'string' ? v.split(',').map(s => s.trim()) : []).filter(Boolean);
  const p: Freigabe = { name: String(o.name ?? '').trim(), pfad: String(o.pfad ?? '').trim(), vollzugriff: liste(o.vollzugriff), aendern: liste(o.aendern) };
  if (!FREIGABE.test(p.name)) return 'name: Freigabename (Buchstaben, Ziffern, _ -, optional $ am Ende für versteckt)';
  if (!PFAD.test(p.pfad) || p.pfad.includes('..')) return 'pfad: Ordner auf einer Datenplatte, z. B. S:\\SQLBackup (nie C:)';
  if (!p.vollzugriff.length && !p.aendern.length) return 'vollzugriff/aendern: mindestens ein Konto (NETBIOS\\name, Computer/gMSA mit $)';
  if ([...p.vollzugriff, ...p.aendern].some(k => !KONTO.test(k))) return 'Konten im Format NETBIOS\\name (z. B. AD3033\\SQLCL01$, AD3033\\gmsa-sqleng$)';
  if (p.vollzugriff.length + p.aendern.length > 12) return 'höchstens 12 Konten';
  return p;
}

/**
 * SMB-Freigabe mit eigenem NTFS-Schutz: Vererbung aus, SYSTEM und Administratoren Vollzugriff, sonst nur die genannten Konten
 * (vollzugriff = FullControl, aendern = Modify) — Freigabe- und NTFS-Rechte gleich. Wiederholbar: Rechte werden neu gesetzt.
 */
export function freigabeSkript(p: Freigabe): string {
  return [
    ...kopf(p, false),
    'New-Item -ItemType Directory -Path $p.pfad -Force | Out-Null',
    '$acl = New-Object System.Security.AccessControl.DirectorySecurity',
    '$acl.SetAccessRuleProtection($true, $false)',
    "function Recht($wer, $was) { $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($wer, $was, 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }",
    "Recht (New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18') 'FullControl'",
    "Recht (New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-544') 'FullControl'",
    "foreach ($k in @($p.vollzugriff)) { Recht (New-Object System.Security.Principal.NTAccount $k) 'FullControl' }",
    "foreach ($k in @($p.aendern)) { Recht (New-Object System.Security.Principal.NTAccount $k) 'Modify' }",
    'Set-Acl -Path $p.pfad -AclObject $acl',
    '$s = Get-SmbShare -Name $p.name -ErrorAction SilentlyContinue',
    "if ($s -and $s.Path -ne $p.pfad) { throw ('Freigabe ' + $p.name + ' zeigt schon auf ' + $s.Path) }",
    "$voll = @('BUILTIN\\Administrators') + @($p.vollzugriff)",
    'if (-not $s) {',
    "  $a = @{ Name = $p.name; Path = $p.pfad; FullAccess = $voll; FolderEnumerationMode = 'AccessBased'; Description = 'Alfred I8d' }",
    '  if (@($p.aendern).Count) { $a.ChangeAccess = @($p.aendern) }',
    "  New-SmbShare @a | Out-Null; $z = 'neu'",
    '} else {',
    "  foreach ($x in @(Get-SmbShareAccess -Name $p.name)) { Revoke-SmbShareAccess -Name $p.name -AccountName $x.AccountName -Force | Out-Null }",
    "  Grant-SmbShareAccess -Name $p.name -AccountName $voll -AccessRight Full -Force | Out-Null",
    "  if (@($p.aendern).Count) { Grant-SmbShareAccess -Name $p.name -AccountName @($p.aendern) -AccessRight Change -Force | Out-Null }",
    "  $z = 'Rechte erneuert'",
    '}',
    "$unc = '\\\\' + $env:COMPUTERNAME.ToLower() + '.' + (Get-CimInstance -ClassName Win32_ComputerSystem).Domain + '\\' + $p.name",
    "Ergebnis @{ freigabe = $p.name; pfad = $p.pfad; unc = $unc; zustand = $z; rechte = @(Get-SmbShareAccess -Name $p.name | ForEach-Object { [string]$_.AccountName + ':' + [string]$_.AccessRight }) }",
  ].join('\n');
}

/** Entfernt nur die Freigabe, nie den Ordner und seine Daten */
export function freigabeEntfernenSkript(p: { name: string }): string {
  return [
    ...kopf(p, false),
    "if (Get-SmbShare -Name $p.name -ErrorAction SilentlyContinue) { Remove-SmbShare -Name $p.name -Force; $z = 'entfernt (Ordner und Daten bleiben)' } else { $z = 'nicht vorhanden' }",
    'Ergebnis @{ freigabe = $p.name; zustand = $z }',
  ].join('\n');
}

// ── Ändern: Active Directory (am DC, mit dem Domänen-Administrator) ───────────────────────────────────────────────────────────────

export function pruefeGmsa(o: Record<string, unknown>): { name: string; ou: string; berechtigte: string[] } | string {
  const name = String(o.name ?? '').trim().replace(/\$$/, '');
  const ou = String(o.ou ?? 'Dienstkonten').trim();
  const berechtigte = (Array.isArray(o.berechtigte) ? o.berechtigte.map(String) : typeof o.berechtigte === 'string' ? o.berechtigte.split(',') : []).map(s => s.trim().replace(/\$$/, '')).filter(Boolean);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,13}$/.test(name)) return 'name: gMSA-Name höchstens 14 Zeichen (ohne $), z. B. gmsa-sqleng';
  if (!OU_NAME.test(ou)) return 'ou: OU direkt unter der Domäne (Standard Dienstkonten)';
  if (!berechtigte.length || berechtigte.length > 8 || berechtigte.some(b => !COMPUTER.test(b))) return 'berechtigte: 1–8 Computernamen, die das Kennwort abrufen dürfen (z. B. sql01, sql02)';
  return { name, ou, berechtigte };
}

/** gMSA anlegen bzw. die berechtigten Computer genau auf die Liste setzen (wiederholbar) */
export function gmsaSkript(p: { name: string; ou: string; berechtigte: string[] }): string {
  return [
    ...kopf(p, true),
    'Import-Module ActiveDirectory',
    adCred,
    "$pfad = 'OU=' + $p.ou + ',' + $d.DistinguishedName",
    "$wer = @($p.berechtigte | ForEach-Object { Get-ADComputer -Identity $_ -Credential $c })",
    "$g = Get-ADServiceAccount -Filter (\"SamAccountName -eq '\" + $p.name + \"$'\") -Credential $c",
    "if (-not $g) { New-ADServiceAccount -Name $p.name -DNSHostName ($p.name + '.' + $d.DNSRoot) -Path $pfad -PrincipalsAllowedToRetrieveManagedPassword $wer -KerberosEncryptionType AES128,AES256 -Description 'Alfred I8d' -Credential $c; $z = 'neu' }",
    "else { Set-ADServiceAccount -Identity $g -PrincipalsAllowedToRetrieveManagedPassword $wer -Credential $c; $z = 'Berechtigte gesetzt' }",
    "$g = Get-ADServiceAccount -Identity ($p.name + '$') -Properties PrincipalsAllowedToRetrieveManagedPassword -Credential $c",
    "Ergebnis @{ name = ($d.NetBIOSName + '\\' + $p.name + '$'); zustand = $z; berechtigte = @($g.PrincipalsAllowedToRetrieveManagedPassword | ForEach-Object { ($_ -split ',')[0] -replace '^CN=', '' }) }",
  ].join('\n');
}

/** Entfernt nur eine von Alfred angelegte gMSA (Beschreibung „Alfred I8d“) */
export function gmsaEntfernenSkript(p: { name: string }): string {
  return [
    ...kopf(p, true),
    'Import-Module ActiveDirectory',
    adCred,
    "$g = Get-ADServiceAccount -Filter (\"SamAccountName -eq '\" + $p.name + \"$'\") -Properties Description -Credential $c",
    "if (-not $g) { $z = 'nicht vorhanden' } elseif ($g.Description -ne 'Alfred I8d') { throw ('gMSA ' + $p.name + ' ist nicht von Alfred angelegt') } else { Remove-ADServiceAccount -Identity $g -Confirm:$false -Credential $c; $z = 'entfernt' }",
    'Ergebnis @{ name = $p.name; zustand = $z }',
  ].join('\n');
}

export function pruefeComputerobjekt(o: Record<string, unknown>): { name: string; ou: string; vollzugriff: string[] } | string {
  const name = String(o.name ?? '').trim();
  const ou = String(o.ou ?? 'Server').trim();
  const vollzugriff = (Array.isArray(o.vollzugriff) ? o.vollzugriff.map(String) : typeof o.vollzugriff === 'string' ? o.vollzugriff.split(',') : []).map(s => s.trim()).filter(Boolean);
  if (!COMPUTER.test(name)) return 'name: Computername höchstens 15 Zeichen (CNO z. B. sqlcl01, VCO/Listener z. B. sqlag01)';
  if (!OU_NAME.test(ou)) return 'ou: OU direkt unter der Domäne (Standard Server)';
  if (vollzugriff.length > 6 || vollzugriff.some(k => !SAM.test(k))) return 'vollzugriff: bis 6 sAMAccountNames, die das Objekt verwalten dürfen (z. B. alfred, sqlcl01$)';
  return { name, ou, vollzugriff };
}

/**
 * CNO/VCO vorab anlegen (deaktiviert, Beschreibung „Alfred I8d“) und genau den genannten Konten Vollzugriff auf DIESES Objekt geben —
 * keine OU-weiten Rechte (Architektur v3: „CNO/VCO prestage objektgenau“). Wiederholbar.
 */
export function computerobjektSkript(p: { name: string; ou: string; vollzugriff: string[] }): string {
  return [
    ...kopf(p, true),
    'Import-Module ActiveDirectory',
    adCred,
    "$pfad = 'OU=' + $p.ou + ',' + $d.DistinguishedName",
    "$o = Get-ADComputer -Filter (\"SamAccountName -eq '\" + $p.name + \"$'\") -Properties Description, Enabled -Credential $c",
    "if (-not $o) { New-ADComputer -Name $p.name -SamAccountName ($p.name + '$') -Path $pfad -Enabled $false -Description 'Alfred I8d' -Credential $c; $o = Get-ADComputer -Identity ($p.name + '$') -Properties Description, Enabled -Credential $c; $z = 'neu (deaktiviert)' } else { $z = 'schon' + $(if ($o.Enabled) { ' (aktiv)' } else { ' (deaktiviert)' }) }",
    '$rechte = @()',
    'if (@($p.vollzugriff).Count) {',
    "  $de = New-Object System.DirectoryServices.DirectoryEntry(('LDAP://' + $d.PDCEmulator + '/' + $o.DistinguishedName), $c.UserName, $c.GetNetworkCredential().Password)",
    '  if ($de.psbase.Options) { $de.psbase.Options.SecurityMasks = [System.DirectoryServices.SecurityMasks]::Dacl }',
    '  foreach ($k in @($p.vollzugriff)) {',
    "    $sid = (Get-ADObject -Filter (\"SamAccountName -eq '\" + $k + \"'\") -Properties objectSid -Credential $c).objectSid",
    "    if (-not $sid) { throw ('Konto ' + $k + ' nicht gefunden') }",
    "    $de.psbase.ObjectSecurity.AddAccessRule((New-Object System.DirectoryServices.ActiveDirectoryAccessRule($sid, 'GenericAll', 'Allow')))",
    '    $rechte += $k',
    '  }',
    '  $de.psbase.CommitChanges()',
    '}',
    "Ergebnis @{ name = $p.name; dn = [string]$o.DistinguishedName; zustand = $z; vollzugriff = $rechte }",
  ].join('\n');
}

/** Entfernt nur ein von Alfred vorab angelegtes, weiterhin deaktiviertes Computerobjekt (ein Cluster nutzt es dann nicht) */
export function computerobjektEntfernenSkript(p: { name: string }): string {
  return [
    ...kopf(p, true),
    'Import-Module ActiveDirectory',
    adCred,
    "$o = Get-ADComputer -Filter (\"SamAccountName -eq '\" + $p.name + \"$'\") -Properties Description, Enabled -Credential $c",
    "if (-not $o) { $z = 'nicht vorhanden' } elseif ($o.Description -ne 'Alfred I8d') { throw ($p.name + ' ist nicht von Alfred vorab angelegt') } elseif ($o.Enabled) { throw ($p.name + ' ist aktiv (vom Cluster benutzt) — erst den Cluster bzw. Listener entfernen') } else { Remove-ADComputer -Identity $o -Confirm:$false -Credential $c; $z = 'entfernt' }",
    'Ergebnis @{ name = $p.name; zustand = $z }',
  ].join('\n');
}

export function pruefeSpn(o: Record<string, unknown>): { konto: string; spns: string[] } | string {
  const konto = String(o.konto ?? '').trim();
  const spns = (Array.isArray(o.spns) ? o.spns.map(String) : typeof o.spns === 'string' ? o.spns.split(',') : []).map(s => s.trim()).filter(Boolean);
  if (!SAM.test(konto)) return 'konto: sAMAccountName (gMSA/Computer mit $), z. B. gmsa-sqleng$';
  if (!spns.length || spns.length > 8 || spns.some(s => !SPN.test(s))) return 'spns: 1–8 SPNs wie MSSQLSvc/sql01.ad.3033.at:1433';
  return { konto, spns };
}

/** SPNs an genau einem Konto setzen; ein SPN, der schon an einem ANDEREN Konto hängt, bricht ab (Kerberos-Dublette) */
export function spnSkript(p: { konto: string; spns: string[] }, entfernen = false): string {
  return [
    ...kopf(p, true),
    'Import-Module ActiveDirectory',
    adCred,
    "$o = Get-ADObject -Filter (\"SamAccountName -eq '\" + $p.konto + \"'\") -Properties servicePrincipalName -Credential $c",
    "if (-not $o) { throw ('Konto ' + $p.konto + ' nicht gefunden') }",
    '$neu = @(); $schon = @()',
    'foreach ($s in @($p.spns)) {',
    ...(entfernen
      ? ["  if (@($o.servicePrincipalName) -contains $s) { Set-ADObject -Identity $o -Remove @{ servicePrincipalName = $s } -Credential $c; $neu += $s } else { $schon += $s }"]
      : [
        "  $andere = @(Get-ADObject -LDAPFilter ('(servicePrincipalName=' + $s + ')') -Credential $c | Where-Object { $_.ObjectGUID -ne $o.ObjectGUID })",
        "  if ($andere.Count) { throw ('SPN ' + $s + ' hängt schon an ' + $andere[0].DistinguishedName) }",
        '  if (@($o.servicePrincipalName) -contains $s) { $schon += $s } else { Set-ADObject -Identity $o -Add @{ servicePrincipalName = $s } -Credential $c; $neu += $s }',
      ]),
    '}',
    "$o = Get-ADObject -Identity $o.ObjectGUID -Properties servicePrincipalName -Credential $c",
    `Ergebnis @{ konto = $p.konto; ${entfernen ? 'entfernt' : 'neu'} = $neu; ${entfernen ? 'nichtVorhanden' : 'schon'} = $schon; spns = @($o.servicePrincipalName) }`,
  ].join('\n');
}

// ── Ändern: Cluster (Kennwort-Anmeldung als <NETBIOS>\alfred) ─────────────────────────────────────────────────────────────────────

export function pruefeKnoten(k: unknown): string[] | string {
  const l = (Array.isArray(k) ? k.map(String) : typeof k === 'string' ? k.split(',') : []).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (l.length < 2 || l.length > 4 || l.some(x => !COMPUTER.test(x)) || new Set(l).size !== l.length) return 'knoten: 2–4 verschiedene Computernamen (z. B. sql01, sql02)';
  return l;
}

/** Skript mit Kennwort-Anmeldung als <NETBIOS>\alfred (Kennwort aus der Standardeingabe) */
export function alsDomaenenkonto(p: unknown, rumpf: string[], sekunden: number): string {
  return [...kopf(p, true), MIT_KONTO, "$nb = DomaeneNetbios", `$w = MitKonto (${kontoAusdruck('alfred', '$nb')}) $e.kennwort ${psText(innenSkript(p, rumpf))} ${sekunden}`, 'Ergebnis $w'].join('\n');
}

/**
 * Test-Cluster über alle Knoten (ohne Speicher-Tests — der Cluster hat keinen gemeinsamen Speicher). Ergebnis aus den Warnungen und
 * dem Bericht: „bestanden“, „Warnungen“ oder „fehlgeschlagen“, dazu die Warnzeilen und der Berichtspfad.
 */
export function validierenSkript(p: { knoten: string[] }): string {
  return alsDomaenenkonto(p, [
    'Import-Module FailoverClusters',
    "$bericht = Join-Path $env:ProgramData ('Alfred\\Cluster-Validierung-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))",
    "$f = Test-Cluster -Node @($p.knoten) -Include 'Inventory', 'Network', 'System Configuration' -ReportName $bericht -WarningVariable wv -WarningAction SilentlyContinue",
    "$html = if (Test-Path ($bericht + '.htm')) { [IO.File]::ReadAllText($bericht + '.htm') } else { '' }",
    '$warn = @($wv | ForEach-Object { [string]$_ })',
    "$alles = ($warn -join ' ') + ' ' + $html",
    "$e = if ($alles -match 'ClusterNotApproved|not suitable for clustering|Validation failed') { 'fehlgeschlagen' } elseif ($alles -match 'ConditionallyApproved' -or $warn.Count) { 'Warnungen' } else { 'bestanden' }",
    "[ordered]@{ ergebnis = $e; warnungen = @($warn | Select-Object -First 12); bericht = ($bericht + '.htm') }",
  ], 1800);
}

/** Cluster ohne Speicher mit fester IP anlegen (CNO vorab angelegt oder neu). Wiederholbar: gibt es den Cluster schon, nichts tun. */
export function clusterAnlegenSkript(p: { name: string; knoten: string[]; ip: string }): string {
  return alsDomaenenkonto(p, [
    'Import-Module FailoverClusters',
    "$alt = $null; try { $alt = Get-Cluster -ErrorAction Stop } catch { }",
    "if ($alt) { if ($alt.Name -ine $p.name) { throw ('Knoten gehört schon zum Cluster ' + $alt.Name) }; return [ordered]@{ name = [string]$alt.Name; zustand = 'schon'; knoten = @(Get-ClusterNode | ForEach-Object { [string]$_.Name + ' ' + [string]$_.State }) } }",
    'New-Cluster -Name $p.name -Node @($p.knoten) -StaticAddress $p.ip -NoStorage -AdministrativeAccessPoint ActiveDirectoryAndDns -WarningAction SilentlyContinue | Out-Null',
    "[ordered]@{ name = $p.name; zustand = 'neu'; ip = $p.ip; knoten = @(Get-ClusterNode | ForEach-Object { [string]$_.Name + ' ' + [string]$_.State }) }",
  ], 1200);
}

/** Cluster auflösen (Rückweg). Computerobjekte bleiben (deaktiviert) im AD — Entfernen ist ein eigener Schritt. */
export function clusterEntfernenSkript(p: { name: string }): string {
  return alsDomaenenkonto(p, [
    'Import-Module FailoverClusters',
    "$alt = $null; try { $alt = Get-Cluster -ErrorAction Stop } catch { }",
    "if (-not $alt) { return [ordered]@{ name = $p.name; zustand = 'nicht vorhanden' } }",
    "if ($alt.Name -ine $p.name) { throw ('Knoten gehört zum Cluster ' + $alt.Name + ', nicht ' + $p.name) }",
    'Remove-Cluster -Cluster $p.name -Force -WarningAction SilentlyContinue',
    "[ordered]@{ name = $p.name; zustand = 'aufgelöst' }",
  ], 900);
}

/** Dateifreigabe-Zeuge setzen (oder ohne_zeuge → Knotenmehrheit); Ergebnis nennt den vorherigen Zustand für den Rückweg */
export function zeugeSkript(p: { freigabe?: string }): string {
  return alsDomaenenkonto(p, [
    'Import-Module FailoverClusters',
    '$q = Get-ClusterQuorum',
    "$vorher = [string]$q.QuorumType; $vorherPfad = ''",
    "if ($q.QuorumResource) { $pa = @(Get-ClusterResource -Name $q.QuorumResource.Name | Get-ClusterParameter -Name SharePath -ErrorAction SilentlyContinue); if ($pa.Count) { $vorherPfad = [string]$pa[0].Value } }",
    "if ($p.freigabe) { Set-ClusterQuorum -FileShareWitness $p.freigabe | Out-Null } else { Set-ClusterQuorum -NoWitness | Out-Null }",
    '$q = Get-ClusterQuorum',
    "$nachher = [string]$q.QuorumType + $(if ($q.QuorumResource) { ' ' + [string]$q.QuorumResource.State } else { '' })",
    "[ordered]@{ vorher = $vorher; vorherFreigabe = $vorherPfad; nachher = $nachher; freigabe = [string]$p.freigabe }",
  ], 600);
}

export function pruefeCluster(o: Record<string, unknown>): { name: string; knoten: string[]; ip: string } | string {
  const name = String(o.name ?? '').trim().toLowerCase();
  if (!COMPUTER.test(name)) return 'name: Clustername (CNO) höchstens 15 Zeichen, z. B. sqlcl01';
  const knoten = pruefeKnoten(o.knoten); if (typeof knoten === 'string') return knoten;
  const ip = String(o.ip ?? '').trim();
  if (!IPV4.test(ip)) return 'ip: feste IPv4 des Clusters (z. B. 10.203.30.4)';
  return { name, knoten, ip };
}

export function pruefeZeuge(o: Record<string, unknown>): { freigabe?: string } | string {
  if (o.ohne_zeuge === true) return {};
  const f = String(o.freigabe ?? '').trim();
  if (!UNC.test(f)) return 'freigabe: UNC-Pfad der Zeugen-Freigabe, z. B. \\\\fs01.ad.3033.at\\Witness$ (oder ohne_zeuge: true)';
  return { freigabe: f };
}

export { FQDN };

// ── v1806 Nachpflege I8d: lesende Erhebung + eng begrenzte Änderungen (Realfall 12.11.: Lese-Käfig sperrte Get-NetFirewallAddressFilter,
// setspn und Get-ChildItem für die Planung von I8d-G/H) ─────────────────────────────────────────────────────────────────────────────

/** Eingehende, aktive Erlauben-Regeln mit Protokoll, lokalen Ports und Gegenstellen (nur_any: nur RemoteAddress Any) */
export function firewallLesenSkript(p: { nur_any?: boolean }): string {
  return [
    ...kopf(p, false),
    '$pf = @{}; foreach ($x in @(Get-NetFirewallPortFilter -All)) { $pf[[string]$x.InstanceID] = $x }',
    '$af = @{}; foreach ($x in @(Get-NetFirewallAddressFilter -All)) { $af[[string]$x.InstanceID] = $x }',
    '$l = New-Object System.Collections.ArrayList',
    'foreach ($r in @(Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow)) {',
    '  $id = [string]$r.InstanceID; $a = $af[$id]; $q = $pf[$id]; $ra = (@($a.RemoteAddress) | ForEach-Object { [string]$_ }) -join \',\'',
    "  if ($p.nur_any -and $ra -ne 'Any') { continue }",
    '  [void]$l.Add([ordered]@{ regel = [string]$r.Name; anzeige = [string]$r.DisplayName; gruppe = [string]$r.DisplayGroup; profil = [string]$r.Profile; protokoll = [string]$q.Protocol; ports = ((@($q.LocalPort) | ForEach-Object { [string]$_ }) -join \',\'); von = $ra })',
    '}',
    'Ergebnis ([ordered]@{ rechner = $env:COMPUTERNAME; anzahl = $l.Count; regeln = @($l) })',
  ].join('\n');
}

export interface FirewallLesen { rechner: string; anzahl: number; regeln: { regel: string; anzeige: string; gruppe: string; profil: string; protokoll: string; ports: string; von: string }[] }

export function firewallLesenText(r: FirewallLesen, nurAny: boolean): string {
  const z = (r.regeln ?? []).map(x => `${x.anzeige} [${x.regel}] ${x.protokoll || 'Any'} ${x.ports || 'Any'} von ${x.von || 'Any'}${x.gruppe ? ` (${x.gruppe})` : ''}`);
  return `${r.rechner}: ${r.anzahl} aktive eingehende Erlauben-Regeln${nurAny ? ' mit Gegenstelle Any' : ''}${z.length ? `:\n${z.slice(0, 200).join('\n')}${z.length > 200 ? `\n… ${z.length - 200} weitere (vollständig in data)` : ''}` : ''}`;
}

const SAM_KONTO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}\$?$/;
export function pruefeSamKonto(k: unknown): string | { konto: string } {
  const konto = String(k ?? '').trim();
  return SAM_KONTO.test(konto) ? { konto } : 'konto: sAMAccountName, z. B. gmsa-sqleng$ oder sql01$';
}

/** servicePrincipalName eines Kontos lesen — als SYSTEM (Computerkonto liest AD; das SSH-Token hat keine Netz-Anmeldedaten) */
export function spnLesenSkript(p: { konto: string }): string {
  const innen = innenSkript(p, [
    '$s = New-Object System.DirectoryServices.DirectorySearcher',
    "$s.Filter = '(sAMAccountName=' + $p.konto + ')'",
    "[void]$s.PropertiesToLoad.Add('servicePrincipalName'); [void]$s.PropertiesToLoad.Add('distinguishedName')",
    '$e = $s.FindOne()',
    "if (-not $e) { throw ('Konto ' + $p.konto + ' nicht gefunden') }",
    "[ordered]@{ konto = $p.konto; dn = [string]$e.Properties['distinguishedname'][0]; spns = @($e.Properties['serviceprincipalname'] | ForEach-Object { [string]$_ } | Sort-Object) }",
  ]);
  return [...kopf(p, false), MIT_KONTO, `$w = MitKonto 'SYSTEM' '' ${psText(innen)} 120`, 'Ergebnis $w'].join('\n');
}

const LOKALER_PFAD = /^[A-Za-z]:\\[^"'`$\r\n*?<>|]{0,240}$/;
export function pruefePfad(v: unknown): string | { pfad: string } {
  const pfad = String(v ?? '').trim();
  return LOKALER_PFAD.test(pfad) && !pfad.includes('..') ? { pfad } : 'pfad: lokaler Pfad mit Laufwerksbuchstabe, z. B. S:\\SQLBackup (ohne Platzhalter und „..“)';
}

/** Dateien unter einem lokalen Pfad (rekursiv, höchstens 500, neueste zuerst) mit Größe und Zeit; Summe über alle */
export function verzeichnisLesenSkript(p: { pfad: string }): string {
  return [
    ...kopf(p, false),
    "if (-not (Test-Path -LiteralPath $p.pfad)) { Ergebnis ([ordered]@{ pfad = $p.pfad; vorhanden = $false }); exit 0 }",
    '$alle = @(Get-ChildItem -LiteralPath $p.pfad -Recurse -Force -File -ErrorAction SilentlyContinue)',
    '$sum = ($alle | Measure-Object -Property Length -Sum).Sum',
    '$n = $p.pfad.TrimEnd(\'\\\').Length',
    "$d = @($alle | Sort-Object LastWriteTime -Descending | Select-Object -First 500 | ForEach-Object { [ordered]@{ datei = $_.FullName.Substring([Math]::Min($n + 1, $_.FullName.Length)); mb = [math]::Round($_.Length / 1MB, 2); zeit = $_.LastWriteTime.ToString('s') } })",
    'Ergebnis ([ordered]@{ pfad = $p.pfad; vorhanden = $true; anzahl = $alle.Count; summeMb = [math]::Round([double]$sum / 1MB, 2); dateien = $d })',
  ].join('\n');
}

export function verzeichnisText(zugang: string, r: { pfad: string; vorhanden: boolean; anzahl?: number; summeMb?: number; dateien?: { datei: string; mb: number; zeit: string }[] }): string {
  if (!r.vorhanden) return `${zugang}: ${r.pfad} nicht vorhanden`;
  const d = r.dateien ?? [];
  return `${zugang}: ${r.pfad} — ${r.anzahl} Dateien, ${r.summeMb} MB${d.length ? `:\n${d.slice(0, 60).map(x => `${x.zeit} ${x.mb} MB ${x.datei}`).join('\n')}${d.length > 60 ? `\n… ${d.length - 60} weitere (in data)` : ''}` : ''}`;
}

/** Diagnoseverzeichnis entfernen — ausschließlich C:\Windows\Temp\alfred-<name> (von Alfred angelegt) */
const DIAGNOSE = /^C:\\Windows\\Temp\\alfred-[A-Za-z0-9-]{1,40}$/i;
export function pruefeDiagnose(v: unknown): string | { pfad: string } {
  const pfad = String(v ?? '').trim();
  return DIAGNOSE.test(pfad) ? { pfad } : 'pfad: nur C:\\Windows\\Temp\\alfred-<name> (von Alfred angelegte Diagnoseordner)';
}
export function diagnoseEntfernenSkript(p: { pfad: string }): string {
  return [
    ...kopf(p, false),
    "if (-not (Test-Path -LiteralPath $p.pfad)) { Ergebnis ([ordered]@{ pfad = $p.pfad; zustand = 'schon entfernt' }); exit 0 }",
    '$mb = [math]::Round([double](@(Get-ChildItem -LiteralPath $p.pfad -Recurse -Force -File) | Measure-Object -Property Length -Sum).Sum / 1MB, 2)',
    'Remove-Item -LiteralPath $p.pfad -Recurse -Force',
    "if (Test-Path -LiteralPath $p.pfad) { throw ('nach dem Entfernen noch vorhanden: ' + $p.pfad) }",
    "Ergebnis ([ordered]@{ pfad = $p.pfad; zustand = 'entfernt'; mb = $mb })",
  ].join('\n');
}

/** Gegenstellen einer BESTEHENDEN eingehenden Regel setzen (regel = Name/InstanceID aus firewall_lesen); Ergebnis nennt den vorherigen Wert */
// v1808 — Sicherheitsprüfung: -Name akzeptiert Platzhalter (* ? [ ]) → ein „*“ hätte alle Regeln getroffen. Nur wörtliche Namen,
// im Skript exakt per Where-Object -eq aufgelöst und genau eine Regel verlangt.
const REGEL_ID = /^[A-Za-z0-9{][A-Za-z0-9 ._:{}()-]{0,199}$/;
export function pruefeFilter(o: Record<string, unknown>): string | { regel: string; von: string[] } {
  const regel = String(o.regel ?? '').trim();
  const von = (Array.isArray(o.von) ? o.von.map(x => String(x).trim()) : typeof o.von === 'string' ? o.von.split(',').map(x => x.trim()) : []).filter(Boolean);
  if (!REGEL_ID.test(regel)) return 'regel: Regelname (Name/InstanceID aus firewall_lesen)';
  const any = von.length === 1 && /^any$/i.test(von[0]!);
  if (!any && (!von.length || von.length > 32 || von.some(x => !IPV4.test(x.split('/')[0]!) || (x.includes('/') && !/^\d{1,2}$/.test(x.split('/')[1]!))))) return 'von: 1–32 IPv4-Adressen oder Netze, oder „Any“ (nur als Rückweg auf den vorherigen Wert)';
  return { regel, von: any ? ['Any'] : von };
}
export function firewallFilterSkript(p: { regel: string; von: string[] }): string {
  return [
    ...kopf(p, false),
    '$r = @(Get-NetFirewallRule -All | Where-Object { [string]$_.Name -ceq $p.regel })',
    "if ($r.Count -ne 1) { throw ('Regel nicht gefunden oder nicht eindeutig: ' + $p.regel + ' (' + $r.Count + ')') }",
    '$r = $r[0]',
    "if ([string]$r.Direction -ne 'Inbound') { throw 'nur eingehende Regeln' }",
    "if ([string]$r.Action -ne 'Allow') { throw 'nur Erlauben-Regeln (Sperr-Regeln bleiben unangetastet)' }",
    "if ([string]$r.PolicyStoreSourceType -ne 'Local') { throw 'nur lokale Regeln (keine Gruppenrichtlinie)' }",
    '$vorher = @(($r | Get-NetFirewallAddressFilter).RemoteAddress | ForEach-Object { [string]$_ })',
    'Set-NetFirewallRule -InputObject $r -RemoteAddress @($p.von)',
    '$nachher = @((@(Get-NetFirewallRule -All | Where-Object { [string]$_.Name -ceq $p.regel })[0] | Get-NetFirewallAddressFilter).RemoteAddress | ForEach-Object { [string]$_ })',
    "Ergebnis ([ordered]@{ regel = [string]$r.Name; anzeige = [string]$r.DisplayName; vorher = ($vorher -join ','); nachher = ($nachher -join ',') })",
  ].join('\n');
}

/** v1807 — bestehende Regel aktivieren/deaktivieren (Owner 12.11.: ungenutzte offene Regeln deaktivieren statt Adressen zu erfinden);
 *  Ergebnis nennt den vorherigen Zustand (Rückweg: firewall_regel_aktiv mit aktiv = vorher). Core Networking ist ausgeschlossen. */
export function pruefeAktiv(o: Record<string, unknown>): string | { regel: string; aktiv: boolean } {
  const regel = String(o.regel ?? '').trim();
  if (!REGEL_ID.test(regel)) return 'regel: Regelname (Name/InstanceID aus firewall_lesen)';
  if (/^CoreNet-/i.test(regel)) return 'regel: Core-Networking-Regeln (DHCP, Nachbarerkennung, ICMP-Fehler) bleiben unangetastet';
  if (typeof o.aktiv !== 'boolean') return 'aktiv: true oder false';
  return { regel, aktiv: o.aktiv };
}
export function firewallAktivSkript(p: { regel: string; aktiv: boolean }): string {
  return [
    ...kopf(p, false),
    '$r = @(Get-NetFirewallRule -All | Where-Object { [string]$_.Name -ceq $p.regel })',
    "if ($r.Count -ne 1) { throw ('Regel nicht gefunden oder nicht eindeutig: ' + $p.regel + ' (' + $r.Count + ')') }",
    '$r = $r[0]',
    "if ([string]$r.Direction -ne 'Inbound') { throw 'nur eingehende Regeln' }",
    "if ([string]$r.Action -ne 'Allow') { throw 'nur Erlauben-Regeln (Sperr-Regeln bleiben unangetastet)' }",
    "if ([string]$r.PolicyStoreSourceType -ne 'Local') { throw 'nur lokale Regeln (keine Gruppenrichtlinie)' }",
    // Core Networking nicht über den (übersetzten) Anzeigetext erkennen: Name, Gruppen-Ressource und Anzeige — im Zweifel ablehnen
    "if ([string]$r.Name -like 'CoreNet-*' -or [string]$r.Group -like '@FirewallAPI.dll,-25000*' -or [string]$r.Group -like '*Core Networking*' -or [string]$r.DisplayGroup -like '*Core Networking*' -or [string]$r.DisplayGroup -like '*Kernnetzwerk*') { throw 'Core-Networking-Regeln bleiben unangetastet' }",
    "$vorher = ([string]$r.Enabled -eq 'True')",
    "if ($vorher -ne [bool]$p.aktiv) { Set-NetFirewallRule -InputObject $r -Enabled $(if ($p.aktiv) { 'True' } else { 'False' }) }",
    "$nachher = ([string]@(Get-NetFirewallRule -All | Where-Object { [string]$_.Name -ceq $p.regel })[0].Enabled -eq 'True')",
    "if ($nachher -ne [bool]$p.aktiv) { throw ('Regel ' + $p.regel + ' nicht im Zielzustand') }",
    "Ergebnis ([ordered]@{ regel = [string]$r.Name; anzeige = [string]$r.DisplayName; gruppe = [string]$r.DisplayGroup; vorher = $vorher; nachher = $nachher })",
  ].join('\n');
}

// ── v1809 Lehre aus H dd0c0b10 (12.11.): Firewall-Changes an Clustern brauchen ein Stabilitätsfenster mit Ereignis 1650 auf BEIDEN Knoten ──

/** Cluster-Ereignisse (Microsoft-Windows-FailoverClustering/Operational) mit RecordId, damit ein späterer Aufruf nur Neue zählt */
export function ereignisseSkript(p: { ids: number[]; seit_record?: number; minuten?: number }): string {
  return [
    ...kopf(p, false),
    "$log = 'Microsoft-Windows-FailoverClustering/Operational'",
    '$f = @{ LogName = $log; Id = @($p.ids | ForEach-Object { [int]$_ }) }',
    'if ($p.minuten) { $f.StartTime = (Get-Date).AddMinutes(-[int]$p.minuten) }',
    '$e = @(Get-WinEvent -FilterHashtable $f -MaxEvents 500 -ErrorAction SilentlyContinue)',
    'if ($p.seit_record) { $e = @($e | Where-Object { $_.RecordId -gt [long]$p.seit_record }) }',
    "$letzte = @(Get-WinEvent -LogName $log -MaxEvents 1 -ErrorAction SilentlyContinue)",
    "$d = @($e | Select-Object -First 50 | ForEach-Object { [ordered]@{ record = [long]$_.RecordId; id = [int]$_.Id; zeit = $_.TimeCreated.ToString('s'); text = (($_.Message -replace '\\s+', ' ').Substring(0, [Math]::Min(200, ($_.Message -replace '\\s+', ' ').Length))) } })",
    "Ergebnis ([ordered]@{ rechner = $env:COMPUTERNAME; jetzt = (Get-Date).ToString('s'); anzahl = $e.Count; hoechsterRecord = $(if ($letzte.Count) { [long]$letzte[0].RecordId } else { 0 }); ereignisse = $d })",
  ].join('\n');
}

export interface ClusterEreignisse { rechner: string; jetzt: string; anzahl: number; hoechsterRecord: number; ereignisse: { record: number; id: number; zeit: string; text: string }[] }

export function pruefeEreignisIds(v: unknown): number[] | string {
  const l = (Array.isArray(v) ? v : v === undefined ? [1650] : String(v).split(',')).map(x => Number(String(x).trim()));
  return l.length && l.length <= 10 && l.every(x => Number.isInteger(x) && x > 0 && x < 65536) ? l : 'event_ids: 1–10 Ereignis-IDs, z. B. [1650]';
}

/**
 * Bewertung eines Stabilitätsfensters aus den Einzelmessungen (rein, testbar): stabil nur, wenn die beobachtete Dauer erreicht ist,
 * jede Messung jedes Knotens gelang, keine neuen Ereignisse kamen und Cluster/AG/Zeuge in JEDER Messung gesund waren.
 */
export interface StabilMessung { zeit: string; knoten: string; ok: boolean; neu: number; fehler?: string; gesund?: boolean; detail?: string }
export function stabilitaetBewerten(m: StabilMessung[], knoten: string[], sollSekunden: number, istSekunden: number): { ergebnis: 'CLUSTER_STABLE' | 'FAIL' | 'UNKNOWN'; gruende: string[] } {
  const g: string[] = [];
  if (istSekunden < sollSekunden) g.push(`beobachtet ${Math.round(istSekunden)} s < ${sollSekunden} s`);
  for (const k of knoten) {
    const mk = m.filter(x => x.knoten === k);
    if (!mk.length) g.push(`${k}: keine Messung`);
    if (mk.some(x => !x.ok)) g.push(`${k}: ${mk.filter(x => !x.ok).length} Messung(en) gescheitert (${mk.find(x => !x.ok)?.fehler ?? '?'})`);
  }
  const neu = m.reduce((s, x) => s + (x.ok ? x.neu : 0), 0);
  const krank = m.filter(x => x.ok && x.gesund === false);
  if (neu > 0) return { ergebnis: 'FAIL', gruende: [...g, `${neu} neue Ereignisse (${[...new Set(m.filter(x => x.neu).map(x => x.knoten))].join(', ')})`] };
  if (krank.length) return { ergebnis: 'FAIL', gruende: [...g, `nicht gesund: ${krank.map(x => `${x.zeit} ${x.knoten} ${x.detail ?? ''}`.trim()).slice(0, 3).join('; ')}`] };
  return g.length ? { ergebnis: 'UNKNOWN', gruende: g } : { ergebnis: 'CLUSTER_STABLE', gruende: [] };
}

/** Eine Messung des Stabilitätsfensters auf einem Knoten: neue Ereignisse seit dem Ausgangs-Record, Knoten/Ressourcen, optional lokaler AG-Zustand */
export function stabilMessSkript(p: { ids: number[]; seit_record: number; ag?: string }): string {
  return [
    ...kopf(p, false),
    'Import-Module FailoverClusters',
    "$e = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-FailoverClustering/Operational'; Id = @($p.ids | ForEach-Object { [int]$_ }) } -MaxEvents 200 -ErrorAction SilentlyContinue | Where-Object { $_.RecordId -gt [long]$p.seit_record })",
    "$kn = @(Get-ClusterNode | ForEach-Object { [string]$_.Name + ' ' + [string]$_.State })",
    "$res = @(Get-ClusterResource | Where-Object { [string]$_.State -ne 'Online' } | ForEach-Object { [string]$_.Name + ' ' + [string]$_.State })",
    "$r = [ordered]@{ rechner = $env:COMPUTERNAME; neu = $e.Count; knoten = $kn; nichtOnline = $res; gesund = (-not ($kn | Where-Object { $_ -notlike '* Up' }) -and -not $res.Count) }",
    'if ($p.ag) {',
    "  $c = New-Object System.Data.SqlClient.SqlConnection 'Server=lpc:.;Integrated Security=SSPI;Pooling=false;Connect Timeout=10'; $c.Open()",
    "  $m = $c.CreateCommand(); $m.CommandText = \"SELECT ar.replica_server_name + ' ' + rs.role_desc + ' ' + rs.synchronization_health_desc + ' ' + rs.connected_state_desc FROM sys.dm_hadr_availability_replica_states rs JOIN sys.availability_replicas ar ON ar.replica_id = rs.replica_id JOIN sys.availability_groups ag ON ag.group_id = rs.group_id WHERE ag.name = @ag AND rs.is_local = 1; SELECT DB_NAME(database_id) + ' ' + synchronization_state_desc + ' ' + synchronization_health_desc FROM sys.dm_hadr_database_replica_states WHERE is_local = 1\"",
    "  [void]$m.Parameters.AddWithValue('@ag', [string]$p.ag)",
    '  $rd = $m.ExecuteReader(); $rep = @(); while ($rd.Read()) { $rep += [string]$rd[0] }; [void]$rd.NextResult(); $dbs = @(); while ($rd.Read()) { $dbs += [string]$rd[0] }; $c.Close()',
    "  $r.ag = $rep; $r.datenbanken = $dbs",
    "  if (-not $rep.Count -or ($rep | Where-Object { $_ -notmatch ' HEALTHY CONNECTED$' }) -or ($dbs | Where-Object { $_ -notmatch ' SYNCHRONIZED HEALTHY$' })) { $r.gesund = $false }",
    '}',
    'Ergebnis $r',
  ].join('\n');
}

