import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { macFensterLesen, macAktion, macTasteSenden, macLeerlaufMs, macKlickenBei } from './satellit-bedienen-mac.js'; // v1283
import { LINUX_ZIELE, linuxAktion, linuxTasteSenden, linuxLeerlaufMs, linuxKlickenBei } from './satellit-bedienen-linux.js'; // v1339

/**
 * v1276 — Bedienen, Stufe A (Spec §18, Owner-Freigabe 07.10. „ausarbeiten und umsetzen"):
 * Element-Karte über Windows UI Automation (Name, Typ, Wert, Rechteck, Nummer), Klicken über die Muster
 * Invoke/Toggle/Select/Expand/DefaultAction, Tippen über ValuePattern oder SendKeys, Tastenkombinationen.
 * Keine Mauskoordinaten (das wäre Stufe B). Sicherungen hier im Modul:
 *  - Karte höchstens KARTE_FRIST_MS alt, sonst „Fenster neu lesen" (das Modell darf nicht blind klicken)
 *  - Passwortfelder gesperrt (IsPassword), gesperrte Fenster nach Titelmuster
 *  - Notbremse: Eingabe des Owners nach unserer letzten Aktion → Abbruch
 * macOS/Linux folgen (Accessibility bzw. AT-SPI).
 */
export interface Element { nr: number; typ: string; name: string; wert?: string | null; zustand?: string | null; passwort: boolean; x: number; y: number; w: number; h: number; id?: string | null }
export interface Karte { fenster: string; programm: string; pid: number; elemente: Element[]; zeit: number; hash: string }

export const KARTE_FRIST_MS = 45_000;
export const GESPERRTE_FENSTER_STANDARD = ['Banking', 'PayPal', 'Zahlung', 'Checkout', 'Kasse', 'Bezahlen', 'Anmelden bei', 'Sign in'];

