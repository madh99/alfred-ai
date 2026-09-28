import { describe, it, expect, vi } from 'vitest';
import { KgQuestionGenerator } from '../insights/question-generator.js';

// v1155 — Realfall 02.09.: Der Generator fragte „Wann hat Hannah Dohnal
// Geburtstag?" und „Wie steht Hannah Dohnal zu dir?", obwohl der KG beides
// längst wusste (birthdate 2019-10-22, relation_to_user Tochter) — er prüfte
// die Alt-Keys birthday/relation_to_owner. Zustellung war eine absurde
// Ja/Nein-Confirmation mit toter memory-action 'add'.

function makeGenerator(entities: Array<Record<string, unknown>>) {
  const kg = { listEntities: vi.fn().mockResolvedValue(entities) };
  const questions = {
    upsertAsk: vi.fn().mockResolvedValue({ id: 'q1', ignoreCount: 0 }),
    ignoreRateForAttribute: vi.fn().mockResolvedValue(0),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const gen = new KgQuestionGenerator(kg as any, questions as any, logger as any);
  return { gen, questions };
}

const HANNAH = {
  id: 'e1', name: 'Hannah Dohnal', entityType: 'person', mentionCount: 900,
  attributes: { birthdate: '2019-10-22', relation_to_user: 'Tochter' },
};

describe('v1155 — KgQuestionGenerator', () => {
  it('fragt NICHT nach Fakten, die der KG unter den Standard-Keys kennt (Hannah-Realfall)', async () => {
    const { gen } = makeGenerator([HANNAH]);
    const gesendet: string[] = [];
    const r = await gen.run('u1', { platform: 'telegram', chatId: 'c1', sendeNachricht: async t => { gesendet.push(t); } });
    expect(r.asked).toBe(0);
    expect(gesendet).toHaveLength(0);
  });

  it('Rollen-Präfix im Namen zählt als bekannte Beziehung', async () => {
    const { gen } = makeGenerator([{
      id: 'e2', name: 'Tochter Lena', entityType: 'person', mentionCount: 50,
      attributes: { birthdate: '2013-05-01' },
    }]);
    const r = await gen.run('u1', { platform: 'telegram', chatId: 'c1', sendeNachricht: async () => {} });
    expect(r.asked).toBe(0);
  });

  it('echte Lücken werden als EINE gebündelte Chat-Nachricht gestellt', async () => {
    const { gen } = makeGenerator([
      { id: 'e3', name: 'Elisabeth', entityType: 'person', mentionCount: 40, attributes: { relation_to_user: 'Schwester' } },
      { id: 'e4', name: 'Bernhard', entityType: 'person', mentionCount: 30, attributes: { birthdate: '1980-01-01' } },
    ]);
    const gesendet: string[] = [];
    const r = await gen.run('u1', { platform: 'telegram', chatId: 'c1', sendeNachricht: async t => { gesendet.push(t); } });
    expect(r.asked).toBe(2);
    expect(gesendet).toHaveLength(1);
    expect(gesendet[0]).toContain('Wann hat **Elisabeth** Geburtstag?');
    expect(gesendet[0]).toContain('Wie steht **Bernhard** zu dir?');
    expect(gesendet[0]).toContain('Einfach antworten');
    expect(gesendet[0]).not.toContain('Approve');
  });

  it('Anti-Nagging: upsertAsk=null (Cooldown) überspringt, ignoreCount≥3 unterdrückt dauerhaft', async () => {
    const { gen, questions } = makeGenerator([
      { id: 'e5', name: 'Max', entityType: 'person', mentionCount: 20, attributes: {} },
      { id: 'e6', name: 'Moritz', entityType: 'person', mentionCount: 10, attributes: {} },
    ]);
    questions.upsertAsk.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'q2', ignoreCount: 3 });
    const r = await gen.run('u1', { platform: 'telegram', chatId: 'c1', sendeNachricht: async () => {} });
    expect(r.asked).toBe(0);
    expect(r.skipped + r.ignored).toBe(2);
  });

  // v1157 — Realfälle: KG enthielt „Mistral"/„Sportverein" als Personen und
  // „Erinnerung aktiv seit" als Organisation; Geburtstag erst bei bekannter Beziehung.
  it('v1157: fragt nie nach System-/Gattungs-/Fragment-Entitäten', async () => {
    const { gen } = makeGenerator([
      { id: 'j1', name: 'Mistral', entityType: 'person', mentionCount: 240, attributes: {} },
      { id: 'j2', name: 'Sportverein', entityType: 'person', mentionCount: 240, attributes: {} },
      { id: 'j3', name: 'Erinnerung aktiv seit', entityType: 'organization', mentionCount: 864, attributes: {} },
    ]);
    const gesendet: string[] = [];
    const r = await gen.run('u1', { platform: 'telegram', chatId: 'c1', sendeNachricht: async t => { gesendet.push(t); } });
    expect(r.asked).toBe(0);
    expect(gesendet).toHaveLength(0);
  });

  // v1158 — Realfälle 27.09.: „Was macht **Mistral** eigentlich?", „Wo liegt **Niederösterreich** genau?"
  it('v1158: System-Organisationen und Regionen/Städte werden nie gefragt, echte Venues schon', async () => {
    const { gen } = makeGenerator([
      { id: 'o1', name: 'Mistral', entityType: 'organization', mentionCount: 3787, attributes: {} },
      { id: 'l1', name: 'Niederösterreich', entityType: 'location', mentionCount: 839, attributes: {} },
      { id: 'l2', name: 'St. Pölten', entityType: 'location', mentionCount: 50, attributes: {} },
      { id: 'l3', name: 'Praxis Dr. Steindl', entityType: 'location', mentionCount: 12, attributes: {} },
    ]);
    const gesendet: string[] = [];
    const r = await gen.run('u1', { platform: 'telegram', chatId: 'c1', sendeNachricht: async t => { gesendet.push(t); } });
    expect(r.asked).toBe(1);
    expect(gesendet[0]).toContain('Praxis Dr. Steindl');
    expect(gesendet[0]).not.toContain('Mistral');
    expect(gesendet[0]).not.toContain('Niederösterreich');
  });

  it('v1157: ohne bekannte Beziehung wird nur die Beziehung gefragt, nicht der Geburtstag', async () => {
    const { gen } = makeGenerator([
      { id: 'p1', name: 'Sabine', entityType: 'person', mentionCount: 30, attributes: {} },
    ]);
    const gesendet: string[] = [];
    await gen.run('u1', { platform: 'telegram', chatId: 'c1', sendeNachricht: async t => { gesendet.push(t); } });
    expect(gesendet[0]).toContain('Wie steht **Sabine** zu dir?');
    expect(gesendet[0]).not.toContain('Geburtstag');
  });
});
