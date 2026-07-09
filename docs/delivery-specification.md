# Delivery Specification — Minions Agent Framework

> **Status:** Draft for implementation delivery  
> **Date:** 2026-06-06  
> **Purpose:** Define the work to be delivered, the scope, the delivery phases, and the acceptance criteria for the Goose multi-agent framework.

## 1. Objective

Deliver a production-ready multi-agent orchestration platform built on Goose, with:

- Slack and Microsoft Teams ingress
- an orchestrator that classifies intent, decomposes tasks, and manages minions
- a shared MCP toolshed with allowlists, logging, and rate limiting
- Azure-hosted infrastructure and observability
- prompt quality, security, and testing controls

This specification is grounded in the existing design documents in this folder, especially:

- [high-level-design.md](./high-level-design.md)
- [goose-changes-required.md](./goose-changes-required.md)
- [gap-analysis.md](./gap-analysis.md)
- [testing-strategy.md](./testing-strategy.md)
- [skills-and-roles.md](./skills-and-roles.md)
- [agent-led-development.md](./agent-led-development.md)

---

## 2. Problem Statement

The current Goose runtime provides the agent loop and tool primitives, but the framework still needs a complete delivery layer to make it useful in real operations:

1. a central orchestrator for multi-minion decomposition and result synthesis
2. shared tool governance for allowlists, auditing, rate limiting, and security
3. Azure deployment, observability, and recovery patterns
4. prompt-quality and test automation to ensure reliability
5. governance and human approval for destructive or high-risk actions

The work to deliver is therefore not just a single bot or prompt, but an end-to-end framework that can safely run agentic workflows across code, tickets, and PR activities.

---

## 3. Scope of Delivery

### In Scope

1. Core framework capabilities
   - Intent classification and routing
   - Task decomposition into DAG-style minion workflows
   - Spawn, monitor, collect, retry, and dead-letter minion runs
   - Correlation ID propagation across sessions, minions, and tool calls

2. Shared tool and security layer
   - MCP toolshed allowlist enforcement
   - Tool-call logging and audit capture
   - Rate limiting and circuit breaking
   - Path scoping and least-privilege access
   - Human approval gates for destructive actions

3. Ingress and channel integration
   - Slack bot entry point
   - Microsoft Teams bot entry point
   - Scheduled task invocation for recurring workflows

4. Azure platform delivery
   - Container Apps runtime
   - Service Bus for asynchronous tasks
   - Storage for session metadata, logs, and backups
   - Key Vault and managed identity
   - AI Foundry model routing and content-safety integration
   - Log Analytics, Grafana, and the custom dashboard/observability views

5. Delivery workflows and controls
   - GitHub and Azure DevOps pull-request review and creation workflows
   - Unit, integration, prompt-quality, E2E, chaos, and performance testing
   - Disaster-recovery, backup/restore, and production-validation checks
   - CI/CD deployment pipelines and rollback paths

### Out of Scope for v1

- Recursive orchestration (an orchestrator spawning another orchestrator)
- Full multi-region failover
- Broad unsupported third-party integrations beyond the core MCP set
- Dynamic runtime extension enable/disable as a governance model
- Fully autonomous destructive actions without human approval

---

## 4. Delivery Outcomes

The deliverable must provide the following business and technical outcomes:

- Users can submit work in Slack or Teams and receive structured, traceable results.
- The framework can intake and act on ServiceNow tickets and Azure DevOps work items as first-class delivery inputs.
- The framework can create and review pull requests in GitHub and Azure DevOps as part of its delivery flow.
- Operators can inspect sessions, correlation trees, live minion status, and tool-call traces through the dashboard and observability tooling.
- The framework can run multiple specialist minions in parallel where appropriate.
- Tool actions are governed, logged, and auditable.
- The system can recover from common failures without silent loss of work.
- Engineers can deploy, monitor, and improve the framework through CI/CD and observability.

---

## 5. Delivery Workstreams

### Workstream A — Orchestrator and Minion Framework

Deliverables:

- orchestrator extension with intent classification and routing
- task decomposition and DAG execution model
- minion lifecycle handling (spawn, monitor, collect, retry, DLQ)
- structured result validation and correlation ID propagation

Success criteria:

- a request can be classified into a supported minion path
- multiple minions can run concurrently and combine outputs
- failed runs are retried and recorded with a clear status

---

### Workstream B — MCP Toolshed and Governance

Deliverables:

- allowlist enforcement per minion type
- tool-call capture, rate limiting, and circuit breaking
- path scoping and blocked-tool reporting
- audit logging to Table Storage and Log Analytics

