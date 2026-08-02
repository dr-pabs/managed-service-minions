import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  CallToolResultSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

export interface HealthStatus {
  healthy: boolean;
  latencyMs: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
}

export interface McpServerAdapter {
  alias: string;
  health(): Promise<HealthStatus>;
  listTools(): Promise<ToolDefinition[]>;
  callTool(name: string, params: unknown): Promise<unknown>;
  close?(): Promise<void>;
}

export interface McpAdapterConfig {
  alias: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** SSE/HTTP MCP server endpoint (e.g. http://host:3001/sse). When set, the toolshed connects via SSE instead of spawning a stdio subprocess — used for docker-compose local development where mock MCP servers run as separate containers. */
  url?: string;
}

export async function createMcpAdapter(config: McpAdapterConfig): Promise<McpServerAdapter> {
  const client = new Client({ name: `toolshed-${config.alias}`, version: '0.1.0' });
  const transport = config.url
    ? new SSEClientTransport(new URL(config.url))
    : new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env,
      });

  await client.connect(transport);

  return {
    alias: config.alias,
    async health(): Promise<HealthStatus> {
      const start = Date.now();
      try {
        await client.ping();
        return { healthy: true, latencyMs: Date.now() - start };
      } catch {
        return { healthy: false, latencyMs: Date.now() - start };
      }
    },
    async listTools(): Promise<ToolDefinition[]> {
      const result = await client.listTools({}, { timeout: 30_000 });
      const tools = (result.tools ?? []) as Tool[];
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema as object,
      }));
    },
    async callTool(name: string, params: unknown): Promise<unknown> {
      const result = await client.callTool({ name, arguments: params as Record<string, unknown> | undefined }, CallToolResultSchema, {
        timeout: 120_000,
      });
      return result;
    },
    async close(): Promise<void> {
      await transport.close();
      await client.close();
    },
  };
}

export function createMockAdapter(
  alias: string,
  handlers: {
    health?: () => Promise<HealthStatus>;
    listTools?: () => Promise<ToolDefinition[]>;
    callTool?: (name: string, params: unknown) => Promise<unknown>;
    close?: () => Promise<void>;
  } = {}
): McpServerAdapter {
  return {
    alias,
    health: handlers.health ?? (async () => ({ healthy: true, latencyMs: 0 })),
    listTools: handlers.listTools ?? (async () => []),
    callTool: handlers.callTool ?? (async () => ({})),
    close: handlers.close,
  };
}
