import { describe, expect, it, jest } from '@jest/globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchemas } from 'framework-core';
import {
  errorFindings,
  evidenceRef,
  runVerificationChain,
  schemaFindingId,
  type VerificationContext,
  type VerifyConfig,
} from '../src/verification.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RECIPES = path.resolve(here, '..', '..', '..', 'recipes');

const schemas = loadSchemas(path.join(RECIPES, 'schemas'));
const schemaMap = new Map<string, string>([['refund_processor', 'refund-action-output.json']]);

const VALID_OUTPUT = { order_id: 'R-1', amount_usd: 50, reason: 'duplicate charge' };

function baseConfig(overrides: Partial<VerifyConfig> = {}): VerifyConfig {
  return {
    verifier: 'composite:refund_request',
    reconcile_checks: [
      {
        server_alias: 'payments',
        tool_name: 'payments_get_charge',
        params: { order_id: '$output.order_id' },
        assert: { read_field: 'amount_usd', output_field: 'amount_usd' },
      },
    ],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    minionType: 'refund_processor',
    output: VALID_OUTPUT,
    schemaMap,
    schemas,
    minionToken: 'token',
    correlationId: 'corr-1',
    attempt: 1,
    sessionId: 'key-1',
    reconcile: jest.fn().mockResolvedValue({ status: 'success', data: { amount_usd: 50 } }),
    ...overrides,
  };
}

describe('evidenceRef', () => {
  it('addresses a verification result under its correlation id', () => {
    expect(evidenceRef('corr-9')).toBe('verify://corr-9/verify');
  });
});

