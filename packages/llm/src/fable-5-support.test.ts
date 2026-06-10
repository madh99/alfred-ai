import { describe, it, expect } from 'vitest';
import { getModelPricing, calculateCost } from './token-costs.js';
import { lookupContextWindow } from './provider.js';

/**
 * v860 — Claude Fable 5 Stammdaten + Kosten-Tracking.
 * Modell: claude-fable-5, $10/$50 per MTok, 1M ctx, 128k out,
 * Cache write $12.50 (1.25x) / read $1.00 (0.1x).
 */

describe('v860 Claude Fable 5 — Pricing', () => {
  it('has pricing entry (prevents $0 in dashboard)', () => {
    const p = getModelPricing('claude-fable-5');
    expect(p).toBeDefined();
    expect(p!.input).toBe(10.00);
    expect(p!.output).toBe(50.00);
    expect(p!.cacheRead).toBe(1.00);
    expect(p!.cacheWrite).toBe(12.50);
  });

  it('mythos-5 shares fable-5 pricing', () => {
    const p = getModelPricing('claude-mythos-5');
    expect(p).toEqual(getModelPricing('claude-fable-5'));
  });

  it('calculates a realistic call correctly (50k in, 5k out, 40k cache-read)', () => {
    const cost = calculateCost('claude-fable-5', {
      inputTokens: 50_000, outputTokens: 5_000,
      cacheReadTokens: 40_000, cacheCreationTokens: 0,
    });
    // regular input: 10k × $10/M = $0.10; cache read: 40k × $1/M = $0.04; output: 5k × $50/M = $0.25
    expect(cost).toBeCloseTo(0.39, 4);
  });

  it('opus-4-8 pricing unchanged (no prefix collision)', () => {
    const p = getModelPricing('claude-opus-4-8');
    expect(p!.input).toBe(5.00);
    expect(p!.output).toBe(25.00);
  });
});

describe('v860 Claude Fable 5 — Context Window', () => {
  it('has 1M/128k context entry (prevents fallback)', () => {
    const cw = lookupContextWindow('claude-fable-5');
    expect(cw).toBeDefined();
    expect(cw!.maxInputTokens).toBe(1_000_000);
    expect(cw!.maxOutputTokens).toBe(128_000);
  });
});
