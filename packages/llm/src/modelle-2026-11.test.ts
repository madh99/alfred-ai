import { describe, it, expect } from 'vitest';
import { getModelPricing, calculateCost, longPromptMultiplier } from './token-costs.js';
import { lookupContextWindow } from './provider.js';
import { OpenAIProvider } from './providers/openai.js';
import { AnthropicProvider } from './providers/anthropic.js';

/**
 * v1917 — Modell-Update November 2026. Quellen 21.11.2026: Live-Modelllisten OpenAI/Anthropic/Mistral (…/v1/models),
 * Live-Proben in Alfreds Anfrageformen (Responses mit Werkzeug + Folgerunde, Effort-Stufen, temperature, Cache-Haltepunkte,
 * chat/completions) für gpt-6.2-sol, gpt-6.2-astra, gpt-6.1-terra, mistral-large-4/-latest; Preise laut OpenAI-Preisseite und
 * Preisvergleichen. claude-fable-5-2 live nicht verprobt (Anthropic-Guthaben leer).
 */
function openai(model: string): OpenAIProvider {
  return new OpenAIProvider({ provider: 'openai', model, apiKey: 'test-key' } as never);
}
function anthropic(model: string): AnthropicProvider {
  return new AnthropicProvider({ provider: 'anthropic', model, apiKey: 'test-key' } as never);
}
const usage = (inputTokens: number, outputTokens: number, cacheReadTokens = 0) =>
  ({ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens: 0 });
type Responses = { buildResponsesParams(r: Record<string, unknown>): Record<string, unknown> };

describe('v1917 OpenAI — GPT-6.2 Sol/Astra, GPT-6.1 Terra', () => {
  it('eigene Preise statt des generischen gpt-6-Preises ($10/$50)', () => {
    expect(getModelPricing('gpt-6.2-sol')).toMatchObject({ input: 2.00, output: 10.00, cacheRead: 0.10 });
    expect(getModelPricing('gpt-6.2-astra')).toMatchObject({ input: 8.00, output: 40.00, cacheRead: 0.40 });
    expect(getModelPricing('gpt-6.1-terra')).toMatchObject({ input: 1.00, output: 5.00, cacheRead: 0.05 });
    expect(getModelPricing('gpt-6.1-sol')).toMatchObject({ input: 2.00, output: 10.00 });
    expect(getModelPricing('gpt-6')).toMatchObject({ input: 10.00, output: 50.00 });
  });
  it('100k Input (90k aus dem Cache) + 5k Output auf gpt-6.2-sol = $0.079; >272k greift der Zuschlag', () => {
    expect(calculateCost('gpt-6.2-sol', usage(100_000, 5_000, 90_000))).toBeCloseTo(0.079, 4);
    expect(longPromptMultiplier('gpt-6.2-sol', 300_000)).toEqual({ input: 2.0, output: 1.5 });
    expect(longPromptMultiplier('gpt-6.1-terra', 300_000)).toEqual({ input: 2.0, output: 1.5 });
  });
  it('Kontextfenster 1.05M / 128k', () => {
    for (const m of ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra']) {
      expect(lookupContextWindow(m)).toEqual({ maxInputTokens: 1_050_000, maxOutputTokens: 128_000 });
    }
  });
  it('Reasoning-Modelle: Responses-API, keine temperature, max_completion_tokens', () => {
    for (const m of ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra']) {
      const p = openai(m) as unknown as { isReasoningModel(): boolean; useResponsesApi(): boolean; safeTemperature(t?: number): number | undefined; tokenLimitParam(n?: number): Record<string, number> };
      expect(p.isReasoningModel()).toBe(true);
      expect(p.useResponsesApi()).toBe(true);
      expect(p.safeTemperature(0.3)).toBeUndefined();
      expect(p.tokenLimitParam(1000)).toEqual({ max_completion_tokens: 1000 });
    }
  });
  it('Responses-Weg: effort none wird low (6.2 lehnt none mit 400 ab), max bleibt max, ohne Effort kein reasoning', () => {
    const p = openai('gpt-6.2-sol') as unknown as Responses;
    const anfrage = (reasoningEffort?: string) => ({ messages: [{ role: 'user', content: 'Hallo' }], ...(reasoningEffort ? { reasoningEffort } : {}) });
    expect(p.buildResponsesParams(anfrage('none')).reasoning).toEqual({ effort: 'low' });
    expect(p.buildResponsesParams(anfrage('max')).reasoning).toEqual({ effort: 'max' });
    expect(p.buildResponsesParams(anfrage('medium')).reasoning).toEqual({ effort: 'medium' });
    expect(p.buildResponsesParams(anfrage()).reasoning).toBeUndefined();
    expect(p.buildResponsesParams(anfrage('low')).temperature).toBeUndefined();
  });
  it('ältere Reasoning-Modelle behalten none im Responses-Weg (gpt-5.6 kennt none)', () => {
    const p = openai('gpt-5.6-sol') as unknown as Responses;
    expect(p.buildResponsesParams({ messages: [{ role: 'user', content: 'Hallo' }], reasoningEffort: 'none' }).reasoning).toEqual({ effort: 'none' });
  });
});

