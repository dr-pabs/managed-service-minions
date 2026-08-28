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
}

/**
 * The consume loop (Milestone 15): drain the work queue one message at a time,
 * hand each to the `WorkItemProcessor`, and keep polling while empty. Runs
 * until the (optional) abort signal fires — it never exits on an empty queue,
 * since a queue consumer's job is to wait for the next item. Returns the total
 * number of messages settled. Signal handling that would abort it (SIGTERM)
 * is deliberately out of scope for this milestone and documented in the README.
 */
export async function consumeQueue(options: ConsumeQueueOptions): Promise<number> {
  const { queue, processor, signal, pollIntervalMs = 1000, onResult } = options;
  let processed = 0;
  for (;;) {
    if (signal?.aborted) {
      return processed;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
