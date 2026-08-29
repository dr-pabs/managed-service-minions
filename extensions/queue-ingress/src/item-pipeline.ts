import { mintMinionToken } from 'framework-core';
import type { SchemaCompileResult, SessionStore } from 'framework-core';
import type { GooseClient } from 'orchestrator';
import {
  createItemCostLedger,
  DEAD_LETTER_BUDGET_EXCEEDED,
  ItemBudgetExceededError,
  priceModelResponse,
  type ItemCostLedger,
} from './cost-control.js';
import {
  errorFindings,
  evidenceRef,
  runVerificationChain,
  type JudgeVerdict,
  type ReconcileReadResult,
  type VerifyConfig,
  type VerificationFinding,
  type VerificationResult,
} from './verification.js';
import type { WorkItem } from './work-item.js';
import {
  assembleEscalationEnvelope,
  type AttemptRecord,
  type EscalationCause,
  type EscalationEnvelope,
  type ResolutionEnvelope,
} from './escalation.js';

/**
 * The bounded item pipeline (Milestone 16): classify -> act -> verify -> commit
 * or escalate. Expressed declaratively (see `recipes/item-pipelines.yaml`),
 * NOT as orchestrator code — iteration belongs to Flow, so this loop is bounded
 * by `max_attempts` and never loops unboundedly.
 */

export interface ClassifyStep {
  agent: string;
  system_prompt: string;
}

export interface ActStep {
  agent: string;
  system_prompt: string;
  output_schema: string;
}

export interface CommitStep {
  effect_type: string;
  target_system: string;
  reversibility: string;
}

export interface ItemPipelineConfig {
  item_type: string;
  max_attempts: number;
  on_failure: 'dead_letter' | 'escalate';
  /**
   * The hard per-item cost cap in USD (budget/v1 `scope: "item"`, `policy:
   * "halt"`). An item whose accumulated model spend reaches this halts and
   * dead-letters as `BUDGET_EXCEEDED` — the item halts, never the queue. Absent
   * means uncapped (the item's spend is still tracked, but never enforced).
   */
  max_cost_usd?: number;
  /** Optional warning threshold as a percentage of `max_cost_usd` (budget/v1 `warn_at_pct`). */
  warn_at_pct?: number;
  classify?: ClassifyStep;
  act: ActStep;
  verify: VerifyConfig;
  commit: CommitStep;
}

/** The inert effect draft the commit step hands to the Milestone 14 gateway. */
export interface EffectDraft {
  effect_type: string;
  target_system: string;
  payload: Record<string, unknown>;
  evidence: string[];
  reversibility: string;
  idempotency_key: string;
  expiry: number;
}

export interface PipelineCaller {
  agentId: string;
  identityToken: string;
  scopeId: string;
  correlationId: string;
}

export interface EffectCommitResult {
  committed: boolean;
  refused?: string;
  approvalPending?: boolean;
  idempotentReplay?: boolean;
}

export type CommitEffect = (args: {
  draft: EffectDraft;
  caller: PipelineCaller;
  compositeResult: VerificationResult;
}) => Promise<EffectCommitResult>;

/**
 * The escalation emitter seam (Milestone 20). The pipeline hands it a signed
 * `escalation/v1` envelope and it delivers it to Flow's intake, returning the
 * verified resolution. Absent, the pipeline's escalation outcomes stay
 * `escalated` (no bridge) — the existing Milestone 16 behaviour.
 */
export type EscalateItem = (envelope: EscalationEnvelope) => Promise<{ resolution: ResolutionEnvelope }>;

export interface ItemPipelineDeps {
  goose: GooseClient;
  store: SessionStore;
  secret: string;
  schemas: SchemaCompileResult;
  schemaMap: Map<string, string>;
  reconcile(args: {
    minionToken: string;
    correlationId: string;
    attempt: number;
    serverAlias: string;
    toolName: string;
    params: unknown;
  }): Promise<ReconcileReadResult>;
  commit: CommitEffect;
  /** The escalation emitter (Milestone 20): delivers a signed envelope to Flow's intake. Absent, escalation outcomes stay `escalated`. */
  escalate?: EscalateItem;
  /**
   * The bridge signing secret the `escalation/v1` envelope is minted under
   * (Milestone 20). Distinct from the identity `secret` — the envelope is
   * signed and verified with the *bridge* key both runtimes share, not the
   * agent-identity key. Falls back to `secret` when absent so a pipeline
   * wired without a dedicated bridge secret still signs (deployments that
   * bridge to Flow MUST set it to match `FORGE_BRIDGE_SECRET`).
   */
  bridgeSecret?: string;
  /** Blended USD price per 1,000 tokens for pricing model calls (Milestone 17). Defaults to 0 (uncapped items never spend). */
  pricePer1kTokensUsd?: number;
  now?: () => number;
  random?: () => number;
}

