import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Payload minted for a minion at delegation time and verified by the
 * toolshed on every `execute_tool` call. `exp` (epoch ms) is added by
 * `mintMinionToken`, not supplied by the caller.
 */
export interface MinionTokenPayload {
  minionType: string;
  sessionId: string;
  correlationId: string;
  exp: number;
}

export type MinionTokenInput = Omit<MinionTokenPayload, 'exp'>;

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
 */
export function mintMinionToken(payload: MinionTokenInput, secret: string, ttlMs: number = DEFAULT_TTL_MS): string {
  const fullPayload: MinionTokenPayload = { ...payload, exp: Date.now() + ttlMs };
  const payloadB64 = base64UrlEncode(JSON.stringify(fullPayload));
  const signatureB64 = sign(payloadB64, secret);
  return `${payloadB64}.${signatureB64}`;
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

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).minionType !== 'string' ||
    typeof (parsed as Record<string, unknown>).sessionId !== 'string' ||
    typeof (parsed as Record<string, unknown>).correlationId !== 'string' ||
    typeof (parsed as Record<string, unknown>).exp !== 'number'
  ) {
    return { ok: false, reason: 'malformed token: payload missing required fields' };
  }

  const payload = parsed as MinionTokenPayload;
  if (payload.exp <= Date.now()) {
    return { ok: false, reason: 'token expired' };
  }

  return { ok: true, payload };
}
