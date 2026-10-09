import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * v1325 — Kamera-Foto als feste Geräteaktion. Realfall 09.10. 15:20 (Owner, PC-App → MacBook): das Modell steuerte Photo Booth
 * über die Oberfläche, drückte den Auslöser und suchte das Bild eine Sekunde später im englischen Pfad „Photo Booth Library" —
 * auf dem deutschen Mac heißt der Ordner „Photo Booth-Mediathek", und Photo Booth zählt erst drei Sekunden herunter.
 * Das Foto lag um 15:21 da, Alfred meldete „bisher kein Foto". Deshalb deterministisch: Photo Booth öffnen, Auslöser
 * (Eingabetaste) über System Events, warten, die neue Datei aus allen „Photo Booth*"-Ordnern holen. Keine zusätzliche
 * Kameraberechtigung nötig — Photo Booth hat sie, und der Owner sieht am Bildschirm, dass die Kamera läuft.
 * v1326 — kein Fenster-Zählen über System Events mehr (lieferte 0, Beweislauf 15:39): Prozess abwarten, feste Anlaufzeit,
 * Auslöser, Datei als einziges Erfolgskriterium; zweiter Auslöseversuch; Photo Booth danach wieder beenden, wenn es
 * vorher nicht lief (Kameralicht aus).
 */
export interface KameraFoto { dateiName: string; daten: Buffer; pfad: string; dauerMs: number }

function run(cmd: string, args: string[], timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim())); else resolve(String(stdout));
    });
  });
}

const schlaf = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function photoBoothLaeuft(): Promise<boolean> {
  try { return (await run('pgrep', ['-x', 'Photo Booth'], 5_000)).trim() !== ''; } catch { return false; }
}

/** Alle Photo-Booth-Ordner (lokalisierte Namen: „Photo Booth Library", „Photo Booth-Mediathek", …) mit ihrem Bilderordner. */
export function photoBoothBilderOrdner(heim = os.homedir()): string[] {
  const bilder = path.join(heim, 'Pictures');
  if (!existsSync(bilder)) return [];
  return readdirSync(bilder)
    .filter(n => /^Photo Booth/i.test(n))
    .map(n => path.join(bilder, n, 'Pictures'))
    .filter(p => existsSync(p));
}

/** Neueste Bilddatei in den Ordnern, die nach `seit` entstanden ist. */
export function neuestesFotoSeit(ordner: string[], seit: number): string | undefined {
  let best: { pfad: string; zeit: number } | undefined;
  for (const o of ordner) {
    let namen: string[] = [];
    try { namen = readdirSync(o); } catch { continue; }
    for (const n of namen) {
      if (!/\.(jpe?g|png|heic)$/i.test(n)) continue;
      const p = path.join(o, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (!st.isFile() || st.mtimeMs < seit) continue;
      if (!best || st.mtimeMs > best.zeit) best = { pfad: p, zeit: st.mtimeMs };
    }
  }
  return best?.pfad;
}

async function ausloesen(): Promise<void> {
  // Photo Booth nach vorn, dann Eingabetaste (key code 36 = Return) — der Auslöser von Photo Booth
  await run('osascript', ['-e', 'tell application "Photo Booth" to activate', '-e', 'delay 1', '-e', 'tell application "System Events" to key code 36']);
}

async function wartenAufFoto(ordner: string[], seit: number, sekunden: number): Promise<string | undefined> {
  for (let i = 0; i < sekunden * 2; i++) {
    const p = neuestesFotoSeit(ordner, seit);
    if (p) return p;
    await schlaf(500);
  }
  return undefined;
}

/** v1328 — Windows: WinRT MediaCapture über PowerShell (ohne Zusatzwerkzeug; am PC des Owners mit BRIO bewiesen). */
const WIN_FOTO = `
param([string]$Ziel)
[Windows.Media.Capture.MediaCapture, Windows.Media.Capture, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.MediaProperties.ImageEncodingProperties, Windows.Media.MediaProperties, ContentType = WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function Await($op, $t) { $m = $asTaskGeneric.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
function AwaitAction($op) { $task = $asTask.Invoke($null, @($op)); $task.Wait(-1) | Out-Null }
$mc = New-Object Windows.Media.Capture.MediaCapture
$s = New-Object Windows.Media.Capture.MediaCaptureInitializationSettings
$s.StreamingCaptureMode = [Windows.Media.Capture.StreamingCaptureMode]::Video
AwaitAction($mc.InitializeAsync($s))
Start-Sleep -Milliseconds 1500
$dir = Split-Path $Ziel -Parent; $name = Split-Path $Ziel -Leaf
$folder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($dir)) ([Windows.Storage.StorageFolder])
$file = Await ($folder.CreateFileAsync($name, [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
$props = [Windows.Media.MediaProperties.ImageEncodingProperties]::CreateJpeg()
AwaitAction($mc.CapturePhotoToStorageFileAsync($props, $file))
$mc.Dispose()
(Get-Item $Ziel).Length
`;

function linuxWerkzeug(): 'ffmpeg' | 'fswebcam' | undefined {
  for (const [w, p] of [['ffmpeg', '/usr/bin/ffmpeg'], ['fswebcam', '/usr/bin/fswebcam']] as const) if (existsSync(p)) return w;
  return undefined;
}

/** Steht eine Kamera-Aktion auf dieser Plattform zur Verfügung? (Manifest; Linux nur mit Werkzeug und /dev/video0) */
export function kameraVerfuegbar(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  return !!linuxWerkzeug() && existsSync('/dev/video0');
}

async function fotoWindows(ziel: string): Promise<void> {
  const skript = path.join(os.tmpdir(), `alfred-foto-${process.pid}.ps1`);
  writeFileSync(skript, WIN_FOTO, 'utf8');
  try { await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', skript, ziel], 45_000); }
  finally { try { unlinkSync(skript); } catch { /* egal */ } }
}

async function fotoLinux(ziel: string): Promise<void> {
  const w = linuxWerkzeug();
  if (!w) throw new Error('Keine Kamera-Software: ffmpeg oder fswebcam installieren.');
  if (w === 'ffmpeg') await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'v4l2', '-i', '/dev/video0', '-frames:v', '1', ziel], 30_000);
  else await run('fswebcam', ['-r', '1280x720', '--no-banner', '-S', '5', ziel], 30_000);
}

