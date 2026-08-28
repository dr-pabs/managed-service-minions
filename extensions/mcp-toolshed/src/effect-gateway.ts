import { createHash, randomUUID } from 'node:crypto';
import { verifyMinionToken, type MinionTokenPayload, type PendingApproval } from 'framework-core';
import type { McpServerAdapter, ToolDefinition, HealthStatus } from './adapter.js';
import type { GovernanceConfig } from './config.js';
import {
  createMemoryEffectStore,
  draftRef,
  newDraftId,
  parseDraftRef,
  toAuditView,
  toDecisionRecord,
  type DecisionRecord,
  type EffectActor,
  type EffectDraftRecord,
  type EffectDraftStore,
} from './effect-store.js';
import type { ReviewDecision, SamplingQa } from './sampling-qa.js';

/**
 * Stream effect gateway (ExecPlan Milestone 14) — the TypeScript mirror of
 * Flow's `forge/tools/effect_gateway.py`. Every externally visible side effect
 * exists twice: as an inert `effect_draft` an agent produces via `draft_effect`,
 * then as a `decision_record` the gateway writes when it commits or discards
 * that draft. Agents can only draft; the gateway is the only component holding
 * the connector credentials that reach the outside world, and it commits only
 * when the draft's evidence carries a passing verification result and the actor
 * satisfies the effect type's approval class.
 *
 * The gateway enforces the `effects/v1` invariants itself, fail-closed,
 * regardless of how the surrounding toolshed is configured:
 *   - identity for a commit or discard comes only from the calling context's
 *     verified `identity/v1` token, never from parameters — a smuggled `actor`,
 *     `token`, or `approver_id` is rejected outright;
 *   - a commit requires a passing verification result among the draft's
 *     evidence;
 *   - an `irreversible` (or `always_human`) draft can never carry an agent
 *     actor — a named human, reached through a resolved approval, is required on
 *     commit and on discard alike;
 *   - commits are idempotent on the draft's `idempotency_key`.
 */

export const SERVER_ALIAS = 'effect_gateway';
export const DRAFT_EFFECT = 'draft_effect';
export const COMMIT_EFFECT = 'commit_effect';
export const DISCARD_EFFECT = 'discard_effect';
/**
 * The tool name a post-hoc review approval carries (Milestone 19). Distinct from
 * `commit_effect` because this approval does NOT gate the commit — the commit
 * already happened; a human `approve`/`deny` records `agreed`/`disagreed`.
 */
export const REVIEW_COMMIT = 'review_commit';
export const GATEWAY_TOOLS = [DRAFT_EFFECT, COMMIT_EFFECT, DISCARD_EFFECT] as const;

export const REVERSIBILITY_CLASSES = ['reversible', 'compensatable', 'irreversible'] as const;
export const APPROVAL_CLASSES = ['auto', 'sampled', 'always_human'] as const;

const DEFAULT_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HASH_DELIMITER = '\0';

const DRAFT_FIELDS = [
  'effect_type',
  'target_system',
  'payload',
  'evidence',
  'reversibility',
  'idempotency_key',
  'expiry',
] as const;

// ---------------------------------------------------------------------------
// Effect type policy
// ---------------------------------------------------------------------------

/** Immutable triple binding an effect type to its reversibility and approval class. */
export interface EffectTypePolicy {
  effectType: string;
  reversibility: string;
  approvalClass: string;
}

export function makeEffectTypePolicy(effectType: string, reversibility: string, approvalClass: string): EffectTypePolicy {
  if (!REVERSIBILITY_CLASSES.includes(reversibility as (typeof REVERSIBILITY_CLASSES)[number])) {
    throw new Error(
      `effect type '${effectType}': reversibility must be one of (${REVERSIBILITY_CLASSES.join(', ')}), got '${reversibility}'`
    );
  }
  if (!APPROVAL_CLASSES.includes(approvalClass as (typeof APPROVAL_CLASSES)[number])) {
    throw new Error(
      `effect type '${effectType}': approval_class must be one of (${APPROVAL_CLASSES.join(', ')}), got '${approvalClass}'`
    );
  }
  return { effectType, reversibility, approvalClass };
}

/** A human must decide an `irreversible` draft, or any draft under `always_human`. */
export function requiresHumanActor(policy: { reversibility: string; approvalClass: string }): boolean {
  return policy.reversibility === 'irreversible' || policy.approvalClass === 'always_human';
}

/** Parse a governance `effect_types:` mapping into policies, rejecting malformed entries. */
export function effectTypesFromRecord(data: unknown): Map<string, EffectTypePolicy> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('effect_types must be a mapping');
  }
  const policies = new Map<string, EffectTypePolicy>();
  for (const [effectType, raw] of Object.entries(data as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`effect_types.${effectType} must be a mapping`);
    }
    const entry = raw as Record<string, unknown>;
    const unknown = Object.keys(entry).filter((key) => key !== 'reversibility' && key !== 'approval_class');
    if (unknown.length > 0) {
      throw new Error(
        `effect_types.${effectType}: unknown keys ${unknown.sort().join(', ')} (expected reversibility, approval_class)`
      );
    }
    for (const key of ['reversibility', 'approval_class'] as const) {
      if (!(key in entry)) {
        throw new Error(`effect_types.${effectType}: missing ${key}`);
      }
    }
    policies.set(
      effectType,
      makeEffectTypePolicy(effectType, String(entry.reversibility), String(entry.approval_class))
    );
  }
  return policies;
}

