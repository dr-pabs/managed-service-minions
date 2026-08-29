import { describe, expect, it, jest } from '@jest/globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchemas, type SessionStore } from 'framework-core';
import type { GooseClient } from 'orchestrator';
import { DailyBudget } from '../src/cost-control.js';
import { runItemPipeline, type ItemPipelineConfig, type ItemPipelineDeps } from '../src/item-pipeline.js';
import { assertPriced } from '../src/pipeline-processor.js';
import type { LoadedPipeline } from '../src/pipeline-config.js';
import type { WorkItem } from '../src/work-item.js';

/**
 * Remediation Milestone 3: the daily budget was gated (the consume loop polls
 * `isExhausted`) but never charged — `DailyBudget.record` had no production
 * caller, so the day cap could never trip. These tests pin the wiring: every
 * settled pipeline item charges its final spend exactly once through
 * `onItemCost`, a `BUDGET_EXCEEDED` item charges its partial spend, and a
 * declared cap with an unpriced model layer fails loud instead of silently
 * disabling every item cap.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const RECIPES = path.resolve(here, '..', '..', '..', 'recipes');

const schemas = loadSchemas(path.join(RECIPES, 'schemas'));
const schemaMap = new Map<string, string>([['refund_processor', 'refund-action-output.json']]);

const item: WorkItem = {
  item_type: 'refund_request',
  payload: { order_id: 'R-1', reason: 'duplicate charge' },
  idempotency_key: 'key-1',
  correlation_id: 'corr-1',
};

/** A fake goose whose responses carry explicit token usage, so costs are exact. */
function usageGoose(script: Record<string, { output: unknown; totalTokens: number }>) {
  const runMinion = jest.fn(async (request: { minionType: string }) => ({
    raw: JSON.stringify(script[request.minionType].output),
    usage: { total_tokens: script[request.minionType].totalTokens },
  }));
  return { runMinion, classifyIntent: jest.fn() };
}