Success criteria:

- disallowed tools are blocked before they reach the backend
- every approved tool call is logged with correlation context
- the toolshed can safely enforce least-privilege access

---

### Workstream C — Ingress, Messaging, and Runtime Integration

Deliverables:

- Slack and Teams bot adapters
- Service Bus queue/topic integration for async execution
- session state persistence and structured session artifacts
- fallback and retry handling for transient platform failures

Success criteria:

- bot messages are accepted, processed, and replied to with structured output
- asynchronous runs are durable and recoverable
- session state can be resumed or inspected for debugging

---

### Workstream D — Azure Infrastructure and Operations

Deliverables:

- Container Apps environment and runtime resources
- private networking, Key Vault, managed identity, and RBAC
- storage, messaging, and AI Foundry wiring
- monitoring, alerting, and Grafana visibility

Success criteria:

- the platform deploys via infrastructure as code
- traffic flows through approved Azure security boundaries
- operators can observe health, failures, cost, and usage

---

### Workstream E — Prompt Quality, Test, and Release Controls

Deliverables:

- minion prompt definitions and JSON output schemas
- prompt evaluation test cases and quality gates
- CI/CD integration for tests, canary deployment, and rollback
- human approval controls for destructive actions

Success criteria:

- prompt changes are measurable against baseline quality
- regression tests run in CI before deployment
- unsafe or low-quality changes can be rolled back or blocked

---

## 6. Delivery Phases

### Phase 1 — Foundation

- scaffold the orchestrator, toolshed, and bot extensions
- prove basic delegate spawning and result collection
- establish session state and initial logging

### Phase 2 — Minion Framework

- implement the core minion types and prompt contracts
- add DAG decomposition, retries, and dead-letter handling
- validate structured outputs and allowlist behavior

### Phase 3 — Ticket and Review Pipelines

- wire end-to-end workflows for ticket analysis, code review, and PR creation
- validate real operational flows with mocked or staged integrations
- introduce human approval and partial-failure handling

### Phase 4 — Platform Hardening

- deploy Azure infrastructure and observability
- implement dashboard, alerting, and production diagnostics
- validate performance, recoverability, and cost assumptions

---

## 7. Acceptance Criteria

The work is complete when all of the following are true:

1. The orchestrator can accept a user request, classify intent, dispatch minions, and synthesize the result.
2. The framework can retrieve, summarize, and act on a ServiceNow ticket and an Azure DevOps work item as part of a delivery flow.
3. The framework can create or review pull requests in GitHub and Azure DevOps as part of the same delivery journey.
4. Minions operate under scoped tool access and their tool calls are audited.
5. Slack and Teams can successfully trigger and receive framework output.
6. Operators can diagnose runs through the dashboard, correlation tree, live status, and logs.
7. Failures are handled through retry, partial result, or dead-letter patterns without silent loss.
8. Azure deployment, observability, recovery, and staging validation (including DR/RTO-RPO and performance checks) are defined and testable.
9. Prompt and pipeline quality are validated through automated checks.
10. Production deployment requires the approved human gate for destructive actions.

---

## 8. Risks and Dependencies

### Key Risks

- Per-delegate model/provider overrides may require explicit verification in Goose.
- Managed identity and Azure OpenAI fallback behavior must be validated against the runtime.
- The ability to cancel a running delegate is a likely Goose core enhancement and should be treated as a dependency.
- Prompt-quality regressions can be subtle and require automated evaluation, not just visual review.

### Dependencies

- Goose runtime primitives (`delegate`, `load(taskId)`, sessions, scheduling)
- Azure Container Apps, Service Bus, Storage, Key Vault, AI Foundry, and Log Analytics
- MCP servers for GitHub, Azure DevOps, ServiceNow, Jira, Slack, and Teams
- CI/CD and environment promotion controls

---

## 9. Definition of Done

The framework is ready to be considered delivered when:

- the core orchestration path works end to end
- the security and audit controls are in place
- the infrastructure and deployment path are documented and reproducible
- tests and prompt-evaluation gates are part of the standard release process
- **100% code coverage is maintained for all runnable TypeScript code in `packages/` and `extensions/`, enforced in CI**
- **A red build blocks merge until fixed, fully re-tested, and QA-approved (the "Ralph Wiggum" loop)**
- the delivery is traceable to the existing architecture and ADR documentation in this workspace

---

## 10. Delivery Summary

This delivery is a platform implementation, not a single feature. The correct outcome is an operating multi-agent framework built on Goose, with clear boundaries between runtime, orchestration, tool governance, Azure hosting, and human oversight.
