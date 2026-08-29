import { estimateTokensFromChars, extractTokenUsage } from 'framework-core';

/**
 * Cost control (Milestone 17): the enforcement half of the token accounting
 * already shipped in `framework-core` (`token-accounting.ts` estimates/extracts
 * tokens, `model-cost.ts` joins them to tier prices). This module turns that
 * accounting into the `budget/v1` choke points Stream needs:
 *
 *  - an **item** cap (`scope: "item"`, `policy: "halt"`): a work item whose
 *    accumulated model spend reaches its `max_cost_usd` halts and dead-letters
 *    as `BUDGET_EXCEEDED` — the item halts, never the queue around it.
 *  - a **day** cap (`scope: "day"`, `policy: "halt"`): one calendar day of
 *    Stream throughput whose exhaustion pauses queue consumption (never
 *    silently drops work) and resumes on the next accounting day.
 *
 * Semantics follow `budget/v1` (forge-contracts/schemas/budget/v1/schema.json):
 * the day cap is enforced pre-dispatch (the consumer refuses to drain the queue
 * while its ledger is exhausted) and the item cap is enforced per-call (the item
 * halts the moment a priced call reaches it); every crossing is surfaced for the
 * audit trail under `audit/v1` kind `budget`.
 */

/** The dead-letter reason an item exceeding its `max_cost_usd` is quarantined with (budget/v1 `policy: "halt"`). */
export const DEAD_LETTER_BUDGET_EXCEEDED = 'BUDGET_EXCEEDED';

/** The UTC calendar-day key (YYYY-MM-DD) a daily budget binds its spend to. */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A model response as the cost ledger sees it: the raw content plus optional reported token usage. */
export interface ModelResponse {
  raw: string;
  /** Optional token usage a real model reports (the field `extractTokenUsage` reads). */
  usage?: { total_tokens?: number };
}

/**
 * Prices one model response in USD. Reads a `usage.total_tokens` field off the
 * response when present (the forward-compatible field `extractTokenUsage` reads,
 * and what a real Goose response would carry once it reports usage); otherwise
 * falls back to the existing characters/4 estimate of the raw content. Multiplied
 * by the tier's `price_per_1k_tokens_usd` exactly as `model-cost.ts` does.
 */
export function priceModelResponse(response: ModelResponse, pricePer1kTokensUsd: number): number {
  const tokens = extractTokenUsage(response) ?? estimateTokensFromChars(response.raw);
  return (tokens / 1000) * pricePer1kTokensUsd;
}

/**
 * The typed error the item pipeline throws when a model call pushes an item's
 * accumulated cost to (or past) its `max_cost_usd`. A distinct, named class so
 * the pipeline can catch it specifically and convert it to a `BUDGET_EXCEEDED`
 * dead-letter rather than treating it as a generic failure.
 */
export class ItemBudgetExceededError extends Error {
  readonly spentUsd: number;
  readonly maxCostUsd: number;
  readonly correlationId: string;

  constructor(spentUsd: number, maxCostUsd: number, correlationId: string) {
    super(`item ${correlationId} exceeded its cost cap of $${maxCostUsd} (spent $${spentUsd})`);
    this.name = 'ItemBudgetExceededError';
    this.spentUsd = spentUsd;
    this.maxCostUsd = maxCostUsd;
    this.correlationId = correlationId;
  }
}

/**
 * The per-item cost ledger: accumulates spend from each priced model call and
 * reports whether the item has reached its cap. `maxCostUsd` may be
 * `Infinity` (an unbounded item) so the pipeline can run one code path whether
 * or not a cap is configured — an unbounded ledger never exhausts.
 */
export class ItemCostLedger {
  private spent = 0;

  constructor(
    readonly maxCostUsd: number,
    private readonly warnAtUsd?: number
  ) {}

  get spentUsd(): number {
    return this.spent;
  }

  /** True once accumulated spend reaches (or exceeds) the cap. */
  isExhausted(): boolean {
    return this.spent >= this.maxCostUsd;
  }

  /** Adds a charge and returns the resulting status (`exceeded` means the item must halt). */
  record(costUsd: number): { status: 'ok' | 'warning' | 'exceeded'; spentUsd: number } {
    this.spent += costUsd;
    if (this.isExhausted()) {
      return { status: 'exceeded', spentUsd: this.spent };
    }
    if (this.warnAtUsd !== undefined && this.spent >= this.warnAtUsd) {
      return { status: 'warning', spentUsd: this.spent };
    }
    return { status: 'ok', spentUsd: this.spent };
  }
}

/**
 * Builds the per-item ledger from the pipeline config's `max_cost_usd` /
 * `warn_at_pct`. No cap means an unbounded (never-exhausting) ledger so the
 * pipeline's single accounting path also serves uncapped items. `warn_at_pct`
 * is a percentage of `max_cost_usd`, mirroring `budget/v1`'s `warn_at_pct`.
 */
export function createItemCostLedger(maxCostUsd: number | undefined, warnAtPct: number | undefined): ItemCostLedger {
  if (maxCostUsd === undefined) {
    return new ItemCostLedger(Number.POSITIVE_INFINITY);
  }
  const warnAtUsd = warnAtPct !== undefined ? (warnAtPct / 100) * maxCostUsd : undefined;
  return new ItemCostLedger(maxCostUsd, warnAtUsd);
}

/**
 * The daily throughput ledger: caps total spend per UTC calendar day. Spend is
 * reset when the accounting day rolls over, which is what makes consumption
 * resume automatically — the consumer checks `isExhausted()` on every poll and
 * a new day resets the ledger to zero spend.
 */
export class DailyBudget {
  private dayKey: string;
  private spent = 0;
  readonly maxCostUsd: number;
  private readonly now: () => number;
  private readonly dayKeyOf: (ms: number) => string;

  constructor(maxCostUsd: number, options: { now?: () => number; dayKeyOf?: (ms: number) => string } = {}) {
    this.maxCostUsd = maxCostUsd;
    this.now = options.now ?? Date.now;
    this.dayKeyOf = options.dayKeyOf ?? utcDayKey;
    this.dayKey = this.dayKeyOf(this.now());
  }

  get spentUsd(): number {
    return this.spent;
  }

  get currentDayKey(): string {
    return this.dayKey;
  }

  get remainingUsd(): number {
    return Math.max(0, this.maxCostUsd - this.spent);
  }

  /** Rolls over to the current accounting day if needed, then reports whether the day's cap is exhausted. */
  isExhausted(now?: number): boolean {
    this.rollover(now ?? this.now());
    return this.spent >= this.maxCostUsd;
  }

  /** Records spend for the current accounting day, rolling over (resetting) first if the day has changed. */
  record(costUsd: number, now?: number): void {
    this.rollover(now ?? this.now());
    this.spent += costUsd;
  }

  private rollover(now: number): void {
    const key = this.dayKeyOf(now);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.spent = 0;
    }
  }
}
