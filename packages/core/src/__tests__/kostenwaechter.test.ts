import { describe, it, expect } from 'vitest';
import { bewerteKosten } from '../lebenszeichen/degradations-waechter.js';

// v1205 — Kostenwächter: Tagesbudget der LLM-Kosten (Guthaben seit 06.10. wieder echtes Geld).
describe('bewerteKosten', () => {
  it('über Budget → ein Befund mit Datum im Schlüssel und größtem Posten', () => {
    const b = bewerteKosten({ datum: '2026-10-06', heuteUsd: 12.37, budgetUsd: 10, groessterPosten: { model: 'claude-opus-5-5', usd: 7.9 } });
    expect(b).toHaveLength(1);
    expect(b[0].key).toBe('kosten:2026-10-06');
    expect(b[0].text).toBe('LLM-Kosten heute $12.37 über dem Tagesbudget von $10.00, größter Posten claude-opus-5-5 $7.90 — läuft weiter, prüfe die Kachel Lebenszeichen');
  });
  it('unter oder gleich Budget, kein Budget oder Budget 0 → nichts', () => {
    expect(bewerteKosten({ datum: '2026-10-06', heuteUsd: 9.99, budgetUsd: 10 })).toEqual([]);
    expect(bewerteKosten({ datum: '2026-10-06', heuteUsd: 10, budgetUsd: 10 })).toEqual([]);
    expect(bewerteKosten({ datum: '2026-10-06', heuteUsd: 99 })).toEqual([]);
    expect(bewerteKosten({ datum: '2026-10-06', heuteUsd: 99, budgetUsd: 0 })).toEqual([]);
  });
});
