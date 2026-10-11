import { describe, it, expect } from 'vitest';
import { istSitzungsPfad, zerlegeSitzungsChat, sitzungsChat, sitzungsChatErlaubt, istFaden } from '../sitzung-pfade.js';

// v1328 — Gesprächsfäden: nur die eigene Sitzung, Faden aus [a-z0-9-]{1,40}
describe('Sitzungs-Chats (v1328)', () => {
  it('zerlegt Hauptgespräch und Faden', () => {
    expect(zerlegeSitzungsChat('sitzung:abc')).toEqual({ geraetId: 'abc' });
    expect(zerlegeSitzungsChat('sitzung:abc:f-1')).toEqual({ geraetId: 'abc', faden: 'f-1' });
    expect(zerlegeSitzungsChat('sitzung:abc:F 1')).toBeUndefined();
    expect(zerlegeSitzungsChat('sitzung:')).toBeUndefined();
    expect(zerlegeSitzungsChat('api-chat-1')).toBeUndefined();
    expect(sitzungsChat('abc')).toBe('sitzung:abc');
    expect(sitzungsChat('abc', 'xyz')).toBe('sitzung:abc:xyz');
    expect(sitzungsChat('abc', 'nicht ok')).toBe('sitzung:abc');
    expect(istFaden('m1x2')).toBe(true); expect(istFaden('')).toBe(false); expect(istFaden(null)).toBe(false);
  });
  it('erlaubt einem Gerätetoken nur Chats seiner Sitzung (Sicherheitsbefund 09.10.)', () => {
    expect(sitzungsChatErlaubt('sitzung:abc', 'abc')).toBe(true);
    expect(sitzungsChatErlaubt('sitzung:abc:t1', 'abc')).toBe(true);
    expect(sitzungsChatErlaubt('sitzung:def', 'abc')).toBe(false);
    expect(sitzungsChatErlaubt('sitzung:abc:', 'abc')).toBe(false);
    expect(sitzungsChatErlaubt('5060785419', 'abc')).toBe(false);
    expect(istSitzungsPfad('/api/geraete/faeden')).toBe(true);
    expect(istSitzungsPfad('/api/geraete/faeden/m1x2')).toBe(true);
    expect(istSitzungsPfad('/api/geraete/faeden/../x')).toBe(false);
  });
});

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
    // v1349 — Anhang-Abruf (v1347) nur mit gültiger Kennung
    expect(istSitzungsPfad('/api/geraete/anhang/'+'a'.repeat(32))).toBe(true);
    expect(istSitzungsPfad('/api/geraete/anhang/../config')).toBe(false);
    // v1350 — Suche und Anhang-Übersicht
    expect(istSitzungsPfad('/api/geraete/suche?q=rechnung')).toBe(true);
    expect(istSitzungsPfad('/api/geraete/anhaenge?limit=50')).toBe(true);
    expect(istSitzungsPfad('/api/geraete/suche/x')).toBe(false);
    expect(istSitzungsPfad('/api/geraete/meldung')).toBe(true); // v1351
    expect(istSitzungsPfad('/api/geraete/abbrechen')).toBe(true); // v1352
    // v1353 — native Ansichten der App
    expect(istSitzungsPfad('/api/geraete/aufgaben')).toBe(true);
    expect(istSitzungsPfad('/api/geraete/aufgaben/0b6c2f1e-1111-4a2b-9c3d-123456789abc')).toBe(true);
    expect(istSitzungsPfad('/api/geraete/erinnerungen/abc-1')).toBe(true);
    expect(istSitzungsPfad('/api/geraete/gedaechtnis?typ=fact&q=linz')).toBe(true);
    expect(istSitzungsPfad('/api/geraete/vorgaenge/v-1')).toBe(true);
    expect(istSitzungsPfad('/api/geraete/befunde')).toBe(true); // v1359 Ansicht „Befunde"
    expect(istSitzungsPfad('/api/geraete/gedaechtnis/../config')).toBe(false);
    expect(istSitzungsPfad('/api/geraete/aufgaben/a/b')).toBe(false);
    expect(istSitzungsPfad('/api/todos')).toBe(false); // Web-Routen bleiben dem API-Token vorbehalten
    expect(istSitzungsPfad('/api/memories')).toBe(false);
  });
});
