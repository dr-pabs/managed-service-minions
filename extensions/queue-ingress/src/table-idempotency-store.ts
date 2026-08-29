import type { TableClient } from '@azure/data-tables';
import type { IdempotencyStore, RecordedOutcome } from './idempotency-store.js';

/**
 * Durable `IdempotencyStore` on Azure Tables (remediation Milestone 4) — the
 * same storage layer `mcp-toolshed`'s shared governance state landed on at
 * M18 (ADR-026), so a duplicate delivery landing on a different queue-ingress
 * replica (or after a restart) short-circuits to the recorded outcome instead
 * of re-running the item. Storage layout: one entity per idempotency key,
 * `PartitionKey = "idempotency"`, `RowKey = <url-encoded key>`, columns
 * `resultJson` (the serialized `IngressResponse`) and `completedAt` (epoch ms).
 *
 * Concurrency: `set` is an insert-if-absent (`createEntity`). Azure Tables
 * rejects a duplicate insert with 409 — which is NOT an error here but the
 * first-writer-wins duplicate outcome: another replica recorded the same
 * completion, so the loser adopts the table's record by simply not
 * overwriting. This is the at-most-once guarantee the Milestone 15 contract
 * ("duplicate delivery of the same item commits at most one effect") needs
 * once the consumer runs more than one replica.
 */

const PARTITION_KEY = 'idempotency';

/**
 * Row keys cannot carry `/`, `\`, `#`, or `?`. `encodeURIComponent` covers
 * all four (and more) while leaving the UUID-ish characters idempotency keys
 * typically use untouched.
 */
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

export class TableIdempotencyStore implements IdempotencyStore {
  constructor(private readonly client: TableClient) {}

  async get(key: string): Promise<RecordedOutcome | undefined> {
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
      const result = JSON.parse(String(entity.resultJson)) as RecordedOutcome['result'];
      return {
        status: 'completed',
        result,
        completedAt: Number(entity.completedAt),
      };
    } catch {
      // A row that cannot be parsed is treated as a miss with a loud note:
      // the item re-runs, and the effect gateway's own idempotency keys
      // remain the backstop against a double external write.
      console.warn(`[queue-ingress] idempotency row for key ${key} is corrupt (unparsable resultJson) -- treating as not recorded`);
      return undefined;
    }
  }

  async set(key: string, outcome: RecordedOutcome): Promise<void> {
    try {
      await this.client.createEntity({
        partitionKey: PARTITION_KEY,
        rowKey: encodeRowKey(key),
        resultJson: JSON.stringify(outcome.result),
        completedAt: outcome.completedAt,
      });
    } catch (err) {
      if (isRestErrorWithStatus(err, 409)) {
        // Another replica recorded this completion first: first writer wins,
        // their outcome stands. Deliberately not an error.
        return;
      }
      throw err;
    }
  }
}