// ---------------------------------------------------------------------------
// Connectors and credentials (secrets agents never see)
// ---------------------------------------------------------------------------

/** Executes an effect against an external system with credentials supplied at call time. */
export interface EffectConnector {
  targetSystem: string;
  execute(effectType: string, payload: Record<string, unknown>, credentials: Record<string, string>): Promise<Record<string, unknown>>;
}

/** Test/sim connector: records what it would have executed (credential names only, never values). */
export class RecordingConnector implements EffectConnector {
  readonly executions: Array<{ effectType: string; payload: Record<string, unknown>; credentialKeys: string[] }> = [];

  constructor(public readonly targetSystem: string) {}

  async execute(
    effectType: string,
    payload: Record<string, unknown>,
    credentials: Record<string, string>
  ): Promise<Record<string, unknown>> {
    this.executions.push({ effectType, payload: { ...payload }, credentialKeys: Object.keys(credentials).sort() });
    return { executed: true, target_system: this.targetSystem };
  }
}

/**
 * The credential vault the gateway hands to a connector at execute time. Secret
 * values never appear in a draft, decision, tool result, approval, or audit
 * row; `toJSON` masks them so a serialised vault leaks nothing.
 */
export class EffectCredentials {
  private readonly secrets: Map<string, string>;

  constructor(entries: Record<string, string> = {}) {
    this.secrets = new Map(Object.entries(entries).filter(([, value]) => value !== ''));
  }

  private envName(system: string): string {
    return `TOOLSHED_EFFECT_${system.toUpperCase()}_API_KEY`;
  }

  /** Credentials for one system: explicit secret first, else the environment; `{}` when unconfigured. */
  forSystem(system: string): Record<string, string> {
    const value = this.secrets.get(system) ?? process.env[this.envName(system)];
    return value ? { [`${system}_api_key`]: value } : {};
  }

  systems(): string[] {
    return Array.from(this.secrets.keys()).sort();
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(Array.from(this.secrets.keys()).map((key) => [key, '***']));
  }
}

// ---------------------------------------------------------------------------
// Verification evidence resolution
// ---------------------------------------------------------------------------

/** A resolved `verification/v1` result behind an evidence reference. */
export interface VerificationView {
  ref: string;
  verifier: string;
  passed: boolean;
  metrics?: Record<string, number>;
  failing?: string[];
}

export interface VerificationResolver {
  resolve(ref: string): VerificationView | null;
}

/** In-memory resolver: evidence references map to verification results. */
export class MapVerificationResolver implements VerificationResolver {
  private readonly views: Map<string, VerificationView>;

  constructor(views: Record<string, VerificationView> = {}) {
    this.views = new Map(Object.entries(views));
  }

