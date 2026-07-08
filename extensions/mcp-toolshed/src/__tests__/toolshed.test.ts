import { jest } from '@jest/globals';
import {
  executeTool,
  initializeToolshed,
  resetToolshed,
  createDefaultToolshedState,
  getToolshedState,
  waitForApproval,
  resolveApproval,
} from '../toolshed.js';
import { createMemoryStore } from '../store.js';
import { createMockAdapter } from '../adapter.js';
import { TokenBucketRateLimiter } from '../rate-limiter.js';

describe('executeTool', () => {
  const baseCtx = {
    teamId: 'team-a',
    minionType: 'code-explorer',
    correlationId: 'corr_1',
    attempt: 1,
  };

  afterEach(() => {
    resetToolshed();
  });

  it('returns error when toolshed is not initialized', async () => {
    const result = await executeTool(baseCtx, 'github', 'get_file_contents', { path: '/repo/readme.md' });
    expect(result.status).toBe('error');
    expect(result.error).toBe('Toolshed not initialized');
  });

  it('blocks tools not on the allowlist', async () => {
    const store = createMemoryStore();
    initializeToolshed(
      createDefaultToolshedState({
        store,
        adapters: new Map(),
      })
    );
    const result = await executeTool(baseCtx, 'github', 'delete_repo', {});
    expect(result.status).toBe('blocked_by_allowlist');
    expect(store.listAuditEntries()).toHaveLength(1);
    expect(store.listAuditEntries()[0].status).toBe('blocked_by_allowlist');
  });

  it('handles non-object params', async () => {
    initializeToolshed(
      createDefaultToolshedState({
        store: createMemoryStore(),
        adapters: new Map(),
        allowlists: {
          allowlists: { code_explorer: { github: ['get_file_contents'] } },
          pathScopes: {},
        },
      })
    );
    const result = await executeTool(baseCtx, 'github', 'get_file_contents', null);
    expect(result.status).toBe('error');
  });

  it('blocks filesystem paths outside the base path', async () => {
    initializeToolshed(
      createDefaultToolshedState({
        store: createMemoryStore(),
        adapters: new Map(),
        allowlists: {
          allowlists: { code_explorer: { filesystem: ['read_file'] } },
          pathScopes: {},
        },
      })
    );
    const result = await executeTool(baseCtx, 'filesystem', 'read_file', { path: '/etc/passwd' });
    expect(result.status).toBe('blocked_by_allowlist');
  });

  it('throttles when rate limit is exceeded', async () => {
    const limiter = new TokenBucketRateLimiter({ requestsPerMinute: 60, burst: 0 });
    initializeToolshed(
      createDefaultToolshedState({
        store: createMemoryStore(),
        adapters: new Map(),
        allowlists: {
          allowlists: { code_explorer: { filesystem: ['read_file'] } },
          pathScopes: {},
        },
        rateLimiter: limiter,
      })
    );
    const result = await executeTool(baseCtx, 'filesystem', 'read_file', { path: '/repo/readme.md' });
    expect(result.status).toBe('throttled');
  });

  it('throttles when circuit breaker is open', async () => {
    initializeToolshed(
      createDefaultToolshedState({
        store: createMemoryStore(),
        adapters: new Map(),
        allowlists: {
          allowlists: { code_explorer: { filesystem: ['read_file'] } },
          pathScopes: {},
        },
        circuitBreakerConfig: {
          failureThreshold: 1,
          successThreshold: 1,
          timeoutSecs: 60,
          halfOpenMaxRequests: 1,
        },
      })
    );
    await executeTool(baseCtx, 'filesystem', 'read_file', { path: '/repo/readme.md' });
    const result = await executeTool(baseCtx, 'filesystem', 'read_file', { path: '/repo/readme.md' });
    expect(result.status).toBe('throttled');
    expect(result.error).toBe('Circuit breaker is open');
  });

  it('requires approval and executes destructive actions when approved', async () => {
    jest.useFakeTimers({ legacyFakeTimers: true });
    const adapter = createMockAdapter('github', {
      callTool: async () => ({ merged: true }),
    });
    const store = createMemoryStore();
    initializeToolshed(
      createDefaultToolshedState({
        store,
        adapters: new Map([['github', adapter]]),
        allowlists: {
          allowlists: { code_explorer: { github: ['merge_pull_request'] } },
          pathScopes: {},
        },
        governance: {
          destructiveActions: [{ serverAlias: 'github', toolName: 'merge_pull_request' }],
          approvalTimeoutMinutes: 15,
          rateLimits: { default: { requestsPerMinute: 60, burst: 20 } },
          workspaceBoundaries: { allowedBasePaths: ['/repo'], denyPatterns: [] },
          cachePolicy: { default: { cacheable: false } },
        },
      })
    );

    let approvalId = '';
    const originalCreateApproval = store.createApproval.bind(store);
    store.createApproval = jest.fn((approval) => {
      approvalId = approval.id;
      originalCreateApproval(approval);
    });

    const promise = executeTool(baseCtx, 'github', 'merge_pull_request', { pr: 1 });
    jest.advanceTimersByTime(1000);
    store.resolveApproval(approvalId, 'approved');

    const result = await promise;
    expect(result.status).toBe('success');
    expect(result.data).toEqual({ merged: true });
    jest.useRealTimers();
  });

  it('requires approval and denies destructive actions when denied', async () => {
    jest.useFakeTimers({ legacyFakeTimers: true });
    const store = createMemoryStore();
    initializeToolshed(
      createDefaultToolshedState({
        store,
        adapters: new Map(),
        allowlists: {
          allowlists: { code_explorer: { github: ['merge_pull_request'] } },
          pathScopes: {},
        },
        governance: {
          destructiveActions: [{ serverAlias: 'github', toolName: 'merge_pull_request' }],
          approvalTimeoutMinutes: 15,
          rateLimits: { default: { requestsPerMinute: 60, burst: 20 } },
          workspaceBoundaries: { allowedBasePaths: ['/repo'], denyPatterns: [] },
          cachePolicy: { default: { cacheable: false } },
        },
      })
    );

    let approvalId = '';
    const originalCreateApproval = store.createApproval.bind(store);
    store.createApproval = jest.fn((approval) => {
      approvalId = approval.id;
      originalCreateApproval(approval);
    });

    const promise = executeTool(baseCtx, 'github', 'merge_pull_request', { pr: 1 });
    jest.advanceTimersByTime(1000);
    store.resolveApproval(approvalId, 'denied');

    const result = await promise;
    expect(result.status).toBe('approval_denied');
    jest.useRealTimers();
  });

  it('times out when approval is not resolved', async () => {
    jest.useFakeTimers({ legacyFakeTimers: true });
    const store = createMemoryStore();
    initializeToolshed(
      createDefaultToolshedState({
        store,
        adapters: new Map(),
        allowlists: {
          allowlists: { code_explorer: { github: ['merge_pull_request'] } },
          pathScopes: {},
        },
        governance: {
          destructiveActions: [{ serverAlias: 'github', toolName: 'merge_pull_request' }],
          approvalTimeoutMinutes: 0.001,
          rateLimits: { default: { requestsPerMinute: 60, burst: 20 } },
          workspaceBoundaries: { allowedBasePaths: ['/repo'], denyPatterns: [] },
          cachePolicy: { default: { cacheable: false } },
        },
      })
    );

    const promise = executeTool(baseCtx, 'github', 'merge_pull_request', { pr: 1 });
    jest.advanceTimersByTime(200);

    const result = await promise;
    expect(result.status).toBe('approval_timeout');
    jest.useRealTimers();
  });

  it('survives an async audit logger failure', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    initializeToolshed(
      createDefaultToolshedState({
        store: createMemoryStore(),
        adapters: new Map(),
        auditLogger: async () => {
          throw new Error('audit sink offline');
        },
      })
    );
    const result = await executeTool(baseCtx, 'github', 'delete_repo', {});
    expect(result.status).toBe('blocked_by_allowlist');
    await new Promise<void>((resolve) => process.nextTick(resolve));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('audit sink offline'));
    consoleSpy.mockRestore();
  });

  it('survives a synchronous audit logger failure with a non-error', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    initializeToolshed(
      createDefaultToolshedState({
        store: createMemoryStore(),
        adapters: new Map(),
        auditLogger: () => {
          throw 'string failure';
        },
      })
    );
    const result = await executeTool(baseCtx, 'github', 'delete_repo', {});
    expect(result.status).toBe('blocked_by_allowlist');
    await new Promise<void>((resolve) => process.nextTick(resolve));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('string failure'));
    consoleSpy.mockRestore();
  });

  it('returns cached results for a tool marked cacheable in governance', async () => {
    const store = createMemoryStore();
    store.setCachedToolCall(
      'team-a:code-explorer:github:get_file_contents:{"path":"/repo/readme.md"}',
      { content: 'cached' },
      300_000
    );
    initializeToolshed(
      createDefaultToolshedState({
        store,
        adapters: new Map(),
        allowlists: {
          allowlists: { code_explorer: { github: ['get_file_contents'] } },
          pathScopes: {},
        },
        governance: {
          destructiveActions: [],
          approvalTimeoutMinutes: 15,
          rateLimits: { default: { requestsPerMinute: 60, burst: 20 } },
          workspaceBoundaries: { allowedBasePaths: ['/repo'], denyPatterns: [] },
          cachePolicy: {
            default: { cacheable: false },
            get_file_contents: { cacheable: true, ttlSeconds: 300 },
          },
        },
      })
    );
    const result = await executeTool(baseCtx, 'github', 'get_file_contents', { path: '/repo/readme.md' });
    expect(result.status).toBe('success');
    expect(result.data).toEqual({ content: 'cached' });
  });

  it('does not consult the cache for a tool not marked cacheable, even if a stale entry exists', async () => {
    const adapter = createMockAdapter('github', {
      callTool: async () => ({ content: 'fresh' }),
    });
    const store = createMemoryStore();
    store.setCachedToolCall(
      'team-a:code-explorer:github:get_file_contents:{"path":"/repo/readme.md"}',
      { content: 'stale' },
      300_000
    );
    initializeToolshed(
      createDefaultToolshedState({
        store,
        adapters: new Map([['github', adapter]]),
        allowlists: {
          allowlists: { code_explorer: { github: ['get_file_contents'] } },
          pathScopes: {},
        },
      })
    );
    const result = await executeTool(baseCtx, 'github', 'get_file_contents', { path: '/repo/readme.md' });
    expect(result.status).toBe('success');
    expect(result.data).toEqual({ content: 'fresh' });
  });

  it('returns error for unknown server alias', async () => {
    initializeToolshed(
      createDefaultToolshedState({
        store: createMemoryStore(),
        adapters: new Map(),
        allowlists: {
          allowlists: { code_explorer: { github: ['get_file_contents'] } },
          pathScopes: {},
        },
      })
    );
    const result = await executeTool(baseCtx, 'github', 'get_file_contents', { path: '/repo/readme.md' });
    expect(result.status).toBe('error');
    expect(result.error).toContain('Unknown MCP server alias');
  });

  it('executes a tool marked cacheable through an adapter and caches the result', async () => {
    const adapter = createMockAdapter('github', {
      callTool: async () => ({ content: 'hello' }),
    });
    const store = createMemoryStore();
    initializeToolshed(
      createDefaultToolshedState({
        store,
        adapters: new Map([['github', adapter]]),
        allowlists: {
          allowlists: { code_explorer: { github: ['get_file_contents'] } },
          pathScopes: {},
        },
        governance: {
          destructiveActions: [],
          approvalTimeoutMinutes: 15,
          rateLimits: { default: { requestsPerMinute: 60, burst: 20 } },
          workspaceBoundaries: { allowedBasePaths: ['/repo'], denyPatterns: [] },
          cachePolicy: {
            default: { cacheable: false },
            get_file_contents: { cacheable: true, ttlSeconds: 300 },
          },
        },
      })
    );
    const result = await executeTool(baseCtx, 'github', 'get_file_contents', { path: '/repo/readme.md' });
    expect(result.status).toBe('success');
    expect(result.data).toEqual({ content: 'hello' });
    const cached = store.getCachedToolCall(
      'team-a:code-explorer:github:get_file_contents:{"path":"/repo/readme.md"}'
    );
    expect(cached).toEqual({ content: 'hello' });
  });

  it('does not cache a tool that is not marked cacheable', async () => {
    const adapter = createMockAdapter('github', {
      callTool: async () => ({ content: 'hello' }),
    });
    const store = createMemoryStore();
    initializeToolshed(
      createDefaultToolshedState({
        store,
        adapters: new Map([['github', adapter]]),
        allowlists: {
          allowlists: { code_explorer: { github: ['get_file_contents'] } },
          pathScopes: {},
        },
      })
    );
    await executeTool(baseCtx, 'github', 'get_file_contents', { path: '/repo/readme.md' });
    const cached = store.getCachedToolCall(
      'team-a:code-explorer:github:get_file_contents:{"path":"/repo/readme.md"}'
    );
    expect(cached).toBeUndefined();
  });

  it('handles adapter errors and trips the breaker', async () => {
    const adapter = createMockAdapter('github', {
      callTool: async () => {
        throw new Error('boom');
      },
    });
    initializeToolshed(
      createDefaultToolshedState({
        store: createMemoryStore(),
        adapters: new Map([['github', adapter]]),
        allowlists: {
          allowlists: { code_explorer: { github: ['get_file_contents'] } },
          pathScopes: {},
        },
        circuitBreakerConfig: {
          failureThreshold: 5,
          successThreshold: 3,
          timeoutSecs: 30,
          halfOpenMaxRequests: 1,
        },
      })
    );
    const result = await executeTool(baseCtx, 'github', 'get_file_contents', { path: '/repo/readme.md' });
    expect(result.status).toBe('error');
    expect(result.error).toBe('boom');
  });

  it('handles non-error adapter failures', async () => {
    const adapter = createMockAdapter('github', {
      callTool: async () => {
        throw 'string error';
      },
    });
    initializeToolshed(
      createDefaultToolshedState({
        store: createMemoryStore(),
        adapters: new Map([['github', adapter]]),
        allowlists: {
          allowlists: { code_explorer: { github: ['get_file_contents'] } },
          pathScopes: {},
        },
      })
    );
    const result = await executeTool(baseCtx, 'github', 'get_file_contents', { path: '/repo/readme.md' });
    expect(result.status).toBe('error');
    expect(result.error).toBe('string error');
  });

  it('truncates large parameters in audit logs', async () => {
    const audit: unknown[] = [];
    initializeToolshed(
      createDefaultToolshedState({
        store: createMemoryStore(),
        adapters: new Map(),
        auditLogger: (entry) => audit.push(entry),
      })
    );
    const largeParams = { content: 'x'.repeat(10_000) };
    await executeTool(baseCtx, 'github', 'delete_repo', largeParams);
    const entry = audit[0] as { params: string };
    expect(entry.params.length).toBeLessThanOrEqual(4096 + '...[truncated]'.length);
    expect(entry.params).toContain('[truncated]');
  });
});

