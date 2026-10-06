import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * v1241 — Ohr und Stimme der Sitzung (Geräte-Architektur Phase 2, Sprache in der Sitzung).
 *
 * Aufnehmen (Push-to-Talk) und Abspielen ohne native Node-Module:
 * - Windows: dauerhafter PowerShell-Kindprozess mit MCI (winmm.dll): waveaudio aufnehmen (16 kHz, mono, 16 bit),
 *   mp3/wav abspielen. Ein Prozess, damit die Aufnahme zwischen Start und Stopp lebt.
 * - macOS: Aufnahme über sox (`rec`) oder ffmpeg (avfoundation), Wiedergabe über afplay.
 * - Linux: Aufnahme über arecord, Wiedergabe über aplay / mpg123 / ffplay / paplay.
 * Fehlt ein Werkzeug, sagt die Sitzung das klar, statt still zu scheitern.
 */
export interface Aufnahme { stop(): Promise<{ data: Buffer; mimeType: string }> }

const PS_ZEILEN = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -TypeDefinition @"',
  'using System; using System.Runtime.InteropServices; using System.Text;',
  'public class AlfredMci {',
  '  [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern int mciSendString(string cmd, StringBuilder ret, int retLen, IntPtr hwnd);',
  '  public static string Send(string cmd) { StringBuilder sb = new StringBuilder(256); int r = mciSendString(cmd, sb, 256, IntPtr.Zero); return r == 0 ? "ok " + sb.ToString() : "err " + r; }',
  '}',
  '"@',
  'while ($true) {',
  '  $l = [Console]::In.ReadLine()',
  '  if ($null -eq $l) { break }',
  "  $t = $l.Split(' ', 2); $cmd = $t[0]; $arg = ''; if ($t.Length -gt 1) { $arg = $t[1] }",
  '  $r = "err unbekannt"',
  "  if ($cmd -eq 'recstart') {",
  "    [AlfredMci]::Send('close rec') | Out-Null",
  "    $r = [AlfredMci]::Send('open new type waveaudio alias rec')",
  "    if ($r -like 'ok*') { [AlfredMci]::Send('set rec time format ms bitspersample 16 channels 1 samplespersec 16000 bytespersec 32000 alignment 2') | Out-Null; $r = [AlfredMci]::Send('record rec') }",
  "  } elseif ($cmd -eq 'recstop') {",
  "    [AlfredMci]::Send('stop rec') | Out-Null",
  "    $r = [AlfredMci]::Send('save rec \"' + $arg + '\"')",
  "    [AlfredMci]::Send('close rec') | Out-Null",
  "  } elseif ($cmd -eq 'play') {",
  "    [AlfredMci]::Send('close p') | Out-Null",
  "    $typ = 'mpegvideo'; if ($arg -match '\\.wav$') { $typ = 'waveaudio' }",
  "    $r = [AlfredMci]::Send('open \"' + $arg + '\" type ' + $typ + ' alias p')",
  "    if ($r -like 'ok*') { $r = [AlfredMci]::Send('play p wait'); [AlfredMci]::Send('close p') | Out-Null }",
  '  }',
  '  [Console]::Out.WriteLine($r)',
  '  [Console]::Out.Flush()',
  '}',
];

function vorhanden(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [cmd], { timeout: 3000, windowsHide: true }, (err) => resolve(!err));
  });
}

export class Audio {
  private ps?: ChildProcess;
  private warteschlange: Array<(z: string) => void> = [];
  private rest = '';
  readonly ordner = path.join(os.homedir(), '.alfred', 'sitzung');

  stop(): void { try { this.ps?.stdin?.end(); this.ps?.kill(); } catch { /* */ } this.ps = undefined; }

