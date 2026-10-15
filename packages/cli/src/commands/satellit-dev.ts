import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, statSync, readlinkSync, appendFileSync, truncateSync, readdirSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { argumenteFuer, claudePfad, parseErgebnis } from './satellit-auftrag.js';

/**
 * v1460 — dev am Gerät (Owner 15.10.: „dev wahlweise auf dem Gerät selbst lassen oder einen anderen Host bestimmen … wie man das
 * Programm starten muss, sollte Alfred automatisch herausfinden“). Der Satellit erkennt, wie ein Projekt lokal startet, startet es
 * im Arbeitsordner abgekoppelt (überlebt Satelliten-Updates), prüft, ob es antwortet, und beendet nur Instanzen dieses Projekts.
 */

/** Feste Stelle im Projekt, an der Claude Code festhält, wie es startet (Etappenregel). */
export const START_DATEI = '.alfred-start.json';
const DEV_DATEI = path.join('.alfred', 'dev.json');
const DEV_LOG = path.join('.alfred', 'dev.log');
const DEV_AUSSCHLUSS = '/.alfred/dev.*';

export interface StartAngabe { dienst: boolean; start?: string; port?: number; pruefung?: string }
export interface Erkennung { gefunden: boolean; angabe?: StartAngabe; quelle?: 'datei' | 'erkannt' | 'claude'; hinweise: string[] }

/** Angabe prüfen (Datei, Claude-Antwort, manuelle Eingabe): ein Befehl ohne Zeilenumbruch, Port 1–65535, Prüfadresse ab „/“. */
export function startAngabePruefen(roh: unknown): StartAngabe | undefined {
  if (!roh || typeof roh !== 'object') return undefined;
  const r = roh as Record<string, unknown>;
  if (r.dienst === false) return { dienst: false };
  const start = typeof r.start === 'string' ? r.start.trim() : '';
  if (!start || start.length > 300 || /[\r\n\0]/.test(start)) return undefined;
  const port = r.port === undefined || r.port === null || r.port === '' ? undefined : Number(r.port);
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) return undefined;
  const pruefung = typeof r.pruefung === 'string' && /^\/\S{0,199}$/.test(r.pruefung) ? r.pruefung : undefined;
  return { dienst: true, start, ...(port ? { port } : {}), ...(pruefung ? { pruefung } : {}) };
}

const lies = (p: string, max = 200_000): string => { try { const s = statSync(p); return s.isFile() && s.size <= max ? readFileSync(p, 'utf8') : ''; } catch { return ''; } };

/** Quelltexte, in denen Port und Prüfadresse stehen könnten: Startdatei, src/ und Wurzel (ohne Abhängigkeiten), höchstens 40. */
function quellen(dir: string, haupt?: string): string[] {
  const aus: string[] = haupt ? [path.join(dir, haupt)] : [];
  for (const ordner of [dir, path.join(dir, 'src'), path.join(dir, 'server'), path.join(dir, 'app')]) {
    try { for (const n of readdirSync(ordner)) if (/\.(m?[jt]s|py)$/.test(n) && !/\.(test|spec)\./.test(n)) aus.push(path.join(ordner, n)); } catch { /* fehlt */ }
  }
  return [...new Set(aus)].slice(0, 40);
}

