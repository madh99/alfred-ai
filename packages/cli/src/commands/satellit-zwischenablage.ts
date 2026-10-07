import { execFile } from 'node:child_process';

/**
 * v1273 — Zwischenablage (Spec §17 Punkt 5): Text lesen und setzen.
 * Windows Get-Clipboard/Set-Clipboard, macOS pbpaste/pbcopy, Linux wl-paste/wl-copy (Wayland) oder xclip (X11).
 * Lesen ist `bestaetigen` (die Zwischenablage enthält oft Passwörter oder Vertrauliches und ginge an das Modell),
 * Setzen ist `auto`. Nur Text; Bilder und Dateien in der Zwischenablage werden als „kein Text" gemeldet.
 */
export const ZWISCHENABLAGE_MAX_ZEICHEN = 20_000;

function run(cmd: string, args: string[], eingabe?: string, timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const kind = execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(new Error(`${cmd}: ${String(stderr).trim().slice(0, 300) || err.message}`)) : resolve(String(stdout)));
    if (eingabe !== undefined && kind.stdin) { kind.stdin.end(eingabe); }
  });
}

async function vorhanden(cmd: string): Promise<boolean> {
  try { await run(process.platform === 'win32' ? 'where' : 'which', [cmd], undefined, 5000); return true; } catch { return false; }
}

function powershell(script: string): Promise<string> {
  const enc = Buffer.from('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' + script, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc]);
}

export async function zwischenablageLesen(): Promise<{ text: string; gekuerzt: boolean }> {
  let text: string;
  if (process.platform === 'win32') text = await powershell('$t = Get-Clipboard -Raw -ErrorAction SilentlyContinue; if ($null -eq $t) { "" } else { $t }');
  else if (process.platform === 'darwin') text = await run('pbpaste', []);
  else if (process.env.WAYLAND_DISPLAY && await vorhanden('wl-paste')) text = await run('wl-paste', ['--no-newline']).catch(() => '');
  else if (await vorhanden('xclip')) text = await run('xclip', ['-selection', 'clipboard', '-o']).catch(() => '');
  else throw new Error('Keine Zwischenablage lesbar (wl-clipboard oder xclip installieren)');
  text = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  const gekuerzt = text.length > ZWISCHENABLAGE_MAX_ZEICHEN;
  return { text: gekuerzt ? text.slice(0, ZWISCHENABLAGE_MAX_ZEICHEN) : text, gekuerzt };
}

export async function zwischenablageSetzen(text: string): Promise<void> {
  if (process.platform === 'win32') {
    // Text über stdin, nicht im Skript: keine Quoting-Fallen, keine Längengrenze der Kommandozeile
    // Realfall 07.10.: „Der angeforderte Clipboard-Vorgang war nicht erfolgreich" — RustDesk/VNC halten die Zwischenablage
    // kurz gesperrt; bis zu zehn Versuche im 150-ms-Abstand
    const script = '[Console]::InputEncoding = [System.Text.Encoding]::UTF8\n$t = [Console]::In.ReadToEnd()\n$ok = $false\nfor ($i = 0; $i -lt 10 -and -not $ok; $i++) { try { Set-Clipboard -Value $t -ErrorAction Stop; $ok = $true } catch { Start-Sleep -Milliseconds 150 } }\nif ($ok) { "ok" } else { "gesperrt" }';
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], text);
    if (!out.includes('ok')) throw new Error('Zwischenablage ist gesperrt (anderes Programm hält sie)');
  } else if (process.platform === 'darwin') await run('pbcopy', [], text);
  else if (process.env.WAYLAND_DISPLAY && await vorhanden('wl-copy')) await run('wl-copy', [], text);
  else if (await vorhanden('xclip')) await run('xclip', ['-selection', 'clipboard', '-i'], text);
  else throw new Error('Keine Zwischenablage setzbar (wl-clipboard oder xclip installieren)');
}
