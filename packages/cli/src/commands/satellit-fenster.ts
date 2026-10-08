import { execFile, spawn } from 'node:child_process';

/**
 * v1271 — Programme und Fenster (Spec §17 Punkt 2): Fensterliste, Programm starten, Fenster in den Vordergrund.
 * Windows über PowerShell (Get-Process MainWindowTitle, SetForegroundWindow), macOS über osascript/open,
 * Linux über wmctrl bzw. xdotool und xdg-open. Kein Tippen, keine Maus — das bleibt Punkt 4.
 */
export interface Fenster { titel: string; programm: string; pid?: number }

function run(cmd: string, args: string[], timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(new Error(`${cmd}: ${String(stderr).trim().slice(0, 300) || err.message}`)) : resolve(String(stdout)));
  });
}

async function powershell(script: string, timeout = 30_000): Promise<string> {
  const enc = Buffer.from('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' + script, 'utf16le').toString('base64');
  return (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], timeout)).trim();
}

async function vorhanden(cmd: string): Promise<boolean> {
  try { await run(process.platform === 'win32' ? 'where' : 'which', [cmd], 5000); return true; } catch { return false; }
}

const psString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Sichtbare Fenster mit Titel. */
export async function fensterListe(): Promise<Fenster[]> {
  if (process.platform === 'win32') {
    const out = await powershell(`$l = Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id, ProcessName, MainWindowTitle; if ($l -eq $null) { '[]' } else { ConvertTo-Json @($l) -Compress }`);
    const j = JSON.parse(out || '[]') as Array<{ Id: number; ProcessName: string; MainWindowTitle: string }>;
    return j.map(p => ({ titel: p.MainWindowTitle, programm: p.ProcessName, pid: p.Id }));
  }
  if (process.platform === 'darwin') {
    // v1298 — Realfall 08.10.: `log` schreibt nach stderr, run() liefert bei Erfolg nur stdout → Liste leer („offen sind:").
    // Jetzt sammelt das Skript die Zeilen und gibt sie als Ergebnis (stdout) zurück; Prozesse ohne Fensterzugriff werden übersprungen.
    const out = await run('osascript', ['-e', MAC_FENSTER_SKRIPT], 20_000);
    return parseFensterZeilen(out);
  }
  if (await vorhanden('wmctrl')) {
    const out = await run('wmctrl', ['-lp']);
    return out.split('\n').filter(Boolean).map(z => { const t = z.split(/\s+/); const pid = parseInt(t[2] ?? '', 10); return { titel: t.slice(4).join(' '), programm: t[3] ?? '', pid: Number.isFinite(pid) ? pid : undefined }; });
  }
  throw new Error('Keine Fensterliste möglich (wmctrl installieren)');
}

const MAC_FENSTER_SKRIPT = [
  'set out to ""',
  'tell application "System Events"',
  '  repeat with p in (every process whose background only is false)',
  '    try',
  '      repeat with w in (every window of p)',
  '        set out to out & (name of p as text) & "|" & (name of w as text) & linefeed',
  '      end repeat',
  '    end try',
  '  end repeat',
  'end tell',
  'return out',
].join('\n');

/** v1298 — „Programm|Titel" je Zeile → Fensterliste; Titel dürfen selbst „|" enthalten. */
export function parseFensterZeilen(out: string): Array<{ titel: string; programm: string; pid?: number }> {
  return out.split('\n').map(z => z.trim()).filter(z => z.includes('|')).map(z => { const [programm, ...rest] = z.split('|'); return { titel: rest.join('|'), programm: programm! }; });
}

/** Startet ein Programm (Name im Pfad, App-Name unter macOS oder voller Pfad), optional mit Argumenten. */
export async function programmStarten(programm: string, argumente: string[] = []): Promise<string> {
  if (!programm.trim()) throw new Error('Programm fehlt');
  if (process.platform === 'win32') {
    const args = argumente.length ? ` -ArgumentList @(${argumente.map(psString).join(',')})` : '';
    await powershell(`Start-Process -FilePath ${psString(programm)}${args}`);
    return `${programm} gestartet`;
  }
  if (process.platform === 'darwin') {
    const istPfad = programm.startsWith('/') || programm.startsWith('~');
    await run('open', istPfad ? [programm, ...argumente] : ['-a', programm, ...argumente], 20_000);
    return `${programm} gestartet`;
  }
  const kind = spawn(programm, argumente, { detached: true, stdio: 'ignore' });
  kind.unref();
  await new Promise<void>((resolve, reject) => { kind.once('error', reject); setTimeout(resolve, 500); });
  return `${programm} gestartet`;
}

/** Holt das erste Fenster, dessen Titel oder Programm den Suchtext enthält, in den Vordergrund. */
export async function fensterVordergrund(suche: string): Promise<Fenster> {
  const s = suche.trim().toLowerCase();
  if (!s) throw new Error('Fenstertitel fehlt');
  const liste = await fensterListe();
  const treffer = liste.find(f => f.titel.toLowerCase().includes(s)) ?? liste.find(f => f.programm.toLowerCase().includes(s));
  if (!treffer) throw new Error(`Kein Fenster mit „${suche}" — offen sind: ${liste.slice(0, 12).map(f => f.titel || f.programm).join(', ')}`);
  if (process.platform === 'win32') {
    await powershell(`
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class AlfredVordergrund {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
}
"@
$p = Get-Process -Id ${treffer.pid ?? 0}
$h = $p.MainWindowHandle
[AlfredVordergrund]::ShowWindowAsync($h, 9) | Out-Null
[AlfredVordergrund]::SetForegroundWindow($h) | Out-Null`);
  } else if (process.platform === 'darwin') {
    await run('osascript', ['-e', `tell application "System Events" to set frontmost of process "${treffer.programm.replace(/"/g, '\\"')}" to true`], 10_000);
  } else if (await vorhanden('wmctrl')) {
    await run('wmctrl', ['-a', treffer.titel]);
  } else throw new Error('Kein Fensterwechsel möglich (wmctrl installieren)');
  return treffer;
}
