import { describe, expect, it } from 'vitest';
import { sammleWindows, leseWinOs, leseWinVolumes, leseWinDienste, leseWinPorts, leseWinProzesse, leseWinRollen, leseWinHotfixes, leseWinAusstehend, leseWinLizenz, jsonListe, WINDOWS_BEFEHLE } from './sammler-windows.js';

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
    const antworten: Record<string, string> = { [WINDOWS_BEFEHLE.os]: OS, [WINDOWS_BEFEHLE.system]: SYS, [WINDOWS_BEFEHLE.volumes]: VOL, [WINDOWS_BEFEHLE.dienste]: DIENSTE, [WINDOWS_BEFEHLE.ports]: PORTS, [WINDOWS_BEFEHLE.prozesse]: PROZ, [WINDOWS_BEFEHLE.rollen]: ROLLEN, [WINDOWS_BEFEHLE.hotfixes]: HOTFIX, [WINDOWS_BEFEHLE.lizenz]: LIZ_EVAL };
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
const LIZ_137 = '[{"Name":"Office 16, Office16O365ProPlusR_Grace edition","Description":"Office 16, RETAIL(Grace) channel","ApplicationID":"0ff1ce15-a989-479d-af46-f275c6370663","PartialProductKey":"VMFTK","LicenseStatus":5,"GracePeriodRemaining":0,"EvaluationEndDate":"\\/Date(-11644473600000)\\/"},{"Name":"Windows(R), Professional edition","Description":"Windows(R) Operating System, RETAIL channel","ApplicationID":"55c92734-d682-4d71-983e-d6ec3f16059f","PartialProductKey":"8HV26","LicenseStatus":1,"GracePeriodRemaining":0,"EvaluationEndDate":"\\/Date(-11644473600000)\\/"}]';
const LIZ_100 = '[{"Name":"Windows(R), Professional edition","Description":"Windows(R) Operating System, RETAIL channel","ApplicationID":"55c92734-d682-4d71-983e-d6ec3f16059f","PartialProductKey":"3V66T","LicenseStatus":5,"GracePeriodRemaining":0,"EvaluationEndDate":"\\/Date(-11644473600000)\\/"}]';
const LIZ_EVAL = '[{"Name":"Windows(R), ServerStandardEval edition","Description":"Windows(R) Operating System, TIMEBASED_EVAL channel","ApplicationID":"55c92734-d682-4d71-983e-d6ec3f16059f","PartialProductKey":"XXXXX","LicenseStatus":1,"GracePeriodRemaining":259200,"EvaluationEndDate":"\\/Date(1806753600000)\\/"}]';
