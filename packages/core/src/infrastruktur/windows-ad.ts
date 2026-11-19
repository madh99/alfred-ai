/**
 * I8c (Spec docs/specs/2026-11-01-windows-i8.md, Vorhaben 8cbcf251) — Active Directory als Fähigkeit Alfreds: feste, geprüfte
 * PowerShell-Bausteine statt im Change frei formulierter Befehle. Owner 08.11.: „es geht darum Alfred die Fähigkeit zu geben“.
 *
 * Jeder Baustein ist ein vollständiges Skript für Windows PowerShell 5.1 (Server 2025). Parameter stehen als JSON im Skript, Geheimnisse
 * (DSRM-, Domänen-Kennwort) kommen NUR über die Standardeingabe (live geprüft 08.11. auf probe-win25b: SSH → powershell -EncodedCommand
 * liest [Console]::In). Jedes Skript schreibt genau eine Ergebniszeile „ALFRED-AD {json}“; Fehler beenden es mit Exit ≠ 0.
 */

export const AD_ERGEBNIS = 'ALFRED-AD ';

/** Domänenname wie ad.3033.at; NetBIOS höchstens 15 Zeichen, Großbuchstaben/Ziffern/Bindestrich */
export const AD_DOMAENE = /^(?=.{3,64}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
export const AD_NETBIOS = /^[A-Z0-9][A-Z0-9-]{0,14}$/;
export const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const OU_NAME = /^[\p{L}\p{N} ._-]{1,60}$/u;
const DNS_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const NTP = /^[a-z0-9.-]{3,80}$/i;

/** PowerShell-Literal in einfachen Anführungszeichen (nur ' verdoppeln) */
/** v1835 — Endmarke der Standardeingabe für Windows-Bausteine (siehe kopf) */
export const EINGABE_ENDE = 'ALFRED-ENDE';

export const psText = (s: string) => `'${s.replace(/'/g, "''")}'`;
export const kopf = (p: unknown, mitEingabe: boolean) => [
  "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'",
  `$p = ${psText(JSON.stringify(p))} | ConvertFrom-Json`,
  // v1835 — Realfall 13.11. PKI-B Schritt 36 (pkiiss01) und PKI-A Schritt 19 (fs01): Windows-OpenSSH gibt das Ende der Standardeingabe
  // nicht zuverlässig weiter (nachgestellt: 5–6 KB hängen in etwa jedem vierten Lauf, mit Endmarke 10/10). Gelesen wird bis zur
  // Endmarke ALFRED-ENDE (der Absender hängt sie an) oder bis zum Dateiende (Gastagent, Eingabe-Datei) — nie mehr auf EOF warten.
  ...(mitEingabe ? ["$__z = New-Object System.Text.StringBuilder; while ($true) { $__l = [Console]::In.ReadLine(); if ($null -eq $__l -or $__l -eq 'ALFRED-ENDE') { break }; [void]$__z.AppendLine($__l) }; $e = $__z.ToString() | ConvertFrom-Json"] : []),
  // v1794 — Realfall 11.11. C3: „vergr��ert“ — die Windows-Konsole schreibt in der OEM-Codepage. Nicht-ASCII als \\uXXXX ausgeben
  // (gültiges JSON, unabhängig von Codepage und SSH)
  `function Ergebnis($o) { $j = $o | ConvertTo-Json -Compress -Depth 5; $j = [regex]::Replace($j, '[^\\x00-\\x7F]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value }); [Console]::Out.WriteLine(${psText(AD_ERGEBNIS)} + $j) }`,
];
const dnsSetzen = "Get-NetAdapter | Where-Object Status -eq 'Up' | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ServerAddresses @($p.dns) }";
/** v1789 — frei wählbares Ausführungskonto: „name“ oder „NETBIOS\\name“; ohne Angabe der Standard (alfred bzw. Administrator) */
export const KONTO_FREI = /^([A-Za-z0-9][A-Za-z0-9-]{0,14}\\)?[A-Za-z0-9][A-Za-z0-9 ._-]{0,19}$/;
/** PowerShell-Ausdruck für das Konto aus $p.konto, sonst <netbios>\\<standard> */
export const kontoAusdruck = (standard: string, netbios: string) => `$(if ([string]$p.ausKonto -like '*\\*') { [string]$p.ausKonto } elseif ($p.ausKonto) { ${netbios} + '\\' + [string]$p.ausKonto } else { ${netbios} + '\\${standard}' })`;
export const neustart = (grund: string) => `shutdown.exe /r /t 20 /d p:4:1 /c ${psText(`Alfred: ${grund}`)}`;

export interface AdStatus {
  rechner: string; domaene: string; mitglied: boolean; rolle: number;
  dienste?: Record<string, string>; pdc?: string; dcs?: string[]; netbios?: string; papierkorb?: boolean; adFehler?: string;
  /** v1782 — eingehende Replikation dieses DCs: Partner, davon mit Fehler, erste Fehlermeldung */
  replPartner?: number; replFehler?: number; replMeldung?: string; replAbfrage?: string;
  /** v1782 — DNS-Server des ersten Adapters mit Einträgen (IPv4, Reihenfolge wie konfiguriert) */
  dnsClient?: string[];
}

/** Lesend: Rolle (0/2 allein, 1/3 Mitglied, 4/5 DC), bei DCs Dienste, PDC, DCs, Papierkorb */
export function adStatusSkript(): string {
  return [
    ...kopf({}, false),
    '$cs = Get-CimInstance -ClassName Win32_ComputerSystem',
    '$r = [ordered]@{ rechner = $env:COMPUTERNAME; domaene = [string]$cs.Domain; mitglied = [bool]$cs.PartOfDomain; rolle = [int]$cs.DomainRole }',
    'if ($cs.DomainRole -ge 4) {',
    "  $r.dienste = [ordered]@{}; foreach ($n in 'NTDS','DNS','ADWS','Netlogon','Kdc','W32Time') { $s = Get-Service -Name $n -ErrorAction SilentlyContinue; $r.dienste[$n] = if ($s) { [string]$s.Status } else { 'fehlt' } }",
    "  try { Import-Module ActiveDirectory; $d = Get-ADDomain; $r.pdc = [string]$d.PDCEmulator; $r.netbios = [string]$d.NetBIOSName; $r.dcs = @(Get-ADDomainController -Filter * | ForEach-Object { [string]$_.HostName }); $r.papierkorb = [bool]((Get-ADOptionalFeature -Filter \"Name -eq 'Recycle Bin Feature'\").EnabledScopes.Count) } catch { $r.adFehler = $_.Exception.Message }",
    // v1782 — Realfall 09.11. (fec4e344 Schritt 5): die Replikation war nur über einen Käfig-fremden Prüfbefehl lesbar. Eingehende
    // Partner dieses DCs (lokal über ADWS, braucht keine Domänengruppen) und deren letztes Ergebnis.
    "  try { $pm = @(Get-ADReplicationPartnerMetadata -Target $env:COMPUTERNAME -Scope Server -ErrorAction Stop); $r.replPartner = $pm.Count; $bad = @($pm | Where-Object { $_.LastReplicationResult -ne 0 }); $r.replFehler = $bad.Count; if ($bad.Count) { $f = @(Get-ADReplicationFailure -Target $env:COMPUTERNAME -ErrorAction SilentlyContinue | Where-Object { $_.FailureCount -gt 0 } | Select-Object -First 1); $r.replMeldung = if ($f.Count) { [string]$f[0].LastError + ' (' + [string]$f[0].Partner + ')' } else { 'Ergebnis ' + [string]$bad[0].LastReplicationResult + ' von ' + [string]$bad[0].Partner } } } catch { $r.replAbfrage = $_.Exception.Message }",
    '}',
    "try { $a = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.ServerAddresses.Count -gt 0 -and $_.InterfaceAlias -notlike 'Loopback*' } | Select-Object -First 1); if ($a.Count) { $r.dnsClient = @($a[0].ServerAddresses | ForEach-Object { [string]$_ }) } } catch { }",
    'Ergebnis $r',
  ].join('\n');
}

/** Bereit = DC dieser Domäne mit laufenden AD-Diensten (nach dem Hochstufen) */
export function dcBereit(s: AdStatus | undefined, domaene: string): boolean {
  return !!s && s.rolle >= 4 && s.domaene.toLowerCase() === domaene.toLowerCase() && !s.adFehler
    && ['NTDS', 'DNS', 'ADWS', 'Netlogon'].every(n => s.dienste?.[n] === 'Running');
}
export function mitgliedBereit(s: AdStatus | undefined, domaene: string): boolean {
  return !!s && s.mitglied && s.domaene.toLowerCase() === domaene.toLowerCase();
}

/** v1782 — Wortlaut für Prüfungen: „Replikation fehlerfrei“ nur mit mindestens einem Partner und ohne Fehler */
export function replikationText(s: AdStatus): string | undefined {
  if (s.replAbfrage) return `Replikation nicht lesbar: ${s.replAbfrage}`;
  if (s.replPartner === undefined) return undefined;
  if (s.replPartner === 0) return 'Replikation: noch kein Partner';
  if (s.replFehler) return `Replikation FEHLER bei ${s.replFehler} von ${s.replPartner} Partner(n)${s.replMeldung ? `: ${s.replMeldung}` : ''}`;
  return `Replikation fehlerfrei (${s.replPartner} Partner)`;
}

export function adStatusText(s: AdStatus): string {
  const dns = s.dnsClient?.length ? `; DNS-Client ${s.dnsClient.join(',')}` : '';
  if (s.rolle >= 4) {
    const dienste = Object.entries(s.dienste ?? {}).filter(([, z]) => z !== 'Running').map(([n, z]) => `${n} ${z}`);
    const repl = replikationText(s);
    return `${s.rechner}: Domänencontroller von ${s.domaene}${s.pdc ? ` (PDC ${s.pdc})` : ''}${s.dcs?.length ? `, DCs: ${s.dcs.join(', ')}` : ''}${s.papierkorb ? ', AD-Papierkorb an' : ''}; Dienste ${dienste.length ? `NICHT alle laufend: ${dienste.join(', ')}` : 'laufen'}${s.adFehler ? `; AD-Abfrage: ${s.adFehler}` : ''}${repl ? `; ${repl}` : ''}${dns}`;
  }
  return (s.mitglied ? `${s.rechner}: Mitglied der Domäne ${s.domaene}` : `${s.rechner}: keiner Domäne beigetreten (Arbeitsgruppe ${s.domaene})`) + dns;
}

export function pruefeWald(p: { domaene: string; netbios: string }): string | undefined {
  if (!AD_DOMAENE.test(p.domaene)) return 'domaene: vollständiger DNS-Name in Kleinbuchstaben, z. B. ad.3033.at';
  if (!AD_NETBIOS.test(p.netbios)) return 'netbios: höchstens 15 Zeichen, Großbuchstaben/Ziffern/Bindestrich, z. B. AD3033';
  return undefined;
}

/**
 * Neuer Wald auf einem Server in der Arbeitsgruppe (eingabe: { dsrm }). Wiederholbar: ist der Rechner schon DC dieser Domäne, nichts tun.
 * Lokale Konten (alfred, Administrator, Owner) werden beim ersten DC eines neuen Walds zu Domänenkonten — der Fernzugang bleibt „alfred“.
 */
export function waldSkript(p: { domaene: string; netbios: string }): string {
  return [
    ...kopf(p, true),
    '$cs = Get-CimInstance -ClassName Win32_ComputerSystem',
    "if ($cs.DomainRole -ge 4) { if ($cs.Domain -ieq $p.domaene) { Ergebnis @{ zustand = 'schon'; domaene = [string]$cs.Domain }; exit 0 } else { throw ('bereits Domänencontroller von ' + $cs.Domain) } }",
    "if ($cs.PartOfDomain) { throw ('Mitglied der Domäne ' + $cs.Domain + ' — kein neuer Wald') }",
    'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools | Out-Null',
    'Import-Module ADDSDeployment',
    '$pw = ConvertTo-SecureString -String $e.dsrm -AsPlainText -Force',
    'Install-ADDSForest -DomainName $p.domaene -DomainNetbiosName $p.netbios -InstallDns -SafeModeAdministratorPassword $pw -NoRebootOnCompletion -Force -WarningAction SilentlyContinue | Out-Null',
    neustart('Hochstufen zum Domänencontroller (neuer Wald)'),
    "Ergebnis @{ zustand = 'hochgestuft'; neustart = $true }",
  ].join('\n');
}

export function pruefeDns(dns: unknown): string[] | string {
  const l = Array.isArray(dns) ? dns.map(String) : typeof dns === 'string' ? dns.split(/[,\s]+/).filter(Boolean) : [];
  if (!l.length || l.length > 4 || l.some(x => !IPV4.test(x))) return 'dns: 1–4 IPv4-Adressen der Domänencontroller';
  return l;
}

/** Weiterer DC (eingabe: { dsrm, kennwort } — Kennwort des Domänenkontos <NETBIOS>\alfred). DNS des Rechners zuerst auf die vorhandenen DCs. */
export function dcSkript(p: { domaene: string; netbios: string; dns: string[]; ausKonto?: string }): string {
  return [
    ...kopf(p, true),
    '$cs = Get-CimInstance -ClassName Win32_ComputerSystem',
    "if ($cs.DomainRole -ge 4) { if ($cs.Domain -ieq $p.domaene) { Ergebnis @{ zustand = 'schon'; domaene = [string]$cs.Domain }; exit 0 } else { throw ('bereits Domänencontroller von ' + $cs.Domain) } }",
    "if ($cs.PartOfDomain -and $cs.Domain -ine $p.domaene) { throw ('Mitglied einer anderen Domäne: ' + $cs.Domain) }",
    dnsSetzen,
    "if (-not (Resolve-DnsName -Name ('_ldap._tcp.dc._msdcs.' + $p.domaene) -Type SRV -DnsOnly -ErrorAction SilentlyContinue)) { throw ('Domäne ' + $p.domaene + ' über ' + ($p.dns -join ', ') + ' nicht auflösbar') }",
    'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools | Out-Null',
    'Import-Module ADDSDeployment',
    "$cred = New-Object System.Management.Automation.PSCredential((" + kontoAusdruck('alfred', '$p.netbios') + "), (ConvertTo-SecureString -String $e.kennwort -AsPlainText -Force))",
    '$pw = ConvertTo-SecureString -String $e.dsrm -AsPlainText -Force',
    'Install-ADDSDomainController -DomainName $p.domaene -Credential $cred -InstallDns -SafeModeAdministratorPassword $pw -NoRebootOnCompletion -Force -WarningAction SilentlyContinue | Out-Null',
    neustart('Hochstufen zum weiteren Domänencontroller'),
    "Ergebnis @{ zustand = 'hochgestuft'; neustart = $true }",
  ].join('\n');
}

/** Mitgliedsserver beitreten (eingabe: { kennwort }); DNS auf die DCs; optional OU (relativ, z. B. „Server“) */
export function beitrittSkript(p: { domaene: string; netbios: string; dns: string[]; ou?: string; ausKonto?: string }): string {
  return [
    ...kopf(p, true),
    '$cs = Get-CimInstance -ClassName Win32_ComputerSystem',
    "if ($cs.PartOfDomain) { if ($cs.Domain -ieq $p.domaene) { Ergebnis @{ zustand = 'schon'; domaene = [string]$cs.Domain }; exit 0 } else { throw ('Mitglied einer anderen Domäne: ' + $cs.Domain) } }",
    dnsSetzen,
    "if (-not (Resolve-DnsName -Name ('_ldap._tcp.dc._msdcs.' + $p.domaene) -Type SRV -DnsOnly -ErrorAction SilentlyContinue)) { throw ('Domäne ' + $p.domaene + ' über ' + ($p.dns -join ', ') + ' nicht auflösbar') }",
    "$cred = New-Object System.Management.Automation.PSCredential((" + kontoAusdruck('alfred', '$p.netbios') + "), (ConvertTo-SecureString -String $e.kennwort -AsPlainText -Force))",
    "$ziel = @{ DomainName = $p.domaene; Credential = $cred; Force = $true }",
    "if ($p.ou) { $ziel.OUPath = 'OU=' + $p.ou + ',' + (($p.domaene -split '\\.' | ForEach-Object { 'DC=' + $_ }) -join ',') }",
    'Add-Computer @ziel -WarningAction SilentlyContinue',
    neustart('Domänenbeitritt'),
    "Ergebnis @{ zustand = 'beigetreten'; neustart = $true }",
  ].join('\n');
}

export const AD_OUS_STANDARD = ['Server', 'Clients', 'Dienstkonten', 'Admins'];
export const NTP_STANDARD = ['0.at.pool.ntp.org', '1.at.pool.ntp.org', '2.at.pool.ntp.org'];

export function pruefeGrundstruktur(p: { ous: string[]; ntp: string[]; weiterleiter: string[] }): string | undefined {
  if (!p.ous.length || p.ous.some(o => !OU_NAME.test(o))) return 'ous: Namen (Buchstaben, Ziffern, Leerzeichen, . _ -)';
  if (!p.ntp.length || p.ntp.some(n => !NTP.test(n))) return 'ntp: Hostnamen externer Zeitquellen';
  if (p.weiterleiter.some(w => !IPV4.test(w))) return 'weiterleiter: IPv4-Adressen (z. B. Gateway des AD-Netzes)';
  return undefined;
}

/**
 * Grundstruktur am PDC: OUs (mit Löschschutz), AD-Papierkorb (lässt sich nicht wieder abschalten), alfred in Domänen-Admins (Konto der
 * Automatisierung; nötig für weitere DCs), externe NTP-Quellen am PDC, DNS-Weiterleiter, KDS-Stammschlüssel für gMSA. Wiederholbar.
 */
export function grundstrukturSkript(p: { ous: string[]; ntp: string[]; weiterleiter: string[]; ausKonto?: string }): string {
  return [
    ...kopf(p, true),
    'Import-Module ActiveDirectory',
    '$d = Get-ADDomain; $dn = $d.DistinguishedName; $r = [ordered]@{ ous = @(); papierkorb = $false }',
    // Realfall 3103ec4c (09.11.): alfred ist nach dem Hochstufen nur in BUILTIN\Administrators — der Papierkorb braucht Organisations-
    // Admins. Papierkorb und Domänen-Admins daher mit dem Domänen-Administrator (Kennwort über die Standardeingabe).
    "$cred = New-Object System.Management.Automation.PSCredential ((" + kontoAusdruck('Administrator', '$d.NetBIOSName') + "), (ConvertTo-SecureString $e.kennwort -AsPlainText -Force))",
    "if ($env:COMPUTERNAME -ine ($d.PDCEmulator -split '\\.')[0]) { throw ('nur am PDC-Emulator ' + $d.PDCEmulator) }",
    "foreach ($ou in $p.ous) { if (-not (Get-ADOrganizationalUnit -LDAPFilter ('(ou=' + $ou + ')') -SearchBase $dn -SearchScope OneLevel)) { New-ADOrganizationalUnit -Name $ou -Path $dn -ProtectedFromAccidentalDeletion $true; $r.ous += $ou } }",
    "$f = Get-ADOptionalFeature -Filter \"Name -eq 'Recycle Bin Feature'\"",
    "if (-not $f.EnabledScopes.Count) { Enable-ADOptionalFeature -Identity 'Recycle Bin Feature' -Scope ForestOrConfigurationSet -Target (Get-ADForest).Name -Credential $cred -Confirm:$false; $r.papierkorbNeu = $true }",
    "$r.papierkorb = [bool]((Get-ADOptionalFeature -Filter \"Name -eq 'Recycle Bin Feature'\").EnabledScopes.Count)",
    "$da = Get-ADGroup -Identity ($d.DomainSID.Value + '-512')",
    "if (-not (Get-ADGroupMember -Identity $da | Where-Object SamAccountName -eq 'alfred')) { Add-ADGroupMember -Identity $da -Members 'alfred' -Credential $cred; $r.alfredAdmin = 'neu' } else { $r.alfredAdmin = 'schon' }",
    "$peers = ($p.ntp | ForEach-Object { $_ + ',0x8' }) -join ' '",
    "w32tm.exe /config /manualpeerlist:$peers /syncfromflags:manual /reliable:yes /update | Out-Null",
    'Restart-Service -Name W32Time; w32tm.exe /resync /nowait | Out-Null',
    '$r.ntp = $p.ntp',
    'if (@($p.weiterleiter).Count) { Set-DnsServerForwarder -IPAddress @($p.weiterleiter); $r.weiterleiter = @((Get-DnsServerForwarder).IPAddress | ForEach-Object { [string]$_ }) }',
    // Realfall 3103ec4c (09.11.): die SSH-Anmeldung per Schlüssel ist ein S4U-Token ohne Domänengruppen — Add-KdsRootKey („The request is
    // not supported“) hat kein -Credential. Daher über WinRM am eigenen Rechner mit dem Domänen-Administrator (volles Token).
    "$kds = Invoke-Command -ComputerName $env:COMPUTERNAME -Credential $cred -ScriptBlock { if (-not (Get-KdsRootKey)) { Add-KdsRootKey -EffectiveImmediately | Out-Null; 'neu' } else { 'schon' } }",
    "$r.kds = if ($kds -eq 'neu') { 'neu (gMSA nach Replikation, bis 10 h)' } else { 'schon' }",
    'Ergebnis $r',
  ].join('\n');
}

/**
 * Systemstatus-Sicherung auf die zweite Platte (Owner 08.11.: nicht PBS). Initialisiert nur eine RAW-Platte genau dieser Größe (±2 GB)
 * und nie Platte 0; Aufgabe täglich zur angegebenen Uhrzeit (wbadmin systemstatebackup, älteste Versionen entfernt Windows bei Platzmangel).
 */
export function sicherungSkript(p: { laufwerk: string; groesseGb: number; uhrzeit: string }): string {
  return [
    ...kopf(p, false),
    'Install-WindowsFeature -Name Windows-Server-Backup | Out-Null',
    '$r = [ordered]@{ laufwerk = $p.laufwerk }',
    'if (-not (Get-Volume -DriveLetter $p.laufwerk -ErrorAction SilentlyContinue)) {',
    "  $d = @(Get-Disk | Where-Object { $_.Number -ne 0 -and $_.PartitionStyle -eq 'RAW' -and [math]::Abs($_.Size / 1GB - $p.groesseGb) -le 2 })",
    "  if ($d.Count -ne 1) { throw ('genau eine leere Platte mit ' + $p.groesseGb + ' GB erwartet, gefunden: ' + $d.Count) }",
    "  Initialize-Disk -Number $d[0].Number -PartitionStyle GPT | Out-Null",
    "  New-Partition -DiskNumber $d[0].Number -UseMaximumSize -DriveLetter $p.laufwerk | Format-Volume -FileSystem NTFS -NewFileSystemLabel 'Systemstatus' -Confirm:$false | Out-Null",
    '  $r.platte = $d[0].Number',
    '}',
    "$ziel = $p.laufwerk + ':'",
    "$a = New-ScheduledTaskAction -Execute 'wbadmin.exe' -Argument ('start systemstatebackup -backupTarget:' + $ziel + ' -quiet')",
    '$t = New-ScheduledTaskTrigger -Daily -At $p.uhrzeit',
    "Register-ScheduledTask -TaskName 'Alfred Systemstatus-Sicherung' -Action $a -Trigger $t -User 'SYSTEM' -RunLevel Highest -Force | Out-Null",
    "$r.aufgabe = [string](Get-ScheduledTask -TaskName 'Alfred Systemstatus-Sicherung').State",
    '$v = Get-Volume -DriveLetter $p.laufwerk; $r.freiGb = [math]::Round($v.SizeRemaining / 1GB, 1); $r.groesseGb = [math]::Round($v.Size / 1GB, 1)',
    'Ergebnis $r',
  ].join('\n');
}

/** Sicherung jetzt ausführen und belegen (wbadmin get versions) */
export function sicherungJetztSkript(p: { laufwerk: string }): string {
  return [
    ...kopf(p, false),
    "$ziel = $p.laufwerk + ':'",
    '$aus = & wbadmin.exe start systemstatebackup ("-backupTarget:" + $ziel) -quiet 2>&1 | Out-String',
    "if ($LASTEXITCODE -ne 0) { throw ('wbadmin Exit ' + $LASTEXITCODE + ': ' + $aus.Substring([math]::Max(0, $aus.Length - 400))) }",
    '$ver = & wbadmin.exe get versions ("-backupTarget:" + $ziel) 2>&1 | Out-String',
    "$ids = @([regex]::Matches($ver, 'Version identifier: (\\S+)') | ForEach-Object { $_.Groups[1].Value })",
    "if (-not $ids.Count) { $ids = @([regex]::Matches($ver, 'Versions-ID: (\\S+)') | ForEach-Object { $_.Groups[1].Value }) }",
    "if (-not $ids.Count) { throw 'nach der Sicherung keine Version lesbar' }",
    '$v = Get-Volume -DriveLetter $p.laufwerk',
    'Ergebnis @{ versionen = $ids.Count; neueste = $ids[-1]; freiGb = [math]::Round($v.SizeRemaining / 1GB, 1) }',
  ].join('\n');
}

/** Beweis AD-Papierkorb: Testkonto anlegen, löschen, aus dem Papierkorb wiederherstellen, prüfen, danach wieder entfernen */
export function papierkorbSkript(p: { kennung: string; ausKonto?: string }): string {
  return [
    ...kopf(p, true),
    'Import-Module ActiveDirectory',
    "$n = 'alfred-pk-' + $p.kennung",
    '$d = Get-ADDomain; $dn = $d.UsersContainer',
    // Realfall 3103ec4c: SSH-Token ohne Domänengruppen — alle AD-Befehle mit dem Domänen-Administrator (Kennwort über die Standardeingabe)
    "$c = New-Object System.Management.Automation.PSCredential ((" + kontoAusdruck('Administrator', '$d.NetBIOSName') + "), (ConvertTo-SecureString $e.kennwort -AsPlainText -Force))",
    'New-ADUser -Name $n -SamAccountName $n -Path $dn -Enabled $false -Description "Alfred: Beweis AD-Papierkorb (I8c)" -Credential $c',
    '$guid = (Get-ADUser -Identity $n -Credential $c).ObjectGUID',
    'Remove-ADUser -Identity $guid -Confirm:$false -Credential $c',
    "if (Get-ADUser -Filter \"SamAccountName -eq '$n'\" -Credential $c) { throw 'Testkonto nach dem Löschen noch da' }",
    '$geloescht = Get-ADObject -Filter "ObjectGUID -eq \'$guid\'" -IncludeDeletedObjects -Credential $c',
    "if (-not $geloescht.Deleted) { throw 'Testkonto nicht im Papierkorb' }",
    'Restore-ADObject -Identity $guid -Credential $c',
    '$zurueck = Get-ADUser -Identity $guid -Credential $c',
    "if ($zurueck.SamAccountName -ne $n) { throw 'Wiederherstellung nicht belegt' }",
    'Remove-ADUser -Identity $guid -Confirm:$false -Credential $c',
    "Ergebnis @{ konto = $n; geloescht = $true; wiederhergestellt = $true; objectGuid = [string]$guid; danachEntfernt = $true }",
  ].join('\n');
}

export function pruefeDnsEintrag(p: { zone: string; name: string; ip?: string }): string | undefined {
  if (!AD_DOMAENE.test(p.zone)) return 'zone: DNS-Zone, z. B. ad.3033.at';
  if (!DNS_NAME.test(p.name)) return 'name: einfacher Name ohne Punkt, z. B. alfred-test-1';
  if (p.ip !== undefined && !IPV4.test(p.ip)) return 'ip: IPv4-Adresse';
  return undefined;
}
/**
 * v1783 — Realfall 10.11. (I8c D 12d82a15 Schritte 8/10/11/14): DNS-Proben waren als „powershell … Resolve-DnsName“-Prüfbefehle geplant,
 * die im Lese-Käfig nie bestehen (Resolve-DnsName ist dort bewusst gesperrt: Netzverkehr zu frei wählbaren Zielen). Lesender Baustein:
 * A-Auflösung eines Namens auf dem Rechner selbst, wahlweise über einen bestimmten Server oder über den eigenen Resolver ohne Cache.
 */
export function pruefeAufloesen(p: { fqdn: string; server?: string }): string | undefined {
  if (!AD_DOMAENE.test(p.fqdn)) return 'fqdn: vollständiger DNS-Name in Kleinbuchstaben, z. B. alfred-test.ad.3033.at';
  if (p.server !== undefined && !IPV4.test(p.server)) return 'server: IPv4-Adresse eines DNS-Servers (weglassen = eigener Resolver des Rechners)';
  return undefined;
}
export function dnsAufloesenSkript(p: { fqdn: string; server?: string; ohneCache?: boolean }): string {
  return [
    ...kopf(p, false),
    'if ($p.ohneCache) { Clear-DnsClientCache }',
    "$a = @{ Name = $p.fqdn; Type = 'A'; DnsOnly = $true; QuickTimeout = $true }; if ($p.server) { $a.Server = $p.server }",
    "try { $r = @(Resolve-DnsName @a -ErrorAction Stop | Where-Object { $_.Type -eq 'A' } | ForEach-Object { [string]$_.IPAddress }); Ergebnis @{ adressen = $r } }",
    'catch { Ergebnis @{ adressen = @(); fehler = $_.Exception.Message } }',
  ].join('\n');
}
export function aufloesenText(p: { fqdn: string; server?: string }, r: { adressen?: string[]; fehler?: string }): string {
  const ueber = p.server ? `über ${p.server}` : 'über den eigenen Resolver';
  return r.adressen?.length ? `${p.fqdn} → ${r.adressen.join(', ')} (${ueber})` : `${p.fqdn}: keine A-Antwort ${ueber}${r.fehler ? ` — ${r.fehler.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`;
}

/** A-Eintrag in einer AD-Zone (z. B. frischer Name für den DNS-Ausfalltest — kein Cache kennt ihn) */
export function dnsEintragSkript(p: { zone: string; name: string; ip: string }): string {
  return [
    ...kopf(p, false),
    "$da = Get-DnsServerResourceRecord -ZoneName $p.zone -Name $p.name -RRType A -ErrorAction SilentlyContinue",
    "if ($da) { if (@($da.RecordData.IPv4Address.IPAddressToString) -contains $p.ip) { Ergebnis @{ zustand = 'schon' }; exit 0 } else { throw ($p.name + ' hat schon eine andere Adresse') } }",
    'Add-DnsServerResourceRecordA -ZoneName $p.zone -Name $p.name -IPv4Address $p.ip -TimeToLive 00:01:00',
    "Ergebnis @{ zustand = 'angelegt'; fqdn = ($p.name + '.' + $p.zone); ip = $p.ip }",
  ].join('\n');
}
export function dnsEintragLoeschenSkript(p: { zone: string; name: string }): string {
  return [
    ...kopf(p, false),
    "$da = Get-DnsServerResourceRecord -ZoneName $p.zone -Name $p.name -RRType A -ErrorAction SilentlyContinue",
    "if (-not $da) { Ergebnis @{ zustand = 'schon weg' }; exit 0 }",
    'Remove-DnsServerResourceRecord -ZoneName $p.zone -Name $p.name -RRType A -Force',
    "Ergebnis @{ zustand = 'entfernt' }",
  ].join('\n');
}

/** DNS-Server eines Windows-Rechners (aktive Netzkarten) setzen; liefert die vorherigen für den Rückweg */
export function dnsClientSkript(p: { dns: string[] }): string {
  return [
    ...kopf(p, false),
    "$nics = @(Get-NetAdapter | Where-Object Status -eq 'Up')",
    "if (-not $nics.Count) { throw 'keine aktive Netzkarte' }",
    '$vorher = @((Get-DnsClientServerAddress -InterfaceIndex $nics[0].ifIndex -AddressFamily IPv4).ServerAddresses)',
    dnsSetzen,
    '$nachher = @((Get-DnsClientServerAddress -InterfaceIndex $nics[0].ifIndex -AddressFamily IPv4).ServerAddresses)',
    "if (($nachher -join ',') -ne (@($p.dns) -join ',')) { throw ('DNS nach dem Setzen: ' + ($nachher -join ', ')) }",
    'Ergebnis @{ vorher = $vorher; nachher = $nachher }',
  ].join('\n');
}

// ── I8e Task 4 — Domänen-Dienstkonto (z. B. svc-sqllnx-backup für die Linux-SQL-Sicherung nach fs01) ─────────────────────────────

/** sAMAccountName eines Benutzer-Dienstkontos (kein $, höchstens 20 Zeichen) */
const DIENSTKONTO = /^[A-Za-z][A-Za-z0-9-]{2,19}$/;
export const DIENSTKONTO_BESCHREIBUNG = 'Alfred I8e Dienstkonto';
/** Tresor-Name des Dienstkonto-Kennworts: ad-<konto> (klein) */
export const dienstkontoTresorName = (konto: string) => `ad-${konto.toLowerCase()}`;

export function pruefeDienstkonto(o: Record<string, unknown>): { konto: string; ou: string } | string {
  const konto = typeof o.konto === 'string' ? o.konto.trim() : '';
  const ou = o.ou === undefined ? 'Dienstkonten' : typeof o.ou === 'string' ? o.ou.trim() : '';
  if (!DIENSTKONTO.test(konto)) return 'konto: sAMAccountName des Dienstkontos (Buchstabe, dann Buchstaben/Ziffern/-, 3–20 Zeichen), z. B. svc-sqllnx-backup';
  if (!OU_NAME.test(ou)) return 'ou: OU direkt unter der Domäne (Standard Dienstkonten)';
  return { konto, ou };
}

/** Domänen-Administrator für AD-Änderungen am DC (Kennwort über die Standardeingabe, wie papierkorbSkript) */
export const adAdminCred = "$d = Get-ADDomain; $dc = $env:COMPUTERNAME + '.' + $d.DNSRoot; $c = New-Object System.Management.Automation.PSCredential ((" + kontoAusdruck('Administrator', '$d.NetBIOSName') + "), (ConvertTo-SecureString $e.kennwort -AsPlainText -Force))";

/**
 * Benutzer-Dienstkonto in der OU (Standard Dienstkonten) anlegen — eingabe: { kennwort (Domänen-Administrator), dienstkennwort }.
 * Kennwort läuft nie ab und kann vom Konto nicht geändert werden (Dienstkonto ohne Anmeldung am Desktop; Wechsel = eigener Change mit
 * neuem Tresor-Wert). Wiederholbar: besteht das Konto (Beschreibung „Alfred I8e Dienstkonto“), wird nur die Anmeldung mit dem
 * Tresor-Kennwort geprüft und fehlende Flags werden gesetzt — ein abweichendes Kennwort wird NIE still zurückgesetzt. Ein fremdes Konto
 * gleichen Namens → Abbruch. Selbstprüfung: LDAP-Anmeldung mit dem Kennwort, aktiv, Flags, OU.
 */
export function dienstkontoSkript(p: { konto: string; ou: string; ausKonto?: string; haerten?: boolean }): string {
  return [
    ...kopf(p, true),
    'Import-Module ActiveDirectory',
    adAdminCred,
    "$pfad = 'OU=' + $p.ou + ',' + $d.DistinguishedName",
    // Fix-Runde 1 (Minor 7): alles gegen diesen DC (zugang = DC) — Anlage und Anmeldeprüfung ohne Replikationsverzug
    "if (-not (Get-ADOrganizationalUnit -Identity $pfad -Server $dc -Credential $c -ErrorAction SilentlyContinue)) { throw ('OU ' + $pfad + ' fehlt (windows_ad grundstruktur)') }",
    "function Anmeldung { try { $t = New-Object System.DirectoryServices.DirectoryEntry(('LDAP://' + $dc + '/' + $d.DistinguishedName), ($d.NetBIOSName + '\\' + $p.konto), $e.dienstkennwort); $null = $t.NativeObject; $true } catch { $false } }",
    "$u = Get-ADUser -Filter (\"SamAccountName -eq '\" + $p.konto + \"'\") -Properties Description, PasswordNeverExpires, CannotChangePassword, Enabled -Server $dc -Credential $c",
    "$z = 'schon'",
    'if (-not $u) {',
    `  New-ADUser -Name $p.konto -SamAccountName $p.konto -UserPrincipalName ($p.konto + '@' + $d.DNSRoot) -Path $pfad -AccountPassword (ConvertTo-SecureString $e.dienstkennwort -AsPlainText -Force) -Enabled $true -PasswordNeverExpires $true -CannotChangePassword $true -Description ${psText(DIENSTKONTO_BESCHREIBUNG)} -Server $dc -Credential $c`,
    "  $z = 'angelegt'",
    '} else {',
    `  if ($u.Description -ne ${psText(DIENSTKONTO_BESCHREIBUNG)}) { throw ('Konto ' + $p.konto + ' ist nicht von Alfred angelegt - nichts geändert') }`,
    "  if (-not (Anmeldung)) { throw ('Konto ' + $p.konto + ': Anmeldung mit dem Tresor-Kennwort scheitert - Kennwort wird nicht still zurückgesetzt; bewusst entscheiden (Tresor-Wert oder Konto prüfen)') }",
    "  if (-not $u.Enabled) { Enable-ADAccount -Identity $u -Server $dc -Credential $c; $z = 'geaendert' }",
    "  if (-not $u.PasswordNeverExpires -or -not $u.CannotChangePassword) { Set-ADUser -Identity $u -PasswordNeverExpires $true -CannotChangePassword $true -Server $dc -Credential $c; $z = 'geaendert' }",
    '}',
    // I8e Etappe 3 — Härtung (svc-sqllnx): nur AES128+AES256 (24), vertraulich/keine Delegierung, Mitglied der Anmeldesperre-Gruppe
    // (Ruling R3: keine userWorkstations-Sperre — sie bricht kinit -k/LDAP vom Linux-Host mit KDC_ERR_POLICY)
    'if ($p.haerten) {',
    "  $h = Get-ADUser -Identity $p.konto -Properties 'msDS-SupportedEncryptionTypes', AccountNotDelegated -Server $dc -Credential $c",
    `  if ([int]$h.'msDS-SupportedEncryptionTypes' -ne ${AD_AES_NUR}) { Set-ADUser -Identity $h -Replace @{ 'msDS-SupportedEncryptionTypes' = ${AD_AES_NUR} } -Server $dc -Credential $c; if ($z -ne 'angelegt') { $z = 'geaendert' } }`,
    "  if (-not $h.AccountNotDelegated) { Set-ADUser -Identity $h -AccountNotDelegated $true -Server $dc -Credential $c; if ($z -ne 'angelegt') { $z = 'geaendert' } }",
    ...ANMELDESPERRE,
    "  if (-not @(Get-ADGroupMember -Identity $sg -Server $dc -Credential $c | Where-Object { $_.SamAccountName -eq $p.konto }).Count) { Add-ADGroupMember -Identity $sg -Members $p.konto -Server $dc -Credential $c; if ($z -ne 'angelegt') { $z = 'geaendert' } }",
    "  $sperre.mitglied = [bool]@(Get-ADGroupMember -Identity $sg -Server $dc -Credential $c | Where-Object { $_.SamAccountName -eq $p.konto }).Count",
    '}',
    '$anm = [bool](Anmeldung)',
    "$u = Get-ADUser -Identity $p.konto -Properties PasswordNeverExpires, CannotChangePassword, Enabled, 'msDS-SupportedEncryptionTypes', AccountNotDelegated -Server $dc -Credential $c",
    "Ergebnis @{ zustand = $z; konto = ($d.NetBIOSName + '\\' + $p.konto); dn = [string]$u.DistinguishedName; aktiv = [bool]$u.Enabled; laeuftNieAb = [bool]$u.PasswordNeverExpires; kannNichtAendern = [bool]$u.CannotChangePassword; inOu = ([string]$u.DistinguishedName).EndsWith(',' + $pfad); anmeldung = $anm; verschluesselung = [int]$u.'msDS-SupportedEncryptionTypes'; keineDelegierung = [bool]$u.AccountNotDelegated; anmeldesperre = $(if ($p.haerten) { $sperre } else { $null }) }",
  ].join('\n');
}

/** I8e Etappe 3 — msDS-SupportedEncryptionTypes: AES128 (0x08) + AES256 (0x10) */
export const AD_AES_NUR = 24;
/** I8e Etappe 3 (Ruling R3) — Gruppe der Dienstkonten ohne interaktive/RDP-Anmeldung und die GPO, die das domänenweit durchsetzt */
export const SPERR_GRUPPE = 'Dienstkonten-KeineAnmeldung';
export const SPERR_GRUPPE_OU = 'Dienstkonten';
export const SPERR_GRUPPE_BESCHREIBUNG = 'Alfred I8e: Dienstkonten ohne interaktive und RDP-Anmeldung (GPO AD3033 Dienstkonten keine Anmeldung)';
export const SPERR_GPO = 'AD3033 Dienstkonten keine Anmeldung';
/** Fix-Runde 2 (R6) — Kommentar (Description) der GPO als Alfred-Marke; eine gleichnamige GPO ohne ihn wird nie übernommen */
export const SPERR_GPO_KOMMENTAR = 'Alfred I8e: Dienstkonten ohne interaktive und RDP-Anmeldung';
/** Client-Erweiterung „Sicherheitseinstellungen“ + Werkzeug-Erweiterung, Pflicht in gPCMachineExtensionNames für GptTmpl.inf */
export const SICHERHEIT_CSE = '[{827D319E-6EAC-11D2-A4EA-00C04F79F83A}{803E14A0-B4FB-11D0-A0D0-00A0C90F574B}]';

/**
 * Anmeldesperre (Teil von dienstkontoSkript mit haerten; braucht $d, $dc, $c, $z): Gruppe in OU Dienstkonten (fremde gleichnamige →
 * Abbruch), GPO an der Domänenwurzel mit SeDenyInteractiveLogonRight + SeDenyRemoteInteractiveLogonRight für die Gruppe. Die
 * GroupPolicy-Cmdlets haben kein -Credential: GPO-Teil über WinRM am eigenen DC mit dem Domänen-Administrator (wie KDS in
 * grundstrukturSkript), alle Zugriffe gegen diesen DC (lokales SYSVOL, -Server) — kein zweiter Sprung. Liefert $sg (Gruppe) und $sperre.
 */
const ANMELDESPERRE = [
  // Fix-Runde 3 (R7): alles im WinRM-Block mit vollem Token. Reihenfolge: nur lesen und prüfen (fremde Gruppe? fremde oder abweichende
  // GPO?) → erst dann Gruppe und GPO anlegen → eine neu angelegte GPO erneut prüfen → erst dann schreiben und verknüpfen.
  `  $sperre = Invoke-Command -ComputerName $env:COMPUTERNAME -Credential $c -ArgumentList ${psText(SPERR_GPO)}, ${psText(SPERR_GRUPPE)}, ${psText(SPERR_GRUPPE_OU)}, ${psText(SPERR_GRUPPE_BESCHREIBUNG)}, $d.DistinguishedName, $d.DNSRoot, $dc, ${psText(SICHERHEIT_CSE)}, ${psText(SPERR_GPO_KOMMENTAR)} -ScriptBlock {`,
  '    param([string]$name, [string]$gname, [string]$gou, [string]$gbeschr, [string]$dn, [string]$root, [string]$server, [string]$cse, [string]$kommentar)',
  "    $ErrorActionPreference = 'Stop'; Import-Module GroupPolicy, ActiveDirectory",
  "    $r = [ordered]@{ gruppeNeu = $false; gpo = 'schon'; inhalt = 'schon'; link = 'schon' }; $angelegt = @()",
  "    $domSid = (Get-ADDomain -Server $server).DomainSID.Value; $rootSid = (Get-ADDomain -Identity (Get-ADForest -Server $server).RootDomain -Server $server).DomainSID.Value",
  // Berechtigte: Domänen-Admins, Organisations-Admins (Stammdomäne), SYSTEM, Administratoren des DCs (erben SYSVOL und die AD-Wurzel),
  // dazu ERSTELLER-BESITZER (S-1-3-0, Vorlage für neue Objekte)
  "    $admins = @(($domSid + '-512'), ($rootSid + '-519'), 'S-1-5-18', 'S-1-5-32-544'); $mitCO = $admins + @('S-1-3-0')",
  "    $sg = Get-ADGroup -Filter (\"SamAccountName -eq '\" + $gname + \"'\") -Properties Description -Server $server",
  "    if ($sg -and $sg.Description -ne $gbeschr) { throw ('Gruppe ' + $gname + ' ist nicht von Alfred angelegt - nichts geändert') }",
  '    $sid = $(if ($sg) { [string]$sg.SID.Value } else { $null })',
  // Prüfung einer (vorhandenen oder eben angelegten) GPO — sammelt jede Abweichung in $abw, ändert nichts
  '    function Pruefe($g, $abw) {',
  "      $gid = '{' + $g.Id.ToString().ToUpper() + '}'",
  "      $pb = Join-Path (Get-SmbShare -Name SYSVOL).Path ($root + '\\Policies\\' + $gid)",
  "      $pad = 'CN=' + $gid + ',CN=Policies,CN=System,' + $dn",
  '      $po = Get-ADObject -Identity $pad -Properties gPCMachineExtensionNames, gPCUserExtensionNames -Server $server',
  "      if ([string]$po.gPCUserExtensionNames) { [void]$abw.Add('Benutzer-Erweiterungen ' + [string]$po.gPCUserExtensionNames) }",
  "      if ([string]$po.gPCMachineExtensionNames -and [string]$po.gPCMachineExtensionNames -ne $cse) { [void]$abw.Add('Computer-Erweiterungen ' + [string]$po.gPCMachineExtensionNames) }",
  "      if (-not (Test-Path -LiteralPath $pb)) { [void]$abw.Add('SYSVOL-Ordner ' + $pb + ' fehlt') } else {",
  "        $fremd = @(Get-ChildItem -LiteralPath $pb -Recurse -File -Force | ForEach-Object { $_.FullName.Substring($pb.Length).TrimStart('\\') } | Where-Object { $_ -ine 'GPT.INI' -and $_ -ine 'Machine\\Microsoft\\Windows NT\\SecEdit\\GptTmpl.inf' })",
  "        if ($fremd.Count) { [void]$abw.Add('fremde Dateien ' + ($fremd -join ', ')) }",
  "        $pdat = Join-Path $pb 'Machine\\Microsoft\\Windows NT\\SecEdit\\GptTmpl.inf'",
  '        if (Test-Path -LiteralPath $pdat) {',
  "          $abschnitt = ''; $erlaubt = @{ 'Unicode' = @('Unicode'); 'Version' = @('signature', 'Revision'); 'Privilege Rights' = @('SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight') }",
  "          foreach ($zl in ([IO.File]::ReadAllText($pdat) -split \"`r?`n\")) { $zl = $zl.Trim(); if (-not $zl) { continue }",
  "            $m = [regex]::Match($zl, '^\\[(.+)\\]$'); if ($m.Success) { $abschnitt = $m.Groups[1].Value; if (-not $erlaubt.ContainsKey($abschnitt)) { [void]$abw.Add('GptTmpl.inf-Abschnitt [' + $abschnitt + ']') }; continue }",
  "            $teil = $zl -split '=', 2; $schl = $teil[0].Trim(); $wert = $(if ($teil.Count -gt 1) { $teil[1].Trim() } else { '' })",
  "            if (-not $erlaubt.ContainsKey($abschnitt) -or $erlaubt[$abschnitt] -notcontains $schl) { [void]$abw.Add('GptTmpl.inf-Eintrag ' + $schl + ' in [' + $abschnitt + ']'); continue }",
  // Werte der beiden Rechte: genau die SID von Dienstkonten-KeineAnmeldung
  "            if ($abschnitt -eq 'Privilege Rights' -and (-not $sid -or $wert -ne ('*' + $sid))) { [void]$abw.Add('Wert von ' + $schl + ': ' + $wert + $(if (-not $sid) { ' (Gruppe ' + $gname + ' fehlt)' } else { ' statt *' + $sid })) } }",
  '        }',
  // Dateirechte im SYSVOL: Schreiben/Ändern/Vollzugriff nur für die Berechtigten
  "        $fsMaske = [int64]0x500D0156",
  "        foreach ($ele in @(@(Get-Item -LiteralPath $pb -Force) + @(Get-ChildItem -LiteralPath $pb -Recurse -Force))) { foreach ($a in (Get-Acl -LiteralPath $ele.FullName).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) { if ([string]$a.AccessControlType -eq 'Allow' -and ([int64]$a.FileSystemRights -band $fsMaske) -and $mitCO -notcontains $a.IdentityReference.Value) { [void]$abw.Add('SYSVOL-Schreibrecht ' + [string]$a.FileSystemRights + ' für ' + $a.IdentityReference.Value + ' auf ' + $ele.FullName.Substring($pb.Length).TrimStart('\\')) } } }",
  '      }',
  // GPMC-Bearbeiten-Rechte
  "      foreach ($x in @(Get-GPPermission -Guid $g.Id -All -Server $server)) { if ([string]$x.Permission -in @('GpoEdit', 'GpoEditDeleteModifySecurity', 'GpoCustom') -and $mitCO -notcontains [string]$x.Trustee.Sid.Value) { [void]$abw.Add('Bearbeiten-Recht ' + [string]$x.Permission + ' für ' + [string]$x.Trustee.Name) } }",
  // Besitzer und DACL des AD-Objekts (ein Besitzer hat immer WRITE_DAC, unabhängig von Get-GPPermission)
  "      $acl = Get-Acl -Path ('AD:' + $pad); $besitzer = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
  "      if ($admins -notcontains $besitzer) { [void]$abw.Add('Besitzer des GPO-Objekts ' + $besitzer) }",
  // CreateChild 0x1, DeleteChild 0x2, WriteDacl 0x40000, WriteOwner 0x80000 (GenericAll enthält sie); WriteProperty 0x20 nur für alle Eigenschaften (GenericWrite enthält es)
  "      foreach ($a in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) { if ([string]$a.AccessControlType -ne 'Allow' -or $mitCO -contains $a.IdentityReference.Value) { continue }; $rr = [int64]$a.ActiveDirectoryRights; if (($rr -band 0xC0003) -or (($rr -band 0x20) -and $a.ObjectType -eq [guid]::Empty)) { [void]$abw.Add('AD-Recht ' + [string]$a.ActiveDirectoryRights + ' für ' + $a.IdentityReference.Value) } }",
  '    }',
  '    $g = Get-GPO -Name $name -Server $server -ErrorAction SilentlyContinue',
  "    if ($g -and [string]$g.Description -ne $kommentar) { throw ('GPO ' + $name + ' ist nicht von Alfred angelegt - nichts geändert') }",
  "    if ($g) { $abw = New-Object System.Collections.ArrayList; Pruefe $g $abw; if ($abw.Count) { throw ('GPO ' + $name + ' weicht ab (' + ($abw -join '; ') + ') - nichts geändert') } }",
  // erst nach allen Prüfungen anlegen
  "    if (-not $sg) { New-ADGroup -Name $gname -SamAccountName $gname -GroupScope Global -GroupCategory Security -Path ('OU=' + $gou + ',' + $dn) -Description $gbeschr -Server $server; $sg = Get-ADGroup -Identity $gname -Server $server; $sid = [string]$sg.SID.Value; $r.gruppeNeu = $true; $angelegt += ('Gruppe ' + $gname) }",
  "    if (-not $g) { $g = New-GPO -Name $name -Server $server -Comment $kommentar; $r.gpo = 'angelegt'; $angelegt += ('GPO ' + $name)",
  "      $abw = New-Object System.Collections.ArrayList; Pruefe $g $abw; if ($abw.Count) { throw ('GPO ' + $name + ' weicht nach dem Anlegen ab (' + ($abw -join '; ') + ') - in diesem Lauf angelegt: ' + ($angelegt -join ', ') + '; nicht beschrieben, nicht verknüpft') } }",
  "    $id = '{' + $g.Id.ToString().ToUpper() + '}'",
  "    $basis = Join-Path (Get-SmbShare -Name SYSVOL).Path ($root + '\\Policies\\' + $id)",
  "    $sec = Join-Path $basis 'Machine\\Microsoft\\Windows NT\\SecEdit'; $datei = Join-Path $sec 'GptTmpl.inf'",
  "    $soll = (@('[Unicode]', 'Unicode=yes', '[Version]', 'signature=\"$CHICAGO$\"', 'Revision=1', '[Privilege Rights]', ('SeDenyInteractiveLogonRight = *' + $sid), ('SeDenyRemoteInteractiveLogonRight = *' + $sid)) -join \"`r`n\") + \"`r`n\"",
  "    $ad = 'CN=' + $id + ',CN=Policies,CN=System,' + $dn",
  "    $o = Get-ADObject -Identity $ad -Properties gPCMachineExtensionNames -Server $server",
  "    $ext = [string]$o.gPCMachineExtensionNames",
  "    $ist = if (Test-Path -LiteralPath $datei) { [IO.File]::ReadAllText($datei) } else { '' }",
  "    if ($ist -ne $soll -or $ext.IndexOf($cse) -lt 0) {",
  '      New-Item -ItemType Directory -Path $sec -Force | Out-Null',
  '      [IO.File]::WriteAllText($datei, $soll, [Text.Encoding]::Unicode)',
  // Version: GPT.INI und versionNumber des GPO-Objekts gemeinsam (Computer-Teil +1), sonst wenden Clients die Änderung nicht an
  "      $ini = Join-Path $basis 'GPT.INI'; $txt = if (Test-Path -LiteralPath $ini) { [IO.File]::ReadAllText($ini) } else { '' }",
  "      $m = [regex]::Match($txt, 'Version=(\\d+)'); $neu = $(if ($m.Success) { [int]$m.Groups[1].Value } else { 0 }) + 1",
  "      $txt = if ($m.Success) { [regex]::Replace($txt, 'Version=\\d+', ('Version=' + $neu)) } else { \"[General]`r`nVersion=$neu`r`n\" }",
  '      [IO.File]::WriteAllText($ini, $txt, [Text.Encoding]::ASCII)',
  '      $set = @{ versionNumber = $neu }; if ($ext.IndexOf($cse) -lt 0) { $set.gPCMachineExtensionNames = $ext + $cse }',
  "      Set-ADObject -Identity $ad -Replace $set -Server $server; $r.inhalt = 'geschrieben'",
  '    }',
  '    $l = @((Get-GPInheritance -Target $dn -Server $server).GpoLinks | Where-Object { $_.GpoId -eq $g.Id })',
  "    if (-not $l.Count) { New-GPLink -Guid $g.Id -Target $dn -LinkEnabled Yes -Server $server | Out-Null; $r.link = 'angelegt' }",
  "    elseif (-not $l[0].Enabled) { Set-GPLink -Guid $g.Id -Target $dn -LinkEnabled Yes -Server $server | Out-Null; $r.link = 'aktiviert' }",
  // Zurücklesen: Verknüpfung an der Domänenwurzel, beide Rechte in GptTmpl.inf, Sicherheits-Erweiterung eingetragen
  '    $l = @((Get-GPInheritance -Target $dn -Server $server).GpoLinks | Where-Object { $_.GpoId -eq $g.Id })',
  '    $txt = [IO.File]::ReadAllText($datei); $o = Get-ADObject -Identity $ad -Properties gPCMachineExtensionNames -Server $server',
  "    $r.gpoName = $name; $r.gpoId = $id; $r.verknuepft = [bool]($l.Count -and $l[0].Enabled)",
  "    $r.lokal = $txt -match ('(?m)^SeDenyInteractiveLogonRight = \\*' + [regex]::Escape($sid) + '\\s*$')",
  "    $r.rdp = $txt -match ('(?m)^SeDenyRemoteInteractiveLogonRight = \\*' + [regex]::Escape($sid) + '\\s*$')",
  '    $r.erweiterung = ([string]$o.gPCMachineExtensionNames).IndexOf($cse) -ge 0',
  '    [pscustomobject]$r',
  '  }',
  "  if ($sperre.gruppeNeu -or $sperre.gpo -ne 'schon' -or $sperre.inhalt -ne 'schon' -or $sperre.link -ne 'schon') { if ($z -ne 'angelegt') { $z = 'geaendert' } }",
  `  $sg = Get-ADGroup -Identity ${psText(SPERR_GRUPPE)} -Server $dc -Credential $c`,
  // Fix-Runde 3: vorher stand hier ${…} in einem gewöhnlichen String — PowerShell las das als Variable (immer leer)
  `  $sperre = [ordered]@{ gruppe = ${psText(SPERR_GRUPPE)}; gpo = [string]$sperre.gpoName; gpoId = [string]$sperre.gpoId; verknuepft = [bool]$sperre.verknuepft; lokal = [bool]$sperre.lokal; rdp = [bool]$sperre.rdp; erweiterung = [bool]$sperre.erweiterung; mitglied = $false }`,
];

export interface Anmeldesperre { gruppe?: string; gpo?: string; verknuepft?: boolean; lokal?: boolean; rdp?: boolean; erweiterung?: boolean; mitglied?: boolean }
/** Härtung vollständig zurückgelesen? (Ergebnis von dienstkontoSkript mit haerten) */
export function dienstkontoGehaertet(r: { verschluesselung?: number; keineDelegierung?: boolean; laeuftNieAb?: boolean; anmeldesperre?: Anmeldesperre | null }): string | undefined {
  const f: string[] = [];
  const s = r.anmeldesperre ?? {};
  if (r.verschluesselung !== AD_AES_NUR) f.push(`Verschlüsselung ${r.verschluesselung ?? '?'} statt ${AD_AES_NUR} (nur AES)`);
  if (r.keineDelegierung !== true) f.push('Delegierung nicht gesperrt');
  if (r.laeuftNieAb !== true) f.push('Kennwort läuft ab');
  if (s.mitglied !== true) f.push(`nicht Mitglied von ${SPERR_GRUPPE}`);
  if (s.verknuepft !== true) f.push(`GPO „${SPERR_GPO}“ nicht an der Domänenwurzel verknüpft`);
  if (s.lokal !== true) f.push('SeDenyInteractiveLogonRight fehlt in der GPO');
  if (s.rdp !== true) f.push('SeDenyRemoteInteractiveLogonRight fehlt in der GPO');
  if (s.erweiterung !== true) f.push('Sicherheits-Erweiterung fehlt in gPCMachineExtensionNames');
  return f.length ? f.join(', ') : undefined;
}

/** Entfernt nur ein von Alfred angelegtes Dienstkonto (Beschreibung „Alfred I8e Dienstkonto“); der Tresor-Eintrag bleibt */
export function dienstkontoEntfernenSkript(p: { konto: string; ausKonto?: string }): string {
  return [
    ...kopf(p, true),
    'Import-Module ActiveDirectory',
    adAdminCred,
    "$u = Get-ADUser -Filter (\"SamAccountName -eq '\" + $p.konto + \"'\") -Properties Description -Server $dc -Credential $c",
    `if (-not $u) { $z = 'nicht vorhanden' } elseif ($u.Description -ne ${psText(DIENSTKONTO_BESCHREIBUNG)}) { throw ('Konto ' + $p.konto + ' ist nicht von Alfred angelegt') } else { Remove-ADUser -Identity $u -Confirm:$false -Server $dc -Credential $c; $z = 'entfernt' }`,
    "if (Get-ADUser -Filter (\"SamAccountName -eq '\" + $p.konto + \"'\") -Server $dc -Credential $c) { throw ('Konto ' + $p.konto + ' nach dem Entfernen noch vorhanden') }",
    'Ergebnis @{ konto = $p.konto; zustand = $z }',
  ].join('\n');
}

/** Ergebniszeile aus der Ausgabe (CLIXML-Fortschritt u. Ä. davor/danach wird ignoriert) */
/**
 * Fehlertexte aus dem CLIXML-Strom von PowerShell über SSH (Realfall 3103ec4c: der Fehler stand nur in `<S S="Error">…</S>`,
 * die Meldung lautete deshalb „keine Ausgabe“).
 */
export function clixmlFehler(text: string): string {
  const teile = [...text.matchAll(/<S S="Error">([^<]*)<\/S>/g)].map(m => m[1]!
    .replace(/_x000D_/g, '').replace(/_x000A_/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
  return teile.join('').replace(/\s+/g, ' ').trim();
}

export function adErgebnis<T = Record<string, unknown>>(stdout: string): T | undefined {
  const z = stdout.split(/\r?\n/).reverse().find(l => l.startsWith(AD_ERGEBNIS));
  if (!z) return undefined;
  try { return JSON.parse(z.slice(AD_ERGEBNIS.length)) as T; } catch { return undefined; }
}

/** Für die Windows-Shell: Skript als -EncodedCommand (UTF-16LE, Base64) — keine Anführungszeichen über SSH */
export function kodiert(skript: string): string {
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(skript, 'utf16le').toString('base64')}`;
}
