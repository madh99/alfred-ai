import { describe, it, expect } from 'vitest';
import { openItemTitleSimilarity } from './project-manager.js';

/** v869 — Titel-Dedup gegen das ungebremste Open-Item-Wachstum (554 Items). */
describe('openItemTitleSimilarity', () => {
  it('identische Titel → 1', () => {
    expect(openItemTitleSimilarity('Hovercard Tests ergänzen', 'Hovercard Tests ergänzen')).toBe(1);
  });

  it('Umformulierung desselben Punkts → >= 0.7 (wird dedupliziert)', () => {
    expect(openItemTitleSimilarity(
      'UGC-Medienanzeige im Frontend reparieren',
      'Medienanzeige für UGC im Frontend reparieren',
    )).toBeGreaterThanOrEqual(0.7);
  });

  it('verschiedene Punkte im selben Projekt → < 0.7 (bleiben getrennt)', () => {
    expect(openItemTitleSimilarity(
      'Admin-Reviewroute statusunabhängig machen',
      'Chat-Sounds bei neuen Nachrichten abspielen',
    )).toBeLessThan(0.7);
  });

  it('Case/Sonderzeichen-tolerant', () => {
    expect(openItemTitleSimilarity(
      'Forum-Moderation: Thread-Override testen!',
      'forum moderation thread override testen',
    )).toBeGreaterThanOrEqual(0.7);
  });

  it('leere/kurze Titel crashen nicht', () => {
    expect(openItemTitleSimilarity('', '')).toBe(1);
    expect(openItemTitleSimilarity('ab', 'ab')).toBe(1);
    expect(openItemTitleSimilarity('', 'etwas')).toBe(0);
  });
});
