# ADR-031: Per-item and daily cost control (`budget/v1`)

| Key | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-28 |
| **Deciders** | Paul Brown |
| **Replaces** | — |
| **Superseded by** | — |

---

## Context

`framework-core` already ships the *accounting* half of cost: `token-accounting.ts` estimates/extracts token usage and `model-cost.ts` joins tokens to tier prices. Queue-driven Stream throughput (ADR-027) needs the *enforcement* half: a single runaway item must not burn unbounded model spend, and a runaway day must not burn the monthly budget — without either failure mode silently discarding work. The semantics come from the cross-language `budget/v1` contract (forge-contracts `schemas/budget/v1/schema.json`); the implementation is `extensions/queue-ingress/src/cost-control.ts` (forge-ops execplan Milestone 17).

## Decision

1. **Item cap** (`budget/v1` `scope: "item"`, `policy: "halt"`): each pipeline run carries an `ItemCostLedger` accumulating priced model calls against the recipe's `max_cost_usd`. The moment a call reaches the cap, the pipeline throws the typed `ItemBudgetExceededError` and the item **dead-letters as `BUDGET_EXCEEDED`** — the item halts, never the queue around it. `warn_at_pct` fires a warning crossing before the hard stop. An absent cap means the item's spend is tracked but never enforced.
2. **Daily cap** (`budget/v1` `scope: "day"`, `policy: "halt"`): a `DailyBudget` ledger keyed by UTC calendar day gates the consume loop (`consumer.ts`). While exhausted, the loop **pauses `receive`** — it sleeps instead of pulling the next message, so work stays on the queue and is **never dropped** — and resumes automatically when the accounting day rolls over and the ledger resets. Each transition into/out of exhaustion writes one `audit/v1` kind `budget` entry.
3. **Both caps halt; neither degrades.** There is no "cheaper model" or "best effort" fallback: a crossed budget is a stop with an auditable reason, per `budget/v1` `policy: "halt"`.
4. **Configuration:** the daily cap comes from `DAILY_BUDGET_MAX_COST_USD` (absent/non-positive = unbounded); the item cap comes from the recipe (`max_cost_usd`, `warn_at_pct` per `item_type` in `recipes/item-pipelines.yaml`).

## Wiring status (honest note)

The **daily** budget is wired in the production consumer (`extensions/queue-ingress/src/index.ts` builds `DailyBudget` and passes it to `consumeQueue`). The **per-item** path is library-complete but not yet wired into the production process — it lives in the item-pipeline engine (ADR-030), which production `index.ts` does not invoke yet; it is exercised by tests (`__tests__/cost-control.test.ts`, `item-pipeline.test.ts`).

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **Drop or dead-letter queued work when the daily budget is exhausted** | The day cap is a throughput valve, not a verdict on any item. Pausing consumption preserves every item for the next accounting day; dropping would turn a finance limit into data loss. |
| **Degrade to a cheaper model instead of halting** | Silently changing the quality of work under budget pressure violates `budget/v1` `policy: "halt"` semantics and hides the problem the budget exists to surface. |
| **A single global cap only** | Cannot distinguish "one pathological item" from "a busy day"; the two failure modes need different responses (halt the item vs. pause the queue). |

## Consequences

### Positive
- A pathological item is quarantined with a named DLQ reason (`BUDGET_EXCEEDED`) operators can triage (`docs/runbooks/stream-operations.md`); a busy day self-heals at midnight UTC with an audit trail of exactly when and why consumption paused.
- Enforcement reuses the shipped accounting primitives — no second pricing model to drift.

### Negative / Mitigations
- The daily ledger is per-process; multiple queue-ingress replicas each enforce their own cap. Mitigation: acceptable at current scale; a shared ledger is a drop-in behind the same interface if replica counts grow.
- A paused queue shows as rising queue depth, which KEDA will answer with more replicas that also refuse to drain. Mitigation: the runbook documents the budget-pause signature (audit `budget` entries) so operators do not mistake it for a stuck consumer.

## References

- `extensions/queue-ingress/src/cost-control.ts`, `consumer.ts`, `item-pipeline.ts`, `index.ts`
- `packages/framework-core/src/token-accounting.ts`, `model-cost.ts`, `token-budget.ts`
- forge-contracts: `schemas/budget/v1/schema.json`; `forge-ops.execplan.md` Milestone 17
- ADR-027, ADR-030, `docs/runbooks/stream-operations.md`
