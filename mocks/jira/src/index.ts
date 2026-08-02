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
    name: 'jira_list_issues',
    description: 'List Jira issues (mock).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        status: { type: 'string', enum: ['open', 'in progress', 'done', 'all'] },
        limit: { type: 'integer' },
      },
      required: ['project'],
    },
  },
  {
    name: 'jira_get_issue',
    description: 'Get a single Jira issue by key (mock).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
      },
      required: ['key'],
    },
  },
  {
    name: 'jira_update_issue',
    description: 'Update a Jira issue (mock).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        fields: { type: 'object' },
      },
      required: ['key'],
    },
  },
  {
    name: 'jira_create_issue',
    description: 'Create a new Jira issue (mock).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        summary: { type: 'string' },
        description: { type: 'string' },
        issuetype: { type: 'string' },
      },
      required: ['project', 'summary'],
    },
  },
  {
    name: 'jira_add_comment',
    description: 'Add a comment to a Jira issue (mock).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['key', 'body'],
    },
  },
];

function cannedResponse(toolName: string, params: Record<string, unknown> | undefined): unknown {
  switch (toolName) {
    case 'jira_list_issues':
      return [{ key: 'PROJ-1', fields: { 'system.subject': 'Login timeout', 'system.status': 'Open' } }];
    case 'jira_get_issue':
      return { key: (params?.key as string) ?? 'PROJ-1', fields: { 'system.subject': 'Login timeout', 'system.status': 'Open', 'system.description': 'Users experience timeout after 30s.' } };
    case 'jira_update_issue':
      return { key: (params?.key as string) ?? 'PROJ-1', updated: true };
    case 'jira_create_issue':
      return { key: 'PROJ-999', self: 'https://example.atlassian.net/rest/api/3/issue/PROJ-999', fields: { 'system.subject': (params?.summary as string) ?? 'New issue' } };
    case 'jira_add_comment':
      return { id: '10001', body: (params?.body as string) ?? '' };
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

const mcpServer = new Server(
  { name: 'mock-jira', version: '1.0.0' },
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
  console.error(`mock-jira MCP server listening on port ${PORT}`);
});
