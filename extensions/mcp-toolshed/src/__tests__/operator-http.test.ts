import http from 'node:http';
import { startOperatorHttpServer } from '../operator-http.js';
import { createMemoryStore } from '../store.js';
import { initializeToolshed, resetToolshed, createDefaultToolshedState } from '../toolshed.js';

interface Response {
  status: number;
  body: unknown;
}

function request(
  port: number,
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {}
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.token !== undefined) {
      headers.Authorization = `Bearer ${options.token}`;
    }
    const req = http.request({ hostname: 'localhost', port, path, method, headers }, (res) => {
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

const OPERATOR_TOKEN = 'test-operator-token';

describe('startOperatorHttpServer (Milestone 4, H3/F1 — the operator surface startToolshedServer(port) finally uses)', () => {
  let server: { close: () => Promise<void>; port: number };
  let store: ReturnType<typeof createMemoryStore>;

  beforeEach(async () => {
    store = createMemoryStore();
    initializeToolshed(createDefaultToolshedState({ store, adapters: new Map() }));
    server = await startOperatorHttpServer(store, 0, OPERATOR_TOKEN);
  });

  afterEach(async () => {
    await server.close();
    resetToolshed();
  });

  it('rejects a request with no Authorization header (401)', async () => {
    const response = await request(server.port, 'GET', '/approvals/pending');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
  });

  it('rejects a request with the wrong bearer token (401)', async () => {
    const response = await request(server.port, 'GET', '/approvals/pending', { token: 'wrong-token' });
    expect(response.status).toBe(401);
  });

  it('rejects every request when the operator token is configured as empty (fail closed)', async () => {
    const emptyTokenServer = await startOperatorHttpServer(store, 0, '');
    const response = await request(emptyTokenServer.port, 'GET', '/approvals/pending', { token: '' });
    expect(response.status).toBe(401);
    await emptyTokenServer.close();
  });

  it('GET /approvals/pending lists pending approvals with a valid token', async () => {
    store.createApproval({
      id: 'a1',
      sessionId: 's1',
      correlationId: 'corr_1',
      serverAlias: 'github',
      toolName: 'merge_pull_request',
      paramsJson: '{}',
      requestedAt: 1,
      timeoutAt: 2,
      requestHash: 'hash_1',
    });
    const response = await request(server.port, 'GET', '/approvals/pending', { token: OPERATOR_TOKEN });
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
  });

  it('POST /approvals/:id/resolve approves a pending approval, defaulting approverKind to dashboard when absent', async () => {
    store.createApproval({
      id: 'a1',
      sessionId: 's1',
      correlationId: 'corr_1',
      serverAlias: 'github',
      toolName: 'merge_pull_request',
      paramsJson: '{}',
      requestedAt: 1,
      timeoutAt: 999_999_999_999,
      requestHash: 'hash_1',
    });

    const response = await request(server.port, 'POST', '/approvals/a1/resolve', {
      token: OPERATOR_TOKEN,
      body: { decision: 'approved', approverId: 'operator_1' },
    });

    expect(response.status).toBe(200);
    expect(store.getApproval('a1')?.decision).toBe('approved');
    expect(store.getApproval('a1')?.approverKind).toBe('dashboard');
    expect(store.getApproval('a1')?.approverId).toBe('operator_1');
  });

  it('POST /approvals/:id/resolve records the approverKind supplied in the body (M4 review N1: slack is not dashboard)', async () => {
    store.createApproval({
      id: 'a_slack',
      sessionId: 's1',
      correlationId: 'corr_1',
      serverAlias: 'github',
      toolName: 'merge_pull_request',
      paramsJson: '{}',
      requestedAt: 1,
      timeoutAt: 999_999_999_999,
      requestHash: 'hash_slack',
    });

    const response = await request(server.port, 'POST', '/approvals/a_slack/resolve', {
      token: OPERATOR_TOKEN,
      body: { decision: 'approved', approverId: 'U123', approverKind: 'slack' },
    });

    expect(response.status).toBe(200);
    expect(store.getApproval('a_slack')?.approverKind).toBe('slack');
    expect(store.getApproval('a_slack')?.approverId).toBe('U123');
  });

  it('POST /approvals/:id/resolve rejects an approverKind outside slack|teams|dashboard (400)', async () => {
    const response = await request(server.port, 'POST', '/approvals/a1/resolve', {
      token: OPERATOR_TOKEN,
      body: { decision: 'approved', approverId: 'U123', approverKind: 'minion' },
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "approverKind must be 'slack', 'teams', or 'dashboard'" });
  });

  it('POST /approvals/:id/resolve denies a pending approval', async () => {
    store.createApproval({
      id: 'a1',
      sessionId: 's1',
      correlationId: 'corr_1',
      serverAlias: 'github',
      toolName: 'merge_pull_request',
      paramsJson: '{}',
      requestedAt: 1,
      timeoutAt: 999_999_999_999,
      requestHash: 'hash_1',
    });

    const response = await request(server.port, 'POST', '/approvals/a1/resolve', {
      token: OPERATOR_TOKEN,
      body: { decision: 'denied', approverId: 'operator_1' },
    });

    expect(response.status).toBe(200);
    expect(store.getApproval('a1')?.decision).toBe('denied');
  });

  it('POST /approvals/:id/resolve returns 404 for a missing approval', async () => {
    const response = await request(server.port, 'POST', '/approvals/missing/resolve', {
      token: OPERATOR_TOKEN,
      body: { decision: 'approved', approverId: 'operator_1' },
    });
    expect(response.status).toBe(404);
  });

  it('POST /approvals/:id/resolve rejects an invalid decision value', async () => {
    const response = await request(server.port, 'POST', '/approvals/a1/resolve', {
      token: OPERATOR_TOKEN,
      body: { decision: 'maybe', approverId: 'operator_1' },
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "decision must be 'approved' or 'denied'" });
  });

  it('POST /approvals/:id/resolve rejects a missing approverId', async () => {
    const response = await request(server.port, 'POST', '/approvals/a1/resolve', {
      token: OPERATOR_TOKEN,
      body: { decision: 'approved' },
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'approverId is required' });
  });

  it('POST /approvals/:id/resolve with an empty body is treated as {} and rejected for a missing decision', async () => {
    const response = await new Promise<Response>((resolve, reject) => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: server.port,
          path: '/approvals/a1/resolve',
          method: 'POST',
          headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` },
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

  it('POST /approvals/:id/resolve rejects an invalid JSON body', async () => {
    const response = await new Promise<Response>((resolve, reject) => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: server.port,
          path: '/approvals/a1/resolve',
          method: 'POST',
          headers: { Authorization: `Bearer ${OPERATOR_TOKEN}`, 'Content-Type': 'application/json' },
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
    expect(response.body).toEqual({ error: 'invalid JSON body' });
  });

  it('returns 404 for an unknown route (with a valid token)', async () => {
    const response = await request(server.port, 'GET', '/unknown', { token: OPERATOR_TOKEN });
    expect(response.status).toBe(404);
  });

  it('returns 500 when the store throws', async () => {
    store.listPendingApprovals = () => {
      throw new Error('store exploded');
    };
    const response = await request(server.port, 'GET', '/approvals/pending', { token: OPERATOR_TOKEN });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'store exploded' });
  });

  it('handles a non-Error thrown by the store with String() (500)', async () => {
    store.listPendingApprovals = () => {
      throw 'not an Error instance';
    };
    const response = await request(server.port, 'GET', '/approvals/pending', { token: OPERATOR_TOKEN });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'not an Error instance' });
  });

  it('resolves the listening port when 0 is requested (ephemeral port)', () => {
    expect(server.port).toBeGreaterThan(0);
  });

  it('treats a missing req.url as "/" (defensive fallback for a malformed request line)', async () => {
    // node:http guarantees req.url on any real request that reaches a
    // handler, so this fallback is defense-in-depth that a live socket
    // cannot exercise — invoke the request handler directly with req.url
    // deleted to prove the `req.url ?? '/'` fallback behaves sanely rather
    // than throwing.
    let capturedHandler: http.RequestListener | undefined;
    const fakeCreateServer: typeof http.createServer = (handler) => {
      capturedHandler = handler as http.RequestListener;
      return http.createServer(handler);
    };
    const directServer = await startOperatorHttpServer(store, 0, OPERATOR_TOKEN, fakeCreateServer);

    const chunks: Buffer[] = [];
    const fakeReq = { url: undefined, headers: { authorization: `Bearer ${OPERATOR_TOKEN}` }, method: 'GET' };
    const fakeRes = {
      writeHead: () => undefined,
      end: (data: string) => chunks.push(Buffer.from(data)),
    };
    await capturedHandler?.(fakeReq as never, fakeRes as never);
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ error: 'Not found' });

    await directServer.close();
  });

  it('resolves the listening port from a non-object server.address() (defensive fallback)', async () => {
    // A real TCP listener's address() always returns an object once
    // `listening` — this exercises the ternary's string/null fallback
    // branch, which a live socket cannot produce.
    const realCreateServer = http.createServer.bind(http);
    const fakeCreateServer: typeof http.createServer = (...args: Parameters<typeof http.createServer>) => {
      const real = realCreateServer(...args);
      real.address = () => null;
      return real;
    };
    const fallbackServer = await startOperatorHttpServer(store, 0, OPERATOR_TOKEN, fakeCreateServer);
    // With address() returning null, the requested port (0) is echoed back
    // verbatim rather than the OS-assigned ephemeral port.
    expect(fallbackServer.port).toBe(0);
    await fallbackServer.close();
  });

  it('close() rejects when the underlying server.close() errors', async () => {
    // A fake createServer whose returned server fails to close, so the
    // rejection branch of startOperatorHttpServer's close() wrapper is
    // exercised without depending on a real socket-level close failure.
    const realCreateServer = http.createServer.bind(http);
    const fakeCreateServer: typeof http.createServer = (...args: Parameters<typeof http.createServer>) => {
      const real = realCreateServer(...args);
      const originalClose = real.close.bind(real);
      real.close = ((callback?: (err?: Error) => void) => {
        originalClose();
        callback?.(new Error('close failed'));
        return real;
      }) as typeof real.close;
      return real;
    };

    const failingServer = await startOperatorHttpServer(store, 0, OPERATOR_TOKEN, fakeCreateServer);
    await expect(failingServer.close()).rejects.toThrow('close failed');
  });
});
