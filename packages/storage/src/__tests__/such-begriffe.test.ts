import { describe, it, expect } from 'vitest';
import { suchBegriffe } from '../repositories/memory-repository.js';

/**
 * v1495 — Füllwörter bestimmten die Stichwortsuche: Realfall 18.10. Strom-Frage — „du", „der", „wie" passten als
 * Wortteil auf fast jeden Text, 1 658 Kandidaten, die Rechnungsübersicht auf Rang 280.
 */
describe('v1495 suchBegriffe', () => {
  it('Realfall: nur die Inhaltswörter bleiben', () => {
    expect(suchBegriffe('kannst du mir sagen wieviel wir heuer für strom bezahlt haben ? und wie sich der verbauch entwickelt hat ?'))
      .toEqual(['heuer', 'strom', 'bezahlt', 'verbauch', 'entwickelt']);
  });

  it('Satzzeichen am Rand fallen weg, Groß/klein egal, keine Doppelten', () => {
    expect(suchBegriffe('Strom, STROM? „aWATTar“ Rechnung!')).toEqual(['strom', 'awattar', 'rechnung']);
  });

  it('nur Füllwörter → wie bisher alle Wörter (ab 2 Zeichen)', () => {
    expect(suchBegriffe('wer ist es')).toEqual(['wer', 'ist', 'es']);
    expect(suchBegriffe('?  a')).toEqual([]);
  });

  it('Schlüssel mit Unterstrich und Zahlen bleiben ganz', () => {
    expect(suchBegriffe('awattar_invoice_2026_09 bitte')).toEqual(['awattar_invoice_2026_09']);
  });
});
