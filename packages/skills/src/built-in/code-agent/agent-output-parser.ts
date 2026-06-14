/**
 * v844 — Parser für die strukturierten Stream-Output-Formate von Claude-Code,
 * Codex und Mistral-Vibe.
 *
 * Hintergrund: Die default-`--print`-Modi dieser drei Agents puffern stdout
 * bis zum Phasen-Ende. Bei langen Phasen (Audit, Repo-Recherche, Multi-File-
 * Refactor) führt das zu 10+ min stdout-Stille — der inactivity-Timer im
 * agent-executor killt den Agent mitten in der Arbeit. Empirisch ~37 %
 * failure-Rate bei claude-code (Postgres-Stats, 14 Tage).
 *
 * Mit Stream-Mode:
 *  - claude `--output-format stream-json --verbose`      → 1 JSON-line/event
 *  - codex `exec --json`                                 → JSONL events
 *  - vibe  `-p --output streaming`                       → JSONL per message
 *
 * Der Parser:
 *  - extrahiert pro JSON-line ein human-readable Progress-Snippet
 *    (`🔧 Bash: ls src/`, `📖 Read: package.json`, `💬 (Antwort-Text)`),
 *  - hält den finalen Text-content für den Caller bereit (extractedText),
 *  - tolerant gegenüber unbekannten event-types (skip statt throw).
 */

export type AgentOutputFormat = 'text' | 'claude-stream-json' | 'codex-jsonl' | 'vibe-streaming';

/** v866 — Token-Usage eines Agent-Laufs (aus result-/turn.completed-Events). */
export interface ParsedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** API-Äquivalent-Kosten laut CLI (bei Subscriptions informativ, nicht abgerechnet). */
  costUsd?: number;
}

export interface ParsedChunk {
  /** Menschenlesbare Progress-Zeilen (mehrere möglich pro Input-Zeile). */
  progress: string[];
  /** Final-Text-Snippets, die als Teil der Agent-Antwort gelten. */
  finalTextChunks: string[];
  /** True wenn Agent ein Terminal-Event (result/turn.completed) gemeldet hat. */
  ended: boolean;
  /** v866 — Token-Usage, wenn dieses Event welche meldet (vorher verworfen). */
  usage?: ParsedUsage;
  /** v866 — Modell aus dem init-Event (z.B. claude-fable-5). */
  model?: string;
}

const EMPTY: ParsedChunk = { progress: [], finalTextChunks: [], ended: false };

/**
 * Sniff: erste nicht-leere Zeile → wenn `{`-Start → JSON-mode.
 * Wird genutzt wenn outputFormat='text' aber Inhalt JSON ist (fallback),
 * sonst auch wenn ein Agent Mid-Stream auf JSON wechselt.
 */
export function looksLikeJsonl(firstLine: string): boolean {
  const t = firstLine.trim();
  return t.length > 0 && t.startsWith('{') && t.endsWith('}');
}

interface ParserState {
  /** Bei `text`-Mode: einfach alles als Final akkumulieren. */
  format: AgentOutputFormat;
}

export function createParserState(format: AgentOutputFormat): ParserState {
  return { format };
}

/**
 * Verarbeitet eine einzelne Output-Zeile. Mehrzeilige Chunks vor dem Aufruf
 * splitten (z.B. `text.split(/\r?\n/)`). Leere Zeilen → no-op.
 */
export function parseLine(state: ParserState, line: string): ParsedChunk {
  const trimmed = line.replace(/\r$/, '');
  if (trimmed.length === 0) return EMPTY;

  if (state.format === 'text') {
    return { progress: [trimmed], finalTextChunks: [trimmed], ended: false };
  }

  // JSON-modes
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Manche Agents printen Pre-/Post-Streaming-Banner als Text (z.B. codex
    // schreibt "Reading additional input from stdin..." auf stderr). Wir
    // tolerieren das und behandeln die Zeile als progress-only.
    return { progress: [trimmed], finalTextChunks: [], ended: false };
  }

  if (!parsed || typeof parsed !== 'object') return EMPTY;

  switch (state.format) {
    case 'claude-stream-json': return parseClaudeEvent(parsed as Record<string, unknown>);
    case 'codex-jsonl':        return parseCodexEvent(parsed as Record<string, unknown>);
    case 'vibe-streaming':     return parseVibeEvent(parsed as Record<string, unknown>);
    default:                   return EMPTY;
  }
}

// ────────────────────────────── Claude ──────────────────────────────