const PS_LESEN = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$suche = '__SUCHE__'
$max = 150
$w = $null
if ($suche) { $p = Get-Process | Where-Object { $_.MainWindowTitle -and ($_.MainWindowTitle -like "*$suche*" -or $_.ProcessName -like "*$suche*") } | Select-Object -First 1 }
else {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class AlfredFg { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'
  $h = [AlfredFg]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { @{ fehler = 'Kein Vordergrundfenster' } | ConvertTo-Json -Compress; exit 0 }
  $w = [System.Windows.Automation.AutomationElement]::FromHandle($h)
  $p = Get-Process -Id $w.Current.ProcessId
}
if (-not $p) { @{ fehler = 'Fenster nicht gefunden' } | ConvertTo-Json -Compress; exit 0 }
if (-not $w) { $w = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle) }
$all = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$liste = New-Object System.Collections.ArrayList
$nr = 0
foreach ($e in $all) {
  $c = $e.Current
  if ($c.IsOffscreen -or -not $c.IsEnabled) { continue }
  $t = $c.ControlType.ProgrammaticName.Replace('ControlType.', '')
  if ($t -notmatch '^(Button|Edit|MenuItem|TabItem|CheckBox|ComboBox|Hyperlink|ListItem|RadioButton|TreeItem|Document|SplitButton|Slider|Spinner|MenuBar|Menu|DataItem|Custom|Text)$') { continue }
  if (($t -eq 'Text' -or $t -eq 'Custom') -and -not $c.IsKeyboardFocusable) { continue }
  $nr++
  if ($nr -gt $max) { break }
  $r = $c.BoundingRectangle
  $wert = $null
  try { $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); if ($vp) { $wert = $vp.Current.Value; if ($wert.Length -gt 80) { $wert = $wert.Substring(0, 80) } } } catch {}
  if ($null -eq $wert -and ($t -eq 'Document' -or $t -eq 'Edit')) { try { $tx = $e.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern); if ($tx) { $wert = $tx.DocumentRange.GetText(80) } } catch {} }
  $zustand = $null
  try { $tp = $e.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); if ($tp) { $zustand = $tp.Current.ToggleState.ToString() } } catch {}
  $null = $liste.Add(@{ nr = $nr; typ = $t; name = $c.Name; wert = $wert; zustand = $zustand; passwort = $c.IsPassword; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height; id = $c.AutomationId })
}
@{ fenster = $p.MainWindowTitle; programm = $p.ProcessName; pid = $p.Id; elemente = $liste } | ConvertTo-Json -Compress -Depth 3
`;

const PS_AKTION = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$ProzessId = __PID__; $Id = '__ID__'; $Name = '__NAME__'; $Typ = '__TYP__'; $X = __X__; $Y = __Y__
$Aktion = '__AKTION__'; $Text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__TEXT64__')); $Enter = '__ENTER__'
$p = Get-Process -Id $ProzessId -ErrorAction SilentlyContinue
if (-not $p) { @{ ok = $false; fehler = 'Programm läuft nicht mehr' } | ConvertTo-Json -Compress; exit 0 }
$win = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
$e = $null
$all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
if ($Id) { foreach ($k in $all) { $c = $k.Current; if ($c.AutomationId -eq $Id -and $c.ControlType.ProgrammaticName -eq "ControlType.$Typ") { $e = $k; break } } }
if (-not $e) { foreach ($k in $all) { $c = $k.Current; if ($c.Name -eq $Name -and $c.ControlType.ProgrammaticName -eq "ControlType.$Typ" -and [int]$c.BoundingRectangle.X -eq $X -and [int]$c.BoundingRectangle.Y -eq $Y) { $e = $k; break } } }
if (-not $e) { foreach ($k in $all) { $c = $k.Current; if ($c.Name -eq $Name -and $c.ControlType.ProgrammaticName -eq "ControlType.$Typ") { $e = $k; break } } }
if (-not $e) { @{ ok = $false; fehler = 'Element nicht mehr vorhanden — Fenster neu lesen' } | ConvertTo-Json -Compress; exit 0 }
if ($e.Current.IsPassword) { @{ ok = $false; fehler = 'Passwortfeld — gesperrt' } | ConvertTo-Json -Compress; exit 0 }
function Muster($el, $pat) { try { return $el.GetCurrentPattern($pat) } catch { return $null } }
$wie = ''
if ($Aktion -eq 'klicken') {
  $ip = Muster $e ([System.Windows.Automation.InvokePattern]::Pattern)
  if ($ip) { $ip.Invoke(); $wie = 'Invoke' }
  else {
    $tp = Muster $e ([System.Windows.Automation.TogglePattern]::Pattern)
    if ($tp) { $tp.Toggle(); $wie = 'Toggle' }
    else {
      $sp = Muster $e ([System.Windows.Automation.SelectionItemPattern]::Pattern)
      if ($sp) { $sp.Select(); $wie = 'Select' }
      else {
        $xp = Muster $e ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        if ($xp) { if ($xp.Current.ExpandCollapseState -eq 'Expanded') { $xp.Collapse() } else { $xp.Expand() }; $wie = 'Expand' }
        else {
          $lp = Muster $e ([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
          if ($lp) { $lp.DoDefaultAction(); $wie = 'DefaultAction' }
          else { try { $e.SetFocus(); [System.Windows.Forms.SendKeys]::SendWait(' '); $wie = 'Fokus+Leertaste' } catch { @{ ok = $false; fehler = 'kein Klickmuster' } | ConvertTo-Json -Compress; exit 0 } }
        }
      }
    }
  }
} elseif ($Aktion -eq 'tippen') {
  $vp = Muster $e ([System.Windows.Automation.ValuePattern]::Pattern)
  if ($vp -and -not $vp.Current.IsReadOnly -and $Typ -ne 'Document') { $vp.SetValue($Text); $wie = 'SetValue' }
  else {
    $e.SetFocus(); Start-Sleep -Milliseconds 120
    $esc = $Text -replace '([+^%~(){}\\[\\]])', '{$1}'
    [System.Windows.Forms.SendKeys]::SendWait($esc); $wie = 'SendKeys'
  }
  if ($Enter -eq 'true') { [System.Windows.Forms.SendKeys]::SendWait('{ENTER}') }
} else { @{ ok = $false; fehler = "Aktion $Aktion unbekannt" } | ConvertTo-Json -Compress; exit 0 }
Start-Sleep -Milliseconds 150
@{ ok = $true; wie = $wie; fenster = $p.MainWindowTitle } | ConvertTo-Json -Compress
`;

