import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { IngressResponse } from 'framework-core';
import { runItemPipeline, type EffectCommitResult, type EffectDraft, type EscalateItem, type ItemPipelineConfig, type ItemPipelineDeps, type PipelineCaller, type PipelineOutcome } from './item-pipeline.js';
import { loadPipeline, type LoadedPipeline } from './pipeline-config.js';
import { deliverEscalation } from './escalation.js';
import type { IdempotencyStore } from './idempotency-store.js';
import { DEAD_LETTER_POISON_MESSAGE, type MessageProcessor, type ProcessResult } from './processor.js';
import type { QueueMessage, WorkItemQueue } from './queue.js';
import { parseWorkItem, type WorkItem } from './work-item.js';

/**
 * Production wiring for the item-pipeline engine (closes the ADR-030/031/033
 * "library-complete; production wiring pending" gap). This module is the seam
 * `src/index.ts` composes at startup:
 *
 *  * {@link loadPipelines} loads every pipeline from `recipes/item-pipelines.yaml`
 *    (fail-safe: an absent file or a broken recipe logs once and yields no
 *    pipeline, so the consumer keeps its pre-pipeline behaviour);
 *  * {@link PipelineWorkItemProcessor} routes each work item by `item_type` —
 *    through `runItemPipeline` when a pipeline exists, otherwise falling back
 *    to the Milestone 15 `WorkItemProcessor` → orchestrator runner path;
 *  * {@link buildEscalateEmitter} arms the ADR-033 bridge emitter only when
 *    both `FORGE_INTAKE_URL` and `FORGE_BRIDGE_SECRET` are configured;
 *  * {@link buildGatewayCommit} adapts the Milestone 14 effect gateway to the
 *    pipeline's `CommitEffect` seam, feeding the gateway's evidence resolver
 *    the composite `verification/v1` result of THIS run.
 *
 * Everything here follows the package's existing dependency-injection shape
 * (structural interfaces, injectable collaborators) so tests drive it with the
 * in-memory queue and trivial fakes — no cloud, no HTTP.
 */

/**
 * Dead-letter reason for a pipeline item whose terminal outcome is `escalated`
 * while no bridge emitter is armed (`FORGE_INTAKE_URL`/`FORGE_BRIDGE_SECRET`
 * unset): the item cannot reach Flow, so it is quarantined — loudly, with its
 * own reason code — rather than dropped or retried forever.
 */
export const DEAD_LETTER_ESCALATION_UNARMED = 'ESCALATION_UNARMED';

/**
 * Dead-letter reason for a bridged item whose verified resolution came back
 * `outcome: "unresolved"` — Flow answered but could not resolve the item, so
 * it must surface to an operator, never complete silently (the audit trail
 * already links the Flow run under the item's correlation id).
 */
export const DEAD_LETTER_ESCALATION_UNRESOLVED = 'ESCALATION_UNRESOLVED';

/**
 * Resolves the recipes directory from `PIPELINES_CONFIG_PATH`. Unset means the
 * repo-relative default the tests use (`<repo>/recipes`). A value pointing at
 * the `item-pipelines.yaml` file itself is accepted too — the loader needs the
 * directory (for `prompts/` and `schemas/`), so the file's directory is used.
 */
export function resolvePipelinesDir(configured: string | undefined, defaultDir: string): string {
  if (!configured) {
    return defaultDir;
  }
  return configured.endsWith('.yaml') || configured.endsWith('.yml') ? path.dirname(configured) : configured;
}

/**
 * Fails loud when a pipeline declares a `max_cost_usd` cap the resolved price
 * can never enforce (remediation Milestone 3): a cap divided by a zero
 * `PIPELINE_PRICE_PER_1K_TOKENS_USD` is infinite, so every item cap would be
 * silently disabled — the exact drift the remediation closes. Throws naming
 * the offending item types and both environment variables unless
 * `PIPELINE_ALLOW_UNPRICED=1` explicitly accepts simulation semantics.
 */
