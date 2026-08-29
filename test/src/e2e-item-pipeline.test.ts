import { describe, expect, it, jest } from '@jest/globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EffectGateway,
  RecordingConnector,
  createMemoryStore,
  makeEffectTypePolicy,
  type SessionStore,
  type VerificationView,
} from 'mcp-toolshed';
import type { GooseClient } from 'orchestrator';
import { loadPipeline } from 'queue-ingress/pipeline-config.js';
import { runItemPipeline, type CommitEffect, type ItemPipelineDeps } from 'queue-ingress/item-pipeline.js';
import type { WorkItem } from 'queue-ingress/work-item.js';

/**
 * Milestone 16 end-to-end test: a `refund_request` work item is driven through
 * the declarative pipeline (`recipes/item-pipelines.yaml` + prompts) end to end,
 * with the commit step wired to the REAL Milestone 14 `EffectGateway` and mock
 * connectors. The seeded system of record says the charge is $50; the act agent
 * first outputs $100, so the schema verifier passes but the reconcile verifier
 * flags a mismatch, the item retries with that feedback, the corrected $50
 * output passes, and the gateway commits exactly one effect to the recording
 * connector. Every verification result lands in the audit trail under the
 * item's correlation id.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const RECIPES = path.join(REPO_ROOT, 'recipes');
const SECRET = 'e2e-item-pipeline-signing-secret';
const NOW = 1_700_000_000_000;

const item: WorkItem = {
  item_type: 'refund_request',
  payload: { order_id: 'R-1', reason: 'duplicate charge' },
  idempotency_key: 'key-1',
  correlation_id: 'corr-1',
};

function makeGoose() {
  const runMinion = jest.fn(async (request: { minionType: string; feedback?: string[] }) => {
    if (request.minionType === 'refund_classifier') {
      return { raw: JSON.stringify({ order_id: 'R-1', reason: 'duplicate charge' }) };
    }
    if (request.minionType === 'refund_processor') {
      // First attempt claims $100; the feedback-driven retry corrects to $50.
      const corrected = (request.feedback?.length ?? 0) > 0;
      return { raw: JSON.stringify({ order_id: 'R-1', amount_usd: corrected ? 50 : 100, reason: 'duplicate charge' }) };
    }
    if (request.minionType === 'refund_judge') {
      return { raw: JSON.stringify({ passed: true }) };
    }
    throw new Error(`unexpected minion type '${request.minionType}'`);
  });
  return { runMinion, classifyIntent: jest.fn(async () => ({ raw: '' })) };
}

describe('e2e: refund_request item through the declarative pipeline and the Milestone 14 gateway', () => {
  it('schema passes, reconcile catches a seeded mismatch, the item retries, passes, and commits through the gateway', async () => {
    const store: SessionStore = createMemoryStore();
    const connector = new RecordingConnector('payments');
    const goose = makeGoose() as unknown as GooseClient;

    // A mock system-of-record connector: the charge is $50. The act agent's
    // first $100 output will mismatch it, and the retry's $50 will match.
    const reconcile = jest.fn<ItemPipelineDeps['reconcile']>(async () => ({ status: 'success', data: { amount_usd: 50 } }));

    // The gateway's evidence resolver is fed the actual composite result the
    // pipeline produced, so a commit is authorised by THIS run's verification,
    // not a pre-seeded stub.
    let evidenceView: VerificationView | null = null;
    const gateway = new EffectGateway({
      effectTypes: new Map([['payment.refund', makeEffectTypePolicy('payment.refund', 'compensatable', 'auto')]]),
      connectors: new Map([['payments', connector]]),
      signingSecret: SECRET,
      evidenceResolver: { resolve: (ref) => (evidenceView && evidenceView.ref === ref ? evidenceView : null) },
      now: () => NOW,
    });

    const commit: CommitEffect = async ({ draft, caller, compositeResult }) => {
      evidenceView = {
        ref: compositeResult.evidence_ref ?? draft.evidence[0] ?? '',
        verifier: compositeResult.verifier,
        passed: compositeResult.passed,
        metrics: compositeResult.metrics,
      };
      const drafted = await gateway.draftEffect(draft, caller);
      if (!drafted.drafted) {
        return { committed: false, refused: drafted.refused };
      }
      return gateway.commitEffect({ draft_ref: drafted.draftRef }, caller);
    };

    const { config, schemas, schemaMap } = loadPipeline(RECIPES, 'refund_request');
    const deps: ItemPipelineDeps = {
      goose,
      store,
      secret: SECRET,
      schemas,
      schemaMap,
      reconcile,
      commit,
      now: () => NOW,
      random: () => 0,
    };

    const outcome = await runItemPipeline(config, deps, item);

    // ASSERT: the item committed on its second attempt (first failed reconcile).
    expect(outcome.status).toBe('committed');
    expect(outcome.attempts).toBe(2);

    // ASSERT: the act agent ran twice, and the retry carried the reconcile
    // mismatch as feedback.
    const actCalls = jest.mocked(goose.runMinion).mock.calls.filter((call) => call[0].minionType === 'refund_processor');
    expect(actCalls).toHaveLength(2);
    expect(actCalls[1]?.[0].feedback).toEqual(expect.arrayContaining([expect.stringContaining('.mismatch')]));

    // ASSERT: reconcile read the resolved order_id both times.
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile.mock.calls[0]?.[0].params).toEqual({ order_id: 'R-1' });

    // ASSERT: the gateway committed exactly one effect, the corrected $50.
    expect(connector.executions).toHaveLength(1);
    expect(connector.executions[0].effectType).toBe('payment.refund');
    expect(connector.executions[0].payload).toEqual({ order_id: 'R-1', amount_usd: 50, reason: 'duplicate charge' });

    // ASSERT: every verification result landed in the audit trail under the
    // item's correlation id, and the seeded mismatch is observable there.
    const entries = store.listAuditEntries({ correlationId: 'corr-1' });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.serverAlias === 'verification')).toBe(true);

    const reconcileEntries = entries.filter((entry) => entry.toolName === 'reconcile');
    expect(reconcileEntries).toHaveLength(2);

    const findings = (params: unknown): Array<{ id: string }> =>
      ((params as { findings?: Array<{ id: string }> }).findings ?? []);
    expect(reconcileEntries[0].status).toBe('error');
    expect(findings(reconcileEntries[0].params).some((f) => f.id.endsWith('.mismatch'))).toBe(true);
    expect(reconcileEntries[1].status).toBe('success');
    expect(findings(reconcileEntries[1].params).some((f) => f.id.endsWith('.match'))).toBe(true);

    // ASSERT: the schema verifier passed on the first attempt (before reconcile
    // even ran), proving the failure that triggered the retry was reconcile-only.
    const schemaEntries = entries.filter((entry) => entry.toolName === 'schema');
    expect(schemaEntries).toHaveLength(2);
    expect(schemaEntries.every((entry) => entry.status === 'success')).toBe(true);
  });
});