const PS_TASTE = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('__KEYS__')
"ok"
`;

// v1281 — Stufe B: Mausklick nach Koordinaten, nur wenn an der Stelle das Vordergrundfenster liegt (WindowFromPoint),
// damit kein verdecktes Ziel und kein fremdes Fenster getroffen wird (Befund 07.10.: Klick landete im Terminal davor).
const PS_KLICK = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class AlfredMaus {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(System.Drawing.Point p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static uint PidVon(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
  public static IntPtr WurzelBei(int x, int y) { IntPtr h = WindowFromPoint(new System.Drawing.Point(x, y)); IntPtr r = GetAncestor(h, 2); return r == IntPtr.Zero ? h : r; }
  public static void Klick(int x, int y, bool doppelt) { SetCursorPos(x, y); System.Threading.Thread.Sleep(60); mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); if (doppelt) { System.Threading.Thread.Sleep(80); mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); } }
}
"@ -ReferencedAssemblies System.Drawing
$x = __X__; $y = __Y__; $doppelt = $__DOPPELT__
$vorne = [AlfredMaus]::GetForegroundWindow()
$dort = [AlfredMaus]::WurzelBei($x, $y)
if ($dort -ne $vorne) { @{ ok = $false; fehler = 'An der Stelle liegt nicht das Vordergrundfenster — erst fenster_vordergrund, dann neues Foto' } | ConvertTo-Json -Compress; exit 0 }
[AlfredMaus]::Klick($x, $y, $doppelt)
@{ ok = $true; x = $x; y = $y; pid = [AlfredMaus]::PidVon($vorne) } | ConvertTo-Json -Compress
`;

const PS_LEERLAUF = `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class AlfredIdle { [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; } [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii); public static uint Ms() { LASTINPUTINFO i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i); GetLastInputInfo(ref i); return (uint)Environment.TickCount - i.dwTime; } }'
[AlfredIdle]::Ms()
`;

