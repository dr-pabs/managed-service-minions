import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verified payload of a minion token — the `identity/v1` claim set. Minted at
 * delegation time and verified by the toolshed on every `execute_tool` call.
 * `exp` (epoch ms) is added by `mintMinionToken`, not supplied by the caller.
 *
 * `scope_id` binds the token to exactly one unit of work: a Stream work-item id
 * (or a Flow run id) — wherever a session id was bound before the rename, a
 * work-item id may be bound now.
 */
export interface MinionTokenPayload {
  agent_id: string;
  scope_id: string;
  correlation_id: string;
  exp: number;
}

/** The `identity/v1` claims a caller supplies to mint a token. */
export interface MinionTokenClaims {
  agent_id: string;
  scope_id: string;
  correlation_id: string;
}

export type VerifyMinionTokenResult =
  | { ok: true; payload: MinionTokenPayload }
  | { ok: false; reason: string };

const DEFAULT_TTL_MS = 15 * 60_000;

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

/**
 * Mints `base64url(json-with-exp).base64url(hmac256)` — not JWT. See the
 * ExecPlan Decision Log for why: one shared secret between two co-deployed
 * trusted processes needs no header/alg negotiation or library.
 *
 * The payload object is constructed in the pinned claim order
 * `agent_id, scope_id, correlation_id, exp`; the cross-language `identity/v1`
 * vectors depend on that exact order, since claim order is object-insertion
 * order (plain `JSON.stringify`, not `canonicalJson`).
 */
export function mintMinionToken(input: MinionTokenClaims, secret: string, ttlMs: number = DEFAULT_TTL_MS): string {
  const fullPayload: MinionTokenPayload = {
    agent_id: input.agent_id,
    scope_id: input.scope_id,
    correlation_id: input.correlation_id,
    exp: Date.now() + ttlMs,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(fullPayload));
  const signatureB64 = sign(payloadB64, secret);
  return `${payloadB64}.${signatureB64}`;
}

/**
 * Extracts a normalized `identity/v1` payload from a parsed token body,
 * accepting only the canonical claim names. Returns `null` when the claim set
 * is not complete (a non-object body, a non-numeric `exp`, or a missing or
 * ill-typed claim).
 */
function extractPayload(parsed: unknown): MinionTokenPayload | null {
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p.exp !== 'number') {
    return null;
  }
  if (
    typeof p.agent_id === 'string' &&
    typeof p.scope_id === 'string' &&
    typeof p.correlation_id === 'string'
  ) {
    return { agent_id: p.agent_id, scope_id: p.scope_id, correlation_id: p.correlation_id, exp: p.exp };
  }
  return null;
}

/**
 * Verifies a token minted by `mintMinionToken`. Signature comparison uses
 * `timingSafeEqual` (never `===`) to avoid a timing side-channel on the MAC.
 * Any structural problem (missing dot, bad base64, bad JSON, missing
 * fields), a forged/tampered signature, or an expired `exp` is a rejection
 * with a specific `reason` string — never a thrown exception.
 */
export function verifyMinionToken(token: string, secret: string): VerifyMinionTokenResult {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1 || dotIndex !== token.lastIndexOf('.')) {
    return { ok: false, reason: 'malformed token: expected exactly one "." separator' };
  }

  const payloadB64 = token.slice(0, dotIndex);
  const signatureB64 = token.slice(dotIndex + 1);
  if (!payloadB64 || !signatureB64) {
    return { ok: false, reason: 'malformed token: missing payload or signature segment' };
  }

  const expectedSignatureB64 = sign(payloadB64, secret);
  const expectedSignature = base64UrlDecode(expectedSignatureB64);
  const actualSignature = base64UrlDecode(signatureB64);
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    return { ok: false, reason: 'invalid signature' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed token: payload is not valid JSON' };
  }

  const payload = extractPayload(parsed);
  if (payload === null) {
    return { ok: false, reason: 'malformed token: payload missing required fields' };
  }

  if (payload.exp <= Date.now()) {
    return { ok: false, reason: 'token expired' };
  }

  return { ok: true, payload };
}
