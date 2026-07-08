import fs from 'node:fs';
import yaml from 'js-yaml';

export interface AllowlistConfig {
  allowlists: Record<string, Record<string, string[]>>;
  pathScopes: Record<
    string,
    {
      mode: 'allowlist' | 'denylist' | 'none';
      paths?: string[];
      deny?: string[];
    }
  >;
}

export interface GovernanceConfig {
  destructiveActions: Array<{
    serverAlias: string;
    toolName: string;
    params?: Record<string, unknown>;
  }>;
  approvalTimeoutMinutes: number;
  rateLimits: Record<string, { requestsPerMinute: number; burst: number }>;
  workspaceBoundaries: {
    allowedBasePaths: string[];
    denyPatterns: string[];
  };
  cachePolicy: Record<string, { cacheable: boolean; ttlSeconds?: number }>;
}

const defaultAllowlists: AllowlistConfig = {
  allowlists: {},
  pathScopes: {},
};

const defaultGovernance: GovernanceConfig = {
  destructiveActions: [],
  approvalTimeoutMinutes: 15,
  rateLimits: {
    default: { requestsPerMinute: 60, burst: 20 },
  },
  workspaceBoundaries: {
    allowedBasePaths: ['/repo'],
    denyPatterns: ['.git/', 'node_modules/', 'secrets/', '.env*'],
  },
  cachePolicy: {
    default: { cacheable: false },
  },
};

function normalizeAllowlists(raw: unknown): AllowlistConfig {
  const data = raw as Record<string, unknown> | undefined;
  const allowlists = (data?.allowlists ?? {}) as AllowlistConfig['allowlists'];
  const pathScopes = (data?.path_scopes ?? {}) as Record<
    string,
    { mode?: string; paths?: string[]; deny?: string[] }
  >;

  const normalizedPathScopes: AllowlistConfig['pathScopes'] = {};
  for (const [minion, scope] of Object.entries(pathScopes)) {
    normalizedPathScopes[minion] = {
      mode: (scope.mode as 'allowlist' | 'denylist' | 'none') || 'none',
      paths: scope.paths,
      deny: scope.deny,
    };
  }

  return { allowlists, pathScopes: normalizedPathScopes };
}

function normalizeGovernance(raw: unknown): GovernanceConfig {
  const top = raw as Record<string, unknown> | undefined;
  const data = (top?.governance as Record<string, unknown> | undefined) ?? top;
  const destructiveActions = ((data?.destructive_actions ?? []) as Array<{
    server_alias: string;
    tool_name: string;
    params?: Record<string, unknown>;
  }>).map((action) => ({
    serverAlias: action.server_alias,
    toolName: action.tool_name,
    params: action.params,
  }));

  const rawRateLimits = (data?.rate_limits ?? {}) as Record<
    string,
    { requests_per_minute?: number; burst?: number }
  >;
  const rateLimits: GovernanceConfig['rateLimits'] = {};
  for (const [key, value] of Object.entries(rawRateLimits)) {
    rateLimits[key] = {
      requestsPerMinute: value.requests_per_minute ?? 60,
      burst: value.burst ?? 20,
    };
  }

  const rawBoundaries = (data?.workspace_boundaries ?? {}) as {
    allowed_base_paths?: string[];
    deny_patterns?: string[];
  };

  const rawCachePolicy = (data?.cache_policy ?? {}) as Record<
    string,
    { cacheable?: boolean; ttl_seconds?: number }
  >;
  const cachePolicy: GovernanceConfig['cachePolicy'] = {};
  for (const [key, value] of Object.entries(rawCachePolicy)) {
    cachePolicy[key] = {
      cacheable: value.cacheable ?? false,
      ttlSeconds: value.ttl_seconds,
    };
  }
  if (!cachePolicy.default) {
    cachePolicy.default = { cacheable: false };
  }

  return {
    destructiveActions,
    approvalTimeoutMinutes: (data?.approval_timeout_minutes as number) ?? 15,
    rateLimits,
    workspaceBoundaries: {
      allowedBasePaths: rawBoundaries.allowed_base_paths ?? ['/repo'],
      denyPatterns: rawBoundaries.deny_patterns ?? ['.git/', 'node_modules/', 'secrets/', '.env*'],
    },
    cachePolicy,
  };
}

