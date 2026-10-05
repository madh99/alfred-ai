import { describe, it, expect } from 'vitest';
import { passtZuIncidentTitel } from '../repositories/itsm-repository.js';

// v1183 — Realfall 05.10.: „Low battery: Temp Terrasse Batterie at 0%" wurde über das
// EINE gemeinsame Wort „battery:" dem auto-resolved Incident „settings ess batterylife
// soclimit" wieder angehängt (Re-Open #2/#3) — Flap zwischen Auto-Recovery und Re-Open.
describe('passtZuIncidentTitel', () => {
  const soclimit = 'homeassistant: Low battery: settings ess batterylife soclimit at 15%';
  const terrasse = 'homeassistant: Low battery: Temp Terrasse  Batterie at 0%';

  it('ein gemeinsames Wort reicht nicht — auch nicht bei gleicher Quelle', () => {
    expect(passtZuIncidentTitel(soclimit, 'homeassistant', ['battery:', 'temp', 'terrasse', 'batterie'])).toBe(false);
    expect(passtZuIncidentTitel(soclimit, 'homeassistant', ['temp', 'terrasse', 'batterie'])).toBe(false);
  });
  it('zwei gemeinsame Wörter bei gleicher Quelle treffen', () => {
    expect(passtZuIncidentTitel(terrasse, 'homeassistant', ['temp', 'terrasse', 'batterie'])).toBe(true);
    expect(passtZuIncidentTitel(soclimit, 'homeassistant', ['batterylife', 'soclimit'])).toBe(true);
  });
  it('ohne Quellen-Übereinstimmung braucht es drei', () => {
    expect(passtZuIncidentTitel(terrasse, 'unifi', ['temp', 'terrasse', 'garage'])).toBe(false);
    expect(passtZuIncidentTitel(terrasse, 'unifi', ['temp', 'terrasse', 'batterie'])).toBe(true);
  });
  it('kurze Meldungen: alle vorhandenen Wörter müssen treffen', () => {
    expect(passtZuIncidentTitel('unifi: Device "AC Mesh" is not connected (state: 2)', 'unifi', ['mesh'])).toBe(true);
    expect(passtZuIncidentTitel('unifi: Device "AC Mesh" is not connected (state: 2)', 'unifi', ['switch'])).toBe(false);
    expect(passtZuIncidentTitel(terrasse, 'homeassistant', [])).toBe(false);
  });
});
