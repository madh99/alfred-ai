import { describe, it, expect, beforeEach } from 'vitest';
import { merkeFehlversuch, darfErneutVersuchen, vergissFehlversuche } from './satellit-update.js';

// v1319 — Realfall PC 09.10.: halbe npm-Installation → Neustart-Schleife alle 20 s, bis der Starter aufgab.
describe('Satelliten-Update: Fehlversuche je Version', () => {
  beforeEach(() => vergissFehlversuche());

  it('erster und zweiter Versuch sind frei, danach 30 min Pause, ab fünf Fehlschlägen 6 h', () => {
    const t0 = Date.parse('2026-10-09T06:00:00Z');
    expect(darfErneutVersuchen('1318', t0)).toBeUndefined();
    merkeFehlversuch('1318', t0);
    expect(darfErneutVersuchen('1318', t0 + 1000)).toBeUndefined();
    merkeFehlversuch('1318', t0 + 60_000);
    expect(darfErneutVersuchen('1318', t0 + 2 * 60_000)).toEqual({ versuche: 2, minuten: 29 });
    expect(darfErneutVersuchen('1318', t0 + 31 * 60_000)).toBeUndefined();
    for (let i = 0; i < 3; i++) merkeFehlversuch('1318', t0 + 40 * 60_000);
    expect(darfErneutVersuchen('1318', t0 + 41 * 60_000)).toEqual({ versuche: 5, minuten: 359 });
  });

  it('andere Versionen sind nicht betroffen', () => {
    merkeFehlversuch('1318'); merkeFehlversuch('1318');
    expect(darfErneutVersuchen('1319')).toBeUndefined();
  });
});
