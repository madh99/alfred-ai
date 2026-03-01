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
  private checkCount = 0;

  check(key: string, limit: RateLimit): RateLimitResult {
    this.checkCount++;
    if (this.checkCount % 100 === 0) {
      this.cleanup();
    }

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

  cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      // Remove entries whose window has long expired (use a generous 2x window)
      // Since we don't know each key's window size, use a default max of 1 hour
      const maxWindowMs = 3_600_000;
      if (now > bucket.windowStart + maxWindowMs) {
        this.buckets.delete(key);
      }
    }
  }

  reset(): void {
    this.buckets.clear();
  }
}
