import type { TableClient, TableEntity } from '@azure/data-tables';
import type { SessionStore } from 'framework-core';
import type { RateLimitConfig, RateLimitResult } from './rate-limiter.js';
import type { CircuitBreakerConfig } from './circuit-breaker.js';
import type { GovernanceStateStore } from './governance-state.js';

/**
 * Shared-storage implementation of `GovernanceStateStore` (Milestone 18,
 * ADR-026): the rate-limit token buckets and circuit breaker state that used
 * to live in process memory (`RateLimiter`'s `Map<string, TokenBucket>` and
 * `ToolshedState.breakers`'s `Map<string, CircuitBreaker>`) are persisted to
 * the repository's existing Azure Table Storage layer — the same account
 * `cloud-audit.ts` already writes to — so two toolshed replicas read and
 * write one shared view of governance state. Approval CRUD is deliberately
 * NOT moved: it stays on the injected `SessionStore` (SQLite), whose
 * synchronous interface is unchanged (see ADR-026 for the residual
 * single-writer limitation on the approval path).
 *
 * Storage layout (one entity per key):
 *  - rate-limit bucket: `PartitionKey = "ratelimit"`, `RowKey = <bucket key>`,
 *    columns `tokens` (double) and `lastRefill` (epoch ms).
 *  - breaker: `PartitionKey = "breaker"`, `RowKey = <server alias>`, columns
 *    `state` ("closed" | "open" | "half-open"), `failures`, `successes`,
 *    `openedAt` (epoch ms), `halfOpenRequests`.
 *
 * Concurrency: every mutation is a read-modify-write protected by the entity's
 * ETag (optimistic concurrency). `getEntity` returns the current ETag; the
 * write-back is an `updateEntity(..., "Replace", { etag })` that Azure Tables
 * rejects with a 412 precondition failure if another replica changed the row
 * first, at which point the whole read-modify-write is retried (bounded). A
 * first-ever create (no entity on read) uses `upsertEntity("Replace")`, whose
 * race is last-writer-wins — acceptable for a token bucket whose refill is
 * a pure function of elapsed time, and for a breaker whose first transition
 * is idempotent. This mirrors the `CircuitBreaker` and
 * `TokenBucketRateLimiter` state machines exactly; the transitions are pure
 * functions below rather than methods on the class so they can run against
 * the record read from the table.
 */

const RATE_PARTITION = 'ratelimit';
const BREAKER_PARTITION = 'breaker';
/** Upper bound on read-modify-write attempts before a live ETag race is surfaced. */
const MAX_CAS_ATTEMPTS = 5;

interface Bucket {
  tokens: number;
  lastRefill: number;
}

interface BreakerRecord {
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  successes: number;
  openedAt: number;
  halfOpenRequests: number;
}

