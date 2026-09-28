import { describe, it, expect } from 'vitest';
import { istNachtjobFaellig, lokalesDatum } from '../nachtjob-plan.js';

// v1158 — Realfall 28.09.: KG-Wartung (04:30) lief seit 12.09. nicht, weil der
// Stunden-Timer immer zur Prozess-Startminute (:04 bzw. :28) feuerte und
// „Minute ≥ 30" damit nie erfüllt war.

const um = (h: number, m: number) => new Date(2026, 8, 28, h, m, 0);

describe('v1158 istNachtjobFaellig', () => {
  it('Realfall: Tick um 04:28 ist NICHT fällig, 04:30 und 04:38 sind es (10-min-Raster)', () => {
    expect(istNachtjobFaellig(um(4, 28), 4, 30, '')).toBeNull();
    expect(istNachtjobFaellig(um(4, 30), 4, 30, '')).toBe('2026-09-28');
    expect(istNachtjobFaellig(um(4, 38), 4, 30, '')).toBe('2026-09-28');
  });

  it('Nachholen nach Restart: 21:28 ohne heutigen Lauf → fällig; nach dem Lauf nicht mehr', () => {
    expect(istNachtjobFaellig(um(21, 28), 4, 30, '')).toBe('2026-09-28');
    expect(istNachtjobFaellig(um(21, 28), 4, 30, '2026-09-28')).toBeNull();
  });

  it('vor der Zielzeit nie fällig, neuer Tag wieder fällig', () => {
    expect(istNachtjobFaellig(um(2, 55), 3, 0, '2026-09-27')).toBeNull();
    expect(istNachtjobFaellig(um(3, 0), 3, 0, '2026-09-27')).toBe('2026-09-28');
  });

  it('lokalesDatum nutzt Lokalzeit, nicht UTC', () => {
    expect(lokalesDatum(new Date(2026, 8, 28, 0, 5))).toBe('2026-09-28');
  });
});
