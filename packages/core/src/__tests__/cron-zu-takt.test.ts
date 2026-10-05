import { describe, it, expect } from 'vitest';
import { cronZuTakt } from '../lebenszeichen/job-register.js';

// v1190 — Backup-Zeitplan (Cron) ins Job-Register.
describe('cronZuTakt', () => {
  it('täglich: „0 3 * * *" → 03:00, exakt', () => {
    expect(cronZuTakt('0 3 * * *')).toEqual({ takt: { art: 'taeglich', um: '03:00' }, exakt: true });
    expect(cronZuTakt('30 23 * * *')).toEqual({ takt: { art: 'taeglich', um: '23:30' }, exakt: true });
    expect(cronZuTakt(undefined)).toEqual({ takt: { art: 'taeglich', um: '03:00' }, exakt: true });
  });
  it('Intervalle: alle N Minuten (mind. Raster 10) und alle N Stunden', () => {
    expect(cronZuTakt('*/30 * * * *')).toEqual({ takt: { art: 'intervall', minuten: 30 }, exakt: true });
    expect(cronZuTakt('*/5 * * * *')).toEqual({ takt: { art: 'intervall', minuten: 10 }, exakt: false });
    expect(cronZuTakt('0 */6 * * *')).toEqual({ takt: { art: 'intervall', minuten: 360 }, exakt: true });
    expect(cronZuTakt('15 */6 * * *')).toEqual({ takt: { art: 'intervall', minuten: 360 }, exakt: false });
  });
  it('nicht übersetzbar (Wochentag/Monat/Listen) → täglich 03:00, nicht exakt', () => {
    expect(cronZuTakt('0 3 * * 1')).toEqual({ takt: { art: 'taeglich', um: '03:00' }, exakt: false });
    expect(cronZuTakt('0,30 3 * * *')).toEqual({ takt: { art: 'taeglich', um: '03:00' }, exakt: false });
    expect(cronZuTakt('kaputt')).toEqual({ takt: { art: 'taeglich', um: '03:00' }, exakt: false });
  });
});
