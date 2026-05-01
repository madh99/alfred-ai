import { describe, it, expect } from 'vitest';
import { resolveRelativeDates, extractRelevantUntil, extractSourceEventRefs } from '../relative-date-resolver.js';

// All tests anchor on a fixed "now" so the assertions are stable.
// Wednesday, 2026-04-22 12:00 UTC.
const NOW = new Date('2026-04-22T12:00:00Z');
const TZ = 'Europe/Vienna';

describe('resolveRelativeDates', () => {
  describe('relative day words', () => {
    it('annotates "morgen"', () => {
      expect(resolveRelativeDates('Erinnere mich morgen anrufen', NOW, TZ))
        .toBe('Erinnere mich morgen (=2026-04-23) anrufen');
    });

    it('annotates "heute"', () => {
      expect(resolveRelativeDates('Heute Termin', NOW, TZ))
        .toBe('Heute (=2026-04-22) Termin');
    });

    it('annotates "übermorgen"', () => {
      expect(resolveRelativeDates('übermorgen einkaufen', NOW, TZ))
        .toBe('übermorgen (=2026-04-24) einkaufen');
    });

    it('annotates "gestern"', () => {
      expect(resolveRelativeDates('gestern war der Termin', NOW, TZ))
        .toBe('gestern (=2026-04-21) war der Termin');
    });

    it('annotates English equivalents', () => {
      expect(resolveRelativeDates('tomorrow call workshop', NOW, TZ))
        .toBe('tomorrow (=2026-04-23) call workshop');
    });
  });

  describe('weekdays — next future occurrence', () => {
    // 2026-04-22 is a Wednesday.
    it('Mittwoch on Mittwoch → next Wednesday (7 days ahead)', () => {
      // Today is Wednesday. "Mittwoch" excludes today by design → next Mittwoch.
      expect(resolveRelativeDates('Mittwoch absagen', NOW, TZ))
        .toBe('Mittwoch (=2026-04-29) absagen');
    });

    it('Montag on Wednesday → next Monday (5 days ahead)', () => {
      expect(resolveRelativeDates('warte bis Montag', NOW, TZ))
        .toBe('warte bis Montag (=2026-04-27)');
    });

    it('Freitag on Wednesday → 2 days ahead', () => {
      expect(resolveRelativeDates('Freitag fertig', NOW, TZ))
        .toBe('Freitag (=2026-04-24) fertig');
    });

    it('Sonntag on Wednesday → 4 days ahead', () => {
      expect(resolveRelativeDates('Sonntag Treffen', NOW, TZ))
        .toBe('Sonntag (=2026-04-26) Treffen');
    });

    it('English Monday', () => {
      expect(resolveRelativeDates('wait until Monday', NOW, TZ))
        .toBe('wait until Monday (=2026-04-27)');
    });
  });

  describe('"in X Tagen/Wochen/Monaten"', () => {
    it('in 3 Tagen', () => {
      expect(resolveRelativeDates('in 3 Tagen anrufen', NOW, TZ))
        .toBe('in 3 Tagen (=2026-04-25) anrufen');
    });

    it('in 2 Wochen', () => {
      expect(resolveRelativeDates('in 2 Wochen Urlaub', NOW, TZ))
        .toBe('in 2 Wochen (=2026-05-06) Urlaub');
    });

    it('in 1 Monat', () => {
      expect(resolveRelativeDates('in 1 Monat fällig', NOW, TZ))
        .toBe('in 1 Monat (=2026-05-22) fällig');
    });
  });

  describe('"nächste/r Woche/Monat/Jahr"', () => {
    it('nächste Woche → next Monday', () => {
      expect(resolveRelativeDates('nächste Woche Meeting', NOW, TZ))
        .toBe('nächste Woche (=2026-04-27) Meeting');
    });

    it('nächster Monat → first of next month', () => {
      expect(resolveRelativeDates('nächster Monat Rechnung', NOW, TZ))
        .toBe('nächster Monat (=2026-05-01) Rechnung');
    });

    it('nächstes Jahr → first of next year', () => {
      expect(resolveRelativeDates('nächstes Jahr Renovierung', NOW, TZ))
        .toBe('nächstes Jahr (=2027-01-01) Renovierung');
    });
  });

  describe('idempotency', () => {
    it('does not re-annotate already annotated text', () => {
      const first = resolveRelativeDates('warte bis Montag', NOW, TZ);
      const second = resolveRelativeDates(first, NOW, TZ);
      expect(second).toBe(first);
    });

    it('multiple expressions in same text get annotated once each', () => {
      const text = 'Montag anrufen, Dienstag bestätigen';
      const out = resolveRelativeDates(text, NOW, TZ);
      expect(out).toBe('Montag (=2026-04-27) anrufen, Dienstag (=2026-04-28) bestätigen');
      expect(resolveRelativeDates(out, NOW, TZ)).toBe(out);
    });
  });

  describe('extractRelevantUntil', () => {
    it('returns undefined when no annotation', () => {
      expect(extractRelevantUntil('Anthropic ist bezahlt')).toBeUndefined();
    });

    it('extracts single date', () => {
      expect(extractRelevantUntil('warte bis Montag (=2026-04-27)')).toBe('2026-04-27');
    });

    it('returns max date when multiple', () => {
      expect(extractRelevantUntil('Montag (=2026-04-27) oder Donnerstag (=2026-04-30)')).toBe('2026-04-30');
    });
  });

  describe('extractSourceEventRefs', () => {
    it('extracts invoice numbers', () => {
      const refs = extractSourceEventRefs('Anthropic-Zahlung erledigt für Rechnung INV-2026-04-001');
      expect(refs).toContain('invoice:INV-2026-04-001');
    });

    it('extracts email message-ids', () => {
      const refs = extractSourceEventRefs('Email <abc-123@anthropic.com> behandelt');
      expect(refs).toContain('email:abc-123@anthropic.com');
    });

    it('extracts ISO dates', () => {
      const refs = extractSourceEventRefs('Email vom 2026-04-15 erledigt');
      expect(refs).toContain('date:2026-04-15');
    });

    it('returns empty for plain text', () => {
      expect(extractSourceEventRefs('Anthropic ist bezahlt')).toEqual([]);
    });

    it('deduplicates refs', () => {
      const refs = extractSourceEventRefs('INV-2026-04-001 INV-2026-04-001');
      expect(refs.filter(r => r === 'invoice:INV-2026-04-001').length).toBe(1);
    });
  });

  describe('no false positives', () => {
    it('leaves text without relative dates unchanged', () => {
      expect(resolveRelativeDates('BMW SoC bei 45%', NOW, TZ))
        .toBe('BMW SoC bei 45%');
    });

    it('leaves ISO dates alone', () => {
      expect(resolveRelativeDates('Termin am 2026-05-15', NOW, TZ))
        .toBe('Termin am 2026-05-15');
    });

    it('does not match weekday inside compound word (Montagsmeeting unchanged)', () => {
      // Word boundary should prevent matches on word *prefixes* like "Montagsmeeting" —
      // because German concatenates words, "Montag" *is* the start of "Montagsmeeting".
      // We accept this trade-off: word boundary in regex matches the boundary AFTER "Montag",
      // and that boundary exists between "g" and "s" only in some regex engines. JS regex
      // does NOT match \b between letters, so "Montagsmeeting" → no match for \bmontag\b
      // because there's no \b between "Montag" and "smeeting".
      expect(resolveRelativeDates('Montagsmeeting', NOW, TZ))
        .toBe('Montagsmeeting');
    });
  });
});
