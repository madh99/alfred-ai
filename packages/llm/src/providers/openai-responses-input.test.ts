import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from './openai.js';

/** v1269 — Kontinuität (previousResponseId): Tool-Ergebnisse UND Nutzer-Inhalte (Bild aus dem Werkzeug) der letzten Nachricht. */
describe('OpenAIProvider.buildResponsesParams (Kontinuität)', () => {
  const provider = new OpenAIProvider({ provider: 'openai', apiKey: 'test', model: 'gpt-test' } as never);
  const build = (req: unknown) => (provider as unknown as { buildResponsesParams: (r: unknown) => Record<string, unknown> }).buildResponsesParams(req);

  it('schickt Tool-Ergebnis und Bildblock derselben Nachricht mit previous_response_id', () => {
    const params = build({
      messages: [
        { role: 'user', content: 'Was ist auf meinem Bildschirm?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'geraet_pc', input: { action: 'bildschirm' } }] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'Bildschirmfoto' },
          { type: 'text', text: 'Bild aus den Werkzeugergebnissen:' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
        ] },
      ],
      previousResponseId: 'resp_1',
    });
    const input = params.input as Array<Record<string, unknown>>;
    expect(params.previous_response_id).toBe('resp_1');
    expect(input.map(i => i.type ?? i.role)).toEqual(['function_call_output', 'user']);
    const user = input[1] as { content: Array<{ type: string; image_url?: string }> };
    expect(user.content.map(c => c.type)).toEqual(['input_text', 'input_image']);
    expect(user.content[1]?.image_url).toBe('data:image/jpeg;base64,AAAA');
  });

  it('ohne Bild nur die Tool-Ergebnisse', () => {
    const params = build({
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 't', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
      ],
      previousResponseId: 'resp_1',
    });
    expect((params.input as Array<Record<string, unknown>>).map(i => i.type)).toEqual(['function_call_output']);
  });
});
