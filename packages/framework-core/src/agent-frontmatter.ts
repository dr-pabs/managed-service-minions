import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

/**
 * The subset of an `agents/*.md` YAML frontmatter block this module cares
 * about. Extracted from `extensions/mcp-toolshed/src/config-validation.ts`'s
 * (Milestone 1) private `readAgents`/`parseFrontmatter` helpers so Milestone
 * 10's `output-contract.ts` (in framework-core) and Milestone 1's validator
 * (in mcp-toolshed) share exactly one frontmatter-parsing implementation
 * instead of drifting apart. This lives in `framework-core`, not
 * `mcp-toolshed`, because the dependency direction only runs one way —
 * `mcp-toolshed` depends on `framework-core` (see its `package.json`), never
 * the reverse — so the shared code has to sit on the side both can reach.
 * `config-validation.ts` was refactored in the same change to import this
 * module rather than keep its own copy (see the ExecPlan Decision Log,
 * Milestone 10, for the rationale).
 */
export interface AgentFrontmatter {
  /** Path to the agent file, relative to `repoRoot` (e.g. `agents/code-writer.md`). */
  file: string;
  minionType?: string;
  outputSchema?: string;
}

/**
 * Parses the leading `---\n...\n---` YAML block of a markdown file's
 * contents. Returns `{}` if there is no frontmatter block at all (some
 * agent files may be plain notes) or if the block parses to something that
 * isn't a mapping.
 */
export function parseFrontmatter(contents: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(contents);
  if (!match) {
    return {};
  }
  const parsed = yaml.load(match[1]);
  return (parsed as Record<string, unknown>) ?? {};
}

/**
 * Reads every `agents/*.md` file under `repoRoot` and extracts the
 * `minion_type` / `output_schema` frontmatter fields used to map a minion
 * type to its allowlist entry (Milestone 1) and its output JSON Schema
 * (Milestone 10). Returns `[]` if the `agents/` directory does not exist
 * (fixture trees may omit it).
 */
export function readAgentFrontmatter(repoRoot: string): AgentFrontmatter[] {
  const agentsDir = path.join(repoRoot, 'agents');
  if (!fs.existsSync(agentsDir)) {
    return [];
  }
  const files = fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md'))
    .sort();
  return files.map((file) => {
    const fullPath = path.join(agentsDir, file);
    const contents = fs.readFileSync(fullPath, 'utf8');
    const frontmatter = parseFrontmatter(contents);
    return {
      file: path.join('agents', file),
      minionType: typeof frontmatter.minion_type === 'string' ? frontmatter.minion_type : undefined,
      outputSchema: typeof frontmatter.output_schema === 'string' ? frontmatter.output_schema : undefined,
    };
  });
}

/**
 * Builds a `minion_type -> output_schema` map (schema path relative to
 * `repoRoot`, e.g. `schemas/code-writer-output.json`) from every agent's
 * frontmatter. Agents without both fields are skipped silently — callers
 * that need completeness (like `scripts/validate-config.ts`) do their own
 * per-agent checks via `readAgentFrontmatter` directly.
 */
export function buildMinionTypeToSchemaMap(repoRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const agent of readAgentFrontmatter(repoRoot)) {
    if (agent.minionType && agent.outputSchema) {
      map.set(agent.minionType, agent.outputSchema);
    }
  }
  return map;
}
