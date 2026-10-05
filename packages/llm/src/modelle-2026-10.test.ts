import { describe, it, expect } from 'vitest';
import { getModelPricing, calculateCost, longPromptMultiplier } from './token-costs.js';
import { lookupContextWindow } from './provider.js';
import { OpenAIProvider } from './providers/openai.js';
import { AnthropicProvider } from './providers/anthropic.js';

/**
 * v1204 — Modell-Update Oktober 2026. Quellen 06.10.2026: Anthropic Models-Overview +
 * claude.com/pricing, Live-Modelllisten von Anthropic/OpenAI/Mistral (api …/v1/models),
 * GPT-6.1-Sol-Ankündigung (29.09.), Preisvergleich 05.10. (OpenAI-Preisseite blockt Abrufe),
 * docs.mistral.ai. Live-Proben der Parameter nicht möglich (OpenAI-/Anthropic-Guthaben leer).
 */
function openai(model: string): OpenAIProvider {
  return new OpenAIProvider({ provider: 'openai', model, apiKey: 'test-key' } as never);
}
function anthropic(model: string): AnthropicProvider {
  return new AnthropicProvider({ provider: 'anthropic', model, apiKey: 'test-key' } as never);
}
const usage = (inputTokens: number, outputTokens: number, cacheReadTokens = 0) =>
  ({ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens: 0 });

describe('v1204 OpenAI — GPT-6.1 Sol, GPT-6 Sol/Luna', () => {
  it('Preise stehen VOR dem generischen gpt-6-Präfix', () => {
    expect(getModelPricing('gpt-6.1-sol')).toMatchObject({ input: 2.00, output: 10.00, cacheRead: 0.10, cacheWrite: 2.50 });
    expect(getModelPricing('gpt-6-sol')).toMatchObject({ input: 2.00, output: 10.00, cacheRead: 0.20 });
    expect(getModelPricing('gpt-6-luna')).toMatchObject({ input: 0.10, output: 0.50, cacheRead: 0.01 });
    expect(getModelPricing('gpt-6-astra')).toMatchObject({ input: 10.00, output: 50.00 });
  });
  it('200k Input + 50k Output auf gpt-6-sol kostet $0.90 statt $4.50 (vorher Astra-Preis); >272k greift der Zuschlag', () => {
    expect(calculateCost('gpt-6-sol', usage(200_000, 50_000))).toBeCloseTo(0.9, 3);
    expect(calculateCost('gpt-6-sol', usage(1_000_000, 100_000))).toBeCloseTo(5.5, 2); // 2× Input, 1,5× Output
  });
  it('Langkontext-Zuschlag und Kontextfenster gelten für 6.1/Sol/Luna', () => {
    expect(longPromptMultiplier('gpt-6.1-sol', 300_000)).toEqual({ input: 2.0, output: 1.5 });
    expect(lookupContextWindow('gpt-6.1-sol')).toEqual({ maxInputTokens: 1_050_000, maxOutputTokens: 128_000 });
    expect(lookupContextWindow('gpt-6-luna')).toEqual({ maxInputTokens: 1_050_000, maxOutputTokens: 128_000 });
  });
  it('gpt-6.1-sol ist Reasoning-Modell: Responses-API-Pfad, max_completion_tokens, none→low', () => {
    const p = openai('gpt-6.1-sol') as unknown as { isReasoningModel(): boolean; reasoningEffortParam(e: string): string | undefined; tokenLimitParam(n?: number): Record<string, number> };
    expect(p.isReasoningModel()).toBe(true);
    expect(p.reasoningEffortParam('none')).toBe('low');
    expect(p.reasoningEffortParam('max')).toBe('xhigh');
    expect(p.tokenLimitParam(1000)).toEqual({ max_completion_tokens: 1000 });
  });
});

describe('v1204 Anthropic — Opus 5.5 / Sonnet 5.5', () => {
  it('Preise und Cache-Sätze; Opus 5 bleibt $5/$25', () => {
    expect(getModelPricing('claude-opus-5-5')).toMatchObject({ input: 4.00, output: 20.00, cacheRead: 0.20, cacheWrite: 5.00 });
    expect(getModelPricing('claude-sonnet-5-5')).toMatchObject({ input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 2.50 });
    expect(getModelPricing('claude-opus-5')).toMatchObject({ input: 5.00, output: 25.00 });
    expect(lookupContextWindow('claude-opus-5-5')).toEqual({ maxInputTokens: 1_000_000, maxOutputTokens: 128_000 });
  });
  it('keine temperature; Opus 5.5 Thinking immer an (effort low), Sonnet 5.5 wie Sonnet 5 (disabled)', () => {
    const opus = anthropic('claude-opus-5-5') as unknown as { supportsTemperature(): boolean; thinkingParam(r: { reasoningEffort?: string }): Record<string, unknown> };
    const sonnet = anthropic('claude-sonnet-5-5') as unknown as { supportsTemperature(): boolean; thinkingParam(r: { reasoningEffort?: string }): Record<string, unknown> };
    expect(opus.supportsTemperature()).toBe(false);
    expect(sonnet.supportsTemperature()).toBe(false);
    expect(opus.thinkingParam({ reasoningEffort: 'low' })).toEqual({ output_config: { effort: 'low' } });
    expect(sonnet.thinkingParam({ reasoningEffort: 'low' })).toEqual({ thinking: { type: 'disabled' } });
    expect(sonnet.thinkingParam({ reasoningEffort: 'high' })).toEqual({});
  });
});

describe('v1204 Mistral — Ministral 3', () => {
  it('Dokumentations-IDs und Live-IDs sind bepreist', () => {
    expect(getModelPricing('ministral-3-14b-25-12')).toMatchObject({ input: 0.20, output: 0.20 });
    expect(getModelPricing('ministral-14b-2512')).toMatchObject({ input: 0.20, output: 0.20 });
    expect(getModelPricing('mistral-large-2512')).toMatchObject({ input: 0.50, output: 1.50 });
  });
});
