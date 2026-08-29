/**
 * The typed work-item envelope (Milestone 15): one unit of Stream input read
 * off the work queue. Producers enqueue these; the queue-ingress parses them
 * and drives the same orchestrator runner the chat and webhook ingresses use.
 * The four fields are exactly the `WorkItem` shape named in
 * forge-ops.execplan.md Milestone 15 — `item_type`, `payload`,
 * `idempotency_key`, `correlation_id`.
 */
export interface WorkItem {
  item_type: string;
  payload: unknown;
  idempotency_key: string;
  correlation_id: string;
}

/**
 * Parses and validates a raw queue body into a `WorkItem`. Returns `undefined`
 * for anything that is not a well-formed envelope (a non-object body, a
 * missing required field, or a required field of the wrong type) so the
 * processor can dead-letter it as `MALFORMED_ENVELOPE` rather than crash on
 * it. `payload` is deliberately `unknown` — its shape is the item pipeline's
 * concern (Milestone 16), not the ingress's — so only its *presence* is
 * required here.
 */
export function parseWorkItem(raw: unknown): WorkItem | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.item_type !== 'string' || record.item_type.length === 0) {
    return undefined;
  }
  if (typeof record.idempotency_key !== 'string' || record.idempotency_key.length === 0) {
    return undefined;
  }
  if (typeof record.correlation_id !== 'string' || record.correlation_id.length === 0) {
    return undefined;
  }
  if (!('payload' in record)) {
    return undefined;
  }
  return {
    item_type: record.item_type,
    payload: record.payload,
    idempotency_key: record.idempotency_key,
    correlation_id: record.correlation_id,
  };
}
