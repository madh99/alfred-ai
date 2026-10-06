import os from 'node:os';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statfsSync } from 'node:fs';

/**
 * v1237/v1239 — Die Sinne des Satelliten.
 *
 * Jede Minute: Leerlauf (Sekunden seit letzter Eingabe), aktives Fenster, Akku.
 * Alle fünf Minuten zusätzlich das System: Laufzeit seit Start, RAM, CPU, GPU, Laufwerke
 * (Owner-Wunsch 06.10.: „sollte er nicht auch uptime, boottime, speicher, disk, cpu, gpu kennen").
 * Die Systemwerte bleiben zwischen den Messungen erhalten, damit das Gehirn immer das volle Bild hat.
 *
 * Windows: ein dauerhafter PowerShell-Kindprozess (P/Invoke GetLastInputInfo / GetForegroundWindow,
 * Win32_Battery, Win32_LogicalDisk, Win32_Processor, GPU-Leistungszähler) — einmal kompiliert statt jede
 * Minute neu. macOS: ioreg, osascript, pmset. Linux: xprintidle, xdotool, sysfs, nvidia-smi.
 * Plattformunabhängig aus Node: Laufzeit, RAM, CPU-Last (Delta der Kernzeiten), Laufwerke (statfs).
 * Fehlende Werkzeuge → Wert fehlt, kein Fehler.
 */
export interface Sinne {
  leerlaufSek?: number; fenster?: string; akkuProzent?: number; akkuLaedt?: boolean;
  uptimeSek?: number; ramGesamtMb?: number; ramFreiMb?: number; cpuProzent?: number; gpuProzent?: number;
  laufwerke?: Array<{ name: string; gesamtGb: number; freiGb: number }>;
}

export const SYSTEM_JEDE_N_MESSUNG = 5;

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
  if ($l -notmatch 'ohneFenster') { $o.fenster = [AlfredSinne]::Fenster() }
  try { $b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1; if ($b) { $o.akkuProzent = [int]$b.EstimatedChargeRemaining; $o.akkuLaedt = ($b.BatteryStatus -eq 2) } } catch {}
  if ($l -match 'system') {
    try { $o.laufwerke = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue | ForEach-Object { @{ name = $_.DeviceID; gesamtGb = [math]::Round($_.Size / 1GB, 1); freiGb = [math]::Round($_.FreeSpace / 1GB, 1) } }) } catch {}
    try { $c = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Measure-Object -Property LoadPercentage -Average; if ($c.Average -ne $null) { $o.cpuProzent = [int]$c.Average } } catch {}
    try { $g = (Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples | Measure-Object -Property CookedValue -Sum; if ($g.Sum -ne $null) { $o.gpuProzent = [int][math]::Min(100, $g.Sum) } } catch {}
  }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 3))
  [Console]::Out.Flush()
}
`;

function lauf(cmd: string, args: string[], timeout = 4000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf8', windowsHide: true }, (err, out) => resolve(err ? '' : String(out).trim()));
  });
}

function gb(bytes: number): number { return Math.round(bytes / 1024 ** 3 * 10) / 10; }

export class SinneErfasser {
  private ps?: ChildProcess;
  private warteschlange: Array<(z: string) => void> = [];
  private rest = '';
  private messung = 0;
  private system: Partial<Sinne> = {};
  private cpuVorher?: { idle: number; total: number };

  constructor(private readonly opts: { ohneFenster?: boolean } = {}) {}

  async erfasse(): Promise<Sinne> {
    const voll = this.messung % SYSTEM_JEDE_N_MESSUNG === 0;
    this.messung += 1;
    let s: Sinne = {};
    try {
      if (process.platform === 'win32') s = await this.windows(voll);
      else if (process.platform === 'darwin') s = await this.macos();
      else s = await this.linux();
    } catch { s = {}; }
    if (voll) {
      try { this.system = { ...this.system, ...this.systemAusNode(), ...(s.laufwerke ? { laufwerke: s.laufwerke } : {}), ...(s.cpuProzent !== undefined ? { cpuProzent: s.cpuProzent } : {}), ...(s.gpuProzent !== undefined ? { gpuProzent: s.gpuProzent } : {}) }; } catch { /* Systemwerte optional */ }
      if (process.platform === 'linux' && this.system.gpuProzent === undefined) {
        const g = await lauf('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits']);
        if (g) this.system.gpuProzent = parseInt(g, 10);
      }
    } else {
      // Laufzeit zwischen den Systemmessungen mitzählen, RAM ist billig
      if (this.system.uptimeSek !== undefined) { this.system.uptimeSek = Math.round(os.uptime()); this.system.ramFreiMb = Math.round(os.freemem() / 1048576); }
    }
    return { ...this.system, ...s, laufwerke: s.laufwerke ?? this.system.laufwerke, cpuProzent: s.cpuProzent ?? this.system.cpuProzent, gpuProzent: s.gpuProzent ?? this.system.gpuProzent };
  }

  stop(): void { try { this.ps?.stdin?.end(); this.ps?.kill(); } catch { /* */ } this.ps = undefined; }

  /** Laufzeit, RAM, CPU-Last (Delta), Laufwerke — aus Node, auf jeder Plattform. */
  private systemAusNode(): Partial<Sinne> {
    const r: Partial<Sinne> = { uptimeSek: Math.round(os.uptime()), ramGesamtMb: Math.round(os.totalmem() / 1048576), ramFreiMb: Math.round(os.freemem() / 1048576) };
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const c of cpus) { idle += c.times.idle; total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle; }
    if (this.cpuVorher && total > this.cpuVorher.total) r.cpuProzent = Math.round(100 * (1 - (idle - this.cpuVorher.idle) / (total - this.cpuVorher.total)));
    this.cpuVorher = { idle, total };
    if (process.platform !== 'win32') {
      const pfade = ['/', '/home'].filter(p => existsSync(p));
      const laufwerke: Sinne['laufwerke'] = [];
      for (const p of pfade) { try { const st = statfsSync(p); laufwerke.push({ name: p, gesamtGb: gb(st.blocks * st.bsize), freiGb: gb(st.bavail * st.bsize) }); } catch { /* */ } }
      if (laufwerke.length) r.laufwerke = laufwerke;
    }
    return r;
  }

  private async windows(voll: boolean): Promise<Sinne> {
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
      const t = setTimeout(() => { const i = this.warteschlange.indexOf(fertig); if (i >= 0) this.warteschlange.splice(i, 1); resolve(''); }, voll ? 15000 : 8000);
      const fertig = (z: string) => { clearTimeout(t); resolve(z); };
      this.warteschlange.push(fertig);
      this.ps?.stdin?.write(`${this.opts.ohneFenster ? 'ohneFenster' : 'x'}${voll ? ' system' : ''}\n`);
    });
    if (!antwort) return {};
    const j = JSON.parse(antwort) as Sinne & { laufwerke?: Array<{ name: string; gesamtGb: number; freiGb: number }> | { name: string; gesamtGb: number; freiGb: number } };
    const laufwerke = Array.isArray(j.laufwerke) ? j.laufwerke : j.laufwerke ? [j.laufwerke] : undefined;
    return { leerlaufSek: j.leerlaufSek, fenster: this.opts.ohneFenster ? undefined : (j.fenster || undefined), akkuProzent: j.akkuProzent, akkuLaedt: j.akkuLaedt, cpuProzent: j.cpuProzent, gpuProzent: j.gpuProzent, laufwerke };
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
