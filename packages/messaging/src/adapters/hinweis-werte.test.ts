import { describe, it, expect } from 'vitest';
import { hinweisWerte } from './http.js';

// v1696 — Owner 27.10.: Adresse zu einem Hinweis ließ sich in App/Web nicht eintragen; Werte kommen jetzt mit
describe('v1696 hinweisWerte', () => {
  it('nimmt Text- und Zahlenwerte mit gültigen Schlüsseln, kürzt lange Werte, ignoriert alles andere', () => {
    expect(hinweisWerte({ info: 'Johann-Böhm-Straße 1', jahr: 1919 })).toEqual({ info: 'Johann-Böhm-Straße 1', jahr: '1919' });
    expect(hinweisWerte({ 'böse schlüssel': 'x', obj: { a: 1 }, ok: 'y' })).toEqual({ ok: 'y' });
    expect(hinweisWerte({ lang: 'a'.repeat(5000) })!.lang).toHaveLength(2000);
    expect(hinweisWerte(undefined)).toBeUndefined();
    expect(hinweisWerte(['a'])).toBeUndefined();
    expect(hinweisWerte({})).toBeUndefined();
  });
});
