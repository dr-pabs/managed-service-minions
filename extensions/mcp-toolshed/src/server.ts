import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { executeTool, resolveApproval, createDefaultToolshedState, initializeToolshed, type ToolResult } from './toolshed.js';
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

const executeToolDefinition: Tool = {
  name: 'execute_tool',
  description: 'Execute a tool on behalf of a minion through the governed toolshed.',
  inputSchema: {
    type: 'object',
    properties: {
      correlation_id: { type: 'string' },
      team_id: { type: 'string' },
      minion_type: { type: 'string' },
      server_alias: { type: 'string' },
      tool_name: { type: 'string' },
      params: { type: 'object' },
      attempt: { type: 'integer' },
    },
    required: ['correlation_id', 'minion_type', 'server_alias', 'tool_name'],
  },
};

const resolveApprovalDefinition: Tool = {
  name: 'resolve_approval',
  description: 'Approve or deny a pending destructive-action approval request.',
  inputSchema: {
    type: 'object',
    properties: {
      approval_id: { type: 'string' },
      decision: { type: 'string', enum: ['approved', 'denied'] },
    },
    required: ['approval_id', 'decision'],
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
    tools: [executeToolDefinition, resolveApprovalDefinition],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    let result: ToolResult;

    if (request.params.name === 'resolve_approval') {
      result = resolveApproval(String(args.approval_id), String(args.decision) as 'approved' | 'denied');
    } else {
      result = await executeTool(
        {
          teamId: String(args.team_id ?? 'default'),
          minionType: String(args.minion_type),
          correlationId: String(args.correlation_id),
          attempt: Number(args.attempt ?? 1),
        },
        String(args.server_alias),
        String(args.tool_name),
        args.params
      );
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
