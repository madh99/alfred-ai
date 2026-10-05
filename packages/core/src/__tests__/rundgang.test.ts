import { describe, it, expect } from 'vitest';
import { istRundgangOhneAenderung, VOLATILE_SEKTIONEN } from '../reasoning-engine.js';

// v1178 — Jarvis Schicht 2: der 30-min-Tick als Rundgang. Live 05.10.: jeder Tick lief
// als Vollpass (50–85 s, 2 LLM-Aufrufe, 3–10 Insights), auch wenn sich nur Aktivitätslog,
// Skill-Status oder Preise geändert hatten.
const T = Date.parse('2026-10-05T09:00:00Z');

describe('istRundgangOhneAenderung', () => {
  it('erster Tick nach Start → Vollpass', () => {
    expect(istRundgangOhneAenderung([], 0, T).ueberspringen).toBe(false);
  });
  it('nur volatile Sektionen geändert, Vollpass vor 30 min → überspringen', () => {
    const r = istRundgangOhneAenderung(['activity', 'skillHealth', 'energy', 'weather'], T - 30 * 60_000, T);
    expect(r).toEqual({ ueberspringen: true, fachlich: [], seitVollpassMin: 30 });
  });
  it('eine fachliche Sektion geändert → Vollpass', () => {
    const r = istRundgangOhneAenderung(['activity', 'smarthome'], T - 30 * 60_000, T);
    expect(r.ueberspringen).toBe(false);
    expect(r.fachlich).toEqual(['smarthome']);
  });
  it('spätestens nach 2 h ohne Vollpass → Vollpass trotz Stillstand', () => {
    expect(istRundgangOhneAenderung([], T - 121 * 60_000, T).ueberspringen).toBe(false);
    expect(istRundgangOhneAenderung([], T - 119 * 60_000, T).ueberspringen).toBe(true);
  });
  it('Kalender, Mail, BMW, CMDB, Feeds sind fachlich', () => {
    for (const k of ['calendar', 'email', 'bmw', 'cmdb', 'feeds', 'memories', 'todos', 'watches']) expect(VOLATILE_SEKTIONEN.has(k)).toBe(false);
  });
});
