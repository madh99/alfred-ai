import { spawn, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CodeAgentDefinitionConfig } from '@alfred/types';
import { appendOutputLine } from './project-agent-skill.js';
import { killAgentTree } from './process-tree.js';

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
 *  invocation to run longer than this regardless of activity. */
const ABSOLUTE_CAP_MS = 60 * 60 * 1000; // 60 minutes

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

export interface AgentExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  modifiedFiles: string[];
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
 */
function snapshotMtimes(dir: string): Map<string, number> {
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

  walk(dir);
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

export async function executeAgent(
  agentDef: CodeAgentDefinitionConfig,
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
  const cwd = options.cwd ?? agentDef.cwd ?? process.cwd();

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

  // Use shell on Windows for .cmd/.bat wrappers
  const isWindows = process.platform === 'win32';

  // Snapshot before execution
  const beforeSnapshot = snapshotMtimes(cwd);
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
        const nowSnapshot = snapshotMtimes(cwd);
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

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      options.onActivity?.(); // v608 F4 — keep sandbox watchdog alive
      resetInactivity('stdout'); // v619 D0 — extend inactivity timer on every chunk
      // v651 — Live-Output-Buffer pro Zeile (max die letzten N Zeilen vorhalten)
      if (options.taskId) {
        for (const line of text.split('\n')) {
          const trimmed = line.replace(/\r$/, '');
          if (trimmed.length === 0) continue;
          try { appendOutputLine(options.taskId, 'stdout', trimmed); } catch { /* best-effort */ }
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
      const durationMs = Date.now() - startTime;
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

      resolve({
        stdout: truncateOutput(stdout),
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
