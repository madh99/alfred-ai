import { describe, it, expect } from 'vitest';
import { deuteHaus } from '../normalzustaende/haus.js';
import { befundeAusDeutung, quelleZuKategorie } from '../ereignisse/befunde.js';
import { haltefristMin, nieStummschaltbar } from '../vorgaenge/regeln.js';

// v1371 — Nachforschen N0(a): die Haus-Deutung wird Befund-Quelle „haus" (Identität, Regeln, Haltefristen, Lage)
const z = (entity_id: string, state: string, device_class?: string, friendly_name?: string) => ({ entity_id, state, attributes: { device_class, friendly_name }, last_changed: '2026-10-12T10:01:00Z' });

describe('Haus-Deutung → Befunde', () => {
  it('offen bei Abwesenheit: ein Befund je Fenster, Kategorie haus, Haltefrist wie Ausfall', () => {
    const d = deuteHaus([z('person.madh', 'not_home'), z('person.lena', 'not_home'), z('binary_sensor.fenster_lena', 'on', 'window', 'Fenster Lena'), z('binary_sensor.haustuer', 'off', 'door', 'Haustür')]);
    const b = befundeAusDeutung('haus', d);
    expect(b.map(x => x.gegenstand)).toEqual(['haus:offen-bei-abwesenheit:binary_sensor.fenster_lena']);
    expect(b[0]!.titel).toContain('Fenster Lena');
    expect(quelleZuKategorie('haus')).toBe('haus');
    expect(haltefristMin({ quelle: 'haus', gegenstand: b[0]!.gegenstand })).toBe(120);
  });

  it('jemand zu Hause: offenes Fenster ist kein Befund (Realfall „Fenster Lena" 12.10.: madh zu Hause)', () => {
    const d = deuteHaus([z('person.madh', 'home'), z('person.lena', 'not_home'), z('binary_sensor.fenster_lena', 'on', 'window', 'Fenster Lena')]);
    expect(befundeAusDeutung('haus', d)).toEqual([]);
  });

  it('Rauch und Wasser: sofort und nie stummschaltbar', () => {
    const d = deuteHaus([z('person.madh', 'home'), z('binary_sensor.rauchmelder_kueche', 'on', 'smoke', 'Rauchmelder Küche'), z('binary_sensor.wasser_keller', 'on', 'moisture', 'Wasser Keller')]);
    const b = befundeAusDeutung('haus', d);
    expect(b.map(x => x.gegenstand).sort()).toEqual(['haus:rauch:binary_sensor.rauchmelder_kueche', 'haus:wasser:binary_sensor.wasser_keller']);
    for (const x of b) {
      expect(haltefristMin({ quelle: 'haus', gegenstand: x.gegenstand })).toBe(0);
      expect(nieStummschaltbar({ quelle: 'haus', gegenstand: x.gegenstand })).toBe(true);
    }
  });
});