  resolve(ref: string): VerificationView | null {
    return this.views.get(ref) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

/**
 * Calling context for a gateway tool. Identity is the raw `identity/v1` token
 * threaded from the verified call; `approvalId` is set only by a governed
 * approval-resume path (an agent can never set it). Never carries an actor or
 * approver name a model authored.
 */
export interface EffectCaller {
  agentId?: string;
  identityToken?: string;
  scopeId?: string;
  correlationId?: string;
  approvalId?: string;
}

/** The subset of the session store the gateway needs for the async approval flow. */
export interface GatewayApprovalStore {
  createApproval(approval: PendingApproval): void;
  getApproval(id: string): PendingApproval | undefined;
  getApprovalByRequestHash(requestHash: string): PendingApproval | undefined;
  markApprovalConsumed(id: string, consumedAt: number): void;
}

/** The evidence view an approver sees attached to an approval request. */
export interface ApprovalEvidenceView {
  draft_ref: string;
  effect_type: string;
  target_system: string;
  reversibility: string;
  approval_class: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  expiry: number;
  requires_human_actor: boolean;
  evidence: Array<{ ref: string; result: VerificationView | null }>;
}

export interface EffectAuditEvent {
  kind: 'effect_draft' | 'effect_commit' | 'effect_discard';
  at: number;
  correlationId: string;
  draftRef: string;
  status: string;
  effectType: string;
  targetSystem: string;
  actor?: EffectActor;
  view: Record<string, unknown>;
}

export interface EffectGatewayOptions {
  store?: EffectDraftStore;
  effectTypes: Map<string, EffectTypePolicy>;
  connectors?: Map<string, EffectConnector>;
  credentials?: EffectCredentials;
  approvalStore?: GatewayApprovalStore;
  /** Shared HMAC secret verifying `identity/v1` tokens. Empty means no commit or discard can proceed. */
  signingSecret?: string;
  evidenceResolver?: VerificationResolver;
  /** Posts an approve/deny notification (Slack/Teams) for an `always_human`/`sampled` commit. */
  approvalNotifier?: (approval: PendingApproval, evidence: ApprovalEvidenceView) => Promise<void>;
  /** Selects which `sampled` commits route to human review; default never samples. */
  sampler?: (record: EffectDraftRecord) => boolean;
  /** Post-hoc sampling QA loop (Milestone 19): samples auto-commits for review and trips auto-commit off on a high disagreement rate. */
  qa?: SamplingQa;
  auditLogger?: (event: EffectAuditEvent) => void;
  approvalTimeoutMinutes?: number;
  now?: () => number;
}

export interface DraftEffectResult {
  drafted: boolean;
  refused?: string;
  draftRef?: string;
  reversibility?: string;
  approvalClass?: string;
  expiry?: number;
}

export interface CommitEffectResult {
  committed: boolean;
  refused?: string;
  approvalPending?: boolean;
  approvalId?: string;
  idempotentReplay?: boolean;
  decision?: DecisionRecord;
  outcome?: Record<string, unknown>;
}

export interface DiscardEffectResult {
  discarded: boolean;
  refused?: string;
  idempotentReplay?: boolean;
  decision?: DecisionRecord;
}

type HumanResolution = { actor?: EffectActor; problem?: string; pending?: boolean; approvalId?: string };

export class EffectGateway {
  private readonly store: EffectDraftStore;
  private readonly effectTypes: Map<string, EffectTypePolicy>;
  private readonly connectors: Map<string, EffectConnector>;
  private readonly credentials: EffectCredentials;
  private readonly approvalStore?: GatewayApprovalStore;
  private readonly signingSecret: string;
  private readonly evidenceResolver?: VerificationResolver;
  private readonly approvalNotifier?: (approval: PendingApproval, evidence: ApprovalEvidenceView) => Promise<void>;
  private readonly sampler: (record: EffectDraftRecord) => boolean;
  private readonly qa?: SamplingQa;
  private readonly auditLogger?: (event: EffectAuditEvent) => void;
  private readonly approvalTimeoutMinutes: number;
  private readonly now: () => number;
  private decisionChain: Promise<void> = Promise.resolve();

  constructor(options: EffectGatewayOptions) {
    this.store = options.store ?? createMemoryEffectStore(options.now);
    this.effectTypes = options.effectTypes;
    this.connectors = options.connectors ?? new Map();
    this.credentials = options.credentials ?? new EffectCredentials();
    this.approvalStore = options.approvalStore;
    this.signingSecret = options.signingSecret ?? '';
    this.evidenceResolver = options.evidenceResolver;
    this.approvalNotifier = options.approvalNotifier;
    this.sampler = options.sampler ?? (() => false);
    this.qa = options.qa;
    this.auditLogger = options.auditLogger;
    this.approvalTimeoutMinutes = options.approvalTimeoutMinutes ?? 15;
    this.now = options.now ?? Date.now;
  }

  // --- draft_effect --------------------------------------------------------

  async draftEffect(params: unknown, caller?: EffectCaller): Promise<DraftEffectResult> {
    const validation = this.validateDraftParams(params);
    if (validation.refused !== undefined) {
      return { drafted: false, refused: validation.refused };
    }
    const { fields, policy } = validation;

    let drafterAgentId = caller?.agentId ?? '';
    let drafterVerified = false;
    if (caller && this.signingSecret && caller.identityToken) {
      const verified = verifyMinionToken(caller.identityToken, this.signingSecret);
      if (verified.ok && (caller.agentId === undefined || verified.payload.agent_id === caller.agentId)) {
        drafterVerified = true;
        drafterAgentId = verified.payload.agent_id;
      }
    }

    const nowMs = this.now();
    const record: EffectDraftRecord = {
      id: newDraftId(),
      sessionId: caller?.scopeId ?? '',
      correlationId: caller?.correlationId ?? '',
      drafterAgentId,
      drafterVerified,
      effectType: fields.effectType,
      targetSystem: fields.targetSystem,
      payload: fields.payload,
      evidence: fields.evidence,
      reversibility: policy.reversibility,
      approvalClass: policy.approvalClass,
      idempotencyKey: fields.idempotencyKey,
      expiry: fields.expiry ?? nowMs + DEFAULT_DRAFT_TTL_MS,
      status: 'draft',
      createdAt: nowMs,
    };
    this.store.saveDraft(record);
    this.audit('effect_draft', record);
    return {
      drafted: true,
      draftRef: draftRef(record.id),
      reversibility: policy.reversibility,
      approvalClass: policy.approvalClass,
      expiry: record.expiry,
    };
  }

  private validateDraftParams(
    params: unknown
  ):
    | { refused: string; fields?: undefined; policy?: undefined }
    | {
        refused?: undefined;
        fields: {
          effectType: string;
          targetSystem: string;
          payload: Record<string, unknown>;
          evidence: string[];
          reversibility: string;
          idempotencyKey: string;
          expiry?: number;
        };
        policy: EffectTypePolicy;
      } {
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return { refused: 'draft parameters must be a JSON object' };
    }
    const p = params as Record<string, unknown>;
    const unknown = Object.keys(p).filter((key) => !DRAFT_FIELDS.includes(key as (typeof DRAFT_FIELDS)[number]));
    if (unknown.length > 0) {
      return {
        refused: `unknown draft fields: ${unknown.sort().join(', ')} (expected: ${DRAFT_FIELDS.join(', ')})`,
      };
    }
    for (const field of ['effect_type', 'target_system', 'reversibility', 'idempotency_key'] as const) {
      if (typeof p[field] !== 'string' || (p[field] as string).length === 0) {
        return { refused: `'${field}' must be a non-empty string` };
      }
    }
    const effectType = p.effect_type as string;
    const reversibility = p.reversibility as string;
    const policy = this.effectTypes.get(effectType);
    if (!policy) {
      return {
        refused: `effect type '${effectType}' has no governance policy (declare it under effect_types) — refusing by default`,
      };
    }
    if (reversibility !== policy.reversibility) {
      return {
        refused: `reversibility '${reversibility}' disagrees with the declared class '${policy.reversibility}' for effect type '${effectType}'`,
      };
    }
    if (typeof p.payload !== 'object' || p.payload === null || Array.isArray(p.payload)) {
      return { refused: "'payload' must be a JSON object" };
    }
    if (!('evidence' in p)) {
      return { refused: "'evidence' is required (an empty array is valid — it simply can never be committed)" };
    }
    if (!Array.isArray(p.evidence) || !p.evidence.every((item) => typeof item === 'string' && item.length > 0)) {
      return { refused: "'evidence' must be an array of non-empty strings" };
    }
    let expiry: number | undefined;
    if ('expiry' in p) {
      if (typeof p.expiry !== 'number' || !Number.isInteger(p.expiry)) {
        return { refused: "'expiry' must be an integer (epoch milliseconds)" };
      }
      const nowMs = this.now();
      if (p.expiry <= nowMs) {
        return { refused: "'expiry' must be in the future" };
      }
      if (p.expiry > nowMs + MAX_DRAFT_TTL_MS) {
        return { refused: `'expiry' may be at most ${MAX_DRAFT_TTL_MS} ms ahead (seven days)` };
      }
      expiry = p.expiry;
    }
    return {
      fields: {
        effectType,
        targetSystem: p.target_system as string,
        payload: { ...(p.payload as Record<string, unknown>) },
        evidence: [...(p.evidence as string[])],
        reversibility,
        idempotencyKey: p.idempotency_key as string,
        expiry,
      },
      policy,
    };
  }

  // --- commit_effect -------------------------------------------------------

  async commitEffect(params: unknown, caller?: EffectCaller): Promise<CommitEffectResult> {
    return this.withDecisionLock(() => this.doCommit(params, caller));
  }

  private async doCommit(params: unknown, caller?: EffectCaller): Promise<CommitEffectResult> {
    const ref = refOf(params);

    const identity = this.verifiedCaller(caller);
    if (identity.problem !== undefined) {
      return refusedCommit(ref, identity.problem);
    }

    const loaded = this.loadDraft(ref);
    if (loaded.problem !== undefined) {
      return refusedCommit(ref, loaded.problem);
    }
    const record = loaded.record;

    // Idempotent replay before any gating: an already-committed draft (or a
    // sibling sharing the key) returns the recorded outcome without re-executing.
    if (record.status === 'committed') {
      return committedReplay(record);
    }
    const sibling = this.store.findByIdempotencyKey(record.idempotencyKey);
    if (sibling && sibling.status === 'committed') {
      return committedReplay(sibling);
    }
    if (record.status === 'discarded') {
      return refusedCommit(ref, `draft '${ref}' was already discarded`);
    }

    if (record.expiry <= this.now()) {
      return refusedCommit(ref, 'draft expired — refusing to commit');
    }

    const evidence = this.resolveEvidence(record);
    if (!evidence.some((entry) => entry.result?.passed === true)) {
      return refusedCommit(
        ref,
        `no passing verification result among the draft's evidence ${JSON.stringify(record.evidence)} — a commit requires one`
      );
    }

    const humanRequired = requiresHumanActor(record);
    // Milestone 19: a tripped sampling-QA breaker disables auto-commit for the
    // type, forcing a pre-commit human approval exactly like `always_human`.
    const forcedByQaBreaker = !humanRequired && this.qa?.isTripped(record.effectType) === true;
    const sampledForReview = !humanRequired && !forcedByQaBreaker && record.approvalClass === 'sampled' && this.sampler(record);
    let actor: EffectActor;
    if (humanRequired || forcedByQaBreaker || sampledForReview) {
      const resolution = await this.resolveCommitApproval(caller, record, evidence);
      if (resolution.pending) {
        return { committed: false, approvalPending: true, approvalId: resolution.approvalId };
      }
      if (resolution.problem !== undefined || !resolution.actor) {
        const clause = humanRequired
          ? `is ${record.reversibility} under approval class '${record.approvalClass}'`
          : forcedByQaBreaker
            ? `has auto-commit disabled by the sampling-QA circuit breaker`
            : `was sampled for human review under approval class '${record.approvalClass}'`;
        return refusedCommit(ref, `effect type '${record.effectType}' ${clause} — ${resolution.problem}`);
      }
      actor = resolution.actor;
    } else {
      actor = agentActor(identity.identity);
    }

    const connector = this.connectors.get(record.targetSystem);
    if (!connector) {
      return refusedCommit(ref, `no connector mounted for target system '${record.targetSystem}' — effect not executed`);
    }

    const outcome = await connector.execute(
      record.effectType,
      record.payload,
      this.credentials.forSystem(record.targetSystem)
    );

    const wrote = this.store.recordDecision(record.id, {
      status: 'committed',
      actor,
      outcome,
      decidedAt: this.now(),
    });
    if (!wrote) {
      // Lost the race — a concurrent commit already decided this draft.
      const current = this.store.getDraft(record.id);
      if (current && current.status === 'committed') {
        return committedReplay(current);
      }
      return refusedCommit(ref, `draft '${ref}' was already discarded`);
    }

    const decided = this.store.getDraft(record.id)!;
    this.audit('effect_commit', decided);
    // Milestone 19: an agent-actor commit (no human in the loop) is a candidate
    // for post-hoc sampling QA. Routing is non-blocking and after the fact — the
    // commit already succeeded; the review only feeds the disagreement breaker.
    if (actor.kind === 'agent') {
      this.routePostHocReview(record, evidence);
    }
    return {
      committed: true,
      idempotentReplay: false,
      decision: toDecisionRecord(decided),
      outcome,
    };
  }

  // --- discard_effect ------------------------------------------------------

  async discardEffect(params: unknown, caller?: EffectCaller): Promise<DiscardEffectResult> {
    return this.withDecisionLock(() => this.doDiscard(params, caller));
  }

  private async doDiscard(params: unknown, caller?: EffectCaller): Promise<DiscardEffectResult> {
    const ref = refOf(params);

    const identity = this.verifiedCaller(caller);
    if (identity.problem !== undefined) {
      return { discarded: false, refused: identity.problem };
    }

    const loaded = this.loadDraft(ref);
    if (loaded.problem !== undefined) {
      return { discarded: false, refused: loaded.problem };
    }
    const record = loaded.record;

    if (record.status === 'committed') {
      return { discarded: false, refused: `draft '${ref}' was already committed` };
    }
    if (record.status === 'discarded') {
      return { discarded: true, idempotentReplay: true, decision: toDecisionRecord(record) };
    }

    const reason = paramValue(params, 'reason');
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      return {
        discarded: false,
        refused: "discard requires a non-empty 'reason' (effects/v1: the audit trail must say why work was abandoned)",
      };
    }

    let actor: EffectActor;
    if (requiresHumanActor(record)) {
      const resolution = this.resolveDiscardApproval(caller, record);
      if (resolution.problem !== undefined || !resolution.actor) {
        return {
          discarded: false,
          refused: `effect type '${record.effectType}' requires a human decision on discard too — ${resolution.problem}`,
        };
      }
      actor = resolution.actor;
    } else {
      actor = agentActor(identity.identity);
    }

    const wrote = this.store.recordDecision(record.id, {
      status: 'discarded',
      actor,
      reason,
      decidedAt: this.now(),
    });
    if (!wrote) {
      const current = this.store.getDraft(record.id);
      if (current && current.status === 'discarded') {
        return { discarded: true, idempotentReplay: true, decision: toDecisionRecord(current) };
      }
      return { discarded: false, refused: `draft '${ref}' was already committed` };
    }

    const decided = this.store.getDraft(record.id)!;
    this.audit('effect_discard', decided);
    return { discarded: true, idempotentReplay: false, decision: toDecisionRecord(decided) };
  }

