import { describe, expect, it, jest } from '@jest/globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IngressRunner, SessionStore } from 'framework-core';
import type { GooseClient } from 'orchestrator';
import { consumeQueue } from '../src/consumer.js';
import { DEAD_LETTER_BUDGET_EXCEEDED } from '../src/cost-control.js';
import type { EffectDraft } from '../src/item-pipeline.js';
import { InMemoryIdempotencyStore } from '../src/idempotency-store.js';
import type { LoadedPipeline } from '../src/pipeline-config.js';
import {
  DEAD_LETTER_ESCALATION_UNARMED,
  buildEscalateEmitter,
  buildGatewayCommit,
  loadPipelines,
  PipelineVerificationResolver,
  PipelineWorkItemProcessor,
  resolvePipelinesDir,
  type PipelineEffectGateway,
  type SharedPipelineDeps,
} from '../src/pipeline-processor.js';
import { WorkItemProcessor, type MessageProcessor, type ProcessResult } from '../src/processor.js';
import { InMemoryWorkItemQueue } from '../src/queue.js';
import type { WorkItem } from '../src/work-item.js';

/**
 * Production-wiring tests (the ADR-030/031/033 gap closure): drive the EXACT
 * composition `src/index.ts` builds — real `loadPipelines` over the repo's
 * `recipes/`, real `PipelineWorkItemProcessor` with the `WorkItemProcessor`
 * fallback, the gateway commit seam, the escalation emitter seam, and the real
 * `consumeQueue` loop over the in-memory queue — end to end, with only the
 * process edges faked (the Goose HTTP client, the toolshed reconcile read, and
 * the Flow intake HTTP call), exactly the seams `index.ts` injects.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const RECIPES = resolvePipelinesDir(undefined, path.resolve(here, '..', '..', '..', 'recipes'));
const SECRET = 'production-wiring-secret';

function refundItem(key = 'key-1', correlation = 'corr-1'): WorkItem {
  return {
    item_type: 'refund_request',
    payload: { order_id: 'R-1', reason: 'duplicate charge' },
    idempotency_key: key,
    correlation_id: correlation,
  };
}

/** The Milestone 16 e2e goose script: act claims $100, corrects to $50 on feedback. */
function makeGoose(options: { neverCorrect?: boolean } = {}) {
  const runMinion = jest.fn(async (request: { minionType: string; feedback?: string[] }) => {
    if (request.minionType === 'refund_classifier') {
      return { raw: JSON.stringify({ order_id: 'R-1', reason: 'duplicate charge' }) };
    }
    if (request.minionType === 'refund_processor') {
      const corrected = !options.neverCorrect && (request.feedback?.length ?? 0) > 0;
      return { raw: JSON.stringify({ order_id: 'R-1', amount_usd: corrected ? 50 : 100, reason: 'duplicate charge' }) };
    }
    if (request.minionType === 'refund_judge') {
      return { raw: JSON.stringify({ passed: true }) };
    }
    throw new Error(`unexpected minion type '${request.minionType}'`);
  });
  return { runMinion, classifyIntent: jest.fn(async () => ({ raw: '' })) };
}

/** An in-memory effect gateway honouring the evidence-resolver contract (drafted, then committed only on passing evidence). */
function makeGateway(resolver: PipelineVerificationResolver) {
  const executions: EffectDraft[] = [];
  const drafts = new Map<string, EffectDraft>();
  let sequence = 0;
  const gateway: PipelineEffectGateway = {
    async draftEffect(draft, caller) {
      if (!caller.identityToken) {
        return { drafted: false, refused: 'no identity token' };
      }
      sequence += 1;
      const draftRef = `draft_${sequence}`;
      drafts.set(draftRef, draft);
      return { drafted: true, draftRef };
    },
    async commitEffect({ draft_ref }) {
      const draft = drafts.get(draft_ref)!;
      const view = resolver.resolve(draft.evidence[0] ?? '');
      if (!view?.passed) {
        return { committed: false, refused: 'no passing verification evidence' };
      }
      executions.push(draft);
      return { committed: true };
    },
  };
  return { gateway, executions };
}

interface WiringOptions {
  pipelines?: Map<string, LoadedPipeline>;
  goose?: ReturnType<typeof makeGoose>;
  pricePer1kTokensUsd?: number;
  escalate?: SharedPipelineDeps['escalate'];
  bridgeSecret?: string;
}

