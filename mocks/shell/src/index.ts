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
    name: 'execute',
    description: 'Execute a shell command (mock returns canned output for common commands).',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, working_directory: { type: 'string' } }, required: ['command'] },
  },
];

function cannedResponse(toolName: string, params: Record<string, unknown> | undefined): unknown {
  switch (toolName) {
    case 'execute': {
      const command = (params?.command as string) ?? '';
      if (command.startsWith('pnpm test') || command.startsWith('npm test') || command.startsWith('npx jest')) {
        return `PASS test/src/e2e-review-pr.test.ts
  e2e: "@minions review PR #1"
    ✓ drives the full path (45 ms)
    ✓ rejects a forged minion token (2 ms)
Test Suites: 1 passed, 1 total
Tests:       2 passed, 2 total`;
      }
      if (command.startsWith('git diff')) {
        return 'diff --git a/src/auth.ts b/src/auth.ts\n+ increase timeout to 30s\n';
      }
      if (command.startsWith('git status')) {
        return 'On branch fix-timeout\nChanges to be committed:\n  (use "git reset HEAD ..." to unstage)\n\n    modified:   src/auth.ts';
      }
      if (command.startsWith('git log')) {
        return 'a1b2c3d Fix login timeout\nf4e5d6c Initial commit';
      }
      return `$ ${command}\n(mock shell output)\n`;
    }
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

const mcpServer = new Server(
  { name: 'mock-shell', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};
  try {
    const data = cannedResponse(name, args as Record<string, unknown>);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, data }) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }) }] };
  }
});

const transports = new Map<string, SSEServerTransport>();

const httpServer = http.createServer((req, res) => {
  const url = req.url ?? '/';
  if (req.method === 'GET' && url === SSE_PATH) {
    const transport = new SSEServerTransport(MESSAGE_PATH, res);
    transports.set(transport.sessionId, transport);
    mcpServer.connect(transport).then(() => transport.start());
    req.on('close', () => { transports.delete(transport.sessionId); });
  } else if (req.method === 'POST' && url === MESSAGE_PATH) {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = transports.get(sessionId ?? '');
    if (transport) { transport.handlePostMessage(req, res); }
    else { res.writeHead(404); res.end('No transport for session'); }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

httpServer.listen(PORT, () => {
  console.error(`mock-shell MCP server listening on port ${PORT}`);
});
