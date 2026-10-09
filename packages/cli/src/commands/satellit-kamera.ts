import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

/**
 * v1325 — Kamera-Foto als feste Geräteaktion. Realfall 09.10. 15:20 (Owner, PC-App → MacBook): das Modell steuerte Photo Booth
 * über die Oberfläche, drückte den Auslöser und suchte das Bild eine Sekunde später im englischen Pfad „Photo Booth Library" —
 * auf dem deutschen Mac heißt der Ordner „Photo Booth-Mediathek", und Photo Booth zählt erst drei Sekunden herunter.
 * Das Foto lag um 15:21 da, Alfred meldete „bisher kein Foto". Deshalb deterministisch: Photo Booth öffnen, Auslöser
 * (Eingabetaste) über System Events, warten, die neue Datei aus allen „Photo Booth*"-Ordnern holen. Keine zusätzliche
 * Kameraberechtigung nötig — Photo Booth hat sie, und der Owner sieht am Bildschirm, dass die Kamera läuft.
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

export async function kameraFoto(geraetName: string): Promise<KameraFoto> {
  if (process.platform !== 'darwin') throw new Error('Kamera-Foto gibt es bisher nur auf macOS (Photo Booth).');
  const start = Date.now();
  const seit = start - 1000;
  await run('open', ['-a', 'Photo Booth']);
  // Fenster abwarten (Kaltstart dauert), dann Auslöser: Eingabetaste in Photo Booth
  let offen = false;
  for (let i = 0; i < 20 && !offen; i++) {
    await schlaf(500);
    try { offen = (await run('osascript', ['-e', 'tell application "System Events" to return (count of windows of process "Photo Booth")'])).trim() !== '0'; } catch { offen = false; }
  }
  if (!offen) throw new Error('Photo Booth hat kein Fenster geöffnet — Kamera nicht verfügbar?');
  await schlaf(1500); // Live-Bild braucht einen Moment, sonst kommt ein schwarzes Foto
  await run('osascript', ['-e', 'tell application "Photo Booth" to activate', '-e', 'delay 0.5', '-e', 'tell application "System Events" to keystroke return']);
  // Countdown 3 s + Speichern: bis zu 10 s auf die neue Datei warten
  const ordner = photoBoothBilderOrdner();
  let pfad: string | undefined;
  for (let i = 0; i < 20 && !pfad; i++) { await schlaf(500); pfad = neuestesFotoSeit(ordner, seit); }
  if (!pfad) throw new Error(`Photo Booth hat kein neues Bild gespeichert (geprüft: ${ordner.join(', ') || 'kein Photo-Booth-Ordner unter ~/Pictures'}).`);
  await schlaf(500); // Datei fertig geschrieben
  const daten = readFileSync(pfad);
  const stempel = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const slug = geraetName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return { dateiName: `foto-${slug}-${stempel}${path.extname(pfad).toLowerCase() || '.jpg'}`, daten, pfad, dauerMs: Date.now() - start };
}
