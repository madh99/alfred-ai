/**
 * Spec I8 (docs/specs/2026-11-01-windows-i8.md), Abschnitt 3b-1 — Standard-Vorlage (i) „Windows-Updates“, Gegenstück zu (h)
 * Betriebssystem-Updates: Snapshot, Vorher-Erhebung, Installation, Neustart nur bei Bedarf, Wiederanlauf, Nachher-Vergleich.
 *
 * Der Windows-Update-Agent lässt sich aus einer per Schlüssel angemeldeten SSH-Sitzung (Netzwerk-Anmeldung) nicht zum Laden und
 * Installieren bewegen; die Installation läuft deshalb als einmalige geplante Aufgabe unter SYSTEM, das Skript wartet auf ihr Ergebnis
 * und räumt sie wieder weg. Feature-Upgrades, Treiber und Updates mit Benutzereingabe bleiben außen vor.
 * Alle Skripte gehen als -EncodedCommand (keine Anführungszeichen-Probleme in der SSH-Befehlszeile).
 */

export const minus = (hhmm: string, min: number) => { const [h, m] = hhmm.split(':').map(Number); const t = Math.max(0, h! * 60 + m! - min); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
// ohne Fortschrittsanzeige: sonst landet beim ersten Modul-Laden CLIXML im Fehlerkanal
// v1748 — Fehler als eine lesbare Zeile statt CLIXML (Realfall d0a4aa66: „OperationStopped: (ausserhalb des …“ in XML-Resten)
export const ps = (zeilen: string[]) => `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(["$ProgressPreference = 'SilentlyContinue'", 'try {', ...zeilen, '} catch { [Console]::Error.WriteLine("FEHLER: " + $_.Exception.Message); exit 1 }'].join('\n'), 'utf16le').toString('base64')}`;

/** Arbeitsordner je Lauf (aus dem Merkmal, z. B. dem Snapshot-Namen) */
export function winUpdateOrdner(tag: string): string {
  const t = tag.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60);
  return `C:\\ProgramData\\Alfred\\winupd-${t}`;
}

/** Dienste, die nur bei Bedarf laufen (Update-Dienste u. ä.) — zählen im Nachher-Vergleich nicht */
export const WIN_NEBENDIENSTE = ['sppsvc', 'RemoteRegistry', 'MapsBroker', 'edgeupdate', 'gupdate', 'TrustedInstaller', 'UsoSvc', 'wuauserv', 'BITS', 'DoSvc', 'WaaSMedicSvc', 'msiserver', 'cloudbase-init'];

/**
 * Arbeitsordner schützen (Sicherheitsprüfung 01.11.): Unterordner von ProgramData dürfen normale Benutzer anlegen — ein vorab
 * angelegter Ordner mit fremden Rechten ließe Dateien unterschieben. Besitzer Administratoren, Vererbung aus, nur SYSTEM und
 * Administratoren; vorhandene Einträge darin auf diese Rechte zurücksetzen. `frisch` legt den Ordner neu an (Vorher-Erhebung).
 */
const ordnerSchuetzen = (d: string, frisch: boolean) => [
  ...(frisch ? [`if (Test-Path -LiteralPath '${d}') { Remove-Item -LiteralPath '${d}' -Recurse -Force }`] : []),
  `New-Item -ItemType Directory -Path '${d}' -Force | Out-Null`,
  `icacls.exe '${d}' /setowner '*S-1-5-32-544' /T /C /Q | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Arbeitsordner: Besitzer nicht gesetzt' }`,
  `icacls.exe '${d}' /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Arbeitsordner: Rechte nicht gesetzt' }`,
  `if (Get-ChildItem -LiteralPath '${d}' -Force) { icacls.exe '${d}\\*' /reset /T /C /Q | Out-Null }`,
];

export const jetztWien = "$n = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'W. Europe Standard Time').ToString('HH:mm')";

