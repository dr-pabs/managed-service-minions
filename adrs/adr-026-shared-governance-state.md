# ADR-026: Shared governance state for the toolshed (rate limiter + circuit breaker on Azure Tables)

| Key | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-28 |
| **Deciders** | Minions remediation project (platform-engineer, Milestone 18) |
| **Replaces** | ADR-025 |
| **Superseded by** | — |

---

## Context

ADR-025 pinned the toolshed (and the chat bots and dashboard) to a single replica because its governance state was **process-local**: the rate limiter's token buckets lived in a `Map<string, TokenBucket>` (`ToolshedState.rateLimiter`), the circuit breaker state lived in a `Map<string, CircuitBreaker>` (`ToolshedState.breakers`), and pending approvals lived on a SQLite file with no multi-writer coordination. A second toolshed replica would have its own independent buckets and breakers, so a minion hitting two replicas behind a load balancer would see roughly double the configured rate limit and a breaker tripped on one replica would leave the other still hammering a failing downstream.

ADR-025 deliberately deferred a distributed implementation on the trigger condition that Milestone 13's observability metrics show sustained load beyond one replica's capacity. That condition is now met by design rather than by measurement: the Forge Ops plan commits the toolshed to high-volume, queue-driven Stream work (work-item pipelines, Milestones 15–17), which does not arrive at the idle rate of the earlier chat-driven workload. Rather than wait for a production incident to prove the single replica is the bottleneck, this milestone implements the distributed store that ADR-025 already designed a seam for — and does it on the repository's **existing** storage layer (Azure Table Storage, ADR-009), not a new one.

The seam already exists: ADR-025's decision point 2 introduced the `GovernanceStateStore` interface (`extensions/mcp-toolshed/src/governance-state.ts`) with an in-process adapter over the existing structures. This milestone adds a second adapter over Azure Tables and makes the six rate-limit/breaker methods asynchronous (they now cross a network boundary); the five approval CRUD methods stay synchronous.

## Decision

1. **Implement `createSharedGovernanceStateStore`** (`extensions/mcp-toolshed/src/shared-governance-state.ts`), a `GovernanceStateStore` adapter that persists the rate-limit token buckets and circuit breaker state to Azure Table Storage — the same storage account the Milestone 8 audit logger and `ToolCallLog` table already use — under a new `GovernanceState` table. Approval CRUD is delegated unchanged to the injected `SessionStore` (SQLite).
2. **Storage layout** — one entity per key: rate-limit buckets under `PartitionKey = "ratelimit"` (`tokens`, `lastRefill` epoch-ms columns), breakers under `PartitionKey = "breaker"` keyed by server alias (`state`, `failures`, `successes`, `openedAt`, `halfOpenRequests`). The breaker and bucket state-machine transitions are expressed as **pure functions** over the record read from the table, mirroring `CircuitBreaker` and `TokenBucketRateLimiter` exactly, so the distributed store and the in-process classes cannot drift.
3. **Concurrency via ETag optimistic concurrency** — every mutation is a read-modify-write: `getEntity` returns the current ETag, the write-back is an `updateEntity(..., "Replace", { etag })` that Azure Tables rejects with a 412 when another replica changed the row first, and the read-modify-write retries (bounded, `MAX_CAS_ATTEMPTS = 5`). A first-ever create (no entity on read) uses `upsertEntity("Replace")`, whose race is last-writer-wins — acceptable because a token-bucket refill is a pure function of elapsed time and a breaker's first transition is idempotent.
4. **Wire it in `server.ts`** behind `TOOLSHED_GOVERNANCE_STATE_CONNECTION_STRING` (table name `TOOLSHED_GOVERNANCE_STATE_TABLE`, default `GovernanceState`). When the env var is unset, `createDefaultToolshedState` builds the in-process adapter over `breakers`/`rateLimiter`/`store` exactly as before, so local/dev runs need no extra infrastructure. The shared adapter is passed the **same** `circuitBreakerConfig` and `defaultRateLimit` the in-process fallback uses.
5. **Raise the toolshed's replica ceiling** — `infra/terraform` changes the toolshed Container App from `min_replicas = 1`/`max_replicas = 1` to `min_replicas = 1`/`max_replicas = 5`, adds the `GovernanceState` table to the storage module, and sets `TOOLSHED_GOVERNANCE_STATE_CONNECTION_STRING` from the storage account's primary connection string. Azurite is added to `docker-compose.yml` for the local emulation of the table.
6. **The chat bots and dashboard stay pinned to `max_replicas = 1`.** They do not hold rate-limiter/breaker state of their own, but they share the toolshed's mounted SQLite file (session/thread bookkeeping and the still-single-writer pending-approval path). Their pinning is unchanged; only the rationale reference moves from ADR-025 to this ADR.
7. **Approval CRUD stays on SQLite.** Approvals were never the scaling trigger, and moving them would require a multi-writer store with richer query patterns (by-id and by-request-hash, resolve-and-consume) that Azure Tables fits poorly; this is the one residual single-writer limitation documented below.

