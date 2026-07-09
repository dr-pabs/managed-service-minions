import { appendFile } from 'node:fs/promises';
import type { TableClient } from '@azure/data-tables';
import type { AuditEntry } from 'framework-core';

export type AuditLogger = (entry: AuditEntry) => void | Promise<void>;

export function createAzureTableAuditLogger(client: TableClient): AuditLogger {
  return async (entry: AuditEntry): Promise<void> => {
    await client.upsertEntity({
      partitionKey: entry.teamId,
      rowKey: entry.id,
      timestamp: entry.timestamp,
      correlationId: entry.correlationId,
      minionType: entry.minionType,
      teamId: entry.teamId,
      serverAlias: entry.serverAlias,
      toolName: entry.toolName,
      params: JSON.stringify(entry.params),
      status: entry.status,
      latencyMs: entry.latencyMs,
      error: entry.error,
      retryAfterSeconds: entry.retryAfterSeconds,
      approvalId: entry.approvalId,
    });
  };
}

const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
/** Exponential backoff: attempt 1 -> 100ms, attempt 2 -> 200ms (before the 3rd/final try). */
const DEFAULT_BACKOFF_MS = (attempt: number): number => 100 * 2 ** (attempt - 1);

/** Default sleep uses a real timer; every test injects a fake `sleep` instead (no real timers in tests). */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultAppendDlq(dlqPath: string, line: string): Promise<void> {
  await appendFile(dlqPath, line);
}

export interface RetryingAuditLoggerOptions {
  /** The underlying cloud logger to deliver to (e.g. `createAzureTableAuditLogger(...)`). */
  deliver: AuditLogger;
  /** Bounded in-memory queue size. Default 1,000 (ExecPlan Milestone 8). */
  maxQueueSize?: number;
  /** Attempts per entry before giving up and writing to the DLQ. Default 3. */
  maxAttempts?: number;
  /** Injectable backoff-delay function, keyed by 1-based attempt number just completed. */
  backoffMs?: (attempt: number) => number;
  /** Injectable sleep, so tests never wait on a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Local dead-letter JSONL path. Defaults to `TOOLSHED_AUDIT_DLQ_PATH`, then `./audit-dlq.jsonl`. */
  dlqPath?: string;
  /** Injectable DLQ append, so only the one dedicated temp-path test touches the real filesystem. */
  appendDlq?: (dlqPath: string, line: string) => Promise<void>;
}

/**
 * A bounded, in-memory, at-least-once-effort retry queue wrapping a cloud
 * audit logger (Milestone 8, M1). Replaces the old fire-and-forget
 * `Promise.resolve().then(auditLogger)` in `toolshed.ts`'s `emit()`.
 *
 * The LOCAL SQLite audit write (`store.createAuditEntry`) already happens
 * synchronously in `emit()`, before this logger is ever invoked, and remains
 * the source of truth regardless of what happens here — this queue exists
 * purely to make a best effort at also mirroring entries to the configured
 * cloud sink (e.g. Azure Table Storage) without blocking the tool-call
 * pipeline and without silently losing entries the cloud sink temporarily
 * rejects.
 *
 * Each entry gets up to `maxAttempts` delivery attempts with a backoff sleep
 * between attempts; if every attempt fails, the entry is appended as one
 * JSON line to a local dead-letter file (`dlqPath`) so an operator can
 * replay it later. A DLQ write failure (e.g. disk full, read-only
 * filesystem) is itself caught and logged, never thrown — losing the
 * best-effort cloud mirror and its own last-resort local backup must not
 * crash or otherwise affect the tool-call pipeline that already durably
 * committed the entry to SQLite.
 *
 * Overflow policy (queue bound): DROP-OLDEST. When a new entry arrives and
 * the number of entries currently queued-or-in-flight is already at
 * `maxQueueSize`, the oldest still-tracked entry is evicted (its retry
 * attempts stop; it is logged as dropped, not silently discarded) to make
 * room for the newest one. Drop-oldest was chosen over drop-new because a
 * sustained cloud-sink outage should not permanently wedge the queue on a
 * batch of entries from the start of the outage — newer entries are more
 * useful for live triage than the oldest ones once the bound is hit, and
 * the local SQLite store (the actual source of truth) already has every
 * entry regardless of what this best-effort mirror keeps or drops.
 */
export interface RetryingAuditLogger {
  (entry: AuditEntry): void;
  /** Resolved dlqPath (for tests/introspection). */
  dlqPath: string;
  /** Current number of entries tracked (queued + in-flight). */
  queueLength: () => number;
}

export function createRetryingAuditLogger(options: RetryingAuditLoggerOptions): RetryingAuditLogger {
  const {
    deliver,
    maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    backoffMs = DEFAULT_BACKOFF_MS,
    sleep = realSleep,
    appendDlq = defaultAppendDlq,
  } = options;
  const dlqPath = options.dlqPath ?? process.env.TOOLSHED_AUDIT_DLQ_PATH ?? './audit-dlq.jsonl';

  // Tracks entries currently queued or being retried, keyed by a per-call
  // sequence number (not `entry.id`, which is not guaranteed unique across
  // every caller) purely so drop-oldest can evict the earliest-inserted
  // tracked entry in insertion order.
  const inFlight = new Map<number, AuditEntry>();
  let sequence = 0;

  async function writeToDlq(entry: AuditEntry): Promise<void> {
    try {
      await appendDlq(dlqPath, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      // Failure-isolated: a DLQ write error must never crash the pipeline or
      // propagate out of this best-effort logger.
      console.error(
        `[audit] DLQ write failed for entry ${entry.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async function attemptDelivery(key: number, entry: AuditEntry): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await deliver(entry);
        inFlight.delete(key);
        return;
      } catch (err) {
        const isLastAttempt = attempt === maxAttempts;
        if (isLastAttempt) {
          console.error(
            `[audit] cloud logger failed after ${maxAttempts} attempts for entry ${entry.id}, writing to DLQ: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          inFlight.delete(key);
          await writeToDlq(entry);
          return;
        }
        await sleep(backoffMs(attempt));
      }
    }
  }

  function logger(entry: AuditEntry): void {
    if (inFlight.size >= maxQueueSize) {
      // `inFlight` is non-empty here (size >= maxQueueSize >= 1), so the
      // first key/value from insertion-order iteration always exists.
      const [oldestKey, dropped] = inFlight.entries().next().value as [number, AuditEntry];
      inFlight.delete(oldestKey);
      console.warn(
        `[audit] retry queue overflow (maxQueueSize=${maxQueueSize}): dropping oldest queued entry ${dropped.id} to admit a newer one`
      );
    }
    const key = sequence++;
    inFlight.set(key, entry);
    void attemptDelivery(key, entry);
  }

  logger.dlqPath = dlqPath;
  logger.queueLength = () => inFlight.size;
  return logger as RetryingAuditLogger;
}
