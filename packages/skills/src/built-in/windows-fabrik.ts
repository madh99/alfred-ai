/**
 * Spec I8 Windows (docs/specs/2026-11-01-windows-i8.md, Owner 01.11.2026 „Spec freigegeben“) — I8a Windows-Vorlagen-Fabrik.
 *
 * Reine Logik ohne Netz: Testversionen aus dem Microsoft Evaluation Center (aktuellste Server-Version, Windows 11 Enterprise),
 * VirtIO-Treiber (versioniertes ISO von fedorapeople), Cloudbase-Init (versioniertes MSI von GitHub), Auswahl des Abbilds aus dem
 * WIM-Verzeichnis, Antwortdatei für die unbeaufsichtigte Installation, Einrichtungsskript in der VM, Sysprep-Antwortdatei und
 * Benutzerdaten je Klon (Host-Schlüssel von Alfred, Anmeldeschlüssel, Kennwort).
 *
 * Microsoft und Fedora veröffentlichen für die ISOs keine Prüfsummen: Herkunft nur über HTTPS von festen Hosts, die SHA-256 wird
 * nach dem Herunterladen am Knoten berechnet und mit der Buildnummer in der Vorlage festgehalten.
 */

export type WinProdukt = 'server' | 'win11';
export type WinVariante = 'server-standard-core' | 'server-standard-desktop' | 'server-datacenter-core' | 'server-datacenter-desktop' | 'win11';
export const WIN_VARIANTEN: WinVariante[] = ['server-standard-core', 'server-standard-desktop', 'server-datacenter-core', 'server-datacenter-desktop', 'win11'];
export const istWinVariante = (x: unknown): x is WinVariante => typeof x === 'string' && (WIN_VARIANTEN as string[]).includes(x);

export const EVAL_BASIS = 'https://www.microsoft.com/en-us/evalcenter/';
/** Kandidaten für „aktuellste Server-Version“: Download-Seiten je Jahr, neueste zuerst (eine Seite für ein künftiges Jahr gibt es erst mit der Version) */
export const serverSeiten = (jetzt: Date) => { const j = jetzt.getUTCFullYear(); return Array.from({ length: j - 2024 + 2 }, (_x, i) => j + 1 - i).filter(y => y >= 2025).map(y => ({ version: String(y), url: `${EVAL_BASIS}download-windows-server-${y}` })); };
export const WIN11_SEITE = `${EVAL_BASIS}download-windows-11-enterprise`;

/** Sprache im Evaluation Center (aria-label „… (de-DE)“) */
export const SPRACHE = /^[a-z]{2}-[a-z]{2}$/;

/** Download-Links einer Evaluation-Center-Seite: je Sprache der fwlink des 64-bit-ISO (Windows 11 ohne LTSC) */
export function evalLinks(html: string, produkt: WinProdukt): Array<{ sprache: string; fwlink: string; version?: string }> {
  const aus: Array<{ sprache: string; fwlink: string; version?: string }> = [];
  const a = /<a\b[^>]*>/g;
  for (const m of html.matchAll(a)) {
    const tag = m[0].replace(/&amp;/g, '&').replace(/&#61;/g, '=');
    const label = /aria-label="([^"]*)"/.exec(tag)?.[1] ?? '';
    const href = /href="(https:\/\/go\.microsoft\.com\/fwlink\/\?[^"]+)"/.exec(tag)?.[1];
    if (!href) continue;
    const muster = produkt === 'server' ? /Download Windows Server (\d{4})[^"]*? ISO 64-bit \(([a-z]{2}-[A-Z]{2})\)/ : /Download Windows 11 Enterprise ISO 64-bit \(([a-z]{2}-[A-Z]{2})\)/;
    const t = muster.exec(label);
    if (!t || /LTSC/.test(label)) continue;
    const sprache = (produkt === 'server' ? t[2]! : t[1]!).toLowerCase();
    if (aus.some(x => x.sprache === sprache)) continue;
    aus.push({ sprache, fwlink: href, ...(produkt === 'server' ? { version: t[1]! } : {}) });
  }
  return aus;
}

/** Erlaubte Ziele der Downloads (nach Weiterleitung) — nur die Herausgeber, nur HTTPS, nur versionierte Dateien */
export const WIN_ISO_URL = /^https:\/\/software-static\.download\.prss\.microsoft\.com\/[A-Za-z0-9/._-]{10,200}\.iso$/;
export const VIRTIO_URL = /^https:\/\/fedorapeople\.org\/groups\/virt\/virtio-win\/direct-downloads\/archive-virtio\/virtio-win-0\.1\.\d{2,4}-\d+\/virtio-win-0\.1\.\d{2,4}\.iso$/;
export const CLOUDBASE_URL = /^https:\/\/github\.com\/cloudbase\/cloudbase-init\/releases\/download\/(\d+\.\d+\.\d+)\/CloudbaseInitSetup_\d+_\d+_\d+_x64\.msi$/;
export const VIRTIO_ARCHIV = 'https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/';