## Rejected alternatives

| Alternative | Why rejected now |
|---|---|
| **Redis-backed `GovernanceStateStore`** (ADR-025's original deferred option) | Still not justified. Azure Tables already exists in the repository's storage layer (ADR-009, used by the Milestone 8 audit logger and `ToolCallLog`), so the rate-limit/breaker state lands on an already-provisioned, already-governed resource with no new managed dependency, no new failure mode, and no new cost line. Redis remains the right answer only if the residual single-writer approval path ever becomes the bottleneck. |
| **Azure Table Storage lease-based coordination** (lease per bucket/breaker key, fall back to local state) | Rejected as in ADR-025: a bespoke distributed-locking protocol with its own clock-skew and lease-expiry edge cases, for no benefit over the ETag read-modify-write the table service already provides natively. |
| **Move approvals to Azure Tables too** | Rejected for this milestone's shape. Approval records need by-id and by-request-hash lookups plus a resolve-and-consume transition; forcing that into a key/value table with row-key query limits adds complexity and risk for a path that is low-volume and was never the scaling trigger. Keeping approvals on SQLite also keeps the diff small and the in-process vs. shared adapters trivially behavior-comparable. |
| **Full refactor of the call sites to async distributed primitives with no in-process fallback** | Rejected. The in-process fallback is what keeps local/dev and tests hermetic and fast; removing it would couple every test to a table endpoint. The shared store is a second adapter behind the same interface, not a rewrite of `toolshed.ts`. |

## Trigger condition for revisiting

Revisit (move approval CRUD off SQLite, or adopt a richer shared store such as Redis) when **pending-approval traffic** — not tool-call rate — becomes a cross-replica coordination problem: concretely, approval resolution latency or `SQLITE_BUSY`/inconsistent-read errors on the mounted SQLite file that correlate with multiple writers, or an operator requirement for horizontal approval throughput. The rate-limit/breaker path this ADR moves is complete; the residual single-writer path is approvals only.

## Consequences

### Positive
- The toolshed can now run more than one replica with correct, shared rate limiting and breaker state: a bucket drained through one replica is drained through all, and a breaker tripped by traffic through one replica rejects calls through every replica (asserted by the Milestone 18 proving test).
- No new storage dependency: the state lives on the already-provisioned Azure Table Storage account, and Azurite provides the same table locally.
- The `GovernanceStateStore` seam (ADR-025) is now exercised by a second implementation, proving the interface was the right cut; the pure-function transitions mirror the in-process classes so the two cannot drift silently.
- Terraform and the docs now match: the toolshed's `max_replicas` is 5 and its rationale (shared table-backed governance state) is documented, while the bots/dashboard remain honestly pinned with their residual SQLite rationale.

### Negative / Mitigations
- Each rate-limit check and breaker transition now costs a table read and (usually) a write — a network hop on the governed-call hot path. Mitigation: the read-modify-write is a single bounded retry loop, and the in-process fallback remains the default so low-volume deployments pay nothing. If the hop ever shows up in the Milestone 13 latency metrics, the fallback remains a one-line switch.
- ETag races on a hot key can retry up to `MAX_CAS_ATTEMPTS` times before surfacing; under sustained contention this could add tail latency. Mitigation: the retry bound is small, the pure-function refill/transition means retries converge, and this is the standard optimistic-concurrency pattern for Azure Tables.
- Approvals remain single-writer on SQLite, so the toolshed is not *uniformly* multi-replica-safe — a limitation that must stay visible in the docs until the trigger condition above is met. This ADR narrows, but does not eliminate, ADR-025's single-replica concern.

## References

- `extensions/mcp-toolshed/src/shared-governance-state.ts`, `governance-state.ts`, `rate-limiter.ts`, `circuit-breaker.ts`, `server.ts`, `store.ts`
- `infra/terraform/modules/container_apps/main.tf`, `infra/terraform/modules/storage/main.tf`, `docker-compose.yml`
- ADR-004 (stateless minions, stateful orchestrator), ADR-009 (SQLite + Azure Table Storage + Azure Blob), ADR-011 (Container Apps), ADR-025 (superseded single-replica decision)
- `forge-ops.execplan.md`, Milestone 18
