import { describe, it, expect } from 'vitest';
import { ZustellProtokoll, nichtZugestelltZeile } from '../zustellung/protokoll.js';
import { formatiereLage } from '../interaktion/lage.js';

// v1369 — Verworfenes sichtbar machen (Owner 12.10.: aWATTar-Rechnung verschluckt, 55 Korrektur-Sperren in einer Woche unbemerkt)
describe('ZustellProtokoll', () => {
  it('zählt je Grund über 24 h, ältere fallen heraus', () => {
    const p = new ZustellProtokoll();
    const t0 = Date.parse('2026-10-12T08:00:00Z');
    p.merke('korrektur', 1, t0 - 25 * 3_600_000);
    p.merke('korrektur', 2, t0 - 3_600_000);
    p.merke('aufgabe', 1, t0);
    p.merke('wiederholung', 0, t0);
    expect(p.zaehlung24h(t0)).toEqual({ korrektur: 2, aufgabe: 1 });
  });

  it('Lage-Zeile: wichtigste Gründe zuerst; ohne Verworfenes keine Zeile', () => {
    expect(nichtZugestelltZeile({ wiederholung: 12, korrektur: 3, aufgabe: 1 }))
      .toBe('Nicht zugestellt (24 h): 3 durch deine Korrekturen, 1 geplante Aufgabe ohne Neues, 12 Wiederholungen — Einzelheiten im Log.');
    expect(nichtZugestelltZeile({})).toBeNull();
  });

  it('steht in der Lage (App-Kachel und Chat-Kontext)', () => {
    const zeile = nichtZugestelltZeile({ aufgabe: 1 });
    const lage = formatiereLage({ befundeOffen: [], befundeErledigt24h: [], vorgaengeOffen: [], vorgaengeAbgeschlossen24h: [], nichtZugestellt: zeile }, new Date('2026-10-12T08:00:00Z'));
    expect(lage).toContain('Nicht zugestellt (24 h): 1 geplante Aufgabe ohne Neues');
  });
});
