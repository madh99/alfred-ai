import { describe, it, expect } from 'vitest';
import { ausKodiertemBefehl, skriptDatei, SKRIPT_NAME, SELBST_LOESCHEN } from './windows-skriptdatei.js';

describe('v1823 Windows-Bausteine als Skriptdatei', () => {
  const skript = "$ErrorActionPreference = 'Stop'\nWrite-Output 'Größe ü'";
  const kodiert = `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(skript, 'utf16le').toString('base64')}`;

  it('liest den Skripttext aus dem bisherigen Befehl, sonst null', () => {
    expect(ausKodiertemBefehl(kodiert)).toBe(skript);
    expect(ausKodiertemBefehl('Get-Service')).toBeNull();
    expect(ausKodiertemBefehl(`${kodiert}; whoami`)).toBeNull();
  });

  it('Datei: zufälliger Name in Windows\\Temp, BOM, löscht sich zuerst selbst, Aufruf ohne Richtlinien-Umgehung und ohne Base64', () => {
    const d = skriptDatei(skript, '0123456789abcdef');
    expect(d.name).toMatch(SKRIPT_NAME);
    expect(d.pfadWindows).toBe('C:\\Windows\\Temp\\alfred-s-0123456789abcdef.ps1');
    expect(d.pfadSftp).toBe('/C:/Windows/Temp/alfred-s-0123456789abcdef.ps1');
    expect(d.inhalt.startsWith(`\uFEFF${SELBST_LOESCHEN}\n`)).toBe(true);
    expect(d.inhalt).toContain(skript);
    expect(d.befehl).toBe('powershell -NoProfile -NonInteractive -File C:\\Windows\\Temp\\alfred-s-0123456789abcdef.ps1');
    expect(d.befehl).not.toMatch(/EncodedCommand|ExecutionPolicy|Bypass/);
    expect(() => skriptDatei(skript, 'xyz')).toThrow();
  });
});
