import http from 'node:http';
import { createMemoryStore, type SessionStore } from 'mcp-toolshed';
import { startDashboardServer } from '../src/dashboard.js';

function get(port: number, urlPath: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${port}${urlPath}`, (res) => {
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
    });
    req.on('error', reject);
  });
}

describe('GET /api/audit?correlationId=... (Milestone 14 audit search)', () => {
  let store: SessionStore;
  let server: { close: () => Promise<void>; port: number };

  beforeEach(async () => {
    store = createMemoryStore();
    server = await startDashboardServer(store, 0);
  });

  afterEach(async () => {
    await server.close();
  });

  it('returns audit entries filtered by correlationId', async () => {
    store.createAuditEntry({
      id: 'e1',
      timestamp: 1,
      correlationId: 'corr_1',
      minionType: 'code-explorer',
      teamId: 'team-a',
      serverAlias: 'github',
      toolName: 'get_file_contents',
      params: {},
      status: 'success',
      latencyMs: 5,
    });
    store.createAuditEntry({
      id: 'e2',
      timestamp: 2,
      correlationId: 'corr_2',
      minionType: 'code-explorer',
      teamId: 'team-a',
      serverAlias: 'github',
      toolName: 'get_file_contents',
      params: {},
      status: 'success',
      latencyMs: 5,
    });

    const response = await get(server.port, '/api/audit?correlationId=corr_1');
    expect(response.status).toBe(200);
    const body = response.body as Array<{ id: string; correlationId: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].correlationId).toBe('corr_1');
    expect(body[0].id).toBe('e1');
  });

  it('returns all audit entries when no correlationId filter is given', async () => {
    store.createAuditEntry({
      id: 'e1',
      timestamp: 1,
      correlationId: 'corr_1',
      minionType: 'code-explorer',
      teamId: 'team-a',
      serverAlias: 'github',
      toolName: 'get_file_contents',
      params: {},
      status: 'success',
      latencyMs: 5,
    });
    store.createAuditEntry({
      id: 'e2',
      timestamp: 2,
      correlationId: 'corr_2',
      minionType: 'code-explorer',
      teamId: 'team-a',
      serverAlias: 'github',
      toolName: 'get_file_contents',
      params: {},
      status: 'success',
      latencyMs: 5,
    });

    const response = await get(server.port, '/api/audit');
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
  });

  it('returns an empty array for a correlationId with no matches', async () => {
    const response = await get(server.port, '/api/audit?correlationId=nope');
    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });
});
