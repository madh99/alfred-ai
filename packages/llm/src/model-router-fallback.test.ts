import { describe, it, expect, vi } from 'vitest';
import { ModelRouter } from './model-router.js';
import type { LLMProvider } from './provider.js';
import type { LLMResponse, MultiModelConfig } from '@alfred/types';

/**
 * v868 — Billing-Fehler (Guthaben/Quota) lösen den Tier-Fallback aus.
 * Vorfall 11.06.: Anthropic "credit balance is too low" (400) → sofortiger
 * throw, der vorhandene Fallback auf OpenAI wurde nie erreicht — Insight/
 * Reasoning/Summarizer fielen still aus.
 */

const CREDIT_ERROR = new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}');

function mockProvider(behavior: 'ok' | 'billing' | 'overloaded', label: string): LLMProvider {
  return {
    async initialize() { /* noop */ },
    async complete(): Promise<LLMResponse> {
      if (behavior === 'billing') throw CREDIT_ERROR;
      if (behavior === 'overloaded') throw new Error('529 overloaded_error');
      return { content: `antwort-von-${label}`, model: label, usage: { inputTokens: 1, outputTokens: 1 } } as LLMResponse;
    },
    async *stream() {
      if (behavior !== 'ok') throw behavior === 'billing' ? CREDIT_ERROR : new Error('529 overloaded');
      yield { type: 'text', text: `stream-${label}` };
    },
    async embed() { return undefined; },
    supportsEmbeddings() { return false; },
    isAvailable() { return true; },
    getContextWindow() { return { total: 100000, maxOutput: 4096 }; },
  } as unknown as LLMProvider;
}

/** Router mit injizierten Providern (initialize() würde echte Provider bauen). */
function buildRouter(tiers: Record<string, LLMProvider>, config?: Partial<MultiModelConfig>): ModelRouter {
  const cfg = {
    default: { provider: 'openai', model: 'gpt-test' },
    fast: { provider: 'anthropic', model: 'haiku-test' },
    ...config,
  } as MultiModelConfig;
  const router = new ModelRouter(cfg);
  const providersMap = (router as unknown as { providers: Map<string, LLMProvider> }).providers;
  for (const [tier, p] of Object.entries(tiers)) providersMap.set(tier, p);
  return router;
}

describe('v868 ModelRouter Billing-Fallback', () => {
  it('Vorfalls-Szenario: fast (Anthropic, Guthaben leer) → Fallback auf default (OpenAI)', async () => {
    const router = buildRouter({
      fast: mockProvider('billing', 'haiku'),
      default: mockProvider('ok', 'gpt'),
    });
    const res = await router.complete({ messages: [{ role: 'user', content: 'hi' }], tier: 'fast' });
    expect(res.content).toBe('antwort-von-gpt');
  });

  it('fallback-Tier (Mistral) springt ein wenn default UND fast billing-tot sind', async () => {
    const router = buildRouter({
      fast: mockProvider('billing', 'haiku'),
      default: mockProvider('billing', 'gpt'),
      fallback: mockProvider('ok', 'mistral'),
    }, { fallback: { provider: 'mistral', model: 'mistral-test' } } as Partial<MultiModelConfig>);
    const res = await router.complete({ messages: [{ role: 'user', content: 'hi' }], tier: 'fast' });
    expect(res.content).toBe('antwort-von-mistral');
  });

  it('fallback-Tier wird NIE regulär geroutet (tier: fallback → default)', async () => {
    const router = buildRouter({
      default: mockProvider('ok', 'gpt'),
      fallback: mockProvider('ok', 'mistral'),
    });
    const res = await router.complete({ messages: [{ role: 'user', content: 'hi' }], tier: 'fallback' as never });
    expect(res.content).toBe('antwort-von-gpt');
  });

  it('non-billing 4xx (z.B. echte invalid request ohne Guthaben-Bezug) wirft weiterhin sofort', async () => {
    const badRequest: LLMProvider = {
      ...mockProvider('ok', 'x'),
      async complete() { throw new Error('400 invalid_request_error: max_tokens exceeds model limit'); },
    } as unknown as LLMProvider;
    const router = buildRouter({ default: badRequest, fast: mockProvider('ok', 'haiku') });
    await expect(router.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow('max_tokens');
  });

  it('Billing-Alert-Callback feuert mit Dedupe (1× pro Tier in 6h)', async () => {
    const alerts: Array<{ tier: string; provider: string }> = [];
    const router = buildRouter({
      fast: mockProvider('billing', 'haiku'),
      default: mockProvider('ok', 'gpt'),
    });
    router.setBillingAlertCallback((info) => alerts.push({ tier: info.tier, provider: info.provider }));
    await router.complete({ messages: [{ role: 'user', content: 'a' }], tier: 'fast' });
    await router.complete({ messages: [{ role: 'user', content: 'b' }], tier: 'fast' });
    expect(alerts.length).toBe(1); // dedupe — zweiter Fehler im 6h-Fenster alarmiert nicht erneut
    expect(alerts[0]).toEqual({ tier: 'fast', provider: 'anthropic' });
  });

  it('529/overloaded fällt weiterhin zurück (bestehendes Verhalten unverändert)', async () => {
    const router = buildRouter({
      fast: mockProvider('overloaded', 'haiku'),
      default: mockProvider('ok', 'gpt'),
    });
    const res = await router.complete({ messages: [{ role: 'user', content: 'hi' }], tier: 'fast' });
    expect(res.content).toBe('antwort-von-gpt');
  });

  it('insufficient_quota (OpenAI-Wortlaut) wird als Billing erkannt', async () => {
    const quota: LLMProvider = {
      ...mockProvider('ok', 'x'),
      async complete() { throw new Error('429 You exceeded your current quota, please check your plan and billing details (insufficient_quota)'); },
    } as unknown as LLMProvider;
    const router = buildRouter({ default: quota, fast: mockProvider('ok', 'haiku') });
    const res = await router.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('antwort-von-haiku');
  });
});
