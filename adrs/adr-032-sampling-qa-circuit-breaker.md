# ADR-032: Sampling QA loop with a per-effect-type auto-commit circuit breaker

| Key | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-28 |
| **Deciders** | Paul Brown |
| **Replaces** | — |
| **Superseded by** | — |

---

## Context

The effect gateway (ADR-028) allows `auto` approval-class commits with no human in the loop — necessary for Stream volume, but it removes the standing human check ADR-007 relies on. The question is how `auto` stays *earned*: what detects an agent that has started committing wrong-but-schema-valid effects, and what turns the autonomy off? The Forge Ops plan (Milestone 19) answers with post-hoc statistical review rather than pre-commit gating.

## Decision

Implement the sampling QA loop in `extensions/mcp-toolshed/src/sampling-qa.ts`, wired into the effect gateway:

1. **Post-hoc sampled review.** After an agent-actor commit, a configurable percentage (`reviewPercent`) of that effect type's commits are routed to a human reviewer through the *existing* approval surface — a `PendingApproval` with tool name `review_commit`, notified like any other approval. The review does not gate the commit (it already happened): `approve` records `agreed`, `deny` records `disagreed`. Routing is non-blocking and best-effort; a missing approval store or failed notifier never fails the commit.
2. **Disagreement-rate circuit breaker, per effect type.** When the disagreement rate over a recent-verdict window (`windowSize`) crosses `disagreementThreshold`, the breaker trips and **auto-commit turns OFF for that effect type**: every subsequent commit of that type is forced through pre-commit human approval, exactly like `always_human`, until an operator resets the breaker. The "type" is the gateway's `effect_type`; the Stream recipe binds each `item_type` to exactly one commit `effect_type`, so the grouping matches the commit boundary being governed.
3. **Dashboard surface.** `GET /api/sampling-qa` (agent-dashboard) serves the per-type stats (reviewed, disagreed, disagreement rate, tripped) and `POST /api/sampling-qa/:effectType/reset` clears the verdict window and trip state — the operator "reset" action, documented in `docs/runbooks/stream-operations.md`.
4. **Durable store seam.** Verdicts and trip state live behind a `SamplingQaStore` (in-memory for local dev/tests, SQLite-backed injectable for durability), mirroring the toolshed's dual-backend pattern, so a tripped breaker survives a replica restart.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **Pre-commit sampling only (the gateway's `sampled` class) with no post-hoc loop** | Pre-commit sampling inspects drafts before they run; it cannot measure whether *auto* commits were right, which is the specific autonomy this loop underwrites. The two mechanisms are complementary, not substitutes. |
| **A global (all-types) breaker** | One misbehaving effect type would shut down every type's autonomy; per-type tripping matches the per-type policy model (ADR-028). |
| **Automatic breaker reset after a cool-down** | A tripped breaker means humans disagreed with the agent's judgment; only a human should decide that the underlying cause is fixed. Reset is an explicit operator action. |

## Consequences

### Positive
- `auto` autonomy is continuously measured against human judgment, and revocation is automatic, targeted, and reversible.
- No new review surface: reviewers see `review_commit` approvals in the same dashboard/Slack/Teams flow as pre-commit approvals.

### Negative / Mitigations
- Post-hoc means a bad commit has already executed before review catches the pattern. Mitigation: this loop governs `auto`-class (reversible/compensatable-leaning) types; `irreversible` never auto-commits at all (ADR-028).
- Sampled review adds human workload proportional to `reviewPercent`. Mitigation: the percentage is per-type policy, tunable to risk.

## References

- `extensions/mcp-toolshed/src/sampling-qa.ts`, `effect-gateway.ts` (`routePostHocReview`, `recordReviewVerdict`)
- `extensions/agent-dashboard/src/dashboard.ts` (`/api/sampling-qa`, `/api/sampling-qa/:effectType/reset`)
- ADR-007 (human-in-the-loop — this ADR is its statistical extension for `auto` commits), ADR-018 (dashboard), ADR-028
- `forge-ops.execplan.md` (forge-contracts repo), Milestone 19; `docs/runbooks/stream-operations.md`
