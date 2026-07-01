import { describe, it, expect } from 'vitest';
import { getModelPricing, calculateCost } from './token-costs.js';
import { lookupContextWindow } from './provider.js';

/**
 * v920 — Claude Sonnet 5 Stammdaten, Kosten-Tracking und die temperature-Grenze.
 * Modell: claude-sonnet-5, 1M ctx / 128k out, $3/$15 per MTok (Einführung $2/$10
 * bis 2026-08-31). Lehnt `temperature` ab (live bewiesen: HTTP 400) — wie die
 * Gen-5-/Opus-4.7+-Familie.
 */

describe('v920 Claude Sonnet 5 — Pricing', () => {
  it('has pricing entry (prevents $0 in dashboard)', () => {
    const p = getModelPricing('claude-sonnet-5');
    expect(p).toBeDefined();
    expect(p!.input).toBe(3.00);
    expect(p!.output).toBe(15.00);
    expect(p!.cacheRead).toBe(0.30);
    expect(p!.cacheWrite).toBe(3.75);
  });

  it('no prefix collision with claude-sonnet-4', () => {
    // startsWith-Lookup: sonnet-5 darf NICHT auf sonnet-4 fallen (und umgekehrt)
    expect('claude-sonnet-5'.startsWith('claude-sonnet-4')).toBe(false);
    expect(getModelPricing('claude-sonnet-4-6')!.input).toBe(3.00);
  });

  it('calculates a realistic call correctly (100k in, 8k out, 60k cache-read)', () => {
    const cost = calculateCost('claude-sonnet-5', {
      inputTokens: 100_000, outputTokens: 8_000,
      cacheReadTokens: 60_000, cacheCreationTokens: 0,
    });
    // regular input = (100k − 60k cache-read) × $3/M = $0.12; cache read: 60k × $0.30/M = $0.018; output: 8k × $15/M = $0.12
    expect(cost).toBeCloseTo(0.258, 4);
  });
});

describe('v920 Claude Sonnet 5 — Context Window', () => {
  it('has 1M/128k entry (prevents generic claude- fallback to 64k)', () => {
    const cw = lookupContextWindow('claude-sonnet-5');
    expect(cw).toBeDefined();
    expect(cw!.maxInputTokens).toBe(1_000_000);
    expect(cw!.maxOutputTokens).toBe(128_000);
  });

  it('sonnet-4-6 keeps its 64k output (no collision)', () => {
    expect(lookupContextWindow('claude-sonnet-4-6')!.maxOutputTokens).toBe(64_000);
  });
});

describe('v920 Sonnet 5 — temperature-Ablehnung (Regex-Grenze)', () => {
  // Spiegelt die Regex aus AnthropicProvider.supportsTemperature() — sperrt die
  // kritische Grenze: Gen-5 lehnt temperature ab, Claude 3.5 behält sie.
  const rejectsTemperature = (m: string) =>
    /(fable|mythos|sonnet|opus|haiku)-5\b/.test(m.toLowerCase());

  it('Gen-5-Modelle lehnen temperature ab', () => {
    expect(rejectsTemperature('claude-sonnet-5')).toBe(true);
    expect(rejectsTemperature('claude-fable-5')).toBe(true);
    expect(rejectsTemperature('claude-mythos-5')).toBe(true);
  });

  it('Claude 3.5 (3-5-sonnet/3-5-haiku) behalten temperature — KEIN Fehltreffer', () => {
    expect(rejectsTemperature('claude-3-5-sonnet-20241022')).toBe(false);
    expect(rejectsTemperature('claude-3-5-haiku-20241022')).toBe(false);
    expect(rejectsTemperature('claude-sonnet-4-6')).toBe(false);
  });
});