/** Vorher-Erhebung; prüft zugleich das Fenster (der Snapshot davor ist harmlos, ab hier wird nur im Fenster gearbeitet) */
export function winVorherSkript(d: string, von: string, startBis: string): string {
  return ps([
    '$ErrorActionPreference = "Stop"',
    jetztWien,
    `if ($n -lt '${von}' -or $n -ge '${startBis}') { throw "ausserhalb des Wartungsfensters ${von}-${startBis}: $n" }`,
    ...ordnerSchuetzen(d, true),
    `$neben = @(${WIN_NEBENDIENSTE.map(x => `'${x}'`).join(',')})`,
    "$l = @(Get-Service | Where-Object { $_.Status -eq 'Running' -and $_.StartType -eq 'Automatic' -and $neben -notcontains $_.Name } | ForEach-Object { $_.Name })",
    // eine Zeile je Dienst: ConvertFrom-Json liefert in PowerShell 5.1 ein Array als EIN Objekt (Probe 01.11.: 39 Dienste → 1)
    `Set-Content -Path '${d}\\vorher.txt' -Encoding UTF8 -Value $l`,
    '"WINUPD_VORHER_OK dienste=$($l.Count)"',
  ]);
}

/** Installation als einmalige Aufgabe unter SYSTEM; Start nur im Fenster bis `startBis`; wartet höchstens `zeitlimitS` */
export function winInstallSkript(d: string, von: string, startBis: string, zeitlimitS: number): string {
  const job = [
    '$ErrorActionPreference = "Stop"',
    'try {',
    '  $s = New-Object -ComObject Microsoft.Update.Session; $s.ClientApplicationID = "Alfred"',
    `  $r = $s.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'")`,
    '  $liste = New-Object -ComObject Microsoft.Update.UpdateColl; $titel = @()',
    '  foreach ($u in $r.Updates) {',
    "    if (@($u.Categories | ForEach-Object { $_.Name }) -contains 'Upgrades') { continue }",
    '    if ($u.InstallationBehavior.CanRequestUserInput) { continue }',
    '    if (-not $u.EulaAccepted) { $u.AcceptEula() }',
    '    [void]$liste.Add($u); $titel += $u.Title',
    '  }',
    '  if ($liste.Count -gt 0) {',
    '    $dl = $s.CreateUpdateDownloader(); $dl.Updates = $liste; [void]$dl.Download()',
    '    $in = $s.CreateUpdateInstaller(); $in.Updates = $liste; $e = $in.Install(); $code = $e.ResultCode; $neu = $e.RebootRequired',
    '  } else { $code = 2; $neu = $false }',
    `  ConvertTo-Json -InputObject @{ ok = $true; anzahl = $liste.Count; titel = $titel; ergebnis = $code; neustart = $neu } -Depth 3 | Set-Content -Path '${d}\\ergebnis.json' -Encoding UTF8`,
    `} catch { ConvertTo-Json -InputObject @{ ok = $false; fehler = $_.Exception.Message } | Set-Content -Path '${d}\\ergebnis.json' -Encoding UTF8 }`,
  ].join('\n');
  return ps([
    '$ErrorActionPreference = "Stop"',
    jetztWien,
    `if ($n -lt '${von}' -or $n -ge '${startBis}') { throw "ausserhalb des Fensters ${von}-${startBis}: $n" }`,
    ...ordnerSchuetzen(d, false),
    `Remove-Item -Path '${d}\\ergebnis.json' -ErrorAction SilentlyContinue`,
    // der Job geht direkt als -EncodedCommand in die Aufgabe — keine Skriptdatei, die SYSTEM aus einem Ordner liest
    `$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -EncodedCommand ${Buffer.from(job, 'utf16le').toString('base64')}'`,
    "Register-ScheduledTask -TaskName 'Alfred-WindowsUpdate' -Action $a -User 'SYSTEM' -RunLevel Highest -Force | Out-Null",
    "Start-ScheduledTask -TaskName 'Alfred-WindowsUpdate'",
    `$ende = (Get-Date).AddSeconds(${zeitlimitS})`,
    `while (-not (Test-Path '${d}\\ergebnis.json') -and (Get-Date) -lt $ende) { Start-Sleep -Seconds 15 }`,
    "Unregister-ScheduledTask -TaskName 'Alfred-WindowsUpdate' -Confirm:$false",
    `if (-not (Test-Path '${d}\\ergebnis.json')) { throw 'Windows-Update nach ${zeitlimitS} s nicht fertig' }`,
    `$e = Get-Content -Path '${d}\\ergebnis.json' -Raw | ConvertFrom-Json`,
    'if (-not $e.ok) { throw ("Windows-Update: " + $e.fehler) }',
    // ResultCode 2 = erfolgreich, 3 = erfolgreich mit Fehlern bei einzelnen Updates
    'if ($e.ergebnis -ne 2 -and $e.ergebnis -ne 3) { throw ("Installation: ResultCode " + $e.ergebnis) }',
    '"WINUPD_INSTALL_OK anzahl=$($e.anzahl) neustart=$($e.neustart) ergebnis=$($e.ergebnis)"',
    '$e.titel | ForEach-Object { "UPDATE $_" }',
  ]);
}