function powershell(script: string, timeout = 60_000): Promise<string> {
  const enc = Buffer.from('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' + script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(new Error(`powershell: ${String(stderr).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || err.message}`)) : resolve(String(stdout).trim()));
  });
}
const ps1 = (s: string) => s.replace(/'/g, "''");
const letzteZeile = (out: string) => out.split('\n').map(z => z.trim()).filter(Boolean).pop() ?? '{}';

/** Tastenkombination „strg+s", „alt+f4", „enter", „tab", „esc", „strg+shift+t" → SendKeys-Syntax. Rein, testbar. */
export function tastenkombi(kombi: string): string {
  const roh = kombi.toLowerCase();
  const teile = roh.split('+').map(t => t.trim()).filter(Boolean);
  if (/\+\s*$/.test(roh)) teile.push('+'); // „shift++" = Plus-Taste
  if (teile.length === 0) throw new Error('Taste fehlt');
  const mod: Record<string, string> = { strg: '^', ctrl: '^', control: '^', alt: '%', shift: '+', umschalt: '+', win: '' };
  const spezial: Record<string, string> = { enter: '{ENTER}', eingabe: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}', backspace: '{BACKSPACE}', rücktaste: '{BACKSPACE}', entf: '{DELETE}', delete: '{DELETE}', del: '{DELETE}', pos1: '{HOME}', home: '{HOME}', ende: '{END}', end: '{END}', hoch: '{UP}', up: '{UP}', runter: '{DOWN}', down: '{DOWN}', links: '{LEFT}', left: '{LEFT}', rechts: '{RIGHT}', right: '{RIGHT}', bildauf: '{PGUP}', pageup: '{PGUP}', bildab: '{PGDN}', pagedown: '{PGDN}', leer: ' ', space: ' ', leertaste: ' ' };
  // v1297 — Zeichen-Aliase wie am Mac: „mal"/„shift+8" → *, „plus" → + (SendKeys tippt Zeichen layoutunabhängig)
  const aliase: Record<string, string> = { mal: '*', multiply: '*', star: '*', stern: '*', 'shift+8': '*', plus: '+', 'shift+=': '+', minus: '-', geteilt: '/', divide: '/', slash: '/', gleich: '=', equals: '=', komma: ',', punkt: '.', prozent: '%', 'shift+5': '%', 'shift+9': '(', 'shift+0': ')' };
  if (roh.trim() in aliase) { const z = aliase[roh.trim()]!; return /[+^%~(){}[\]]/.test(z) ? `{${z}}` : z; }
  let prefix = ''; let taste = '';
  for (const t of teile) {
    if (t in mod) { if (t === 'win') throw new Error('Windows-Taste wird nicht unterstützt'); prefix += mod[t]; continue; }
    if (taste) throw new Error(`Nur eine Taste je Kombination: ${kombi}`);
    if (t in spezial) taste = spezial[t]!;
    else if (/^f([1-9]|1[0-2])$/.test(t)) taste = `{${t.toUpperCase()}}`;
    else if (t.length === 1) taste = /[+^%~(){}[\]]/.test(t) ? `{${t}}` : t;
    else throw new Error(`Unbekannte Taste: ${t}`);
  }
  if (!taste) throw new Error('Taste fehlt (nur Modifikatoren)');
  return prefix + taste;
}

export function istGesperrtesFenster(titel: string, muster: string[]): string | undefined {
  const t = titel.toLowerCase();
  return muster.find(m => m && t.includes(m.toLowerCase()));
}

/** Zustand des Bedienens je Satellit: letzte Karte, letzte eigene Eingabe (für die Notbremse). */
export class Bedienung {
  private karte?: Karte;
  private letzteEigeneEingabe = 0;

  constructor(private readonly gesperrteFenster: string[] = GESPERRTE_FENSTER_STANDARD) {}

  async fensterLesen(suche?: string): Promise<Karte> {
    if (process.platform === 'linux') {
      // v1339 — Wayland liefert keine Fensterliste und keine Elemente: feste Ziele (aktives Fenster, Terminal), Titel unbekannt
      const elemente: Element[] = LINUX_ZIELE.map(z => ({ ...z }));
      const karte: Karte = { fenster: suche ?? '', programm: '', pid: 0, elemente, zeit: Date.now(), hash: 'linux-wayland' };
      this.karte = karte;
      return karte;
    }
    if (process.platform !== 'win32' && process.platform !== 'darwin') throw new Error('Bedienen gibt es unter Windows, macOS und Linux');
    const j = process.platform === 'darwin'
      ? await macFensterLesen(suche) as { fehler?: string; fenster?: string; programm?: string; pid?: number; elemente?: Element[] | Element }
      : JSON.parse(letzteZeile(await powershell(PS_LESEN.replace('__SUCHE__', ps1(suche ?? ''))))) as { fehler?: string; fenster?: string; programm?: string; pid?: number; elemente?: Element[] | Element };
    if (j.fehler) throw new Error(j.fehler);
    const elemente = Array.isArray(j.elemente) ? j.elemente : j.elemente ? [j.elemente] : [];
    const karte: Karte = { fenster: j.fenster ?? '', programm: j.programm ?? '', pid: j.pid ?? 0, elemente, zeit: Date.now(), hash: createHash('sha1').update(JSON.stringify(elemente.map(e => [e.typ, e.name, e.id]))).digest('hex').slice(0, 8) };
    this.karte = karte;
    return karte;
  }

  /** Sicherungen vor jeder Aktion: Karte frisch, Fenster erlaubt, Owner tippt nicht gerade selbst. */
  private async pruefeVorAktion(): Promise<Karte> {
    // v1340 — Linux: die Karte besteht nur aus festen Zielen, deshalb bei Bedarf selbst anlegen (Realfall 09.10.: „taste strg+alt+t" scheiterte an „Erst fenster_lesen")
    if (process.platform === 'linux' && (!this.karte || this.karte.zeit === 0 || Date.now() - this.karte.zeit > KARTE_FRIST_MS)) await this.fensterLesen();
    const k = this.karte;
    if (!k) throw new Error('Erst fenster_lesen — ohne Element-Karte keine Aktion');
    // v1296 — nach einer Aktion steht zeit auf 0: dann „verfallen" statt „1791418999 s alt" (Realfall Mac 08.10.)
    if (k.zeit === 0) throw new Error('Element-Karte ist nach der letzten Aktion verfallen — fenster_lesen wiederholen');
    if (Date.now() - k.zeit > KARTE_FRIST_MS) throw new Error(`Element-Karte ist ${Math.round((Date.now() - k.zeit) / 1000)} s alt — fenster_lesen wiederholen`);
    const gesperrt = istGesperrtesFenster(k.fenster, this.gesperrteFenster);
    if (gesperrt) throw new Error(`Fenster „${k.fenster}" ist gesperrt (Muster „${gesperrt}") — das bedient der Owner selbst`);
    const leerlauf = await this.leerlaufMs();
    if (Number.isFinite(leerlauf)) {
      const ownerEingabe = Date.now() - leerlauf;
      if (ownerEingabe > this.letzteEigeneEingabe + 700 && leerlauf < 3000) throw new Error(`Notbremse: der Owner hat vor ${Math.round(leerlauf / 100) / 10} s selbst Eingaben gemacht — Vorhaben abgebrochen`);
    }
    return k;
  }

  private async aktion(nr: number, aktion: 'klicken' | 'tippen', text = '', enter = false): Promise<{ wie: string; element: Element; fenster: string }> {
    const k = await this.pruefeVorAktion();
    const e = k.elemente.find(x => x.nr === nr);
    if (!e) throw new Error(`Element Nr. ${nr} gibt es nicht (1–${k.elemente.length})`);
    if (e.passwort) throw new Error('Passwortfeld — gesperrt');
    this.letzteEigeneEingabe = Date.now();
    let j: { ok: boolean; wie?: string; fehler?: string; fenster?: string };
    if (process.platform === 'darwin') j = await macAktion(k.pid, e, aktion, text, enter);
    else if (process.platform === 'linux') j = await linuxAktion(e.id === 'terminal' ? 'terminal' : 'fenster', aktion, text, enter); // v1339
    else {
      const script = PS_AKTION.replace('__PID__', String(k.pid)).replace('__ID__', ps1(e.id ?? '')).replace('__NAME__', ps1(e.name ?? '')).replace('__TYP__', ps1(e.typ)).replace('__X__', String(e.x)).replace('__Y__', String(e.y)).replace('__AKTION__', aktion).replace('__TEXT64__', Buffer.from(text, 'utf8').toString('base64')).replace('__ENTER__', enter ? 'true' : 'false');
      j = JSON.parse(letzteZeile(await powershell(script))) as { ok: boolean; wie?: string; fehler?: string; fenster?: string };
    }
    this.letzteEigeneEingabe = Date.now();
    if (!j.ok) throw new Error(j.fehler ?? 'Aktion fehlgeschlagen');
    if (this.karte) this.karte.zeit = 0; // nach jeder Aktion ist die Karte ungültig: neu lesen
    return { wie: j.wie ?? '', element: e, fenster: j.fenster ?? k.fenster };
  }

  klicken(nr: number) { return this.aktion(nr, 'klicken'); }

  /** v1281 — Stufe B: Klick nach Bildschirmkoordinaten (Aufrufer rechnet Fotokoordinaten um). Sicherungen wie bei Aktionen, plus Vordergrund-Prüfung im Skript. */
  async klickenBei(x: number, y: number, doppelt = false, fensterTitel = ''): Promise<{ x: number; y: number; pid: number }> {
    if (process.platform !== 'win32' && process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('Klick nach Koordinaten gibt es unter Windows, macOS und Linux');
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x und y fehlen');
    const gesperrt = istGesperrtesFenster(fensterTitel, this.gesperrteFenster);
    if (gesperrt) throw new Error(`Fenster „${fensterTitel}" ist gesperrt (Muster „${gesperrt}")`);
    const leerlauf = await this.leerlaufMs();
    if (Number.isFinite(leerlauf) && Date.now() - leerlauf > this.letzteEigeneEingabe + 700 && leerlauf < 3000) throw new Error(`Notbremse: der Owner hat vor ${Math.round(leerlauf / 100) / 10} s selbst Eingaben gemacht — Vorhaben abgebrochen`);
    this.letzteEigeneEingabe = Date.now();
    const j = process.platform === 'darwin'
      ? await macKlickenBei(x, y, doppelt)
      : process.platform === 'linux' ? await linuxKlickenBei(x, y, doppelt) // v1339
      : JSON.parse(letzteZeile(await powershell(PS_KLICK.replace('__X__', String(Math.round(x))).replace('__Y__', String(Math.round(y))).replace('__DOPPELT__', doppelt ? 'true' : 'false'), 30_000))) as { ok: boolean; fehler?: string; pid?: number };
    this.letzteEigeneEingabe = Date.now();
    if (!j.ok) throw new Error(j.fehler ?? 'Klick fehlgeschlagen');
    if (this.karte) this.karte.zeit = 0;
    return { x: Math.round(x), y: Math.round(y), pid: j.pid ?? 0 };
  }
  tippen(nr: number, text: string, enter = false) { return this.aktion(nr, 'tippen', text, enter); }

  /** Leerlauf seit der letzten Eingabe (Notbremse): Windows GetLastInputInfo, macOS HIDIdleTime. */
  private async leerlaufMs(): Promise<number> {
    if (process.platform === 'darwin') return macLeerlaufMs();
    if (process.platform === 'linux') return linuxLeerlaufMs(); // v1339 — Mutter IdleMonitor
    return Number(letzteZeile(await powershell(PS_LEERLAUF, 15_000)));
  }

  async taste(kombi: string): Promise<string> {
    let keys = process.platform === 'darwin' || process.platform === 'linux' ? kombi : tastenkombi(kombi);
    await this.pruefeVorAktion();
    this.letzteEigeneEingabe = Date.now();
    if (process.platform === 'darwin') await macTasteSenden(kombi);
    else if (process.platform === 'linux') keys = await linuxTasteSenden(kombi); // v1339 — ydotool (Tastennamen), Zeichen über Zwischenablage
    else await powershell(PS_TASTE.replace('__KEYS__', ps1(keys)), 20_000);
    this.letzteEigeneEingabe = Date.now();
    if (this.karte) this.karte.zeit = 0;
    return keys;
  }

  /** v1279 — Marken für das markierte Bildschirmfoto (Set of Marks) aus der letzten Karte. */
  marken(): { nr: number; x: number; y: number; w: number; h: number }[] {
    return (this.karte?.elemente ?? []).filter(e => e.w > 1 && e.h > 1 && e.x > -30000).map(e => ({ nr: e.nr, x: e.x, y: e.y, w: e.w, h: e.h }));
  }
  letzteKarte(): Karte | undefined { return this.karte; }

  /** Karte als Text für das Modell: Nummer, Typ, Name, Wert, Zustand. */
  static formatiere(k: Karte): string {
    const z = k.elemente.map(e => `${e.nr}. [${e.typ}] ${e.name || '(ohne Name)'}${e.wert ? ` = „${e.wert}"` : ''}${e.zustand ? ` (${e.zustand})` : ''}${e.passwort ? ' 🔒' : ''}`);
    return `Fenster „${k.fenster}" (${k.programm}) — ${k.elemente.length} Elemente, Karte ${k.hash}:\n${z.join('\n')}`;
  }
}