  // --- shared internals ----------------------------------------------------

  private verifiedCaller(caller?: EffectCaller): { identity: MinionTokenPayload; problem?: undefined } | { identity?: undefined; problem: string } {
    if (!this.signingSecret) {
      return {
        problem: 'identity verification is not configured (set TOOLSHED_SIGNING_SECRET) — no commit or discard can proceed',
      };
    }
    if (!caller) {
      return { problem: 'missing calling context — identity cannot be verified' };
    }
    const token = caller.identityToken ?? '';
    if (!token) {
      return { problem: 'identity rejected: missing identity token' };
    }
    const verified = verifyMinionToken(token, this.signingSecret);
    if (!verified.ok) {
      return { problem: `identity rejected: ${verified.reason}` };
    }
    const payload = verified.payload;
    if (caller.agentId !== undefined && payload.agent_id !== caller.agentId) {
      return { problem: `identity rejected: token is for agent '${payload.agent_id}', caller presented '${caller.agentId}'` };
    }
    if (caller.scopeId !== undefined && payload.scope_id !== caller.scopeId) {
      return { problem: `identity rejected: token is scoped to '${payload.scope_id}', caller is on '${caller.scopeId}'` };
    }
    return { identity: payload };
  }

  private loadDraft(ref: string): { record: EffectDraftRecord; problem?: undefined } | { record?: undefined; problem: string } {
    if (!ref.startsWith('draft://')) {
      return { problem: "'draft_ref' must be a draft://<id> reference" };
    }
    const record = this.store.getDraft(parseDraftRef(ref));
    if (!record) {
      return { problem: `unknown draft '${ref}'` };
    }
    return { record };
  }

