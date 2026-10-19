import { describe, it, expect } from 'vitest';
import { zeitplanText } from '../gespraeche.js';

/** v1504 — Rückmeldung „Geplant: …“ auf Deutsch statt „Scheduled action created … running "undefined"“ (Live-Probe 19.10.). */
describe('v1504 zeitplanText', () => {
  it('täglich, wöchentlich, einmalig (Ortszeit Wien)', () => {
    expect(zeitplanText('cron', '5 8 * * *')).toBe('täglich um 08:05');
    expect(zeitplanText('cron', '30 19 * * 1')).toBe('jeden Montag um 19:30');
    expect(zeitplanText('cron', '0 9 * * 0')).toBe('jeden Sonntag um 09:00');
    expect(zeitplanText('once', '2026-10-20T01:00:00.000Z')).toBe('einmalig am 20.10.2026 um 03:00');
  });
  it('anderes Muster bleibt sichtbar', () => {
    expect(zeitplanText('cron', '*/15 * * * *')).toBe('nach Plan „*/15 * * * *“');
    expect(zeitplanText('once', 'kaputt')).toBe('einmalig (kaputt)');
  });
});
