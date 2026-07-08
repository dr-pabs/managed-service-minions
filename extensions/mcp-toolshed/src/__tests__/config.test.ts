import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadAllowlists,
  loadGovernance,
  isDestructive,
  isToolAllowed,
  isPathAllowed,
  getCachePolicy,
} from '../config.js';

describe('config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolshed-config-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadAllowlists', () => {
    it('returns defaults when path is missing', () => {
      const config = loadAllowlists();
      expect(config.allowlists).toEqual({});
      expect(config.pathScopes).toEqual({});
    });

    it('loads allowlists from YAML', () => {
      const allowlistsPath = path.join(tmpDir, 'allowlists.yaml');
      fs.writeFileSync(
        allowlistsPath,
        `
allowlists:
  code_explorer:
    github:
      - search_repositories
      - get_file_contents
path_scopes:
  code_explorer:
    mode: allowlist
    paths:
      - /repo
    deny:
      - .git/
      - node_modules/
  broad_explorer:
    mode: denylist
    deny:
      - secrets/
  no_mode:
    paths:
      - /repo
`
      );
      const config = loadAllowlists(allowlistsPath);
      expect(isToolAllowed(config, 'code-explorer', 'github', 'search_repositories')).toBe(true);
      expect(isToolAllowed(config, 'code-explorer', 'github', 'delete_repo')).toBe(false);
      expect(config.pathScopes.code_explorer.mode).toBe('allowlist');
      expect(config.pathScopes.broad_explorer.mode).toBe('denylist');
      expect(config.pathScopes.no_mode.mode).toBe('none');
    });

    it('returns defaults when file does not exist', () => {
      const config = loadAllowlists(path.join(tmpDir, 'missing.yaml'));
      expect(config.allowlists).toEqual({});
    });
  });

  describe('loadGovernance', () => {
    it('returns defaults when path is missing', () => {
      const config = loadGovernance();
      expect(config.approvalTimeoutMinutes).toBe(15);
      expect(config.rateLimits.default.requestsPerMinute).toBe(60);
    });

    it('loads governance from YAML', () => {
      const governancePath = path.join(tmpDir, 'governance.yaml');
      fs.writeFileSync(
        governancePath,
        `
governance:
  destructive_actions:
    - server_alias: github
      tool_name: merge_pull_request
    - server_alias: jira
      tool_name: transition_issue
      params:
        status: Closed
  approval_timeout_minutes: 30
  rate_limits:
    default:
      requests_per_minute: 120
      burst: 40
  workspace_boundaries:
    allowed_base_paths:
      - /repo
      - /workspace
    deny_patterns:
      - .git/
  cache_policy:
    default:
      cacheable: false
    github_get_pull_request_diff:
      cacheable: true
      ttl_seconds: 300
`
      );
      const config = loadGovernance(governancePath);
      expect(config.approvalTimeoutMinutes).toBe(30);
      expect(config.rateLimits.default.requestsPerMinute).toBe(120);
      expect(config.workspaceBoundaries.allowedBasePaths).toContain('/workspace');
      expect(isDestructive(config, 'github', 'merge_pull_request')).toBe(true);
      expect(isDestructive(config, 'jira', 'transition_issue', { status: 'Closed' })).toBe(true);
      expect(isDestructive(config, 'jira', 'transition_issue', { status: 'Open' })).toBe(false);
      expect(isDestructive(config, 'jira', 'transition_issue')).toBe(false);
      expect(isDestructive(config, 'github', 'delete_branch')).toBe(false);
      expect(config.cachePolicy.github_get_pull_request_diff).toEqual({
        cacheable: true,
        ttlSeconds: 300,
      });
      expect(config.cachePolicy.default).toEqual({ cacheable: false });
    });

    it('loads governance without top-level governance key', () => {
      const governancePath = path.join(tmpDir, 'governance-flat.yaml');
      fs.writeFileSync(
        governancePath,
        `
destructive_actions:
  - server_alias: github
    tool_name: delete_branch
approval_timeout_minutes: 7
`
      );
      const config = loadGovernance(governancePath);
      expect(config.approvalTimeoutMinutes).toBe(7);
      expect(isDestructive(config, 'github', 'delete_branch')).toBe(true);
    });

    it('applies defaults for partial rate limits and boundaries', () => {
      const governancePath = path.join(tmpDir, 'governance.yaml');
      fs.writeFileSync(
        governancePath,
        `
governance:
  rate_limits:
    default:
      requests_per_minute: 10
    slow:
      burst: 1
  workspace_boundaries:
    allowed_base_paths:
      - /workspace
`
      );
      const config = loadGovernance(governancePath);
      expect(config.rateLimits.default.burst).toBe(20);
      expect(config.rateLimits.slow.requestsPerMinute).toBe(60);
      expect(config.workspaceBoundaries.denyPatterns).toEqual(['.git/', 'node_modules/', 'secrets/', '.env*']);
    });
  });

  describe('getCachePolicy', () => {
    it('returns an explicit per-tool entry over the default', () => {
      const config = loadGovernance();
      const withPolicy = {
        ...config,
        cachePolicy: {
          default: { cacheable: false },
          github_get_pull_request_diff: { cacheable: true, ttlSeconds: 300 },
        },
      };
      expect(getCachePolicy(withPolicy, 'github_get_pull_request_diff')).toEqual({
        cacheable: true,
        ttlSeconds: 300,
      });
    });

    it('falls back to the default entry for a tool with no explicit policy', () => {
      const config = loadGovernance();
      const withPolicy = {
        ...config,
        cachePolicy: { default: { cacheable: false } },
      };
      expect(getCachePolicy(withPolicy, 'github_create_pull_request')).toEqual({ cacheable: false });
    });

    it('falls back to non-cacheable when cachePolicy has no default entry at all', () => {
      const config = loadGovernance();
      const withPolicy = { ...config, cachePolicy: {} };
      expect(getCachePolicy(withPolicy, 'anything')).toEqual({ cacheable: false });
    });

    it('normalizes a cache_policy entry that omits the cacheable key to non-cacheable', () => {
      const governancePath = path.join(tmpDir, 'governance.yaml');
      fs.writeFileSync(
        governancePath,
        `
governance:
  cache_policy:
    some_tool:
      ttl_seconds: 60
`
      );
      const config = loadGovernance(governancePath);
      expect(config.cachePolicy.some_tool).toEqual({ cacheable: false, ttlSeconds: 60 });
    });
  });

  describe('isToolAllowed', () => {
    it('rejects unknown minion', () => {
      const config: Parameters<typeof isToolAllowed>[0] = {
        allowlists: {},
        pathScopes: {},
      };
      expect(isToolAllowed(config, 'unknown', 'github', 'get_file_contents')).toBe(false);
    });

    it('rejects unknown server for known minion', () => {
      const config: Parameters<typeof isToolAllowed>[0] = {
        allowlists: { code_explorer: { github: ['get_file_contents'] } },
        pathScopes: {},
      };
      expect(isToolAllowed(config, 'code-explorer', 'ado', 'get_item')).toBe(false);
    });
  });

  describe('isPathAllowed', () => {
    const governance = loadGovernance();

    it('allows non-filesystem tools', () => {
      const allowlists = loadAllowlists();
      expect(isPathAllowed(allowlists, governance, 'code-explorer', 'get_pr').allowed).toBe(true);
    });

    it('allows filesystem tools without a path', () => {
      const allowlists = loadAllowlists();
      expect(isPathAllowed(allowlists, governance, 'code-explorer', 'read_file', {}).allowed).toBe(true);
      expect(isPathAllowed(allowlists, governance, 'code-explorer', 'read_file', undefined).allowed).toBe(true);
    });

    it('blocks paths outside base paths', () => {
      const allowlists = loadAllowlists();
      expect(isPathAllowed(allowlists, governance, 'code-explorer', 'read_file', { path: '/etc/passwd' }).allowed).toBe(false);
    });

    it('enforces allowlist mode', () => {
      const allowlistsPath = path.join(tmpDir, 'allowlists.yaml');
      fs.writeFileSync(
        allowlistsPath,
        `
path_scopes:
  code_explorer:
    mode: allowlist
    paths:
      - /repo/auth
    deny:
      - .git/
  empty_allowlist:
    mode: allowlist
`
      );
      const allowlists = loadAllowlists(allowlistsPath);
      expect(isPathAllowed(allowlists, governance, 'code-explorer', 'read_file', { path: '/repo/auth/login.ts' }).allowed).toBe(true);
      expect(isPathAllowed(allowlists, governance, 'code-explorer', 'read_file', { path: '/repo/billing/card.ts' }).allowed).toBe(false);
      expect(isPathAllowed(allowlists, governance, 'empty-allowlist', 'read_file', { path: '/repo/readme.md' }).allowed).toBe(false);
    });

    it('enforces denylist mode', () => {
      const allowlistsPath = path.join(tmpDir, 'allowlists.yaml');
      fs.writeFileSync(
        allowlistsPath,
        `
path_scopes:
  broad_explorer:
    mode: denylist
    deny:
      - secrets/
`
      );
      const allowlists = loadAllowlists(allowlistsPath);
      expect(isPathAllowed(allowlists, governance, 'broad-explorer', 'read_file', { path: '/repo/secrets/key.env' }).allowed).toBe(false);
      expect(isPathAllowed(allowlists, governance, 'broad-explorer', 'read_file', { path: '/repo/readme.md' }).allowed).toBe(true);
    });

    it('falls back to global deny patterns when no scope', () => {
      const allowlists = loadAllowlists();
      expect(isPathAllowed(allowlists, governance, 'no-scope', 'read_file', { path: '/repo/node_modules/x' }).allowed).toBe(false);
      expect(isPathAllowed(allowlists, governance, 'no-scope', 'read_file', { path: '/repo/readme.md' }).allowed).toBe(true);
    });
  });
});
