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
    expect(istSitzungsPfad('/api/geraete/dateien')).toBe(true); // v1249
    expect(istSitzungsPfad('/api/geraete/dateien/abc?offset=0')).toBe(true);
    expect(istSitzungsPfad('/api/geraete/dateien/abc/fertig')).toBe(true);
    expect(istSitzungsPfad('/api/geraete/update')).toBe(true); // v1258
    expect(istSitzungsPfad('/api/geraete/update/datei')).toBe(true);
    expect(istSitzungsPfad('/api/vorgaenge?limit=20')).toBe(true); // v1313
    expect(istSitzungsPfad('/api/geraete/verlauf?limit=30')).toBe(true); // v1314
    expect(istSitzungsPfad('/api/app/update?plattform=windows')).toBe(true); // v1322
    expect(istSitzungsPfad('/api/app/update/datei?plattform=macos')).toBe(true);
    expect(istSitzungsPfad('/api/conversations')).toBe(false);
    expect(istSitzungsPfad('/api/vorgaenge/abc/entscheidung')).toBe(false);
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
