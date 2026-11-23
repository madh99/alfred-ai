import { describe, it, expect } from 'vitest';
import { changeBefehl } from './change-schnell.js';

/**
 * v1937 — L1 erster Helfer (Owner 23.11. nach Auswertung Block 26.10.): „change e44e8270 schritt wiederholen“ war die häufigste
 * wiederholte Frage (13×), Change anzeigen die teuerste Absicht (160×, 118 $). Beides deterministisch ohne Modell.
 * Bewusst NICHT: abbrechen, Rückweg, überspringen — das bleibt beim Modell mit Wortlaut-Pflicht.
 */
describe('v1937 L1 — Change-Befehle ohne Modell', () => {
  it('Schritt wiederholen in den üblichen Formen', () => {
    expect(changeBefehl('change e44e8270 schritt wiederholen')).toEqual({ art: 'wiederholen', id: 'e44e8270' });
    expect(changeBefehl('Change E44E8270 Schritt 5 wiederholen.')).toEqual({ art: 'wiederholen', id: 'e44e8270' });
    expect(changeBefehl('change e44e8270 wiederholen')).toEqual({ art: 'wiederholen', id: 'e44e8270' });
  });
  it('Status', () => {
    expect(changeBefehl('status change 29b2f140')).toEqual({ art: 'status', id: '29b2f140' });
    expect(changeBefehl('Stand von Change 29b2f140?')).toEqual({ art: 'status', id: '29b2f140' });
    expect(changeBefehl('change 29b2f140 status')).toEqual({ art: 'status', id: '29b2f140' });
  });
  it('alles andere bleibt beim Modell', () => {
    expect(changeBefehl('change e44e8270 abbrechen')).toBeNull();
    expect(changeBefehl('change e44e8270 rückweg')).toBeNull();
    expect(changeBefehl('bitte change e44e8270 schritt wiederholen und dann melden')).toBeNull();
    expect(changeBefehl('wie ist der status?')).toBeNull();
  });
});
