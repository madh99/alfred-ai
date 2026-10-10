import { describe, it, expect } from 'vitest';
import { kontoName } from './index.js';

describe('kontoName (v1344)', () => {
  const konten = ['GmailMarkus', 'outlook'];
  it('„default" und leer bedeuten das erste Konto (undefined)', () => {
    expect(kontoName('default', konten)).toBeUndefined();
    expect(kontoName('DEFAULT', konten)).toBeUndefined();
    expect(kontoName('', konten)).toBeUndefined();
    expect(kontoName(undefined, konten)).toBeUndefined();
  });
  it('exakter und Groß-/Kleinschreibung-unabhängiger Treffer', () => {
    expect(kontoName('outlook', konten)).toBe('outlook');
    expect(kontoName('Outlook', konten)).toBe('outlook');
    expect(kontoName('gmailmarkus', konten)).toBe('GmailMarkus');
  });
  it('unbekannte Namen bleiben (Fehlermeldung mit Liste beim Aufrufer)', () => {
    expect(kontoName('arbeit', konten)).toBe('arbeit');
  });
});
