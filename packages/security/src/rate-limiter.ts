import type { RateLimit } from '@alfred/types';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetsAt: number;
}

interface Bucket {
  count: number;
  windowStart: number;
  windowMs: number;
}

export class RateLimiter {
  private buckets: Map<string, Bucket> = new Map();
  private checkCount = 0;

  /**
   * Atomically check and increment the rate limit counter.
   * Returns the result AFTER incrementing (if allowed).
   */
  checkAndIncrement(key: string, limit: RateLimit): RateLimitResult {
    this.checkCount++;
    if (this.checkCount % 100 === 0) {
      this.cleanup();
    }

    const now = Date.now();
    const windowMs = limit.windowSeconds * 1000;
    const bucket = this.buckets.get(key);

    // No bucket or window expired — start fresh window with count=1
    if (!bucket || now > bucket.windowStart + bucket.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now, windowMs });
      return {
        allowed: true,
        remaining: Math.max(0, limit.maxInvocations - 1),
        resetsAt: now + windowMs,
      };
    }

    // Within window — check and increment atomically
    if (bucket.count < limit.maxInvocations) {
      bucket.count += 1;
      return {
        allowed: true,
        remaining: Math.max(0, limit.maxInvocations - bucket.count),
        resetsAt: bucket.windowStart + windowMs,
      };
    }

    // Rate limited
    return {
      allowed: false,
      remaining: 0,
      resetsAt: bucket.windowStart + windowMs,
    };
  }

  /** @deprecated Use checkAndIncrement for atomic operation. */
  check(key: string, limit: RateLimit): RateLimitResult {
    this.checkCount++;
    if (this.checkCount % 100 === 0) {
      this.cleanup();
    }

    const now = Date.now();
    const windowMs = limit.windowSeconds * 1000;
    const bucket = this.buckets.get(key);

    if (!bucket) {
      return { allowed: true, remaining: limit.maxInvocations, resetsAt: now + windowMs };
    }

    if (now > bucket.windowStart + bucket.windowMs) {
      return { allowed: true, remaining: limit.maxInvocations, resetsAt: now + windowMs };
    }

    const remaining = Math.max(0, limit.maxInvocations - bucket.count);
    return {
      allowed: bucket.count < limit.maxInvocations,
      remaining,
      resetsAt: bucket.windowStart + windowMs,
    };
  }

  /** @deprecated Use checkAndIncrement for atomic operation. */
  increment(key: string, limit: RateLimit): void {
    const now = Date.now();
    const windowMs = limit.windowSeconds * 1000;
    const bucket = this.buckets.get(key);

    if (!bucket || now > bucket.windowStart + bucket.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now, windowMs });
    } else {
      bucket.count += 1;
    }
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      // Remove entries whose window has expired (use 2x the actual window for safety)
      if (now > bucket.windowStart + bucket.windowMs * 2) {
        this.buckets.delete(key);
      }
    }
  }

  reset(): void {
    this.buckets.clear();
  }
}
