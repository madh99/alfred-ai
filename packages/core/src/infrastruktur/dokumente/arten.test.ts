import { describe, it, expect } from 'vitest';
import { DOKU_ARTEN, pruefeDokument } from './arten.js';
import { alsMarkdown } from './markdown.js';
import type { Dokument, Kapitel } from './modell.js';

function abnahme(): Dokument {
  const kapitel: Kapitel[] = DOKU_ARTEN.abnahme.kapitel.map((k, i) => ({
    nr: i + 1,
    id: k.id,
    titel: k.titel,
    bloecke: k.frei
      ? [{ art: 'frei', feld: k.frei.feld, text: 'kurz' }]
      : [{ art: 'absatz', text: 'Inhalt' }],
  }));
  return {
    kopf: { art: 'abnahme', artVersion: 1, titel: 'Abnahme X', ordner: 'x', erzeugt: '2026-11-15T10:00:00Z', quellen: [{ quelle: 'lauf', stand: '2026-11-15T09:59:00Z' }], verweise: ['change-1'] },
    kapitel,
    anhaenge: [],
  };
}

describe('pruefeDokument', () => {
  it('gültiges Abnahmedokument mit allen 6 Kapiteln ergibt keine Meldung', () => {
    expect(pruefeDokument(abnahme())).toEqual([]);
  });
  it('meldet fehlendes Pflichtkapitel beweise', () => {
    const d = abnahme();
    d.kapitel = d.kapitel.filter((k) => k.id !== 'beweise');
    expect(pruefeDokument(d).join('\n')).toContain('beweise');
  });
  it('meldet falsche Reihenfolge', () => {
    const d = abnahme();
    [d.kapitel[2], d.kapitel[3]] = [d.kapitel[3]!, d.kapitel[2]!];
    expect(pruefeDokument(d).join('\n')).toMatch(/Reihenfolge/);
  });
  it('meldet freies Feld über 600 Zeichen', () => {
    const d = abnahme();
    d.kapitel[1]!.bloecke = [{ art: 'frei', feld: 'zweck', text: 'x'.repeat(601) }];
    const m = pruefeDokument(d);
    expect(m.length).toBe(1);
    expect(m[0]).toContain('600');
  });
  it('meldet Pflichtkapitel ohne Block', () => {
    const d = abnahme();
    d.kapitel[2]!.bloecke = [];
    expect(pruefeDokument(d).join('\n')).toContain('schritte');
  });
  it('meldet unbekanntes Kapitel', () => {
    const d = abnahme();
    d.kapitel.push({ nr: 7, id: 'sonstiges', titel: 'X', bloecke: [] });
    expect(pruefeDokument(d).join('\n')).toContain('sonstiges');
  });
  it('betrieb hat 13 Kapitel in Spec-Reihenfolge', () => {
    expect(DOKU_ARTEN.betrieb.kapitel.map((k) => k.id)).toEqual([
      'zweck', 'architektur', 'komponenten', 'netz', 'identitaeten', 'abhaengigkeiten', 'wiederaufbau',
      'sicherung', 'ueberwachung', 'betrieb', 'historie', 'beweise', 'abweichungen',
    ]);
  });
});

describe('pruefeDokument (Härtung)', () => {
  it('meldet falsche Version der Dokumentart', () => {
    const d = abnahme();
    d.kopf.artVersion = 2;
    expect(pruefeDokument(d).join('\n')).toMatch(/Version/);
  });
  it('meldet doppelte Kapitel-IDs', () => {
    const d = abnahme();
    d.kapitel.push({ ...d.kapitel[5]! });
    expect(pruefeDokument(d).join('\n')).toMatch(/Doppeltes Kapitel: beweise/);
  });
  it('meldet freies Feld mit falschem Namen', () => {
    const d = abnahme();
    d.kapitel[1]!.bloecke = [{ art: 'frei', feld: 'anderes', text: 'x' }];
    expect(pruefeDokument(d).join('\n')).toContain('anderes');
  });
  it('meldet freien Block in Kapitel ohne freie Definition', () => {
    const d = abnahme();
    d.kapitel[2]!.bloecke = [{ art: 'frei', feld: 'zweck', text: 'x' }];
    expect(pruefeDokument(d).join('\n')).toMatch(/nicht vorgesehen/);
  });
});

describe('alsMarkdown (Härtung)', () => {
  function mitBloecken(bloecke: Dokument['kapitel'][number]['bloecke']): string {
    const d = abnahme();
    d.kapitel[5]!.bloecke = bloecke;
    return alsMarkdown(d);
  }
  it('Zaun ist länger als Backtick-Folgen im Inhalt', () => {
    const md = mitBloecken([
      { art: 'code', text: 'a ``` b' },
      { art: 'mermaid', text: 'x ```` y' },
    ]);
    expect(md).toContain('````\na ``` b\n````');
    expect(md).toContain('`````mermaid\nx ```` y\n`````');
  });
  it('sehr viele getrennte Backticks werfen nicht, Zaun bleibt 3', () => {
    const text = '`a'.repeat(200000);
    const md = mitBloecken([{ art: 'code', text }]);
    expect(md).toContain('```\n`a');
    expect(md).not.toContain('````\n');
  });
  it('mehrzeiliger Grund bleibt im Zitat', () => {
    const md = mitBloecken([{ art: 'nichtBelegt', grund: 'eins\r\nzwei\n\ndrei' }]);
    expect(md).toContain('> **Nicht belegt:** eins\n> zwei\n>\n> drei');
  });
  it('Tabellenzelle: Backslash vor Pipe, einzelnes CR', () => {
    const md = mitBloecken([{ art: 'tabelle', kopf: ['A'], zeilen: [['a\\|b'], ['x\ry']] }]);
    expect(md).toContain('| a\\\\\\|b |');
    expect(md).toContain('| x y |');
  });
});

describe('alsMarkdown', () => {
  it('rendert Kapitel, Nicht-belegt, leeres freies Feld, Tabelle und Mermaid', () => {
    const d = abnahme();
    d.kapitel[1]!.bloecke = [{ art: 'frei', feld: 'zweck' }];
    d.kapitel[5]!.bloecke = [
      { art: 'nichtBelegt', grund: 'kein Lauf' },
      { art: 'tabelle', kopf: ['A', 'B'], zeilen: [['1', 'a|b']] },
      { art: 'mermaid', text: 'graph TD; A-->B' },
    ];
    const md = alsMarkdown(d);
    expect(md).toContain('## 6. Abnahme und Beweise');
    expect(md).toContain('> **Nicht belegt:** kein Lauf');
    expect(md).toContain('_(nicht ausgefüllt)_');
    expect(md).toContain('| A | B |');
    expect(md).toContain('a\\|b');
    expect(md).toContain('```mermaid\ngraph TD; A-->B\n```');
    expect(md).toContain('lauf: 2026-11-15T09:59:00Z');
  });
});
