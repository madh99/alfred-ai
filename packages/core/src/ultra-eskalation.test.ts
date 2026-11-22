import { describe, it, expect } from 'vitest';
import { UltraEskalation, korrekturZiel, eskalationsZeile, ESKALATION_GUELTIG_MS } from './ultra-eskalation.js';

describe('Spec Stufe ultra U2.3 — Eskalations-Register', () => {
  it('Planprüfung: erst die zweite Ablehnung in Folge eskaliert; Speichern beendet und setzt zurück', () => {
    const r = new UltraEskalation();
    expect(r.planAbgelehnt('f')).toBe(false);
    expect(r.aktiv('f')).toBeUndefined();
    expect(r.planAbgelehnt('f')).toBe(true);
    expect(r.aktiv('f')).toBe('planpruefung');
    r.planGespeichert('f');
    expect(r.aktiv('f')).toBeUndefined();
    expect(r.planAbgelehnt('f')).toBe(false); // Zähler zurückgesetzt
  });

  it('Ablehnung, Erfolg, Ablehnung ist nicht „zweimal in Folge“', () => {
    const r = new UltraEskalation();
    r.planAbgelehnt('f'); r.planGespeichert('f'); r.planAbgelehnt('f');
    expect(r.aktiv('f')).toBeUndefined();
  });

  it('Einwand gilt je Faden, bis eine Stufe gewählt wird; verfällt nach der Gültigkeit', () => {
    let t = 0;
    const r = new UltraEskalation(() => t);
    r.setze('a', 'einwand');
    expect(r.aktiv('a')).toBe('einwand');
    expect(r.aktiv('b')).toBeUndefined();
    r.beende('a');
    expect(r.aktiv('a')).toBeUndefined();
    r.setze('a', 'einwand');
    t = ESKALATION_GUELTIG_MS + 1;
    expect(r.aktiv('a')).toBeUndefined();
  });

  it('Korrektur: ID eines angehaltenen Changes im Text, außer bei festen Steuerbefehlen', () => {
    const halt = ['3af9930c-1111-2222-3333-444455556666'];
    expect(korrekturZiel('Plan von 3af9930c ab Schritt 4 korrigieren: Position 1. statt 2.', halt)).toBe('3af9930c');
    expect(korrekturZiel('Change 3af9930c Schritt wiederholen', halt)).toBeUndefined();
    expect(korrekturZiel('Change 3af9930c abbrechen', halt)).toBeUndefined();
    expect(korrekturZiel('Change 3af9930c Schritt überspringen', halt)).toBeUndefined();
    expect(korrekturZiel('was macht ab56d72f?', halt)).toBeUndefined();
  });

  it('Zeile im Faden', () => {
    expect(eskalationsZeile('einwand')).toBe('↗ Auf ultra gewechselt, weil du einen Einwand erhoben hast.');
    expect(eskalationsZeile('korrektur:3af9930c')).toBe('↗ Auf ultra gewechselt, weil Change 3af9930c angehalten ist und korrigiert wird.');
  });
});
