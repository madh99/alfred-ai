import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';

/**
 * v1342 — Aufträge an Claude Code im Druckmodus (Owner 10.10.: „erstelle mit der Claude-Code-Session Projekt XY, die
 * Spezifikationen sind wie folgt"; Beweise nur auf der Ubuntu-VM). Kein tmux, kein Tippen: `claude -p` läuft abgekoppelt im
 * Projektverzeichnis, schreibt sein Protokoll nach ~/.alfred/auftraege/<id>/, und der Satellit meldet das Ende als Ereignis
 * ans Gehirn (Alfred fasst dann in der anfragenden Sitzung zusammen). Läuft auf Windows, macOS und Linux gleich.
 *
 * Grenzen: nur Projektverzeichnisse mit Schreibrecht; die Spezifikation wird als Datei übergeben (AUFTRAG.md im Projekt),
 * nicht in die Befehlszeile gequetscht; Claude Code arbeitet im Berechtigungsmodus „auto" (Standard 2.1), ohne --dangerously.
 */

export interface AuftragMeta {
  id: string; titel: string; projekt: string; start: string; ende?: string; exit?: number | null; pid?: number;
  status: 'laeuft' | 'fertig' | 'fehler' | 'abgebrochen'; befehl: string; auftragDatei: string;
}

export interface AuftragErgebnis { text: string; kosten?: number; dauerMs?: number; sitzung?: string; fehler?: string }

export function auftraegeOrdner(home = os.homedir()): string { return path.join(home, '.alfred', 'auftraege'); }

