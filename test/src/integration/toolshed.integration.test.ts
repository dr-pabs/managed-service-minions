import { describe, expect, it, jest } from '@jest/globals';
import {
  createMemoryStore,
  createMockAdapter,
  createDefaultToolshedState,
  executeTool,
  initializeToolshed,
  resetToolshed,
} from 'mcp-toolshed';

describe('toolshed integration', () => {
  afterEach(() => {
    resetToolshed();
  });

  it('executes an allowed tool through the toolshed', async () => {
    const adapter = createMockAdapter('github', {
      callTool: async () => ({ path: '/repo/readme.md', content: 'hello' }),
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

    const result = await executeTool(
      { teamId: 'team-a', minionType: 'code-explorer', sessionId: 'sess_1', correlationId: 'corr_1', attempt: 1 },
      'github',
      'get_file_contents',
      { path: '/repo/readme.md' }
    );

    expect(result.status).toBe('success');
    expect(result.data).toEqual({ path: '/repo/readme.md', content: 'hello' });
    expect(store.listAuditEntries()).toHaveLength(1);
    expect(store.listAuditEntries()[0].status).toBe('success');
  });

  it('returns the cached result on identical calls to a tool marked cacheable', async () => {
    const callTool = jest.fn(async () => ({ cached: true })) as unknown as (
      name: string,
      params: unknown
    ) => Promise<unknown>;
    const adapter = createMockAdapter('github', { callTool });
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

    const ctx = { teamId: 'team-a', minionType: 'code-explorer', sessionId: 'sess_1', correlationId: 'corr_1', attempt: 1 };
    await executeTool(ctx, 'github', 'get_file_contents', { path: '/repo/readme.md' });
    const result = await executeTool(ctx, 'github', 'get_file_contents', { path: '/repo/readme.md' });

    expect(result.status).toBe('success');
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('does not cache a tool with no cache_policy entry (C3): identical calls invoke the adapter twice', async () => {
    const callTool = jest.fn(async () => ({ cached: true })) as unknown as (
      name: string,
      params: unknown
    ) => Promise<unknown>;
    const adapter = createMockAdapter('github', { callTool });
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

    const ctx = { teamId: 'team-a', minionType: 'code-explorer', sessionId: 'sess_1', correlationId: 'corr_1', attempt: 1 };
    await executeTool(ctx, 'github', 'get_file_contents', { path: '/repo/readme.md' });
    const result = await executeTool(ctx, 'github', 'get_file_contents', { path: '/repo/readme.md' });

    expect(result.status).toBe('success');
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('blocks disallowed tools', async () => {
    const store = createMemoryStore();
    initializeToolshed(
      createDefaultToolshedState({
        store,
        adapters: new Map(),
        allowlists: {
          allowlists: { code_explorer: { github: ['get_file_contents'] } },
          pathScopes: {},
        },
      })
    );

    const result = await executeTool(
      { teamId: 'team-a', minionType: 'code-explorer', sessionId: 'sess_1', correlationId: 'corr_1', attempt: 1 },
      'github',
      'delete_repo',
      {}
    );

    expect(result.status).toBe('blocked_by_allowlist');
    expect(store.listAuditEntries()).toHaveLength(1);
  });
});
