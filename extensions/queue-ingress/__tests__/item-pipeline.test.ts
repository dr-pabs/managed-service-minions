import { describe, expect, it, jest } from '@jest/globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchemas, type SessionStore } from 'framework-core';
import type { GooseClient } from 'orchestrator';
import { runItemPipeline, type ItemPipelineConfig, type ItemPipelineDeps } from '../src/item-pipeline.js';
import type { WorkItem } from '../src/work-item.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RECIPES = path.resolve(here, '..', '..', '..', 'recipes');

const schemas = loadSchemas(path.join(RECIPES, 'schemas'));
const schemaMap = new Map<string, string>([['refund_processor', 'refund-action-output.json']]);

const item: WorkItem = {
  item_type: 'refund_request',
  payload: { order_id: 'R-1', reason: 'duplicate charge' },
  idempotency_key: 'key-1',
  correlation_id: 'corr-1',
};

interface ScriptedTurn {
  output: unknown;
  retryOutput?: unknown;
}

function makeGoose(script: Record<string, ScriptedTurn>) {
  const counts = new Map<string, number>();
  const runMinion = jest.fn(async (request: { minionType: string; feedback?: string[] }) => {
    const index = counts.get(request.minionType) ?? 0;
    counts.set(request.minionType, index + 1);
    const turn = script[request.minionType];
    const output = index === 0 || turn.retryOutput === undefined ? turn.output : turn.retryOutput;
    return { raw: JSON.stringify(output) };
  });
  return { runMinion, classifyIntent: jest.fn() };
}

function rawGoose(rawByType: Record<string, string>) {
  const runMinion = jest.fn(async (request: { minionType: string }) => ({ raw: rawByType[request.minionType] }));
  return { runMinion, classifyIntent: jest.fn() };
}

