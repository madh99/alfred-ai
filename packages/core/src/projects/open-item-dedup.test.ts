import { describe, it, expect } from 'vitest';
import { openItemTitleSimilarity, filterEchoOpenItems } from './project-manager.js';

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

/** v869.2 — deterministischer Echo-Filter. Fixture = REALER Vorfall 11.06.
 *  (Session 85f9d56e): Summarizer echote die abgeschlossenen Phasen als
 *  "offene" Punkte zurück. */
describe('filterEchoOpenItems', () => {
  const INCIDENT_MILESTONES = [
    'Plan erstellt',
    'Phase 1: Chat-Komponente mit Scroll-Verhalten im Repo lokalisieren',
    'Phase 2: Auto-Scroll-Logik fixen: nur bei neuen Nachrichten nach unten, nicht nach oben',
  ];
  const INCIDENT_ITEMS = [
    { title: 'Chat-Komponente mit Scroll-Verhalten im Repo lokalisieren' },
    { title: 'Auto-Scroll-Logik fixen: nur bei neuen Nachrichten nach unten scrollen' },
    { title: 'Test für Scroll-Verhalten ergänzen' },
  ];

  it('Vorfalls-Fixture: Phasen-Echos werden verworfen, echtes Rest-Item bleibt', () => {
    const { kept, skipped } = filterEchoOpenItems(INCIDENT_ITEMS, { milestones: INCIDENT_MILESTONES });
    expect(skipped.map(s => s.reason)).toEqual(['milestone-echo', 'milestone-echo']);
    // "Test ergänzen" matched keine Phase — bleibt (kann legitim offen sein,
    // dafür ist die Prompt-Schicht zuständig)
    expect(kept.map(k => k.title)).toEqual(['Test für Scroll-Verhalten ergänzen']);
  });

  it('Milestone-Filter greift auch bei failed Sessions (erreichte Phasen SIND erledigt)', () => {
    const { skipped } = filterEchoOpenItems(
      [{ title: 'Chat-Komponente mit Scroll-Verhalten im Repo lokalisieren' }],
      { milestones: INCIDENT_MILESTONES, success: false },
    );
    expect(skipped[0]?.reason).toBe('milestone-echo');
  });

  it('Goal-Echo: bei success=true werden Goal-Zeilen-Echos verworfen', () => {
    const goal = [
      'Arbeite die folgenden offenen Punkte ab:',
      '1. **UGC-Medienanzeige im Frontend reparieren**',
      '2. **Admin-Reviewroute statusunabhängig machen**',
    ].join('\n');
    const { kept, skipped } = filterEchoOpenItems(
      [
        { title: 'UGC-Medienanzeige im Frontend reparieren' },
        { title: 'Performance der Galerie-Seite messen' },
      ],
      { goal, success: true },
    );
    expect(skipped.map(s => s.reason)).toEqual(['goal-echo']);
    expect(kept.map(k => k.title)).toEqual(['Performance der Galerie-Seite messen']);
  });

  it('Goal-Echo greift NICHT bei failed Sessions (Goal-Inhalt kann legitim offen sein)', () => {
    const goal = '1. UGC-Medienanzeige im Frontend reparieren';
    const { kept } = filterEchoOpenItems(
      [{ title: 'UGC-Medienanzeige im Frontend reparieren' }],
      { goal, success: false },
    );
    expect(kept.length).toBe(1);
  });

  it('Duplikate gegen Bestand + Intra-Batch werden weiter gefangen (v869-Verhalten)', () => {
    const { kept, skipped } = filterEchoOpenItems(
      [
        { title: 'Medienanzeige für UGC im Frontend reparieren' }, // ≈ Bestand
        { title: 'Galerie-Lazy-Loading einbauen' },
        { title: 'Lazy-Loading für die Galerie einbauen' },        // ≈ Batch-Vorgänger
      ],
      { existingTitles: ['UGC-Medienanzeige im Frontend reparieren'] },
    );
    expect(skipped.map(s => s.reason)).toEqual(['duplicate', 'duplicate']);
    expect(kept.map(k => k.title)).toEqual(['Galerie-Lazy-Loading einbauen']);
  });

  it('"Plan erstellt"-Milestone filtert keine echten Plan-Items', () => {
    const { kept } = filterEchoOpenItems(
      [{ title: 'Deployment-Plan für Staging erstellen' }],
      { milestones: ['Plan erstellt'] },
    );
    expect(kept.length).toBe(1);
  });
});
