import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { verifyAndExecuteTool, createDefaultToolshedState, initializeToolshed, type ToolResult } from './toolshed.js';
import { loadAllowlists, loadGovernance } from './config.js';
import { validateConfigAtRoot } from './config-validation.js';
import { createSqliteStore } from './store.js';
import { createRateLimiter } from './rate-limiter.js';
import { createMcpAdapter, type McpServerAdapter, type McpAdapterConfig } from './adapter.js';
import { CircuitBreaker, type CircuitBreakerConfig } from './circuit-breaker.js';
import { createSharedGovernanceStateStore } from './shared-governance-state.js';
import { TableClient } from '@azure/data-tables';
import { startOperatorHttpServer, type OperatorHttpServer } from './operator-http.js';
import { watchRules, type WatchRulesHandle } from './hot-reload.js';

// This file lives at extensions/mcp-toolshed/src/server.ts (or, once built,
// extensions/mcp-toolshed/dist/server.js) — three directories below the
// repo root in both cases. Used as the default value for TOOLSHED_REPO_ROOT
// so the startup validator (see buildToolshedState below) finds agents/,
// rules/, and schemas/ without every deployment having to set the env var.
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface HealthStatus {
  healthy: boolean;
  latencyMs: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
}

export { type McpServerAdapter };

// Identity (minionType, sessionId) comes ONLY from the verified minion_token
// (C1/C2 fix, Milestone 3) — minion_type/team_id are accepted here purely as
// the dev-only TOOLSHED_ALLOW_UNSIGNED=1 escape hatch; see verifyAndExecuteTool.
// There is deliberately no resolve_approval tool: see the Decision Log entry
// on removing that MCP surface entirely (C1's root-cause fix).
const executeToolDefinition: Tool = {
  name: 'execute_tool',
  description: 'Execute a tool on behalf of a minion through the governed toolshed.',
  inputSchema: {
    type: 'object',
    properties: {
      correlation_id: { type: 'string' },
      minion_token: { type: 'string' },
      team_id: { type: 'string' },
      minion_type: { type: 'string' },
      server_alias: { type: 'string' },
      tool_name: { type: 'string' },
      params: { type: 'object' },
      attempt: { type: 'integer' },
    },
    required: ['correlation_id', 'minion_token', 'server_alias', 'tool_name'],
  },
};

export function parseAdapterConfigs(json?: string): McpAdapterConfig[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) {
      return parsed as McpAdapterConfig[];
    }
    return [];
  } catch {
    return [];
  }
}

