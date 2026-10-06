import { describe, it, expect } from 'vitest';
import { deuteGeraete, formatiereDauerKurz } from '../normalzustaende/geraete.js';
import { entscheideZustellung, GERAET_AKTIV_SEK } from '../delivery-scheduler.js';

// v1237 — Sinne der Geräte: Deutung, Befund-Schlüssel, Anwesenheitssignal für die Zustellung.
const JETZT = new Date('2026-10-06T20:00:00Z');
const iso = (minVor: number) => new Date(JETZT.getTime() - minVor * 60_000).toISOString();

describe('deuteGeraete', () => {
  it('aktiv mit Fenster, Leerlauf, getrennt (⚠️ ab 3 h), Akku niedrig (⚠️ ohne Netz)', () => {
    const d = deuteGeraete({ jetzt: JETZT, geraete: [
      { name: 'PC-madh', plattform: 'windows', online: true, sinneZeit: iso(1), sinne: { leerlaufSek: 40, fenster: 'Visual Studio Code' } },
      { name: 'Mac', plattform: 'macos', online: true, sinneZeit: iso(1), sinne: { leerlaufSek: 23 * 60, akkuProzent: 12, akkuLaedt: false } },
      { name: 'Laptop', plattform: 'linux', online: true, sinneZeit: iso(1), sinne: { leerlaufSek: 10, akkuProzent: 12, akkuLaedt: true } },
      { name: 'Handy', plattform: 'android', online: false, zuletztGesehen: iso(200) },
      { name: 'Tablet', plattform: 'ios', online: false, zuletztGesehen: iso(20) },
    ] })!;
    expect(d.zeilen[0]).toBe('PC-madh (windows): aktiv (Leerlauf unter 1 min), Fenster „Visual Studio Code"');
    expect(d.zeilen[1]).toBe('⚠️ Mac (macos): im Leerlauf seit 23 min, Akku 12 % (nicht am Netz)');
    expect(d.zeilen[2]).toContain('Akku 12 % (lädt)');
    expect(d.zeilen[3]).toBe('⚠️ Handy (android): getrennt seit 3 h 20 min');
    expect(d.zeilen[4]).toBe('Tablet (ios): getrennt seit 20 min');
    expect(d.auffaellig).toEqual(['geraet:Mac:akku', 'geraet:Handy:getrennt']);
    expect(d.aktiv).toEqual({ name: 'Laptop', leerlaufSek: 10 });
  });
  it('Systemzeile mit Laufzeit, CPU, GPU, RAM und knappem Laufwerk als Befund', () => {
    const d = deuteGeraete({ jetzt: JETZT, geraete: [
      { name: 'PC', plattform: 'windows', online: true, sinneZeit: iso(1), sinne: { leerlaufSek: 5, uptimeSek: 13 * 86_400 + 2 * 3600, cpuProzent: 12, gpuProzent: 3, ramGesamtMb: 128_000, ramFreiMb: 70_000, laufwerke: [{ name: 'C:', gesamtGb: 931, freiGb: 120 }, { name: 'D:', gesamtGb: 1863, freiGb: 90 }] } },
    ] })!;
    expect(d.zeilen[1]).toContain('⚠️ ↳ PC System: läuft seit 13 d');
    expect(d.zeilen[1]).toContain('CPU 12 % · GPU 3 % · RAM 68 GB frei von 125 · C: 120 GB frei von 931 · ⚠️ D: 90 GB frei von 1863');
    expect(d.auffaellig).toEqual(['geraet:PC:laufwerk:D']);
  });
  it('alte Sinne zählen nicht; ohne Geräte keine Deutung', () => {
    const d = deuteGeraete({ jetzt: JETZT, geraete: [{ name: 'PC', plattform: 'windows', online: true, verbundenSeit: iso(90), sinneZeit: iso(10), sinne: { leerlaufSek: 5 } }] })!;
    expect(d.zeilen[0]).toBe('PC (windows): online seit 1 h 30 min');
    expect(d.aktiv).toBeUndefined();
    expect(deuteGeraete({ geraete: [] })).toBeUndefined();
  });
  it('Dauer kurz', () => {
    expect(formatiereDauerKurz(30_000)).toBe('unter 1 min');
    expect(formatiereDauerKurz(3 * 86_400_000)).toBe('3 d');
  });
});

describe('entscheideZustellung — Owner am Gerät', () => {
  const basis = { urgency: 'normal' as const, chatAktiv: false, imRuhefenster: false, profilErlaubt: false, profilText: 'Profil: QUIET', now: JETZT.getTime() };
  it('liefert, wenn der Owner gerade am Gerät ist — nicht im Ruhefenster, nicht bei niedriger Dringlichkeit', () => {
    expect(entscheideZustellung({ ...basis, anwesenheit: { amGeraet: { name: 'PC-madh', leerlaufSek: 30 } } })).toEqual({ liefern: true, grund: 'Owner am PC-madh (Leerlauf unter 1 min)' });
    expect(entscheideZustellung({ ...basis, anwesenheit: { amGeraet: { name: 'PC-madh', leerlaufSek: GERAET_AKTIV_SEK + 1 } } }).liefern).toBe(false);
    expect(entscheideZustellung({ ...basis, imRuhefenster: true, anwesenheit: { amGeraet: { name: 'PC-madh', leerlaufSek: 30 } } }).liefern).toBe(false);
    expect(entscheideZustellung({ ...basis, urgency: 'low', anwesenheit: { amGeraet: { name: 'PC-madh', leerlaufSek: 30 } } }).liefern).toBe(false);
  });
});