/** Claude Code finden: PATH, sonst ~/.local/bin (Standardinstallation), Windows mit .exe/.cmd. */
export function claudePfad(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | undefined {
  const namen = process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  const dirs = [...(env.PATH ?? '').split(path.delimiter).filter(Boolean), path.join(home, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];
  for (const d of dirs) for (const n of namen) { const p = path.join(d, n); if (existsSync(p)) return p; }
  return undefined;
}

export function claudeVerfuegbar(): boolean { return !!claudePfad(); }

export function neueAuftragId(now = new Date()): string {
  const z = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${z}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Prompt für `claude -p`: die Spezifikation liegt als Datei im Projekt, Claude liest sie selbst. */
export function auftragPrompt(auftragDatei: string, projekt: string): string {
  return `Lies die Datei ${auftragDatei} und führe den darin beschriebenen Auftrag im Verzeichnis ${projekt} vollständig aus. Arbeite nur innerhalb dieses Verzeichnisses. Am Ende fasse in wenigen Sätzen zusammen, was du erstellt oder geändert hast und was offen blieb.`;
}

/** Die JSON-Ausgabe von `claude -p --output-format json` (eine Zeile oder ein Objekt am Ende des Protokolls). */
export function parseErgebnis(protokoll: string): AuftragErgebnis {
  const zeilen = protokoll.split('\n').map(z => z.trim()).filter(Boolean);
  for (let i = zeilen.length - 1; i >= 0; i--) {
    const z = zeilen[i]!;
    if (!z.startsWith('{')) continue;
    try {
      const j = JSON.parse(z) as { result?: string; total_cost_usd?: number; duration_ms?: number; session_id?: string; is_error?: boolean; subtype?: string };
      if (typeof j.result === 'string' || j.subtype) return { text: j.result ?? `(${j.subtype})`, kosten: j.total_cost_usd, dauerMs: j.duration_ms, sitzung: j.session_id, fehler: j.is_error ? (j.result ?? j.subtype ?? 'Fehler') : undefined };
    } catch { /* keine JSON-Zeile */ }
  }
  // kein JSON: Ende des Protokolls als Text (z. B. Startfehler)
  return { text: zeilen.slice(-20).join('\n'), fehler: zeilen.length ? zeilen.slice(-3).join(' ') : 'keine Ausgabe' };
}

function metaPfad(id: string, home?: string): string { return path.join(auftraegeOrdner(home), id, 'meta.json'); }
function logPfad(id: string, home?: string): string { return path.join(auftraegeOrdner(home), id, 'log.txt'); }

export function ladeMeta(id: string, home?: string): AuftragMeta | undefined {
  try { return JSON.parse(readFileSync(metaPfad(id, home), 'utf8')) as AuftragMeta; } catch { return undefined; }
}
function speichereMeta(m: AuftragMeta, home?: string): void { writeFileSync(metaPfad(m.id, home), JSON.stringify(m, null, 2)); }

function laeuft(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Auftrag starten: Spezifikation als AUFTRAG-<id>.md ins Projekt, `claude -p` abgekoppelt, Protokoll in ~/.alfred/auftraege/<id>/. */
export function auftragStarten(opts: { projekt: string; auftrag: string; titel?: string; beiEnde?: (meta: AuftragMeta, ergebnis: AuftragErgebnis) => void; home?: string; claude?: string }): AuftragMeta {
  const claude = opts.claude ?? claudePfad();
  if (!claude) throw new Error('Claude Code ist auf diesem Gerät nicht installiert (claude nicht im PATH)');
  if (!existsSync(opts.projekt) || !statSync(opts.projekt).isDirectory()) throw new Error(`Projektverzeichnis fehlt: ${opts.projekt}`);
  const id = neueAuftragId();
  const ordner = path.join(auftraegeOrdner(opts.home), id);
  mkdirSync(ordner, { recursive: true });
  const auftragDatei = path.join(opts.projekt, `AUFTRAG-${id}.md`);
  writeFileSync(auftragDatei, `# ${opts.titel ?? 'Auftrag'}\n\n${opts.auftrag.trim()}\n`);
  const args = ['-p', auftragPrompt(auftragDatei, opts.projekt), '--output-format', 'json', '--permission-mode', 'auto'];
  const log = openSync(logPfad(id, opts.home), 'a');
  const istCmd = /\.cmd$/i.test(claude);
  const kind = spawn(istCmd ? 'cmd.exe' : claude, istCmd ? ['/c', claude, ...args] : args, { cwd: opts.projekt, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, CLAUDE_CODE_NO_UPDATE_CHECK: '1' } });
  const meta: AuftragMeta = { id, titel: opts.titel ?? opts.auftrag.split('\n')[0]!.slice(0, 80), projekt: opts.projekt, start: new Date().toISOString(), pid: kind.pid, status: 'laeuft', befehl: `${path.basename(claude)} -p … --output-format json --permission-mode auto`, auftragDatei };
  speichereMeta(meta, opts.home);
  kind.on('error', (err) => {
    closeSync(log);
    const m = { ...meta, status: 'fehler' as const, ende: new Date().toISOString(), exit: null };
    speichereMeta(m, opts.home);
    opts.beiEnde?.(m, { text: '', fehler: `Start fehlgeschlagen: ${err.message}` });
  });
  kind.on('exit', (code) => {
    try { closeSync(log); } catch { /* schon zu */ }
    let protokoll = '';
    try { protokoll = readFileSync(logPfad(id, opts.home), 'utf8'); } catch { /* leer */ }
    const erg = parseErgebnis(protokoll);
    const m: AuftragMeta = { ...meta, status: code === 0 && !erg.fehler ? 'fertig' : 'fehler', ende: new Date().toISOString(), exit: code };
    speichereMeta(m, opts.home);
    opts.beiEnde?.(m, erg);
  });
  kind.unref();
  return meta;
}

/** Stand: läuft noch?, Dauer, letzte Protokollzeilen. */
export function auftragStand(id: string, home?: string, zeilen = 15): { meta: AuftragMeta; laeuft: boolean; dauerS: number; letzteZeilen: string } {
  const meta = ladeMeta(id, home);
  if (!meta) throw new Error(`Auftrag ${id} unbekannt`);
  const aktiv = meta.status === 'laeuft' && laeuft(meta.pid);
  if (meta.status === 'laeuft' && !aktiv) { meta.status = 'fehler'; meta.ende = meta.ende ?? new Date().toISOString(); speichereMeta(meta, home); } // Satellit war zwischendurch neu gestartet
  let log = '';
  try { log = readFileSync(logPfad(id, home), 'utf8'); } catch { /* leer */ }
  const letzte = log.split('\n').filter(z => z.trim()).slice(-zeilen).map(z => z.length > 300 ? `${z.slice(0, 300)}…` : z).join('\n');
  const ende = meta.ende ? new Date(meta.ende).getTime() : Date.now();
  return { meta, laeuft: aktiv, dauerS: Math.round((ende - new Date(meta.start).getTime()) / 1000), letzteZeilen: letzte };
}

export function auftragErgebnis(id: string, home?: string): { meta: AuftragMeta; ergebnis: AuftragErgebnis } {
  const { meta } = auftragStand(id, home, 1);
  if (meta.status === 'laeuft') throw new Error(`Auftrag ${id} läuft noch — auftrag_stand zeigt den Fortschritt`);
  let log = '';
  try { log = readFileSync(logPfad(id, home), 'utf8'); } catch { /* leer */ }
  return { meta, ergebnis: parseErgebnis(log) };
}

export function auftragAbbrechen(id: string, home?: string): AuftragMeta {
  const meta = ladeMeta(id, home);
  if (!meta) throw new Error(`Auftrag ${id} unbekannt`);
  if (meta.status === 'laeuft' && meta.pid && laeuft(meta.pid)) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(meta.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-meta.pid, 'SIGTERM'); // Prozessgruppe (detached)
    } catch { try { process.kill(meta.pid, 'SIGKILL'); } catch { /* weg */ } }
  }
  meta.status = 'abgebrochen'; meta.ende = new Date().toISOString();
  speichereMeta(meta, home);
  return meta;
}

export function auftraege(home?: string, n = 10): AuftragMeta[] {
  const o = auftraegeOrdner(home);
  if (!existsSync(o)) return [];
  return readdirSync(o).sort().reverse().slice(0, n).map(id => ladeMeta(id, home)).filter((m): m is AuftragMeta => !!m).map(m => (m.status === 'laeuft' && !laeuft(m.pid) ? { ...m, status: 'fehler' as const } : m));
}

export function formatiereMeta(m: AuftragMeta): string {
  const dauer = Math.round(((m.ende ? new Date(m.ende).getTime() : Date.now()) - new Date(m.start).getTime()) / 1000);
  return `${m.id} · ${m.titel} · ${m.projekt} · ${m.status} · ${dauer} s`;
}
