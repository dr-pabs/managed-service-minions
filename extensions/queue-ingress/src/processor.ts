import type { IngressRequest, IngressResponse, IngressRunner } from 'framework-core';
import { parseWorkItem, type WorkItem } from './work-item.js';
import type { IdempotencyStore } from './idempotency-store.js';
import type { QueueMessage, WorkItemQueue } from './queue.js';

/**
 * Dead-letter reason codes (Milestone 15). The processor never silently drops
 * a message: a malformed envelope is dead-lettered immediately with
 * `MALFORMED_ENVELOPE`, and a well-formed item that repeatedly fails is
 * dead-lettered once its delivery count reaches the threshold with
 * `POISON_MESSAGE`. Both are surfaced so operators can inspect the dead-letter
 * queue and see *why* an item was quarantined.
 */
export const DEAD_LETTER_MALFORMED_ENVELOPE = 'MALFORMED_ENVELOPE';
export const DEAD_LETTER_POISON_MESSAGE = 'POISON_MESSAGE';

export type ProcessResult =
  | { status: 'completed'; result: IngressResponse; shortCircuited: boolean }
  | { status: 'dead_lettered'; reason: string }
  | { status: 'abandoned'; reason: string };

/**
 * The narrow capability the consume loop needs. Kept as a structural interface
 * (not the concrete `WorkItemProcessor` class, which carries private state) so
 * tests can pass a trivial `{ process }` fake without constructing the class.
 */
export interface MessageProcessor {
  process(message: QueueMessage): Promise<ProcessResult>;
}

export interface WorkItemProcessorDeps {
  runner: IngressRunner;
  queue: WorkItemQueue;
  outcomes: IdempotencyStore;
  /** Delivery count at which a repeatedly-failing item is dead-lettered as poison. Defaults to 3 (mirrors the Service Bus topic subscription's `max_delivery_count`). */
  maxDeliveryCount?: number;
}

/**
 * Maps a parsed `WorkItem` onto the exact `IngressRunner` request shape the
 * chat and webhook ingresses already drive, so the queue-ingress reuses the
 * SAME orchestrator runner with no changes. `platform: 'webhook'` is chosen
 * because the runner never branches on platform (it uses only `text`,
 * `sessionId`, and `correlationRoot`). Crucially this is called directly on
 * `runner.run` — NOT through `handleIngressMessage` — because that helper
 * overwrites `correlationRoot` with a fresh `createRootCorrelationId()`, which
 * would discard the envelope's own `correlation_id` (Milestone 15 requires
 * preserving it). `sessionId` is the `idempotency_key` so the runner's
 * `MinionRun` rows are stably keyed by item, and `correlationRoot` is the
 * envelope's `correlation_id` so the whole Stream trace hangs together.
 */
export function toRunnerRequest(item: WorkItem): IngressRequest & { sessionId: string; correlationRoot: string } {
  return {
    platform: 'webhook',
    teamId: item.item_type,
    userId: 'queue',
    text: payloadToText(item.payload),
    threadId: item.idempotency_key,
    sessionId: item.idempotency_key,
    correlationRoot: item.correlation_id,
  };
}

function payloadToText(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }
  try {
    return JSON.stringify(payload) ?? 'null';
  } catch {
    return String(payload);
  }
}

/**
 * Turns one queue message into exactly one of three outcomes (Milestone 15
 * redelivery safety, at-most-once effect commits):
 *
 * 1. **Malformed** — `parseWorkItem` rejects the body -> dead-letter
 *    `MALFORMED_ENVELOPE` immediately (no effect attempted).
 * 2. **Already completed** — `idempotency_key` is in `outcomes` -> settle the
 *    message with the recorded result, *without* re-running the runner. This
 *    is the short-circuit that makes a duplicate delivery an at-most-once
 *    effect commit.
 * 3. **Poisoned** — delivery count has reached `maxDeliveryCount` -> dead-letter
 *    `POISON_MESSAGE`. Checked *after* the idempotency short-circuit so a
 *    redelivery of an already-completed item is never mislabeled poison.
 * 4. **Run** — otherwise drive the orchestrator runner, record the outcome
 *    *before* settling (so a settle failure still short-circuits on
 *    redelivery), and complete. A thrown runner error abandons the message
 *    (redelivery, `deliveryCount` +1) so the poison path can eventually trip.
 */
export class WorkItemProcessor implements MessageProcessor {
  private readonly deps: WorkItemProcessorDeps;

  constructor(deps: WorkItemProcessorDeps) {
    this.deps = deps;
  }

  async process(message: QueueMessage): Promise<ProcessResult> {
    const item = parseWorkItem(message.body);
    if (!item) {
      await this.deps.queue.deadLetter(message, DEAD_LETTER_MALFORMED_ENVELOPE);
      return { status: 'dead_lettered', reason: DEAD_LETTER_MALFORMED_ENVELOPE };
    }

    const recorded = this.deps.outcomes.get(item.idempotency_key);
    if (recorded) {
      await this.deps.queue.complete(message);
      return { status: 'completed', result: recorded.result, shortCircuited: true };
    }

    const maxDeliveryCount = this.deps.maxDeliveryCount ?? 3;
    if (message.deliveryCount >= maxDeliveryCount) {
      await this.deps.queue.deadLetter(message, DEAD_LETTER_POISON_MESSAGE);
      return { status: 'dead_lettered', reason: DEAD_LETTER_POISON_MESSAGE };
    }

    let result: IngressResponse;
    try {
      result = await this.deps.runner.run(toRunnerRequest(item));
    } catch (err) {
      // Only a failed RUN abandons (redelivery, deliveryCount +1) so the
      // poison path can eventually trip. The try/catch deliberately wraps
      // `runner.run` alone: a settle failure below must propagate, not be
      // mislabeled 'abandoned', and the outcome is already recorded so a
      // redelivery still short-circuits (at-most-once).
      await this.deps.queue.abandon(message);
      return { status: 'abandoned', reason: err instanceof Error ? err.message : String(err) };
    }

    this.deps.outcomes.set(item.idempotency_key, {
      status: 'completed',
      result,
      completedAt: Date.now(),
    });
    await this.deps.queue.complete(message);
    return { status: 'completed', result, shortCircuited: false };
  }
}
