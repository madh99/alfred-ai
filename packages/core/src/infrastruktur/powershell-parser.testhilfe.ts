/**
 * Testhilfe (nur für *.test.ts): PowerShell-5.1-Parserprüfung von Baustein-Skripten.
 *
 * Skripte gehen als Datei an den Parser, nicht inline per -EncodedCommand: lange Bausteine (z. B. dienstkontoSkript mit Anmeldesperre)
 * sprengen die Windows-Befehlszeile (32 767 Zeichen), spawnSync liefert dann keine Ausgabe (Realfall I8e Etappe 3, Fix-Runden 2 und 4).
 * Der Windows-Transport legt Bausteine ebenso als Datei ab (fernzugriff/windows-skriptdatei.ts). Ein absichtlich fehlerhaftes Skript
 * läuft immer mit (Gegenprobe), damit ein stumm „grüner“ Parser auffällt.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GEGENPROBE = '__gegenprobe__';

/** Windows PowerShell vorhanden (sonst die Parser-Tests überspringen) */
export function powershellVorhanden(): boolean {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
  return r.status === 0 && /^\d+/.test(String(r.stdout ?? '').trim());
}

export interface ParserErgebnis {
  /** je Skriptname „OK“ oder die Parsermeldungen */
  ergebnisse: Record<string, string>;
  /** das fehlerhafte Gegenprobe-Skript wurde als fehlerhaft erkannt */
  gegenprobeErkannt: boolean;
  /** Rohausgabe für Fehlermeldungen */
  roh: string;
}

/** Parst alle Skripte in einem PowerShell-Aufruf (Namen: Buchstaben, Ziffern, _ und -) */
export function parseSkripte(skripte: Record<string, string>): ParserErgebnis {
  const dir = mkdtempSync(join(tmpdir(), 'alfred-ps-'));
  try {
    for (const [name, s] of Object.entries(skripte)) {
      if (!/^[A-Za-z0-9_-]+$/.test(name) || name === GEGENPROBE) throw new Error(`Skriptname ${name}: nur Buchstaben, Ziffern, _ und -`);
      writeFileSync(join(dir, `${name}.ps1`), s, 'utf8');
    }
    writeFileSync(join(dir, `${GEGENPROBE}.ps1`), "if ($a) { 'x' ", 'utf8');
    const prog = [
      `foreach ($d in @(Get-ChildItem -LiteralPath '${dir.replace(/'/g, "''")}' -Filter '*.ps1')) {`,
      '  $t = [IO.File]::ReadAllText($d.FullName, [Text.Encoding]::UTF8); $f = $null',
      '  [void][System.Management.Automation.Language.Parser]::ParseInput($t, [ref]$null, [ref]$f)',
      "  if ($f.Count) { $d.BaseName + \"`t\" + (@($f | ForEach-Object { $_.Message }) -join ' | ') } else { $d.BaseName + \"`tOK\" }",
      '}',
    ].join('\n');
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(prog, 'utf16le').toString('base64')], { encoding: 'utf8' });
    const roh = `${String(r.stdout ?? '')}${r.stderr ? `\n${r.stderr}` : ''}${r.error ? `\n${String(r.error)}` : ''}`;
    const alle: Record<string, string> = {};
    for (const z of String(r.stdout ?? '').split(/\r?\n/)) { const i = z.indexOf('\t'); if (i > 0) alle[z.slice(0, i)] = z.slice(i + 1).trim(); }
    const ergebnisse: Record<string, string> = {};
    for (const name of Object.keys(skripte)) ergebnisse[name] = alle[name] ?? `kein Ergebnis (${roh.trim().slice(0, 300) || 'keine Ausgabe'})`;
    return { ergebnisse, gegenprobeErkannt: alle[GEGENPROBE] !== undefined && alle[GEGENPROBE] !== 'OK', roh };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
