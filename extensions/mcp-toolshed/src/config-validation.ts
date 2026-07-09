import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { readAgentFrontmatter } from 'framework-core';

/**
 * Cross-checks the governance config artifacts (agents/*.md frontmatter,
 * rules/allowlists.yaml, rules/governance.yaml, rules/tool-registry.yaml,
 * schemas/*.json, and — once it exists — rules/intents.yaml) against each
 * other so drift between them is caught before it bricks a minion (the C4
 * failure mode: an agent's minion_type has no matching allowlists key).
 *
 * Every check names the offending file and key in its message so a human
 * reading only the printed output can find and fix the problem.
 */

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * minion_type values that are expected to have no `rules/allowlists.yaml`
 * entry because they call no tools directly through the toolshed. The
 * orchestrator only classifies intent and delegates to other minions; it
 * never calls execute_tool itself.
 */
export const ORCHESTRATOR_EXEMPTION: readonly string[] = ['orchestrator'];

// Frontmatter reading (agents/*.md -> minion_type/output_schema) used to be
// a private copy here. Milestone 10 (output-contract enforcement) needed
// the identical convention in `framework-core` — which `mcp-toolshed`
// already depends on, never the reverse — so the parsing logic now lives
// in `framework-core`'s `agent-frontmatter.ts` and both packages import it
// from there. See the ExecPlan Decision Log, Milestone 10.
const readAgents = readAgentFrontmatter;

function loadYamlFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const raw = yaml.load(fs.readFileSync(filePath, 'utf8'));
  return (raw as Record<string, unknown>) ?? {};
}

function loadJsonFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

/**
 * Validates the config tree rooted at `repoRoot` (the directory containing
 * `agents/`, `rules/`, and `schemas/`). Returns the accumulated errors and
 * warnings; callers decide what to do with them (the CLI script exits 1 on
 * any error, the jest test asserts both arrays are empty against the real
 * checked-in config, buildToolshedState logs and throws on errors).
 */
