import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, readdirSync, statSync, appendFileSync, statfsSync, renameSync } from 'node:fs';

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
  /** v1382 — Ende ans Gehirn gemeldet (Zeitpunkt); fehlt bei Aufträgen, deren Ende noch zu melden ist */
  gemeldet?: string;
  /** v1396 — neues Projektverzeichnis als Git-Repository angelegt */
  gitAngelegt?: boolean;
  /** v1397 — bestehendes Verzeichnis übernommen (nur auf Wunsch des Projekts) */
  git?: GitUebernahme;
  /** v1512 — Frage zum Projekt (nur lesend); zählt nicht für die Verzeichnis-Sperre */
  nurLesen?: boolean;
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

/**
 * v1478 — Starter für Aufträge außerhalb des Satelliten (Windows): liest start.json, startet den Befehl mit Ausgabe ins Protokoll,
 * schreibt den Exit-Code nach exit.json. Bewusst ohne Abhängigkeiten — er läuft als eigene Datei im Auftragsordner.
 */
export const STARTER_JS = [
  "const fs = require('fs'); const { spawn } = require('child_process');",
  "const s = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));",
  "const fd = fs.openSync(s.log, 'a');",
  "const k = spawn(s.befehl, s.args, { cwd: s.cwd, stdio: ['ignore', fd, fd], windowsHide: true, env: { ...process.env, ...s.env } });",
  "k.on('error', (e) => { try { fs.appendFileSync(s.log, '\\nStart fehlgeschlagen: ' + e.message + '\\n'); } catch {} fs.writeFileSync(s.exitDatei, JSON.stringify({ exit: null, fehler: e.message })); process.exit(1); });",
  "k.on('exit', (c) => { fs.writeFileSync(s.exitDatei, JSON.stringify({ exit: c })); process.exit(0); });",
  '',
].join('\n');

/**
 * PowerShell-Befehl für WMI Win32_Process.Create (unsichtbares Fenster); Ausgabe „<ReturnValue> <ProcessId>“.
 * v1479 — fester Befehl ohne eingebettete Werte: Kommandozeile und Verzeichnis kommen über Umgebungsvariablen
 * (Sicherheitsprüfung v1478: in '…'-Zeichenketten zählen auch ‘ ’ ‚ ‛ als Hochkomma — ein Projektordner damit hätte ausbrechen können).
 */
export const WMI_START_BEFEHL = '$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$env:ALFRED_WMI_KOMMANDOZEILE; CurrentDirectory=$env:ALFRED_WMI_VERZEICHNIS; ProcessStartupInformation=$si}; "$($r.ReturnValue) $($r.ProcessId)"';
export function wmiStartUmgebung(kommandozeile: string, cwd: string): NodeJS.ProcessEnv {
  return { ...process.env, ALFRED_WMI_KOMMANDOZEILE: kommandozeile, ALFRED_WMI_VERZEICHNIS: cwd };
}

