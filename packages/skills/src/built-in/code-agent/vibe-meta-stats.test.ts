import { describe, it, expect } from 'vitest';
import { parseVibeMetaStats } from './agent-executor.js';

/**
 * v895 — vibe liefert Tokens/Kosten/Modell nicht im Stream, sondern in der
 * Session-meta.json (stats + config). parseVibeMetaStats extrahiert sie daraus.
 * Werte aus der realen Session 55e390cc (mistral-vibe).
 */
describe('v895 parseVibeMetaStats', () => {
  it('extrahiert model + usage aus stats/config (reale 55e390cc-Werte)', () => {
    const meta = {
      stats: {
        session_prompt_tokens: 3641961,
        session_completion_tokens: 29536,
        session_cost: 5.684461499999999,
        input_price_per_million: 1.5,
        output_price_per_million: 7.5,
      },
      config: { active_model: 'mistral-medium-3.5' },
    };
    const r = parseVibeMetaStats(meta);
    expect(r.model).toBe('mistral-medium-3.5');
    expect(r.usage).toEqual({ inputTokens: 3641961, outputTokens: 29536, cacheReadTokens: 0, costUsd: 5.684461499999999 });
  });

  it('ohne stats → usage undefined (nur model wenn vorhanden)', () => {
    const r = parseVibeMetaStats({ config: { active_model: 'devstral-medium' } });
    expect(r.model).toBe('devstral-medium');
    expect(r.usage).toBeUndefined();
  });

  it('leeres meta → beides undefined', () => {
    const r = parseVibeMetaStats({});
    expect(r.model).toBeUndefined();
    expect(r.usage).toBeUndefined();
  });

  it('stats mit 0-Tokens → keine usage (kein Phantom-0-Eintrag)', () => {
    const r = parseVibeMetaStats({ stats: { session_prompt_tokens: 0, session_completion_tokens: 0, session_cost: 0 }, config: { active_model: 'x' } });
    expect(r.usage).toBeUndefined();
  });
});
