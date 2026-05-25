import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from 'pino';
import type {
  AgentSessionAdapter,
  AgentEvent,
  AgentInvokeOptions,
  AgentInvokeResult,
  AgentAdapterCapabilities,
} from '../types.js';

/**
 * v786 — GenericPlainAdapter
 *
 * Fallback-Adapter für CLIs ohne strukturierte JSON-Event-Streams. Spawnt das
 * konfigurierte Binary, streamt stdout als chunked `text`-Events, stderr wird
 * gebuffered und nur bei non-zero exit als `error`-Event emit'd.
 *
 * **Keine Session-Continuation** (persistence='none'): jeder Run ist ein frischer
 * Subprocess. CLI hat keinen Zugriff auf vorherigen Kontext aus DB. Das ist OK
 * für experimentelle CLIs (kilo, opencode, pi-code, vibe-code) — bedeutet aber
 * dass jeder Iteration der Agent das Codebase erneut explorieren muss.
 *
 * Anders als die spezialisierten Adapter wird hier eine **pro-Agent-Instanz**
 * erstellt: der Adapter kennt das spezifische command/argsTemplate aus
 * `CodeAgentDefinitionConfig`. Manager.registerAdapter() speichert unter
 * `adapter.name` → User kann beliebig viele Agents (mit verschiedenen
 * Binaries) parallel haben.
 *
 * Modified-Files-Detection: mtime-Snapshot vor/nach Run (legacy-Approach aus
 * executeAgent).
 */

export interface GenericPlainAdapterConfig {
  name: string;
  command: string;
  argsTemplate: string[];
  /** Default 'arg' — Prompt wird via {{prompt}}-Substitution in argsTemplate eingefügt. */
  promptVia?: 'arg' | 'stdin';
  env?: Record<string, string>;
  /** Optional fixed cwd override (default: invoke()-cwd). */
  cwd?: string;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', '.cache', '.turbo', 'target']);

export class GenericPlainAdapter implements AgentSessionAdapter {
  readonly name: string;
  readonly capabilities: AgentAdapterCapabilities = {
    persistence: 'none',
    structuredOutput: false,
    streamingTokens: true, // wir streamen chunks während sie reinkommen
    supportsAbort: true,
    supportsCaching: false,
  };

  constructor(
    private readonly logger: Logger,
    private readonly config: GenericPlainAdapterConfig,
  ) {
    this.name = config.name;
  }

  async invoke(opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
    const promptToSend = opts.promptPrefix ? `${opts.promptPrefix}\n\n${opts.prompt}` : opts.prompt;
    const promptVia = this.config.promptVia ?? 'arg';

    // argsTemplate {{prompt}}-Substitution (legacy convention aus executeAgent)
    const baseArgs = this.config.argsTemplate.map(a => {
      if (promptVia === 'arg') return a.replace(/\{\{prompt\}\}/g, promptToSend);
      return a;
    });

    // sudo-wrapping wenn runAsUser gesetzt
    let cmd = this.config.command;
    let cmdArgs = baseArgs;
    if (opts.runAsUser) {
      cmdArgs = ['-u', opts.runAsUser, this.config.command, ...baseArgs];
      cmd = 'sudo';
    }

    const cwd = this.config.cwd ?? opts.cwd;
    this.logger.info({ agent: this.name, cmd, promptVia, cwd, runAsUser: opts.runAsUser }, 'v786 generic adapter invoke');

    // Snapshot vor Run für Modified-Files-Detection
    const beforeMtimes = snapshotMtimes(cwd);

    const startTime = Date.now();
    const result = await this.runChild(cmd, cmdArgs, opts, promptToSend, promptVia, cwd);
    result.durationMs = Date.now() - startTime;

    // Modified-Files berechnen
    const afterMtimes = snapshotMtimes(cwd);
    const modified: string[] = [];
    for (const [file, mtime] of afterMtimes) {
      const prev = beforeMtimes.get(file);
      if (prev === undefined || prev !== mtime) {
        modified.push(path.relative(cwd, file));
      }
    }
    result.modifiedFiles = modified;
    return result;
  }