function starteAusserhalbWindows(o: { befehl: string; args: string[]; cwd: string; log: string; ordner: string; env: Record<string, string> }): number | undefined {
  try {
    const startJson = path.join(o.ordner, 'start.json');
    const starter = path.join(o.ordner, 'starter.cjs');
    writeFileSync(startJson, JSON.stringify({ befehl: o.befehl, args: o.args, cwd: o.cwd, log: o.log, env: o.env, exitDatei: path.join(o.ordner, 'exit.json') }));
    writeFileSync(starter, STARTER_JS);
    // Pfade in der Kommandozeile stammen aus dem eigenen Auftragsordner; Windows-Pfade können kein " enthalten
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WMI_START_BEFEHL], { windowsHide: true, timeout: 30_000, env: wmiStartUmgebung(`"${process.execPath}" "${starter}" "${startJson}"`, o.cwd) }).toString();
    const m = /(\d+)\s+(\d+)\s*$/.exec(out.trim());
    return m && m[1] === '0' && Number(m[2]) > 0 ? Number(m[2]) : undefined;
  } catch { return undefined; }
}

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
      const j = JSON.parse(z) as { type?: string; result?: string; total_cost_usd?: number; duration_ms?: number; session_id?: string; is_error?: boolean; subtype?: string };
      if (j.type !== undefined && j.type !== 'result') continue; // v1392 — stream-json: nur die Abschlusszeile
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
export function auftragStarten(opts: { projekt: string; auftrag: string; ohneWmi?: boolean; titel?: string; beiEnde?: (meta: AuftragMeta, ergebnis: AuftragErgebnis) => void; home?: string; claude?: string; maxKostenUsd?: number; gitUebernehmen?: boolean; nurLesen?: boolean; sudoSperre?: boolean; protokoll?: ProtokollAngabe; /** v1432 — Folgefrage: Claude-Code-Sitzung fortsetzen (nur mit nurLesen) */ sitzung?: string }): AuftragMeta {
  const claude = opts.claude ?? claudePfad();
  if (!claude) throw new Error('Claude Code ist auf diesem Gerät nicht installiert (claude nicht im PATH)');
  // v1391 — Realfall 12.10.: neues Projekt in einem noch nicht vorhandenen Ordner scheiterte an Etappe 1; anlegen (Rechte prüft der Aufrufer)
  // v1404 — Frage zum Projekt: Verzeichnis muss existieren; keine Auftragsdatei, kein Git, keine Schreib-/Shell-Werkzeuge (siehe argumenteFuer)
  if (opts.nurLesen && !existsSync(opts.projekt)) throw new Error(`Projektverzeichnis fehlt: ${opts.projekt}`);
  // v1512 P1 — nie zwei schreibende Claude-Code-Aufträge im selben Verzeichnis (Owner 19.10.); lesende Fragen und andere
  // Verzeichnisse bleiben frei. Vor jeder Wirkung (Ordner, Git, Auftragsdatei).
  if (!opts.nurLesen) {
    const belegt = schreibenderImVerzeichnis(opts.projekt, opts.home);
    if (belegt) throw new Error(`Im Verzeichnis ${opts.projekt} läuft schon der Claude-Code-Auftrag ${belegt.id} („${belegt.titel}“) — kein zweiter schreibender Auftrag im selben Verzeichnis`);
  }
  const neu = !existsSync(opts.projekt);
  if (neu) mkdirSync(opts.projekt, { recursive: true });
  if (!statSync(opts.projekt).isDirectory()) throw new Error(`Projektpfad ist kein Verzeichnis: ${opts.projekt}`);
  // v1396 — Owner 12.10.: neue Projektordner automatisch als Git-Repository, damit jede Etappe nachvollziehbar committet wird
  let gitAngelegt = !opts.nurLesen && neu && gitAnlegen(opts.projekt) === 'angelegt';
  // v1397 — bestehendes Verzeichnis ohne Git: nur wenn das Projekt es verlangt (Owner hat es mit dem Plan freigegeben); vor der Auftragsdatei
  const git = !opts.nurLesen && !neu && opts.gitUebernehmen ? gitUebernehmen(opts.projekt) : undefined;
  if (git?.status === 'angelegt') gitAngelegt = true;
  const id = neueAuftragId();
  const ordner = path.join(auftraegeOrdner(opts.home), id);
  mkdirSync(ordner, { recursive: true });
  // v1404 — die Frage liegt im Auftragsordner, nicht im Projekt (nur lesend: das Projekt bleibt unberührt)
  // v1425 — Projektlauf: Auftrag im Protokollordner des Laufs (.alfred/laeufe/<lauf>/etappe-<n>-auftrag.md) statt lose in der Projektwurzel
  const auftragDatei = opts.nurLesen ? path.join(ordner, 'FRAGE.md') : opts.protokoll ? protokollAuftragDatei(opts.projekt, opts.protokoll) : path.join(opts.projekt, `AUFTRAG-${id}.md`);
  writeFileSync(auftragDatei, `# ${opts.titel ?? 'Auftrag'}\n\n${opts.auftrag.trim()}\n`);
  // v1392 — stream-json: Claude Code schreibt jeden Schritt sofort ins Protokoll (Fortschritt sichtbar), die result-Zeile am Ende bleibt gleich
  // v1394 — ohne die Benutzereinstellungen (~/.claude: Hooks, MCP-Server, Umgebung des Owners; Realfall 12.10.: claude-flow-Hook vor jedem
  // Befehl bremste die Etappe) — Projekt-Einstellungen gelten weiter; optional Kostengrenze je Auftrag
  const args = argumenteFuer({ prompt: opts.nurLesen ? fragePrompt(opts.auftrag, opts.projekt) : auftragPrompt(auftragDatei, opts.projekt), nurLesen: !!opts.nurLesen, maxKostenUsd: opts.maxKostenUsd, sudoSperre: opts.sudoSperre, ...(opts.nurLesen && opts.sitzung ? { sitzung: opts.sitzung } : {}) });
  const istCmd = /\.cmd$/i.test(claude);
  const befehl = istCmd ? 'cmd.exe' : claude;
  const befehlArgs = istCmd ? ['/c', claude, ...args] : args;
  const zusatzEnv = { CLAUDE_CODE_NO_UPDATE_CHECK: '1' };
  const metaVon = (pid: number | undefined): AuftragMeta => ({ id, titel: opts.titel ?? opts.auftrag.split('\n')[0]!.slice(0, 80), projekt: opts.projekt, start: new Date().toISOString(), pid, status: 'laeuft', befehl: `${path.basename(claude)} -p … ${args.slice(2).join(' ')}`, auftragDatei, ...(gitAngelegt ? { gitAngelegt } : {}), ...(git ? { git } : {}), ...(opts.nurLesen ? { nurLesen: true } : {}) });
  const abschliessen = (meta: AuftragMeta, code: number | null) => {
    let protokoll = '';
    try { protokoll = readFileSync(logPfad(id, opts.home), 'utf8'); } catch { /* leer */ }
    const erg = parseErgebnis(protokoll);
    // v1382 — abgebrochen bleibt abgebrochen (auftragAbbrechen schreibt den Status vor dem Prozessende)
    const abgebrochen = ladeMeta(id, opts.home)?.status === 'abgebrochen';
    const m: AuftragMeta = { ...meta, status: abgebrochen ? 'abgebrochen' : code === 0 && !erg.fehler ? 'fertig' : 'fehler', ende: ladeMeta(id, opts.home)?.ende ?? new Date().toISOString(), exit: code };
    speichereMeta(m, opts.home);
    opts.beiEnde?.(m, erg);
  };
  // v1478 — Windows: Claude Code außerhalb der Prozesskette des Satelliten starten (WMI Win32_Process.Create). Ein Kind des Satelliten
  // liegt in dessen Job-Objekt und starb bei jedem Satelliten-Neustart mit (Realfall-Probe Office-VM 16.10.: Auftrag nach 19 s „fehler“).
  // Ein kleiner Starter leitet die Ausgabe ins Protokoll und schreibt den Exit-Code; Ende über Lebendprüfung, nach einem Neustart über den Wächter.
  if (process.platform === 'win32' && !opts.ohneWmi && !process.env.VITEST) {
    const exitDatei = path.join(ordner, 'exit.json');
    const pid = starteAusserhalbWindows({ befehl, args: befehlArgs, cwd: opts.projekt, log: logPfad(id, opts.home), ordner, env: zusatzEnv });
    if (pid) {
      const meta = metaVon(pid);
      speichereMeta(meta, opts.home);
      const takt = setInterval(() => {
        if (laeuft(pid)) return;
        clearInterval(takt);
        let code: number | null = null;
        try { const e = JSON.parse(readFileSync(exitDatei, 'utf8')) as { exit?: number | null }; code = typeof e.exit === 'number' ? e.exit : null; } catch { /* Starter ohne Exit-Datei beendet */ }
        abschliessen(meta, code);
      }, 2000);
      takt.unref?.();
      return meta;
    }
    // WMI nicht verfügbar → bisheriger Start (stirbt bei einem Satelliten-Neustart mit; das Selbst-Update wartet ohnehin, v1459)
  }
  const log = openSync(logPfad(id, opts.home), 'a');
  const kind = spawn(befehl, befehlArgs, { cwd: opts.projekt, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, ...zusatzEnv } });
  const meta = metaVon(kind.pid);
  speichereMeta(meta, opts.home);
  kind.on('error', (err) => {
    closeSync(log);
    const m = { ...meta, status: 'fehler' as const, ende: new Date().toISOString(), exit: null };
    speichereMeta(m, opts.home);
    opts.beiEnde?.(m, { text: '', fehler: `Start fehlgeschlagen: ${err.message}` });
  });
  kind.on('exit', (code) => {
    try { closeSync(log); } catch { /* schon zu */ }
    abschliessen(meta, code);
  });
  kind.unref();
  return meta;
}

/** v1426 — Status eines Auftrags ohne beobachtetes Prozessende: fertig nur mit erfolgreicher result-Zeile von Claude Code. */
export function statusAusProtokoll(log: string): 'fertig' | 'fehler' {
  return /"type":"result"/.test(log) && !parseErgebnis(log).fehler ? 'fertig' : 'fehler';
}