/** Buildnummer aus dem Dateinamen des Microsoft-ISO („26100.32230.260111-0550…“) */
export function buildAusUrl(url: string): string | undefined {
  return /\/(\d{5}\.\d{1,6})\.\d{6}-\d{4}\.[^/]*\.iso$/.exec(url)?.[1];
}

/** Neueste VirtIO-Version aus dem Archiv-Listing */
export function neuesteVirtio(listing: string): { version: string; url: string } | undefined {
  const v = [...new Set([...listing.matchAll(/virtio-win-0\.1\.(\d{2,4})-(\d+)\//g)].map(m => `${m[1]}-${m[2]}`))]
    .sort((a, b) => { const [x1, x2] = a.split('-').map(Number); const [y1, y2] = b.split('-').map(Number); return x1! - y1! || x2! - y2!; }).pop();
  if (!v) return undefined;
  const [haupt] = v.split('-');
  return { version: `0.1.${v}`, url: `${VIRTIO_ARCHIV}virtio-win-0.1.${v}/virtio-win-0.1.${haupt}.iso` };
}

/** Dateinamen im ISO-Speicher */
export const ISO_DATEI = /^[a-z0-9][a-z0-9._-]{2,90}\.iso$/;
export const ISO_VOLUME = /^[a-zA-Z][\w-]{0,40}:iso\/[a-z0-9][a-z0-9._-]{2,90}\.iso$/;
export function isoDateiname(produkt: WinProdukt, version: string, build: string, sprache: string): string {
  return `${produkt === 'server' ? `win-server-${version}` : 'win11-enterprise'}-eval-${build}-${sprache}.iso`.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}

// ── Abbild im ISO ───────────────────────────────────────────────

export interface WimAbbild { index: number; name: string; editionId: string; installationType: string; build?: string }

/** Abbild zur Variante: Edition aus EDITIONID, Core/Desktop aus INSTALLATIONTYPE („Server Core“ / „Server“), Windows 11 = Enterprise */
export function waehleAbbild(abbilder: WimAbbild[], v: WinVariante): WimAbbild | undefined {
  if (v === 'win11') return abbilder.find(a => /enterprise/i.test(a.editionId) && !/ltsc|ltsb|^enterprisen/i.test(a.editionId));
  const edition = v.includes('datacenter') ? /datacenter/i : /standard/i;
  const core = v.endsWith('-core');
  return abbilder.find(a => edition.test(a.editionId) && !/azure/i.test(a.editionId) && (core ? /^server core$/i.test(a.installationType) : /^server$/i.test(a.installationType)));
}

/** Ordner der Treiber im VirtIO-ISO je Variante (Fallback auf die nächstältere Server-Fassung) */
export const virtioOrdner = (v: WinVariante): string[] => (v === 'win11' ? ['w11', 'w10'] : ['2k25', '2k22']);
export const VIRTIO_TREIBER = ['vioscsi', 'viostor', 'NetKVM', 'Balloon', 'vioserial', 'viorng', 'pvpanic'];

// ── Antwortdateien ──────────────────────────────────────────────

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const KOMP = (name: string, inhalt: string) => `    <component name="${name}" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n${inhalt}\n    </component>`;

export interface Regional { sprache: string; tastatur?: string; gebietsschema?: string; zeitzone?: string }
const regional = (r: Regional) => {
  const ui = r.sprache.replace(/-([a-z]{2})$/, (_m, c: string) => `-${c.toUpperCase()}`);
  return { ui, tastatur: r.tastatur ?? '0c07:00000407', gebiet: r.gebietsschema ?? 'de-AT', zeitzone: r.zeitzone ?? 'W. Europe Standard Time' };
};
const KENNWORT = /^[A-Za-z0-9_.+-]{16,64}$/;
const COMPUTER = /^[A-Za-z0-9-]{1,15}$/;

/** autounattend.xml für den Bau der Vorlage: Platte GPT, Abbild per Index, Konto alfred, automatische Anmeldung, Einrichtungsskript */
export function autounattend(o: { variante: WinVariante; index: number; regional: Regional; computer: string; kennwort: string }): string {
  if (!Number.isInteger(o.index) || o.index < 1 || o.index > 32) throw new Error('ungültiger Abbild-Index');
  if (!KENNWORT.test(o.kennwort)) throw new Error('Baukennwort ungültig');
  if (!COMPUTER.test(o.computer)) throw new Error('Computername: höchstens 15 Zeichen A-Z 0-9 -');
  const r = regional(o.regional);
  const win11 = o.variante === 'win11';
  const intl = (pe: boolean) => KOMP(pe ? 'Microsoft-Windows-International-Core-WinPE' : 'Microsoft-Windows-International-Core', [
    ...(pe ? [`      <SetupUILanguage><UILanguage>${r.ui}</UILanguage></SetupUILanguage>`] : []),
    `      <InputLocale>${xml(r.tastatur)}</InputLocale><SystemLocale>${r.gebiet}</SystemLocale><UILanguage>${r.ui}</UILanguage><UserLocale>${r.gebiet}</UserLocale>`,
  ].join('\n'));
  const pw = (wert: string) => `<Value>${xml(wert)}</Value><PlainText>true</PlainText>`;
  const setup = KOMP('Microsoft-Windows-Setup', [
    // Windows 11 prüft den Prozessor; das VM-Modell (x86-64-v2-AES) steht auf keiner Liste — nur diese eine Prüfung umgehen (TPM 2.0 und Secure Boot sind echt vorhanden)
    ...(win11 ? ['      <RunSynchronous><RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>reg add HKLM\\SYSTEM\\Setup\\LabConfig /v BypassCPUCheck /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand></RunSynchronous>'] : []),
    '      <DiskConfiguration><Disk wcm:action="add"><DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk><CreatePartitions>',
    '        <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>260</Size></CreatePartition>',
    '        <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>',
    '        <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>',
    '      </CreatePartitions><ModifyPartitions>',
    '        <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition>',
    '        <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID></ModifyPartition>',
    '        <ModifyPartition wcm:action="add"><Order>3</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>',
    '      </ModifyPartitions></Disk></DiskConfiguration>',
    `      <ImageInstall><OSImage><InstallFrom><MetaData wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>${o.index}</Value></MetaData></InstallFrom><InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo></OSImage></ImageInstall>`,
    '      <UserData><AcceptEula>true</AcceptEula><FullName>Alfred</FullName><Organization>Alfred</Organization></UserData>',
  ].join('\n'));
  const spezial = [
    KOMP('Microsoft-Windows-Shell-Setup', `      <ComputerName>${o.computer}</ComputerName><TimeZone>${xml(r.zeitzone)}</TimeZone>`),
    // Windows 11 verschlüsselt mit TPM sonst selbständig; eine verschlüsselte Bau-VM ließe sich nicht als Vorlage verallgemeinern
    ...(win11 ? [KOMP('Microsoft-Windows-Deployment', '      <RunSynchronous><RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>reg add HKLM\\SYSTEM\\CurrentControlSet\\Control\\BitLocker /v PreventDeviceEncryption /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand></RunSynchronous>')] : []),
  ].join('\n');
  const oobe = KOMP('Microsoft-Windows-Shell-Setup', [
    '      <OOBE><HideEULAPage>true</HideEULAPage><HideLocalAccountScreen>true</HideLocalAccountScreen><HideOEMRegistrationScreen>true</HideOEMRegistrationScreen><HideOnlineAccountScreens>true</HideOnlineAccountScreens><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE><ProtectYourPC>3</ProtectYourPC><SkipUserOOBE>true</SkipUserOOBE><SkipMachineOOBE>true</SkipMachineOOBE></OOBE>',
    `      <UserAccounts>${win11 ? '' : `<AdministratorPassword>${pw(o.kennwort)}</AdministratorPassword>`}<LocalAccounts><LocalAccount wcm:action="add"><Name>alfred</Name><Group>Administrators</Group><DisplayName>Alfred</DisplayName><Password>${pw(o.kennwort)}</Password></LocalAccount></LocalAccounts></UserAccounts>`,
    `      <AutoLogon><Username>alfred</Username><Enabled>true</Enabled><LogonCount>3</LogonCount><Password>${pw(o.kennwort)}</Password></AutoLogon>`,
    '      <FirstLogonCommands><SynchronousCommand wcm:action="add"><Order>1</Order><RequiresUserInput>false</RequiresUserInput>',
    '        <CommandLine>cmd /c for %d in (D E F G H I J K) do if exist %d:\\alfred-setup.ps1 powershell -NoProfile -ExecutionPolicy Bypass -File %d:\\alfred-setup.ps1</CommandLine>',
    '      </SynchronousCommand></FirstLogonCommands>',
    `      <TimeZone>${xml(r.zeitzone)}</TimeZone>`,
  ].join('\n'));
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<unattend xmlns="urn:schemas-microsoft-com:unattend">',
    '  <settings pass="windowsPE">', intl(true), setup, '  </settings>',
    '  <settings pass="specialize">', spezial, '  </settings>',
    '  <settings pass="oobeSystem">', intl(false), oobe, '  </settings>',
    '</unattend>', '',
  ].join('\n');
}

/** Antwortdatei für sysprep /generalize: Klone überspringen die Einrichtungsseiten; Cloudbase-Init setzt Name und Netz im specialize-Durchgang */
export function sysprepUnattend(o: { variante: WinVariante; regional: Regional; kennwort: string }): string {
  if (!KENNWORT.test(o.kennwort)) throw new Error('Kennwort ungültig');
  const r = regional(o.regional);
  const cb = 'C:\\Program Files\\Cloudbase Solutions\\Cloudbase-Init';
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<unattend xmlns="urn:schemas-microsoft-com:unattend">',
    '  <settings pass="generalize">',
    KOMP('Microsoft-Windows-PnpSysprep', '      <PersistAllDeviceInstalls>true</PersistAllDeviceInstalls>'),
    '  </settings>',
    '  <settings pass="specialize">',
    KOMP('Microsoft-Windows-Deployment', `      <RunSynchronous><RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>cmd.exe /c ""${cb}\\Python\\Scripts\\cloudbase-init.exe" --config-file "${cb}\\conf\\cloudbase-init-unattend.conf" &amp;&amp; exit 1 || exit 2"</Path><Description>Cloudbase-Init (Name, Netz)</Description><WillReboot>OnRequest</WillReboot></RunSynchronousCommand></RunSynchronous>`),
    KOMP('Microsoft-Windows-Shell-Setup', `      <TimeZone>${xml(r.zeitzone)}</TimeZone>`),
    '  </settings>',
    '  <settings pass="oobeSystem">',
    KOMP('Microsoft-Windows-International-Core', `      <InputLocale>${xml(r.tastatur)}</InputLocale><SystemLocale>${r.gebiet}</SystemLocale><UILanguage>${r.ui}</UILanguage><UserLocale>${r.gebiet}</UserLocale>`),
    KOMP('Microsoft-Windows-Shell-Setup', [
      '      <OOBE><HideEULAPage>true</HideEULAPage><HideLocalAccountScreen>true</HideLocalAccountScreen><HideOEMRegistrationScreen>true</HideOEMRegistrationScreen><HideOnlineAccountScreens>true</HideOnlineAccountScreens><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE><ProtectYourPC>3</ProtectYourPC><SkipUserOOBE>true</SkipUserOOBE><SkipMachineOOBE>true</SkipMachineOOBE></OOBE>',
      // Server verlangt nach generalize ein Administrator-Kennwort; Vorlagenwert, jeder Klon setzt seinen eigenen aus dem Tresor
      ...(o.variante === 'win11' ? [] : [`      <UserAccounts><AdministratorPassword><Value>${xml(o.kennwort)}</Value><PlainText>true</PlainText></AdministratorPassword></UserAccounts>`]),
    ].join('\n')),
    '  </settings>',
    '</unattend>', '',
  ].join('\n');
}

const CB_GEMEINSAM = [
  'username=alfred', 'groups=Administrators', 'inject_user_password=false', 'first_logon_behaviour=no',
  'config_drive_raw_hhd=true', 'config_drive_cdrom=true', 'config_drive_vfat=true',
  'bsdtar_path=C:\\Program Files\\Cloudbase Solutions\\Cloudbase-Init\\bin\\bsdtar.exe',
  'mtools_path=C:\\Program Files\\Cloudbase Solutions\\Cloudbase-Init\\bin\\',
  'verbose=true', 'debug=true', 'logdir=C:\\Program Files\\Cloudbase Solutions\\Cloudbase-Init\\log\\',
  'default_log_levels=comtypes=INFO,suds=INFO,iso8601=WARN,requests=WARN',
  'metadata_services=cloudbaseinit.metadata.services.configdrive.ConfigDriveService',
  'check_latest_version=false', 'mtu_use_dhcp_config=false', 'ntp_use_dhcp_config=false',
];
/** Cloudbase-Init im specialize-Durchgang: Name und Netz (statische Adresse aus dem Konfigurationslaufwerk von Proxmox) */
export const CLOUDBASE_UNATTEND_CONF = ['[DEFAULT]', ...CB_GEMEINSAM, 'logfile=cloudbase-init-unattend.log',
  'plugins=cloudbaseinit.plugins.common.sethostname.SetHostNamePlugin,cloudbaseinit.plugins.common.networkconfig.NetworkConfigPlugin',
  'allow_reboot=false', 'stop_service_on_exit=false', ''].join('\r\n');
/** Cloudbase-Init als Dienst beim ersten Start: Volume erweitern, Benutzerdaten (Host-Schlüssel, Anmeldeschlüssel, Kennwort) */
export const CLOUDBASE_CONF = ['[DEFAULT]', ...CB_GEMEINSAM, 'logfile=cloudbase-init.log',
  'plugins=cloudbaseinit.plugins.common.sethostname.SetHostNamePlugin,cloudbaseinit.plugins.common.networkconfig.NetworkConfigPlugin,cloudbaseinit.plugins.windows.extendvolumes.ExtendVolumesPlugin,cloudbaseinit.plugins.common.userdata.UserDataPlugin',
  'allow_reboot=true', 'stop_service_on_exit=false', ''].join('\r\n');

/**
 * Einrichtungsskript beim ersten Anmelden in der Bau-VM: Gast-Werkzeuge (Treiber + Gast-Agent), OpenSSH-Server (PowerShell als
 * Standard-Shell, Host-Schlüssel der Vorlage entfernt), Cloudbase-Init mit Alfreds Konfiguration, Aufräumen (Kennwörter aus der
 * Panther-Ablage), dann sysprep /generalize /shutdown — die VM schaltet sich aus, wenn die Vorlage fertig ist.
 */
export function setupSkript(o: { variante: WinVariante }): string {
  const win11 = o.variante === 'win11';
  return [
    '$ErrorActionPreference = "Stop"',
    'Start-Transcript -Path C:\\Windows\\Temp\\alfred-setup.log -Append',
    'trap { Write-Output "ALFRED: FEHLER $($_.Exception.Message)"; Stop-Transcript; exit 1 }',
    'function Laufwerk($datei) { foreach ($d in "DEFGHIJK".ToCharArray()) { if (Test-Path "$($d):\\$datei") { return "$($d):" } } throw "nicht gefunden: $datei" }',
    '$antwort = Laufwerk "alfred-setup.ps1"',
    '$virtio = Laufwerk "virtio-win-guest-tools.exe"',
    'Write-Output "ALFRED: Gast-Werkzeuge"',
    'Start-Process -FilePath "$virtio\\virtio-win-guest-tools.exe" -ArgumentList "/install","/quiet","/norestart" -Wait',
    ...(win11 ? [
      // Store-Apps dürfen sich vor sysprep nicht für den Bau-Benutzer aktualisieren (sysprep scheitert sonst an benutzergebundenen Paketen)
      'New-Item -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\WindowsStore" -Force | Out-Null',
      'Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\WindowsStore" -Name AutoDownload -Value 2 -Type DWord',
    ] : []),
    'Write-Output "ALFRED: OpenSSH"',
    '$cap = Get-WindowsCapability -Online -Name "OpenSSH.Server*" | Select-Object -First 1',
    'if ($cap.State -ne "Installed") { for ($i = 0; $i -lt 20; $i++) { try { Add-WindowsCapability -Online -Name $cap.Name | Out-Null; break } catch { Start-Sleep -Seconds 30 } } }',
    'if ((Get-WindowsCapability -Online -Name $cap.Name).State -ne "Installed") { throw "OpenSSH-Server nicht installiert" }',
    'New-Item -Path "HKLM:\\SOFTWARE\\OpenSSH" -Force | Out-Null',
    'Set-ItemProperty -Path "HKLM:\\SOFTWARE\\OpenSSH" -Name DefaultShell -Value "$env:WINDIR\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
    'Set-Service -Name sshd -StartupType Automatic',
    ...SSH_FIREWALL,
    'Write-Output "ALFRED: Cloudbase-Init"',
    '$cbLog = "C:\\Windows\\Temp\\cloudbase-init-msi.log"',
    'Start-Process -FilePath msiexec.exe -ArgumentList "/i","$antwort\\CloudbaseInitSetup_x64.msi","/qn","/l*v",$cbLog,"RUN_SERVICE_AS_LOCAL_SYSTEM=1" -Wait',
    '$cb = "C:\\Program Files\\Cloudbase Solutions\\Cloudbase-Init"',
    'if (-not (Test-Path "$cb\\Python\\Scripts\\cloudbase-init.exe")) { throw "Cloudbase-Init nicht installiert" }',
    'Copy-Item "$antwort\\cloudbase-init.conf" "$cb\\conf\\cloudbase-init.conf" -Force',
    'Copy-Item "$antwort\\cloudbase-init-unattend.conf" "$cb\\conf\\cloudbase-init-unattend.conf" -Force',
    'Copy-Item "$antwort\\alfred-sysprep.xml" "$cb\\conf\\alfred-sysprep.xml" -Force',
    'Set-Service -Name cloudbase-init -StartupType Automatic',
    'Write-Output "ALFRED: Aufraeumen"',
    'powercfg /hibernate off',
    'Get-ChildItem "C:\\ProgramData\\ssh\\ssh_host_*" -ErrorAction SilentlyContinue | Remove-Item -Force',
    'Remove-Item "C:\\Windows\\Panther\\unattend.xml","C:\\Windows\\Panther\\Unattend\\unattend.xml" -Force -ErrorAction SilentlyContinue',
    'Remove-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon" -Name DefaultPassword,AutoAdminLogon -ErrorAction SilentlyContinue',
    'Write-Output "ALFRED: sysprep"',
    'Stop-Transcript',
    '& "$env:WINDIR\\System32\\Sysprep\\sysprep.exe" /generalize /oobe /shutdown /quiet "/unattend:$cb\\conf\\alfred-sysprep.xml"',
    '',
  ].join('\r\n');
}

// ── Klon ─────────────────────────────────────────────────────────

const SSH_OEFF = /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/=]{40,1200}( [\w@.+-]{0,80})?$/;
const SSH_PRIV = /^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]{100,5000}\n-----END OPENSSH PRIVATE KEY-----\n?$/;
const psText = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Firewall-Regel für SSH in allen Netzprofilen (Realfall probe-win25, 01.11.: vorinstallierte Regel nur „Private“, Netz „Public“ → Port 22 zu) */
const SSH_FIREWALL = [
  '$r = Get-NetFirewallRule -Name OpenSSH-Server-In-TCP -ErrorAction SilentlyContinue',
  'if ($r) { Set-NetFirewallRule -Name OpenSSH-Server-In-TCP -Enabled True -Profile Any -Action Allow } else { New-NetFirewallRule -Name OpenSSH-Server-In-TCP -DisplayName "OpenSSH Server (sshd)" -Enabled True -Profile Any -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null }',
];

