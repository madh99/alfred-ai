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

describe('parseLine: vibe-streaming', () => {
  const state = () => createParserState('vibe-streaming');

  it('extracts assistant message text', () => {
    const evt = { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Vibe response' }] };
    const r = parseLine(state(), JSON.stringify(evt));
    expect(r.finalTextChunks).toEqual(['Vibe response']);
    expect(r.progress[0]).toContain('Vibe response');
  });

  it('handles standalone text event', () => {
    const r = parseLine(state(), JSON.stringify({ type: 'text', text: 'standalone' }));
    expect(r.finalTextChunks).toEqual(['standalone']);
  });

  it('marks done as ended', () => {
    const r = parseLine(state(), JSON.stringify({ type: 'done' }));
    expect(r.ended).toBe(true);
  });

  it('extracts tool_use', () => {
    const evt = { type: 'tool_use', name: 'Read', input: { file_path: '/etc/hosts' } };
    const r = parseLine(state(), JSON.stringify(evt));
    expect(r.progress[0]).toBe('🔧 Read: /etc/hosts');
  });
});
