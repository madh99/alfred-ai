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
// Ruling R36 (I8e L6): win11-pro (Windows 11 Pro aus dem Mehrfach-Edition-ISO) neben win11 (= Enterprise Evaluation, Standard)
export type WinVariante = 'server-standard-core' | 'server-standard-desktop' | 'server-datacenter-core' | 'server-datacenter-desktop' | 'win11' | 'win11-pro';
export const WIN_VARIANTEN: WinVariante[] = ['server-standard-core', 'server-standard-desktop', 'server-datacenter-core', 'server-datacenter-desktop', 'win11', 'win11-pro'];
export const istWinVariante = (x: unknown): x is WinVariante => typeof x === 'string' && (WIN_VARIANTEN as string[]).includes(x);
/** Ruling R36 (I8e L6): Windows-11-Sonderfälle (Prozessor-Ausnahme, keine Geräteverschlüsselung, kein Administrator-Kennwort, Store) für beide Windows-11-Varianten */
export const istWin11 = (v: WinVariante): boolean => v === 'win11' || v === 'win11-pro';

/**
 * Ruling R36 (I8e L6): KMS-Client-Setup-Schlüssel (GVLK) für Windows 11 Pro — öffentlich von Microsoft: Microsoft Learn „Key Management
 * Services (KMS) client activation and product keys“ (learn.microsoft.com/windows-server/get-started/kms-client-activation-keys, Tabelle
 * „Windows 11 Pro / Windows 10 Pro“, gelesen 20.11.2026). Wählt nur die Edition bei der Installation und aktiviert nicht (nur gegen einen
 * KMS-Host) — kein Retail-/MAK-Schlüssel, keine Aktivierungsumgehung.
 */
export const WIN11_PRO_GVLK = 'W269N-WFGWX-YVC9B-4J6C9-T83GX';

/** Lizenzstand der Vorlage für Beschreibung und Ergebnis */
export function lizenzHinweis(v: WinVariante): string {
  if (v === 'win11-pro') return 'Pro unaktiviert — Aktivierung braucht eine eigene Lizenz (KMS/MAK/Retail)';
  return v === 'win11' ? 'Testversion Windows 11 Enterprise, 90 Tage ab Installation' : 'Testversion Windows Server, 180 Tage ab Installation';
}

/**
 * Ruling R36 (I8e L6): Windows 11 Pro gibt es nicht als Testversion. Das Mehrfach-Edition-ISO von Microsoft (Download-Seite
 * software-download/windows11) hat nur zeitlich begrenzte, sitzungsgebundene Links — kein fester automatischer Bezug; das ISO liegt
 * schon im ISO-Speicher: Microsoft-Dateiname „Win11_<Version>_<Sprache>_x64[vN].iso“ oder umbenannt „win11-pro-…-<xx-yy>.iso“.
 * Sprache aus dem Namen (nur bekannte Microsoft-Sprachwörter) oder ausdrücklich angegeben; beides vorhanden → muss übereinstimmen.
 */
export const WIN11_PRO_ISO_VOLUME = /^[a-zA-Z][\w-]{0,40}:iso\/Win11_\d{2}H\d_([A-Za-z]{2,40})_x64(v\d)?\.iso$/;
export const WIN11_SPRACHWORT: Record<string, string> = { english: 'en-us', englishinternational: 'en-gb', german: 'de-de' };
export function win11ProIso(iso: string, angabe?: string): { sprache: string } | { fehler: string } {
  if (angabe !== undefined && !SPRACHE.test(angabe)) return { fehler: `sprache „${angabe}“: Form xx-yy, z. B. de-de` };
  const ms = WIN11_PRO_ISO_VOLUME.exec(iso);
  const umbenannt = !ms && ISO_VOLUME.test(iso) && /:iso\/win11-pro-/.test(iso) ? /-([a-z]{2}-[a-z]{2})\.iso$/.exec(iso)?.[1] : undefined;
  if (!ms && !umbenannt) return { fehler: `ISO ${iso} ist kein Windows-11-ISO mit Pro (Win11_<Version>_<Sprache>_x64.iso oder win11-pro-…-xx-yy.iso)` };
  const ausName = ms ? WIN11_SPRACHWORT[ms[1]!.toLowerCase()] : umbenannt;
  if (ausName && angabe && ausName !== angabe) return { fehler: `sprache ${angabe} widerspricht dem ISO-Namen (${ausName})` };
  const sprache = angabe ?? ausName;
  if (!sprache) return { fehler: `Sprache aus ${iso} nicht eindeutig — sprache angeben (z. B. fr-fr)` };
  return { sprache };
}

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
  // Ruling R36 (I8e L6): genau EDITIONID „Professional“ (nicht ProfessionalN/-Education/-Workstation, nicht Education/Core)
  if (v === 'win11-pro') return abbilder.find(a => a.editionId.toLowerCase() === 'professional');
  const edition = v.includes('datacenter') ? /datacenter/i : /standard/i;
  const core = v.endsWith('-core');
  return abbilder.find(a => edition.test(a.editionId) && !/azure/i.test(a.editionId) && (core ? /^server core$/i.test(a.installationType) : /^server$/i.test(a.installationType)));
}