describe('toolshed state', () => {
  afterEach(() => {
    resetToolshed();
  });

  it('returns undefined before initialization', () => {
    expect(getToolshedState()).toBeUndefined();
  });

  it('returns the initialized state', () => {
    const state = createDefaultToolshedState({
      store: createMemoryStore(),
      adapters: new Map(),
    });
    initializeToolshed(state);
    expect(getToolshedState()).toBe(state);
  });
});

describe('resolveApproval', () => {
  afterEach(() => {
    resetToolshed();
  });

  it('returns error when toolshed is not initialized', () => {
    const result = resolveApproval('appr_1', 'approved');
    expect(result.status).toBe('error');
  });

  it('returns error when approval is missing', () => {
    initializeToolshed(
      createDefaultToolshedState({
        store: createMemoryStore(),
        adapters: new Map(),
      })
    );
    const result = resolveApproval('missing', 'approved');
    expect(result.status).toBe('error');
    expect(result.error).toContain('missing');
  });

  it('resolves an existing approval', () => {
    const store = createMemoryStore();
    store.createApproval({
      id: 'appr_1',
      sessionId: 's1',
      correlationId: 'corr_1',
      serverAlias: 'github',
      toolName: 'merge_pull_request',
      paramsJson: '{}',
      requestedAt: 1,
      timeoutAt: 2,
    });
    initializeToolshed(
      createDefaultToolshedState({
        store,
        adapters: new Map(),
      })
    );
    const result = resolveApproval('appr_1', 'approved');
    expect(result.status).toBe('success');
    expect(store.getApproval('appr_1')?.decision).toBe('approved');
  });
});

