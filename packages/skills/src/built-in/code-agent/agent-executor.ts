import { spawn, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CodeAgentDefinitionConfig } from '@alfred/types';

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes — used as inactivity threshold by default
const MAX_TIMEOUT_MS = 900_000; // 15 minutes — used as inactivity threshold ceiling
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
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let killReason: 'inactivity' | 'absolute' | undefined;

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
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const resetInactivity = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        killed = true;
        killReason = 'inactivity';
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5_000);
      }, timeoutMs);
    };
    resetInactivity();

    const absoluteTimer = setTimeout(() => {
      killed = true;
      killReason = 'absolute';
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, ABSOLUTE_CAP_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      options.onActivity?.(); // v608 F4 — keep sandbox watchdog alive
      resetInactivity();      // v619 D0 — extend inactivity timer on every chunk
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      options.onActivity?.(); // v608 F4 — keep sandbox watchdog alive
      resetInactivity();      // v619 D0 — extend inactivity timer on every chunk
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
      clearTimeout(absoluteTimer);
      const durationMs = Date.now() - startTime;
      const afterSnapshot = snapshotMtimes(cwd);
      const modifiedFiles = detectModifiedFiles(beforeSnapshot, afterSnapshot, cwd);

      // v619 D0 — annotate stderr with kill-reason so downstream diagnostics
      // (project-agent-runner) can distinguish inactivity-kill from absolute-cap-kill
      let finalStderr = stderr;
      if (killReason === 'inactivity') {
        finalStderr = stderr + `\n[agent-executor] killed: no output for ${Math.round(timeoutMs / 1000)}s (inactivity timeout)`;
      } else if (killReason === 'absolute') {
        finalStderr = stderr + `\n[agent-executor] killed: ${Math.round(ABSOLUTE_CAP_MS / 60_000)}min absolute cap reached (was active but ran too long)`;
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
      clearTimeout(absoluteTimer);
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
