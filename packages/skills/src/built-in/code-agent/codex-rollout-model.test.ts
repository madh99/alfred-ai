import { describe, it, expect } from 'vitest';
import { parseCodexRolloutModel } from './agent-executor.js';

/**
 * v903 — codex liefert das Modell nicht im --json-Stream (nur usage im
 * turn.completed). Es steht in der Rollout-Session (~/.codex/sessions/.../
 * rollout-*.jsonl) im turn_context-Event als payload.model.
 * Werte aus einer realen codex-0.132.0-Session (model gpt-5.5).
 */
describe('v903 parseCodexRolloutModel', () => {
  it('liest model aus dem turn_context-Event (reale Rollout-Zeilen)', () => {
    const content = [
      '{"timestamp":"2026-06-16T08:09:17.855Z","type":"session_meta","payload":{"id":"019ecf7a","cwd":"/tmp","model_provider":"openai"}}',
      '{"timestamp":"2026-06-16T08:09:17.855Z","type":"event_msg","payload":{"type":"task_started","model_context_window":258400}}',
      '{"timestamp":"2026-06-16T08:09:18.874Z","type":"turn_context","payload":{"turn_id":"019ecf7a","cwd":"/tmp","approval_policy":"never","model":"gpt-5.5"}}',
    ].join('\n');
    expect(parseCodexRolloutModel(content)).toBe('gpt-5.5');
  });

  it('ignoriert kaputte Zeilen und nimmt die erste mit payload.model', () => {
    const content = [
      'NICHT JSON',
      '{"type":"session_meta","payload":{"model_provider":"openai"}}',
      '{"type":"turn_context","payload":{"model":"gpt-5.4"}}',
      '{"type":"turn_context","payload":{"model":"gpt-5.5"}}',
    ].join('\n');
    expect(parseCodexRolloutModel(content)).toBe('gpt-5.4');
  });

  it('liefert undefined wenn kein payload.model vorkommt', () => {
    const content = [
      '{"type":"session_meta","payload":{"model_provider":"openai"}}',
      '{"type":"turn.completed","usage":{"input_tokens":14423}}',
    ].join('\n');
    expect(parseCodexRolloutModel(content)).toBeUndefined();
  });

  it('robust gegen leeren Input', () => {
    expect(parseCodexRolloutModel('')).toBeUndefined();
  });
});