export async function buildToolshedState(): Promise<ReturnType<typeof createDefaultToolshedState>> {
  const allowlistsPath = process.env.TOOLSHED_ALLOWLISTS_PATH;
  const governancePath = process.env.TOOLSHED_GOVERNANCE_PATH;
  const storePath = process.env.TOOLSHED_STORE_PATH ?? ':memory:';
  const adapterJson = process.env.TOOLSHED_ADAPTERS;
  const repoRoot = process.env.TOOLSHED_REPO_ROOT ?? DEFAULT_REPO_ROOT;

  // Config errors are not downstream failures: a misconfigured toolshed
  // (agent frontmatter drifted from rules/allowlists.yaml, a destructive
  // tool marked cacheable, etc. — the exact class of bug that bricked two
  // minions, C4) must never start serving tool calls. Log every error so an
  // operator can fix all of them in one pass, then refuse to start.
  const { errors } = validateConfigAtRoot(repoRoot);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    throw new Error(`[toolshed] config validation failed with ${errors.length} error(s); see log above`);
  }

  // Minion identity tokens (C1/C2 fix, Milestone 3): TOOLSHED_SIGNING_SECRET
  // must be set in production so execute_tool can verify who is calling.
  // "Production" is defined the same way Milestone 6 will define it
  // (NODE_ENV === 'production') so the two startup gates agree; see the
  // Decision Log entry for why this milestone reuses that flag early.
  // TOOLSHED_ALLOW_UNSIGNED=1 is a loudly-logged dev escape hatch, default
  // off, that lets execute_tool fall back to caller-supplied identity params
  // — never enable it in production.
  const signingSecret = process.env.TOOLSHED_SIGNING_SECRET;
  const allowUnsignedTokens = process.env.TOOLSHED_ALLOW_UNSIGNED === '1';
  const isProduction = process.env.NODE_ENV === 'production';

  if (!signingSecret && isProduction) {
    throw new Error(
      '[toolshed] TOOLSHED_SIGNING_SECRET is required in production (NODE_ENV=production) to verify minion identity tokens'
    );
  }
  if (!signingSecret && !isProduction) {
    console.warn(
      '[toolshed] TOOLSHED_SIGNING_SECRET is not set — minion tokens cannot be verified outside TOOLSHED_ALLOW_UNSIGNED=1. This is only acceptable in development.'
    );
  }
  if (allowUnsignedTokens) {
    console.warn(
      '[toolshed] TOOLSHED_ALLOW_UNSIGNED=1 is set: execute_tool will accept unverified, caller-supplied minion identity (minion_type/team_id). This is a development-only escape hatch and must never be enabled in production.'
    );
  }

  const allowlists = loadAllowlists(allowlistsPath);
  const governance = loadGovernance(governancePath);
  const store = createSqliteStore(storePath);

  const adapterConfigs = parseAdapterConfigs(adapterJson);
  const adapters = new Map<string, McpServerAdapter>();
  for (const config of adapterConfigs) {
    try {
      const adapter = await createMcpAdapter(config);
      adapters.set(adapter.alias, adapter);
    } catch (err) {
      console.warn(`[toolshed] Failed to connect adapter ${config.alias}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const defaultRateLimit = governance.rateLimits.default ?? { requestsPerMinute: 60, burst: 20 };
  // Same config `createDefaultToolshedState` uses internally when not
  // overridden — declared here so the shared governance store below enforces
  // the identical breaker thresholds/timeouts as the in-process fallback.
  const circuitBreakerConfig: CircuitBreakerConfig = {
    failureThreshold: 5,
    successThreshold: 3,
    timeoutSecs: 30,
    halfOpenMaxRequests: 1,
  };

  // Milestone 18 (ADR-026): when a governance-state connection string is
  // configured, persist the rate-limit buckets and circuit breaker state to
  // Azure Table Storage (or Azurite in dev) so multiple toolshed replicas
  // share one view of them. Approvals stay on the SQLite `store` — see
  // `shared-governance-state.ts`. Without the env var, fall back to the
  // in-process adapter so local/dev runs need no extra infrastructure.
  const governanceStateConnectionString = process.env.TOOLSHED_GOVERNANCE_STATE_CONNECTION_STRING;
  const governanceStateTable = process.env.TOOLSHED_GOVERNANCE_STATE_TABLE ?? 'GovernanceState';
  const sharedGovernanceState = governanceStateConnectionString
    ? createSharedGovernanceStateStore({
        client: TableClient.fromConnectionString(governanceStateConnectionString, governanceStateTable),
        store,
        circuitBreakerConfig,
        defaultRateLimit,
      })
    : undefined;

  return createDefaultToolshedState({
    allowlists,
    governance,
    store,
    adapters,
    breakers: new Map<string, CircuitBreaker>(),
    rateLimiter: createRateLimiter(defaultRateLimit),
    circuitBreakerConfig,
    // Only override `governanceState` when a shared store is configured;
    // otherwise let `createDefaultToolshedState` build the in-process adapter
    // over the `breakers`/`rateLimiter`/`store` above.
    ...(sharedGovernanceState ? { governanceState: sharedGovernanceState } : {}),
    auditLogger: (entry) => {
      console.log(JSON.stringify({ type: 'audit', ...entry }));
    },
    signingSecret,
    allowUnsignedTokens,
  });
}

/**
 * Starts BOTH toolshed transports in the same process:
 *  - the minion-facing MCP server over stdio (unchanged) — this is what
 *    minions actually call `execute_tool` through, and it never gained an
 *    approve/resolve surface (C1's fix stands).
 *  - the operator-facing HTTP server on `port` (Milestone 4, H3/F1) — bare
 *    `node:http`, bearer-token authenticated, serving
 *    `POST /approvals/:id/resolve` and `GET /approvals/pending` for the
 *    Slack/Teams action handlers and the dashboard.
 *
 * The two transports don't compete for anything: stdio is the process's
 * own stdin/stdout, HTTP is a TCP listener on `port` — there is no shared
 * resource to arbitrate, so running both concurrently in one process is
 * simply two independent event-loop listeners (see the ExecPlan Decision
 * Log for this coexistence choice). This is also the first real use of the
 * `port` argument — previously named `_port` and never used, a Low finding
 * this milestone resolves.
 */
export async function startToolshedServer(port: number): Promise<{ operatorHttp: OperatorHttpServer; hotReload?: WatchRulesHandle }> {
  const state = await buildToolshedState();
  initializeToolshed(state);

  const operatorToken = process.env.TOOLSHED_OPERATOR_TOKEN ?? '';
  if (!operatorToken) {
    console.warn(
      '[toolshed] TOOLSHED_OPERATOR_TOKEN is not set — the operator HTTP endpoints will reject every request with 401. Set it to allow Slack/Teams/dashboard approval resolution.'
    );
  }
  const operatorHttp = await startOperatorHttpServer(state.store, port, operatorToken);

  // Rules hot-reload (Milestone 17, F16): opt-in via TOOLSHED_WATCH_RULES=1.
  // Only meaningful when the toolshed was actually pointed at real
  // allowlists/governance YAML files (TOOLSHED_ALLOWLISTS_PATH/
  // TOOLSHED_GOVERNANCE_PATH) — with no path set, buildToolshedState already
  // fell back to the hardcoded defaults and there is nothing on disk to
  // watch. Reuses the exact same env vars buildToolshedState() itself reads,
  // so "what the toolshed loaded at startup" and "what watchRules watches"
  // can never point at different files.
  let hotReload: WatchRulesHandle | undefined;
  if (process.env.TOOLSHED_WATCH_RULES === '1') {
    const allowlistsPath = process.env.TOOLSHED_ALLOWLISTS_PATH;
    const governancePath = process.env.TOOLSHED_GOVERNANCE_PATH;
    const repoRoot = process.env.TOOLSHED_REPO_ROOT ?? DEFAULT_REPO_ROOT;
    if (!allowlistsPath || !governancePath) {
      console.warn(
        '[toolshed] TOOLSHED_WATCH_RULES=1 is set but TOOLSHED_ALLOWLISTS_PATH/TOOLSHED_GOVERNANCE_PATH are not both set — nothing to watch, hot-reload disabled.'
      );
    } else {
      hotReload = watchRules({
        repoRoot,
        allowlistsPath,
        governancePath,
        state,
        store: state.store,
        auditLogger: state.auditLogger,
      });
      console.log(`[toolshed] hot-reload enabled: watching ${allowlistsPath} and ${governancePath}`);
    }
  }

  const server = new Server(
    { name: 'mcp-toolshed', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [executeToolDefinition],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};

    const result: ToolResult = await verifyAndExecuteTool(
      {
        minionToken: args.minion_token === undefined ? undefined : String(args.minion_token),
        correlationId: String(args.correlation_id),
        attempt: Number(args.attempt ?? 1),
        legacyMinionType: args.minion_type === undefined ? undefined : String(args.minion_type),
        legacyTeamId: args.team_id === undefined ? undefined : String(args.team_id),
      },
      String(args.server_alias),
      String(args.tool_name),
      args.params
    );

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  return { operatorHttp, hotReload };
}