/** Ordner der Treiber im VirtIO-ISO je Variante (Fallback auf die nächstältere Server-Fassung) */
export const virtioOrdner = (v: WinVariante): string[] => (istWin11(v) ? ['w11', 'w10'] : ['2k25', '2k22']);
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
  const win11 = istWin11(o.variante);
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
    // Ruling R36 (I8e L6): Pro aus dem Mehrfach-Edition-ISO mit dem öffentlichen KMS-Client-Schlüssel (GVLK) — wählt die Edition, aktiviert nicht
    `      <UserData>${o.variante === 'win11-pro' ? `<ProductKey><Key>${WIN11_PRO_GVLK}</Key><WillShowUI>OnError</WillShowUI></ProductKey>` : ''}<AcceptEula>true</AcceptEula><FullName>Alfred</FullName><Organization>Alfred</Organization></UserData>`,
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
      ...(istWin11(o.variante) ? [] : [`      <UserAccounts><AdministratorPassword><Value>${xml(o.kennwort)}</Value><PlainText>true</PlainText></AdministratorPassword></UserAccounts>`]),
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
  const win11 = istWin11(o.variante);
  return [
    '$ErrorActionPreference = "Stop"',
    'Start-Transcript -Path C:\\Windows\\Temp\\alfred-setup.log -Append',
    // Ruling R37 (I8e L6): das Transkript hält die Datei offen (für den Gast-Agenten gesperrt) — Marken zusätzlich zeilenweise in eine
    // eigene Statusdatei, die windows_build_log jederzeit lesen kann
    `$alfredStatus = "${SETUP_STATUS_DATEI}"`,
    'function Marke($t) { Write-Output "ALFRED: $t"; Add-Content -LiteralPath $alfredStatus -Value "$(Get-Date -Format s) ALFRED: $t" -Encoding UTF8 }',
    'trap { Marke "FEHLER $($_.Exception.Message)"; Stop-Transcript; exit 1 }',
    'function Laufwerk($datei) { foreach ($d in "DEFGHIJK".ToCharArray()) { if (Test-Path "$($d):\\$datei") { return "$($d):" } } throw "nicht gefunden: $datei" }',
    '$antwort = Laufwerk "alfred-setup.ps1"',
    '$virtio = Laufwerk "virtio-win-guest-tools.exe"',
    // Ruling R35 (I8e L6): Medienprüfung — Ergebnisdatei frisch, Bewertung gemeinsam mit check_windows_media
    ...medienPsGrundlage(),
    `$mpDatei = "${MEDIEN_DATEI}"; $mpAbgeholt = "${MEDIEN_ABGEHOLT}"`,
    'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $mpDatei) | Out-Null',
    'Remove-Item -LiteralPath $mpDatei,$mpAbgeholt -Force -ErrorAction SilentlyContinue',
    'function MpSchreiben { [IO.File]::WriteAllText($mpDatei, (ConvertTo-Json -InputObject $mp -Depth 5 -Compress), (New-Object Text.UTF8Encoding $false)) }',
    'function MpFehlschlag { $mp.ok = $false; MpSchreiben; Marke "MEDIENPRUEFUNG_FEHLER $($mp.fehler -join "; ")"; Stop-Transcript; exit 1 }',
    'Marke "Gast-Werkzeuge"',
    'Start-Process -FilePath "$virtio\\virtio-win-guest-tools.exe" -ArgumentList "/install","/quiet","/norestart" -Wait',
    ...(win11 ? [
      // Store-Apps dürfen sich vor sysprep nicht für den Bau-Benutzer aktualisieren (sysprep scheitert sonst an benutzergebundenen Paketen)
      'New-Item -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\WindowsStore" -Force | Out-Null',
      'Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\WindowsStore" -Name AutoDownload -Value 2 -Type DWord',
    ] : []),
    `Marke "OpenSSH (Windows Update, hoechstens ${OPENSSH_ZEITLIMIT_S / 60} min)"`,
    '$cap = Get-WindowsCapability -Online -Name "OpenSSH.Server*" | Select-Object -First 1',
    // Ruling R37 (I8e L6): Add-WindowsCapability lädt aus Windows Update und kann ohne Fehler hängen — eigener Job mit Zeitlimit,
    // Zeitüberschreitung = FEHLER (Marke, kein sysprep, die VM bleibt an)
    'if ($cap.State -ne "Installed") {',
    '  $job = Start-Job -ArgumentList $cap.Name -ScriptBlock { param($n) for ($i = 1; $i -le 20; $i++) { try { Add-WindowsCapability -Online -Name $n | Out-Null; return } catch { Start-Sleep -Seconds 30 } } }',
    `  if (-not (Wait-Job -Job $job -Timeout ${OPENSSH_ZEITLIMIT_S})) { Stop-Job -Job $job; throw "OpenSSH-Server: Add-WindowsCapability nach ${OPENSSH_ZEITLIMIT_S / 60} min nicht fertig (Windows Update erreichbar?)" }`,
    '  Receive-Job -Job $job -ErrorAction SilentlyContinue | Out-Null',
    '}',
    'if ((Get-WindowsCapability -Online -Name $cap.Name).State -ne "Installed") { throw "OpenSSH-Server nicht installiert" }',
    'New-Item -Path "HKLM:\\SOFTWARE\\OpenSSH" -Force | Out-Null',
    'Set-ItemProperty -Path "HKLM:\\SOFTWARE\\OpenSSH" -Name DefaultShell -Value "$env:WINDIR\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
    'Set-Service -Name sshd -StartupType Automatic',
    ...SSH_FIREWALL,
    'Marke "Cloudbase-Init"',
    // Ruling R35 (I8e L6): MSI erst nach gültiger Signatur von Cloudbase Solutions installieren — sonst Ergebnis schreiben, kein sysprep
    ...medienPsCloudbaseMsi('"$antwort\\CloudbaseInitSetup_x64.msi"'),
    'if ($mp.fehler.Count -gt 0) { MpFehlschlag }',
    '$cbLog = "C:\\Windows\\Temp\\cloudbase-init-msi.log"',
    'Start-Process -FilePath msiexec.exe -ArgumentList "/i","$antwort\\CloudbaseInitSetup_x64.msi","/qn","/l*v",$cbLog,"RUN_SERVICE_AS_LOCAL_SYSTEM=1" -Wait',
    '$cb = "C:\\Program Files\\Cloudbase Solutions\\Cloudbase-Init"',
    'if (-not (Test-Path "$cb\\Python\\Scripts\\cloudbase-init.exe")) { throw "Cloudbase-Init nicht installiert" }',
    'Copy-Item "$antwort\\cloudbase-init.conf" "$cb\\conf\\cloudbase-init.conf" -Force',
    'Copy-Item "$antwort\\cloudbase-init-unattend.conf" "$cb\\conf\\cloudbase-init-unattend.conf" -Force',
    'Copy-Item "$antwort\\alfred-sysprep.xml" "$cb\\conf\\alfred-sysprep.xml" -Force',
    'Set-Service -Name cloudbase-init -StartupType Automatic',
    'Marke "Aufraeumen"',
    'powercfg /hibernate off',
    'Get-ChildItem "C:\\ProgramData\\ssh\\ssh_host_*" -ErrorAction SilentlyContinue | Remove-Item -Force',
    'Remove-Item "C:\\Windows\\Panther\\unattend.xml","C:\\Windows\\Panther\\Unattend\\unattend.xml" -Force -ErrorAction SilentlyContinue',
    'Remove-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon" -Name DefaultPassword,AutoAdminLogon -ErrorAction SilentlyContinue',
    // Ruling R35 (I8e L6): vor sysprep prüfen; nur bestanden UND von Alfred abgeholt (Ergebnis in der VM-Beschreibung) geht es weiter.
    // Fehlschlag oder keine Abholung: kein sysprep, die VM bleibt an (finish_windows_template meldet das Ergebnis)
    'Marke "Medienpruefung"',
    medienPsPruefung(),
    'if (-not $mp.ok) { MpFehlschlag }',
    'MpSchreiben',
    'Marke "Medienpruefung bestanden, warte auf Abholung durch Alfred"',
    '$bis = (Get-Date).AddHours(6)',
    'while (-not (Test-Path -LiteralPath $mpAbgeholt)) { if ((Get-Date) -gt $bis) { Marke "FEHLER Medienpruefung nicht abgeholt"; Stop-Transcript; exit 1 }; Start-Sleep -Seconds 10 }',
    'Marke "sysprep"',
    'Stop-Transcript',
    '& "$env:WINDIR\\System32\\Sysprep\\sysprep.exe" /generalize /oobe /shutdown /quiet "/unattend:$cb\\conf\\alfred-sysprep.xml"',
    '',
  ].join('\r\n');
}

