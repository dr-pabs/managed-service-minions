import { describe, expect, it } from '@jest/globals';
import type { IngressRunner } from 'framework-core';
import { consumeQueue } from '../src/consumer.js';
import { InMemoryIdempotencyStore } from '../src/idempotency-store.js';
import {
  DEAD_LETTER_MALFORMED_ENVELOPE,
  DEAD_LETTER_POISON_MESSAGE,
  WorkItemProcessor,
} from '../src/processor.js';
import { InMemoryWorkItemQueue } from '../src/queue.js';

/**
 * Milestone 21 soak: drive the queue-ingress through a thousand-item run over
 * the REAL `InMemoryWorkItemQueue` + `WorkItemProcessor` +
 * `InMemoryIdempotencyStore` + `consumeQueue` stack, seeded with duplicates and
 * poison items, and prove two invariants the milestone's "zero double-commits
 * and complete dead-letter accounting" clause demands:
 *
 *  * at-most-once effect commit — no idempotency key commits more than once, a
 *    seeded duplicate short-circuits to its recorded outcome instead of
 *    re-running the runner, and a poison item never commits at all;
 *  * no silent drops — every settled message is either completed or
 *    dead-lettered with the right reason, and the dead-letter queue holds
 *    exactly the poison + malformed items.
 *
 * Kept out of the default jest run: `testMatch` only discovers `__tests__/`,
 * so this file is reached solely via `pnpm --filter ./extensions/queue-ingress
 * test:soak`.
 */

// Seed sizes (add to exactly 1000 enqueued messages).
const GOOD_UNIQUE = 850;
const DUPLICATES = 100;
const POISON = 40;
const MALFORMED = 10;
const TOTAL_ENQUEUED = GOOD_UNIQUE + DUPLICATES + POISON + MALFORMED; // 1000
const MAX_DELIVERY = 3; // the processor's default poison threshold

function workItem(key: string) {
  return {
    item_type: 'ticket',
    payload: { title: `item ${key}` },
    idempotency_key: key,
    correlation_id: `corr-${key}`,
  };
}

describe('queue-ingress soak: 1000-item run (Milestone 21)', () => {
  it('commits no item twice and dead-letters exactly the poison and malformed items', async () => {
    const queue = new InMemoryWorkItemQueue();
    const outcomes = new InMemoryIdempotencyStore();

    const poisonKeys = new Set<string>();
    const runsByKey = new Map<string, number>();
    const commitsByKey = new Map<string, number>();

    const runner: IngressRunner = {
      async run(request) {
        const key = request.sessionId; // toRunnerRequest binds sessionId := idempotency_key
        runsByKey.set(key, (runsByKey.get(key) ?? 0) + 1);
        if (poisonKeys.has(key)) {
          throw new Error(`poison: ${key}`);
        }
        commitsByKey.set(key, (commitsByKey.get(key) ?? 0) + 1);
        return { text: `ok:${key}` };
      },
    };

    const processor = new WorkItemProcessor({ runner, queue, outcomes });

    // Seeded mix: GOOD_UNIQUE good items, DUPLICATES re-enqueues of a distinct
    // subset of those keys, POISON items whose run always throws, and MALFORMED
    // envelopes parseWorkItem rejects.
    const goodKeys: string[] = [];
    for (let i = 0; i < GOOD_UNIQUE; i += 1) {
      const key = `good-${i}`;
      goodKeys.push(key);
      queue.enqueue(workItem(key));
    }
    for (let i = 0; i < DUPLICATES; i += 1) {
      queue.enqueue(workItem(goodKeys[i % GOOD_UNIQUE])); // seeded duplicate
    }
    for (let i = 0; i < POISON; i += 1) {
      const key = `poison-${i}`;
      poisonKeys.add(key);
      queue.enqueue(workItem(key));
    }
    for (let i = 0; i < MALFORMED; i += 1) {
      queue.enqueue({ not: 'a work item' }); // malformed envelope
    }

    // Every message settles exactly once — except a poison item, which is
    // abandoned (MAX_DELIVERY - 1) times and then dead-lettered on its
    // MAX_DELIVERY-th delivery. The settlement count is therefore deterministic.
    const expectedSettlements = GOOD_UNIQUE + DUPLICATES + POISON * MAX_DELIVERY + MALFORMED;

    let settled = 0;
    const controller = new AbortController();
    const processed = await consumeQueue({
      queue,
      processor,
      signal: controller.signal,
      pollIntervalMs: 0,
      onResult: () => {
        settled += 1;
        if (settled === expectedSettlements) {
          controller.abort();
        }
      },
    });

    // The loop settled exactly the expected number of times — nothing was
    // silently dropped and no poison item was redelivered forever.
    expect(TOTAL_ENQUEUED).toBe(1000);
    expect(processed).toBe(expectedSettlements);

    // Zero double-commits. Each of the GOOD_UNIQUE keys committed exactly once
    // (its seeded duplicate short-circuited), and every poison key committed
    // zero times. `commitsByKey.size` is the total number of distinct committed
    // keys, which must be precisely the good ones.
    expect(commitsByKey.size).toBe(GOOD_UNIQUE);
    for (const n of commitsByKey.values()) {
      expect(n).toBe(1);
    }
    for (const key of poisonKeys) {
      expect(commitsByKey.has(key)).toBe(false);
    }

    // No key re-ran the runner: good keys ran once, poison keys ran
    // (MAX_DELIVERY - 1) times before dead-lettering — so the aggregate run
    // count is exactly this, proving duplicates short-circuited rather than
    // re-running.
    const totalRuns = [...runsByKey.values()].reduce((a, b) => a + b, 0);
    expect(totalRuns).toBe(GOOD_UNIQUE + POISON * (MAX_DELIVERY - 1));

    // Complete dead-letter accounting: exactly POISON + MALFORMED entries, with
    // the right reason split, and no in-flight message left over.
    const dead = queue.deadLetters();
    expect(dead).toHaveLength(POISON + MALFORMED);
    const byReason = new Map<string, number>();
    for (const entry of dead) {
      byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
    }
    expect(byReason.get(DEAD_LETTER_POISON_MESSAGE)).toBe(POISON);
    expect(byReason.get(DEAD_LETTER_MALFORMED_ENVELOPE)).toBe(MALFORMED);
    expect(queue.inFlightCount()).toBe(0);
  });
});