export function assertPriced(
  pipelines: Map<string, LoadedPipeline>,
  pricePer1kTokensUsd: number,
  allowUnpriced: boolean = process.env.PIPELINE_ALLOW_UNPRICED === '1'
): void {
  if (allowUnpriced || pricePer1kTokensUsd > 0) {
    return;
  }
  const capped = [...pipelines.entries()]
    .filter(([, pipeline]) => (pipeline.config.max_cost_usd ?? 0) > 0)
    .map(([itemType, pipeline]) => `'${itemType}' (max_cost_usd ${pipeline.config.max_cost_usd})`);
  if (capped.length === 0) {
    return;
  }
  throw new Error(
    `[queue-ingress] item pipeline(s) declare a max_cost_usd cap but PIPELINE_PRICE_PER_1K_TOKENS_USD is unset or zero, so the cap can never trip: ${capped.join(', ')}. Set PIPELINE_PRICE_PER_1K_TOKENS_USD to the blended USD price per 1,000 tokens, or set PIPELINE_ALLOW_UNPRICED=1 to accept unenforced caps (simulation only).`
  );
}

/**
 * Loads every item pipeline declared in `<recipesDir>/item-pipelines.yaml`.
 * Strictly additive and safe to deploy with no recipes present: an absent
 * file, an unreadable file, or a malformed mapping logs once and returns an
 * empty map (every item falls back to the orchestrator-runner path), and one
 * broken pipeline entry logs and is skipped without taking down its siblings.
 */
export function loadPipelines(recipesDir: string, log: (message: string) => void = console.warn): Map<string, LoadedPipeline> {
  const pipelines = new Map<string, LoadedPipeline>();
  const configPath = path.join(recipesDir, 'item-pipelines.yaml');
  if (!fs.existsSync(configPath)) {
    log(
      `[queue-ingress] no item-pipelines.yaml at ${configPath} -- every work item takes the WorkItemProcessor -> orchestrator runner path (set PIPELINES_CONFIG_PATH to enable item pipelines).`
    );
    return pipelines;
  }
  let itemTypes: string[];
  try {
    const raw = yaml.load(fs.readFileSync(configPath, 'utf8')) as { item_pipelines?: unknown } | undefined;
    const mapping = raw?.item_pipelines;
    if (typeof mapping !== 'object' || mapping === null || Array.isArray(mapping)) {
      throw new Error('item-pipelines.yaml must define an item_pipelines mapping');
    }
    itemTypes = Object.keys(mapping);
  } catch (err) {
    log(
      `[queue-ingress] failed to read ${configPath} (${err instanceof Error ? err.message : String(err)}) -- every work item takes the WorkItemProcessor -> orchestrator runner path.`
    );
    return pipelines;
  }
  for (const itemType of itemTypes) {
    try {
      pipelines.set(itemType, loadPipeline(recipesDir, itemType));
    } catch (err) {
      log(
        `[queue-ingress] item pipeline '${itemType}' failed to load (${err instanceof Error ? err.message : String(err)}) -- items of this type fall back to the WorkItemProcessor -> orchestrator runner path.`
      );
    }
  }
  return pipelines;
}

/**
 * Builds the ADR-033 escalation emitter, armed only when BOTH the Flow intake
 * URL and the bridge secret are configured; otherwise `undefined`, and the
 * pipeline's escalation outcomes stay `escalated` (which the processor below
 * dead-letters as {@link DEAD_LETTER_ESCALATION_UNARMED} — it never throws).
 * A delivery the intake rejects throws, so the processor abandons the message
 * for redelivery (a transient intake outage retries; a persistent one trips
 * the poison path) rather than losing the escalation.
 */
export function buildEscalateEmitter(options: {
  intakeUrl?: string;
  bridgeSecret?: string;
  /** Injectable delivery seam for tests; defaults to the real `deliverEscalation`. */
  deliver?: typeof deliverEscalation;
}): EscalateItem | undefined {
  const { intakeUrl, bridgeSecret, deliver = deliverEscalation } = options;
  if (!intakeUrl || !bridgeSecret) {
    return undefined;
  }
  return async (envelope) => {
    const result = await deliver(envelope, intakeUrl, bridgeSecret);
    if (result.status !== 'resolved') {
      throw new Error(`escalation delivery rejected by Flow intake: ${result.reason}`);
    }
    return { resolution: result.resolution };
  };
}

/** The resolved `verification/v1` evidence view the effect gateway reads at commit time. */
export interface PipelineEvidenceView {
  ref: string;
  verifier: string;
  passed: boolean;
  metrics?: Record<string, number>;
}

/**
 * A mutable evidence resolver joining the pipeline's commit step to the effect
 * gateway: `buildGatewayCommit` records the composite result of the CURRENT
 * run under its evidence ref before drafting, so a commit is authorised by
 * this run's verification, never a stale or pre-seeded one. Structurally
 * compatible with `mcp-toolshed`'s `VerificationResolver`.
 */