// ── Ruling R35 (I8e L6): Medienprüfung im Gast ───────────────────────────────────────────────────────────────────────────────────
// Echtheit der installierten Medien technisch belegt statt nur über die HTTPS-Herkunft: Secure Boot aktiv (UEFI mit den
// Microsoft-Schlüsseln erzwingt eine Microsoft-signierte Bootkette), Kernsystemdateien und VirtIO-Treiber mit gültiger
// Authenticode-/Katalogsignatur (Get-AuthenticodeSignature prüft Katalogsignaturen mit), Cloudbase-Init vom Herausgeber signiert.
// Eine Prüflogik für beide Wege: vor sysprep im Einrichtungsskript und lesend auf jeder laufenden Windows-VM (check_windows_media).

/** Ruling R37 (I8e L6): Marken des Einrichtungsskripts, zeilenweise geschrieben und für den Gast-Agenten lesbar (das Transkript ist gesperrt) */
export const SETUP_STATUS_DATEI = 'C:\\Windows\\Temp\\alfred-setup-status.log';
/** Ruling R37: Zeitlimit für die OpenSSH-Nachinstallation aus Windows Update (Realfall 9110: weit über 30 min) */
export const OPENSSH_ZEITLIMIT_S = 5400;
/**
 * Ruling R37: Enter für „Press any key to boot from CD or DVD“ nur im Fenster der Boot-Abfrage (etwa 12 s nach dem Start).
 * Länger trifft es das schon laufende Setup — dort hat „Abbrechen“ den Fokus (Realfall 9110/9111).
 */
