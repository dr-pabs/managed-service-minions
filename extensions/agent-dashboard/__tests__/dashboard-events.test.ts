import http from 'node:http';
import { createMemoryStore, type SessionStore } from 'mcp-toolshed';
import { startDashboardServer } from '../src/dashboard.js';

/**
 * SSE test helper: connects, collects raw `data: ...` chunks off the
 * response stream, and lets the test trigger the injected poll tick
 * directly instead of waiting on a real 2s interval (per the milestone:
 * "injectable clock/interval so tests don't wait 2s").
 */
function connectSse(port: number, authToken?: string): Promise<{
  req: http.ClientRequest;
  res: http.IncomingMessage;
  events: string[];
  waitForEvent: () => Promise<string>;
}> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (authToken !== undefined) {
      headers.Authorization = `Bearer ${authToken}`;
    }
    const req = http.get(`http://localhost:${port}/api/events`, { headers }, (res) => {
      const events: string[] = [];
      let buffer = '';
      let pendingResolve: ((value: string) => void) | undefined;

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const line = part
            .split('\n')
            .find((l) => l.startsWith('data:'));
          if (line) {
            const payload = line.slice('data:'.length).trim();
            events.push(payload);
            if (pendingResolve) {
              pendingResolve(payload);
              pendingResolve = undefined;
            }
          }
        }
      });

      resolve({
        req,
        res,
        events,
        waitForEvent: () =>
          new Promise((res2) => {
            if (events.length > 0) {
              res2(events[events.length - 1]);
              return;
            }
            pendingResolve = res2;
          }),
      });
    });
    req.on('error', reject);
  });
}

