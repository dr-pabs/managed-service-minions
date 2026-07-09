import type { PendingApproval, SessionStore } from 'framework-core';
import type { RateLimitConfig, RateLimitResult, RateLimiter } from './rate-limiter.js';
import { CircuitBreaker, type CircuitBreakerConfig } from './circuit-breaker.js';

/**
 * Shared-state seam for the governance operations that currently live as
 * process-local structures inside the toolshed (H5/F6, ADR-025): rate-limit
 * token buckets, circuit breaker state, and pending-approval CRUD. Every
 * operation here is exactly what `executeTool`/`gateDestructiveCall`
 * (`toolshed.ts`) already needs — extracted from the existing
 * `RateLimiter`/`CircuitBreaker`/`SessionStore` call sites, not invented.
 *
 * Today the only implementation (`createInProcessGovernanceStateStore`) is a
 * thin adapter over those same in-process structures — this milestone is
 * intentionally an additive interface plus adapter, not a rewrite of the
 * rate limiter/breaker/approval logic itself (see the ExecPlan Decision Log
 * for Milestone 7: the smaller, behavior-preserving diff was chosen over a
 * full refactor of every call site). A future distributed implementation
 * (Redis, per ADR-025's trigger condition) implements this same interface
 * without `toolshed.ts` needing to change again.
 */
export interface GovernanceStateStore {
  /**
   * Attempts to take one token from the named bucket, enforcing `limit`.
   * Mirrors `RateLimiter.canExecuteWithLimit` exactly — used for the
   * per-server `server:${serverAlias}` bucket, whose limit is looked up from
   * `governance.rateLimits` per call.
   */
  takeRateLimitToken(key: string, limit: RateLimitConfig, now?: number): RateLimitResult;

  /**
   * Attempts to take one token from the named bucket using the rate
   * limiter's OWN constructor-configured default limit (mirrors
   * `RateLimiter.canExecute` exactly). Used for the pre-existing
   * fine-grained `team:minion:server:tool` bucket, which — unlike the
   * per-server bucket above — has always been driven by whatever limit the
   * `RateLimiter` instance itself was constructed with, not by
   * `governance.rateLimits.default` read fresh on every call (the two
   * happen to hold the same value in the wired-up server, but tests are
   * free to override one without the other, e.g. to prove throttling in
   * isolation — collapsing this into a single governance-config-driven
   * method would silently change that behavior).
   */
  takeDefaultRateLimitToken(key: string, now?: number): RateLimitResult;

  /** Whether the named breaker currently permits a call (state read + half-open bookkeeping). */
  canExecuteBreaker(key: string): boolean;
  /** Records a successful downstream call against the named breaker. */
  recordBreakerSuccess(key: string): void;
  /** Records a failed downstream call against the named breaker. */
  recordBreakerFailure(key: string): void;
  /** Seconds until the named breaker's open state may transition to half-open (0 if not open). */
  breakerRetryAfterSeconds(key: string): number;

  /** Persists a newly created pending approval. */
  createApproval(approval: PendingApproval): void;
  /** Looks up a pending approval by id. */
  getApproval(id: string): PendingApproval | undefined;
  /** Looks up the most-recently-requested pending approval matching a request hash (resume-by-resubmit, Milestone 4). */
  getApprovalByRequestHash(requestHash: string): PendingApproval | undefined;
  /** Records a human decision (and, when known, the approver's identity) against a pending approval. */
  resolveApproval(
    id: string,
    decision: 'approved' | 'denied',
    approver?: { kind: 'slack' | 'teams' | 'dashboard'; id: string }
  ): void;
  /** Marks a pending approval as consumed (executed) at the given time, so a further identical resubmission cannot re-execute it. */
  markApprovalConsumed(id: string, consumedAt: number): void;
}

/**
 * Adapter over the toolshed's current in-process structures: the injected
 * `RateLimiter` (its own internal `Map<string, TokenBucket>`), a
 * `Map<string, CircuitBreaker>` keyed by server alias (constructed lazily,
 * same as `getBreaker` in `toolshed.ts` before this milestone), and the
 * existing `SessionStore` for approval CRUD. No new state is introduced —
 * this exists purely to give `toolshed.ts` one seam to call through instead
 * of reaching into three different collaborators directly.
 */
export function createInProcessGovernanceStateStore(
  rateLimiter: RateLimiter,
  breakers: Map<string, CircuitBreaker>,
  circuitBreakerConfig: CircuitBreakerConfig,
  store: SessionStore
): GovernanceStateStore {
  function getOrCreateBreaker(key: string): CircuitBreaker {
    let breaker = breakers.get(key);
    if (!breaker) {
      breaker = new CircuitBreaker(circuitBreakerConfig);
      breakers.set(key, breaker);
    }
    return breaker;
  }

  return {
    takeRateLimitToken(key, limit, now) {
      return rateLimiter.canExecuteWithLimit(key, limit, now);
    },
    takeDefaultRateLimitToken(key, now) {
      return rateLimiter.canExecute(key, now);
    },
    canExecuteBreaker(key) {
      return getOrCreateBreaker(key).canExecute();
    },
    recordBreakerSuccess(key) {
      getOrCreateBreaker(key).recordSuccess();
    },
    recordBreakerFailure(key) {
      getOrCreateBreaker(key).recordFailure();
    },
    breakerRetryAfterSeconds(key) {
      return getOrCreateBreaker(key).retryAfterSeconds;
    },
    createApproval(approval) {
      store.createApproval(approval);
    },
    getApproval(id) {
      return store.getApproval(id);
    },
    getApprovalByRequestHash(requestHash) {
      return store.getApprovalByRequestHash(requestHash);
    },
    resolveApproval(id, decision, approver) {
      store.resolveApproval(id, decision, approver);
    },
    markApprovalConsumed(id, consumedAt) {
      store.markApprovalConsumed(id, consumedAt);
    },
  };
}
