'use client';

import { useState } from 'react';

/**
 * v783 — AgentEventCard-Components
 *
 * Strukturierte Live-Anzeige für AgentEvents die v780+v781 vom Backend kommen.
 * Jeder Event-Type hat seine eigene Card. Renderer schaltet basierend auf entry.type.
 *
 * Event-Shapes siehe @alfred/skills/agent-session/types.ts (AgentEvent).
 */

export interface AgentEventEntry {
  ts: number;
  type: string;
  data: unknown;
}

interface CardProps {
  entry: AgentEventEntry;
}

/** Dispatcher — picks Card-Component basierend auf event.type. */
export function AgentEventCard({ entry }: CardProps) {
  const d = entry.data as Record<string, unknown>;
  switch (entry.type) {
    case 'session_id':
      return <SessionIdCard sessionId={String(d.value ?? '')} />;
    case 'progress':
      return <ProgressCard phase={String(d.phase ?? '')} detail={d.detail ? String(d.detail) : undefined} />;
    case 'text':
      return <TextChunkCard text={String(d.text ?? '')} />;
    case 'thinking':
      return <ThinkingCard text={String(d.text ?? '')} />;
    case 'tool_call':
      return <ToolCallCard tool={String(d.tool ?? '?')} input={d.input} />;
    case 'tool_result':
      return <ToolResultCard output={d.output} />;
    case 'edit':
      return <EditCard path={String(d.path ?? '?')} before={String(d.before ?? '')} after={String(d.after ?? '')} linesAdded={Number(d.linesAdded ?? 0)} linesRemoved={Number(d.linesRemoved ?? 0)} />;
    case 'shell':
      return <ShellCard command={String(d.command ?? '')} status={String(d.status ?? 'done')} output={d.output ? String(d.output) : undefined} exitCode={d.exitCode != null ? Number(d.exitCode) : undefined} />;
    case 'usage':
      return <UsageCard inputTokens={Number(d.inputTokens ?? 0)} outputTokens={Number(d.outputTokens ?? 0)} cachedTokens={d.cachedTokens != null ? Number(d.cachedTokens) : undefined} costUsd={d.costUsd != null ? Number(d.costUsd) : undefined} />;
    case 'error':
      return <ErrorCard message={String(d.message ?? '')} recoverable={!!d.recoverable} />;
    default:
      return <UnknownCard type={entry.type} data={d} />;
  }
}

function SessionIdCard({ sessionId }: { sessionId: string }) {
  return (
    <div className="text-[10px] text-blue-400/70 flex items-center gap-1.5">
      <span>🔗</span>
      <span>Session: <code className="font-mono">{sessionId.slice(0, 12)}…</code></span>
    </div>
  );
}

function ProgressCard({ phase, detail }: { phase: string; detail?: string }) {
  return (
    <div className="text-[10px] text-cyan-400/80 flex items-center gap-1.5">
      <span>▸</span>
      <span className="font-medium">{phase}</span>
      {detail && <span className="text-gray-500">— {detail}</span>}
    </div>
  );
}

function TextChunkCard({ text }: { text: string }) {
  return (
    <div className="text-xs text-gray-200 whitespace-pre-wrap leading-relaxed">{text}</div>
  );
}