export const BOOT_TASTEN = { anzahl: 8, abstandMs: 1500 } as const;
/** Ergebnisdatei der Bau-VM und Freigabe-Marke (schreibt Alfred erst, nachdem das Ergebnis in der VM-Beschreibung steht) */
export const MEDIEN_DATEI = 'C:\\Windows\\Setup\\Alfred\\medienpruefung.json';
export const MEDIEN_ABGEHOLT = 'C:\\Windows\\Setup\\Alfred\\medienpruefung.abgeholt';
/** Zeile in der Beschreibung der Bau-VM: „MEDIENPRUEFUNG {json}“ — finish_windows_template liest nur sie (die VM ist dann aus) */
export const MEDIEN_MARKE = 'MEDIENPRUEFUNG ';
/** Feste Kernsystemdateien (alle Varianten); explorer.exe zusätzlich außer bei Server Core */
export const MEDIEN_SYSTEM = ['C:\\Windows\\System32\\ntoskrnl.exe', 'C:\\Windows\\System32\\winload.efi', 'C:\\Windows\\System32\\ci.dll', 'C:\\Windows\\System32\\kernel32.dll'];
export const MEDIEN_EXPLORER = 'C:\\Windows\\explorer.exe';
/** VirtIO-Treiber aus dem VirtIO-ISO (Dateien in System32\drivers); geprüft wird jeder vorhandene, Pflicht sind Platte, Netz und Gast-Agent-Kanal */
export const VIRTIO_SYS = ['vioscsi', 'viostor', 'netkvm', 'balloon', 'vioser', 'viorng', 'pvpanic', 'fwcfg', 'viofs', 'vioinput', 'viogpudo'];
export const VIRTIO_SYS_PFLICHT = ['vioscsi', 'netkvm', 'vioser'];
/**
 * Ruling R38: erlaubte Orte eines VirtIO-Treibers — System32\drivers oder der Treiberspeicher, dort nur im Paketordner des
 * gleichnamigen INF (z. B. vioscsi.inf_amd64_11391c8694cab0ca\vioscsi.sys, Realfall 9112)
 */
