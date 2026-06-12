import { describe, it, expect } from 'vitest';
import { openItemTitleSimilarity, openItemTitleContainment, filterEchoOpenItems, isDocsOnlyRun, pickPrimaryDoc } from './project-manager.js';

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

/** v869.5 — Doku-only-Gate: das Verhalten von Nicht-Doku-Läufen darf sich
 *  NICHT ändern (Zusicherung an den User, per Test festgepinnt). */
describe('isDocsOnlyRun', () => {
  it('Vorfalls-Fixture f3a8d888 (2 Docs + CHANGELOG) → true', () => {
    expect(isDocsOnlyRun([
      'docs/profile-privacy-gdpr-audit.md',
      'docs/profile-privacy-consolidation-proposal.md',
      'CHANGELOG.md',
    ])).toBe(true);
  });

  it('normaler Code-Lauf → false (eine .tsx reicht)', () => {
    expect(isDocsOnlyRun(['src/app/community/chat/ChatClient.tsx', 'CHANGELOG.md'])).toBe(false);
  });

  it('Misch-Lauf (Code + Docs) → false (konservativ)', () => {
    expect(isDocsOnlyRun(['docs/proposal.md', 'src/lib/auth.ts'])).toBe(false);
  });

  it('leere Liste / undefined → false', () => {
    expect(isDocsOnlyRun([])).toBe(false);
    expect(isDocsOnlyRun(undefined)).toBe(false);
  });

  it('pickPrimaryDoc überspringt CHANGELOG/README', () => {
    expect(pickPrimaryDoc(['CHANGELOG.md', 'README.md', 'docs/proposal.md'])).toBe('docs/proposal.md');
    expect(pickPrimaryDoc(['CHANGELOG.md'])).toBeUndefined();
  });
});

/** v878 — Containment + Template-Echos. Fixtures = REALE Geister vom 12.06.
 *  (Sessions 362a28f7 + 68a08f61): 6 Items an einem Tag trotz v869.2-Filter. */
describe('filterEchoOpenItems v878 (Containment + Template-Echos)', () => {
  it('Klammer-Suffix-Duplikate werden gefangen (Jaccard 0.60/0.57 versagte)', () => {
    const existingTitles = [
      'Temporäre Bans durchsetzen (duration wird nie angewendet)',
      'Mute-Expiry konsistent aufheben (unmute-Aktion/History)',
      'BUG-MOD-03: Moderations-Notifications implementieren (approve/reject/delete/ban/mute/warn)',
    ];
    const { kept, skipped } = filterEchoOpenItems(
      [
        { title: 'Temporäre Bans durchsetzen' },
        { title: 'Mute-Expiry konsistent aufheben' },
        { title: 'Moderations-Notifications implementieren' },
      ],
      { existingTitles, success: false },
    );
    expect(kept).toEqual([]);
    expect(skipped.map(s => s.reason)).toEqual(['duplicate', 'duplicate', 'duplicate']);
  });

  it('Flexions-Variante im Suffix wird gefangen (anwenden vs angewendet)', () => {
    const { skipped } = filterEchoOpenItems(
      [{ title: 'Temporäre Bans durchsetzen (duration anwenden)' }],
      { existingTitles: ['Temporäre Bans durchsetzen (duration wird nie angewendet)'], success: true },
    );
    expect(skipped[0]?.reason).toBe('duplicate');
  });

  it('Template-Echos werden auch bei FAILED Sessions verworfen', () => {
    const { kept, skipped } = filterEchoOpenItems(
      [
        { title: 'Build wieder grün bekommen' },
        { title: 'Fehlende Teile umsetzen ohne bestehende Arbeit zu überschreiben' },
        { title: 'Push zum Remote verifizieren' },
        { title: 'Reporter-Rückmeldung zum Ausgang der eigenen Meldung' },
      ],
      { success: false },
    );
    expect(skipped.map(s => s.reason)).toEqual(['template-echo', 'template-echo', 'template-echo']);
    expect(kept.map(k => k.title)).toEqual(['Reporter-Rückmeldung zum Ausgang der eigenen Meldung']);
  });

  it('goal-echo per Containment: kurzer Titel matcht jetzt lange Goal-Zeile', () => {
    const goal = 'Untersuche den Repo-Stand.\nDanach: UGC-Owner-Bypass für Autoren implementieren und Moderations-Notifications ergänzen, Build verifizieren.';
    const { skipped } = filterEchoOpenItems(
      [{ title: 'UGC-Owner-Bypass implementieren' }],
      { goal, success: true },
    );
    expect(skipped[0]?.reason).toBe('goal-echo');
  });

  it('verschiedene Items bleiben weiterhin getrennt (kein Über-Filtern)', () => {
    const { kept } = filterEchoOpenItems(
      [
        { title: 'Forum-Queue: Pagination statt hartkodiertem limit=100' },
        { title: 'Members: User-Dossier mit Moderations-Historie' },
      ],
      { existingTitles: ['Reports: Bulk-Aktion für Duplikate (gleicher Content N-fach gemeldet)'], success: true },
    );
    expect(kept).toHaveLength(2);
  });

  it('openItemTitleContainment: Suffix-Variante = 1.0, Verschiedenes bleibt niedrig', () => {
    expect(openItemTitleContainment(
      'Temporäre Bans durchsetzen',
      'Temporäre Bans durchsetzen (duration wird nie angewendet)',
    )).toBe(1);
    expect(openItemTitleContainment(
      'Chat-Sounds bei neuen Nachrichten abspielen',
      'Admin-Reviewroute statusunabhängig machen',
    )).toBeLessThan(0.5);
  });
});
