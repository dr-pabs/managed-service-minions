import { randomUUID } from 'node:crypto';
import type { SessionStore, PendingApproval, AuditEntry } from 'framework-core';
import { verifyMinionToken } from 'framework-core';
import {
  type AllowlistConfig,
  type GovernanceConfig,
  getCachePolicy,
  isDestructive,
  isPathAllowed,
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
  status: 'success' | 'error' | 'blocked_by_allowlist' | 'throttled' | 'approval_required' | 'approval_denied' | 'approval_timeout';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForApproval(
  store: SessionStore,
  approvalId: string,
  timeoutMs: number,
  pollIntervalMs = 500
): Promise<'approved' | 'denied' | 'timeout'> {
  let remaining = timeoutMs;
  while (remaining > 0) {
    const approval = store.getApproval(approvalId);
    if (approval?.decision) {
      return approval.decision;
    }
    const sleepMs = Math.min(pollIntervalMs, remaining);
    await sleep(sleepMs);
    remaining -= sleepMs;
  }
  return 'timeout';
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
    const approvalId = `appr_${ctx.correlationId}_${serverAlias}_${toolName}_${Date.now()}`;
    const approval: PendingApproval = {
      id: approvalId,
      sessionId: ctx.teamId,
      correlationId: ctx.correlationId,
      serverAlias,
      toolName,
      paramsJson: JSON.stringify(params),
      requestedAt: Date.now(),
      timeoutAt: Date.now() + toolshedState.governance.approvalTimeoutMinutes * 60_000,
    };
    toolshedState.store.createApproval(approval);

    const timeoutMs = Math.max(0, approval.timeoutAt - approval.requestedAt);
    const decision = await waitForApproval(toolshedState.store, approvalId, timeoutMs);

    if (decision === 'denied') {
      return emit({
        status: 'approval_denied',
        approvalId,
        error: 'Destructive action was denied by the operator',
      });
    }

    if (decision === 'timeout') {
      return emit({
        status: 'approval_timeout',
        approvalId,
        error: 'Approval request timed out',
      });
    }
  }

  return emit(await doExecuteTool(ctx, serverAlias, toolName, params, breaker));
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
    allowlists: { allowlists: {}, pathScopes: {} },
    governance: {
      destructiveActions: [],
      approvalTimeoutMinutes: 15,
      rateLimits: { default: { requestsPerMinute: 60, burst: 20 } },
      workspaceBoundaries: { allowedBasePaths: ['/repo'], denyPatterns: ['.git/', 'node_modules/', 'secrets/', '.env*'] },
      cachePolicy: { default: { cacheable: false } },
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
    ...overrides,
  };
}