export class PipelineVerificationResolver {
  private readonly views = new Map<string, PipelineEvidenceView>();

  set(view: PipelineEvidenceView): void {
    this.views.set(view.ref, view);
  }

  resolve(ref: string): PipelineEvidenceView | null {
    return this.views.get(ref) ?? null;
  }
}

/**
 * The narrow effect-gateway surface the commit seam needs — a structural
 * subset of `mcp-toolshed`'s `EffectGateway` (draft, then commit), kept as an
 * interface so tests pass a trivial fake without constructing the real class.
 */
export interface PipelineEffectGateway {
  draftEffect(draft: EffectDraft, caller: PipelineCaller): Promise<{ drafted: boolean; refused?: string; draftRef?: string }>;
  commitEffect(args: { draft_ref: string }, caller: PipelineCaller): Promise<EffectCommitResult>;
}

/**
 * Adapts the Milestone 14 effect gateway to the pipeline's `CommitEffect`
 * seam, mirroring `test/src/e2e-item-pipeline.test.ts`: publish this run's
 * composite verification under its evidence ref, draft, and commit. A refused
 * draft is a refused commit (the pipeline then escalates), never a throw.
 */
export function buildGatewayCommit(gateway: PipelineEffectGateway, resolver: PipelineVerificationResolver): ItemPipelineDeps['commit'] {
  return async ({ draft, caller, compositeResult }) => {
    resolver.set({
      ref: compositeResult.evidence_ref ?? draft.evidence[0] ?? '',
      verifier: compositeResult.verifier,
      passed: compositeResult.passed,
      metrics: compositeResult.metrics,
    });
    const drafted = await gateway.draftEffect(draft, caller);
    if (!drafted.drafted) {
      return { committed: false, refused: drafted.refused };
    }
    return gateway.commitEffect({ draft_ref: drafted.draftRef! }, caller);
  };
}

/** The per-item deps shared across pipelines; `schemas`/`schemaMap` come from each item type's `LoadedPipeline`. */
export type SharedPipelineDeps = Omit<ItemPipelineDeps, 'schemas' | 'schemaMap'>;

export interface PipelineProcessorDeps {
  /** `item_type` -> loaded pipeline; item types with no entry fall back. */
  pipelines: Map<string, LoadedPipeline>;
  /** Shared pipeline collaborators (goose, store, secrets, reconcile, commit, escalate, pricing). */
  deps: SharedPipelineDeps;
  /** The Milestone 15 processor items without a pipeline fall back to (and the malformed-envelope path). */
  fallback: MessageProcessor;
  queue: WorkItemQueue;
  outcomes: IdempotencyStore;
  /** Delivery count at which a repeatedly-failing item is dead-lettered as poison. Defaults to 3 (mirrors `WorkItemProcessor`). */
  maxDeliveryCount?: number;
  /** Injectable engine seam for tests; defaults to the real `runItemPipeline`. */
  runPipeline?: (config: ItemPipelineConfig, deps: ItemPipelineDeps, item: WorkItem) => Promise<PipelineOutcome>;
  log?: (message: string) => void;
}

/** The recorded/settled `IngressResponse` describing a pipeline item's terminal outcome. */
function describeOutcome(item: WorkItem, outcome: PipelineOutcome): IngressResponse {
  if (outcome.status === 'bridged') {
    return {
      text: `Work item ${item.correlation_id} (type '${item.item_type}') escalated to Flow and resolved (run ${outcome.resolution.run_id ?? 'unknown'}) after ${outcome.attempts} attempt(s).`,
    };
  }
  return {
    text: `Work item ${item.correlation_id} (type '${item.item_type}') committed via its item pipeline after ${outcome.attempts} attempt(s).`,
  };
}

/**
 * The production message processor (ADR-030 wiring): routes each work item by
 * `item_type` through its declarative pipeline, falling back to the wrapped
 * Milestone 15 `WorkItemProcessor` when no pipeline matches (or the envelope
 * is malformed — the fallback owns `MALFORMED_ENVELOPE`). The redelivery
 * contract is identical to `WorkItemProcessor`: idempotency short-circuit
 * before the poison check, outcome recorded before settling, and a thrown
 * pipeline error abandons the message so the poison path can eventually trip.
 *
 * Pipeline outcomes map to queue settlements as:
 *  * `committed`, or `bridged` with a `resolved` resolution -> complete (outcome recorded);
 *  * `dead_lettered` -> dead-letter with the pipeline's reason (`BUDGET_EXCEEDED`
 *    for a cost-cap halt, ADR-031 — the item halts, never the queue);
 *  * `escalated` (no emitter armed) -> dead-letter {@link DEAD_LETTER_ESCALATION_UNARMED}, with a log;
 *  * `bridged` but `unresolved` -> dead-letter {@link DEAD_LETTER_ESCALATION_UNRESOLVED}.
 */
