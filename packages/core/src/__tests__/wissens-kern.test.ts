import { describe, it, expect } from 'vitest';
import {
  bereinigeAttributeNachSchema, normalisierePersonenName, planePersonenNamensHeilung,
  darfUeberschreiben, provEintrag,
} from '../wissens-schema.js';
import { extrahierePersonenFakten, beziehungZuRelation, StammdatenSync } from '../stammdaten-sync.js';
import { VorausschauRadar } from '../vorausschau-radar.js';
import { KnowledgeGraphService } from '../knowledge-graph.js';

// v1146 — S-Serie („Wissens-Kern"): Schema-Positivliste, Identitäts-
// Normalisierung, deterministischer Stammdaten-Sync, Herkunfts-Regeln —
// bewiesen an den Realfällen dieser Session (Noahs Zürich-Müllhalde,
// „Tochter Lena", neues Familienmitglied Ende-zu-Ende).

const LOGGER = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, child: () => LOGGER } as never;

describe('S1 — Schema-Positivliste (Realfall: Noahs Attribut-Müllhalde)', () => {
  it('entfernt den Zürich-/friend-/Bekanntschafts-Müll, behält die Stammdaten', () => {
    const noahMuell = {
      birthdate: '2009-04-06', fullName: 'Noah Habel', alias: ['Sohn Noah'], relation_to_user: 'step_son',
      wohnort: 'Zürich', location: 'Zürich', home_location: 'Zürich', employer: 'Zürich Versicherung',
      insurance: 'Zürich Versicherung', expertise: 'sachverständiger', rolle: 'Bekanntschaft',
      relation_to_linus: 'friend', relationship_to_user: 'Bekannt (Ladung Zürich)', context: 'Sachverständiger in Zürich',
      age: 'unbekannt', siblings: ['Lena Dohnal'],
    };
    const { bereinigt, entfernt } = bereinigeAttributeNachSchema('person', noahMuell);
    expect(bereinigt).toEqual({
      birthdate: '2009-04-06', fullName: 'Noah Habel', alias: ['Sohn Noah'], relation_to_user: 'step_son',
    });
    expect(entfernt).toContain('wohnort');
    expect(entfernt).toContain('insurance');
    expect(entfernt).toContain('relation_to_linus');
    expect(entfernt).toContain('expertise');
  });

  it('Orte behalten Geo-Felder, Organisationen ihre Rolle; unbekannte Typen bleiben unangetastet', () => {
    expect(bereinigeAttributeNachSchema('location', { city: 'Altlengbach', isUserHome: true, is_typo: true }).bereinigt)
      .toEqual({ city: 'Altlengbach', isUserHome: true });
    expect(bereinigeAttributeNachSchema('organization', { role: 'Teamlead', quatsch: 1 }).bereinigt)
      .toEqual({ role: 'Teamlead' });
    expect(bereinigeAttributeNachSchema('network_device', { firmware: 'x', port: 8080 }).entfernt).toEqual([]);
  });
});

describe('S4 — Identitäts-Normalisierung', () => {
  it('Rollen-Präfix wird Beziehung („Nichte Emma" ist kein Name)', () => {
    expect(normalisierePersonenName('Nichte Emma')).toEqual({ name: 'Emma', beziehung: 'Nichte' });
    expect(normalisierePersonenName('Tochter Lena')).toEqual({ name: 'Lena', beziehung: 'Tochter' });
    expect(normalisierePersonenName('Markus Dohnal')).toBe(null);
    expect(normalisierePersonenName('Sohn')).toBe(null);
  });

  it('Heilungs-Plan: fullName gewinnt, Rolle wird Beziehung, Kollisionen werden übersprungen', () => {
    const plan = planePersonenNamensHeilung([
      { id: 'l', name: 'Tochter Lena', attributes: { fullName: 'Lena Habel' } },
      { id: 'e', name: 'Schwester Elisabeth', attributes: {} },
      { id: 'x', name: 'Sohn Noah', attributes: { fullName: 'Noah Habel' } },
      { id: 'n', name: 'Noah Habel', attributes: {} }, // Kollision → x wird übersprungen
      { id: 'u', name: 'User', attributes: {} },
    ]);
    expect(plan).toEqual([
      { id: 'l', alterName: 'Tochter Lena', neuerName: 'Lena Habel', beziehung: 'Tochter' },
      { id: 'e', alterName: 'Schwester Elisabeth', neuerName: 'Elisabeth', beziehung: 'Schwester' },
    ]);
  });
});