export async function kameraFoto(geraetName: string): Promise<KameraFoto> {
  const slug = geraetName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const stempel = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  if (process.platform !== 'darwin') {
    const start = Date.now();
    const ziel = path.join(os.tmpdir(), `alfred-foto-${process.pid}-${Date.now()}.jpg`);
    try {
      if (process.platform === 'win32') await fotoWindows(ziel); else await fotoLinux(ziel);
      if (!existsSync(ziel)) throw new Error('Die Kamera hat kein Bild geliefert.');
      const daten = readFileSync(ziel);
      return { dateiName: `foto-${slug}-${stempel}.jpg`, daten, pfad: ziel, dauerMs: Date.now() - start };
    } finally { try { unlinkSync(ziel); } catch { /* egal */ } }
  }
  const start = Date.now();
  const seit = start - 1000;
  const liefSchon = await photoBoothLaeuft();
  await run('open', ['-a', 'Photo Booth']);
  let laeuft = liefSchon;
  for (let i = 0; i < 20 && !laeuft; i++) { await schlaf(500); laeuft = await photoBoothLaeuft(); }
  if (!laeuft) throw new Error('Photo Booth ließ sich nicht starten — Kamera nicht verfügbar?');
  await schlaf(liefSchon ? 1500 : 5000); // Kaltstart: Fenster + Live-Bild brauchen einen Moment, sonst wird das Foto schwarz
  const ordner = photoBoothBilderOrdner();
  if (ordner.length === 0) throw new Error('Kein Photo-Booth-Ordner unter ~/Pictures gefunden — Photo Booth noch nie benutzt?');
  await ausloesen();
  let pfad = await wartenAufFoto(ordner, seit, 12); // Countdown 3 s + Speichern
  if (!pfad) { await ausloesen(); pfad = await wartenAufFoto(ordner, seit, 12); } // zweiter Versuch (erster Tastendruck ging ins Leere)
  if (!liefSchon) { try { await run('osascript', ['-e', 'tell application "Photo Booth" to quit']); } catch { /* bleibt offen */ } }
  if (!pfad) throw new Error(`Photo Booth hat kein neues Bild gespeichert (geprüft: ${ordner.join(', ')}).`);
  await schlaf(500); // Datei fertig geschrieben
  const daten = readFileSync(pfad);
  return { dateiName: `foto-${slug}-${stempel}${path.extname(pfad).toLowerCase() || '.jpg'}`, daten, pfad, dauerMs: Date.now() - start };
}
