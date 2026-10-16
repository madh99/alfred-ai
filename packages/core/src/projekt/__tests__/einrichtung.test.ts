import { describe, it, expect } from 'vitest';
import { einrichtungStand, einrichtungHinweis, ProjektAktenUeberProjekte } from '../akten-projekte.js';

// v1486 F5 — Einrichtung eines Geräte-Projekts aus den vorhandenen Einstellungen, „passt so“ als Tag
describe('Einrichtung', () => {
  it('neues Projekt: 0/5, Hinweis nennt alles; nie eine Kostengrenze', () => {
    const e = einrichtungStand({ tags: ['geraet'] });
    expect(e.erledigt).toBe(0);
    expect(e.gesamt).toBe(5);
    expect(einrichtungHinweis(e)).toMatch(/^🧭 Einrichtung 0\/5 — offen: Repository · Prüfbefehle · Merge Requests · Projektregeln · Protokoll im Repository/);
    expect(JSON.stringify(e)).not.toMatch(/kosten|budget|grenze/i);
  });

  it('aus den Einstellungen und „passt so“; alles eingerichtet → kein Hinweis', () => {
    const e = einrichtungStand({ repoUrl: 'https://git.example/x.git', pruefBefehle: ['npm test'], tags: ['eingerichtet:mr', 'protokoll-aus'], conventions: { changelog: { pflegen: true } } });
    expect(e.schritte.map(s => [s.schritt, s.erledigt])).toEqual([['repo', true], ['pruefung', true], ['mr', true], ['regeln', true], ['protokoll', true]]);
    expect(e.schritte.find(s => s.schritt === 'mr')!.stand).toMatch(/^aus/);
    expect(einrichtungHinweis(e)).toBeUndefined();
    const k = einrichtungStand({ tags: ['eingerichtet:repo'] });
    expect(k.schritte[0]!.stand).toMatch(/keins/);
    expect(k.erledigt).toBe(1);
  });

  it('Schalter markieren den Schritt; „passt so“ nur einmal; fremde Projekte nie', async () => {
    const p: { id: string; geraetId?: string; tags: string[] } = { id: 'p1', geraetId: 'g1', tags: ['geraet'] };
    const repo = { getById: async (_u: string, id: string) => (id === 'p1' ? p : null), update: async (_u: string, _id: string, f: { tags: string[] }) => { p.tags = f.tags; } };
    const a = new ProjektAktenUeberProjekte(repo as never);
    await a.setzeMergeRequests('o', 'p1', false);
    expect(p.tags).toContain('eingerichtet:mr');
    await a.setzeProtokoll('o', 'p1', true);
    expect(p.tags.filter(t => t === 'eingerichtet:protokoll')).toHaveLength(1);
    await a.setzeProtokoll('o', 'p1', false);
    expect(p.tags.filter(t => t === 'eingerichtet:protokoll')).toHaveLength(1);
    expect(p.tags).toContain('protokoll-aus');
    expect(await a.einrichtungOk('o', 'p1', 'regeln')).toBe(true);
    await a.einrichtungOk('o', 'p1', 'regeln');
    expect(p.tags.filter(t => t === 'eingerichtet:regeln')).toHaveLength(1);
    expect(await a.einrichtungOk('o', 'fremd', 'regeln')).toBe(false);
    expect(einrichtungStand(p).erledigt).toBe(3);
  });
});
