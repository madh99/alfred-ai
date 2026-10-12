import { describe, it, expect } from 'vitest';
import { folgesignalFuer, istProtokollAnfrage, werkzeugeAus } from '../lernen/anfrage-protokoll.js';
import { absichtenAus } from '../skill-filter.js';

// v1374 — Lernende Helfer L0: Lernsignal je Gesprächsanfrage
describe('Folgesignal', () => {
  it('Widerspruch des Owners → korrigiert', () => {
    expect(folgesignalFuer('Wie ist der SoC vom BMW?', 'Nein, ich meinte die Hausbatterie')).toBe('korrigiert');
    expect(folgesignalFuer('Wann kommt die Rechnung?', 'Das stimmt nicht, die kam gestern')).toBe('korrigiert');
  });
  it('fast dieselbe Frage noch einmal → wiederholt; neue Frage → nichts', () => {
    expect(folgesignalFuer('Welche Lichter waren gestern länger an als sonst?', 'Welche Lichter waren gestern länger an?')).toBe('wiederholt');
    expect(folgesignalFuer('Welche Lichter waren gestern länger an?', 'Wie wird das Wetter morgen in Altlengbach?')).toBeNull();
    expect(folgesignalFuer('ok', 'danke')).toBeNull();
  });
});

describe('Was protokolliert wird', () => {
  it('keine Knöpfe, geplanten Läufe oder Update-Befehle', () => {
    expect(istProtokollAnfrage('Wie spät ist es?', '5060785419')).toBe(true);
    expect(istProtokollAnfrage('hw:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:gut', '5060785419')).toBe(false);
    expect(istProtokollAnfrage('Prüfe die Rechnung', 'scheduled-5b1fcecf')).toBe(false);
    expect(istProtokollAnfrage('Alfred, aktualisiere dich', 'api-update-1374')).toBe(false);
    expect(istProtokollAnfrage('x', 'c', { scheduled: true })).toBe(false);
  });
  it('Werkzeuge mit Aktion und Ausgang; Absicht aus den Kategorien', () => {
    const w = werkzeugeAus(
      [{ id: 't1', name: 'homeassistant', input: { action: 'history_summary' } }, { id: 't2', name: 'email', input: { action: 'read' } }],
      [{ type: 'tool_result', tool_use_id: 't1' }, { type: 'tool_result', tool_use_id: 't2', is_error: true }],
    );
    expect(w).toEqual([{ skill: 'homeassistant', aktion: 'history_summary', ok: true }, { skill: 'email', aktion: 'read', ok: false }]);
    expect(Array.isArray(absichtenAus('Schick mir die E-Mail von aWATTar'))).toBe(true);
  });
});
