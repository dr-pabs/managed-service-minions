/**
 * Token accounting (Milestone 13, review finding M9 / F9 — "tokensUsed and
 * token budgets are dead code"). This is the estimation/enforcement half;
 * `token-budget.ts`'s `TokenBudgetTracker` (pre-existing, previously never
 * called from anywhere) is the accumulator this module drives.
 *
 * DISCOVERY (logged per the milestone's explicit instruction): Milestone
 * 11's recorded contract fixtures (`test/fixtures/goose/*.json`) and
 * `extensions/orchestrator/src/goose-client.ts`'s `GooseReplyResponsePayload`
 * type both show the Goose `/reply` response as exactly `{role, content}` —
 * no `usage`, `tokens`, or similar field anywhere in the wire contract that
 * was verified against those fixtures. `extractTokenUsage` below is kept
 * forward-compatible (reads an optional `usage.total_tokens` if a future
 * Goose response ever adds one) but on today's actual contract it always
 * returns `undefined`, so every caller falls back to the characters/4
 * estimate via `estimateTokensFromChars`. See the ExecPlan's Surprises &
 * Discoveries and Decision Log for this same finding recorded at the plan
 * level.
 */
import { TokenBudgetTracker } from './token-budget.js';

/** characters/4, rounded up (never under-counts a partial token). Applied to the system prompt + user content + response content of a single minion turn. */
export function estimateTokensFromChars(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Reads a `usage.total_tokens` field off a raw Goose response object, if
 * present and a finite number. Returns `undefined` on any other shape —
 * including the actual current Goose contract, which never has this field
 * (see the module doc comment) — so the caller knows to estimate instead.
 */
export function extractTokenUsage(response: unknown): number | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const usage = (response as Record<string, unknown>).usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const total = (usage as Record<string, unknown>).total_tokens;
  return typeof total === 'number' && Number.isFinite(total) ? total : undefined;
}

/** Context surfaced to chat / logged when a minion run is aborted for exceeding its frontmatter `token_budget`. */
export interface TokenBudgetContext {
  minionType: string;
  sessionId: string;
  correlationId: string;
  budget: number;
}

/**
 * Typed error the orchestrator runner throws when a minion's accumulated
 * token usage reaches its frontmatter `token_budget` (enforced via the
 * existing `TokenBudgetTracker`). Deliberately a distinct, named error class
 * — never a generic `Error` — so the runner can catch it specifically and
 * surface a clean chat message instead of crashing the minion run or
 * leaking a stack trace to the user.
 */
export class TokenBudgetExceededError extends Error {
  readonly minionType: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly budget: number;
  readonly used: number;

  constructor(ctx: TokenBudgetContext & { used: number }) {
    super(
      `Minion "${ctx.minionType}" exceeded its token budget of ${ctx.budget} (used ${ctx.used}) during run ${ctx.correlationId}`
    );
    this.name = 'TokenBudgetExceededError';
    this.minionType = ctx.minionType;
    this.sessionId = ctx.sessionId;
    this.correlationId = ctx.correlationId;
    this.budget = ctx.budget;
    this.used = ctx.used;
  }
}

/**
 * A `TokenBudgetTracker` (`token-budget.ts`) paired with the running total
 * this module needs to report an accurate `used` count on
 * {@link TokenBudgetExceededError} — `TokenBudgetTracker.recordUsage`
 * clamps its returned `remaining` at 0, so the raw accumulated total
 * (which can exceed the budget) has to be tracked alongside it rather than
 * derived from `budget - remaining`.
 */
export interface TrackedBudget {
  tracker: TokenBudgetTracker;
  used: number;
}

/** Creates a fresh {@link TrackedBudget} wrapping a new `TokenBudgetTracker` for the given budget. */
export function createTrackedBudget(budget: number, warningThreshold = 0.8): TrackedBudget {
  return {
    tracker: new TokenBudgetTracker({ maxTokensPerRun: budget, warningThreshold }),
    used: 0,
  };
}

/**
 * Records `tokensForThisCall` against `tracked` and throws
 * {@link TokenBudgetExceededError} the moment the accumulated total reaches
 * (or exceeds) the run's budget — i.e. as soon as `tracker.recordUsage`
 * reports `'exceeded'`. Driving the EXISTING, previously-dead
 * `TokenBudgetTracker` (rather than reimplementing accumulation here) is
 * the whole point of this milestone.
 */
export function enforceTokenBudget(tracked: TrackedBudget, tokensForThisCall: number, ctx: TokenBudgetContext): void {
  tracked.used += tokensForThisCall;
  const outcome = tracked.tracker.recordUsage(tokensForThisCall);
  if (outcome.status === 'exceeded') {
    throw new TokenBudgetExceededError({ ...ctx, used: tracked.used });
  }
}
