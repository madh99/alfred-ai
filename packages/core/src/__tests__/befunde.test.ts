import { describe, it, expect } from 'vitest';
import { befundeAusDeutung, quelleZuKategorie, bereinigeZeile } from '../ereignisse/befunde.js';

// v1217 — Jarvis Schicht 3: Befunde mit Identität aus den Deutungen des Weltmodells.
describe('befundeAusDeutung', () => {
  it('ordnet jedem auffälligen Schlüssel die passende ⚠️-Zeile als Titel zu', () => {
    const d = {
      zeilen: [
        '**Sensorbatterien:** 12 Sensoren · niedrigster ok 61 %',
        '⚠️ Temp Terrasse: nicht erreichbar (zuletzt 05.10. 13:20) → Sensor prüfen',
        '⚠️ Wohnzimmer Fenster: 8 % (−3 %/Tag) → in ~2 Tagen tauschen',
      ],
      auffaellig: ['sensorbatterie:sensor.temp_terrasse_battery:offline', 'sensorbatterie:sensor.wohnzimmer_fenster_battery:niedrig'],
    };
    const b = befundeAusDeutung('sensorbatterien', d);
    expect(b.map(x => x.gegenstand)).toEqual(d.auffaellig);
    expect(b[0].titel).toBe('Temp Terrasse: nicht erreichbar (zuletzt 05.10. 13:20) → Sensor prüfen');
    expect(b[1].titel).toBe('Wohnzimmer Fenster: 8 % (−3 %/Tag) → in ~2 Tagen tauschen');
    expect(b[0].detail).toContain('Sensorbatterien: 12 Sensoren');
  });
  it('v1218 Realfall: mehrere Sensoren in EINER Zeile mit „ · " → Titel ist das passende ⚠️-Segment', () => {
    const zeile = '**Sensorbatterien:** 20 Sensoren · Holztüre Garage Batterie: 50 % (Trend im Aufbau) ↳ beobachten · ⚠️ Terrasse Temp Terrasse Batterie: nicht erreichbar (zuletzt 05.10. 13:20) → Sensor prüfen · niedrigster ok 61 %';
    const b = befundeAusDeutung('sensorbatterien', { zeilen: [zeile], auffaellig: ['sensorbatterie:sensor.terrasse_temp_terrasse_batterie:offline'] });
    expect(b[0].titel).toBe('Terrasse Temp Terrasse Batterie: nicht erreichbar (zuletzt 05.10. 13:20) → Sensor prüfen');
  });
  it('eine einzige ⚠️-Zeile gilt für den einen Schlüssel; ohne Zeile generischer Titel; Duplikate und leer', () => {
    expect(befundeAusDeutung('energie', { zeilen: ['**Hausbatterie:** 12 % ⚠️ niedrig (≤ 15 %)'], auffaellig: ['hausbatterie:niedrig'] })[0].titel).toBe('Hausbatterie: 12 % ⚠️ niedrig (≤ 15 %)');
    expect(befundeAusDeutung('mikrotik', { zeilen: ['Interfaces: 8 up'], auffaellig: ['mikrotik:ether5:neu-down'] })[0].titel).toBe('mikrotik: mikrotik:ether5:neu-down');
    expect(befundeAusDeutung('bmw', { zeilen: [], auffaellig: ['mqtt', 'mqtt'] })).toHaveLength(1);
    expect(befundeAusDeutung('bmw', undefined)).toEqual([]);
  });
  it('Quelle → Kategorie der Vorgänge; Zeilen werden bereinigt', () => {
    expect(quelleZuKategorie('sensorbatterien')).toBe('haus');
    expect(quelleZuKategorie('mikrotik')).toBe('infra');
    expect(quelleZuKategorie('bmw')).toBe('bmw');
    expect(bereinigeZeile('**⚠️ ALARM:** Rauch Küche ausgelöst')).toBe('ALARM: Rauch Küche ausgelöst');
  });
});
