import { describe, expect, it } from 'vitest';
import { sammleWindows, leseWinOs, leseWinVolumes, leseWinDienste, leseWinPorts, leseWinProzesse, leseWinRollen, leseWinHotfixes, leseWinAusstehend, leseWinLizenz, leseWinSmbServer, leseWinSmbClient, leseWinFirewall, leseWinDefender, leseWinRegistry, jsonListe, WINDOWS_BEFEHLE } from './sammler-windows.js';

// Ausgaben im Format von Windows PowerShell 5.1 (ConvertTo-Json -Compress), wie auf probe-win25 (Server 2025 Core)
const OS = '{"Caption":"Microsoft Windows Server 2025 Standard Evaluation","Version":"10.0.26100","BuildNumber":"26100","TotalVisibleMemorySize":4193784,"FreePhysicalMemory":2621440}';
const SYS = '{"NumberOfLogicalProcessors":2,"Domain":"WORKGROUP","PartOfDomain":false}';
const VOL = '[{"DriveLetter":"C","FileSystemLabel":"Windows","FileSystem":"NTFS","Size":68085919744,"SizeRemaining":55834574848},{"DriveLetter":null,"FileSystemLabel":"System","FileSystem":"FAT32","Size":271314944,"SizeRemaining":240000000},{"DriveLetter":"D","FileSystemLabel":"","FileSystem":"","Size":0,"SizeRemaining":0},{"DriveLetter":"E","FileSystemLabel":"cidata","FileSystem":"CDFS","Size":524288,"SizeRemaining":0}]';
const DIENSTE = '[{"Name":"sshd","Status":4},{"Name":"WinRM","Status":4},{"Name":"Spooler","Status":1}]';
const PORTS = '[{"LocalAddress":"0.0.0.0","LocalPort":22,"OwningProcess":3120},{"LocalAddress":"::","LocalPort":22,"OwningProcess":3120},{"LocalAddress":"0.0.0.0","LocalPort":5985,"OwningProcess":4}]';
const PROZ = '[{"Id":3120,"ProcessName":"sshd"},{"Id":4,"ProcessName":"System"}]';
const ROLLEN = '[{"Name":"AD-Certificate","Installed":false},{"Name":"FS-FileServer","Installed":true},{"Name":"Windows-Defender","Installed":true}]';
const HOTFIX = '[{"HotFixID":"KB5044281","InstalledOn":{"value":"\\/Date(1730419200000)\\/","DateTime":"Friday, November 1, 2024 12:00:00 AM"}},{"HotFixID":"KB5043080","InstalledOn":"\\/Date(1727740800000)\\/"}]';
const WU = '[{"Title":"2026-11 Cumulative Update for Microsoft server operating system version 24H2 for x64-based Systems (KB5070000)"},{"Title":"Windows Malicious Software Removal Tool x64 - v5.130"}]';

