import { describe, it, expect } from 'vitest';
import { lizenzBefunde, erreichbarkeitsBefund, auffaelligkeiten } from './bericht.js';
import { sammleWindowsUeberwachung, WINDOWS_BEFEHLE } from './sammler-windows.js';

// Owner 24.11. — sql01/sql02/pkiiss01 seit 21.11. aus (Kulanzfrist ohne Aktivierung); die stündliche Überwachung meldete nichts
describe('Windows-Lizenz in der stündlichen Überwachung', () => {
  it('nicht aktiviert → hoch mit Hinweis auf windows_aktivieren; Kulanzfrist ≤ 7 Tage → hoch', () => {
    const a = lizenzBefunde('sql01', { status: 'nicht_aktiviert', kanal: 'Volume' });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ schwere: 'hoch', schluessel: 'lizenz:sql01', kategorie: 'lizenz', zugang: 'sql01' });
    expect(a[0]!.text).toContain('windows_aktivieren');
    const k = lizenzBefunde('sql02', { status: 'kulanzfrist', kanal: 'Retail', restTage: 3, ablauf: '2026-11-21' });
    expect(k[0]).toMatchObject({ schwere: 'hoch' });
    expect(k[0]!.text).toContain('Kulanzfrist läuft in 3 Tagen ab');
    expect(lizenzBefunde('dc01', { status: 'testversion', kanal: 'Eval', restTage: 165, ablauf: '2027-05-08' })).toEqual([]);
  });

  it('Bestandsbericht nutzt dieselbe Regel (gleicher Schlüssel)', () => {
    const host = { zugang: 'sql01', host: '10.203.30.2', dateisysteme: [], dienste: [], ports: [], container: [], compose: [], volumes: [], fehler: [], erfasst: '', windows: { lizenz: { status: 'nicht_aktiviert', kanal: 'Volume' } } };
    const a = auffaelligkeiten({ hosts: [host as never], vms: [], proxy: [] }).filter(x => x.kategorie === 'lizenz');
    expect(a.map(x => x.schluessel)).toEqual(['lizenz:sql01']);
  });

  it('Sammlung liest die Lizenz mit', async () => {
    const gelesen: string[] = [];
    await sammleWindowsUeberwachung(async (b) => { gelesen.push(b); throw new Error('aus'); });
    expect(gelesen).toContain(WINDOWS_BEFEHLE.lizenz);
  });
});

describe('Windows-Host nicht erreichbar', () => {
  it('nichts lesbar → Befund hoch mit erstem Fehlergrund', async () => {
    const r = await sammleWindowsUeberwachung(async () => { throw new Error('ssh: connect to host 10.203.30.2 port 22: No route to host'); });
    const a = erreichbarkeitsBefund('sql01', r);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ schwere: 'hoch', schluessel: 'ueberwachung:sql01:erreichbar', kategorie: 'ueberwachung', zugang: 'sql01' });
    expect(a[0]!.text).toContain('No route to host');
  });

  it('teilweise lesbar → kein Erreichbarkeitsbefund', () => {
    expect(erreichbarkeitsBefund('dc01', { ueberwachung: { dienste: [] }, fehler: ['dc: Zeitüberschreitung'] })).toEqual([]);
    expect(erreichbarkeitsBefund('dc01', { dateisysteme: [], ueberwachung: {}, fehler: ['dienste-gestoppt: x'] })).toEqual([]);
    expect(erreichbarkeitsBefund('dc01', { ueberwachung: {}, fehler: [] })).toEqual([]);
  });
});
