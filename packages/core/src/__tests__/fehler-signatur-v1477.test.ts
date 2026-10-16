import { describe, it, expect } from 'vitest';
import { MessagePipeline } from '../message-pipeline.js';

// v1477 — Abbruchsperre: nur derselbe Aufruf mit denselben Eingaben gilt als „gleicher Fehler“
const sig = (blocks: unknown[], calls: unknown[]) =>
  (MessagePipeline.prototype as unknown as { buildErrorSignature: (b: unknown[], c: unknown[]) => string }).buildErrorSignature.call({}, blocks, calls);
const fehler = (id: string) => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: 'willhaben detail: advertDetails not found in page data' });

describe('v1477 Fehler-Signatur', () => {
  it('zwei verschiedene Inserate mit gleicher Meldung sind verschiedene Signaturen (Realfall 16.10.)', () => {
    const a = sig([fehler('t1')], [{ id: 't1', name: 'marketplace', input: { action: 'detail', listing_id: '1450404520' } }]);
    const b = sig([fehler('t2')], [{ id: 't2', name: 'marketplace', input: { action: 'detail', listing_id: '2045162438' } }]);
    expect(a).not.toBe(b);
  });

  it('derselbe Aufruf zweimal ergibt dieselbe Signatur; ohne Fehler leer', () => {
    const c = { name: 'marketplace', input: { action: 'detail', listing_id: '1450404520' } };
    expect(sig([fehler('x')], [{ id: 'x', ...c }])).toBe(sig([fehler('y')], [{ id: 'y', ...c }]));
    expect(sig([{ type: 'tool_result', tool_use_id: 'z', is_error: false, content: 'ok' }], [])).toBe('');
  });
});