/** Composes the queue-ingress production stack exactly as `src/index.ts` wires it. */
function wireStack(options: WiringOptions = {}) {
  const queue = new InMemoryWorkItemQueue();
  const outcomes = new InMemoryIdempotencyStore();
  const store = { createAuditEntry: jest.fn(), listAuditEntries: jest.fn(() => []) } as unknown as SessionStore;
  const runner: IngressRunner = { run: jest.fn(async () => ({ text: 'runner ran' })) } as IngressRunner;
  const fallback = new WorkItemProcessor({ runner, queue, outcomes });

  const pipelines = options.pipelines ?? loadPipelines(RECIPES, () => {});
  const resolver = new PipelineVerificationResolver();
  const { gateway, executions } = makeGateway(resolver);
  const goose = options.goose ?? makeGoose();
  // The seeded system of record: the charge is $50 (mirrors the e2e).
  const reconcile = jest.fn(async () => ({ status: 'success', data: { amount_usd: 50 } }));
  const log = jest.fn();

  const processor: MessageProcessor = new PipelineWorkItemProcessor({
    pipelines,
    deps: {
      goose: goose as unknown as GooseClient,
      store,
      secret: SECRET,
      reconcile,
      commit: buildGatewayCommit(gateway, resolver),
      pricePer1kTokensUsd: options.pricePer1kTokensUsd ?? 0,
      random: () => 0,
      ...(options.escalate ? { escalate: options.escalate } : {}),
      ...(options.bridgeSecret ? { bridgeSecret: options.bridgeSecret } : {}),
    },
    fallback,
    queue,
    outcomes,
    log,
  });

  return { queue, outcomes, store, runner, processor, executions, goose, reconcile, log };
}

/** Runs the real consume loop until `count` messages settle, then aborts it. */
async function drain(queue: InMemoryWorkItemQueue, processor: MessageProcessor, count: number, store?: SessionStore) {
  const controller = new AbortController();
  const results: ProcessResult[] = [];
  const settled = await consumeQueue({
    queue,
    processor,
    signal: controller.signal,
    pollIntervalMs: 1,
    onResult: (result) => {
      results.push(result);
      if (results.length >= count) {
        controller.abort();
      }
    },
    ...(store ? { store } : {}),
  });
  return { results, settled };
}

