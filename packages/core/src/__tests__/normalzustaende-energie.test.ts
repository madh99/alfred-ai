import { describe, it, expect } from 'vitest';
import { median, mad, bewerteGegenBaseline, trendProStunde } from '../normalzustaende/baseline.js';
import { deuteEnergie, rolleVon, ladeplanLiegtZurueck, type EnergieMesswert } from '../normalzustaende/energie.js';

// Jarvis Schicht 1, Quelle Energie & Haus — Realdaten Home Assistant 05.10.2026 02:55.
const JETZT = new Date(2026, 9, 5, 2, 55);
const iso = (d: Date) => d.toISOString();

const AKTUELL: EnergieMesswert[] = [
  { entity: 'sensor.victron_system_battery_soc', name: 'settings Battery soc', wert: 65, einheit: '%', zeit: iso(JETZT) },
  { entity: 'sensor.victron_system_battery_power', name: 'settings Battery power', wert: -357, einheit: 'W', zeit: iso(JETZT) },
  { entity: 'sensor.victron_system_battery_state', name: 'settings Battery state', text: 'DISCHARGING', zeit: iso(JETZT) },
  { entity: 'sensor.battery_charge_plan_text', name: 'Ladeplan (Batterie)', text: '🔋 Ladefenster: Sat, 18.07. 15:00 – 15:30 (0.5 h)', zeit: iso(JETZT) },
  { entity: 'sensor.pv_power_ges', name: 'PV Gesamt Power', wert: 0, einheit: 'W', zeit: iso(JETZT) },
  { entity: 'sensor.0x00158d000320aede_0x00158d000320aede_temperature', name: 'Wohnzimmer Temp Temperatur', wert: 22.36, einheit: '°C', zeit: iso(JETZT) },
  { entity: 'sensor.daily_energy_kwh', name: 'Daily Energy in kWh', wert: 0.049, einheit: 'kWh', zeit: iso(JETZT) },
  { entity: 'sensor.pv_prod_ges', name: 'PV Ertrag Tag Gesamt', wert: 0, einheit: 'kWh', zeit: iso(JETZT) },
  { entity: 'input_boolean.battery_charge_allowed', name: 'Akku laden erlaubt', text: 'off', zeit: iso(JETZT) },
];

/** SoC-Verlauf wie am 03./04.10.: 14:00 100 %, dann fallend bis 55 % um 07:00, danach leicht steigend. */
function socVerlauf(): EnergieMesswert[] {
  const out: EnergieMesswert[] = [];
  const start = new Date(2026, 9, 3, 12, 0);
  const werte = [95, 96, 100, 99, 94, 90, 83, 77, 73, 71, 69, 67, 66, 65, 63, 62, 61, 59, 58, 55, 57, 58];
  werte.forEach((w, i) => out.push({ entity: 'sensor.victron_system_battery_soc', wert: w, einheit: '%', zeit: iso(new Date(start.getTime() + i * 3600_000)) }));
  // bis „jetzt" weiter: 04.10. 10:00 → 05.10. 02:55 fallend auf 65 … (vereinfachte Punkte)
  out.push({ entity: 'sensor.victron_system_battery_soc', wert: 72, einheit: '%', zeit: iso(new Date(2026, 9, 5, 0, 55)) });
  out.push({ entity: 'sensor.victron_system_battery_soc', wert: 68, einheit: '%', zeit: iso(new Date(2026, 9, 5, 1, 55)) });
  return out;
}

