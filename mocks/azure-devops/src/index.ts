import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

const PORT = 3000;
const SSE_PATH = '/sse';
const MESSAGE_PATH = '/message';

const tools: Tool[] = [
  {
    name: 'ado_list_pull_requests',
    description: 'List pull requests in Azure DevOps (mock).',
    inputSchema: {
      type: 'object',
      properties: {
        organization: { type: 'string' },
        project: { type: 'string' },
        repository_id: { type: 'string' },
        status: { type: 'string', enum: ['active', 'completed', 'all'] },
      },
      required: ['organization', 'project'],
    },
  },
  {
    name: 'ado_get_pull_request',
    description: 'Get details for an Azure DevOps pull request (mock).',
    inputSchema: {
      type: 'object',
      properties: {
        organization: { type: 'string' },
        project: { type: 'string' },
        repository_id: { type: 'string' },
        pull_request_id: { type: 'integer' },
      },
      required: ['organization', 'project', 'pull_request_id'],
    },
  },
  {
    name: 'ado_get_pull_request_diff',
    description: 'Get the diff for an Azure DevOps pull request (mock).',
    inputSchema: {
      type: 'object',
      properties: {
        organization: { type: 'string' },
        project: { type: 'string' },
        repository_id: { type: 'string' },
        pull_request_id: { type: 'integer' },
      },
      required: ['organization', 'project', 'pull_request_id'],
    },
  },
  {
    name: 'ado_create_pull_request',
    description: 'Create a new Azure DevOps pull request (mock).',
    inputSchema: {
      type: 'object',
      properties: {
        organization: { type: 'string' },
        project: { type: 'string' },
        repository_id: { type: 'string' },
        title: { type: 'string' },
        source_branch: { type: 'string' },
        target_branch: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['organization', 'project', 'title', 'source_branch', 'target_branch'],
    },
  },
  {
    name: 'ado_merge_pull_request',
    description: 'Merge an Azure DevOps pull request (mock).',
    inputSchema: {
      type: 'object',
      properties: {
        organization: { type: 'string' },
        project: { type: 'string' },
        repository_id: { type: 'string' },
        pull_request_id: { type: 'integer' },
        merge_status: { type: 'string', enum: ['squash', 'rebase', 'merge'] },
      },
      required: ['organization', 'project', 'pull_request_id'],
    },
  },
  {
    name: 'ado_list_work_items',
    description: 'List Azure DevOps work items (mock).',
    inputSchema: {
      type: 'object',
      properties: {
        organization: { type: 'string' },
        project: { type: 'string' },
        wiql: { type: 'string' },
      },
      required: ['organization', 'project'],
    },
  },
  {
    name: 'ado_get_work_item',
    description: 'Get an Azure DevOps work item by ID (mock).',
    inputSchema: {
      type: 'object',
      properties: {
        organization: { type: 'string' },
        project: { type: 'string' },
        id: { type: 'integer' },
      },
      required: ['organization', 'project', 'id'],
    },
  },
  {
    name: 'ado_update_work_item',
    description: 'Update an Azure DevOps work item (mock).',
    inputSchema: {
      type: 'object',
      properties: {
        organization: { type: 'string' },
        id: { type: 'integer' },
        fields: { type: 'object' },
      },
      required: ['organization', 'id'],
    },
  },
];

function cannedResponse(toolName: string, params: Record<string, unknown> | undefined): unknown {
  switch (toolName) {
    case 'ado_list_pull_requests':
      return [{ pullRequestId: 1, title: 'Fix login timeout', status: 'active' }];
    case 'ado_get_pull_request':
      return { pullRequestId: (params?.pull_request_id as number) ?? 1, title: 'Fix login timeout', status: 'active', sourceBranch: 'refs/heads/fix-timeout', targetBranch: 'refs/heads/main' };
    case 'ado_get_pull_request_diff':
      return { diff: 'diff --git a/src/auth.ts b/src/auth.ts\n+ increase timeout to 30s\n' };
    case 'ado_create_pull_request':
      return { pullRequestId: 2, title: (params?.title as string) ?? 'New PR', status: 'active' };
    case 'ado_merge_pull_request':
      return { success: true, message: 'Pull request merged.' };
    case 'ado_list_work_items':
      return [{ id: 1, fields: { 'System.Title': 'Fix login timeout', 'System.State': 'Active' } }];
    case 'ado_get_work_item':
      return { id: (params?.id as number) ?? 1, fields: { 'System.Title': 'Fix login timeout', 'System.State': 'Active' } };
    case 'ado_update_work_item':
      return { id: (params?.id as number) ?? 1, updated: true };
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

const mcpServer = new Server(
  { name: 'mock-azure-devops', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};

  try {
    const data = cannedResponse(name, args as Record<string, unknown>);
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, data }) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: false, error: message }) }],
    };
  }
});

const transports = new Map<string, SSEServerTransport>();

const httpServer = http.createServer((req, res) => {
  const url = req.url ?? '/';

  if (req.method === 'GET' && url === SSE_PATH) {
    const transport = new SSEServerTransport(MESSAGE_PATH, res);
    transports.set(transport.sessionId, transport);
    mcpServer.connect(transport).then(() => transport.start());
    req.on('close', () => {
      transports.delete(transport.sessionId);
    });
  } else if (req.method === 'POST' && url === MESSAGE_PATH) {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = transports.get(sessionId ?? '');
    if (transport) {
      transport.handlePostMessage(req, res);
    } else {
      res.writeHead(404);
      res.end('No transport for session');
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

httpServer.listen(PORT, () => {
  console.error(`mock-azure-devops MCP server listening on port ${PORT}`);
});
