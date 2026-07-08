/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest } from '@jest/globals';
import { resetToolshed } from '../toolshed.js';
import { mintMinionToken } from 'framework-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockSetRequestHandler = jest.fn() as jest.Mock<any>;
const mockConnect = jest.fn() as jest.Mock<any>;
const mockCreateMcpAdapter = jest.fn() as jest.Mock<any>;

const MockServer = jest.fn() as jest.Mock<any>;
const MockTransport = jest.fn() as jest.Mock<any>;

jest.unstable_mockModule('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: MockServer,
}));

jest.unstable_mockModule('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: MockTransport,
}));

jest.unstable_mockModule('../adapter.js', () => ({
  createMcpAdapter: mockCreateMcpAdapter,
}));

MockServer.mockImplementation(() => ({
  setRequestHandler: mockSetRequestHandler,
  connect: mockConnect,
}));

MockTransport.mockImplementation(() => ({}));

const { parseAdapterConfigs, buildToolshedState, startToolshedServer } = await import('../server.js');

const SECRET = 'test-signing-secret';

describe('server', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolshed-server-'));
    resetToolshed();
    mockSetRequestHandler.mockClear();
    mockConnect.mockClear();
    mockCreateMcpAdapter.mockClear();
    mockConnect.mockResolvedValue(undefined);
    process.env.TOOLSHED_SIGNING_SECRET = SECRET;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TOOLSHED_ALLOWLISTS_PATH;
    delete process.env.TOOLSHED_GOVERNANCE_PATH;
    delete process.env.TOOLSHED_STORE_PATH;
    delete process.env.TOOLSHED_ADAPTERS;
    delete process.env.TOOLSHED_REPO_ROOT;
    delete process.env.TOOLSHED_SIGNING_SECRET;
    delete process.env.TOOLSHED_ALLOW_UNSIGNED;
    delete process.env.NODE_ENV;
    resetToolshed();
  });

  describe('parseAdapterConfigs', () => {
    it('returns empty array for undefined input', () => {
      expect(parseAdapterConfigs(undefined)).toEqual([]);
    });

    it('returns empty array for invalid JSON', () => {
      expect(parseAdapterConfigs('not-json')).toEqual([]);
    });

    it('returns empty array for non-array JSON', () => {
      expect(parseAdapterConfigs('{}')).toEqual([]);
    });

    it('parses valid JSON array', () => {
      const configs = [{ alias: 'github', command: 'node', args: ['github-mcp.js'] }];
      expect(parseAdapterConfigs(JSON.stringify(configs))).toEqual(configs);
    });
  });

  describe('buildToolshedState', () => {
    it('builds state from environment variables', async () => {
      const allowlistsPath = path.join(tmpDir, 'allowlists.yaml');
      const governancePath = path.join(tmpDir, 'governance.yaml');
      fs.writeFileSync(
        allowlistsPath,
        `allowlists:\n  code_explorer:\n    github:\n      - get_file_contents\n`
      );
      fs.writeFileSync(
        governancePath,
        `governance:\n  approval_timeout_minutes: 5\n  rate_limits:\n    default:\n      requests_per_minute: 10\n      burst: 2\n`
      );
      process.env.TOOLSHED_ALLOWLISTS_PATH = allowlistsPath;
      process.env.TOOLSHED_GOVERNANCE_PATH = governancePath;
      process.env.TOOLSHED_STORE_PATH = ':memory:';
      process.env.TOOLSHED_ADAPTERS = JSON.stringify([]);

      const state = await buildToolshedState();
      expect(state.governance.approvalTimeoutMinutes).toBe(5);
      expect(state.allowlists.allowlists.code_explorer.github).toContain('get_file_contents');
      expect(state.signingSecret).toBe(SECRET);
      expect(state.allowUnsignedTokens).toBe(false);
    });

    it('connects adapters from environment config', async () => {
      process.env.TOOLSHED_ADAPTERS = JSON.stringify([{ alias: 'github', command: 'node' }]);
      mockCreateMcpAdapter.mockResolvedValue({ alias: 'github', health: async () => ({ healthy: true, latencyMs: 0 }), listTools: async () => [], callTool: async () => ({}) });

      const state = await buildToolshedState();
      expect(state.adapters.has('github')).toBe(true);
    });

    it('uses default rate limit when config omits default', async () => {
      const governancePath = path.join(tmpDir, 'governance.yaml');
      fs.writeFileSync(governancePath, `governance:\n  approval_timeout_minutes: 5\n`);
      process.env.TOOLSHED_GOVERNANCE_PATH = governancePath;
      process.env.TOOLSHED_STORE_PATH = ':memory:';
      process.env.TOOLSHED_ADAPTERS = JSON.stringify([]);

      const state = await buildToolshedState();
      expect(state.rateLimiter.canExecute('key').allowed).toBe(true);
    });

    it('warns and continues when an adapter fails to connect', async () => {
      process.env.TOOLSHED_ADAPTERS = JSON.stringify([{ alias: 'github', command: 'node' }]);
      mockCreateMcpAdapter.mockRejectedValue(new Error('connection failed'));
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      const state = await buildToolshedState();
      expect(state.adapters.has('github')).toBe(false);
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('warns with non-error adapter failures', async () => {
      process.env.TOOLSHED_ADAPTERS = JSON.stringify([{ alias: 'github', command: 'node' }]);
      mockCreateMcpAdapter.mockRejectedValue('string failure');
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      const state = await buildToolshedState();
      expect(state.adapters.has('github')).toBe(false);

      warnSpy.mockRestore();
    });

    it('succeeds when TOOLSHED_REPO_ROOT points at a config tree with zero validator errors', async () => {
      process.env.TOOLSHED_ADAPTERS = JSON.stringify([]);
      process.env.TOOLSHED_REPO_ROOT = path.resolve(tmpDir, '..', '..', '..', '..', '..');
      const state = await buildToolshedState();
      expect(state).toBeDefined();
      delete process.env.TOOLSHED_REPO_ROOT;
    });

    it('logs every validator error and refuses to start when TOOLSHED_REPO_ROOT has config drift', async () => {
      process.env.TOOLSHED_ADAPTERS = JSON.stringify([]);
      fs.writeFileSync(
        path.join(tmpDir, 'placeholder.txt'),
        'an empty repo root has no agents/, rules/, or schemas/ dirs, so nothing to cross-check but the intent enum still triggers warnings, not errors'
      );
      // A repo root with no agents/*.md at all has nothing to flag under
      // check (a); use one with a real drift instead: an agents/ dir whose
      // frontmatter minion_type has no allowlists entry.
      fs.mkdirSync(path.join(tmpDir, 'agents'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'agents', 'ghost.md'),
        ['---', 'name: ghost', 'minion_type: ghost_type', '---', '# Ghost'].join('\n')
      );
      fs.mkdirSync(path.join(tmpDir, 'rules'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'rules', 'allowlists.yaml'), 'allowlists: {}\n');
      fs.mkdirSync(path.join(tmpDir, 'schemas'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'schemas', 'intent.json'), '{}');

      process.env.TOOLSHED_REPO_ROOT = tmpDir;
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(buildToolshedState()).rejects.toThrow(/config validation failed/i);
      expect(errorSpy).toHaveBeenCalled();
      const loggedMessages = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(loggedMessages.some((m) => m.includes('ghost_type'))).toBe(true);

      errorSpy.mockRestore();
      delete process.env.TOOLSHED_REPO_ROOT;
    });

    it('throws at startup when TOOLSHED_SIGNING_SECRET is unset in production', async () => {
      delete process.env.TOOLSHED_SIGNING_SECRET;
      process.env.NODE_ENV = 'production';
      process.env.TOOLSHED_ADAPTERS = JSON.stringify([]);

      await expect(buildToolshedState()).rejects.toThrow(/TOOLSHED_SIGNING_SECRET is required in production/i);
    });

    it('warns loudly but continues when TOOLSHED_SIGNING_SECRET is unset outside production', async () => {
      delete process.env.TOOLSHED_SIGNING_SECRET;
      process.env.TOOLSHED_ADAPTERS = JSON.stringify([]);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      const state = await buildToolshedState();
      expect(state.signingSecret).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('TOOLSHED_SIGNING_SECRET is not set'));

      warnSpy.mockRestore();
    });

    it('warns loudly when TOOLSHED_ALLOW_UNSIGNED=1 is set', async () => {
      process.env.TOOLSHED_ALLOW_UNSIGNED = '1';
      process.env.TOOLSHED_ADAPTERS = JSON.stringify([]);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      const state = await buildToolshedState();
      expect(state.allowUnsignedTokens).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('TOOLSHED_ALLOW_UNSIGNED=1'));

      warnSpy.mockRestore();
    });
  });

  describe('startToolshedServer', () => {
    it('starts the server and registers handlers', async () => {
      process.env.TOOLSHED_ADAPTERS = JSON.stringify([]);
      await startToolshedServer(3000);
      expect(mockSetRequestHandler).toHaveBeenCalledTimes(2);
    });

    it('invokes the ListTools handler and no longer exposes resolve_approval (C1 regression)', async () => {
      process.env.TOOLSHED_ADAPTERS = JSON.stringify([]);
      await startToolshedServer(3000);
      const listToolsHandler = mockSetRequestHandler.mock.calls[0][1] as (req: unknown) => Promise<{ tools: Array<{ name: string }> }>;
      const response = await listToolsHandler?.({});
      expect(response.tools).toHaveLength(1);
      expect(response.tools.map((t) => t.name)).toContain('execute_tool');
      expect(response.tools.map((t) => t.name)).not.toContain('resolve_approval');
    });

    it('invokes the CallTool handler with a valid minion token', async () => {
      process.env.TOOLSHED_ADAPTERS = JSON.stringify([]);
      await startToolshedServer(3000);
      const callToolHandler = mockSetRequestHandler.mock.calls[1][1] as (req: unknown) => Promise<{ content: Array<{ text: string }> }>;
      const token = mintMinionToken({ minionType: 'code_explorer', sessionId: 'sess_1', correlationId: 'corr_1' }, SECRET);
      const response = await callToolHandler?.({
        params: {
          arguments: {
            correlation_id: 'corr_1',
            minion_token: token,
            server_alias: 'github',
            tool_name: 'get_file_contents',
            params: { path: '/repo/readme.md' },
          },
        },
      });
      expect(response).toBeDefined();
      // No allowlists.yaml is configured (default env), so this reaches the
      // pipeline (past identity verification) and is blocked by the
      // allowlist step — proving the token was verified and accepted, not
      // merely that some error occurred.
      expect(response.content[0].text).toContain('blocked_by_allowlist');
    });

    it('invokes the CallTool handler without a minion token and rejects the call', async () => {
      process.env.TOOLSHED_ADAPTERS = JSON.stringify([]);
      await startToolshedServer(3000);
      const callToolHandler = mockSetRequestHandler.mock.calls[1][1] as (req: unknown) => Promise<{ content: Array<{ text: string }> }>;
      const response = await callToolHandler?.({
        params: {
          arguments: {
            correlation_id: 'corr_1',
            server_alias: 'github',
            tool_name: 'get_file_contents',
          },
        },
      });
      expect(response.content[0].text).toContain('invalid minion token');
    });

    it('invokes the CallTool handler without arguments', async () => {
      process.env.TOOLSHED_ADAPTERS = JSON.stringify([]);
      await startToolshedServer(3000);
      const callToolHandler = mockSetRequestHandler.mock.calls[1][1] as (req: unknown) => Promise<{ content: Array<{ text: string }> }>;
      const response = await callToolHandler?.({ params: {} });
      expect(response.content[0].text).toContain('invalid minion token');
    });

    it('rejects a forged/tampered minion token', async () => {
      process.env.TOOLSHED_ADAPTERS = JSON.stringify([]);
      await startToolshedServer(3000);
      const callToolHandler = mockSetRequestHandler.mock.calls[1][1] as (req: unknown) => Promise<{ content: Array<{ text: string }> }>;
      const token = mintMinionToken({ minionType: 'code_explorer', sessionId: 'sess_1', correlationId: 'corr_1' }, 'wrong-secret');
      const response = await callToolHandler?.({
        params: {
          arguments: {
            correlation_id: 'corr_1',
            minion_token: token,
            server_alias: 'github',
            tool_name: 'get_file_contents',
            params: { path: '/repo/readme.md' },
          },
        },
      });
      expect(response.content[0].text).toContain('invalid minion token');
    });

    it('accepts legacy minion_type/team_id params only when TOOLSHED_ALLOW_UNSIGNED=1', async () => {
      resetToolshed();
      process.env.TOOLSHED_ADAPTERS = JSON.stringify([]);
      process.env.TOOLSHED_ALLOW_UNSIGNED = '1';
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      await startToolshedServer(3000);
      warnSpy.mockRestore();
      const callToolHandler = mockSetRequestHandler.mock.calls[1][1] as (req: unknown) => Promise<{ content: Array<{ text: string }> }>;
      const response = await callToolHandler?.({
        params: {
          arguments: {
            correlation_id: 'corr_1',
            team_id: 'team-a',
            minion_type: 'code_explorer',
            server_alias: 'github',
            tool_name: 'get_file_contents',
            params: { path: '/repo/readme.md' },
          },
        },
      });
      expect(response.content[0].text).toContain('blocked_by_allowlist');
    });
  });
});