  private resolveEvidence(record: EffectDraftRecord): Array<{ ref: string; result: VerificationView | null }> {
    return record.evidence.map((ref) => ({ ref, result: this.evidenceResolver?.resolve(ref) ?? null }));
  }

  private async resolveCommitApproval(
    caller: EffectCaller | undefined,
    record: EffectDraftRecord,
    evidence: Array<{ ref: string; result: VerificationView | null }>
  ): Promise<HumanResolution> {
    const ref = draftRef(record.id);

    // Direct dashboard-resolved approval carried on the calling context.
    if (caller?.approvalId) {
      if (!this.approvalStore) {
        return { problem: 'no approval store is configured for the gateway' };
      }
      const approval = this.approvalStore.getApproval(caller.approvalId);
      return this.humanActorFromApproval(approval, caller.approvalId, COMMIT_EFFECT, ref);
    }

    // Async, resume-by-resubmit approval flow (the toolshed's existing model).
    if (!this.approvalStore) {
      return { problem: 'no approval store is configured for the gateway' };
    }
    const requestHash = this.commitRequestHash(record);
    const existing = this.approvalStore.getApprovalByRequestHash(requestHash);

    if (existing && existing.decision === 'approved' && existing.consumedAt === undefined) {
      if (existing.timeoutAt < this.now()) {
        return { problem: 'the approval request timed out' };
      }
      const resolved = this.humanActorFromApproval(existing, existing.id, COMMIT_EFFECT, ref);
      if (resolved.actor) {
        this.approvalStore.markApprovalConsumed(existing.id, this.now());
      }
      return resolved;
    }
    if (existing && existing.decision === 'denied') {
      return { problem: 'the approval request was denied by the operator' };
    }
    if (existing && existing.decision === undefined) {
      if (existing.timeoutAt < this.now()) {
        return { problem: 'the approval request timed out' };
      }
      return { pending: true, approvalId: existing.id };
    }

    const approval = this.buildApproval(record, requestHash);
    this.approvalStore.createApproval(approval);
    await this.notify(approval, this.approvalEvidenceView(record, evidence));
    return { pending: true, approvalId: approval.id };
  }