/** Stand: läuft noch?, Dauer, letzte Protokollzeilen. */
export function auftragStand(id: string, home?: string, zeilen = 15): { meta: AuftragMeta; laeuft: boolean; dauerS: number; letzteZeilen: string; werkzeuge: number } {
  const meta = ladeMeta(id, home);
  if (!meta) throw new Error(`Auftrag ${id} unbekannt`);
  const aktiv = meta.status === 'laeuft' && laeuft(meta.pid);
  let log = '';
  try { log = readFileSync(logPfad(id, home), 'utf8'); } catch { /* leer */ }
  // Satellit war zwischendurch neu gestartet (Update mitten im Auftrag), das Prozessende hat niemand gesehen.
  // v1426 — Realfall 13.10. 12:46: Claude Code war erfolgreich, Status wurde trotzdem „fehler" → das Ergebnis im Protokoll entscheidet.
  if (meta.status === 'laeuft' && !aktiv) { meta.status = statusAusProtokoll(log); meta.ende = meta.ende ?? new Date().toISOString(); speichereMeta(meta, home); }
  const fort = fortschrittAus(log, zeilen);
  const letzte = fort.schritte.length ? `${fort.werkzeuge} Werkzeugschritte bisher, zuletzt:\n${fort.schritte.join('\n')}` : log.split('\n').filter(z => z.trim()).slice(-zeilen).map(z => z.length > 300 ? `${z.slice(0, 300)}…` : z).join('\n');
  const ende = meta.ende ? new Date(meta.ende).getTime() : Date.now();
  return { meta, laeuft: aktiv, dauerS: Math.round((ende - new Date(meta.start).getTime()) / 1000), letzteZeilen: letzte, werkzeuge: fort.werkzeuge };
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

/**
 * v1459 — Owner 15.10. (Update-Sperre): Zahl der Claude-Code-Aufträge, die auf diesem Gerät gerade laufen (Status läuft und Prozess
 * lebt). Das Selbstupdate wartet, bis sie fertig sind — unter Windows läuft Claude Code nicht abgekoppelt und würde mit beendet.
 */
export function laufendeAuftraege(home?: string): number {
  const o = auftraegeOrdner(home);
  if (!existsSync(o)) return 0;
  let n = 0;
  for (const id of readdirSync(o).sort().reverse().slice(0, 50)) { const m = ladeMeta(id, home); if (m?.status === 'laeuft' && laeuft(m.pid)) n++; }
  return n;
}

/** v1512 — gleiches Verzeichnis: aufgelöster Pfad, unter Windows ohne Groß/Klein. */
export function gleichesVerzeichnis(a: string, b: string): boolean {
  const n = (p: string) => { const r = path.resolve(p).replace(/[\\/]+$/, ''); return process.platform === 'win32' ? r.toLowerCase() : r; };
  return n(a) === n(b);
}

/** v1512 P1 — laufender schreibender Auftrag (Prozess lebt) im Verzeichnis; Fragen (nur lesend, auch ältere mit FRAGE.md) zählen nicht. */
export function schreibenderImVerzeichnis(projekt: string, home?: string): AuftragMeta | undefined {
  const o = auftraegeOrdner(home);
  if (!existsSync(o)) return undefined;
  for (const id of readdirSync(o).sort().reverse().slice(0, 50)) {
    const m = ladeMeta(id, home);
    if (!m || m.status !== 'laeuft' || !laeuft(m.pid)) continue;
    if (m.nurLesen || /FRAGE\.md$/.test(m.auftragDatei ?? '')) continue;
    if (gleichesVerzeichnis(m.projekt, projekt)) return m;
  }
  return undefined;
}

export function formatiereMeta(m: AuftragMeta): string {
  const dauer = Math.round(((m.ende ? new Date(m.ende).getTime() : Date.now()) - new Date(m.start).getTime()) / 1000);
  return `${m.id} · ${m.titel} · ${m.projekt} · ${m.status} · ${dauer} s`;
}

/** v1382 — Ende melden (R1): geänderte Dateien im Projekt seit dem Start, ohne Abhängigkeiten und Build-Ordner. */
const DATEIEN_OHNE = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.dart_tool', 'target', '.turbo', 'coverage']);
export function geaenderteDateien(projekt: string, seitMs: number, opts: { max?: number; ohne?: string[] } = {}): { dateien: string[]; anzahl: number } {
  const max = opts.max ?? 20;
  const ohne = new Set((opts.ohne ?? []).map(d => path.resolve(d)));
  const treffer: string[] = [];
  let anzahl = 0, besucht = 0;
  const geh = (dir: string, tiefe: number) => {
    if (tiefe > 8 || besucht > 20_000) return;
    let eintraege: import('node:fs').Dirent[];
    try { eintraege = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of eintraege) {
      if (++besucht > 20_000) return;
      const voll = path.join(dir, e.name);
      if (e.isDirectory()) { if (!DATEIEN_OHNE.has(e.name)) geh(voll, tiefe + 1); continue; }
      if (!e.isFile() || ohne.has(path.resolve(voll))) continue;
      try { if (statSync(voll).mtimeMs >= seitMs) { anzahl++; if (treffer.length < max) treffer.push(path.relative(projekt, voll).split(path.sep).join('/')); } } catch { /* weg */ }
    }
  };
  geh(projekt, 0);
  return { dateien: treffer.sort(), anzahl };
}

/** Ereignis fürs Gehirn (Typ GeraetEreignis ohne Rahmen). Der Ergebnistext von Claude Code ist fremder Inhalt: gekürzt, nie ausgewertet. */
export function endeEreignis(m: AuftragMeta, erg: AuftragErgebnis): Record<string, unknown> {
  const status = m.status === 'laeuft' ? 'fehler' : m.status;
  const { dateien, anzahl } = geaenderteDateien(m.projekt, new Date(m.start).getTime(), { ohne: [m.auftragDatei] });
  return {
    typ: 'ereignis', art: 'auftrag', auftragId: m.id, status, titel: m.titel, projekt: m.projekt,
    text: (erg.fehler && !erg.text ? erg.fehler : erg.text).slice(0, 3000),
    ...(erg.fehler ? { fehler: erg.fehler.slice(0, 500) } : {}),
    dauerS: Math.round(((m.ende ? new Date(m.ende).getTime() : Date.now()) - new Date(m.start).getTime()) / 1000),
    ...(erg.kosten !== undefined ? { kosten: erg.kosten } : {}),
    ...(erg.sitzung ? { sitzung: erg.sitzung } : {}), // v1432
    dateien, dateienAnzahl: anzahl,
    changelogGeaendert: changelogGeaendert(m.projekt, new Date(m.start).getTime()), // v1426
  };
}

/** v1426 — wurde CHANGELOG.md (Groß/Klein egal, Projektwurzel) seit dem Start geändert? Unabhängig von der gekürzten Dateiliste. */
export function changelogGeaendert(projekt: string, seitMs: number): boolean {
  try {
    const name = readdirSync(projekt).find(x => /^changelog\.md$/i.test(x));
    return !!name && statSync(path.join(projekt, name)).mtimeMs >= seitMs;
  } catch { return false; }
}

/** Als gemeldet markieren — danach sendet der Satellit das Ende nicht noch einmal. */
export function markiereGemeldet(id: string, home?: string): void {
  const m = ladeMeta(id, home);
  if (m && !m.gemeldet) { m.gemeldet = new Date().toISOString(); speichereMeta(m, home); }
}

/**
 * Beendete, noch nicht gemeldete Aufträge (nach Verbindungsabbruch oder Neustart des Satelliten; der Claude-Prozess läuft
 * abgekoppelt weiter und kann ohne Exit-Handler enden). Ein toter Prozess mit Status „läuft" wird aus dem Protokoll bestimmt.
 * Aufträge älter als 7 Tage werden nicht mehr nachgemeldet.
 */
export function offeneEndmeldungen(home?: string, jetzt = Date.now()): Array<{ meta: AuftragMeta; ergebnis: AuftragErgebnis }> {
  const o = auftraegeOrdner(home);
  if (!existsSync(o)) return [];
  const aus: Array<{ meta: AuftragMeta; ergebnis: AuftragErgebnis }> = [];
  for (const id of readdirSync(o).sort()) {
    const m = ladeMeta(id, home);
    if (!m || m.gemeldet || jetzt - new Date(m.start).getTime() > 7 * 86_400_000) continue;
    if (m.status === 'laeuft' && laeuft(m.pid)) continue;
    let log = '';
    try { log = readFileSync(logPfad(id, home), 'utf8'); } catch { /* leer */ }
    const erg = parseErgebnis(log);
    if (m.status === 'laeuft') {
      m.status = erg.fehler ? 'fehler' : 'fertig';
      let bis = jetzt; try { bis = statSync(logPfad(id, home)).mtimeMs; } catch { /* kein Protokoll */ }
      m.ende = m.ende ?? new Date(bis).toISOString();
      speichereMeta(m, home);
    }
    aus.push({ meta: m, ergebnis: erg });
  }
  return aus;
}

/**
 * v1392 — Fortschritt aus dem stream-json-Protokoll von Claude Code: eine Zeile je Werkzeugschritt bzw. Zwischentext,
 * die letzten `n`. Owner 12.10.: „wo sieht man, dass etwas läuft?" — vorher stand im Protokoll bis zum Ende nichts.
 * Fremdinhalt (Befehle, Texte) wird gekürzt, nie ausgeführt.
 */
export function fortschrittAus(protokoll: string, n = 10): { schritte: string[]; werkzeuge: number } {
  const schritte: string[] = [];
  let werkzeuge = 0;
  const kurz = (t: unknown, max = 90) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max)}…` : s; };
  const datei = (p: unknown) => { const s = String(p ?? ''); return s.split(/[\\/]/).slice(-2).join('/'); };
  for (const z of protokoll.split('\n')) {
    const t = z.trim();
    if (!t.startsWith('{')) continue;
    let j: { type?: string; message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }> } };
    try { j = JSON.parse(t); } catch { continue; }
    if (j.type !== 'assistant') continue;
    for (const b of j.message?.content ?? []) {
      if (b.type === 'text' && b.text?.trim()) schritte.push(`💬 ${kurz(b.text, 120)}`);
      if (b.type !== 'tool_use') continue;
      werkzeuge++;
      const i = b.input ?? {};
      switch (b.name) {
        case 'Write': schritte.push(`✏️ schreibt ${datei(i.file_path)}`); break;
        case 'Edit': case 'MultiEdit': schritte.push(`✏️ ändert ${datei(i.file_path)}`); break;
        case 'Read': schritte.push(`📖 liest ${datei(i.file_path)}`); break;
        case 'Bash': schritte.push(`▶ ${kurz(i.command)}`); break;
        case 'Glob': case 'Grep': schritte.push(`🔎 sucht ${kurz(i.pattern, 60)}`); break;
        case 'TodoWrite': schritte.push('📝 aktualisiert die Aufgabenliste'); break;
        default: schritte.push(`🔧 ${kurz(b.name, 40)}`);
      }
    }
  }
  return { schritte: schritte.slice(-n), werkzeuge };
}

/**
 * v1396 — neues Projektverzeichnis als Git-Repository anlegen (Owner 12.10.: „git init automatisch freigegeben"). Die Etappen-
 * Aufträge committen bereits, sobald ein Repository da ist. Nur für Verzeichnisse, die der Satellit selbst neu angelegt hat:
 * - liegt das Verzeichnis schon in einem Repository (neuer Unterordner eines Projekts), KEIN verschachteltes Repository;
 * - .gitignore gegen Abhängigkeiten und Geheimnisse (node_modules, .env) — sonst landen sie im ersten Etappen-Commit;
 * - fehlt eine Git-Identität, eine lokale für dieses Repository (sonst scheitern die Commits still);
 * - ohne installiertes Git oder bei Fehlern: weiter ohne Repository (der Auftrag läuft trotzdem).
 */
function gitLauf(git: string, dir: string, args: string[], timeoutMs = 15_000, env?: Record<string, string>): string {
  return execFileSync(git, ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) }).toString().trim();
}

/**
 * v1456 — Commits des Satelliten (Etappenprotokoll, verschobene Aufträge) in einem Repository ohne Git-Identität. Realfall 15.10.
 * (Probe-Repo ohne user.email): „Identität des Autors unbekannt“, die Protokolle blieben nur gestaget. Autor „Alfred“ nur für diesen
 * Aufruf über die Umgebung — die Konfiguration des Repos bleibt unverändert; eine vorhandene Identität gilt wie bisher.
 */
export function identitaetUmgebung(dir: string, git = 'git'): Record<string, string> {
  let email = '';
  try { email = gitLauf(git, dir, ['config', 'user.email']); } catch { /* keine Identität */ }
  if (email) return {};
  const e = `alfred@${os.hostname()}.local`;
  return { GIT_AUTHOR_NAME: 'Alfred', GIT_AUTHOR_EMAIL: e, GIT_COMMITTER_NAME: 'Alfred', GIT_COMMITTER_EMAIL: e };
}

/** Schutzzeilen der .gitignore; fehlende werden an eine vorhandene angehängt. */
const GIT_IGNORE = ['node_modules/', '.env', '.env.*', '!.env.example', '*.log'];

export function gitAnlegen(dir: string, git = 'git'): 'angelegt' | 'schon-repository' | 'ohne-git' {
  const lauf = (args: string[]) => gitLauf(git, dir, args);
  try { lauf(['--version']); } catch { return 'ohne-git'; }
  try { if (lauf(['rev-parse', '--is-inside-work-tree']) === 'true') return 'schon-repository'; } catch { /* kein Repository: anlegen */ }
  try {
    lauf(['init', '-q']);
    const ignore = path.join(dir, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, [...GIT_IGNORE, ''].join('\n'));
    else {
      // v1397 — vorhandene .gitignore des Owners bleibt, fehlende Schutzzeilen kommen dazu
      const da = new Set(readFileSync(ignore, 'utf8').split(/\r?\n/).map(z => z.trim()));
      const fehlt = GIT_IGNORE.filter(z => !da.has(z));
      if (fehlt.length) appendFileSync(ignore, `\n# Alfred: Abhängigkeiten und Geheimnisse nicht ins Repository\n${fehlt.join('\n')}\n`);
    }
    let email = '';
    try { email = lauf(['config', 'user.email']); } catch { /* keine Identität */ }
    if (!email) { lauf(['config', 'user.name', 'Alfred']); lauf(['config', 'user.email', `alfred@${os.hostname()}.local`]); }
    return 'angelegt';
  } catch { return 'ohne-git'; }
}