describe('S2 — Herkunfts-Regeln', () => {
  it('explizite Aussage schlägt Extraktion schlägt LLM; unbelegt darf immer', () => {
    expect(darfUeberschreiben(undefined, 'llm')).toBe(true);
    expect(darfUeberschreiben(provEintrag('llm', 0.5), 'memory:child_x')).toBe(true);
    expect(darfUeberschreiben(provEintrag('memory:child_x', 0.95), 'llm')).toBe(false);
    expect(darfUeberschreiben(provEintrag('memory:a', 0.9), 'memory:b')).toBe(true);
    expect(darfUeberschreiben(provEintrag('chat', 1), 'memory:b')).toBe(false);
  });
});

describe('S3 — extrahierePersonenFakten (Realfälle)', () => {
  it('„Nichte Emma, geboren 12.03.2020" → Vorname, Beziehung, Geburtsdatum', () => {
    const f = extrahierePersonenFakten([{ key: 'niece_emma', value: 'Nichte Emma, geboren 12.03.2020, spielt gern Lego', confidence: 0.95 }]);
    expect(f).toEqual([expect.objectContaining({ vorname: 'Emma', beziehung: 'Nichte', birthdate: '2020-03-12' })]);
  });

  it('Bestands-Realfälle: child_lena + full_name-Key + Ehefrau-Muster', () => {
    const f = extrahierePersonenFakten([
      { key: 'child_lena', value: 'Tochter Lena, geboren 18.09.2005', confidence: 0.95 },
      { key: 'child_lena_full_name', value: 'Lena Habel', confidence: 1 },
      { key: 'spouse_alex', value: 'Alexandra ist meine Ehefrau', confidence: 1 },
    ]);
    const lena = f.find(x => x.vorname === 'Lena');
    expect(lena?.birthdate).toBe('2005-09-18');
    expect(lena?.beziehung).toBe('Tochter');
    expect(lena?.fullName).toBe('Lena Habel');
    expect(f.find(x => x.vorname === 'Alexandra')?.beziehung).toBe('Ehefrau');
  });

  it('niedrige Confidence und interne Keys werden ignoriert', () => {
    expect(extrahierePersonenFakten([
      { key: 'geraten', value: 'Nichte Emma, geboren 12.03.2020', confidence: 0.5 },
      { key: 'insight_delivered:x', value: 'Nichte Emma, geboren 12.03.2020', confidence: 1 },
    ])).toEqual([]);
  });

  it('beziehungZuRelation: Kinder/Eltern/Partner/Rest korrekt gerichtet', () => {
    expect(beziehungZuRelation('Tochter')).toEqual({ typ: 'parent_of', richtung: 'user_zu_person' });
    expect(beziehungZuRelation('Mutter')).toEqual({ typ: 'parent_of', richtung: 'person_zu_user' });
    expect(beziehungZuRelation('Ehefrau')).toEqual({ typ: 'spouse', richtung: 'user_zu_person' });
    expect(beziehungZuRelation('Nichte')).toEqual({ typ: 'family', richtung: 'user_zu_person' });
  });
});

// ── S5 — Ende-zu-Ende: „Wir haben ein neues Familienmitglied" ─────────────

