import { describe, expect, it, jest } from '@jest/globals';
import type { TableClient } from '@azure/data-tables';
import { InMemoryIdempotencyStore, type RecordedOutcome } from '../src/idempotency-store.js';
import { TableIdempotencyStore } from '../src/table-idempotency-store.js';

/**
 * Remediation Milestone 4: the durable idempotency store backing the
 * at-most-once guarantee across the queue consumer's replicas. The fake
 * TableClient mirrors `mcp-toolshed`'s `shared-governance-state.test.ts`
 * stand-in (real 404/409 semantics, no live Azure/Azurite); a live-Azurite
 * integration test lands with Milestone 11.
 */

const outcome: RecordedOutcome = {
  status: 'completed',
  result: { text: 'item settled' },
  completedAt: 1_700_000_000_000,
};

interface FakeTable {
  client: TableClient;
  put: (partitionKey: string, rowKey: string, fields: Record<string, unknown>) => void;
  rows: () => Map<string, Record<string, unknown>>;
}

function createFakeTable(): FakeTable {
  const rows = new Map<string, Record<string, unknown>>();
  const key = (partitionKey: string, rowKey: string) => `${partitionKey} ${rowKey}`;
  const err = (statusCode: number) => {
    const e = new Error(`HTTP ${statusCode}`) as Error & { statusCode: number };
    e.statusCode = statusCode;
    return e;
  };
  const client = {
    async getEntity(partitionKey: string, rowKey: string) {
      const row = rows.get(key(partitionKey, rowKey));
      if (!row) throw err(404);
      return { ...row, partitionKey, rowKey, etag: 'W/"1"' };
    },
    async createEntity(entity: Record<string, unknown>) {
      const { partitionKey, rowKey } = entity as Record<string, unknown> & {
        partitionKey: string;
        rowKey: string;
      };
      if (rows.has(key(partitionKey, rowKey))) throw err(409);
      rows.set(key(partitionKey, rowKey), entity);
      return;
    },
  } as unknown as TableClient;
  return {
    client,
    put: (partitionKey, rowKey, fields) => rows.set(key(partitionKey, rowKey), fields),
    rows: () => rows,
  };
}

describe('TableIdempotencyStore (remediation Milestone 4)', () => {
  it('returns undefined for a key with no row (the miss path)', async () => {
    const table = createFakeTable();
    const store = new TableIdempotencyStore(table.client);
    await expect(store.get('key-1')).resolves.toBeUndefined();
  });

  it('round-trips an outcome through the row (partition idempotency, url-encoded row key)', async () => {
    const table = createFakeTable();
    const store = new TableIdempotencyStore(table.client);

    await store.set('key/with?special#chars', outcome);
    const read = await store.get('key/with?special#chars');

    expect(read).toEqual(outcome);
    // Exactly one row, in the idempotency partition, encoded so the illegal
    // row-key characters survive.
    expect([...table.rows().keys()]).toEqual(['idempotency key%2Fwith%3Fspecial%23chars']);
  });

  it('adopts the first writer outcome on a 409 (concurrent duplicate across replicas)', async () => {
    const table = createFakeTable();
    const winner = new TableIdempotencyStore(table.client);
    const loser = new TableIdempotencyStore(table.client);

    await winner.set('key-1', outcome);
    // The losing replica wrote between the winner's set and its own — no
    // throw, no overwrite; the recorded outcome is still the winner's.
    await expect(loser.set('key-1', { ...outcome, completedAt: 999 })).resolves.toBeUndefined();
    await expect(winner.get('key-1')).resolves.toEqual(outcome);
  });

  it('treats a corrupt row as a miss, loudly (the gateway idempotency keys remain the backstop)', async () => {
    const table = createFakeTable();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      table.put('idempotency', 'corrupt', { resultJson: '{not json', completedAt: 1 });
      const store = new TableIdempotencyStore(table.client);
      await expect(store.get('corrupt')).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('corrupt'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('surfaces non-409/404 storage errors rather than swallowing them', async () => {
    const err = new Error('HTTP 503') as Error & { statusCode: number };
    err.statusCode = 503;
    const client = {
      getEntity: async () => {
        throw err;
      },
      createEntity: async () => {
        throw err;
      },
    } as unknown as TableClient;
    const store = new TableIdempotencyStore(client);
    await expect(store.get('k')).rejects.toThrow('503');
    await expect(store.set('k', outcome)).rejects.toThrow('503');
  });

  it('the async interface keeps the in-memory store a drop-in replacement', async () => {
    const store = new InMemoryIdempotencyStore();
    await expect(store.get('k')).resolves.toBeUndefined();
    await store.set('k', outcome);
    await expect(store.get('k')).resolves.toEqual(outcome);
  });
});
