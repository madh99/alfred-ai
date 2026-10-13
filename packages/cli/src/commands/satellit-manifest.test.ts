import { describe, it, expect } from 'vitest';
import { pruefeManifest } from '@alfred/core';
import { baueManifest } from './satellit.js';

// v1416 — Realfall 13.10. 02:08: Manifest des Windows-Satelliten über der Grenze → abgewiesen, Satellit fiel zurück.
// Das Manifest dieser Plattform muss die Prüfung des Gehirns bestehen (die Tests laufen auf dem Windows-PC und der VM).
describe('Manifest des Satelliten', () => {
  it('besteht die Prüfung des Gehirns', () => {
    const m = baueManifest('0.0.0-test');
    for (const a of m.aktionen) if (a.beschreibung.length > 300) a.beschreibung = a.beschreibung.slice(0, 297) + '…'; // wie vor dem Senden (v1277)
    const r = pruefeManifest(m);
    expect(r.ok, r.ok ? '' : r.grund).toBe(true);
    expect(m.aktionen.length).toBeGreaterThan(20);
  });
});
