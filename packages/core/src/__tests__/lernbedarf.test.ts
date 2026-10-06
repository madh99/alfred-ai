import { describe, it, expect } from 'vitest';
import { istAbsage, lernbedarfAusAbsage, lernbedarfAusSkillFehler } from '../vorgaenge/lernbedarf.js';

// v1207 — Jarvis Schleife 3: Lücke → Fähigkeit.
describe('istAbsage', () => {
  it('erkennt deutsche und englische Absagen, nicht aber normale Antworten', () => {
    expect(istAbsage('Das kann ich leider nicht, mir fehlt der Zugriff auf den Kalender.')).toBe(true);
    expect(istAbsage("I can't access that mailbox.")).toBe(true);
    expect(istAbsage('Dein BMW steht zu Hause, Akku 30 %.')).toBe(false);
  });
});

describe('lernbedarfAusAbsage', () => {
  it('baut Titel, Ziel, nächsten Schritt, Dedupe-Schlüssel und Kategorie aus Frage und Absage', () => {
    const v = lernbedarfAusAbsage('Was war das Outlook-Problem heute?', 'Dazu habe ich keinen Zugriff auf das Postfach.\nSag mir, was ich prüfen soll.')!;
    expect(v.titel).toBe('Lernbedarf: „Was war das Outlook-Problem heute?" konnte ich nicht beantworten');
    expect(v.ziel).toContain('Antwort (Absage): Dazu habe ich keinen Zugriff auf das Postfach.');
    expect(v.dedupeKey.startsWith('lernbedarf:absage:')).toBe(true);
    expect(v.kategorie).toBe('email');
    expect(lernbedarfAusAbsage('Was war das Outlook-Problem heute?', 'Hier ist die Übersicht …')).toBeUndefined();
    expect(lernbedarfAusAbsage('ok', 'kann ich nicht')).toBeUndefined();
  });
  it('gleiche Frage in anderer Reihenfolge der Wörter → gleicher Schlüssel', () => {
    const a = lernbedarfAusAbsage('Outlook Problem heute?', 'geht nicht')!;
    const b = lernbedarfAusAbsage('Problem heute Outlook?', 'geht nicht')!;
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });
});

describe('lernbedarfAusSkillFehler', () => {
  it('nennt Skill, Fehlerklasse, Ort und den beobachteten Umweg', () => {
    const v = lernbedarfAusSkillFehler({ failedSkill: 'email', errorClass: 'AUTH', scope: 'outlook', workaroundSteps: ['Token erneuert', 'erneut versucht'], finalSuccess: true });
    expect(v.titel).toBe('Lernbedarf: Skill „email" scheitert AUTH bei outlook');
    expect(v.ziel).toBe('Beobachteter Umweg: Token erneuert → erneut versucht');
    expect(v.naechsterSchritt).toMatch(/Runbook bestätigen/);
    expect(v.dedupeKey).toBe('lernbedarf:skill:email:outlook:auth');
    expect(v.kategorie).toBe('alfred');
  });
});
