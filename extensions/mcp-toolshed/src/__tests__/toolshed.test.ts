import { jest } from '@jest/globals';
import { mintMinionToken } from 'framework-core';
import {
  executeTool,
  verifyAndExecuteTool,
  initializeToolshed,
  resetToolshed,
  createDefaultToolshedState,
  getToolshedState,
  waitForApproval,
  resolveApprovalRecord,
} from '../toolshed.js';
import { createMemoryStore } from '../store.js';
import { createMockAdapter } from '../adapter.js';
import { TokenBucketRateLimiter } from '../rate-limiter.js';

const SECRET = 'test-signing-secret';

describe('executeTool', () => {
  const baseCtx = {
    teamId: 'team-a',
    minionType: 'code-explorer',
    sessionId: 'sess_1',
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

  it('truncates undefined params to the literal string "undefined" in the audit log', async () => {
    const audit: unknown[] = [];
    initializeToolshed(
      createDefaultToolshedState({
        store: createMemoryStore(),
        adapters: new Map(),
        auditLogger: (entry) => audit.push(entry),
      })
    );
    await executeTool(baseCtx, 'github', 'delete_repo', undefined);
    const entry = audit[0] as { params: string };
    expect(entry.params).toBe('undefined');
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

describe('resolveApprovalRecord (internal — not exposed as an MCP tool, C1 fix)', () => {
  afterEach(() => {
    resetToolshed();
  });

  it('returns error when toolshed is not initialized', () => {
    const result = resolveApprovalRecord('appr_1', 'approved', { kind: 'dashboard', id: 'operator_1' });
    expect(result.status).toBe('error');
  });

  it('returns error when approval is missing', () => {
    initializeToolshed(
      createDefaultToolshedState({
        store: createMemoryStore(),
        adapters: new Map(),
      })
    );
    const result = resolveApprovalRecord('missing', 'approved', { kind: 'dashboard', id: 'operator_1' });
    expect(result.status).toBe('error');
    expect(result.error).toContain('missing');
  });

  it('resolves an existing approval and records the operator identity', () => {
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
    const result = resolveApprovalRecord('appr_1', 'approved', { kind: 'slack', id: 'U123' });
    expect(result.status).toBe('success');
    expect(store.getApproval('appr_1')?.decision).toBe('approved');
    expect(store.getApproval('appr_1')?.approverKind).toBe('slack');
    expect(store.getApproval('appr_1')?.approverId).toBe('U123');
  });
});

describe('verifyAndExecuteTool (C1/C2 fix: identity comes only from a verified token)', () => {
  afterEach(() => {
    resetToolshed();
  });

  it('returns error when toolshed is not initialized', async () => {
    const result = await verifyAndExecuteTool(
      { minionToken: 'whatever', correlationId: 'corr_1', attempt: 1 },
      'github',
      'get_file_contents',
      {}
    );
    expect(result.status).toBe('error');
    expect(result.error).toBe('Toolshed not initialized');
  });

  it('executes with a valid token, deriving minionType/sessionId only from the verified payload', async () => {
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
        signingSecret: SECRET,
      })
    );

    const token = mintMinionToken(
      { minionType: 'code_explorer', sessionId: 'sess_1', correlationId: 'corr_1' },
      SECRET
    );
    const result = await verifyAndExecuteTool(
      { minionToken: token, correlationId: 'corr_1', attempt: 1 },
      'github',
      'get_file_contents',
      { path: '/repo/readme.md' }
    );
    expect(result.status).toBe('success');
    expect(result.data).toEqual({ content: 'hello' });
    expect(store.listAuditEntries()[0].minionType).toBe('code_explorer');
  });

  it('blocks a token minted for a minionType lacking the tool (blocked_by_allowlist)', async () => {
    const store = createMemoryStore();
    initializeToolshed(
      createDefaultToolshedState({
        store,
        adapters: new Map(),
        allowlists: {
          allowlists: { code_explorer: { github: ['get_file_contents'] } },
          pathScopes: {},
        },
        signingSecret: SECRET,
      })
    );

    // Token minted for a minion type that has no allowlist entry for github
    // at all — proves the allowlist check runs against the *verified*
    // minionType, not any caller-supplied value.
    const token = mintMinionToken(
      { minionType: 'ticket_analyst', sessionId: 'sess_1', correlationId: 'corr_1' },
      SECRET
    );
    const result = await verifyAndExecuteTool(
      { minionToken: token, correlationId: 'corr_1', attempt: 1 },
      'github',
      'get_file_contents',
      { path: '/repo/readme.md' }
    );
    expect(result.status).toBe('blocked_by_allowlist');
  });

  it('rejects a forged/tampered token and audits the rejection (invariant 2)', async () => {
    const store = createMemoryStore();
    initializeToolshed(
      createDefaultToolshedState({
        store,
        adapters: new Map(),
        signingSecret: SECRET,
      })
    );

    const token = mintMinionToken(
      { minionType: 'code_explorer', sessionId: 'sess_1', correlationId: 'corr_1' },
      'wrong-secret'
    );
    const result = await verifyAndExecuteTool(
      { minionToken: token, correlationId: 'corr_1', attempt: 1 },
      'github',
      'get_file_contents',
      { path: '/repo/readme.md' }
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('invalid minion token');

    // The rejection is itself an audited exit path: no verified identity
    // exists yet, so the entry is labeled plainly rather than trusting any
    // caller-supplied minionType/teamId (that trust is the C2 bug).
    const entries = store.listAuditEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('error');
    expect(entries[0].error).toContain('invalid minion token');
    expect(entries[0].minionType).toBe('unverified');
  });

  it('survives an audit logger failure on a rejected-token exit path', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    initializeToolshed(
      createDefaultToolshedState({
        store: createMemoryStore(),
        adapters: new Map(),
        signingSecret: SECRET,
        auditLogger: async () => {
          throw new Error('audit sink offline');
        },
      })
    );

    const result = await verifyAndExecuteTool(
      { minionToken: 'garbage', correlationId: 'corr_1', attempt: 1 },
      'github',
      'get_file_contents',
      {}
    );
    expect(result.status).toBe('error');
    await new Promise<void>((resolve) => process.nextTick(resolve));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('audit sink offline'));
    consoleSpy.mockRestore();
  });

  it('survives a synchronous, non-error audit logger failure on a rejected-token exit path', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    initializeToolshed(
      createDefaultToolshedState({
        store: createMemoryStore(),
        adapters: new Map(),
        signingSecret: SECRET,
        auditLogger: () => {
          throw 'string failure';
        },
      })
    );

    const result = await verifyAndExecuteTool(
      { minionToken: 'garbage', correlationId: 'corr_1', attempt: 1 },
      'github',
      'get_file_contents',
      {}
    );
    expect(result.status).toBe('error');
    await new Promise<void>((resolve) => process.nextTick(resolve));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('string failure'));
    consoleSpy.mockRestore();
  });

  it('uses the caller-supplied legacyTeamId alongside a valid token, when present', async () => {
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
        signingSecret: SECRET,
      })
    );

    const token = mintMinionToken(
      { minionType: 'code_explorer', sessionId: 'sess_1', correlationId: 'corr_1' },
      SECRET
    );
    const result = await verifyAndExecuteTool(
      { minionToken: token, correlationId: 'corr_1', attempt: 1, legacyTeamId: 'team-explicit' },
      'github',
      'get_file_contents',
      { path: '/repo/readme.md' }
    );
    expect(result.status).toBe('success');
    expect(store.listAuditEntries()[0].teamId).toBe('team-explicit');
  });

  it('rejects garbage tokens the same way as a forged signature', async () => {
    const store = createMemoryStore();
    initializeToolshed(
      createDefaultToolshedState({
        store,
        adapters: new Map(),
        signingSecret: SECRET,
      })
    );

    const result = await verifyAndExecuteTool(
      { minionToken: 'not-a-real-token', correlationId: 'corr_1', attempt: 1 },
      'github',
      'get_file_contents',
      {}
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('invalid minion token');
  });

  it('rejects any token when no signingSecret is configured (falls back to empty string)', async () => {
    const store = createMemoryStore();
    initializeToolshed(
      createDefaultToolshedState({
        store,
        adapters: new Map(),
        // signingSecret intentionally omitted.
      })
    );

    const token = mintMinionToken(
      { minionType: 'code_explorer', sessionId: 'sess_1', correlationId: 'corr_1' },
      SECRET
    );
    const result = await verifyAndExecuteTool(
      { minionToken: token, correlationId: 'corr_1', attempt: 1 },
      'github',
      'get_file_contents',
      {}
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('invalid minion token');
  });

  it('rejects an unsigned call (no minion_token) when the dev flag is off (default)', async () => {
    const store = createMemoryStore();
    initializeToolshed(
      createDefaultToolshedState({
        store,
        adapters: new Map(),
        signingSecret: SECRET,
        allowUnsignedTokens: false,
      })
    );

    const result = await verifyAndExecuteTool(
      { correlationId: 'corr_1', attempt: 1, legacyMinionType: 'code_explorer', legacyTeamId: 'team-a' },
      'github',
      'get_file_contents',
      { path: '/repo/readme.md' }
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('invalid minion token');
    expect(store.listAuditEntries()).toHaveLength(1);
  });

  it('accepts legacy self-reported identity only when TOOLSHED_ALLOW_UNSIGNED dev flag is on', async () => {
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
        signingSecret: SECRET,
        allowUnsignedTokens: true,
      })
    );

    const result = await verifyAndExecuteTool(
      { correlationId: 'corr_1', attempt: 1, legacyMinionType: 'code_explorer', legacyTeamId: 'team-a' },
      'github',
      'get_file_contents',
      { path: '/repo/readme.md' }
    );
    expect(result.status).toBe('success');
  });

  it('defaults legacy sessionId/teamId when unsigned and none supplied', async () => {
    const store = createMemoryStore();
    initializeToolshed(
      createDefaultToolshedState({
        store,
        adapters: new Map(),
        allowUnsignedTokens: true,
      })
    );

    const result = await verifyAndExecuteTool(
      { correlationId: 'corr_1', attempt: 1 },
      'github',
      'get_file_contents',
      {}
    );
    expect(result.status).toBe('blocked_by_allowlist');
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
