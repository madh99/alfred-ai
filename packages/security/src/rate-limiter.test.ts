import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimiter } from './rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;
  const limit = { maxInvocations: 3, windowSeconds: 60 };

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow when no previous invocations', () => {
    const result = limiter.check('key', limit);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(limit.maxInvocations);
  });

  it('should allow up to maxInvocations', () => {
    limiter.increment('key', limit);
    limiter.increment('key', limit);

    const result = limiter.check('key', limit);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });

  it('should deny when limit exceeded', () => {
    for (let i = 0; i < limit.maxInvocations; i++) {
      limiter.increment('key', limit);
    }

    const result = limiter.check('key', limit);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('should reset after window expires', () => {
    vi.useFakeTimers();

    for (let i = 0; i < limit.maxInvocations; i++) {
      limiter.increment('key', limit);
    }

    const denied = limiter.check('key', limit);
    expect(denied.allowed).toBe(false);

    // Advance time past the window
    vi.advanceTimersByTime(limit.windowSeconds * 1000 + 1);

    const allowed = limiter.check('key', limit);
    expect(allowed.allowed).toBe(true);
    expect(allowed.remaining).toBe(limit.maxInvocations);
  });

  it('should reset all counters', () => {
    limiter.increment('key', limit);
    limiter.increment('key', limit);
    limiter.increment('key', limit);

    const denied = limiter.check('key', limit);
    expect(denied.allowed).toBe(false);

    limiter.reset();

    const allowed = limiter.check('key', limit);
    expect(allowed.allowed).toBe(true);
    expect(allowed.remaining).toBe(limit.maxInvocations);
  });

  it('should track separate keys independently', () => {
    limiter.increment('key1', limit);
    limiter.increment('key1', limit);
    limiter.increment('key1', limit);

    const key1Result = limiter.check('key1', limit);
    expect(key1Result.allowed).toBe(false);

    const key2Result = limiter.check('key2', limit);
    expect(key2Result.allowed).toBe(true);
    expect(key2Result.remaining).toBe(limit.maxInvocations);
  });
});
