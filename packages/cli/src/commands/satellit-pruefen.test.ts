import { describe, it, expect } from 'vitest';
import { pruefungenAus, pruefeAlle, type PruefMittel } from './satellit-pruefen.js';

// v1383 (R1) — harte Prüfschritte ohne Modell
const mittel = (o: Partial<PruefMittel> = {}): PruefMittel => ({
  datei: async (p) => (p === '/p/hallo.txt' ? { existiert: true, inhalt: 'Hallo R1' } : { existiert: false }),
  http: async () => ({ status: 200, text: '<h1>Hallo von Alfred!</h1>' }),
  fenster: async () => 'Rechner\nErgebnis 42',
  befehl: async (b) => (b === 'npm test' ? { exit: 0, ausgabe: 'Tests 5 passed' } : { exit: 1, ausgabe: 'Error: kaputt' }),
  ...o,
});

describe('Prüfschritte', () => {
  it('Parameter: Arten je Aktion, Befehle nur über pruefen_befehl, URL nur http(s), höchstens 10', () => {
    expect(pruefungenAus({}, ['datei'])).toMatch(/pruefungen fehlt/);
    expect(pruefungenAus({ pruefungen: [{ art: 'befehl', ziel: 'rm -rf /' }] }, ['datei', 'http', 'fenster'])).toMatch(/pruefen_befehl/);
    expect(pruefungenAus({ pruefungen: [{ art: 'http', ziel: 'file:///etc/passwd' }] }, ['http'])).toMatch(/http\(s\)/);
    expect(pruefungenAus({ pruefungen: Array.from({ length: 11 }, () => ({ art: 'datei', ziel: '/a' })) }, ['datei'])).toMatch(/höchstens 10/);
    expect(pruefungenAus({ pruefungen: [{ art: 'datei', pfad: '/p/hallo.txt', enthaelt: 'Hallo' }] }, ['datei'])).toEqual([{ art: 'datei', ziel: '/p/hallo.txt', enthaelt: 'Hallo' }]);
    expect(pruefungenAus({ pruefungen: [{ art: 'fenster' }] }, ['fenster'])).toEqual([{ art: 'fenster', ziel: '' }]);
  });

  it('alle bestanden', async () => {
    const r = await pruefeAlle([
      { art: 'datei', ziel: '/p/hallo.txt', enthaelt: 'hallo r1' },
      { art: 'http', ziel: 'http://localhost:3000', enthaelt: 'Hallo von Alfred' },
      { art: 'fenster', ziel: '', enthaelt: '42' },
      { art: 'befehl', ziel: 'npm test', enthaelt: 'passed' },
    ], mittel());
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^Alle Prüfungen bestanden/);
  });

  it('Fehlschläge mit Grund und Auszug', async () => {
    const r = await pruefeAlle([
      { art: 'datei', ziel: '/p/fehlt.txt' },
      { art: 'http', ziel: 'http://x', status: 201 },
      { art: 'befehl', ziel: 'npm run build' },
      { art: 'befehl', ziel: 'langsam' },
      { art: 'datei', ziel: '/p/hallo.txt', enthaelt: 'Tschüss' },
    ], mittel({ befehl: async (b) => (b === 'langsam' ? { exit: null, ausgabe: '' } : { exit: 2, ausgabe: 'Error: kaputt' }) }));
    expect(r.ok).toBe(false);
    expect(r.ergebnisse.map(e => e.grund)).toEqual(['Datei fehlt', 'Status 200 statt 201', 'Exit 2', 'abgebrochen (Zeitlimit)', 'existiert, enthält „Tschüss" nicht']);
    expect(r.ergebnisse[2]!.auszug).toBe('Error: kaputt');
    expect(r.text).toMatch(/^5 von 5 Prüfungen fehlgeschlagen/);
  });

  it('Ausnahmen werden Fehlschläge, nicht Abbrüche', async () => {
    const r = await pruefeAlle([{ art: 'http', ziel: 'http://weg' }, { art: 'datei', ziel: '/p/hallo.txt' }], mittel({ http: async () => { throw new Error('ECONNREFUSED'); } }));
    expect(r.ergebnisse[0]).toMatchObject({ ok: false, grund: 'Fehler: ECONNREFUSED' });
    expect(r.ergebnisse[1]!.ok).toBe(true);
  });
});

// v1384 — Sicherheitsbefund SSRF: ohne Bestätigung nur Adressen auf dem Gerät selbst
describe('HTTP ohne Bestätigung nur lokal', () => {
  it('pruefen lehnt LAN- und Metadaten-Adressen ab, pruefen_befehl erlaubt sie', () => {
    const ohne = ['datei', 'http', 'fenster'] as const;
    for (const u of ['http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data', 'https://ha.3033.at', 'http://localhost.evil.com', 'http://127.0.0.1.nip.io']) {
      expect(pruefungenAus({ pruefungen: [{ art: 'http', ziel: u }] }, [...ohne]), u).toMatch(/nur Adressen auf diesem Gerät/);
    }
    for (const u of ['http://localhost:3000', 'http://127.0.0.1:8080/health', 'http://[::1]:5173']) {
      expect(Array.isArray(pruefungenAus({ pruefungen: [{ art: 'http', ziel: u }] }, [...ohne])), u).toBe(true);
    }
    expect(Array.isArray(pruefungenAus({ pruefungen: [{ art: 'http', ziel: 'http://192.168.1.96:3003' }] }, [...ohne, 'befehl']))).toBe(true);
  });
  it('pruefeAlle mit nurLokal fragt fremde Adressen gar nicht erst ab', async () => {
    let abgefragt = 0;
    const r = await pruefeAlle([{ art: 'http', ziel: 'http://192.168.1.1/' }], mittel({ http: async () => { abgefragt++; return { status: 200, text: 'geheim' }; } }), true);
    expect(abgefragt).toBe(0);
    expect(r.ergebnisse[0]).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toContain('geheim');
  });
});
