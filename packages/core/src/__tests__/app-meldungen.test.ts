import { describe, it, expect } from 'vitest';
import { AppMeldungsGrenze } from '../geraete/app-meldungen.js';

// v1351 — Fehlermeldungen der App ins Log, ohne Flut bei Fehlerschleifen
describe('AppMeldungsGrenze', () => {
  it('gleicher Text je Gerät höchstens alle 10 min', () => {
    const g = new AppMeldungsGrenze();
    const t = Date.parse('2026-10-11T10:00:00Z');
    expect(g.erlaube('pc', 'Mikrofon: kein Gerät', t)).toBe(true);
    expect(g.erlaube('pc', 'Mikrofon: kein Gerät', t + 60_000)).toBe(false);
    expect(g.erlaube('mac', 'Mikrofon: kein Gerät', t + 60_000)).toBe(true); // anderes Gerät
    expect(g.erlaube('pc', 'Mikrofon: kein Gerät', t + 10 * 60_000)).toBe(true);
  });

  it('höchstens 30 je Stunde und Gerät', () => {
    const g = new AppMeldungsGrenze();
    const t = Date.parse('2026-10-11T10:00:00Z');
    for (let i = 0; i < 30; i++) expect(g.erlaube('pc', `Fehler ${i}`, t + i)).toBe(true);
    expect(g.erlaube('pc', 'Fehler 31', t + 100)).toBe(false);
    expect(g.erlaube('pc', 'Fehler 32', t + 3_600_000 + 50)).toBe(true); // Stunde vorbei
  });
});