export interface SharedGovernanceStateStoreOptions {
  /** The TableClient for the governance table (real Azure or Azurite emulation). */
  client: TableClient;
  /** Approval CRUD is delegated here — unchanged from the in-process adapter. */
  store: SessionStore;
  /** Breaker thresholds/timeouts, the same config `createDefaultToolshedState` uses. */
  circuitBreakerConfig: CircuitBreakerConfig;
  /** The rate limiter's constructor-configured default limit (mirrors `createRateLimiter`). */
  defaultRateLimit: RateLimitConfig;
  /** Injectable clock (matching the `now` convention elsewhere); defaults to `Date.now`. */
  now?: () => number;
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeState(value: unknown): BreakerRecord['state'] {
  if (value === 'open' || value === 'half-open') return value;
  return 'closed';
}

function bucketToEntity(bucket: Bucket): Record<string, unknown> {
  return { tokens: bucket.tokens, lastRefill: bucket.lastRefill };
}

function bucketFromEntity(entity: Record<string, unknown>): Bucket {
  return { tokens: num(entity.tokens), lastRefill: num(entity.lastRefill) };
}

function breakerToEntity(record: BreakerRecord): Record<string, unknown> {
  return {
    state: record.state,
    failures: record.failures,
    successes: record.successes,
    openedAt: record.openedAt,
    halfOpenRequests: record.halfOpenRequests,
  };
}

function recordFromEntity(entity: Record<string, unknown> | undefined): BreakerRecord {
  if (!entity) {
    return { state: 'closed', failures: 0, successes: 0, openedAt: 0, halfOpenRequests: 0 };
  }
  return {
    state: normalizeState(entity.state),
    failures: num(entity.failures),
    successes: num(entity.successes),
    openedAt: num(entity.openedAt),
    halfOpenRequests: num(entity.halfOpenRequests),
  };
}

/** Pure mirror of `CircuitBreaker`'s `state` getter (open -> half-open once the timeout elapses). */
function resolveState(record: BreakerRecord, now: number, config: CircuitBreakerConfig): BreakerRecord {
  if (record.state === 'open' && (now - record.openedAt) / 1000 >= config.timeoutSecs) {
    return { ...record, state: 'half-open', halfOpenRequests: 0, successes: 0 };
  }
  return record;
}

/** Pure mirror of `CircuitBreaker.recordSuccess` (reads `_state`, no half-open transition). */
function recordSuccess(record: BreakerRecord, config: CircuitBreakerConfig): BreakerRecord {
  if (record.state === 'half-open') {
    const successes = record.successes + 1;
    if (successes >= config.successThreshold) {
      return { state: 'closed', failures: 0, successes: 0, openedAt: record.openedAt, halfOpenRequests: record.halfOpenRequests };
    }
    return { ...record, successes };
  }
  return { ...record, failures: 0 };
}

/** Pure mirror of `CircuitBreaker.recordFailure` (half-open trips immediately; otherwise counts up). */
function recordFailure(record: BreakerRecord, now: number, config: CircuitBreakerConfig): BreakerRecord {
  if (record.state === 'half-open') {
    return { state: 'open', failures: 0, successes: 0, openedAt: now, halfOpenRequests: 0 };
  }
  const failures = record.failures + 1;
  if (failures >= config.failureThreshold) {
    return { state: 'open', failures: 0, successes: 0, openedAt: now, halfOpenRequests: 0 };
  }
  return { ...record, failures };
}

/** Pure mirror of `CircuitBreaker.retryAfterSeconds` (reads `_state`, no transition). */
function retryAfterSeconds(record: BreakerRecord, now: number, config: CircuitBreakerConfig): number {
  if (record.state !== 'open') return 0;
  const elapsed = (now - record.openedAt) / 1000;
  return Math.max(0, Math.ceil(config.timeoutSecs - elapsed));
}

/** Pure mirror of `TokenBucketRateLimiter.canExecuteWithLimit`. */
function takeToken(
  bucket: Bucket | undefined,
  limit: RateLimitConfig,
  now: number
): { next: Bucket; result: RateLimitResult } {
  const capacity = limit.burst;
  const refillRatePerMs = limit.requestsPerMinute / 60_000;
  const current = bucket ?? { tokens: capacity, lastRefill: now };
  const tokensToAdd = (now - current.lastRefill) * refillRatePerMs;
  const tokens = Math.min(capacity, current.tokens + tokensToAdd);
  const lastRefill = now;

  if (tokens < 1) {
    const deficit = 1 - tokens;
    const retryAfterSeconds = Math.max(1, Math.ceil(deficit / (limit.requestsPerMinute / 60)));
    return { next: { tokens, lastRefill }, result: { allowed: false, retryAfterSeconds } };
  }
  return { next: { tokens: tokens - 1, lastRefill }, result: { allowed: true } };
}

function isRestErrorWithStatus(err: unknown, status: number): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { statusCode?: unknown }).statusCode === status
  );
}

function isNotFound(err: unknown): boolean {
  return isRestErrorWithStatus(err, 404);
}

function isPreconditionFailed(err: unknown): boolean {
  return isRestErrorWithStatus(err, 412);
}

interface EntitySnapshot {
  entity?: Record<string, unknown>;
  etag?: string;
}

/** Reads an entity, treating a 404 (never existed) as "absent" rather than an error. */
async function readEntity(client: TableClient, partitionKey: string, rowKey: string): Promise<EntitySnapshot> {
  try {
    const result = await client.getEntity(partitionKey, rowKey);
    return { entity: result as unknown as Record<string, unknown>, etag: result.etag };
  } catch (err) {
    if (isNotFound(err)) return {};
    throw err;
  }
}

