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
    name: 'servicenow_list_incidents',
    description: 'List ServiceNow incidents (mock).',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'resolved', 'closed', 'all'] },
        limit: { type: 'integer' },
      },
      required: [],
    },
  },
  {
    name: 'servicenow_get_incident',
    description: 'Get a single ServiceNow incident by number (mock).',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'string' },
      },
      required: ['number'],
    },
  },
  {
    name: 'servicenow_update_incident',
    description: 'Update a ServiceNow incident (mock).',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'string' },
        state: { type: 'string' },
        comments: { type: 'string' },
      },
      required: ['number'],
    },
  },
  {
    name: 'servicenow_create_incident',
    description: 'Create a new ServiceNow incident (mock).',
    inputSchema: {
      type: 'object',
      properties: {
        short_description: { type: 'string' },
        description: { type: 'string' },
        assignment_group: { type: 'string' },
      },
      required: ['short_description'],
    },
  },
];

function cannedResponse(toolName: string, params: Record<string, unknown> | undefined): unknown {
  switch (toolName) {
    case 'servicenow_list_incidents':
      return [{ number: 'INC0001234', short_description: 'Login timeout for some users', state: 'open', assignment_group: 'IT Support' }];
    case 'servicenow_get_incident':
      return { number: (params?.number as string) ?? 'INC0001234', short_description: 'Login timeout', description: 'Users experience timeout after 30s', state: 'open', assignment_group: 'IT Support', priority: '2 - High' };
    case 'servicenow_update_incident':
      return { number: (params?.number as string) ?? 'INC0001234', updated: true, state: (params?.state as string) ?? 'open' };
    case 'servicenow_create_incident':
      return { number: 'INC0009999', short_description: (params?.short_description as string) ?? 'New incident', state: 'open' };
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

const mcpServer = new Server(
  { name: 'mock-servicenow', version: '1.0.0' },
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
  console.error(`mock-servicenow MCP server listening on port ${PORT}`);
});