  /** Startet die Aufnahme; `stop()` liefert WAV. */
  async aufnehmen(): Promise<Aufnahme> {
    mkdirSync(this.ordner, { recursive: true });
    const datei = path.join(this.ordner, `aufnahme-${Date.now()}.wav`);
    if (process.platform === 'win32') {
      const r = await this.mci(`recstart`);
      if (!r.startsWith('ok')) throw new Error(`Aufnahme nicht möglich (MCI ${r}) — ist ein Mikrofon angeschlossen?`);
      return { stop: async () => { const s = await this.mci(`recstop ${datei}`); if (!s.startsWith('ok') || !existsSync(datei)) throw new Error(`Aufnahme nicht gespeichert (MCI ${s})`); const data = readFileSync(datei); try { unlinkSync(datei); } catch { /* */ } return { data, mimeType: 'audio/wav' }; } };
    }
    let cmd: [string, string[]] | undefined;
    if (process.platform === 'darwin') {
      if (await vorhanden('rec')) cmd = ['rec', ['-q', '-r', '16000', '-c', '1', '-b', '16', datei]];
      else if (await vorhanden('ffmpeg')) cmd = ['ffmpeg', ['-loglevel', 'quiet', '-f', 'avfoundation', '-i', ':0', '-ar', '16000', '-ac', '1', '-y', datei]];
    } else {
      if (await vorhanden('arecord')) cmd = ['arecord', ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', datei]];
      else if (await vorhanden('ffmpeg')) cmd = ['ffmpeg', ['-loglevel', 'quiet', '-f', 'pulse', '-i', 'default', '-ar', '16000', '-ac', '1', '-y', datei]];
    }
    if (!cmd) throw new Error(process.platform === 'darwin' ? 'Kein Aufnahmewerkzeug: bitte sox (brew install sox) oder ffmpeg installieren.' : 'Kein Aufnahmewerkzeug: bitte alsa-utils (arecord) oder ffmpeg installieren.');
    const kind = spawn(cmd[0], cmd[1], { stdio: ['pipe', 'ignore', 'ignore'] });
    return {
      stop: () => new Promise((resolve, reject) => {
        kind.on('exit', () => {
          try { const data = readFileSync(datei); try { unlinkSync(datei); } catch { /* */ } resolve({ data, mimeType: 'audio/wav' }); }
          catch (err) { reject(new Error(`Aufnahme nicht gespeichert: ${(err as Error).message}`)); }
        });
        if (cmd![0] === 'ffmpeg') { try { kind.stdin?.write('q'); } catch { /* */ } }
        try { kind.kill('SIGINT'); } catch { /* */ }
      }),
    };
  }

  /** Spielt mp3/wav ab und wartet, bis es fertig ist. */
  async abspielen(data: Buffer, mimeType: string): Promise<void> {
    mkdirSync(this.ordner, { recursive: true });
    const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('ogg') || mimeType.includes('opus') ? 'ogg' : 'mp3';
    const datei = path.join(this.ordner, `antwort-${Date.now()}.${ext}`);
    writeFileSync(datei, data);
    try {
      if (process.platform === 'win32') {
        if (ext === 'ogg') { await new Promise<void>((resolve) => { execFile('cmd', ['/c', 'start', '', datei], { windowsHide: true }, () => resolve()); }); return; }
        const r = await this.mci(`play ${datei}`, 10 * 60_000);
        if (!r.startsWith('ok')) throw new Error(`Wiedergabe fehlgeschlagen (MCI ${r})`);
        return;
      }
      const kandidaten: Array<[string, string[]]> = process.platform === 'darwin'
        ? [['afplay', [datei]]]
        : ext === 'wav' ? [['aplay', ['-q', datei]], ['paplay', [datei]], ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', datei]]]
          : [['mpg123', ['-q', datei]], ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', datei]], ['paplay', [datei]]];
      for (const [c, a] of kandidaten) {
        if (!(await vorhanden(c))) continue;
        await new Promise<void>((resolve, reject) => { execFile(c, a, { timeout: 10 * 60_000 }, (err) => err ? reject(err) : resolve()); });
        return;
      }
      throw new Error('Kein Abspielwerkzeug gefunden (afplay / mpg123 / ffplay / aplay).');
    } finally {
      try { unlinkSync(datei); } catch { /* */ }
    }
  }

  private async mci(befehl: string, timeoutMs = 15_000): Promise<string> {
    if (!this.ps || this.ps.exitCode !== null) {
      const enc = Buffer.from(PS_ZEILEN.join('\n'), 'utf16le').toString('base64');
      this.ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      this.ps.stdout?.setEncoding('utf8');
      this.ps.stdout?.on('data', (d: string) => {
        this.rest += d;
        let i: number;
        while ((i = this.rest.indexOf('\n')) >= 0) {
          const zeile = this.rest.slice(0, i).trim(); this.rest = this.rest.slice(i + 1);
          const w = this.warteschlange.shift(); if (w) w(zeile);
        }
      });
      this.ps.on('exit', () => { this.ps = undefined; for (const w of this.warteschlange.splice(0)) w('err beendet'); });
    }
    return new Promise<string>((resolve) => {
      const t = setTimeout(() => { const i = this.warteschlange.indexOf(fertig); if (i >= 0) this.warteschlange.splice(i, 1); resolve('err Zeitüberschreitung'); }, timeoutMs);
      const fertig = (z: string) => { clearTimeout(t); resolve(z); };
      this.warteschlange.push(fertig);
      this.ps?.stdin?.write(befehl + '\n');
    });
  }
}
