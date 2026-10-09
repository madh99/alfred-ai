import { describe, it, expect } from 'vitest';
import { istLeererInsightText } from '../reasoning-engine.js';

// v1337 — Owner-Befund 09.10. 21:00: „```json\n[]\n```" wurde als Insight verschickt
describe('istLeererInsightText (v1337)', () => {
  it('erkennt leere JSON-Hüllen, Codezäune und „Keine Insights"', () => {
    for (const t of ['```json\n[]\n```', '[]', '{}', '```\n\n```', 'null', 'Keine Insights: Die beiden Auffälligkeiten sind gelöst.', '["", " "]', '   ']) expect(istLeererInsightText(t)).toBe(true);
  });
  it('lässt echte Insights durch', () => {
    for (const t of ['E-Mail- und Dateioperations-Fehlerquote liegen weiter über dem Normalwert.', '1. Wallbox nicht erreichbar\n2. Token erneuert', '```json\n[{"titel":"Wallbox"}]\n```']) expect(istLeererInsightText(t)).toBe(false);
  });
});
