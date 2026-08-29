import type { IngressResponse } from 'framework-core';

/**
 * The outcome of a successfully processed work item, recorded against its
 * `idempotency_key` so a redelivery or duplicate can short-circuit to this
 * result instead of re-running the orchestrator (Milestone 15 redelivery
 * safety). `completedAt` is an epoch-millis timestamp for observability.
 */
export interface RecordedOutcome {
  status: 'completed';
  result: IngressResponse;
  completedAt: number;
}

/**
 * Key-value store of completed idempotency keys -> recorded outcome
 * (remediation Milestone 4). The interface is async because the durable
 * implementation is Azure Tables: `set` is an insert-if-absent whose 409
 * means another replica recorded the same outcome first — first writer wins,
 * which is exactly the duplicate semantics the consumer needs. The in-memory
 * implementation below remains the local-dev / single-process backend;
 * production wiring (`src/index.ts`) selects the table-backed store when
 * `IDEMPOTENCY_STATE_CONNECTION_STRING` is set, so the at-most-once guarantee
 * survives restarts and holds across the queue consumer's 1-5 replicas.
 */
export interface IdempotencyStore {
  get(key: string): Promise<RecordedOutcome | undefined>;
  set(key: string, outcome: RecordedOutcome): Promise<void>;
}

/**
 * In-memory `IdempotencyStore`: a `Map`-backed implementation used for local
 * dev and every test. Not durable across restarts and not shared between
 * replicas — with queue-ingress scaled beyond one replica (the M18 posture
 * that superseded ADR-025), a duplicate landing on another replica re-runs,
 * so deployments that care set `IDEMPOTENCY_STATE_CONNECTION_STRING` and get
 * the table-backed store instead.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private outcomes = new Map<string, RecordedOutcome>();

  async get(key: string): Promise<RecordedOutcome | undefined> {
    return this.outcomes.get(key);
  }

  async set(key: string, outcome: RecordedOutcome): Promise<void> {
    this.outcomes.set(key, outcome);
  }
}
