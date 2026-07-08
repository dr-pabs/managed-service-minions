import { randomUUID, createHash } from 'node:crypto';
import type { SessionStore, PendingApproval, AuditEntry } from 'framework-core';
import { verifyMinionToken, canonicalJson } from 'framework-core';
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

function getBreaker(
  breakers: Map<string, CircuitBreaker>,
  config: CircuitBreakerConfig,
  key: string
): CircuitBreaker {
  let breaker = breakers.get(key);
  if (!breaker) {
    breaker = new CircuitBreaker(config);
    breakers.set(key, breaker);
  }
  return breaker;
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
  const approval = state.store.getApproval(approvalId);
  if (!approval) {
    return { status: 'error', error: `Approval ${approvalId} not found` };
  }
  state.store.resolveApproval(approvalId, decision, approver);
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
    error: result.error,
  };
  state.store.createAuditEntry(entry);
  Promise.resolve()
    .then(() => state.auditLogger(entry))
    .catch((err) => {
      console.error(`[audit] logger failed: ${err instanceof Error ? err.message : String(err)}`);
    });
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
      // teamId is derived from the token's sessionId, never from
      // input.legacyTeamId — the token payload stays at the pinned
      // three-field format {minionType, sessionId, correlationId}, and
      // Milestone 6 (M4) adds a distinct teamId to approval records.
      teamId: verified.payload.sessionId,
      minionType: verified.payload.minionType,
      sessionId: verified.payload.sessionId,
      correlationId: verified.payload.correlationId,
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

export async function executeTool(
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
  const auditBase: Omit<AuditEntry, 'id' | 'status' | 'latencyMs' | 'error' | 'retryAfterSeconds' | 'approvalId'> = {
    timestamp: start,
    correlationId: ctx.correlationId,
    minionType: ctx.minionType,
    teamId: ctx.teamId,
    serverAlias,
    toolName,
    params: truncate(params, 4096),
  };

  function emit(result: ToolResult): ToolResult {
    const entry: AuditEntry = {
      id: `audit_${randomUUID()}`,
      ...auditBase,
      status: result.status,
      latencyMs: Date.now() - start,
      error: result.error,
      retryAfterSeconds: result.retryAfterSeconds,
      approvalId: result.approvalId,
    };
    toolshedState.store.createAuditEntry(entry);
    Promise.resolve()
      .then(() => toolshedState.auditLogger(entry))
      .catch((err) => {
        console.error(`[audit] logger failed: ${err instanceof Error ? err.message : String(err)}`);
      });
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

  const rateKey = `${ctx.teamId}:${ctx.minionType}:${serverAlias}:${toolName}`;
  const rateLimit = toolshedState.rateLimiter.canExecute(rateKey);
  if (!rateLimit.allowed) {
    return emit({
      status: 'throttled',
      error: 'Rate limit exceeded',
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
  }

  const breakerKey = `${serverAlias}:${toolName}`;
  const breaker = getBreaker(toolshedState.breakers, toolshedState.circuitBreakerConfig, breakerKey);
  if (!breaker.canExecute()) {
    return emit({
      status: 'throttled',
      error: 'Circuit breaker is open',
      retryAfterSeconds: breaker.retryAfterSeconds,
    });
  }

  if (isDestructive(toolshedState.governance, serverAlias, toolName, paramsRecord)) {
    return emit(await gateDestructiveCall(toolshedState, ctx, serverAlias, toolName, params, breaker));
  }

  return emit(await doExecuteTool(ctx, serverAlias, toolName, params, breaker));
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
  breaker: CircuitBreaker
): Promise<Pick<ToolResult, 'status' | 'data' | 'error' | 'approvalId'>> {
  const requestHash = computeRequestHash(serverAlias, toolName, params, ctx.correlationId);
  const existing = state.store.getApprovalByRequestHash(requestHash);

  if (existing && existing.decision === 'approved' && existing.consumedAt === undefined) {
    // Read-time timeout: a decision made after timeoutAt still counts as
    // approved-in-the-store, but the governance timeout window has since
    // elapsed — treat it the same as an unresolved-and-expired approval
    // rather than silently honoring a stale approval.
    if (existing.timeoutAt < state.now()) {
      return { status: 'approval_timeout', approvalId: existing.id, error: 'Approval request timed out' };
    }
    state.store.markApprovalConsumed(existing.id, state.now());
    return { approvalId: existing.id, ...(await doExecuteTool(ctx, serverAlias, toolName, params, breaker)) };
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
    sessionId: ctx.teamId,
    correlationId: ctx.correlationId,
    serverAlias,
    toolName,
    paramsJson: JSON.stringify(params),
    requestedAt,
    timeoutAt: requestedAt + state.governance.approvalTimeoutMinutes * 60_000,
    requestHash,
  };
  state.store.createApproval(approval);

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
  breaker: CircuitBreaker
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
      breaker.recordSuccess();
      return { status: 'success', data: cached };
    }
  }

  const adapter = state.adapters.get(serverAlias);
  if (!adapter) {
    breaker.recordFailure();
    return { status: 'error', error: `Unknown MCP server alias: ${serverAlias}` };
  }

  try {
    const data = await adapter.callTool(toolName, params);
    breaker.recordSuccess();
    if (cacheKeyValue) {
      const ttlMs = (policy.ttlSeconds ?? 0) * 1000;
      state.store.setCachedToolCall(cacheKeyValue, data, ttlMs);
    }
    return { status: 'success', data };
  } catch (err) {
    breaker.recordFailure();
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

export function createDefaultToolshedState(
  overrides: Partial<ToolshedState> & Pick<ToolshedState, 'store' | 'adapters'>
): ToolshedState {
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
    breakers: new Map<string, CircuitBreaker>(),
    rateLimiter: createRateLimiter(),
    auditLogger: (entry) => {
      console.log(`[AUDIT] ${entry.status} ${entry.minionType} ${entry.serverAlias}.${entry.toolName} ${entry.latencyMs}ms`);
    },
    circuitBreakerConfig: {
      failureThreshold: 5,
      successThreshold: 3,
      timeoutSecs: 30,
      halfOpenMaxRequests: 1,
    },
    allowUnsignedTokens: false,
    now: Date.now,
    ...overrides,
  };
}
