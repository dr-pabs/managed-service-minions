import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from 'framework-core';
import type { VerificationResult } from './verification.js';
import type { WorkItem } from './work-item.js';

/**
 * The escalation bridge emitter (Milestone 20): Stream's half of the seam that
 * joins it to Flow. When an item exceeds its retry, cost, or complexity
 * thresholds, the item pipeline hands this module the item and its attempt
 * history; it assembles an `escalation/v1` envelope, signs it under the bridge
 * scheme, and delivers it to Flow's intake endpoint. The signed resolution
 * envelope that comes back is verified before Stream closes the item and links
 * the audit trails under the shared correlation id.
 *
 * The signature is the bridge scheme from the `escalation/v1` contract — the
 * same HMAC-SHA256/base64url primitive as `identity/v1` tokens, but over
 * *sorted* canonical JSON (`canonicalJson`) rather than the token's pinned
 * claim insertion order. Both runtimes sign and verify envelopes with sorted
 * canonicalization, so the two halves are byte-identical.
 */

/** Why the item left the bounded pipeline (the `escalation/v1` `cause` enum). */
export type EscalationCause = 'retry_exceeded' | 'cost_cap' | 'complexity';

/** One Stream attempt on the item, ending in a `verification/v1` verdict. */
export interface AttemptRecord {
  attempt: number;
  at: number;
  verification: VerificationResult;
}

/** The `escalation/v1` envelope travelling Stream -> Flow. */
export interface EscalationEnvelope {
  item: WorkItem;
  history: AttemptRecord[];
  correlation_id: string;
  cause: EscalationCause;
  nonce: string;
  expiry: number;
  signature: string;
}

/** The resolution envelope travelling Flow -> Stream. */
export interface ResolutionEnvelope {
  correlation_id: string;
  item_ref?: string;
  run_id?: string;
  outcome: 'resolved' | 'unresolved';
  effects: string[];
  summary?: string;
  reason?: string;
  nonce?: string;
  expiry?: number;
  signature: string;
}

/** Fifteen minutes, the envelope TTL both runtimes mint (as in `identity/v1`). */
export const DEFAULT_TTL_MS = 15 * 60_000;

/**
 * The bridge signature for `unsigned` — every field of the envelope except
 * `signature` itself — as `base64url(HMAC-SHA256(canonicalJson(unsigned)))`.
 */
export function signEnvelope(unsigned: Record<string, unknown>, secret: string): string {
  return createHmac('sha256', secret).update(canonicalJson(unsigned)).digest('base64url');
}

/** Recompute an envelope's signature and compare it timing-safely. */
export function verifyEnvelopeSignature(
  envelope: unknown,
  secret: string
): { ok: boolean; reason: string } {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    return { ok: false, reason: 'malformed envelope: not a JSON object' };
  }
  const record = envelope as Record<string, unknown>;
  const signature = record.signature;
  if (typeof signature !== 'string' || signature.length === 0) {
    return { ok: false, reason: 'missing signature' };
  }
  const { signature: _signature, ...unsigned } = record;
  const expected = signEnvelope(unsigned, secret);
  const expectedBytes = Buffer.from(expected, 'base64url');
  const actualBytes = Buffer.from(signature, 'base64url');
  if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) {
    return { ok: false, reason: 'invalid signature' };
  }
  return { ok: true, reason: 'ok' };
}

export interface AssembleEscalationArgs {
  item: WorkItem;
  history: AttemptRecord[];
  cause: EscalationCause;
  secret: string;
  /** Replay protection: unique per envelope. Defaults to a fresh UUID. */
  nonce?: string;
  /** Epoch ms after which the envelope must not be acted on. Defaults to now + TTL. */
  expiry?: number;
  now?: () => number;
}

/**
 * Assemble and sign an `escalation/v1` envelope for the item. The envelope
 * carries the item, its full attempt history (each with its `verification/v1`
 * verdict), the shared correlation id, the cause, and a fresh nonce + expiry
 * for replay protection.
 */
export function assembleEscalationEnvelope(args: AssembleEscalationArgs): EscalationEnvelope {
  const now = args.now ?? Date.now;
  const expiry = args.expiry ?? now() + DEFAULT_TTL_MS;
  const nonce = args.nonce ?? randomUUID();
  const unsigned = {
    item: args.item,
    history: args.history,
    correlation_id: args.item.correlation_id,
    cause: args.cause,
    nonce,
    expiry,
  };
  return { ...unsigned, signature: signEnvelope(unsigned, args.secret) };
}

export type EscalationDeliveryResult =
  | { status: 'resolved'; resolution: ResolutionEnvelope }
  | { status: 'rejected'; reason: string };

/**
 * Deliver a signed escalation envelope to Flow's intake endpoint and verify
 * the resolution that comes back. A non-2xx response is a rejection with the
 * intake's reason; a returned resolution whose signature does not verify, or
 * whose correlation id does not match the escalation's, is refused so Stream
 * never closes an item on a forged or crossed-wire answer.
 */
export async function deliverEscalation(
  envelope: EscalationEnvelope,
  intakeUrl: string,
  secret: string,
  fetchImpl: typeof fetch = fetch
): Promise<EscalationDeliveryResult> {
  let response: Response;
  try {
    response = await fetchImpl(intakeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
  } catch (err) {
    return { status: 'rejected', reason: err instanceof Error ? err.message : String(err) };
  }

  if (!response.ok) {
    const text = await response.text();
    return { status: 'rejected', reason: `intake rejected the envelope (${response.status}): ${text}` };
  }

  let body: ResolutionEnvelope;
  try {
    body = (await response.json()) as ResolutionEnvelope;
  } catch {
    return { status: 'rejected', reason: 'intake returned a non-JSON resolution' };
  }

  const verified = verifyEnvelopeSignature(body, secret);
  if (!verified.ok) {
    return { status: 'rejected', reason: `resolution envelope failed verification: ${verified.reason}` };
  }
  if (body.correlation_id !== envelope.correlation_id) {
    return {
      status: 'rejected',
      reason: `resolution correlation id mismatch: expected ${envelope.correlation_id}, got ${body.correlation_id}`,
    };
  }
  return { status: 'resolved', resolution: body };
}
