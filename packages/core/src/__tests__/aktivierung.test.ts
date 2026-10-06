import { describe, it, expect } from 'vitest';
import { pruefeAktivierung, abstand } from '../interaktion/aktivierung.js';

// v1252 — Aktivierungswort: tolerant, mit Gesprächsfenster und Stoppwort.
describe('pruefeAktivierung', () => {
  it('nimmt Äußerungen mit dem Wort, auch mit Transkriptionsfehlern und Füllwort', () => {
    expect(pruefeAktivierung('Alfred, was macht mein PC gerade?', 'Alfred', false)).toEqual({ art: 'nachricht', text: 'Was macht mein PC gerade?' });
    expect(pruefeAktivierung('Alfried wie ist die Lage', 'Alfred', false)).toEqual({ art: 'nachricht', text: 'Wie ist die Lage' });
    expect(pruefeAktivierung('Hey Alfred, wie spät ist es?', 'Alfred', false)).toEqual({ art: 'nachricht', text: 'Wie spät ist es?' });
    expect(pruefeAktivierung('Jarvis, Licht an.', 'Jarvis', false)).toEqual({ art: 'nachricht', text: 'Licht an.' });
  });
  it('ignoriert ohne Wort — außer im Gesprächsfenster', () => {
    expect(pruefeAktivierung('Was macht mein PC gerade?', 'Alfred', false).art).toBe('ignoriert');
    expect(pruefeAktivierung('Und morgen?', 'Alfred', true)).toEqual({ art: 'nachricht', text: 'Und morgen?' });
    expect(pruefeAktivierung('Alfons kommt später', 'Alfred', false).art).toBe('ignoriert'); // Abstand 3
    expect(pruefeAktivierung('   ', 'Alfred', true).art).toBe('ignoriert');
  });
  it('nur das Wort → Rückfrage; Stoppwort → stopp', () => {
    expect(pruefeAktivierung('Alfred?', 'Alfred', false).art).toBe('nur_wort');
    expect(pruefeAktivierung('Alfred, stopp!', 'Alfred', false).art).toBe('stopp');
    expect(pruefeAktivierung('Stop', 'Alfred', true).art).toBe('stopp');
    expect(pruefeAktivierung('Stoppuhr starten bitte', 'Alfred', true).art).toBe('nachricht');
  });
  it('abstand', () => { expect(abstand('alfred', 'alfried')).toBe(1); expect(abstand('alfred', 'alfons')).toBe(3); });
});
