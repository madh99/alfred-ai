import { describe, it, expect } from 'vitest';
import { parseFeatureSuggestions, parseFeaturePlanPhases } from '../project.js';

/** v880 — Parser der Feature-Discovery + Plan-Ausarbeitung. */
describe('parseFeatureSuggestions', () => {
  it('parses suggestions with effort normalization', () => {
    const out = `Analyse fertig.\n[
      {"title":"Push-Benachrichtigungen für Forum-Antworten","value":"User kommen zurück","effort":"m","rationale":"Community-Bindung"},
      {"title":"Dark-Mode","value":"Komfort","effort":"S","rationale":"oft gewünscht"},
      {"title":"Ohne Effort","value":"x","rationale":"y"}
    ]`;
    const r = parseFeatureSuggestions(out);
    expect(r).toHaveLength(3);
    expect(r[0].effort).toBe('M');
    expect(r[1].effort).toBe('S');
    expect(r[2].effort).toBe('M'); // Default
  });

  it('caps at 10 and drops titleless entries', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ title: `Feature ${i}`, value: 'v', effort: 'S', rationale: 'r' }));
    const r = parseFeatureSuggestions(JSON.stringify([{ value: 'kein titel' }, ...many]));
    expect(r).toHaveLength(10);
  });

  it('garbage → []', () => {
    expect(parseFeatureSuggestions('keine vorschläge')).toEqual([]);
  });
});

describe('parseFeaturePlanPhases', () => {
  it('parses phases in order, survives [slug]-paths', () => {
    const out = `Plan committed.\n\`\`\`json\n[
      {"title":"Datenmodell + Migration","description":"Tabelle notifications, Migration 89, src/lib/db.ts"},
      {"title":"API-Routen","description":"app/api/notifications/[id]/route.ts neu"},
      {"title":"UI-Anbindung","description":"Header-Badge + Liste"}
    ]\n\`\`\``;
    const r = parseFeaturePlanPhases(out);
    expect(r).toHaveLength(3);
    expect(r[0].title).toContain('Datenmodell');
    expect(r[1].description).toContain('[id]');
  });

  it('caps at 10, garbage → []', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `Phase ${i}`, description: 'd' }));
    expect(parseFeaturePlanPhases(JSON.stringify(many))).toHaveLength(10);
    expect(parseFeaturePlanPhases('nope')).toEqual([]);
  });
});
