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
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const OU_NAME = /^[\p{L}\p{N} ._-]{1,60}$/u;
const DNS_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const NTP = /^[a-z0-9.-]{3,80}$/i;

/** PowerShell-Literal in einfachen Anführungszeichen (nur ' verdoppeln) */
const psText = (s: string) => `'${s.replace(/'/g, "''")}'`;
const kopf = (p: unknown, mitEingabe: boolean) => [
  "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'",
  `$p = ${psText(JSON.stringify(p))} | ConvertFrom-Json`,
  ...(mitEingabe ? ['$e = [Console]::In.ReadToEnd() | ConvertFrom-Json'] : []),
  `function Ergebnis($o) { [Console]::Out.WriteLine(${psText(AD_ERGEBNIS)} + ($o | ConvertTo-Json -Compress -Depth 5)) }`,
];
const dnsSetzen = "Get-NetAdapter | Where-Object Status -eq 'Up' | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ServerAddresses @($p.dns) }";
const neustart = (grund: string) => `shutdown.exe /r /t 20 /d p:4:1 /c ${psText(`Alfred: ${grund}`)}`;

export interface AdStatus {
  rechner: string; domaene: string; mitglied: boolean; rolle: number;
  dienste?: Record<string, string>; pdc?: string; dcs?: string[]; netbios?: string; papierkorb?: boolean; adFehler?: string;
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
    '}',
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

export function adStatusText(s: AdStatus): string {
  if (s.rolle >= 4) {
    const dienste = Object.entries(s.dienste ?? {}).filter(([, z]) => z !== 'Running').map(([n, z]) => `${n} ${z}`);
    return `${s.rechner}: Domänencontroller von ${s.domaene}${s.pdc ? ` (PDC ${s.pdc})` : ''}${s.dcs?.length ? `, DCs: ${s.dcs.join(', ')}` : ''}${s.papierkorb ? ', AD-Papierkorb an' : ''}; Dienste ${dienste.length ? `NICHT alle laufend: ${dienste.join(', ')}` : 'laufen'}${s.adFehler ? `; AD-Abfrage: ${s.adFehler}` : ''}`;
  }
  return s.mitglied ? `${s.rechner}: Mitglied der Domäne ${s.domaene}` : `${s.rechner}: keiner Domäne beigetreten (Arbeitsgruppe ${s.domaene})`;
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
export function dcSkript(p: { domaene: string; netbios: string; dns: string[] }): string {
  return [
    ...kopf(p, true),
    '$cs = Get-CimInstance -ClassName Win32_ComputerSystem',
    "if ($cs.DomainRole -ge 4) { if ($cs.Domain -ieq $p.domaene) { Ergebnis @{ zustand = 'schon'; domaene = [string]$cs.Domain }; exit 0 } else { throw ('bereits Domänencontroller von ' + $cs.Domain) } }",
    "if ($cs.PartOfDomain -and $cs.Domain -ine $p.domaene) { throw ('Mitglied einer anderen Domäne: ' + $cs.Domain) }",
    dnsSetzen,
    "if (-not (Resolve-DnsName -Name ('_ldap._tcp.dc._msdcs.' + $p.domaene) -Type SRV -DnsOnly -ErrorAction SilentlyContinue)) { throw ('Domäne ' + $p.domaene + ' über ' + ($p.dns -join ', ') + ' nicht auflösbar') }",
    'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools | Out-Null',
    'Import-Module ADDSDeployment',
    "$cred = New-Object System.Management.Automation.PSCredential(($p.netbios + '\\alfred'), (ConvertTo-SecureString -String $e.kennwort -AsPlainText -Force))",
    '$pw = ConvertTo-SecureString -String $e.dsrm -AsPlainText -Force',
    'Install-ADDSDomainController -DomainName $p.domaene -Credential $cred -InstallDns -SafeModeAdministratorPassword $pw -NoRebootOnCompletion -Force -WarningAction SilentlyContinue | Out-Null',
    neustart('Hochstufen zum weiteren Domänencontroller'),
    "Ergebnis @{ zustand = 'hochgestuft'; neustart = $true }",
  ].join('\n');
}

/** Mitgliedsserver beitreten (eingabe: { kennwort }); DNS auf die DCs; optional OU (relativ, z. B. „Server“) */
export function beitrittSkript(p: { domaene: string; netbios: string; dns: string[]; ou?: string }): string {
  return [
    ...kopf(p, true),
    '$cs = Get-CimInstance -ClassName Win32_ComputerSystem',
    "if ($cs.PartOfDomain) { if ($cs.Domain -ieq $p.domaene) { Ergebnis @{ zustand = 'schon'; domaene = [string]$cs.Domain }; exit 0 } else { throw ('Mitglied einer anderen Domäne: ' + $cs.Domain) } }",
    dnsSetzen,
    "if (-not (Resolve-DnsName -Name ('_ldap._tcp.dc._msdcs.' + $p.domaene) -Type SRV -DnsOnly -ErrorAction SilentlyContinue)) { throw ('Domäne ' + $p.domaene + ' über ' + ($p.dns -join ', ') + ' nicht auflösbar') }",
    "$cred = New-Object System.Management.Automation.PSCredential(($p.netbios + '\\alfred'), (ConvertTo-SecureString -String $e.kennwort -AsPlainText -Force))",
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
export function grundstrukturSkript(p: { ous: string[]; ntp: string[]; weiterleiter: string[] }): string {
  return [
    ...kopf(p, false),
    'Import-Module ActiveDirectory',
    '$d = Get-ADDomain; $dn = $d.DistinguishedName; $r = [ordered]@{ ous = @(); papierkorb = $false }',
    "if ($env:COMPUTERNAME -ine ($d.PDCEmulator -split '\\.')[0]) { throw ('nur am PDC-Emulator ' + $d.PDCEmulator) }",
    "foreach ($ou in $p.ous) { if (-not (Get-ADOrganizationalUnit -LDAPFilter ('(ou=' + $ou + ')') -SearchBase $dn -SearchScope OneLevel)) { New-ADOrganizationalUnit -Name $ou -Path $dn -ProtectedFromAccidentalDeletion $true; $r.ous += $ou } }",
    "$f = Get-ADOptionalFeature -Filter \"Name -eq 'Recycle Bin Feature'\"",
    "if (-not $f.EnabledScopes.Count) { Enable-ADOptionalFeature -Identity 'Recycle Bin Feature' -Scope ForestOrConfigurationSet -Target (Get-ADForest).Name -Confirm:$false; $r.papierkorbNeu = $true }",
    "$r.papierkorb = [bool]((Get-ADOptionalFeature -Filter \"Name -eq 'Recycle Bin Feature'\").EnabledScopes.Count)",
    "$da = Get-ADGroup -Identity ($d.DomainSID.Value + '-512')",
    "if (-not (Get-ADGroupMember -Identity $da | Where-Object SamAccountName -eq 'alfred')) { Add-ADGroupMember -Identity $da -Members 'alfred'; $r.alfredAdmin = 'neu' } else { $r.alfredAdmin = 'schon' }",
    "$peers = ($p.ntp | ForEach-Object { $_ + ',0x8' }) -join ' '",
    "w32tm.exe /config /manualpeerlist:$peers /syncfromflags:manual /reliable:yes /update | Out-Null",
    'Restart-Service -Name W32Time; w32tm.exe /resync /nowait | Out-Null',
    '$r.ntp = $p.ntp',
    'if (@($p.weiterleiter).Count) { Set-DnsServerForwarder -IPAddress @($p.weiterleiter); $r.weiterleiter = @((Get-DnsServerForwarder).IPAddress | ForEach-Object { [string]$_ }) }',
    "if (-not (Get-KdsRootKey)) { Add-KdsRootKey -EffectiveImmediately | Out-Null; $r.kds = 'neu (gMSA nach Replikation, bis 10 h)' } else { $r.kds = 'schon' }",
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
export function papierkorbSkript(p: { kennung: string }): string {
  return [
    ...kopf(p, false),
    'Import-Module ActiveDirectory',
    "$n = 'alfred-pk-' + $p.kennung",
    '$dn = (Get-ADDomain).UsersContainer',
    'New-ADUser -Name $n -SamAccountName $n -Path $dn -Enabled $false -Description "Alfred: Beweis AD-Papierkorb (I8c)"',
    '$guid = (Get-ADUser -Identity $n).ObjectGUID',
    'Remove-ADUser -Identity $guid -Confirm:$false',
    "if (Get-ADUser -Filter \"SamAccountName -eq '$n'\") { throw 'Testkonto nach dem Löschen noch da' }",
    '$geloescht = Get-ADObject -Filter "ObjectGUID -eq \'$guid\'" -IncludeDeletedObjects',
    "if (-not $geloescht.Deleted) { throw 'Testkonto nicht im Papierkorb' }",
    'Restore-ADObject -Identity $guid',
    '$zurueck = Get-ADUser -Identity $guid',
    "if ($zurueck.SamAccountName -ne $n) { throw 'Wiederherstellung nicht belegt' }",
    'Remove-ADUser -Identity $guid -Confirm:$false',
    "Ergebnis @{ konto = $n; geloescht = $true; wiederhergestellt = $true; objectGuid = [string]$guid; danachEntfernt = $true }",
  ].join('\n');
}

export function pruefeDnsEintrag(p: { zone: string; name: string; ip?: string }): string | undefined {
  if (!AD_DOMAENE.test(p.zone)) return 'zone: DNS-Zone, z. B. ad.3033.at';
  if (!DNS_NAME.test(p.name)) return 'name: einfacher Name ohne Punkt, z. B. alfred-test-1';
  if (p.ip !== undefined && !IPV4.test(p.ip)) return 'ip: IPv4-Adresse';
  return undefined;
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

/** Ergebniszeile aus der Ausgabe (CLIXML-Fortschritt u. Ä. davor/danach wird ignoriert) */
export function adErgebnis<T = Record<string, unknown>>(stdout: string): T | undefined {
  const z = stdout.split(/\r?\n/).reverse().find(l => l.startsWith(AD_ERGEBNIS));
  if (!z) return undefined;
  try { return JSON.parse(z.slice(AD_ERGEBNIS.length)) as T; } catch { return undefined; }
}

/** Für die Windows-Shell: Skript als -EncodedCommand (UTF-16LE, Base64) — keine Anführungszeichen über SSH */
export function kodiert(skript: string): string {
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(skript, 'utf16le').toString('base64')}`;
}
