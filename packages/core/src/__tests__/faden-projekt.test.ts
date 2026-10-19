import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { fadenAusChatId, projektDesFadens, projektAusEingabe, fadenBefehl, FadenStore, type ProjektKurz, type FadenAenderung } from '../gespraeche.js';

/**
 * v1499 (D1) — Owner 19.10.: Projektfäden in der Seitenleiste unter ihr Projekt, und der Faden, aus dem ein Projekt
 * entstand, gleich dazu (Realfall: „finanzapp“ → Projekt Finanz-Backend, Herkunft sitzung:<pc>:mvcisfqj).
 */
const projekte: ProjektKurz[] = [
  { id: '6445e598-1111-2222-3333-444455556666', name: 'Finanz-Backend', aktualisiert: '2026-10-19T07:08:00Z' },
  { id: 'cd0677ce-aaaa-bbbb-cccc-ddddeeeeffff', name: 'Heizölpreis Österreich', aktualisiert: '2026-10-16T18:58:00Z' },
  { id: 'b77431a2-0000-0000-0000-000000000000', name: 'Angebots-Radar Österreich', aktualisiert: '2026-10-15T11:26:00Z' },
];

describe('v1499 Faden aus der Herkunft', () => {
  it('App/Terminal und Owner-Faden ja; Hauptgespräch, Projektfaden, Telegram nein', () => {
    expect(fadenAusChatId('sitzung:7d9f6a58-52c2-4874-90b3-9208cab00724:mvcisfqj')).toBe('mvcisfqj');
    expect(fadenAusChatId('api:sitzung:7d9f6a58:mvaxfx4v')).toBe('mvaxfx4v');
    expect(fadenAusChatId('owner:faden:mv55pltv')).toBe('mv55pltv');
    expect(fadenAusChatId('sitzung:7d9f6a58:haupt')).toBeUndefined();
    expect(fadenAusChatId('sitzung:7d9f6a58-52c2-4874-90b3-9208cab00724')).toBeUndefined();
    expect(fadenAusChatId('sitzung:7d9f6a58:projekt-cd0677ce')).toBeUndefined();
    expect(fadenAusChatId('5060785419')).toBeUndefined();
    expect(fadenAusChatId('api-probe-1397')).toBeUndefined();
    expect(fadenAusChatId(undefined)).toBeUndefined();
  });
});

describe('v1499 Projekt eines Fadens', () => {
  it('Projektfaden über die Kennung, andere über die Zuordnung, archivierte/fremde nicht', () => {
    expect(projektDesFadens('projekt-cd0677ce', undefined, projekte)).toEqual({ id: projekte[1].id, name: 'Heizölpreis Österreich' });
    expect(projektDesFadens('mvcisfqj', projekte[0].id, projekte)).toEqual({ id: projekte[0].id, name: 'Finanz-Backend' });
    expect(projektDesFadens('mvcisfqj', 'archiviertes-projekt', projekte)).toBeUndefined();
    expect(projektDesFadens('projekt-deadbeef', undefined, projekte)).toBeUndefined();
    expect(projektDesFadens(null, undefined, projekte)).toBeUndefined();
  });

  it('Projekt aus der Eingabe: ID, ID-Anfang, Name, eindeutiger Teil', () => {
    expect(projektAusEingabe(projekte[0].id, projekte)?.name).toBe('Finanz-Backend');
    expect(projektAusEingabe('6445e598', projekte)?.name).toBe('Finanz-Backend');
    expect(projektAusEingabe('🔨 finanz-backend', projekte)?.name).toBe('Finanz-Backend');
    expect(projektAusEingabe('heizöl', projekte)?.name).toBe('Heizölpreis Österreich');
    expect(projektAusEingabe('österreich', projekte)).toBeUndefined(); // zwei Treffer → keiner
    expect(projektAusEingabe('', projekte)).toBeUndefined();
  });
});

describe('v1499 /faden projekt', () => {
  function aufbau() {
    const store = new FadenStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'alfred-faden-projekt-')), 'g.json'));
    const gesetzt: Array<[string, FadenAenderung]> = [];
    const deps = {
      store,
      liste: async () => [
        { faden: null, titel: 'Hauptgespräch', zeit: '2026-10-19T07:00:00Z', anzahl: 3 },
        { faden: 'mvcisfqj', titel: 'finanzapp', zeit: '2026-10-18T19:54:00Z', anzahl: 20 },
        { faden: 'projekt-6445e598', titel: '🔨 Finanz-Backend', zeit: '2026-10-19T07:08:00Z', anzahl: 4, projekt: { id: projekte[0].id, name: 'Finanz-Backend' } },
      ],
      loeschen: async () => false,
      setzen: async (f: string, a: FadenAenderung) => { gesetzt.push([f, a]); return a.projekt !== 'gibtsnicht'; },
    };
    return { deps, gesetzt };
  }

  it('zuordnen per Nummer und Name, lösen mit „-“', async () => {
    const { deps, gesetzt } = aufbau();
    expect(await fadenBefehl('/faden projekt 2 Finanz-Backend', 'telegram', '1', deps)).toBe('Faden mvcisfqj gehört jetzt zum Projekt „Finanz-Backend“.');
    expect(await fadenBefehl('/faden projekt mvcisfqj -', 'telegram', '1', deps)).toBe('Faden mvcisfqj gehört zu keinem Projekt mehr.');
    expect(gesetzt).toEqual([['mvcisfqj', { projekt: 'Finanz-Backend' }], ['mvcisfqj', { projekt: null }]]);
  });

  it('Projektfaden bleibt beim Projekt; fehlende Angaben und unbekanntes Projekt', async () => {
    const { deps, gesetzt } = aufbau();
    expect(await fadenBefehl('/faden projekt 3 Heizöl', 'telegram', '1', deps)).toBe('Ein Projektfaden gehört immer zu seinem Projekt.');
    expect(await fadenBefehl('/faden projekt 2', 'telegram', '1', deps)).toContain('So geht es');
    expect(await fadenBefehl('/faden projekt 2 gibtsnicht', 'telegram', '1', deps)).toContain('nicht gefunden');
    expect(gesetzt).toEqual([['mvcisfqj', { projekt: 'gibtsnicht' }]]);
  });
});
