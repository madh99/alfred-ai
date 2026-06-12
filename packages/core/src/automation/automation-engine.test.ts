import { describe, it, expect } from 'vitest';
import { buildPreviousRunBlock } from './automation-engine.js';

/** v881 — Vergleichsbasis-Block: macht Drift-/Trend-Templates ehrlich. */
describe('buildPreviousRunBlock', () => {
  it('builds block from successful previous run', () => {
    const b = buildPreviousRunBlock('2026-06-06T09:00:00.000Z', 'success', 'Coverage gesamt: 81.2%\nlines: 12000/14770');
    expect(b).toContain('Vorheriger Lauf (2026-06-06 09:00)');
    expect(b).toContain('VERGLEICHSBASIS');
    expect(b).toContain('81.2%');
    expect(b).toContain('Erfinde KEINE Trends');
  });

  it('returns empty for first run (no output)', () => {
    expect(buildPreviousRunBlock(undefined, undefined, undefined)).toBe('');
    expect(buildPreviousRunBlock('2026-06-06T09:00:00.000Z', 'success', '')).toBe('');
  });

  it('returns empty when previous run failed (kein valider Vergleich)', () => {
    expect(buildPreviousRunBlock('2026-06-06T09:00:00.000Z', 'failed', 'Error: LLM down')).toBe('');
  });

  it('truncates long outputs with marker', () => {
    const b = buildPreviousRunBlock('2026-06-06T09:00:00.000Z', 'success', 'x'.repeat(5000));
    expect(b.length).toBeLessThan(3000);
    expect(b).toContain('[... gekürzt]');
  });
});
