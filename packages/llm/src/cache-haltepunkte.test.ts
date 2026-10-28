import { describe, it, expect, afterEach } from 'vitest';
import { cacheTeile, entwicklerNachricht, markiereLetzteNachricht, haltepunkteAktiv } from './cache-haltepunkte.js';
import { OpenAIProvider } from './providers/openai.js';

// v1704 (K1c) — ausdrückliche Cache-Haltepunkte: fester Teil | Werkzeugliste | wechselnder Teil
const SYSTEM = 'Du bist Alfred.\n\n## Core principles\nA\n\n## Available tools\n- x\n\n## Known skill-failure patterns\nf\n\n## Weltmodell (automatisch erhoben)\nw\n\n## Current date & time\n10:00';

describe('K1c Haltepunkte', () => {
  afterEach(() => { delete process.env.ALFRED_OPENAI_CACHE_HALTEPUNKTE; });
  it('teilt vor „Available tools“ und vor dem ersten wechselnden Abschnitt; Haltepunkte nur an den festen Teilen', () => {
    const t = cacheTeile(SYSTEM);
    expect(t).toHaveLength(3);
    expect(t[0]!.endsWith('## Core principles\nA')).toBe(true);
    expect(t[1]!.startsWith('\n\n## Available tools')).toBe(true);
    expect(t[2]!.startsWith('\n\n## Known skill-failure patterns')).toBe(true);
    expect(t.join('')).toBe(SYSTEM); // Inhalt unverändert
    const d = entwicklerNachricht(SYSTEM) as { role: string; content: Array<Record<string, unknown>> };
    expect(d.role).toBe('developer');
    expect(d.content.map(c => 'prompt_cache_breakpoint' in c)).toEqual([true, true, false]);
    expect(cacheTeile('nur fest')).toEqual(['nur fest']);
    expect((entwicklerNachricht('nur fest') as { content: Array<Record<string, unknown>> }).content[0]).toHaveProperty('prompt_cache_breakpoint');
  });
  it('Haltepunkt am Ende der letzten Nutzernachricht, Original unverändert', () => {
    const items = [{ role: 'user', content: 'alt' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'neu' }];
    const m = markiereLetzteNachricht(items);
    expect(m[2]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'neu', prompt_cache_breakpoint: { mode: 'explicit' } }] });
    expect(m[0]).toEqual({ role: 'user', content: 'alt' });
    expect(items[2]!.content).toBe('neu');
  });
  it('nur für GPT-5.6 und neuer, abschaltbar', () => {
    expect(haltepunkteAktiv('gpt-6.1-sol')).toBe(true);
    expect(haltepunkteAktiv('gpt-5.6-sol')).toBe(true);
    expect(haltepunkteAktiv('gpt-5.5')).toBe(false);
    expect(haltepunkteAktiv('gpt-6.1-sol', { ALFRED_OPENAI_CACHE_HALTEPUNKTE: 'aus' })).toBe(false);
  });
  it('Provider: erste Runde mit Entwickler-Nachricht, Folgerunde derselben Kette ohne instructions; fremde Kette wie bisher', () => {
    const p = new OpenAIProvider({ provider: 'openai', apiKey: 'test', model: 'gpt-6.1-sol' } as never);
    const intern = p as unknown as { buildResponsesParams: (r: unknown) => Record<string, unknown>; merkeK1c: (pa: Record<string, unknown>, r: unknown, id: string) => void };
    const erste = { system: SYSTEM, gespraech: 'owner:faden:x', messages: [{ role: 'user', content: 'Frage' }] };
    const p1 = intern.buildResponsesParams(erste);
    expect(p1.instructions).toBeUndefined();
    expect((p1.input as Array<{ role?: string }>)[0]!.role).toBe('developer');
    intern.merkeK1c(p1, erste, 'resp_1');
    const folge = { system: SYSTEM, previousResponseId: 'resp_1', messages: [{ role: 'user', content: 'Frage' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }] };
    const p2 = intern.buildResponsesParams(folge);
    expect(p2.instructions).toBeUndefined();
    expect(p2.previous_response_id).toBe('resp_1');
    expect((p2.input as Array<{ role?: string }>).some(i => i.role === 'developer')).toBe(false);
    expect(p2.prompt_cache_options).toBeUndefined();
    const fremd = intern.buildResponsesParams({ ...folge, previousResponseId: 'resp_unbekannt' });
    expect(fremd.instructions).toBe(SYSTEM); // Kette vor dem Update/Neustart: wie bisher
    process.env.ALFRED_OPENAI_CACHE_HALTEPUNKTE = 'aus';
    expect(intern.buildResponsesParams(erste).instructions).toBe(SYSTEM);
  });
});

describe('K1c nur in Gesprächen', () => {
  it('ohne Gesprächsschlüssel (Hintergrund) bleibt alles wie bisher', () => {
    const p = new OpenAIProvider({ provider: 'openai', apiKey: 'test', model: 'gpt-6.1-sol' } as never);
    const r = (p as unknown as { buildResponsesParams: (r: unknown) => Record<string, unknown> }).buildResponsesParams({ system: 'S', messages: [{ role: 'user', content: 'x' }] });
    expect(r.instructions).toBe('S');
    expect(r.prompt_cache_options).toBeUndefined();
  });
});
