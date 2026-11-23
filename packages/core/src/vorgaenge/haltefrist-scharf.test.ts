import { describe, it, expect } from 'vitest';
import { vorgangFaellig, faelligOhneVorgang } from './regeln.js';

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

/**
 * v1938 — Realfall 23.11. 14:13: nach v1937 legte die Frist-Prüfung Vorgänge für Befunde an, die bewusst nie einen
 * Vorgang bekamen (licht „beobachtend“, cmdb-umgebung, beobachter) → 91b2204d, 99ef9198. Fällig werden nur Befunde
 * aus dem Weltmodell-Weg, der auch bisher Vorgänge anlegte.
 */
describe('v1938 E2 — nur Befunde aus dem Weltmodell-Weg', () => {
  const alt = '2026-11-23T00:00:00Z';
  const b = (quelle: string, vorgangId?: string) => ({ quelle, gegenstand: `${quelle}:x`, entstanden: alt, vorgangId });
  it('licht, cmdb-umgebung, beobachter, lebenszeichen, haus-check bleiben ohne Vorgang', () => {
    const r = faelligOhneVorgang([b('licht'), b('cmdb-umgebung'), b('beobachter'), b('lebenszeichen'), b('haus-check')], new Set(['infra']), min(600));
    expect(r).toEqual([]);
  });
  it('Weltmodell-Quelle nach Frist ohne Vorgang → fällig; mit Vorgang oder innerhalb Frist → nicht', () => {
    const r = faelligOhneVorgang([b('infra'), b('infra', 'v1'), { quelle: 'infra', gegenstand: 'neu', entstanden: '2026-11-23T09:30:00Z' }], new Set(['infra']), t0);
    expect(r.map(x => x.gegenstand)).toEqual(['infra:x']);
  });
  it('leere Quellen-Menge (frisch nach Neustart) → nichts fällig (fail-closed bis zum ersten Sync)', () => {
    expect(faelligOhneVorgang([b('infra')], new Set(), min(600))).toEqual([]);
  });
});
