import { describe, it, expect } from 'vitest';
import { parseFensterZeilen } from './satellit-fenster.js';

describe('parseFensterZeilen (v1298)', () => {
  it('liest Programm|Titel je Zeile, Titel mit | bleiben ganz, Leerzeilen fallen weg', () => {
    const out = 'Calculator|Rechner\nTerminal|Dokumente — node /usr/local/bin/alfred sitzung — 120×30\nSafari|A | B\n\n';
    expect(parseFensterZeilen(out)).toEqual([
      { titel: 'Rechner', programm: 'Calculator' },
      { titel: 'Dokumente — node /usr/local/bin/alfred sitzung — 120×30', programm: 'Terminal' },
      { titel: 'A | B', programm: 'Safari' },
    ]);
    expect(parseFensterZeilen('')).toEqual([]);
  });
});
