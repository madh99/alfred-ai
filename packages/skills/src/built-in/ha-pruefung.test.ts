import { describe, it, expect } from 'vitest';
import { pruefe, pruefText, pruefSatz, istAusgenommen, type PruefEingabe, type EntitaetZustand } from './ha-pruefung.js';
import type { AutoZuordnung } from './ha-zuordnung.js';

// v1359 — Haus-Check-Regeln (Owner 12.10.: Grenzen 30/30/7 Tage, Ausnahmen EMS/Batterie/Pool, LEDs, Diagnose)
const JETZT = Date.parse('2026-10-12T08:00:00Z');
const TAG = 86_400_000;
const iso = (tageZurueck: number) => new Date(JETZT - tageZurueck * TAG).toISOString();
const auto = (x: Partial<AutoZuordnung> & { entityId: string; name: string }): AutoZuordnung =>
  ({ aktiv: true, ausloeser: [], bedingungen: [], ziele: [], fehlend: [], letzteAusloesung: iso(1), ...x });

function eingabe(x: Partial<PruefEingabe> = {}): PruefEingabe {
  const zustaende = new Map<string, EntitaetZustand>([
    ['binary_sensor.wk_occupancy', { state: 'off', deviceClass: 'occupancy', name: 'Waschkammerl Belegung' }],
    ['binary_sensor.rauch_gang', { state: 'off', deviceClass: 'smoke', name: 'Rauch Gang' }],
    ['switch.licht_wk', { state: 'off', name: 'LichtWaschkammerl' }],
  ]);
  return {
    jetzt: JETZT, tz: 'Europe/Vienna', zustaende, bereiche: new Map([['switch.licht_wk', { raum: 'Waschkammerl', geraet: 'LichtWaschkammerl' }]]),
    zuordnung: { stand: iso(0), automationen: [] }, deaktiviertSeit: {}, beobachtetSeit: iso(0),
    langNichtVerfuegbar: new Set(), nieAusgeloest: new Set(), aussetzerJeTag: new Map(), ...x,
  };
}

describe('pruefe — Automationen', () => {
  it('A1 fehlende Verweise, A2 lange nicht ausgelöst mit Zustand des Auslösers', () => {
    const b = pruefe(eingabe({
      nieAusgeloest: new Set(['binary_sensor.wk_occupancy']),
      zuordnung: { stand: iso(0), automationen: [
        auto({ entityId: 'automation.strompreis', name: 'Strompreis WARNUNG', fehlend: ['device_tracker.iphone'], ausloeser: ['sensor.preis'] }),
        auto({ entityId: 'automation.wk_ein', name: 'Licht Waschkammerl EIN', ausloeser: ['binary_sensor.wk_occupancy'], letzteAusloesung: iso(40) }),
        auto({ entityId: 'automation.frisch', name: 'Frisch', ausloeser: ['binary_sensor.wk_occupancy'], letzteAusloesung: iso(29) }),
      ] },
    }));
    expect(b.map(x => x.gegenstand)).toEqual(['A1:automation.strompreis', 'A2:automation.wk_ein', 'B2:binary_sensor.wk_occupancy']);
    expect(b[1]!.detail).toContain('Waschkammerl Belegung: 7 Tage nie ausgelöst');
    expect(b[2]!.detail).toContain('Davon abhängig: „Licht Waschkammerl EIN"');
  });

  it('A2: Alarm/Rauch ausgenommen, reine Zeit-Trigger nicht bewertbar, EMS/Pool ausgenommen', () => {
    const b = pruefe(eingabe({ zuordnung: { stand: iso(0), automationen: [
      auto({ entityId: 'automation.feuer', name: 'FeuerGangOben', ausloeser: ['binary_sensor.rauch_gang'], letzteAusloesung: iso(200) }),
      auto({ entityId: 'automation.x', name: 'Rauchmelder-Ende', ausloeser: ['binary_sensor.rauch_gang'], letzteAusloesung: undefined }),
      auto({ entityId: 'automation.checkpoint', name: 'Checkpoint 10:00', ausloeser: [], letzteAusloesung: iso(60) }),
      auto({ entityId: 'automation.pool', name: 'Poolpumpe PV-Überschuss EIN', ausloeser: ['sensor.pv'], letzteAusloesung: iso(60), fehlend: ['sensor.pv'] }),
      auto({ entityId: 'automation.ems', name: 'EMS: manueller Modus Auto-Aus', ausloeser: ['input_boolean.ems'], letzteAusloesung: undefined }),
    ] } }));
    expect(b).toEqual([]);
  });

  it('A3 erst nach 30 Tagen eigener Beobachtung', () => {
    const z = { stand: iso(0), automationen: [auto({ entityId: 'automation.alt', name: 'Alt', aktiv: false }), auto({ entityId: 'automation.neu', name: 'Neu', aktiv: false })] };
    const b = pruefe(eingabe({ zuordnung: z, deaktiviertSeit: { 'automation.alt': iso(31), 'automation.neu': iso(3) } }));
    expect(b.map(x => x.gegenstand)).toEqual(['A3:automation.alt']);
  });
});

