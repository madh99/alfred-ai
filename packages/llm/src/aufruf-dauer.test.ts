import { describe, it, expect } from 'vitest';
import { ModelRouter } from './model-router.js';
import type { LLMProvider } from './provider.js';
import type { LLMResponse, LLMStreamEvent, MultiModelConfig } from '@alfred/types';

/**
 * v1345 — Antwortzeit (Punkt 8 der Ist-Aufnahme): jede Zeile „LLM call completed" trägt die Dauer des
 * Modellaufrufs, gestreamte Aufrufe zusätzlich die Zeit bis zum ersten Ereignis.
 */
const warte = (ms: number) => new Promise(r => setTimeout(r, ms));
const antwort = { content: 'ok', model: 'm', usage: { inputTokens: 1, outputTokens: 1 } } as LLMResponse;

function provider(): LLMProvider {
  return {
    async initialize() { /* noop */ },
    async complete() { await warte(20); return { ...antwort }; },
    async *stream(): AsyncIterable<LLMStreamEvent> {
      await warte(20);
      yield { type: 'text_delta', text: 'o' };
      await warte(20);
      yield { type: 'message_complete', response: { ...antwort } };
    },
    async embed() { return undefined; },
    supportsEmbeddings() { return false; },
    isAvailable() { return true; },
    getContextWindow() { return { total: 100000, maxOutput: 4096 }; },
  } as unknown as LLMProvider;
}

function router() {
  const zeilen: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const log = (obj: Record<string, unknown>, msg: string) => { zeilen.push({ obj, msg }); };
  const r = new ModelRouter({ default: { provider: 'anthropic', model: 'm' } } as MultiModelConfig,
    { info: log, warn: log, debug: log, error: log } as never);
  (r as unknown as { providers: Map<string, LLMProvider> }).providers.set('default', provider());
  return { r, fertig: () => zeilen.filter(z => z.msg === 'LLM call completed').map(z => z.obj) };
}

describe('v1345 Dauer je Modellaufruf', () => {
  it('complete(): durationMs im Log', async () => {
    const { r, fertig } = router();
    await r.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(fertig()).toHaveLength(1);
    expect(fertig()[0].durationMs).toBeGreaterThanOrEqual(10);
  });

  it('stream(): durationMs und ersteAntwortMs, erste Antwort vor dem Ende', async () => {
    const { r, fertig } = router();
    for await (const _ of r.stream({ messages: [{ role: 'user', content: 'hi' }] })) { /* verbrauchen */ }
    const z = fertig()[0];
    expect(z.ersteAntwortMs).toBeGreaterThanOrEqual(10);
    expect(z.durationMs as number).toBeGreaterThan(z.ersteAntwortMs as number);
  });
});
