import { describe, it, expect } from 'vitest';
import { bewerteAdapter, bewerteProben, DEGRADATION_SCHWELLE_MS } from '../lebenszeichen/degradations-waechter.js';
import { fuehreProbenAus } from '../lebenszeichen/proben.js';

// v1191 — Realfall 05.10.: Matrix-Homeserver 502 ab der Nacht, Adapter nach dem
// fehlgeschlagenen Start-Connect den ganzen Tag tot (24 Fehlerzeilen), kein Owner-Satz.
const NOW = new Date('2026-10-05T17:00:00Z');

describe('bewerteAdapter', () => {
  it('getrennt länger als die Schwelle → ein Befund mit Dauer; verbunden oder frisch getrennt → nichts', () => {
    const b = bewerteAdapter([
      { platform: 'matrix', status: 'disconnected', getrenntSeitMs: NOW.getTime() - 5 * 3_600_000 },
      { platform: 'telegram', status: 'connected' },
      { platform: 'discord', status: 'disconnected', getrenntSeitMs: NOW.getTime() - DEGRADATION_SCHWELLE_MS + 60_000 },
    ], NOW);
    expect(b).toHaveLength(1);
    expect(b[0].key).toBe('adapter:matrix');
    expect(b[0].text).toMatch(/Adapter matrix seit 5 h nicht verbunden \(disconnected\)/);
  });
});

describe('Adapter-Probe', () => {
  it('liefert je Soll-Adapter ein Ergebnis; getrennte werden Befund „Adapter …"', async () => {
    const ergebnisse = await fuehreProbenAus({
      jobs: () => [], letzterLauf: async () => undefined, now: () => NOW,
      adapter: () => [
        { platform: 'matrix', status: 'disconnected', getrenntSeitMs: NOW.getTime() - 2 * 3_600_000 },
        { platform: 'telegram', status: 'connected' },
      ],
    });
    const adapter = ergebnisse.filter(e => e.art === 'adapter');
    expect(adapter.map(a => `${a.name}:${a.ok}`)).toEqual(['matrix:false', 'telegram:true']);
    expect(adapter[0].detail).toBe('nicht verbunden (disconnected) seit 2 h');
    const befunde = bewerteProben(ergebnisse);
    expect(befunde).toEqual([{ key: 'adapter:matrix', text: 'Adapter matrix: nicht verbunden (disconnected) seit 2 h' }]);
  });
});
