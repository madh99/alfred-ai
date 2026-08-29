import { describe, it, expect } from 'vitest';
import { spaetestesDatumImText, istInsightEcho, extrahiereAnwesenheit } from '../reasoning-context-collector.js';
import { DegradedTracker } from '@alfred/llm';

// v1143 — Regressionstests zum Gamescom-Fall (29.08.2026): veralteter Kontext
// wurde als Gegenwart präsentiert („Rückfahrt von Köln planen" zwei Tage nach
// der Rückkehr), Alfreds eigene Ausgaben wurden als Wissen recycelt, und der
// Degraded-Betrieb produzierte wochenlang Notmodell-Müll.

describe('J1 — spaetestesDatumImText', () => {
  const jetzt = new Date(2026, 7, 29, 12); // 29.08.2026

  it('Realfall: „Do 27.08. 02:00 Uhr" ohne Jahr wird als 27.08. des aktuellen Jahres erkannt', () => {
    const d = spaetestesDatumImText('BMW i4 Ladeplanung für gamescom-Fahrt (Do 27.08. 02:00 Uhr) – DRINGEND', jetzt);
    expect(d?.getDate()).toBe(27);
    expect(d?.getMonth()).toBe(7);
    expect(d?.getFullYear()).toBe(2026);
  });

  it('ISO-Datum und deutsches Datum: das späteste gewinnt', () => {
    const d = spaetestesDatumImText('Termin 2026-08-25, verschoben auf 30.08.2026', jetzt);
    expect(d?.getDate()).toBe(30);
  });

  it('Versionsnummern und unplausible Werte sind keine Daten', () => {
    expect(spaetestesDatumImText('Update auf v0.19.0 und 42.13. installiert', jetzt)).toBe(null);
  });

  it('Text ohne Datum → null', () => {
    expect(spaetestesDatumImText('Wallbox lädt mit 11 kW', jetzt)).toBe(null);
  });
});

describe('J2 — istInsightEcho', () => {
  it('Realfall: der gespeicherte Gamescom-Insight wird als Echo erkannt', () => {
    expect(istInsightEcho('**🚗 BMW i4 Ladeplanung für gamescom-Fahrt (Do 27.08. 02:00 Uhr) – DRINGEND AKTUALISIEREN**\nAktueller SoC (31%) reicht nicht')).toBe(true);
    expect(istInsightEcho('SoC prüfen. → *Aktion: Routenberechnung mit Ladeoptionen vorschlagen*')).toBe(true);
  });

  it('echte Fakten sind kein Echo', () => {
    expect(istInsightEcho('Mutter wohnt in Eichgraben')).toBe(false);
    expect(istInsightEcho('User bevorzugt Antworten auf Deutsch')).toBe(false);
  });
});

describe('J4 — extrahiereAnwesenheit', () => {
  it('person-Zeilen werden zu einer Anwesenheits-Zeile', () => {
    const ha = '| person.madh | home | Markus |\n| person.alexandra | not_home | Alexandra |\n| light.wohnzimmer | on | - |';
    const zeile = extrahiereAnwesenheit(ha);
    expect(zeile).toContain('madh: zuhause');
    expect(zeile).toContain('alexandra: abwesend');
    expect(zeile).toContain('KÜNFTIGES Ereignis');
  });

  it('ohne person-Zeilen → null', () => {
    expect(extrahiereAnwesenheit('| light.garage | off |')).toBe(null);
  });
});

describe('A — DegradedTracker (Hysterese)', () => {
  it('erst nach minDegradedMs durchgehendem Doppel-Ausfall degradiert', () => {
    const t = new DegradedTracker(3_600_000, 1_800_000); // 1h Schwelle, 30min Stabilität
    const start = 1_000_000_000;
    t.beobachte(true, start);
    expect(t.istDegradiert(start)).toBe(false);
    t.beobachte(true, start + 3_599_000);
    expect(t.istDegradiert(start + 3_599_000)).toBe(false);
    t.beobachte(true, start + 3_600_000);
    expect(t.istDegradiert(start + 3_600_000)).toBe(true);
  });

  it('kurze Lücken (< Stabilitätsfenster) unterbrechen die Degradierung NICHT', () => {
    const t = new DegradedTracker(3_600_000, 1_800_000);
    const start = 0;
    t.beobachte(true, start);
    t.beobachte(false, start + 600_000); // 10 min Lücke (Cooldown gerade abgelaufen)
    t.beobachte(true, start + 1_200_000);
    t.beobachte(true, start + 3_600_000);
    expect(t.istDegradiert(start + 3_600_000)).toBe(true);
  });

  it('30 min stabiler Betrieb ohne Doppel-Ausfall → Entwarnung', () => {
    const t = new DegradedTracker(3_600_000, 1_800_000);
    t.beobachte(true, 0);
    t.beobachte(true, 3_600_000);
    expect(t.istDegradiert(3_600_000)).toBe(true);
    t.beobachte(false, 3_600_000 + 1_900_000); // >30 min ohne Doppel-Ausfall
    expect(t.istDegradiert(3_600_000 + 1_900_000)).toBe(false);
  });

  it('echter Erfolg auf einem Denk-Tier entwarnt sofort', () => {
    const t = new DegradedTracker(3_600_000, 1_800_000);
    t.beobachte(true, 0);
    t.beobachte(true, 4_000_000);
    expect(t.istDegradiert(4_000_000)).toBe(true);
    t.erfolg();
    expect(t.istDegradiert(4_000_000)).toBe(false);
  });
});