export const VIRTIO_PFAD = /^c:\\windows\\system32\\(drivers\\[a-z0-9]+|driverstore\\filerepository\\([a-z0-9]+)\.inf_amd64_[0-9a-f]{16}\\\2)\.sys$/i;
/** Signer-Subjekte (X.500, wie Get-AuthenticodeSignature sie liefert); gleiche Ausdrücke im Gast (.NET) und hier */
export const SIGNER_MICROSOFT = /(^|,\s*)O=Microsoft Corporation(,|$)/i;
/** VirtIO 0.1.2xx/0.1.30x: Windows-10/11-/Server-Treiber attestation-signiert („Microsoft Windows Hardware Compatibility Publisher“); ältere Red Hat */
export const SIGNER_VIRTIO = /(^|,\s*)O=(Microsoft Corporation|"Red Hat, Inc\.?"|Red Hat Inc\.?)(,|$)/i;
/** Cloudbase-Init 1.1.9 (gelesen am 20.11.2026): „CN=Cloudbase Solutions Srl, O=Cloudbase Solutions Srl, L=Timisoara, C=RO“ */
export const SIGNER_CLOUDBASE = /(^|,\s*)O=Cloudbase Solutions Srl(,|$)/i;

const psLit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Gemeinsamer Anfang: Signer-Ausdrücke, Signatur-Funktion, Ergebnisobjekt, Installationsart */
export function medienPsGrundlage(): string[] {
  return [
    `$msO = ${psLit(SIGNER_MICROSOFT.source)}`,
    `$vioO = ${psLit(SIGNER_VIRTIO.source)}`,
    `$cbO = ${psLit(SIGNER_CLOUDBASE.source)}`,
    'function Signatur($pfad) { if (-not $pfad -or -not (Test-Path -LiteralPath $pfad)) { return [pscustomobject]@{ datei = [string]$pfad; status = "Fehlt"; signer = "" } }; $s = Get-AuthenticodeSignature -LiteralPath $pfad; $n = ""; if ($s.SignerCertificate) { $n = $s.SignerCertificate.Subject }; [pscustomobject]@{ datei = [string]$pfad; status = $s.Status.ToString(); signer = $n } }',
    '$mp = [ordered]@{ version = 1; ok = $false; installationType = ""; secureBoot = $false; system = @(); virtio = @(); cloudbase = @(); fehler = @() }',
    'try { $mp.installationType = [string](Get-ItemProperty -LiteralPath "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion").InstallationType } catch { }',
  ];
}

/** Cloudbase-Init-MSI vor der Installation (Bau-VM) */
export function medienPsCloudbaseMsi(pfadAusdruck: string): string[] {
  return [
    `$e = Signatur ${pfadAusdruck}; $mp.cloudbase = @($e)`,
    'if ($e.status -ne "Valid" -or $e.signer -notmatch $cbO) { $mp.fehler += "Cloudbase-Init-MSI nicht gueltig von Cloudbase Solutions signiert ($($e.status), $($e.signer))" }',
  ];
}

/** Cloudbase-Init installiert (lesend, z. B. Klone): Dienstprogramm oder das von Windows Installer zwischengespeicherte MSI */
export function medienPsCloudbaseInstalliert(): string[] {
  return [
    `$d = Get-CimInstance Win32_Service -Filter "Name='cloudbase-init'" -ErrorAction SilentlyContinue`,
    'if ($d -and $d.PathName) { $x = [string]$d.PathName; if ($x -match \'^"([^"]+)"\') { $x = $Matches[1] } else { $x = ($x -split " ")[0] }; $mp.cloudbase += Signatur $x }',
    '$pk = Get-ChildItem -LiteralPath "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Installer\\UserData\\S-1-5-18\\Products" -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty -LiteralPath (Join-Path $_.PSPath "InstallProperties") -ErrorAction SilentlyContinue } | Where-Object { $_.DisplayName -like "Cloudbase-Init*" } | Select-Object -First 1',
    'if ($pk -and $pk.LocalPackage) { $mp.cloudbase += Signatur ([string]$pk.LocalPackage) }',
    'if (-not ($mp.cloudbase | Where-Object { $_.status -eq "Valid" -and $_.signer -match $cbO })) { $mp.fehler += "Cloudbase-Init: weder Dienstprogramm noch zwischengespeichertes MSI gueltig von Cloudbase Solutions signiert" }',
  ];
}

