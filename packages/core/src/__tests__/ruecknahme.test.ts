import { describe, it, expect } from 'vitest';
import { ruecknahmeHinweis } from '../vorgaenge/ruecknahme.js';

// v1200 — Spec Risiken: jede Auto-Aktion mit Rücknahme-Hinweis im Ausführungsgedächtnis.
describe('ruecknahmeHinweis', () => {
  it('nennt den Rückweg mit der Kennung aus dem Skill-Ergebnis', () => {
    expect(ruecknahmeHinweis('reminder', 'set', { message: 'Müll' }, { reminderId: 'r-1' })).toBe('Erinnerung löschen: reminder/cancel reminderId=r-1');
    expect(ruecknahmeHinweis('todo', 'create', {}, { todoId: 't-9', title: 'x' })).toBe('Todo löschen: todo/delete todoId=t-9');
    expect(ruecknahmeHinweis('todo', 'complete', {}, { todoId: 't-9' })).toBe('Todo wieder öffnen: todo/reopen todoId=t-9');
    expect(ruecknahmeHinweis('memory', 'save', { key: 'bmw_soc_min' }, undefined)).toBe('Memory löschen: memory/delete key=bmw_soc_min');
    expect(ruecknahmeHinweis('watch', 'create', {}, { watchId: 'w-2' })).toBe('Watch löschen: watch/delete watchId=w-2');
  });
  it('ohne Kennung bleibt der Rückweg generisch; Lese-Aktionen haben keinen', () => {
    expect(ruecknahmeHinweis('reminder', 'set', {}, { ok: true })).toBe('Erinnerung löschen: reminder/cancel');
    expect(ruecknahmeHinweis('calendar', 'list', {}, {})).toBeUndefined();
    expect(ruecknahmeHinweis('homeassistant', 'turn_on', {}, {})).toBeUndefined();
  });
});
