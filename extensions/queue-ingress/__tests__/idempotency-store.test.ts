import { describe, expect, it } from '@jest/globals';
import { InMemoryIdempotencyStore } from '../src/idempotency-store.js';

const outcome = {
  status: 'completed' as const,
  result: { text: 'done' },
  completedAt: 1234567890,
};

describe('InMemoryIdempotencyStore (Milestone 15)', () => {
  it('returns undefined for an unrecorded key', async () => {
    const store = new InMemoryIdempotencyStore();
    await expect(store.get('missing')).resolves.toBeUndefined();
  });

  it('round-trips a recorded outcome', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.set('key-1', outcome);
    await expect(store.get('key-1')).resolves.toEqual(outcome);
  });

  it('overwrites on a repeated set', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.set('key-1', outcome);
    await store.set('key-1', { ...outcome, completedAt: 999 });
    await expect(store.get('key-1')).resolves.toEqual({ ...outcome, completedAt: 999 });
  });
});
