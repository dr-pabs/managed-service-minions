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
import { CircuitBreaker } from './circuit-breaker.js';

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

  return createDefaultToolshedState({
    allowlists,
    governance,
    store,
    adapters,
    breakers: new Map<string, CircuitBreaker>(),
    rateLimiter: createRateLimiter(defaultRateLimit),
    auditLogger: (entry) => {
      console.log(JSON.stringify({ type: 'audit', ...entry }));
    },
    signingSecret,
    allowUnsignedTokens,
  });
}

export async function startToolshedServer(_port: number): Promise<void> {
  const state = await buildToolshedState();
  initializeToolshed(state);

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
}
