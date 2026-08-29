import { describe, expect, it, jest } from '@jest/globals';
import {
  DEFAULT_TTL_MS,
  assembleEscalationEnvelope,
  deliverEscalation,
  signEnvelope,
  verifyEnvelopeSignature,
  type AttemptRecord,
  type EscalationEnvelope,
  type ResolutionEnvelope,
} from '../src/escalation.js';
import type { VerificationResult } from '../src/verification.js';
import type { WorkItem } from '../src/work-item.js';

const SECRET = 'bridge-secret';
const NOW = 1_800_000_000_000;

const item: WorkItem = {
  item_type: 'refund_request',
  payload: { order_id: 'R-1', amount_usd: 94 },
  idempotency_key: 'key-1',
  correlation_id: 'corr-1',
};

const failingVerification: VerificationResult = {
  passed: false,
  verifier: 'reconcile:stripe',
  findings: [{ id: 'amount.mismatch', message: 'mismatch', severity: 'error' }],
  metrics: { checks_run: 1 },
  cost_usd: 0,
};

const history: AttemptRecord[] = [{ attempt: 1, at: NOW, verification: failingVerification }];

function signedResolution(overrides: Partial<ResolutionEnvelope> = {}): ResolutionEnvelope {
  const unsigned = {
    correlation_id: 'corr-1',
    run_id: 'run_1',
    outcome: 'resolved' as const,
    effects: [],
    summary: 'done',
    nonce: 'res_1',
    expiry: NOW + 60_000,
    ...overrides,
  };
  const { signature: _sig, ...rest } = unsigned;
  return { ...rest, signature: signEnvelope(unsigned, SECRET) };
}

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => (typeof body === 'string' && body === 'NOT-JSON' ? Promise.reject(new Error('bad json')) : body),
  } as unknown as Response;
}

describe('signEnvelope / verifyEnvelopeSignature (bridge scheme)', () => {
  it('signs canonical sorted JSON so key order does not matter', () => {
    expect(signEnvelope({ b: 1, a: 2 }, 'k')).toBe(signEnvelope({ a: 2, b: 1 }, 'k'));
  });

  it('pins the canonical HMAC vector (drift against the contract)', () => {
    expect(signEnvelope({ b: 1, a: 2 }, 'k')).toBe('merlPgBmzuN6FkzWFwlI9XDq9X0oTbDJxJ72wwAgnwQ');
  });

  it('verifies a correctly signed envelope', () => {
    const envelope = assembleEscalationEnvelope({ item, history, cause: 'retry_exceeded', secret: SECRET, nonce: 'n1', expiry: NOW + 60_000 });
    expect(verifyEnvelopeSignature(envelope, SECRET)).toEqual({ ok: true, reason: 'ok' });
  });

  it('rejects a missing signature', () => {
    const { signature: _s, ...unsigned } = assembleEscalationEnvelope({
      item, history, cause: 'retry_exceeded', secret: SECRET, nonce: 'n1', expiry: NOW + 60_000,
    });
    expect(verifyEnvelopeSignature(unsigned, SECRET)).toEqual({ ok: false, reason: 'missing signature' });
  });

  it('rejects a tampered envelope', () => {
    const envelope = assembleEscalationEnvelope({ item, history, cause: 'retry_exceeded', secret: SECRET, nonce: 'n1', expiry: NOW + 60_000 });
    envelope.correlation_id = 'corr_forged';
    expect(verifyEnvelopeSignature(envelope, SECRET)).toEqual({ ok: false, reason: 'invalid signature' });
  });

  it('rejects a non-object envelope', () => {
    expect(verifyEnvelopeSignature([1, 2, 3], SECRET)).toEqual({ ok: false, reason: 'malformed envelope: not a JSON object' });
  });

  it('rejects a non-string signature field', () => {
    expect(verifyEnvelopeSignature({ signature: 123 }, SECRET)).toEqual({ ok: false, reason: 'missing signature' });
  });
});

