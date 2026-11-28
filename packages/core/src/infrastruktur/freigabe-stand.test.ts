import { describe, it, expect } from 'vitest';
import type { CmdbChangeRequest } from '@alfred/types';
import { freigabeStand } from './change-planung.js';

// Realfall 28.11. (811c766d): „wartet auf Freigabe“ ohne offene Freigabe-Frage
const basis = (x: Partial<CmdbChangeRequest>): CmdbChangeRequest => ({ id: 'c1', title: 'T', status: 'submitted', fingerabdruck: 'fp2', ...x } as CmdbChangeRequest);
const jetzt = Date.parse('2026-11-28T18:00:00Z');

describe('freigabeStand', () => {
  it('submitted mit passender, gültiger Frage → wartet auf den Owner', () => {
    expect(freigabeStand(basis({ freigabeAnfrage: { hash: 'h', bis: '2026-11-29T18:00:00Z', fingerabdruck: 'fp2' } }), jetzt)).toMatch(/^wartet auf die Freigabe des Owners/);
  });
  it('submitted ohne Frage, mit abgelaufener oder zu altem Plan gehörender Frage → KEINE Frage offen', () => {
    expect(freigabeStand(basis({}), jetzt)).toMatch(/KEINE Freigabe-Frage offen/);
    expect(freigabeStand(basis({ freigabeAnfrage: { hash: 'h', bis: '2026-11-28T17:00:00Z', fingerabdruck: 'fp2' } }), jetzt)).toMatch(/KEINE/);
    expect(freigabeStand(basis({ freigabeAnfrage: { hash: 'h', bis: '2026-11-29T18:00:00Z', fingerabdruck: 'fp1' } }), jetzt)).toMatch(/KEINE/);
  });
  it('korrigierter, angehaltener Change wird als solcher benannt; laufende und andere Stati unverändert', () => {
    const k = basis({ status: 'in_progress', freigabeFingerabdruck: 'fp1', lauf: { phase: 'angehalten', korrektur: { zeit: 'x' } } as never });
    expect(freigabeStand(k, jetzt)).toMatch(/^korrigiert, angehalten — bereit zur Freigabe/);
    expect(freigabeStand(basis({ status: 'in_progress', lauf: { phase: 'laeuft' } as never }), jetzt)).toBe('in_progress');
    expect(freigabeStand(basis({ status: 'draft' }), jetzt)).toBe('draft');
  });
});
