import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { fadenBefehl, FadenStore, type FadenEintrag, type FadenAenderung } from '../gespraeche.js';

/**
 * v1497 — Owner 18.10.: In der App fehlten Fäden (nur die neuesten 12), anheften und archivieren gab es nicht.
 * Telegram: /faden anheften|lösen|archiv|zurück; archivierte Fäden stehen nicht in der Liste, bleiben aber erreichbar.
 */
function aufbau() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'alfred-faden-archiv-'));
  const store = new FadenStore(path.join(dir, 'g.json'));
  const liste: FadenEintrag[] = [
    { faden: null, titel: 'Hauptgespräch', zeit: '2026-10-18T10:00:00Z', anzahl: 9 },
    { faden: 'p1', titel: 'Angebots-Radar', zeit: '2026-10-15T10:00:00Z', anzahl: 313, angeheftet: true },
    { faden: 't1', titel: 'Strom heuer', zeit: '2026-10-18T13:00:00Z', anzahl: 4 },
    { faden: 'a1', titel: 'Alter Faden', zeit: '2026-10-11T10:00:00Z', anzahl: 8, archiviert: true },
  ];
  const gesetzt: Array<[string, FadenAenderung]> = [];
  const deps = { store, liste: async () => liste, loeschen: async () => false, setzen: async (f: string, a: FadenAenderung) => { gesetzt.push([f, a]); return ['p1', 't1', 'a1'].includes(f); } };
  return { store, deps, gesetzt };
}

describe('v1497 /faden anheften und archivieren', () => {
  it('Liste: angeheftete mit 📌, archivierte nicht, aber als Zahl erwähnt', async () => {
    const { deps } = aufbau();
    const l = await fadenBefehl('/faden', 'telegram', '1', deps);
    expect(l).toContain('2. 📌 p1 — Angebots-Radar');
    expect(l).toContain('3. t1 — Strom heuer');
    expect(l).not.toContain('Alter Faden');
    expect(l).toContain('Archiviert: 1');
  });

  it('anheften per Nummer, lösen per Kennung, ohne Angabe der aktive Faden', async () => {
    const { deps, gesetzt, store } = aufbau();
    expect(await fadenBefehl('/faden anheften 3', 'telegram', '1', deps)).toBe('Faden t1 angeheftet.');
    expect(await fadenBefehl('/faden lösen p1', 'telegram', '1', deps)).toBe('Faden p1 gelöst.');
    store.setze('telegram', '1', 't1');
    expect(await fadenBefehl('/faden anheften', 'telegram', '1', deps)).toBe('Faden t1 angeheftet.');
    expect(gesetzt).toEqual([['t1', { angeheftet: true }], ['p1', { angeheftet: false }], ['t1', { angeheftet: true }]]);
  });

  it('Hauptgespräch lässt sich nicht anheften oder archivieren', async () => {
    const { deps, gesetzt } = aufbau();
    expect(await fadenBefehl('/faden archiv 1', 'telegram', '1', deps)).toContain('Hauptgespräch lässt sich weder');
    expect(gesetzt).toEqual([]);
  });

  it('archivieren des aktiven Fadens führt zurück ins Hauptgespräch', async () => {
    const { deps, store, gesetzt } = aufbau();
    store.setze('telegram', '1', 't1');
    expect(await fadenBefehl('/faden archiv t1', 'telegram', '1', deps)).toBe('Faden t1 archiviert. Du bist zurück im Hauptgespräch.');
    expect(store.aktiver('telegram', '1')).toBeNull();
    expect(gesetzt).toEqual([['t1', { archiviert: true }]]);
  });

  it('/faden archiv zeigt die archivierten, zurück per Nummer der Archivliste', async () => {
    const { deps, gesetzt } = aufbau();
    expect(await fadenBefehl('/faden archiv', 'telegram', '1', deps)).toContain('1. a1 — Alter Faden');
    expect(await fadenBefehl('/faden zurück 1', 'telegram', '1', deps)).toBe('Faden a1 ist zurück in der Liste.');
    expect(gesetzt).toEqual([['a1', { archiviert: false }]]);
  });

  it('archivierter Faden bleibt per Kennung erreichbar (Schreiben holt ihn zurück)', async () => {
    const { deps, store } = aufbau();
    expect(await fadenBefehl('/faden a1', 'telegram', '1', deps)).toContain('Weiter im Faden a1');
    expect(store.aktiver('telegram', '1')).toBe('a1');
    expect(await fadenBefehl('/faden 4', 'telegram', '1', deps)).toContain('Kein Faden'); // Nummern nur der sichtbaren Liste
  });

  it('unbekannter Faden', async () => {
    const { deps } = aufbau();
    expect(await fadenBefehl('/faden archiv zz9', 'telegram', '1', deps)).toBe('Faden zz9 nicht gefunden.');
  });
});