  private resolveDiscardApproval(caller: EffectCaller | undefined, record: EffectDraftRecord): HumanResolution {
    if (!caller?.approvalId) {
      return { problem: 'a human actor is required, but the call did not arrive through a resolved approval' };
    }
    if (!this.approvalStore) {
      return { problem: 'no approval store is configured for the gateway' };
    }
    const approval = this.approvalStore.getApproval(caller.approvalId);
    return this.humanActorFromApproval(approval, caller.approvalId, DISCARD_EFFECT, draftRef(record.id));
  }

  private humanActorFromApproval(
    approval: PendingApproval | undefined,
    id: string,
    tool: string,
    ref: string
  ): HumanResolution {
    if (!approval) {
      return { problem: `approval '${id}' not found` };
    }
    if (approval.decision !== 'approved') {
      return { problem: `approval '${id}' is '${approval.decision ?? 'pending'}', not approved` };
    }
    if (approval.serverAlias !== SERVER_ALIAS || approval.toolName !== tool) {
      return { problem: `approval '${id}' authorises ${approval.serverAlias}.${approval.toolName}, not ${SERVER_ALIAS}.${tool}` };
    }
    const boundRef = draftRefOfParams(approval.paramsJson);
    if (boundRef !== undefined && boundRef !== ref) {
      return { problem: `approval '${id}' authorises draft '${boundRef}', not '${ref}'` };
    }
    const approver = approval.approverId ?? '';
    if (!approver) {
      return {
        problem: `approval '${id}' was resolved without an authenticated approver identity — refusing to attribute the decision to an unnamed human`,
      };
    }
    return { actor: { kind: 'human', approver_id: approver } };
  }

