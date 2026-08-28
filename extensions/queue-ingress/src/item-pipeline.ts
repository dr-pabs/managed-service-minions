import { mintMinionToken } from 'framework-core';
import type { SchemaCompileResult, SessionStore } from 'framework-core';
import type { GooseClient } from 'orchestrator';
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
  now?: () => number;
  random?: () => number;
}

export type PipelineOutcome =
  | { status: 'committed'; correlationId: string; attempts: number; results: VerificationResult[] }
  | { status: 'dead_lettered'; correlationId: string; attempts: number; results: VerificationResult[]; reason: string }
  | { status: 'escalated'; correlationId: string; attempts: number; results: VerificationResult[]; reason: string };

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
  token: string
): Promise<unknown> {
  if (!config.classify) {
    return item.payload;
  }
  const response = await deps.goose.runMinion({
    minionType: config.classify.agent,
    systemPrompt: config.classify.system_prompt,
    userContent: classifyUserContent(item),
    sessionId: item.idempotency_key,
    correlationId: item.correlation_id,
    minionToken: token,
  });
  return parseJson(response.raw) ?? item.payload;
}

async function act(
  config: ItemPipelineConfig,
  deps: ItemPipelineDeps,
  item: WorkItem,
  token: string,
  facts: unknown,
  feedback: string[] | undefined
): Promise<unknown> {
  const response = await deps.goose.runMinion({
    minionType: config.act.agent,
    systemPrompt: config.act.system_prompt,
    userContent: actUserContent(item, facts),
    sessionId: item.idempotency_key,
    correlationId: item.correlation_id,
    minionToken: token,
    feedback,
  });
  return parseJson(response.raw);
}

async function runJudge(
  config: ItemPipelineConfig,
  deps: ItemPipelineDeps,
  item: WorkItem,
  token: string,
  userContent: string
): Promise<JudgeVerdict> {
  const judge = config.verify.judge!;
  const response = await deps.goose.runMinion({
    minionType: judge.agent,
    systemPrompt: judge.system_prompt,
    userContent,
    sessionId: item.idempotency_key,
    correlationId: item.correlation_id,
    minionToken: token,
  });
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
 * (chain never passed and `on_failure` is `dead_letter`), or `escalated`
 * (chain never passed under `on_failure: escalate`, or the commit was
 * refused). The loop is bounded by `max_attempts`; every attempt's
 * verification results are written to the audit trail under the item's
 * correlation id.
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

  const facts = await classify(config, deps, item, token);

  let lastResults: VerificationResult[] = [];
  let feedback: string[] | undefined;

  for (let attempt = 1; attempt <= config.max_attempts; attempt++) {
    const action = await act(config, deps, item, token, facts, feedback);

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
        ? ({ userContent }) => runJudge(config, deps, item, token, userContent)
        : undefined,
      random,
    });

    lastResults = chain.results;
    writeVerificationAudit(deps, config, item, chain.results, attempt, now);

    if (chain.passed) {
      const commitResult = await commitEffect(config, deps, item, token, action, chain.composite, now);
      if (commitResult.committed) {
        return { status: 'committed', correlationId, attempts: attempt, results: chain.results };
      }
      return {
        status: 'escalated',
        correlationId,
        attempts: attempt,
        results: chain.results,
        reason: commitResult.refused ?? 'commit refused',
      };
    }

    feedback = errorFindings(chain.results).map((finding) => `${finding.id}: ${finding.message}`);
  }

  const reason = `verification failed after ${config.max_attempts} attempt(s)`;
  if (config.on_failure === 'escalate') {
    return { status: 'escalated', correlationId, attempts: config.max_attempts, results: lastResults, reason };
  }
  return { status: 'dead_lettered', correlationId, attempts: config.max_attempts, results: lastResults, reason };
}
