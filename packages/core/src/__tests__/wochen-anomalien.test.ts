import { describe, it, expect } from 'vitest';
import { aktuelleAnomalien } from '../active-learning/temporal-analyzer.js';

// v1363 — Realfall: Wochenanalyse 04.10. „email 50 % (normal 9 %), file 75 % (normal 6 %)" stand bis 11.10. im Kontext,
// obwohl der Microsoft-Token am 07.10. getauscht war. Zahlen der letzten 48 h wie live am 12.10.
describe('aktuelleAnomalien', () => {
  const woche = [
    '[critical] email: Error-Rate 50% (normal: 9%)',
    '[critical] file: Error-Rate 75% (normal: 6%)',
    '[warning] calendar: 40% Fehler (bisher keine)',
    '[critical] shell: 54 Calls (normal: ~6/Woche)',
  ].join('\n');
  const aktuell = new Map([['email', { calls: 16, errors: 0 }], ['file', { calls: 1, errors: 0 }], ['calendar', { calls: 9, errors: 3 }], ['shell', { calls: 8, errors: 1 }]]);

  it('behobene Fehlerquote fällt weg; ohne genug Aufrufe oder bei weiter hohen Fehlern bleibt sie; andere Anomalien unberührt', () => {
    const r = aktuelleAnomalien(woche, aktuell);
    expect(r.text.split('\n')).toEqual([
      '[critical] file: Error-Rate 75% (normal: 6%)',
      '[warning] calendar: 40% Fehler (bisher keine)',
      '[critical] shell: 54 Calls (normal: ~6/Woche)',
    ]);
    expect(r.entfernt).toEqual(['[critical] email: Error-Rate 50% (normal: 9%) → letzte 48 h 0/16 Fehler']);
  });

  it('ohne aktuelle Daten bleibt alles', () => {
    expect(aktuelleAnomalien(woche, new Map()).text).toBe(woche);
  });
});
