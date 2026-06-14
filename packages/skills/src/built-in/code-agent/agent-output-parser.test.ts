import { describe, it, expect } from 'vitest';
import { createParserState, parseLine, looksLikeJsonl } from './agent-output-parser.js';

describe('looksLikeJsonl', () => {
  it('returns true for json-like lines', () => {
    expect(looksLikeJsonl('{"type":"system"}')).toBe(true);
    expect(looksLikeJsonl('  {"a":1}  ')).toBe(true);
  });
  it('returns false for plain text', () => {
    expect(looksLikeJsonl('hello world')).toBe(false);
    expect(looksLikeJsonl('')).toBe(false);
    expect(looksLikeJsonl('{ broken')).toBe(false);
  });
});

describe('parseLine: text mode', () => {
  it('passes through plain text as both progress and final', () => {
    const s = createParserState('text');
    // parseLine receives single line (caller does the splitting in agent-executor)
    const r = parseLine(s, 'hello');
    expect(r.progress).toEqual(['hello']);
    expect(r.finalTextChunks).toEqual(['hello']);
    expect(r.ended).toBe(false);
  });
  it('returns empty for blank lines', () => {
    const s = createParserState('text');
    const r = parseLine(s, '   ');
    expect(r.progress).toEqual(['   ']); // text mode preserves leading whitespace
  });
});

describe('parseLine: claude-stream-json', () => {
  const state = () => createParserState('claude-stream-json');

  it('handles system init event', () => {
    const r = parseLine(state(), JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-6' }));
    expect(r.progress[0]).toContain('Claude init');
    expect(r.progress[0]).toContain('claude-opus-4-6');
    expect(r.ended).toBe(false);
  });

  it('extracts tool_use as progress with label', () => {
    const evt = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls src/' } }] },
    };
    const r = parseLine(state(), JSON.stringify(evt));
    expect(r.progress[0]).toBe('🔧 Bash: ls src/');
    expect(r.finalTextChunks).toEqual([]);
  });

  it('extracts assistant text as both progress and final', () => {
    const evt = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hier ist das Ergebnis.' }] },
    };
    const r = parseLine(state(), JSON.stringify(evt));
    expect(r.progress[0]).toContain('Hier ist das Ergebnis');
    expect(r.finalTextChunks).toEqual(['Hier ist das Ergebnis.']);
  });

  it('marks result as ended and extracts final text', () => {
    const evt = { type: 'result', subtype: 'success', result: 'final answer', total_cost_usd: 0.0123 };
    const r = parseLine(state(), JSON.stringify(evt));
    expect(r.ended).toBe(true);
    expect(r.finalTextChunks).toEqual(['final answer']);
    expect(r.progress[0]).toContain('success');
    expect(r.progress[0]).toContain('$0.0123');
  });

  it('tolerates malformed JSON by treating as progress-only', () => {
    const r = parseLine(state(), '{ not json');
    expect(r.progress).toEqual(['{ not json']);
    expect(r.finalTextChunks).toEqual([]);
  });

  it('skips unknown event types silently', () => {
    const r = parseLine(state(), JSON.stringify({ type: 'unknown_xyz' }));
    expect(r.progress).toEqual([]);
    expect(r.finalTextChunks).toEqual([]);
  });

  it('reports rate_limit_event', () => {
    const r = parseLine(state(), JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }));
    expect(r.progress[0]).toContain('rate-limit');
    expect(r.progress[0]).toContain('allowed');
  });

  it('reports tool_result with error flag', () => {
    const evt = { type: 'user', message: { content: [{ type: 'tool_result', is_error: true }] } };
    const r = parseLine(state(), JSON.stringify(evt));
    expect(r.progress[0]).toContain('tool error');
  });
});

describe('parseLine: codex-jsonl', () => {
  const state = () => createParserState('codex-jsonl');

  it('handles thread.started', () => {
    const r = parseLine(state(), JSON.stringify({ type: 'thread.started', thread_id: '019e9285-bb95-7e92-b9f3' }));
    expect(r.progress[0]).toContain('thread started');
    expect(r.progress[0]).toContain('019e9285');
  });

  it('extracts agent_message as final text', () => {
    const evt = { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'Hi.' } };
    const r = parseLine(state(), JSON.stringify(evt));
    expect(r.finalTextChunks).toEqual(['Hi.']);
  });

  it('marks turn.completed as ended', () => {
    const r = parseLine(state(), JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 29 } }));
    expect(r.ended).toBe(true);
    expect(r.progress[0]).toContain('out=29');
  });

  it('handles shell_command tool calls', () => {
    const evt = { type: 'item.completed', item: { type: 'shell_command', command: 'ls -la' } };
    const r = parseLine(state(), JSON.stringify(evt));
    expect(r.progress[0]).toContain('🔧');
    expect(r.progress[0]).toContain('ls -la');
  });
});