export function validateConfigAtRoot(repoRoot: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const allowlistsPath = path.join(repoRoot, 'rules', 'allowlists.yaml');
  const governancePath = path.join(repoRoot, 'rules', 'governance.yaml');
  const registryPath = path.join(repoRoot, 'rules', 'tool-registry.yaml');
  const intentsPath = path.join(repoRoot, 'rules', 'intents.yaml');
  const intentSchemaPath = path.join(repoRoot, 'schemas', 'intent.json');

  const allowlistsRaw = loadYamlFile(allowlistsPath);
  const allowlists = (allowlistsRaw.allowlists ?? {}) as Record<string, Record<string, string[]>>;
  const pathScopes = (allowlistsRaw.path_scopes ?? {}) as Record<string, unknown>;
  const allowlistKeys = new Set(Object.keys(allowlists));

  const governanceRaw = loadYamlFile(governancePath);
  const governance = (governanceRaw.governance ?? governanceRaw) as Record<string, unknown>;
  const destructiveActions = (governance.destructive_actions ?? []) as Array<{
    server_alias?: string;
    tool_name?: string;
  }>;
  const cachePolicy = (governance.cache_policy ?? {}) as Record<string, { cacheable?: boolean }>;
  const pathCheckedTools = (governance.path_checked_tools ?? {}) as Record<string, string[]>;

  const registryRaw = loadYamlFile(registryPath);
  const registry = (registryRaw.registry ?? {}) as Record<string, string[]>;

  const agents = readAgents(repoRoot);

  // (a) every agents/*.md frontmatter minion_type has a matching allowlists key,
  // except the exempted orchestrator (it calls no tools directly).
  for (const agent of agents) {
    if (!agent.minionType) {
      continue;
    }
    if (ORCHESTRATOR_EXEMPTION.includes(agent.minionType)) {
      continue;
    }
    if (!allowlistKeys.has(agent.minionType)) {
      errors.push(
        `ERROR ${agent.file}: minion_type "${agent.minionType}" has no allowlists entry (keys: ${Array.from(allowlistKeys).join(', ')})`
      );
    }
  }

  // (b) every path_scopes key matches an allowlists key.
  for (const pathScopeKey of Object.keys(pathScopes)) {
    if (!allowlistKeys.has(pathScopeKey)) {
      errors.push(
        `ERROR rules/allowlists.yaml: path_scopes key "${pathScopeKey}" has no matching allowlists key`
      );
    }
  }

  // (c) every output_schema path in frontmatter points to an existing file in schemas/.
  for (const agent of agents) {
    if (!agent.outputSchema) {
      continue;
    }
    const schemaFullPath = path.join(repoRoot, agent.outputSchema);
    if (!fs.existsSync(schemaFullPath)) {
      errors.push(`ERROR ${agent.file}: output_schema "${agent.outputSchema}" does not exist`);
    }
  }

  // (d) every tool name in every allowlist appears in the tool registry; warn
  // if the registry lists a tool that no allowlist grants (possible drift the
  // other direction — a server exports a tool nobody was given access to).
  const grantedTools = new Set<string>();
  for (const [minionType, servers] of Object.entries(allowlists)) {
    for (const [serverAlias, tools] of Object.entries(servers)) {
      const registryTools = new Set(registry[serverAlias] ?? []);
      for (const toolName of tools) {
        grantedTools.add(`${serverAlias}.${toolName}`);
        if (!registryTools.has(toolName)) {
          errors.push(
            `ERROR rules/allowlists.yaml: minion "${minionType}" is granted "${serverAlias}.${toolName}", which is absent from rules/tool-registry.yaml`
          );
        }
      }
    }
  }
  for (const [serverAlias, tools] of Object.entries(registry)) {
    for (const toolName of tools) {
      if (!grantedTools.has(`${serverAlias}.${toolName}`)) {
        warnings.push(
          `WARN rules/tool-registry.yaml: "${serverAlias}.${toolName}" is registered but no allowlist grants it to any minion`
        );
      }
    }
  }

  // (e) every destructive_actions entry names a server alias and tool present in the registry.
  for (const action of destructiveActions) {
    const serverAlias = action.server_alias;
    const toolName = action.tool_name;
    if (!serverAlias || !registry[serverAlias]) {
      errors.push(
        `ERROR rules/governance.yaml: destructive_actions entry names server alias "${serverAlias}", which is absent from rules/tool-registry.yaml`
      );
      continue;
    }
    if (!toolName || !registry[serverAlias].includes(toolName)) {
      errors.push(
        `ERROR rules/governance.yaml: destructive_actions entry names tool "${toolName}" for server "${serverAlias}", which is absent from rules/tool-registry.yaml`
      );
    }
  }

  // (g) every path_checked_tools tool name (Milestone 5, H1) exists under
  // SOME server alias in the tool registry -- path_checked_tools has no
  // server_alias of its own (it is keyed by tool name only, since the same
  // toolshed pipeline step runs regardless of which server the tool belongs
  // to), so this checks the flattened set of every registered tool name
  // across every alias, rather than a single alias like checks (d)/(e) do.
  const allRegisteredToolNames = new Set(Object.values(registry).flat());
  for (const toolName of Object.keys(pathCheckedTools)) {
    if (!allRegisteredToolNames.has(toolName)) {
      errors.push(
        `ERROR rules/governance.yaml: path_checked_tools names tool "${toolName}", which is absent from rules/tool-registry.yaml under any server alias`
      );
    }
  }

  // cache_policy must never mark a destructive tool cacheable.
  for (const action of destructiveActions) {
    const toolName = action.tool_name;
    if (toolName && cachePolicy[toolName]?.cacheable) {
      errors.push(
        `ERROR rules/governance.yaml: cache_policy marks destructive tool "${toolName}" cacheable, which is forbidden`
      );
    }
  }

  // (f) every enum value in schemas/intent.json `intent` appears in rules/intents.yaml's
  // map. This check only warns while rules/intents.yaml does not exist yet (Milestone 11
  // creates it); once it exists, a missing intent is an error.
  const intentSchema = loadJsonFile(intentSchemaPath);
  const intentEnum = ((intentSchema.properties as Record<string, unknown> | undefined)?.intent as
    | { enum?: string[] }
    | undefined
  )?.enum ?? [];
  const intentsFileExists = fs.existsSync(intentsPath);
  const intentsRaw = intentsFileExists ? loadYamlFile(intentsPath) : {};
  const intentDag = (intentsRaw.intents ?? {}) as Record<string, unknown>;
  const intentDagKeys = new Set(Object.keys(intentDag));

  for (const intentName of intentEnum) {
    if (intentDagKeys.has(intentName)) {
      continue;
    }
    const message = `rules/intents.yaml: intent "${intentName}" (from schemas/intent.json) has no entry in the intent -> minion DAG`;
    if (intentsFileExists) {
      errors.push(`ERROR ${message}`);
    } else {
      warnings.push(`WARN ${message} (warn-only: rules/intents.yaml does not exist yet)`);
    }
  }

  return { errors, warnings };
}