function baseConfig(overrides: Partial<ItemPipelineConfig> = {}): ItemPipelineConfig {
  return {
    item_type: 'refund_request',
    max_attempts: 2,
    on_failure: 'dead_letter',
    classify: { agent: 'refund_classifier', system_prompt: 'classify prompt' },
    act: { agent: 'refund_processor', system_prompt: 'act prompt', output_schema: 'refund-action-output.json' },
    verify: {
      verifier: 'composite:refund_request',
      reconcile_checks: [
        {
          server_alias: 'payments',
          tool_name: 'payments_get_charge',
          params: { order_id: '$output.order_id' },
          assert: { read_field: 'amount_usd', output_field: 'amount_usd' },
        },
      ],
    },
    commit: { effect_type: 'payment.refund', target_system: 'payments', reversibility: 'compensatable' },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ItemPipelineDeps> = {}): ItemPipelineDeps {
  return {
    goose: { runMinion: jest.fn(), classifyIntent: jest.fn() } as unknown as GooseClient,
    store: { createAuditEntry: jest.fn(), listAuditEntries: jest.fn(() => []) } as unknown as SessionStore,
    secret: 'secret',
    schemas,
    schemaMap,
    reconcile: jest.fn().mockResolvedValue({ status: 'success', data: { amount_usd: 50 } }),
    commit: jest.fn().mockResolvedValue({ committed: true }),
    now: () => 1000,
    random: () => 0.5,
    ...overrides,
  };
}

describe('runItemPipeline (Milestone 16)', () => {
  it('classifies, acts, verifies, retries on a reconcile mismatch, then commits the corrected action', async () => {
    const goose = makeGoose({
      refund_classifier: { output: { order_id: 'R-1', reason: 'duplicate charge' } },
      refund_processor: {
        output: { order_id: 'R-1', amount_usd: 100, reason: 'duplicate charge' },
        retryOutput: { order_id: 'R-1', amount_usd: 50, reason: 'duplicate charge' },
      },
    });
    const commit = jest.fn().mockResolvedValue({ committed: true });
    const deps = makeDeps({ goose, commit });

    const outcome = await runItemPipeline(baseConfig(), deps, item);

    expect(outcome.status).toBe('committed');
    expect(outcome.attempts).toBe(2);

    const actCalls = goose.runMinion.mock.calls.filter((call) => call[0].minionType === 'refund_processor');
    expect(actCalls).toHaveLength(2);
    expect(actCalls[1][0].feedback).toEqual(expect.arrayContaining([expect.stringContaining('.mismatch')]));

    expect(commit).toHaveBeenCalledTimes(1);
    const commitArg = commit.mock.calls[0][0];
    expect(commitArg.draft.payload).toEqual({ order_id: 'R-1', amount_usd: 50, reason: 'duplicate charge' });
    expect(commitArg.draft.evidence).toEqual(['verify://corr-1/verify']);
    expect(commitArg.caller.agentId).toBe('refund_processor');
    expect(commitArg.caller.scopeId).toBe('key-1');
    expect(commitArg.caller.correlationId).toBe('corr-1');
    expect(commitArg.caller.identityToken).toEqual(expect.any(String));
  });

  it('writes every verification result to the audit trail under the correlation id', async () => {
    const goose = makeGoose({
      refund_classifier: { output: { order_id: 'R-1', reason: 'duplicate charge' } },
      refund_processor: {
        output: { order_id: 'R-1', amount_usd: 100, reason: 'duplicate charge' },
        retryOutput: { order_id: 'R-1', amount_usd: 50, reason: 'duplicate charge' },
      },
    });
    const store = { createAuditEntry: jest.fn(), listAuditEntries: jest.fn(() => []) } as unknown as SessionStore;
    const deps = makeDeps({ goose, store });

    await runItemPipeline(baseConfig(), deps, item);

    expect(store.createAuditEntry).toHaveBeenCalledTimes(6); // 2 attempts x (schema, reconcile, composite)
    const entries = store.createAuditEntry.mock.calls.map((call) => call[0]);
    expect(entries.every((entry) => entry.correlationId === 'corr-1')).toBe(true);
    expect(entries.every((entry) => entry.serverAlias === 'verification')).toBe(true);
    expect(entries.map((entry) => entry.toolName)).toEqual([
      'schema',
      'reconcile',
      'composite',
      'schema',
      'reconcile',
      'composite',
    ]);
    expect(entries.filter((entry) => entry.toolName === 'composite').map((entry) => entry.status)).toEqual([
      'error',
      'success',
    ]);
  });

  it('dead-letters after max_attempts when the chain never passes', async () => {
    const goose = makeGoose({
      refund_classifier: { output: { order_id: 'R-1', reason: 'duplicate charge' } },
      refund_processor: { output: { order_id: 'R-1', amount_usd: 100, reason: 'duplicate charge' } },
    });
    const commit = jest.fn();
    const outcome = await runItemPipeline(baseConfig(), makeDeps({ goose, commit }), item);

    expect(outcome.status).toBe('dead_lettered');
    expect(outcome.attempts).toBe(2);
    expect(commit).not.toHaveBeenCalled();
  });

  it('escalates when on_failure is escalate', async () => {
    const goose = makeGoose({
      refund_classifier: { output: { order_id: 'R-1', reason: 'duplicate charge' } },
      refund_processor: { output: { order_id: 'R-1', amount_usd: 100, reason: 'duplicate charge' } },
    });
    const outcome = await runItemPipeline(baseConfig({ on_failure: 'escalate' }), makeDeps({ goose }), item);

    expect(outcome.status).toBe('escalated');
  });

  it('escalates when the commit is refused', async () => {
    const goose = makeGoose({
      refund_classifier: { output: { order_id: 'R-1', reason: 'duplicate charge' } },
      refund_processor: { output: { order_id: 'R-1', amount_usd: 50, reason: 'duplicate charge' } },
    });
    const commit = jest.fn().mockResolvedValue({ committed: false, refused: 'no connector mounted' });
    const outcome = await runItemPipeline(baseConfig(), makeDeps({ goose, commit }), item);

    expect(outcome.status).toBe('escalated');
    expect(outcome.reason).toBe('no connector mounted');
  });

  it('bridges to Flow when on_failure is escalate and an emitter is wired', async () => {
    const goose = makeGoose({
      refund_classifier: { output: { order_id: 'R-1', reason: 'duplicate charge' } },
      refund_processor: { output: { order_id: 'R-1', amount_usd: 100, reason: 'duplicate charge' } },
    });
    const escalate = jest.fn(async () => ({
      resolution: {
        correlation_id: 'corr-1',
        run_id: 'run_1',
        outcome: 'resolved' as const,
        effects: [],
        summary: 'done',
        signature: 'sig',
      },
    }));
    const store = { createAuditEntry: jest.fn(), listAuditEntries: jest.fn(() => []) } as unknown as SessionStore;

    const outcome = await runItemPipeline(
      baseConfig({ on_failure: 'escalate' }),
      makeDeps({ goose, escalate, bridgeSecret: 'bridge-secret', store }),
      item
    );

    expect(outcome.status).toBe('bridged');
    expect(outcome.cause).toBe('retry_exceeded');
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate.mock.calls[0][0].correlation_id).toBe('corr-1');

    // The escalation was audited under the item's correlation id.
    const escalationAudit = store.createAuditEntry.mock.calls.map((call) => call[0]).filter(
      (entry) => entry.serverAlias === 'escalation'
    );
    expect(escalationAudit).toHaveLength(1);
    expect(escalationAudit[0].params).toEqual({ cause: 'retry_exceeded', run_id: 'run_1', outcome: 'resolved' });
  });

  it('bridges to Flow with cause complexity when the commit is refused', async () => {
    const goose = makeGoose({
      refund_classifier: { output: { order_id: 'R-1', reason: 'duplicate charge' } },
      refund_processor: { output: { order_id: 'R-1', amount_usd: 50, reason: 'duplicate charge' } },
    });
    const commit = jest.fn().mockResolvedValue({ committed: false, refused: 'no connector mounted' });
    // No `bridgeSecret` here exercises the identity-secret fallback, and the
    // unresolved outcome exercises the error audit status.
    const escalate = jest.fn(async () => ({
      resolution: {
        correlation_id: 'corr-1',
        run_id: 'run_2',
        outcome: 'unresolved' as const,
        effects: [],
        summary: 'still unresolved',
        reason: 'missing documents',
        signature: 'sig',
      },
    }));

    const outcome = await runItemPipeline(baseConfig(), makeDeps({ goose, commit, escalate }), item);

    expect(outcome.status).toBe('bridged');
    expect(outcome.cause).toBe('complexity');
    if (outcome.status !== 'bridged') return;
    expect(outcome.resolution.outcome).toBe('unresolved');
  });

  it('skips classification when no classify step is configured', async () => {
    const goose = makeGoose({
      refund_processor: { output: { order_id: 'R-1', amount_usd: 50, reason: 'duplicate charge' } },
    });
    const outcome = await runItemPipeline(baseConfig({ classify: undefined }), makeDeps({ goose }), item);

    expect(outcome.status).toBe('committed');
    expect(goose.runMinion.mock.calls.filter((call) => call[0].minionType === 'refund_classifier')).toHaveLength(0);
  });

  it('passes a string payload to the classifier verbatim', async () => {
    const goose = makeGoose({
      refund_classifier: { output: { order_id: 'R-1', reason: 'duplicate charge' } },
      refund_processor: { output: { order_id: 'R-1', amount_usd: 50, reason: 'duplicate charge' } },
    });
    await runItemPipeline(baseConfig(), makeDeps({ goose }), { ...item, payload: 'raw refund request' });

    const classifyCall = goose.runMinion.mock.calls.find((call) => call[0].minionType === 'refund_classifier');
    expect(classifyCall?.[0].userContent).toBe('raw refund request');
  });

  it('dead-letters when the act output is not valid JSON', async () => {
    const goose = rawGoose({
      refund_classifier: '{"order_id":"R-1"}',
      refund_processor: 'not valid json',
    });
    const outcome = await runItemPipeline(baseConfig(), makeDeps({ goose }), item);

    expect(outcome.status).toBe('dead_lettered');
  });

  it('runs the judge when sampled and includes its verdict in the chain', async () => {
    const goose = makeGoose({
      refund_classifier: { output: { order_id: 'R-1', reason: 'duplicate charge' } },
      refund_processor: { output: { order_id: 'R-1', amount_usd: 50, reason: 'duplicate charge' } },
      refund_judge: { output: { passed: true } },
    });
    const config = baseConfig({
      verify: {
        verifier: 'composite:refund_request',
        reconcile_checks: baseConfig().verify.reconcile_checks,
        judge: { agent: 'refund_judge', system_prompt: 'judge prompt', sample_percent: 100 },
      },
    });
    const store = { createAuditEntry: jest.fn(), listAuditEntries: jest.fn(() => []) } as unknown as SessionStore;
    const outcome = await runItemPipeline(config, makeDeps({ goose, store, random: () => 0 }), item);

    expect(outcome.status).toBe('committed');
    expect(outcome.results.map((r) => r.verifier)).toEqual([
      'schema:refund_processor',
      'reconcile:refund_request',
      'judge:refund_request',
      'composite:refund_request',
    ]);
  });

  it('dead-letters when the judge returns an invalid verdict', async () => {
    const goose = makeGoose({
      refund_classifier: { output: { order_id: 'R-1', reason: 'duplicate charge' } },
      refund_processor: { output: { order_id: 'R-1', amount_usd: 50, reason: 'duplicate charge' } },
      refund_judge: { output: { ok: true } },
    });
    const config = baseConfig({
      verify: {
        verifier: 'composite:refund_request',
        reconcile_checks: baseConfig().verify.reconcile_checks,
        judge: { agent: 'refund_judge', system_prompt: 'judge prompt', sample_percent: 100 },
      },
    });
    const outcome = await runItemPipeline(config, makeDeps({ goose, random: () => 0 }), item);

    expect(outcome.status).toBe('dead_lettered');
  });

  it('escalates when the act output is not a JSON object (array)', async () => {
    const goose = makeGoose({ refund_processor: { output: [1, 2] } });
    const config = baseConfig({
      classify: undefined,
      verify: { verifier: 'composite:refund_request', schema: false, reconcile_checks: [] },
    });
    const outcome = await runItemPipeline(config, makeDeps({ goose }), item);

    expect(outcome.status).toBe('escalated');
    expect(outcome.reason).toContain('not a JSON object');
  });

  it('escalates when the act output is null', async () => {
    const goose = makeGoose({ refund_processor: { output: null } });
    const config = baseConfig({
      classify: undefined,
      verify: { verifier: 'composite:refund_request', schema: false, reconcile_checks: [] },
    });
    const outcome = await runItemPipeline(config, makeDeps({ goose }), item);

    expect(outcome.status).toBe('escalated');
  });

  it('escalates when the act output is a primitive', async () => {
    const goose = makeGoose({ refund_processor: { output: 'hello' } });
    const config = baseConfig({
      classify: undefined,
      verify: { verifier: 'composite:refund_request', schema: false, reconcile_checks: [] },
    });
    const outcome = await runItemPipeline(config, makeDeps({ goose }), item);

    expect(outcome.status).toBe('escalated');
  });

  it('passes a judge verdict with findings through to the chain', async () => {
    const goose = makeGoose({
      refund_classifier: { output: { order_id: 'R-1', reason: 'duplicate charge' } },
      refund_processor: { output: { order_id: 'R-1', amount_usd: 50, reason: 'duplicate charge' } },
      refund_judge: {
        output: { passed: true, findings: [{ id: 'judge.ok', message: 'looks good', severity: 'info' }] },
      },
    });
    const config = baseConfig({
      verify: {
        verifier: 'composite:refund_request',
        reconcile_checks: baseConfig().verify.reconcile_checks,
        judge: { agent: 'refund_judge', system_prompt: 'judge prompt', sample_percent: 100 },
      },
    });
    const outcome = await runItemPipeline(config, makeDeps({ goose, random: () => 0 }), item);

    expect(outcome.status).toBe('committed');
    const judgeResult = outcome.results.find((r) => r.verifier === 'judge:refund_request');
    expect(judgeResult?.findings.some((f) => f.id === 'judge.ok')).toBe(true);
  });

  it('falls back to the payload when classification returns invalid JSON', async () => {
    const goose = {
      runMinion: jest.fn(async (request: { minionType: string }) => {
        if (request.minionType === 'refund_classifier') {
          return { raw: 'not json' };
        }
        return { raw: JSON.stringify({ order_id: 'R-1', amount_usd: 50, reason: 'duplicate charge' }) };
      }),
      classifyIntent: jest.fn(),
    };
    const outcome = await runItemPipeline(baseConfig(), makeDeps({ goose: goose as unknown as GooseClient }), item);

    expect(outcome.status).toBe('committed');
  });

  it('commits when no random is injected', async () => {
    const goose = makeGoose({
      refund_classifier: { output: { order_id: 'R-1', reason: 'duplicate charge' } },
      refund_processor: { output: { order_id: 'R-1', amount_usd: 50, reason: 'duplicate charge' } },
    });
    const outcome = await runItemPipeline(baseConfig(), makeDeps({ goose, random: undefined }), item);

    expect(outcome.status).toBe('committed');
  });

  it('uses Date.now when no clock is injected', async () => {
    const goose = makeGoose({
      refund_classifier: { output: { order_id: 'R-1', reason: 'duplicate charge' } },
      refund_processor: { output: { order_id: 'R-1', amount_usd: 50, reason: 'duplicate charge' } },
    });
    const outcome = await runItemPipeline(baseConfig(), makeDeps({ goose, now: undefined }), item);

    expect(outcome.status).toBe('committed');
  });

  it('defaults the escalation reason when a commit refusal has no message', async () => {
    const goose = makeGoose({
      refund_classifier: { output: { order_id: 'R-1', reason: 'duplicate charge' } },
      refund_processor: { output: { order_id: 'R-1', amount_usd: 50, reason: 'duplicate charge' } },
    });
    const commit = jest.fn().mockResolvedValue({ committed: false });
    const outcome = await runItemPipeline(baseConfig(), makeDeps({ goose, commit }), item);

    expect(outcome.status).toBe('escalated');
    expect(outcome.reason).toBe('commit refused');
  });
});
