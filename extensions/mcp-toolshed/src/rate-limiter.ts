export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export interface RateLimiter {
  canExecute(key: string, now?: number): RateLimitResult;
  /**
   * Same token-bucket algorithm as `canExecute`, but the caller supplies the
   * limit to enforce for this key instead of the limiter's single
   * constructor-configured limit (H4 fix). This lets one `RateLimiter`
   * instance back multiple buckets with different limits — e.g. a
   * per-server bucket (`server:github`, limit from `governance.rateLimits`)
   * and the existing fine-grained per-tool bucket (`team:minion:server:tool`,
   * the `default` limit) — without needing a limiter-per-config-entry.
   */
  canExecuteWithLimit(key: string, limit: RateLimitConfig, now?: number): RateLimitResult;
}

export interface RateLimitConfig {
  requestsPerMinute: number;
  burst: number;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

export class TokenBucketRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(private readonly config: RateLimitConfig) {}

  canExecute(key: string, now = Date.now()): RateLimitResult {
    return this.canExecuteWithLimit(key, this.config, now);
  }

  canExecuteWithLimit(key: string, limit: RateLimitConfig, now = Date.now()): RateLimitResult {
    const capacity = limit.burst;
    const refillRatePerMs = limit.requestsPerMinute / 60_000;

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now };
    }

    const elapsedMs = now - bucket.lastRefill;
    const tokensToAdd = elapsedMs * refillRatePerMs;
    bucket.tokens = Math.min(capacity, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      const deficit = 1 - bucket.tokens;
      const retryAfterSeconds = Math.max(1, Math.ceil(deficit / (limit.requestsPerMinute / 60)));
      this.buckets.set(key, bucket);
      return { allowed: false, retryAfterSeconds };
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return { allowed: true };
  }
}

export function createRateLimiter(config?: RateLimitConfig): RateLimiter {
  return new TokenBucketRateLimiter(config ?? { requestsPerMinute: 60, burst: 20 });
}