/** Neustart nur bei Bedarf (Ergebnis oder RebootRequired-Schlüssel), spätestens bis `rebootBis` */
export function winNeustartSkript(d: string, rebootBis: string): string {
  return ps([
    '$ErrorActionPreference = "Stop"',
    `$e = Get-Content -Path '${d}\\ergebnis.json' -Raw | ConvertFrom-Json`,
    "$noetig = [bool]$e.neustart -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired')",
    "if (-not $noetig) { 'WINUPD_KEIN_NEUSTART'; exit 0 }",
    jetztWien,
    `if ($n -ge '${rebootBis}') { throw "zu spaet fuer einen Neustart: $n" }`,
    `Set-Content -Path '${d}\\neustart' -Value $n`,
    'shutdown.exe /r /t 60 /d p:2:17 /c "Alfred Standard-Change Windows-Updates"',
    "'WINUPD_NEUSTART in 60 s'",
  ]);
}

/** Alle vorher laufenden automatischen Dienste laufen wieder (bis 10 min Anlaufzeit) */
export function winNachherSkript(d: string): string {
  return ps([
    '$ErrorActionPreference = "Stop"',
    `$v = @(Get-Content -Path '${d}\\vorher.txt' | Where-Object { $_ })`,
    "if ((Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending')) { throw 'Windows verlangt weiterhin einen Neustart' }",
    '$ende = (Get-Date).AddMinutes(10)',
    "do { $fehlt = @($v | Where-Object { (Get-Service -Name $_ -ErrorAction SilentlyContinue).Status -ne 'Running' }); if (-not $fehlt.Count) { break }; Start-Sleep -Seconds 20 } while ((Get-Date) -lt $ende)",
    'if ($fehlt.Count) { throw ("nicht wieder gestartet: " + ($fehlt -join ", ")) }',
    '"WINUPD_NACHHER_OK dienste=$($v.Count)"',
  ]);
}

export const SSH_LAEUFT = (z: string) => ({ typ: 'befehl', zugang: z, befehl: 'Get-Service -Name sshd', erwartet: 'Running' });
const WARTUNG_RUHT = (z: string) => ({ typ: 'befehl', zugang: z, befehl: 'Get-Service -Name TrustedInstaller', erwartet: 'Stopped' });

