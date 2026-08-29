import { describe, expect, it } from '@jest/globals';
import { InMemoryIdempotencyStore } from '../src/idempotency-store.js';

const outcome = {
  status: 'completed' as const,
  result: { text: 'done' },
  completedAt: 1234567890,
};

describe('InMemoryIdempotencyStore (Milestone 15)', () => {
  it('returns undefined for an unrecorded key', () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.get('missing')).toBeUndefined();
  });

  it('round-trips a recorded outcome', () => {
    const store = new InMemoryIdempotencyStore();
    store.set('key-1', outcome);
    expect(store.get('key-1')).toEqual(outcome);
  });

  it('overwrites on a repeated set', () => {
    const store = new InMemoryIdempotencyStore();
    store.set('key-1', outcome);
    store.set('key-1', { ...outcome, completedAt: 999 });
    expect(store.get('key-1')).toEqual({ ...outcome, completedAt: 999 });
  });
});
