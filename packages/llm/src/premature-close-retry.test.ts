import { describe, it, expect } from 'vitest';
import { isPrematureCloseError, withPrematureCloseRetry } from './provider.js';

/**
 * v916 — node-fetch v2 (vom @anthropic-ai/sdk 0.39 genutzt) wirft bei transient
 * unterbrochenen gzip-Streams ERR_STREAM_PREMATURE_CLOSE / "Premature close".
 * Der Helper erkennt das und wiederholt; andere Fehler werden durchgereicht.
 */
describe('v916 isPrematureCloseError', () => {
  it('erkennt code ERR_STREAM_PREMATURE_CLOSE', () => {
    expect(isPrematureCloseError({ code: 'ERR_STREAM_PREMATURE_CLOSE' })).toBe(true);
  });
  it('erkennt die node-fetch-Message', () => {
    expect(isPrematureCloseError(new Error('Invalid response body while trying to fetch https://api.anthropic.com/v1/messages: Premature close'))).toBe(true);
  });
  it('erkennt code im cause', () => {
    expect(isPrematureCloseError({ message: 'fetch failed', cause: { code: 'ERR_STREAM_PREMATURE_CLOSE' } })).toBe(true);
  });
  it('ignoriert andere Fehler (401/Rate-Limit/Netz)', () => {
    expect(isPrematureCloseError(new Error('401 authentication_error'))).toBe(false);
    expect(isPrematureCloseError({ code: 'ECONNRESET', message: 'socket hang up' })).toBe(false);
    expect(isPrematureCloseError(undefined)).toBe(false);
  });
});

describe('v916 withPrematureCloseRetry', () => {
  it('gibt beim ersten Erfolg sofort zurück', async () => {
    let calls = 0;
    const r = await withPrematureCloseRetry(async () => { calls++; return 'ok'; });
    expect(r).toBe('ok');
    expect(calls).toBe(1);
  });

  it('wiederholt bei Premature close und kommt durch', async () => {
    let calls = 0;
    const r = await withPrematureCloseRetry(async () => {
      calls++;
      if (calls < 2) throw new Error('Premature close');
      return 'recovered';
    }, 3);
    expect(r).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('reicht Nicht-Premature-Fehler sofort durch (kein Retry)', async () => {
    let calls = 0;
    await expect(withPrematureCloseRetry(async () => { calls++; throw new Error('401 unauthorized'); }, 3))
      .rejects.toThrow('401');
    expect(calls).toBe(1);
  });

  it('wirft nach erschöpften Versuchen den letzten Premature-close-Fehler', async () => {
    let calls = 0;
    await expect(withPrematureCloseRetry(async () => { calls++; throw new Error('Premature close'); }, 3))
      .rejects.toThrow('Premature close');
    expect(calls).toBe(3);
  });
});