/**
 * Benutzerdaten eines Windows-Klons (Cloudbase-Init, #ps1_sysnative): Computername, Host-Schlüssel von Alfred (statt eines
 * ungeprüften ersten Kontakts), Anmeldeschlüssel für Administratoren, Kennwort des Kontos alfred (und Administrator bei Server),
 * SSH-Freigabe in allen Netzprofilen, danach Cloudbase-Init aus — damit bleiben Host-Schlüssel und Kennwort auch nach einem neuen
 * Konfigurationslaufwerk.
 *
 * Realfall probe-win25 (01.11.): Proxmox schreibt den Namen nur in die Standard-Benutzerdaten, die hier ersetzt werden („Hostname not
 * found in metadata“) — der Name wird deshalb hier gesetzt; beim ersten Start nach sysprep war die Kontenverwaltung noch nicht bereit
 * („SAM or LSA server was in the wrong state“) — deshalb mit Wiederholung, und bei Misserfolg Neustart mit erneutem Lauf (1003).
 */
export function windowsBenutzerDaten(v: { variante: WinVariante; hostname: string; alfredSchluessel: string; weitereSchluessel?: string[]; hostPrivat: string; hostOeffentlich: string; kennwort: string; ownerKonto?: { name: string; kennwort: string }; rdp?: boolean }): string {
  if (!/^[a-z0-9]([a-z0-9-]{0,13}[a-z0-9])?$/.test(v.hostname)) throw new Error('Computername: Kleinbuchstaben, Ziffern, -, höchstens 15 Zeichen');
  const schluessel = [v.alfredSchluessel, ...(v.weitereSchluessel ?? [])].map(s => s.trim());
  for (const s of schluessel) if (!SSH_OEFF.test(s)) throw new Error('ungültiger öffentlicher SSH-Schlüssel');
  const hostOeff = v.hostOeffentlich.trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]{40,200}( \S*)?$/.test(hostOeff)) throw new Error('Host-Schlüssel muss ed25519 sein');
  const privat = v.hostPrivat.replace(/\r\n/g, '\n');
  if (!SSH_PRIV.test(privat)) throw new Error('privater Host-Schlüssel hat nicht das OpenSSH-Format');
  if (!KENNWORT.test(v.kennwort)) throw new Error('Kennwort ungültig');
  // v1745 (Owner 01.11.: eigener Zugang) — Konto des Owners als Administrator, eigenes Kennwort im Tresor
  if (v.ownerKonto && (!/^[a-z][a-z0-9_-]{1,19}$/.test(v.ownerKonto.name) || /^(alfred|administrator|guest|gast)$/i.test(v.ownerKonto.name) || !KENNWORT.test(v.ownerKonto.kennwort))) throw new Error('Owner-Konto: Name a–z/0–9/_/- (2–20, nicht alfred/administrator) und gültiges Kennwort');
  const rechte = (pfad: string) => `  icacls ${psText(pfad)} /inheritance:r /grant "*S-1-5-18:F" /grant "*S-1-5-32-544:F" | Out-Null; if ($LASTEXITCODE -ne 0) { throw "icacls $LASTEXITCODE" }`;
  return [
    '#ps1_sysnative',
    '$ErrorActionPreference = "Stop"',
    '$ssh = "C:\\ProgramData\\ssh"',
    'function Einrichten {',
    '  Get-LocalUser -Name alfred | Out-Null',
    '  New-Item -ItemType Directory -Path $ssh -Force | Out-Null',
    '  Get-ChildItem "$ssh\\ssh_host_*" -ErrorAction SilentlyContinue | Remove-Item -Force',
    `  [IO.File]::WriteAllText("$ssh\\ssh_host_ed25519_key", ${psText(privat.endsWith('\n') ? privat : `${privat}\n`)})`,
    `  [IO.File]::WriteAllText("$ssh\\ssh_host_ed25519_key.pub", ${psText(`${hostOeff}\n`)})`,
    rechte('C:\\ProgramData\\ssh\\ssh_host_ed25519_key'),
    `  [IO.File]::WriteAllText("$ssh\\administrators_authorized_keys", ${psText(`${schluessel.join('\n')}\n`)})`,
    rechte('C:\\ProgramData\\ssh\\administrators_authorized_keys'),
    `  $pw = ConvertTo-SecureString ${psText(v.kennwort)} -AsPlainText -Force`,
    '  Set-LocalUser -Name alfred -Password $pw -PasswordNeverExpires $true',
    ...(v.variante === 'win11' ? [] : ['  Set-LocalUser -Name Administrator -Password $pw']),
    ...(v.ownerKonto ? [
      `  $opw = ConvertTo-SecureString ${psText(v.ownerKonto.kennwort)} -AsPlainText -Force`,
      `  if (Get-LocalUser -Name ${psText(v.ownerKonto.name)} -ErrorAction SilentlyContinue) { Set-LocalUser -Name ${psText(v.ownerKonto.name)} -Password $opw -PasswordNeverExpires $true } else { New-LocalUser -Name ${psText(v.ownerKonto.name)} -Password $opw -PasswordNeverExpires -FullName ${psText(v.ownerKonto.name)} | Out-Null }`,
      `  if (-not (Get-LocalGroupMember -SID S-1-5-32-544 | Where-Object { $_.Name -like ${psText(`*\\${v.ownerKonto.name}`)} })) { Add-LocalGroupMember -SID S-1-5-32-544 -Member ${psText(v.ownerKonto.name)} }`,
    ] : []),
    ...(v.rdp ? [
      '  Set-ItemProperty -Path "HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server" -Name fDenyTSConnections -Value 0',
      '  Set-ItemProperty -Path "HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp" -Name UserAuthentication -Value 1',
      '  Get-NetFirewallRule -Group "@FirewallAPI.dll,-28752" | Enable-NetFirewallRule',
    ] : []),
    ...SSH_FIREWALL.map(z => `  ${z}`),
    '  Set-Service -Name sshd -StartupType Automatic',
    '  Restart-Service -Name sshd -Force',
    '}',
    '$ok = $false',
    'for ($i = 0; $i -lt 30 -and -not $ok; $i++) { try { Einrichten; $ok = $true } catch { Start-Sleep -Seconds 20 } }',
    'if (-not $ok) { exit 1003 }',
    `if ($env:COMPUTERNAME -ne ${psText(v.hostname.toUpperCase())}) { Rename-Computer -NewName ${psText(v.hostname)} -Force; Set-Service -Name cloudbase-init -StartupType Disabled; exit 1001 }`,
    'Set-Service -Name cloudbase-init -StartupType Disabled',
    'exit 0',
    '',
  ].join('\r\n');
}

