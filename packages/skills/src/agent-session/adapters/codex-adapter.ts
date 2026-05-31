import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Logger } from 'pino';
import type {
  AgentSessionAdapter,
  AgentEvent,
  AgentInvokeOptions,
  AgentInvokeResult,
  AgentAdapterCapabilities,
} from '../types.js';

/**
 * v785 — CodexAdapter (OpenAI Codex CLI)
 *
 * Spawnt `codex exec --json --skip-git-repo-check --sandbox=danger-full-access -C <cwd> "<prompt>"`.
 * Resume via `codex exec resume <thread_id> ...`.
 *
 * Output-Format ist **Event-stream mit item.completed-Wrapping** — anders als Claude (per-block)
 * und Vibe (OpenAI-chat-style). Codex sammelt eine Aktion vollständig und emit'd sie als
 * `item.completed` mit typisiertem `item`-Payload:
 *
 *   {"type":"thread.started", "thread_id":"7df1c8d0-..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed", "item":{"type":"assistant_message","text":"..."}}
 *   {"type":"item.completed", "item":{"type":"command_execution","command":"...","status":"success","exit_code":0,"output":"..."}}
 *   {"type":"item.completed", "item":{"type":"file_change","path":"...","change_type":"modify","diff":"..."}}
 *   {"type":"item.completed", "item":{"type":"mcp_tool_call","tool":"...","input":{...},"output":"..."}}
 *   {"type":"item.completed", "item":{"type":"todo_list","todos":[...]}}
 *   {"type":"turn.completed", "usage":{"input_tokens":N,"output_tokens":N,"cached_input_tokens":N}}
 *
 * Sandbox-Mode: alfred verwaltet bereits eigene Worktree-Sandboxes (Container/VM-Isolation),
 * darum schalten wir Codex' Seatbelt/Landlock-Sandbox aus → `--sandbox=danger-full-access`.
 *
 * Verifiziert mit codex 0.132.0 (auf alfred .92).
 */

const CODEX_BIN = process.env.ALFRED_CODEX_BIN ?? 'codex';
const SANDBOX_MODE = process.env.ALFRED_CODEX_SANDBOX ?? 'danger-full-access';

export class CodexAdapter implements AgentSessionAdapter {
  readonly name = 'codex';
  readonly capabilities: AgentAdapterCapabilities = {
    persistence: 'flag-resume', // codex exec resume <thread_id>
    structuredOutput: true,
    streamingTokens: false, // codex emit'd item.completed pro Aktion (nicht token-by-token)
    supportsAbort: true,
    supportsCaching: true,
  };

  constructor(private readonly logger: Logger) {}

  async invoke(opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
    const promptToSend = opts.promptPrefix ? `${opts.promptPrefix}\n\n${opts.prompt}` : opts.prompt;

    // Resume vs new
    const subArgs: string[] = ['exec'];
    if (opts.cliSessionId) {
      subArgs.push('resume', opts.cliSessionId);
    }
    subArgs.push(
      '--json',
      '--skip-git-repo-check',
      `--sandbox=${SANDBOX_MODE}`,
      '-C', opts.cwd,
      promptToSend,
    );

    const cmd = opts.runAsUser ? 'sudo' : CODEX_BIN;
    const cmdArgs = opts.runAsUser ? ['-u', opts.runAsUser, CODEX_BIN, ...subArgs] : subArgs;

    this.logger.info({ agent: 'codex', cwd: opts.cwd, resume: !!opts.cliSessionId, sandboxMode: SANDBOX_MODE, runAsUser: opts.runAsUser }, 'v785 codex invoke');

    const startTime = Date.now();
    const result = await this.runChild(cmd, cmdArgs, opts);
    result.durationMs = Date.now() - startTime;
    return result;
  }

  async isHealthy(_cliSessionId: string, _runAsUser?: string): Promise<boolean> {
    // Codex persistiert threads in ~/.codex/sessions/. Voller health-check würde
    // codex `--list-threads` o.ä. brauchen. Default trust — failed resume zeigt sich im invoke.
    return true;
  }

  async destroy(_cliSessionId: string, _runAsUser?: string): Promise<void> {
    // Kein offizieller CLI-Command zum Thread-löschen.
  }

