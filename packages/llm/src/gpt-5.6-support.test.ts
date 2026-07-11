import { describe, it, expect } from 'vitest';
import { getModelPricing, calculateCost } from './token-costs.js';
import { lookupContextWindow } from './provider.js';
import { OpenAIProvider } from './providers/openai.js';

/**
 * v1097 — GPT-5.6-Familie (Luna/Terra/Sol) Stammdaten + API-Eigenheiten.
 * Live verprobt 11.07.2026: Reasoning-Familie — temperature wird ABGELEHNT
 * („Only the default (1) value is supported"), reasoning_effort none…xhigh
 * (das neue 'max' existiert nur in der Responses-API), max_completion_tokens
 * Pflicht, Tools+reasoning_effort in chat/completions unvereinbar (wie 5.5).
 * Preise (OpenAI-Ankündigung): Sol $5/$30 · Terra $2.50/$15 · Luna $1/$6;
 * Cache-Read = 10% des Inputs (OpenAI-Standardrabatt). Kontext laut Docs:
 * 1.050.000 / 128.000 (Sol und Luna explizit, Terra analog).
 */

function provider(model: string): OpenAIProvider {
  return new OpenAIProvider({ provider: 'openai', model, apiKey: 'test-key' } as never);
}

describe('v1097 GPT-5.6 — Pricing', () => {
  it('alle drei Stufen haben Preise (verhindert $0 im Dashboard)', () => {
    expect(getModelPricing('gpt-5.6-sol')).toMatchObject({ input: 5.00, output: 30.00 });
    expect(getModelPricing('gpt-5.6-terra')).toMatchObject({ input: 2.50, output: 15.00 });
    expect(getModelPricing('gpt-5.6-luna')).toMatchObject({ input: 1.00, output: 6.00 });
  });

  it('Datums-Varianten matchen per Prefix; gpt-5.5 bleibt unberührt', () => {
    expect(getModelPricing('gpt-5.6-luna-2026-07-09')).toEqual(getModelPricing('gpt-5.6-luna'));
    expect(getModelPricing('gpt-5.5')).toMatchObject({ input: 5.00, output: 30.00 });
  });

  it('realistischer Luna-Call (100k in, 4k out)', () => {
    const cost = calculateCost('gpt-5.6-luna', { inputTokens: 100_000, outputTokens: 4_000, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(cost).toBeCloseTo(0.124, 4); // 100k×$1/M + 4k×$6/M
  });
});

describe('v1097 GPT-5.6 — Kontextfenster', () => {
  it('1,05M/128k je Stufe (verhindert Fallback)', () => {
    for (const m of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      const cw = lookupContextWindow(m);
      expect(cw, m).toBeDefined();
      expect(cw!.maxInputTokens).toBe(1_050_000);
      expect(cw!.maxOutputTokens).toBe(128_000);
    }
  });
});

describe('v1097 GPT-5.6 — Reasoning-Parameter (live verprobt)', () => {
  it('temperature wird weggelassen (API lehnt alles außer Default ab)', () => {
    for (const m of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect((provider(m) as never as { safeTemperature(t?: number): number | undefined }).safeTemperature(0.7), m).toBeUndefined();
    }
    // Chat-Modelle bleiben unangetastet
    expect((provider('gpt-5.4') as never as { safeTemperature(t?: number): number | undefined }).safeTemperature(0.7)).toBe(0.7);
  });

  it('reasoning_effort wird durchgereicht (none…xhigh), max_completion_tokens statt max_tokens', () => {
    const p = provider('gpt-5.6-terra') as never as {
      reasoningEffortParam(r?: string): string | undefined;
      tokenLimitParam(m?: number): { max_tokens?: number; max_completion_tokens?: number };
    };
    expect(p.reasoningEffortParam('xhigh')).toBe('xhigh');
    expect(p.tokenLimitParam(2048)).toEqual({ max_completion_tokens: 2048 });
    // gpt-5.4 (Chat-Modell): kein reasoning_effort
    expect((provider('gpt-5.4') as never as { reasoningEffortParam(r?: string): string | undefined }).reasoningEffortParam('low')).toBeUndefined();
  });
});
