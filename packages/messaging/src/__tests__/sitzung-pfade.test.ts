import { describe, it, expect } from 'vitest';
import { istSitzungsPfad } from '../sitzung-pfade.js';

// v1232 — Gerätetoken ist kein Generalschlüssel: nur Sitzungs-Routen.
describe('istSitzungsPfad', () => {
  it('erlaubt Chat, Bestätigungen, Lebenszeichen, Geräteliste', () => {
    expect(istSitzungsPfad('/api/message')).toBe(true);
    expect(istSitzungsPfad('/api/confirmations/pending?x=1')).toBe(true);
    expect(istSitzungsPfad('/api/confirmations/abc-123/approve')).toBe(true);
    expect(istSitzungsPfad('/api/confirmations/abc-123/reject')).toBe(true);
    expect(istSitzungsPfad('/api/lebenszeichen')).toBe(true);
    expect(istSitzungsPfad('/api/geraete')).toBe(true);
    expect(istSitzungsPfad('/api/transcribe')).toBe(true); // v1241
    expect(istSitzungsPfad('/api/sprich')).toBe(true);
  });
  it('sperrt alles andere', () => {
    expect(istSitzungsPfad('/api/geraete/abc')).toBe(false); // Widerruf
    expect(istSitzungsPfad('/api/geraete/pairing-code')).toBe(false);
    expect(istSitzungsPfad('/api/confirmations/abc/custom')).toBe(false);
    expect(istSitzungsPfad('/api/config')).toBe(false);
    expect(istSitzungsPfad('/api/messages')).toBe(false);
    expect(istSitzungsPfad(undefined)).toBe(false);
  });
});
