import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import type { Dokument } from './modell.js';
import { alsPdf } from './pdf.js';
import { alsDocx } from './docx.js';
import { winAnsi } from './pdf.js';

async function dokumentXml(b: Buffer): Promise<string> {
  const req = createRequire(createRequire(import.meta.url).resolve('docx'));
  const JSZip = req('jszip');
  const z = await JSZip.loadAsync(b);
  return z.file('word/document.xml').async('string');
}

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
  it('DOCX entfernt unzulässige Steuerzeichen', async () => {
    const d = beispiel();
    d.kapitel[0]!.bloecke.push({ art: 'code', text: 'a' + String.fromCharCode(7) + 'b' + String.fromCharCode(27) + 'c' });
    const xml = await dokumentXml(await alsDocx(d));
    expect(xml).toContain('abc');
    for (const c of [7, 27]) expect(xml.includes(String.fromCharCode(c))).toBe(false);
  });

  it('DOCX entfernt verwaiste Surrogate und U+FFFE/U+FFFF, behält Emoji', async () => {
    const d = beispiel();
    const lone = String.fromCharCode(0xd83d);
    const fffe = String.fromCharCode(0xfffe);
    const ffff = String.fromCharCode(0xffff);
    d.kapitel[0]!.bloecke = [{ art: 'absatz', text: 'a' + lone + 'b' + fffe + ffff + 'c' + String.fromCodePoint(0x1f600) }];
    const xml = await dokumentXml(await alsDocx(d));
    expect(xml).toContain('abc' + String.fromCodePoint(0x1f600));
    const ohneEmoji = xml.split(String.fromCodePoint(0x1f600)).join('');
    for (const c of [lone, fffe, ffff]) expect(ohneEmoji.includes(c)).toBe(false);
  });

  it('DOCX-Tabelle hat 100 Prozent Breite', async () => {
    const xml = await dokumentXml(await alsDocx(beispiel()));
    expect(xml).toContain(`<w:tblW w:type="pct" w:w="100%"/>`);
    expect(xml).toContain(`<w:gridCol w:w="2256"/>`);
  });

  it('Tabelle ohne Kopf wird als Platzhalter gerendert', async () => {
    const d = beispiel();
    d.kapitel[0]!.bloecke = [{ art: 'tabelle', kopf: [], zeilen: [] }];
    expect(await dokumentXml(await alsDocx(d))).toContain('Tabelle ohne Spalten');
    expect((await alsPdf(d)).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('winAnsi normalisiert kombinierende Umlaute', () => {
    expect(winAnsi('u' + String.fromCharCode(0x308))).toBe('ü');
  });
});
