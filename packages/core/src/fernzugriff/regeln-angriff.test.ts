import { describe, expect, it } from 'vitest';
import { befehlsklasse, windowsBefehlsklasse } from './regeln.js';

// Sicherheitsprüfung 01.11. (v1729/v1733): Angriffseingaben gegen die Leseliste — keine darf als Lesen durchgehen
describe('Angriffsprobe Leseliste', () => {
  it('Linux sed/2>&1', () => {
    const faelle = [
      "docker logs x | sed 's/a/b/' | sh",
      "docker logs x | sed 's/a/b/e'",
      "docker logs x | sed 's/a/b/w /etc/cron.d/x'",
      "docker logs x | sed 's/a/b/;e id'",
      "docker logs x | sed \"s/a/$(id)/\"",
      "docker logs x | sed 's/a/b/' /etc/shadow",
      "docker logs x | sed -i 's/a/b/' /etc/passwd",
      "docker logs x | sed -f /tmp/s",
      "docker logs x | sed --expression='s/a/b/'",
      "docker logs x 2>&1 > /tmp/x",
      "docker logs x 2>&1; reboot",
      "docker logs x 2>&1 && reboot",
      "docker logs x 2>&1 & reboot",
      "docker logs x 2>&1| sh",
      "docker logs x | sed 's/a/b/' 2>&1 >/etc/x",
      "'s/a/b/' ; reboot",
      "docker logs x | sed 's/a'\"$(id)\"'/b/'",
      "docker logs x | sed 's/a/b/'\"'\"';reboot;'\"'\"'",
      "docker logs x | sed __SED__ /etc/shadow",
      "docker logs x | sed -e 's/a/b/' -e 's/c/d/' /etc/shadow",
      "docker logs x | sed 's/.*/cat \\/etc\\/shadow/e'",
      "docker logs x | sed 's/a/b/I' | sed 's/x/y/M'",
      "docker logs x | sed 's/a/b/' ''$'\\n''reboot'",
      "docker logs x | sed $'s/a/b/\\nreboot'",
    ];
    const durch = faelle.filter(f => befehlsklasse(f) === 'lesen');
    expect(durch).toEqual([]);
  });
  it('Windows', () => {
    const faelle = [
      'Get-Service; Restart-Computer', 'Get-Service | Restart-Computer', 'Get-Service -Name x -ComputerName evil',
      'Get-Service -Name sshd | Stop-Service', 'Get-ComputerInfo | Out-File C:/x', 'Get-HotFix | Format-List *|iex',
      'Get-Volume | ForEach-Object Delete', 'Get-Service -Name x*  | Select-Object -ExpandProperty Name',
      'Get-WinEvent -LogName Security -MaxEvents 5', 'Get-CimInstance Win32_Process', 'whoami /all & calc',
      'Get-Service -Name sshd -ErrorAction', 'Get-ScheduledTask | Select-Object Actions', 'Get-Date --% & calc',
      'Get-Service -Name `$x', 'Get-Service #\nRestart-Computer', 'Get-Service\u2028Restart-Computer', 'Get-Service\u0085Restart-Computer',
      'Get-Service | Sort-Object Name -Descending | Invoke-Item', 'Get-Service –Name x; Restart-Computer',
    ];
    const durch = faelle.filter(f => windowsBefehlsklasse(f) === 'lesen');
    expect(durch).toEqual([]);
  });
  it('Windows-Lese-Käfig: Parameter für andere Rechner, Dateien, Benutzer, Filter, Anmeldedaten — auch abgekürzt — und das Sicherheitsprotokoll gesperrt', async () => {
    const { windowsKaefigGrund, windowsKaefigBefehl, WIN_KAEFIG_CMDLETS } = await import('./regeln.js');
    const WIN_KAEFIG_CMDLETS_LISTE = WIN_KAEFIG_CMDLETS as readonly string[];
    const gesperrt = [
      'Get-Service -ComputerName dc01', 'Get-Service -Comp dc01', 'Get-Service -cn dc01', 'Get-Process -IncludeUserName', 'Get-Process -Inc',
      'Get-WinEvent -Path C:\\x.evtx', 'Get-WinEvent -Pa C:\\x.evtx', 'Get-WinEvent -FilterXml x', 'Get-WinEvent -FilterHashtable x', 'Get-WinEvent -LogName Security -MaxEvents 5',
      'Get-WinEvent Security', 'Get-NetTCPConnection -CimSession srv', 'Get-SmbShare -Cim srv', 'Get-HotFix -ComputerName:srv', 'Get-Service –ComputerName srv',
      'Get-Process -Module', 'Get-Process -FileVersionInfo', 'Get-LocalUser | Format-List -Property * -Session x', 'Get-Service -C dc01', 'Get-WinEvent -P C:\\x.evtx',
      // zweite Runde der Sicherheitsprüfung: Aliase mit Unterstrich, Parameter nach „;“, Platzhalter, Abkürzungen erlaubter Namen, Zahlen
      'Get-HotFix -__Server dc01', 'Get-Service;-ComputerName dc01', 'Get-Service -Name x;Get-Service -Cn y', 'Get-WinEvent -LogName *', 'Get-WinEvent Sec*',
      'Get-WinEvent -LogName Sys* -MaxEvents 5', 'Get-WinEvent -LogName System,Security', 'Get-Service -Nam sshd', 'Get-Process -ErrorAction SilentlyContinue',
      'Get-Service -Name x -AsJob', 'Get-NetTCPConnection -ThrottleLimit 1', 'Get-Service \u2012ComputerName x', 'Get-Process | Select-Object -First -1',
    ];
    expect(WIN_KAEFIG_CMDLETS_LISTE).not.toContain('Get-HotFix');
    // vierte Runde: Liste mit Leerzeichen vor dem Komma, Anführungszeichen, weitere Argumente
    for (const b of ['Get-WinEvent -LogName System , Microsoft-Windows-PowerShell/Operational', 'Get-WinEvent System ,Security', "Get-WinEvent -LogName 'System'", 'Get-WinEvent -LogName System -MaxEvents 5 -Oldest', 'Get-WinEvent -LogName System -MaxEvents 5 x']) expect(windowsKaefigGrund(b), b).toBeDefined();
    expect(windowsKaefigGrund('Get-WinEvent -LogName System -MaxEvents 5 | Format-List TimeCreated, Message')).toBeUndefined();
    // dritte Runde: Zeilentrenner als Anweisungstrenner (zweites Get-WinEvent in der nächsten Zeile)
    for (const z of [10, 13, 0x85, 0x2028, 0x2029]) {
      const b = `Get-WinEvent -LogName System -MaxEvents 1${String.fromCharCode(z)}Get-WinEvent -LogName Microsoft-Windows-PowerShell/Operational`;
      expect(windowsKaefigGrund(b), `Zeichen ${z}`).toBeDefined();
    }
    expect(gesperrt.filter(b => !windowsKaefigGrund(b))).toEqual([]);
    for (const b of gesperrt) expect(() => windowsKaefigBefehl(b)).toThrow();
    for (const b of ['Get-Service | Where-Object Status -eq Running | Measure-Object', 'Get-WinEvent -LogName System -MaxEvents 20 | Format-List TimeCreated, Id, Message', 'Get-NetFirewallRule -Enabled True | Select-Object -First 5', 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name, CPU']) expect(windowsKaefigGrund(b), b).toBeUndefined();
  });
});
