import { describe, it, expect } from 'vitest';
import { isSubstantialSession } from './session-thresholds.js';

describe('isSubstantialSession', () => {
  it('returns false for trivial sessions', () => {
    expect(isSubstantialSession({ toolCalls: 1, filesChanged: 0, durationMs: 5_000 })).toBe(false);
    expect(isSubstantialSession({})).toBe(false);
  });

  it('crosses on tool-calls threshold', () => {
    expect(isSubstantialSession({ toolCalls: 5 })).toBe(true);
    expect(isSubstantialSession({ toolCalls: 4 })).toBe(false);
  });

  it('crosses on any file change', () => {
    expect(isSubstantialSession({ filesChanged: 1 })).toBe(true);
    expect(isSubstantialSession({ filesChanged: 0 })).toBe(false);
  });

  it('crosses on duration ≥ 3 minutes', () => {
    expect(isSubstantialSession({ durationMs: 3 * 60_000 })).toBe(true);
    expect(isSubstantialSession({ durationMs: 2 * 60_000 + 59_000 })).toBe(false);
  });

  it('respects custom thresholds', () => {
    expect(isSubstantialSession({ toolCalls: 3 }, { toolCallsThreshold: 3 })).toBe(true);
    expect(isSubstantialSession({ durationMs: 60_000 }, { minutesThreshold: 1 })).toBe(true);
  });

  it('any single criterion is enough', () => {
    expect(isSubstantialSession({ toolCalls: 0, filesChanged: 1, durationMs: 100 })).toBe(true);
    expect(isSubstantialSession({ toolCalls: 10, filesChanged: 0, durationMs: 100 })).toBe(true);
  });
});
