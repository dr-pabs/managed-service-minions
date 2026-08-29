# Gap Analysis — What We've Covered and What's Missing

> **Date:** 2026-06-06  
> **Status:** Working document — most gaps closed  
> **Purpose:** Identify every gap so nothing ships half-designed.

---

## Coverage Matrix

| Domain | Status | Documents |
|---|---|---|
| **Architecture** | ✅ Complete | `./high-level-design.md`, `./logical-architecture.md` |
| **Physical architecture** | ✅ Complete | `./physical-architecture.md`, `./azure-architecture.md` |
| **Decision records** | ✅ 33 ADRs | `adrs/readme.md` (index), `adrs/adr-001` through `adr-033` |
| **Goose capabilities** | ✅ Complete | `./goose-capabilities-and-usage.md` |
| **LLM integration** | ✅ Complete | `./how-goose-works-with-llms.md` |
| **Storage architecture** | ✅ Complete | `./high-level-design.md` §7, ADR-009 |
| **Tool call capture** | ✅ Complete | `./high-level-design.md` §8, ADR-016 |
| **Security model** | ✅ Complete | `./high-level-design.md` §14, ADR-007, 019 |
| **Minion definitions** | ✅ Complete | `./high-level-design.md` §5 |
| **Entry points** | ✅ Complete | `./high-level-design.md` §3, ADR-014 |
| **Code scoping & tagging** | ✅ Complete | ADR-019, ADR-020 |
| **Observability (Grafana)** | ✅ Complete | ADR-018 |
| **Custom dashboard** | ✅ Complete | `./dashboard-design.md` |
| **Goose core changes** | ✅ Complete | `./goose-changes-required.md` |
| **Error handling patterns** | ✅ Complete | `./error-handling.md` |
| **Prompt lifecycle** | ✅ Complete | ADR-021, `adrs/adr-021-prompt-lifecycle.md` |
| **Multi-tenancy** | ✅ Complete | ADR-022, `adrs/adr-022-multi-tenancy.md` |
| **Testing strategy** | ✅ Complete | `./testing-strategy.md` |
| **Disaster recovery** | ✅ Complete | `./disaster-recovery.md` |
| **Scale limits** | ⚠️ Documented below | Expand with production data |
| **Recursive orchestration** | ✅ Decided | Explicit non-goal for v1 |
| **Identity contract (`identity/v1`)** | ✅ Complete | ADR-029, `packages/framework-core/README.md`, forge-contracts vectors |
| **Queue-first Stream ingress** | ✅ Complete | ADR-027, `extensions/queue-ingress/README.md`, `./runbooks/stream-operations.md` |
| **Effect gateway (`effects/v1`)** | ✅ Complete | ADR-028, `extensions/mcp-toolshed/README.md` |
| **Item pipelines (declarative)** | ✅ Complete (wired into the production consumer with per-`item_type` routing and fallback) | ADR-030, `recipes/README.md` |
| **Cost control (`budget/v1`)** | ✅ Complete (daily and per-item caps both wired in the production consumer) | ADR-031 |
| **Sampling QA circuit breaker** | ✅ Complete | ADR-032, `./dashboard-design.md` addendum |
| **Escalation bridge (`escalation/v1`)** | ✅ Complete (emitter wired in the production consumer, armed by `FORGE_INTAKE_URL` + `FORGE_BRIDGE_SECRET`) | ADR-033, `./runbooks/stream-operations.md` |

---

## Remaining Gaps

### 1. Scale Limits — Documented, Needs Production Validation

| Question | Answer |
|---|---|
| Max concurrent minions per orchestrator replica | Bounded by Goose delegate pool. Estimated 10-20 per replica. |
| Max sessions per minute | Bounded by intent classifier latency (~500ms). Estimated 30-50/min with 5 orchestrator replicas. |
| Bottleneck | LLM API rate limits, not compute or storage. |
| Scaling strategy | The **queue-ingress** is the KEDA scale target (1–5 replicas on `minion-tasks` work-queue depth — ADR-027; the scaler moved off the orchestrator at forge-ops Milestone 15). The **orchestrator** runs 1–5 replicas with no scaler of its own (ADR-004, ADR-012 as amended by ADR-027). The **toolshed** also scales now (ADR-026): its rate-limiter buckets and circuit breaker state moved to a shared `GovernanceState` Azure Table, so multiple replicas enforce one view of them; only pending-approval CRUD remains single-writer on SQLite. The **chat bots and dashboard remain pinned to a single replica** (ADR-026): they share the toolshed's mounted SQLite file (session bookkeeping and the single-writer approval path) and hold no rate-limiter/breaker state of their own. See ADR-025 (superseded) and ADR-026 for the residual-limitation trigger condition. |

The throughput ceiling should be validated with load testing in staging. See `./testing-strategy.md` §Performance Tests.

### 2. Recursive Orchestration — Explicit Non-Goal for v1

The orchestrator spawning an orchestrator delegate (e.g., "Fix all 50 open P1 bugs" → 50 sub-orchestrations) is a deliberate non-goal. It introduces complexity in correlation ID depth, session fan-out, and result aggregation that outweighs the benefit for v1. Large batch tasks are handled by the existing cron + parallel minion model.

### 3. Production Validation

All current numbers (cost estimates, throughput ceilings, RTO/RPO targets) are calculated or estimated. They must be validated in staging and production. The Grafana dashboards and alert rules are designed to surface discrepancies.

---

## Document Inventory

```
.
├── docs/
│   ├── high-level-design.md               Architecture narrative
│   ├── logical-architecture.md            Mermaid diagrams (logical views)
│   ├── physical-architecture.md           Mermaid diagrams (physical views)
│   ├── azure-architecture.md              Mermaid diagrams (Azure views)
│   ├── low-level-design.md                Goose primitives + framework additions
│   ├── gap-analysis.md                    This document
│   ├── dashboard-design.md                View wireframes + as-built addendum
│   ├── goose-changes-required.md          Capability audit
│   ├── goose-capabilities-and-usage.md    Goose boundary analysis
│   ├── how-goose-works-with-llms.md       LLM integration + tiers
│   ├── error-handling.md                  Failure scenarios + DLQ triage
│   ├── testing-strategy.md                Testing layers (incl. soak + contract conformance)
│   ├── disaster-recovery.md               Failure scenarios
│   └── runbooks/                          DR, production handoff, security review, stream operations
├── adrs/
    ├── readme.md (index) + adr-001 through adr-033   (34 files)
```

(Line counts removed — they drifted with every edit; the inventory lists what exists, `wc -l` answers how big.)
