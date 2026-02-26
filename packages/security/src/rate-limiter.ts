import type { RateLimit } from '@alfred/types';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetsAt: number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private buckets: Map<string, Bucket> = new Map();

  check(key: string, limit: RateLimit): RateLimitResult {
    const now = Date.now();
    const windowMs = limit.windowSeconds * 1000;
    const bucket = this.buckets.get(key);

    // No bucket yet — full capacity available
    if (!bucket) {
      return {
        allowed: true,
        remaining: limit.maxInvocations,
        resetsAt: now + windowMs,
      };
    }

    // Window has expired — reset and allow
    if (now > bucket.windowStart + windowMs) {
      return {
        allowed: true,
        remaining: limit.maxInvocations,
        resetsAt: now + windowMs,
      };
    }

    // Within window — check count
    const remaining = Math.max(0, limit.maxInvocations - bucket.count);
    return {
      allowed: bucket.count < limit.maxInvocations,
      remaining,
      resetsAt: bucket.windowStart + windowMs,
    };
  }

  increment(key: string, limit: RateLimit): void {
    const now = Date.now();
    const windowMs = limit.windowSeconds * 1000;
    const bucket = this.buckets.get(key);

    if (!bucket || now > bucket.windowStart + windowMs) {
      // Start a new window
      this.buckets.set(key, { count: 1, windowStart: now });
    } else {
      bucket.count += 1;
    }
  }

  reset(): void {
    this.buckets.clear();
  }
}
