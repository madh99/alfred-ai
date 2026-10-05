import { describe, it, expect } from 'vitest';
import { klassifiziereBatterie, istMobilgeraeteEntity } from './batterie-klassen.js';

// v1172 — Realfall: Monitor meldete den ESS-Konfigurationswert (soclimit 15 %) und
// Handy-Akkus 6 Monate lang als Incidents.
describe('klassifiziereBatterie (Schreiber = Leser)', () => {
  it('Konfiguration, Mobilgerät, Hausbatterie, Sensor', () => {
    expect(klassifiziereBatterie('sensor.victron_settings_ess_batterylife_soclimit', 'settings Ess batterylife soclimit')).toBe('konfiguration');
    expect(klassifiziereBatterie('sensor.sm_s928b_battery_level', 'SM-S928B Battery level')).toBe('mobilgeraet');
    expect(klassifiziereBatterie('sensor.iphone_von_noah1_battery_level')).toBe('mobilgeraet');
    expect(klassifiziereBatterie('sensor.victron_system_battery_soc')).toBe('hausbatterie');
    expect(klassifiziereBatterie('sensor.0x00158d00047db98d_0x00158d00047db98d_battery', 'Holztüre Garage Batterie')).toBe('sensor');
    expect(klassifiziereBatterie('sensor.terrasse_temp_terrasse_batterie', 'Temp Terrasse Batterie')).toBe('sensor');
  });
  it('istMobilgeraeteEntity erkennt Companion-App-Entitäten', () => {
    expect(istMobilgeraeteEntity('sensor.alex_i_phone_steps')).toBe(true);
    expect(istMobilgeraeteEntity('binary_sensor.iphone_15_pro_max_madh_camera_motion')).toBe(true);
    expect(istMobilgeraeteEntity('sensor.unifi_network_u7_pro_cpu')).toBe(false);
  });
});
