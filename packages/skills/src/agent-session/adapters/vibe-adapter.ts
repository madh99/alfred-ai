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
 * v784 — VibeAdapter (Mistral Vibe)
 *
 * Spawnt `vibe -p <prompt> --output streaming --trust --workdir <cwd>`. Optional
 * `--resume <session-id>` für Session-Continuation.
 *
 * Output-Format ist **OpenAI-Chat-Completion-style** (anders als Claude's Anthropic-blocks):
 *   {"role": "system",    "content": "<long system prompt>"}
 *   {"role": "user",      "content": "<user prompt>"}
 *   {"role": "assistant", "content": "<text>", "reasoning_content": "...", "tool_calls": [{...}]}
 *   {"role": "tool",      "content": "<result>", "tool_call_id": "<id>", "name": "<tool>"}
 *
 * Tool-Call-Shape (OpenAI-style):
 *   {"id": "abc", "function": {"name": "read_file", "arguments": "{\"path\":\"foo.ts\"}"}, "type": "function"}
 *
 * Vibe-Tools sind snake_case: read_file, write_file, search_replace, bash, grep, task, todo, ...
 *
 * Session-ID: vibe vergibt eine ID, gibt sie aber NICHT in der stream-json aus.
 * Stattdessen wird sie am Run-Ende auf stderr geprintet wie:
 *   "Or: vibe --resume 418496da"
 * Wir parsen stderr für diesen Pattern.
 *
 * Verifiziert mit vibe v2.10.1 (auf alfred .92).
 */

const VIBE_BIN = process.env.ALFRED_VIBE_BIN ?? 'vibe';
const SESSION_ID_REGEX = /vibe\s+--resume\s+([0-9a-f]{6,})/i;

export class VibeAdapter implements AgentSessionAdapter {
  readonly name = 'vibe';
  readonly capabilities: AgentAdapterCapabilities = {
    persistence: 'flag-resume',
    structuredOutput: true,
    streamingTokens: false, // vibe streamt nicht token-by-token, sondern message-by-message
    supportsAbort: true,
    supportsCaching: true,
  };

  constructor(private readonly logger: Logger) {}

  async invoke(opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
    const args: string[] = [
      '-p', // programmatic mode
      '--output', 'streaming',
      '--trust',
      '--workdir', opts.cwd,
    ];
    if (opts.cliSessionId) {
      args.push('--resume', opts.cliSessionId);
    }
    const promptToSend = opts.promptPrefix ? `${opts.promptPrefix}\n\n${opts.prompt}` : opts.prompt;
    args.push(promptToSend);

    const cmd = opts.runAsUser ? 'sudo' : VIBE_BIN;
    const cmdArgs = opts.runAsUser ? ['-u', opts.runAsUser, VIBE_BIN, ...args] : args;

    this.logger.info({ agent: 'vibe', cwd: opts.cwd, resume: !!opts.cliSessionId, runAsUser: opts.runAsUser }, 'v784 vibe invoke');

    const startTime = Date.now();
    const result = await this.runChild(cmd, cmdArgs, opts);
    result.durationMs = Date.now() - startTime;
    return result;
  }

  async isHealthy(_cliSessionId: string, _runAsUser?: string): Promise<boolean> {
    // vibe persistiert Sessions in ~/.vibe/sessions/ (vermutet).
    // Default trust — falls --resume failt, sehen wir das im invoke().
    return true;
  }

  async destroy(_cliSessionId: string, _runAsUser?: string): Promise<void> {
    // Kein CLI-Command zum Session-Löschen. Vibe macht eigenes cleanup nach Inaktivität.
  }

  private runChild(cmd: string, args: string[], opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
    return new Promise<AgentInvokeResult>((resolve) => {
      const isWindows = process.platform === 'win32';
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...(process.env as Record<string, string>) },
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
        opts.onEvent({ type: 'error', message: `vibe timeout after ${timeoutMs}ms`, recoverable: true });
        onAbort();
      }, timeoutMs);

      // State
      let newCliSessionId: string | undefined;
      const modifiedFiles = new Set<string>();
      const toolNameById = new Map<string, string>();
      let aggUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
      let finalText: string | undefined;
      let stderrBuf = '';

      // stdout: line-by-line JSON parsing
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let raw: any;
        try { raw = JSON.parse(trimmed); }
        catch (err) {
          this.logger.debug({ err, line: trimmed.slice(0, 200) }, 'v784 vibe non-JSON line, ignored');
          return;
        }
        try {
          this.mapEvent(raw, opts.onEvent, {
            recordModified: (path) => { if (path) modifiedFiles.add(path); },
            registerToolName: (id, name) => { toolNameById.set(id, name); },
            getToolName: (id) => toolNameById.get(id) ?? 'unknown',
            setFinalText: (t) => { finalText = t; },
          });
        } catch (err) {
          this.logger.warn({ err, role: raw?.role }, 'v784 vibe event mapping failed');
        }
      });

      // stderr: parse für session-id + token-stats
      child.stderr.on('data', (chunk: Buffer) => {
        const txt = chunk.toString();
        stderrBuf += txt;
        if (stderrBuf.length > 50_000) stderrBuf = stderrBuf.slice(-50_000);
        // Session-ID-Pattern: "vibe --resume <id>"
        const m = txt.match(SESSION_ID_REGEX);
        if (m && !newCliSessionId && !opts.cliSessionId) {
          newCliSessionId = m[1];
          opts.onEvent({ type: 'session_id', value: m[1] });
        }
        // Token-Stats: "Total tokens used this session: input=17,011 output=55 (total=17,066)"
        const tokM = txt.match(/input=(\d[\d,]*).*?output=(\d[\d,]*)/);
        if (tokM) {
          aggUsage.inputTokens = parseInt(tokM[1].replace(/,/g, ''), 10);
          aggUsage.outputTokens = parseInt(tokM[2].replace(/,/g, ''), 10);
        }
      });

      child.on('close', (exitCode) => {
        clearTimeout(timeoutTimer);
        if (opts.signal.removeEventListener) {
          opts.signal.removeEventListener('abort', onAbort);
        }
        // Final stderr-scan falls noch nichts gefunden
        if (!newCliSessionId && !opts.cliSessionId) {
          const m = stderrBuf.match(SESSION_ID_REGEX);
          if (m) {
            newCliSessionId = m[1];
            opts.onEvent({ type: 'session_id', value: m[1] });
          }
        }
        // Emit final usage-event wenn wir Tokens haben
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
          durationMs: 0, // wird vom caller überschrieben
          usage: aggUsage,
          finalText,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timeoutTimer);
        this.logger.warn({ err }, 'v784 vibe child error');
        opts.onEvent({ type: 'error', message: `vibe spawn failed: ${err.message}`, recoverable: false });
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

  /** Map vibe role-based JSON-message auf AgentEvents. */
  private mapEvent(
    raw: any,
    emit: (e: AgentEvent) => void,
    helpers: {
      recordModified: (path: string) => void;
      registerToolName: (id: string, name: string) => void;
      getToolName: (id: string) => string;
      setFinalText: (t: string) => void;
    },
  ): void {
    if (raw.role === 'system') {
      // Ignore — riesiger system-prompt, nicht für UI relevant
      return;
    }
    if (raw.role === 'user') {
      // Echo des prompts, ignorieren
      return;
    }
    if (raw.role === 'assistant') {
      // reasoning_content (Mistral's thinking)
      if (typeof raw.reasoning_content === 'string' && raw.reasoning_content.trim()) {
        emit({ type: 'thinking', text: raw.reasoning_content });
      }
      // content (text response)
      if (typeof raw.content === 'string' && raw.content.trim()) {
        emit({ type: 'text', text: raw.content });
        helpers.setFinalText(raw.content);
      }
      // tool_calls[] (OpenAI-style)
      if (Array.isArray(raw.tool_calls)) {
        for (const tc of raw.tool_calls) {
          if (!tc || tc.type !== 'function' || !tc.function) continue;
          const name = String(tc.function.name ?? '?');
          const id = String(tc.id ?? `vibe-tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
          let input: unknown;
          try { input = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments; }
          catch { input = tc.function.arguments; }
          helpers.registerToolName(id, name);

          // Generic tool_call
          emit({ type: 'tool_call', tool: name, input, toolCallId: id });

          // Spezialisierungen
          if (name === 'search_replace' && input && typeof input === 'object') {
            const obj = input as Record<string, unknown>;
            const filePath = String(obj.file_path ?? '');
            const content = String(obj.content ?? '');
            if (filePath) {
              helpers.recordModified(filePath);
              // SEARCH/REPLACE block parsen → before/after extrahieren
              const { before, after } = parseSearchReplaceBlocks(content);
              const linesAdded = (after.match(/\n/g) ?? []).length + (after ? 1 : 0);
              const linesRemoved = (before.match(/\n/g) ?? []).length + (before ? 1 : 0);
              emit({
                type: 'edit',
                path: filePath,
                before, after, linesAdded, linesRemoved,
                toolCallId: id,
              });
            }
          } else if (name === 'write_file' && input && typeof input === 'object') {
            const obj = input as Record<string, unknown>;
            const filePath = String(obj.path ?? obj.file_path ?? '');
            if (filePath) {
              helpers.recordModified(filePath);
              const content = String(obj.content ?? '');
              const linesAdded = (content.match(/\n/g) ?? []).length + 1;
              emit({
                type: 'edit',
                path: filePath,
                before: '', after: content, linesAdded, linesRemoved: 0,
                toolCallId: id,
              });
            }
          } else if (name === 'bash' && input && typeof input === 'object') {
            const obj = input as Record<string, unknown>;
            const command = String(obj.command ?? obj.cmd ?? '');
            emit({
              type: 'shell',
              command,
              status: 'running',
              toolCallId: id,
            });
          }
        }
      }
      return;
    }
    if (raw.role === 'tool') {
      // Tool-Result
      const id = String(raw.tool_call_id ?? '');
      const toolName = helpers.getToolName(id) || String(raw.name ?? 'unknown');
      const content = String(raw.content ?? '');
      if (toolName === 'bash') {
        // Versuche exit-code zu detecten ("exit_code: 0" pattern in content)
        const exitM = content.match(/exit[_\s]*code[:\s]+(\d+)/i);
        const exitCode = exitM ? parseInt(exitM[1], 10) : (raw.is_error ? 1 : 0);
        emit({
          type: 'shell',
          command: '',
          status: 'done',
          output: content,
          exitCode,
          toolCallId: id,
        });
      } else {
        emit({ type: 'tool_result', toolCallId: id, output: content });
      }
      return;
    }
    // Unknown role
    this.logger.debug({ role: raw.role }, 'v784 vibe unknown role');
  }
}

/**
 * Parse vibe's search_replace-content das aus mehreren SEARCH/REPLACE-Blöcken besteht:
 *   <<<<<<< SEARCH
 *   old code
 *   =======
 *   new code
 *   >>>>>>> REPLACE
 *
 * Wir konkatenieren alle SEARCH-Bereiche als before, alle REPLACE-Bereiche als after.
 * Vereinfachung: ein Edit pro Block ist genauer, aber wir wollen nur eine Edit-Card.
 */
function parseSearchReplaceBlocks(content: string): { before: string; after: string } {
  const blocks: Array<{ search: string; replace: string }> = [];
  const re = /<<<<<<< SEARCH\n([\s\S]*?)\n=======+\n([\s\S]*?)\n>>>>>>> REPLACE/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    blocks.push({ search: m[1], replace: m[2] });
  }
  if (blocks.length === 0) {
    // Fallback: ganzer content als after (z.B. partial)
    return { before: '', after: content };
  }
  return {
    before: blocks.map(b => b.search).join('\n\n'),
    after: blocks.map(b => b.replace).join('\n\n'),
  };
}