/** Gemeinsame Prüfung: Secure Boot, Kernsystemdateien, VirtIO-Treiber; setzt $mp.ok */
export function medienPsPruefung(): string {
  return [
    'try { $mp.secureBoot = [bool](Confirm-SecureBootUEFI) } catch { $mp.secureBoot = $false }',
    'if (-not $mp.secureBoot) { $mp.fehler += "Secure Boot nicht aktiv" }',
    `$sys = @(${MEDIEN_SYSTEM.map(psLit).join(', ')})`,
    `if ($mp.installationType -ne "Server Core") { $sys += "${MEDIEN_EXPLORER}" }`,
    'foreach ($f in $sys) { $e = Signatur $f; $mp.system += $e; if ($e.status -ne "Valid" -or $e.signer -notmatch $msO) { $mp.fehler += "$f nicht Microsoft-signiert ($($e.status))" } }',
    // Ruling R38 (I8e L6): neuere VirtIO-Treiber laufen aus dem Treiberspeicher (DriverStore\FileRepository) statt aus System32\drivers —
    // Pfad aus der Dienstkonfiguration aller Systemtreiber über den Dateinamen (Dienstnamen weichen ab, z. B. vioser), sonst der alte Ort
    '$drv = @(Get-CimInstance Win32_SystemDriver -ErrorAction SilentlyContinue | Where-Object { $_.PathName } | ForEach-Object { $p = ([string]$_.PathName).Trim(\'"\') -replace \'^\\\\\\?\\?\\\\\', \'\'; if ($p -match \'^\\\\SystemRoot\\\\\') { $p = $env:WINDIR + $p.Substring(11) } elseif ($p -match \'^(?i)system32\\\\\') { $p = Join-Path $env:WINDIR $p }; $p })',
    `foreach ($t in @(${VIRTIO_SYS.map(psLit).join(', ')})) { $f = $drv | Where-Object { [IO.Path]::GetFileName($_) -ieq "$t.sys" } | Select-Object -First 1; if (-not $f) { $f = "C:\\Windows\\System32\\drivers\\$t.sys" }; if (Test-Path -LiteralPath $f) { $e = Signatur $f; $mp.virtio += $e; if ($e.status -ne "Valid" -or $e.signer -notmatch $vioO) { $mp.fehler += "$t.sys nicht gueltig signiert ($($e.status))" } } elseif (@(${VIRTIO_SYS_PFLICHT.map(psLit).join(', ')}) -contains $t) { $mp.fehler += "VirtIO-Treiber $t.sys fehlt" } }`,
    '$mp.ok = ($mp.fehler.Count -eq 0)',
  ].join('\r\n');
}

/** Lesende Prüfung auf einer laufenden Windows-VM (über den Gast-Agenten): schreibt nichts, Ergebnis als „ALFRED_MEDIEN {json}“ */
export function medienPruefSkript(): string {
  return [
    '$ErrorActionPreference = "Stop"',
    ...medienPsGrundlage(),
    ...medienPsCloudbaseInstalliert(),
    medienPsPruefung(),
    '"ALFRED_MEDIEN " + (ConvertTo-Json -InputObject $mp -Depth 5 -Compress)',
    '',
  ].join('\r\n');
}

export interface MedienErgebnis { ok: boolean; fehler: string[]; zeile: string; system: number; virtio: number; json?: string }
interface MedienEintrag { datei: string; status: string; signer: string }

/**
 * Bewertet das Ergebnis aus dem Gast unabhängig von dessen eigenem „ok“ (fail-closed): fehlt etwas, ist es unlesbar oder weicht ab,
 * gilt die Prüfung als nicht bestanden. Feste Zeile „MEDIEN_SIGNIERT …“ bzw. „MEDIEN_NICHT_BELEGT …“.
 */
