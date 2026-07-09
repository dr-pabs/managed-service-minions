#!/usr/bin/env -S npx tsx
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfigAtRoot } from 'mcp-toolshed';

/**
 * CLI entry point for the config cross-validator (Milestone 1, F3).
 *
 * Run from the repo root with `pnpm tsx scripts/validate-config.ts`. It
 * cross-checks agents/*.md frontmatter, rules/allowlists.yaml,
 * rules/governance.yaml, rules/tool-registry.yaml, schemas/*.json, and
 * (once created) rules/intents.yaml against each other; see
 * extensions/mcp-toolshed/src/config-validation.ts for the checks
 * themselves, which this script only prints and turns into a process exit
 * code. Prints one line per failure naming the offending file and key,
 * then a count, then exits 1 if any errors were found (warnings alone
 * exit 0).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

export function runValidation(root: string): number {
  const { errors, warnings } = validateConfigAtRoot(root);

  for (const warning of warnings) {
    console.warn(warning);
  }
  for (const error of errors) {
    console.error(error);
  }

  const total = errors.length;
  console.log(`${total} error(s).`);

  return total > 0 ? 1 : 0;
}

const exitCode = runValidation(repoRoot);
if (exitCode !== 0) {
  process.exit(exitCode);
}
