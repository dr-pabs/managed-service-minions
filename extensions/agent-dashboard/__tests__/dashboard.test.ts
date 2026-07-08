import http from 'node:http';
import { createMemoryStore, type SessionStore } from 'mcp-toolshed';
import { startDashboardServer } from '../src/dashboard.js';

async function get(port: number, path: string): Promise<{ status: number; body: unknown; contentType?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${port}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        const contentType = res.headers['content-type'];
        try {
          resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null, contentType });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data, contentType });
        }
      });
    });
    req.on('error', reject);
  });
}

describe('startDashboardServer', () => {
  let server: { close: () => Promise<void>; port: number };
  let store: SessionStore;

  beforeEach(async () => {
    store = createMemoryStore();
    server = await startDashboardServer(store, 0);
  });

  afterEach(async () => {
    await server.close();
  });

  it('serves the HTML dashboard at /', async () => {
    const response = await get(server.port, '/');
    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/html');
    expect(response.body as string).toContain('<!doctype html>');
    expect(response.body as string).toContain('Goose Agent Dashboard');
  });

  it('returns ok from /health', async () => {
    const response = await get(server.port, '/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('lists sessions', async () => {
    store.createSession({
      id: 's1',
      teamId: 'team-a',
      platform: 'slack',
      userId: 'u1',
      correlationRoot: 'corr_1',
      createdAt: 1,
      updatedAt: 1,
    });

    const response = await get(server.port, '/sessions');
    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      {
        id: 's1',
        teamId: 'team-a',
        platform: 'slack',
        userId: 'u1',
        correlationRoot: 'corr_1',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
  });

  it('returns a session by id', async () => {
    store.createSession({
      id: 's1',
      teamId: 'team-a',
      platform: 'slack',
      userId: 'u1',
      correlationRoot: 'corr_1',
      createdAt: 1,
      updatedAt: 1,
    });

    const response = await get(server.port, '/sessions/s1');
    expect(response.status).toBe(200);
    expect((response.body as { id: string }).id).toBe('s1');
  });

  it('returns 404 for a missing session', async () => {
    const response = await get(server.port, '/sessions/missing');
    expect(response.status).toBe(404);
  });

  it('lists minion runs for a session', async () => {
    store.createSession({
      id: 's1',
      teamId: 'team-a',
      platform: 'slack',
      userId: 'u1',
      correlationRoot: 'corr_1',
      createdAt: 1,
      updatedAt: 1,
    });
    store.createMinionRun({
      id: 'r1',
      sessionId: 's1',
      minionType: 'code-explorer',
      correlationId: 'corr_1',
      status: 'completed',
      createdAt: 1,
      completedAt: 2,
    });

    const response = await get(server.port, '/sessions/s1/minion-runs');
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
  });

  it('returns a correlation tree', async () => {
    store.createMinionRun({
      id: 'r1',
      sessionId: 's1',
      minionType: 'code-explorer',
      correlationId: 'corr_1',
      status: 'completed',
      createdAt: 1,
      completedAt: 2,
    });

    const response = await get(server.port, '/correlation-tree/corr_1');
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
  });

  it('lists pending approvals', async () => {
    store.createApproval({
      id: 'a1',
      sessionId: 's1',
      teamId: 'team-a',
      correlationId: 'corr_1',
      serverAlias: 'github',
      toolName: 'github_merge_pull_request',
      paramsJson: '{}',
      requestedAt: 1,
      timeoutAt: 2,
      requestHash: 'hash_1',
    });

    const response = await get(server.port, '/pending-approvals');
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
  });

  it('returns 404 for unknown routes', async () => {
    const response = await get(server.port, '/unknown');
    expect(response.status).toBe(404);
  });

  it('returns 404 for unsupported methods on known routes', async () => {
    const response = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = http.request(
        { hostname: 'localhost', port: server.port, path: '/sessions', method: 'POST' },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null });
            } catch {
              resolve({ status: res.statusCode ?? 0, body: data });
            }
          });
        }
      );
      req.on('error', reject);
      req.end();
    });

    expect(response.status).toBe(404);
  });

  it('returns 500 when the store throws', async () => {
    store.listSessions = () => {
      throw new Error('store failure');
    };

    const response = await get(server.port, '/sessions');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'store failure' });
  });

  it('returns 500 when the store throws a non-error', async () => {
    store.listSessions = () => {
      throw 'string failure';
    };

    const response = await get(server.port, '/sessions');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'string failure' });
  });

  it('returns empty agentTypes from /api/config when none are configured', async () => {
    const response = await get(server.port, '/api/config');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ agentTypes: [] });
  });

  it('returns all 7 agent types from /api/config', async () => {
    const agentTypes = [
      'code-explorer',
      'code-reviewer',
      'pr-crafter',
      'ticket-analyst',
      'security-auditor',
      'code-writer',
      'test-writer',
    ];
    const configServer = await startDashboardServer(createMemoryStore(), 0, http.createServer, agentTypes);
    try {
      const response = await get(configServer.port, '/api/config');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ agentTypes });
    } finally {
      await configServer.close();
    }
  });
});
