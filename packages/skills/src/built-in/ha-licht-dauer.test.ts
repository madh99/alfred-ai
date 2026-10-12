import { describe, it, expect } from 'vitest';
import { werteAus, lichtDauerAuffaellig, type HaZustand } from './ha-verlauf.js';

// v1371 — Nachforschen N0(b): Messlatte Waschkammerl 11.10. (14,8 statt 9,8 h/Tag an)
const H = 3_600_000;
const jetzt = Date.parse('2026-10-12T04:00:00Z');
function reihe(anJeTagStd: number[], start: number): HaZustand[] {
  const r: HaZustand[] = [];
  anJeTagStd.forEach((h, i) => {
    const tag = start + i * 24 * H;
    r.push({ state: 'on', last_changed: new Date(tag + 6 * H).toISOString() });
    r.push({ state: 'off', last_changed: new Date(tag + 6 * H + h * H).toISOString() });
  });
  return r;
}
const aktuell = { von: jetzt - 24 * H, bis: jetzt };
const vergleich = { von: aktuell.von - 7 * 24 * H, bis: aktuell.von };

describe('lichtDauerAuffaellig', () => {
  it('deutlich länger an als in den 7 Tagen davor → auffällig', () => {
    const r = reihe([10, 9, 10, 10, 9, 10, 10, 16], vergleich.von);
    const b = { entityId: 'light.waschkammerl', aktuell: werteAus(r, aktuell, 'Europe/Vienna'), vergleich: werteAus(r, vergleich, 'Europe/Vienna') };
    // 16 h gegen den Schnitt davor (Datenbeginn erst 06:00 am ersten Vergleichstag → ~10 h/Tag)
    expect(lichtDauerAuffaellig(b, jetzt)).toMatch(/^an am Stück 16,0 h, an 16,0 statt 10,\d h\/Tag$/);
  });
  it('wie üblich → nichts', () => {
    const r = reihe([10, 9, 10, 10, 9, 10, 10, 10], vergleich.von);
    const b = { entityId: 'light.gang', aktuell: werteAus(r, aktuell, 'Europe/Vienna'), vergleich: werteAus(r, vergleich, 'Europe/Vienna') };
    expect(lichtDauerAuffaellig(b, jetzt)).toBeNull();
  });
});
