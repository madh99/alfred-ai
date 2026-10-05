import { describe, it, expect } from 'vitest';
import { deuteSensorbatterien, klassifiziere, trendProTag, type SensorBatterie } from '../normalzustaende/sensorbatterien.js';

// Jarvis Schicht 1, Quelle Sensorbatterien — Realdaten Home Assistant 05.10.2026 03:16 (32 device_class=battery).
const JETZT = new Date('2026-10-05T01:16:00Z');
const S = (entity: string, name: string, wert: number | undefined, zeit = '2026-10-04T12:11:00Z', verfuegbar = true): SensorBatterie => ({ entity, name, wert, zeit, verfuegbar });

const REAL: SensorBatterie[] = [
  S('sensor.sm_s928b_battery_level', 'SM-S928B Battery level', 0),
  S('sensor.terrasse_temp_terrasse_batterie', 'Temp Terrasse  Batterie', 0, '2026-09-27T12:11:00Z'),
  S('sensor.victron_settings_ess_batterylife_soclimit', 'settings Ess batterylife soclimit', 15),
  S('sensor.alex_i_phone_battery_level', 'Alex i-phone Battery Level', 35),
  S('sensor.0x00158d00047db98d_0x00158d00047db98d_battery', 'Holztüre Garage Batterie', 50),
  S('sensor.victron_system_battery_soc', 'settings Battery soc', 64),
  S('sensor.0x00178801086482eb_battery', 'B_Garage Batterie', 72.5),
  S('sensor.temp_badezimmer_temp_badezimmer_battery', 'TEMP_BADEZIMMER Batterie', 77),
  S('sensor.iphone_15_pro_max_madh_battery_level', 'iPhone 15 pro max Madh Battery Level', 80),
  S('sensor.smokelinus_battery', 'shellyplussmoke-a0a3b3e66078 SmokeLinus battery', 88),
  S('sensor.wetterstation_battery', 'Wetterstation Batterie', 100),
  S('sensor.0x00158d00045cbb2c_0x00158d00045cbb2c_battery', 'Garagentor Batterie', 100),
  S('sensor.victron_settings_ess_batterylife_minimumsoc', 'settings Ess batterylife minimumsoc', undefined, '2026-10-04T12:11:00Z', false),
  S('sensor.victron_vebus_soc_227', 'vebus Soc', undefined, '2026-10-04T12:11:00Z', false),
];

describe('klassifiziere', () => {
  it('trennt Mobilgeräte, Konfiguration, Hausbatterie und echte Sensoren', () => {
    expect(klassifiziere('sensor.sm_s928b_battery_level', 'SM-S928B Battery level')).toBe('mobilgeraet');
    expect(klassifiziere('sensor.alex_i_phone_watch_battery_level')).toBe('mobilgeraet');
    expect(klassifiziere('sensor.victron_settings_ess_batterylife_soclimit')).toBe('konfiguration');
    expect(klassifiziere('sensor.victron_settings_ess_batterylife_minimumsoc')).toBe('konfiguration');
    expect(klassifiziere('sensor.victron_system_battery_soc')).toBe('hausbatterie');
    expect(klassifiziere('sensor.victron_vebus_soc_227')).toBe('hausbatterie');
    expect(klassifiziere('sensor.0x00158d00047db98d_0x00158d00047db98d_battery', 'Holztüre Garage Batterie')).toBe('sensor');
    expect(klassifiziere('sensor.smokelinus_battery', 'shellyplussmoke SmokeLinus battery')).toBe('sensor');
  });
});

describe('deuteSensorbatterien', () => {
  it('Realfall: Terrasse 0 % seit 8 Tagen → Sensor meldet nicht; Holztüre Garage 50 % normal; Handys und ESS-Limit getrennt; Hausbatterie ausgelassen', () => {
    const d = deuteSensorbatterien({ sensoren: REAL, verlauf: [], jetzt: JETZT })!;
    const text = d.zeilen.join('\n');
    expect(text).toMatch(/\*\*Sensorbatterien:\*\* 7 Sensoren · ⚠️ Temp Terrasse {2}Batterie: 0 % leer → Batterie tauschen — Wert unverändert seit 8 Tagen, vermutlich meldet der Sensor nicht mehr · Holztüre Garage Batterie: 50 % \(Trend im Aufbau\) ↳ NORMAL, kein Handlungsbedarf · übrige ≥ 72,5 % ↳ NORMAL/);
    expect(text).toMatch(/\*\*Mobilgeräte:\*\* 3 Handys\/Watches erfasst — laden sich selbst, NICHT bewerten/);
    expect(text).toMatch(/\*\*Konfiguration:\*\* settings Ess batterylife soclimit 15 % — Einstellwert/);
    expect(text).not.toMatch(/Battery soc|vebus/);
    expect(d.auffaellig).toEqual(['sensorbatterie:sensor.terrasse_temp_terrasse_batterie:leer']);
  });

  it('niedrig mit Trend: 18 %, −1 %/Tag über 10 Tage → Prognose in Wochen; offline-Sensor wird gemeldet', () => {
    const verlauf = Array.from({ length: 11 }, (_, i) => ({ entity: 'sensor.garage_batt', wert: 28 - i, zeit: new Date(JETZT.getTime() - (10 - i) * 86_400_000).toISOString() }));
    const d = deuteSensorbatterien({
      sensoren: [S('sensor.garage_batt', 'Garage Tür Batterie', 18, JETZT.toISOString()), S('sensor.keller_batt', 'Keller Batterie', undefined, '2026-10-03T10:00:00Z', false)],
      verlauf, jetzt: JETZT,
    })!;
    const text = d.zeilen.join('\n');
    expect(text).toMatch(/⚠️ Garage Tür Batterie: 18 % niedrig \(−7 %\/Woche → leer in ~2 Wochen\) → Ersatz bereitlegen/);
    expect(text).toMatch(/⚠️ Keller Batterie: nicht erreichbar \(zuletzt 03\.10\. 12:00\) → Sensor prüfen/);
    expect(d.auffaellig.sort()).toEqual(['sensorbatterie:sensor.garage_batt:niedrig', 'sensorbatterie:sensor.keller_batt:offline']);
  });

  it('trendProTag braucht ≥ 2 Tage Spanne', () => {
    expect(trendProTag([{ entity: 'x', wert: 50, zeit: '2026-10-01T00:00:00Z' }, { entity: 'x', wert: 48, zeit: '2026-10-01T12:00:00Z' }])).toBeUndefined();
    expect(trendProTag([{ entity: 'x', wert: 50, zeit: '2026-10-01T00:00:00Z' }, { entity: 'x', wert: 46, zeit: '2026-10-05T00:00:00Z' }])).toBe(-1);
  });

  it('ohne Sensoren: undefined', () => {
    expect(deuteSensorbatterien({ sensoren: [], verlauf: [], jetzt: JETZT })).toBeUndefined();
  });
});