export class PipelineWorkItemProcessor implements MessageProcessor {
  private readonly deps: PipelineProcessorDeps;
  private readonly fallbackLogged = new Set<string>();

  constructor(deps: PipelineProcessorDeps) {
    this.deps = deps;
  }

  private log(message: string): void {
    (this.deps.log ?? console.warn)(message);
  }

  async process(message: QueueMessage): Promise<ProcessResult> {
    const item = parseWorkItem(message.body);
    if (!item) {
      // The fallback processor owns the MALFORMED_ENVELOPE dead-letter path.
      return this.deps.fallback.process(message);
    }

    const loaded = this.deps.pipelines.get(item.item_type);
    if (!loaded) {
      if (!this.fallbackLogged.has(item.item_type)) {
        this.fallbackLogged.add(item.item_type);
        this.log(
          `[queue-ingress] no item pipeline for item_type '${item.item_type}' -- falling back to the WorkItemProcessor -> orchestrator runner path (logged once per item type).`
        );
      }
      return this.deps.fallback.process(message);
    }

    const recorded = this.deps.outcomes.get(item.idempotency_key);
    if (recorded) {
      await this.deps.queue.complete(message);
      return { status: 'completed', result: recorded.result, shortCircuited: true };
    }

    const maxDeliveryCount = this.deps.maxDeliveryCount ?? 3;
    if (message.deliveryCount >= maxDeliveryCount) {
      await this.deps.queue.deadLetter(message, DEAD_LETTER_POISON_MESSAGE);
      return { status: 'dead_lettered', reason: DEAD_LETTER_POISON_MESSAGE };
    }

    const run = this.deps.runPipeline ?? runItemPipeline;
    let outcome: PipelineOutcome;
    try {
      outcome = await run(loaded.config, { ...this.deps.deps, schemas: loaded.schemas, schemaMap: loaded.schemaMap }, item);
    } catch (err) {
      // Mirrors WorkItemProcessor: only a failed RUN abandons (redelivery,
      // deliveryCount +1) so the poison path can eventually trip.
      await this.deps.queue.abandon(message);
      return { status: 'abandoned', reason: err instanceof Error ? err.message : String(err) };
    }

    if (outcome.status === 'dead_lettered') {
      await this.deps.queue.deadLetter(message, outcome.reason);
      return { status: 'dead_lettered', reason: outcome.reason };
    }

    if (outcome.status === 'escalated') {
      this.log(
        `[queue-ingress] item ${item.correlation_id} (type '${item.item_type}') escalated with no bridge emitter armed (FORGE_INTAKE_URL/FORGE_BRIDGE_SECRET unset) -- dead-lettering as ${DEAD_LETTER_ESCALATION_UNARMED}: ${outcome.reason}`
      );
      await this.deps.queue.deadLetter(message, DEAD_LETTER_ESCALATION_UNARMED);
      return { status: 'dead_lettered', reason: DEAD_LETTER_ESCALATION_UNARMED };
    }

    if (outcome.status === 'bridged' && outcome.resolution.outcome !== 'resolved') {
      this.log(
        `[queue-ingress] item ${item.correlation_id} (type '${item.item_type}') bridged to Flow but came back unresolved -- dead-lettering as ${DEAD_LETTER_ESCALATION_UNRESOLVED}.`
      );
      await this.deps.queue.deadLetter(message, DEAD_LETTER_ESCALATION_UNRESOLVED);
      return { status: 'dead_lettered', reason: DEAD_LETTER_ESCALATION_UNRESOLVED };
    }

    const result = describeOutcome(item, outcome);
    this.deps.outcomes.set(item.idempotency_key, {
      status: 'completed',
      result,
      completedAt: (this.deps.deps.now ?? Date.now)(),
    });
    await this.deps.queue.complete(message);
    return { status: 'completed', result, shortCircuited: false };
  }
}
