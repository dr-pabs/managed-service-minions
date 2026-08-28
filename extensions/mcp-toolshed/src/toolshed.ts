import { randomUUID, createHash } from 'node:crypto';
import type { SessionStore, PendingApproval, AuditEntry } from 'framework-core';
import { verifyMinionToken, canonicalJson, withSpan } from 'framework-core';
import {
  type AllowlistConfig,
  type GovernanceConfig,
  getCachePolicy,
  isDestructive,
  isPathAllowed,
  isShellCommandAllowed,
  isToolAllowed,
} from './config.js';
import { CircuitBreaker, type CircuitBreakerConfig } from './circuit-breaker.js';
import { type RateLimiter, createRateLimiter } from './rate-limiter.js';
import type { McpServerAdapter } from './adapter.js';
import { type GovernanceStateStore, createInProcessGovernanceStateStore } from './governance-state.js';
import { redactValue, redactSecrets } from './redact.js';
import { recordGovernanceOutcome, recordToolLatency, recordBreakerState } from './telemetry-metrics.js';

export interface ToolContext {
  teamId: string;
  minionType: string;
  /**
   * Session identity as verified from the minion token (Milestone 3).
   * Threaded through so Milestone 6's approval records can key on it
   * instead of the coarser `teamId` (see ExecPlan Decision Log, M4).
   */
  sessionId: string;
  correlationId: string;
  attempt: number;
}

export interface ToolResult {
  status:
    | 'success'
    | 'error'
    | 'blocked_by_allowlist'
    | 'throttled'
    | 'approval_required'
    | 'approval_pending'
    | 'approval_denied'
    | 'approval_timeout';
  data?: unknown;
  error?: string;
  retryAfterSeconds?: number;
  approvalId?: string;
}

export interface ToolshedState {
  allowlists: AllowlistConfig;
  governance: GovernanceConfig;
  store: SessionStore;
  adapters: Map<string, McpServerAdapter>;
  breakers: Map<string, CircuitBreaker>;
  rateLimiter: RateLimiter;
  auditLogger: (entry: AuditEntry) => void | Promise<void>;
  circuitBreakerConfig: CircuitBreakerConfig;
  /**
   * Shared-state seam for rate-limit/breaker/approval operations (H5/F6,
   * ADR-025, ADR-026). By default this is the in-process adapter
   * (`createInProcessGovernanceStateStore`) over the same `rateLimiter`,
   * `breakers`, and `store` fields above; `server.ts` may instead install a
   * shared Azure Table Storage-backed implementation
   * (`createSharedGovernanceStateStore`, Milestone 18) when a connection
   * string is configured, so multiple replicas share one view of rate-limit
   * and breaker state. `executeTool`/`gateDestructiveCall` read and write
   * governance state exclusively through this field rather than reaching into
   * those collaborators directly. See `governance-state.ts` and
   * `shared-governance-state.ts`.
   */
  governanceState: GovernanceStateStore;
  /**
   * Shared HMAC secret used to verify minion identity tokens (Milestone 3,
   * C1/C2 fix). Required to accept a signed `minion_token`; see
   * `verifyAndExecuteTool`.
   */
  signingSecret?: string;
  /**
   * Dev-only escape hatch (`TOOLSHED_ALLOW_UNSIGNED=1`): when true, a caller
   * may fall back to self-reported `minionType`/`teamId`/`sessionId` params
   * instead of a verified token. Always default-off; every use is logged
   * loudly by the caller (`server.ts`) at startup.
   */
  allowUnsignedTokens: boolean;
  /**
   * Invoked once when a NEW pending approval is created for a destructive
   * call (Milestone 4, H3/F1). Typically posts a Slack/Teams Approve/Deny
   * message. Failure here must never lose the approval record — the record
   * is already persisted via `store.createApproval` before this is called,
   * and a rejected/thrown notifier is caught and logged, not surfaced as a
   * tool failure (the approval still exists and can be resolved through the
   * dashboard or a retried notification even if the first chat post failed).
   */
  approvalNotifier?: (approval: PendingApproval, ctx: ToolContext) => Promise<void>;
  /**
   * Injectable clock, matching the pattern already used by the SQLite/memory
   * stores (Milestone 2 Decision Log): read-time approval-timeout evaluation
   * (`timeoutAt` comparison) must never depend on a real timer, so tests can
   * advance a fake clock deterministically instead of sleeping.
   */
  now: () => number;
}

