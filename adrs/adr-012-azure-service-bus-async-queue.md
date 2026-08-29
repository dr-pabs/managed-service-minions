# ADR-012: Azure Service Bus for async task queuing

| Key | Value |
|---|---|
| **Status** | Accepted (amended by ADR-027) |
| **Date** | 2026-06-05 |
| **Deciders** | Goose Agent Framework team |
| **Replaces** | — |
| **Superseded by** | — (queue topology amended by ADR-027: single work queue, consumer-side idempotency, KEDA on the queue-ingress) |

---

## Context

Complex pipelines (ticket → fix → PR) involve multiple minion invocations across multiple steps. The orchestrator must reliably dispatch tasks, handle failures, and maintain ordering where dependencies exist.

Options:

1. **Azure Service Bus** — managed message broker with sessions, dead-lettering, and duplicate detection.
2. **Azure Storage Queues** — simpler, cheaper, but no sessions or dead-lettering.
3. **RabbitMQ** — self-hosted message broker.
4. **In-memory queue** — no external dependency. Tasks queued in-process.

## Decision

Use Azure Service Bus, Standard tier (~$10/month).

### Queue Topology

- **Topic:** `minion-tasks` — all minion tasks are published here.
- **Subscriptions:** One per minion type (`code-explorer`, `code-reviewer`, `pr-crafter`, `ticket-analyst`, `security-auditor`). Each subscription filters on `minion_type` property.
- **Sessions enabled** — Session ID = correlation ID. Ensures messages for the same orchestration arrive in order and are processed by the same consumer.
- **Dead-letter** — Failed tasks (exhausted retries) move to DLQ for manual inspection and replay.

## Rationale

- **Sessions** — Ordered delivery per correlation ID. Critical for pipelines where Phase 2 depends on Phase 1 outputs.
- **Dead-lettering** — Failed tasks are automatically moved to DLQ after max delivery attempts. No lost work. Operators can inspect and replay.
- **Duplicate detection** — Prevents double-processing if the orchestrator retries a dispatch.
- **Scheduled messages** — Supports delayed retry with exponential backoff. A failed minion can be rescheduled for 30s, 60s, 120s later.
- **Standard tier cost** — ~$10/month includes sessions, dead-letter, duplicate detection, and up to 256KB messages.
- **Managed** — No server to patch, no cluster to maintain.

### Why not the alternatives?

| Option | Rejected Because |
|---|---|
| **Storage Queues** | No sessions (critical for ordered delivery). No dead-letter with metadata. Manual poison queue handling. |
| **RabbitMQ** | Self-hosted — operational burden of patching, scaling, and monitoring. No Azure AD integration. |
| **In-memory** | Lost on restart. No cross-replica communication. Not production-grade. |

## Consequences

### Positive
- Reliable, ordered delivery with sessions
- Automatic dead-lettering for failed tasks
- Managed — zero operations

### Negative / Mitigations
- **Adds a managed Azure resource** — Mitigation: $10/month Standard tier is negligible. Infrastructure-as-code (Bicep/Terraform) in the framework repo.
- **Session-based ordering limits fan-out within a session** — Mitigation: Parallel sub-tasks use separate sessions (sub-correlation IDs). The orchestrator coordinates the fan-out.
- **256KB message size limit (Standard tier)** — Mitigation: Large context payloads go via Blob Storage. The Service Bus message contains a Blob SAS URL reference.