export type PipelineOutcome =
  | { status: 'committed'; correlationId: string; attempts: number; results: VerificationResult[] }
  | { status: 'dead_lettered'; correlationId: string; attempts: number; results: VerificationResult[]; reason: string }
  | { status: 'escalated'; correlationId: string; attempts: number; results: VerificationResult[]; reason: string }
  | {
      status: 'bridged';
      correlationId: string;
      attempts: number;
      results: VerificationResult[];
      cause: EscalationCause;
      resolution: ResolutionEnvelope;
    };

/** The cost accounting carried through every model call of one item run (Milestone 17). */
interface CostAccount {
  ledger: ItemCostLedger;
  pricePer1kTokensUsd: number;
}

/**
 * Prices one model call against the item's cost ledger and halts the item the
 * moment its accumulated spend reaches the cap. The cap is enforced on the
 * priced call (post-dispatch): the item only discovers it exceeded `max_cost_usd`
 * once a call is priced, then throws {@link ItemBudgetExceededError} so the
 * pipeline dead-letters this item without making a further call.
 */
async function runModelCall(
  call: () => Promise<{ raw: string }>,
  account: CostAccount,
  correlationId: string
): Promise<{ raw: string }> {
  const response = await call();
  account.ledger.record(priceModelResponse(response, account.pricePer1kTokensUsd));
  if (account.ledger.isExhausted()) {
    throw new ItemBudgetExceededError(account.ledger.spentUsd, account.ledger.maxCostUsd, correlationId);
  }
  return response;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseJudgeVerdict(raw: string): JudgeVerdict {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.passed === 'boolean') {
      const findings = Array.isArray(parsed.findings) ? (parsed.findings as VerificationFinding[]) : undefined;
      return { passed: parsed.passed, findings };
    }
  } catch {
    // fall through to the invalid-output verdict
  }
  return {
    passed: false,
    findings: [{ id: 'judge.invalid_output', message: 'judge returned invalid output', severity: 'error' }],
  };
}

function classifyUserContent(item: WorkItem): string {
  return typeof item.payload === 'string' ? item.payload : JSON.stringify(item.payload);
}

function actUserContent(item: WorkItem, facts: unknown): string {
  return JSON.stringify({ item_type: item.item_type, payload: item.payload, facts });
}

async function classify(
  config: ItemPipelineConfig,
  deps: ItemPipelineDeps,
  item: WorkItem,
  token: string,
  account: CostAccount
): Promise<unknown> {
  if (!config.classify) {
    return item.payload;
  }
  const classifyStep = config.classify;
  const response = await runModelCall(
    () =>
      deps.goose.runMinion({
        minionType: classifyStep.agent,
        systemPrompt: classifyStep.system_prompt,
        userContent: classifyUserContent(item),
        sessionId: item.idempotency_key,
        correlationId: item.correlation_id,
        minionToken: token,
      }),
    account,
    item.correlation_id
  );
  return parseJson(response.raw) ?? item.payload;
}

async function act(
  config: ItemPipelineConfig,
  deps: ItemPipelineDeps,
  item: WorkItem,
  token: string,
  facts: unknown,
  feedback: string[] | undefined,
  account: CostAccount
): Promise<unknown> {
  const response = await runModelCall(
    () =>
      deps.goose.runMinion({
        minionType: config.act.agent,
        systemPrompt: config.act.system_prompt,
        userContent: actUserContent(item, facts),
        sessionId: item.idempotency_key,
        correlationId: item.correlation_id,
        minionToken: token,
        feedback,
      }),
    account,
    item.correlation_id
  );
  return parseJson(response.raw);
}

async function runJudge(
  config: ItemPipelineConfig,
  deps: ItemPipelineDeps,
  item: WorkItem,
  token: string,
  userContent: string,
  account: CostAccount
): Promise<JudgeVerdict> {
  const judge = config.verify.judge!;
  const response = await runModelCall(
    () =>
      deps.goose.runMinion({
        minionType: judge.agent,
        systemPrompt: judge.system_prompt,
        userContent,
        sessionId: item.idempotency_key,
        correlationId: item.correlation_id,
        minionToken: token,
      }),
    account,
    item.correlation_id
  );
  return parseJudgeVerdict(response.raw);
}

