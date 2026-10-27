import { describe, it, expect, vi, afterEach } from 'vitest';
import { BMWSkill, BmwAnmeldungAbgelaufen } from './bmw.js';

// v1700 — Realfall 23.–27.10.: BMW antwortete 400 invalid_request auf den Refresh, Alfred meldete „Netzwerk“
describe('v1700 BMW Token-Refresh', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  const refresh = (s: BMWSkill) => (s as unknown as { refreshAccessToken: (t: unknown) => Promise<string> }).refreshAccessToken({ accessToken: 'a', refreshToken: 'r'.repeat(27), expiresAt: 0 });

  it('400 vom Token-Endpunkt = Anmeldung abgelaufen (kein Netzwerkfehler, kein zweiter Versuch)', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{"error":"invalid_request"}', { status: 400 }));
    vi.stubGlobal('fetch', f);
    const s = new BMWSkill({ clientId: 'c' } as never);
    const e = await refresh(s).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BmwAnmeldungAbgelaufen);
    expect((e as Error).message).toContain('BMW-Anmeldung abgelaufen');
    expect((e as Error).message).toContain('authorize');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('echter Netzwerkfehler bleibt Netzwerk (ein Wiederholungsversuch)', async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', f);
    const s = new BMWSkill({ clientId: 'c' } as never);
    const p = refresh(s).catch((x: unknown) => x);
    await vi.advanceTimersByTimeAsync(3_500);
    const e = await p;
    expect((e as Error).message).toContain('(Netzwerk)');
    expect(f).toHaveBeenCalledTimes(2);
  });
});
