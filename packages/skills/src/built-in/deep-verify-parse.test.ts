import { describe, it, expect } from 'vitest';
import { parseDeepVerifyFindings } from './project.js';

/** v870 — Parser der Deep-Verify-Agent-Antwort (letztes valides JSON-Array). */
describe('parseDeepVerifyFindings', () => {
  const idA = '11111111-aaaa-4bbb-8ccc-111111111111';
  const idB = '22222222-aaaa-4bbb-8ccc-222222222222';
  const valid = new Set([idA, idB]);

  it('parst ein sauberes Verdikt-Array mit allen Feldern', () => {
    const out = `Ich habe den Code geprüft.\n\n[{"id":"${idA}","verdict":"implemented","confidence":0.9,"evidence":"src/lib/auth.ts:42 prüft den Fokus"},{"id":"${idB}","verdict":"partially","confidence":0.7,"evidence":"Komponente existiert","missing":"Tests fehlen"}]`;
    const f = parseDeepVerifyFindings(out, valid);
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ id: idA, verdict: 'implemented', confidence: 0.9 });
    expect(f[1].missing).toBe('Tests fehlen');
  });

  it('nimmt das LETZTE valide Array (Agent darf vorher Listen ausgeben)', () => {
    const out = `Gefundene Dateien: ["a.ts","b.ts"]\n\nFinale Bewertung:\n[{"id":"${idA}","verdict":"obsolete","confidence":0.8,"evidence":"Feature wurde entfernt"}]`;
    const f = parseDeepVerifyFindings(out, valid);
    expect(f).toHaveLength(1);
    expect(f[0].verdict).toBe('obsolete');
  });

  it('toleriert Markdown-Fences und ignoriert fremde/ungültige IDs + Verdikte', () => {
    const out = '```json\n[{"id":"' + idA + '","verdict":"not-implemented","confidence":0.6,"evidence":"kein Treffer"},{"id":"fremde-id","verdict":"implemented","confidence":1,"evidence":"x"},{"id":"' + idB + '","verdict":"quatsch","confidence":1,"evidence":"x"}]\n```';
    const f = parseDeepVerifyFindings(out, valid);
    expect(f).toHaveLength(1);
    expect(f[0].id).toBe(idA);
  });

  it('clamped confidence auf [0,1] und kürzt evidence', () => {
    const out = `[{"id":"${idA}","verdict":"implemented","confidence":7,"evidence":"${'x'.repeat(500)}"}]`;
    const f = parseDeepVerifyFindings(out, valid);
    expect(f[0].confidence).toBe(1);
    expect(f[0].evidence.length).toBe(300);
  });

  it('kein JSON / leerer Output → leere Liste, kein Throw', () => {
    expect(parseDeepVerifyFindings('Agent erzählte nur Prosa.', valid)).toEqual([]);
    expect(parseDeepVerifyFindings('', valid)).toEqual([]);
  });

  // v870.1 — REALER Vorfall 12.06. (Lauf 860f0740): Next.js-Routen-Pfade mit
  // [slug]/[id] in den Evidence-Strings brachen die alte Regex-Extraktion —
  // 15 perfekte Verdikte geliefert, 0 geparst.
  it('v870.1: Brackets in Evidence-Strings ([slug]-Pfade) brechen den Parser nicht mehr', () => {
    const out = `Analyse fertig. Hier die Bewertung:\n\n\`\`\`json\n[` +
      `{"id":"${idA}","verdict":"implemented","confidence":0.95,"evidence":"news.status/publishAt in src/lib/migrations.ts; Preview-Route src/app/api/news/[slug]/preview/route.ts + preview.test.ts; Admin-Link news/page.tsx:32"},` +
      `{"id":"${idB}","verdict":"implemented","confidence":0.9,"evidence":"Detailseite src/app/community/ugc/[id]/page.tsx rendert Medien typabhängig"}` +
      `]\n\`\`\``;
    const f = parseDeepVerifyFindings(out, valid);
    expect(f).toHaveLength(2);
    expect(f[0].evidence).toContain('[slug]');
    expect(f[1].evidence).toContain('[id]');
  });

  it('v870.1: escaped quotes in Evidence-Strings werden korrekt überlaufen', () => {
    const out = `[{"id":"${idA}","verdict":"obsolete","confidence":0.8,"evidence":"Feature \\"Galerie [alt]\\" wurde entfernt"}]`;
    const f = parseDeepVerifyFindings(out, valid);
    expect(f).toHaveLength(1);
    expect(f[0].evidence).toContain('Galerie [alt]');
  });

  it('v870.1: [slug]-Listen VOR dem Verdikt-Array stören nicht', () => {
    const out = `Geprüfte Routen: [slug], [id], [...catchall]\n\n[{"id":"${idA}","verdict":"not-implemented","confidence":0.7,"evidence":"kein Treffer in src/app/api"}]`;
    const f = parseDeepVerifyFindings(out, valid);
    expect(f).toHaveLength(1);
    expect(f[0].verdict).toBe('not-implemented');
  });
});
