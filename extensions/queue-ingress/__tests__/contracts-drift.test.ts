import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from '@jest/globals';
import { resolveContractsDir } from 'framework-core';
import { assembleEscalationEnvelope } from '../src/escalation.js';
import { runVerificationChain, type VerifyConfig } from '../src/verification.js';
import type { WorkItem } from '../src/work-item.js';

/**
 * Remediation Milestone 6: consumer-side drift tests for the `verification/v1`
 * and `escalation/v1` contracts. Only `identity/v1` had a consumer-side
 * conformance suite before; these two contracts were mirrored by code comments
 * only. The suites validate every conformance fixture against the real schema
 * with this package's own ajv (proving the runtime can load the contract), and
 * pin that documents MINTED by this runtime's implementations validate — with
 * mutations that must fail, so drift trips here rather than in production.
 *
 * One-registry rule (ADR-004): `escalation/v1` `$ref`s `verification/v1` by
 * absolute `$id`, so the verification schema must be registered in the same
 * ajv instance before compiling escalation — a registry holding every
 * cross-referenced schema, exactly as forge-contracts' own pytest gate does.
 */

const CONTRACTS_DIR = resolveContractsDir();
const SCHEMAS_AVAILABLE =
  CONTRACTS_DIR !== undefined && existsSync(join(CONTRACTS_DIR, 'schemas', 'verification', 'v1', 'schema.json'));

if (!SCHEMAS_AVAILABLE) {
  console.warn(
    [
      '',
      '⚠️  contracts-drift.test.ts (queue-ingress): SKIPPING — no forge-contracts checkout.',
      `⚠️  resolved contracts dir: ${CONTRACTS_DIR ?? 'none'}.`,
      '⚠️  Set FORGE_CONTRACTS_DIR or place forge-contracts as a workspace sibling to run this suite.',
      '',
    ].join('\n')
  );
}

function loadSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(CONTRACTS_DIR!, 'schemas', name, 'v1', 'schema.json'), 'utf8'));
}

function fixtureFiles(name: string, kind: 'valid' | 'invalid'): string[] {
  const dir = join(CONTRACTS_DIR!, 'fixtures', name, 'v1', kind);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
}

function makeValidator(schemas: Record<string, unknown>, compile: string) {
  const ajv = new Ajv2020({ allErrors: true });
  // Register every REFERENCED schema (the one-registry rule); compile the
  // target itself — compiling a schema whose $id is also addSchema'd throws.
  for (const [name, schema] of Object.entries(schemas)) {
    if (name !== compile) {
      ajv.addSchema(schema as object);
    }
  }
  return ajv.compile(JSON.parse(JSON.stringify(schemas[compile])));
}

const describeDrift = SCHEMAS_AVAILABLE ? describe : describe.skip;