/** Proxmox-Konfiguration der Bau-VM (UEFI mit Microsoft-Schlüsseln, TPM 2.0, VirtIO) */
export function windowsBauKonfig(v: { vmid: number; name: string; storage: string; windowsIso: string; virtioIso: string; antwortIso: string; groesseGb?: number; memory?: number; cores?: number; bridge?: string; vlan?: number; beschreibung?: string; machine?: string }): Record<string, unknown> {
  for (const iso of [v.windowsIso, v.virtioIso, v.antwortIso]) if (!ISO_VOLUME.test(iso)) throw new Error(`ungültiges ISO-Volume ${iso}`);
  // Windows bekommt eine feste Maschinenversion (pc-q35-X.Y): ein QEMU-Update ändert sonst die virtuelle Hardware unter dem Gast
  if (v.machine !== undefined && !/^pc-q35-\d+\.\d+$/.test(v.machine)) throw new Error(`ungültige Maschinenversion ${v.machine}`);
  return {
    vmid: v.vmid, name: v.name, ostype: 'win11', machine: v.machine ?? 'q35', bios: 'ovmf', cpu: 'x86-64-v2-AES',
    memory: v.memory ?? 4096, cores: v.cores ?? 2, balloon: 0, scsihw: 'virtio-scsi-single',
    efidisk0: `${v.storage}:1,efitype=4m,pre-enrolled-keys=1`, tpmstate0: `${v.storage}:1,version=v2.0`,
    scsi0: `${v.storage}:${v.groesseGb ?? 64},discard=on,iothread=1,ssd=1`,
    ide2: `${v.windowsIso},media=cdrom`, sata0: `${v.virtioIso},media=cdrom`, sata1: `${v.antwortIso},media=cdrom`,
    boot: 'order=scsi0;ide2', agent: 'enabled=1', citype: 'configdrive2',
    net0: `virtio,bridge=${v.bridge ?? 'vmbr0'}${v.vlan ? `,tag=${v.vlan}` : ''}`,
    ...(v.beschreibung ? { description: v.beschreibung } : {}),
  };
}

