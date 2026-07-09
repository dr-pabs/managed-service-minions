import { jest } from '@jest/globals';
import http from 'node:http';
import { createMemoryStore, type SessionStore } from 'mcp-toolshed';
import { startDashboardServer } from '../src/dashboard.js';

function get(
  port: number,
  urlPath: string,
  token?: string
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token !== undefined) {
      headers.Authorization = `Bearer ${token}`;
    }
    const req = http.get(`http://localhost:${port}${urlPath}`, { headers }, (res) => {
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

describe('dashboard auth (Milestone 14, review finding M7 "dashboard has no auth")', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = createMemoryStore();
  });

  describe('when DASHBOARD_AUTH_TOKEN is configured', () => {
    let server: { close: () => Promise<void>; port: number };
    const TOKEN = 'test-dashboard-token';

    beforeEach(async () => {
      server = await startDashboardServer(store, 0, undefined, [], undefined, { authToken: TOKEN });
    });

    afterEach(async () => {
      await server.close();
    });

    it('401s a request with no Authorization header', async () => {
      const response = await get(server.port, '/sessions');
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'unauthorized' });
    });

    it('401s a request with the wrong bearer token', async () => {
      const response = await get(server.port, '/sessions', 'wrong-token');
      expect(response.status).toBe(401);
    });

    it('allows a request with the correct bearer token', async () => {
      const response = await get(server.port, '/sessions', TOKEN);
      expect(response.status).toBe(200);
    });

    it('gates the Milestone 13 cost endpoint too, and it still works once authenticated', async () => {
      const unauth = await get(server.port, '/api/sessions/s1/cost');
      expect(unauth.status).toBe(401);

      const authed = await get(server.port, '/api/sessions/s1/cost', TOKEN);
      expect(authed.status).toBe(200);
      expect(authed.body).toEqual({ totalTokens: 0, totalCostUsd: 0, byMinionType: {} });
    });

    it('gates the HTML root route too, not just JSON API routes', async () => {
      const response = await get(server.port, '/');
      expect(response.status).toBe(401);
    });

    it('gates /health as well (every request per the milestone text)', async () => {
      const response = await get(server.port, '/health');
      expect(response.status).toBe(401);
    });

    it('gates the approvals/audit/events routes added by this milestone', async () => {
      const approvals = await get(server.port, '/api/approvals/pending');
      const audit = await get(server.port, '/api/audit');
      expect(approvals.status).toBe(401);
      expect(audit.status).toBe(401);
    });
  });

  describe('when DASHBOARD_AUTH_TOKEN is unset (local dev)', () => {
    let server: { close: () => Promise<void>; port: number };
    let warnSpy: ReturnType<typeof jest.spyOn>;

    beforeEach(async () => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      server = await startDashboardServer(store, 0, undefined, [], undefined, {});
    });

    afterEach(async () => {
      await server.close();
      warnSpy.mockRestore();
    });

    it('keeps the open (pre-Milestone-14) behavior when no token is configured', async () => {
      const response = await get(server.port, '/sessions');
      expect(response.status).toBe(200);
    });

    it('logs a loud warning at startup that auth is disabled', () => {
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('DASHBOARD_AUTH_TOKEN is not set')
      );
    });
  });

  it('falls back to "/" when req.url is missing on the auth check (defensive fallback for a malformed request line)', async () => {
    // node:http guarantees req.url on any real request that reaches a
    // handler, so this exercises isDashboardAuthorized's `req.url ?? '/'`
    // fallback directly, the same defensive-fallback pattern already used
    // by operator-http.test.ts and dashboard-server-errors.test.ts.
    let capturedHandler: http.RequestListener | undefined;
    const fakeCreateServer: typeof http.createServer = (handler) => {
      capturedHandler = handler as http.RequestListener;
      return http.createServer(handler);
    };
    const directServer = await startDashboardServer(store, 0, fakeCreateServer, [], undefined, {
      authToken: 'secret',
    });

    const chunks: Buffer[] = [];
    const fakeReq = { url: undefined, headers: {}, method: 'GET' };
    const fakeRes = {
      writeHead: () => undefined,
      end: (data: string) => chunks.push(Buffer.from(data)),
    };
    await capturedHandler?.(fakeReq as never, fakeRes as never);
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ error: 'unauthorized' });

    await directServer.close();
  });

  it('treats an empty-string auth token the same as unset (open dev mode, not a fail-closed empty secret)', async () => {
    // Consistent with how a falsy env var reads in JS/the operator-http
    // convention elsewhere in this repo: `''` and `undefined` both mean "no
    // token configured" rather than "configured to require an empty string".
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const server = await startDashboardServer(store, 0, undefined, [], undefined, { authToken: '' });
    try {
      const response = await get(server.port, '/sessions');
      expect(response.status).toBe(200);
    } finally {
      await server.close();
      warnSpy.mockRestore();
    }
  });
});
