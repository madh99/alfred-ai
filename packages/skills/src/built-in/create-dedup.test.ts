import { describe, it, expect } from 'vitest';
import { TodoSkill } from './todo.js';

/**
 * v924 — Erstell-Dedup gegen semantische Duplikate. Realfall: 45 offene
 * Sensor-Batterien-Todos, jedes anders formuliert (HEUTE/JETZT/SOFORT/URGENT/
 * KRITISCH/austauschen/wechseln/ersetzen…) — exakter Titel-Vergleich fand NULL.
 */
describe('v924 TodoSkill.findSimilarTodo', () => {
  const existing = [
    { id: 't1', title: '🔴 SOFORT: Sensor-Batterien austauschen (Garage Temp, Wohnzimmer Temp, B_Garage)' },
    { id: 't2', title: 'Steuererklärung 2025 vorbereiten' },
  ];

  it('erkennt semantische Duplikate trotz anderer Formulierung', () => {
    const hit = TodoSkill.findSimilarTodo('🔋 HEUTE: Sensor-Batterien wechseln — Garage Temp, Wohnzimmer Temp', existing);
    expect(hit?.id).toBe('t1');
  });

  it('erkennt Duplikat mit Emoji-/Dringlichkeits-Varianten', () => {
    const hit = TodoSkill.findSimilarTodo('URGENT: Sensor-Batterien ersetzen (Garage, Wohnzimmer)', existing);
    expect(hit?.id).toBe('t1');
  });

  it('lässt unabhängige Todos durch', () => {
    expect(TodoSkill.findSimilarTodo('Reifen wechseln beim Auto', existing)).toBeNull();
    expect(TodoSkill.findSimilarTodo('Zahnarzttermin vereinbaren', existing)).toBeNull();
  });

  it('kurze generische Titel erzeugen keinen Fehltreffer', () => {
    expect(TodoSkill.findSimilarTodo('Einkaufen', existing)).toBeNull();
  });
});
