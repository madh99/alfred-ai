import { describe, it, expect } from 'vitest';
import { ergaenzePflichtfelder } from '../vorgaenge/pflichtfelder.js';
import { istInterneMemory } from '../active-learning/interne-memories.js';

// v1216 — Realfälle 05./06.10.: Auto-Aktionen scheiterten an fehlenden Pflichtfeldern;
// Dedup-Marker liefen als Wissen in den Chat-Prompt.
describe('ergaenzePflichtfelder', () => {
  it('reminder.set ohne message → Beschreibung; watch.create ohne name → Beschreibung (max 80)', () => {
    const r = ergaenzePflichtfelder({ skillName: 'reminder', skillParams: { action: 'set', delayMinutes: 60 } as Record<string, unknown>, description: 'Erinnerung für Sensor-Batterie-Tausch (Temp Terrasse) setzen.' });
    expect(r.ergaenzt).toEqual(['message']);
    expect(r.action.skillParams?.message).toBe('Erinnerung für Sensor-Batterie-Tausch (Temp Terrasse) setzen.');
    expect(r.action.skillParams?.delayMinutes).toBe(60);
    const w = ergaenzePflichtfelder({ skillName: 'watch', skillParams: { action: 'create', skill_name: 'energy_price', condition_field: 'bruttoCt', condition_operator: 'lt', condition_value: 30 } as Record<string, unknown>, description: 'Watch für günstige Strompreise (< 30 ct/kWh) erstellen.' });
    expect(w.ergaenzt).toEqual(['name']);
    expect((w.action.skillParams?.name as string).length).toBeLessThanOrEqual(80);
  });
  it('vorhandene Felder bleiben unangetastet; fremde Skills unverändert', () => {
    const a = { skillName: 'reminder', skillParams: { action: 'set', message: 'Zahnarzt' }, description: 'Erinnerung Zahnarzt' };
    const r = ergaenzePflichtfelder(a);
    expect(r.ergaenzt).toEqual([]);
    expect(r.action).toBe(a);
    expect(ergaenzePflichtfelder({ skillName: 'homeassistant', skillParams: { action: 'turn_on' }, description: 'Licht an' }).ergaenzt).toEqual([]);
  });
});

describe('istInterneMemory', () => {
  it('Marker und Zähler sind intern, Owner-Wissen nicht', () => {
    expect(istInterneMemory('insight_delivered:infrastrukturprobleme_kritische')).toBe(true);
    expect(istInterneMemory('action_feedback_memory')).toBe(true);
    expect(istInterneMemory('kg_connection_bmw_wallbox')).toBe(true);
    expect(istInterneMemory('rule_skill_homeassistant_1')).toBe(true);
    expect(istInterneMemory('correction_bmw_api_token_resolved')).toBe(false);
    expect(istInterneMemory('awattar_invoice_2026_05')).toBe(false);
    expect(istInterneMemory(undefined)).toBe(false);
  });
});
