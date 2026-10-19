import { describe, it, expect } from 'vitest';
import { FeedbackService } from './feedback-service.js';

/** v1510 D6a — 👎 mit Grund aus App/Web wird direkt zur Korrektur (Typ correction), ohne LLM-Klassifizierung. */
describe('v1510 korrekturAusBewertung', () => {
  const aufbau = () => {
    const events: unknown[][] = []; const gespeichert: unknown[][] = [];
    const repo = { recordEvent: async (...a: unknown[]) => { events.push(a); } };
    const mem = { saveWithMetadata: async (...a: unknown[]) => { gespeichert.push(a); return { id: 'x' }; } };
    const log = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
    const f = new FeedbackService(repo as never, mem as never, log as never);
    return { f, events, gespeichert };
  };

  it('speichert die Korrektur mit Frage und Grund als correction', async () => {
    const { f, events, gespeichert } = aufbau();
    expect(await f.korrekturAusBewertung({ userId: 'o', frage: 'Wie viel Strom heuer?', antwort: '647 €', grund: 'Die Summe gilt nur bis August, nicht September.' })).toBe('gespeichert');
    expect(events).toHaveLength(1);
    expect(gespeichert).toHaveLength(1);
    const [user, , text, , typ] = gespeichert[0]!;
    expect(user).toBe('o');
    expect(typ).toBe('correction');
    expect(text).toBe('Nutzer-Korrektur (Antwort mit 👎 bewertet zu „Wie viel Strom heuer?“): Die Summe gilt nur bis August, nicht September.');
  });

  it('ohne brauchbaren Grund nichts speichern', async () => {
    const { f, gespeichert } = aufbau();
    expect(await f.korrekturAusBewertung({ userId: 'o', frage: 'x', antwort: 'y', grund: '  ' })).toBe('leer');
    expect(gespeichert).toHaveLength(0);
  });
});