function ThinkingCard({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = text.length > 200 ? text.slice(0, 200) + '…' : text;
  return (
    <details
      className="bg-purple-500/5 border border-purple-500/20 rounded px-2 py-1 text-[11px]"
      onToggle={(e) => setExpanded((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-purple-300/80 flex items-center gap-1.5 select-none">
        <span>🤔</span>
        <span className="flex-1">{expanded ? 'thinking' : preview}</span>
      </summary>
      {expanded && (
        <div className="mt-1 text-gray-400 whitespace-pre-wrap leading-relaxed pl-4">{text}</div>
      )}
    </details>
  );
}

function ToolCallCard({ tool, input }: { tool: string; input: unknown }) {
  const inputPreview = formatInputPreview(input);
  const icon = TOOL_ICONS[tool] ?? '🔧';
  return (
    <div className="flex items-start gap-1.5 text-[11px] bg-[#0a0a0a] border border-[#1a1a1a] rounded px-2 py-1">
      <span>{icon}</span>
      <div className="flex-1 min-w-0">
        <span className="text-blue-300 font-medium">{tool}</span>
        {inputPreview && <span className="text-gray-500 ml-2 truncate">{inputPreview}</span>}
      </div>
    </div>
  );
}

function ToolResultCard({ output }: { output: unknown }) {
  const text = typeof output === 'string' ? output : (Array.isArray(output) ? output.map((b: any) => b.text ?? '').join('') : '');
  if (!text) return null;
  const preview = text.length > 100 ? text.slice(0, 100) + '…' : text;
  return (
    <div className="text-[10px] text-gray-500 pl-4 truncate">↳ {preview}</div>
  );
}

function EditCard({ path, before, after, linesAdded, linesRemoved }: { path: string; before: string; after: string; linesAdded: number; linesRemoved: number }) {
  const [expanded, setExpanded] = useState(false);
  const diff = computeDiff(before, after);
  return (
    <details
      className="bg-amber-500/5 border border-amber-500/30 rounded text-[11px]"
      onToggle={(e) => setExpanded((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer px-2 py-1 flex items-center gap-1.5 select-none">
        <span>✏️</span>
        <span className="text-amber-300 font-medium flex-1 truncate">{path}</span>
        <span className="text-[10px] text-emerald-400">+{linesAdded}</span>
        <span className="text-[10px] text-red-400">−{linesRemoved}</span>
      </summary>
      {expanded && (
        <div className="border-t border-amber-500/20 px-2 py-1 bg-black/30 font-mono text-[10px] leading-relaxed max-h-64 overflow-y-auto">
          {diff.map((line, i) => (
            <div
              key={i}
              className={
                line.kind === 'add' ? 'text-emerald-400' :
                line.kind === 'remove' ? 'text-red-400' :
                'text-gray-500'
              }
            >
              <span className="select-none w-3 inline-block">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span>
              {line.text || ' '}
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

function ShellCard({ command, status, output, exitCode }: { command: string; status: string; output?: string; exitCode?: number }) {
  const [expanded, setExpanded] = useState(false);
  const showCmd = command || '(continuing)';
  const ok = exitCode == null || exitCode === 0;
  return (
    <details
      className={`bg-[#0a0a0a] border rounded text-[11px] ${ok ? 'border-[#1a1a1a]' : 'border-red-500/40'}`}
      onToggle={(e) => setExpanded((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer px-2 py-1 flex items-center gap-1.5 select-none">
        <span>{status === 'running' ? '⏳' : (ok ? '$' : '✗')}</span>
        <code className="text-gray-300 flex-1 truncate font-mono">{showCmd}</code>
        {exitCode != null && (
          <span className={`text-[10px] ${ok ? 'text-emerald-400' : 'text-red-400'}`}>exit={exitCode}</span>
        )}
      </summary>
      {expanded && output && (
        <pre className="border-t border-[#1a1a1a] px-2 py-1 bg-black/30 font-mono text-[10px] text-gray-400 max-h-48 overflow-y-auto whitespace-pre-wrap">{output}</pre>
      )}
    </details>
  );
}

function UsageCard({ inputTokens, outputTokens, cachedTokens, costUsd }: { inputTokens: number; outputTokens: number; cachedTokens?: number; costUsd?: number }) {
  return (
    <div className="text-[10px] text-gray-500 flex items-center gap-2 flex-wrap">
      <span>📊</span>
      <span>in {inputTokens.toLocaleString()}</span>
      <span>·</span>
      <span>out {outputTokens.toLocaleString()}</span>
      {cachedTokens != null && cachedTokens > 0 && (
        <>
          <span>·</span>
          <span className="text-emerald-400/70">cached {cachedTokens.toLocaleString()}</span>
        </>
      )}
      {costUsd != null && (
        <>
          <span>·</span>
          <span className="text-amber-400/80">${costUsd.toFixed(4)}</span>
        </>
      )}
    </div>
  );
}

function ErrorCard({ message, recoverable }: { message: string; recoverable: boolean }) {
  return (
    <div className={`text-[11px] rounded px-2 py-1 border ${recoverable ? 'bg-amber-500/10 border-amber-500/40 text-amber-300' : 'bg-red-500/10 border-red-500/40 text-red-300'}`}>
      <span className="mr-1">{recoverable ? '⚠️' : '❌'}</span>
      {message}
    </div>
  );
}

function UnknownCard({ type, data }: { type: string; data: unknown }) {
  return (
    <div className="text-[10px] text-gray-600">
      <span>?</span> {type} <code className="font-mono">{JSON.stringify(data).slice(0, 80)}</code>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  // claude-code Tools
  Read: '🔍',
  Write: '📝',
  Edit: '✏️',
  Glob: '🌐',
  Grep: '🔎',
  Bash: '$',
  WebFetch: '🌐',
  WebSearch: '🔎',
  Task: '👥',
  TodoWrite: '✓',
  // vibe Tools (snake_case)
  read_file: '🔍',
  write_file: '📝',
  search_replace: '✏️',
  grep: '🔎',
  bash: '$',
  task: '👥',
  todo: '✓',
  web_fetch: '🌐',
  web_search: '🔎',
};

function formatInputPreview(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.slice(0, 80);
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    // Bevorzugte Felder zuerst
    for (const k of ['file_path', 'path', 'command', 'pattern', 'query']) {
      if (typeof obj[k] === 'string') return String(obj[k]).slice(0, 80);
    }
    const json = JSON.stringify(input);
    return json.length > 80 ? json.slice(0, 80) + '…' : json;
  }
  return String(input).slice(0, 80);
}

/** Sehr simpler line-by-line diff. Kein LCS. Für UI ausreichend. */
function computeDiff(before: string, after: string): Array<{ kind: 'context' | 'add' | 'remove'; text: string }> {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const result: Array<{ kind: 'context' | 'add' | 'remove'; text: string }> = [];

  // Wenn before leer (Write-Tool): alles add
  if (!before) {
    for (const l of afterLines) result.push({ kind: 'add', text: l });
    return result;
  }
  // Wenn after leer (Löschung): alles remove
  if (!after) {
    for (const l of beforeLines) result.push({ kind: 'remove', text: l });
    return result;
  }

  // Naive Strategy: zeige alle remove, dann alle add. Bei kleinen Edits funktioniert das gut.
  // Bei großen Edits ungenau aber lesbar.
  // Wenn before === after: alles context (sollte nicht passieren)
  if (before === after) {
    for (const l of beforeLines.slice(0, 50)) result.push({ kind: 'context', text: l });
    return result;
  }

  // Common prefix/suffix erkennen damit kleine Edits in großem Block lesbar werden
  let commonPrefix = 0;
  const minLen = Math.min(beforeLines.length, afterLines.length);
  while (commonPrefix < minLen && beforeLines[commonPrefix] === afterLines[commonPrefix]) commonPrefix++;
  let commonSuffix = 0;
  while (
    commonSuffix < minLen - commonPrefix &&
    beforeLines[beforeLines.length - 1 - commonSuffix] === afterLines[afterLines.length - 1 - commonSuffix]
  ) commonSuffix++;

  // Show: context-prefix (max 2 lines) | removes | adds | context-suffix (max 2 lines)
  const prefixShow = Math.min(commonPrefix, 2);
  const suffixShow = Math.min(commonSuffix, 2);

  // Context-prefix
  for (let i = commonPrefix - prefixShow; i < commonPrefix; i++) {
    result.push({ kind: 'context', text: beforeLines[i] });
  }
  // Removes
  for (let i = commonPrefix; i < beforeLines.length - commonSuffix; i++) {
    result.push({ kind: 'remove', text: beforeLines[i] });
  }
  // Adds
  for (let i = commonPrefix; i < afterLines.length - commonSuffix; i++) {
    result.push({ kind: 'add', text: afterLines[i] });
  }
  // Context-suffix
  for (let i = beforeLines.length - commonSuffix; i < beforeLines.length - commonSuffix + suffixShow; i++) {
    result.push({ kind: 'context', text: beforeLines[i] });
  }

  return result;
}
