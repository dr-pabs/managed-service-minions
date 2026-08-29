import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TableClient } from '@azure/data-tables';
import { buildToolshedState, createSqliteStore, initializeToolshed, verifyAndExecuteTool, EffectGateway, makeEffectTypePolicy, TableCommitRecordStore, type CommitRecordStore, type EffectTypePolicy } from 'mcp-toolshed';
import { createOrchestratorRunner, createHttpGooseClient } from 'orchestrator';
import { consumeQueue } from './consumer.js';
import { DailyBudget } from './cost-control.js';
import { InMemoryIdempotencyStore, type IdempotencyStore } from './idempotency-store.js';
import { TableIdempotencyStore } from './table-idempotency-store.js';
import {
  assertPriced,
  buildEscalateEmitter,
  buildGatewayCommit,
  loadPipelines,
  PipelineVerificationResolver,
  PipelineWorkItemProcessor,
  resolvePipelinesDir,
  type SharedPipelineDeps,
} from './pipeline-processor.js';
import { WorkItemProcessor, type MessageProcessor } from './processor.js';
import { InMemoryWorkItemQueue, type WorkItemQueue } from './queue.js';
import { ServiceBusWorkItemQueue } from './service-bus-queue.js';

/**
 * Production wiring for the queue-ingress consumer (Milestones 15-20) -- mirrors
 * `extensions/webhook-ingress/src/index.ts`: build a real in-process toolshed
 * via `mcp-toolshed`'s own `buildToolshedState()`, wire the real orchestrator
 * runner against it, then drain the work queue. The queue is a Service Bus
 * consumer when `SERVICE_BUS_CONNECTION_STRING` is set, otherwise an in-memory
 * queue (local dev / tests) -- the same dual-backend shape `mcp-toolshed`'s
 * `store.ts` uses, so the package runs with zero cloud dependency.
 *
 * Work items are routed by `item_type` (ADR-030 wiring): an item whose type
 * has a pipeline in `recipes/item-pipelines.yaml` runs the bounded
 * classify->act->verify->commit/escalate engine — with per-item cost caps
 * (ADR-031, `BUDGET_EXCEEDED` dead-letter) and the escalation bridge emitter
 * armed when `FORGE_INTAKE_URL` + `FORGE_BRIDGE_SECRET` are set (ADR-033) —
 * while every other item takes the original `WorkItemProcessor` ->
 * orchestrator runner path. No recipes present means no behaviour change.
 */
const config = {
  connectionString: process.env.SERVICE_BUS_CONNECTION_STRING ?? '',
  queueName: process.env.SERVICE_BUS_QUEUE_NAME ?? 'minion-tasks',
  sqlitePath: process.env.SQLITE_PATH ?? ':memory:',
  gooseUrl: process.env.GOOSE_SERVE_URL ?? process.env.GOOSE_BASE_URL ?? 'http://localhost:3284',
  signingSecret: process.env.TOOLSHED_SIGNING_SECRET ?? '',
};

/** Repo-relative default recipes dir (src/ or dist/ -> queue-ingress -> extensions -> repo root), the same path the tests use. */
function defaultRecipesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'recipes');
}

async function buildQueue(): Promise<WorkItemQueue> {
  if (!config.connectionString) {
    console.warn(
      '[queue-ingress] SERVICE_BUS_CONNECTION_STRING is not set -- using the in-memory work queue (local dev / tests). Set it to consume real Stream work items.'
    );
    return new InMemoryWorkItemQueue();
  }
  return ServiceBusWorkItemQueue.connect(config.connectionString, config.queueName);
}

/**
 * Builds the optional daily throughput budget from `DAILY_BUDGET_MAX_COST_USD`
 * (budget/v1 `scope: "day"`, `policy: "halt"`). Absent, non-numeric, or
 * non-positive input means no daily cap — the queue consumes unbounded.
 */
