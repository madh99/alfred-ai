import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from './providers/openai.js';
import type { LLMRequest } from '@alfred/types';

/**
 * v1099 — Responses-API-Pfad (Etappe 1+2). Live verprobt 11.07.2026:
 * Tool-Call MIT reasoning_effort (auf chat/completions verboten),
 * Kontinuität via previous_response_id (Runde 2 = nur Tool-Ergebnis,
 * 103 Input-Tokens statt voller History), GPT-5.6 über /v1/responses.
 */

function provider(model: string, extra: Record<string, unknown> = {}): OpenAIProvider {
  return new OpenAIProvider({ provider: 'openai', model, apiKey: 'test-key', ...extra } as never);
}
type Internals = {
  useResponsesApi(): boolean;
  buildResponsesParams(r: LLMRequest): Record<string, unknown>;
  mapResponsesResponse(r: unknown): { content: string; toolCalls?: unknown[]; usage: Record<string, number>; stopReason: string; responseId?: string };
  shouldFallbackToChat(e: unknown): boolean;
  reasoningEffortParam(r?: string): string | undefined;
};
const internals = (m: string, extra?: Record<string, unknown>) => provider(m, extra) as never as Internals;

describe('v1099 Responses-API — Routing', () => {
  it('Reasoning-Modelle nehmen den Responses-Pfad, Chat-Modelle nicht, Kill-Switch greift', () => {
    expect(internals('gpt-5.5').useResponsesApi()).toBe(true);
    expect(internals('gpt-5.6-terra').useResponsesApi()).toBe(true);
    expect(internals('o3-mini').useResponsesApi()).toBe(true);
    expect(internals('gpt-5.4').useResponsesApi()).toBe(false); // Chat-Modell
    expect(internals('gpt-4o').useResponsesApi()).toBe(false);
    expect(internals('gpt-5.5', { responsesApi: false }).useResponsesApi()).toBe(false);
  });

  it('Fallback nur bei Endpoint-/Parameter-Fehlern — Rate-Limit/Auth gehen durch', () => {
    const i = internals('gpt-5.5');
    expect(i.shouldFallbackToChat({ status: 404, message: 'not found' })).toBe(true);
    expect(i.shouldFallbackToChat(Object.assign(new Error('this model is not supported'), { status: 400 }))).toBe(true);
    expect(i.shouldFallbackToChat(Object.assign(new Error('rate limit'), { status: 429 }))).toBe(false);
    expect(i.shouldFallbackToChat(Object.assign(new Error('invalid api key'), { status: 401 }))).toBe(false);
  });
});

describe('v1099 Responses-API — Request-Bau', () => {
  it('Tools + Effort ZUSAMMEN, flaches Tool-Format, keine temperature', () => {
    const p = internals('gpt-5.6-sol').buildResponsesParams({
      messages: [{ role: 'user', content: 'Frage' }],
      system: 'Du bist Alfred.',
      tools: [{ name: 'get_score', description: 'Spielstand', inputSchema: { type: 'object', properties: {} } }],
      reasoningEffort: 'max', maxTokens: 2000, temperature: 0.7,
    });
    expect(p.instructions).toBe('Du bist Alfred.');
    expect(p.max_output_tokens).toBe(2000);
    expect(p.reasoning).toEqual({ effort: 'max' }); // 'max' läuft hier NICHT über xhigh-Mapping
    expect((p.tools as Array<{ type: string; name: string }>)[0]).toMatchObject({ type: 'function', name: 'get_score' });
    expect('temperature' in p).toBe(false);
  });

  it('History-Mapping: tool_use → function_call, tool_result → function_call_output (Top-Level)', () => {
    const p = internals('gpt-5.5').buildResponsesParams({
      messages: [
        { role: 'user', content: 'Wie steht es?' },
        { role: 'assistant', content: [{ type: 'text', text: 'Ich schaue nach.' }, { type: 'tool_use', id: 'call_1', name: 'get_score', input: { match: 'FRA-MAR' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '2:1' }] },
      ],
    });
    const input = p.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ role: 'user', content: 'Wie steht es?' });
    expect(input[1]).toMatchObject({ role: 'assistant', content: 'Ich schaue nach.' });
    expect(input[2]).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'get_score', arguments: '{"match":"FRA-MAR"}' });
    expect(input[3]).toMatchObject({ type: 'function_call_output', call_id: 'call_1', output: '2:1' });
  });

  it('Etappe 2: mit previousResponseId gehen NUR die neuen Tool-Ergebnisse raus', () => {
    const p = internals('gpt-5.5').buildResponsesParams({
      previousResponseId: 'resp_abc',
      messages: [
        { role: 'user', content: 'Wie steht es?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_score', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '2:1', is_error: false }] },
      ],
    });
    const input = p.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
    expect(p.previous_response_id).toBe('resp_abc');
  });

  it('Etappe 2 — Kontrakt-Verletzung (letzte Message ohne Tool-Ergebnis) → volle History, KEINE previous_response_id', () => {
    const p = internals('gpt-5.5').buildResponsesParams({
      previousResponseId: 'resp_abc',
      messages: [{ role: 'user', content: 'Neue Frage ohne Tool-Kontext' }],
    });
    expect((p.input as unknown[]).length).toBe(1);
    expect((p.input as Array<Record<string, unknown>>)[0]).toMatchObject({ role: 'user' });
    expect('previous_response_id' in p).toBe(false);
  });
});

describe('v1099 Responses-API — Antwort-Mapping', () => {
  it('output-Items → content/toolCalls/usage/responseId; Tool-Call = stopReason tool_use', () => {
    const r = internals('gpt-5.5').mapResponsesResponse({
      id: 'resp_1', status: 'completed',
      output: [
        { type: 'reasoning' },
        { type: 'message', content: [{ type: 'output_text', text: 'Hallo ' }, { type: 'output_text', text: 'Welt' }] },
        { type: 'function_call', call_id: 'call_9', name: 'get_score', arguments: '{"match":"x"}' },
      ],
      usage: { input_tokens: 103, output_tokens: 25, input_tokens_details: { cached_tokens: 40 } },
    });
    expect(r.content).toBe('Hallo Welt');
    expect(r.toolCalls).toEqual([{ id: 'call_9', name: 'get_score', input: { match: 'x' } }]);
    expect(r.usage).toMatchObject({ inputTokens: 103, outputTokens: 25, cacheReadTokens: 40 });
    expect(r.stopReason).toBe('tool_use');
    expect(r.responseId).toBe('resp_1');
  });

  it('incomplete/max_output_tokens → stopReason max_tokens (Schutz vor kaputten Tool-Calls greift im Loop)', () => {
    const r = internals('gpt-5.5').mapResponsesResponse({
      id: 'resp_2', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'abgeschn' }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(r.stopReason).toBe('max_tokens');
  });
});

describe('v1099 — chat/completions-Pfad bleibt kompatibel', () => {
  it("Effort 'max' wird auf dem Chat-Pfad zu 'xhigh' (API lehnt 'max' dort ab)", () => {
    expect(internals('gpt-5.5').reasoningEffortParam('max')).toBe('xhigh');
    expect(internals('gpt-5.5').reasoningEffortParam('high')).toBe('high');
    expect(internals('gpt-5.4').reasoningEffortParam('max')).toBeUndefined();
  });
});
