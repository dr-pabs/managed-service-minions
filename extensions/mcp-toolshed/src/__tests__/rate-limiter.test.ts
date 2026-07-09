import { TokenBucketRateLimiter, createRateLimiter } from '../rate-limiter.js';

describe('rate limiter', () => {
  it('creates a default limiter', () => {
    const limiter = createRateLimiter();
    expect(limiter.canExecute('key').allowed).toBe(true);
  });

  it('creates a configured limiter', () => {
    const limiter = createRateLimiter({ requestsPerMinute: 10, burst: 1 });
    expect(limiter.canExecute('key').allowed).toBe(true);
    expect(limiter.canExecute('key').allowed).toBe(false);
  });

  it('allows requests within burst', () => {
    const limiter = new TokenBucketRateLimiter({ requestsPerMinute: 60, burst: 3 });
    expect(limiter.canExecute('key', 0).allowed).toBe(true);
    expect(limiter.canExecute('key', 0).allowed).toBe(true);
    expect(limiter.canExecute('key', 0).allowed).toBe(true);
    expect(limiter.canExecute('key', 0).allowed).toBe(false);
  });

  it('refills tokens over time', () => {
    const limiter = new TokenBucketRateLimiter({ requestsPerMinute: 60, burst: 1 });
    expect(limiter.canExecute('key', 0).allowed).toBe(true);
    expect(limiter.canExecute('key', 0).allowed).toBe(false);
    expect(limiter.canExecute('key', 60_000).allowed).toBe(true);
  });

  it('reports retryAfterSeconds when bucket is empty', () => {
    const limiter = new TokenBucketRateLimiter({ requestsPerMinute: 60, burst: 1 });
    limiter.canExecute('key', 0);
    const result = limiter.canExecute('key', 0);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  describe('canExecuteWithLimit (H4)', () => {
    it('enforces a per-call limit independent of the constructor limit, keyed separately per bucket', () => {
      // Constructor limit is generous; the per-key limit passed to
      // canExecuteWithLimit is what actually governs this key's bucket.
      const limiter = new TokenBucketRateLimiter({ requestsPerMinute: 6000, burst: 100 });
      const tightLimit = { requestsPerMinute: 60, burst: 1 };
      expect(limiter.canExecuteWithLimit('server:github', tightLimit, 0).allowed).toBe(true);
      expect(limiter.canExecuteWithLimit('server:github', tightLimit, 0).allowed).toBe(false);
      // A different key with the same limiter instance has its own bucket.
      expect(limiter.canExecute('team:m:github:tool', 0).allowed).toBe(true);
    });

    it('refills a canExecuteWithLimit bucket over time using the supplied limit', () => {
      const limiter = new TokenBucketRateLimiter({ requestsPerMinute: 60, burst: 20 });
      const limit = { requestsPerMinute: 60, burst: 1 };
      expect(limiter.canExecuteWithLimit('server:github', limit, 0).allowed).toBe(true);
      expect(limiter.canExecuteWithLimit('server:github', limit, 0).allowed).toBe(false);
      expect(limiter.canExecuteWithLimit('server:github', limit, 60_000).allowed).toBe(true);
    });
  });
});
