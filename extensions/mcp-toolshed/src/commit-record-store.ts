import type { TableClient } from '@azure/data-tables';
import type { DecisionRecord } from './effect-store.js';

/**
 * Durable commit-record store (remediation Milestone 5). The effect gateway
 * deduplicates commits on the draft's `idempotency_key` using in-process
 * state (`EffectDraftStore`), so a restart or a second replica holding the
 * same key can double-commit a replayed commit. This store is the durable
 * half: the outcome of every committed key is recorded in Azure Tables
 * (partition `commits`, row key = url-encoded idempotency key, the serialized
 * decision record and connector outcome as columns), and the gateway consults
 * it before gating and writes it before acknowledging a commit.
 *
 * Concurrency: `put` is an insert-if-absent (`createEntity`). A 409 is NOT an
 * error — it means another replica committed the same key first; first writer
 * wins and the caller replays the recorded outcome. This mirrors the
 * queue-ingress `TableIdempotencyStore` semantics (remediation Milestone 4)
 * and, like it, rides the same storage account the shared governance state
 * uses (ADR-026) so one connection string covers both tables.
 */

export interface CommitRecord {
  /** The `effects/v1` decision record of the commit, exactly as returned to the caller. */
  decision: DecisionRecord;
  /** The connector outcome of the commit. */
  outcome: Record<string, unknown>;
  /** Epoch-millis commit time (observability). */
  committedAt: number;
}

export interface CommitRecordStore {
  get(key: string): Promise<CommitRecord | undefined>;
  /** Returns false when another replica already recorded this key (first writer won). */
  put(key: string, record: CommitRecord): Promise<boolean>;
}

const PARTITION_KEY = 'commits';

function encodeRowKey(key: string): string {
  return encodeURIComponent(key);
}

function isRestErrorWithStatus(err: unknown, status: number): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { statusCode?: unknown }).statusCode === status
  );
}

export class TableCommitRecordStore implements CommitRecordStore {
  constructor(private readonly client: TableClient) {}

  async get(key: string): Promise<CommitRecord | undefined> {
    let entity: Record<string, unknown>;
    try {
      entity = (await this.client.getEntity(PARTITION_KEY, encodeRowKey(key))) as Record<string, unknown>;
    } catch (err) {
      if (isRestErrorWithStatus(err, 404)) {
        return undefined;
      }
      throw err;
    }
    try {
      return {
        decision: JSON.parse(String(entity.decisionJson)) as DecisionRecord,
        outcome: JSON.parse(String(entity.outcomeJson)) as Record<string, unknown>,
        committedAt: Number(entity.committedAt),
      };
    } catch {
      console.warn(`[mcp-toolshed] commit record for key ${key} is corrupt -- treating as not recorded`);
      return undefined;
    }
  }

  async put(key: string, record: CommitRecord): Promise<boolean> {
    try {
      await this.client.createEntity({
        partitionKey: PARTITION_KEY,
        rowKey: encodeRowKey(key),
        decisionJson: JSON.stringify(record.decision),
        outcomeJson: JSON.stringify(record.outcome),
        committedAt: record.committedAt,
      });
      return true;
    } catch (err) {
      if (isRestErrorWithStatus(err, 409)) {
        return false;
      }
      throw err;
    }
  }
}
