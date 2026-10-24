import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getNextCronDate } from '@alfred/types';

// v1654 — Realfall 25.10.2026: der 24-h-Horizont fand am Tag der Zeitumstellung (25 h) keinen Termin mehr,
// der Scheduler deaktivierte daraufhin vier tägliche Aufgaben. Wochen- und Monats-Crons waren nie planbar.
describe('getNextCronDate', () => {
  const altTz = process.env.TZ;
  beforeAll(() => { process.env.TZ = 'Europe/Vienna'; });
  afterAll(() => { if (altTz === undefined) delete process.env.TZ; else process.env.TZ = altTz; });

  it('Realfall: tägliche Aufgabe über das Ende der Sommerzeit (25-h-Tag)', () => {
    // Lauf 24.10.2026 19:30:58 MESZ (17:30:58Z) → nächster Termin 25.10. 19:30 MEZ (18:30Z)
    expect(getNextCronDate('30 19 * * *', new Date('2026-10-24T17:30:58Z'))?.toISOString()).toBe('2026-10-25T18:30:00.000Z');
    expect(getNextCronDate('0 9 * * *', new Date('2026-10-24T07:00:23Z'))?.toISOString()).toBe('2026-10-25T08:00:00.000Z');
    expect(getNextCronDate('0 22 * * *', new Date('2026-10-24T20:00:59Z'))?.toISOString()).toBe('2026-10-25T21:00:00.000Z');
  });

  it('Beginn der Sommerzeit (23-h-Tag) und normaler Tag', () => {
    expect(getNextCronDate('45 12 * * *', new Date('2026-03-28T11:45:10Z'))?.toISOString()).toBe('2026-03-29T10:45:00.000Z');
    expect(getNextCronDate('45 12 * * *', new Date('2026-10-20T10:45:10Z'))?.toISOString()).toBe('2026-10-21T10:45:00.000Z');
    expect(getNextCronDate('*/15 * * * *', new Date('2026-10-20T10:46:00Z'))?.toISOString()).toBe('2026-10-20T11:00:00.000Z');
  });

  it('Wochen- und Monats-Crons finden ihren Termin', () => {
    // Montag 9:00 nach einem Montagslauf → eine Woche später
    expect(getNextCronDate('0 9 * * 1', new Date('2026-10-19T07:00:30Z'))?.toISOString()).toBe('2026-10-26T08:00:00.000Z');
    // Am 1. jedes Monats 06:00
    expect(getNextCronDate('0 6 1 * *', new Date('2026-10-01T04:00:30Z'))?.toISOString()).toBe('2026-11-01T05:00:00.000Z');
  });

  it('ungültige oder unerfüllbare Ausdrücke liefern null', () => {
    expect(getNextCronDate('0 9 * *', new Date('2026-10-20T00:00:00Z'))).toBeNull();
    expect(getNextCronDate('0 9 31 2 *', new Date('2026-10-20T00:00:00Z'))).toBeNull();
  });
});
