import { describe, it, expect } from 'vitest';
import { tastenkombi, istGesperrtesFenster, Bedienung, GESPERRTE_FENSTER_STANDARD } from './satellit-bedienen.js';

describe('tastenkombi', () => {
  it('übersetzt Modifikatoren und Sondertasten in SendKeys', () => {
    expect(tastenkombi('strg+s')).toBe('^s');
    expect(tastenkombi('Alt+F4')).toBe('%{F4}');
    expect(tastenkombi('strg+shift+t')).toBe('^+t');
    expect(tastenkombi('enter')).toBe('{ENTER}');
    expect(tastenkombi('strg+Pos1')).toBe('^{HOME}');
    expect(tastenkombi('shift++')).toBe('+{+}');
  });
  it('lehnt Unbekanntes, Windows-Taste und zwei Tasten ab', () => {
    expect(() => tastenkombi('win+r')).toThrow(/Windows-Taste/);
    expect(() => tastenkombi('strg+alt')).toThrow(/Taste fehlt/);
    expect(() => tastenkombi('a+b')).toThrow(/Nur eine Taste/);
    expect(() => tastenkombi('strg+foo')).toThrow(/Unbekannte Taste/);
  });
});

describe('istGesperrtesFenster', () => {
  it('erkennt Banking und Kasse, sonst nichts', () => {
    expect(istGesperrtesFenster('George Banking – Brave', GESPERRTE_FENSTER_STANDARD)).toBe('Banking');
    expect(istGesperrtesFenster('Amazon.de Checkout', GESPERRTE_FENSTER_STANDARD)).toBe('Checkout');
    expect(istGesperrtesFenster('Rechner', GESPERRTE_FENSTER_STANDARD)).toBeUndefined();
  });
});

describe('Bedienung', () => {
  it('formatiert die Karte und verlangt vor Aktionen eine Karte', async () => {
    const b = new Bedienung();
    await expect(b.klicken(1)).rejects.toThrow(/Erst fenster_lesen/);
    const text = Bedienung.formatiere({ fenster: 'Rechner', programm: 'calc', pid: 1, zeit: Date.now(), hash: 'abc', elemente: [
      { nr: 1, typ: 'Button', name: 'Sieben', passwort: false, x: 0, y: 0, w: 1, h: 1 },
      { nr: 2, typ: 'Edit', name: 'Kennwort', passwort: true, x: 0, y: 0, w: 1, h: 1 },
      { nr: 3, typ: 'CheckBox', name: 'Merken', zustand: 'On', passwort: false, x: 0, y: 0, w: 1, h: 1 },
    ] });
    expect(text).toContain('1. [Button] Sieben');
    expect(text).toContain('2. [Edit] Kennwort 🔒');
    expect(text).toContain('3. [CheckBox] Merken (On)');
  });
});