describe('GET /api/events (Milestone 14 SSE live updates)', () => {
  let store: SessionStore;

  it('sends the correct SSE headers (Content-Type text/event-stream, no buffering)', async () => {
    store = createMemoryStore();
    const server = await startDashboardServer(store, 0, undefined, [], undefined, {});
    try {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.get(`http://localhost:${server.port}/api/events`, resolve);
        req.on('error', reject);
      });
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.headers['cache-control']).toContain('no-cache');
      expect(response.headers.connection).toBe('keep-alive');
      response.destroy();
    } finally {
      await server.close();
    }
  });

  it('emits an SSE event on a new pending approval, using the injectable poll interval (no real 2s wait)', async () => {
    store = createMemoryStore();
    let tick: (() => void) | undefined;
    const fakeSetInterval = (fn: () => void): NodeJS.Timeout => {
      tick = fn;
      return 0 as unknown as NodeJS.Timeout;
    };
    const fakeClearInterval = (): void => undefined;

    const server = await startDashboardServer(store, 0, undefined, [], undefined, {
      setIntervalFn: fakeSetInterval as unknown as typeof setInterval,
      clearIntervalFn: fakeClearInterval as unknown as typeof clearInterval,
    });
    try {
      const conn = await connectSse(server.port);

      store.createApproval({
        id: 'a1',
        sessionId: 's1',
        teamId: 'team-a',
        correlationId: 'corr_1',
        serverAlias: 'github',
        toolName: 'github_merge_pull_request',
        paramsJson: '{}',
        requestedAt: 1,
        timeoutAt: 999_999_999_999,
        requestHash: 'hash_1',
      });

      expect(tick).toBeDefined();
      tick?.();

      const payload = await conn.waitForEvent();
      const parsed = JSON.parse(payload);
      expect(parsed.type).toBe('approval');
      expect(parsed.data.id).toBe('a1');

      conn.req.destroy();
    } finally {
      await server.close();
    }
  });

  it('emits an SSE event on a new minion run', async () => {
    store = createMemoryStore();
    let tick: (() => void) | undefined;
    const server = await startDashboardServer(store, 0, undefined, [], undefined, {
      setIntervalFn: ((fn: () => void) => {
        tick = fn;
        return 0 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setInterval,
      clearIntervalFn: (() => undefined) as unknown as typeof clearInterval,
    });
    try {
      const conn = await connectSse(server.port);

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
      });

      tick?.();
      const payload = await conn.waitForEvent();
      expect(JSON.parse(payload).type).toBe('run');

      conn.req.destroy();
    } finally {
      await server.close();
    }
  });

  it('emits an SSE event on a new audit entry', async () => {
    store = createMemoryStore();
    let tick: (() => void) | undefined;
    const server = await startDashboardServer(store, 0, undefined, [], undefined, {
      setIntervalFn: ((fn: () => void) => {
        tick = fn;
        return 0 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setInterval,
      clearIntervalFn: (() => undefined) as unknown as typeof clearInterval,
    });
    try {
      const conn = await connectSse(server.port);

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

      tick?.();
      const payload = await conn.waitForEvent();
      expect(JSON.parse(payload).type).toBe('audit');

      conn.req.destroy();
    } finally {
      await server.close();
    }
  });

  it('does not replay pre-existing runs/approvals/audit entries that existed before the client connected (only a backlog-free stream)', async () => {
    store = createMemoryStore();
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
    });
    store.createApproval({
      id: 'a1',
      sessionId: 's1',
      teamId: 'team-a',
      correlationId: 'corr_1',
      serverAlias: 'github',
      toolName: 'github_merge_pull_request',
      paramsJson: '{}',
      requestedAt: 1,
      timeoutAt: 999_999_999_999,
      requestHash: 'hash_pre_existing',
    });
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

    let tick: (() => void) | undefined;
    const server = await startDashboardServer(store, 0, undefined, [], undefined, {
      setIntervalFn: ((fn: () => void) => {
        tick = fn;
        return 0 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setInterval,
      clearIntervalFn: (() => undefined) as unknown as typeof clearInterval,
    });
    try {
      const conn = await connectSse(server.port);
      tick?.();
      await new Promise((resolve) => setImmediate(resolve));
      expect(conn.events).toHaveLength(0);

      // Now create a genuinely new approval and confirm the stream is live.
      store.createApproval({
        id: 'a2',
        sessionId: 's1',
        teamId: 'team-a',
        correlationId: 'corr_1',
        serverAlias: 'github',
        toolName: 'github_merge_pull_request',
        paramsJson: '{}',
        requestedAt: 2,
        timeoutAt: 999_999_999_999,
        requestHash: 'hash_new',
      });
      tick?.();
      const payload = await conn.waitForEvent();
      expect(JSON.parse(payload).data.id).toBe('a2');

      conn.req.destroy();
    } finally {
      await server.close();
    }
  });

  it('does not re-emit an already-seen item on the next poll tick (only NEW items push)', async () => {
    store = createMemoryStore();
    let tick: (() => void) | undefined;
    const server = await startDashboardServer(store, 0, undefined, [], undefined, {
      setIntervalFn: ((fn: () => void) => {
        tick = fn;
        return 0 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setInterval,
      clearIntervalFn: (() => undefined) as unknown as typeof clearInterval,
    });
    try {
      const conn = await connectSse(server.port);
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
      });
      tick?.();
      await conn.waitForEvent();

      tick?.();
      // Give the event loop a tick to flush any (incorrect) duplicate write.
      await new Promise((resolve) => setImmediate(resolve));
      expect(conn.events).toHaveLength(1);

      conn.req.destroy();
    } finally {
      await server.close();
    }
  });

  it('clears the poll interval on client disconnect (no leaked interval per connection)', async () => {
    store = createMemoryStore();
    let intervalCleared = false;
    let clearedHandle: unknown;
    let createdHandle: unknown;
    const fakeSetInterval = ((): unknown => {
      createdHandle = { marker: 'the-interval-handle' };
      return createdHandle;
    }) as unknown as typeof setInterval;
    const fakeClearInterval = ((handle: unknown) => {
      intervalCleared = true;
      clearedHandle = handle;
    }) as unknown as typeof clearInterval;

    const server = await startDashboardServer(store, 0, undefined, [], undefined, {
      setIntervalFn: fakeSetInterval,
      clearIntervalFn: fakeClearInterval,
    });
    try {
      const conn = await connectSse(server.port);
      // Let the connection fully establish before tearing it down.
      await new Promise((resolve) => setImmediate(resolve));
      conn.req.destroy();
      // Give the server's 'close'/'aborted' handler a turn to run.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(intervalCleared).toBe(true);
      expect(clearedHandle).toBe(createdHandle);
    } finally {
      await server.close();
    }
  });

  it('401s the events stream when DASHBOARD_AUTH_TOKEN is configured and no token is presented', async () => {
    store = createMemoryStore();
    const server = await startDashboardServer(store, 0, undefined, [], undefined, { authToken: 'secret' });
    try {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.get(`http://localhost:${server.port}/api/events`, resolve);
        req.on('error', reject);
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('accepts a valid ?token= query param on /api/events (M18: the one route EventSource cannot attach headers to)', async () => {
    store = createMemoryStore();
    const server = await startDashboardServer(store, 0, undefined, [], undefined, { authToken: 'secret' });
    try {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.get(`http://localhost:${server.port}/api/events?token=secret`, resolve);
        req.on('error', reject);
      });
      expect(response.statusCode).toBe(200);
      response.destroy();
    } finally {
      await server.close();
    }
  });
});