  private runChild(cmd: string, args: string[], opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
    return new Promise<AgentInvokeResult>((resolve) => {
      const isWindows = process.platform === 'win32';
      // v839 — NODE_OPTIONS Augmentor für codex + grandchildren
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { augmentSpawnEnv } = require('../env-util.js') as typeof import('../env-util.js');
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: augmentSpawnEnv(process.env, { nodeMaxOldSpaceSizeMb: opts.nodeMaxOldSpaceSizeMb }),
        // stdin auf 'ignore' → kein hängender Read auf stdin
        stdio: ['ignore', 'pipe', 'pipe'],
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
        opts.onEvent({ type: 'error', message: `codex timeout after ${timeoutMs}ms`, recoverable: true });
        onAbort();
      }, timeoutMs);

      // State
      let newCliSessionId: string | undefined;
      const modifiedFiles = new Set<string>();
      let aggUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
      let finalText: string | undefined;
      let stderrBuf = '';
      let itemCounter = 0;

      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let raw: any;
        try { raw = JSON.parse(trimmed); }
        catch (err) {
          this.logger.debug({ err, line: trimmed.slice(0, 200) }, 'v785 codex non-JSON line, ignored');
          return;
        }
        try {
          this.mapEvent(raw, opts.onEvent, {
            recordModified: (path) => { if (path) modifiedFiles.add(path); },
            nextItemId: () => `codex-item-${++itemCounter}`,
            setFinalText: (t) => { finalText = t; },
            setThreadId: (id) => {
              if (!newCliSessionId && !opts.cliSessionId) {
                newCliSessionId = id;
                opts.onEvent({ type: 'session_id', value: id });
              }
            },
            addUsage: (u) => {
              aggUsage.inputTokens += u.inputTokens;
              aggUsage.outputTokens += u.outputTokens;
              aggUsage.cachedTokens += u.cachedTokens;
            },
          });
        } catch (err) {
          this.logger.warn({ err, type: raw?.type }, 'v785 codex event mapping failed');
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const txt = chunk.toString();
        stderrBuf += txt;
        if (stderrBuf.length > 50_000) stderrBuf = stderrBuf.slice(-50_000);
      });

