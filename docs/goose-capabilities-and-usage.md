# Goose Agent Harness — Capabilities Analysis

> **Date:** 2026-06-06  
> **Purpose:** Clarify what Goose provides, what the framework uses, and what is deliberately unused.

---

## Table of Contents

1. [What Goose Is](#what-goose-is)
2. [Goose Capabilities We Use](#goose-capabilities-we-use)
3. [How Gooses Harness Powers the Framework](#how-gooses-harness-powers-the-framework)
4. [Goose Capabilities Deliberately Unused](#goose-capabilities-deliberately-unused)
5. [Gap Analysis — What We Build Ourselves](#gap-analysis--what-we-build-ourselves)
6. [Summary Matrix](#summary-matrix)

---

## What Goose Is

Goose is an **LLM-powered agent runtime** that provides:

- A **session-based conversational loop** — it receives instructions, reasons, calls tools, observes results, and responds
- An **extension system** — tools and behaviors are packaged as loadable extensions with manifests
- A **delegate mechanism** — it can spawn sub-agents that run in isolated context windows with restricted tool access
- **MCP (Model Context Protocol) support** — extensions can expose tools via the MCP standard
- **Scheduling** — cron-based job execution
- A set of **built-in developer tools** — shell, file editing, code search, code analysis

Goose is *not* a workflow engine, a message queue, a database, or a multi-agent orchestrator. It provides the *primitives* — our framework composes them into the architecture.

---

## Goose Capabilities We Use

### Core Primitives

| Goose Capability | What It Provides | How We Use It |
|---|---|---|
| **`delegate`** | Spawn a sub-agent with isolated context, restricted tools, and async execution | Every minion is a `delegate`. The orchestrator calls `delegate(instructions, extensions, max_turns, async: true)` to spawn minions. Context isolation prevents prompt pollution. Tool allowlisting via the `extensions` parameter enforces ADR-005. |
| **`load(taskId)`** | Wait for and collect the result of an async delegate | The orchestrator's Minion Monitor polls `load(taskId)` to track minion completion, collect structured JSON outputs, and detect timeouts. |
| **Extensions** | Package tools, prompts, and behaviors as independently versioned units | Every framework component is a Goose extension: `orchestrator`, `mcp-toolshed`, `slack-bot`, `teams-bot`, `agent-dashboard`. Extensions declare dependencies via `requires` (e.g., `orchestrator` requires `mcp-toolshed`). ADR-003. |
| **Sessions** | Persistent conversation state across turns | The orchestrator maintains session state (correlation ID, user, channel, intent) in Goose's session model, backed by SQLite. |
| **`platform__manage_schedule`** | Cron-based job scheduling | Daily PR review, ticket polling, weekly security scans. The scheduled trigger invokes the orchestrator with a pre-defined intent. |

### Tool Ecosystem

| Goose Capability | What It Provides | How We Use It |
|---|---|---|
| **`shell`** | Execute bash commands with stdout/stderr capture | Used by Code Explorer (read-only commands like `git log`), PR Crafter (build/test commands), and Security Auditor (scanners like `bandit`, `trivy`). Command allowlists restrict what each minion can execute. |
| **`edit` / `write`** | Modify or create files | Used by PR Crafter to implement fixes and write tests. Filesystem MCP provides additional read/write/search/list capabilities. |
| **`tree`** | Directory listing with line counts, .gitignore-aware | Used by Code Explorer for initial codebase navigation before deeper analysis. |
| **`analyze`** | Tree-sitter AST parsing: structure overview, symbol details, call graphs | Core tool for Code Explorer minion. Provides function/class counts, call chains, and symbol tracing without raw grep. |
| **`rg`** (ripgrep) | Fast code search, .gitignore-aware | Used by Code Explorer and Code Reviewer for targeted searches across large codebases. |

### Integration & Memory

| Goose Capability | What It Provides | How We Use It |
|---|---|---|
| **`chatrecall` extension** | Search past conversations, load session summaries | Provides shared memory across minion invocations. If a Ticket Analyst already fetched incident details earlier in the session, the PR Crafter can recall them instead of re-querying. |
| **MCP tool specification** | Standard protocol for tool exposure | The `mcp-toolshed` extension manages connections to MCP servers (GitHub, ADO, ServiceNow, Jira, Slack, Teams) and exposes their tools to minions through the Goose tool interface. |
| **`apps__create_app`** | Generate sandboxed HTML/CSS/JS apps from a description | Used to build the `agent-dashboard` extension (Phase 4) — a web UI for session replay, correlation tree viewing, and governance config. |
| **`apps__iterate_app`** | Improve an existing app based on feedback | Used for iterative development of the `agent-dashboard` during Phase 4. |

---

## How Goose's Harness Powers the Framework

### The Orchestrator-to-Minion Flow (in Goose terms)

```
1. User messages Slack/Teams
2. Slack/Teams bot (Goose extension) receives the event
3. Bot calls the orchestrator (another Goose extension) with the message
4. Orchestrator classifies intent, generates correlation ID
5. Orchestrator calls:
     delegate(
       instructions: "You are a Ticket Analyst. Query ServiceNow for INC00421...",
       extensions: ["mcp-toolshed"],      ← toolshed's allowlist limits which MCP tools
       max_turns: 10,
       async: true
     )
6. Goose spawns the delegate in an isolated context:
   - Its own LLM conversation window
   - Only the extensions listed (mcp-toolshed)
   - Its own turn counter and timeout
7. Orchestrator calls load(taskId) periodically
8. Delegate returns structured JSON
9. Orchestrator validates schema, merges with other results, responds to user
```

### What Goose Handles for Free

| Concern | Handled by Goose? | Notes |
|---|---|---|
| LLM invocation loop (think → call tool → observe → repeat) | ✅ Yes | Built into every delegate |
| Context window isolation | ✅ Yes | Each delegate has its own window |
| Tool registration and discovery | ✅ Yes | Extensions register tools; delegates see only allowed tools |
| Turn counting and limiting | ✅ Yes | `max_turns` parameter |
| Session persistence | ✅ Yes | Conversations persist across turns |
| Extension lifecycle (load, init, shutdown) | ✅ Yes | Goose manages extension state |
| Async execution | ✅ Yes | `async: true` on delegate |
| Structured output collection | ✅ Yes | `load(taskId)` returns the delegate's final message |

### What We Build on Top

| Concern | We Build | Using Goose Primitive |
|---|---|---|
| Intent classification | Orchestrator extension | `delegate` with a classifier prompt |
| Task decomposition (DAG) | Orchestrator extension | Multiple `delegate` calls with dependency ordering |
| Minion allowlisting | `mcp-toolshed` extension | Extension tool registration + per-minion config |
| Tool call logging | `mcp-toolshed` extension | Intercepts every tool call before/after |
| Correlation ID propagation | Orchestrator + toolshed | Passes IDs in delegate instructions and logs |
| Human-in-the-loop gating | Orchestrator extension | Pauses pipeline, posts approval prompt, waits |
| Message platform adapters | `slack-bot`, `teams-bot` extensions | Goose extensions with HTTP ingress |
| Scheduling recipes | Goose `platform__manage_schedule` | Cron expressions → orchestrator invocation |

---

## Goose Capabilities Deliberately Unused

These Goose capabilities exist but we do not use them in the framework. Each has a specific reason.

### Extension Management

| Capability | What It Does | Why Unused |
|---|---|---|
| **`extensionmanager__manage_extensions`** | Enable/disable extensions at runtime | The framework's extensions are loaded at container start and stay loaded. Dynamic enable/disable adds complexity without benefit for our use case. Extensions are deployed via CI/CD, not toggled at runtime. |
| **`extensionmanager__search_available_extensions`** | Discover extensions available to load | Not relevant at runtime. The extension set is defined in the container image. |
| **`extensionmanager__list_resources` / `read_resource`** | Browse and read extension-provided resources (files, schemas, data) | We use extension manifests (YAML) for configuration, not Goose's resource system. Our configs are version-controlled in Git. |

### Skills & Tutorials

| Capability | What It Does | Why Unused |
|---|---|---|
| **`load_skill`** | Load a skill's full instructions into context | Skills are Goose's mechanism for on-demand prompt injection. We use minion system prompts (versioned `.md` files) instead. Skills would introduce runtime prompt variability — we want prompts to be PR-reviewed and deployed. |
| **`skills` extension** | Skill catalog | Same reason. Prompt changes are governed (ADR-013), not loaded dynamically. |
| **`tutorial` extension** | Interactive guides | Not needed for an automated agent framework. |

### Niche Tools

| Capability | What It Does | Why Unused |
|---|---|---|
| **`summon` extension** | (Unclear purpose in current Goose) | Not applicable to our architecture. |
| **`tom` extension** | (Unclear purpose in current Goose) | Not applicable to our architecture. |
| **`computercontroller`** | General computer control (UI automation) | Our agents operate on APIs, Git, and files — not GUIs. Computer control would be a security risk and is unnecessary for codebase tasks. |
| **`autovisualiser`** | Data visualization and UI generation | We use Azure Managed Grafana for operational dashboards. The custom `agent-dashboard` is built via `apps__create_app`, not `autovisualiser`. |
| **`memory`** | Teach Goose preferences as you go | Our framework is multi-tenant and stateless per-minion. Per-user preferences would add complexity without clear benefit. Session memory is handled by `chatrecall`. |
| **`code_execution`** | Make extension calls through code execution | Our minions call tools directly through the toolshed. Adding a code execution indirection would complicate the audit trail and allowlist enforcement. |

---

## Gap Analysis — What We Build Ourselves

These capabilities do not exist in Goose and must be built entirely by the framework:

| Capability | What It Requires | Where It Lives |
|---|---|---|
| **Multi-minion orchestration** | DAG construction, parallel dispatch, result merging, dependency ordering | `orchestrator` extension |
| **Intent classification** | LLM prompt that maps user messages to intents + platform detection | `orchestrator` extension |
| **Tool allowlist enforcement** | Per-minion, per-server tool allowlists with blocking and logging | `mcp-toolshed` extension |
| **Tool call audit logging** | Three-layer capture with Table Storage + Log Analytics + Blob | `mcp-toolshed` extension |
| **Rate limiting** | Sliding window per server+minion pair | `mcp-toolshed` extension |
| **Correlation ID propagation** | Root ID → sub-ID → tool-call ID through all layers | `orchestrator` + `mcp-toolshed` |
| **Human-in-the-loop gating** | Approval prompts, timeout handling, decision logging | `orchestrator` extension |
| **MCP server connections** | Connection pool, health checks, circuit breaking, auth management | `mcp-toolshed` extension |
| **Chat platform adapters** | Slack Bolt integration, Microsoft 365 Agent SDK integration, Adaptive Card rendering | `slack-bot` + `teams-bot` extensions |
| **Structured minion outputs** | JSON schemas per minion type, validation, schema versioning | `orchestrator` extension |
| **Minion retry logic** | Exponential backoff, max retries, dead-letter on exhaustion | `orchestrator` extension |
| **SQLite session store** | Schema for sessions, minion runs, approvals; periodic backup to Blob | `orchestrator` extension |
| **Grafana dashboards** | KQL-based panels for Overview, Minion Health, Cost, Security | Azure Managed Grafana (config) |
| **Custom dashboard** | Session explorer, correlation tree, live status, governance editor | `agent-dashboard` extension (Phase 4) |

---

## Forge Ops (Stream) Capabilities

Beyond the Goose-boundary gaps above, Minions carries a **Forge Ops (Stream)**
distribution — the high-volume customer-workflow half of a two-runtime design
(**Flow** lives in the Forge repository), joined by versioned contracts in the
[`forge-contracts`](https://github.com/dr-pabs/forge-contracts) repository.
Each capability below ships with a backing test suite; the table is the Stream
counterpart to Forge's `capabilities.yaml` (which names each Flow capability's
backing test the same way).

| Capability | What it does | Backing tests |
|---|---|---|
| **Identity tokens** (`identity/v1`) | Agent identity tokens minted/verified with the contract claim set; no self-reported identity | `packages/framework-core/src/__tests__/identity-contract.test.ts`, `minion-token.test.ts` |
| **Effect gateway** (`effects/v1`) | Agents draft side effects; only the gateway commits them, gated on verification evidence + approval class; irreversible effects refuse agent actors | `extensions/mcp-toolshed/src/__tests__/effect-gateway.test.ts` |
| **Work-item queue ingress** | Typed `WorkItem` envelopes consumed from Service Bus with idempotent redelivery and reason-coded dead-lettering | `extensions/queue-ingress/__tests__/*.test.ts` |
| **Item pipelines** | Declarative classify→act→verify→commit/escalate chains with per-item verification | `extensions/queue-ingress/__tests__/item-pipeline.test.ts`, `test/src/e2e-item-pipeline.test.ts` |
| **Cost control** (`budget/v1`) | Hard per-item `max_cost_usd` (item halts, never the queue) and a per-UTC-day budget that pauses consumption | `extensions/queue-ingress/__tests__/cost-control.test.ts` |
| **Multi-replica governance state** | Rate-limit and breaker state shared across replicas (ADR-026 supersedes ADR-025) | `extensions/mcp-toolshed/src/__tests__/shared-governance-state.test.ts` |
| **Sampling QA loop** | Post-hoc human review of auto-commits turns a disagreement rate into an auto-commit circuit breaker per effect type | `extensions/mcp-toolshed/src/__tests__/sampling-qa.test.ts` |
| **Escalation bridge** (`escalation/v1`) | A failing item escalates into a signed envelope, runs in Flow, and closes on a signed resolution under one correlation id | `extensions/queue-ingress/__tests__/escalation.test.ts`, `test/src/bridge-e2e.test.ts` |
| **1000-item soak** | At-most-once commits and complete dead-letter accounting over a seeded duplicate/poison run | `extensions/queue-ingress/soak/soak.test.ts` (`pnpm --filter ./extensions/queue-ingress test:soak`) |

The full design and milestone history live in
[`forge-ops.execplan.md`](https://github.com/dr-pabs/forge-contracts/blob/main/forge-ops.execplan.md)
in the contracts repository.

---

## Summary Matrix

| Category | What Goose Provides | What We Add | What We Don't Use |
|---|---|---|---|
| **Agent execution** | `delegate`, `load(taskId)`, sessions, turn limits, context isolation | Multi-agent orchestration, DAG scheduling, retry, dead-letter | — |
| **Tool access** | MCP tool spec, extension tool registration | Allowlist enforcement, rate limiting, audit logging, three-layer capture | Dynamic extension enable/disable |
| **File & code** | `shell`, `edit`, `write`, `tree`, `analyze`, `rg` | Command allowlists per minion, workspace boundaries | `computercontroller` |
| **AI inference** | LLM conversation loop | Model routing by configurable tier (fast, reasoning, code_review, code_generation, security) | — |
| **Memory** | `chatrecall` (conversation search) | Correlation ID propagation, session SQLite store | `memory` (preference learning) |
| **Scheduling** | `platform__manage_schedule` (cron) | Recipe definitions (daily PR review, ticket polling, security scans) | — |
| **Chat ingress** | — | Slack Bolt + Microsoft 365 Agent SDK adapters; webhook ingress (GitHub/ADO events) | — |
| **Queue ingress (Stream)** | — | `queue-ingress`: single Service Bus work queue, consumer-side idempotency, reason-coded DLQ, KEDA scale target (ADR-027) | — |
| **Effect gateway** | — | In-process `effect_gateway` in the toolshed: draft/commit/discard with evidence gate + approval classes (ADR-028) | — |
| **Cost control** | — | `budget/v1` enforcement: per-item cap halts the item (`BUDGET_EXCEEDED`), daily cap pauses the queue (ADR-031) | — |
| **Observability** | — | MCP proxy logging, Table Storage, Log Analytics, Grafana, custom dashboard | `autovisualiser` |
| **Security** | — | Tool allowlisting, rate limiting, human-in-the-loop, content safety (AI Foundry), managed identity, private endpoints | — |
| **Config & prompts** | Extension manifests (YAML) | Git-versioned prompts, governance configs, CI/CD deployment | Resources system, `load_skill` |

### The Goose Boundary

```
┌─────────────────────────────────────────────────────────┐
│                 GOOSE AGENT HARNESS                      │
│                                                          │
│  ✅ delegate (async sub-agents)                          │
│  ✅ load(taskId) (result collection)                     │
│  ✅ Extensions (packaging, tool registration)            │
│  ✅ Sessions (conversation state)                        │
│  ✅ MCP tool spec (tool exposure)                        │
│  ✅ shell, edit, write, tree, analyze, rg (dev tools)   │
│  ✅ chatrecall (conversation memory)                     │
│  ✅ platform__manage_schedule (cron)                     │
│  ✅ apps__create_app (dashboard scaffolding)             │
│                                                          │
│  ❌ extensionmanager (dynamic enable/disable)            │
│  ❌ load_skill (dynamic prompt loading)                  │
│  ❌ memory (preference learning)                         │
│  ❌ computercontroller (UI automation)                   │
│  ❌ autovisualiser (data viz)                            │
│  ❌ tutorial (interactive guides)                        │
│  ❌ summon, tom (niche extensions)                       │
│  ❌ code_execution (indirection layer)                   │
└─────────────────────────────────────────────────────────┘
                         │
                         │  We build on top:
                         ▼
┌─────────────────────────────────────────────────────────┐
│              MINIONS AGENT FRAMEWORK                     │
│                                                          │
│  🏗️  orchestrator (intent, DAG, lifecycle, gating)       │
│  🏗️  mcp-toolshed (allowlists, rate limiting, logging,   │
│      effect gateway + sampling QA — ADR-028/032)         │
│  🏗️  slack-bot (Slack ingress/egress)                    │
│  🏗️  teams-bot (Teams ingress/egress)                    │
│  🏗️  webhook-ingress (GitHub/ADO event ingress)          │
│  🏗️  queue-ingress (Service Bus work items, ADR-027)     │
│  🏗️  agent-dashboard (session replay, correlation tree)  │
│  🏗️  Minion prompts (7 specialized system prompts)       │
│  🏗️  SQLite session store + schema                       │
│  🏗️  Azure Table (ToolCallLog + shared GovernanceState,  │
│      ADR-026) + Blob + Service Bus + Grafana             │
│  🏗️  Correlation ID propagation                          │
│  🏗️  Governance config + CI/CD                           │
└─────────────────────────────────────────────────────────┘
```

Goose provides the **agent runtime** — the loop, the tools, the sub-agent spawning. The framework provides everything else: multi-agent orchestration, security, observability, platform integration, and governance.
