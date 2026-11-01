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
    const { windowsKaefigGrund, windowsKaefigBefehl } = await import('./regeln.js');
    const gesperrt = [
      'Get-Service -ComputerName dc01', 'Get-Service -Comp dc01', 'Get-Service -cn dc01', 'Get-Process -IncludeUserName', 'Get-Process -Inc',
      'Get-WinEvent -Path C:\\x.evtx', 'Get-WinEvent -Pa C:\\x.evtx', 'Get-WinEvent -FilterXml x', 'Get-WinEvent -FilterHashtable x', 'Get-WinEvent -LogName Security -MaxEvents 5',
      'Get-WinEvent Security', 'Get-NetTCPConnection -CimSession srv', 'Get-SmbShare -Cim srv', 'Get-HotFix -ComputerName:srv', 'Get-Service –ComputerName srv',
      'Get-Process -Module', 'Get-Process -FileVersionInfo', 'Get-LocalUser | Format-List -Property * -Session x', 'Get-Service -C dc01', 'Get-WinEvent -P C:\\x.evtx',
    ];
    expect(gesperrt.filter(b => !windowsKaefigGrund(b))).toEqual([]);
    for (const b of gesperrt) expect(() => windowsKaefigBefehl(b)).toThrow();
    for (const b of ['Get-Service | Where-Object Status -eq Running | Measure-Object', 'Get-WinEvent -LogName System -MaxEvents 20 | Format-List TimeCreated, Id, Message', 'Get-NetFirewallRule -Enabled True | Select-Object -First 5', 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name, CPU']) expect(windowsKaefigGrund(b), b).toBeUndefined();
  });
});
