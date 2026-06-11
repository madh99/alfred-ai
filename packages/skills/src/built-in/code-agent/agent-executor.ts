import { spawn, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CodeAgentDefinitionConfig } from '@alfred/types';
import { appendOutputLine } from './project-agent-skill.js';
import { killAgentTree } from './process-tree.js';
import { createParserState, parseLine, type AgentOutputFormat } from './agent-output-parser.js';

// v635 — Default auf 12min angehoben (war 10min v625). Praxisbefund Phase 24
// (Datenmodell/Migration): claude-code ging 600s lang stdout-stumm obwohl
// Dateien geschrieben wurden — stdout-Buffering oder lange interne Tool-Calls.
// Wichtiger als Default-Bump ist der File-mtime-Heartbeat unten.
const DEFAULT_TIMEOUT_MS = 720_000; // 12 minutes — used as inactivity threshold by default
// v626 — Ceiling 15→30min. v624 D wollte 20min für Long-Phases (npm install +
// build + lint + typecheck + test als ein Block); die alte 15min-Decke clampte
// den Wert intern auf 15min, wodurch das v624-Versprechen nicht eingelöst wurde.
// Mit 30min Ceiling wirkt das 20min-Long-Phase-Setting wirklich, plus Buffer.
const MAX_TIMEOUT_MS = 1_800_000; // 30 minutes — used as inactivity threshold ceiling
const MAX_OUTPUT_CHARS = 100_000;
/** v619 D0 — Absolute safety cap. Sliding inactivity timer can extend indefinitely
 *  if the subprocess keeps producing output, but we never want a single agent
 *  invocation to run longer than this regardless of activity.
 *
 *  v853 — von 60min auf 4h erhöht. Realistische Multi-Phase-Refactors mit
 *  Build/Test-Cycles laufen oft 1-3h legitim. Inaktivitäts-Timer (default
 *  10min für code/project agents) bleibt die primäre Schutzlinie — der
 *  ABSOLUTE_CAP fängt nur den seltenen "active-but-wedged" Fall ab.
 *  Override via ENV `ALFRED_AGENT_EXECUTOR_ABSOLUTE_CAP_MS`. */
