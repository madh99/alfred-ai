import { describe, it, expect } from 'vitest';
import { fadenAenderungLesen } from '../adapters/http.js';

/** v1497 — PATCH eines Fadens: Titel, angeheftet, archiviert (App und Web). */
describe('v1497 fadenAenderungLesen', () => {
  it('Titel allein wie bisher, auf 80 Zeichen gekürzt', () => {
    expect(fadenAenderungLesen(JSON.stringify({ titel: '  Urlaub  ' }))).toEqual({ titel: 'Urlaub' });
    expect(fadenAenderungLesen(JSON.stringify({ titel: 'x'.repeat(100) }))?.titel).toHaveLength(80);
  });

  it('angeheftet und archiviert nur als Wahrheitswert', () => {
    expect(fadenAenderungLesen(JSON.stringify({ angeheftet: true }))).toEqual({ aenderung: { angeheftet: true } });
    expect(fadenAenderungLesen(JSON.stringify({ archiviert: false }))).toEqual({ aenderung: { archiviert: false } });
    expect(fadenAenderungLesen(JSON.stringify({ archiviert: 'ja' }))).toBeUndefined();
  });

  it('leer, ungültig oder ohne Felder → nichts', () => {
    expect(fadenAenderungLesen('')).toBeUndefined();
    expect(fadenAenderungLesen('{kaputt')).toBeUndefined();
    expect(fadenAenderungLesen(JSON.stringify({ titel: '   ' }))).toBeUndefined();
    expect(fadenAenderungLesen('null')).toBeUndefined();
  });
});
