import { describe, it, expect } from 'vitest';
import { deuteMikrotik, downSeit } from '../normalzustaende/infra.js';

// Jarvis Schicht 1, Quelle Infrastruktur — Korrektur 15.04.: dauerhaft downe MikroTik-Interfaces sind unkritisch.
const JETZT = new Date('2026-10-05T02:00:00Z');
const alle10min = (entity: string, vonIso: string, bisIso: string) => {
  const out = []; for (let t = Date.parse(vonIso); t <= Date.parse(bisIso); t += 10 * 60_000) out.push({ entity, zeit: new Date(t).toISOString() }); return out;
};

describe('downSeit', () => {
  it('Beginn der lückenlosen Down-Kette; Lücke > 2 h startet neue Phase; nicht aktuell → undefined', () => {
    const alt = alle10min('r1/ether5', '2026-09-20T00:00:00Z', '2026-09-25T00:00:00Z');
    const neu = alle10min('r1/ether5', '2026-10-04T20:00:00Z', '2026-10-05T01:55:00Z');
    expect(downSeit([...alt, ...neu], JETZT)).toBe('2026-10-04T20:00:00.000Z');
    expect(downSeit(alt, JETZT)).toBeUndefined();
  });
});

describe('deuteMikrotik', () => {
  it('alle up → NORMAL', () => {
    expect(deuteMikrotik({ aktuellDown: [], verlauf: [], jetzt: JETZT, routerText: 'router-core: OK' }).zeilen[0]).toBe('**Interfaces:** alle up · router-core: OK ↳ NORMAL');
  });
  it('Bestand seit Wochen = unkritisch (Korrektur), neu down heute = Signal', () => {
    const verlauf = [
      ...alle10min('router-core/sfp-sfpplus2', '2026-09-20T00:00:00Z', '2026-10-05T01:55:00Z'),
      ...alle10min('router-core/ether8', '2026-10-05T00:30:00Z', '2026-10-05T01:55:00Z'),
    ];
    const d = deuteMikrotik({ aktuellDown: ['router-core/sfp-sfpplus2', 'router-core/ether8'], verlauf, jetzt: JETZT });
    expect(d.zeilen[0]).toMatch(/router-core\/sfp-sfpplus2 down seit 15 Tagen ↳ Bestand, laut Korrektur \(15\.04\.\) nicht kritisch für IPv4 — NICHT melden/);
    expect(d.zeilen[0]).toMatch(/⚠️ router-core\/ether8 NEU down seit 05\.10\. 02:30 → prüfen/);
    expect(d.auffaellig).toEqual(['mikrotik:router-core/ether8:neu-down']);
  });
  it('ohne Historie gilt ein downes Interface als neu (seit jetzt)', () => {
    const d = deuteMikrotik({ aktuellDown: ['r1/ether1'], verlauf: [], jetzt: JETZT });
    expect(d.auffaellig).toEqual(['mikrotik:r1/ether1:neu-down']);
  });
});