describe('waitForApproval', () => {
  it('returns approved when the store already has a decision', async () => {
    const store = createMemoryStore();
    store.createApproval({
      id: 'a1',
      sessionId: 's1',
      correlationId: 'corr_1',
      serverAlias: 'github',
      toolName: 'merge_pull_request',
      paramsJson: '{}',
      requestedAt: 1,
      timeoutAt: 2,
      decision: 'approved',
      decidedAt: 3,
    });

    const result = await waitForApproval(store, 'a1', 1000, 50);
    expect(result).toBe('approved');
  });

  it('returns denied when the store already has a decision', async () => {
    const store = createMemoryStore();
    store.createApproval({
      id: 'a1',
      sessionId: 's1',
      correlationId: 'corr_1',
      serverAlias: 'github',
      toolName: 'merge_pull_request',
      paramsJson: '{}',
      requestedAt: 1,
      timeoutAt: 2,
      decision: 'denied',
      decidedAt: 3,
    });

    const result = await waitForApproval(store, 'a1', 1000, 50);
    expect(result).toBe('denied');
  });

  it('polls until a decision is made', async () => {
    jest.useFakeTimers({ legacyFakeTimers: true });
    const store = createMemoryStore();
    store.createApproval({
      id: 'a1',
      sessionId: 's1',
      correlationId: 'corr_1',
      serverAlias: 'github',
      toolName: 'merge_pull_request',
      paramsJson: '{}',
      requestedAt: 1,
      timeoutAt: 1000,
    });

    const promise = waitForApproval(store, 'a1', 1000, 100);
    jest.advanceTimersByTime(250);
    store.resolveApproval('a1', 'approved');

    const result = await promise;
    expect(result).toBe('approved');
    jest.useRealTimers();
  });

  it('returns timeout when no decision is made', async () => {
    const store = createMemoryStore();
    store.createApproval({
      id: 'a1',
      sessionId: 's1',
      correlationId: 'corr_1',
      serverAlias: 'github',
      toolName: 'merge_pull_request',
      paramsJson: '{}',
      requestedAt: 1,
      timeoutAt: 1000,
    });

    const result = await waitForApproval(store, 'a1', 50, 25);
    expect(result).toBe('timeout');
  });
});
