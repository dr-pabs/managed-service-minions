import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveContractsDir } from '../contracts-dir.js';

describe('resolveContractsDir', () => {
  it('the explicit env var wins, trusted as-is', () => {
    expect(resolveContractsDir({ env: { FORGE_CONTRACTS_DIR: '/opt/contracts' } })).toBe('/opt/contracts');
  });

  it('a blank env value falls through (does not override discovery)', () => {
    const root = join(tmpdir(), `contracts-dir-blank-${process.pid}-${Date.now()}`);
    const workspace = join(root, 'ws');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'pnpm-workspace.yaml'), 'packages: []\n');

    expect(resolveContractsDir({ env: { FORGE_CONTRACTS_DIR: '  ' }, startDir: workspace, legacyPaths: [] })).toBeUndefined();
  });

  it('finds a sibling checkout next to the pnpm workspace root', () => {
    const root = join(tmpdir(), `contracts-dir-sibling-${process.pid}-${Date.now()}`);
    const workspace = join(root, 'ws');
    const deep = join(workspace, 'packages', 'a');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(workspace, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const sibling = join(root, 'forge-contracts');
    mkdirSync(sibling);

    expect(resolveContractsDir({ env: {}, startDir: deep, legacyPaths: [] })).toBe(sibling);
  });

  it('a workspace root without a sibling falls back to the legacy paths, first hit wins', () => {
    const root = join(tmpdir(), `contracts-dir-legacy-${process.pid}-${Date.now()}`);
    mkdirSync(join(root, 'ws', 'packages', 'a'), { recursive: true });
    writeFileSync(join(root, 'ws', 'pnpm-workspace.yaml'), 'packages: []\n');
    mkdirSync(join(root, 'legacy-contracts'));

    expect(
      resolveContractsDir({
        env: {},
        startDir: join(root, 'ws', 'packages', 'a'),
        legacyPaths: [join(root, 'missing-first'), join(root, 'legacy-contracts')],
      })
    ).toBe(join(root, 'legacy-contracts'));
  });

  it('returns undefined when nothing is found (callers skip loudly)', () => {
    const root = join(tmpdir(), `contracts-dir-none-${process.pid}-${Date.now()}`);
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    expect(resolveContractsDir({ env: {}, startDir: join(root, 'a', 'b'), legacyPaths: [] })).toBeUndefined();
  });

  it('a workspace marker with no sibling and no legacy candidates resolves undefined', () => {
    const root = join(tmpdir(), `contracts-dir-marker-${process.pid}-${Date.now()}`);
    mkdirSync(join(root, 'ws', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'ws', 'pnpm-workspace.yaml'), 'packages: []\n');
    expect(resolveContractsDir({ env: {}, startDir: join(root, 'ws', 'pkg'), legacyPaths: [] })).toBeUndefined();
  });
});
