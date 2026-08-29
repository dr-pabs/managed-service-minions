import type { SessionStore } from 'framework-core';
import type { DailyBudget } from './cost-control.js';
import type { QueueMessage, WorkItemQueue } from './queue.js';
import type { MessageProcessor, ProcessResult } from './processor.js';

export interface ConsumeQueueOptions {
  queue: WorkItemQueue;
  processor: MessageProcessor;
  /** Abort signal for graceful shutdown; the loop stops on the next iteration after it aborts. */
  signal?: AbortSignal;
  /** Poll interval (ms) when the queue is empty. Defaults to 1000. */
  pollIntervalMs?: number;
  /** Observation hook for tests/telemetry, invoked once per settled message. */
  onResult?: (result: ProcessResult) => void;
  /**
   * Optional daily throughput budget (Milestone 17, `budget/v1` `scope: "day"`).
   * When set and exhausted, the loop pauses `receive` — it never silently drops
   * work — and resumes automatically on the next accounting day. Each transition
   * into/out of exhaustion is audited via `store`.
   */
  dailyBudget?: DailyBudget;
  /** The audit trail the daily-budget transitions are written to (Milestone 17). */
  store?: SessionStore;
}

/**
 * The consume loop (Milestone 15): drain the work queue one message at a time,
 * hand each to the `WorkItemProcessor`, and keep polling while empty. Runs
 * until the (optional) abort signal fires — it never exits on an empty queue,
 * since a queue consumer's job is to wait for the next item. Returns the total
 * number of messages settled. Signal handling that would abort it (SIGTERM)
 * is deliberately out of scope for this milestone and documented in the README.
 *
 * Milestone 17 adds the daily-budget gate: before each `receive` the loop checks
 * `dailyBudget.isExhausted()`; while exhausted it sleeps instead of pulling the
 * next message (pausing consumption without dropping work), writes one audit
 * entry per transition into/out of exhaustion, and resumes the moment the
 * accounting day rolls over and the ledger resets.
 */
export async function consumeQueue(options: ConsumeQueueOptions): Promise<number> {
  const { queue, processor, signal, pollIntervalMs = 1000, onResult, dailyBudget, store } = options;
  let processed = 0;
  let budgetExhausted = false;
  for (;;) {
    if (signal?.aborted) {
      return processed;
    }
    if (dailyBudget) {
      const exhausted = dailyBudget.isExhausted();
      if (exhausted !== budgetExhausted) {
        budgetExhausted = exhausted;
        writeBudgetAudit(store, dailyBudget, exhausted ? 'exhausted' : 'resumed');
      }
      if (exhausted) {
        await sleep(pollIntervalMs);
        continue;
      }
    }
    const message: QueueMessage | undefined = await queue.receive();
    if (message === undefined) {
      await sleep(pollIntervalMs);
      continue;
    }
    const result = await processor.process(message);
    processed += 1;
    onResult?.(result);
  }
}

/**
 * Writes the `audit/v1` kind `budget` event for a daily-budget transition
 * (Milestone 17). One entry per transition — `exhausted` when the day's cap is
 * reached, `resumed` when the next accounting day resets the ledger — so the
 * audit trail shows exactly when consumption paused and why.
 */
function writeBudgetAudit(store: SessionStore | undefined, budget: DailyBudget, status: 'exhausted' | 'resumed'): void {
  if (!store) {
    return;
  }
  store.createAuditEntry({
    id: `budget_day_${budget.currentDayKey}_${status}`,
    timestamp: Date.now(),
    correlationId: '',
    minionType: 'queue-ingress',
    teamId: 'stream',
    serverAlias: 'budget',
    toolName: 'day_cap',
    params: { scope: 'day', policy: 'halt', max_cost_usd: budget.maxCostUsd, spent_usd: budget.spentUsd },
    status,
    latencyMs: 0,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
