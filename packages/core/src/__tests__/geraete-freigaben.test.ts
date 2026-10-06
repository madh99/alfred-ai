import { describe, it, expect } from 'vitest';
import { Freigaben, paramsFingerabdruck, FREIGABE_GUELTIG_MS, VorhabenFreigaben, domainErlaubt, hostAus } from '../geraete/freigaben.js';

// v1230 — Vorhaben-Freigabe: ein Ja für viele Schritte, Umfang nach Aktionen und Domains.
describe('VorhabenFreigaben', () => {
  it('deckt erst nach Aktivierung, nur genannte Aktionen, nur erlaubte Domains, zählt Schritte', () => {
    const f = new VorhabenFreigaben();
    const v = f.erzeuge('geraet_pc', { beschreibung: 'Bartschneider in den Einkaufswagen', aktionen: ['browser_*'], domains: ['amazon.de'], dauerMin: 30 });
    expect(f.deckt('geraet_pc', 'browser_klicken', {})).toBeUndefined(); // noch nicht freigegeben
    expect(f.aktiviere('falsch', 'geraet_pc')).toBeUndefined();
    expect(f.aktiviere(v.nonce, 'anderes_geraet')).toBeUndefined();
    expect(f.aktiviere(v.nonce, 'geraet_pc')?.beschreibung).toBe('Bartschneider in den Einkaufswagen');
    expect(f.deckt('geraet_pc', 'browser_klicken', {})?.schritte).toBe(1);
    expect(f.deckt('geraet_pc', 'browser_oeffnen', { url: 'https://www.amazon.de/s?k=x' })?.schritte).toBe(2);
    expect(f.deckt('geraet_pc', 'browser_oeffnen', { url: 'https://www.paypal.com/' })).toBeUndefined();
    expect(f.deckt('geraet_pc', 'shell', { command: 'dir' })).toBeUndefined();
    expect(f.deckt('anderes_geraet', 'browser_klicken', {})).toBeUndefined();
  });
  it('läuft ab und Dauer ist auf 5–120 Minuten begrenzt', () => {
    let t = 1_000_000;
    const f = new VorhabenFreigaben(() => t);
    const v = f.erzeuge('s', { beschreibung: 'x', aktionen: ['a'], dauerMin: 999 });
    expect(v.bis - t).toBe(120 * 60_000);
    f.aktiviere(v.nonce, 's');
    t += 121 * 60_000;
    expect(f.deckt('s', 'a', {})).toBeUndefined();
  });
  it('Domain-Regeln', () => {
    expect(hostAus('https://www.amazon.de/s?k=1')).toBe('www.amazon.de');
    expect(hostAus('amazon.de')).toBe('amazon.de');
    expect(hostAus(undefined)).toBeUndefined();
    expect(domainErlaubt('www.amazon.de', ['amazon.de'])).toBe(true);
    expect(domainErlaubt('amazon.de.evil.com', ['amazon.de'])).toBe(false);
    expect(domainErlaubt('x', [])).toBe(true);
  });
});

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
