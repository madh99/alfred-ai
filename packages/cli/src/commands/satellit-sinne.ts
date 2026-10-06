import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * v1237 — Die Sinne des Satelliten: Leerlauf (Sekunden seit letzter Eingabe), aktives Fenster, Akku.
 * Jede Minute an das Gehirn (Nachricht `sinne`), dort Weltmodell-Quelle „Geräte" und Anwesenheitssignal.
 *
 * Windows: ein dauerhafter PowerShell-Kindprozess (P/Invoke GetLastInputInfo / GetForegroundWindow,
 * Win32_Battery) — einmal kompiliert statt jede Minute neu. macOS: ioreg, osascript, pmset.
 * Linux: xprintidle, xdotool, /sys/class/power_supply. Fehlende Werkzeuge → Wert fehlt, kein Fehler.
 */
export interface Sinne { leerlaufSek?: number; fenster?: string; akkuProzent?: number; akkuLaedt?: boolean }

const PS_SKRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public class AlfredSinne {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  public static uint Idle() { LASTINPUTINFO l = new LASTINPUTINFO(); l.cbSize = (uint)Marshal.SizeOf(l); if (!GetLastInputInfo(ref l)) return 0; return ((uint)Environment.TickCount - l.dwTime) / 1000; }
  public static string Fenster() { StringBuilder sb = new StringBuilder(256); GetWindowText(GetForegroundWindow(), sb, 256); return sb.ToString(); }
}
"@
while ($true) {
  $l = [Console]::In.ReadLine()
  if ($null -eq $l) { break }
  $o = @{ leerlaufSek = [int][AlfredSinne]::Idle() }
  if ($l -ne 'ohneFenster') { $o.fenster = [AlfredSinne]::Fenster() }
  try { $b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1; if ($b) { $o.akkuProzent = [int]$b.EstimatedChargeRemaining; $o.akkuLaedt = ($b.BatteryStatus -eq 2) } } catch {}
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
`;

function lauf(cmd: string, args: string[], timeout = 4000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf8', windowsHide: true }, (err, out) => resolve(err ? '' : String(out).trim()));
  });
}

export class SinneErfasser {
  private ps?: ChildProcess;
  private warteschlange: Array<(z: string) => void> = [];
  private rest = '';

  constructor(private readonly opts: { ohneFenster?: boolean } = {}) {}

  async erfasse(): Promise<Sinne> {
    try {
      if (process.platform === 'win32') return await this.windows();
      if (process.platform === 'darwin') return await this.macos();
      return await this.linux();
    } catch { return {}; }
  }

  stop(): void { try { this.ps?.stdin?.end(); this.ps?.kill(); } catch { /* */ } this.ps = undefined; }

  private async windows(): Promise<Sinne> {
    if (!this.ps || this.ps.exitCode !== null) {
      const enc = Buffer.from(PS_SKRIPT, 'utf16le').toString('base64');
      this.ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      this.ps.stdout?.setEncoding('utf8');
      this.ps.stdout?.on('data', (d: string) => {
        this.rest += d;
        let i: number;
        while ((i = this.rest.indexOf('\n')) >= 0) {
          const zeile = this.rest.slice(0, i).trim(); this.rest = this.rest.slice(i + 1);
          const w = this.warteschlange.shift(); if (w && zeile) w(zeile);
        }
      });
      this.ps.on('exit', () => { this.ps = undefined; for (const w of this.warteschlange.splice(0)) w(''); });
    }
    const antwort = await new Promise<string>((resolve) => {
      const t = setTimeout(() => { const i = this.warteschlange.indexOf(fertig); if (i >= 0) this.warteschlange.splice(i, 1); resolve(''); }, 8000);
      const fertig = (z: string) => { clearTimeout(t); resolve(z); };
      this.warteschlange.push(fertig);
      this.ps?.stdin?.write((this.opts.ohneFenster ? 'ohneFenster' : 'x') + '\n');
    });
    if (!antwort) return {};
    const j = JSON.parse(antwort) as Sinne;
    return { leerlaufSek: j.leerlaufSek, fenster: this.opts.ohneFenster ? undefined : (j.fenster || undefined), akkuProzent: j.akkuProzent, akkuLaedt: j.akkuLaedt };
  }

  private async macos(): Promise<Sinne> {
    const s: Sinne = {};
    const idle = await lauf('/bin/sh', ['-c', "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'"]);
    if (idle) s.leerlaufSek = parseInt(idle, 10);
    if (!this.opts.ohneFenster) {
      const f = await lauf('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true']);
      if (f) s.fenster = f;
    }
    const b = await lauf('pmset', ['-g', 'batt']);
    const m = /(\d+)%;\s*(\w[\w ]*)/.exec(b);
    if (m) { s.akkuProzent = parseInt(m[1], 10); s.akkuLaedt = /charging|charged|AC/i.test(m[2]) && !/discharging/i.test(m[2]); }
    return s;
  }

  private async linux(): Promise<Sinne> {
    const s: Sinne = {};
    const idle = await lauf('xprintidle', []);
    if (idle) s.leerlaufSek = Math.round(parseInt(idle, 10) / 1000);
    if (!this.opts.ohneFenster) {
      const f = await lauf('xdotool', ['getactivewindow', 'getwindowname']);
      if (f) s.fenster = f;
    }
    try {
      const cap = readFileSync('/sys/class/power_supply/BAT0/capacity', 'utf8').trim();
      const status = readFileSync('/sys/class/power_supply/BAT0/status', 'utf8').trim();
      if (cap) { s.akkuProzent = parseInt(cap, 10); s.akkuLaedt = /charging|full/i.test(status); }
    } catch { /* kein Akku */ }
    return s;
  }
}
