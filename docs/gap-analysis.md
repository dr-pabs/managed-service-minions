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
| **Decision records** | ✅ 22 ADRs | `adrs.md`, `adrs/adr-001` through `adr-022` |
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

---

## Remaining Gaps

### 1. Scale Limits — Documented, Needs Production Validation

| Question | Answer |
|---|---|
| Max concurrent minions per orchestrator replica | Bounded by Goose delegate pool. Estimated 10-20 per replica. |
| Max sessions per minute | Bounded by intent classifier latency (~500ms). Estimated 30-50/min with 5 orchestrator replicas. |
| Bottleneck | LLM API rate limits, not compute or storage. |
| Scaling strategy | The **orchestrator** scales horizontally (more Container Apps replicas, KEDA on Service Bus queue depth, session affinity — ADR-004, ADR-012). The **toolshed, chat bots, and dashboard are pinned to a single replica** (ADR-025): their rate limiter, circuit breaker, and pending-approval reads/writes are process-local state with no cross-replica coordination, so adding replicas to those apps would silently break governance enforcement rather than add capacity. See ADR-025 for the trigger condition to revisit. |

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
│   ├── high-level-design.md              (1,434 lines)  Architecture narrative
│   ├── logical-architecture.md            (986 lines)   12 Mermaid diagrams
│   ├── physical-architecture.md           (541 lines)   7 Mermaid diagrams
│   ├── azure-architecture.md              (834 lines)   9 Mermaid diagrams
│   ├── gap-analysis.md                    (137 lines)   This document
│   ├── dashboard-design.md                (380 lines)   6 view wireframes
│   ├── goose-changes-required.md          (132 lines)   Capability audit
│   ├── goose-capabilities-and-usage.md    (235 lines)   Goose boundary analysis
│   ├── how-goose-works-with-llms.md       (759 lines)   LLM integration + tiers
│   ├── error-handling.md                  (523 lines)   12 failure scenarios
│   ├── testing-strategy.md                (484 lines)   9 testing layers
│   └── disaster-recovery.md               (175 lines)   4 failure scenarios
├── adrs/
    ├── adr-001 through adr-022        (22 files)
```