function baseConfig(overrides: Partial<ItemPipelineConfig> = {}): ItemPipelineConfig {
  return {
    item_type: 'refund_request',
    max_attempts: 2,
    on_failure: 'dead_letter',
    classify: { agent: 'refund_classifier', system_prompt: 'classify prompt' },
    act: { agent: 'refund_processor', system_prompt: 'act prompt', output_schema: 'refund-action-output.json' },
    verify: {
      verifier: 'composite:refund_request',
      reconcile_checks: [
        {
          server_alias: 'payments',
          tool_name: 'payments_get_charge',
          params: { order_id: '$output.order_id' },
          assert: { read_field: 'amount_usd', output_field: 'amount_usd' },
        },
      ],
    },
    commit: { effect_type: 'payment.refund', target_system: 'payments', reversibility: 'compensatable' },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ItemPipelineDeps> = {}): ItemPipelineDeps {
  return {
    goose: { runMinion: jest.fn(), classifyIntent: jest.fn() } as unknown as GooseClient,
    store: { createAuditEntry: jest.fn(), listAuditEntries: jest.fn(() => []) } as unknown as SessionStore,
    secret: 'secret',
    schemas,
    schemaMap,
    reconcile: jest.fn().mockResolvedValue({ status: 'success', data: { amount_usd: 50 } }),
    commit: jest.fn().mockResolvedValue({ committed: true }),
    now: () => 1000,
    random: () => 0.5,
    ...overrides,
  };
}

function loadedWith(config: ItemPipelineConfig): Map<string, LoadedPipeline> {
  return new Map([['refund_request', { config, schemas, schemaMap } as unknown as LoadedPipeline]]);
}

describe('daily budget charging (remediation Milestone 3)', () => {
  it('charges a settled item exactly once, with the priced spend of its model calls', async () => {
    const goose = usageGoose({
      refund_classifier: { output: { order_id: 'R-1' }, totalTokens: 1000 },
      refund_processor: { output: { order_id: 'R-1', amount_usd: 50, reason: 'duplicate charge' }, totalTokens: 3000 },
    });
    const onItemCost = jest.fn();
    const deps = makeDeps({ goose, pricePer1kTokensUsd: 10, onItemCost });

    const outcome = await runItemPipeline(baseConfig(), deps, item);

    expect(outcome.status).toBe('committed');
    // (1000 + 3000) tokens / 1000 * $10 per 1k = $40, charged once at settle.
    expect(onItemCost).toHaveBeenCalledTimes(1);
    expect(onItemCost).toHaveBeenCalledWith(40);
  });

  it('charges a budget-exceeded item its partial spend and dead-letters as BUDGET_EXCEEDED', async () => {
    const goose = usageGoose({
      refund_classifier: { output: { order_id: 'R-1' }, totalTokens: 1000 },
      refund_processor: { output: {}, totalTokens: 0 },
    });
    const onItemCost = jest.fn();
    const deps = makeDeps({ goose, pricePer1kTokensUsd: 10, onItemCost });

    // Cap $5: the classify call alone prices at $10 and halts the item.
    const outcome = await runItemPipeline(baseConfig({ max_cost_usd: 5 }), deps, item);

    expect(outcome.status).toBe('dead_lettered');
    expect(outcome.reason).toBe('BUDGET_EXCEEDED');
    expect(onItemCost).toHaveBeenCalledTimes(1);
    expect(onItemCost).toHaveBeenCalledWith(10);
  });

  it('charges on every terminal path — an escalated item pays for its attempts', async () => {
    const goose = usageGoose({
      refund_classifier: { output: { order_id: 'R-1' }, totalTokens: 500 },
      refund_processor: { output: { order_id: 'R-1', amount_usd: 50, reason: 'x' }, totalTokens: 500 },
    });
    const onItemCost = jest.fn();
    const deps = makeDeps({
      goose,
      pricePer1kTokensUsd: 2,
      onItemCost,
      // Reconcile matches on the first attempt; the commit is refused, which
      // routes the item to escalation.
      reconcile: jest.fn().mockResolvedValue({ status: 'success', data: { amount_usd: 50 } }),
      commit: jest.fn().mockResolvedValue({ committed: false, refused: 'policy' }),
    });

    const outcome = await runItemPipeline(baseConfig({ max_attempts: 2 }), deps, item);

    // classify 500 + act 500 tokens at $2 per 1k = $2, charged at settle
    // even though the item's terminal outcome is escalation, not completion.
    expect(outcome.status).toBe('escalated');
    expect(onItemCost).toHaveBeenCalledTimes(1);
    expect(onItemCost).toHaveBeenCalledWith(2);
  });

  it('wiring shape: a charged daily budget trips for real', () => {
    // The index wiring hands DailyBudget.record to onItemCost; prove the
    // object semantics the wiring depends on: record() accumulates and
    // isExhausted() flips exactly at the cap.
    const budget = new DailyBudget(100);
    const charge = (costUsd: number): void => budget.record(costUsd);
    charge(60);
    expect(budget.isExhausted()).toBe(false);
    charge(40);
    expect(budget.isExhausted()).toBe(true);
  });
});

describe('assertPriced (remediation Milestone 3)', () => {
  const capped = loadedWith(baseConfig({ max_cost_usd: 0.75 }));

  it('throws for a capped pipeline when the price resolves to zero', () => {
    expect(() => assertPriced(capped, 0, false)).toThrow(/PIPELINE_PRICE_PER_1K_TOKENS_USD/);
    expect(() => assertPriced(capped, 0, false)).toThrow(/refund_request/);
  });

  it('passes with the escape hatch or a positive price', () => {
    expect(() => assertPriced(capped, 0, true)).not.toThrow();
    expect(() => assertPriced(capped, 0.01, false)).not.toThrow();
  });

  it('passes for uncapped pipelines at any price', () => {
    const uncapped = loadedWith(baseConfig());
    expect(() => assertPriced(uncapped, 0, false)).not.toThrow();
  });
});
