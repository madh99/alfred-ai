import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * v1304 — `alfred` im PATH ohne globales npm-Paket (Owner-Freigabe 08.10. „punkt 4"): auf dem PC lief der Dienst über den
 * expliziten Node-Pfad, ein `alfred sitzung` im Terminal gab es nicht. Jetzt legt `alfred satellit --install` (und
 * `--starter`) in `~/.alfred/bin` einen Starter ab: `alfred-start.js` liest `~/.alfred/cli/aktuell.json`, nimmt die
 * laufende (bei gescheiterter Probe die vorige) Version und führt sie aus; `alfred.cmd` bzw. `alfred` rufen ihn mit dem
 * Node des Dienstes auf. Der PATH des Benutzers bekommt `~/.alfred/bin` (Windows: Benutzer-Registry ohne setx-Kürzung;
 * macOS/Linux: eine Zeile in ~/.zshrc und ~/.bashrc). Die gestartete Version übernimmt wie bisher selbst das Weiterreichen
 * an neuere Installationen (Starter-Logik in index.ts).
 */
export function binOrdner(home: string = os.homedir()): string { return path.join(home, '.alfred', 'bin'); }

export function starterJs(): string {
  return `#!/usr/bin/env node
// Alfred-Starter (v1304): führt die unter ~/.alfred/cli installierte Version aus.
const fs = require('fs'); const path = require('path'); const os = require('os'); const { spawnSync } = require('child_process');
const dir = path.join(os.homedir(), '.alfred', 'cli');
const bundle = (v) => path.join(dir, v, 'node_modules', '@madh-io', 'alfred-ai', 'bundle', 'index.js');
const nummer = (v) => { const m = /(\\d+)$/.exec(v); return m ? parseInt(m[1], 10) : 0; };
let einstieg;
try {
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'aktuell.json'), 'utf8'));
  const kandidat = a.gescheitert && a.vorige ? bundle(a.vorige) : (a.einstieg || (a.version ? bundle(a.version) : undefined));
  if (kandidat && fs.existsSync(kandidat)) einstieg = kandidat;
} catch (e) { /* kein aktuell.json */ }
if (!einstieg) {
  try {
    const vs = fs.readdirSync(dir).filter(v => fs.existsSync(bundle(v))).sort((x, y) => nummer(x) - nummer(y));
    if (vs.length) einstieg = bundle(vs[vs.length - 1]);
  } catch (e) { /* kein Ordner */ }
}
if (!einstieg) { console.error('Keine installierte Alfred-Version unter ~/.alfred/cli. Erst koppeln und installieren: alfred satellit --install'); process.exit(1); }
const args = process.argv.slice(2);
const env = { ...process.env, ALFRED_STARTER_PFAD: __filename };
const dienst = args.includes('satellit') && args.includes('--dienst');
if (!dienst) {
  const r = spawnSync(process.execPath, [einstieg, ...args], { stdio: 'inherit', env });
  process.exit(r.status === null ? 1 : r.status);
}
// Dienstschleife (v1308): Code 75 = Update → sofort die (neue) Version aus aktuell.json; Absturz → mit Wartezeit neu,
// höchstens 50 Neustarts je Stunde. Vorher endete der Dienst mit dem ersten Absturz oder einem verlorenen Starter.
const log = (z) => { try { fs.appendFileSync(path.join(os.homedir(), '.alfred', 'satellit.log'), new Date().toISOString() + ' [starter] ' + z + '\\n'); } catch (e) { /* */ } };
const warteMs = Number(process.env.ALFRED_STARTER_WARTE_MS || 5000);
let neustarts = []; let warte = warteMs;
for (;;) {
  const start = Date.now();
  const r = spawnSync(process.execPath, [aktuellerEinstieg() || einstieg, ...args], { stdio: 'inherit', env });
  const code = r.status === null ? 1 : r.status;
  if (code === 0) process.exit(0);
  const jetzt = Date.now();
  neustarts = neustarts.filter(t => jetzt - t < 3600000); neustarts.push(jetzt);
  if (neustarts.length > 50) { log('mehr als 50 Neustarts in einer Stunde — gebe auf'); process.exit(1); }
  if (code === 75) { log('Update (Code 75) — starte die aktuelle Version'); warte = warteMs; continue; }
  if (jetzt - start > 600000) warte = warteMs; // lief länger als 10 min stabil → Wartezeit zurücksetzen
  log('Satellit beendet mit Code ' + code + ' — Neustart in ' + Math.round(warte / 1000) + ' s');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, warte);
  warte = Math.min(warte * 2, 60000);
}
function aktuellerEinstieg() {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(dir, 'aktuell.json'), 'utf8'));
    const k = a.gescheitert && a.vorige ? bundle(a.vorige) : (a.einstieg || (a.version ? bundle(a.version) : undefined));
    return k && fs.existsSync(k) ? k : undefined;
  } catch (e) { return undefined; }
}
`;
}

/** v1308 — Dienst-Einträge zeigen auf den Starter in ~/.alfred/bin statt auf eine Versionsdatei, die später aufgeräumt wird. */
export function starterEinstieg(node: string = process.execPath, plattform: NodeJS.Platform = process.platform): string {
  const [js] = schreibeStarter(binOrdner(), node, plattform);
  return js!;
}

export function starterAufrufWindows(node: string): string {
  return `@echo off\r\nset "ALFRED_NODE=${node}"\r\nif not exist "%ALFRED_NODE%" set "ALFRED_NODE=node"\r\n"%ALFRED_NODE%" "%~dp0alfred-start.js" %*\r\n`;
}
export function starterAufrufUnix(node: string): string {
  return `#!/bin/sh\nN="${node}"\n[ -x "$N" ] || N=node\nexec "$N" "$(dirname "$0")/alfred-start.js" "$@"\n`;
}

/** Dateien schreiben; liefert die Pfade. Testbar mit eigenem Ordner/Plattform. */
export function schreibeStarter(ordner: string, node: string = process.execPath, plattform: NodeJS.Platform = process.platform): string[] {
  mkdirSync(ordner, { recursive: true });
  const js = path.join(ordner, 'alfred-start.js');
  writeFileSync(js, starterJs());
  const pfade = [js];
  if (plattform === 'win32') {
    const cmd = path.join(ordner, 'alfred.cmd');
    writeFileSync(cmd, starterAufrufWindows(node));
    pfade.push(cmd);
  } else {
    const sh = path.join(ordner, 'alfred');
    writeFileSync(sh, starterAufrufUnix(node));
    try { chmodSync(sh, 0o755); chmodSync(js, 0o755); } catch { /* */ }
    pfade.push(sh);
  }
  return pfade;
}

/** PATH des Benutzers um den bin-Ordner ergänzen; liefert, was geschehen ist. */
export function ergaenzePath(ordner: string, plattform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  if (plattform === 'win32') {
    const skript = `$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if (($p -split ';') -contains $env:ALFRED_BIN) { 'vorhanden' } else { [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';' + $env:ALFRED_BIN), 'User'); 'ergaenzt' }`;
    try {
      const r = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', skript], { env: { ...process.env, ALFRED_BIN: ordner }, encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim();
      return r === 'ergaenzt' ? `PATH des Benutzers um ${ordner} ergänzt — gilt in neuen Terminals` : `PATH enthält ${ordner} bereits`;
    } catch (err) { return `PATH nicht ergänzt (${(err as Error).message.slice(0, 80)}) — bitte von Hand: ${ordner}`; }
  }
  const zeile = `export PATH="$HOME/.alfred/bin:$PATH" # alfred`;
  const dateien = plattform === 'darwin' ? ['.zshrc', '.bashrc', '.bash_profile'] : ['.bashrc', '.zshrc', '.profile'];
  const geaendert: string[] = [];
  for (const d of dateien) {
    const p = path.join(home, d);
    if (!existsSync(p) && d !== dateien[0]) continue; // nur vorhandene Dateien, die erste wird angelegt
    let inhalt = ''; try { inhalt = readFileSync(p, 'utf8'); } catch { /* neu */ }
    if (inhalt.includes('.alfred/bin')) continue;
    appendFileSync(p, `${inhalt.endsWith('\n') || !inhalt ? '' : '\n'}${zeile}\n`);
    geaendert.push(d);
  }
  return geaendert.length ? `PATH-Zeile in ${geaendert.join(', ')} ergänzt — gilt in neuen Terminals` : 'PATH-Zeile schon vorhanden';
}

export function installiereStarter(): string[] {
  const ordner = binOrdner();
  const pfade = schreibeStarter(ordner);
  return [`Starter angelegt: ${pfade.join(', ')}`, ergaenzePath(ordner)];
}
