/**
 * Per-session token cost math (Milestone 13, review finding M9 / F9),
 * joining `MinionRun.tokensUsed` against `rules/models.yaml` tier prices —
 * the collaborator behind the dashboard's `GET /api/sessions/:id/cost`
 * endpoint. Deliberately separate from `token-accounting.ts` (estimation +
 * budget enforcement, which runs DURING a minion run) — this module only
 * ever runs AFTER runs are recorded, reading the store, never mutating it.
 */
import fs from 'node:fs';
import yaml from 'js-yaml';
import { readAgentFrontmatter } from './agent-frontmatter.js';
import type { MinionRun } from './store.js';

interface RawModelsYaml {
  tiers?: Record<string, { price_per_1k_tokens_usd?: number }>;
}

export interface ModelTierPricing {
  pricePer1kTokensUsd: number;
}

export interface ModelPricing {
  tiers: Record<string, ModelTierPricing>;
}

/**
 * Parses `rules/models.yaml` (or a fixture with the same shape) into a
 * `tier -> price` map. A tier with no `price_per_1k_tokens_usd` defaults to
 * 0 (an unconfigured price estimates as free rather than throwing or
 * `NaN`-ing the cost math — operators fill in real prices when they care
 * about the estimate).
 */
export function loadModelPricing(modelsYamlPath: string): ModelPricing {
  const raw = yaml.load(fs.readFileSync(modelsYamlPath, 'utf8')) as RawModelsYaml | undefined;
  const tiers: Record<string, ModelTierPricing> = {};
  for (const [tierName, tier] of Object.entries(raw?.tiers ?? {})) {
    tiers[tierName] = {
      pricePer1kTokensUsd:
        typeof tier?.price_per_1k_tokens_usd === 'number' && Number.isFinite(tier.price_per_1k_tokens_usd)
          ? tier.price_per_1k_tokens_usd
          : 0,
    };
  }
  return { tiers };
}

/**
 * Builds `minion_type -> model_tier` from `agents/*.md` frontmatter (the
 * SAME frontmatter convention `agent-frontmatter.ts`'s `readAgentFrontmatter`
 * already reads for `minion_type`/`output_schema` — this module reads the
 * sibling `model_tier` field directly rather than widening the shared
 * `AgentFrontmatter` type, since no other consumer of that type needs
 * pricing information).
 */
export function buildMinionTypeToTierMap(repoRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const agent of readAgentFrontmatter(repoRoot)) {
    // `agent.minionType` is only ever set by `readAgentFrontmatter` when its
    // OWN frontmatter regex already matched (see agent-frontmatter.ts) --
    // re-running the same regex here would always match too, so this reads
    // the file once more only to pull the sibling `model_tier` field, not
    // to re-validate frontmatter presence.
    if (!agent.minionType) continue;
    const fullPath = `${repoRoot}/${agent.file}`;
    const contents = fs.readFileSync(fullPath, 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(contents)!;
    const frontmatter = yaml.load(match[1]) as Record<string, unknown> | undefined;
    const tier = frontmatter?.model_tier;
    if (typeof tier === 'string') {
      map.set(agent.minionType, tier);
    }
  }
  return map;
}

export interface SessionCostResult {
  totalTokens: number;
  totalCostUsd: number;
  byMinionType: Record<string, { tokens: number; costUsd: number }>;
}

/**
 * Sums `MinionRun.tokensUsed` across every run passed in, grouped by
 * `minionType`, and estimates USD cost by joining each run's minion type ->
 * tier (via `tierMap`) -> price (via `pricing`). A run with no `tokensUsed`
 * counts as 0 tokens (never `NaN`); a minion type with no tier mapping, or
 * a tier with no configured price, costs 0 but its tokens still count
 * toward `totalTokens` — an unpriced/unmapped tier should never make the
 * token TOTAL silently disappear, only the cost estimate.
 */
export function computeSessionCost(
  runs: MinionRun[],
  tierMap: Map<string, string>,
  pricing: ModelPricing
): SessionCostResult {
  let totalTokens = 0;
  let totalCostUsd = 0;
  const byMinionType: Record<string, { tokens: number; costUsd: number }> = {};

  for (const run of runs) {
    const tokens = run.tokensUsed ?? 0;
    const tier = tierMap.get(run.minionType);
    const pricePer1k = tier ? (pricing.tiers[tier]?.pricePer1kTokensUsd ?? 0) : 0;
    const costUsd = (tokens / 1000) * pricePer1k;

    totalTokens += tokens;
    totalCostUsd += costUsd;

    const existing = byMinionType[run.minionType] ?? { tokens: 0, costUsd: 0 };
    byMinionType[run.minionType] = { tokens: existing.tokens + tokens, costUsd: existing.costUsd + costUsd };
  }

  return { totalTokens, totalCostUsd, byMinionType };
}