let globalState: ToolshedState | undefined;

export function initializeToolshed(state: ToolshedState): void {
  globalState = state;
}

export function resetToolshed(): void {
  globalState = undefined;
}

export function getToolshedState(): ToolshedState | undefined {
  return globalState;
}

/**
 * `requestHash = sha256(serverAlias + toolName + canonicalJSON(params) +
 * correlationId)` (Milestone 4, H3/F1; ExecPlan Artifacts and Notes pins
 * this contract). Identical resubmission of the same destructive call
 * (same server/tool/params/correlation) hashes identically regardless of
 * incidental key ordering in `params` — see `canonicalJson` in
 * `framework-core` for why plain `JSON.stringify` is not good enough.
 *
 * A NUL byte delimits the four chunks (M4 review finding N2): without it,
 * differently-split inputs like ('github', 'merge_x') and ('githubmerge_x',
 * '') feed byte-identical data to the hash and collide. None of the chunk
 * values can contain a NUL (server aliases/tool names come from the
 * validated registry, canonical JSON escapes control characters as \\u0000,
 * correlation IDs are dot-separated tokens), so the delimiter makes such
 * splits structurally incapable of colliding rather than incidentally
 * prevented by the closed registry.
 */
const HASH_DELIMITER = '\0';

export function computeRequestHash(
  serverAlias: string,
  toolName: string,
  params: unknown,
  correlationId: string
): string {
  return createHash('sha256')
    .update(serverAlias)
    .update(HASH_DELIMITER)
    .update(toolName)
    .update(HASH_DELIMITER)
    .update(canonicalJson(params))
    .update(HASH_DELIMITER)
    .update(correlationId)
    .digest('hex');
}

function cacheKey(ctx: ToolContext, serverAlias: string, toolName: string, params: unknown): string {
  return `${ctx.teamId}:${ctx.minionType}:${serverAlias}:${toolName}:${JSON.stringify(params)}`;
}

function truncate(value: unknown, maxLength: number): string {
  const serialized = value === undefined ? 'undefined' : JSON.stringify(value);
  if (serialized.length <= maxLength) return serialized;
  return `${serialized.slice(0, maxLength)}...[truncated]`;
}

/**
 * Invokes the configured `auditLogger` and swallows any failure — sync
 * throw or rejected promise — so a misbehaving cloud logger (or, in tests,
 * a stub written to throw) can never surface as a tool-call failure. The
 * durable audit write is `store.createAuditEntry`, called synchronously
 * before this, unconditionally; `auditLogger` (in production, a
 * `createRetryingAuditLogger`-wrapped cloud sink — see `cloud-audit.ts`) is
 * a best-effort mirror, not the source of truth (invariant 2 is satisfied
 * by the SQLite write alone).
 */
