import { describe, it, expect } from 'vitest';
import { vorgangFaellig } from './regeln.js';

/**
 * v1937 — Block 26.10. (Owner 23.11. „ok“): E2-Haltefrist scharf. Auswertung seit 12.10.: infra 60 von 73 Befund-Vorgängen
 * waren innerhalb von 120 min von selbst erledigt, haus 11 von 11 — ein Vorgang entsteht erst nach Ablauf der Haltefrist.
 */
const t0 = Date.parse('2026-11-23T10:00:00Z');
const min = (m: number) => t0 + m * 60_000;

describe('v1937 E2 — Vorgang erst nach der Haltefrist', () => {
  it('Sicherheit (Rauch, Wasser, Lebenszeichen) sofort', () => {
    expect(vorgangFaellig({ quelle: 'haus', gegenstand: 'rauchmelder_flur' }, '2026-11-23T10:00:00Z', t0)).toBe('sofort');
    expect(vorgangFaellig({ quelle: 'lebenszeichen', gegenstand: 'job:x' }, '2026-11-23T10:00:00Z', t0)).toBe('sofort');
  });
  it('infra-RAM: unter 120 min warten, ab 120 min fällig', () => {
    const s = { quelle: 'infra', gegenstand: 'proxmox:win11-dev:ram' };
    expect(vorgangFaellig(s, '2026-11-23T10:00:00Z', min(119))).toBe('warten');
    expect(vorgangFaellig(s, '2026-11-23T10:00:00Z', min(120))).toBe('faellig');
  });
  it('Batterie 24 h', () => {
    const s = { quelle: 'sensorbatterien', gegenstand: 'temp_terrasse' };
    expect(vorgangFaellig(s, '2026-11-23T10:00:00Z', min(23 * 60))).toBe('warten');
    expect(vorgangFaellig(s, '2026-11-23T10:00:00Z', min(24 * 60))).toBe('faellig');
  });
  it('Haus-Check nie', () => {
    expect(vorgangFaellig({ quelle: 'haus-check', gegenstand: 'A1:x' }, '2026-11-23T10:00:00Z', min(10_000))).toBe('nie');
  });
  it('unlesbarer Zeitpunkt → fällig (lieber melden als verschlucken)', () => {
    expect(vorgangFaellig({ quelle: 'infra', gegenstand: 'x' }, 'kaputt', t0)).toBe('faellig');
  });
});

describe('v1937 E2 — Abwesenheits-Meldungen bleiben sofort (möglicher Einbruch)', () => {
  it('Bewegung oder offen bei Abwesenheit → sofort, nicht 120 min', () => {
    expect(vorgangFaellig({ quelle: 'haus', gegenstand: 'haus:bewegung-bei-abwesenheit:binary_sensor.praesenz_radar_1_occupancy' }, '2026-11-23T10:00:00Z', t0)).toBe('sofort');
    expect(vorgangFaellig({ quelle: 'haus', gegenstand: 'haus:offen-bei-abwesenheit:binary_sensor.x_contact' }, '2026-11-23T10:00:00Z', t0)).toBe('sofort');
  });
});
