import { describe, expect, it, jest } from '@jest/globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchemas, type SessionStore } from 'framework-core';
import type { GooseClient } from 'orchestrator';
import { consumeQueue } from '../src/consumer.js';
import {
  createItemCostLedger,
  DailyBudget,
  DEAD_LETTER_BUDGET_EXCEEDED,
  ItemBudgetExceededError,
  ItemCostLedger,
  priceModelResponse,
  utcDayKey,
} from '../src/cost-control.js';
import { runItemPipeline, type ItemPipelineConfig, type ItemPipelineDeps } from '../src/item-pipeline.js';
import type { WorkItem } from '../src/work-item.js';

/**
 * Milestone 17 cost-control tests. Two enforcement surfaces:
 *
 *  - the per-item `max_cost_usd` cap in `runItemPipeline` — a deliberately
 *    expensive mock model drives an item past its cap and the pipeline
 *    dead-letters it as `BUDGET_EXCEEDED` (the item halts, never the queue);
 *  - the daily throughput budget in `consumeQueue` — a small day budget is
 *    exhausted, consumption pauses with an audit event (never dropping work),
 *    and resumes on the next accounting day.
 *
 * Plus unit coverage of the budget primitives (`cost-control.ts`) so the
 * `budget/v1` semantics are pinned directly.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const RECIPES = path.resolve(here, '..', '..', '..', 'recipes');

const DAY1 = Date.UTC(2026, 0, 1, 12, 0, 0); // 2026-01-01T12:00:00Z
const DAY2 = Date.UTC(2026, 0, 2, 0, 0, 0); // 2026-01-02T00:00:00Z

describe('utcDayKey', () => {
  it('formats a UTC calendar-day key (YYYY-MM-DD)', () => {
    expect(utcDayKey(DAY1)).toBe('2026-01-01');
    expect(utcDayKey(DAY2)).toBe('2026-01-02');
  });
});

describe('priceModelResponse', () => {
  it('prices a reported usage.total_tokens field', () => {
    expect(priceModelResponse({ raw: 'x', usage: { total_tokens: 2000 } }, 0.01)).toBeCloseTo(0.02);
  });

  it('falls back to the characters/4 estimate when no usage is reported', () => {
    expect(priceModelResponse({ raw: 'x'.repeat(4000) }, 0.01)).toBeCloseTo(0.01);
  });
});

describe('ItemBudgetExceededError', () => {
  it('is a named Error carrying the spend, cap, and correlation id', () => {
    const err = new ItemBudgetExceededError(0.02, 0.015, 'corr-1');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ItemBudgetExceededError');
    expect(err.spentUsd).toBe(0.02);
    expect(err.maxCostUsd).toBe(0.015);
    expect(err.correlationId).toBe('corr-1');
    expect(err.message).toContain('corr-1');
  });
});

describe('ItemCostLedger', () => {
  it('accumulates spend and reports ok, then warning, then exceeded', () => {
    const ledger = new ItemCostLedger(10, 5);
    expect(ledger.spentUsd).toBe(0);
    expect(ledger.maxCostUsd).toBe(10);
    expect(ledger.isExhausted()).toBe(false);
    expect(ledger.record(3)).toEqual({ status: 'ok', spentUsd: 3 });
    expect(ledger.record(2)).toEqual({ status: 'warning', spentUsd: 5 });
    expect(ledger.isExhausted()).toBe(false);
    expect(ledger.record(5)).toEqual({ status: 'exceeded', spentUsd: 10 });
    expect(ledger.isExhausted()).toBe(true);
  });

  it('exceeds immediately when a single charge crosses the cap', () => {
    const ledger = new ItemCostLedger(1);
    expect(ledger.record(2)).toEqual({ status: 'exceeded', spentUsd: 2 });
  });

  it('never warns when no warn threshold is configured', () => {
    const ledger = new ItemCostLedger(10);
    expect(ledger.record(9)).toEqual({ status: 'ok', spentUsd: 9 });
  });
});

describe('createItemCostLedger', () => {
  it('returns an unbounded ledger when no cap is configured', () => {
    const ledger = createItemCostLedger(undefined, undefined);
    expect(ledger.maxCostUsd).toBe(Number.POSITIVE_INFINITY);
    expect(ledger.record(1_000_000)).toEqual({ status: 'ok', spentUsd: 1_000_000 });
    expect(ledger.isExhausted()).toBe(false);
  });

  it('maps warn_at_pct to an absolute warn threshold', () => {
    const ledger = createItemCostLedger(10, 50);
    expect(ledger.maxCostUsd).toBe(10);
    expect(ledger.record(4)).toEqual({ status: 'ok', spentUsd: 4 });
    expect(ledger.record(1)).toEqual({ status: 'warning', spentUsd: 5 });
  });

  it('omits the warn threshold when warn_at_pct is absent', () => {
    const ledger = createItemCostLedger(10, undefined);
    expect(ledger.record(9)).toEqual({ status: 'ok', spentUsd: 9 });
  });
});

describe('DailyBudget', () => {
  it('tracks spend, exhausts at the cap, and clamps remaining at 0', () => {
    const budget = new DailyBudget(10, { now: () => DAY1 });
    expect(budget.currentDayKey).toBe('2026-01-01');
    expect(budget.spentUsd).toBe(0);
    expect(budget.maxCostUsd).toBe(10);
    expect(budget.remainingUsd).toBe(10);
    expect(budget.isExhausted()).toBe(false);
    budget.record(10);
    expect(budget.spentUsd).toBe(10);
    expect(budget.isExhausted()).toBe(true);
    expect(budget.remainingUsd).toBe(0);
    budget.record(5);
    expect(budget.remainingUsd).toBe(0);
  });

  it('resets spend on day rollover', () => {
    const budget = new DailyBudget(10, { now: () => DAY1 });
    budget.record(10);
    expect(budget.isExhausted(DAY1)).toBe(true);
    expect(budget.isExhausted(DAY2)).toBe(false);
    expect(budget.spentUsd).toBe(0);
    expect(budget.currentDayKey).toBe('2026-01-02');
  });

  it('rolls over and records on the new day when record crosses the boundary', () => {
    const budget = new DailyBudget(10, { now: () => DAY1 });
    budget.record(9);
    budget.record(1, DAY2);
    expect(budget.currentDayKey).toBe('2026-01-02');
    expect(budget.spentUsd).toBe(1);
  });

  it('defaults to the real clock and UTC day key', () => {
    const budget = new DailyBudget(10);
    expect(budget.currentDayKey).toBe(utcDayKey(Date.now()));
  });

  it('accepts a custom day-key function', () => {
    const budget = new DailyBudget(10, { now: () => DAY1, dayKeyOf: (ms) => `custom-${ms}` });
    expect(budget.currentDayKey).toBe(`custom-${DAY1}`);
  });
});

const schemas = loadSchemas(path.join(RECIPES, 'schemas'));
const schemaMap = new Map<string, string>([['refund_processor', 'refund-action-output.json']]);

const item: WorkItem = {
  item_type: 'refund_request',
  payload: { order_id: 'R-1', reason: 'duplicate charge' },
  idempotency_key: 'key-1',
  correlation_id: 'corr-1',
};

function costConfig(overrides: Partial<ItemPipelineConfig> = {}): ItemPipelineConfig {
  return {
    item_type: 'refund_request',
    max_attempts: 2,
    on_failure: 'dead_letter',
    act: { agent: 'refund_processor', system_prompt: 'act prompt', output_schema: 'refund-action-output.json' },
    verify: { verifier: 'composite:refund_request', schema: false, reconcile_checks: [] },
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
    reconcile: jest.fn().mockResolvedValue({ status: 'success', data: {} }),
    commit: jest.fn().mockResolvedValue({ committed: true }),
    pricePer1kTokensUsd: 0.01,
    now: () => 1000,
    random: () => 0.5,
    ...overrides,
  };
}

describe('runItemPipeline cost cap (Milestone 17)', () => {
  it('dead-letters BUDGET_EXCEEDED when an expensive model drives the item past its cap', async () => {
    const goose = {
      runMinion: jest.fn(async () => ({
        raw: JSON.stringify({ order_id: 'R-1', amount_usd: 50 }),
        // 2000 tokens at $0.01/1k = $0.02, over the $0.015 cap.
        usage: { total_tokens: 2000 },
      })),
      classifyIntent: jest.fn(),
    };
    const createAuditEntry = jest.fn();
    const store = { createAuditEntry, listAuditEntries: jest.fn(() => []) } as unknown as SessionStore;
    const commit = jest.fn().mockResolvedValue({ committed: true });
    const deps = makeDeps({ goose: goose as unknown as GooseClient, store, commit });

    const outcome = await runItemPipeline(costConfig({ max_cost_usd: 0.015 }), deps, item);

    expect(outcome.status).toBe('dead_lettered');
    expect(outcome.reason).toBe(DEAD_LETTER_BUDGET_EXCEEDED);
    expect(outcome.attempts).toBe(1);
    expect(commit).not.toHaveBeenCalled();

    const budgetEntries = createAuditEntry.mock.calls.map((call) => call[0]).filter((e) => e.serverAlias === 'budget');
    expect(budgetEntries).toHaveLength(1);
    expect(budgetEntries[0]).toMatchObject({
      serverAlias: 'budget',
      toolName: 'item_cap',
      status: 'exceeded',
      correlationId: 'corr-1',
    });
    expect(budgetEntries[0].params).toMatchObject({ scope: 'item', policy: 'halt', max_cost_usd: 0.015 });
  });

  it('commits normally when the item stays under its cap', async () => {
    const goose = {
      runMinion: jest.fn(async () => ({
        raw: JSON.stringify({ order_id: 'R-1', amount_usd: 50 }),
        // 10 tokens at $0.01/1k = $0.0001, well under the $0.75 cap.
        usage: { total_tokens: 10 },
      })),
      classifyIntent: jest.fn(),
    };
    const commit = jest.fn().mockResolvedValue({ committed: true });
    const deps = makeDeps({ goose: goose as unknown as GooseClient, commit });

    const outcome = await runItemPipeline(costConfig({ max_cost_usd: 0.75 }), deps, item);

    expect(outcome.status).toBe('committed');
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-budget model failures unchanged', async () => {
    const boom = new Error('model down');
    const goose = {
      runMinion: jest.fn(async () => {
        throw boom;
      }),
      classifyIntent: jest.fn(),
    };
    const deps = makeDeps({ goose: goose as unknown as GooseClient });

    await expect(runItemPipeline(costConfig({ max_cost_usd: 0.75 }), deps, item)).rejects.toBe(boom);
  });
});

function makeQueue() {
  return {
    receive: jest.fn(),
    complete: jest.fn(),
    abandon: jest.fn(),
    deadLetter: jest.fn(),
    close: jest.fn(),
  };
}

describe('consumeQueue daily budget (Milestone 17)', () => {
  it('pauses consumption and writes one exhaustion audit entry while the day cap is exhausted', async () => {
    const budget = new DailyBudget(1.0, { now: () => DAY1 });
    budget.record(1.0);
    const queue = makeQueue();
    const controller = new AbortController();
    const createAuditEntry = jest.fn(() => controller.abort());
    const store = { createAuditEntry } as unknown as SessionStore;
    const processor = { process: jest.fn() };

    const count = await consumeQueue({
      queue,
      processor,
      dailyBudget: budget,
      store,
      signal: controller.signal,
      pollIntervalMs: 0,
    });

    expect(count).toBe(0);
    expect(queue.receive).not.toHaveBeenCalled();
    expect(processor.process).not.toHaveBeenCalled();
    expect(createAuditEntry).toHaveBeenCalledTimes(1);
    expect(createAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ serverAlias: 'budget', toolName: 'day_cap', status: 'exhausted' })
    );
  });

  it('resumes consumption on the next accounting day, auditing both transitions', async () => {
    let clock = DAY1;
    const budget = new DailyBudget(1.0, { now: () => clock });
    budget.record(1.0);
    const queue = makeQueue();
    const m1 = { messageId: 'm1', body: { a: 1 }, deliveryCount: 1 };
    queue.receive.mockResolvedValue(m1);
    const controller = new AbortController();
    const statuses: string[] = [];
    const createAuditEntry = jest.fn((entry) => {
      statuses.push(entry.status);
      if (entry.status === 'exhausted') {
        clock = DAY2;
      } else if (entry.status === 'resumed') {
        controller.abort();
      }
    });
    const store = { createAuditEntry } as unknown as SessionStore;
    const processor = {
      process: jest.fn(async () => ({ status: 'completed' as const, result: { text: 'ok' }, shortCircuited: false })),
    };

    const count = await consumeQueue({
      queue,
      processor,
      dailyBudget: budget,
      store,
      signal: controller.signal,
      pollIntervalMs: 0,
    });

    expect(statuses).toEqual(['exhausted', 'resumed']);
    expect(queue.receive).toHaveBeenCalledTimes(1);
    expect(processor.process).toHaveBeenCalledTimes(1);
    expect(count).toBe(1);
  });

  it('pauses without a store and never crashes', async () => {
    const budget = new DailyBudget(1.0, { now: () => DAY1 });
    budget.record(1.0);
    const queue = makeQueue();
    const controller = new AbortController();
    const processor = { process: jest.fn() };

    const promise = consumeQueue({
      queue,
      processor,
      dailyBudget: budget,
      signal: controller.signal,
      pollIntervalMs: 0,
    });
    controller.abort();
    const count = await promise;

    expect(count).toBe(0);
    expect(queue.receive).not.toHaveBeenCalled();
    expect(processor.process).not.toHaveBeenCalled();
  });
});
