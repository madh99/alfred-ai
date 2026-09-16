import { describe, it, expect } from 'vitest';
import { getModelPricing, calculateCost, longPromptMultiplier } from './token-costs.js';
import { lookupContextWindow } from './provider.js';
import { OpenAIProvider } from './providers/openai.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { MistralProvider } from './providers/mistral.js';

/**
 * v1156 — Modell-Update September 2026 (Quellen: offizielle Preisseiten von
 * OpenAI, Anthropic, Google, Mistral am 16.09.2026 + Live-Modelllisten).
 * Live-Proben der API-Parameter waren nicht möglich (OpenAI- und Anthropic-
 * Guthaben leer) — die Parameter-Regeln folgen der Dokumentation.
 */

function openai(model: string): OpenAIProvider {
  return new OpenAIProvider({ provider: 'openai', model, apiKey: 'test-key' } as never);
}
function anthropic(model: string): AnthropicProvider {
  return new AnthropicProvider({ provider: 'anthropic', model, apiKey: 'test-key' } as never);
}
function mistral(model: string): MistralProvider {
  return new MistralProvider({ provider: 'mistral', model, apiKey: 'test-key' } as never);
}
const usage = (inputTokens: number, outputTokens: number, cacheReadTokens = 0) =>
  ({ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens: 0 });

describe('v1156 OpenAI — GPT-6 Astra + Preissenkung GPT-5.6', () => {
  it('gpt-6-astra: $10/$50, Cache-Read $1, 1,05M/128k', () => {
    expect(getModelPricing('gpt-6-astra')).toMatchObject({ input: 10.00, output: 50.00, cacheRead: 1.00 });
    expect(lookupContextWindow('gpt-6-astra')).toEqual({ maxInputTokens: 1_050_000, maxOutputTokens: 128_000 });
  });

  it('gpt-5.6 wurde gesenkt: Sol $4/$20, Terra $2/$12, Luna $0.20/$1.20', () => {
    expect(getModelPricing('gpt-5.6-sol')).toMatchObject({ input: 4.00, output: 20.00, cacheRead: 0.40 });
    expect(getModelPricing('gpt-5.6-terra')).toMatchObject({ input: 2.00, output: 12.00, cacheRead: 0.20 });
    expect(getModelPricing('gpt-5.6-luna')).toMatchObject({ input: 0.20, output: 1.20, cacheRead: 0.02 });
  });

  it('Pro-/Codex-Varianten stehen VOR ihren Basis-Präfixen', () => {
    expect(getModelPricing('gpt-5.5-pro')).toMatchObject({ input: 30.00, output: 180.00 });
    expect(getModelPricing('gpt-5.4-pro')).toMatchObject({ input: 30.00, output: 180.00 });
    expect(getModelPricing('gpt-5-pro')).toMatchObject({ input: 15.00, output: 120.00 });
    expect(getModelPricing('gpt-5.3-codex')).toMatchObject({ input: 1.75, output: 14.00 });
    expect(getModelPricing('gpt-5.5')).toMatchObject({ input: 5.00, output: 30.00 });
    expect(getModelPricing('gpt-5-mini')).toMatchObject({ input: 0.625, output: 5.00 });
  });

  it('Langkontext-Zuschlag >272k gilt für gpt-6, gpt-5.6, gpt-5.5, gpt-5.4 (nicht mini/nano)', () => {
    expect(longPromptMultiplier('gpt-6-astra', 300_000)).toEqual({ input: 2.0, output: 1.5 });
    expect(longPromptMultiplier('gpt-5.6-luna', 300_000)).toEqual({ input: 2.0, output: 1.5 });
    expect(longPromptMultiplier('gpt-5.4', 300_000)).toEqual({ input: 2.0, output: 1.5 });
    expect(longPromptMultiplier('gpt-5.4-mini', 300_000)).toEqual({ input: 1.0, output: 1.0 });
    expect(longPromptMultiplier('gpt-6-astra', 200_000)).toEqual({ input: 1.0, output: 1.0 });
    // 300k in / 10k out auf Astra: 300k×$20/M + 10k×$75/M = 6.00 + 0.75
    expect(calculateCost('gpt-6-astra', usage(300_000, 10_000))).toBeCloseTo(6.75, 4);
  });

  it('gpt-6 ist Reasoning-Modell: keine temperature, max_completion_tokens, none→low', () => {
    const p = openai('gpt-6-astra') as never as {
      safeTemperature(t?: number): number | undefined;
      tokenLimitParam(m?: number): Record<string, number>;
      reasoningEffortParam(e?: string): string | undefined;
    };
    expect(p.safeTemperature(0.7)).toBeUndefined();
    expect(p.tokenLimitParam(1000)).toEqual({ max_completion_tokens: 1000 });
    expect(p.reasoningEffortParam('none')).toBe('low');
    expect(p.reasoningEffortParam('xhigh')).toBe('xhigh');
  });

  it('Bild-Modelle und ada-002 haben Preise', () => {
    expect(getModelPricing('gpt-image-2.5-flare')).toMatchObject({ input: 5.00, output: 30.00 });
    expect(getModelPricing('gpt-image-1-mini')).toMatchObject({ input: 2.00, output: 8.00 });
    expect(getModelPricing('gpt-image-1')).toMatchObject({ input: 5.00, output: 40.00 });
    expect(getModelPricing('text-embedding-ada-002')).toMatchObject({ input: 0.10 });
  });
});

