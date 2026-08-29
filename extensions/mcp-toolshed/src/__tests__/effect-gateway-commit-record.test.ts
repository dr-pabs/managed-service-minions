import { describe, expect, it } from '@jest/globals';
import type { TableClient } from '@azure/data-tables';
import { mintMinionToken } from 'framework-core';
import { createMemoryStore } from '../store.js';
import { createMemoryEffectStore } from '../effect-store.js';
import {
  EffectGateway,
  MapVerificationResolver,
  RecordingConnector,
  effectTypesFromRecord,
} from '../effect-gateway.js';
import { TableCommitRecordStore, type CommitRecordStore } from '../commit-record-store.js';

/**
 * Remediation Milestone 5: the gateway's commit idempotency must survive the
 * process. With a durable `commitRecordStore` configured, a commit is
 * recorded before it is acknowledged, and a gateway re-initialised over the
 * same store (a restart, or another replica) replays the recorded outcome
 * without executing the connector again.
 */

const SECRET = 'test-signing-secret';
const RUN_ID = 'run_1';
const CORR = 'corr_5';

function mintToken(agentId: string): string {
  return mintMinionToken({ agent_id: agentId, scope_id: RUN_ID, correlation_id: CORR }, SECRET);
}

function committer() {
  return { agentId: 'committer', identityToken: mintToken('committer'), scopeId: RUN_ID, correlationId: CORR };
}

function draftParams(key = 'fx_run_1_casenote'): Record<string, unknown> {
  return {
    effect_type: 'crm.case_note.append',
    target_system: 'crm',
    payload: { case_id: '5001', note: 'refund issued' },
    evidence: ['verify://ok'],
    reversibility: 'reversible',
    idempotency_key: key,
  };
}

function createFakeTable() {
  const rows = new Map<string, Record<string, unknown>>();
  const key = (p: string, r: string) => `${p} ${r}`;
  const err = (statusCode: number) => {
    const e = new Error(`HTTP ${statusCode}`) as Error & { statusCode: number };
    e.statusCode = statusCode;
    return e;
  };
  const client = {
    async getEntity(partitionKey: string, rowKey: string) {
      const row = rows.get(key(partitionKey, rowKey));
      if (!row) throw err(404);
      return { ...row, partitionKey, rowKey };
    },
    async createEntity(entity: Record<string, unknown>) {
      const { partitionKey, rowKey } = entity as Record<string, unknown> & { partitionKey: string; rowKey: string };
      if (rows.has(key(partitionKey, rowKey))) throw err(409);
      rows.set(key(partitionKey, rowKey), entity);
      return;
    },
  } as unknown as TableClient;
  return { client, rows };
}

/** A fresh gateway over its own in-process state, sharing the given durable store. */
function makeGateway(commitRecordStore?: CommitRecordStore): {
  gateway: EffectGateway;
  connector: RecordingConnector;
} {
  const clock = { value: 1_000_000 };
  const connector = new RecordingConnector('crm');
  const resolver = new MapVerificationResolver({
    'verify://ok': { ref: 'verify://ok', verifier: 'pytest', passed: true, failing: [] },
  });
  const gateway = new EffectGateway({
    effectTypes: effectTypesFromRecord({
      'crm.case_note.append': { reversibility: 'reversible', approval_class: 'auto' },
    }),
    connectors: new Map([['crm', connector]]),
    credentials: undefined,
    approvalStore: createMemoryStore(() => clock.value),
    signingSecret: SECRET,
    evidenceResolver: resolver,
    ...(commitRecordStore ? { commitRecordStore } : {}),
    now: () => clock.value,
  });
  return { gateway, connector };
}

async function draftAndCommit(gateway: EffectGateway, key = 'fx_run_1_casenote') {
  const drafted = await gateway.draftEffect(draftParams(key), committer());
  if (!drafted.drafted || !drafted.draftRef) {
    throw new Error(`draft refused: ${drafted.refused}`);
  }
  return gateway.commitEffect({ draft_ref: drafted.draftRef }, committer());
}

describe('EffectGateway durable commit records (remediation Milestone 5)', () => {
  it('records the commit durably before acknowledging it', async () => {
    const table = createFakeTable();
    const { gateway, connector } = makeGateway(new TableCommitRecordStore(table.client));

    const result = await draftAndCommit(gateway);

    expect(result.committed).toBe(true);
    expect(result.idempotentReplay).toBeFalsy();
    expect(connector.executions).toHaveLength(1);
    expect([...table.rows.keys()]).toEqual(['commits fx_run_1_casenote']);
  });

  it('a re-initialised gateway replays the recorded outcome without executing the connector', async () => {
    const table = createFakeTable();
    const first = makeGateway(new TableCommitRecordStore(table.client));
    const original = await draftAndCommit(first.gateway);
    expect(first.connector.executions).toHaveLength(1);

    // A new process: fresh in-process draft store, SAME durable commit store.
    const second = makeGateway(new TableCommitRecordStore(table.client));
    const replay = await draftAndCommit(second.gateway);

    expect(replay.committed).toBe(true);
    expect(replay.idempotentReplay).toBe(true);
    expect(second.connector.executions).toHaveLength(0);
    expect(replay.decision).toEqual(original.decision);
    expect(replay.outcome).toEqual(original.outcome);
  });

  it('loses the put race to another replica and returns the winner outcome as a replay', async () => {
    const table = createFakeTable();
    const winner = makeGateway(new TableCommitRecordStore(table.client));
    const original = await draftAndCommit(winner.gateway);
    const winnerRecord = {
      decision: original.decision,
      outcome: original.outcome as Record<string, unknown>,
      committedAt: 1_000_000,
    };

    // The genuine race window: the pre-gating lookup misses (the winner's
    // record lands between the loser's check and its put), the loser's put
    // hits the 409, and the re-read adopts the winner's outcome.
    let getCalls = 0;
    const racingStore: CommitRecordStore = {
      get: async () => {
        getCalls += 1;
        return getCalls === 1 ? undefined : winnerRecord;
      },
      put: async () => false,
    };
    const loser = makeGateway(racingStore);
    const result = await draftAndCommit(loser.gateway, 'fx_run_1_casenote');

    expect(result.committed).toBe(true);
    expect(result.idempotentReplay).toBe(true);
    expect(result.outcome).toEqual(original.outcome);
    // The loser did execute locally (the race was lost after dispatch); the
    // recorded winner outcome is what the caller sees.
    expect(loser.connector.executions).toHaveLength(1);
  });

  it('without a store, behaviour is exactly as before (in-process only)', async () => {
    const a = makeGateway();
    const b = makeGateway();
    await draftAndCommit(a.gateway);
    const result = await draftAndCommit(b.gateway);
    // No durable record: the second process has no memory of the first.
    expect(result.committed).toBe(true);
    expect(result.idempotentReplay).toBeFalsy();
    expect(b.connector.executions).toHaveLength(1);
  });
});
