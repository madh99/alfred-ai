/**
 * v779 — AgentSession Layer: Common Event-Types + Adapter-Interface
 *
 * Zwischen-Schicht zwischen Alfred und CLI-Coding-Agents (claude-code, codex, vibe, ...).
 * Jeder CLI hat eigenes Output-Format (Anthropic-blocks / OpenAI-chat / Event-Stream),
 * der jeweilige Adapter mapped es auf diese common AgentEvent-Types damit das Frontend
 * einheitlich Cards rendern kann.
 */

/** Common Event-Stream — unabhängig vom CLI-Backend. */
export type AgentEvent =
  /** Beim ersten Run: CLI vergibt session-id, wir persistieren sie für resume. */
  | { type: 'session_id'; value: string }
  /** Plain-text assistant message chunk. Bei streaming-CLIs kommt das in mehreren chunks. */
  | { type: 'text'; text: string }
  /** Agent denkt nach (claude's 'thinking', vibe's 'reasoning_content', codex' reasoning_output_tokens). */
  | { type: 'thinking'; text: string }
  /** Agent ruft ein typed-Tool auf (Read/Edit/Glob/Grep/...). Für claude/vibe-style. */
  | { type: 'tool_call'; tool: string; input: unknown; toolCallId: string }
  /** Tool-Result kommt zurück. */
  | { type: 'tool_result'; toolCallId: string; output: unknown; durationMs?: number }
  /** Edit-Tool-Use enriched mit Diff (vom Adapter aus tool_call.input extrahiert). */
  | { type: 'edit'; path: string; before: string; after: string; linesAdded: number; linesRemoved: number; toolCallId: string }
  /** Shell-Command-Execution (codex' command_execution, claude's Bash-tool, vibe's bash-tool). */
  | { type: 'shell'; command: string; status: 'running' | 'done'; output?: string; exitCode?: number; toolCallId: string }
  /** Usage/Cost-Tracking — kommt am Ende eines Runs. */
  | { type: 'usage'; inputTokens: number; outputTokens: number; cachedTokens?: number; reasoningTokens?: number; costUsd?: number }
  /** Fehler aus dem CLI (z.B. rate-limit, broken process). */
  | { type: 'error'; message: string; recoverable: boolean }
  /** Generischer Progress-Marker (Phase-Wechsel, "lade...", etc.). */
  | { type: 'progress'; phase: string; detail?: string };


/** Adapter-Capabilities — was kann diese spezifische CLI? */
export interface AgentAdapterCapabilities {
  /** Wie die CLI ihre Session persistiert. */
  persistence: 'flag-resume' | 'long-process' | 'disk-state' | 'none';
  /** Streamt strukturiertes JSON (nicht nur plain-text)? */
  structuredOutput: boolean;
  /** Streamt token-by-token (vs am-Ende-batch)? */
  streamingTokens: boolean;
  /** Kann via Signal abgebrochen werden? */
  supportsAbort: boolean;
  /** Hat eingebautes Prompt-Caching (Token-Cost-Reduction)? */
  supportsCaching: boolean;
}


/** Result eines invoke()-Aufrufs. */
export interface AgentInvokeResult {
  /** Falls neue Session: die vom CLI vergebene Session-ID. Falls existierende: undefined. */
  newCliSessionId?: string;
  exitCode: number;
  /** Files die der Agent modifiziert hat (aus tool-use detection oder diff). */
  modifiedFiles: string[];
  durationMs: number;
  /** Aggregierte Token-Usage des Runs. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    reasoningTokens?: number;
    costUsd?: number;
  };
  /** Falls Adapter selbst erkennt dass die Session nicht mehr nutzbar ist. */
  sessionInvalidated?: boolean;
  /** Optional: ein letzter assistant-text als "summary" für UI-Display. */
  finalText?: string;
}


export interface AgentInvokeOptions {
  /** null = neue Session, sonst CLI-eigene session-id für resume. */
  cliSessionId: string | null;
  /** Optionale UUID die wir der CLI vorgeben (nur wenn `--session-id`-Flag supported). */
  preferredSessionId?: string;
  prompt: string;
  cwd: string;
  /** runAsUser für sudo -u <user> wrapping. */
  runAsUser?: string;
  signal: AbortSignal;
  /** Wird pro Event called — Adapter mapped CLI-spezifisches Format auf AgentEvent. */
  onEvent: (event: AgentEvent) => void;
  /** Per-Run timeout. */
  timeoutMs?: number;
  /** Optional: kurze Zusatz-Anweisung die im Prompt vorangestellt wird (z.B. read-only-mode-hint für Discuss). */
  promptPrefix?: string;
  /**
   * v802 — Read-only-Modus für Discuss/Beratung. Adapter mappen zu CLI-spezifischen
   * Flags (claude-code: --permission-mode=plan; andere ignorieren oder setzen
   * eigene read-only-flag).
   * Default false (= normal write-able mode).
   */
  readOnly?: boolean;
}


/**
 * Pro CLI-Agent ein Adapter. Stateless-Klasse — alle Session-State liegt in der DB,
 * der Adapter ist nur die Code-Strategy zum Mappen + Spawn.
 */
export interface AgentSessionAdapter {
  readonly name: string;
  readonly capabilities: AgentAdapterCapabilities;

  /** Startet einen Run. Wenn cliSessionId=null → neue Session, sonst resume. */
  invoke(opts: AgentInvokeOptions): Promise<AgentInvokeResult>;

  /** Optional: prüft ob die Session noch nutzbar ist (z.B. state-file existiert, process lebt). */
  isHealthy(cliSessionId: string, runAsUser?: string): Promise<boolean>;

  /** Optional: räumt CLI-eigenen state auf (state-files löschen, process killen). */
  destroy(cliSessionId: string, runAsUser?: string): Promise<void>;
}
