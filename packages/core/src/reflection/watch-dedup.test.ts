import { describe, it, expect } from 'vitest';
import { WatchReflector } from './watch-reflector.js';

/**
 * v925 — Watch-Duplikat-Merge. Realfall: „Daily Sensor Battery Check" existierte
 * 2× (24.06. + 25.06.) mit jeweils geratenen, unterschiedlichen entity_ids.
 */
describe('v925 WatchReflector.findDuplicateGroups', () => {
  it('erkennt Namens-Duplikate (≥3 gemeinsame Keywords), neueste bleibt', () => {
    const groups = WatchReflector.findDuplicateGroups([
      { id: 'w-old', name: 'Daily Sensor Battery Check (Garage, Wohnzimmer)', skillName: 'homeassistant', skillParams: { entity_id: 'sensor.garage_temp_batterie' }, createdAt: '2026-06-24T10:00:00Z' },
      { id: 'w-new', name: 'Daily Sensor Battery Check (Garage, Wohnzimmer, B_Garage)', skillName: 'homeassistant', skillParams: { entity_id: 'sensor.garage_temp_battery' }, createdAt: '2026-06-25T10:00:00Z' },
    ]);
    expect(groups.length).toBe(1);
    expect(groups[0].keep.id).toBe('w-new');
    expect(groups[0].drop.map(d => d.id)).toEqual(['w-old']);
  });

  it('erkennt gleiche skill+entity_id auch bei anderem Namen', () => {
    const groups = WatchReflector.findDuplicateGroups([
      { id: 'a', name: 'ESS SoC Alarm', skillName: 'homeassistant', skillParams: { entity_id: 'sensor.ess_soc' }, createdAt: '2026-06-01T00:00:00Z' },
      { id: 'b', name: 'Speicher Ladestand prüfen', skillName: 'homeassistant', skillParams: { entity_id: 'sensor.ess_soc' }, createdAt: '2026-06-10T00:00:00Z' },
    ]);
    expect(groups.length).toBe(1);
    expect(groups[0].keep.id).toBe('b');
  });

  it('unabhängige Watches bleiben unangetastet', () => {
    const groups = WatchReflector.findDuplicateGroups([
      { id: 'a', name: 'iPhone Battery Low Alert', skillName: 'homeassistant', skillParams: { entity_id: 'sensor.iphone_battery' }, createdAt: '2026-06-01T00:00:00Z' },
      { id: 'b', name: 'Crypto BTC Preis-Alarm', skillName: 'crypto', skillParams: {}, createdAt: '2026-06-02T00:00:00Z' },
    ]);
    expect(groups.length).toBe(0);
  });
});
