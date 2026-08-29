import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locates the forge-contracts checkout for cross-language conformance tests
 * (identity vectors, contract drift suites). Resolution order:
 *
 *  1. `FORGE_CONTRACTS_DIR` — the operator's explicit choice, trusted as-is
 *     (this is also what CI sets after checking the repository out);
 *  2. a sibling `forge-contracts` directory next to this workspace — the
 *     layout the three repositories sit in on a development machine (the
 *     workspace root is found by walking up to `pnpm-workspace.yaml`);
 *  3. the legacy absolute path this repo grew up under, kept as a
 *     last-resort fallback so existing local runs do not break.
 *
 * Returns `undefined` when nothing is found — callers skip loudly rather than
 * silently pass, the pattern `identity-contract.test.ts` established.
 */
export function resolveContractsDir(
  options: {
    /** Environment to read `FORGE_CONTRACTS_DIR` from; defaults to `process.env`. */
    env?: { FORGE_CONTRACTS_DIR?: string };
    /** Directory to walk up from when looking for the workspace root; defaults to this module. */
    startDir?: string;
    /** Last-resort absolute paths, most specific first; defaults to the legacy checkout. */
    legacyPaths?: string[];
  } = {}
): string | undefined {
  const env = options.env ?? process.env;
  const explicit = env.FORGE_CONTRACTS_DIR;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return explicit;
  }

  const startDir = options.startDir ?? dirname(fileURLToPath(import.meta.url));
  const legacyPaths = options.legacyPaths ?? ['/Volumes/ExtDisk1/forge-contracts'];

  const sibling = findSiblingCheckout(startDir);
  if (sibling !== undefined) {
    return sibling;
  }
  for (const candidate of legacyPaths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Walks up from *startDir* to the `pnpm-workspace.yaml` root, then checks its sibling. */
function findSiblingCheckout(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      const candidate = join(dir, '..', 'forge-contracts');
      return existsSync(candidate) ? candidate : undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}