  async isHealthy(_cliSessionId: string, _runAsUser?: string): Promise<boolean> {
    return true; // Generic-Adapter hat keine Session → immer "healthy"
  }

  async destroy(_cliSessionId: string, _runAsUser?: string): Promise<void> {
    // No-op — kein Session-State.
  }

  private runChild(
    cmd: string,
    args: string[],
    opts: AgentInvokeOptions,
    promptToSend: string,
    promptVia: 'arg' | 'stdin',
    cwd: string,
  ): Promise<AgentInvokeResult> {
    return new Promise<AgentInvokeResult>((resolve) => {
      const isWindows = process.platform === 'win32';
      const envMerged = { ...(process.env as Record<string, string>), ...(this.config.env ?? {}) };
      const child = spawn(cmd, args, {
        cwd,
        env: envMerged,
        stdio: [promptVia === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        detached: !isWindows,
      });

      let aborted = false;
      const onAbort = () => {
        aborted = true;
        try {
          if (!isWindows && child.pid) {
            process.kill(-child.pid, 'SIGTERM');
            setTimeout(() => { try { if (child.pid) process.kill(-child.pid!, 'SIGKILL'); } catch { /* */ } }, 3_000);
          } else {
            child.kill('SIGTERM');
          }
        } catch { /* */ }
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });

      const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
      const timeoutTimer = setTimeout(() => {
        opts.onEvent({ type: 'error', message: `${this.name} timeout after ${timeoutMs}ms`, recoverable: true });
        onAbort();
      }, timeoutMs);

      // Prompt via stdin senden falls konfiguriert
      if (promptVia === 'stdin' && child.stdin) {
        try {
          child.stdin.write(promptToSend);
          child.stdin.end();
        } catch (err) {
          this.logger.warn({ err }, 'v786 generic stdin write failed');
        }
      }

      const stdoutChunks: string[] = [];
      let stderrBuf = '';
      let finalText = '';

      // Stdout chunked als text-events emitten — User sieht live Output streamen
      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stdoutChunks.push(text);
        finalText += text;
        opts.onEvent({ type: 'text', text });
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stderrBuf += text;
        if (stderrBuf.length > 50_000) stderrBuf = stderrBuf.slice(-50_000);
      });

      child.on('close', (exitCode) => {
        clearTimeout(timeoutTimer);
        if (opts.signal.removeEventListener) {
          opts.signal.removeEventListener('abort', onAbort);
        }
        if (exitCode !== 0 && stderrBuf.trim() && !aborted) {
          opts.onEvent({ type: 'error', message: stderrBuf.slice(-1000), recoverable: true });
        }
        resolve({
          // Keine Session-ID — generic-CLI persistiert nichts
          exitCode: exitCode ?? -1,
          modifiedFiles: [], // wird vom Caller (invoke()) befüllt
          durationMs: 0,
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          finalText: finalText.slice(-10_000),
        });
      });

      child.on('error', (err) => {
        clearTimeout(timeoutTimer);
        this.logger.warn({ err, agent: this.name }, 'v786 generic child error');
        opts.onEvent({ type: 'error', message: `${this.name} spawn failed: ${err.message}`, recoverable: false });
        resolve({
          exitCode: -1,
          modifiedFiles: [],
          durationMs: 0,
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          sessionInvalidated: true,
        });
      });
    });
  }
}

/**
 * mtime-Snapshot eines Directory-Baums. Identisch zum legacy executeAgent-Approach.
 * Skipt typische ignorierte Ordner (node_modules, .git, dist, …).
 */
function snapshotMtimes(dir: string): Map<string, number> {
  const result = new Map<string, number>();
  function walk(current: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          result.set(fullPath, stat.mtimeMs);
        } catch { /* skip */ }
      }
    }
  }
  try { walk(dir); } catch { /* */ }
  return result;
}
