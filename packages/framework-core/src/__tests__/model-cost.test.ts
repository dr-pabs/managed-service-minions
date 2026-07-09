import { describe, expect, it } from '@jest/globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadModelPricing,
  buildMinionTypeToTierMap,
  computeSessionCost,
  type ModelPricing,
} from '../model-cost.js';
import type { MinionRun } from '../store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(here, 'fixtures', 'model-cost');

function makeRun(overrides: Partial<MinionRun>): MinionRun {
  return {
    id: 'run_1',
    sessionId: 'sess_1',
    minionType: 'ticket_analyst',
    correlationId: 'corr_1.0',
    status: 'completed',
    createdAt: 1000,
    ...overrides,
  };
}

describe('loadModelPricing (fixture models.yaml)', () => {
  it('parses tier -> price_per_1k_tokens_usd from a deterministic fixture file', () => {
    const pricing = loadModelPricing(path.join(FIXTURE_ROOT, 'models.yaml'));
    expect(pricing.tiers.fast.pricePer1kTokensUsd).toBe(0.001);
    expect(pricing.tiers.reasoning.pricePer1kTokensUsd).toBe(0.01);
  });

  it('defaults a tier with no price_per_1k_tokens_usd to 0 (dashboard estimate degrades to free, never throws)', () => {
    const pricing = loadModelPricing(path.join(FIXTURE_ROOT, 'models.yaml'));
    expect(pricing.tiers.unpriced.pricePer1kTokensUsd).toBe(0);
  });

  it('returns an empty tiers map (never throws) for a models.yaml with no tiers key at all', () => {
    const pricing = loadModelPricing(path.join(here, 'fixtures', 'model-cost-empty', 'models.yaml'));
    expect(pricing.tiers).toEqual({});
  });
});

describe('buildMinionTypeToTierMap (fixture agents/)', () => {
  it('maps minion_type -> model_tier from agents/*.md frontmatter', () => {
    const map = buildMinionTypeToTierMap(FIXTURE_ROOT);
    expect(map.get('ticket_analyst')).toBe('fast');
    expect(map.get('code_writer')).toBe('reasoning');
  });

  it('skips an agent file with no frontmatter block (no minion_type) without throwing', () => {
    const map = buildMinionTypeToTierMap(FIXTURE_ROOT);
    // no-frontmatter.md contributes nothing; the map still has exactly the
    // two agents that DO have a minion_type + model_tier.
    expect(map.size).toBe(2);
  });
});

describe('computeSessionCost', () => {
  const pricing: ModelPricing = {
    tiers: {
      fast: { pricePer1kTokensUsd: 0.001 },
      reasoning: { pricePer1kTokensUsd: 0.01 },
    },
  };
  const tierMap = new Map([
    ['ticket_analyst', 'fast'],
    ['code_writer', 'reasoning'],
  ]);

  it('sums tokensUsed across every run and computes cost per tier, deterministically', () => {
    const runs: MinionRun[] = [
      makeRun({ id: 'r1', minionType: 'ticket_analyst', tokensUsed: 2000 }),
      makeRun({ id: 'r2', minionType: 'code_writer', tokensUsed: 5000 }),
    ];
    const result = computeSessionCost(runs, tierMap, pricing);

    expect(result.totalTokens).toBe(7000);
    // ticket_analyst: 2000/1000 * 0.001 = 0.002
    // code_writer: 5000/1000 * 0.01 = 0.05
    expect(result.totalCostUsd).toBeCloseTo(0.052, 6);
    expect(Object.keys(result.byMinionType).sort()).toEqual(['code_writer', 'ticket_analyst']);
    expect(result.byMinionType.ticket_analyst.tokens).toBe(2000);
    expect(result.byMinionType.ticket_analyst.costUsd).toBeCloseTo(0.002, 6);
    expect(result.byMinionType.code_writer.tokens).toBe(5000);
    expect(result.byMinionType.code_writer.costUsd).toBeCloseTo(0.05, 6);
  });

  it('treats a run with no tokensUsed as zero (never NaN)', () => {
    const runs: MinionRun[] = [makeRun({ id: 'r1', minionType: 'ticket_analyst', tokensUsed: undefined })];
    const result = computeSessionCost(runs, tierMap, pricing);
    expect(result.totalTokens).toBe(0);
    expect(result.totalCostUsd).toBe(0);
  });

  it('treats an unknown minion_type (no tier mapping) as zero cost but still counts its tokens', () => {
    const runs: MinionRun[] = [makeRun({ id: 'r1', minionType: 'ghost_minion', tokensUsed: 1000 })];
    const result = computeSessionCost(runs, tierMap, pricing);
    expect(result.totalTokens).toBe(1000);
    expect(result.totalCostUsd).toBe(0);
    expect(result.byMinionType.ghost_minion).toEqual({ tokens: 1000, costUsd: 0 });
  });

  it('returns zero totals for an empty run list', () => {
    const result = computeSessionCost([], tierMap, pricing);
    expect(result).toEqual({ totalTokens: 0, totalCostUsd: 0, byMinionType: {} });
  });

  it('treats a mapped tier with no pricing entry as zero cost but still counts its tokens', () => {
    const tierMapWithGap = new Map([['orphan_minion', 'nonexistent_tier']]);
    const runs: MinionRun[] = [makeRun({ id: 'r1', minionType: 'orphan_minion', tokensUsed: 3000 })];
    const result = computeSessionCost(runs, tierMapWithGap, pricing);
    expect(result.totalTokens).toBe(3000);
    expect(result.totalCostUsd).toBe(0);
  });
});