describe('I8b Windows-Sammler', () => {
  it('Parser für PowerShell-5.1-JSON', () => {
    expect(jsonListe('')).toEqual([]);
    expect(jsonListe('{"a":1}')).toEqual([{ a: 1 }]);
    expect(leseWinOs(OS)).toMatchObject({ os: { name: 'Microsoft Windows Server 2025 Standard Evaluation', id: 'windows', version: '10.0.26100 (Build 26100)' }, ram: { gesamt: 4193784 * 1024 } });
    expect(leseWinVolumes(VOL).map(v => [v.mount, v.typ, v.prozent])).toEqual([['C:', 'NTFS', 18], ['System', 'FAT32', 12]]);
    expect(leseWinDienste(DIENSTE)).toEqual(['WinRM', 'sshd']);
    expect(leseWinPorts(PORTS, leseWinProzesse(PROZ))).toEqual([{ adresse: '0.0.0.0', port: 22, prozess: 'sshd' }, { adresse: '::', port: 22, prozess: 'sshd' }, { adresse: '0.0.0.0', port: 5985, prozess: 'System' }]);
    expect(leseWinRollen(ROLLEN)).toEqual(['FS-FileServer', 'Windows-Defender']);
    expect(leseWinHotfixes(HOTFIX)).toEqual({ anzahl: 2, letztes: '2024-11-01' });
    expect(leseWinAusstehend(WU)).toMatchObject({ anzahl: 2, sicherheit: 1 });
  });

  it('sammleWindows: Bestand wie Linux plus Windows-Angaben; Teilfehler stehen im Bestand', async () => {
    const antworten: Record<string, string> = { [WINDOWS_BEFEHLE.os]: OS, [WINDOWS_BEFEHLE.system]: SYS, [WINDOWS_BEFEHLE.volumes]: VOL, [WINDOWS_BEFEHLE.dienste]: DIENSTE, [WINDOWS_BEFEHLE.ports]: PORTS, [WINDOWS_BEFEHLE.prozesse]: PROZ, [WINDOWS_BEFEHLE.rollen]: ROLLEN, [WINDOWS_BEFEHLE.hotfixes]: HOTFIX, [WINDOWS_BEFEHLE.lizenz]: LIZ_EVAL, [WINDOWS_BEFEHLE.smbServer]: SMB_S, [WINDOWS_BEFEHLE.smbClient]: SMB_C_9102, [WINDOWS_BEFEHLE.firewall]: FW_9102, [WINDOWS_BEFEHLE.defender]: DEF, [WINDOWS_BEFEHLE.registry]: REG_9102 };
    const b = await sammleWindows('probe-win25', '192.168.1.222', async c => { if (!(c in antworten)) throw new Error('Zeitüberschreitung'); return antworten[c]!; });
    expect(b).toMatchObject({ cpus: 2, dienste: ['WinRM', 'sshd'], windows: { rollen: ['FS-FileServer', 'Windows-Defender'], hotfixes: { anzahl: 2 }, lizenz: { status: 'testversion', kanal: 'Testversion' } } });
    expect(b.windows.domaene).toBeUndefined();
    expect(b.updates).toBeUndefined();
    expect(b.fehler).toEqual([]);
  });

  // I8 3b-5 — echte Ausgaben vom 06.11. (VM 137 Win11-Dev aktiviert, VM 100 workVM Benachrichtigungsmodus), Testversion wie Server-2025-Eval
  it('3b-5 Lizenz: Windows-Produkt mit Schlüssel, Office und Nulldatum 1601 ignoriert, Kanal/Status/Ablauf', () => {
    const jetzt = new Date('2026-11-06T12:00:00Z');
    expect(leseWinLizenz(LIZ_137, jetzt)).toEqual({ status: 'aktiviert', kanal: 'Einzelhandel', produkt: 'Windows(R), Professional edition' });
    expect(leseWinLizenz(LIZ_100, jetzt)).toMatchObject({ status: 'benachrichtigung', kanal: 'Einzelhandel' });
    expect(leseWinLizenz(LIZ_EVAL, jetzt)).toEqual({ status: 'testversion', kanal: 'Testversion', produkt: 'Windows(R), ServerStandardEval edition', ablauf: '2027-04-03', restTage: 148 });
    // ohne EvaluationEndDate: Restlaufzeit in Minuten
    expect(leseWinLizenz(LIZ_EVAL.replace('"\\/Date(1806753600000)\\/"', '"\\/Date(-11644473600000)\\/"'), jetzt)).toMatchObject({ restTage: 180, ablauf: '2027-05-05' });
    expect(leseWinLizenz('[]', jetzt)).toBeUndefined();
  });
});
// I8 3b-2a — echte Ausgaben vom 07.11. (VM 9102 probe-win25b Server 2025 Core, VM 137 Windows 11)
const SMB_S = '{"EnableSMB1Protocol":false,"RequireSecuritySignature":false,"EncryptData":false}';
const SMB_C_9102 = '{"RequireSecuritySignature":true,"EnableInsecureGuestLogons":false}';
const SMB_C_137 = '{"RequireSecuritySignature":false,"EnableInsecureGuestLogons":false}';
const FW_9102 = '[{"Name":"Domain","Enabled":1,"DefaultInboundAction":0},{"Name":"Private","Enabled":1,"DefaultInboundAction":0},{"Name":"Public","Enabled":1,"DefaultInboundAction":0}]';
const FW_137 = '[{"Name":"Domain","Enabled":1,"DefaultInboundAction":4},{"Name":"Private","Enabled":1,"DefaultInboundAction":4},{"Name":"Public","Enabled":1,"DefaultInboundAction":4}]';
const DEF = '{"AMServiceEnabled":true,"AntivirusEnabled":true,"RealTimeProtectionEnabled":true,"AntivirusSignatureAge":0,"AntivirusSignatureLastUpdated":"\\/Date(1793976922000)\\/"}';
const REG_9102 = '{"RdpAus":1,"Nla":1,"Tls10":null,"Tls11":null,"LapsCsp":null,"LapsGpo":null,"LapsLokal":null}';
const REG_137 = '{"RdpAus":0,"Nla":1,"Tls10":null,"Tls11":null,"LapsCsp":null,"LapsGpo":null,"LapsLokal":null}';