function parseClaudeEvent(evt: Record<string, unknown>): ParsedChunk {
  const type = evt.type as string | undefined;
  if (!type) return EMPTY;

  switch (type) {
    case 'system': {
      const subtype = evt.subtype as string | undefined;
      if (subtype === 'init') {
        const model = (evt.model as string) ?? 'unknown';
        // v866 — model strukturiert mitliefern (für CLI-Usage-Tracking)
        return { progress: [`🚀 Claude init (model=${model})`], finalTextChunks: [], ended: false, model };
      }
      return { progress: [`ℹ system/${subtype ?? '?'}`], finalTextChunks: [], ended: false };
    }
    case 'assistant': {
      const message = evt.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? message!.content as Array<Record<string, unknown>> : [];
      const progress: string[] = [];
      const finalTextChunks: string[] = [];
      for (const item of content) {
        if (item.type === 'tool_use') {
          progress.push(formatClaudeToolUse(item));
        } else if (item.type === 'text') {
          const txt = String(item.text ?? '').trim();
          if (txt.length > 0) {
            progress.push(`💬 ${truncate(txt, 200)}`);
            finalTextChunks.push(txt);
          }
        }
      }
      return { progress, finalTextChunks, ended: false };
    }
    case 'user': {
      // tool_result events — keep light progress, no final text
      const message = evt.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? message!.content as Array<Record<string, unknown>> : [];
      const progress: string[] = [];
      for (const item of content) {
        if (item.type === 'tool_result') {
          const isErr = item.is_error === true;
          progress.push(isErr ? '❌ tool error' : '✓ tool result');
        }
      }
      return { progress, finalTextChunks: [], ended: false };
    }
    case 'rate_limit_event': {
      const info = evt.rate_limit_info as Record<string, unknown> | undefined;
      const status = info?.status ?? 'unknown';
      return { progress: [`⏱ rate-limit: ${status}`], finalTextChunks: [], ended: false };
    }
    case 'result': {
      const success = evt.subtype === 'success';
      const text = evt.result as string | undefined;
      const cost = evt.total_cost_usd as number | undefined;
      const progress = [`🏁 result (${success ? 'success' : 'error'}${cost !== undefined ? `, $${cost.toFixed(4)}` : ''})`];
      const finalTextChunks = text && text.length > 0 ? [text] : [];
      // v866 — Usage strukturiert extrahieren (vorher: nur Kosten als Progress-
      // String gerendert, Token-Zahlen komplett verworfen).
      const u = evt.usage as Record<string, unknown> | undefined;
      const usage = u ? {
        inputTokens: Number(u.input_tokens ?? 0),
        outputTokens: Number(u.output_tokens ?? 0),
        cacheReadTokens: Number(u.cache_read_input_tokens ?? 0),
        costUsd: cost,
      } : (cost !== undefined ? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: cost } : undefined);
      return { progress, finalTextChunks, ended: true, usage };
    }
    default:
      return EMPTY;
  }
}

function formatClaudeToolUse(item: Record<string, unknown>): string {
  const name = String(item.name ?? '?');
  const input = item.input as Record<string, unknown> | undefined;
  const label = pickToolLabel(name, input);
  return `🔧 ${name}${label ? `: ${label}` : ''}`;
}

function pickToolLabel(name: string, input?: Record<string, unknown>): string {
  if (!input) return '';
  switch (name) {
    case 'Bash':       return truncate(String(input.command ?? ''), 80);
    case 'Read':       return String(input.file_path ?? '');
    case 'Edit':
    case 'Write':      return String(input.file_path ?? '');
    case 'Glob':       return String(input.pattern ?? '');
    case 'Grep':       return String(input.pattern ?? '');
    case 'TodoWrite':  return `${Array.isArray(input.todos) ? input.todos.length : 0} todos`;
    case 'WebFetch':   return String(input.url ?? '');
    default:           return '';
  }
}

// ────────────────────────────── Codex ──────────────────────────────

function parseCodexEvent(evt: Record<string, unknown>): ParsedChunk {
  const type = evt.type as string | undefined;
  if (!type) return EMPTY;

  switch (type) {
    case 'thread.started': {
      const id = evt.thread_id as string | undefined;
      return { progress: [`🚀 codex thread started${id ? ` (${id.slice(0, 8)}…)` : ''}`], finalTextChunks: [], ended: false };
    }
    case 'turn.started':
      return { progress: ['▶ turn started'], finalTextChunks: [], ended: false };
    case 'item.completed': {
      const item = evt.item as Record<string, unknown> | undefined;
      if (!item) return EMPTY;
      const itype = item.type as string | undefined;
      if (itype === 'agent_message') {
        const text = String(item.text ?? '').trim();
        if (text.length === 0) return EMPTY;
        return { progress: [`💬 ${truncate(text, 200)}`], finalTextChunks: [text], ended: false };
      }
      if (itype === 'tool_call' || itype === 'function_call' || itype === 'shell_command') {
        const label = String(item.command ?? item.name ?? itype);
        return { progress: [`🔧 ${truncate(label, 120)}`], finalTextChunks: [], ended: false };
      }
      return { progress: [`• ${itype ?? '?'}`], finalTextChunks: [], ended: false };
    }
    case 'turn.completed': {
      const usage = evt.usage as Record<string, unknown> | undefined;
      const out = usage?.output_tokens ?? 0;
      // v866 — Usage strukturiert (codex meldet input/cached_input/output)
      const parsedUsage = usage ? {
        inputTokens: Number(usage.input_tokens ?? 0),
        outputTokens: Number(usage.output_tokens ?? 0),
        cacheReadTokens: Number(usage.cached_input_tokens ?? 0),
      } : undefined;
      return { progress: [`🏁 turn completed (out=${out})`], finalTextChunks: [], ended: true, usage: parsedUsage };
    }
    case 'error': {
      const msg = String(evt.message ?? evt.error ?? 'unknown');
      return { progress: [`❌ ${truncate(msg, 200)}`], finalTextChunks: [], ended: false };
    }
    default:
      return EMPTY;
  }
}