const ABSOLUTE_CAP_MS = (() => {
  const envVal = process.env['ALFRED_AGENT_EXECUTOR_ABSOLUTE_CAP_MS'];
  if (envVal) {
    const n = Number.parseInt(envVal, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 4 * 60 * 60 * 1000; // 4 hours
})();

/**
 * v608 F5 — Preflight: check the agent's binary is callable before spawning.
 * If it's missing we want a clear actionable error, not a 10-minute idle hang
 * (claude-code sometimes exits silently with no output when the binary is unreachable).
 */
function preflightAgent(agentDef: CodeAgentDefinitionConfig): string | null {
  // For `sudo -u <user> <real-command> ...` we want to check the real binary,
  // not `sudo` itself.
  let probeCommand = agentDef.command;
  let probeArgs: string[] = [];
  if (agentDef.command === 'sudo' && Array.isArray(agentDef.argsTemplate)) {
    const sudoArgs = [...agentDef.argsTemplate];
    let i = 0;
    while (i < sudoArgs.length && sudoArgs[i].startsWith('-')) {
      if (sudoArgs[i] === '-u' || sudoArgs[i] === '--user') { i += 2; continue; }
      i += 1;
    }
    if (i < sudoArgs.length) probeCommand = sudoArgs[i];
  }
  if (process.platform === 'win32') return null; // skip on Windows — shell:true handles wrappers
  if (path.isAbsolute(probeCommand)) {
    return fs.existsSync(probeCommand) ? null : `Agent binary nicht gefunden: ${probeCommand}`;
  }
  try {
    const result = spawnSync('which', [probeCommand], { timeout: 3000, encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout?.trim()) {
      return `Agent binary "${probeCommand}" nicht im PATH (\`which ${probeCommand}\` exit=${result.status}). ` +
        `Prüfe Installation oder agents.command in Config.`;
    }
    return null;
  } catch {
    return null; // best-effort — don't block on the preflight itself
  }
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', '.cache']);

/**
 * v844 — Expandiert `~` und `$HOME` zu absolutem Pfad. Wird für
 * `additionalHeartbeatPaths` benötigt damit configs Pfade wie
 * `~/.claude/projects` schreiben können.
 */
function expandHome(p: string): string {
  const home = os.homedir();
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p.replace(/\$HOME/g, home);
}

/**
 * v844 — Backwards-compat upgrade für agent-defs aus pre-v844 configs.
 *
 * Bestehende Installations (z.B. /root/alfred/config/default.yml auf .92)
 * haben claude/codex/vibe mit Default-Output-Mode (text). Bei langen Phasen
 * → 600s stdout-Stille → unfairer kill (siehe v844 changelog).
 *
 * Statt user-configs zu mutieren, detecten wir den Agent-Typ am `command`
 * und injecten Stream-Flags + outputFormat IN-MEMORY. User-config bleibt
 * unverändert; expliziter outputFormat in config überschreibt die Detection.
 */
function upgradeAgentDef(def: CodeAgentDefinitionConfig): CodeAgentDefinitionConfig {
  if (def.outputFormat) return def; // user has explicit setting — respect it
  const tpl = Array.isArray(def.argsTemplate) ? def.argsTemplate : [];

  const isClaude = tpl.includes('claude') || /^|\/claude($|\s)/.test(def.command);
  const isCodex  = tpl.includes('codex')  || /^|\/codex($|\s)/.test(def.command);
  const isVibe   = tpl.includes('vibe')   || /^|\/vibe($|\s)/.test(def.command);

  if (!isClaude && !isCodex && !isVibe) return def;

  const updated: CodeAgentDefinitionConfig = { ...def, argsTemplate: [...tpl] };
  const hasFlag = (flag: string) => updated.argsTemplate.includes(flag);

  if (isClaude) {
    updated.outputFormat = 'claude-stream-json';
    // Required combo: --output-format stream-json + --verbose
    if (!hasFlag('--output-format')) injectAfterClaudePrintFlag(updated.argsTemplate, ['--output-format', 'stream-json']);
    if (!hasFlag('--verbose'))       injectAfterClaudePrintFlag(updated.argsTemplate, ['--verbose']);
    const existing = updated.additionalHeartbeatPaths ?? [];
    if (!existing.includes('~/.claude/projects')) {
      updated.additionalHeartbeatPaths = [...existing, '~/.claude/projects'];
    }
  } else if (isCodex) {
    updated.outputFormat = 'codex-jsonl';
    if (!hasFlag('--json')) injectAfterCodexExec(updated.argsTemplate, ['--json']);
    const existing = updated.additionalHeartbeatPaths ?? [];
    if (!existing.includes('~/.codex/sessions')) {
      updated.additionalHeartbeatPaths = [...existing, '~/.codex/sessions'];
    }
  } else if (isVibe) {
    updated.outputFormat = 'vibe-streaming';
    // vibe nutzt `--output text` als Default — auf streaming wechseln
    const outputIdx = updated.argsTemplate.indexOf('--output');
    if (outputIdx >= 0 && outputIdx + 1 < updated.argsTemplate.length) {
      updated.argsTemplate[outputIdx + 1] = 'streaming';
    } else {
      updated.argsTemplate.push('--output', 'streaming');
    }
    const existing = updated.additionalHeartbeatPaths ?? [];
    if (!existing.includes('~/.vibe/sessions')) {
      updated.additionalHeartbeatPaths = [...existing, '~/.vibe/sessions'];
    }
  }
  return updated;
}

/** Insert flags right after `--print` (claude) or at end if --print missing. */
function injectAfterClaudePrintFlag(args: string[], flags: string[]): void {
  const printIdx = args.findIndex(a => a === '--print' || a === '-p');
  if (printIdx >= 0) args.splice(printIdx + 1, 0, ...flags);
  else args.push(...flags);
}

/** Insert flags right after `exec` (codex subcommand). */
function injectAfterCodexExec(args: string[], flags: string[]): void {
  const idx = args.indexOf('exec');
  if (idx >= 0) args.splice(idx + 1, 0, ...flags);
  else args.unshift(...flags);
}

export interface AgentExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  modifiedFiles: string[];
}

/**
 * v864 — Erkennt ob ein non-zero Agent-Exit ein TRANSIENTER LLM-API-Fehler war
 * (Provider überlastet, Rate-Limit, Netzwerk) statt eines echten Crashes.
 *
 * Hintergrund (Vorfall 494ae636, 11.06.): Phase 4 starb nach 38s an einem
 * Anthropic `529 Overloaded` — der claude CLI retried intern, gibt dann auf
 * und exitet 1. Der Runner behandelte das wie einen Auth-/Binary-Fehler und
 * brach die ganze Session ab; 3 grüne Phasen + 5485 grüne Tests blieben
 * ungepusht liegen. Alfreds EIGENE LLM-Calls haben Retry/Fallback
 * (anthropic.ts maxRetries=5, model-router isRetryableError) — der externe
 * CLI-Agent-Pfad hatte bis v864 keinerlei Klassifikation.
 *
 * Geprüft wird nur das ENDE von stdout+stderr (je 2000 Zeichen): beim
 * stream-json-Format ist stdout der extrahierte finale Assistant-Text, dort
 * landet der Fehler („API Error: 529 …"). Bewusst NICHT matchen: 401/403
 * (Auth — permanent), "command not found" (Binary — permanent).
 */
export function isTransientApiFailure(result: Pick<AgentExecutionResult, 'stdout' | 'stderr' | 'exitCode'>): boolean {
  if (result.exitCode === 0) return false;
  const tail = `${(result.stdout ?? '').slice(-2000)}\n${(result.stderr ?? '').slice(-2000)}`;
  return (
    /API Error:?\s*5\d\d/i.test(tail) ||
    /API Error:?\s*429/i.test(tail) ||
    /overloaded_error|"overloaded"|\bOverloaded\b/i.test(tail) ||
    /rate.?limit(ed|s)?\b|too many requests/i.test(tail) ||
    /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|network error/i.test(tail)
  );
}

/**
 * Resolve `${VAR_NAME}` placeholders in env values against process.env.
 */
function resolveEnv(env: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    resolved[key] = value.replace(/\$\{(\w+)\}/g, (_match, varName: string) => {
      return process.env[varName] ?? '';
    });
  }
  return resolved;
}

/**
 * Replace `{{prompt}}` placeholders in args template.
 */
function buildArgs(template: string[], prompt: string): string[] {
  return template.map((arg) => arg.replace(/\{\{prompt\}\}/g, prompt));
}

/**
 * Truncate output keeping the tail (most recent output is most useful).
 */
function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return '[...truncated...]\n' + text.slice(-MAX_OUTPUT_CHARS);
}

/**
 * Snapshot file mtimes in a directory, skipping ignored dirs.
 * v844 — accepts multiple roots so the heartbeat can also watch agent-side
 * session paths (claude `~/.claude/projects/...`) where the agent writes
 * even when it stays silent on stdout.
 */
function snapshotMtimes(dirOrDirs: string | string[]): Map<string, number> {
  const roots = Array.isArray(dirOrDirs) ? dirOrDirs : [dirOrDirs];
  const result = new Map<string, number>();

  function walk(current: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          result.set(fullPath, stat.mtimeMs);
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  for (const root of roots) {
    if (root && fs.existsSync(root)) walk(root);
  }
  return result;
}

/**
 * Detect files that were created or modified between two snapshots.
 */
function detectModifiedFiles(
  before: Map<string, number>,
  after: Map<string, number>,
  baseDir: string,
): string[] {
  const modified: string[] = [];
  for (const [filePath, mtime] of after) {
    const prevMtime = before.get(filePath);
    if (prevMtime === undefined || mtime > prevMtime) {
      modified.push(path.relative(baseDir, filePath));
    }
  }
  return modified.sort();
}

/**
 * v850 — Optional MCP-Token-Provider. Wenn gesetzt: jeder agent-Spawn
 * bekommt ein frisches One-Time-Token via env-var ALFRED_MCP_TOKEN damit
 * der CLI-Agent über MCP-stdio auf Alfreds Knowledge-Stores zugreifen kann.
 *
 * Alfred setzt den Provider in alfred.ts beim Start wenn `codeAgents.mcp.enabled`.
 */
let mcpTokenProvider: ((opts: { agentName: string; cwd?: string }) => string | null) | null = null;

export function setMcpTokenProvider(p: ((opts: { agentName: string; cwd?: string }) => string | null) | null): void {
  mcpTokenProvider = p;
}

export async function executeAgent(
  agentDefRaw: CodeAgentDefinitionConfig,
  prompt: string,
  options: {
    cwd?: string;
    timeoutMs?: number;
    onProgress?: (status: string) => void;
    /** v608 F4 — callback fired on every stdout/stderr chunk so the SkillSandbox
     *  ActivityTracker stays alive while the subprocess produces output.
     *  Without this, long-running claude-code runs get killed by the 120s
     *  inactivity watchdog even though they're working. */
    onActivity?: () => void;
    /** v650 — AbortSignal vom Runner. Wenn signal aborted: child-process tree
     *  wird sauber gekillt (SIGTERM, dann SIGKILL nach 3s). */
    signal?: AbortSignal;
    /** v651 — taskId/sessionId für Live-Output-Buffer (siehe project-agent-skill
     *  outputBuffers). Wenn gesetzt: jede stdout/stderr-Zeile wird in den
     *  Ring-Buffer geschoben damit SSE-Subscriber live mitlesen können. */
    taskId?: string;
  } = {},
): Promise<AgentExecutionResult> {
  // v844 — auto-upgrade legacy agent defs to stream-mode (claude/codex/vibe).
  // No-op if user explicitly set outputFormat in config.
  const agentDef = upgradeAgentDef(agentDefRaw);
  const cwd = options.cwd ?? agentDef.cwd ?? process.cwd();

  // v862 — Hard-Guard (letzte Verteidigung): Code-Agents dürfen NIE direkt in
  // Alfreds eigener Installation arbeiten. Der reguläre Pfad ist der Self-
  // Healing-Redirect im project_agent (Repo-Checkout + MR/PR). Dieser Guard
  // fängt Umgehungen (z.B. delegate→code_agent.run mit Installations-cwd —
  // exakt der Vorfall vom 10.06.2026, claude-code patchte bundle/index.js).
  {
    const { isSelfInstallPath } = await import('./self-healing.js');
    if (isSelfInstallPath(cwd)) {
      return {
        stdout: '',
        stderr: `cwd "${cwd}" ist Alfreds eigene Installation — Code-Agents dürfen dort nicht arbeiten ` +
          `(Patches sind flüchtig, unreviewt und werden beim nächsten npm install überschrieben). ` +
          `Nutze stattdessen project_agent mit demselben cwd: der Self-Healing-Redirect arbeitet ` +
          `automatisch im Repo-Checkout und erstellt einen MR/PR zur Review.`,
        exitCode: 126,
        durationMs: 0,
        modifiedFiles: [],
      };
    }
  }

  // v608 F5 — preflight: catch missing binary BEFORE spawning, so we don't
  // burn the 10-minute initial-timeout on a process that silently dies.
  const preflightError = preflightAgent(agentDef);
  if (preflightError) {
    return {
      stdout: '',
      stderr: preflightError,
      exitCode: 127,
      durationMs: 0,
      modifiedFiles: [],
    };
  }

  // Auto-create working directory if it doesn't exist
  if (!fs.existsSync(cwd)) {
    fs.mkdirSync(cwd, { recursive: true });
  }
  // If command runs as a different user (sudo -u <user>), ensure cwd is owned by that user
  // Safety: only chown if cwd is not a system directory (/root, /home, /, /etc etc.)
  if (agentDef.command === 'sudo' && agentDef.argsTemplate[0] === '-u' && agentDef.argsTemplate[1]) {
    const runAsUser = agentDef.argsTemplate[1];
    const cwdDepth = cwd.split('/').filter(Boolean).length;
    if (cwdDepth >= 2) { // Only chown paths like /root/project, /home/user/project — never /root or /home
      try { execFileSync('chown', ['-R', `${runAsUser}:${runAsUser}`, cwd], { timeout: 5000 }); } catch { /* best effort */ }
    }
  }
  const rawTimeout = options.timeoutMs ?? agentDef.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(rawTimeout, MAX_TIMEOUT_MS);

  const args = buildArgs(agentDef.argsTemplate, prompt);
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...(agentDef.env ? resolveEnv(agentDef.env) : {}),
  };
  // v850 — Per-spawn MCP-Token: wenn provider verdrahtet ist, ein frisches
  // Token issuen und in env passieren. CLI-Agent gibt es transparent an
  // sein MCP-stdio-process weiter (via spawn-env-Vererbung). Alfred-MCP-
  // Server validiert das Token vor jedem tool-call.
  if (mcpTokenProvider) {
    try {
      const token = mcpTokenProvider({ agentName: agentDef.name, cwd });
      if (token) env.ALFRED_MCP_TOKEN = token;
    } catch { /* token issue non-critical */ }
  }

  // Use shell on Windows for .cmd/.bat wrappers
  const isWindows = process.platform === 'win32';

  // v844 — Heartbeat-Roots: cwd + optional agent-spezifische Session-Pfade
  // (~/.claude/projects/..., ~/.codex/sessions/..., etc.). Erkennt aktivität
  // wenn der Agent dort schreibt obwohl im cwd nichts passiert (typisch für
  // Audit/Read-only Phasen).
  const heartbeatRoots: string[] = [cwd];
  if (Array.isArray(agentDef.additionalHeartbeatPaths)) {
    for (const p of agentDef.additionalHeartbeatPaths) {
      if (typeof p === 'string' && p.length > 0) heartbeatRoots.push(expandHome(p));
    }
  }

  // v844 — Output-Parser: bei stream-formats werden JSON-events in human-
  // readable progress-zeilen umgewandelt und der finale text-content separat
  // akkumuliert (wird als stdout returned). Default 'text' = passthrough.
  const outputFormat: AgentOutputFormat = (agentDef.outputFormat as AgentOutputFormat) ?? 'text';
  const parserState = createParserState(outputFormat);

  // Snapshot before execution
  const beforeSnapshot = snapshotMtimes(heartbeatRoots);
  const startTime = Date.now();

  return new Promise<AgentExecutionResult>((resolve) => {
    const child = spawn(agentDef.command, args, {
      cwd,
      env,
      shell: isWindows,
      stdio: agentDef.promptVia === 'stdin' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      // v650 — detached so we can SIGTERM the whole process group (kill -PGID)
      detached: !isWindows,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let killReason: 'inactivity' | 'absolute' | 'aborted' | undefined;

    // v650/v810 — Stop-Cleanup: wenn Caller via AbortSignal aborted, kompletten
    // Agent-Baum killen. v810: killAgentTree erfasst auch reparentete Sub-Sessions
    // (claude-code spawnt Bash-Tools in eigenen Sessions → Group-Kill verfehlt sie
    // → Waisen halten den Worktree offen). Kill via cwd-Match als Backstop.
    const onAbort = () => {
      killed = true;
      killReason = 'aborted';
      killAgentTree(child.pid, cwd, { detached: !isWindows });
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    // v619 D0 — Sliding inactivity timer statt absolutem Timer.
    // Vorher (Bug): const timer = setTimeout(kill, timeoutMs) — egal wie aktiv
    // der Subprocess war, nach timeoutMs (5min default) wurde SIGTERM gesendet.
    // Phasen die länger als 5min dauern aber kontinuierlich Output produzieren
    // (typisch für codex bei Multi-Datei-Edits) wurden mitten in der Arbeit gekillt.
    //
    // Neu: bei jedem stdout/stderr-Chunk wird der Timer zurückgesetzt. Der Agent
    // darf beliebig lange laufen, solange er innerhalb des timeoutMs-Fensters
    // Output produziert. Zusätzlich absolute Sicherung (ABSOLUTE_CAP_MS) damit
    // nichts ewig läuft (z.B. forever-loop in eskaliertem child-process).
    // v624 B — Mid-Progress-Warning: bei timeoutMs/2 Stille ein einmaliger Hinweis
    // an onProgress (geht via project-agent-runner an Telegram). Lässt den User
    // sehen "Agent ist still aber lebt noch — kill in N min". Wird beim nächsten
    // Chunk zurückgesetzt damit man bei zwischenzeitlicher Aktivität nicht
    // gespamt wird. Pro inactivity-window genau eine Warning.
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    let halfwayTimer: ReturnType<typeof setTimeout> | undefined;
    let resetSource: 'stdout' | 'stderr' | 'fs-heartbeat' | 'initial' = 'initial';
    const resetInactivity = (source: typeof resetSource = 'initial') => {
      resetSource = source;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (halfwayTimer) clearTimeout(halfwayTimer);
      halfwayTimer = setTimeout(() => {
        const halfSec = Math.round(timeoutMs / 2 / 1000);
        const remainingMin = Math.round((timeoutMs - timeoutMs / 2) / 60_000);
        options.onProgress?.(`⏳ Stille seit ${halfSec}s — wird in ~${remainingMin}min gekillt sofern keine Aktivität`);
      }, timeoutMs / 2);
      inactivityTimer = setTimeout(() => {
        killed = true;
        killReason = 'inactivity';
        // v810 — kompletter Baum statt nur child.kill (erfasst Sub-Sessions)
        killAgentTree(child.pid, cwd, { detached: !isWindows, graceMs: 5_000 });
      }, timeoutMs);
    };
    resetInactivity();

    // v635 — File-mtime-Heartbeat alle 30s. Wenn der Agent neue Dateien schreibt
    // (typisch für Multi-File-Edits / Migrationen / Code-Generation) aber stdout/stderr
    // gepuffert oder still ist, bleibt der Subprocess als aktiv erkannt und der
    // Inactivity-Timer wird zurückgesetzt. Verhindert das v625-Symptom: Agent
    // schreibt 77 Dateien aber wird mid-phase wegen stdout-Stille gekillt.
    let lastHeartbeatSnapshot = beforeSnapshot;
    const heartbeatInterval = setInterval(() => {
      try {
        const nowSnapshot = snapshotMtimes(heartbeatRoots);
        // Compare against last heartbeat snapshot — count files that changed since
        let changed = 0;
        for (const [fp, mtime] of nowSnapshot) {
          const prev = lastHeartbeatSnapshot.get(fp);
          if (prev === undefined || mtime > prev) { changed++; if (changed >= 1) break; }
        }
        if (changed > 0) {
          lastHeartbeatSnapshot = nowSnapshot;
          resetInactivity('fs-heartbeat');
        }
      } catch { /* fs scan errors are non-fatal */ }
    }, 30_000);
    (heartbeatInterval as { unref?: () => void }).unref?.();

    const absoluteTimer = setTimeout(() => {
      killed = true;
      killReason = 'absolute';
      // v810 — kompletter Baum statt nur child.kill (erfasst Sub-Sessions)
      killAgentTree(child.pid, cwd, { detached: !isWindows, graceMs: 5_000 });
    }, ABSOLUTE_CAP_MS);

    // v844 — Bei stream-formats akkumulieren wir den finalen text-content
    // separat, damit codeResult.stdout für Caller (project-agent-runner,
    // code-agent-skill) genauso aussieht wie bei text-Mode (human-readable).
    // rawStdout bleibt für Debug verfügbar (wird nicht returned aber im
    // stderr-Fall via fallback genutzt).
    let extractedText = '';
    let stdoutBuffer = ''; // partial line buffer (chunks können mid-line geteilt sein)
    const isStreaming = outputFormat !== 'text';

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      options.onActivity?.(); // v608 F4 — keep sandbox watchdog alive
      resetInactivity('stdout'); // v619 D0 — extend inactivity timer on every chunk

      stdoutBuffer += text;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? ''; // keep incomplete last line for next chunk
      for (const rawLine of lines) {
        const trimmed = rawLine.replace(/\r$/, '');
        if (trimmed.length === 0) continue;
        if (isStreaming) {
          const parsed = parseLine(parserState, trimmed);
          for (const p of parsed.progress) {
            if (options.taskId) {
              try { appendOutputLine(options.taskId, 'stdout', p); } catch { /* */ }
            }
            options.onProgress?.(`[${agentDef.name}] ${p}`);
          }
          for (const f of parsed.finalTextChunks) extractedText += (extractedText ? '\n' : '') + f;
        } else {
          // text-mode: passthrough wie bisher
          if (options.taskId) {
            try { appendOutputLine(options.taskId, 'stdout', trimmed); } catch { /* */ }
          }
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      options.onActivity?.(); // v608 F4 — keep sandbox watchdog alive
      resetInactivity('stderr'); // v619 D0 — extend inactivity timer on every chunk
      // v651 — Live-Output-Buffer pro Zeile
      if (options.taskId) {
        for (const line of text.split('\n')) {
          const trimmed = line.replace(/\r$/, '');
          if (trimmed.length === 0) continue;
          try { appendOutputLine(options.taskId, 'stderr', trimmed); } catch { /* best-effort */ }
        }
      }
      // Forward stderr lines as progress updates
      if (options.onProgress) {
        const lastLine = text.trim().split('\n').pop();
        if (lastLine) {
          options.onProgress(`[${agentDef.name}] ${lastLine}`);
        }
      }
    });

    // Send prompt via stdin if configured
    if (agentDef.promptVia === 'stdin' && child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    child.on('close', (code) => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (halfwayTimer) clearTimeout(halfwayTimer);
      clearTimeout(absoluteTimer);
      clearInterval(heartbeatInterval);
      // v844 — flush trailing partial line through parser
      if (stdoutBuffer.length > 0) {
        const trimmed = stdoutBuffer.replace(/\r$/, '');
        if (trimmed.length > 0 && isStreaming) {
          const parsed = parseLine(parserState, trimmed);
          for (const p of parsed.progress) {
            if (options.taskId) { try { appendOutputLine(options.taskId, 'stdout', p); } catch { /* */ } }
          }
          for (const f of parsed.finalTextChunks) extractedText += (extractedText ? '\n' : '') + f;
        } else if (trimmed.length > 0 && options.taskId) {
          try { appendOutputLine(options.taskId, 'stdout', trimmed); } catch { /* */ }
        }
        stdoutBuffer = '';
      }
      const durationMs = Date.now() - startTime;
      // v844 — afterSnapshot nur über cwd (für modifiedFiles), nicht über
      // additionalHeartbeatPaths — der Caller will Files-im-Projekt zurück.
      const afterSnapshot = snapshotMtimes(cwd);
      const modifiedFiles = detectModifiedFiles(beforeSnapshot, afterSnapshot, cwd);

      // v619 D0 — annotate stderr with kill-reason so downstream diagnostics
      // (project-agent-runner) can distinguish inactivity-kill from absolute-cap-kill
      // v635 — include last-activity-source so we can see whether the agent
      // was silent both in stdout AND in file-writes (truly idle) vs only stdout
      let finalStderr = stderr;
      if (killReason === 'inactivity') {
        finalStderr = stderr + `\n[agent-executor] killed: no output for ${Math.round(timeoutMs / 1000)}s (inactivity timeout, last-activity=${resetSource})`;
      } else if (killReason === 'absolute') {
        finalStderr = stderr + `\n[agent-executor] killed: ${Math.round(ABSOLUTE_CAP_MS / 60_000)}min absolute cap reached (was active but ran too long)`;
      } else if (killReason === 'aborted') {
        finalStderr = stderr + `\n[agent-executor] killed: caller aborted (Stop-Signal)`;
      }

      // v844 — bei stream-mode geben wir den extrahierten human-readable text
      // zurück (statt raw JSON-lines). Fallback auf raw stdout falls der parser
      // nichts extrahiert hat (z.B. Agent crashte vor erstem assistant_message).
      const stdoutForCaller = isStreaming
        ? (extractedText.length > 0 ? extractedText : stdout)
        : stdout;

      resolve({
        stdout: truncateOutput(stdoutForCaller),
        stderr: truncateOutput(finalStderr),
        exitCode: killed ? 124 : (code ?? 1),
        durationMs,
        modifiedFiles,
      });
    });

    child.on('error', (err) => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (halfwayTimer) clearTimeout(halfwayTimer);
      clearTimeout(absoluteTimer);
      clearInterval(heartbeatInterval);
      const durationMs = Date.now() - startTime;
      resolve({
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr + '\n' + err.message),
        exitCode: 127,
        durationMs,
        modifiedFiles: [],
      });
    });
  });
}