  /**
   * Milestone 19: after an agent-actor commit, route a configurable percentage
   * of the type's commits to post-hoc review through the existing approval
   * surface (a `PendingApproval` of tool name `review_commit`, notified the same
   * way a pre-commit `always_human`/`sampled` approval is). This is non-blocking
   * and best-effort: the commit has already happened, so a missing approval
   * store or a failed notifier must never fail the commit — the review simply
   * is not created.
   */
  private routePostHocReview(
    record: EffectDraftRecord,
    evidence: Array<{ ref: string; result: VerificationView | null }>
  ): void {
    if (!this.qa || !this.qa.shouldReview(record.effectType)) {
      return;
    }
    if (!this.approvalStore) {
      return;
    }
    const requestedAt = this.now();
    const approval: PendingApproval = {
      id: `appr_${record.correlationId}_${SERVER_ALIAS}_${REVIEW_COMMIT}_${requestedAt}_${randomUUID()}`,
      sessionId: record.sessionId,
      teamId: record.sessionId,
      correlationId: record.correlationId,
      serverAlias: SERVER_ALIAS,
      toolName: REVIEW_COMMIT,
      paramsJson: JSON.stringify({ draft_ref: draftRef(record.id), effect_type: record.effectType }),
      requestedAt,
      timeoutAt: requestedAt + this.approvalTimeoutMinutes * 60_000,
      requestHash: this.reviewRequestHash(record),
    };
    this.approvalStore.createApproval(approval);
    void this.notify(approval, this.approvalEvidenceView(record, evidence));
  }

  /**
   * Records a reviewer's verdict on a `review_commit` approval into the QA loop
   * (`approved` -> `agreed`, `denied` -> `disagreed`), tripping the breaker if
   * the disagreement rate crosses the type's threshold. Returns the updated
   * stat, or `undefined` when the approval is not a post-hoc review (or no QA
   * loop is configured). This is the seam the approval-resolution surface
   * (dashboard / Slack / Teams) calls after a human decides.
   */
  recordReviewVerdict(approvalId: string, decision: ReviewDecision): ReturnType<SamplingQa['recordVerdict']> | undefined {
    if (!this.qa || !this.approvalStore) {
      return undefined;
    }
    const approval = this.approvalStore.getApproval(approvalId);
    if (!approval || approval.serverAlias !== SERVER_ALIAS || approval.toolName !== REVIEW_COMMIT) {
      return undefined;
    }
    const effectType = effectTypeOfParams(approval.paramsJson);
    if (effectType === undefined) {
      return undefined;
    }
    return this.qa.recordVerdict({
      effectType,
      correlationId: approval.correlationId,
      draftRef: draftRefOfParams(approval.paramsJson) ?? '',
      decision,
      reviewedAt: this.now(),
    });
  }

  private reviewRequestHash(record: EffectDraftRecord): string {
    return createHash('sha256')
      .update(SERVER_ALIAS)
      .update(HASH_DELIMITER)
      .update(REVIEW_COMMIT)
      .update(HASH_DELIMITER)
      .update(draftRef(record.id))
      .update(HASH_DELIMITER)
      .update(record.correlationId)
      .digest('hex');
  }

  private commitRequestHash(record: EffectDraftRecord): string {
    return createHash('sha256')
      .update(SERVER_ALIAS)
      .update(HASH_DELIMITER)
      .update(COMMIT_EFFECT)
      .update(HASH_DELIMITER)
      .update(draftRef(record.id))
      .update(HASH_DELIMITER)
      .update(record.correlationId)
      .digest('hex');
  }

  private buildApproval(record: EffectDraftRecord, requestHash: string): PendingApproval {
    const requestedAt = this.now();
    const id = `appr_${record.correlationId}_${SERVER_ALIAS}_${COMMIT_EFFECT}_${requestedAt}_${randomUUID()}`;
    return {
      id,
      sessionId: record.sessionId,
      teamId: record.sessionId,
      correlationId: record.correlationId,
      serverAlias: SERVER_ALIAS,
      toolName: COMMIT_EFFECT,
      paramsJson: JSON.stringify({ draft_ref: draftRef(record.id) }),
      requestedAt,
      timeoutAt: requestedAt + this.approvalTimeoutMinutes * 60_000,
      requestHash,
    };
  }

  private approvalEvidenceView(
    record: EffectDraftRecord,
    evidence: Array<{ ref: string; result: VerificationView | null }>
  ): ApprovalEvidenceView {
    return {
      draft_ref: draftRef(record.id),
      effect_type: record.effectType,
      target_system: record.targetSystem,
      reversibility: record.reversibility,
      approval_class: record.approvalClass,
      idempotency_key: record.idempotencyKey,
      payload: { ...record.payload },
      expiry: record.expiry,
      requires_human_actor: requiresHumanActor(record),
      evidence,
    };
  }