export function bewerteMedienpruefung(roh: string | undefined, name: string, variante?: WinVariante): MedienErgebnis {
  const nein = (fehler: string[], json?: string, system = 0, virtio = 0): MedienErgebnis => ({ ok: false, fehler, zeile: `MEDIEN_NICHT_BELEGT ${name}: ${fehler.join('; ')}`, system, virtio, ...(json ? { json } : {}) });
  if (roh === undefined || !roh.trim()) return nein(['kein Ergebnis der Medienprüfung (Ruling R35)']);
  let x: Record<string, unknown>;
  try { x = JSON.parse(roh.replace(/^\uFEFF/, '').trim()) as Record<string, unknown>; } catch { return nein(['Ergebnis der Medienprüfung unlesbar']); }
  if (!x || typeof x !== 'object') return nein(['Ergebnis der Medienprüfung unlesbar']);
  const liste = (v: unknown): MedienEintrag[] => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [])
    .filter((z): z is Record<string, unknown> => !!z && typeof z === 'object')
    .map(z => ({ datei: String(z.datei ?? ''), status: String(z.status ?? ''), signer: String(z.signer ?? '') }));
  const json = JSON.stringify(x);
  const fehler: string[] = [];
  const gast = (Array.isArray(x.fehler) ? x.fehler : x.fehler ? [x.fehler] : []).map(String);
  fehler.push(...gast);
  if (x.version !== 1) fehler.push('unbekannte Fassung des Ergebnisses');
  if (x.ok !== true && !gast.length) fehler.push('Gast meldet nicht bestanden');
  if (x.secureBoot !== true) { if (!fehler.includes('Secure Boot nicht aktiv')) fehler.push('Secure Boot nicht aktiv'); }
  const kern = String(x.installationType ?? '') === 'Server Core';
  if (variante && variante.endsWith('-core') !== kern) fehler.push(`Installationsart „${String(x.installationType ?? '')}“ passt nicht zur Variante ${variante}`);
  // Sicherheitsprüfung: ohne bekannte Variante darf die Selbstauskunft des Gastes („Server Core“) die Pflichtliste nicht verkürzen
  const sollKern = variante ? variante.endsWith('-core') : false;
  const system = liste(x.system);
  const basis = (d: string) => d.split('\\').pop()!.toLowerCase();
  for (const p of [...MEDIEN_SYSTEM, ...(sollKern ? [] : [MEDIEN_EXPLORER])]) {
    const t = system.find(s => s.datei.toLowerCase() === p.toLowerCase());
    if (!t || t.status !== 'Valid' || !SIGNER_MICROSOFT.test(t.signer)) { const m = `${basis(p)} nicht Microsoft-signiert (${t?.status ?? 'fehlt'})`; if (!fehler.some(f => f.toLowerCase().includes(basis(p)))) fehler.push(m); }
  }
  for (const s of system) if (s.status !== 'Valid' || !SIGNER_MICROSOFT.test(s.signer)) { if (!fehler.some(f => f.toLowerCase().includes(basis(s.datei)))) fehler.push(`${basis(s.datei)} nicht Microsoft-signiert (${s.status})`); }
  const virtio = liste(x.virtio);
  for (const p of VIRTIO_SYS_PFLICHT) if (!virtio.some(v => basis(v.datei) === `${p}.sys`)) { if (!fehler.some(f => f.includes(`${p}.sys`))) fehler.push(`VirtIO-Treiber ${p}.sys fehlt`); }
  for (const v of virtio) {
    if (!VIRTIO_PFAD.test(v.datei)) fehler.push(`VirtIO-Eintrag außerhalb von System32\\drivers und DriverStore\\FileRepository: ${v.datei}`);
    else if (v.status !== 'Valid' || !SIGNER_VIRTIO.test(v.signer)) { if (!fehler.some(f => f.includes(basis(v.datei)))) fehler.push(`${basis(v.datei)} nicht gültig signiert (${v.status})`); }
  }
  if (!liste(x.cloudbase).some(c => c.status === 'Valid' && SIGNER_CLOUDBASE.test(c.signer)) && !fehler.some(f => f.startsWith('Cloudbase-Init'))) fehler.push('Cloudbase-Init nicht gültig von Cloudbase Solutions signiert');
  if (fehler.length) return nein(fehler, json, system.length, virtio.length);
  return { ok: true, fehler: [], zeile: `MEDIEN_SIGNIERT ${name}: Secure Boot an, ${system.length} Systemdateien Microsoft-signiert, VirtIO ${virtio.length} signiert, Cloudbase-Init signiert`, system: system.length, virtio: virtio.length, json };
}

/** Festgehaltenes Ergebnis aus der Beschreibung der Bau-VM (Zeile „MEDIENPRUEFUNG {json}“) */
export function medienAusBeschreibung(beschreibung: string): string | undefined {
  // Sicherheitsprüfung: genau eine Ergebniszeile, und sie muss die letzte sein — sonst mehrdeutig (unlesbar, fail-closed)
  const zeilen = beschreibung.split(/\r?\n/).filter(l => l.trim() !== '');
  const treffer = zeilen.filter(l => l.startsWith(MEDIEN_MARKE));
  if (!treffer.length) return undefined;
  if (treffer.length !== 1 || zeilen[zeilen.length - 1] !== treffer[0]) return 'MEHRDEUTIG';
  return treffer[0].slice(MEDIEN_MARKE.length);
}

