import { describe, it, expect } from 'vitest';
import { leseBefunde, gegenpruefungNoetig, vermerkText, gegenpruefungFrage } from './ultra-gegenpruefung.js';

describe('Spec Stufe ultra U2.2 — Gegenprüfung (reine Teile)', () => {
  it('nur Risiko high und critical (O1)', () => {
    expect(gegenpruefungNoetig('high')).toBe(true);
    expect(gegenpruefungNoetig('critical')).toBe(true);
    expect(gegenpruefungNoetig('medium')).toBe(false);
    expect(gegenpruefungNoetig('low')).toBe(false);
    expect(gegenpruefungNoetig(undefined)).toBe(false);
  });

  it('liest JSON auch im Code-Block, verwirft zu kurze Befunde, begrenzt auf 8', () => {
    const viele = Array.from({ length: 12 }, (_, i) => ({ bezug: `Schritt ${i + 1}`, text: `Mangel Nummer ${i + 1} mit Folge` }));
    expect(leseBefunde('```json\n' + JSON.stringify({ befunde: viele }) + '\n```')).toHaveLength(8);
    expect(leseBefunde('{"befunde":[{"bezug":"Schritt 3","text":"kurz"},{"text":"Rückweg fehlt für das Anlegen der VM"}]}'))
      .toEqual([{ bezug: 'gesamt', text: 'Rückweg fehlt für das Anlegen der VM' }]);
    expect(leseBefunde('{"befunde":[]}')).toEqual([]);
  });

  it('unlesbar → undefined (fail-closed)', () => {
    expect(leseBefunde('Der Plan sieht gut aus.')).toBeUndefined();
    expect(leseBefunde('{"ergebnis": "ok"}')).toBeUndefined();
    expect(leseBefunde('{kaputt')).toBeUndefined();
  });

  it('Vermerk und Frage', () => {
    expect(vermerkText({ fingerabdruck: 'x', befunde: 0, zeit: '' })).toBe('Von ultra gegengeprüft: keine Befunde.');
    expect(vermerkText({ fingerabdruck: 'x', befunde: 2, zeit: '' })).toContain('2 Befunde');
    expect(gegenpruefungFrage({ id: 'abcdef1234', title: 'T', riskLevel: 'high' }, { schritte: [] })).toContain('Change abcdef12 „T“ (Risiko high)');
  });
});
