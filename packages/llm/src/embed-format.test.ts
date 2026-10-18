import { describe, it, expect, vi } from 'vitest';
import { OpenAIProvider } from './providers/openai.js';
import { MistralProvider } from './providers/mistral.js';

/**
 * v1495 — Embeddings ausdrücklich als Zahlen-Array anfordern. Ohne encoding_format fordert das openai-SDK base64 an
 * und dekodiert die Antwort; Mistral liefert trotzdem ein Array → das SDK machte daraus 256 Nullen (Realfall 18.10.:
 * alle 4 360 gespeicherten Embeddings seit 30.03. waren Nullvektoren, die semantische Suche lieferte Zufall).
 */
function mitClient<T extends OpenAIProvider>(p: T, embedding: unknown) {
  const create = vi.fn().mockResolvedValue({ data: [{ embedding }], usage: { total_tokens: 3 } });
  (p as unknown as { client: unknown }).client = { embeddings: { create } };
  return create;
}

describe('v1495 Embedding-Format', () => {
  it('Mistral fordert float an und gibt das Array unverändert weiter', async () => {
    const p = new MistralProvider({ provider: 'mistral', model: 'mistral-embed', apiKey: 'x' } as never);
    const create = mitClient(p, [0.1, -0.2, 0.3]);
    const r = await p.embed('Stromrechnung');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'mistral-embed', encoding_format: 'float' }));
    expect(r?.embedding).toEqual([0.1, -0.2, 0.3]);
    expect(r?.dimensions).toBe(3);
  });

  it('OpenAI ebenso; eine Antwort ohne Array gilt als Ausfall', async () => {
    const p = new OpenAIProvider({ provider: 'openai', model: 'text-embedding-3-small', apiKey: 'x' } as never);
    const create = mitClient(p, 'AAAA');
    expect(await p.embed('x')).toBeUndefined();
    expect(create.mock.calls[0][0].encoding_format).toBe('float');
  });
});