function buildDailyBudget(raw: string | undefined): DailyBudget | undefined {
  const maxCostUsd = Number.parseFloat(raw ?? '');
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
    return undefined;
  }
  return new DailyBudget(maxCostUsd);
}

/**
 * Parses `PIPELINE_PRICE_PER_1K_TOKENS_USD` — the blended USD price per 1,000
 * tokens that turns model calls into per-item spend (ADR-031). Absent,
 * non-numeric, or non-positive input prices calls at 0, so recipe cost caps
 * are tracked but never trip (the engine's own documented default).
 */
function buildPricePer1kTokens(raw: string | undefined): number {
  const price = Number.parseFloat(raw ?? '');
  return Number.isFinite(price) && price > 0 ? price : 0;
}

/** The table the durable idempotency store records completed outcomes in. */
const IDEMPOTENCY_TABLE = 'idempotency';

/** The table the effect gateway's durable commit records live in (remediation Milestone 5). */
const COMMITS_TABLE = 'commits';

/**
 * Builds the effect gateway's durable commit-record store (remediation
 * Milestone 5) from `TOOLSHED_GOVERNANCE_STATE_CONNECTION_STRING` — the same
 * storage account the shared governance state rides (ADR-026), so one secret
 * covers both tables and a gateway restart (or a second replica holding the
 * same idempotency key) replays the recorded outcome instead of re-executing
 * the effect. Absent keeps the in-process-only behaviour.
 */
async function buildCommitRecordStore(): Promise<CommitRecordStore | undefined> {
  const connectionString = process.env.TOOLSHED_GOVERNANCE_STATE_CONNECTION_STRING;
  if (!connectionString) {
    return undefined;
  }
  const client = new TableClient(connectionString, COMMITS_TABLE);
  try {
    await client.createTable();
  } catch (err) {
    if (!(typeof err === 'object' && err !== null && (err as { statusCode?: unknown }).statusCode === 409)) {
      throw err;
    }
  }
  return new TableCommitRecordStore(client);
}

/**
 * Builds the idempotency store (remediation Milestone 4). With
 * `IDEMPOTENCY_STATE_CONNECTION_STRING` set, completed outcomes live in Azure
 * Tables — durable across restarts and shared across the queue consumer's
 * 1-5 replicas, first-writer-wins on a concurrent duplicate — so the
 * at-most-once guarantee of Milestone 15 holds at deployment scale. Without
 * it, the in-memory store (local dev / single-process) keeps today's
 * behaviour, with a loud warning about what that means.
 */
async function buildOutcomes(): Promise<IdempotencyStore> {
  const connectionString = process.env.IDEMPOTENCY_STATE_CONNECTION_STRING;
  if (!connectionString) {
    console.warn(
      '[queue-ingress] IDEMPOTENCY_STATE_CONNECTION_STRING is not set -- using the in-memory idempotency store: duplicates re-run across restarts or other replicas. Set it (TableEndpoint under the same storage account the toolshed uses) to make at-most-once hold at scale.'
    );
    return new InMemoryIdempotencyStore();
  }
  const client = new TableClient(connectionString, IDEMPOTENCY_TABLE);
  try {
    await client.createTable();
  } catch (err) {
    // 409 — the table already exists — is the normal second-boot path.
    if (!(typeof err === 'object' && err !== null && (err as { statusCode?: unknown }).statusCode === 409)) {
      throw err;
    }
  }
  return new TableIdempotencyStore(client);
}

