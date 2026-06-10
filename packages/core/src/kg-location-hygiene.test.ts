import { describe, it, expect } from 'vitest';

/**
 * v859 — KG-Location-Hygiene: PLZ-Regex + Plausibility-Gate.
 *
 * Die Regex + isPlausibleLocation sind private/module-level in knowledge-graph.ts.
 * Wir testen die Regex-Semantik hier mit einer identischen Kopie — bewusst:
 * der Test dokumentiert die VERTRAGLICHE Erwartung an das Pattern. Driftet die
 * Implementierung, muss auch dieser Test angepasst werden (Review-Zwang).
 */
const PLZ_CITY_REGEX = /(?<![\d.,])\b(\d{4,5})\s+([A-ZÄÖÜ][a-zäöüß]{2,}(?:[\s-][A-ZÄÖÜ][a-zäöüß]+)?)\b/g;

function plzMatches(text: string): Array<{ plz: string; city: string }> {
  PLZ_CITY_REGEX.lastIndex = 0;
  const out: Array<{ plz: string; city: string }> = [];
  let m;
  while ((m = PLZ_CITY_REGEX.exec(text)) !== null) {
    out.push({ plz: m[1], city: m[2] });
  }
  return out;
}

describe('v859 PLZ_CITY_REGEX — Datums-/Zahlen-Kontexte', () => {
  it('matcht echte PLZ+Stadt', () => {
    expect(plzMatches('Ich wohne in 3033 Altlengbach')).toEqual([{ plz: '3033', city: 'Altlengbach' }]);
    expect(plzMatches('80331 München ist schön')).toEqual([{ plz: '80331', city: 'München' }]);
  });

  it('matcht zweiteilige Städtenamen', () => {
    expect(plzMatches('5760 Saalfelden Land')).toEqual([{ plz: '5760', city: 'Saalfelden Land' }]);
  });

  it('matcht NICHT Jahreszahlen aus Datumsangaben (27.05.2026 Vier Sensoren)', () => {
    // Vor v859: PLZ=2026, Stadt="Vier Sensoren"
    expect(plzMatches('überfällig seit 27.05.2026 Vier Sensoren sind kritisch')).toEqual([]);
  });

  it('matcht NICHT Zahlen nach Komma/Punkt (Zähler in Insight-Texten)', () => {
    expect(plzMatches('Batterie 0,5000 Prozent verbleibend')).toEqual([]);
  });

  it('matcht alleinstehende Insight-Zahlen — Gate übernimmt die Filterung', () => {
    // "(2514 Alerts Backlog)" hat keinen Ziffer/Punkt-Prefix → Regex matcht.
    // DIESE Fälle fängt das isPlausibleLocation-Gate (LOCATION_DISQUALIFIERS).
    expect(plzMatches('UniFi (2514 Alerts Backlog)')).toEqual([{ plz: '2514', city: 'Alerts Backlog' }]);
  });
});

describe('v859 isPlausibleLocation-Vertrag (Disqualifier)', () => {
  // Identische Kopie der v859-Patterns — dokumentiert den Vertrag.
  const LOCATION_DISQUALIFIERS = /\b(cloud|stack|platform|service|engine|server|cluster|virtual|online|digital|smart|hub|lab|edge|node|zone|tier|core|base|space|net|alert|alerts|backlog|sensor|sensoren|gerät|geräte|batterie|batterien|status|assistant|update|updates|backup|backups|event|events|incident|temperatur)\b/i;
  const NUMBER_WORD_PREFIX = /^(ein|eine|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)\s/i;

  const garbage = ['Drei Sensoren', 'Vier Sensoren', 'Drei Temperatur', 'Alerts Backlog', 'Home Assistant', 'Alerts'];
  const real = ['Altlengbach', 'Wien', 'Linz', 'Saalfelden Land', 'München'];

  it.each(garbage)('disqualifiziert Garbage: %s', (name) => {
    const blocked = LOCATION_DISQUALIFIERS.test(name) || NUMBER_WORD_PREFIX.test(name);
    expect(blocked).toBe(true);
  });

  it.each(real)('lässt echte Orte durch: %s', (name) => {
    const blocked = LOCATION_DISQUALIFIERS.test(name) || NUMBER_WORD_PREFIX.test(name);
    expect(blocked).toBe(false);
  });
});
