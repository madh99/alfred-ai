import { describe, it, expect, vi, afterEach } from 'vitest';
import { WillhabenProvider } from './willhaben-provider.js';

// v1477 — Realfall 16.10.: abgelaufenes Inserat 1450404520 leitet mit 200 auf die Suche um (…?fromExpiredAdId=1450404520)
const antwort = (url: string, pageProps: unknown) => ({
  ok: true, status: 200, url,
  text: async () => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps } })}</script></html>`,
});

describe('v1477 willhaben: abgelaufenes Inserat ist ein Status, kein Fehler', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('Weiterleitung mit fromExpiredAdId → „nicht mehr abrufbar“', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => antwort('https://www.willhaben.at/iad/kaufen-und-verkaufen/marktplatz/computer-tablets/pcs-5833?fromExpiredAdId=1450404520', { searchResult: {}, fromExpiredAdId: '1450404520' })));
    const d = await new WillhabenProvider().getDetail('1450404520');
    expect(d.status).toBe('nicht mehr abrufbar');
    expect(d.statusGrund).toContain('abgelaufen');
  });

  it('fromExpiredAdId nur in den Seitendaten reicht ebenfalls; unbekannte Seite bleibt ein Fehler', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => antwort('https://www.willhaben.at/iad/x', { fromExpiredAdId: '1' })));
    expect((await new WillhabenProvider().getDetail('1')).status).toBe('nicht mehr abrufbar');
    vi.stubGlobal('fetch', vi.fn(async () => antwort('https://www.willhaben.at/iad/y', { etwasAnderes: true })));
    await expect(new WillhabenProvider().getDetail('2')).rejects.toThrow('advertDetails not found');
  });
});
