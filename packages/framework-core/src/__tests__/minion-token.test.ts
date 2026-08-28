import { createHmac } from 'node:crypto';
import { mintMinionToken, verifyMinionToken } from '../minion-token.js';

const SECRET = 'test-secret-do-not-use-in-prod';

describe('mintMinionToken / verifyMinionToken', () => {
  it('round-trips a minted token', () => {
    const token = mintMinionToken(
      { agent_id: 'code_reviewer', scope_id: 'item_1', correlation_id: 'corr_1' },
      SECRET
    );
    const result = verifyMinionToken(token, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.agent_id).toBe('code_reviewer');
      expect(result.payload.scope_id).toBe('item_1');
      expect(result.payload.correlation_id).toBe('corr_1');
      expect(typeof result.payload.exp).toBe('number');
    }
  });

  it('produces the pinned format: base64url(json).base64url(hmac)', () => {
    const token = mintMinionToken(
      { agent_id: 'code_reviewer', scope_id: 'item_1', correlation_id: 'corr_1' },
      SECRET
    );
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    const decoded = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    expect(decoded).toMatchObject({ agent_id: 'code_reviewer', scope_id: 'item_1', correlation_id: 'corr_1' });
    expect(typeof decoded.exp).toBe('number');
    // Claim order is pinned by the identity/v1 vectors.
    expect(Object.keys(decoded)).toEqual(['agent_id', 'scope_id', 'correlation_id', 'exp']);
  });

  it('rejects a legacy-named token now that the Milestone 13 shim is removed', () => {
    // The wire names minionType/sessionId/correlationId are pre-rename; the
    // Milestone 21 shim that once normalized them is gone, so a legacy payload
    // is now an incomplete canonical claim set and must be refused.
    const legacyPayloadB64 = Buffer.from(
      JSON.stringify({ minionType: 'code_reviewer', sessionId: 'sess_1', correlationId: 'corr_1', exp: 4102444800000 })
    ).toString('base64url');
    const sigB64 = createHmac('sha256', SECRET).update(legacyPayloadB64).digest('base64url');
    const result = verifyMinionToken(`${legacyPayloadB64}.${sigB64}`, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('missing required fields');
    }
  });

  it('rejects a token whose payload has been tampered with', () => {
    const token = mintMinionToken(
      { agent_id: 'code_reviewer', scope_id: 'item_1', correlation_id: 'corr_1' },
      SECRET
    );
    const [payloadB64, sigB64] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    payload.agent_id = 'security_auditor';
    const tamperedPayloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const tampered = `${tamperedPayloadB64}.${sigB64}`;

    const result = verifyMinionToken(tampered, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('invalid signature');
    }
  });

  it('rejects a token signed with the wrong secret', () => {
    const token = mintMinionToken(
      { agent_id: 'code_reviewer', scope_id: 'item_1', correlation_id: 'corr_1' },
      'wrong-secret'
    );
    const result = verifyMinionToken(token, SECRET);
    expect(result.ok).toBe(false);
  });

  it('rejects an expired token', () => {
    const token = mintMinionToken(
      { agent_id: 'code_reviewer', scope_id: 'item_1', correlation_id: 'corr_1' },
      SECRET,
      -1
    );
    const result = verifyMinionToken(token, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('expired');
    }
  });

  it('rejects garbage input with no separator', () => {
    const result = verifyMinionToken('not-a-token-at-all', SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('malformed');
    }
  });

  it('rejects garbage input with more than one separator', () => {
    const result = verifyMinionToken('a.b.c', SECRET);
    expect(result.ok).toBe(false);
  });

  it('rejects a token with an empty payload segment', () => {
    const result = verifyMinionToken('.somesignature', SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('malformed');
    }
  });

  it('rejects a token with an empty signature segment', () => {
    const result = verifyMinionToken('somepayload.', SECRET);
    expect(result.ok).toBe(false);
  });

  it('rejects a token whose payload is not valid JSON', () => {
    const badPayloadB64 = Buffer.from('not json').toString('base64url');
    const sigB64 = createHmac('sha256', SECRET).update(badPayloadB64).digest('base64url');
    const result = verifyMinionToken(`${badPayloadB64}.${sigB64}`, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('not valid JSON');
    }
  });

  it('rejects a token whose payload is missing required fields', () => {
    const payloadB64 = Buffer.from(JSON.stringify({ agent_id: 'x' })).toString('base64url');
    const sigB64 = createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
    const result = verifyMinionToken(`${payloadB64}.${sigB64}`, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('missing required fields');
    }
  });

  it('rejects a token whose payload has a valid exp but an incomplete claim set', () => {
    // exp is numeric (passes the exp guard) but the canonical claim triple is
    // incomplete, so it is still rejected.
    const payloadB64 = Buffer.from(JSON.stringify({ agent_id: 'x', exp: 4102444800000 })).toString('base64url');
    const sigB64 = createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
    const result = verifyMinionToken(`${payloadB64}.${sigB64}`, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('missing required fields');
    }
  });

  it('rejects a token whose payload is not an object', () => {
    const payloadB64 = Buffer.from(JSON.stringify('a string')).toString('base64url');
    const sigB64 = createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
    const result = verifyMinionToken(`${payloadB64}.${sigB64}`, SECRET);
    expect(result.ok).toBe(false);
  });

  it('uses a default TTL when none is provided', () => {
    const before = Date.now();
    const token = mintMinionToken(
      { agent_id: 'code_reviewer', scope_id: 'item_1', correlation_id: 'corr_1' },
      SECRET
    );
    const result = verifyMinionToken(token, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.exp).toBeGreaterThan(before);
      expect(result.payload.exp).toBeLessThanOrEqual(before + 15 * 60_000 + 5000);
    }
  });

  it('rejects when signature length differs from expected (different byte length)', () => {
    const token = mintMinionToken(
      { agent_id: 'code_reviewer', scope_id: 'item_1', correlation_id: 'corr_1' },
      SECRET
    );
    const [payloadB64] = token.split('.');
    const shortSig = Buffer.from('x').toString('base64url');
    const result = verifyMinionToken(`${payloadB64}.${shortSig}`, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid signature');
    }
  });
});
