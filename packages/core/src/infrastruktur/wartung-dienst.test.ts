import { describe, it, expect } from 'vitest';
import type { CmdbChangeRequest } from '@alfred/types';
import { WartungsDienst, erreichbar } from './wartung-dienst.js';
import type { BenachrichtigungsRegel, KalenderEintrag } from './wartung.js';

// I4b Teil 1 — Ankündigung, Fenster und Zustellung im Ablauf
const t = (s: string) => Date.parse(s);
function aufbau(kalender: KalenderEintrag[], regeln: BenachrichtigungsRegel[], c: Partial<CmdbChangeRequest> = {}) {
  let jetzt = t('2026-10-22T10:00:00Z');
  const gesendet: string[] = [];
  const change = { id: 'chg', title: 'Matrix umziehen', type: 'normal', status: 'approved', affectedAssetIds: ['a-ha'], affectedServiceIds: [], ausfallMinuten: 30, ...c } as CmdbChangeRequest;
  const d = new WartungsDienst({
    kalender: async () => kalender, regeln: async () => regeln,
    setzeAnkuendigung: async (_o, _id, a) => { change.ankuendigung = a; },
    sende: async (e, k, titel) => { gesendet.push(`${e.name ?? e.art}/${k}/${titel}`); return true; },
    jetzt: () => jetzt,
  });
  return { d, change, gesendet, stelle: (s: string) => { jetzt = t(s); } };
}
const familie: BenachrichtigungsRegel = { id: 'r1', name: 'Familie bei HA', geltung: { assetIds: ['a-ha'] }, empfaenger: [{ art: 'nutzer', name: 'Alexandra', telegramId: '123' }, { art: 'owner' }], kanaele: ['telegram'], zeitpunkte: ['24h_vorher', '1h_vorher', 'start', 'ende'], aktiv: true };
const nachts: KalenderEintrag = { id: 'f1', art: 'fenster', name: 'nachts', geltung: { global: true }, regel: { art: 'woechentlich', tage: [0, 1, 2, 3, 4, 5, 6], von: '22:00', bis: '06:00' }, aktiv: true };

describe('I4b WartungsDienst', () => {
  it('ohne Regeln/Fenster: sofort', async () => {
    const a = aufbau([], []);
    expect((await a.d.zeitplan('o', a.change)).jetzt).toBe(true);
  });
  it('24-h-Regel: Start wird angekündigt (frühestens 24 h später, im Fenster), Meldungen genau einmal, dann Start', async () => {
    const a = aufbau([nachts], [familie]);
    const z1 = await a.d.zeitplan('o', a.change);
    expect(z1.jetzt).toBe(false);
    expect(a.change.ankuendigung!.start).toBe('2026-10-23T20:00:00.000Z'); // Fr 22:00 MESZ (24 h + nächstes Fenster)
    expect(a.gesendet).toEqual([]); // 24-h-Meldung erst ab Do 22:00
    a.stelle('2026-10-22T20:10:00Z');
    await a.d.zeitplan('o', a.change);
    expect(a.gesendet).toEqual(['Alexandra/telegram/Wartung morgen', 'owner/telegram/Wartung morgen']);
    await a.d.zeitplan('o', a.change);
    expect(a.gesendet.length).toBe(2); // nicht doppelt
    a.stelle('2026-10-23T19:05:00Z');
    expect((await a.d.zeitplan('o', a.change)).jetzt).toBe(false);
    expect(a.gesendet.slice(2)).toEqual(['Alexandra/telegram/Wartung in 1 Stunde', 'owner/telegram/Wartung in 1 Stunde']);
    a.stelle('2026-10-23T20:00:00Z');
    expect((await a.d.zeitplan('o', a.change)).jetzt).toBe(true);
    await a.d.ereignis('o', a.change, 'start', 'beginnt');
    expect(a.gesendet.at(-1)).toBe('owner/telegram/Wartung beginnt: Matrix umziehen');
  });
  it('Notfall ignoriert Ankündigung und Fenster; Regel für andere Assets greift nicht', async () => {
    const a = aufbau([nachts], [familie], { type: 'emergency' });
    expect((await a.d.zeitplan('o', a.change)).jetzt).toBe(true);
    const b = aufbau([], [familie], { affectedAssetIds: ['a-x'] });
    expect((await b.d.zeitplan('o', b.change)).jetzt).toBe(true);
  });
  it('Erreichbarkeit je Empfänger', () => {
    expect(erreichbar({ art: 'owner' }, ['push'])).toBe(true);
    expect(erreichbar({ art: 'nutzer', name: 'X' }, ['telegram'])).toBe(false);
    expect(erreichbar({ art: 'nutzer', name: 'X', telegramId: '1' }, ['telegram'])).toBe(true);
    expect(erreichbar({ art: 'kontakt', email: 'a@b.at' }, ['push', 'email'])).toBe(true);
    expect(erreichbar({ art: 'kontakt' }, ['homeassistant'])).toBe(false);
  });
});