function makeInMemoryKg() {
  const entities: Array<{ id: string; name: string; entityType: string; attributes: Record<string, unknown>; sources: string[]; mentionCount: number }> = [
    { id: 'u', name: 'User', entityType: 'person', attributes: {}, sources: ['system'], mentionCount: 1 },
  ];
  const relations: Array<{ id: string; sourceEntityId: string; targetEntityId: string; relationType: string; context: string | null; sourceSection: string }> = [];
  let seq = 0;
  return {
    entities, relations,
    upsertEntity: async (_u: string, name: string, entityType: string, attrs?: Record<string, unknown>, source?: string) => {
      const norm = name.trim().toLowerCase();
      let e = entities.find(x => x.entityType === entityType && x.name.trim().toLowerCase() === norm);
      if (e) { e.attributes = { ...e.attributes, ...(attrs ?? {}) }; return e; }
      e = { id: `e${++seq}`, name, entityType, attributes: attrs ?? {}, sources: source ? [source] : [], mentionCount: 1 };
      entities.push(e);
      return e;
    },
    getEntitiesByType: async (_u: string, t: string) => entities.filter(e => e.entityType === t),
    setEntityAttributes: async (id: string, attrs: Record<string, unknown>) => {
      const e = entities.find(x => x.id === id); if (e) e.attributes = attrs;
    },
    upsertRelation: async (_u: string, s: string, t: string, typ: string, ctx?: string, sec?: string) => {
      if (!relations.some(r => r.sourceEntityId === s && r.targetEntityId === t && r.relationType === typ)) {
        relations.push({ id: `r${++seq}`, sourceEntityId: s, targetEntityId: t, relationType: typ, context: ctx ?? null, sourceSection: sec ?? 'test' });
      }
      return relations[relations.length - 1];
    },
    getFullGraph: async () => ({ entities, relations }),
    renameEntity: async (id: string, neu: string) => { const e = entities.find(x => x.id === id); if (e) { e.name = neu; return true; } return false; },
  };
}

describe('S5 — E2E: neues Familienmitglied läuft durch die komplette Kette', () => {
  it('Memory → Person „Emma" mit Datum+Beziehung+Herkunft → Familien-Block → Vorausschau', async () => {
    const kg = makeInMemoryKg();
    const memoryRepo = {
      listAll: async () => [
        { key: 'niece_emma', value: 'Nichte Emma, geboren 12.03.2020, spielt gern Lego', confidence: 0.95 },
      ],
    } as never;

    // 1. Stammdaten-Sync: Person entsteht KORREKT (Name ohne Rollen-Präfix)
    const sync = new StammdatenSync(kg as never, memoryRepo, LOGGER);
    const r = await sync.run('u1');
    expect(r.angelegt).toBe(1);
    const emma = kg.entities.find(e => e.name === 'Emma');
    expect(emma).toBeDefined();
    expect(emma?.attributes.birthdate).toBe('2020-03-12');
    expect(emma?.attributes.relation_to_user).toBe('Nichte');
    expect((emma?.attributes._prov as Record<string, { q: string }>).birthdate.q).toBe('memory:niece_emma');
    expect(kg.relations.some(x => x.relationType === 'family' && x.targetEntityId === emma?.id)).toBe(true);

    // 2. Stammdaten-Block: Emma erscheint im Chat-Kontext
    const svc = new KnowledgeGraphService(kg as never, LOGGER);
    const kontext = await svc.buildPersonalContext('u1');
    expect(kontext).toContain('Emma');

    // 3. Vorausschau: 7 Tage vor dem Geburtstag kommt die Erinnerung
    const gemeldet: Array<{ title: string }> = [];
    const insights = { upsertCandidate: async (_u: string, c: { title: string }) => { gemeldet.push(c); return {}; } } as never;
    const radar = new VorausschauRadar(kg as never, { listAll: async () => [] } as never, insights, LOGGER);
    await radar.run('u1', new Date(2027, 2, 5)); // 05.03. → 12.03. sind 7 Tage
    expect(gemeldet.some(g => g.title.includes('Emma') && g.title.includes('in 7 Tagen'))).toBe(true);

    // 4. Idempotenz: zweiter Lauf legt nichts doppelt an
    const r2 = await sync.run('u1');
    expect(r2.angelegt).toBe(0);
    expect(kg.entities.filter(e => e.name === 'Emma').length).toBe(1);
  });
});