describeDrift('verification/v1 and escalation/v1 contract drift (forge-contracts)', () => {
  it('every valid verification fixture validates under this runtime\'s ajv', () => {
    const validate = makeValidator({ verification: loadSchema('verification') }, 'verification');
    for (const file of fixtureFiles('verification', 'valid')) {
      const doc = JSON.parse(readFileSync(join(CONTRACTS_DIR!, 'fixtures', 'verification', 'v1', 'valid', file), 'utf8'));
      expect({ file, ok: validate(doc) }).toEqual({ file, ok: true });
    }
  });

  it('every invalid verification fixture is rejected', () => {
    const validate = makeValidator({ verification: loadSchema('verification') }, 'verification');
    for (const file of fixtureFiles('verification', 'invalid')) {
      const doc = JSON.parse(readFileSync(join(CONTRACTS_DIR!, 'fixtures', 'verification', 'v1', 'invalid', file), 'utf8'));
      expect({ file, ok: validate(doc) }).toEqual({ file, ok: false });
    }
  });

  it('a verification chain result minted by this runtime validates', async () => {
    const validate = makeValidator({ verification: loadSchema('verification') }, 'verification');
    const config: VerifyConfig = {
      verifier: 'composite:drift_probe',
      // No output-schema for a drift probe — the reconcile result is the
      // chain under test (the schema step is the item pipeline's concern).
      schema: false,
      reconcile_checks: [
        {
          server_alias: 'payments',
          tool_name: 'payments_get_charge',
          params: { order_id: 'R-1' },
          assert: { read_field: 'amount_usd', output_field: 'amount_usd' },
        },
      ],
    };
    const chain = await runVerificationChain(config, {
      minionType: 'refund_processor',
      output: { order_id: 'R-1', amount_usd: 50 },
      schemaMap: new Map(),
      schemas: { validators: new Map() },
      minionToken: 'token',
      correlationId: 'corr-drift',
      attempt: 1,
      sessionId: 'sess-drift',
      reconcile: async () => ({ status: 'success', data: { amount_usd: 50 } }),
    });

    expect(chain.passed).toBe(true);
    expect(validate(chain.composite)).toBe(true);

    // Mutation tripwire: a finding severity outside the enum must fail.
    const mutated = JSON.parse(JSON.stringify(chain.composite)) as {
      findings: Array<{ severity: string }>;
      passed: boolean;
    };
    mutated.passed = false;
    mutated.findings = [
      { id: 'reconcile.mismatch', message: 'drift probe', severity: 'catastrophic', location: 'order:R-1' },
    ];
    expect(validate(mutated)).toBe(false);
  });

  it('every valid escalation fixture validates under the one-registry ajv', () => {
    // escalation/v1 $refs verification/v1 by absolute $id: both schemas must
    // live in one registry or compilation itself fails.
    const validate = makeValidator(
      { verification: loadSchema('verification'), escalation: loadSchema('escalation') },
      'escalation'
    );
    for (const file of fixtureFiles('escalation', 'valid')) {
      const doc = JSON.parse(readFileSync(join(CONTRACTS_DIR!, 'fixtures', 'escalation', 'v1', 'valid', file), 'utf8'));
      expect({ file, ok: validate(doc) }).toEqual({ file, ok: true });
    }
  });

  it('every invalid escalation fixture is rejected', () => {
    const validate = makeValidator(
      { verification: loadSchema('verification'), escalation: loadSchema('escalation') },
      'escalation'
    );
    for (const file of fixtureFiles('escalation', 'invalid')) {
      const doc = JSON.parse(readFileSync(join(CONTRACTS_DIR!, 'fixtures', 'escalation', 'v1', 'invalid', file), 'utf8'));
      expect({ file, ok: validate(doc) }).toEqual({ file, ok: false });
    }
  });

  it('an escalation envelope minted by this runtime validates', () => {
    const validate = makeValidator(
      { verification: loadSchema('verification'), escalation: loadSchema('escalation') },
      'escalation'
    );
    const item: WorkItem = {
      item_type: 'refund_request',
      payload: { order_id: 'R-1' },
      idempotency_key: 'key-drift',
      correlation_id: 'corr-drift',
    };
    const envelope = assembleEscalationEnvelope({
      item,
      history: [{ attempt: 1, at: 1000, verification: {
        passed: false,
        verifier: 'composite:drift_probe',
        findings: [{ id: 'reconcile.mismatch', message: 'amount mismatch', severity: 'error' }],
        metrics: { rules_checked: 1, rule_pass_rate: 0 },
        cost_usd: 0,
        evidence_ref: 'verify://corr-drift/verify',
      } }],
      cause: 'retry_exceeded',
      secret: 'bridge-secret',
      now: () => 1000,
    });

    expect(validate(envelope)).toBe(true);

    // Mutation tripwires: empty history violates minItems; a missing
    // signature violates the required set.
    const noHistory = JSON.parse(JSON.stringify(envelope));
    delete noHistory.history;
    expect(validate(noHistory)).toBe(false);
    const unsigned = JSON.parse(JSON.stringify(envelope));
    delete unsigned.signature;
    expect(validate(unsigned)).toBe(false);
  });
});
