import { describe, it, expect, vi } from 'vitest';
import { ModelRouter, type PulsEreignis } from './model-router.js';
import type { LLMProvider } from './provider.js';
import type { LLMResponse, MultiModelConfig } from '@alfred/types';

/**
 * v1162 — Jarvis Schicht 0: Der Router meldet jeden Erfolg/Fehler je Tier an
 * den Provider-Puls und kann einen Tier OHNE Fallback-Kette proben.
 */
const CREDIT_ERROR = new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}');

function mockProvider(behavior: 'ok' | 'billing' | 'auth' | 'netz', label: string): LLMProvider {
  const fail = () => {
    if (behavior === 'billing') throw CREDIT_ERROR;
    if (behavior === 'auth') throw Object.assign(new Error('401 invalid x-api-key'), { status: 401 });
    throw new Error('getaddrinfo EAI_AGAIN api.example.com');
  };
  return {
    async initialize() { /* noop */ },
    async complete(): Promise<LLMResponse> {
      if (behavior !== 'ok') fail();
      return { content: `antwort-von-${label}`, model: label, usage: { inputTokens: 1, outputTokens: 1 } } as LLMResponse;
    },
    async *stream() { if (behavior !== 'ok') fail(); yield { type: 'text', text: `stream-${label}` }; },
    async embed() { return undefined; },
    supportsEmbeddings() { return false; },
    isAvailable() { return true; },
    getContextWindow() { return { total: 100000, maxOutput: 4096 }; },
  } as unknown as LLMProvider;
}

function buildRouter(tiers: Record<string, LLMProvider>): { router: ModelRouter; puls: PulsEreignis[] } {
  const cfg = {
    default: { provider: 'anthropic', model: 'claude-test' },
    fallback: { provider: 'mistral', model: 'mistral-test' },
  } as MultiModelConfig;
  const router = new ModelRouter(cfg);
  const providersMap = (router as unknown as { providers: Map<string, LLMProvider> }).providers;
  for (const [tier, p] of Object.entries(tiers)) providersMap.set(tier, p);
  const puls: PulsEreignis[] = [];
  router.setPulsCallback(ev => puls.push(ev));
  return { router, puls };
}

describe('v1162 Provider-Puls-Hooks im ModelRouter', () => {
  it('Realfall: default (Guthaben leer) → Fehler-Puls billing + Erfolg-Puls fallback', async () => {
    const { router, puls } = buildRouter({ default: mockProvider('billing', 'claude'), fallback: mockProvider('ok', 'mistral') });
    const res = await router.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('antwort-von-mistral');
    expect(puls).toEqual([
      { art: 'fehler', tier: 'default', provider: 'anthropic', model: 'claude-test', klasse: 'billing', fehler: expect.stringContaining('credit balance') },
      { art: 'erfolg', tier: 'fallback', provider: 'mistral', model: 'mistral-test' },
    ]);
  });

  it('Stream-Pfad meldet ebenfalls', async () => {
    const { router, puls } = buildRouter({ default: mockProvider('netz', 'claude'), fallback: mockProvider('ok', 'mistral') });
    const chunks: string[] = [];
    for await (const ev of router.stream({ messages: [{ role: 'user', content: 'hi' }] })) chunks.push((ev as { text: string }).text);
    expect(chunks).toEqual(['stream-mistral']);
    expect(puls.map(p => `${p.art}:${p.tier}:${p.klasse ?? ''}`)).toEqual(['fehler:default:netz', 'erfolg:fallback:']);
  });

  it('probeTier fragt den Tier DIREKT — der Fallback verdeckt den Ausfall nicht', async () => {
    const { router, puls } = buildRouter({ default: mockProvider('auth', 'claude'), fallback: mockProvider('ok', 'mistral') });
    const r = await router.probeTier('default');
    expect(r).toMatchObject({ tier: 'default', ok: false, klasse: 'auth', provider: 'anthropic' });
    const ok = await router.probeTier('fallback');
    expect(ok.ok).toBe(true);
    expect(puls.map(p => `${p.art}:${p.tier}`)).toEqual(['fehler:default', 'erfolg:fallback']);
    expect(router.konfigurierteTiers().sort()).toEqual(['default', 'fallback']);
  });

  it('klassifiziereFehler: billing / auth / rate / netz / modell / unbekannt', () => {
    const { router } = buildRouter({});
    expect(router.klassifiziereFehler(CREDIT_ERROR)).toBe('billing');
    // v1164 — Realfall OpenAI (provider_puls 05.10.): lief als „rate" durch
    expect(router.klassifiziereFehler(Object.assign(new Error('429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.'), { status: 429 }))).toBe('billing');
    expect(router.klassifiziereFehler(Object.assign(new Error('x'), { status: 401 }))).toBe('auth');
    expect(router.klassifiziereFehler(new Error('429 rate limit exceeded'))).toBe('rate');
    expect(router.klassifiziereFehler(new Error('fetch failed'))).toBe('netz');
    expect(router.klassifiziereFehler(new Error('404 model gpt-9 does not exist'))).toBe('modell');
    expect(router.klassifiziereFehler(new Error('irgendwas'))).toBe('unbekannt');
    // v1301 — Realfall 08.10.: Probe mit maxTokens 5 → 400 der Responses-API, lief als „unbekannt"
    expect(router.klassifiziereFehler(Object.assign(new Error("400 Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 5 instead."), { status: 400 }))).toBe('anfrage');
    expect(router.klassifiziereFehler(new Error('422 invalid_request: unsupported parameter temperature'))).toBe('anfrage');
  });

  it('ohne Puls-Callback ändert sich nichts (kein Fehler)', async () => {
    const cfg = { default: { provider: 'anthropic', model: 'claude-test' } } as MultiModelConfig;
    const router = new ModelRouter(cfg);
    (router as unknown as { providers: Map<string, LLMProvider> }).providers.set('default', mockProvider('ok', 'claude'));
    const res = await router.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('antwort-von-claude');
  });
});
