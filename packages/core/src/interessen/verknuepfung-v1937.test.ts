import { describe, it, expect } from 'vitest';
import { ankerAusWissen, auswahl, type VerknuepfungsTreffer } from './verknuepfung.js';

/**
 * v1937 — Block 26.10. (Owner 23.11. „ok“): 2711 Treffer seit 13.11., viele Fehl-Anker aus dem Wissensgraph („Drei“ 138×,
 * „Full“ 19×, „Speicher“ 17×, „Services“ 20×). Sperrliste allgemeiner Wörter, und gezählt werden nur starke Treffer (Titel).
 */
describe('v1937 Verknüpfung — Sperrliste und nur stark', () => {
  it('allgemeine Wörter werden keine Anker', () => {
    const a = ankerAusWissen([
      { name: 'Drei', typ: 'organization' }, { name: 'Full', typ: 'location' }, { name: 'Speicher', typ: 'location' },
      { name: 'Services', typ: 'organization' }, { name: 'Anthropic', typ: 'organization' }, { name: 'Linz', typ: 'location' },
    ]);
    expect(a.map(x => x.wort).sort()).toEqual(['Anthropic', 'Linz']);
  });
  it('Auswahl nimmt nur starke Treffer', () => {
    const t = (titel: string, stark: boolean): VerknuepfungsTreffer => ({ beitrag: { titel, thema: 'x' }, anker: [{ wort: 'Linz', art: 'ort', herkunft: 'w' }], stark });
    const r = auswahl([t('A schwach', false), t('B stark', true)], new Map());
    expect(r.map(x => x.beitrag.titel)).toEqual(['B stark']);
  });
});
