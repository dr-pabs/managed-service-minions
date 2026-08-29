import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from '@jest/globals';
import { mintMinionToken, resolveContractsDir } from 'framework-core';
import { createMemoryStore } from '../store.js';
import { toDecisionRecord, toDraftDocument } from '../effect-store.js';
import {
  EffectGateway,
  MapVerificationResolver,
  RecordingConnector,
  effectTypesFromRecord,
} from '../effect-gateway.js';

/**
 * Remediation Milestone 6: consumer-side drift test for the `effects/v1`
 * contract. The gateway mirrored the schema by code comments only; this suite
 * validates every conformance fixture against the real schema with this
 * package's own ajv, and pins that documents MINTED by the gateway (a draft,
 * and a committed decision record) validate — with a mutation that must fail:
 * an agent actor on an irreversible commit, the contract's central invariant.
 *
 * One-registry rule (ADR-004): `effects/v1` `$ref`s `identity/v1` by absolute
 * `$id`, so the identity schema must be registered in the same ajv instance
 * before compiling effects.
 */

const CONTRACTS_DIR = resolveContractsDir();
const SCHEMAS_AVAILABLE =
  CONTRACTS_DIR !== undefined && existsSync(join(CONTRACTS_DIR, 'schemas', 'effects', 'v1', 'schema.json'));

if (!SCHEMAS_AVAILABLE) {
  console.warn(
    [
      '',
      '⚠️  contracts-drift.test.ts (mcp-toolshed): SKIPPING — no forge-contracts checkout.',
      `⚠️  resolved contracts dir: ${CONTRACTS_DIR ?? 'none'}.`,
      '⚠️  Set FORGE_CONTRACTS_DIR or place forge-contracts as a workspace sibling to run this suite.',
      '',
    ].join('\n')
  );
}

const describeDrift = SCHEMAS_AVAILABLE ? describe : describe.skip;

function loadSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(CONTRACTS_DIR!, 'schemas', name, 'v1', 'schema.json'), 'utf8'));
}

function fixtureFiles(kind: 'valid' | 'invalid'): string[] {
  const dir = join(CONTRACTS_DIR!, 'fixtures', 'effects', 'v1', kind);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
}

function makeEffectsValidator() {
  const ajv = new Ajv2020({ allErrors: true });
  // identity/v1 is $ref'd by absolute $id — one registry holds both.
  ajv.addSchema(loadSchema('identity') as object);
  return ajv.compile(loadSchema('effects'));
}

const SECRET = 'drift-secret';
const RUN_ID = 'run_drift';
const CORR = 'corr_drift';

function committer() {
  return {
    agentId: 'committer',
    identityToken: mintMinionToken({ agent_id: 'committer', scope_id: RUN_ID, correlation_id: CORR }, SECRET),
    scopeId: RUN_ID,
    correlationId: CORR,
  };
}

function makeGateway() {
  const clock = { value: 1_000_000 };
  const connector = new RecordingConnector('crm');
  const store = createMemoryEffectStore(() => clock.value);
  const resolver = new MapVerificationResolver({
    'verify://ok': { ref: 'verify://ok', verifier: 'pytest', passed: true, failing: [] },
  });
  const gateway = new EffectGateway({
    store,
    effectTypes: effectTypesFromRecord({
      'crm.case_note.append': { reversibility: 'reversible', approval_class: 'auto' },
    }),
    connectors: new Map([['crm', connector]]),
    approvalStore: createMemoryStore(() => clock.value),
    signingSecret: SECRET,
    evidenceResolver: resolver,
    now: () => clock.value,
  });
  return { gateway, store };
}

function draftParams(): Record<string, unknown> {
  return {
    effect_type: 'crm.case_note.append',
    target_system: 'crm',
    payload: { case_id: '5001', note: 'drift probe' },
    evidence: ['verify://ok'],
    reversibility: 'reversible',
    idempotency_key: 'fx_drift_probe',
  };
}

describeDrift('effects/v1 contract drift (forge-contracts)', () => {
  it('every valid fixture validates under this runtime\'s ajv', () => {
    const validate = makeEffectsValidator();
    for (const file of fixtureFiles('valid')) {
      const doc = JSON.parse(readFileSync(join(CONTRACTS_DIR!, 'fixtures', 'effects', 'v1', 'valid', file), 'utf8'));
      expect({ file, ok: validate(doc) }).toEqual({ file, ok: true });
    }
  });

  it('every invalid fixture is rejected', () => {
    const validate = makeEffectsValidator();
    for (const file of fixtureFiles('invalid')) {
      const doc = JSON.parse(readFileSync(join(CONTRACTS_DIR!, 'fixtures', 'effects', 'v1', 'invalid', file), 'utf8'));
      expect({ file, ok: validate(doc) }).toEqual({ file, ok: false });
    }
  });

  it('a draft and a committed decision minted by this gateway validate', async () => {
    const validate = makeEffectsValidator();
    const { gateway, store } = makeGateway();

    const drafted = await gateway.draftEffect(draftParams(), committer());
    if (!drafted.drafted || !drafted.draftRef) {
      throw new Error(`draft refused: ${drafted.refused}`);
    }
    const record = store.getDraft(drafted.draftRef.replace('draft://', ''));
    if (!record) {
      throw new Error('draft record missing');
    }
    const draftDoc = toDraftDocument(record);
    expect(validate(draftDoc)).toBe(true);

    const committed = await gateway.commitEffect({ draft_ref: drafted.draftRef }, committer());
    expect(committed.committed).toBe(true);
    // Re-read: the store hands out snapshots, and the decision record is the
    // post-commit view.
    const decided = store.getDraft(drafted.draftRef.replace('draft://', ''))!;
    expect(validate(toDecisionRecord(decided))).toBe(true);
  });

  it('mutation tripwire: an agent actor on an irreversible commit is rejected by the schema', async () => {
    const validate = makeEffectsValidator();
    const { gateway, store } = makeGateway();

    const drafted = await gateway.draftEffect(draftParams(), committer());
    await gateway.commitEffect({ draft_ref: drafted.draftRef! }, committer());
    const decided = store.getDraft(drafted.draftRef!.replace('draft://', ''))!;
    const decision = toDecisionRecord(decided) as unknown as {
      draft: { reversibility: string };
    };

    // The gateway itself refuses this combination; the CONTRACT must too —
    // that agreement is the drift this test pins.
    decision.draft.reversibility = 'irreversible';
    expect(validate(decision)).toBe(false);
  });
});