function writeVerificationAudit(
  deps: ItemPipelineDeps,
  config: ItemPipelineConfig,
  item: WorkItem,
  results: VerificationResult[],
  attempt: number,
  now: () => number
): void {
  const timestamp = now();
  for (const result of results) {
    const toolName = result.verifier.split(':')[0];
    const errors = result.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.message);
    deps.store.createAuditEntry({
      id: `verify_${item.correlation_id}_${toolName}_${attempt}`,
      timestamp,
      correlationId: item.correlation_id,
      minionType: config.act.agent,
      teamId: config.item_type,
      serverAlias: 'verification',
      toolName,
      params: result,
      status: result.passed ? 'success' : 'error',
      latencyMs: 0,
      error: errors.length > 0 ? errors.join('; ') : undefined,
    });
  }
}

/**
 * Writes the `audit/v1` kind `budget` event for an item that crossed its cap
 * (Milestone 17). Mirrors the shape `writeVerificationAudit` uses so the item's
 * whole story — verification results and the budget halt — hangs together under
 * one correlation id.
 */
function writeItemBudgetAudit(
  deps: ItemPipelineDeps,
  config: ItemPipelineConfig,
  item: WorkItem,
  error: ItemBudgetExceededError,
  now: () => number
): void {
  deps.store.createAuditEntry({
    id: `budget_item_${item.correlation_id}`,
    timestamp: now(),
    correlationId: item.correlation_id,
    minionType: config.act.agent,
    teamId: config.item_type,
    serverAlias: 'budget',
    toolName: 'item_cap',
    params: { scope: 'item', policy: 'halt', max_cost_usd: error.maxCostUsd, spent_usd: error.spentUsd },
    status: 'exceeded',
    latencyMs: 0,
    error: error.message,
  });
}

/**
 * Writes the audit entry that links Stream's trace to the Flow run that
 * answered the escalation (Milestone 20). Carries the escalation cause and the
 * resolution's `run_id`/`outcome` under the item's correlation id, so the two
 * audit trails read as one story.
 */
function writeEscalationAudit(
  deps: ItemPipelineDeps,
  config: ItemPipelineConfig,
  item: WorkItem,
  cause: EscalationCause,
  resolution: ResolutionEnvelope,
  now: () => number
): void {
  deps.store.createAuditEntry({
    id: `escalation_${item.correlation_id}`,
    timestamp: now(),
    correlationId: item.correlation_id,
    minionType: config.act.agent,
    teamId: config.item_type,
    serverAlias: 'escalation',
    toolName: 'bridge',
    params: { cause, run_id: resolution.run_id, outcome: resolution.outcome },
    status: resolution.outcome === 'resolved' ? 'success' : 'error',
    latencyMs: 0,
  });
}

/**
 * Routes an escalation to its terminal outcome. With an emitter wired, the
 * pipeline assembles a signed `escalation/v1` envelope from the item and its
 * attempt history, delivers it, and returns `bridged` with the verified
 * resolution; without one, it returns `escalated` (Milestone 16 behaviour).
 */
async function escalateItem(
  config: ItemPipelineConfig,
  deps: ItemPipelineDeps,
  item: WorkItem,
  cause: EscalationCause,
  history: AttemptRecord[],
  results: VerificationResult[],
  attempts: number,
  reason: string,
  now: () => number
): Promise<PipelineOutcome> {
  if (!deps.escalate) {
    return { status: 'escalated', correlationId: item.correlation_id, attempts, results, reason };
  }
  const envelope = assembleEscalationEnvelope({ item, history, cause, secret: deps.bridgeSecret ?? deps.secret, now });
  const { resolution } = await deps.escalate(envelope);
  writeEscalationAudit(deps, config, item, cause, resolution, now);
  return { status: 'bridged', correlationId: item.correlation_id, attempts, results, cause, resolution };
}