// ── Knoten-Skripte (laufen als root am Proxmox-Knoten; das Skript aus einer temporären Datei, die Eingabe als JSON über stdin) ──

/** Liest das WIM-Verzeichnis (XML im Kopf von install.wim/esd) und die VirtIO-Ordner; hängt die ISOs nur lesend ein und wieder aus */
export const KNOTEN_INSPEKTION = `f=$(mktemp /tmp/alfred-XXXXXX.py) && cat > "$f" <<'PY'
import json,subprocess,sys,tempfile,struct,os,re
e=json.load(sys.stdin)
def pfad(v): return subprocess.check_output(['pvesm','path',v],text=True).strip()
def einhaengen(iso):
  d=tempfile.mkdtemp(prefix='alfred-iso-');subprocess.run(['mount','-o','loop,ro',iso,d],check=True);return d
aus={}
w=einhaengen(pfad(e['windows']))
try:
  q=next(os.path.join(w,'sources',n) for n in ('install.wim','install.esd','INSTALL.WIM','INSTALL.ESD') if os.path.exists(os.path.join(w,'sources',n)))
  with open(q,'rb') as f:
    k=f.read(208);assert k[:8]==b'MSWIM\\0\\0\\0','kein WIM'
    groesse=int.from_bytes(k[72:79],'little');ofs=struct.unpack('<Q',k[80:88])[0]
    f.seek(ofs);x=f.read(groesse).decode('utf-16')
  bilder=[]
  for m in re.finditer(r'<IMAGE INDEX="(\\d+)">(.*?)</IMAGE>',x,re.S):
    t=lambda n:(re.search('<%s>(.*?)</%s>'%(n,n),m.group(2),re.S) or [None,''])[1]
    bilder.append({'index':int(m.group(1)),'name':t('NAME'),'editionId':t('EDITIONID'),'installationType':t('INSTALLATIONTYPE'),'build':t('BUILD')+'.'+t('SPBUILD')})
  aus['abbilder']=bilder
finally:
  subprocess.run(['umount',w]);os.rmdir(w)
v=einhaengen(pfad(e['virtio']))
try:
  aus['virtio']=sorted(n for n in os.listdir(os.path.join(v,'vioscsi')))
  aus['gastWerkzeuge']=os.path.exists(os.path.join(v,'virtio-win-guest-tools.exe'))
finally:
  subprocess.run(['umount',v]);os.rmdir(v)
print('ALFRED_JSON '+json.dumps(aus))
PY
python3 "$f"; r=$?; rm -f "$f"; exit $r`;