describe('v1917 Anthropic — Fable 5.2 / Mythos 5.2', () => {
  it('Preis $8/$40 (Cache-Read $0.20, Write $10) statt Fable 5 ($10/$50, Cache $1)', () => {
    expect(getModelPricing('claude-fable-5-2')).toMatchObject({ input: 8.00, output: 40.00, cacheRead: 0.20, cacheWrite: 10.00 });
    expect(getModelPricing('claude-mythos-5-2')).toMatchObject({ input: 8.00, output: 40.00, cacheRead: 0.20 });
    expect(getModelPricing('claude-fable-5-1')).toMatchObject({ input: 10.00, output: 50.00, cacheRead: 0.25 });
    expect(lookupContextWindow('claude-fable-5-2')).toEqual({ maxInputTokens: 1_000_000, maxOutputTokens: 128_000 });
  });
  it('Gen-5-Regeln greifen: keine temperature, Thinking immer an (effort low), Fallback-Modell bei Ablehnung', () => {
    type A = { supportsTemperature(): boolean; thinkingParam(r: { reasoningEffort?: string }): Record<string, unknown>; fallbacksParam(): Record<string, unknown>; anfrageOptionen(): unknown };
    const p = anthropic('claude-fable-5-2') as unknown as A;
    expect(p.supportsTemperature()).toBe(false);
    expect(p.thinkingParam({ reasoningEffort: 'low' })).toEqual({ output_config: { effort: 'low' } });
    // Live-Probe 21.11.: ohne Header 400 „Extra inputs are not permitted“, Liste ['claude-opus-4-8'] 400 „does not match the expected shape“
    expect(p.fallbacksParam()).toEqual({ fallbacks: 'default' });
    expect(p.anfrageOptionen()).toEqual({ headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' } });
  });
  it('Modelle ohne fallbacks bekommen keinen Beta-Header', () => {
    const p = anthropic('claude-opus-5-5') as unknown as { fallbacksParam(): Record<string, unknown>; anfrageOptionen(): unknown };
    expect(p.fallbacksParam()).toEqual({});
    expect(p.anfrageOptionen()).toBeUndefined();
  });
  it('create und stream schicken den Header mit (Fable), ohne Header bei anderen Modellen', async () => {
    for (const [modell, erwartet] of [['claude-fable-5-2', { headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' } }], ['claude-sonnet-5-5', undefined]] as const) {
      const p = anthropic(modell);
      const optionen: unknown[] = [];
      const antwort = { id: 'm', model: modell, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
      (p as unknown as { client: unknown }).client = {
        messages: {
          create: async (_b: unknown, o: unknown) => { optionen.push(o); return antwort; },
          stream: (_b: unknown, o: unknown) => { optionen.push(o); return { async *[Symbol.asyncIterator]() { /* leer */ }, finalMessage: async () => antwort }; },
        },
      };
      await p.complete({ messages: [{ role: 'user', content: 'Hallo' }] } as never);
      for await (const _ of p.stream({ messages: [{ role: 'user', content: 'Hallo' }] } as never)) { /* leeren */ }
      expect(optionen).toEqual([erwartet, erwartet]);
    }
  });
});

describe('v1917 Mistral — Large 4 hinter mistral-large-latest', () => {
  it('Preis $0.70/$2.10 und 1M Kontext; Large 3 (2512) bleibt $0.50/$1.50 und 256k', () => {
    expect(getModelPricing('mistral-large-latest')).toMatchObject({ input: 0.70, output: 2.10, cacheRead: 0.07 });
    expect(getModelPricing('mistral-large-4-0')).toMatchObject({ input: 0.70, output: 2.10 });
    expect(getModelPricing('mistral-large-2512')).toMatchObject({ input: 0.50, output: 1.50 });
    expect(lookupContextWindow('mistral-large-latest')).toEqual({ maxInputTokens: 1_048_576, maxOutputTokens: 256_000 });
    expect(lookupContextWindow('mistral-large-4')?.maxInputTokens).toBe(1_048_576);
    expect(lookupContextWindow('mistral-large-2512')?.maxInputTokens).toBe(256_000);
  });
});