      child.on('close', (exitCode) => {
        clearTimeout(timeoutTimer);
        if (opts.signal.removeEventListener) {
          opts.signal.removeEventListener('abort', onAbort);
        }
        // Emit usage event nach Run-Ende
        if (aggUsage.inputTokens || aggUsage.outputTokens) {
          opts.onEvent({
            type: 'usage',
            inputTokens: aggUsage.inputTokens,
            outputTokens: aggUsage.outputTokens,
            cachedTokens: aggUsage.cachedTokens,
            costUsd: aggUsage.costUsd || undefined,
          });
        }
        if (stderrBuf.trim() && exitCode !== 0 && !aborted) {
          opts.onEvent({ type: 'error', message: stderrBuf.slice(-1000), recoverable: true });
        }
        resolve({
          newCliSessionId,
          exitCode: exitCode ?? -1,
          modifiedFiles: Array.from(modifiedFiles),
          durationMs: 0,
          usage: aggUsage,
          finalText,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timeoutTimer);
        this.logger.warn({ err }, 'v785 codex child error');
        opts.onEvent({ type: 'error', message: `codex spawn failed: ${err.message}`, recoverable: false });
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

  /**
   * Map codex' event-stream auf AgentEvent. Hauptfälle:
   *  - thread.started → session_id
   *  - turn.started → progress
   *  - item.completed mit item.type ∈ {assistant_message, command_execution, file_change, mcp_tool_call, todo_list, web_search, plan, image_input}
   *  - turn.completed mit usage → usage
   */
  private mapEvent(
    raw: any,
    emit: (e: AgentEvent) => void,
    helpers: {
      recordModified: (path: string) => void;
      nextItemId: () => string;
      setFinalText: (t: string) => void;
      setThreadId: (id: string) => void;
      addUsage: (u: { inputTokens: number; outputTokens: number; cachedTokens: number }) => void;
    },
  ): void {
    const type = String(raw.type ?? '');

    if (type === 'thread.started') {
      const tid = String(raw.thread_id ?? raw.threadId ?? '');
      if (tid) helpers.setThreadId(tid);
      emit({ type: 'progress', phase: 'thread-started', detail: tid.slice(0, 8) });
      return;
    }
    if (type === 'turn.started') {
      emit({ type: 'progress', phase: 'turn-started' });
      return;
    }
    if (type === 'turn.completed') {
      const u = raw.usage ?? {};
      const inputTokens = num(u.input_tokens ?? u.inputTokens);
      const outputTokens = num(u.output_tokens ?? u.outputTokens);
      const cachedTokens = num(u.cached_input_tokens ?? u.cachedInputTokens ?? u.cached_tokens);
      helpers.addUsage({ inputTokens, outputTokens, cachedTokens });
      emit({ type: 'progress', phase: 'turn-completed' });
      return;
    }
    if (type !== 'item.completed') {
      // turn.failed, item.started, image_input etc. — als generic progress
      emit({ type: 'progress', phase: type });
      return;
    }

    // item.completed mit getypten item-Payloads
    const item = raw.item ?? {};
    const itemType = String(item.type ?? 'unknown');
    const itemId = String(item.id ?? helpers.nextItemId());

    switch (itemType) {
      case 'assistant_message': {
        const text = String(item.text ?? item.content ?? '');
        if (text) {
          emit({ type: 'text', text });
          helpers.setFinalText(text);
        }
        return;
      }
      case 'reasoning':
      case 'thinking': {
        const text = String(item.text ?? item.content ?? '');
        if (text) emit({ type: 'thinking', text });
        return;
      }
      case 'command_execution': {
        const command = String(item.command ?? item.cmd ?? '');
        const status = String(item.status ?? '');
        const exitCode = item.exit_code !== undefined ? num(item.exit_code) : (item.exitCode !== undefined ? num(item.exitCode) : undefined);
        const output = String(item.output ?? item.stdout ?? '');
        // Codex emit'd 'command_execution' nach completion (nicht start + done).
        // Wir emit'n direkt das done-shell-event mit kompletten Daten.
        emit({
          type: 'shell',
          command,
          status: 'done',
          output,
          exitCode: typeof exitCode === 'number' ? exitCode : (status === 'success' ? 0 : 1),
          toolCallId: itemId,
        });
        return;
      }
      case 'file_change': {
        const path = String(item.path ?? item.file_path ?? '');
        const changeType = String(item.change_type ?? item.changeType ?? 'modify');
        const diff = String(item.diff ?? '');
        if (path) helpers.recordModified(path);
        // Parse unified-diff für before/after
        const { before, after, linesAdded, linesRemoved } = parseUnifiedDiff(diff, changeType);
        emit({
          type: 'edit',
          path,
          before, after, linesAdded, linesRemoved,
          toolCallId: itemId,
        });
        return;
      }
      case 'mcp_tool_call': {
        const tool = String(item.tool ?? item.name ?? 'mcp-tool');
        const input = item.input ?? item.arguments ?? {};
        const output = item.output ?? item.result ?? '';
        emit({ type: 'tool_call', tool, input, toolCallId: itemId });
        emit({
          type: 'tool_result',
          toolCallId: itemId,
          output: typeof output === 'string' ? output : JSON.stringify(output).slice(0, 4000),
        });
        return;
      }
      case 'web_search': {
        emit({
          type: 'tool_call',
          tool: 'web_search',
          input: { query: String(item.query ?? item.search ?? '') },
          toolCallId: itemId,
        });
        if (item.results) {
          emit({
            type: 'tool_result',
            toolCallId: itemId,
            output: typeof item.results === 'string' ? item.results : JSON.stringify(item.results).slice(0, 4000),
          });
        }
        return;
      }
      case 'todo_list': {
        const todos = Array.isArray(item.todos) ? item.todos : [];
        const summary = todos.map((t: any, i: number) => `${i + 1}. [${t.status ?? '?'}] ${t.text ?? t.title ?? '?'}`).join('\n');
        emit({ type: 'progress', phase: 'todo_list', detail: summary.slice(0, 500) });
        return;
      }
      case 'plan': {
        const text = String(item.text ?? item.content ?? '');
        emit({ type: 'progress', phase: 'plan', detail: text.slice(0, 500) });
        return;
      }
      case 'image_input': {
        emit({ type: 'progress', phase: 'image_input' });
        return;
      }
      default: {
        emit({ type: 'progress', phase: `item:${itemType}` });
        return;
      }
    }
  }
}

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = parseInt(v.replace(/,/g, ''), 10); return Number.isFinite(n) ? n : 0; }
  return 0;
}

/**
 * Parse unified-diff (z.B. aus codex' file_change.diff) → before/after strings + line-counts.
 * Fallback: nur line-counts (für riesige diffs ohne komplette Rekonstruktion).
 */
function parseUnifiedDiff(diff: string, changeType: string): {
  before: string; after: string; linesAdded: number; linesRemoved: number;
} {
  if (!diff) return { before: '', after: '', linesAdded: 0, linesRemoved: 0 };
  const lines = diff.split(/\r?\n/);
  const beforeLines: string[] = [];
  const afterLines: string[] = [];
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.startsWith('+++ ') || l.startsWith('--- ') || l.startsWith('@@')) continue;
    if (l.startsWith('+') && !l.startsWith('+++')) {
      afterLines.push(l.slice(1));
      added++;
    } else if (l.startsWith('-') && !l.startsWith('---')) {
      beforeLines.push(l.slice(1));
      removed++;
    } else if (l.startsWith(' ')) {
      const ctx = l.slice(1);
      beforeLines.push(ctx);
      afterLines.push(ctx);
    }
  }
  if (changeType === 'create' || changeType === 'add') {
    return { before: '', after: afterLines.join('\n'), linesAdded: added, linesRemoved: 0 };
  }
  if (changeType === 'delete' || changeType === 'remove') {
    return { before: beforeLines.join('\n'), after: '', linesAdded: 0, linesRemoved: removed };
  }
  return {
    before: beforeLines.join('\n'),
    after: afterLines.join('\n'),
    linesAdded: added,
    linesRemoved: removed,
  };
}
