import { describe, it, expect } from 'vitest';
import { WarumSpeicher, istWarumFrage, insightTitel, formatiereWarum, WARUM_RING_GROESSE } from '../interaktion/warum.js';

// Jarvis Interaktion — „Warum?" liefert die Kette Daten → Deutung → Entscheidung ohne LLM.
describe('istWarumFrage', () => {
  it('erkennt kurze Warum-Fragen, nicht aber Sätze mit Inhalt', () => {
    for (const t of ['warum?', 'Warum', 'wieso das?', 'weshalb denn', 'warum diese Meldung?', ' WARUM?? ']) expect(istWarumFrage(t)).toBe(true);
    for (const t of ['warum ist der Himmel blau', 'erkläre warum', 'todo:abc:done', '']) expect(istWarumFrage(t)).toBe(false);
  });
});

describe('insightTitel', () => {
  it('erste Zeile ohne Nummer, Markdown, Emoji, Schweregrad', () => {
    expect(insightTitel('### **1. 🔴 [HIGH] Kritische Systemfehler – E-Mail**\nDetails')).toBe('Kritische Systemfehler – E-Mail');
  });
});

describe('WarumSpeicher / formatiereWarum', () => {
  it('Ring hält die letzten Begründungen, jüngste zuerst', () => {
    const w = new WarumSpeicher();
    for (let i = 0; i < WARUM_RING_GROESSE + 5; i++) w.merke({ zeit: new Date(2026, 9, 5, 12, i).toISOString(), art: 'vollpass', ausloeser: [`a${i}`], gateAusgesetzt: [], insights: [], zustellung: 'still' });
    expect(w.letzte(2).map(b => b.ausloeser[0])).toEqual([`a${WARUM_RING_GROESSE + 4}`, `a${WARUM_RING_GROESSE + 3}`]);
    expect(w.letzte(100)).toHaveLength(WARUM_RING_GROESSE);
  });
  it('formatiert Art, Auslöser, Gate, Meldungen und Zustellung; ohne Begründung ein ehrlicher Satz', () => {
    const t = formatiereWarum({
      zeit: new Date(2026, 9, 5, 22, 0).toISOString(), art: 'vollpass', ausloeser: ['cmdb: „2 offen" → „0 offen"'],
      gateAusgesetzt: ['korrektur:bmw-mqtt'], insights: ['Zwei Incidents gelöst'], zustellung: 'gesendet', dauerMs: 41_200,
    });
    expect(t).toContain('Warum die Meldung von 05.10. 22:00?');
    expect(t).toContain('Art: Vollpass');
    expect(t).toContain('Auslöser: cmdb: „2 offen" → „0 offen"');
    expect(t).toContain('Gate ausgesetzt (Weltmodell meldete Auffälligkeit): korrektur:bmw-mqtt');
    expect(t).toContain('Gemeldet (1): „Zwei Incidents gelöst"');
    expect(t).toContain('Zustellung: sofort gesendet · Dauer 41.2 s');
    expect(formatiereWarum(undefined)).toMatch(/keine Begründung gespeichert/);
    const m = formatiereWarum({ zeit: new Date().toISOString(), art: 'minipass', ausloeser: ['haus: Tür Terrasse offen'], gateAusgesetzt: [], insights: [], zustellung: 'aufgeschoben' });
    expect(m).toContain('Art: Mini-Pass');
    expect(m).toContain('aufgeschoben (du warst nicht aktiv)');
  });
});
