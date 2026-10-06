import { describe, it, expect } from 'vitest';
import { istGesperrteUrl, istGesperrteBeschriftung, formatiereSeite } from '../geraete/browser-regeln.js';

// v1229 — Browser-Hand: Kauf, Bestellung, Zahlung und Anmeldung bleiben beim Owner (deterministisch).
describe('Browser-Sperren', () => {
  it('erkennt Zahlungs-, Bestell- und Anmelde-URLs', () => {
    expect(istGesperrteUrl('https://www.amazon.de/gp/buy/spc/handlers/display.html')).toBe(true);
    expect(istGesperrteUrl('https://www.amazon.de/ap/signin?x=1')).toBe(true);
    expect(istGesperrteUrl('https://shop.example/checkout')).toBe(true);
    expect(istGesperrteUrl('https://www.paypal.com/')).toBe(true);
    expect(istGesperrteUrl('https://www.amazon.de/s?k=bartschneider')).toBe(false);
    expect(istGesperrteUrl('https://www.amazon.de/dp/B0C1234/')).toBe(false);
    expect(istGesperrteUrl('https://www.amazon.de/gp%2Fbuy/spc')).toBe(true); // kodiert
    expect(istGesperrteUrl('https://shop.example/%2563heckout')).toBe(true); // doppelt kodiert
  });
  it('erkennt Kauf- und Anmelde-Beschriftungen, lässt „In den Einkaufswagen" zu', () => {
    expect(istGesperrteBeschriftung('Jetzt kaufen')).toBe(true);
    expect(istGesperrteBeschriftung('Bestellung aufgeben')).toBe(true);
    expect(istGesperrteBeschriftung('Place your order')).toBe(true);
    expect(istGesperrteBeschriftung('Anmelden')).toBe(true);
    expect(istGesperrteBeschriftung('In den Einkaufswagen')).toBe(false);
    expect(istGesperrteBeschriftung('Weiter einkaufen')).toBe(false);
  });
  it('formatiert eine Seite mit Element-Karte', () => {
    const t = formatiereSeite({ url: 'https://x', titel: 'Titel', text: 'Hallo', elemente: [{ i: 1, tag: 'a', text: 'Link', href: '/a' }, { i: 2, tag: 'input', text: 'Suche', typ: 'text' }] });
    expect(t).toContain('Titel — https://x');
    expect(t).toContain('[1] a Link → /a');
    expect(t).toContain('[2] input:text Suche');
  });
});