/** Port und Prüfadresse aus dem Code (nie aus .env — dort stehen Geheimnisse; .env.example ja). */
function portUndPruefung(dir: string, haupt?: string): { port?: number; pruefung?: string; hinweise: string[] } {
  const hinweise: string[] = [];
  let port: number | undefined; let pruefung: string | undefined;
  const env = lies(path.join(dir, '.env.example'));
  const pe = env.match(/^\s*PORT\s*=\s*(\d{2,5})\s*$/m);
  if (pe) { port = Number(pe[1]); hinweise.push(`Port ${port} aus .env.example`); }
  for (const f of quellen(dir, haupt)) {
    const t = lies(f); if (!t) continue;
    const rel = path.relative(dir, f).split(path.sep).join('/');
    if (!port) {
      const m = t.match(/process\.env\.PORT\)?\s*(?:\|\||\?\?)\s*['"]?(\d{2,5})/) ?? t.match(/\.listen\(\s*(\d{2,5})\b/) ?? t.match(/\bPORT\s*=\s*(\d{2,5})\b/);
      if (m) { port = Number(m[1]); hinweise.push(`Port ${port} aus ${rel}`); }
    }
    if (!pruefung) {
      const m = t.match(/['"`](\/(?:api\/)?(?:health|healthz|gesundheit|status|ping)\b[\w/-]*)['"`]/i);
      if (m) { pruefung = m[1]; hinweise.push(`Prüfadresse ${pruefung} aus ${rel}`); }
    }
    if (port && pruefung) break;
  }
  return { ...(port ? { port } : {}), ...(pruefung ? { pruefung } : {}), hinweise };
}

/** Feste Erkennung ohne Modell: Startdatei, package.json, Procfile, docker-compose. */
export function startErkennen(dir: string): Erkennung {
  const datei = lies(path.join(dir, START_DATEI));
  if (datei) {
    try { const a = startAngabePruefen(JSON.parse(datei)); if (a) return { gefunden: true, angabe: a, quelle: 'datei', hinweise: [`aus ${START_DATEI}`] }; } catch { /* unten weiter */ }
  }
  const pj = lies(path.join(dir, 'package.json'));
  if (pj) {
    try {
      const j = JSON.parse(pj) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; main?: string; bin?: unknown };
      const skript = j.scripts?.start ? 'start' : j.scripts?.dev ? 'dev' : undefined;
      if (skript) {
        const befehl = j.scripts![skript]!;
        const haupt = befehl.match(/\bnode\b[^&|;]*?\s([\w./-]+\.m?[jt]s)\b/)?.[1] ?? j.main;
        const pp = portUndPruefung(dir, haupt);
        const deps = Object.keys({ ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) });
        const webDep = deps.some(d => /^(express|fastify|koa|hono|next|nuxt|vite|@nestjs\/core|http-server|serve|astro|@sveltejs\/kit)$/.test(d));
        const serverCode = haupt ? /createServer|\.listen\(/.test(lies(path.join(dir, haupt))) : false;
        if (pp.port || webDep || serverCode) return { gefunden: true, angabe: { dienst: true, start: skript === 'start' ? 'npm start' : 'npm run dev', ...(pp.port ? { port: pp.port } : {}), ...(pp.pruefung ? { pruefung: pp.pruefung } : {}) }, quelle: 'erkannt', hinweise: [`Start aus package.json (scripts.${skript}: ${befehl.slice(0, 80)})`, ...pp.hinweise] };
        if (j.bin) return { gefunden: true, angabe: { dienst: false }, quelle: 'erkannt', hinweise: ['package.json: Kommandozeilenwerkzeug (bin), kein Dienst'] };
      } else if (j.bin || !j.scripts?.start) {
        return { gefunden: true, angabe: { dienst: false }, quelle: 'erkannt', hinweise: ['package.json ohne start-Skript: kein Dienst'] };
      }
    } catch { /* kaputtes package.json: weiter */ }
  }
  const procfile = lies(path.join(dir, 'Procfile')).match(/^web:\s*(.+)$/m)?.[1]?.trim();
  if (procfile) { const pp = portUndPruefung(dir); return { gefunden: true, angabe: { dienst: true, start: procfile, ...(pp.port ? { port: pp.port } : {}), ...(pp.pruefung ? { pruefung: pp.pruefung } : {}) }, quelle: 'erkannt', hinweise: ['Start aus Procfile (web)', ...pp.hinweise] }; }
  for (const n of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const t = lies(path.join(dir, n));
    if (!t) continue;
    const port = t.match(/-\s*["']?(\d{2,5}):\d{2,5}/)?.[1];
    return { gefunden: true, angabe: { dienst: true, start: 'docker compose up --build', ...(port ? { port: Number(port) } : {}) }, quelle: 'erkannt', hinweise: [`Start aus ${n}${port ? `, Port ${port}` : ''}`] };
  }
  return { gefunden: false, hinweise: ['nichts Eindeutiges gefunden (package.json, Procfile, docker-compose, ' + START_DATEI + ')'] };
}

/** Rückfall: Claude Code nur lesend (Plan-Modus, ohne Schreib-/Shell-Werkzeuge, höchstens 0,30 $), Antwort als eine JSON-Zeile. */
export function startErkennenClaude(dir: string, timeoutMs = 180_000): Promise<Erkennung> {
  const claude = claudePfad();
  if (!claude) return Promise.resolve({ gefunden: false, hinweise: ['Claude Code fehlt auf diesem Gerät'] });
  const prompt = `Ermittle nur lesend, wie das Projekt im Verzeichnis ${dir} lokal gestartet wird. Ändere nichts. Antworte am Ende mit genau einer JSON-Zeile: {"dienst": true, "start": "<Befehl im Projektordner>", "port": <Port>, "pruefung": "<Pfad, der mit Status 2xx antwortet>"} — oder {"dienst": false}, wenn es kein Dienst ist (Bibliothek, Kommandozeilenwerkzeug, Desktop-App). Lies nie .env (Geheimnisse); .env.example ja.`;
  const args = argumenteFuer({ prompt, nurLesen: true, maxKostenUsd: 0.3 });
  const istCmd = /\.cmd$/i.test(claude);
  return new Promise((resolve) => {
    let aus = '';
    const k = spawn(istCmd ? 'cmd.exe' : claude, istCmd ? ['/c', claude, ...args] : args, { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const t = setTimeout(() => { try { k.kill(); } catch { /* weg */ } }, timeoutMs);
    k.stdout.on('data', (d: Buffer) => { aus += d.toString(); });
    k.on('error', (err) => { clearTimeout(t); resolve({ gefunden: false, hinweise: [`Claude Code nicht gestartet: ${err.message}`] }); });
    k.on('close', () => {
      clearTimeout(t);
      const text = parseErgebnis(aus).text ?? '';
      const kandidaten = text.match(/\{[^{}]*"dienst"[^{}]*\}/g) ?? [];
      for (const z of kandidaten.reverse()) { try { const a = startAngabePruefen(JSON.parse(z)); if (a) { resolve({ gefunden: true, angabe: a, quelle: 'claude', hinweise: ['von Claude Code (nur lesend) ermittelt'] }); return; } } catch { /* nächste */ } }
      resolve({ gefunden: false, hinweise: ['Claude Code hat keine verwertbare Angabe geliefert'] });
    });
  });
}

// ── Prozess ─────────────────────────────────────────────────────────────

export function prozessLebt(pid: number | undefined): boolean { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }

function beenden(pid: number, gruppe: boolean): void {
  if (process.platform === 'win32') { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); return; }
  try { process.kill(gruppe ? -pid : pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* weg */ } }
}

async function beendenUndWarten(pid: number, gruppe: boolean, ms = 8_000): Promise<void> {
  beenden(pid, gruppe);
  const bis = Date.now() + ms;
  while (prozessLebt(pid) && Date.now() < bis) await new Promise(r => setTimeout(r, 250));
  if (prozessLebt(pid) && process.platform !== 'win32') { try { process.kill(gruppe ? -pid : pid, 'SIGKILL'); } catch { /* weg */ } }
}

export function portBelegt(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

/** Wer lauscht auf dem Port (Linux: ss + /proc, macOS: lsof)? Windows: unbekannt — dann gilt der Port als fremd belegt. */
export function portBesitzer(port: number): { pid?: number; cwd?: string } {
  try {
    if (process.platform === 'linux') {
      const r = spawnSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8', timeout: 5000 });
      const pid = Number(r.stdout.match(/pid=(\d+)/)?.[1]);
      if (!pid) return {};
      let cwd: string | undefined; try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* fremder Benutzer */ }
      return { pid, ...(cwd ? { cwd } : {}) };
    }
    if (process.platform === 'darwin') {
      const pid = Number(spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 5000 }).stdout.trim().split('\n')[0]);
      if (!pid) return {};
      const cwd = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 5000 }).stdout.split('\n').find(z => z.startsWith('n'))?.slice(1);
      return { pid, ...(cwd ? { cwd } : {}) };
    }
  } catch { /* unbekannt */ }
  return {};
}

const innerhalb = (dir: string, p: string) => { const r = path.relative(path.resolve(dir), path.resolve(p)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

/** Antwortet der Dienst? Erst https (eigene Zertifikate erlaubt — nur lokal), dann http; Status < 500 gilt als lebendig. */
export function antwortet(port: number, pfad = '/', ms = 3000): Promise<{ ok: boolean; schema?: 'https' | 'http'; status?: number }> {
  const versuch = (mod: typeof http | typeof https, schema: 'https' | 'http') => new Promise<{ ok: boolean; schema?: 'https' | 'http'; status?: number }>((resolve) => {
    const req = (mod as typeof https).request({ host: '127.0.0.1', port, path: pfad, method: 'GET', timeout: ms, ...(schema === 'https' ? { rejectUnauthorized: false } : {}) }, (res) => { res.resume(); resolve({ ok: (res.statusCode ?? 500) < 500, schema, status: res.statusCode }); });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.end();
  });
  return versuch(https, 'https').then(r => (r.ok ? r : versuch(http, 'http')));
}

export function lanAdresse(): string {
  for (const l of Object.values(os.networkInterfaces())) for (const a of l ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return '127.0.0.1';
}

function devAusschluss(dir: string): void {
  const datei = path.join(dir, '.git', 'info', 'exclude');
  if (!existsSync(path.join(dir, '.git'))) return;
  const alt = existsSync(datei) ? readFileSync(datei, 'utf8') : '';
  if (alt.split(/\r?\n/).includes(DEV_AUSSCHLUSS)) return;
  mkdirSync(path.dirname(datei), { recursive: true });
  appendFileSync(datei, `${alt && !alt.endsWith('\n') ? '\n' : ''}${DEV_AUSSCHLUSS}\n`);
}

function logEnde(dir: string, n = 12): string { return lies(path.join(dir, DEV_LOG), 50_000_000).split('\n').filter(z => z.trim()).slice(-n).join('\n').slice(-1500); }
function devMeta(dir: string): { pid?: number; start?: string; port?: number; pruefung?: string; zeit?: string } { try { return JSON.parse(readFileSync(path.join(dir, DEV_DATEI), 'utf8')); } catch { return {}; } }

/**
 * dev starten bzw. neu starten. Eigene frühere Instanz (dev.json) beenden; lauscht auf dem Port ein Prozess AUS DIESEM PROJEKTORDNER
 * (z. B. von Hand gestartet), wird er ebenfalls beendet — ein fremder Prozess nie. Dann abgekoppelt starten und warten, bis er antwortet.
 */
// ── v1462 Autostart: bestätigte Instanzen lokal merken, nach Neustart des Geräts/Satelliten wieder hochfahren ──

interface RegisterEintrag { dir: string; start: string; port?: number; pruefung?: string; versuche?: number[] }
export function registerPfad(home = os.homedir()): string { return path.join(home, '.alfred', 'dev-autostart.json'); }
function registerLesen(home?: string): RegisterEintrag[] { try { const j = JSON.parse(readFileSync(registerPfad(home), 'utf8')); return Array.isArray(j) ? j as RegisterEintrag[] : []; } catch { return []; } }
function registerSchreiben(e: RegisterEintrag[], home?: string): void { mkdirSync(path.dirname(registerPfad(home)), { recursive: true }); writeFileSync(registerPfad(home), JSON.stringify(e, null, 1)); }
function registrieren(dir: string, a: StartAngabe, home?: string): void {
  const r = registerLesen(home).filter(x => path.resolve(x.dir) !== path.resolve(dir));
  registerSchreiben([...r, { dir: path.resolve(dir), start: a.start!, ...(a.port ? { port: a.port } : {}), ...(a.pruefung ? { pruefung: a.pruefung } : {}) }], home);
}
function austragen(dir: string, home?: string): void { const r = registerLesen(home); const n = r.filter(x => path.resolve(x.dir) !== path.resolve(dir)); if (n.length !== r.length) registerSchreiben(n, home); }

/**
 * Läuft eine gemerkte Instanz nicht (Gerät neu gestartet, abgestürzt), wieder starten — höchstens 3 Mal je Stunde und Instanz
 * (eine App, die immer gleich abstürzt, soll nicht endlos neu starten). Ordner weg → austragen. Port fremd belegt → überspringen.
 */
export async function autostartPruefen(log: (z: string) => void, home?: string, jetzt = Date.now()): Promise<number> {
  const liste = registerLesen(home);
  let n = 0;
  for (const e of liste) {
    if (!existsSync(e.dir)) { austragen(e.dir, home); log(`Autostart: ${e.dir} fehlt — ausgetragen`); continue; }
    if (prozessLebt(devMeta(e.dir).pid)) continue;
    if (e.port && await portBelegt(e.port)) continue;
    const versuche = (e.versuche ?? []).filter(t => jetzt - t < 3_600_000);
    if (versuche.length >= 3) continue;
    const aktuell = registerLesen(home);
    registerSchreiben(aktuell.map(x => (path.resolve(x.dir) === path.resolve(e.dir) ? { ...x, versuche: [...versuche, jetzt] } : x)), home);
    const r = await devStarten(e.dir, { dienst: true, start: e.start, ...(e.port ? { port: e.port } : {}), ...(e.pruefung ? { pruefung: e.pruefung } : {}) }, 60_000, home);
    n++;
    log(`Autostart ${e.dir}: ${r.ok ? r.text : r.fehler}`);
  }
  return n;
}

export async function devStarten(dir: string, a: StartAngabe, wartenMs = 60_000, home?: string): Promise<{ ok: true; pid: number; url?: string; text: string } | { ok: false; fehler: string; log?: string }> {
  if (!a.dienst || !a.start) return { ok: false, fehler: 'kein Dienst — nichts zu starten' };
  mkdirSync(path.join(dir, '.alfred'), { recursive: true });
  devAusschluss(dir);
  const alt = devMeta(dir);
  if (alt.pid && prozessLebt(alt.pid)) await beendenUndWarten(alt.pid, true);
  const hinweise: string[] = [];
  if (a.port && await portBelegt(a.port)) {
    const b = portBesitzer(a.port);
    if (b.pid && b.cwd && innerhalb(dir, b.cwd)) { await beendenUndWarten(b.pid, false); hinweise.push(`frühere Instanz dieses Projekts (PID ${b.pid}) beendet`); }
    const bis = Date.now() + 8_000;
    while (await portBelegt(a.port) && Date.now() < bis) await new Promise(r => setTimeout(r, 300));
    if (await portBelegt(a.port)) return { ok: false, fehler: `Port ${a.port} ist belegt${b.pid ? ` (PID ${b.pid}${b.cwd ? `, ${b.cwd}` : ''})` : ''} — kein Prozess dieses Projekts, Alfred beendet ihn nicht` };
  }
  const logPfad = path.join(dir, DEV_LOG);
  try { if (statSync(logPfad).size > 5_000_000) truncateSync(logPfad, 0); } catch { /* neu */ }
  appendFileSync(logPfad, `\n--- ${new Date().toISOString()} Alfred startet: ${a.start} ---\n`);
  const fd = openSync(logPfad, 'a');
  const env = { ...process.env, ...(a.port ? { PORT: String(a.port) } : {}) };
  const k = process.platform === 'win32'
    ? spawn('cmd.exe', ['/c', a.start], { cwd: dir, detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env })
    : spawn('/bin/sh', ['-c', a.start], { cwd: dir, detached: true, stdio: ['ignore', fd, fd], env });
  closeSync(fd);
  const pid = k.pid;
  k.unref();
  if (!pid) return { ok: false, fehler: 'Start fehlgeschlagen (keine Prozessnummer)', log: logEnde(dir) };
  writeFileSync(path.join(dir, DEV_DATEI), JSON.stringify({ pid, start: a.start, ...(a.port ? { port: a.port } : {}), ...(a.pruefung ? { pruefung: a.pruefung } : {}), zeit: new Date().toISOString() }, null, 1));
  const bis = Date.now() + wartenMs;
  const ab = Date.now();
  while (Date.now() < bis) {
    await new Promise(r => setTimeout(r, 1000));
    if (!prozessLebt(pid)) return { ok: false, fehler: 'Prozess hat sich beendet', log: logEnde(dir) };
    if (!a.port) { if (Date.now() - ab >= 5000) { registrieren(dir, a, home); return { ok: true, pid, text: [`läuft (PID ${pid}, ohne Port)`, ...hinweise].join(' · ') }; } continue; }
    const r = await antwortet(a.port, a.pruefung ?? '/');
    if (r.ok) { registrieren(dir, a, home); const url = `${r.schema}://${lanAdresse()}:${a.port}`; return { ok: true, pid, url, text: [`läuft: ${url}${a.pruefung ? ` (${a.pruefung} → ${r.status})` : ''}`, ...hinweise].join(' · ') }; }
  }
  return { ok: false, fehler: `antwortet nach ${Math.round(wartenMs / 1000)} s nicht${a.port ? ` auf Port ${a.port}` : ''} (Prozess läuft weiter)`, log: logEnde(dir) };
}

export async function devStoppen(dir: string, home?: string): Promise<{ ok: boolean; text: string }> {
  austragen(dir, home); // v1462 — gestoppt heißt: auch nicht mehr automatisch starten
  const m = devMeta(dir);
  if (!m.pid || !prozessLebt(m.pid)) return { ok: true, text: 'dev lief nicht' };
  await beendenUndWarten(m.pid, true);
  return { ok: !prozessLebt(m.pid), text: prozessLebt(m.pid) ? `PID ${m.pid} lässt sich nicht beenden` : `dev gestoppt (PID ${m.pid})` };
}

export async function devStand(dir: string): Promise<{ laeuft: boolean; pid?: number; url?: string; antwortet?: boolean; start?: string; log: string }> {
  const m = devMeta(dir);
  const laeuft = prozessLebt(m.pid);
  let url: string | undefined; let ok: boolean | undefined;
  if (laeuft && m.port) { const r = await antwortet(m.port, m.pruefung ?? '/'); ok = r.ok; if (r.ok) url = `${r.schema}://${lanAdresse()}:${m.port}`; }
  return { laeuft, ...(m.pid ? { pid: m.pid } : {}), ...(url ? { url } : {}), ...(ok !== undefined ? { antwortet: ok } : {}), ...(m.start ? { start: m.start } : {}), log: logEnde(dir, 8) };
}

// ── v1462 test am Gerät: eigener Ordner aus dem Zielzweig (git worktree, ohne Netz und Token), eigener Port ──

const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]{1,120}$/;
const git = (args: string[], cwd: string, ms = 60_000) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: ms, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

/** Hash der Abhängigkeits-Angaben (Lock-Datei, sonst package.json) — installiert wird nur bei Änderung oder fehlendem node_modules. */
function depsHash(dir: string): string | undefined {
  const pj = lies(path.join(dir, 'package.json'));
  if (!pj) return undefined;
  try { const j = JSON.parse(pj) as { dependencies?: object; devDependencies?: object }; if (!Object.keys({ ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) }).length) return undefined; } catch { return undefined; }
  const lock = lies(path.join(dir, 'package-lock.json'), 50_000_000);
  return createHash('sha256').update(lock || pj).digest('hex').slice(0, 16);
}

/**
 * test-Ordner anlegen bzw. auf den Stand von `ref` bringen (detached, --force: test hat keine eigenen Änderungen), Abhängigkeiten bei
 * Bedarf installieren (npm ci / npm install), .env aus der Umgebung „test“ schreiben (0600) — die .env von dev wird nie kopiert.
 */
export async function testBereitstellen(projekt: string, ordner: string, ref: string, envText?: string): Promise<{ ok: true; sha: string; zweig: string; neu: boolean; installiert: boolean; text: string } | { ok: false; fehler: string }> {
  const p = path.resolve(projekt); const o = path.resolve(ordner);
  // ohne Angabe: der ausgecheckte Zweig des Projekts — außer einem Lauf-Zweig (alfred/…), dann main bzw. master
  if (!ref) { const b = git(['rev-parse', '--abbrev-ref', 'HEAD'], p).stdout.trim(); ref = b && b !== 'HEAD' && !b.startsWith('alfred/') ? b : ['main', 'master'].find(z => git(['rev-parse', '--verify', '--quiet', `refs/heads/${z}`], p).status === 0) ?? ''; }
  if (!REF.test(ref)) return { ok: false, fehler: ref ? `ungültiger Zweig: ${ref}` : 'Zielzweig nicht erkennbar — bitte angeben' };
  if (innerhalb(p, o) || innerhalb(o, p)) return { ok: false, fehler: 'Der test-Ordner darf nicht im Projektordner liegen (und umgekehrt)' };
  if (git(['rev-parse', '--is-inside-work-tree'], p).stdout.trim() !== 'true') return { ok: false, fehler: 'Projektordner ist kein Git-Repository' };
  const ziel = git(['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], p).status === 0 ? `refs/heads/${ref}` : git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ref}`], p).status === 0 ? `refs/remotes/origin/${ref}` : undefined;
  if (!ziel) return { ok: false, fehler: `Zweig ${ref} gibt es im Projekt nicht` };
  const sha = git(['rev-parse', ziel], p).stdout.trim();
  let neu = false;
  if (!existsSync(path.join(o, '.git'))) {
    if (existsSync(o) && readdirSync(o).length > 0) return { ok: false, fehler: `${o} gibt es schon und ist kein test-Ordner von Alfred — bitte leeren oder einen anderen Ordner wählen` };
    git(['worktree', 'prune'], p);
    const w = git(['worktree', 'add', '--detach', '--force', o, sha], p, 5 * 60_000);
    if (w.status !== 0) return { ok: false, fehler: `git worktree add: ${(w.stderr || w.stdout).trim().slice(-400)}` };
    neu = true;
  } else {
    const c = git(['checkout', '--detach', '--force', sha], o, 5 * 60_000);
    if (c.status !== 0) return { ok: false, fehler: `git checkout: ${(c.stderr || c.stdout).trim().slice(-400)}` };
  }
  mkdirSync(path.join(o, '.alfred'), { recursive: true });
  devAusschluss(p);
  if (envText !== undefined) writeFileSync(path.join(o, '.env'), envText, { mode: 0o600 });
  let installiert = false;
  const h = depsHash(o);
  const merk = path.join(o, '.alfred', 'dev.test.json');
  let alt: { deps?: string } = {}; try { alt = JSON.parse(readFileSync(merk, 'utf8')); } catch { /* neu */ }
  if (h && (alt.deps !== h || !existsSync(path.join(o, 'node_modules')))) {
    const befehl = existsSync(path.join(o, 'package-lock.json')) ? 'npm ci' : 'npm install';
    const r = process.platform === 'win32' ? spawnSync('cmd.exe', ['/c', befehl], { cwd: o, encoding: 'utf8', timeout: 15 * 60_000, windowsHide: true }) : spawnSync('/bin/sh', ['-c', befehl], { cwd: o, encoding: 'utf8', timeout: 15 * 60_000 });
    if (r.status !== 0) return { ok: false, fehler: `${befehl} fehlgeschlagen: ${(r.stderr || r.stdout || '').trim().slice(-600)}` };
    installiert = true;
  }
  writeFileSync(merk, JSON.stringify({ deps: h ?? null, sha, ref, zeit: new Date().toISOString() }, null, 1));
  return { ok: true, sha: sha.slice(0, 8), zweig: ref, neu, installiert, text: `test auf ${ref} (${sha.slice(0, 8)})${neu ? ', Ordner angelegt' : ''}${installiert ? ', Abhängigkeiten installiert' : ''}${envText !== undefined ? ', .env aus der Umgebung test' : ''}` };
}
