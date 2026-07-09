# ADR-025: Single-replica deployment for the toolshed and chat bots (governance state is process-local)

| Key | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-09 |
| **Deciders** | Minions remediation project (platform-engineer, Milestone 7) |
| **Replaces** | — |
| **Superseded by** | — |

---

## Context

The remediation review (H5/F6) flagged that `infra/terraform/modules/container_apps/main.tf` set `max_replicas = 3` on the `toolshed` and `dashboard` Container Apps while several docs (`docs/gap-analysis.md`, `docs/high-level-design.md`) describe or imply horizontal scaling as an available or planned capability for these apps. That is not honest: the governance state these two apps rely on is **process-local, in-memory state with no cross-replica coordination**:

- **Rate limiter** (`extensions/mcp-toolshed/src/rate-limiter.ts`, `TokenBucketRateLimiter`) — token buckets live in a single `Map<string, TokenBucket>` inside one `RateLimiter` instance held by `ToolshedState.rateLimiter`. A second replica gets its own empty `Map` and its own independent buckets; a minion hitting two replicas behind a load balancer would see roughly double the configured `requestsPerMinute`/`burst` for both the per-server (`server:${serverAlias}`) and fine-grained (`team:minion:server:tool`) buckets.
- **Circuit breaker** (`extensions/mcp-toolshed/src/circuit-breaker.ts`, `CircuitBreaker`) — breaker state (`_state`, `failures`, `successes`, `openedAt`, `halfOpenRequests`) is held in a `Map<string, CircuitBreaker>` (`ToolshedState.breakers`, keyed by bare `serverAlias` since Milestone 6/M2). A downstream outage tripping the breaker on replica A leaves replica B's breaker closed and still hammering the failing server.
- **Pending approvals and everything else `SessionStore` durably persists** (`extensions/mcp-toolshed/src/store.ts`) — the SQLite file is mounted from a single Azure Files share but SQLite itself has no built-in multi-writer coordination across processes on different hosts; Milestone 4/6's resume-by-request-hash contract and the approval CRUD path assume one writer's view is authoritative at read time. Two toolshed replicas writing/reading the same `.sqlite` file concurrently risk `SQLITE_BUSY` errors or, worse, silently inconsistent reads (a resubmission landing on the replica that hasn't yet seen another replica's just-created approval row).
- The chat bots (`extensions/slack-bot`, `extensions/teams-bot`) already had `min_replicas = 1` / `max_replicas = 1` in Terraform before this ADR — this decision keeps that pinning and gives it the documented rationale it previously lacked (session/thread state and the same shared SQLite file are also process-adjacent concerns for the bots, even though the bots themselves hold less state than the toolshed).

Running more than one replica of the toolshed or a bot today does not add capacity — it silently breaks rate limiting, breaker isolation, and (in the worst case) approval-record consistency, while `docs/gap-analysis.md`'s "Scaling strategy: Horizontal (more Container Apps replicas)" line and `docs/high-level-design.md`'s SQLite section (which frames pending-approval/rate-limit state as an "orchestrator replica" affinity problem solvable via Service Bus sessions) do not distinguish this from the orchestrator's own legitimate, already-single-writer-safe KEDA/Service-Bus-driven scaling (ADR-004, ADR-012: minions are stateless, the orchestrator coordinates via session-affine queue messages, and multiple orchestrator replicas were already a supported, tested scaling axis). The toolshed and bots were never part of that story and the docs did not say so.

## Decision

1. **Pin `max_replicas = 1` (and `min_replicas = 1`) on the toolshed and bot Container Apps** in `infra/terraform/modules/container_apps/main.tf`, with a comment on each pointing at this ADR. The orchestrator and dashboard's replica counts are addressed separately below.
2. **Define a `GovernanceStateStore` interface** (`extensions/mcp-toolshed/src/governance-state.ts`) covering the operations the rate limiter, circuit breaker, and approval code actually need — extracted from the current `RateLimiter`, `CircuitBreaker`, and `SessionStore` approval methods — and **implement it with the current in-process structures** (the existing `Map`-backed rate limiter and breaker state, plus the existing `SessionStore` for approval CRUD). No behavior changes; this is a seam, not a rewrite (see the ExecPlan Decision Log for the additive-adapter-vs-full-refactor choice).
3. **Do not adopt Redis (or any other shared store) now.** The interface exists so that swap is mechanical later; it is not implemented because there is no second replica today to justify the operational cost (a managed Redis instance, cache-aside invalidation logic, network hop latency on every rate-limit check) of a distributed implementation.
4. **The dashboard's replica count is also pinned to `max_replicas = 1`.** The dashboard (`extensions/agent-dashboard`) reads through the same `SessionStore` (`extensions/agent-dashboard/src/dashboard.ts`) and, from Milestone 14 onward, will proxy operator approve/deny actions to the toolshed's operator HTTP endpoint — it is a thin read/proxy layer today with no independent governance state of its own, but it shares the same SQLite-file consistency concern as the toolshed (same mounted Azure Files share, same "one writer's view is authoritative" assumption in the approval-resolution path) and has no scaling requirement that offsets that risk. If the dashboard later needs to handle real concurrent operator load, that is a distinct, purely-read-scaling problem (no rate limiter/breaker state) that can be revisited independently of this ADR's trigger condition.
5. **The orchestrator's replica count is unchanged** (`min_replicas = 1`, `max_replicas = 5`, KEDA-scaled on Service Bus queue depth) — it is out of scope for this ADR. The orchestrator does not hold the toolshed's rate-limiter/breaker/approval state; its own scaling story (ADR-004, ADR-012, ADR-009) already accounts for per-replica SQLite via Service Bus session affinity and was not part of the H5/F6 finding.