describe('runVerificationChain (Milestone 16)', () => {
  it('passes when schema and reconcile both pass, and cites evidence on the composite', async () => {
    const result = await runVerificationChain(baseConfig(), makeCtx());
    expect(result.passed).toBe(true);
    expect(result.results.map((r) => r.verifier)).toEqual([
      'schema:refund_processor',
      'reconcile:refund_request',
      'composite:refund_request',
    ]);
    expect(result.composite.passed).toBe(true);
    expect(result.composite.evidence_ref).toBe('verify://corr-1/verify');
    expect(result.composite.metrics).toEqual({ verifiers_run: 2 });
  });

  it('fails the composite when the schema verifier rejects the output', async () => {
    const result = await runVerificationChain(
      baseConfig(),
      makeCtx({ output: { order_id: 'R-1' } }) // missing amount_usd + reason
    );
    expect(result.passed).toBe(false);
    const schema = result.results.find((r) => r.verifier.startsWith('schema:'));
    expect(schema?.passed).toBe(false);
    expect(schema?.findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it('flags a reconcile mismatch as an error finding and fails the composite', async () => {
    const result = await runVerificationChain(
      baseConfig(),
      makeCtx({ output: { order_id: 'R-1', amount_usd: 100, reason: 'x' } })
    );
    expect(result.passed).toBe(false);
    const reconcile = result.results.find((r) => r.verifier.startsWith('reconcile:'));
    expect(reconcile?.passed).toBe(false);
    expect(reconcile?.findings.some((f) => f.id.endsWith('.mismatch'))).toBe(true);
  });

  it('flags a failed reconcile read as read_failed', async () => {
    const result = await runVerificationChain(
      baseConfig(),
      makeCtx({ reconcile: jest.fn().mockResolvedValue({ status: 'error', error: 'boom' }) })
    );
    const reconcile = result.results.find((r) => r.verifier.startsWith('reconcile:'));
    expect(reconcile?.passed).toBe(false);
    expect(reconcile?.findings.some((f) => f.id.endsWith('.read_failed'))).toBe(true);
  });

  it('falls back to the status when a failed read has no error message', async () => {
    const result = await runVerificationChain(
      baseConfig(),
      makeCtx({ reconcile: jest.fn().mockResolvedValue({ status: 'timeout' }) })
    );
    const reconcile = result.results.find((r) => r.verifier.startsWith('reconcile:'));
    expect(reconcile?.passed).toBe(false);
    expect(reconcile?.findings[0].message).toContain('timeout');
  });

  it('skips the schema verifier when schema is false', async () => {
    const result = await runVerificationChain(
      baseConfig({ schema: false }),
      makeCtx()
    );
    expect(result.results.some((r) => r.verifier.startsWith('schema:'))).toBe(false);
    expect(result.passed).toBe(true);
  });

  it('omits reconcile when there are no reconcile checks', async () => {
    const result = await runVerificationChain(
      baseConfig({ reconcile_checks: [] }),
      makeCtx()
    );
    expect(result.results.some((r) => r.verifier.startsWith('reconcile:'))).toBe(false);
  });

  it('omits reconcile when reconcile_checks is undefined', async () => {
    const result = await runVerificationChain(
      baseConfig({ reconcile_checks: undefined }),
      makeCtx()
    );
    expect(result.results.some((r) => r.verifier.startsWith('reconcile:'))).toBe(false);
  });

  it('runs the judge when sampled and folds its verdict into the chain', async () => {
    const judge = jest.fn().mockResolvedValue({ passed: true });
    const result = await runVerificationChain(
      baseConfig({ judge: { agent: 'refund_judge', system_prompt: 'j', sample_percent: 100 } }),
      makeCtx({ judge, random: () => 0 })
    );
    expect(result.results.some((r) => r.verifier === 'judge:refund_request')).toBe(true);
    expect(result.passed).toBe(true);
    expect(judge).toHaveBeenCalledWith({ userContent: JSON.stringify({ action: VALID_OUTPUT }) });
  });

  it('fails the chain when a sampled judge rejects the output', async () => {
    const judge = jest.fn().mockResolvedValue({ passed: false, findings: [{ id: 'judge.amount', message: 'bad', severity: 'error' as const }] });
    const result = await runVerificationChain(
      baseConfig({ judge: { agent: 'refund_judge', system_prompt: 'j', sample_percent: 100 } }),
      makeCtx({ judge, random: () => 0 })
    );
    expect(result.passed).toBe(false);
    const judgeResult = result.results.find((r) => r.verifier === 'judge:refund_request');
    expect(judgeResult?.passed).toBe(false);
    expect(judgeResult?.findings.some((f) => f.id === 'judge.amount')).toBe(true);
  });

  it('defaults the finding when a judge rejects without findings', async () => {
    const judge = jest.fn().mockResolvedValue({ passed: false });
    const result = await runVerificationChain(
      baseConfig({ judge: { agent: 'refund_judge', system_prompt: 'j', sample_percent: 100 } }),
      makeCtx({ judge, random: () => 0 })
    );
    expect(result.passed).toBe(false);
    const judgeResult = result.results.find((r) => r.verifier === 'judge:refund_request');
    expect(judgeResult?.passed).toBe(false);
    expect(judgeResult?.findings.some((f) => f.id === 'judge.failed')).toBe(true);
  });

  it('samples the judge with Math.random when no random is injected', async () => {
    const judge = jest.fn().mockResolvedValue({ passed: true });
    const result = await runVerificationChain(
      baseConfig({ judge: { agent: 'refund_judge', system_prompt: 'j', sample_percent: 100 } }),
      makeCtx({ judge }) // no random: Math.random() < 1 is always true at 100%
    );
    expect(result.results.some((r) => r.verifier === 'judge:refund_request')).toBe(true);
    expect(judge).toHaveBeenCalled();
  });

  it('skips the judge entirely when the item is not sampled', async () => {
    const judge = jest.fn();
    const result = await runVerificationChain(
      baseConfig({ judge: { agent: 'refund_judge', system_prompt: 'j', sample_percent: 0 } }),
      makeCtx({ judge, random: () => 0 })
    );
    expect(result.results.some((r) => r.verifier.startsWith('judge:'))).toBe(false);
    expect(judge).not.toHaveBeenCalled();
  });

  it('resolves non-string and static reconcile params verbatim', async () => {
    const reconcile = jest.fn().mockResolvedValue({ status: 'success', data: { amount_usd: 50 } });
    const config = baseConfig({
      reconcile_checks: [
        {
          server_alias: 'payments',
          tool_name: 'payments_get_charge',
          params: { order_id: '$output.order_id', limit: 10, tag: 'refund' },
          assert: { read_field: 'amount_usd', output_field: 'amount_usd' },
        },
      ],
    });
    await runVerificationChain(config, makeCtx({ reconcile }));
    expect(reconcile).toHaveBeenCalledWith({
      serverAlias: 'payments',
      toolName: 'payments_get_charge',
      params: { order_id: 'R-1', limit: 10, tag: 'refund' },
    });
  });

  it('derives the item name from the composite verifier spec', async () => {
    const result = await runVerificationChain(
      baseConfig({ verifier: 'composite:refund_request' }),
      makeCtx()
    );
    expect(result.results.some((r) => r.verifier === 'reconcile:refund_request')).toBe(true);
  });

  it('uses a generic item name when the verifier spec has no colon', async () => {
    const result = await runVerificationChain(
      baseConfig({ verifier: 'refund_request' }),
      makeCtx()
    );
    expect(result.results.some((r) => r.verifier === 'reconcile:item')).toBe(true);
    expect(result.composite.verifier).toBe('refund_request');
  });
});

describe('schemaFindingId', () => {
  it('keys the id to the failing instance path', () => {
    expect(schemaFindingId('/amount_usd must be number')).toBe('schema.invalid:/amount_usd');
  });

  it('falls back to root when the error has no leading path token', () => {
    expect(schemaFindingId('invalid')).toBe('schema.invalid:root');
  });
});

describe('errorFindings', () => {
  it('returns only error-severity findings across the chain', () => {
    const findings = errorFindings([
      {
        passed: false,
        verifier: 'schema:x',
        findings: [
          { id: 'a', message: 'bad', severity: 'error' },
          { id: 'b', message: 'note', severity: 'info' },
        ],
        metrics: {},
        cost_usd: 0,
      },
      {
        passed: false,
        verifier: 'reconcile:x',
        findings: [{ id: 'c', message: 'warn', severity: 'warning' }],
        metrics: {},
        cost_usd: 0,
      },
    ]);
    expect(findings.map((f) => f.id)).toEqual(['a']);
  });
});
