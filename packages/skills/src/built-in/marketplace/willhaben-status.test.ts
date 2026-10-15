import { describe, it, expect } from 'vitest';
import { willhabenStatusAus, willhabenStatusAusHtml, willhabenStatusZeile } from './willhaben-status.js';

// v1459 — Werte wie auf echten Seiten (15.10.: 789898944 verkauft, 2058030293 aktiv)
const seite = (ad: unknown) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { advertDetails: ad } } })}</script></html>`;

describe('v1459 willhaben-Status aus den Seitendaten', () => {
  it('verkauft, aktiv, reserviert; ohne Daten nichts', () => {
    expect(willhabenStatusAusHtml(seite({ advertStatus: { id: 'sold', description: 'verkauft', statusId: 120 }, deleteReason: 'SOLD_ON_WILLHABEN' }))).toEqual({ status: 'verkauft', id: 'sold', grund: 'SOLD_ON_WILLHABEN' });
    expect(willhabenStatusAusHtml(seite({ advertStatus: { id: 'active', description: 'aktiv', statusId: 50 }, deleteReason: null }))).toEqual({ status: 'aktiv', id: 'active' });
    expect(willhabenStatusAus({ advertStatus: { id: 'reserved', description: 'reserviert' } })?.status).toBe('reserviert');
    expect(willhabenStatusAus({ advertStatus: { id: 'neu', description: 'Sonderfall' } })?.status).toBe('Sonderfall');
    expect(willhabenStatusAusHtml('<html>keine Daten</html>')).toBeUndefined();
    expect(willhabenStatusAusHtml('<script id="__NEXT_DATA__">{kaputt</script>')).toBeUndefined();
    expect(willhabenStatusZeile({ status: 'verkauft', id: 'sold', grund: 'SOLD_ON_WILLHABEN' })).toBe('Status laut willhaben: verkauft (SOLD_ON_WILLHABEN)');
  });
});
