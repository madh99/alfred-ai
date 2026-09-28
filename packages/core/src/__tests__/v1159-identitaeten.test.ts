import { describe, it, expect, vi } from 'vitest';
import { PatternAnalyzer } from '../active-learning/pattern-analyzer.js';

// v1159 — Realfall 28.09.: Die Pattern-Analyse fragte activity_log OHNE
// userId ab und speicherte die globalen Muster unter jeder der 8 Identitäten
// (pattern_abendliche_nachbereitung in allen 8 Zeilen, Alexandra bekam die
// Gewohnheiten des Owners als ihre eigenen).

function leeresRepo(): unknown {
  return new Proxy({}, { get: () => vi.fn(async () => []) });
}

describe('v1159 PatternAnalyzer — Aktivität nur des eigenen Users', () => {
  it('alle Activity-Abfragen tragen die userId', async () => {
    const query = vi.fn(async (_filter: { userId?: string }) => [] as unknown[]);
    const activityRepo = { query } as never;
    const analyzer = new PatternAnalyzer(
      {} as never, leeresRepo() as never, activityRepo,
      { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as never,
    );
    const n = await analyzer.analyze('master-uuid-1');
    expect(n).toBe(0);
    expect(query).toHaveBeenCalled();
    for (const call of query.mock.calls) {
      expect(call[0].userId, JSON.stringify(call[0])).toBe('master-uuid-1');
    }
  });
});
