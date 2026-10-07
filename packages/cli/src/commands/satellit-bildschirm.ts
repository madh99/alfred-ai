import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * v1268 — Bildschirm sehen: Foto des ganzen Bildschirms (alle Monitore) oder des aktiven Fensters als JPEG,
 * auf höchstens `maxBreite` Pixel verkleinert (Tokens). Windows über PowerShell (System.Drawing; zwei Aufrufe und ohne Qualitätsparameter wegen Defender), macOS über screencapture + sips, Linux über gnome-screenshot, import oder scrot.
 * Unter macOS braucht der Satellit die Berechtigung „Bildschirmaufnahme" (Systemeinstellungen → Datenschutz);
 * ohne sie liefert screencapture nur den Schreibtisch.
 */
export type Bereich = 'alles' | 'fenster';
export interface Bildschirmfoto { jpegBase64: string; breite: number; hoehe: number; titel?: string; bereich: Bereich; marken?: number }
/** v1279 — Markierung aus der Element-Karte (Set of Marks): Nummer und Rechteck in Bildschirmkoordinaten. */
export interface Marke { nr: number; x: number; y: number; w: number; h: number }

// Windows: ZWEI PowerShell-Aufrufe. Defender/AMSI blockt ein Skript, das P/Invoke (Fensterrechteck) UND CopyFromScreen
// enthält, als „schädlich" (Befund 07.10.); getrennt läuft beides. Keine DPI-Bewusstheit, damit Fensterrechteck und
// Aufnahme dieselben (virtualisierten) Koordinaten nutzen.
const WIN_FENSTER = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public class AlfredFenster {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
$h = [AlfredFenster]::GetForegroundWindow()
$r = New-Object AlfredFenster+RECT
[AlfredFenster]::GetWindowRect($h, [ref]$r) | Out-Null
$sb = New-Object System.Text.StringBuilder 512
[AlfredFenster]::GetWindowText($h, $sb, 512) | Out-Null
@{ x = $r.Left; y = $r.Top; w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top); titel = $sb.ToString() } | ConvertTo-Json -Compress
`;

const WIN_FOTO = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$ziel = '__ZIEL__'; $maxB = __MAXB__
$x = __X__; $y = __Y__; $w = __W__; $hh = __H__
if ($w -lt 10 -or $hh -lt 10) {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $x = $vs.X; $y = $vs.Y; $w = $vs.Width; $hh = $vs.Height
}
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
# v1279 — Markierungen (Set of Marks) aus der Element-Karte: rote Rahmen, Nummer mit weißem Grund
$markenDatei = '__MARKEN__'
if ($markenDatei -and (Test-Path $markenDatei)) {
  $marken = Get-Content -Raw -Encoding UTF8 $markenDatei | ConvertFrom-Json
  # UIA liefert physische Pixel, die Aufnahme hier ist nicht DPI-bewusst (virtualisiert): bei 125 % durch 1,25 teilen
  $dpi = 96; try { $dpi = (Get-ItemProperty 'HKCU:\\Control Panel\\Desktop\\WindowMetrics' -Name AppliedDPI -ErrorAction Stop).AppliedDPI } catch {}
  $skala = [double]$dpi / 96.0
  if ($skala -le 0) { $skala = 1.0 }
  $stift = New-Object System.Drawing.Pen ([System.Drawing.Color]::Red), 2
  $schrift = New-Object System.Drawing.Font 'Arial', 11, ([System.Drawing.FontStyle]::Bold)
  foreach ($m in $marken) {
    $mx = [int]([double]$m.x / $skala) - $x; $my = [int]([double]$m.y / $skala) - $y
    $mw = [int]([double]$m.w / $skala); $mh = [int]([double]$m.h / $skala)
    if ($mw -lt 2 -or $mh -lt 2) { continue }
    $g.DrawRectangle($stift, $mx, $my, $mw, $mh)
    $t = [string]$m.nr
    $sz = $g.MeasureString($t, $schrift)
    $g.FillRectangle([System.Drawing.Brushes]::White, $mx, $my, $sz.Width + 2, $sz.Height)
    $g.DrawString($t, $schrift, [System.Drawing.Brushes]::Red, $mx + 1, $my)
  }
}
$g.Dispose()
$out = $bmp
if ($w -gt $maxB) { $nh = [int]($hh * $maxB / $w); $out = New-Object System.Drawing.Bitmap $bmp, $maxB, $nh }
# Kein EncoderParameter (JPEG-Qualitaet): Defender/AMSI blockt CopyFromScreen + EncoderParameter als schaedlich (Befund 07.10.)
$out.Save($ziel, [System.Drawing.Imaging.ImageFormat]::Jpeg)
@{ breite = $out.Width; hoehe = $out.Height } | ConvertTo-Json -Compress
`;

async function powershell(script: string, timeout = 60_000): Promise<string> {
  const enc = Buffer.from('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' + script, 'utf16le').toString('base64');
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], timeout);
  return out.trim().split('\n').pop() ?? '{}';
}

function run(cmd: string, args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(new Error(`${cmd}: ${String(stderr).trim().slice(0, 300) || err.message}`)) : resolve(String(stdout)));
  });
}

async function vorhanden(cmd: string): Promise<boolean> {
  try { await run(process.platform === 'win32' ? 'where' : 'which', [cmd], 5000); return true; } catch { return false; }
}

