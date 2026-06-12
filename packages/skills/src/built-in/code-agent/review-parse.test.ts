import { describe, it, expect } from 'vitest';
import { parseReviewFindings, parseCrossCheckVerdicts } from '../project.js';

/** v879 — Parser des Codebase-Reviews (string-bewusstes Bracket-Matching wie Deep-Verify). */
describe('parseReviewFindings', () => {
  it('parses a clean findings array and assigns f1..fn ids', () => {
    const out = `Analyse fertig.\n[
      {"title":"SQL-Injection in Suchroute","kind":"security","severity":"critical","evidence":"api/search/route.ts:42 — ungeparameterisierte Query","confidence":0.9,"suggestedMilestone":"Review: Security"},
      {"title":"Fehlende Pagination","kind":"gap","severity":"medium","evidence":"api/items/route.ts:10","confidence":0.7}
    ]`;
    const r = parseReviewFindings(out);
    expect(r).toHaveLength(2);
    expect(r[0].id).toBe('f1');
    expect(r[0].kind).toBe('security');
    expect(r[0].severity).toBe('critical');
    expect(r[1].id).toBe('f2');
    expect(r[1].suggestedMilestone).toBeUndefined();
  });

  it('survives [slug]-paths in evidence (string-aware bracket matching)', () => {
    const out = `Vorab [interne Notiz].\n\`\`\`json\n[{"title":"Owner-Bypass fehlt","kind":"bug","severity":"high","evidence":"app/api/ugc/[id]/route.ts:38 filtert hart auf approved","confidence":0.85}]\n\`\`\``;
    const r = parseReviewFindings(out);
    expect(r).toHaveLength(1);
    expect(r[0].evidence).toContain('[id]');
  });

  it('drops entries with invalid kind/severity and caps at 25', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ title: `Befund ${i}`, kind: 'bug', severity: 'low', evidence: 'x', confidence: 0.5 }));
    const withJunk = [{ title: 'kaputt', kind: 'feature', severity: 'low' }, ...many];
    const r = parseReviewFindings(JSON.stringify(withJunk));
    expect(r).toHaveLength(25);
    expect(r.every(f => f.kind === 'bug')).toBe(true);
  });

  it('empty array / garbage → []', () => {
    expect(parseReviewFindings('[]')).toEqual([]);
    expect(parseReviewFindings('kein json')).toEqual([]);
  });
});

describe('parseCrossCheckVerdicts', () => {
  const ids = new Set(['f1', 'f2', 'f3']);

  it('parses verdicts and ignores unknown ids', () => {
    const out = `Prüfung fertig.\n[{"id":"f1","verdict":"confirmed","note":"selbst verifiziert"},{"id":"f2","verdict":"refuted","note":"Route hat Guard in Zeile 12"},{"id":"f9","verdict":"confirmed"}]`;
    const r = parseCrossCheckVerdicts(out, ids);
    expect(r).toHaveLength(2);
    expect(r[0].verdict).toBe('confirmed');
    expect(r[1].verdict).toBe('refuted');
    expect(r[1].note).toContain('Guard');
  });

  it('invalid verdict values are dropped', () => {
    const r = parseCrossCheckVerdicts('[{"id":"f1","verdict":"maybe"},{"id":"f2","verdict":"unclear"}]', ids);
    expect(r).toHaveLength(1);
    expect(r[0].verdict).toBe('unclear');
  });

  it('garbage → []', () => {
    expect(parseCrossCheckVerdicts('nichts', ids)).toEqual([]);
  });
});
