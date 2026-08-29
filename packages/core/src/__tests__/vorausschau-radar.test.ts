import { describe, it, expect } from 'vitest';
import { VorausschauRadar, naechstesVorkommen, tageBis, vorlaufStufe, parseGeburtsdatum } from '../vorausschau-radar.js';

// v1145 — K3: „he, nicht vergessen — X hat Geburtstag, ein nettes Geschenk
// wäre …" — deterministische Vorausschau (7 Tage + Vortag), generisch für
// alle datierbaren Ereignisse, LLM nur für den Vorschlags-Satz (optional).

const LOGGER = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, child: () => LOGGER } as never;

describe('Helfer', () => {
  it('naechstesVorkommen: Geburtstag dieses Jahr noch vor uns bzw. schon vorbei', () => {
    const geb = new Date(2009, 3, 6); // 06.04.2009
    expect(naechstesVorkommen(geb, new Date(2026, 2, 30)).getFullYear()).toBe(2026);
    expect(naechstesVorkommen(geb, new Date(2026, 4, 1)).getFullYear()).toBe(2027);
    expect(naechstesVorkommen(geb, new Date(2026, 3, 6)).getFullYear()).toBe(2026); // am Tag selbst
  });

  it('vorlaufStufe: genau 7 Tage und Vortag, sonst nichts', () => {
    expect(vorlaufStufe(7)).toBe('7tage');
    expect(vorlaufStufe(1)).toBe('vortag');
    expect(vorlaufStufe(3)).toBe(null);
    expect(vorlaufStufe(0)).toBe(null);
  });

  it('parseGeburtsdatum: ISO und deutsches Format, alle Attribut-Varianten', () => {
    expect(parseGeburtsdatum({ birthdate: '2009-04-06' })?.getFullYear()).toBe(2009);
    expect(parseGeburtsdatum({ birthday: '06.04.2009' })?.getMonth()).toBe(3);
    expect(parseGeburtsdatum({})).toBe(null);
  });
});

function makeRadar(memories: Array<{ key: string; value: string; relevantUntil?: string }> = []) {
  const gemeldet: Array<{ dedupeKey?: string; title: string; category: string; sourceData?: Record<string, unknown> }> = [];
  const kgRepo = {
    getEntitiesByType: async () => [
      { id: 'noah', name: 'Noah Habel', entityType: 'person', attributes: { birthdate: '2009-04-06', relation_to_user: 'step_son', sport: 'Fußball' }, sources: [] },
      { id: 'u', name: 'User', entityType: 'person', attributes: {}, sources: [] },
    ],
  } as never;
  const memoryRepo = { listAll: async () => memories } as never;
  const insights = { upsertCandidate: async (_u: string, c: never) => { gemeldet.push(c); return {}; } } as never;
  return { radar: new VorausschauRadar(kgRepo, memoryRepo, insights, LOGGER), gemeldet };
}

describe('VorausschauRadar', () => {
  it('Realfall: 7 Tage vor Noahs Geburtstag kommt GENAU EINE Meldung mit stabilem Dedup-Schlüssel', async () => {
    const { radar, gemeldet } = makeRadar();
    const n = await radar.run('u', new Date(2026, 2, 30)); // 30.03. → 06.04. sind 7 Tage
    expect(n).toBe(1);
    expect(gemeldet[0].title).toContain('🎂');
    expect(gemeldet[0].title).toContain('Noah Habel');
    expect(gemeldet[0].title).toContain('in 7 Tagen');
    expect(gemeldet[0].dedupeKey).toBe('vorausschau:geburtstag:noah:2026:7tage');
    expect(gemeldet[0].sourceData?.router).toBe(true);
  });

  it('am Vortag zweite Stufe — eigener Schlüssel, Alter im Kontext', async () => {
    const { radar, gemeldet } = makeRadar();
    await radar.run('u', new Date(2026, 3, 5)); // 05.04.
    expect(gemeldet[0].title).toContain('morgen');
    expect(gemeldet[0].dedupeKey).toBe('vorausschau:geburtstag:noah:2026:vortag');
  });

  it('dazwischen (3 Tage vorher) und danach: keine Meldung', async () => {
    const { radar, gemeldet } = makeRadar();
    await radar.run('u', new Date(2026, 3, 3));
    await radar.run('u', new Date(2026, 3, 10));
    expect(gemeldet.length).toBe(0);
  });

  it('generisch: Memory-Termin morgen meldet; interne Keys und ferne Termine nicht', async () => {
    const { radar, gemeldet } = makeRadar([
      { key: 'tuev_bmw', value: 'BMW i4 TÜV-Termin', relevantUntil: '2026-08-30T10:00:00Z' },
      { key: 'insight_delivered:xyz', value: 'Termin 30.08.2026', relevantUntil: '2026-08-30T10:00:00Z' },
      { key: 'urlaub_planung', value: 'Familienurlaub ab 15.10.2026' },
    ]);
    await radar.run('u', new Date(2026, 7, 29)); // 29.08.
    const termine = gemeldet.filter(g => g.title.includes('📅'));
    expect(termine.length).toBe(1);
    expect(termine[0].title).toContain('TÜV');
    expect(termine[0].dedupeKey).toBe('vorausschau:memory:tuev_bmw:2026:vortag');
  });
});