describe('pruefe — Geräte', () => {
  it('B1 je Gerät gebündelt; Sitzungen, LEDs und Diagnose ausgenommen', () => {
    const bereiche = new Map([
      ['sensor.ap_cpu', { geraet: 'AP_Halle' }], ['sensor.ap_mem', { geraet: 'AP_Halle' }],
      ['switch.alt_licht', { geraet: 'Licht Stiegenhaus shellyswitch25', raum: 'Gang' }],
    ]);
    const b = pruefe(eingabe({
      bereiche,
      langNichtVerfuegbar: new Set(['sensor.ap_cpu', 'sensor.ap_mem', 'switch.alt_licht', 'media_player.emby_iphone', 'light.ap_halle_led', 'button.ap_halle_restart', 'sensor.victron_soc']),
    }));
    expect(b.map(x => x.titel)).toEqual([
      'AP_Halle: 2 Entitäten seit über 7 Tagen nicht verfügbar',
      'Licht Stiegenhaus shellyswitch25 (Gang): switch.alt_licht seit über 7 Tagen nicht verfügbar',
    ]);
  });

  it('B2 eingefrorene Temperatur ab 48 h, B3 ab 5 Aussetzern pro Tag', () => {
    const zustaende = new Map<string, EntitaetZustand>([
      ['sensor.kueche_temp', { state: '24.76', deviceClass: 'temperature', lastChanged: iso(3), name: 'Küche Temperatur' }],
      ['sensor.bad_temp', { state: '22.1', deviceClass: 'temperature', lastChanged: iso(1), name: 'Bad Temperatur' }],
      ['sensor.batt', { state: '100', deviceClass: 'battery', lastChanged: iso(9) }],
      ['switch.licht_wk', { state: 'off', name: 'LichtWaschkammerl' }],
    ]);
    const b = pruefe(eingabe({ zustaende, aussetzerJeTag: new Map([['switch.licht_wk', 21.9], ['switch.ok', 2]]) }));
    expect(b.map(x => x.titel)).toEqual(['Küche Temperatur: Wert 24.76 seit 72 h unverändert', 'LichtWaschkammerl (Waschkammerl): 21,9 kurze Verbindungsaussetzer pro Tag']);
  });

  it('Ausnahmen', () => {
    expect(istAusgenommen('sensor.emhass_plan')).toBe(true);
    expect(istAusgenommen('switch.poolpumpe')).toBe(true);
    expect(istAusgenommen('light.u7_pro_led')).toBe(true);
    expect(istAusgenommen('update.shelly_firmware')).toBe(true);
    expect(istAusgenommen('switch.lichtwaschkammerl')).toBe(false);
    expect(istAusgenommen('sensor.systems_status')).toBe(false); // „ems" nur als eigenes Wort
  });
});

describe('Ausgabe', () => {
  it('Text gruppiert nach Regel und nennt die Beobachtung deaktivierter Automationen; Satz für Telegram', () => {
    const b = pruefe(eingabe({ zuordnung: { stand: iso(0), automationen: [auto({ entityId: 'automation.a', name: 'A', fehlend: ['sensor.weg'] })] } }));
    const t = pruefText(b, { tz: 'Europe/Vienna', jetzt: JETZT, deaktiviert: 15, beobachtetSeit: iso(0), hinweise: [] });
    expect(t).toContain('### A1 — Automation verweist auf fehlende Entität oder fehlendes Gerät (1)');
    expect(t).toContain('15 deaktivierte Automationen');
    expect(pruefSatz({ neu: 3, offen: 12, erledigt: 0 })).toBe('🏠 Haus-Check: 3 neu, 12 offen — Details in der App unter „Befunde" › Haus-Check.');
  });
});
