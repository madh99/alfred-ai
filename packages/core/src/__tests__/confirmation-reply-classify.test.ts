import { describe, it, expect } from 'vitest';
import { classifyConfirmationReply } from '../confirmation-queue.js';

/**
 * v884 — deterministische Schicht hinter der Reply-bewussten Bestätigung.
 * Vorfall 13.06.: "ok mach es so" wurde nicht als Bestätigung erkannt; "ok"
 * traf blind die neueste statt der reply-referenzierten Confirmation.
 */
describe('classifyConfirmationReply', () => {
  it('strenge Wortliste gilt immer (ohne Reply-Bezug)', () => {
    expect(classifyConfirmationReply('ok', false)).toBe('yes');
    expect(classifyConfirmationReply('ja', false)).toBe('yes');
    expect(classifyConfirmationReply('nein', false)).toBe('no');
    expect(classifyConfirmationReply('abbrechen', false)).toBe('no');
  });

  it('OHNE Reply: freie Phrasen werden NICHT als Bestätigung gewertet (sicher)', () => {
    expect(classifyConfirmationReply('ok mach es so', false)).toBe('none');
    expect(classifyConfirmationReply('ja passt schon', false)).toBe('none');
    expect(classifyConfirmationReply('das ist ok für mich denke ich', false)).toBe('none');
  });

  it('MIT Reply: breitere Affirmativ-Phrasen greifen', () => {
    expect(classifyConfirmationReply('ok mach es so', true)).toBe('yes');
    expect(classifyConfirmationReply('ja passt', true)).toBe('yes');
    expect(classifyConfirmationReply('mach das', true)).toBe('yes');
    expect(classifyConfirmationReply('los gehts', true)).toBe('yes');
  });

  it('MIT Reply: Ablehnung erkannt', () => {
    expect(classifyConfirmationReply('nein lass das', true)).toBe('no');
    expect(classifyConfirmationReply('bitte nicht', true)).toBe('no');
    expect(classifyConfirmationReply('stopp', true)).toBe('no');
  });

  it('gemischte Signale → none (kein Raten)', () => {
    expect(classifyConfirmationReply('ja aber nicht jetzt', true)).toBe('none');
    expect(classifyConfirmationReply('ok aber stop', true)).toBe('none');
  });

  it('neutrale Antwort → none (auch mit Reply)', () => {
    expect(classifyConfirmationReply('was meinst du genau', true)).toBe('none');
    expect(classifyConfirmationReply('erklär mir das nochmal', true)).toBe('none');
  });

  it('Rückfrage (Fragezeichen) ist keine Bestätigung', () => {
    expect(classifyConfirmationReply('ist das ok?', true)).toBe('none');
    expect(classifyConfirmationReply('soll ich ja sagen?', true)).toBe('none');
  });
});