/** Variante aus der Beschreibung einer Bau-VM oder eines Klons (nur bekannte Werte) */
export function varianteAusBeschreibung(beschreibung: string): WinVariante | undefined {
  const v = /Windows-Vorlage von Alfred \(I8a\): ([\w-]+),/.exec(beschreibung)?.[1] ?? /aus Windows-Vorlage \d+ \(([\w-]+)\)/.exec(beschreibung)?.[1];
  return istWinVariante(v) ? v : undefined;
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
    ...(istWin11(v.variante) ? [] : ['  Set-LocalUser -Name Administrator -Password $pw']),
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

/**
 * Realfall probe-win25b (01.11. 22:30): beim ersten Start nach sysprep endete PowerShell mit den Benutzerdaten nach einer Sekunde
 * mit Exit 1, ohne einen Befehl auszuführen (zeitgleich „User Profile Service has stopped“). Cloudbase-Init wiederholt nach Exit 1
 * nicht — Schlüssel, Konto, Firewall und Name fehlten. Dieses feste Skript (Gast-Agent, SYSTEM) holt die Einrichtung genau dann nach:
 * Cloudbase-Init noch nicht abgeschaltet und der letzte Lauf endete nicht mit 0/1001/1003. Die Benutzerdaten kommen vom
 * Konfigurationslaufwerk und gehen direkt als -EncodedCommand in einen neuen Prozess — keine Datei, kein Inhalt in der Ausgabe.
 * Bei 1001 (Name gesetzt) folgt der Neustart, den sonst Cloudbase-Init auslöst.
 */
export const WIN_EINRICHTUNG_NACHHOLEN = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$log = 'C:\\Program Files\\Cloudbase Solutions\\Cloudbase-Init\\log\\cloudbase-init.log'",
  "if ((Get-Service -Name cloudbase-init).StartType -eq 'Disabled') { 'NACHHOLEN_UNNOETIG Cloudbase-Init schon abgeschaltet'; exit 0 }",
  "$m = Select-String -Path $log -Pattern 'User_data script ended with return code: (-?\\d+)' -ErrorAction SilentlyContinue | Select-Object -Last 1",
  "if (-not $m) { 'NACHHOLEN_UNNOETIG Benutzerdaten noch nicht gelaufen'; exit 0 }",
  "$alt = [int]$m.Matches[0].Groups[1].Value",
  "if (@(0, 1001, 1003) -contains $alt) { \"NACHHOLEN_UNNOETIG letzter Lauf $alt\"; exit 0 }",
  "$lw = Get-Volume | Where-Object { $_.FileSystemLabel -eq 'config-2' -and $_.DriveLetter } | Select-Object -First 1",
  "if (-not $lw) { 'NACHHOLEN_FEHLER kein Konfigurationslaufwerk config-2'; exit 2 }",
  "$t = [IO.File]::ReadAllText(\"$($lw.DriveLetter):\\openstack\\latest\\user_data\")",
  "if (-not $t.StartsWith('#ps1_sysnative')) { 'NACHHOLEN_FEHLER Benutzerdaten sind kein PowerShell-Skript'; exit 2 }",
  "$b = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($t))",
  "$p = Start-Process -FilePath \"$env:WINDIR\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -ArgumentList '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $b -Wait -PassThru -WindowStyle Hidden",
  "$c = $p.ExitCode",
  "if ($c -eq 1001) { shutdown.exe /r /t 10 /d p:4:1 /c 'Alfred: Einrichtung nachgeholt, Neustart fuer den Namen' | Out-Null }",
  "\"NACHHOLEN_ERGEBNIS vorher=$alt jetzt=$c\"",
  "if (@(0, 1001) -contains $c) { exit 0 } else { exit 3 }",
].join('\r\n');

/** Proxmox-Konfiguration der Bau-VM (UEFI mit Microsoft-Schlüsseln, TPM 2.0, VirtIO) */
export function windowsBauKonfig(v: { vmid: number; name: string; storage: string; windowsIso: string; virtioIso: string; antwortIso: string; groesseGb?: number; memory?: number; cores?: number; bridge?: string; vlan?: number; beschreibung?: string; machine?: string }): Record<string, unknown> {
  // Ruling R36 (I8e L6): Windows-ISO auch mit dem Microsoft-Dateinamen des Mehrfach-Edition-ISO
  if (!ISO_VOLUME.test(v.windowsIso) && !WIN11_PRO_ISO_VOLUME.test(v.windowsIso)) throw new Error(`ungültiges ISO-Volume ${v.windowsIso}`);
  for (const iso of [v.virtioIso, v.antwortIso]) if (!ISO_VOLUME.test(iso)) throw new Error(`ungültiges ISO-Volume ${iso}`);
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
