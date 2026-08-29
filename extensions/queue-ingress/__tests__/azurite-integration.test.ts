import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TableClient } from '@azure/data-tables';
import { mintMinionToken } from 'framework-core';
import { EffectGateway, MapVerificationResolver, RecordingConnector, TableCommitRecordStore, effectTypesFromRecord } from 'mcp-toolshed';
import { TableIdempotencyStore } from '../src/table-idempotency-store.js';
import type { RecordedOutcome } from '../src/idempotency-store.js';

/**
 * Live-Azurite integration for the durable idempotency and commit-record
 * stores (remediation Milestones 4/5/11). The hermetic fakes prove the
 * 404/409 semantics; these tests prove the stores against the real table
 * service — including first-writer-wins under two concurrent clients and a
 * gateway commit replay across two separate gateway instances. Skips loudly
 * unless AZURITE_TABLES_CONNECTION_STRING is set:
 *
 *     npx azurite --tableHost 127.0.0.1   # or the docker-compose dev profile
 *     AZURITE_TABLES_CONNECTION_STRING='UseDevelopmentStorage=true' pnpm --filter queue-ingress test -- azurite
 */

const CONNECTION_STRING = process.env.AZURITE_TABLES_CONNECTION_STRING;
const describeAzurite = CONNECTION_STRING ? describe : describe.skip;

if (!CONNECTION_STRING) {
  console.warn(
    [
      '',
      '⚠️  azurite-integration.test.ts (queue-ingress): SKIPPING — AZURITE_TABLES_CONNECTION_STRING is not set.',
      '⚠️  Start the emulator (npx azurite, or the docker-compose dev profile) and set it to run these tests.',
      '',
    ].join('\n')
  );
}

const STAMP = `${Date.now()}${process.pid}`;
const IDEMPOTENCY_TABLE = `idemtest${STAMP}`;
const COMMITS_TABLE = `committest${STAMP}`;

const outcome: RecordedOutcome = {
  status: 'completed',
  result: { text: 'settled against live azurite' },
  completedAt: 1_700_000_000_000,
};

let idempotencyClient: TableClient;
let commitsClient: TableClient;

beforeAll(async () => {
  idempotencyClient = TableClient.fromConnectionString(CONNECTION_STRING!, IDEMPOTENCY_TABLE);
  await idempotencyClient.createTable();
  commitsClient = TableClient.fromConnectionString(CONNECTION_STRING!, COMMITS_TABLE);
  await commitsClient.createTable();
});

afterAll(async () => {
  await idempotencyClient.deleteTable();
  await commitsClient.deleteTable();
});

describeAzurite('durable stores against live Azurite', () => {
  it('TableIdempotencyStore round-trips and first-writer-wins across two clients', async () => {
    const winner = new TableIdempotencyStore(idempotencyClient);
    const loser = new TableIdempotencyStore(idempotencyClient);

    await expect(winner.get('live-key')).resolves.toBeUndefined();

    await Promise.all([
      winner.set('live-key', outcome),
      loser.set('live-key', { ...outcome, completedAt: 999 }),
    ]);

    const recorded = await loser.get('live-key');
    expect(recorded).toEqual(outcome); // the first writer's outcome stands
  });

  it('TableCommitRecordStore reports first-winner on a concurrent put', async () => {
    const a = new TableCommitRecordStore(commitsClient);
    const b = new TableCommitRecordStore(commitsClient);
    const record = {
      decision: {
        draft_ref: 'draft_live_1',
        decision: 'commit',
        draft: { effect_type: 'payment.refund', target_system: 'payments' },
      } as never,
      outcome: { refund_id: 're_live' },
      committedAt: 1_700_000_000_000,
    };

    const [aWon, bWon] = await Promise.all([a.put('live-key', record), b.put('live-key', record)]);
    expect(aWon !== bWon).toBe(true); // exactly one won
    const read = await b.get('live-key');
    expect(read?.outcome).toEqual({ refund_id: 're_live' });
  });
});

// ─── Gateway replay across two instances ──────────────────────────────────

const SECRET = 'azurite-bridge-secret';
const RUN_ID = 'run_azurite';
const CORR = 'corr_azurite';

function committer() {
  return {
    agentId: 'committer',
    identityToken: mintMinionToken({ agent_id: 'committer', scope_id: RUN_ID, correlation_id: CORR }, SECRET),
    scopeId: RUN_ID,
    correlationId: CORR,
  };
}

function makeGateway(commitStore?: TableCommitRecordStore) {
  const connector = new RecordingConnector('crm');
  const resolver = new MapVerificationResolver({
    'verify://ok': { ref: 'verify://ok', verifier: 'pytest', passed: true, failing: [] },
  });
  const gateway = new EffectGateway({
    effectTypes: effectTypesFromRecord({
      'crm.case_note.append': { reversibility: 'reversible', approval_class: 'auto' },
    }),
    connectors: new Map([['crm', connector]]),
    signingSecret: SECRET,
    evidenceResolver: resolver,
    ...(commitStore ? { commitRecordStore: commitStore } : {}),
  });
  return { gateway, connector };
}

function draftParams() {
  return {
    effect_type: 'crm.case_note.append',
    target_system: 'crm',
    payload: { case_id: '5001', note: 'azurite replay probe' },
    evidence: ['verify://ok'],
    reversibility: 'reversible',
    idempotency_key: 'fx_azurite_probe',
  };
}

describeAzurite('gateway commit replay survives a re-initialised gateway (live table)', () => {
  it('a second gateway instance replays without executing the connector', async () => {
    const first = makeGateway(new TableCommitRecordStore(commitsClient));
    const drafted = await first.gateway.draftEffect(draftParams(), committer());
    expect(drafted.drafted).toBe(true);
    const commit = await first.gateway.commitEffect({ draft_ref: drafted.draftRef! }, committer());
    expect(commit.committed).toBe(true);
    expect(first.connector.executions).toHaveLength(1);

    // A NEW process would re-initialise everything in-process; here the
    // fresh gateway stands in for it, sharing only the live commits table.
    const second = makeGateway(new TableCommitRecordStore(commitsClient));
    const redrafted = await second.gateway.draftEffect(draftParams(), committer());
    expect(redrafted.drafted).toBe(true);
    const replay = await second.gateway.commitEffect({ draft_ref: redrafted.draftRef! }, committer());
    expect(replay.committed).toBe(true);
    expect(replay.idempotentReplay).toBe(true);
    expect(second.connector.executions).toHaveLength(0);
    expect(replay.outcome).toEqual(commit.outcome);
  });
});