async function main(): Promise<void> {
  const queue = await buildQueue();
  const store = createSqliteStore(config.sqlitePath);
  const state = await buildToolshedState();
  initializeToolshed(state);

  const goose = createHttpGooseClient({ baseUrl: config.gooseUrl });
  const runner = createOrchestratorRunner({
    goose,
    store,
    toolshed: { verifyAndExecuteTool },
    secret: config.signingSecret,
  });

  const outcomes = await buildOutcomes();
  const fallback = new WorkItemProcessor({ runner, queue, outcomes });

  // The daily throughput budget gates the consume loop (below) AND is charged
  // by every settled pipeline item via `onItemCost` — the remediation Milestone
  // 3 fix: the cap was gated but never charged, so it could never trip.
  const dailyBudget = buildDailyBudget(process.env.DAILY_BUDGET_MAX_COST_USD);
  const chargeDaily = dailyBudget ? (costUsd: number): void => dailyBudget.record(costUsd) : undefined;
  // The day-cap exhaustion audit stays with the consume loop's existing
  // transition detection: charging now makes `isExhausted()` trip for real,
  // and that poll writes the `budget_day_*_exhausted` entry (one writer, one
  // audit id — a second writer here would collide on the audit PK).
  const pricePer1kTokensUsd = buildPricePer1kTokens(process.env.PIPELINE_PRICE_PER_1K_TOKENS_USD);

  // ADR-030 wiring: load the declarative pipelines. Fail-safe by construction —
  // no recipes (or a broken recipe) logs once inside loadPipelines and every
  // item keeps the WorkItemProcessor -> orchestrator runner path above.
  const recipesDir = resolvePipelinesDir(process.env.PIPELINES_CONFIG_PATH, defaultRecipesDir());
  const pipelines = loadPipelines(recipesDir);
  // Remediation Milestone 3: a declared cap with an unpriced model layer is a
  // configuration error, not a silent no-op (PIPELINE_ALLOW_UNPRICED=1 opts
  // out for simulation).
  assertPriced(pipelines, pricePer1kTokensUsd);

  let processor: MessageProcessor = fallback;
  const commitRecordStore = await buildCommitRecordStore();
  if (pipelines.size > 0) {
    // The Milestone 14 effect gateway is the pipeline's only commit path.
    // Policies come from each recipe's commit block; the approval class is
    // 'auto' because the gateway's own fail-closed invariants still govern
    // (an irreversible draft, or an empty signing secret, refuses to commit
    // and the item escalates rather than acting).
    const effectTypes = new Map<string, EffectTypePolicy>(
      [...pipelines.values()].map((pipeline) => [
        pipeline.config.commit.effect_type,
        makeEffectTypePolicy(pipeline.config.commit.effect_type, pipeline.config.commit.reversibility, 'auto'),
      ])
    );
    const resolver = new PipelineVerificationResolver();
    const gateway = new EffectGateway({
      effectTypes,
      signingSecret: config.signingSecret,
      evidenceResolver: resolver,
      ...(commitRecordStore ? { commitRecordStore } : {}),
    });

    const bridgeSecret = process.env.FORGE_BRIDGE_SECRET;
    const escalate = buildEscalateEmitter({ intakeUrl: process.env.FORGE_INTAKE_URL, bridgeSecret });

    const pipelineDeps: SharedPipelineDeps = {
      goose,
      store,
      secret: config.signingSecret,
      reconcile: ({ minionToken, correlationId, attempt, serverAlias, toolName, params }) =>
        verifyAndExecuteTool({ minionToken, correlationId, attempt }, serverAlias, toolName, params),
      commit: buildGatewayCommit(gateway, resolver),
      pricePer1kTokensUsd,
      ...(chargeDaily ? { onItemCost: chargeDaily } : {}),
      ...(escalate ? { escalate } : {}),
      ...(bridgeSecret ? { bridgeSecret } : {}),
    };

    processor = new PipelineWorkItemProcessor({
      pipelines,
      deps: pipelineDeps,
      fallback,
      queue,
      outcomes,
    });
  }

  // The daily budget gates the consume loop itself, so it applies identically
  // to pipeline-routed items and fallback items (ADR-031, unchanged) — and the
  // pipeline items now charge it, so the gate actually engages.
  await consumeQueue({ queue, processor, store, ...(dailyBudget ? { dailyBudget } : {}) });
}

main().catch((err) => {
  console.error('Queue ingress failed to start', err);
  process.exit(1);
});
