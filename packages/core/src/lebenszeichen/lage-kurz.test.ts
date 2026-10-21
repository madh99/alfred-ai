import { describe, it, expect } from 'vitest';
import { lageKurz } from './lage-kurz.js';

// v1540 — Lage in Kurzform: dieselbe Ampel wie die App (kacheln.dart gesamtZustand)
const jetzt = new Date('2026-10-21T20:00:00Z');
const befund = (id: string, t: string) => ({ id, titel: `Befund ${id}`, quelle: 'haus-check', entstanden: t });

describe('v1540 lageKurz', () => {
  it('grün ohne Störung und ohne Befunde', () => {
    const k = lageKurz({ puls: [{ tier: 'default' }], offen: [], befunde: { offen: [] }, geraete: [{ online: true }, { online: false }, { online: true, status: 'widerrufen' }], kosten: { heuteUsd: 4.2, budgetUsd: 20 } }, [], 0, jetzt);
    expect(k).toMatchObject({ ampel: 'ok', text: 'Alles ruhig', geraete: { online: 1, gesamt: 2 }, kosten: { heute: 4.2, budget: 20 }, vorgang: null });
  });
  it('gelb bei Befunden, jüngste zuerst', () => {
    const k = lageKurz({ befunde: { offen: [befund('a', '2026-10-20T10:00:00Z'), befund('b', '2026-10-21T10:00:00Z')] } }, [], 0, jetzt);
    expect(k.ampel).toBe('warn');
    expect(k.text).toBe('2 Befunde');
    expect(k.befunde.map(b => b.id)).toEqual(['b', 'a']);
  });
  it('rot bei gestörtem Modell oder Wächter — Embeddings zählen nicht; Text ohne Namen', () => {
    expect(lageKurz({ puls: [{ tier: 'embeddings', gestoertSeit: 'x' }] }, [], 0, jetzt).ampel).toBe('ok');
    const k = lageKurz({ puls: [{ tier: 'default', gestoertSeit: 'x' }], offen: [{ art: 'guthaben' }, { art: 'x' }], befunde: { offen: [befund('a', 't')] } }, [], 0, jetzt);
    expect(k).toMatchObject({ ampel: 'bad', text: '1 Modell gestört · 2 Wächter-Meldungen', modelleGestoert: 1, waechter: 2 });
  });
  it('braucht dich: wartende Vorgänge, erster für „Später“; Lage-Zeilen ohne Modell-Hinweis', () => {
    const k = lageKurz({ lage: { stand: 's', text: '### Lage\nBefunde: 2 offen\nHinweis: Das ist der belegte Stand …\nVorgänge: 1 wartet' } },
      [{ id: 'v1', titel: 'RAM prüfen', status: 'wartet' }, { id: 'v2', titel: 'auto', status: 'offen', besitzer: 'alfred' }], 3, jetzt);
    expect(k).toMatchObject({ braucht: 1, bestaetigungen: 3, vorgang: { id: 'v1', titel: 'RAM prüfen' }, lageStand: 's' });
    expect(k.zeilen).toEqual([{ stichwort: 'Befunde', text: '2 offen' }, { stichwort: 'Vorgänge', text: '1 wartet' }]);
  });
});
