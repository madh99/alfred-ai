import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { markiereVerlaufFuerCache } from './anthropic.js';
import { OpenAIProvider } from './openai.js';

/** v1355 — Prompt-Caching für alle Anbieter, wo möglich (Punkt 8 Schritt 3, Owner-Freigabe 11.10.). */
describe('Anthropic: Verlauf im Cache nur in Werkzeug-Schleifen', () => {
  const schleife: Anthropic.MessageParam[] = [
    { role: 'user', content: 'Welche Lichter waren lange an?' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'homeassistant', input: { action: 'history' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'viele Zeilen' }, { type: 'text', text: 'Hinweis' }] },
  ];

  it('markiert den letzten Block der letzten Nachricht, wenn sie Werkzeugergebnisse enthält; Eingabe bleibt unverändert', () => {
    const aus = markiereVerlaufFuerCache(schleife);
    const letzte = aus[2]!.content as unknown as Array<Record<string, unknown>>;
    expect(letzte[1]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(letzte[0]!.cache_control).toBeUndefined();
    expect((schleife[2]!.content as unknown as Array<Record<string, unknown>>)[1]!.cache_control).toBeUndefined();
    expect(aus.filter(m => typeof m.content !== 'string' && m.content.some(b => 'cache_control' in b))).toHaveLength(1);
  });

  it('Einzelanfrage oder Text-Nachricht: keine Marke (Cache-Schreiben kostet 25 % Aufschlag)', () => {
    const einzel: Anthropic.MessageParam[] = [{ role: 'user', content: 'Wie spät ist es?' }];
    expect(markiereVerlaufFuerCache(einzel)).toBe(einzel);
    const ohneWerkzeug: Anthropic.MessageParam[] = [{ role: 'user', content: [{ type: 'text', text: 'Hallo' }] }];
    expect(markiereVerlaufFuerCache(ohneWerkzeug)).toBe(ohneWerkzeug);
    expect(markiereVerlaufFuerCache([])).toEqual([]);
  });
});

describe('OpenAI: prompt_cache_key nur beim echten Endpunkt', () => {
  // v1703 — Standard ist jetzt „aus“ (Test nach OpenAI-Empfehlung); diese Fälle prüfen die Modi gespraech/inhalt
  beforeEach(() => { process.env.ALFRED_OPENAI_CACHE_KEY = 'gespraech'; });
  afterEach(() => { delete process.env.ALFRED_OPENAI_CACHE_KEY; });
  const anfrage = { system: 'Du bist Alfred.', tools: [{ name: 'reminder', description: 'x', inputSchema: {} }], messages: [{ role: 'user', content: 'Hallo' }] };
  const params = (p: OpenAIProvider) => (p as unknown as { buildResponsesParams: (r: unknown) => Record<string, unknown> }).buildResponsesParams(anfrage);
  const extra = (p: OpenAIProvider, r: unknown = anfrage) => (p as unknown as { extraRequestParams: (r: unknown) => Record<string, unknown> }).extraRequestParams(r);

  it('Responses- und Chat-Weg schicken denselben stabilen Schlüssel', () => {
    const p = new OpenAIProvider({ provider: 'openai', apiKey: 'test', model: 'gpt-6.1-sol' } as never);
    const k = params(p).prompt_cache_key;
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(extra(p).prompt_cache_key).toBe(k);
    expect(params(new OpenAIProvider({ provider: 'openai', apiKey: 'test', model: 'gpt-6.1-sol', baseUrl: 'https://api.openai.com/v1' } as never)).prompt_cache_key).toBe(k);
  });

  it('anderer System-Prompt → anderer Schlüssel; ohne System und Werkzeuge kein Schlüssel', () => {
    const p = new OpenAIProvider({ provider: 'openai', apiKey: 'test', model: 'gpt-6.1-sol' } as never);
    expect(extra(p, { ...anfrage, system: 'Anders' }).prompt_cache_key).not.toBe(extra(p).prompt_cache_key);
    expect(extra(p, { messages: [] })).toEqual({});
  });

  it('v1694 (K1): mit Gespräch fester Schlüssel je Gespräch und Modell, unabhängig von System und Werkzeugen', () => {
    const p = new OpenAIProvider({ provider: 'openai', apiKey: 'test', model: 'gpt-6.1-sol' } as never);
    const k = extra(p, { ...anfrage, gespraech: 'owner:faden:infra' }).prompt_cache_key;
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(extra(p, { ...anfrage, system: 'Anders, mit neuer Uhrzeit', tools: [], gespraech: 'owner:faden:infra' }).prompt_cache_key).toBe(k);
    expect(extra(p, { ...anfrage, gespraech: 'owner:faden:anderer' }).prompt_cache_key).not.toBe(k);
    expect(k).not.toBe(extra(p).prompt_cache_key);
    const anderesModell = new OpenAIProvider({ provider: 'openai', apiKey: 'test', model: 'gpt-6.1' } as never);
    expect(extra(anderesModell, { ...anfrage, gespraech: 'owner:faden:infra' }).prompt_cache_key).not.toBe(k);
  });

  it('OpenAI-kompatible Fremd-Endpunkte bekommen nichts Unbekanntes', () => {
    const fremd = new OpenAIProvider({ provider: 'openai', apiKey: 'test', model: 'llama', baseUrl: 'http://192.168.1.50:8080/v1' } as never);
    expect(extra(fremd)).toEqual({});
    expect(params(fremd).prompt_cache_key).toBeUndefined();
  });
});

describe('v1703 Schalter ALFRED_OPENAI_CACHE_KEY', () => {
  it('Standard aus: kein prompt_cache_key; gespraech und inhalt wie bisher', async () => {
    const { openaiCacheKeyModus } = await import('./openai.js');
    expect(openaiCacheKeyModus({})).toBe('aus');
    expect(openaiCacheKeyModus({ ALFRED_OPENAI_CACHE_KEY: 'gespraech' })).toBe('gespraech');
    expect(openaiCacheKeyModus({ ALFRED_OPENAI_CACHE_KEY: 'Inhalt' })).toBe('inhalt');
    const p = new OpenAIProvider({ provider: 'openai', apiKey: 'test', model: 'gpt-6.1-sol' } as never);
    const r = (p as unknown as { buildResponsesParams: (r: unknown) => Record<string, unknown> }).buildResponsesParams({ system: 'S', messages: [{ role: 'user', content: 'x' }], gespraech: 'c' });
    expect(r.prompt_cache_key).toBeUndefined();
  });
});
