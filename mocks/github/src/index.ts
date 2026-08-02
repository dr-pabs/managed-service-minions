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
    name: 'github_list_pull_requests',
    description: 'List pull requests for a GitHub repository (mock).',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed', 'all'] }, limit: { type: 'integer' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'github_get_pull_request',
    description: 'Get details for a single GitHub pull request (mock).',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] },
  },
  {
    name: 'github_get_pull_request_diff',
    description: 'Get the diff text for a single GitHub pull request (mock).',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] },
  },
  {
    name: 'github_create_pull_request',
    description: 'Create a new GitHub pull request (mock).',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'github_merge_pull_request',
    description: 'Merge a GitHub pull request (mock).',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' }, commit_title: { type: 'string' }, commit_message: { type: 'string' }, merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'] } }, required: ['owner', 'repo', 'pull_number'] },
  },
  {
    name: 'github_create_issue_comment',
    description: 'Post a comment on a GitHub issue or pull request (mock).',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'integer' }, body: { type: 'string' } }, required: ['owner', 'repo', 'issue_number', 'body'] },
  },
];

function cannedResponse(toolName: string, params: Record<string, unknown> | undefined): unknown {
  switch (toolName) {
    case 'github_list_pull_requests':
      return [
        { number: 1, title: 'Fix login timeout', state: 'open', draft: false },
        { number: 3, title: 'Add user profile page', state: 'open', draft: false },
      ];
    case 'github_get_pull_request':
      return { number: (params?.pull_number as number) ?? 1, title: 'Fix login timeout', body: 'Fixes the login timeout bug.', state: 'open', draft: false };
    case 'github_get_pull_request_diff':
      return { diff: 'diff --git a/src/auth.ts b/src/auth.ts\n+ increase timeout to 30s\n' };
    case 'github_create_pull_request':
      return { number: 2, title: (params?.title as string) ?? 'New PR', html_url: 'https://github.com/mock/repo/pull/2', state: 'open' };
    case 'github_merge_pull_request':
      return { merged: true, message: 'Pull request merged successfully.' };
    case 'github_create_issue_comment':
      return { id: 1, body: (params?.body as string) ?? '', html_url: 'https://github.com/mock/repo/issues/1#issuecomment-1' };
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

const mcpServer = new Server(
  { name: 'mock-github', version: '1.0.0' },
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
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }) }],
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
  console.error(`mock-github MCP server listening on port ${PORT} (SSE: ${SSE_PATH}, POST: ${MESSAGE_PATH})`);
});
