import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveContractsDir } from '../contracts-dir.js';
import { mintMinionToken, verifyMinionToken } from '../minion-token.js';
import type { MinionTokenClaims } from '../minion-token.js';

/**
 * Conformance test against the `identity/v1` cross-language test vectors in
 * the forge-contracts repository. `mintMinionToken` must reproduce every
 * accept vector byte-for-byte and `verifyMinionToken` must reject every
 * reject vector with its labeled reason.
 *
 * As of Milestone 13 of forge-ops.execplan.md, `MinionTokenPayload` carries the
 * contract claim names natively (`agent_id`, `scope_id`, `correlation_id`), so
 * this suite feeds the vector payloads straight through with no name-mapping.
 */

interface IdentityVectorPayload {
  agent_id: string;
  scope_id: string;
  correlation_id: string;
  exp: number;
}

interface IdentityVector {
  id: string;
  kind: 'accept' | 'reject';
  secret: string;
  payload: IdentityVectorPayload;
  token: string;
  now_ms: number;
  reject_reason?: string;
  tamper?: string;
}

const CONTRACTS_DIR = resolveContractsDir();
const VECTORS_PATH =
  CONTRACTS_DIR !== undefined ? join(CONTRACTS_DIR, 'vectors', 'identity', 'v1', 'vectors.json') : '';

const vectorsFileExists = CONTRACTS_DIR !== undefined && existsSync(VECTORS_PATH);
if (!vectorsFileExists) {
  console.warn(
    [
      '',
      '⚠️  ────────────────────────────────────────────────────────────────────────',
      '⚠️  identity-contract.test.ts: SKIPPING the identity/v1 conformance vectors.',
      `⚠️  No vectors file at: ${VECTORS_PATH}`,
      `⚠️  resolved contracts dir: ${CONTRACTS_DIR ?? 'none found (set FORGE_CONTRACTS_DIR or place forge-contracts as a workspace sibling)'}.`,
      '⚠️  Point it at a checkout of the forge-contracts repository to run this suite;',
      '⚠️  the token code is otherwise covered only by minion-token.test.ts.',
      '⚠️  ────────────────────────────────────────────────────────────────────────',
      '',
    ].join('\n')
  );
}

function loadVectors(): { accept: IdentityVector[]; reject: IdentityVector[] } {
  const doc = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as {
    contract?: string;
    vectors?: IdentityVector[];
  };
  if (doc.contract !== 'identity/v1' || !Array.isArray(doc.vectors) || doc.vectors.length === 0) {
    throw new Error(`unexpected vector file shape at ${VECTORS_PATH}`);
  }
  for (const v of doc.vectors) {
    if (v.kind !== 'accept' && v.kind !== 'reject') {
      throw new Error(`vector ${v.id}: kind must be "accept" or "reject"`);
    }
    if (v.kind === 'reject' && typeof v.reject_reason !== 'string') {
      throw new Error(`reject vector ${v.id}: missing reject_reason`);
    }
  }
  return {
    accept: doc.vectors.filter((v) => v.kind === 'accept'),
    reject: doc.vectors.filter((v) => v.kind === 'reject'),
  };
}

/** The contract claim names are now `MinionTokenPayload`'s own field names. */
function toTokenInput(payload: IdentityVectorPayload): MinionTokenClaims {
  return {
    agent_id: payload.agent_id,
    scope_id: payload.scope_id,
    correlation_id: payload.correlation_id,
  };
}

const describeVectors = vectorsFileExists ? describe : describe.skip;

describeVectors('identity/v1 contract vectors (forge-contracts)', () => {
  // `describe.skip` still executes this callback at collection time, so the
  // vectors must not be read (and `.each` must not see an empty table) when
  // the file is absent — substitute a placeholder vector that never runs.
  const placeholder: IdentityVector = {
    id: 'placeholder (vectors file not found)',
    kind: 'accept',
    secret: '',
    payload: { agent_id: '', scope_id: '', correlation_id: '', exp: 0 },
    token: '',
    now_ms: 0,
    reject_reason: 'placeholder',
  };
  const { accept, reject } = vectorsFileExists
    ? loadVectors()
    : { accept: [placeholder], reject: [placeholder] };

  afterEach(() => {
    jest.useRealTimers();
  });

  describe.each(accept.map((v) => [v.id, v] as const))('accept vector %s', (_id, vector) => {
    it('is reproduced byte-for-byte by mintMinionToken', () => {
      // Pin the clock to the vector's reference instant so the minted exp —
      // and therefore the whole token — is deterministic.
      jest.useFakeTimers();
      jest.setSystemTime(vector.now_ms);
      const minted = mintMinionToken(
        toTokenInput(vector.payload),
        vector.secret,
        vector.payload.exp - vector.now_ms
      );
      expect(minted).toBe(vector.token);
    });

    it('is accepted by verifyMinionToken with the claims round-tripping', () => {
      jest.useFakeTimers();
      jest.setSystemTime(vector.now_ms);
      const result = verifyMinionToken(vector.token, vector.secret);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.agent_id).toBe(vector.payload.agent_id);
        expect(result.payload.scope_id).toBe(vector.payload.scope_id);
        expect(result.payload.correlation_id).toBe(vector.payload.correlation_id);
        expect(result.payload.exp).toBe(vector.payload.exp);
      }
    });
  });

  describe.each(reject.map((v) => [v.id, v] as const))('reject vector %s', (_id, vector) => {
    it(`is rejected with reason "${vector.reject_reason}"`, () => {
      jest.useFakeTimers();
      jest.setSystemTime(vector.now_ms);
      const result = verifyMinionToken(vector.token, vector.secret);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(vector.reject_reason);
      }
    });
  });
});
