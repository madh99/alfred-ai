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

export async function kameraFoto(geraetName: string): Promise<KameraFoto> {
  if (process.platform !== 'darwin') throw new Error('Kamera-Foto gibt es bisher nur auf macOS (Photo Booth).');
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
  const stempel = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const slug = geraetName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return { dateiName: `foto-${slug}-${stempel}${path.extname(pfad).toLowerCase() || '.jpg'}`, daten, pfad, dauerMs: Date.now() - start };
}
