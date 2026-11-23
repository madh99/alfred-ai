import { describe, it, expect, vi } from 'vitest';
import { AnthropicProvider } from './providers/anthropic.js';

/**
 * v1934 — Realfall 23.11.2026 (Change 29b2f140): Die ultra-Gegenprüfung (claude-fable-5-2, Thinking immer an)
 * verbrauchte alle 16.000 maxTokens im Thinking und lieferte leeren Text → „Antwort nicht lesbar“, keine Freigabefrage.
 * Ein höheres Limit verlangt im Anthropic-SDK ab ~21.333 Tokens Streaming (nicht-streamend > 10 min wirft das SDK).
 * Deshalb laufen lange complete()-Aufrufe intern über messages.stream().finalMessage().
 */
const nachricht = { id: 'm1', type: 'message', role: 'assistant', model: 'claude-fable-5-2', stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };

function provider() {
  const p = new AnthropicProvider({ provider: 'anthropic', model: 'claude-fable-5-2', apiKey: 'test-key' } as never);
  const create = vi.fn(async () => nachricht);
  const stream = vi.fn(() => ({ finalMessage: async () => nachricht }));
  (p as unknown as { client: unknown }).client = { messages: { create, stream } };
  return { p, create, stream };
}

describe('v1934 Anthropic — lange Antworten über Stream', () => {
  it('maxTokens 48.000 geht über messages.stream().finalMessage(), nicht über create', async () => {
    const { p, create, stream } = provider();
    const r = await p.complete({ messages: [{ role: 'user', content: 'Prüfe' }], maxTokens: 48_000 } as never);
    expect(r.content).toBe('ok');
    expect(stream).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect((stream.mock.calls[0] as unknown as [{ max_tokens: number }])[0].max_tokens).toBe(48_000);
  });
  it('kurze Anfragen bleiben bei messages.create', async () => {
    const { p, create, stream } = provider();
    await p.complete({ messages: [{ role: 'user', content: 'Hallo' }], maxTokens: 4_000 } as never);
    expect(create).toHaveBeenCalledTimes(1);
    expect(stream).not.toHaveBeenCalled();
  });
});