/** Schritte der Vorlage (i) für eine Windows-VM */
export function winUpdateSchritte(z: string, vm: { vmid: number; node: string }, snap: string, fenster: { von: string; bis: string }): Array<Record<string, unknown>> {
  const d = winUpdateOrdner(snap);
  const startBis = minus(fenster.bis, 45), rebootBis = minus(fenster.bis, 30);
  const rueck = { skill: 'proxmox', aktion: 'rollback_snapshot', parameter: { vmid: vm.vmid, node: vm.node, name: snap } };
  return [
    { titel: `Snapshot ${snap}`, art: 'aktion', skill: 'proxmox', aktion: 'create_snapshot', parameter: { vmid: vm.vmid, node: vm.node, name: snap, description: 'Alfred Standard-Change Windows-Updates, haltbar 7 Tage' }, pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'list_snapshots', parameter: { vmid: vm.vmid, node: vm.node }, erwartet: snap }, rueckweg: { skill: 'proxmox', aktion: 'delete_snapshot', parameter: { vmid: vm.vmid, node: vm.node, name: snap } } },
    { titel: `Vorher: Fenster ${fenster.von}–${startBis} und laufende automatische Dienste festhalten`, art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: z, befehl: winVorherSkript(d, fenster.von, startBis), timeout_s: 120 }, pruefung: SSH_LAEUFT(z), rueckweg: rueck },
    { titel: `Windows-Updates installieren (Start bis ${startBis}, ohne Feature-Upgrades und Treiber)`, art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: z, befehl: winInstallSkript(d, fenster.von, startBis, 5400), timeout_s: 5500 }, pruefung: SSH_LAEUFT(z), rueckweg: rueck, zeitlimitS: 5600 },
    { titel: `Neustart nur wenn nötig (bis ${rebootBis})`, art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: z, befehl: winNeustartSkript(d, rebootBis), timeout_s: 60 }, pruefung: SSH_LAEUFT(z), rueckweg: rueck },
    { titel: 'Anlaufzeit', art: 'warten', sekunden: 180, zeitlimitS: 600 },
    { titel: 'VM läuft', art: 'warten', pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: vm.vmid, node: vm.node }, erwartet: 'running' }, zeitlimitS: 900 },
    { titel: 'Gast-Agent antwortet', art: 'warten', pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'agent_status', parameter: { vmid: vm.vmid, node: vm.node } }, zeitlimitS: 900 },
    { titel: 'SSH wieder erreichbar', art: 'warten', pruefung: SSH_LAEUFT(z), zeitlimitS: 900 },
    // v1752 — Realfall 02.11. (87edadca): nach Alfreds Neustart startete Windows noch zweimal selbst neu (TrustedInstaller, 01:39 und
    // 01:41) und brach den Nachher-Vergleich ab. Erst weiter, wenn der Wartungsdienst ruht — als Warte-Schritte, die einen weiteren
    // Neustart überstehen (eine gescheiterte Prüfung wird bis zum Zeitlimit wiederholt), dann Ruhezeit und erneute Prüfung.
    { titel: 'Windows-Wartung abgeschlossen (TrustedInstaller ruht)', art: 'warten', pruefung: WARTUNG_RUHT(z), zeitlimitS: 2700 },
    { titel: 'Ruhezeit nach der Wartung', art: 'warten', sekunden: 300, zeitlimitS: 600 },
    { titel: 'Windows-Wartung ruht weiterhin', art: 'warten', pruefung: WARTUNG_RUHT(z), zeitlimitS: 1800 },
    { titel: 'Nachher: alle vorher laufenden Dienste laufen wieder', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: z, befehl: winNachherSkript(d), timeout_s: 700 }, pruefung: SSH_LAEUFT(z), rueckweg: rueck, zeitlimitS: 800 },
  ];
}

/**
 * I8 3b-1 — ausstehende Windows-Updates für den Anwendungs-Update-Bericht: nur suchen (Windows-Update-Agent), nichts laden oder
 * installieren. Läuft als festes Skript aus dem Code (nicht im Lese-Käfig — der kennt kein COM); auf probe-win25b per SSH belegt.
 */
export const WIN_UPDATE_SUCHE = ps([
  '$s = New-Object -ComObject Microsoft.Update.Session',
  `$r = $s.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'")`,
  '"ANZAHL=" + $r.Updates.Count',
  // Zeilenumbrüche aus Titeln entfernen — sonst zerfiele ein Update in mehrere Zeilen (Sicherheitsprüfung 02.11.)
  'foreach ($u in $r.Updates) { "UPDATE " + ($u.Title -replace "[\\r\\n|]+", " ") + " | " + ((@($u.Categories | ForEach-Object { $_.Name }) -join "/") -replace "[\\r\\n|]+", " ") + " | " + $u.InstallationBehavior.RebootBehavior }',
]);

export interface WinUpdate { titel: string; kategorie: string; neustart: boolean }
/** Liste und gemeldete Anzahl — weichen sie ab, ist die Liste unvollständig und der Bericht sagt das (Sicherheitsprüfung 02.11.) */
export function leseWinUpdates(t: string): { updates: WinUpdate[]; anzahl: number } | undefined {
  const m = /^ANZAHL=(\d+)/m.exec(t);
  if (!m) return undefined;
  const updates = t.split(/\r?\n/).filter(z => z.startsWith('UPDATE ')).map(z => {
    const [titel, kategorie, rb] = z.slice(7).split(' | ');
    return { titel: (titel ?? '').trim(), kategorie: (kategorie ?? '').trim(), neustart: (rb ?? '0').trim() !== '0' };
  });
  return { updates, anzahl: Number(m[1]) };
}

