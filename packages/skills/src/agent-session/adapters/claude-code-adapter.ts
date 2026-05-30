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
 * v780 — ClaudeCodeAdapter
 *
 * Spawnt `claude --print --verbose --output-format=stream-json` und parsed das line-by-line.
 * Mapped Anthropic-style message-blocks (content[].type=text|tool_use|thinking) auf
 * unsere common AgentEvent-Types.
 *
 * Verifiziert mit claude-code v2.1.86 (auf alfred .92):
 *  - `--session-id=<uuid>` setzt explizite Session-ID beim Erst-Run
 *  - `--resume <session-id>` resumed eine bestehende (Tool-Call-Cache erhalten)
 *  - `--permission-mode=bypassPermissions` für non-interactive headless
 *  - stream-json events: system/init, assistant, user, rate_limit_event, result
 *
 * Edit-Diff: claude's Edit-Tool hat input={file_path, old_string, new_string} → wir
 * emitten zusätzlich zu tool_call ein 'edit'-Event mit before/after damit Frontend
 * inline-diff rendern kann.
 *
 * Bash-Tool: emitted als 'shell'-Event (parallel zu codex' command_execution).
 */

const CLAUDE_BIN = process.env.ALFRED_CLAUDE_BIN ?? 'claude';

export class ClaudeCodeAdapter implements AgentSessionAdapter {
  readonly name = 'claude-code';
  readonly capabilities: AgentAdapterCapabilities = {
    persistence: 'flag-resume',
    structuredOutput: true,
    streamingTokens: true,
    supportsAbort: true,
    supportsCaching: true,
  };

  constructor(private readonly logger: Logger) {}

  async invoke(opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
    // v802 — Read-only-Modus für Discuss/Beratung: claude --permission-mode=plan
    // restringiert auf Read/Grep/Glob/WebFetch/WebSearch/TodoWrite — keine Edit/Write/Bash.
    // Default 'bypassPermissions' = volle Tools für Quick/Plan-Mode.
    const permMode = opts.readOnly ? 'plan' : 'bypassPermissions';
    const args: string[] = [
      '--print',
      '--verbose',
      '--output-format=stream-json',
      '--permission-mode', permMode,
    ];
    // v818 D1 — Defense-in-Depth: explizite Disallow-Liste für Write-Tools im
    // readOnly-Modus. Vorher verließ sich Discuss NUR auf --permission-mode=plan
    // + nachgelagerten git-checkout-Revert als Safety-Net. Bei einem Adapter-
    // Bug oder Plan-Mode-Bypass hätte der Agent Files schreiben können. Mit
    // --disallowedTools lehnt claude-code die Tool-Calls hart ab BEVOR sie laufen.
    if (opts.readOnly) {
      args.push('--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit,Bash');
    }
    if (opts.cliSessionId) {
      args.push('--resume', opts.cliSessionId);
    } else if (opts.preferredSessionId && /^[0-9a-f-]{36}$/i.test(opts.preferredSessionId)) {
      args.push('--session-id', opts.preferredSessionId);
    }
    const promptToSend = opts.promptPrefix ? `${opts.promptPrefix}\n\n${opts.prompt}` : opts.prompt;
    args.push(promptToSend);

    // sudo -u <user> falls runAsUser gesetzt
    const cmd = opts.runAsUser ? 'sudo' : CLAUDE_BIN;
    const cmdArgs = opts.runAsUser ? ['-u', opts.runAsUser, CLAUDE_BIN, ...args] : args;

    this.logger.info({ agent: 'claude-code', cwd: opts.cwd, resume: !!opts.cliSessionId, runAsUser: opts.runAsUser }, 'v780 claude invoke');

    const startTime = Date.now();
    const result = await this.runChild(cmd, cmdArgs, opts);
    result.durationMs = Date.now() - startTime;
    return result;
  }

  async isHealthy(_cliSessionId: string, _runAsUser?: string): Promise<boolean> {
    // claude-code persistiert Sessions in ~/.claude/projects/<cwd-hash>/<session-id>.jsonl
    // Per default trust we're healthy — falls --resume fehlschlägt feuert das adapter den
    // sessionInvalidated-Pfad. Echter Health-Check würde stat() machen, aber wir wissen
    // den hash-Algorithmus nicht zuverlässig. Return true und lass invoke() fehlschlagen.
    return true;
  }

  async destroy(_cliSessionId: string, _runAsUser?: string): Promise<void> {
    // claude-code hat keinen CLI-Befehl zum Löschen einer Session.
    // State-File liegt in ~/.claude/projects/<hash>/<id>.jsonl — könnten wir löschen,
    // aber riskant (falscher Hash → falsche Files weg). Best-effort: nichts tun,
    // Session wird vom claude-CLI selbst aufgeräumt nach Inaktivität.
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

      // Timeout (hart)
      const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
      const timeoutTimer = setTimeout(() => {
        opts.onEvent({ type: 'error', message: `claude timeout after ${timeoutMs}ms`, recoverable: true });
        onAbort();
      }, timeoutMs);

      // State während des Runs
      let newCliSessionId: string | undefined;
      const modifiedFiles = new Set<string>();
      let aggUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, costUsd: 0 };
      let finalText: string | undefined;
      const toolNameById = new Map<string, string>(); // für tool_result → tool-name-lookup

      // Line-by-line JSON-parsing aus stdout
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let raw: any;
        try { raw = JSON.parse(trimmed); }
        catch (err) {
          this.logger.debug({ err, line: trimmed.slice(0, 200) }, 'v780 claude non-JSON line, ignored');
          return;
        }
        try {
          this.mapEvent(raw, opts.onEvent, {
            captureSessionId: (id) => { if (!newCliSessionId && !opts.cliSessionId) newCliSessionId = id; },
            recordModified: (path) => { if (path) modifiedFiles.add(path); },
            recordUsage: (u) => {
              if (u.input_tokens != null) aggUsage.inputTokens += u.input_tokens;
              if (u.output_tokens != null) aggUsage.outputTokens += u.output_tokens;
              if (u.cache_read_input_tokens != null) aggUsage.cachedTokens += u.cache_read_input_tokens;
              if (u.cache_creation_input_tokens != null) aggUsage.cachedTokens += u.cache_creation_input_tokens;
            },
            recordCost: (c) => { aggUsage.costUsd = (aggUsage.costUsd ?? 0) + (c ?? 0); },
            registerToolName: (id, name) => { toolNameById.set(id, name); },
            getToolName: (id) => toolNameById.get(id) ?? 'unknown',
            setFinalText: (t) => { finalText = t; },
          });
        } catch (err) {
          this.logger.warn({ err, eventType: raw?.type }, 'v780 claude event mapping failed');
        }
      });

      let stderrBuf = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        if (stderrBuf.length > 50_000) stderrBuf = stderrBuf.slice(-50_000);
      });

      child.on('close', (exitCode) => {
        clearTimeout(timeoutTimer);
        if (opts.signal.removeEventListener) {
          opts.signal.removeEventListener('abort', onAbort);
        }
        if (stderrBuf.trim() && exitCode !== 0) {
          opts.onEvent({ type: 'error', message: stderrBuf.slice(-1000), recoverable: true });
        }
        // result-event hat die finale costUsd → falls schon gesetzt, nicht überschreiben
        resolve({
          newCliSessionId,
          exitCode: exitCode ?? -1,
          modifiedFiles: Array.from(modifiedFiles),
          durationMs: 0, // wird vom caller überschrieben
          usage: {
            inputTokens: aggUsage.inputTokens,
            outputTokens: aggUsage.outputTokens,
            cachedTokens: aggUsage.cachedTokens,
            reasoningTokens: aggUsage.reasoningTokens || undefined,
            costUsd: aggUsage.costUsd || undefined,
          },
          sessionInvalidated: aborted ? false : undefined,
          finalText,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timeoutTimer);
        this.logger.warn({ err }, 'v780 claude child error');
        opts.onEvent({ type: 'error', message: `claude spawn failed: ${err.message}`, recoverable: false });
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

  /** Map ein claude stream-json event auf unsere AgentEvents. */
  private mapEvent(
    raw: any,
    emit: (e: AgentEvent) => void,
    helpers: {
      captureSessionId: (id: string) => void;
      recordModified: (path: string) => void;
      recordUsage: (u: any) => void;
      recordCost: (c: number) => void;
      registerToolName: (id: string, name: string) => void;
      getToolName: (id: string) => string;
      setFinalText: (t: string) => void;
    },
  ): void {
    switch (raw.type) {
      case 'system':
        if (raw.subtype === 'init' && typeof raw.session_id === 'string') {
          helpers.captureSessionId(raw.session_id);
          emit({ type: 'session_id', value: raw.session_id });
          emit({ type: 'progress', phase: 'session-init', detail: `model: ${raw.model ?? '?'}` });
        }
        return;

      case 'assistant':
        if (raw.message?.usage) helpers.recordUsage(raw.message.usage);
        const content = Array.isArray(raw.message?.content) ? raw.message.content : [];
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            emit({ type: 'text', text: block.text });
            helpers.setFinalText(block.text);
          } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
            emit({ type: 'thinking', text: block.thinking });
          } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
            helpers.registerToolName(block.id, block.name);
            // Generic tool_call event
            emit({ type: 'tool_call', tool: block.name, input: block.input, toolCallId: block.id });
            // Spezialisierungen
            if (block.name === 'Edit' && block.input?.file_path) {
              const before = String(block.input.old_string ?? '');
              const after = String(block.input.new_string ?? '');
              const linesAdded = (after.match(/\n/g) ?? []).length + (after && !after.endsWith('\n') ? 1 : 0);
              const linesRemoved = (before.match(/\n/g) ?? []).length + (before && !before.endsWith('\n') ? 1 : 0);
              helpers.recordModified(String(block.input.file_path));
              emit({
                type: 'edit',
                path: String(block.input.file_path),
                before, after, linesAdded, linesRemoved,
                toolCallId: block.id,
              });
            } else if (block.name === 'Write' && block.input?.file_path) {
              helpers.recordModified(String(block.input.file_path));
              const content = String(block.input.content ?? '');
              const linesAdded = (content.match(/\n/g) ?? []).length + 1;
              emit({
                type: 'edit',
                path: String(block.input.file_path),
                before: '', after: content, linesAdded, linesRemoved: 0,
                toolCallId: block.id,
              });
            } else if (block.name === 'Bash' && block.input?.command) {
              emit({
                type: 'shell',
                command: String(block.input.command),
                status: 'running',
                toolCallId: block.id,
              });
            }
          }
        }
        return;

      case 'user':
        // tool_result Events
        const userContent = Array.isArray(raw.message?.content) ? raw.message.content : [];
        for (const block of userContent) {
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            const toolName = helpers.getToolName(block.tool_use_id);
            // Bei Bash: emit shell-done event mit output
            if (toolName === 'Bash') {
              const out = typeof block.content === 'string'
                ? block.content
                : (Array.isArray(block.content) ? block.content.map((c: any) => c.text ?? '').join('') : '');
              emit({
                type: 'shell',
                command: '', // already emitted on tool_use
                status: 'done',
                output: out,
                exitCode: block.is_error ? 1 : 0,
                toolCallId: block.tool_use_id,
              });
            } else {
              emit({
                type: 'tool_result',
                toolCallId: block.tool_use_id,
                output: block.content,
              });
            }
          }
        }
        return;

      case 'rate_limit_event':
        // Optional ans UI, low-prio
        return;

      case 'result':
        if (raw.usage) helpers.recordUsage(raw.usage);
        if (typeof raw.total_cost_usd === 'number') helpers.recordCost(raw.total_cost_usd);
        if (typeof raw.result === 'string') helpers.setFinalText(raw.result);
        emit({
          type: 'usage',
          inputTokens: raw.usage?.input_tokens ?? 0,
          outputTokens: raw.usage?.output_tokens ?? 0,
          cachedTokens: (raw.usage?.cache_read_input_tokens ?? 0) + (raw.usage?.cache_creation_input_tokens ?? 0),
          costUsd: raw.total_cost_usd ?? undefined,
        });
        if (raw.subtype === 'success') {
          emit({ type: 'progress', phase: 'done' });
        } else {
          emit({ type: 'error', message: String(raw.error ?? raw.subtype ?? 'unknown error'), recoverable: false });
        }
        return;

      default:
        // unknown event types — log debug, skip
        this.logger.debug({ type: raw.type }, 'v780 claude unknown event type');
        return;
    }
  }
}