export interface GitUebernahme { status: 'angelegt' | 'schon-repository' | 'ohne-git'; commit?: string; grosse: string[]; fehler?: string }

/**
 * v1397 — bestehendes Projektverzeichnis ohne Git übernehmen (Owner 12.10.: „ja so bauen, freigegeben"): Repository anlegen
 * (gitAnlegen) und den vorhandenen Stand als Ausgangs-Commit „Stand vor Alfred" sichern — danach zeigt jede Etappe genau,
 * was Claude Code am bestehenden Code geändert hat. Dateien über `maxBytes` kommen nicht ins Repository (in die .gitignore,
 * werden gemeldet). Nur für Projekte: deren Planfrage nennt den Schritt, die Owner-Freigabe deckt ihn.
 */
export function gitUebernehmen(dir: string, git = 'git', maxBytes = 10 * 1024 * 1024): GitUebernahme {
  const status = gitAnlegen(dir, git);
  if (status !== 'angelegt') return { status, grosse: [] };
  const lauf = (args: string[], t?: number) => gitLauf(git, dir, args, t);
  try {
    lauf(['add', '-A'], 120_000);
    const namen = lauf(['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
    const grosse = namen.filter(n => n !== '.gitignore').filter(n => { try { return statSync(path.join(dir, n)).size > maxBytes; } catch { return false; } });
    if (grosse.length) {
      lauf(['rm', '--cached', '-q', '--', ...grosse]);
      appendFileSync(path.join(dir, '.gitignore'), `\n# Alfred: zu groß für Git (über ${Math.round(maxBytes / 1024 / 1024)} MB)\n${grosse.map(n => `/${n}`).join('\n')}\n`);
      lauf(['add', '.gitignore']);
    }
    if (!lauf(['diff', '--cached', '--name-only'])) return { status, grosse };
    lauf(['commit', '-q', '-m', 'Stand vor Alfred'], 120_000);
    return { status, grosse, commit: lauf(['rev-parse', '--short', 'HEAD']) };
  } catch (err) {
    return { status, grosse: [], fehler: (err as Error).message.slice(0, 200) };
  }
}

export interface ProjektBestand { readme?: string; paket?: string; baum: string[]; commits: Array<{ sha: string; message: string; files: string[] }>; git: boolean; /** v1408 R3a */ umgebung?: Umgebung; /** v1453 — vor dem Lauf vorgefundene, nicht eingecheckte Änderungen */ offen?: string[] }

/**
 * v1453 — `git status --porcelain=v1 -z` in Zeilen „<pfad> (<art>)“; Alfreds eigene Dateien (.alfred/, .alfred-anhaenge/, AUFTRAG-*.md)
 * zählen nicht (Realfall 14.10.: vom Owner gelöschte SPAR-Dokumente fielen erst im Bericht von Etappe 1 auf).
 */
export function offeneAenderungen(roh: string, max = 40): string[] {
  const teile = roh.split('\0');
  const z: string[] = [];
  for (let i = 0; i < teile.length; i++) {
    const t = teile[i]!;
    if (t.length < 4) continue;
    const xy = t.slice(0, 2);
    const pfad = t.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // -z: bei Umbenennung folgt der alte Pfad als eigener Eintrag
    if (/^\.alfred(-anhaenge)?\//.test(pfad) || /^AUFTRAG-[\w-]+\.md$/.test(pfad)) continue;
    const art = xy === '??' ? 'neu, nicht eingecheckt' : xy.includes('D') ? 'gelöscht' : xy[0] === 'R' ? 'umbenannt' : xy[0] === 'A' ? 'hinzugefügt' : 'geändert';
    // v1454 — Dateinamen sind fremde Daten: ohne Steuerzeichen/Zeilenumbrüche/Backticks, gekürzt (sonst falsche Zeilen in Startfrage und Auftrag)
    z.push(`${pfad.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029`]/g, '?').slice(0, 160)} (${art})`);
  }
  return z.length > max ? [...z.slice(0, max), `… und ${z.length - max} weitere`] : z;
}

/**
 * v1398 — Spec „Projekte sichtbar und fortsetzbar" P2: Bestand eines Projektordners nur lesend — README (≤ 4 KB), Paket und
 * Skripte, Struktur (Tiefe 2, ohne Abhängigkeiten/Build), letzte 10 Commits. Grundlage für „weiter" (Planer) und die Akte.
 */
export function projektLesen(dir: string, git = 'git'): ProjektBestand {
  const liesText = (p: string, max: number): string | undefined => {
    try { const st = statSync(p); if (!st.isFile() || st.size > 2_000_000) return undefined; const t = readFileSync(p, 'utf8'); return t.includes('\u0000') ? undefined : t.slice(0, max); } catch { return undefined; }
  };
  let readme: string | undefined;
  for (const n of ['README.md', 'readme.md', 'Readme.md', 'README', 'docs/README.md']) { readme = liesText(path.join(dir, n), 4000); if (readme) break; }
  let paket: string | undefined;
  const pj = liesText(path.join(dir, 'package.json'), 200_000);
  if (pj) {
    try { const j = JSON.parse(pj) as { name?: string; description?: string; scripts?: Record<string, string> }; paket = [j.name && `name: ${j.name}`, j.description && `beschreibung: ${j.description}`, ...Object.entries(j.scripts ?? {}).map(([k, v]) => `npm run ${k}: ${v}`)].filter(Boolean).join('\n').slice(0, 1000); } catch { paket = pj.slice(0, 1000); }
  } else {
    for (const n of ['pyproject.toml', 'Cargo.toml', 'pubspec.yaml', 'go.mod']) { const t = liesText(path.join(dir, n), 1000); if (t) { paket = `${n}:\n${t}`; break; } }
  }
  const baum: string[] = [];
  const geh = (rel: string, tiefe: number) => {
    let namen: string[] = [];
    try { namen = readdirSync(path.join(dir, rel)).sort(); } catch { return; }
    for (const n of namen) {
      if (baum.length >= 150) return;
      if (DATEIEN_OHNE.has(n) || (n.startsWith('.') && n !== '.gitignore') || /^AUFTRAG-.*\.md$/.test(n)) continue;
      const r = rel ? `${rel}/${n}` : n;
      let ordner = false;
      try { ordner = statSync(path.join(dir, r)).isDirectory(); } catch { continue; }
      baum.push(ordner ? `${r}/` : r);
      if (ordner && tiefe < 2) geh(r, tiefe + 1);
    }
  };
  geh('', 1);
  let istGit = false;
  const commits: ProjektBestand['commits'] = [];
  try {
    istGit = gitLauf(git, dir, ['rev-parse', '--is-inside-work-tree']) === 'true';
    if (istGit) {
      const log = gitLauf(git, dir, ['log', '-n', '10', '--name-only', '--format=%x01%h%x02%s']);
      for (const block of log.split('\u0001').filter(Boolean)) {
        const [kopf, ...rest] = block.split('\n');
        const [sha, message] = (kopf ?? '').split('\u0002');
        if (sha) commits.push({ sha: sha.trim(), message: (message ?? '').trim(), files: rest.map(z => z.trim()).filter(Boolean).slice(0, 20) });
      }
    }
  } catch { /* kein Git oder noch keine Commits */ }
  let offen: string[] = [];
  if (istGit) {
    // ohne trim(): die erste Zeile beginnt bei „ D …“ mit einem Leerzeichen
    try { offen = offeneAenderungen(execFileSync(git, ['-C', dir, 'status', '--porcelain=v1', '-z'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }).toString()); } catch { /* ohne Status */ }
  }
  return { ...(readme ? { readme } : {}), ...(paket ? { paket } : {}), baum, commits, git: istGit, umgebung: umgebungLesen(dir), ...(offen.length ? { offen } : {}) };
}

/** v1404 — Werkzeuge, die eine Frage zum Projekt nicht hat (Nachweis VM 13.10. 00:02: Datei unverändert, nichts angelegt, git status leer). */
export const NUR_LESEN_GESPERRT = 'Edit Write MultiEdit NotebookEdit Bash';

/**
 * v1392/v1394/v1395 — Argumente für `claude -p`: stream-json (Fortschritt), ohne Benutzereinstellungen und fremde MCP-Server;
 * v1404 — nurLesen: Plan-Modus (nur lesen) UND Schreib-/Shell-Werkzeuge gesperrt — technisch keine Änderung möglich.
 */
/** v1409 R3b — Regel, die sudo in Bau-Aufträgen sperrt (Nachweis VM 13.10. 01:06: ohne Regel legte sudo eine root-Datei an, mit Regel abgelehnt). */
export const SUDO_GESPERRT = 'Bash(sudo:*)';

export function argumenteFuer(o: { prompt: string; nurLesen: boolean; maxKostenUsd?: number; sudoSperre?: boolean; sitzung?: string }): string[] {
  return ['-p', o.prompt, '--output-format', 'stream-json', '--verbose',
    ...(o.sitzung && /^[0-9a-f-]{8,64}$/i.test(o.sitzung) ? ['--resume', o.sitzung] : []), // v1432 — Folgefrage
    '--permission-mode', o.nurLesen ? 'plan' : 'auto',
    ...(o.nurLesen ? ['--disallowedTools', NUR_LESEN_GESPERRT] : o.sudoSperre ? ['--disallowedTools', SUDO_GESPERRT] : []),
    '--setting-sources', 'project,local', '--strict-mcp-config',
    ...(o.maxKostenUsd !== undefined && o.maxKostenUsd > 0 ? ['--max-budget-usd', String(o.maxKostenUsd)] : [])];
}

/** v1404 — Prompt für eine Frage zum Projekt (Frage als Text; Claude Code liest im Projektverzeichnis und antwortet). */
/**
 * v1424 — Anhang des Owners ins Projekt legen (für Frage und Weiterarbeit): `<projekt>/.alfred-anhaenge/<ordner>/<name>`,
 * Ordner lokal von git ausgeschlossen (.git/info/exclude, nie .gitignore des Projekts), überschreibt nie. Rückgabe: relativer Pfad.
 */
export function anhangInsProjekt(projekt: string, ordner: string, name: string, inhalt: Buffer, eindeutig: (wunsch: string, belegt: (n: string) => boolean) => string): string {
  const sicherOrdner = ordner.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'anhang';
  const sicherName = path.basename(name).replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'anhang';
  const ziel = path.join(projekt, '.alfred-anhaenge', sicherOrdner);
  mkdirSync(ziel, { recursive: true });
  const n = eindeutig(sicherName, x => existsSync(path.join(ziel, x)));
  writeFileSync(path.join(ziel, n), inhalt, { flag: 'wx' });
  const exclude = path.join(projekt, '.git', 'info', 'exclude');
  try {
    if (existsSync(path.join(projekt, '.git'))) {
      const alt = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
      if (!alt.split(/\r?\n/).includes('.alfred-anhaenge/')) { mkdirSync(path.dirname(exclude), { recursive: true }); appendFileSync(exclude, `${alt && !alt.endsWith('\n') ? '\n' : ''}.alfred-anhaenge/\n`); }
    }
  } catch { /* Ausschluss ist Komfort — die Datei liegt trotzdem */ }
  return path.posix.join('.alfred-anhaenge', sicherOrdner, n);
}

/** v1425 — Protokoll eines Projektlaufs im Projekt: Auftrag und Bericht je Etappe; an = mit committen, aus = nur lokal (git-Ausschluss). */
export interface ProtokollAngabe { lauf: string; nr: number; fix?: number; an: boolean }

const PROTOKOLL_AUSSCHLUSS = '.alfred/laeufe/';

export function protokollOrdner(projekt: string, lauf: string): string {
  return path.join(projekt, '.alfred', 'laeufe', lauf.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || 'lauf');
}

/** Ausschluss in .git/info/exclude (nie .gitignore des Projekts): aus → Zeile da, an → Zeile weg. Ohne git: nichts. */
export function protokollAusschluss(projekt: string, an: boolean): void {
  if (!existsSync(path.join(projekt, '.git'))) return;
  const datei = path.join(projekt, '.git', 'info', 'exclude');
  const alt = existsSync(datei) ? readFileSync(datei, 'utf8') : '';
  const zeilen = alt.split(/\r?\n/);
  const hat = zeilen.includes(PROTOKOLL_AUSSCHLUSS);
  if (!an && !hat) { mkdirSync(path.dirname(datei), { recursive: true }); appendFileSync(datei, `${alt && !alt.endsWith('\n') ? '\n' : ''}${PROTOKOLL_AUSSCHLUSS}\n`); }
  if (an && hat) writeFileSync(datei, zeilen.filter(z => z !== PROTOKOLL_AUSSCHLUSS).join('\n'));
}

/** Frühere Auftragsdateien (AUFTRAG-*.md in der Projektwurzel) einmalig nach .alfred/laeufe/frueher/ — überschreibt nie. */
export function alteAuftraegeVerschieben(projekt: string): number {
  let n = 0;
  let namen: string[] = [];
  try { namen = readdirSync(projekt).filter(x => /^AUFTRAG-[\w-]+\.md$/.test(x)); } catch { return 0; }
  if (!namen.length) return 0;
  const ziel = path.join(projekt, '.alfred', 'laeufe', 'frueher');
  mkdirSync(ziel, { recursive: true });
  for (const x of namen) { if (existsSync(path.join(ziel, x))) continue; try { renameSync(path.join(projekt, x), path.join(ziel, x)); n++; } catch { /* bleibt liegen */ } }
  return n;
}

/**
 * v1448 — die Verschiebung früherer AUFTRAG-*.md auch committen (Befund 13.10.: 23 Einträge in git status bei Angebots-Radar).
 * Nur Dateien, deren Kopie in .alfred/laeufe/frueher liegt; nur diese Pfade. Protokoll an → Verschiebung (gelöscht + neu);
 * Protokoll aus → nur das Entfernen aus der Wurzel (die Dateien bleiben lokal im ausgeschlossenen Ordner). Holt Altfälle nach.
 */
export function auftraegeVerschiebungCommitten(projekt: string, an: boolean, git = 'git'): number {
  const id = identitaetUmgebung(projekt, git); // v1456
  const lauf = (args: string[]) => gitLauf(git, projekt, args, 15_000, id);
  try { if (lauf(['rev-parse', '--is-inside-work-tree']) !== 'true') return 0; } catch { return 0; }
  const geloescht = lauf(['ls-files', '--deleted', '--', 'AUFTRAG-*.md']).split('\n').map(x => x.trim())
    .filter(f => /^AUFTRAG-[\w-]+\.md$/.test(f) && existsSync(path.join(projekt, '.alfred', 'laeufe', 'frueher', f)));
  if (!geloescht.length) return 0;
  const neu = an ? geloescht.map(f => `.alfred/laeufe/frueher/${f}`) : [];
  lauf(['add', '-A', '--', ...geloescht, ...neu]);
  lauf(['commit', '-q', '-m', `chore(alfred): ${geloescht.length} frühere Auftragsdatei(en) nach .alfred/laeufe/frueher verschoben`, '--', ...geloescht, ...neu]);
  return geloescht.length;
}

function freierName(ordner: string, wunsch: string): string {
  if (!existsSync(path.join(ordner, wunsch))) return wunsch;
  const basis = wunsch.replace(/\.md$/, '');
  for (let i = 2; i < 100; i++) { const n = `${basis}-${i}.md`; if (!existsSync(path.join(ordner, n))) return n; }
  return `${basis}-${Date.now()}.md`;
}

export function protokollAuftragDatei(projekt: string, p: ProtokollAngabe): string {
  alteAuftraegeVerschieben(projekt);
  protokollAusschluss(projekt, p.an);
  try { auftraegeVerschiebungCommitten(projekt, p.an); } catch { /* ohne Git oder ohne Identität: bleibt wie bisher */ }
  const ordner = protokollOrdner(projekt, p.lauf);
  mkdirSync(ordner, { recursive: true });
  return path.join(ordner, freierName(ordner, `etappe-${Math.max(1, Math.floor(p.nr))}${p.fix ? `-fix${Math.floor(p.fix)}` : ''}-auftrag.md`));
}

/**
 * Bericht einer Etappe schreiben (geschwärzt, ersetzt den Bericht derselben Etappe) und — wenn an und git vorhanden — NUR den
 * Protokollordner des Laufs committen (`git commit -- <ordner>`; andere Änderungen im Index bleiben unberührt).
 */
export function protokollSchreiben(projekt: string, p: { lauf: string; nr: number; an: boolean; bericht: string; nachricht: string }): { pfad: string; commit?: string; hinweis?: string } {
  protokollAusschluss(projekt, p.an);
  const ordner = protokollOrdner(projekt, p.lauf);
  mkdirSync(ordner, { recursive: true });
  const datei = path.join(ordner, `etappe-${Math.max(1, Math.floor(p.nr))}-bericht.md`);
  writeFileSync(datei, schwaerze(p.bericht).slice(0, 200_000));
  const rel = path.relative(projekt, ordner).split(path.sep).join('/');
  const pfad = path.relative(projekt, datei).split(path.sep).join('/');
  if (!existsSync(path.join(projekt, '.git'))) return { pfad, hinweis: p.an ? 'kein git im Projekt' : 'nur lokal (Protokoll im Projekt aus)' };
  const id = identitaetUmgebung(projekt); // v1456 — ohne Identität im Repo scheiterte der Commit
  const git = (args: string[]) => spawnSync('git', args, { cwd: projekt, encoding: 'utf8', timeout: 30_000, windowsHide: true, env: { ...process.env, ...id } });
  // v1448 — die von Alfred angelegte .gitignore mitsichern, falls noch untracked (Befund 13.10.: blieb in neuen Projekten liegen).
  // Neue Projekte bekommen bewusst keinen eigenen Anlege-Commit (v1397); das erste Etappenprotokoll nimmt sie mit.
  const ignore = (git(['ls-files', '--others', '--exclude-standard', '--', '.gitignore']).stdout ?? '').trim() ? ['.gitignore'] : [];
  if (!p.an) {
    if (ignore.length && git(['add', '--', '.gitignore']).status === 0) git(['commit', '-q', '-m', 'chore(alfred): .gitignore (Abhängigkeiten und Geheimnisse ausschließen)', '--', '.gitignore']);
    return { pfad, hinweis: 'nur lokal (Protokoll im Projekt aus)' };
  }
  const a = git(['add', '--', rel, ...ignore]);
  if (a.status !== 0) return { pfad, hinweis: `git add: ${(a.stderr || '').trim().slice(0, 200)}` };
  const c = git(['commit', '-q', '-m', p.nachricht.slice(0, 200), '--', rel, ...ignore]);
  if (c.status !== 0) return { pfad, hinweis: /nothing (added )?to commit|nichts zu committen/i.test(`${c.stdout}${c.stderr}`) ? 'nichts Neues zu committen' : `git commit: ${(c.stderr || c.stdout || '').trim().slice(0, 200)}` };
  const h = git(['rev-parse', '--short', 'HEAD']);
  return { pfad, ...(h.status === 0 ? { commit: h.stdout.trim() } : {}) };
}

export function fragePrompt(frage: string, projekt: string): string {
  return `Beantworte eine Frage zum Projekt im Verzeichnis ${projekt}. Lies dafür, was du brauchst (README, Code, Konfiguration), ändere aber nichts. Antworte auf Deutsch, knapp und konkret, mit Dateinamen und Zeilen, wo hilfreich. Geheimnisse (Schlüssel, Passwörter, Tokens) nie wörtlich wiedergeben.\n\nFrage: ${frage.trim()}`;
}

/** v1407 — Titel aus Freitext: erste Zeile, an einer Wortgrenze gekürzt mit „…" (Realfall 13.10.: „… in welcher Datei steht die"). */
export function kurzTitel(text: string, max: number): string {
  const z = text.split('\n')[0]!.trim().replace(/\s+/g, ' ');
  if (z.length <= max) return z;
  const schnitt = z.slice(0, max - 1);
  const wort = schnitt.lastIndexOf(' ');
  return `${(wort > max * 0.6 ? schnitt.slice(0, wort) : schnitt).replace(/[\s,;:.\-–]+$/, '')}…`;
}

/** v1408 — R3a: Umgebung des Geräts (Owner 13.10. „ja wie empfohlen"): Betriebssystem, Werkzeug-Versionen, freier Platz. */
export interface Umgebung { os: string; werkzeuge: Record<string, string | null>; freiGb?: number }

const WIN = process.platform === 'win32';
/** Werkzeuge und ihr Versionsaufruf (Name → Befehl, Argumente). */
export const UMGEBUNG_WERKZEUGE: Array<[string, string, string[]]> = [
  ['node', 'node', ['-v']], ['npm', 'npm', ['-v']], ['pnpm', 'pnpm', ['-v']], ['yarn', 'yarn', ['-v']],
  ['python', WIN ? 'python' : 'python3', ['--version']], ['pip', WIN ? 'pip' : 'pip3', ['--version']],
  ['docker', 'docker', ['--version']], ['git', 'git', ['--version']], ['java', 'java', ['-version']],
  ['go', 'go', ['version']], ['cargo', 'cargo', ['--version']], ['flutter', 'flutter', ['--version', '--suppress-analytics']],
  ...(process.platform === 'darwin' ? [['brew', 'brew', ['--version']] as [string, string, string[]]] : process.platform === 'linux' ? [['apt', 'apt-get', ['--version']] as [string, string, string[]]] : [['winget', 'winget', ['--version']] as [string, string, string[]]]),
];

/** Version aus der Ausgabe (`v22.23.3`, `Python 3.12.3`, `openjdk version "21.0.4"`) — null, wenn keine erkennbar. */
export function versionAus(ausgabe: string): string | null {
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(ausgabe);
  return m ? m[1]! : null;
}

let umgebungCache: { zeit: number; u: Umgebung } | undefined;
/** Versionen je Werkzeug (je höchstens 8 s, fehlend = null), 10 min zwischengespeichert. `lauf` für Tests. */
export function umgebungLesen(dir: string, lauf?: (cmd: string, args: string[]) => string | null): Umgebung {
  if (!lauf && umgebungCache && Date.now() - umgebungCache.zeit < 600_000) return umgebungCache.u;
  const ausfuehren = lauf ?? ((cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8_000, windowsHide: true, shell: WIN });
    return r.status === 0 || (r.stdout || r.stderr) && !r.error && r.status !== null && r.status !== 127 && !/not recognized|nicht als|command not found/i.test(`${r.stderr}`) ? `${r.stdout ?? ''}\n${r.stderr ?? ''}` : null;
  });
  const werkzeuge: Record<string, string | null> = {};
  for (const [name, cmd, args] of UMGEBUNG_WERKZEUGE) { const a = ausfuehren(cmd, args); werkzeuge[name] = a === null ? null : (versionAus(a) ?? 'vorhanden'); }
  let osName = `${os.type()} ${os.release()}`;
  try { if (process.platform === 'linux') { const m = /PRETTY_NAME="([^"]+)"/.exec(readFileSync('/etc/os-release', 'utf8')); if (m) osName = m[1]!; } else if (process.platform === 'darwin') osName = `macOS ${os.release()}`; } catch { /* Standard */ }
  let freiGb: number | undefined;
  try { const st = statfsSync(existsSync(dir) ? dir : os.homedir()); freiGb = Math.round((st.bavail * st.bsize) / 1e9); } catch { /* unbekannt */ }
  const u: Umgebung = { os: osName, werkzeuge, ...(freiGb !== undefined ? { freiGb } : {}) };
  if (!lauf) umgebungCache = { zeit: Date.now(), u };
  return u;
}

/** v1410 — nach einer Installation die zwischengespeicherte Umgebung verwerfen. */
export function umgebungNeu(): void { umgebungCache = undefined; }

/**
 * v1417 G1 — „Was hat sich geändert?": Statistik eines Commits und auf Wunsch der Diff einer Datei (nur lesend, gekürzt).
 * Commit-Kennung und Dateipfad werden geprüft (keine Optionen, kein .., kein absoluter Pfad).
 */
export function projektDiff(dir: string, commit: string, datei?: string, git = 'git'): { ok: true; text: string } | { ok: false; fehler: string } {
  if (!/^[0-9a-f]{4,40}$/i.test(commit)) return { ok: false, fehler: 'commit ungültig' };
  if (datei !== undefined && (!datei || datei.startsWith('-') || /(^|[\\/])\.\.([\\/]|$)/.test(datei) || path.isAbsolute(datei))) return { ok: false, fehler: 'datei ungültig' };
  try {
    const text = datei
      ? gitLauf(git, dir, ['show', '--format=%h %s', commit, '--', datei], 30_000)
      : gitLauf(git, dir, ['show', '--stat', '--format=%h %s%n%n%b', commit], 30_000);
    return { ok: true, text: text.length > 12_000 ? `${text.slice(0, 12_000)}\n… (gekürzt)` : text };
  } catch (err) { return { ok: false, fehler: (err as Error).message.slice(0, 200) }; }
}

/** v1418 G2 — mögliche Geheimnisse in Befehlen/Texten schwärzen, bevor Schritte das Gerät verlassen. */
export function schwaerze(t: string): string {
  return t
    .replace(/(bearer\s+)[^\s"']+/gi, '$1***')
    .replace(/((?:token|passwor[dt]|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|auth)[^\s=:]*\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"']+)/gi, '$1***')
    .replace(/(:\/\/[^:\s/]+:)[^@\s]+@/g, '$1***@');
}

/** v1418 G2 — Fortschritt eines Auftrags aus seinem Protokoll (letzte n Schritte, geschwärzt) und ob er noch läuft. */
export function fortschrittVon(id: string, n = 8, home?: string): { laeuft: boolean; schritte: string[]; werkzeuge: number } {
  const meta = ladeMeta(id, home);
  let log = '';
  try { log = readFileSync(logPfad(id, home), 'utf8'); } catch { /* leer */ }
  const f = fortschrittAus(log, n);
  return { laeuft: meta?.status === 'laeuft' && laeuft(meta.pid), schritte: f.schritte.map(schwaerze), werkzeuge: f.werkzeuge };
}