export function loadAllowlists(path?: string): AllowlistConfig {
  if (!path || !fs.existsSync(path)) {
    return defaultAllowlists;
  }
  const raw = yaml.load(fs.readFileSync(path, 'utf8'));
  return normalizeAllowlists(raw);
}

export function loadGovernance(path?: string): GovernanceConfig {
  if (!path || !fs.existsSync(path)) {
    return defaultGovernance;
  }
  const raw = yaml.load(fs.readFileSync(path, 'utf8'));
  return normalizeGovernance(raw);
}

export function isDestructive(
  governance: GovernanceConfig,
  serverAlias: string,
  toolName: string,
  params?: Record<string, unknown>
): boolean {
  return governance.destructiveActions.some((action) => {
    if (action.serverAlias !== serverAlias || action.toolName !== toolName) {
      return false;
    }
    if (!action.params) {
      return true;
    }
    if (!params) {
      return false;
    }
    return Object.entries(action.params).every(([key, value]) => params[key] === value);
  });
}

/**
 * Resolves the cache policy for a tool: an explicit per-tool entry wins,
 * otherwise falls back to `cache_policy.default` (or the hard-coded
 * non-cacheable default if the config omits `default` entirely). Caching is
 * opt-in — an unrecognized tool is never cacheable.
 */
export function getCachePolicy(
  governance: GovernanceConfig,
  toolName: string
): { cacheable: boolean; ttlSeconds?: number } {
  return (
    governance.cachePolicy[toolName] ?? governance.cachePolicy.default ?? { cacheable: false }
  );
}

export function isToolAllowed(
  allowlists: AllowlistConfig,
  minionType: string,
  serverAlias: string,
  toolName: string
): boolean {
  const minionKey = minionType.replace(/-/g, '_');
  const serverRules = allowlists.allowlists[minionKey];
  if (!serverRules) {
    return false;
  }
  const tools = serverRules[serverAlias];
  if (!tools) {
    return false;
  }
  return tools.includes(toolName);
}

function pathMatchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const normalized = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
    const lowerPath = path.toLowerCase();
    const lowerPattern = normalized.toLowerCase();
    return (
      lowerPath === lowerPattern ||
      lowerPath.startsWith(`${lowerPattern}/`) ||
      lowerPath.includes(`/${lowerPattern}/`) ||
      lowerPath.endsWith(`/${lowerPattern}`)
    );
  });
}

export function isPathAllowed(
  allowlists: AllowlistConfig,
  governance: GovernanceConfig,
  minionType: string,
  toolName: string,
  params?: Record<string, unknown>
): { allowed: boolean; reason?: string } {
  if (serverAliasForTool(toolName) !== 'filesystem') {
    return { allowed: true };
  }

  const pathParam = extractPathParam(params);
  if (!pathParam) {
    return { allowed: true };
  }

  const minionKey = minionType.replace(/-/g, '_');
  const scope = allowlists.pathScopes[minionKey];

  const allowedBasePaths = governance.workspaceBoundaries.allowedBasePaths;
  if (!pathMatchesAny(pathParam, allowedBasePaths)) {
    return { allowed: false, reason: `path ${pathParam} outside allowed base paths` };
  }

  if (scope?.mode === 'allowlist') {
    const allowedPaths = scope.paths ?? [];
    if (!pathMatchesAny(pathParam, allowedPaths)) {
      return { allowed: false, reason: `path ${pathParam} not in allowlist` };
    }
  }

  const denyPatterns = scope?.deny ?? governance.workspaceBoundaries.denyPatterns;
  if (pathMatchesAny(pathParam, denyPatterns)) {
    return { allowed: false, reason: `path ${pathParam} matches denied pattern` };
  }

  return { allowed: true };
}

function serverAliasForTool(toolName: string): string {
  if (['read_file', 'list_directory', 'search_files', 'write_file', 'edit_file'].includes(toolName)) {
    return 'filesystem';
  }
  return '';
}

function extractPathParam(params?: Record<string, unknown>): string | undefined {
  if (!params) return undefined;
  const candidates = ['path', 'file_path', 'directory_path', 'search_path'];
  for (const key of candidates) {
    const value = params[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}
