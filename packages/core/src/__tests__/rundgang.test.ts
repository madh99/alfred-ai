import { describe, it, expect } from 'vitest';
import { istRundgangOhneAenderung, VOLATILE_SEKTIONEN } from '../reasoning-engine.js';
import { fachlicherFingerabdruck, ersteAbweichung } from '../reasoning-context-collector.js';

// v1193 — zeigt die erste fachlich abweichende Zeile zweier Sektions-Inhalte
describe('ersteAbweichung', () => {
  it('relative Zeiten zählen nicht, fachliche Werte schon; fehlende Zeilen werden als leer verglichen', () => {
    expect(ersteAbweichung('a (vor 3 min)\nSoC 30 %', 'a (vor 33 min)\nSoC 30 %')).toBeUndefined();
    expect(ersteAbweichung('a\nSoC 30 %', 'a\nSoC 29 %')).toEqual({ alt: 'SoC 30 %', neu: 'SoC 29 %' });
    expect(ersteAbweichung('a', 'a\n- neuer Incident')).toEqual({ alt: '', neu: '- neuer Incident' });
  });
});

// v1179 — Live 12:01: bmw/cmdb/projects galten nur wegen „vor 23 min", „(2254 ms)", Uhrzeiten als geändert.
describe('fachlicherFingerabdruck', () => {
  it('relative Zeitangaben und Uhrzeiten ändern den Fingerabdruck nicht', () => {
    const a = '**Fahrzeug:** steht seit 04.10. 18:28 (34 h), letzte Fahrt 63.995 → 64.093 km · **Datenlage:** REST-Abruf aktuell (vor 23 min, Takt 30 min) · MQTT still seit 03.10. 16:28 (2.102 min) · anthropic/claude antwortet (2254 ms)';
    const b = '**Fahrzeug:** steht seit 04.10. 19:01 (35 h), letzte Fahrt 63.995 → 64.093 km · **Datenlage:** REST-Abruf aktuell (vor 3 min, Takt 30 min) · MQTT still seit 03.10. 16:28 (2.132 min) · anthropic/claude antwortet (801 ms)';
    expect(fachlicherFingerabdruck(a)).toBe(fachlicherFingerabdruck(b));
  });
  it('v1189 — Projekt-Alter „vor 3d" ändert den Fingerabdruck nicht', () => {
    expect(fachlicherFingerabdruck('- **fussball-cc** (vor 3d) — 2 offene Punkte')).toBe(fachlicherFingerabdruck('- **fussball-cc** (vor 4d) — 2 offene Punkte'));
    expect(fachlicherFingerabdruck('- **fussball-cc** (vor 3d) — 2 offene Punkte')).not.toBe(fachlicherFingerabdruck('- **fussball-cc** (vor 3d) — 3 offene Punkte'));
  });
  it('fachliche Änderungen bleiben sichtbar', () => {
    expect(fachlicherFingerabdruck('SoC 30 % · vor 5 min')).not.toBe(fachlicherFingerabdruck('SoC 29 % · vor 5 min'));
    expect(fachlicherFingerabdruck('Fenster Lena offen')).not.toBe(fachlicherFingerabdruck('Türen/Fenster alle geschlossen'));
  });
});

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
    for (const k of ['calendar', 'email', 'bmw', 'cmdb', 'memories', 'todos', 'watches']) expect(VOLATILE_SEKTIONEN.has(k)).toBe(false);
    // v1185 — neue RSS-Artikel sind kein Zustandswechsel (lösten jeden Tick einen Vollpass aus)
    expect(VOLATILE_SEKTIONEN.has('feeds')).toBe(true);
    // v1189 — eigenes Gedächtnis und Wallbox-Leistung sind keine Weltänderung
    expect(VOLATILE_SEKTIONEN.has('vorgaenge')).toBe(true);
    expect(VOLATILE_SEKTIONEN.has('charger')).toBe(true);
  });
});
