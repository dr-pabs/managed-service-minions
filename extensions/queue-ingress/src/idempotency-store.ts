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
 * Key-value store of completed idempotency keys -> recorded outcome. In
 * production this would be backed by durable storage shared across replicas;
 * for Milestone 15 the in-memory implementation below is the reference
 * backend (mirrors `createMemoryStore` in `mcp-toolshed`'s `store.ts`), and
 * the interface is what keeps a durable swap-in a drop-in replacement.
 */
export interface IdempotencyStore {
  get(key: string): RecordedOutcome | undefined;
  set(key: string, outcome: RecordedOutcome): void;
}

/**
 * In-memory `IdempotencyStore` (Milestone 15): a `Map`-backed implementation
 * used for local dev and every test. Not durable across restarts — a process
 * restart re-runs in-flight items, which is acceptable for this milestone's
 * single-replica governance posture (ADR-025) and out of scope to harden.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private outcomes = new Map<string, RecordedOutcome>();

  get(key: string): RecordedOutcome | undefined {
    return this.outcomes.get(key);
  }

  set(key: string, outcome: RecordedOutcome): void {
    this.outcomes.set(key, outcome);
  }
}
