# Architecture Decision Records — Minions Agent Framework

This directory holds one file per ADR. Each file is the authoritative record of its decision; this readme is only an index. (An earlier revision of this file duplicated the full text of ADR-001–022 inline, which drifted from the standalone files as decisions were amended — the duplication was removed on 2026-07-09.)

Amendments are appended to an ADR, never rewritten over it: the original Context/Decision/Consequences remain the historical record, and dated amendment sections record what changed and why (see ADR-023 for the pattern).

| ADR | Title | Status |
|---|---|---|
| [ADR-001](./adr-001-use-goose-delegate-as-minion-runtime.md) | Use Goose `delegate` as the minion runtime | Accepted |
| [ADR-002](./adr-002-use-mcp-for-tool-integrations.md) | Use MCP for all tool integrations | Accepted |
| [ADR-003](./adr-003-use-goose-extensions-as-packaging-unit.md) | Use Goose extensions as the packaging unit | Accepted |
| [ADR-004](./adr-004-stateless-minions-stateful-orchestrator.md) | Stateless minions, stateful orchestrator | Accepted |
| [ADR-005](./adr-005-tool-allowlisting-per-minion.md) | Tool allowlisting per minion | Accepted |
| [ADR-006](./adr-006-structured-json-output-contracts.md) | Structured JSON output contracts for minions | Accepted |
| [ADR-007](./adr-007-human-in-the-loop-destructive-ops.md) | Human-in-the-loop for destructive operations | Accepted |
| [ADR-008](./adr-008-async-first-with-sync-fallback.md) | Async-first task execution with sync fallback | Accepted |
| [ADR-009](./adr-009-sqlite-table-blob-storage-reject-cosmos.md) | SQLite + Azure Table Storage + Azure Blob for storage (reject Cosmos DB) | Accepted |
| [ADR-010](./adr-010-azure-ai-foundry-as-ai-platform.md) | Azure AI Foundry as the AI platform | Accepted |
| [ADR-011](./adr-011-azure-container-apps-for-compute.md) | Azure Container Apps for compute | Accepted |
| [ADR-012](./adr-012-azure-service-bus-async-queue.md) | Azure Service Bus for async task queuing | Accepted (amended by ADR-027) |
| [ADR-013](./adr-013-github-as-source-of-truth-cicd.md) | GitHub as framework source of truth + CI/CD | Accepted |
| [ADR-014](./adr-014-teams-phase-1-peer-to-slack.md) | Microsoft Teams as Phase 1 priority (peer to Slack) | Accepted |
| [ADR-015](./adr-015-azure-devops-first-class-mcp.md) | Azure DevOps as first-class MCP integration | Accepted |
| [ADR-016](./adr-016-three-layer-tool-call-capture.md) | Three-layer tool call capture | Accepted |
| [ADR-017](./adr-017-correlation-id-propagation.md) | Correlation ID propagation for distributed tracing | Accepted |
| [ADR-018](./adr-018-observability-dashboard.md) | Observability dashboard design | Accepted |
| [ADR-019](./adr-019-filesystem-path-scoping.md) | Filesystem path scoping per minion | Accepted |
| [ADR-020](./adr-020-optional-semantic-code-tagging.md) | Optional semantic code tagging | Proposed |
| [ADR-021](./adr-021-prompt-lifecycle.md) | Prompt lifecycle and quality measurement | Proposed |
| [ADR-022](./adr-022-multi-tenancy.md) | Multi-tenancy model | Proposed |
| [ADR-023](./adr-023-100-percent-test-coverage-gate.md) | 100% Test Coverage Gate for Runnable Code | Accepted (amended 2026-07-09: 95% branches/lines; amended 2026-08-28: thresholds skipped on filtered runs only) |
| [ADR-024](./adr-024-red-build-policy-ralph-wiggum-loop.md) | Red Build Policy — The "Ralph Wiggum" Loop | Accepted |
| [ADR-025](./adr-025-single-replica-governance-state.md) | Single-replica deployment for the toolshed and chat bots (governance state is process-local) | Accepted (superseded by ADR-026) |
| [ADR-026](./adr-026-shared-governance-state.md) | Shared governance state for the toolshed (rate limiter + circuit breaker on Azure Tables) | Accepted |
| [ADR-027](./adr-027-queue-first-ingress.md) | Queue-first Stream ingress (single work queue, consumer-side idempotency, KEDA on the queue-ingress) | Accepted (amends ADR-012) |
| [ADR-028](./adr-028-effect-gateway.md) | Effect gateway — agents draft, only the gateway commits | Accepted (extends ADR-007) |
| [ADR-029](./adr-029-identity-v1-claims.md) | `identity/v1` token claim set (`agent_id`, `scope_id`, `correlation_id`, `exp`) | Accepted |
| [ADR-030](./adr-030-declarative-item-pipelines.md) | Declarative item pipelines under `recipes/` | Accepted |
| [ADR-031](./adr-031-per-item-and-daily-cost-control.md) | Per-item and daily cost control (`budget/v1`) | Accepted |
| [ADR-032](./adr-032-sampling-qa-circuit-breaker.md) | Sampling QA loop with a per-effect-type auto-commit circuit breaker | Accepted |
| [ADR-033](./adr-033-escalation-bridge.md) | Escalation bridge — signed `escalation/v1` envelopes from Stream to the Forge (Flow) | Accepted |
