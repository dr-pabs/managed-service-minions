import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionStore, SchemaCompileResult } from 'framework-core';
import type { GooseClient } from 'orchestrator';
import type { EscalationEnvelope, ResolutionEnvelope } from '../src/escalation.js';
import type { ItemPipelineConfig, PipelineOutcome } from '../src/item-pipeline.js';
import type { LoadedPipeline } from '../src/pipeline-config.js';
import {
  DEAD_LETTER_ESCALATION_UNARMED,
  DEAD_LETTER_ESCALATION_UNRESOLVED,
  buildEscalateEmitter,
  buildGatewayCommit,
  loadPipelines,
  PipelineVerificationResolver,
  PipelineWorkItemProcessor,
  resolvePipelinesDir,
  type PipelineEffectGateway,
  type PipelineProcessorDeps,
  type SharedPipelineDeps,
} from '../src/pipeline-processor.js';
import { DEAD_LETTER_POISON_MESSAGE, type MessageProcessor, type ProcessResult } from '../src/processor.js';
import type { QueueMessage, WorkItemQueue } from '../src/queue.js';
import { InMemoryIdempotencyStore } from '../src/idempotency-store.js';
import type { WorkItem } from '../src/work-item.js';
import type { VerificationResult } from '../src/verification.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RECIPES = path.resolve(here, '..', '..', '..', 'recipes');

const item: WorkItem = {
  item_type: 'refund_request',
  payload: { order_id: 'R-1', reason: 'duplicate charge' },
  idempotency_key: 'key-1',
  correlation_id: 'corr-1',
};

function message(body: unknown, deliveryCount = 1): QueueMessage {
  return { messageId: 'msg_1', body, deliveryCount };
}

function fakeQueue() {
  return {
    receive: jest.fn<WorkItemQueue['receive']>(),
    complete: jest.fn<WorkItemQueue['complete']>(async () => {}),
    abandon: jest.fn<WorkItemQueue['abandon']>(async () => {}),
    deadLetter: jest.fn<WorkItemQueue['deadLetter']>(async () => {}),
    close: jest.fn<WorkItemQueue['close']>(async () => {}),
  };
}

function fakeFallback(): MessageProcessor & { process: jest.Mock<MessageProcessor['process']> } {
  return {
    process: jest.fn<MessageProcessor['process']>(async () => ({
      status: 'completed',
      result: { text: 'fallback ran' },
      shortCircuited: false,
    })),
  };
}

const pipelineConfig: ItemPipelineConfig = {
  item_type: 'refund_request',
  max_attempts: 1,
  on_failure: 'dead_letter',
  act: { agent: 'refund_processor', system_prompt: 'act', output_schema: 'refund-action-output.json' },
  verify: { verifier: 'composite:refund_request' },
  commit: { effect_type: 'payment.refund', target_system: 'payments', reversibility: 'compensatable' },
};

function loadedPipeline(): LoadedPipeline {
  return {
    config: pipelineConfig,
    schemas: { schemas: new Map() } as unknown as SchemaCompileResult,
    schemaMap: new Map([['refund_processor', 'refund-action-output.json']]),
  };
}

function sharedDeps(): SharedPipelineDeps {
  return {
    goose: { runMinion: jest.fn(), classifyIntent: jest.fn() } as unknown as GooseClient,
    store: { createAuditEntry: jest.fn(), listAuditEntries: jest.fn(() => []) } as unknown as SessionStore,
    secret: 'unit-secret',
    reconcile: jest.fn(async () => ({ status: 'success', data: {} })),
    commit: jest.fn(async () => ({ committed: true })),
    now: () => 1_700_000_000_000,
  } as SharedPipelineDeps;
}

const compositeResult: VerificationResult = {
  passed: true,
  verifier: 'composite:refund_request',
  findings: [],
  metrics: { checks: 1 },
  cost_usd: 0,
  evidence_ref: 'verify://corr-1/verify',
};

function outcome(partial: Partial<PipelineOutcome> & { status: PipelineOutcome['status'] }): PipelineOutcome {
  return {
    correlationId: item.correlation_id,
    attempts: 1,
    results: [],
    ...partial,
  } as PipelineOutcome;
}

