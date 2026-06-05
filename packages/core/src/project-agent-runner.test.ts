import { describe, it, expect } from 'vitest';
import { buildCommitSubject } from './project-agent-runner.js';

describe('buildCommitSubject', () => {
  it('extracts topic before colon', () => {
    const s = buildCommitSubject(
      'Channel-Leave/Rejoin-Logik korrigieren: beim expliziten Channel-Verlassen Membership beenden',
      4,
      'conventional',
    );
    expect(s).toBe('fix: Channel-Leave/Rejoin-Logik korrigieren');
  });

  it('detects fix type from "korrigier"', () => {
    const s = buildCommitSubject('Auth-Bug korrigieren', 1, 'conventional');
    expect(s.startsWith('fix:')).toBe(true);
  });

  it('detects test type', () => {
    const s = buildCommitSubject('Tests für Channel-Switch ergänzen', 1, 'conventional');
    expect(s.startsWith('test:')).toBe(true);
  });

  it('detects refactor type', () => {
    const s = buildCommitSubject('Auth-Module refactoring', 1, 'conventional');
    expect(s.startsWith('refactor:')).toBe(true);
  });

  it('falls back to feat for unknown intent', () => {
    const s = buildCommitSubject('Add new endpoint', 1, 'conventional');
    expect(s.startsWith('feat:')).toBe(true);
  });

  it('truncates topic at 60 chars', () => {
    const long = 'a'.repeat(100);
    const s = buildCommitSubject(long, 1, 'conventional');
    expect(s.length).toBeLessThanOrEqual(72);
    expect(s).toMatch(/…$/);
  });

  it('extracts first sentence when no colon', () => {
    const s = buildCommitSubject('Short fix. With more detail in second sentence that is long.', 1, 'conventional');
    expect(s).toBe('fix: Short fix');
  });

  it('falls back to "Phase N:" when no conventional', () => {
    const s = buildCommitSubject('Some change description here', 5);
    expect(s.startsWith('Phase 5:')).toBe(true);
  });

  it('handles empty/whitespace input gracefully', () => {
    const s = buildCommitSubject('  trim me  ', 1, 'conventional');
    expect(s).toBe('feat: trim me');
  });
});