describe('I8 3b-2a Sicherheits-Grundlinie', () => {
  it('Parser mit echten Ausgaben', () => {
    expect(leseWinSmbServer(SMB_S)).toEqual({ smb1: false, smbSignaturServer: false });
    expect(leseWinSmbClient(SMB_C_9102)).toEqual({ smbSignaturClient: true, gastAnmeldung: false });
    expect(leseWinFirewall(FW_9102)).toEqual([{ profil: 'Domain', an: true, eingehend: 'standard' }, { profil: 'Private', an: true, eingehend: 'standard' }, { profil: 'Public', an: true, eingehend: 'standard' }]);
    expect(leseWinFirewall(FW_137)[0]).toEqual({ profil: 'Domain', an: true, eingehend: 'blockieren' });
    expect(leseWinFirewall('[{"Name":"Public","Enabled":0,"DefaultInboundAction":2}]')).toEqual([{ profil: 'Public', an: false, eingehend: 'zulassen' }]);
    expect(leseWinDefender(DEF)).toEqual({ an: true, echtzeit: true, signaturTage: 0 });
    expect(leseWinDefender(DEF.replace('"AntivirusSignatureAge":0', '"AntivirusSignatureAge":65535'), new Date(1793976922000 + 10 * 86_400_000))).toMatchObject({ signaturTage: 10 });
    expect(leseWinRegistry(REG_9102)).toEqual({ rdp: { an: false, nla: true }, tls10Aus: false, tls11Aus: false });
    expect(leseWinRegistry(REG_137)).toMatchObject({ rdp: { an: true, nla: true } });
    expect(leseWinRegistry('{"RdpAus":0,"Nla":0,"Tls10":0,"Tls11":0,"LapsCsp":null,"LapsGpo":2,"LapsLokal":1}')).toEqual({ rdp: { an: true, nla: false }, tls10Aus: true, tls11Aus: true, laps: 'ad' });
  });

  it('sammleWindows führt die Grundlinie; ein fehlender Teil ist eine Erfassungslücke', async () => {
    const antworten: Record<string, string> = { [WINDOWS_BEFEHLE.os]: OS, [WINDOWS_BEFEHLE.smbServer]: SMB_S, [WINDOWS_BEFEHLE.smbClient]: SMB_C_137, [WINDOWS_BEFEHLE.firewall]: FW_137, [WINDOWS_BEFEHLE.registry]: REG_137 };
    const b = await sammleWindows('win11', '192.168.1.137', async c => { if (!(c in antworten)) throw new Error('Zeitüberschreitung'); return antworten[c]!; });
    expect(b.windows.grundlinie).toMatchObject({ smb1: false, smbSignaturClient: false, rdp: { an: true, nla: true }, tls10Aus: false });
    expect(b.windows.grundlinie!.defender).toBeUndefined();
    expect(b.fehler.some(f => f.startsWith('defender:'))).toBe(true);
  });

  it('alle Grundlinien-Befehle stehen als lesend auf der Leseliste', async () => {
    const { windowsBefehlsklasse, normalisiereBefehl } = await import('../fernzugriff/regeln.js');
    for (const k of ['smbServer', 'smbClient', 'firewall', 'defender', 'registry'] as const) expect(windowsBefehlsklasse(normalisiereBefehl(WINDOWS_BEFEHLE[k])), k).toBe('lesen');
    // der feste Registry-Text gilt nur exakt — jede Abwandlung braucht die Owner-Bestätigung
    expect(windowsBefehlsklasse(WINDOWS_BEFEHLE.registry.replace('fDenyTSConnections', 'fDenyTSConnections;Remove-Item C:/x'))).toBe('bestaetigen');
    expect(windowsBefehlsklasse(WINDOWS_BEFEHLE.registry.replace('HKLM:\\SOFTWARE\\Microsoft\\Policies\\LAPS', 'HKLM:\\SAM\\SAM'))).toBe('bestaetigen');
  });
});

const LIZ_137 = '[{"Name":"Office 16, Office16O365ProPlusR_Grace edition","Description":"Office 16, RETAIL(Grace) channel","ApplicationID":"0ff1ce15-a989-479d-af46-f275c6370663","PartialProductKey":"VMFTK","LicenseStatus":5,"GracePeriodRemaining":0,"EvaluationEndDate":"\\/Date(-11644473600000)\\/"},{"Name":"Windows(R), Professional edition","Description":"Windows(R) Operating System, RETAIL channel","ApplicationID":"55c92734-d682-4d71-983e-d6ec3f16059f","PartialProductKey":"8HV26","LicenseStatus":1,"GracePeriodRemaining":0,"EvaluationEndDate":"\\/Date(-11644473600000)\\/"}]';
const LIZ_100 = '[{"Name":"Windows(R), Professional edition","Description":"Windows(R) Operating System, RETAIL channel","ApplicationID":"55c92734-d682-4d71-983e-d6ec3f16059f","PartialProductKey":"3V66T","LicenseStatus":5,"GracePeriodRemaining":0,"EvaluationEndDate":"\\/Date(-11644473600000)\\/"}]';
const LIZ_EVAL = '[{"Name":"Windows(R), ServerStandardEval edition","Description":"Windows(R) Operating System, TIMEBASED_EVAL channel","ApplicationID":"55c92734-d682-4d71-983e-d6ec3f16059f","PartialProductKey":"XXXXX","LicenseStatus":1,"GracePeriodRemaining":259200,"EvaluationEndDate":"\\/Date(1806753600000)\\/"}]';