function safeInvokeAuditLogger(auditLogger: (entry: AuditEntry) => void | Promise<void>, entry: AuditEntry): void {
  try {
    const result = auditLogger(entry);
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch((err) => {
        console.error(`[audit] logger failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  } catch (err) {
    console.error(`[audit] logger failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Resolves a pending approval and records who decided it. This is
 * deliberately NOT exposed as an MCP tool (C1 fix, F2): the old
 * `resolveApproval` was reachable by any minion with no authorization check
 * at all, making self-approval structurally possible. Callers of this
 * function are operator-authenticated surfaces only — the Slack/Teams
 * action handler and the dashboard's approval endpoint (Milestone 4) — each
 * of which authenticates the human first and then calls this with their
 * verified identity.
 */
export function resolveApprovalRecord(
  approvalId: string,
  decision: 'approved' | 'denied',
  approver: { kind: 'slack' | 'teams' | 'dashboard'; id: string }
): ToolResult {
  const state = globalState;
  if (!state) {
    return { status: 'error', error: 'Toolshed not initialized' };
  }
  const approval = state.governanceState.getApproval(approvalId);
  if (!approval) {
    return { status: 'error', error: `Approval ${approvalId} not found` };
  }
  state.governanceState.resolveApproval(approvalId, decision, approver);
  return { status: 'success', data: { approvalId, decision, approver } };
}

/** Caller-supplied identity input to {@link verifyAndExecuteTool}. */
export interface MinionIdentityInput {
  /** Signed token minted by the ingress/orchestrator (Milestone 3). Required unless the dev escape hatch is on. */
  minionToken?: string;
  correlationId: string;
  attempt: number;
  /**
   * Legacy self-reported identity, honored ONLY on the unsigned dev path
   * (`ToolshedState.allowUnsignedTokens` true AND no `minionToken`
   * supplied). When a valid token is present, every one of these is
   * ignored — trusting any of them alongside a token would let a caller
   * with a legitimately minted token still choose its own `teamId`
   * (rate-limit bucket, cache key, approval sessionId, audit teamId),
   * reopening C2.
   */
  legacyMinionType?: string;
  legacyTeamId?: string;
  legacySessionId?: string;
}

function auditRejectedIdentity(
  state: ToolshedState,
  input: MinionIdentityInput,
  serverAlias: string,
  toolName: string,
  error: string
): ToolResult {
  const result: ToolResult = { status: 'error', error };
  const entry: AuditEntry = {
    id: `audit_${randomUUID()}`,
    timestamp: Date.now(),
    correlationId: input.correlationId,
    // No verified identity exists for a rejected token: label the identity
    // fields plainly rather than trust the unverified caller-supplied value
    // (that trust is exactly the C2 bug this milestone fixes). The TARGET of
    // the call (serverAlias/toolName) is known regardless of identity and is
    // recorded so an investigator can see which tool a forged caller was
    // aiming at. This keeps invariant 2 (an audit entry on every exit path)
    // true even for calls that never reach a ToolContext.
    minionType: 'unverified',
    teamId: 'unverified',
    serverAlias,
    toolName,
    params: undefined,
    status: result.status,
    latencyMs: 0,
    // Redacted (M1/F10) for the same reason as emit()'s error handling: the
    // rejection reason string is free text and this is itself an audited
    // exit path (invariant 2), so it must never leak a credential either.
    // `error` is a required string parameter here (not optional, unlike
    // ToolResult.error in general), so no undefined branch to guard.
    error: redactSecrets(result.error!),
  };
  state.store.createAuditEntry(entry);
  safeInvokeAuditLogger(state.auditLogger, entry);
  return result;
}

/**
 * Verifies the minion's identity token and, only on success, runs the
 * governed pipeline (`executeTool`). On the verified branch every identity
 * field of `ToolContext` — `minionType`, `sessionId`, `correlationId`, and
 * `teamId` (derived from the token's `sessionId`; see the ExecPlan Decision
 * Log) — comes exclusively from the verified payload; caller-supplied
 * `legacy*` values are ignored (C2 fix). Verification happens here (inside
 * the pipeline module, not in `server.ts`) specifically so a rejected token
 * is itself an audited exit path, per the toolshed's "audit on every exit
 * path" invariant.
 */
export async function verifyAndExecuteTool(
  input: MinionIdentityInput,
  serverAlias: string,
  toolName: string,
  params: unknown
): Promise<ToolResult> {
  const state = globalState;
  if (!state) {
    return { status: 'error', error: 'Toolshed not initialized' };
  }

  if (input.minionToken) {
    // Refuse outright when no secret is configured: HMAC with an empty key
    // is still a valid MAC, so falling back to '' would VERIFY any token an
    // attacker minted with the empty string — "operator forgot the secret"
    // must fail closed, not open.
    if (!state.signingSecret) {
      return auditRejectedIdentity(
        state,
        input,
        serverAlias,
        toolName,
        'invalid minion token: no signing secret is configured, token cannot be verified'
      );
    }
    const verified = verifyMinionToken(input.minionToken, state.signingSecret);
    if (!verified.ok) {
      return auditRejectedIdentity(state, input, serverAlias, toolName, `invalid minion token: ${verified.reason}`);
    }
    const ctx: ToolContext = {
      // teamId is derived from the token's scope_id (a work-item or session
      // id), never from input.legacyTeamId — the token payload is the pinned
      // identity/v1 claim set {agent_id, scope_id, correlation_id}, and
      // Milestone 6 (M4) adds a distinct teamId to approval records.
      teamId: verified.payload.scope_id,
      minionType: verified.payload.agent_id,
      sessionId: verified.payload.scope_id,
      correlationId: verified.payload.correlation_id,
      attempt: input.attempt,
    };
    return executeTool(ctx, serverAlias, toolName, params);
  }

  if (state.allowUnsignedTokens) {
    const ctx: ToolContext = {
      teamId: input.legacyTeamId ?? 'default',
      minionType: input.legacyMinionType ?? '',
      sessionId: input.legacySessionId ?? input.legacyTeamId ?? 'default',
      correlationId: input.correlationId,
      attempt: input.attempt,
    };
    return executeTool(ctx, serverAlias, toolName, params);
  }

  return auditRejectedIdentity(
    state,
    input,
    serverAlias,
    toolName,
    'invalid minion token: no minion_token supplied and unsigned calls are disabled'
  );
}

/**
 * `ToolResult` -> the milestone's six governance-outcome metric buckets
 * (Milestone 13, M9/F9). Telemetry-only mapping — never consulted by any
 * enforcement decision, only by `recordGovernanceOutcome` inside `emit()`
 * below, which runs identically regardless of whether telemetry is
 * configured (see `telemetry-metrics.ts`'s no-op guarantee).
 *
 * A resumed, previously-approved destructive call returns the SAME
 * `status: 'success'` a non-destructive allowed call does (there is no
 * separate `ToolResult` status for "approved and executed" — see
 * `gateDestructiveCall`'s approved branch) but DOES carry `approvalId`,
 * which is the only signal available to tell the two apart for the
 * `approved` metric bucket the milestone asks for, distinct from the
 * generic `allowed` bucket a plain non-destructive success gets.
 */
function governanceOutcomeForResult(result: ToolResult): import('./telemetry-metrics.js').GovernanceOutcome {
  if (result.status === 'success') {
    return result.approvalId ? 'approved' : 'allowed';
  }
  switch (result.status) {
    case 'blocked_by_allowlist':
      return 'blocked';
    case 'throttled':
      return 'throttled';
    case 'approval_pending':
      return 'approval_requested';
    case 'approval_denied':
    case 'approval_timeout':
      return 'denied';
    case 'error':
    case 'approval_required':
      return 'blocked';
  }
}

/**
 * Governed pipeline entry point, wrapped in an `execute_tool` OTel span
 * (Milestone 13, M9/F9) that nests under whatever span is active on the
 * caller's context (a `minion.run` span, when called via the orchestrator
 * runner's minted-token path) and carries the three required identity
 * attributes. The span wrapper is ADDITIVE ONLY: `doExecuteToolPipeline`
 * below is the untouched enforcement pipeline body (same order, same
 * statuses, same audit calls) — see `toolshed-governance-invariants`.
 */
export async function executeTool(
  ctx: ToolContext,
  serverAlias: string,
  toolName: string,
  params: unknown
): Promise<ToolResult> {
  return withSpan(
    'execute_tool',
    { correlation_id: ctx.correlationId, minion_type: ctx.minionType, session_id: ctx.sessionId },
    () => doExecuteToolPipeline(ctx, serverAlias, toolName, params)
  );
}

async function doExecuteToolPipeline(
  ctx: ToolContext,
  serverAlias: string,
  toolName: string,
  params: unknown
): Promise<ToolResult> {
  const state = globalState;
  if (!state) {
    return { status: 'error', error: 'Toolshed not initialized' };
  }
  const toolshedState = state;

  const start = Date.now();
  const paramsRecord = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : undefined;
  // Secret redaction (M1/F10) runs BEFORE truncate(): truncation is a raw
  // 4KB character cut, so redacting first guarantees a secret is never left
  // half-visible by a truncation boundary landing in the middle of it.
  // redactValue walks the PARSED params (field-aware layer, catches secrets
  // under a sensitive key name regardless of shape), then truncate's own
  // JSON.stringify serializes the already-redacted structure.
  const auditBase: Omit<AuditEntry, 'id' | 'status' | 'latencyMs' | 'error' | 'retryAfterSeconds' | 'approvalId'> = {
    timestamp: start,
    correlationId: ctx.correlationId,
    minionType: ctx.minionType,
    teamId: ctx.teamId,
    serverAlias,
    toolName,
    params: truncate(redactValue(params), 4096),
  };

  function emit(result: ToolResult): ToolResult {
    // result.error is a free-text string (e.g. an adapter's thrown error
    // message) that can itself contain a leaked credential (a REST client
    // echoing back an Authorization header, a connection string in a
    // downstream failure message) — redactSecrets' pattern-scan layer runs
    // on it before truncate, same ordering rationale as params above.
    const redactedError = result.error !== undefined ? redactSecrets(result.error) : undefined;
    const latencyMs = Date.now() - start;
    const entry: AuditEntry = {
      id: `audit_${randomUUID()}`,
      ...auditBase,
      status: result.status,
      latencyMs,
      error: redactedError,
      retryAfterSeconds: result.retryAfterSeconds,
      approvalId: result.approvalId,
    };
    toolshedState.store.createAuditEntry(entry);
    safeInvokeAuditLogger(toolshedState.auditLogger, entry);
    // Telemetry (Milestone 13, M9/F9): additive only, runs AFTER the audit
    // write above on every exit path, mirroring emit()'s own "audit on
    // every exit" invariant but for metrics rather than the durable trail.
    // Never affects `result` or throws into the caller.
    const metricAttrs = { serverAlias, toolName, minionType: ctx.minionType };
    recordGovernanceOutcome(governanceOutcomeForResult(result), metricAttrs);
    recordToolLatency(latencyMs, metricAttrs);
    return result;
  }

  if (!isToolAllowed(toolshedState.allowlists, ctx.minionType, serverAlias, toolName)) {
    return emit({
      status: 'blocked_by_allowlist',
      error: `Tool ${serverAlias}.${toolName} is not allowed for minion ${ctx.minionType}`,
    });
  }

  // Shell governance (H2/F5) runs BEFORE path scope, per the pinned
  // enforcement order (allowlist -> shell-command check -> path scope ->
  // rate limit -> ... -> cache-aware adapter call). Only shell.execute calls
  // carry a raw command string to check; every other tool/server passes
  // through unaffected.
  if (serverAlias === 'shell' && toolName === 'execute') {
    const command = typeof paramsRecord?.command === 'string' ? paramsRecord.command : '';
    const shellCheck = isShellCommandAllowed(toolshedState.allowlists, ctx.minionType, command);
    if (!shellCheck.allowed) {
      return emit({
        status: 'blocked_by_allowlist',
        error: shellCheck.reason,
      });
    }
  }

  const pathCheck = isPathAllowed(toolshedState.allowlists, toolshedState.governance, ctx.minionType, toolName, paramsRecord);
  if (!pathCheck.allowed) {
    return emit({
      status: 'blocked_by_allowlist',
      error: pathCheck.reason,
    });
  }

  // Per-server bucket (H4 fix): governance.yaml's rate_limits block sets a
  // limit per server alias (e.g. github: 30/min) that applies across EVERY
  // tool on that server, not per-tool — a minion hammering two different
  // github tools must still be throttled by the shared github bucket. Falls
  // back to the `default` entry when no per-server entry is configured.
  const serverRateKey = `server:${serverAlias}`;
  const serverRateLimit = toolshedState.governance.rateLimits[serverAlias] ?? toolshedState.governance.rateLimits.default;
  if (serverRateLimit) {
    const serverThrottle = await toolshedState.governanceState.takeRateLimitToken(serverRateKey, serverRateLimit);
    if (!serverThrottle.allowed) {
      return emit({
        status: 'throttled',
        error: 'Rate limit exceeded',
        retryAfterSeconds: serverThrottle.retryAfterSeconds,
      });
    }
  }

  // Fine-grained bucket (pre-existing): team:minion:server:tool, using the
  // `default` limit. Kept in addition to the per-server bucket above, per
  // the pinned enforcement order — both are checked at the rate-limit step.
  const rateKey = `${ctx.teamId}:${ctx.minionType}:${serverAlias}:${toolName}`;
  const rateLimit = await toolshedState.governanceState.takeDefaultRateLimitToken(rateKey);
  if (!rateLimit.allowed) {
    return emit({
      status: 'throttled',
      error: 'Rate limit exceeded',
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
  }

  // Breakers are keyed on serverAlias ALONE (M2 fix), not server:tool: every
  // tool on a server shares the same underlying connection (adapter
  // process), so tripping per-tool would let a failing tool keep hammering
  // an already-unhealthy server connection via its sibling tools' still
  // separately-tracked, still-closed breakers. See README.md for the same
  // statement kept in sync.
  const breakerKey = serverAlias;
  if (!(await toolshedState.governanceState.canExecuteBreaker(breakerKey))) {
    // Breaker-state gauge (Milestone 13, M9/F9): observe-only, recorded
    // alongside the pre-existing open-breaker decision, never influencing
    // it. Ordering (M13 review hardening finding): `emit()` — which writes
    // the audit entry FIRST, before its own telemetry calls — runs before
    // this metric, not after, so the durable audit trail is guaranteed
    // written even if this call were somehow to throw (it also can't, since
    // `recordBreakerState` is itself failure-isolated — see
    // `telemetry-metrics.ts`'s `safeEmit`; this ordering is the second,
    // structural half of the same guarantee, independent of that helper).
    const breakerRetryAfterSeconds = await toolshedState.governanceState.breakerRetryAfterSeconds(breakerKey);
    const result = emit({
      status: 'throttled',
      error: 'Circuit breaker is open',
      retryAfterSeconds: breakerRetryAfterSeconds,
    });
    recordBreakerState(breakerKey, true);
    return result;
  }

  if (isDestructive(toolshedState.governance, serverAlias, toolName, paramsRecord)) {
    return emit(await gateDestructiveCall(toolshedState, ctx, serverAlias, toolName, params, breakerKey));
  }

  return emit(await doExecuteTool(ctx, serverAlias, toolName, params, breakerKey));
}

/**
 * Asynchronous, chat-visible approval gate (Milestone 4, H3/F1 — replaces
 * the old in-call `waitForApproval` poll, which could block for up to the
 * governed timeout with no way to succeed through a real HTTP transport).
 * Returns immediately in every branch; a human decision is applied the next
 * time an IDENTICAL call (same serverAlias/toolName/canonicalJSON(params)/
 * correlationId) is submitted — see `computeRequestHash` and the ExecPlan's
 * Artifacts and Notes for the pinned resume contract.
 */
async function gateDestructiveCall(
  state: ToolshedState,
  ctx: ToolContext,
  serverAlias: string,
  toolName: string,
  params: unknown,
  breakerKey: string
): Promise<Pick<ToolResult, 'status' | 'data' | 'error' | 'approvalId'>> {
  const requestHash = computeRequestHash(serverAlias, toolName, params, ctx.correlationId);
  const existing = state.governanceState.getApprovalByRequestHash(requestHash);

  if (existing && existing.decision === 'approved' && existing.consumedAt === undefined) {
    // Read-time timeout: a decision made after timeoutAt still counts as
    // approved-in-the-store, but the governance timeout window has since
    // elapsed — treat it the same as an unresolved-and-expired approval
    // rather than silently honoring a stale approval.
    if (existing.timeoutAt < state.now()) {
      return { status: 'approval_timeout', approvalId: existing.id, error: 'Approval request timed out' };
    }
    state.governanceState.markApprovalConsumed(existing.id, state.now());
    return { approvalId: existing.id, ...(await doExecuteTool(ctx, serverAlias, toolName, params, breakerKey)) };
  }

  if (existing && existing.decision === 'denied') {
    return {
      status: 'approval_denied',
      approvalId: existing.id,
      error: 'Destructive action was denied by the operator',
    };
  }

  if (existing && existing.decision === undefined) {
    // Still awaiting a human decision. Read-time timeout applies here too:
    // no timers ever fire this — the NEXT identical resubmission is what
    // discovers that timeoutAt has passed.
    if (existing.timeoutAt < state.now()) {
      return { status: 'approval_timeout', approvalId: existing.id, error: 'Approval request timed out' };
    }
    return { status: 'approval_pending', approvalId: existing.id };
  }

  // No live match (none exists, or the only match was already consumed, or
  // timed out and thus no longer eligible to be resumed) — a consumed or
  // timed-out approval never executes twice, so a further identical
  // resubmission always creates a fresh approval rather than reusing an old
  // record's decision.
  const requestedAt = state.now();
  // A random suffix (not just requestedAt) guarantees a fresh id even when
  // two approvals for the same call are created within the same
  // millisecond of an injected/fake clock — e.g. a consumed-then-resubmitted
  // approval created back-to-back in a test with no real time elapsed.
  const approvalId = `appr_${ctx.correlationId}_${serverAlias}_${toolName}_${requestedAt}_${randomUUID()}`;
  const approval: PendingApproval = {
    id: approvalId,
    // M4 fix: sessionId is the verified token's session (ctx.sessionId), NOT
    // ctx.teamId — the pre-M4 code conflated the two. teamId is now its own
    // distinct field on PendingApproval (see framework-core's store.ts).
    sessionId: ctx.sessionId,
    teamId: ctx.teamId,
    correlationId: ctx.correlationId,
    serverAlias,
    toolName,
    paramsJson: JSON.stringify(params),
    requestedAt,
    timeoutAt: requestedAt + state.governance.approvalTimeoutMinutes * 60_000,
    requestHash,
  };
  state.governanceState.createApproval(approval);

  if (state.approvalNotifier) {
    try {
      await state.approvalNotifier(approval, ctx);
    } catch (err) {
      // Notifier failure (e.g. Slack API down) must never lose the approval
      // record — it is already persisted above. An operator can still
      // resolve it via the dashboard, or a future milestone can retry the
      // notification; the tool call itself just reports approval_pending
      // either way.
      console.error(
        `[toolshed] approvalNotifier failed for ${approvalId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return { status: 'approval_pending', approvalId };
}

async function doExecuteTool(
  ctx: ToolContext,
  serverAlias: string,
  toolName: string,
  params: unknown,
  breakerKey: string
): Promise<Pick<ToolResult, 'status' | 'data' | 'error'>> {
  const state = globalState!;

  // Cache is opt-in and read-only: only consult/populate it when the tool's
  // policy in governance.yaml's cache_policy block says cacheable. Anything
  // absent from cache_policy (and everything by default) is never cached, so
  // repeat writes (e.g. github_create_pull_request) always reach the
  // adapter — this is the C3 fix.
  const policy = getCachePolicy(state.governance, toolName);
  const cacheKeyValue = policy.cacheable ? cacheKey(ctx, serverAlias, toolName, params) : undefined;

  if (cacheKeyValue) {
    const cached = state.store.getCachedToolCall(cacheKeyValue);
    if (cached !== undefined) {
      await state.governanceState.recordBreakerSuccess(breakerKey);
      recordBreakerState(breakerKey, false);
      return { status: 'success', data: cached };
    }
  }

  const adapter = state.adapters.get(serverAlias);
  if (!adapter) {
    // M2 fix: an unknown/unregistered server alias is a CONFIG error (the
    // allowlist grants a server with no adapter wired up), not a downstream
    // health signal — it must never feed the circuit breaker. Recording it
    // as a failure would eventually trip the breaker for a server that may
    // be perfectly healthy, purely from repeated misconfigured calls.
    return { status: 'error', error: `Unknown MCP server alias: ${serverAlias}` };
  }

  try {
    // adapter.call span (Milestone 13, M9/F9): the innermost span in the
    // nesting chain (ingress -> orchestrator.run -> minion.run ->
    // execute_tool -> adapter.call), wrapping ONLY the real downstream
    // call -- cache hits above never reach here, matching the milestone's
    // "each adapter call" wording (a cache hit isn't one).
    const data = await withSpan(
      'adapter.call',
      { correlation_id: ctx.correlationId, minion_type: ctx.minionType, session_id: ctx.sessionId, server_alias: serverAlias, tool_name: toolName },
      () => adapter.callTool(toolName, params)
    );
    await state.governanceState.recordBreakerSuccess(breakerKey);
    recordBreakerState(breakerKey, false);
    if (cacheKeyValue) {
      const ttlMs = (policy.ttlSeconds ?? 0) * 1000;
      state.store.setCachedToolCall(cacheKeyValue, data, ttlMs);
    }
    return { status: 'success', data };
  } catch (err) {
    await state.governanceState.recordBreakerFailure(breakerKey);
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

export function createDefaultToolshedState(
  overrides: Partial<ToolshedState> & Pick<ToolshedState, 'store' | 'adapters'>
): ToolshedState {
  const breakers = overrides.breakers ?? new Map<string, CircuitBreaker>();
  const rateLimiter = overrides.rateLimiter ?? createRateLimiter();
  const circuitBreakerConfig = overrides.circuitBreakerConfig ?? {
    failureThreshold: 5,
    successThreshold: 3,
    timeoutSecs: 30,
    halfOpenMaxRequests: 1,
  };
  const store = overrides.store;

  return {
    allowlists: { allowlists: {}, pathScopes: {}, shellCommands: {} },
    governance: {
      destructiveActions: [],
      approvalTimeoutMinutes: 15,
      rateLimits: { default: { requestsPerMinute: 60, burst: 20 } },
      workspaceBoundaries: { allowedBasePaths: ['/repo'], denyPatterns: ['.git/', 'node_modules/', 'secrets/', '.env*'] },
      cachePolicy: { default: { cacheable: false } },
      pathCheckedTools: {},
    },
    breakers,
    rateLimiter,
    auditLogger: (entry) => {
      console.log(`[AUDIT] ${entry.status} ${entry.minionType} ${entry.serverAlias}.${entry.toolName} ${entry.latencyMs}ms`);
    },
    circuitBreakerConfig,
    allowUnsignedTokens: false,
    now: Date.now,
    // Built from the (possibly overridden) rateLimiter/breakers/
    // circuitBreakerConfig/store above so it always reflects the same
    // collaborators `executeTool` reads elsewhere on this state — a caller
    // may still override `governanceState` directly (e.g. to test a future
    // distributed implementation) via `...overrides` below.
    governanceState: createInProcessGovernanceStateStore(rateLimiter, breakers, circuitBreakerConfig, store),
    ...overrides,
  };
}