describe('resolvePipelinesDir', () => {
  it('falls back to the default recipes dir when PIPELINES_CONFIG_PATH is unset', () => {
    expect(resolvePipelinesDir(undefined, '/repo/recipes')).toBe('/repo/recipes');
    expect(resolvePipelinesDir('', '/repo/recipes')).toBe('/repo/recipes');
  });

  it('accepts a directory as-is', () => {
    expect(resolvePipelinesDir('/etc/minions/recipes', '/repo/recipes')).toBe('/etc/minions/recipes');
  });

  it('accepts the item-pipelines.yaml file itself and uses its directory', () => {
    expect(resolvePipelinesDir('/etc/minions/recipes/item-pipelines.yaml', '/repo/recipes')).toBe('/etc/minions/recipes');
    expect(resolvePipelinesDir('/etc/minions/recipes/item-pipelines.yml', '/repo/recipes')).toBe('/etc/minions/recipes');
  });
});

describe('loadPipelines', () => {
  let tmpDirs: string[] = [];

  function tmpRecipes(yamlContents?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-ingress-recipes-'));
    tmpDirs.push(dir);
    if (yamlContents !== undefined) {
      fs.writeFileSync(path.join(dir, 'item-pipelines.yaml'), yamlContents);
    }
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it('loads every pipeline from the real repo recipes', () => {
    const log = jest.fn();
    const pipelines = loadPipelines(RECIPES, log);
    expect(pipelines.has('refund_request')).toBe(true);
    expect(pipelines.get('refund_request')!.config.commit.effect_type).toBe('payment.refund');
    expect(log).not.toHaveBeenCalled();
  });

  it('logs once and returns no pipelines when item-pipelines.yaml is absent (safe to deploy with no recipes)', () => {
    const log = jest.fn();
    const pipelines = loadPipelines(tmpRecipes(), log);
    expect(pipelines.size).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no item-pipelines.yaml'));
  });

  it('logs and returns no pipelines when the file does not define an item_pipelines mapping', () => {
    const log = jest.fn();
    const pipelines = loadPipelines(tmpRecipes('item_pipelines: []\n'), log);
    expect(pipelines.size).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failed to read'));
  });

  it('skips a broken pipeline entry with a log, without taking down its siblings', () => {
    const log = jest.fn();
    const dir = tmpRecipes('item_pipelines:\n  broken:\n    max_attempts: 1\n');
    const pipelines = loadPipelines(dir, log);
    expect(pipelines.size).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("item pipeline 'broken' failed to load"));
  });

  it('defaults its logger to console.warn', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      loadPipelines(tmpRecipes());
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no item-pipelines.yaml'));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('buildEscalateEmitter', () => {
  const envelope = { correlation_id: 'corr-1' } as EscalationEnvelope;
  const resolution: ResolutionEnvelope = {
    correlation_id: 'corr-1',
    outcome: 'resolved',
    effects: [],
    signature: 'sig',
  };

  it('is unarmed (undefined) unless BOTH the intake URL and bridge secret are set', () => {
    expect(buildEscalateEmitter({})).toBeUndefined();
    expect(buildEscalateEmitter({ intakeUrl: 'http://forge/intake' })).toBeUndefined();
    expect(buildEscalateEmitter({ bridgeSecret: 'bridge' })).toBeUndefined();
  });

  it('delivers the envelope and returns the verified resolution when armed', async () => {
    const deliver = jest.fn(async () => ({ status: 'resolved' as const, resolution }));
    const emit = buildEscalateEmitter({ intakeUrl: 'http://forge/intake', bridgeSecret: 'bridge', deliver })!;
    await expect(emit(envelope)).resolves.toEqual({ resolution });
    expect(deliver).toHaveBeenCalledWith(envelope, 'http://forge/intake', 'bridge');
  });

  it('throws on a rejected delivery so the processor abandons for redelivery', async () => {
    const deliver = jest.fn(async () => ({ status: 'rejected' as const, reason: 'intake down' }));
    const emit = buildEscalateEmitter({ intakeUrl: 'http://forge/intake', bridgeSecret: 'bridge', deliver })!;
    await expect(emit(envelope)).rejects.toThrow('escalation delivery rejected by Flow intake: intake down');
  });
});

describe('PipelineVerificationResolver and buildGatewayCommit', () => {
  it('resolves only evidence it has seen', () => {
    const resolver = new PipelineVerificationResolver();
    expect(resolver.resolve('verify://corr-1/verify')).toBeNull();
    resolver.set({ ref: 'verify://corr-1/verify', verifier: 'composite:x', passed: true });
    expect(resolver.resolve('verify://corr-1/verify')).toEqual({
      ref: 'verify://corr-1/verify',
      verifier: 'composite:x',
      passed: true,
    });
  });

  function draft() {
    return {
      effect_type: 'payment.refund',
      target_system: 'payments',
      payload: { order_id: 'R-1' },
      evidence: ['verify://corr-1/verify'],
      reversibility: 'compensatable',
      idempotency_key: 'key-1',
      expiry: 1,
    };
  }

  const caller = { agentId: 'refund_processor', identityToken: 'tok', scopeId: 'key-1', correlationId: 'corr-1' };

  it("publishes THIS run's composite result, then drafts and commits through the gateway", async () => {
    const resolver = new PipelineVerificationResolver();
    const gateway: PipelineEffectGateway = {
      draftEffect: jest.fn<PipelineEffectGateway['draftEffect']>(async () => ({ drafted: true, draftRef: 'draft_1' })),
      commitEffect: jest.fn<PipelineEffectGateway['commitEffect']>(async () => ({ committed: true })),
    };
    const commit = buildGatewayCommit(gateway, resolver);

    const result = await commit({ draft: draft(), caller, compositeResult });

    expect(result).toEqual({ committed: true });
    expect(resolver.resolve('verify://corr-1/verify')).toEqual({
      ref: 'verify://corr-1/verify',
      verifier: 'composite:refund_request',
      passed: true,
      metrics: { checks: 1 },
    });
    expect(gateway.draftEffect).toHaveBeenCalledWith(expect.objectContaining({ effect_type: 'payment.refund' }), caller);
    expect(gateway.commitEffect).toHaveBeenCalledWith({ draft_ref: 'draft_1' }, caller);
  });

  it('keys the evidence off the draft when the composite carries no evidence_ref', async () => {
    const resolver = new PipelineVerificationResolver();
    const gateway: PipelineEffectGateway = {
      draftEffect: jest.fn<PipelineEffectGateway['draftEffect']>(async () => ({ drafted: true, draftRef: 'draft_1' })),
      commitEffect: jest.fn<PipelineEffectGateway['commitEffect']>(async () => ({ committed: true })),
    };
    const commit = buildGatewayCommit(gateway, resolver);
    const withoutRef = { ...compositeResult };
    delete withoutRef.evidence_ref;

    await commit({ draft: draft(), caller, compositeResult: withoutRef });

    expect(resolver.resolve('verify://corr-1/verify')).toEqual(expect.objectContaining({ passed: true }));
  });

  it('surfaces a refused draft as a refused commit (the pipeline then escalates), never a throw', async () => {
    const resolver = new PipelineVerificationResolver();
    const gateway: PipelineEffectGateway = {
      draftEffect: jest.fn<PipelineEffectGateway['draftEffect']>(async () => ({
        drafted: false,
        refused: "unknown effect type 'payment.refund'",
      })),
      commitEffect: jest.fn<PipelineEffectGateway['commitEffect']>(async () => ({ committed: true })),
    };
    const commit = buildGatewayCommit(gateway, resolver);

    const result = await commit({ draft: draft(), caller, compositeResult });

    expect(result).toEqual({ committed: false, refused: "unknown effect type 'payment.refund'" });
    expect(gateway.commitEffect).not.toHaveBeenCalled();
  });
});

describe('PipelineWorkItemProcessor', () => {
  type RunPipeline = NonNullable<PipelineProcessorDeps['runPipeline']>;

  function makeProcessor(overrides: {
    pipelines?: Map<string, LoadedPipeline>;
    outcome?: PipelineOutcome;
    runPipeline?: RunPipeline;
    log?: (msg: string) => void;
    maxDeliveryCount?: number;
    deps?: SharedPipelineDeps;
  }) {
    const queue = fakeQueue();
    const fallback = fakeFallback();
    const outcomes = new InMemoryIdempotencyStore();
    const runPipeline: RunPipeline =
      overrides.runPipeline ?? jest.fn(async () => overrides.outcome ?? outcome({ status: 'committed' }));
    const processor = new PipelineWorkItemProcessor({
      pipelines: overrides.pipelines ?? new Map([['refund_request', loadedPipeline()]]),
      deps: overrides.deps ?? sharedDeps(),
      fallback,
      queue,
      outcomes,
      ...(overrides.maxDeliveryCount !== undefined ? { maxDeliveryCount: overrides.maxDeliveryCount } : {}),
      runPipeline,
      ...(overrides.log ? { log: overrides.log } : {}),
    });
    return { processor, queue, fallback, outcomes, runPipeline };
  }

  it('hands a malformed envelope to the fallback (which owns MALFORMED_ENVELOPE)', async () => {
    const { processor, fallback, runPipeline } = makeProcessor({});
    const msg = message({ nope: true });
    await processor.process(msg);
    expect(fallback.process).toHaveBeenCalledWith(msg);
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('falls back for an item_type with no pipeline, logging once per item type', async () => {
    const log = jest.fn();
    const { processor, fallback, runPipeline } = makeProcessor({ log });
    const ticket = { ...item, item_type: 'ticket' };
    await processor.process(message(ticket));
    await processor.process(message({ ...ticket, idempotency_key: 'key-2' }));
    expect(fallback.process).toHaveBeenCalledTimes(2);
    expect(runPipeline).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no item pipeline for item_type 'ticket'"));
  });

  it('short-circuits a redelivered completed item without re-running the pipeline (at-most-once)', async () => {
    const { processor, queue, outcomes, runPipeline } = makeProcessor({});
    await outcomes.set(item.idempotency_key, { status: 'completed', result: { text: 'done' }, completedAt: 1 });
    const result = await processor.process(message(item));
    expect(result).toEqual({ status: 'completed', result: { text: 'done' }, shortCircuited: true });
    expect(queue.complete).toHaveBeenCalled();
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('dead-letters a poisoned item once its delivery count reaches the threshold', async () => {
    const { processor, queue, runPipeline } = makeProcessor({ maxDeliveryCount: 2 });
    const result = await processor.process(message(item, 2));
    expect(result).toEqual({ status: 'dead_lettered', reason: DEAD_LETTER_POISON_MESSAGE });
    expect(queue.deadLetter).toHaveBeenCalledWith(expect.anything(), DEAD_LETTER_POISON_MESSAGE);
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('defaults the poison threshold to 3 deliveries (mirrors WorkItemProcessor)', async () => {
    const { processor, queue } = makeProcessor({});
    const result = await processor.process(message(item, 3));
    expect(result).toEqual({ status: 'dead_lettered', reason: DEAD_LETTER_POISON_MESSAGE });
    expect(queue.deadLetter).toHaveBeenCalledWith(expect.anything(), DEAD_LETTER_POISON_MESSAGE);
  });

  it('completes a committed item, recording the outcome BEFORE settling', async () => {
    const { processor, queue, outcomes, runPipeline } = makeProcessor({
      outcome: outcome({ status: 'committed', attempts: 2 }),
    });
    const result = await processor.process(message(item));

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.shortCircuited).toBe(false);
    expect(result.result.text).toContain('committed via its item pipeline after 2 attempt(s)');
    await expect(outcomes.get(item.idempotency_key)).resolves.toEqual({
      status: 'completed',
      result: result.result,
      completedAt: 1_700_000_000_000,
    });
    expect(queue.complete).toHaveBeenCalled();
    expect(runPipeline).toHaveBeenCalledWith(
      pipelineConfig,
      expect.objectContaining({ secret: 'unit-secret', schemaMap: expect.any(Map) }),
      item
    );
  });

  it('stamps completedAt from the wall clock when no injectable clock is supplied', async () => {
    const deps = sharedDeps();
    delete (deps as { now?: () => number }).now;
    const before = Date.now();
    const { processor, outcomes } = makeProcessor({ deps, outcome: outcome({ status: 'committed' }) });
    await processor.process(message(item));
    await expect(outcomes.get(item.idempotency_key)).resolves.toMatchObject({ completedAt: expect.any(Number) });
    const recorded = await outcomes.get(item.idempotency_key);
    expect(recorded!.completedAt).toBeGreaterThanOrEqual(before);
  });

  it('completes a bridged item whose resolution is resolved', async () => {
    const { processor, queue } = makeProcessor({
      outcome: outcome({
        status: 'bridged',
        cause: 'retry_exceeded',
        resolution: { correlation_id: 'corr-1', outcome: 'resolved', effects: [], signature: 's', run_id: 'flow-1' },
      }),
    });
    const result = await processor.process(message(item));
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.result.text).toContain('escalated to Flow and resolved (run flow-1)');
    expect(queue.complete).toHaveBeenCalled();
  });

  it('describes a bridged resolution with no run id as unknown', async () => {
    const { processor } = makeProcessor({
      outcome: outcome({
        status: 'bridged',
        cause: 'retry_exceeded',
        resolution: { correlation_id: 'corr-1', outcome: 'resolved', effects: [], signature: 's' },
      }),
    });
    const result = (await processor.process(message(item))) as Extract<ProcessResult, { status: 'completed' }>;
    expect(result.result.text).toContain('(run unknown)');
  });

  it('dead-letters a bridged item whose resolution came back unresolved, with a log', async () => {
    const log = jest.fn();
    const { processor, queue, outcomes } = makeProcessor({
      log,
      outcome: outcome({
        status: 'bridged',
        cause: 'retry_exceeded',
        resolution: { correlation_id: 'corr-1', outcome: 'unresolved', effects: [], signature: 's' },
      }),
    });
    const result = await processor.process(message(item));
    expect(result).toEqual({ status: 'dead_lettered', reason: DEAD_LETTER_ESCALATION_UNRESOLVED });
    expect(queue.deadLetter).toHaveBeenCalledWith(expect.anything(), DEAD_LETTER_ESCALATION_UNRESOLVED);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unresolved'));
    await expect(outcomes.get(item.idempotency_key)).resolves.toBeUndefined();
  });

  it("dead-letters with the pipeline's own reason (e.g. BUDGET_EXCEEDED) on a dead_lettered outcome", async () => {
    const { processor, queue } = makeProcessor({
      outcome: outcome({ status: 'dead_lettered', reason: 'BUDGET_EXCEEDED' }),
    });
    const result = await processor.process(message(item));
    expect(result).toEqual({ status: 'dead_lettered', reason: 'BUDGET_EXCEEDED' });
    expect(queue.deadLetter).toHaveBeenCalledWith(expect.anything(), 'BUDGET_EXCEEDED');
  });

  it('dead-letters an escalated outcome as ESCALATION_UNARMED with a log when no emitter is armed — never throws', async () => {
    const log = jest.fn();
    const { processor, queue } = makeProcessor({
      log,
      outcome: outcome({ status: 'escalated', reason: 'verification failed after 1 attempt(s)' }),
    });
    const result = await processor.process(message(item));
    expect(result).toEqual({ status: 'dead_lettered', reason: DEAD_LETTER_ESCALATION_UNARMED });
    expect(queue.deadLetter).toHaveBeenCalledWith(expect.anything(), DEAD_LETTER_ESCALATION_UNARMED);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no bridge emitter armed'));
  });

  it('logs through console.warn by default', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { processor } = makeProcessor({
        outcome: outcome({ status: 'escalated', reason: 'nope' }),
      });
      await processor.process(message(item));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no bridge emitter armed'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('abandons the message for redelivery when the pipeline throws (poison path can then trip)', async () => {
    const { processor, queue } = makeProcessor({
      runPipeline: jest.fn(async () => {
        throw new Error('intake unreachable');
      }),
    });
    const result = await processor.process(message(item));
    expect(result).toEqual({ status: 'abandoned', reason: 'intake unreachable' });
    expect(queue.abandon).toHaveBeenCalled();
    expect(queue.deadLetter).not.toHaveBeenCalled();
  });

  it('stringifies a non-Error pipeline throw into the abandon reason', async () => {
    const { processor } = makeProcessor({
      runPipeline: jest.fn(async () => {
        throw 'boom';
      }),
    });
    const result = await processor.process(message(item));
    expect(result).toEqual({ status: 'abandoned', reason: 'boom' });
  });
});