describe('assembleEscalationEnvelope', () => {
  it('carries the item, history, correlation id, cause, and a verifying signature', () => {
    const envelope = assembleEscalationEnvelope({
      item, history, cause: 'retry_exceeded', secret: SECRET, nonce: 'esc_1', expiry: NOW + 60_000,
    });
    expect(envelope.item).toEqual(item);
    expect(envelope.history).toEqual(history);
    expect(envelope.correlation_id).toBe('corr-1');
    expect(envelope.cause).toBe('retry_exceeded');
    expect(envelope.nonce).toBe('esc_1');
    expect(envelope.expiry).toBe(NOW + 60_000);
    expect(verifyEnvelopeSignature(envelope, SECRET).ok).toBe(true);
  });

  it('defaults a fresh nonce and a now+TTL expiry when omitted', () => {
    const envelope = assembleEscalationEnvelope({ item, history, cause: 'cost_cap', secret: SECRET, now: () => NOW });
    expect(envelope.nonce.length).toBeGreaterThan(0);
    expect(envelope.expiry).toBe(NOW + DEFAULT_TTL_MS);
  });
});

describe('deliverEscalation', () => {
  const envelope: EscalationEnvelope = assembleEscalationEnvelope({
    item, history, cause: 'retry_exceeded', secret: SECRET, nonce: 'esc_1', expiry: NOW + 60_000,
  });

  it('returns the verified resolution on a 2xx response', async () => {
    const resolution = signedResolution();
    const fetchImpl = jest.fn(async () => fakeResponse(200, resolution)) as unknown as typeof fetch;
    const result = await deliverEscalation(envelope, 'http://forge/api/escalations', SECRET, fetchImpl);
    expect(result.status).toBe('resolved');
    expect((result as { resolution: ResolutionEnvelope }).resolution.correlation_id).toBe('corr-1');
  });

  it('rejects on a non-2xx intake response', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(400, { detail: 'invalid signature' })) as unknown as typeof fetch;
    const result = await deliverEscalation(envelope, 'http://forge/api/escalations', SECRET, fetchImpl);
    expect(result.status).toBe('rejected');
    expect((result as { reason: string }).reason).toContain('invalid signature');
  });

  it('rejects when the fetch itself throws', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    const result = await deliverEscalation(envelope, 'http://forge/api/escalations', SECRET, fetchImpl);
    expect(result.status).toBe('rejected');
    expect((result as { reason: string }).reason).toContain('connection refused');
  });

  it('rejects a non-Error fetch failure with its string form', async () => {
    const fetchImpl = jest.fn(async () => {
      throw 'connection reset';
    }) as unknown as typeof fetch;
    const result = await deliverEscalation(envelope, 'http://forge/api/escalations', SECRET, fetchImpl);
    expect(result.status).toBe('rejected');
    expect((result as { reason: string }).reason).toContain('connection reset');
  });

  it('defaults to the global fetch when no fetchImpl is supplied', async () => {
    const resolution = signedResolution();
    const original = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => fakeResponse(200, resolution)) as unknown as typeof fetch;
    try {
      const result = await deliverEscalation(envelope, 'http://forge/api/escalations', SECRET);
      expect(result.status).toBe('resolved');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('rejects a non-JSON resolution body', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(200, 'NOT-JSON')) as unknown as typeof fetch;
    const result = await deliverEscalation(envelope, 'http://forge/api/escalations', SECRET, fetchImpl);
    expect(result.status).toBe('rejected');
    expect((result as { reason: string }).reason).toContain('non-JSON');
  });

  it('rejects a resolution whose signature does not verify', async () => {
    const resolution = signedResolution();
    resolution.summary = 'tampered';
    const fetchImpl = jest.fn(async () => fakeResponse(200, resolution)) as unknown as typeof fetch;
    const result = await deliverEscalation(envelope, 'http://forge/api/escalations', SECRET, fetchImpl);
    expect(result.status).toBe('rejected');
    expect((result as { reason: string }).reason).toContain('failed verification');
  });

  it('rejects a resolution whose correlation id does not match', async () => {
    const resolution = signedResolution({ correlation_id: 'corr_other' });
    const fetchImpl = jest.fn(async () => fakeResponse(200, resolution)) as unknown as typeof fetch;
    const result = await deliverEscalation(envelope, 'http://forge/api/escalations', SECRET, fetchImpl);
    expect(result.status).toBe('rejected');
    expect((result as { reason: string }).reason).toContain('correlation id mismatch');
  });
});
