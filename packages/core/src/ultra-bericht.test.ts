import { describe, it, expect } from 'vitest';
import { ultraTagesbericht, ultraKennzahlen, ausloeserText } from './ultra-bericht.js';

describe('Spec Stufe ultra U3 — Tagesbericht', () => {
  it('kein Bericht an Tagen ohne ultra', () => {
    expect(ultraTagesbericht('2026-11-22', [])).toBeUndefined();
  });

  it('Anzahl, Auslöser und Kosten, teuerster Posten zuerst, Rückfälle', () => {
    const s = [
      { grund: 'ausdrücklich', aufrufe: 1, kostenUsd: 0.391414, rueckfaelle: 0 },
      { grund: 'gegenpruefung:ab56d72f-1111-2222', aufrufe: 2, kostenUsd: 0.8, rueckfaelle: 1 },
    ];
    expect(ultraTagesbericht('2026-11-22', s)).toBe([
      'Stufe ultra am 2026-11-22: 3 Aufrufe, 1,19 $',
      '- Gegenprüfung ab56d72f: 2 Aufrufe, 0,80 $',
      '- ausdrücklich gewählt: 1 Aufruf, 0,39 $',
      'Rückfall auf eine andere Stufe: 1×',
    ].join('\n'));
    expect(ultraKennzahlen(s)).toEqual({ ultraAufrufe: 3, ultraKostenUsd: 1.1914, ultraRueckfaelle: 1 });
  });

  it('Auslösertexte', () => {
    expect(ausloeserText('eskalation:planpruefung')).toBe('Eskalation (Planprüfung 2× abgelehnt)');
    expect(ausloeserText('eskalation:einwand')).toBe('Eskalation (Einwand)');
    expect(ausloeserText('eskalation:korrektur:ab12cd34')).toBe('Eskalation (Korrektur ab12cd34)');
    expect(ausloeserText('ohne-ausloeser')).toContain('Fehler');
  });
});
