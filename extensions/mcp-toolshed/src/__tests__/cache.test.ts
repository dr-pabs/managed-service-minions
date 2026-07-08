import {
  executeTool,
  initializeToolshed,
  resetToolshed,
  createDefaultToolshedState,
} from '../toolshed.js';
import { createMemoryStore } from '../store.js';
import { createMockAdapter } from '../adapter.js';

/**
 * Milestone 2 (C3 / F4): caching must be opt-in, read-only, and TTL-bound.
 * These tests are written first, per the ExecPlan's TDD requirement, and are
 * expected to FAIL against the pre-milestone code (which caches every tool
 * call unconditionally and forever, silently dropping repeat writes).
 */
describe('cache policy (C3 / F4)', () => {
  const baseCtx = {
    teamId: 'team-a',
    minionType: 'pr_create',
    correlationId: 'corr_1',
    attempt: 1,
  };

  afterEach(() => {
    resetToolshed();
  });

  it('invokes the adapter twice for a non-cacheable tool called twice', async () => {
    let calls = 0;
    const adapter = createMockAdapter('github', {
      callTool: async () => {
        calls += 1;
        return { content: `call-${calls}` };
      },
    });
    initializeToolshed(
      createDefaultToolshedState({
        store: createMemoryStore(),
        adapters: new Map([['github', adapter]]),
        allowlists: {
          allowlists: { pr_create: { github: ['github_get_pull_request'] } },
          pathScopes: {},
          shellCommands: {},
        },
        governance: {
          destructiveActions: [],
          approvalTimeoutMinutes: 15,
          rateLimits: { default: { requestsPerMinute: 6000, burst: 6000 } },
          workspaceBoundaries: { allowedBasePaths: ['/repo'], denyPatterns: [] },
          cachePolicy: { default: { cacheable: false } },
          pathCheckedTools: {},
        },
      })
    );

    const first = await executeTool(baseCtx, 'github', 'github_get_pull_request', { pr: 1 });
    const second = await executeTool(baseCtx, 'github', 'github_get_pull_request', { pr: 1 });

    expect(calls).toBe(2);
    expect(first.data).toEqual({ content: 'call-1' });
    expect(second.data).toEqual({ content: 'call-2' });
  });

  it('C3 regression: github_create_pull_request called twice invokes the adapter twice (destructive writes are never dropped)', async () => {
    let calls = 0;
    const adapter = createMockAdapter('github', {
      callTool: async () => {
        calls += 1;
        return { number: calls };
      },
    });
    initializeToolshed(
      createDefaultToolshedState({
        store: createMemoryStore(),
        adapters: new Map([['github', adapter]]),
        allowlists: {
          allowlists: { pr_create: { github: ['github_create_pull_request'] } },
          pathScopes: {},
          shellCommands: {},
        },
        governance: {
          destructiveActions: [],
          approvalTimeoutMinutes: 15,
          rateLimits: { default: { requestsPerMinute: 6000, burst: 6000 } },
          workspaceBoundaries: { allowedBasePaths: ['/repo'], denyPatterns: [] },
          cachePolicy: { default: { cacheable: false } },
          pathCheckedTools: {},
        },
      })
    );

    const first = await executeTool(baseCtx, 'github', 'github_create_pull_request', {
      title: 'Fix bug',
    });
    const second = await executeTool(baseCtx, 'github', 'github_create_pull_request', {
      title: 'Fix bug',
    });

    expect(calls).toBe(2);
    expect(first.data).toEqual({ number: 1 });
    expect(second.data).toEqual({ number: 2 });
  });

  it('a cacheable tool respects TTL using an injected clock', async () => {
    let calls = 0;
    const adapter = createMockAdapter('github', {
      callTool: async () => {
        calls += 1;
        return { diff: `diff-${calls}` };
      },
    });
    let now = 1_000_000;
    const clock = () => now;
    const store = createMemoryStore(clock);
    initializeToolshed(
      createDefaultToolshedState({
        store,
        adapters: new Map([['github', adapter]]),
        allowlists: {
          allowlists: { pr_create: { github: ['github_get_pull_request_diff'] } },
          pathScopes: {},
          shellCommands: {},
        },
        governance: {
          destructiveActions: [],
          approvalTimeoutMinutes: 15,
          rateLimits: { default: { requestsPerMinute: 6000, burst: 6000 } },
          workspaceBoundaries: { allowedBasePaths: ['/repo'], denyPatterns: [] },
          cachePolicy: {
            default: { cacheable: false },
            github_get_pull_request_diff: { cacheable: true, ttlSeconds: 300 },
          },
          pathCheckedTools: {},
        },
      })
    );

    const first = await executeTool(baseCtx, 'github', 'github_get_pull_request_diff', { pr: 1 });
    expect(first.data).toEqual({ diff: 'diff-1' });
    expect(calls).toBe(1);

    // Still within TTL (299s later): served from cache, adapter not called again.
    now += 299_000;
    const second = await executeTool(baseCtx, 'github', 'github_get_pull_request_diff', { pr: 1 });
    expect(second.data).toEqual({ diff: 'diff-1' });
    expect(calls).toBe(1);

    // Past TTL (another 2s later, total 301s): cache expired, adapter called again.
    now += 2_000;
    const third = await executeTool(baseCtx, 'github', 'github_get_pull_request_diff', { pr: 1 });
    expect(third.data).toEqual({ diff: 'diff-2' });
    expect(calls).toBe(2);
  });

  it('treats a cacheable tool with no ttl_seconds as immediately expiring (ttl defaults to 0)', async () => {
    let calls = 0;
    const adapter = createMockAdapter('github', {
      callTool: async () => {
        calls += 1;
        return { diff: `diff-${calls}` };
      },
    });
    initializeToolshed(
      createDefaultToolshedState({
        store: createMemoryStore(),
        adapters: new Map([['github', adapter]]),
        allowlists: {
          allowlists: { pr_create: { github: ['github_get_pull_request_diff'] } },
          pathScopes: {},
          shellCommands: {},
        },
        governance: {
          destructiveActions: [],
          approvalTimeoutMinutes: 15,
          rateLimits: { default: { requestsPerMinute: 6000, burst: 6000 } },
          workspaceBoundaries: { allowedBasePaths: ['/repo'], denyPatterns: [] },
          cachePolicy: {
            default: { cacheable: false },
            github_get_pull_request_diff: { cacheable: true },
          },
          pathCheckedTools: {},
        },
      })
    );

    await executeTool(baseCtx, 'github', 'github_get_pull_request_diff', { pr: 1 });
    const second = await executeTool(baseCtx, 'github', 'github_get_pull_request_diff', { pr: 1 });
    expect(second.data).toEqual({ diff: 'diff-2' });
    expect(calls).toBe(2);
  });
});
