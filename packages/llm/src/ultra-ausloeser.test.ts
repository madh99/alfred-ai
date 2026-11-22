import { describe, it, expect } from 'vitest';
import { ModelRouter } from './model-router.js';
import type { UltraNutzung } from './model-router.js';
import { mitUltraAusloeser, ULTRA_OHNE_AUSLOESER } from './ultra-grund.js';
import type { LLMProvider } from './provider.js';
import type { LLMResponse, MultiModelConfig } from '@alfred/types';

/**
 * Spec Stufe ultra U3 — jeder Aufruf, der ultra angefordert hat, wird mit Auslöser und Kosten verbucht (Callback und
 * Logzeile „LLM call completed“ mit `ultra`). Andere Stufen bleiben unberührt.
 */

function provider(label: string, fehler?: Error): LLMProvider {
  return {
    async initialize() { /* noop */ },
    async complete(): Promise<LLMResponse> {
      if (fehler) throw fehler;
      return { content: label, model: label, usage: { inputTokens: 1000, outputTokens: 100 } } as LLMResponse;
    },
    async *stream() {
      if (fehler) throw fehler;
      yield { type: 'message_complete', response: { content: label, model: label, usage: { inputTokens: 2000, outputTokens: 50 }, stopReason: 'end_turn' } };
    },
    async embed() { return undefined; },
    supportsEmbeddings() { return false; },
    isAvailable() { return true; },
    getContextWindow() { return { total: 100000, maxOutput: 4096 }; },
  } as unknown as LLMProvider;
}

function aufbau(tiers: Record<string, LLMProvider>) {
  const zeilen: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const log = { info: (obj: Record<string, unknown>, msg: string) => zeilen.push({ obj, msg }), warn: (obj: Record<string, unknown>, msg: string) => zeilen.push({ obj, msg }), debug: () => undefined };
  const router = new ModelRouter({
    default: { provider: 'openai', model: 'gpt-6.2-sol' },
    strong: { provider: 'anthropic', model: 'claude-opus-5-5' },
    ultra: { provider: 'anthropic', model: 'claude-fable-5-2' },
  } as MultiModelConfig, log);
  const m = (router as unknown as { providers: Map<string, LLMProvider> }).providers;
  for (const [t, p] of Object.entries(tiers)) m.set(t, p);
  const nutzung: UltraNutzung[] = [];
  router.setUltraNutzungCallback(n => nutzung.push(n));
  return { router, zeilen, nutzung, fertig: () => zeilen.filter(z => z.msg === 'LLM call completed').map(z => z.obj) };
}

const frage = { messages: [{ role: 'user' as const, content: 'hi' }] };

describe('Spec Stufe ultra U3 — Auslöser und Kosten', () => {
  it('ausdrücklich: Callback mit Auslöser, Ort, Modell und Kosten; Logzeile trägt ultra', async () => {
    const { router, nutzung, fertig } = aufbau({ default: provider('gpt-6.2-sol'), strong: provider('claude-opus-5-5'), ultra: provider('claude-fable-5-2') });
    await mitUltraAusloeser({ grund: 'ausdrücklich', ort: 'owner:faden:x' }, () => router.complete({ ...frage, tier: 'ultra' }));
    expect(nutzung).toHaveLength(1);
    expect(nutzung[0]).toMatchObject({ grund: 'ausdrücklich', ort: 'owner:faden:x', stufe: 'ultra', modell: 'claude-fable-5-2', inputTokens: 1000, outputTokens: 100 });
    expect(nutzung[0]!.kostenUsd).toBeGreaterThan(0);
    expect(fertig()[0]).toMatchObject({ tier: 'ultra', model: 'claude-fable-5-2', ultra: 'ausdrücklich' });
  });

  it('Stream: ebenso verbucht', async () => {
    const { router, nutzung, fertig } = aufbau({ default: provider('gpt-6.2-sol'), ultra: provider('claude-fable-5-2') });
    await mitUltraAusloeser({ grund: 'gegenpruefung:abcdef12-0000' }, async () => { for await (const _ of router.stream({ ...frage, tier: 'ultra' })) { /* leeren */ } });
    expect(nutzung[0]).toMatchObject({ grund: 'gegenpruefung:abcdef12-0000', stufe: 'ultra', inputTokens: 2000 });
    expect(fertig()[0]).toMatchObject({ stream: true, ultra: 'gegenpruefung:abcdef12-0000' });
  });

  it('Rückfall: ultra fällt aus → verbucht mit tatsächlicher Stufe strong', async () => {
    const { router, nutzung } = aufbau({ default: provider('gpt-6.2-sol'), strong: provider('claude-opus-5-5'), ultra: provider('claude-fable-5-2', new Error('529 overloaded')) });
    await mitUltraAusloeser({ grund: 'eskalation:einwand' }, () => router.complete({ ...frage, tier: 'ultra' }));
    expect(nutzung).toHaveLength(1);
    expect(nutzung[0]).toMatchObject({ grund: 'eskalation:einwand', stufe: 'strong', modell: 'claude-opus-5-5' });
  });

  it('ohne Auslöser: als ohne-ausloeser verbucht und gewarnt', async () => {
    const { router, nutzung, zeilen } = aufbau({ default: provider('gpt-6.2-sol'), ultra: provider('claude-fable-5-2') });
    await router.complete({ ...frage, tier: 'ultra' });
    expect(nutzung[0]?.grund).toBe(ULTRA_OHNE_AUSLOESER);
    expect(zeilen.some(z => z.msg === 'Spec ultra U3: ultra-Aufruf ohne Auslöser')).toBe(true);
  });

  it('andere Stufen: kein Eintrag, auch innerhalb eines ultra-Kontexts (Hintergrund-Auswertung auf fast)', async () => {
    const { router, nutzung, fertig } = aufbau({ default: provider('gpt-6.2-sol'), strong: provider('claude-opus-5-5'), ultra: provider('claude-fable-5-2') });
    await mitUltraAusloeser({ grund: 'ausdrücklich' }, async () => {
      await router.complete({ ...frage, tier: 'strong' });
      await router.complete(frage);
    });
    expect(nutzung).toHaveLength(0);
    expect(fertig().every(z => !('ultra' in z))).toBe(true);
  });
});
