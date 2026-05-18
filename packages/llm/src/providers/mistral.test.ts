import { describe, it, expect } from 'vitest';
import { MistralProvider } from './mistral.js';
import { getModelPricing } from '../token-costs.js';
import { lookupContextWindow } from '../provider.js';

// Helper to instantiate MistralProvider with a given model name (no API call).
function mk(model: string): MistralProvider {
  return new MistralProvider({ provider: 'mistral', apiKey: 'test', model });
}

describe('Mistral Medium 3.5 — pricing match', () => {
  it('matches the new 3.5 entry, not the generic mistral-medium', () => {
    const p = getModelPricing('mistral-medium-3-5-26-04');
    expect(p?.input).toBe(1.50);
    expect(p?.output).toBe(7.50);
    expect(p?.cacheRead).toBe(0.15);
  });

  it('matches the alias mistral-medium-3-5', () => {
    const p = getModelPricing('mistral-medium-3-5');
    expect(p?.input).toBe(1.50);
    expect(p?.output).toBe(7.50);
  });

  it('does NOT regress the older generic mistral-medium (still 0.40/2.00)', () => {
    // 'mistral-medium' alone should still hit the old entry — that's the v3.0/v3.1 pricing.
    const p = getModelPricing('mistral-medium');
    expect(p?.input).toBe(0.40);
    expect(p?.output).toBe(2.00);
  });

  it('mistral-medium-3 (v3.0) hits the generic entry, not 3.5', () => {
    // Important: 'mistral-medium-3' does NOT prefix-match 'mistral-medium-3-5'.
    const p = getModelPricing('mistral-medium-3');
    expect(p?.input).toBe(0.40);
    expect(p?.output).toBe(2.00);
  });
});

describe('Mistral Medium 3.5 — context window', () => {
  it('returns 256k input for the new model', () => {
    const cw = lookupContextWindow('mistral-medium-3-5-26-04');
    expect(cw?.maxInputTokens).toBe(256_000);
  });

  it('returns 131k input for the older generic mistral-medium', () => {
    const cw = lookupContextWindow('mistral-medium');
    expect(cw?.maxInputTokens).toBe(131_072);
  });
});

describe('Mistral prompt_cache_key — scoped to 3.5 models', () => {
  it('enables caching for mistral-medium-3-5', () => {
    const p = mk('mistral-medium-3-5');
    expect((p as unknown as { supportsPromptCaching: () => boolean }).supportsPromptCaching()).toBe(true);
  });

  it('enables caching for the dated snapshot mistral-medium-3-5-26-04', () => {
    const p = mk('mistral-medium-3-5-26-04');
    expect((p as unknown as { supportsPromptCaching: () => boolean }).supportsPromptCaching()).toBe(true);
  });

  it('does NOT enable caching for older mistral-medium', () => {
    const p = mk('mistral-medium');
    expect((p as unknown as { supportsPromptCaching: () => boolean }).supportsPromptCaching()).toBe(false);
  });

  it('does NOT enable caching for mistral-medium-3', () => {
    const p = mk('mistral-medium-3');
    expect((p as unknown as { supportsPromptCaching: () => boolean }).supportsPromptCaching()).toBe(false);
  });

  it('does NOT enable caching for mistral-large', () => {
    const p = mk('mistral-large-latest');
    expect((p as unknown as { supportsPromptCaching: () => boolean }).supportsPromptCaching()).toBe(false);
  });

  it('does NOT enable caching for magistral or ministral', () => {
    expect((mk('magistral-medium-latest') as unknown as { supportsPromptCaching: () => boolean }).supportsPromptCaching()).toBe(false);
    expect((mk('ministral-8b-latest') as unknown as { supportsPromptCaching: () => boolean }).supportsPromptCaching()).toBe(false);
  });
});

describe('Mistral cache-key — stability + scoping', () => {
  type WithKey = { computeCacheKey: (req: { system?: string; tools?: unknown[] }) => string | undefined };
  const p = mk('mistral-medium-3-5') as unknown as WithKey;

  it('returns same key for identical system+tools', () => {
    const a = p.computeCacheKey({ system: 'You are Alfred', tools: [{ name: 'reminder' }] });
    const b = p.computeCacheKey({ system: 'You are Alfred', tools: [{ name: 'reminder' }] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('returns different key when system changes', () => {
    const a = p.computeCacheKey({ system: 'A', tools: [] });
    const b = p.computeCacheKey({ system: 'B', tools: [] });
    expect(a).not.toBe(b);
  });

  it('returns different key when tools change', () => {
    const a = p.computeCacheKey({ system: 'Same', tools: [{ name: 'x' }] });
    const b = p.computeCacheKey({ system: 'Same', tools: [{ name: 'y' }] });
    expect(a).not.toBe(b);
  });

  it('returns undefined when nothing cacheable is present', () => {
    expect(p.computeCacheKey({})).toBeUndefined();
    expect(p.computeCacheKey({ system: '', tools: [] })).toBeUndefined();
  });
});

describe('Mistral extraRequestParams hook', () => {
  type WithExtras = { extraRequestParams: (req: { system?: string; tools?: unknown[] }) => Record<string, unknown> };
  it('emits prompt_cache_key for 3.5 with substantive prompt', () => {
    const p = mk('mistral-medium-3-5') as unknown as WithExtras;
    const out = p.extraRequestParams({ system: 'sys', tools: [{ name: 'x' }] });
    expect(out.prompt_cache_key).toMatch(/^[0-9a-f]{32}$/);
  });

  it('emits empty object for non-3.5 models', () => {
    const p = mk('mistral-small-latest') as unknown as WithExtras;
    const out = p.extraRequestParams({ system: 'sys', tools: [] });
    expect(out).toEqual({});
  });

  it('emits empty object even for 3.5 when system+tools are empty', () => {
    const p = mk('mistral-medium-3-5') as unknown as WithExtras;
    const out = p.extraRequestParams({});
    expect(out).toEqual({});
  });
});