  private async notify(approval: PendingApproval, evidence: ApprovalEvidenceView): Promise<void> {
    if (!this.approvalNotifier) {
      return;
    }
    try {
      await this.approvalNotifier(approval, evidence);
    } catch (err) {
      console.error(
        `[effect-gateway] approvalNotifier failed for ${approval.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private audit(kind: EffectAuditEvent['kind'], record: EffectDraftRecord): void {
    if (!this.auditLogger) {
      return;
    }
    this.auditLogger({
      kind,
      at: this.now(),
      correlationId: record.correlationId,
      draftRef: draftRef(record.id),
      status: record.status,
      effectType: record.effectType,
      targetSystem: record.targetSystem,
      actor: record.decisionActor,
      view: toAuditView(record),
    });
  }

  private withDecisionLock<T>(fn: () => Promise<T>): Promise<T> {
    // The chain is always resolved (normalised below), so `fn` always runs.
    const run = this.decisionChain.then(() => fn());
    // Keep the chain alive regardless of fn's outcome, without surfacing its
    // rejection on the chain itself — the next decision still serialises after it.
    this.decisionChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  // --- MCP adapter surface -------------------------------------------------

  /** Mounts the gateway as the in-process `effect_gateway` MCP server. */
  adapter(): McpServerAdapter & { callToolAs(name: string, params: unknown, caller: EffectCaller): Promise<unknown> } {
    return {
      alias: SERVER_ALIAS,
      health: async (): Promise<HealthStatus> => ({ healthy: true, latencyMs: 0 }),
      listTools: async (): Promise<ToolDefinition[]> => gatewayToolDefinitions(),
      // A context-less adapter call carries no verified identity, so any commit
      // or discard is refused; drafting still works (it is inert).
      callTool: async (name: string, params: unknown): Promise<unknown> => this.dispatch(name, params, undefined),
      callToolAs: async (name: string, params: unknown, caller: EffectCaller): Promise<unknown> =>
        this.dispatch(name, params, caller),
    };
  }

  async dispatch(name: string, params: unknown, caller?: EffectCaller): Promise<unknown> {
    switch (name) {
      case DRAFT_EFFECT:
        return this.draftEffect(params, caller);
      case COMMIT_EFFECT:
        return this.commitEffect(params, caller);
      case DISCARD_EFFECT:
        return this.discardEffect(params, caller);
      default:
        return { error: `unknown tool '${name}'` };
    }
  }
}

// ---------------------------------------------------------------------------
// Governance wiring
// ---------------------------------------------------------------------------

/**
 * Pins `effect_gateway.commit_effect` as a destructive action so a commit always
 * surfaces a human-visible approval, even under an empty governance file.
 * Idempotent; discard is deliberately NOT destructive.
 */
export function ensureEffectGatewayRules(governance: GovernanceConfig): GovernanceConfig {
  const present = governance.destructiveActions.some(
    (action) => action.serverAlias === SERVER_ALIAS && action.toolName === COMMIT_EFFECT
  );
  if (!present) {
    governance.destructiveActions.push({ serverAlias: SERVER_ALIAS, toolName: COMMIT_EFFECT });
  }
  return governance;
}

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

function agentActor(identity: MinionTokenPayload): EffectActor {
  return { kind: 'agent', token_payload: identity };
}

function refOf(params: unknown): string {
  const value = paramValue(params, 'draft_ref');
  return typeof value === 'string' ? value : '';
}

function paramValue(params: unknown, key: string): unknown {
  if (typeof params !== 'object' || params === null) {
    return undefined;
  }
  return (params as Record<string, unknown>)[key];
}

function draftRefOfParams(paramsJson: string): string | undefined {
  try {
    const parsed = JSON.parse(paramsJson);
    if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).draft_ref === 'string') {
      return (parsed as Record<string, string>).draft_ref;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function effectTypeOfParams(paramsJson: string): string | undefined {
  try {
    const parsed = JSON.parse(paramsJson);
    if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).effect_type === 'string') {
      return (parsed as Record<string, string>).effect_type;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function refusedCommit(_ref: string, reason: string): CommitEffectResult {
  return { committed: false, refused: reason };
}

function committedReplay(record: EffectDraftRecord): CommitEffectResult {
  return {
    committed: true,
    idempotentReplay: true,
    decision: toDecisionRecord(record),
    outcome: record.outcome,
  };
}

function gatewayToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: DRAFT_EFFECT,
      description: 'Produce an effect draft (inert until committed by the gateway).',
      inputSchema: {
        type: 'object',
        properties: {
          effect_type: { type: 'string' },
          target_system: { type: 'string' },
          payload: { type: 'object' },
          evidence: { type: 'array', items: { type: 'string' } },
          reversibility: { type: 'string', enum: [...REVERSIBILITY_CLASSES] },
          idempotency_key: { type: 'string' },
          expiry: { type: 'integer' },
        },
        required: ['effect_type', 'target_system', 'payload', 'evidence', 'reversibility', 'idempotency_key'],
      },
    },
    {
      name: COMMIT_EFFECT,
      description: 'Commit a draft (gateway-only; requires passing evidence and approval class).',
      inputSchema: {
        type: 'object',
        properties: { draft_ref: { type: 'string' }, reason: { type: 'string' } },
        required: ['draft_ref'],
      },
    },
    {
      name: DISCARD_EFFECT,
      description: 'Discard a draft without effect (reason required).',
      inputSchema: {
        type: 'object',
        properties: { draft_ref: { type: 'string' }, reason: { type: 'string' } },
        required: ['draft_ref', 'reason'],
      },
    },
  ];
}
