import { describe, it, expect } from 'vitest';
import { spaetestesDatumImText, istInsightEcho, extrahiereAnwesenheit } from '../reasoning-context-collector.js';

// v1143 — Regressionstests zum Gamescom-Fall (29.08.2026): veralteter Kontext
// wurde als Gegenwart präsentiert („Rückfahrt von Köln planen" zwei Tage nach
// der Rückkehr) und Alfreds eigene Ausgaben wurden als Wissen recycelt. Die
// Leitplanken sind DETERMINISTISCH — sie funktionieren mit jedem Modell,
// vom Not-Fallback bis zum Top-Tier (bewusster Grundsatz dieses Systems).

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