async function commitEffect(
  config: ItemPipelineConfig,
  deps: ItemPipelineDeps,
  item: WorkItem,
  token: string,
  action: unknown,
  composite: VerificationResult,
  now: () => number
): Promise<EffectCommitResult> {
  if (typeof action !== 'object' || action === null || Array.isArray(action)) {
    return { committed: false, refused: 'act output is not a JSON object — cannot draft an effect' };
  }
  const draft: EffectDraft = {
    effect_type: config.commit.effect_type,
    target_system: config.commit.target_system,
    payload: action as Record<string, unknown>,
    evidence: [evidenceRef(item.correlation_id)],
    reversibility: config.commit.reversibility,
    idempotency_key: item.idempotency_key,
    expiry: now() + 60_000,
  };
  const caller: PipelineCaller = {
    agentId: config.act.agent,
    identityToken: token,
    scopeId: item.idempotency_key,
    correlationId: item.correlation_id,
  };
  return deps.commit({ draft, caller, compositeResult: composite });
}

/**
 * Drives one work item through its pipeline to exactly one terminal outcome:
 * `committed` (chain passed and the gateway committed), `dead_lettered`
 * (chain never passed and `on_failure` is `dead_letter`, or the item crossed
 * its `max_cost_usd` cap as `BUDGET_EXCEEDED`), `escalated` (chain never
 * passed under `on_failure: escalate`, or the commit was refused — with no
 * emitter wired), or `bridged` (the same escalation routes, delivered to
 * Flow's intake via the Milestone 20 emitter, closed with a verified
 * resolution). The loop is bounded by `max_attempts`; every attempt's
 * verification results are written to the audit trail under the item's
 * correlation id, and every model call is priced against the item's cost
 * ledger (Milestone 17) so a runaway item halts itself rather than the queue
 * around it.
 */
export async function runItemPipeline(
  config: ItemPipelineConfig,
  deps: ItemPipelineDeps,
  item: WorkItem
): Promise<PipelineOutcome> {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const correlationId = item.correlation_id;
  const token = mintMinionToken(
    { agent_id: config.act.agent, scope_id: item.idempotency_key, correlation_id: correlationId },
    deps.secret
  );

  const account: CostAccount = {
    ledger: createItemCostLedger(config.max_cost_usd, config.warn_at_pct),
    pricePer1kTokensUsd: deps.pricePer1kTokensUsd ?? 0,
  };

  let lastResults: VerificationResult[] = [];
  let attempts = 0;
  const attemptHistory: AttemptRecord[] = [];

  try {
    const facts = await classify(config, deps, item, token, account);

    let feedback: string[] | undefined;

    for (let attempt = 1; attempt <= config.max_attempts; attempt++) {
      attempts = attempt;
      const action = await act(config, deps, item, token, facts, feedback, account);

      const chain = await runVerificationChain(config.verify, {
        minionType: config.act.agent,
        output: action,
        schemaMap: deps.schemaMap,
        schemas: deps.schemas,
        minionToken: token,
        correlationId,
        attempt,
        sessionId: item.idempotency_key,
        reconcile: (args) => deps.reconcile({ minionToken: token, correlationId, attempt, ...args }),
        judge: config.verify.judge
          ? ({ userContent }) => runJudge(config, deps, item, token, userContent, account)
          : undefined,
        random,
      });

      lastResults = chain.results;
      writeVerificationAudit(deps, config, item, chain.results, attempt, now);
      attemptHistory.push({ attempt, at: now(), verification: chain.composite });

      if (chain.passed) {
        const commitResult = await commitEffect(config, deps, item, token, action, chain.composite, now);
        if (commitResult.committed) {
          return { status: 'committed', correlationId, attempts: attempt, results: chain.results };
        }
        return escalateItem(
          config,
          deps,
          item,
          'complexity',
          attemptHistory,
          chain.results,
          attempt,
          commitResult.refused ?? 'commit refused',
          now
        );
      }

      feedback = errorFindings(chain.results).map((finding) => `${finding.id}: ${finding.message}`);
    }
  } catch (err) {
    if (err instanceof ItemBudgetExceededError) {
      writeItemBudgetAudit(deps, config, item, err, now);
      return { status: 'dead_lettered', correlationId, attempts, results: lastResults, reason: DEAD_LETTER_BUDGET_EXCEEDED };
    }
    throw err;
  }

  const reason = `verification failed after ${config.max_attempts} attempt(s)`;
  if (config.on_failure === 'escalate') {
    return escalateItem(
      config,
      deps,
      item,
      'retry_exceeded',
      attemptHistory,
      lastResults,
      config.max_attempts,
      reason,
      now
    );
  }
  return { status: 'dead_lettered', correlationId, attempts: config.max_attempts, results: lastResults, reason };
}