describe('baseline', () => {
  it('median/mad robust; Baseline im Aufbau unter 10 Stichproben; Ausreißer ≥ 3σ auffällig', () => {
    expect(median([1, 5, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(mad([10, 10, 10, 10, 100], 10)).toBe(0);
    const wenige = Array.from({ length: 5 }, (_, i) => ({ wert: 20 + i, zeit: iso(new Date(2026, 9, 1 + i, 3, 0)) }));
    expect(bewerteGegenBaseline(21, iso(JETZT), wenige).urteil).toBe('im-aufbau');
    const viele = Array.from({ length: 14 }, (_, i) => ({ wert: 22 + (i % 3) * 0.2, zeit: iso(new Date(2026, 8, 20 + i, 3, 0)) }));
    expect(bewerteGegenBaseline(22.3, iso(JETZT), viele).urteil).toBe('normal');
    expect(bewerteGegenBaseline(15, iso(JETZT), viele).urteil).toBe('auffaellig');
  });
  it('trendProStunde aus den letzten 2 h', () => {
    const p = [{ wert: 72, zeit: iso(new Date(2026, 9, 5, 0, 55)) }, { wert: 68, zeit: iso(new Date(2026, 9, 5, 1, 55)) }, { wert: 65, zeit: iso(JETZT) }];
    expect(trendProStunde(p, JETZT)).toBeCloseTo(-3.5, 1);
  });
});

describe('rolleVon / ladeplanLiegtZurueck', () => {
  it('erkennt die Realentitäten', () => {
    expect(rolleVon({ entity: 'sensor.victron_system_battery_soc' })).toBe('soc');
    expect(rolleVon({ entity: 'sensor.victron_system_ess_minimum_soc' })).toBe('minSoc');
    expect(rolleVon({ entity: 'sensor.victron_system_battery_power' })).toBe('power');
    expect(rolleVon({ entity: 'input_boolean.battery_charge_allowed' })).toBe('allowed');
    expect(rolleVon({ entity: 'sensor.pv_power_ges' })).toBe('pvPower');
    expect(rolleVon({ entity: 'sensor.pv_prod_ges' })).toBe('pvToday');
    expect(rolleVon({ entity: 'sensor.energie_bedarfd_ges' })).toBe('consumptionToday');
    expect(rolleVon({ entity: 'sensor.0x00158d000320aede_0x00158d000320aede_temperature', einheit: '°C' })).toBe('temperature');
  });
  it('Ladeplan vom 18.07. liegt am 05.10. zurück', () => {
    expect(ladeplanLiegtZurueck('🔋 Ladefenster: Sat, 18.07. 15:00 – 15:30 (0.5 h)', JETZT)).toBe(true);
    expect(ladeplanLiegtZurueck('🔋 Ladefenster: Mon, 06.10. 13:00 – 14:00', JETZT)).toBe(false);
    expect(ladeplanLiegtZurueck('kein Ladefenster', JETZT)).toBeUndefined();
  });
});

describe('deuteEnergie', () => {
  it('Realfall 05.10. 02:55: Hausbatterie 65 %, entlädt, Vollladung 03.10. 14:00, Ladeplan vergangen, PV nachts normal', () => {
    const d = deuteEnergie({ aktuell: AKTUELL, verlauf: socVerlauf(), jetzt: JETZT })!;
    const text = d.zeilen.join('\n');
    expect(text).toMatch(/\*\*Hausbatterie:\*\* SoC 65 % · entlädt 357 W · −3,5 %\/h/);
    expect(text).toMatch(/Vollladung zuletzt 03\.10\. 15:00 \(vor 36 h\)/); // 99 % um 15:00 zählt als Vollladung (≥ 99)
    expect(text).toMatch(/Baseline im Aufbau/);
    expect(text).toMatch(/nicht Teil der BMW-Fahrtplanung/);
    expect(text).toMatch(/Netzladung erlaubt: nein \(setzt die Automation\) · Ladeplan: „🔋 Ladefenster: Sat, 18\.07\./);
    expect(text).toMatch(/Fenster liegt in der Vergangenheit — derzeit KEIN geplantes Ladefenster/);
    expect(text).toMatch(/\*\*PV:\*\* PV 0 W · Ertrag heute 0 kWh · Verbrauch heute 0,05 kWh · ↳ nachts 0 W NORMAL/);
    expect(text).toMatch(/\*\*Wohnzimmer Temp Temperatur:\*\* 22,4 °C ↳ Baseline im Aufbau/);
    expect(d.auffaellig).toEqual([]);
  });

  it('Realfall ESS-Mindest-SoC: 15 % ist Konfiguration — eigene Zeile, kein Alarm; niedriger echter SoC wird markiert', () => {
    const d = deuteEnergie({
      aktuell: [
        { entity: 'sensor.victron_system_ess_minimum_soc', wert: 15, einheit: '%', zeit: iso(JETZT) },
        { entity: 'sensor.victron_system_battery_soc', wert: 18, einheit: '%', zeit: iso(JETZT) },
      ], verlauf: [], jetzt: JETZT,
    })!;
    const text = d.zeilen.join('\n');
    expect(text).toMatch(/\*\*Mindest-SoC:\*\* 15 % — Konfiguration \(ESS-Untergrenze\), KEIN aktueller Ladestand/);
    expect(text).toMatch(/\*\*Hausbatterie:\*\* SoC 18 %.*⚠️ niedrig/);
    expect(d.auffaellig).toEqual(['hausbatterie:niedrig']);
  });

  it('Regel Lademanagement: 30 Tage Verlauf ohne 100 % → Hinweis; mit Baseline wird ein Ausreißer markiert', () => {
    const verlauf: EnergieMesswert[] = [];
    for (let t = 0; t < 31 * 24; t += 1) {
      verlauf.push({ entity: 'sensor.victron_system_battery_soc', wert: 50 + (t % 24), einheit: '%', zeit: iso(new Date(JETZT.getTime() - t * 3600_000)) });
    }
    const d = deuteEnergie({ aktuell: [{ entity: 'sensor.victron_system_battery_soc', wert: 95, einheit: '%', zeit: iso(JETZT) }], verlauf, jetzt: JETZT })!;
    const text = d.zeilen.join('\n');
    expect(text).toMatch(/⚠️ seit über 30 Tagen keine Vollladung \(Regel Lademanagement\)/);
    expect(text).toMatch(/⚠️ deutlich über der Baseline dieser Stunde/);
    expect(d.auffaellig).toEqual(expect.arrayContaining(['hausbatterie:vollladung', 'hausbatterie:baseline']));
  });

  it('ohne Werte: undefined', () => {
    expect(deuteEnergie({ aktuell: [], verlauf: [], jetzt: JETZT })).toBeUndefined();
  });
});
