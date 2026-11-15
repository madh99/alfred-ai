import { describe, it, expect } from 'vitest';
import type { Dokument } from './modell.js';
import { alsPdf } from './pdf.js';
import { alsDocx } from './docx.js';
import { winAnsi } from './pdf.js';

function beispiel(): Dokument {
  return {
    kopf: {
      art: 'abnahme',
      artVersion: 1,
      titel: 'Abnahme „Test“ — Größe',
      ordner: 'inst-1',
      erzeugt: '2026-11-15T10:00:00Z',
      quellen: [
        { quelle: 'incidents', stand: '2026-11-15' },
        { quelle: 'lauf', stand: '2026-11-14', fehler: 'Zeitüberschreitung' },
      ],
      verweise: ['Change 42'],
    },
    kapitel: [
      {
        nr: 1,
        id: 'a',
        titel: 'Übersicht',
        bloecke: [
          { art: 'absatz', text: '✅ „Test“ — Größe ü' },
          { art: 'liste', punkte: ['eins', '❌ zwei'] },
          {
            art: 'tabelle',
            kopf: ['A', 'B', 'C', 'D'],
            zeilen: [
              ['1', '2', '3', 'x'.repeat(200)],
              ['4', '5', '6', '7'],
              ['8', '9', '10', '11'],
            ],
          },
          { art: 'code', text: 'x'.repeat(5000) },
          { art: 'mermaid', text: 'graph TD\n  A-->B' },
          { art: 'nichtBelegt', grund: 'Quelle fehlt' },
          { art: 'frei', feld: 'notiz' },
          { art: 'frei', feld: 'notiz2', text: 'Freitext' },
        ],
      },
    ],
    anhaenge: [],
  };
}

describe('Dokument-Export', () => {
  it('erzeugt ein PDF', async () => {
    const b = await alsPdf(beispiel());
    expect(Buffer.isBuffer(b)).toBe(true);
    expect(b.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('paginiert lange Dokumente mit Seitenzahl in der Kopfzeile', async () => {
    const d = beispiel();
    d.kapitel[0]!.bloecke.push({ art: 'code', text: Array.from({ length: 400 }, (_, i) => `zeile ${i}`).join('\n') });
    const b = await alsPdf(d);
    const s = b.toString('latin1');
    expect((s.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(2);
  });

  it('erzeugt ein DOCX', async () => {
    const b = await alsDocx(beispiel());
    expect(Buffer.isBuffer(b)).toBe(true);
    expect(b.subarray(0, 2).toString()).toBe('PK');
  });

  it('winAnsi ersetzt Zeichen außerhalb von Latin-1', () => {
    expect(winAnsi('✅ „x“ — ü→')).toBe('[OK] "x" - ü->');
    expect(winAnsi('❌ ‚a‘ ’ – … ß 😀')).toBe('[FEHLER] \'a\' \' - ... ß ?');
  });
});
