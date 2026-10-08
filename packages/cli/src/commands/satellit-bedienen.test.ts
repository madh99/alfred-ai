import { describe, it, expect } from 'vitest';
import { tastenkombi, istGesperrtesFenster, Bedienung, GESPERRTE_FENSTER_STANDARD } from './satellit-bedienen.js';
import { macTaste } from './satellit-bedienen-mac.js';

describe('Zeichen-Aliase (v1297)', () => {
  it('Mac: shift+8 und „mal" tippen *, Wörter werden Zeichen', () => {
    expect(macTaste('shift+8')).toBe("Application('System Events').keystroke(\"*\"); 'ok'");
    expect(macTaste('mal')).toContain('keystroke("*")');
    expect(macTaste('*')).toContain('keystroke("*")');
    expect(macTaste('plus')).toContain('keystroke("+")');
    expect(macTaste('cmd+plus')).toBe("Application('System Events').keystroke(\"+\", { using: ['command down'] }); 'ok'");
    expect(macTaste('enter')).toContain('keyCode(36)');
  });
  it('Windows: shift+8 und „mal" werden {*}, gleich wird =', () => {
    expect(tastenkombi('shift+8')).toBe('*');
    expect(tastenkombi('mal')).toBe('*');
    expect(tastenkombi('plus')).toBe('{+}');
    expect(tastenkombi('gleich')).toBe('=');
    expect(tastenkombi('strg+s')).toBe('^s');
  });
});

describe('macTaste (v1283)', () => {
  it('cmd+s, strg+c, enter, cmd+shift+t, Pfeile', () => {
    expect(macTaste('cmd+s')).toBe("Application('System Events').keystroke(\"s\", { using: ['command down'] }); 'ok'");
    expect(macTaste('strg+c')).toContain("'control down'");
    expect(macTaste('enter')).toBe("Application('System Events').keyCode(36); 'ok'");
    expect(macTaste('cmd+shift+t')).toContain("['command down', 'shift down']");
    expect(macTaste('runter')).toContain('keyCode(125)');
  });
  it('lehnt Unbekanntes ab', () => {
    expect(() => macTaste('cmd+foo')).toThrow(/Unbekannte Taste/);
    expect(() => macTaste('cmd')).toThrow(/Taste fehlt/);
  });
});

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
