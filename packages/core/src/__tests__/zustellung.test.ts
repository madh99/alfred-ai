import { describe, it, expect } from 'vitest';
import { entscheideZustellung, BEWEGUNG_FRISCH_MIN } from '../delivery-scheduler.js';

// v1198 — Jarvis Interaktion: Anwesenheit aus Home Assistant und Chat-Aktivität steuern die Zustellung.
const NOW = Date.parse('2026-10-05T18:00:00Z');
const basis = { urgency: 'normal' as const, chatAktiv: false, imRuhefenster: false, profilErlaubt: false, profilText: 'Aktivitätsprofil 20 Uhr: QUIET (nötig WAKING)', now: NOW };

describe('entscheideZustellung', () => {
  it('Reihenfolge: dringend → Chat aktiv → Ruhefenster', () => {
    expect(entscheideZustellung({ ...basis, urgency: 'urgent', imRuhefenster: true })).toEqual({ liefern: true, grund: 'dringend' });
    expect(entscheideZustellung({ ...basis, chatAktiv: true, imRuhefenster: true })).toEqual({ liefern: true, grund: 'Chat aktiv (letzte 30 min)' });
    expect(entscheideZustellung({ ...basis, imRuhefenster: true, anwesenheit: { jemandZuhause: true, letzteBewegungAt: NOW } })).toEqual({ liefern: false, grund: 'Ruhefenster' });
  });
  it('Bewegung im Haus (zu Hause, frisch) liefert trotz QUIET-Profil — nicht bei low', () => {
    const r = entscheideZustellung({ ...basis, anwesenheit: { jemandZuhause: true, letzteBewegungAt: NOW - 4 * 60_000 } });
    expect(r).toEqual({ liefern: true, grund: 'Bewegung im Haus vor 4 min (zu Hause, wach)' });
    expect(entscheideZustellung({ ...basis, anwesenheit: { jemandZuhause: true, letzteBewegungAt: NOW - (BEWEGUNG_FRISCH_MIN + 1) * 60_000 } }).liefern).toBe(false);
    expect(entscheideZustellung({ ...basis, urgency: 'low', profilErlaubt: true, anwesenheit: { jemandZuhause: true, letzteBewegungAt: NOW } }).grund).toMatch(/Aktivitätsprofil/);
  });
  it('niemand zu Hause: niedrige Dringlichkeit wartet, normale folgt dem Profil', () => {
    expect(entscheideZustellung({ ...basis, urgency: 'low', profilErlaubt: true, anwesenheit: { jemandZuhause: false } })).toEqual({ liefern: false, grund: 'niemand zu Hause, niedrige Dringlichkeit' });
    expect(entscheideZustellung({ ...basis, profilErlaubt: true, anwesenheit: { jemandZuhause: false } })).toEqual({ liefern: true, grund: basis.profilText });
  });
  it('ohne Anwesenheits-Signal entscheidet das Profil wie bisher', () => {
    expect(entscheideZustellung({ ...basis })).toEqual({ liefern: false, grund: basis.profilText });
    expect(entscheideZustellung({ ...basis, profilErlaubt: true })).toEqual({ liefern: true, grund: basis.profilText });
  });
});