// v894 — echtes vibe-Format: pro Zeile EIN LLMMessage (role/content/tool_calls),
// wie StreamingJsonOutputFormatter es schreibt. (Vorher testete dies das nie
// zutreffende `type`-Schema → Parser gab immer EMPTY → 0 Live-Zeilen.)
describe('parseLine: vibe-streaming (v894 LLMMessage-Format)', () => {
  const state = () => createParserState('vibe-streaming');

  it('assistant-content → 💬 Text + finalText', () => {
    const evt = { role: 'assistant', content: 'Vibe response', tool_calls: null, reasoning_content: null };
    const r = parseLine(state(), JSON.stringify(evt));
    expect(r.finalTextChunks).toEqual(['Vibe response']);
    expect(r.progress[0]).toContain('Vibe response');
  });

  it('assistant tool_call read_file → 🔧 mit Pfad (arguments als JSON-String)', () => {
    const evt = { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] };
    const r = parseLine(state(), JSON.stringify(evt));
    expect(r.progress[0]).toBe('🔧 read_file: README.md');
  });

  it('assistant tool_call bash → 🔧 mit command', () => {
    const evt = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'bash', arguments: '{"command":"ls -la"}' } }] };
    const r = parseLine(state(), JSON.stringify(evt));
    expect(r.progress[0]).toBe('🔧 bash: ls -la');
  });

  it('tool-result (role=tool) → ✓', () => {
    const r = parseLine(state(), JSON.stringify({ role: 'tool', content: 'total 12\nfoo', tool_call_id: 'a' }));
    expect(r.progress[0]).toMatch(/^✓/);
  });

  it('tool-result mit Fehler → ❌', () => {
    const r = parseLine(state(), JSON.stringify({ role: 'tool', content: 'error: file not found', tool_call_id: 'a' }));
    expect(r.progress[0]).toMatch(/^❌/);
  });

  it('v894.1 — Permission-Ablehnung → ⚠ (nicht ✓)', () => {
    const r = parseLine(state(), JSON.stringify({ role: 'tool', content: 'Tool execution not permitted.', tool_call_id: 'a' }));
    expect(r.progress[0]).toMatch(/^⚠/);
  });

  it('reine Denk-Runde (nur reasoning_content) → 💭', () => {
    const r = parseLine(state(), JSON.stringify({ role: 'assistant', content: '', tool_calls: null, reasoning_content: 'Let me look at the repo first.' }));
    expect(r.progress[0]).toMatch(/^💭/);
  });

  it('system- und user-Message werden übersprungen (Prompt-Echo)', () => {
    expect(parseLine(state(), JSON.stringify({ role: 'system', content: 'huge system prompt' })).progress).toEqual([]);
    expect(parseLine(state(), JSON.stringify({ role: 'user', content: 'the task' })).progress).toEqual([]);
  });
});

// v866 — Usage + Modell strukturiert extrahieren (vorher verworfen)
describe('parseLine: v866 usage/model extraction', () => {
  const claude = () => createParserState('claude-stream-json');
  const codex = () => createParserState('codex-jsonl');

  it('claude init liefert model strukturiert', () => {
    const r = parseLine(claude(), JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5' }));
    expect(r.model).toBe('claude-fable-5');
  });

  it('claude result liefert usage (tokens + cost)', () => {
    const evt = {
      type: 'result', subtype: 'success', result: 'fertig', total_cost_usd: 1.2345,
      usage: { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 50000 },
    };
    const r = parseLine(claude(), JSON.stringify(evt));
    expect(r.ended).toBe(true);
    expect(r.usage).toEqual({ inputTokens: 1200, outputTokens: 800, cacheReadTokens: 50000, costUsd: 1.2345 });
  });

  it('claude result ohne usage aber mit cost → usage mit 0-Tokens + cost', () => {
    const r = parseLine(claude(), JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.5 }));
    expect(r.usage?.costUsd).toBe(0.5);
    expect(r.usage?.inputTokens).toBe(0);
  });

  it('claude assistant-event hat KEINE usage (nur result zählt)', () => {
    const r = parseLine(claude(), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }));
    expect(r.usage).toBeUndefined();
  });

  it('codex turn.completed liefert usage', () => {
    const evt = { type: 'turn.completed', usage: { input_tokens: 300, cached_input_tokens: 100, output_tokens: 42 } };
    const r = parseLine(codex(), JSON.stringify(evt));
    expect(r.ended).toBe(true);
    expect(r.usage).toEqual({ inputTokens: 300, outputTokens: 42, cacheReadTokens: 100 });
  });
});