/**
 * Baut das Antwort-ISO: Dateien aus dem JSON (base64), Treiber aus dem VirtIO-ISO in $WinPEDriver$ (Setup lädt sie von selbst,
 * ohne Laufwerksbuchstaben), Cloudbase-Init-MSI per HTTPS (feste Herkunft, Größe protokolliert). Ergebnis im ISO-Speicher.
 */
export const KNOTEN_ANTWORT_ISO = `f=$(mktemp /tmp/alfred-XXXXXX.py) && cat > "$f" <<'PY'
import json,subprocess,sys,tempfile,os,shutil,base64,hashlib
e=json.load(sys.stdin)
def pfad(v): return subprocess.check_output(['pvesm','path',v],text=True).strip()
ziel=pfad(e['ziel'])
assert not os.path.exists(ziel),'Antwort-ISO gibt es schon'
d=tempfile.mkdtemp(prefix='alfred-antwort-')
try:
  for n,b in e['dateien'].items():
    assert '/' not in n and not n.startswith('.')
    open(os.path.join(d,n),'wb').write(base64.b64decode(b))
  subprocess.run(['curl','-fsSL','--proto','=https','--max-time','600','-o',os.path.join(d,'CloudbaseInitSetup_x64.msi'),e['cloudbase']],check=True)
  m=hashlib.sha256(open(os.path.join(d,'CloudbaseInitSetup_x64.msi'),'rb').read()).hexdigest()
  v=tempfile.mkdtemp(prefix='alfred-iso-');subprocess.run(['mount','-o','loop,ro',pfad(e['virtio']),v],check=True)
  try:
    for t in e['treiber']:
      q=os.path.join(v,t,e['ordner'],'amd64')
      if os.path.isdir(q): shutil.copytree(q,os.path.join(d,'$WinPEDriver$',t))
  finally:
    subprocess.run(['umount',v]);os.rmdir(v)
  subprocess.run(['genisoimage','-quiet','-J','-r','-V','ALFRED','-o',ziel,d],check=True)
  print('ALFRED_JSON '+json.dumps({'iso':e['ziel'],'cloudbaseSha256':m,'treiber':sorted(os.listdir(os.path.join(d,'$WinPEDriver$'))) if os.path.isdir(os.path.join(d,'$WinPEDriver$')) else []}))
finally:
  shutil.rmtree(d,ignore_errors=True)
PY
python3 "$f"; r=$?; rm -f "$f"; exit $r`;

/** „ALFRED_JSON {…}“ aus der Ausgabe eines Knoten-Skripts */
export function knotenJson<T>(ausgabe: string): T {
  const z = ausgabe.split(/\r?\n/).reverse().find(l => l.startsWith('ALFRED_JSON '));
  if (!z) throw new Error(`Knoten-Skript ohne Ergebnis: ${ausgabe.slice(-300)}`);
  return JSON.parse(z.slice('ALFRED_JSON '.length)) as T;
}

/** Zufälliges Kennwort, das Windows-Komplexitätsregeln erfüllt und in XML/PowerShell ohne Maskierung steht */
export function zufallsKennwort(zufall: (n: number) => Uint8Array): string {
  const zeichen = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const b = zufall(24);
  return `Al-${Array.from(b, x => zeichen[x % zeichen.length]).join('')}9a`;
}
