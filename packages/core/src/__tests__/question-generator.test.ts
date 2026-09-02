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
    ]);
    questions.upsertAsk.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'q2', ignoreCount: 3 });
    const r = await gen.run('u1', { platform: 'telegram', chatId: 'c1', sendeNachricht: async () => {} });
    expect(r.asked).toBe(0);
    expect(r.skipped + r.ignored).toBe(2);
  });
});