describe('v1156 Anthropic — Fable 5.1 / Mythos 5.1 + Sonnet-5-Dauerpreis', () => {
  it('fable-5-1: $10/$50, Cache-Read $0.25 (0.025x), Cache-Write $12.50; fable-5 bleibt $1 Cache-Read', () => {
    expect(getModelPricing('claude-fable-5-1')).toEqual({ input: 10.00, output: 50.00, cacheRead: 0.25, cacheWrite: 12.50 });
    expect(getModelPricing('claude-mythos-5-1')).toEqual(getModelPricing('claude-fable-5-1'));
    expect(getModelPricing('claude-fable-5')!.cacheRead).toBe(1.00);
    // 10k frisch + 90k Cache-Read + 5k out: 0.10 + 0.0225 + 0.25
    expect(calculateCost('claude-fable-5-1', usage(100_000, 5_000, 90_000))).toBeCloseTo(0.3725, 4);
  });

  it('Sonnet 5: $2/$10 ist Dauerpreis (Erhöhung auf $3/$15 entfällt)', () => {
    expect(getModelPricing('claude-sonnet-5')).toEqual({ input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 2.50 });
    expect(getModelPricing('claude-sonnet-4-6')).toMatchObject({ input: 3.00, output: 15.00 });
  });

  it('Kontextfenster 1M/128k für fable-5-1', () => {
    expect(lookupContextWindow('claude-fable-5-1')).toEqual({ maxInputTokens: 1_000_000, maxOutputTokens: 128_000 });
  });

  it('Fable/Mythos: Thinking nie abschalten — effort low statt thinking:disabled; Opus 5 weiter disabled', () => {
    const fable = anthropic('claude-fable-5-1') as never as { thinkingParam(r: unknown): Record<string, unknown>; supportsTemperature(): boolean };
    expect(fable.supportsTemperature()).toBe(false);
    expect(fable.thinkingParam({ reasoningEffort: 'low' })).toEqual({ output_config: { effort: 'low' } });
    expect(fable.thinkingParam({ reasoningEffort: 'high' })).toEqual({});
    const opus = anthropic('claude-opus-5') as never as { thinkingParam(r: unknown): Record<string, unknown> };
    expect(opus.thinkingParam({ reasoningEffort: 'none' })).toEqual({ thinking: { type: 'disabled' } });
  });
});

describe('v1156 Google — Gemini 3.8/3.7/3.6/3.5 Flash', () => {
  it('Einführungspreis $0.75/$3.75 (bis 31.12.2026) und 3.5-Preise', () => {
    expect(getModelPricing('gemini-3.8-flash')).toMatchObject({ input: 0.75, output: 3.75, cacheRead: 0.075 });
    expect(getModelPricing('gemini-3.7-flash')).toMatchObject({ input: 0.75, output: 3.75 });
    expect(getModelPricing('gemini-3.5-flash')).toMatchObject({ input: 1.50, output: 9.00 });
    expect(getModelPricing('gemini-3.5-flash-lite')).toMatchObject({ input: 0.30, output: 2.50 });
    expect(lookupContextWindow('gemini-3.8-flash')).toEqual({ maxInputTokens: 1_048_576, maxOutputTokens: 65_536 });
  });
});

describe('v1156 Mistral — Medium-3.5-Aliase, GLM, Embeddings', () => {
  it('alle drei Medium-3.5-Schreibweisen kosten $1.50/$7.50 (vorher generisch $0.40/$2)', () => {
    for (const m of ['mistral-medium-3-5', 'mistral-medium-3.5', 'mistral-medium-2604', 'mistral-medium-latest']) {
      expect(getModelPricing(m), m).toMatchObject({ input: 1.50, output: 7.50, cacheRead: 0.15 });
      expect(lookupContextWindow(m)!.maxInputTokens, m).toBe(256_000);
    }
    expect(getModelPricing('mistral-medium-2505')).toMatchObject({ input: 0.40, output: 2.00 });
  });

  it('Prompt-Caching-Schlüssel wird für alle Medium-3.5-Aliase gesetzt', () => {
    for (const m of ['mistral-medium-3.5', 'mistral-medium-2604', 'mistral-medium-latest']) {
      expect((mistral(m) as never as { supportsPromptCaching(): boolean }).supportsPromptCaching(), m).toBe(true);
    }
    expect((mistral('mistral-large-latest') as never as { supportsPromptCaching(): boolean }).supportsPromptCaching()).toBe(false);
  });

  it('GLM 5.2/5.3, Small 4 (2603), Large 3 (2512), Codestral Embed, Leanstral', () => {
    expect(getModelPricing('zai-glm-5-3')).toMatchObject({ input: 1.40, output: 4.40 });
    expect(getModelPricing('glm-5-2')).toMatchObject({ input: 1.40, output: 4.40 });
    expect(getModelPricing('mistral-small-2603')).toMatchObject({ input: 0.15, output: 0.60 });
    expect(getModelPricing('mistral-large-2512')).toMatchObject({ input: 0.50, output: 1.50 });
    expect(getModelPricing('codestral-embed')).toMatchObject({ input: 0.15 });
    expect(getModelPricing('labs-leanstral-1-5')).toEqual({ input: 0, output: 0 });
  });
});