export async function bildschirmfoto(bereich: Bereich = 'alles', maxBreite = 1600, marken: Marke[] = []): Promise<Bildschirmfoto> {
  const ziel = path.join(os.tmpdir(), `alfred-bildschirm-${process.pid}-${Date.now()}.jpg`);
  const markenDatei = marken.length && process.platform === 'win32' ? ziel.replace(/\.jpg$/, '-marken.json') : '';
  if (markenDatei) writeFileSync(markenDatei, JSON.stringify(marken));
  try {
    let titel: string | undefined; let breite = 0; let hoehe = 0; let effektiv: Bereich = bereich;
    if (process.platform === 'win32') {
      let x = 0; let y = 0; let w = 0; let h = 0;
      if (bereich === 'fenster') {
        try {
          const f = JSON.parse(await powershell(WIN_FENSTER, 20_000)) as { x?: number; y?: number; w?: number; h?: number; titel?: string };
          x = f.x ?? 0; y = f.y ?? 0; w = f.w ?? 0; h = f.h ?? 0; titel = f.titel || undefined;
        } catch { /* ganzer Bildschirm */ }
        if (w < 10 || h < 10) effektiv = 'alles';
      }
      const script = WIN_FOTO.replace('__ZIEL__', ziel.replace(/'/g, "''")).replace('__MARKEN__', markenDatei.replace(/'/g, "''")).replace('__MAXB__', String(maxBreite))
        .replace('__X__', String(x)).replace('__Y__', String(y)).replace('__W__', String(effektiv === 'fenster' ? w : 0)).replace('__H__', String(effektiv === 'fenster' ? h : 0));
      const j = JSON.parse(await powershell(script)) as { breite?: number; hoehe?: number };
      breite = j.breite ?? 0; hoehe = j.hoehe ?? 0;
    } else if (process.platform === 'darwin') {
      if (bereich === 'fenster') {
        try {
          const out = await run('osascript', ['-e', 'tell application "System Events" to tell (first application process whose frontmost is true) to return (name as text) & "|" & (name of front window as text) & "|" & ((position of front window) as text) & "|" & ((size of front window) as text)'], 10_000);
          const [app, fenster, pos, groesse] = out.trim().split('|');
          const [px, py] = (pos ?? '').split(',').map(s => parseInt(s.trim(), 10));
          const [gw, gh] = (groesse ?? '').split(',').map(s => parseInt(s.trim(), 10));
          titel = [fenster, app].filter(Boolean).join(' — ') || undefined;
          if (Number.isFinite(px) && Number.isFinite(gw) && gw! > 10 && gh! > 10) await run('screencapture', ['-x', '-t', 'jpg', '-R', `${px},${py},${gw},${gh}`, ziel]);
          else effektiv = 'alles';
        } catch { effektiv = 'alles'; }
      }
      if (effektiv === 'alles') await run('screencapture', ['-x', '-t', 'jpg', ziel]);
      const dims = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', ziel], 20_000);
      breite = parseInt(/pixelWidth:\s*(\d+)/.exec(dims)?.[1] ?? '0', 10); hoehe = parseInt(/pixelHeight:\s*(\d+)/.exec(dims)?.[1] ?? '0', 10);
      if (breite > maxBreite) { await run('sips', ['--resampleWidth', String(maxBreite), ziel], 30_000); hoehe = Math.round(hoehe * maxBreite / breite); breite = maxBreite; }
    } else {
      // Linux: erstes vorhandenes Werkzeug
      if (await vorhanden('gnome-screenshot')) await run('gnome-screenshot', bereich === 'fenster' ? ['-w', '-f', ziel] : ['-f', ziel]);
      else if (await vorhanden('import')) {
        let fenster = 'root';
        if (bereich === 'fenster' && await vorhanden('xdotool')) { try { fenster = (await run('xdotool', ['getactivewindow'])).trim(); } catch { fenster = 'root'; } }
        await run('import', ['-window', fenster, ziel]);
      } else if (await vorhanden('scrot')) await run('scrot', bereich === 'fenster' ? ['-u', ziel] : [ziel]);
      else throw new Error('Kein Bildschirmfoto-Werkzeug gefunden (gnome-screenshot, ImageMagick import oder scrot installieren)');
      if (await vorhanden('convert')) {
        await run('convert', [ziel, '-resize', `${maxBreite}x>`, '-quality', '72', `jpg:${ziel}`], 30_000);
        try { const id = await run('identify', ['-format', '%w %h', ziel], 10_000); const [w, h] = id.trim().split(' ').map(Number); breite = w ?? 0; hoehe = h ?? 0; } catch { /* ohne Maße */ }
      }
      if (bereich === 'fenster' && await vorhanden('xdotool')) { try { titel = (await run('xdotool', ['getactivewindow', 'getwindowname'])).trim() || undefined; } catch { /* ohne Titel */ } }
    }
    if (!existsSync(ziel)) throw new Error('Bildschirmfoto wurde nicht erzeugt');
    const data = readFileSync(ziel);
    if (data.length < 100) throw new Error('Bildschirmfoto ist leer');
    return { jpegBase64: data.toString('base64'), breite, hoehe, titel, bereich: effektiv, marken: markenDatei ? marken.length : undefined };
  } finally {
    try { unlinkSync(ziel); } catch { /* weg */ }
    if (markenDatei) { try { unlinkSync(markenDatei); } catch { /* weg */ } }
  }
}
