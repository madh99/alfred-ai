import { describe, it, expect } from 'vitest';
import { Freigaben, paramsFingerabdruck, FREIGABE_GUELTIG_MS } from '../geraete/freigaben.js';

// v1225 — Sicherheitsbefund .1224: `confirmed: true` im Tool-Aufruf hätte die Owner-Bestätigung umgangen.
describe('Freigaben', () => {
  it('eine Freigabe gilt genau einmal, nur für dieselbe Aktion mit denselben Parametern', () => {
    const f = new Freigaben();
    const nonce = f.erzeuge('geraet_pc', 'oeffnen', { path: 'C:/x' });
    expect(f.verbrauche(nonce, 'geraet_pc', 'oeffnen', { path: 'C:/x', freigabe: nonce })).toBe(true);
    expect(f.verbrauche(nonce, 'geraet_pc', 'oeffnen', { path: 'C:/x' })).toBe(false); // verbraucht
    const n2 = f.erzeuge('geraet_pc', 'oeffnen', { path: 'C:/x' });
    expect(f.verbrauche(n2, 'geraet_pc', 'shell', { path: 'C:/x' })).toBe(false); // andere Aktion
    const n3 = f.erzeuge('geraet_pc', 'oeffnen', { path: 'C:/x' });
    expect(f.verbrauche(n3, 'geraet_pc', 'oeffnen', { path: 'C:/geheim' })).toBe(false); // andere Parameter
    expect(f.verbrauche('erfunden', 'geraet_pc', 'oeffnen', { path: 'C:/x' })).toBe(false);
    expect(f.verbrauche(undefined, 'geraet_pc', 'oeffnen', {})).toBe(false);
    expect(f.verbrauche(true, 'geraet_pc', 'oeffnen', {})).toBe(false); // das alte confirmed:true zählt nicht
  });
  it('läuft nach 60 Minuten ab', () => {
    let t = 1_000_000;
    const f = new Freigaben(() => t);
    const n = f.erzeuge('s', 'a', { x: 1 });
    t += FREIGABE_GUELTIG_MS + 1;
    expect(f.verbrauche(n, 's', 'a', { x: 1 })).toBe(false);
    expect(f.anzahl()).toBe(0);
  });
  it('Fingerabdruck ignoriert Reihenfolge und die Steuerfelder', () => {
    expect(paramsFingerabdruck({ a: 1, b: 2 })).toBe(paramsFingerabdruck({ b: 2, a: 1, freigabe: 'x', confirmed: true }));
    expect(paramsFingerabdruck({ a: 1 })).not.toBe(paramsFingerabdruck({ a: 2 }));
  });
});
