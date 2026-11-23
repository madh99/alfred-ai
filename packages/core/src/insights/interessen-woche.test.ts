import { describe, it, expect } from 'vitest';
import { interessenWochenText } from './interessen-woche.js';

/**
 * v1937 — Block 26.10. (Owner 23.11. „ok“): 872 Interessen-Hinweise liefen seit 12.10. ohne Reaktion ab. Keine Einzelmeldungen
 * mehr je Thema und Tag, sondern sonntags eine Wochenübersicht aus den still abgelegten Themen-Digests.
 */
describe('v1937 Interessen-Wochenübersicht', () => {
  it('summiert neue Beiträge je Thema aus den Titeln „<Thema>: <n> neue Beiträge“, größte zuerst', () => {
    const t = interessenWochenText([
      'KI-Modelle: 4 neue Beiträge', 'Apple: 2 neue Beiträge', 'KI-Modelle: 3 neue Beiträge', 'Quellen-Pflege: 1 Feed(s) neu, 0 deaktiviert',
    ]);
    expect(t).toContain('KI-Modelle — 7');
    expect(t.indexOf('KI-Modelle')).toBeLessThan(t.indexOf('Apple'));
    expect(t).not.toContain('Quellen-Pflege');
  });
  it('nichts → leer (keine Meldung)', () => {
    expect(interessenWochenText([])).toBe('');
    expect(interessenWochenText(['Quellen-Pflege: 1 Feed(s) neu'])).toBe('');
  });
});
