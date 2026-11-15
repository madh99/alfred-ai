import { describe, it, expect } from 'vitest';
import { pruefeBetriebParameter } from './betrieb-parameter.js';

describe('pruefeBetriebParameter', () => {
  it('leere Asset-Liste: „mindestens ein Asset“', () => {
    expect(pruefeBetriebParameter({ assets: [] })).toContain('mindestens ein Asset');
  });
  it('41 Assets: „höchstens 40“', () => {
    expect(pruefeBetriebParameter({ assets: Array.from({ length: 41 }, (_, i) => `a${i}`) })).toContain('höchstens 40');
  });
  it('40 Assets sind erlaubt', () => {
    const r = pruefeBetriebParameter({ assets: Array.from({ length: 40 }, (_, i) => `a${i}`) });
    expect(typeof r).toBe('object');
  });
  it('unbekannte Schlüssel werden abgewiesen', () => {
    expect(pruefeBetriebParameter({ assets: ['a'], foo: 1 })).toContain('foo');
  });
  it('kein Objekt oder Liste: Fehler', () => {
    expect(typeof pruefeBetriebParameter(null)).toBe('string');
    expect(typeof pruefeBetriebParameter([])).toBe('string');
  });
  it('doppelte Assets und leere Einträge werden abgewiesen', () => {
    expect(pruefeBetriebParameter({ assets: ['a', 'a'] })).toContain('doppelt');
    expect(typeof pruefeBetriebParameter({ assets: [' '] })).toBe('string');
    expect(typeof pruefeBetriebParameter({ assets: [5] })).toBe('string');
  });
  it('jobs und standardVorlagen: nur einfache Schlüssel, ohne Doppelte', () => {
    expect(pruefeBetriebParameter({ assets: ['a'], jobs: ['pki betrieb'] })).toContain('jobs');
    expect(pruefeBetriebParameter({ assets: ['a'], standardVorlagen: ['k', 'k'] })).toContain('doppelt');
    expect(pruefeBetriebParameter({ assets: ['a'], jobs: 'x' })).toContain('Liste');
  });
  it('gültige Eingabe wird unverändert übernommen', () => {
    expect(pruefeBetriebParameter({ assets: ['a', 'b'], vorhabenId: 'v1', architekturDocId: 'd1', jobs: ['pki-betrieb'], standardVorlagen: ['k'], restoreChangeId: 'c1' }))
      .toEqual({ assets: ['a', 'b'], vorhabenId: 'v1', architekturDocId: 'd1', jobs: ['pki-betrieb'], standardVorlagen: ['k'], restoreChangeId: 'c1' });
  });
  it('ungültige ID-Felder werden abgewiesen', () => {
    expect(pruefeBetriebParameter({ assets: ['a'], vorhabenId: 5 })).toContain('vorhabenId');
    expect(pruefeBetriebParameter({ assets: ['a'], restoreChangeId: '' })).toContain('restoreChangeId');
  });
});
