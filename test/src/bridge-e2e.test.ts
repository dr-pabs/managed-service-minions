import { describe, expect, it, jest } from '@jest/globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStore, type SessionStore } from 'mcp-toolshed';
import type { GooseClient } from 'orchestrator';
import { loadPipeline } from 'queue-ingress/pipeline-config.js';
import { runItemPipeline, type CommitEffect, type ItemPipelineDeps } from 'queue-ingress/item-pipeline.js';
import { deliverEscalation } from 'queue-ingress/escalation.js';
import type { WorkItem } from 'queue-ingress/work-item.js';

/**
 * Milestone 20 end-to-end round trip: a `refund_request` work item whose
 * verification never passes is escalated out of Stream's bounded pipeline, the
 * signed `escalation/v1` envelope is delivered to Flow's live intake
 * (`FORGE_INTAKE_URL`), and the signed resolution that comes back closes the
 * item with a matching correlation id. Skipped when the intake URL / bridge
 * secret are absent (the full round trip is driven by
 * ``forge-contracts/scripts/bridge_e2e.sh``, which starts Forge's serve mode,
 * exports both, and runs this test).
 */

const intakeUrl = process.env.FORGE_INTAKE_URL;
const bridgeSecret = process.env.FORGE_BRIDGE_SECRET;
const configured = Boolean(intakeUrl && bridgeSecret);
const maybe = configured ? describe : describe.skip;

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const RECIPES = path.join(REPO_ROOT, 'recipes');
const SECRET = 'e2e-bridge-pipeline-signing-secret';

const item: WorkItem = {
  item_type: 'refund_request',
  payload: { order_id: 'R-1', reason: 'duplicate charge' },
  idempotency_key: 'key-1',
  correlation_id: 'corr-bridge-1',
};

function makeGoose() {
  const runMinion = jest.fn(async (request: { minionType: string }) => {
    if (request.minionType === 'refund_classifier') {
      return { raw: JSON.stringify({ order_id: 'R-1', reason: 'duplicate charge' }) };
    }
    if (request.minionType === 'refund_processor') {
      // Always claims $100, so the reconcile verifier (seeded $50) never passes:
      // the item exhausts its attempts and escalates out of the pipeline.
      return { raw: JSON.stringify({ order_id: 'R-1', amount_usd: 100, reason: 'duplicate charge' }) };
    }
    throw new Error(`unexpected minion type '${request.minionType}'`);
  });
  return { runMinion, classifyIntent: jest.fn(async () => ({ raw: '' })) };
}

maybe('e2e: escalation round trip through Flow intake', () => {
  it('escalates the item, Flow resolves it, and the correlation id matches end to end', async () => {
    const store: SessionStore = createMemoryStore();
    const goose = makeGoose() as unknown as GooseClient;

    // The system of record says the charge is $50; the act agent's $100 never
    // matches it, so the reconcile verifier fails every attempt.
    const reconcile = jest.fn(async () => ({ status: 'success', data: { amount_usd: 50 } }));

    // Never reached — the chain never passes, so the item escalates instead.
    const commit: CommitEffect = jest.fn(async () => ({ committed: false }));

    const escalate: ItemPipelineDeps['escalate'] = async (envelope) => {
      const result = await deliverEscalation(envelope, intakeUrl!, bridgeSecret!);
      if (result.status !== 'resolved') {
        throw new Error(`escalation rejected by intake: ${result.reason}`);
      }
      return { resolution: result.resolution };
    };

    const { config, schemas, schemaMap } = loadPipeline(RECIPES, 'refund_request');
    config.on_failure = 'escalate'; // this recipe dead-letters by default; the bridge test escalates

    const deps: ItemPipelineDeps = {
      goose,
      store,
      secret: SECRET,
      bridgeSecret: bridgeSecret!,
      schemas,
      schemaMap,
      reconcile,
      commit,
      escalate,
      // The escalation envelope's `expiry` is verified against Flow's real
      // wall clock in a separate process, so the pipeline clock must be the
      // real one here — a frozen Stream clock mints an envelope that has
      // already expired by the time Flow's intake reads it.
      now: () => Date.now(),
      random: () => 0,
    };

    const outcome = await runItemPipeline(config, deps, item);

    // ASSERT: the item closed by bridging to Flow, not by dead-lettering.
    expect(outcome.status).toBe('bridged');
    if (outcome.status !== 'bridged') return;

    // ASSERT: the retry-exceeded cause was carried, and the resolution Flow
    // signed echoes the escalation's correlation id — the two audit trails
    // join on this id end to end.
    expect(outcome.cause).toBe('retry_exceeded');
    expect(outcome.resolution.correlation_id).toBe(item.correlation_id);

    // ASSERT: the escalation was audited under the item's correlation id, with
    // the Flow run id the intake assigned.
    const escalationAudit = store.listAuditEntries({ correlationId: item.correlation_id }).filter(
      (entry) => entry.toolName === 'bridge'
    );
    expect(escalationAudit).toHaveLength(1);
    expect(escalationAudit[0].status).toBe('success');
  });
});
