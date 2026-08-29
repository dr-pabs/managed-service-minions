import { describe, expect, it, jest } from '@jest/globals';
import type { TableClient } from '@azure/data-tables';
import { TableCommitRecordStore, type CommitRecord } from '../commit-record-store.js';

/**
 * Remediation Milestone 5: the durable commit-record store that keeps the
 * effect gateway's commit idempotency alive across restarts and replicas.
 * The fake TableClient mirrors `shared-governance-state.test.ts` (real
 * 404/409 semantics, no live Azure); a live-Azurite integration test lands
 * with Milestone 11.
 */

const record: CommitRecord = {
  decision: {
    draft_ref: 'effect_00000000-0000-0000-0000-000000000000',
    decision: 'commit',
    draft: { effect_type: 'payment.refund', target_system: 'payments' },
  } as CommitRecord['decision'],
  outcome: { refund_id: 're_1' },
  committedAt: 1_700_000_000_000,
};

function createFakeTable() {
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
  return { client, rows };
}

describe('TableCommitRecordStore (remediation Milestone 5)', () => {
  it('returns undefined for a key with no row', async () => {
    const { client } = createFakeTable();
    const store = new TableCommitRecordStore(client);
    await expect(store.get('key-1')).resolves.toBeUndefined();
  });

  it('round-trips a commit record (partition commits, url-encoded row key)', async () => {
    const table = createFakeTable();
    const store = new TableCommitRecordStore(table.client);

    const won = await store.put('refund/key?1', record);
    expect(won).toBe(true);
    await expect(store.get('refund/key?1')).resolves.toEqual(record);
    expect([...table.rows.keys()]).toEqual(['commits refund%2Fkey%3F1']);
  });

  it('reports first-writer-wins on a 409 without overwriting', async () => {
    const table = createFakeTable();
    const winner = new TableCommitRecordStore(table.client);
    const loser = new TableCommitRecordStore(table.client);

    await winner.put('key-1', record);
    await expect(loser.put('key-1', { ...record, committedAt: 999 })).resolves.toBe(false);
    await expect(winner.get('key-1')).resolves.toEqual(record);
  });

  it('treats a corrupt row as a miss, loudly', async () => {
    const table = createFakeTable();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      table.rows.set('commits corrupt', { decisionJson: '{nope', outcomeJson: '{}', committedAt: 1 });
      const store = new TableCommitRecordStore(table.client);
      await expect(store.get('corrupt')).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('corrupt'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('surfaces non-404/409 storage errors', async () => {
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
    const store = new TableCommitRecordStore(client);
    await expect(store.get('k')).rejects.toThrow('503');
    await expect(store.put('k', record)).rejects.toThrow('503');
  });
});
