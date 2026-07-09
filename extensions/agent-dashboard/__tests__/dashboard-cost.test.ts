import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStore, type SessionStore } from 'mcp-toolshed';
import { startDashboardServer } from '../src/dashboard.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO_ROOT = path.join(here, 'fixtures', 'cost-repo');

async function get(port: number, urlPath: string): Promise<{ status: number; body: unknown }> {
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

describe('GET /api/sessions/:id/cost (Milestone 13, M9/F9)', () => {
  let server: { close: () => Promise<void>; port: number };
  let store: SessionStore;

  beforeEach(async () => {
    store = createMemoryStore();
    server = await startDashboardServer(store, 0, undefined, [], FIXTURE_REPO_ROOT);
  });

  afterEach(async () => {
    await server.close();
  });

  it('returns token totals and estimated USD cost for a session, joining rules/models.yaml tier prices', async () => {
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
      minionType: 'ticket_analyst',
      correlationId: 'corr_1.0',
      status: 'completed',
      createdAt: 1,
      completedAt: 2,
      tokensUsed: 5000,
    });

    const response = await get(server.port, '/api/sessions/s1/cost');
    expect(response.status).toBe(200);
    const body = response.body as { totalTokens: number; totalCostUsd: number; byMinionType: Record<string, unknown> };
    expect(body.totalTokens).toBe(5000);
    // ticket_analyst -> fast tier -> 0.001 $/1k tokens -> 5000/1000*0.001 = 0.005
    expect(body.totalCostUsd).toBeCloseTo(0.005, 6);
    expect(body.byMinionType.ticket_analyst).toEqual({ tokens: 5000, costUsd: expect.any(Number) });
  });

  it('sums across multiple runs and minion types for the session', async () => {
    store.createSession({
      id: 's2',
      teamId: 'team-a',
      platform: 'slack',
      userId: 'u1',
      correlationRoot: 'corr_2',
      createdAt: 1,
      updatedAt: 1,
    });
    store.createMinionRun({
      id: 'r1',
      sessionId: 's2',
      minionType: 'ticket_analyst',
      correlationId: 'corr_2.0',
      status: 'completed',
      createdAt: 1,
      tokensUsed: 1000,
    });
    store.createMinionRun({
      id: 'r2',
      sessionId: 's2',
      minionType: 'ticket_analyst',
      correlationId: 'corr_2.1',
      status: 'completed',
      createdAt: 1,
      tokensUsed: 2000,
    });

    const response = await get(server.port, '/api/sessions/s2/cost');
    expect(response.status).toBe(200);
    const body = response.body as { totalTokens: number };
    expect(body.totalTokens).toBe(3000);
  });

  it('returns zero totals (not 404) for a session with no minion runs yet', async () => {
    const response = await get(server.port, '/api/sessions/no-runs-yet/cost');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ totalTokens: 0, totalCostUsd: 0, byMinionType: {} });
  });

  it('respects the ?teamId= scoping already used by the sibling minion-runs endpoint (M9 teamId scoping)', async () => {
    store.createSession({
      id: 's3',
      teamId: 'team-a',
      platform: 'slack',
      userId: 'u1',
      correlationRoot: 'corr_3',
      createdAt: 1,
      updatedAt: 1,
    });
    store.createMinionRun({
      id: 'r1',
      sessionId: 's3',
      minionType: 'ticket_analyst',
      correlationId: 'corr_3.0',
      status: 'completed',
      createdAt: 1,
      tokensUsed: 4000,
    });

    // Right team: the run is still counted.
    const rightTeam = await get(server.port, '/api/sessions/s3/cost?teamId=team-a');
    expect((rightTeam.body as { totalTokens: number }).totalTokens).toBe(4000);

    // Wrong team: mcp-toolshed's memory/sqlite listMinionRunsBySession scopes
    // by the session's OWN teamId when a teamId filter is given, so a
    // mismatched teamId returns nothing -- defense in depth against an
    // operator guessing another tenant's session id (ADR-022).
    const wrongTeam = await get(server.port, '/api/sessions/s3/cost?teamId=team-b');
    expect((wrongTeam.body as { totalTokens: number }).totalTokens).toBe(0);
  });
});