## Rejected alternatives

| Alternative | Why rejected now |
|---|---|
| **Redis-backed `GovernanceStateStore`** (shared token buckets, shared breaker state, pub/sub or TTL-based approval cache) | Real fix for multi-replica correctness, but adds a new managed dependency (cost, network hop on every governed call, a new failure mode — what happens to rate limiting/breaker checks when Redis itself is unreachable) with no present need: there is exactly one replica of each affected app today. Building it now is speculative generality against an unmeasured requirement. |
| **Azure Table Storage lease-based coordination** (each replica acquires a lease per bucket/breaker key, falls back to local state if the lease can't be acquired) | Avoids adding Redis as a new dependency type (Table Storage is already used elsewhere, ADR-009) but is a bespoke distributed-locking protocol with its own correctness edge cases (lease expiry vs. clock skew, what a rate limiter does while waiting for a lease) that would need at least as much design and test investment as adopting Redis, for the same "no current need" reason. |
| **Leave `max_replicas` unpinned/at 3 and rely on documentation alone** | Rejected outright — a config that permits the exact failure mode described in Context is not made safe by a doc caveat. Terraform must enforce what the ADR says. |
| **Full refactor of `RateLimiter`/`CircuitBreaker`/approval store call sites to distributed-first primitives now, with an in-process fallback** | Rejected as this milestone's shape: it would touch every call site in `toolshed.ts` and inflate the diff and regression surface for a capability (actual multi-replica coordination) not yet needed. The additive `GovernanceStateStore` interface plus a thin in-process adapter over the existing structures gets the seam in place with a behavior-preserving, easily-reviewed diff; see the ExecPlan Decision Log entry for Milestone 7. |

## Trigger condition for revisiting

Revisit this decision (implement a real distributed `GovernanceStateStore`, e.g. Redis-backed, and raise `max_replicas` above 1) when Milestone 13's observability metrics show **sustained load beyond what one toolshed replica's capacity can serve** — concretely, sustained tool-call latency growth, breaker/rate-limit throttling that correlates with legitimate (not misconfigured) traffic volume rather than downstream outages, or CPU/memory saturation on the toolshed container observed over a sustained window (not a single spike) via the Milestone 13 metrics (tool latency histogram, throttle counters, breaker-state gauge). Until that evidence exists, a single replica plus the process-local structures already in place is the honest and sufficient design.

## Consequences

### Positive
- Terraform now matches reality: no configuration permits the toolshed, dashboard, or bots to silently run in a broken multi-replica configuration.
- `GovernanceStateStore` gives the later Redis swap a single, narrow interface to reimplement rather than a search-and-replace across `toolshed.ts`.
- Docs corrected (`docs/gap-analysis.md`, `docs/high-level-design.md`) so a future reader does not conflate the orchestrator's real, tested KEDA/Service-Bus scaling with the toolshed/bots' current single-replica constraint.

### Negative / Mitigations
- The toolshed cannot absorb load beyond one replica's capacity today. Mitigation: the trigger condition above, backed by Milestone 13 metrics, is the explicit signal to invest in a distributed implementation — this is a deliberate, documented limit, not an oversight.
- `min_replicas = 1` (not 0) on the toolshed and bots means no scale-to-zero for these apps, unlike the orchestrator. This is unchanged from before this ADR (the toolshed and bots were already effectively single-warm-instance in practice) and is required for pending approvals and audit continuity to have a live process to serve requests against.

## References

- `extensions/mcp-toolshed/src/rate-limiter.ts`, `circuit-breaker.ts`, `store.ts`, `governance-state.ts`
- `infra/terraform/modules/container_apps/main.tf`
- `docs/gap-analysis.md` §1 Scale Limits, `docs/high-level-design.md` §SQLite — Session State
- ADR-004 (stateless minions, stateful orchestrator), ADR-009 (SQLite storage), ADR-011 (Container Apps), ADR-012 (Service Bus)
- `docs/execplan/2026-07-08-minions-remediation-and-features.md`, Milestone 7 and Decision Log (H5, F6)
