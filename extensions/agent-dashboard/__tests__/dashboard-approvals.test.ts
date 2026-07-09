import http from 'node:http';
import { createMemoryStore, type SessionStore } from 'mcp-toolshed';
import { startDashboardServer } from '../src/dashboard.js';

interface Response {
  status: number;
  body: unknown;
}

function request(
  port: number,
  method: string,
  urlPath: string,
  options: { body?: unknown; token?: string } = {}
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.token !== undefined) {
      headers.Authorization = `Bearer ${options.token}`;
    }
    const req = http.request({ hostname: 'localhost', port, path: urlPath, method, headers }, (res) => {
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
    if (options.body !== undefined) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

/**
 * Fake "toolshed operator HTTP endpoint" target, standing in for the real
 * `mcp-toolshed` process's `startOperatorHttpServer` (Milestone 4). The
 * dashboard proxy under test should call THIS with the SAME shape the real
 * operator-http.ts route expects (`Authorization: Bearer <operatorToken>`,
 * JSON body `{decision, approverId, approverKind}`), never mutate the
 * approval store directly, and never accept an unauthenticated caller of its
 * own `/api/approvals/:id/resolve` route.
 */
function startFakeOperatorServer(expectedToken: string): Promise<{
  port: number;
  close: () => Promise<void>;
  calls: Array<{ path: string; method: string; authHeader: string | undefined; body: unknown }>;
}> {
  const calls: Array<{ path: string; method: string; authHeader: string | undefined; body: unknown }> = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        const authHeader = req.headers.authorization;
        let body: unknown;
        try {
          body = data ? JSON.parse(data) : undefined;
        } catch {
          body = undefined;
        }
        calls.push({ path: req.url ?? '', method: req.method ?? '', authHeader, body });

        if (authHeader !== `Bearer ${expectedToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }

        if (req.method === 'GET' && req.url === '/approvals/pending') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([{ id: 'a1' }]));
          return;
        }

        const match = /^\/approvals\/([^/]+)\/resolve$/.exec(req.url ?? '');
        if (req.method === 'POST' && match) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'success', approval: { id: match[1], decision: (body as { decision?: string })?.decision } }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        port,
        calls,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

describe('dashboard approve/deny proxy (Milestone 14, toolshed-governance-invariants #4)', () => {
  const DASHBOARD_TOKEN = 'dashboard-token';
  const OPERATOR_TOKEN = 'operator-token';
  let store: SessionStore;
  let fakeOperator: Awaited<ReturnType<typeof startFakeOperatorServer>>;
  let server: { close: () => Promise<void>; port: number };

  beforeEach(async () => {
    store = createMemoryStore();
    fakeOperator = await startFakeOperatorServer(OPERATOR_TOKEN);
    server = await startDashboardServer(store, 0, undefined, [], undefined, {
      authToken: DASHBOARD_TOKEN,
      operatorUrl: `http://localhost:${fakeOperator.port}`,
      operatorToken: OPERATOR_TOKEN,
    });
  });

  afterEach(async () => {
    await server.close();
    await fakeOperator.close();
  });

  it('rejects an unauthenticated approve/deny call — DASHBOARD_AUTH_TOKEN gates this route too (invariant 4)', async () => {
    const response = await request(server.port, 'POST', '/api/approvals/a1/resolve', {
      body: { decision: 'approved', approverId: 'op@example.com' },
    });
    expect(response.status).toBe(401);
    // And crucially: the toolshed's operator endpoint was never even called.
    expect(fakeOperator.calls).toHaveLength(0);
  });

  it('proxies GET /api/approvals/pending to the toolshed operator endpoint using TOOLSHED_OPERATOR_TOKEN', async () => {
    const response = await request(server.port, 'GET', '/api/approvals/pending', { token: DASHBOARD_TOKEN });
    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ id: 'a1' }]);
    expect(fakeOperator.calls).toHaveLength(1);
    expect(fakeOperator.calls[0]).toMatchObject({ path: '/approvals/pending', method: 'GET', authHeader: `Bearer ${OPERATOR_TOKEN}` });
  });

  it('proxies POST /api/approvals/:id/resolve, passing the authenticated operator identity through so the approval is audited as approverKind:"dashboard"', async () => {
    const response = await request(server.port, 'POST', '/api/approvals/a1/resolve', {
      token: DASHBOARD_TOKEN,
      body: { decision: 'approved', approverId: 'op@example.com' },
    });

    expect(response.status).toBe(200);
    expect(fakeOperator.calls).toHaveLength(1);
    const call = fakeOperator.calls[0];
    expect(call.path).toBe('/approvals/a1/resolve');
    expect(call.method).toBe('POST');
    expect(call.authHeader).toBe(`Bearer ${OPERATOR_TOKEN}`);
    // The proxy must stamp approverKind:'dashboard' itself (invariant 4:
    // approvals resolved via the dashboard record {kind:'dashboard'}) —
    // never trust a client-supplied approverKind for this route.
    expect(call.body).toEqual({ decision: 'approved', approverId: 'op@example.com', approverKind: 'dashboard' });
  });

  it('does not let the caller override approverKind away from "dashboard" on this route', async () => {
    await request(server.port, 'POST', '/api/approvals/a1/resolve', {
      token: DASHBOARD_TOKEN,
      body: { decision: 'approved', approverId: 'op@example.com', approverKind: 'slack' },
    });
    const call = fakeOperator.calls[0];
    expect((call.body as { approverKind: string }).approverKind).toBe('dashboard');
  });

  it('forwards a denied decision', async () => {
    const response = await request(server.port, 'POST', '/api/approvals/a1/resolve', {
      token: DASHBOARD_TOKEN,
      body: { decision: 'denied', approverId: 'op@example.com' },
    });
    expect(response.status).toBe(200);
    expect((response.body as { approval: { decision: string } }).approval.decision).toBe('denied');
  });

  it('surfaces a non-2xx response from the toolshed operator endpoint verbatim (e.g. a wrong operator token)', async () => {
    const wrongTokenServer = await startDashboardServer(store, 0, undefined, [], undefined, {
      authToken: DASHBOARD_TOKEN,
      operatorUrl: `http://localhost:${fakeOperator.port}`,
      operatorToken: 'not-the-real-operator-token',
    });
    try {
      const response = await request(wrongTokenServer.port, 'POST', '/api/approvals/a1/resolve', {
        token: DASHBOARD_TOKEN,
        body: { decision: 'approved', approverId: 'op@example.com' },
      });
      expect(response.status).toBe(401);
    } finally {
      await wrongTokenServer.close();
    }
  });

  it('returns 502 when the toolshed operator endpoint is unreachable', async () => {
    await fakeOperator.close();
    const response = await request(server.port, 'POST', '/api/approvals/a1/resolve', {
      token: DASHBOARD_TOKEN,
      body: { decision: 'approved', approverId: 'op@example.com' },
    });
    expect(response.status).toBe(502);
    expect((response.body as { error: string }).error).toContain('toolshed operator endpoint unreachable');
  });

  it('returns 502 with the Error.message when the fetch implementation throws a real Error instance', async () => {
    // Real network failures under this test environment's fetch
    // implementation don't reliably preserve `instanceof Error` across the
    // VM-modules realm boundary (see the "unreachable" test above, whose
    // real ECONNREFUSED still resolves usefully via the String(err)
    // fallback either way) — inject a genuine same-realm Error to
    // deterministically prove the err.message branch itself.
    const throwingFetch = (async () => {
      throw new Error('a real Error instance');
    }) as unknown as typeof fetch;
    const badFetchServer = await startDashboardServer(store, 0, undefined, [], undefined, {
      authToken: DASHBOARD_TOKEN,
      operatorUrl: `http://localhost:${fakeOperator.port}`,
      operatorToken: OPERATOR_TOKEN,
      fetchImpl: throwingFetch,
    });
    try {
      const response = await request(badFetchServer.port, 'GET', '/api/approvals/pending', { token: DASHBOARD_TOKEN });
      expect(response.status).toBe(502);
      expect(response.body).toEqual({
        error: 'toolshed operator endpoint unreachable: a real Error instance',
      });
    } finally {
      await badFetchServer.close();
    }
  });

  it('returns 400 when the request body is missing required fields, without calling the toolshed', async () => {
    const response = await request(server.port, 'POST', '/api/approvals/a1/resolve', {
      token: DASHBOARD_TOKEN,
      body: { decision: 'approved' },
    });
    expect(response.status).toBe(400);
    expect(fakeOperator.calls).toHaveLength(0);
  });

  it('returns 500 when the dashboard has no operatorUrl configured', async () => {
    const unconfiguredServer = await startDashboardServer(store, 0, undefined, [], undefined, {
      authToken: DASHBOARD_TOKEN,
    });
    try {
      const response = await request(unconfiguredServer.port, 'GET', '/api/approvals/pending', {
        token: DASHBOARD_TOKEN,
      });
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'dashboard is not configured with TOOLSHED_OPERATOR_URL' });
    } finally {
      await unconfiguredServer.close();
    }
  });

  it('returns 400 for a decision that is neither approved nor denied', async () => {
    const response = await request(server.port, 'POST', '/api/approvals/a1/resolve', {
      token: DASHBOARD_TOKEN,
      body: { decision: 'maybe', approverId: 'op@example.com' },
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "decision must be 'approved' or 'denied'" });
    expect(fakeOperator.calls).toHaveLength(0);
  });

  it('401s with an invalid/mismatched ?token= query param when no header is present (rejects, not just missing token)', async () => {
    const response = await request(server.port, 'GET', '/api/approvals/pending?token=wrong-token');
    expect(response.status).toBe(401);
  });

  it('rejects an approve/deny call whose body is a non-object, hitting the {} JSON-body fallback the same as an empty body', async () => {
    const response = await new Promise<Response>((resolve, reject) => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: server.port,
          path: '/api/approvals/a1/resolve',
          method: 'POST',
          headers: { Authorization: `Bearer ${DASHBOARD_TOKEN}`, 'Content-Type': 'application/json' },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "decision must be 'approved' or 'denied'" });
  });

  it('proxies with an empty Authorization bearer suffix when TOOLSHED_OPERATOR_TOKEN is not configured on the dashboard', async () => {
    const noOperatorTokenServer = await startDashboardServer(store, 0, undefined, [], undefined, {
      authToken: DASHBOARD_TOKEN,
      operatorUrl: `http://localhost:${fakeOperator.port}`,
      // operatorToken intentionally omitted
    });
    try {
      const response = await request(noOperatorTokenServer.port, 'GET', '/api/approvals/pending', {
        token: DASHBOARD_TOKEN,
      });
      // The fake operator server 401s an empty/wrong bearer, proving the
      // dashboard still forwarded SOME Authorization header (not a crash)
      // even with no operatorToken configured.
      expect(response.status).toBe(401);
    } finally {
      await noOperatorTokenServer.close();
    }
  });

  it('returns 502 with a String()-formatted error when the fetch implementation throws a non-Error value', async () => {
    const throwingFetch = (async () => {
      throw 'a non-Error rejection';
    }) as unknown as typeof fetch;
    const badFetchServer = await startDashboardServer(store, 0, undefined, [], undefined, {
      authToken: DASHBOARD_TOKEN,
      operatorUrl: `http://localhost:${fakeOperator.port}`,
      operatorToken: OPERATOR_TOKEN,
      fetchImpl: throwingFetch,
    });
    try {
      const response = await request(badFetchServer.port, 'GET', '/api/approvals/pending', { token: DASHBOARD_TOKEN });
      expect(response.status).toBe(502);
      expect(response.body).toEqual({
        error: 'toolshed operator endpoint unreachable: a non-Error rejection',
      });
    } finally {
      await badFetchServer.close();
    }
  });

  it('falls back to an undefined body when the operator endpoint responds with non-JSON', async () => {
    const nonJsonFetch = (async () =>
      new Response('not-json{{{', { status: 200 })) as unknown as typeof fetch;
    const badBodyServer = await startDashboardServer(store, 0, undefined, [], undefined, {
      authToken: DASHBOARD_TOKEN,
      operatorUrl: `http://localhost:${fakeOperator.port}`,
      operatorToken: OPERATOR_TOKEN,
      fetchImpl: nonJsonFetch,
    });
    try {
      const response = await request(badBodyServer.port, 'GET', '/api/approvals/pending', { token: DASHBOARD_TOKEN });
      expect(response.status).toBe(200);
      expect(response.body).toBeNull();
    } finally {
      await badBodyServer.close();
    }
  });

  it('returns 400 for an invalid JSON body', async () => {
    const response = await new Promise<Response>((resolve, reject) => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: server.port,
          path: '/api/approvals/a1/resolve',
          method: 'POST',
          headers: { Authorization: `Bearer ${DASHBOARD_TOKEN}`, 'Content-Type': 'application/json' },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
        }
      );
      req.on('error', reject);
      req.write('not-json{{{');
      req.end();
    });
    expect(response.status).toBe(400);
  });
});
