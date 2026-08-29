import type { PendingApproval, SessionStore } from 'framework-core';
import type { RateLimitConfig, RateLimitResult, RateLimiter } from './rate-limiter.js';
import { CircuitBreaker, type CircuitBreakerConfig } from './circuit-breaker.js';

/**
 * Shared-state seam for the governance operations that live as process-local
 * structures inside the toolshed (H5/F6, ADR-025) — rate-limit token buckets,
 * circuit breaker state, and pending-approval CRUD. Every operation here is
 * exactly what `executeTool`/`gateDestructiveCall` (`toolshed.ts`) already
 * needs — extracted from the existing `RateLimiter`/`CircuitBreaker`/
 * `SessionStore` call sites, not invented.
 *
 * The six rate-limit/breaker methods are **async**: their state moves out of
 * process memory into a shared store for multi-replica scaling (Milestone 18,
 * ADR-026), and a network-backed implementation can only offer a promise. The
 * approval CRUD methods stay **sync** because approvals remain on the
 * `SessionStore` (SQLite), whose interface is synchronous today — moving them
 * is explicitly out of scope for ADR-026.
 *
 * Two implementations satisfy this interface:
 *  - `createInProcessGovernanceStateStore` (below) — the original thin adapter
 *    over the in-process `RateLimiter`/`CircuitBreaker`/`SessionStore`. Still
 *    the default in `createDefaultToolshedState` and in dev, it now wraps the
 *    same synchronous results in promises so the interface is uniformly async.
 *  - `createSharedGovernanceStateStore` (`shared-governance-state.ts`,
 *    Milestone 18) — persists the rate-limit buckets and breaker state to the
 *    repository's existing Azure Table Storage layer (local Azurite emulation
 *    in dev) so multiple toolshed replicas share one view of governance state.
 *    Approval CRUD is delegated through to the injected `SessionStore`.
 *
 * Extracting this interface was intentionally an additive seam rather than a
 * rewrite of the rate limiter/breaker/approval logic itself (see the ExecPlan
 * Decision Log for Milestone 7); Milestone 18 is the first non-in-process
 * implementation of it.
 */
export interface GovernanceStateStore {
  /**
   * Attempts to take one token from the named bucket, enforcing `limit`.
   * Mirrors `RateLimiter.canExecuteWithLimit` exactly — used for the
   * per-server `server:${serverAlias}` bucket, whose limit is looked up from
   * `governance.rateLimits` per call.
   */
  takeRateLimitToken(key: string, limit: RateLimitConfig, now?: number): Promise<RateLimitResult>;

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
  takeDefaultRateLimitToken(key: string, now?: number): Promise<RateLimitResult>;

  /** Whether the named breaker currently permits a call (state read + half-open bookkeeping). */
  canExecuteBreaker(key: string): Promise<boolean>;
  /** Records a successful downstream call against the named breaker. */
  recordBreakerSuccess(key: string): Promise<void>;
  /** Records a failed downstream call against the named breaker. */
  recordBreakerFailure(key: string): Promise<void>;
  /** Seconds until the named breaker's open state may transition to half-open (0 if not open). */
  breakerRetryAfterSeconds(key: string): Promise<number>;

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
 *
 * The rate-limit/breaker methods are declared `async` so this adapter and
 * `createSharedGovernanceStateStore` present one uniformly-async interface:
 * the underlying `RateLimiter`/`CircuitBreaker` calls are still synchronous,
 * so each method simply resolves with the same value the pre-async interface
 * returned. `async` also converts a (theoretical) synchronous throw from a
 * misbehaving collaborator into a rejected promise rather than a throw the
 * `await`ing caller never expects — matching the shared store's error model.
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
    async takeRateLimitToken(key, limit, now) {
      return rateLimiter.canExecuteWithLimit(key, limit, now);
    },
    async takeDefaultRateLimitToken(key, now) {
      return rateLimiter.canExecute(key, now);
    },
    async canExecuteBreaker(key) {
      return getOrCreateBreaker(key).canExecute();
    },
    async recordBreakerSuccess(key) {
      getOrCreateBreaker(key).recordSuccess();
    },
    async recordBreakerFailure(key) {
      getOrCreateBreaker(key).recordFailure();
    },
    async breakerRetryAfterSeconds(key) {
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