// ────────────────────────────── Vibe ──────────────────────────────

function parseVibeEvent(evt: Record<string, unknown>): ParsedChunk {
  // v894 — vibe `--output streaming` schreibt pro Message EIN LLMMessage-Objekt
  // (StreamingJsonOutputFormatter.on_message_added → message.model_dump(json)).
  // Schema (OpenAI-Stil, NICHT Anthropic): { role, content, reasoning_content,
  //   tool_calls: [{ id, type:'function', function:{ name, arguments:<json-string> } }],
  //   tool_call_id }. `on_event` ist ein No-op → keine separaten Event-Typen.
  // Das alte Schema (`type` / `content:[{type:'text'|'tool_use'}]`) traf NIE zu
  // → parseVibeEvent gab IMMER EMPTY zurück → null Live-Zeilen im Panel.
  const role = evt.role as string | undefined;
  // System-Prompt + User-Prompt sind nur Echo (riesig) — kein Fortschritt.
  if (role === 'system' || role === 'user' || !role) return EMPTY;

  if (role === 'assistant') {
    const progress: string[] = [];
    const finalTextChunks: string[] = [];
    const toolCalls = Array.isArray(evt.tool_calls) ? evt.tool_calls as Array<Record<string, unknown>> : [];
    for (const tc of toolCalls) {
      const fn = (tc.function ?? {}) as Record<string, unknown>;
      const name = String(fn.name ?? tc.name ?? '?');
      const args = parseToolArgs(fn.arguments ?? tc.arguments);
      const label = pickVibeToolLabel(name, args);
      progress.push(`🔧 ${name}${label ? `: ${label}` : ''}`);
    }
    const content = typeof evt.content === 'string' ? evt.content.trim() : '';
    if (content.length > 0) {
      progress.push(`💬 ${truncate(content, 200)}`);
      finalTextChunks.push(content);
    } else if (toolCalls.length === 0) {
      // Reine Denk-Runde (nur reasoning_content) — kurzer Aktivitäts-Hinweis,
      // damit das Panel nicht „tot" wirkt während vibe nachdenkt.
      const reasoning = typeof evt.reasoning_content === 'string' ? evt.reasoning_content.trim() : '';
      if (reasoning.length > 0) progress.push(`💭 ${truncate(reasoning, 160)}`);
    }
    return { progress, finalTextChunks, ended: false };
  }

  if (role === 'tool') {
    const content = typeof evt.content === 'string' ? evt.content.trim() : '';
    if (content.length === 0) return { progress: ['✓ tool result'], finalTextChunks: [], ended: false };
    const isErr = /(^|\n)\s*(error|traceback|command failed|exit code [1-9])/i.test(content);
    return { progress: [`${isErr ? '❌' : '✓'} ${truncate(content, 140)}`], finalTextChunks: [], ended: false };
  }

  return EMPTY;
}

/** v894 — vibe tool_calls.function.arguments ist ein JSON-String → in Objekt parsen. */
function parseToolArgs(raw: unknown): Record<string, unknown> | undefined {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return undefined; }
  }
  return undefined;
}

/** v894 — Label für vibe-Tools (eigene Namen/Arg-Keys, NICHT die claude-Namen). */
function pickVibeToolLabel(name: string, input?: Record<string, unknown>): string {
  if (!input) return '';
  switch (name) {
    case 'bash':           return truncate(String(input.command ?? ''), 80);
    case 'read_file':      return String(input.path ?? input.file_path ?? '');
    case 'write_file':
    case 'search_replace': return String(input.file_path ?? input.path ?? '');
    case 'grep':           return String(input.pattern ?? '');
    case 'todo':           return `${Array.isArray(input.todos) ? input.todos.length : 0} todos`;
    case 'web_search':     return truncate(String(input.query ?? ''), 60);
    case 'web_fetch':      return String(input.url ?? '');
    case 'task':           return truncate(String(input.description ?? input.prompt ?? ''), 60);
    default:               return '';
  }
}

// ────────────────────────────── helpers ──────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
