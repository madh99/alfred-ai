import { describe, it, expect } from 'vitest';
import { istImRuhefenster } from '../delivery-scheduler.js';
import { KnowledgeGraphService } from '../knowledge-graph.js';
import { EmbeddingService } from '../embedding-service.js';

// v1144 — K1/K2: Chat-Stammdaten (Realfall „wann hat mein Sohn Geburtstag?"
// — zwei Söhne, beide fehlten bzw. ohne Geburtsdatum) und Ruhefenster
// (Realfall: 10 Insights um 04:02 Uhr).

const LOGGER = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, child: () => LOGGER } as never;

describe('K2 — istImRuhefenster', () => {
  it('Über-Mitternacht-Fenster 22–7: nachts zu, tagsüber offen', () => {
    expect(istImRuhefenster(23, [22, 7])).toBe(true);
    expect(istImRuhefenster(4, [22, 7])).toBe(true);   // der 04:02-Realfall
    expect(istImRuhefenster(7, [22, 7])).toBe(false);
    expect(istImRuhefenster(12, [22, 7])).toBe(false);
    expect(istImRuhefenster(21, [22, 7])).toBe(false);
  });

  it('Tagesfenster und degeneriertes Fenster', () => {
    expect(istImRuhefenster(13, [12, 14])).toBe(true);
    expect(istImRuhefenster(14, [12, 14])).toBe(false);
    expect(istImRuhefenster(9, [7, 7])).toBe(false);
  });
});

describe('K1 Stufe 1 — Stammdaten-Block (buildPersonalContext)', () => {
  function makeKg() {
    const user = { id: 'u', name: 'User', entityType: 'person', attributes: {}, sources: ['system'] };
    const noah = { id: 'n', name: 'Noah Habel', entityType: 'person', attributes: { birthdate: '2009-04-06', relation_to_user: 'step_son' }, sources: ['memories'] };
    const linus = { id: 'l', name: 'Linus Dohnal', entityType: 'person', attributes: { birthdate: '2014-11-08', relation_to_user: 'son' }, sources: ['memories'] };
    const lena = { id: 'le', name: 'Tochter Lena', entityType: 'person', attributes: { birthdate: '2005-09-18', fullName: 'Lena Habel' }, sources: ['memories'] };
    const maria = { id: 'm', name: 'Maria Dohnal', entityType: 'person', attributes: {}, sources: ['memories'] };
    const entities = [user, noah, linus, lena, maria];
    const relations = [
      // gemischte Richtungen wie in der echten DB: parent_of VOM User,
      // child_of ZUM User, und die Mutter als parent_of AUF den User
      { id: 'r1', sourceEntityId: 'u', targetEntityId: 'l', relationType: 'parent_of', context: null },
      { id: 'r2', sourceEntityId: 'n', targetEntityId: 'u', relationType: 'child_of', context: null },
      { id: 'r3', sourceEntityId: 'u', targetEntityId: 'le', relationType: 'parent_of', context: 'child_lena' },
      { id: 'r4', sourceEntityId: 'm', targetEntityId: 'u', relationType: 'parent_of', context: null },
    ];
    return {
      getFullGraph: async () => ({ entities, relations }),
    } as never;
  }

  it('Realfall: BEIDE Söhne erscheinen mit Rolle und Geburtsdatum — auch der child_of-verknüpfte', async () => {
    const svc = new KnowledgeGraphService(makeKg(), LOGGER);
    const text = await svc.buildPersonalContext('u');
    expect(text).toContain('Noah Habel (Stiefsohn');
    expect(text).toContain('geb. 2009-04-06');
    expect(text).toContain('Linus Dohnal (Sohn');
    expect(text).toContain('geb. 2014-11-08');
  });

  it('Richtung zählt: die Mutter erscheint als Elternteil, nicht als Kind', async () => {
    const svc = new KnowledgeGraphService(makeKg(), LOGGER);
    const text = await svc.buildPersonalContext('u');
    expect(text).toContain('Maria Dohnal (Elternteil)');
    expect(text).not.toContain('Maria Dohnal (Kind');
  });

  it('fullName und Geburtsdatum der Tochter stehen im Block', async () => {
    const svc = new KnowledgeGraphService(makeKg(), LOGGER);
    const text = await svc.buildPersonalContext('u');
    expect(text).toContain('Tochter Lena (Tochter, Lena Habel, geb. 2005-09-18');
  });
});

describe('K1 Stufe 2 — semanticSearchByType', () => {
  it('liefert nur den gewünschten sourceType, sortiert nach Ähnlichkeit', async () => {
    const llm = { supportsEmbeddings: () => true, embed: async () => ({ embedding: [1, 0], model: 'm', dimensions: 2 }) } as never;
    const repo = {
      vectorSearch: async () => null, // Fallback-Pfad (JS-Cosine)
      findByUser: async () => [
        { sourceType: 'kg_entity', sourceId: 'noah', content: 'Noah Habel [person] — Sohn', embedding: [1, 0] },
        { sourceType: 'kg_entity', sourceId: 'wallbox', content: 'Wallbox [item]', embedding: [0, 1] },
        { sourceType: 'memory', sourceId: 'mem1', content: 'Sohn Noah Geburtstag', embedding: [1, 0] },
      ],
    } as never;
    const svc = new EmbeddingService(llm, repo, LOGGER);
    const hits = await svc.semanticSearchByType('u', 'wann hat mein Sohn Geburtstag?', 'kg_entity', 5, 0.5);
    expect(hits.map(h => h.sourceId)).toEqual(['noah']);
    expect(hits[0].content).toContain('Noah Habel');
  });
});
