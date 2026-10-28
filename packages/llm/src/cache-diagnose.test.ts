import { describe, it, expect } from 'vitest';
import { anthropicDiagnose, openaiDiagnose, DiagnoseKette, istDiagnoseAblehnung } from './cache-diagnose.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';

// v1693 (K2) — Cache-Diagnose je Anfrage: nur Messung, darf nie eine Antwort verhindern
describe('Cache-Diagnose: Auswertung der Antworten', () => {
  it('Anthropic: erster Zug, kein Unterschied, ausstehend, Abweichung, ohne Basis', () => {
    expect(anthropicDiagnose(null, false)).toEqual({ ergebnis: 'erster' });
    expect(anthropicDiagnose(null, true)).toEqual({ ergebnis: 'treffer' });
    expect(anthropicDiagnose({ cache_miss_reason: null }, true)).toEqual({ ergebnis: 'ausstehend' });
    expect(anthropicDiagnose({ cache_miss_reason: { type: 'system_changed', cache_missed_input_tokens: 41850 } }, true)).toEqual({ ergebnis: 'abweichung', grund: 'system_changed', verloreneToken: 41850 });
    expect(anthropicDiagnose({ cache_miss_reason: { type: 'previous_message_not_found' } }, true)).toEqual({ ergebnis: 'keine_basis' });
    expect(anthropicDiagnose({ cache_miss_reason: { type: 'unavailable' } }, true)).toEqual({ ergebnis: 'nicht_verfuegbar' });
  });
  it('OpenAI: Treffer, Fehlschlag mit Grund, ohne Basis, unbekannte Form', () => {
    expect(openaiDiagnose(undefined, false)).toEqual({ ergebnis: 'erster' });
    expect(openaiDiagnose({ type: 'cache_hit' }, true)).toEqual({ ergebnis: 'treffer' });
    expect(openaiDiagnose({ type: 'cache_miss', reason: 'prompt_cache_key_changed', cache_missed_tokens: 86000 }, true)).toEqual({ ergebnis: 'abweichung', grund: 'prompt_cache_key_changed', verloreneToken: 86000 });
    expect(openaiDiagnose({ type: 'comparison_response_not_found' }, true)).toEqual({ ergebnis: 'keine_basis' });
    expect(openaiDiagnose(undefined, true)).toBeUndefined();
  });
  it('Kette merkt die letzte ID je Gespräch; Ablehnung nur bei 400 mit Feldnamen', () => {
    const k = new DiagnoseKette(2);
    expect(k.vorher('a')).toBeNull();
    k.merke('a', 'm1'); k.merke('b', 'm2'); k.merke('a', 'm3'); k.merke('c', 'm4');
    expect(k.vorher('a')).toBe('m3'); expect(k.vorher('b')).toBeNull();
    expect(istDiagnoseAblehnung({ status: 400, message: 'diagnostics: Extra inputs are not permitted' }, 'diagnostics')).toBe(true);
    expect(istDiagnoseAblehnung({ status: 500, message: 'diagnostics' }, 'diagnostics')).toBe(false);
  });
});

describe('Cache-Diagnose in den Providern', () => {
  it('Anthropic: schickt previous_message_id (erst null, dann letzte ID) und wiederholt ohne Parameter, wenn abgelehnt', async () => {
    const p = new AnthropicProvider({ provider: 'anthropic', apiKey: 'test', model: 'claude-opus-5-5' } as never);
    const gesendet: Array<Record<string, unknown>> = [];
    let ablehnen = false;
    (p as unknown as { client: unknown }).client = { messages: { create: async (params: Record<string, unknown>) => {
      gesendet.push(params);
      if (ablehnen && 'diagnostics' in params) throw Object.assign(new Error('diagnostics: Extra inputs are not permitted'), { status: 400 });
      return { id: `msg_${gesendet.length}`, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, diagnostics: gesendet.length === 2 ? { cache_miss_reason: { type: 'system_changed', cache_missed_input_tokens: 9000 } } : null };
    } } };
    const anfrage = { messages: [{ role: 'user' as const, content: 'Hallo' }], cacheDiagnose: 'owner:faden:x' };
    const r1 = await p.complete(anfrage);
    expect(gesendet[0]!.diagnostics).toEqual({ previous_message_id: null });
    expect(r1.cacheDiagnose).toEqual({ ergebnis: 'erster' });
    const r2 = await p.complete(anfrage);
    expect(gesendet[1]!.diagnostics).toEqual({ previous_message_id: 'msg_1' });
    expect(r2.cacheDiagnose).toEqual({ ergebnis: 'abweichung', grund: 'system_changed', verloreneToken: 9000 });
    ablehnen = true;
    const r3 = await p.complete(anfrage);
    expect(r3.content).toBe('ok');
    expect('diagnostics' in gesendet.at(-1)!).toBe(false);
    expect(r3.cacheDiagnose).toBeUndefined();
    // ohne Gesprächsschlüssel: nichts mitschicken
    const p2 = new AnthropicProvider({ provider: 'anthropic', apiKey: 'test', model: 'claude-opus-5-5' } as never);
    (p2 as unknown as { client: unknown }).client = (p as unknown as { client: unknown }).client;
    ablehnen = false; await p2.complete({ messages: [{ role: 'user', content: 'x' }] });
    expect('diagnostics' in gesendet.at(-1)!).toBe(false);
  });

  it('OpenAI Responses: comparison_response_id erst ab der zweiten Anfrage, nicht bei Fremd-Endpunkten', () => {
    const p = new OpenAIProvider({ provider: 'openai', apiKey: 'test', model: 'gpt-6.1-sol' } as never);
    const intern = p as unknown as { buildResponsesParams: (r: unknown) => Record<string, unknown>; diagnose: DiagnoseKette };
    const anfrage = { system: 'S', messages: [{ role: 'user', content: 'Hallo' }], cacheDiagnose: 'owner:faden:x', gespraech: 'owner:faden:x' };
    expect(intern.buildResponsesParams(anfrage).prompt_cache_options).toEqual({ mode: 'explicit' }); // v1704 K1c
    intern.diagnose.merke('owner:faden:x', 'resp_1');
    expect(intern.buildResponsesParams(anfrage).prompt_cache_options).toEqual({ mode: 'explicit', comparison_response_id: 'resp_1' });
    const fremd = new OpenAIProvider({ provider: 'openai', apiKey: 'test', model: 'llama', baseUrl: 'http://192.168.1.50:8080/v1' } as never) as unknown as typeof intern;
    fremd.diagnose.merke('owner:faden:x', 'resp_1');
    expect(fremd.buildResponsesParams(anfrage).prompt_cache_options).toBeUndefined();
  });
});