describe('production wiring: pipeline-routed items through the index.ts composition', () => {
  it('drives a refund_request end to end through the pipeline and commits exactly one effect', async () => {
    const { queue, processor, executions, store, outcomes } = wireStack();
    queue.enqueue(refundItem());

    const { results } = await drain(queue, processor, 1);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('completed');
    if (results[0].status !== 'completed') return;
    expect(results[0].shortCircuited).toBe(false);
    expect(results[0].result.text).toContain('committed via its item pipeline after 2 attempt(s)');

    // Exactly one effect committed, the corrected $50 action.
    expect(executions).toHaveLength(1);
    expect(executions[0].effect_type).toBe('payment.refund');
    expect(executions[0].payload).toEqual({ order_id: 'R-1', amount_usd: 50, reason: 'duplicate charge' });

    // Verification results audited under the item's correlation id; nothing dead-lettered.
    const audited = (store.createAuditEntry as jest.Mock).mock.calls.map((call) => call[0] as { correlationId: string });
    expect(audited.length).toBeGreaterThan(0);
    expect(audited.every((entry) => entry.correlationId === 'corr-1')).toBe(true);
    expect(queue.deadLetters()).toHaveLength(0);

    // The outcome is recorded, so a redelivery of the same key short-circuits.
    await expect(outcomes.get('key-1')).resolves.toBeDefined();
    queue.enqueue(refundItem());
    const second = await drain(queue, processor, 1);
    expect(second.results[0]).toMatchObject({ status: 'completed', shortCircuited: true });
    expect(executions).toHaveLength(1); // still exactly one commit — at-most-once
  });

  it('falls back to the WorkItemProcessor -> orchestrator runner path when no recipe matches the item_type', async () => {
    const { queue, processor, runner, executions, log } = wireStack();
    queue.enqueue({ item_type: 'ticket', payload: { title: 'T-1' }, idempotency_key: 'key-t', correlation_id: 'corr-t' });

    const { results } = await drain(queue, processor, 1);

    expect(results[0]).toMatchObject({ status: 'completed', shortCircuited: false });
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({ correlationRoot: 'corr-t', sessionId: 'key-t' }));
    expect(executions).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no item pipeline for item_type 'ticket'"));
  });

  it("dead-letters an item that crosses its recipe max_cost_usd as BUDGET_EXCEEDED via the cost-control path — the item halts, never the queue", async () => {
    // $100 per 1k tokens prices the very first classify call far past the
    // recipe's max_cost_usd of 0.75, so the item halts before acting.
    const { queue, processor, executions, runner } = wireStack({ pricePer1kTokensUsd: 100 });
    queue.enqueue(refundItem('key-b', 'corr-b'));
    // The queue itself keeps consuming: a fallback item behind the halted one still completes.
    queue.enqueue({ item_type: 'ticket', payload: {}, idempotency_key: 'key-t2', correlation_id: 'corr-t2' });

    const { results } = await drain(queue, processor, 2);

    expect(results[0]).toEqual({ status: 'dead_lettered', reason: DEAD_LETTER_BUDGET_EXCEEDED });
    expect(queue.deadLetters()).toHaveLength(1);
    expect(queue.deadLetters()[0].reason).toBe(DEAD_LETTER_BUDGET_EXCEEDED);
    expect(executions).toHaveLength(0);
    expect(results[1].status).toBe('completed');
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it('dead-letters an escalating item as ESCALATION_UNARMED (with a log, never a throw) when the bridge env is unset', async () => {
    // The recipe dead-letters by default; flip it to escalate, and the act
    // agent never corrects, so verification never passes.
    const loaded = loadPipelines(RECIPES, () => {});
    const refund = loaded.get('refund_request')!;
    const pipelines = new Map([
      ['refund_request', { ...refund, config: { ...refund.config, on_failure: 'escalate' as const } }],
    ]);
    expect(buildEscalateEmitter({ intakeUrl: undefined, bridgeSecret: undefined })).toBeUndefined();
    const { queue, processor, executions, log } = wireStack({ pipelines, goose: makeGoose({ neverCorrect: true }) });
    queue.enqueue(refundItem('key-e', 'corr-e'));

    const { results } = await drain(queue, processor, 1);

    expect(results[0]).toEqual({ status: 'dead_lettered', reason: DEAD_LETTER_ESCALATION_UNARMED });
    expect(queue.deadLetters()).toHaveLength(1);
    expect(queue.deadLetters()[0].reason).toBe(DEAD_LETTER_ESCALATION_UNARMED);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no bridge emitter armed'));
    expect(executions).toHaveLength(0);
  });

  it('bridges an escalating item to Flow and completes it when the emitter is armed', async () => {
    const loaded = loadPipelines(RECIPES, () => {});
    const refund = loaded.get('refund_request')!;
    const pipelines = new Map([
      ['refund_request', { ...refund, config: { ...refund.config, on_failure: 'escalate' as const } }],
    ]);
    // The armed emitter, exactly as index.ts builds it — with the intake HTTP
    // delivery seam faked to return a resolved, correlation-matched resolution.
    const deliver = jest.fn(async (envelope: { correlation_id: string }) => ({
      status: 'resolved' as const,
      resolution: {
        correlation_id: envelope.correlation_id,
        run_id: 'flow-run-1',
        outcome: 'resolved' as const,
        effects: [],
        signature: 'sig',
      },
    }));
    const escalate = buildEscalateEmitter({
      intakeUrl: 'http://forge:8787/intake',
      bridgeSecret: 'bridge-secret',
      deliver: deliver as never,
    });
    const { queue, processor, store } = wireStack({
      pipelines,
      goose: makeGoose({ neverCorrect: true }),
      escalate,
      bridgeSecret: 'bridge-secret',
    });
    queue.enqueue(refundItem('key-f', 'corr-f'));

    const { results } = await drain(queue, processor, 1);

    expect(results[0].status).toBe('completed');
    if (results[0].status !== 'completed') return;
    expect(results[0].result.text).toContain('escalated to Flow and resolved (run flow-run-1)');
    expect(deliver).toHaveBeenCalledTimes(1);
    // The envelope was signed under the BRIDGE secret and carried the cause.
    const envelope = deliver.mock.calls[0][0] as { cause: string; signature: string; correlation_id: string };
    expect(envelope.cause).toBe('retry_exceeded');
    expect(envelope.correlation_id).toBe('corr-f');
    expect(envelope.signature).toBeTruthy();
    expect(queue.deadLetters()).toHaveLength(0);
    // The escalation was audited under the item's correlation id with the Flow run id.
    const bridgeAudits = (store.createAuditEntry as jest.Mock).mock.calls
      .map((call) => call[0] as { toolName: string; correlationId: string })
      .filter((entry) => entry.toolName === 'bridge');
    expect(bridgeAudits).toHaveLength(1);
    expect(bridgeAudits[0].correlationId).toBe('corr-f');
  });
});
