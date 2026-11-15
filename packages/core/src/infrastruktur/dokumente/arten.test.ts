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
