import { describe, it, expect } from 'vitest';
import { LearnedRecipeRepository } from './learned-recipe-repository.js';

// v1147 — P2: zentrale Recipe-Validierung. Das v722-Feature hatte in Monaten
// genau EINEN Eintrag produziert — mit leerer Trigger-Phrase, den der
// Pipeline-Matcher nie finden konnte.

const fakeAdapter = { execute: async () => undefined, query: async () => [], queryOne: async () => undefined } as never;

describe('LearnedRecipeRepository.create — Validierung', () => {
  const repo = new LearnedRecipeRepository(fakeAdapter);

  it('leere Trigger-Phrase wird abgelehnt (der Realfall)', async () => {
    await expect(repo.create({
      userId: 'u', triggerPhrase: '', triggerKeywords: [], actionSequence: [{ skill: 'sonos', action: 'play' }], source: 'chat',
    } as never)).rejects.toThrow(/trigger_phrase/);
  });

  it('leere oder kaputte action_sequence wird abgelehnt', async () => {
    await expect(repo.create({
      userId: 'u', triggerPhrase: 'starte radio göd', triggerKeywords: ['radio'], actionSequence: [], source: 'chat',
    } as never)).rejects.toThrow(/action_sequence/);
    await expect(repo.create({
      userId: 'u', triggerPhrase: 'starte radio göd', triggerKeywords: ['radio'], actionSequence: [{ params: {} }], source: 'chat',
    } as never)).rejects.toThrow(/action_sequence/);
  });

  it('gültiges Rezept passiert; fehlende Keywords werden aus der Phrase abgeleitet', async () => {
    const r = await repo.create({
      userId: 'u', triggerPhrase: 'starte radio göd', triggerKeywords: [], actionSequence: [{ skill: 'sonos', action: 'play' }], source: 'chat',
    } as never);
    expect(r.triggerKeywords).toContain('starte');
    expect(r.triggerKeywords).toContain('radio');
  });
});
