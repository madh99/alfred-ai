import { describe, it, expect } from 'vitest';
import { psFehlertext, letzteZeile, outlookVorhanden, excelVorhanden, mitUrsache } from './satellit-office.js';

describe('satellit-office (v1292)', () => {
  it('kürzt CLIXML-Fehlerausgabe von PowerShell auf einen Satz', () => {
    const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">Ausnahme beim Abrufen der COM-Klassenfactory_x000D__x000A_</S><S S="Error">für Komponente Outlook.Application</S></Objs>';
    expect(psFehlertext(clixml)).toBe('Ausnahme beim Abrufen der COM-Klassenfactory für Komponente Outlook.Application');
    expect(psFehlertext('')).toBe('');
    expect(psFehlertext('x'.repeat(500)).length).toBe(400);
  });
  it('nimmt die letzte nicht-leere Zeile als Ergebnis', () => {
    expect(letzteZeile('WARNUNG: irgendwas\r\n{"a":1}\r\n\r\n')).toBe('{"a":1}');
    expect(letzteZeile('')).toBe('{}');
  });
  it('erklärt COM-Fehler 80080005 je nach Erhöhung des Satelliten (v1294)', () => {
    expect(mitUrsache('Fehler 80080005', true)).toContain('Administratorrechten');
    expect(mitUrsache('Fehler 80080005', false)).toContain('erhöht oder zeigt einen Dialog');
    expect(mitUrsache('anderer Fehler', true)).toBe('anderer Fehler');
  });
  it('bietet Office außerhalb von Windows nie an', () => {
    if (process.platform === 'win32') return; // dort entscheidet die Registry (Profil vorhanden?)
    expect(outlookVorhanden()).toBe(false);
    expect(excelVorhanden()).toBe(false);
  });
});