async function writeEntity(
  client: TableClient,
  partitionKey: string,
  rowKey: string,
  fields: Record<string, unknown>,
  etag?: string
): Promise<void> {
  const entity = { partitionKey, rowKey, ...fields } as TableEntity<Record<string, unknown>>;
  if (etag === undefined) {
    await client.upsertEntity(entity, 'Replace');
  } else {
    await client.updateEntity(entity, 'Replace', { etag });
  }
}

/**
 * Read-modify-write with optimistic concurrency. `compute` maps the current
 * entity (or `undefined` if absent) to the fields to write and a caller-facing
 * result; returning `write: null` skips the write for read-only transitions.
 * An ETag conflict (412) re-reads and retries, bounded by `MAX_CAS_ATTEMPTS`.
 */
async function readModifyWrite<T>(
  client: TableClient,
  partitionKey: string,
  rowKey: string,
  compute: (current: Record<string, unknown> | undefined) => { write: Record<string, unknown> | null; result: T }
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const snapshot = await readEntity(client, partitionKey, rowKey);
    const { write, result } = compute(snapshot.entity);
    if (write === null) return result;
    try {
      await writeEntity(client, partitionKey, rowKey, write, snapshot.etag);
      return result;
    } catch (err) {
      if (isPreconditionFailed(err) && attempt < MAX_CAS_ATTEMPTS - 1) {
        continue;
      }
      throw err;
    }
  }
}

export function createSharedGovernanceStateStore(options: SharedGovernanceStateStoreOptions): GovernanceStateStore {
  const { client, store, circuitBreakerConfig, defaultRateLimit } = options;
  const now = options.now ?? Date.now;

  return {
    async takeRateLimitToken(key, limit, at) {
      const nowMs = at ?? now();
      return readModifyWrite(client, RATE_PARTITION, key, (current) => {
        const taken = takeToken(current ? bucketFromEntity(current) : undefined, limit, nowMs);
        return { write: bucketToEntity(taken.next), result: taken.result };
      });
    },

    async takeDefaultRateLimitToken(key, at) {
      const nowMs = at ?? now();
      return readModifyWrite(client, RATE_PARTITION, key, (current) => {
        const taken = takeToken(current ? bucketFromEntity(current) : undefined, defaultRateLimit, nowMs);
        return { write: bucketToEntity(taken.next), result: taken.result };
      });
    },

    async canExecuteBreaker(key) {
      const nowMs = now();
      return readModifyWrite(client, BREAKER_PARTITION, key, (current) => {
        const record = recordFromEntity(current);
        const resolved = resolveState(record, nowMs, circuitBreakerConfig);
        if (resolved.state === 'open') {
          // Still open (timeout not yet elapsed): reject, nothing to write.
          return { write: null, result: false };
        }
        if (resolved.state === 'half-open' && resolved.halfOpenRequests >= circuitBreakerConfig.halfOpenMaxRequests) {
          // Half-open but already at the probe budget: reject without writing.
          return { write: null, result: false };
        }
        const next: BreakerRecord = { ...resolved, halfOpenRequests: resolved.halfOpenRequests + 1 };
        return { write: breakerToEntity(next), result: true };
      });
    },

    async recordBreakerSuccess(key) {
      await readModifyWrite(client, BREAKER_PARTITION, key, (current) => {
        const record = recordFromEntity(current);
        return { write: breakerToEntity(recordSuccess(record, circuitBreakerConfig)), result: undefined as void };
      });
    },

    async recordBreakerFailure(key) {
      const nowMs = now();
      await readModifyWrite(client, BREAKER_PARTITION, key, (current) => {
        const record = recordFromEntity(current);
        return { write: breakerToEntity(recordFailure(record, nowMs, circuitBreakerConfig)), result: undefined as void };
      });
    },

    async breakerRetryAfterSeconds(key) {
      const nowMs = now();
      const snapshot = await readEntity(client, BREAKER_PARTITION, key);
      return retryAfterSeconds(recordFromEntity(snapshot.entity), nowMs, circuitBreakerConfig);
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
