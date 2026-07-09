# Goose Agent Framework — High-Level Design

> **Status:** Revised Draft  
> **Date:** 2026-06-05  
> **Author:** Goose (AAIF)

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Layer 1: Entry Points](#layer-1-entry-points)
4. [Layer 2: Orchestrator](#layer-2-orchestrator)
5. [Layer 3: Minion Pool](#layer-3-minion-pool)
6. [Layer 4: MCP Toolshed](#layer-4-mcp-toolshed)
7. [Storage Architecture](#storage-architecture)
8. [Tool Call Capture](#tool-call-capture)
9. [Technical Architecture](#technical-architecture)
10. [GitHub's Role](#githubs-role)
11. [Data Flows](#data-flows)
12. [Implementation Roadmap](#implementation-roadmap)
13. [Key Design Decisions](#key-design-decisions)
14. [Security & Governance](#security--governance)
15. [Observability](#observability)
16. [Architecture Decision Records](#architecture-decision-records)
17. [Appendix: Extension Manifests](#appendix-extension-manifests)

---

## Overview

The Goose Agent Framework extends the core Goose platform into a **multi-agent orchestration system** where specialized sub-agents ("minions") collaborate to perform complex tasks across large codebases. The system ingests work from chat platforms (Slack, Microsoft Teams), ticket systems (ServiceNow, Jira, Azure DevOps), and scheduled triggers, then decomposes, delegates, and synthesizes results back to the user.

### Capabilities

| Capability | Description |
|---|---|
| **Multi-agent delegation** | Spawn focused minions for code exploration, review, PR creation, ticket analysis, and security auditing |
| **MCP toolshed** | Shared pool of Model Context Protocol servers providing GitHub, Azure DevOps, ServiceNow, Jira, Slack, Teams, and filesystem tools |
| **Chat-platform ingestion** | Receive natural-language instructions from Slack and Microsoft Teams (both are Phase 1 priorities) |
| **Ticket-system integration** | Read, query, and act on tickets from ServiceNow, Jira, and Azure DevOps work items |
| **Code review** | Automated diff analysis with structured feedback on bugs, style, performance, and security |
| **PR automation** | Branch creation, code changes, commit, and pull-request opening in GitHub and Azure DevOps |
| **Scheduled execution** | Cron-driven recurring jobs (e.g., daily PR review, ticket polling) |
| **Immutable audit trail** | Every tool call captured, correlated, and queryable via Azure Table Storage and Log Analytics |
| **Low-cost durable storage** | SQLite + Azure Table Storage + Azure Blob — ~$2-5/month at moderate scale |

---

## Architecture

### Logical Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          ENTRY POINTS                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────────────┐ │
│  │  Slack   │  │  Teams   │  │  Web UI  │  │  Scheduled / Cron        │ │
│  │  Bot     │  │  Bot     │  │  (opt.)  │  │                          │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────────┬──────────────┘ │
└───────┼──────────────┼─────────────┼───────────────────┼─────────────────┘
        │              │             │                   │
        ▼              ▼             ▼                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                     ORCHESTRATION LAYER                                    │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                    Goose Orchestrator                               │  │
│  │  • Intent classification & routing                                  │  │
│  │  • Task decomposition (DAG-based)                                   │  │
│  │  • Minion lifecycle (spawn / monitor / collect / terminate)         │  │
│  │  • Correlation ID propagation (root → minion → tool call)           │  │
│  │  • Shared memory & state coordination                               │  │
│  │  • Human-in-the-loop gating                                         │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                      MINION POOL (Specialized Agents)                     │
│                                                                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ Code     │ │ Code     │ │ Ticket   │ │ PR       │ │ Security     │  │
│  │ Explorer │ │ Reviewer │ │ Analyst  │ │ Crafter  │ │ Auditor      │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘  │
└───────┼──────────────┼─────────────┼─────────────┼─────────────┼─────────┘
        │              │             │             │             │
        ▼              ▼             ▼             ▼             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                       MCP TOOLSHED (Shared)                               │
│                                                                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ GitHub   │ │ Azure    │ │ServiceNow│ │  Jira    │ │  Filesystem  │  │
│  │ MCP      │ │ DevOps   │ │ MCP      │ │ MCP      │ │  MCP         │  │
│  │          │ │ MCP      │ │          │ │          │ │              │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│  │  Slack   │ │  Teams   │ │   Git    │ │  Shell   │ │  Custom      │  │
│  │  MCP     │ │  MCP     │ │  MCP     │ │  MCP     │ │  (pluggable) │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

### Principles

1. **Stateless minions, stateful orchestrator** — Minions are disposable delegates; the orchestrator holds the conversation thread and aggregates results.
2. **Tool allowlisting per minion** — Each minion receives only the MCP tools it needs, enforcing least privilege.
3. **Async parallelism** — Independent sub-tasks run concurrently via Goose's `delegate` with `async: true`.
4. **Human-in-the-loop** — Destructive actions (merge, deploy) require explicit confirmation.
5. **Extensible by extension** — Every component is a Goose extension; new minions, tools, and entry points can be added without modifying the core.
6. **Correlated observability** — Every action carries a root correlation ID: Session → Minion → Tool Call.
7. **Cheap by default** — Storage architecture starts at ~$2/month; scales linearly with usage. No Cosmos DB dependency.

---

## Layer 1: Entry Points

### Slack Bot

- **Type:** Goose extension (`slack-bot`)
- **Phase:** 1
- **SDK:** Slack Bolt (Python or Node.js)
- **Mechanism:** Listens for `@minions` mentions in channels or DMs
- **Flow:**
  1. Receive message event
  2. Post "thinking..." reaction
  3. Forward raw text + channel/user context to Orchestrator
  4. Receive structured response (summary + optional attachments)
  5. Post threaded reply with results
- **Security:** Slack signing secret verification; channel allowlist

### Microsoft Teams Bot

- **Type:** Goose extension (`teams-bot`)
- **Phase:** 1 (peer priority with Slack)
- **SDK:** Microsoft 365 Agent SDK (successor to the deprecated Bot Framework SDK)
- **Mechanism:** Listens for `@minions` mentions in channels, group chats, and personal chats
- **Flow:**
  1. Receive message activity from Microsoft 365 Agent SDK
  2. Post "typing" indicator
  3. Forward raw text + teams/channel/user context to Orchestrator
  4. Receive structured response
  5. Post Adaptive Card with rich results (links, code snippets, action buttons)
- **Security:**
  - Azure AD app registration with delegated permissions (Microsoft Entra ID)
  - Team/channel allowlist
  - Managed identity for Azure service authentication (no static App ID + password)
  - Built-in token management via the SDK
- **Additional capabilities (beyond Slack):**
  - Adaptive Cards with actionable buttons ("Approve", "Request Changes")
  - Deep links to Azure DevOps work items
  - Message extensions for search-based commands
  - Meeting integration (add Goose to a meeting, ask it to summarize)

### Web Dashboard (Optional)

- **Type:** Goose extension (`agent-dashboard`) or standalone React app
- **Phase:** 4
- **Views:**
  - Active minions and their status
  - Task queue / history with correlation IDs
  - Tool call log (queryable)
  - Configuration (MCP servers, minion allowlists, governance)

### Scheduled Triggers

- **Type:** Goose built-in (`platform__manage_schedule`)
- **Phase:** 4
- **Examples:**
  - `0 8 * * 1-5` — Review all open PRs each weekday morning
  - `*/30 * * * *` — Poll ServiceNow for new critical incidents
  - `0 7 * * 1` — Weekly codebase health report (security scan + dependency audit)

---

## Layer 2: Orchestrator

The orchestrator is a Goose extension (`orchestrator`) that acts as the central nervous system.

### Intent Classification

Uses a lightweight LLM call (or pattern matching for common commands) to classify user intent and select the appropriate minion(s).

| User Input Example | Intent | Minion(s) Dispatched |
|---|---|---|
| "Review PR #342" | `code_review` | Code Reviewer |
| "What's the status of INC00421?" | `ticket_lookup` | Ticket Analyst |
| "Find the source of the login timeout" | `code_explore` | Code Explorer |
| "Create a PR to fix bug AB#1234" | `pr_create` | PR Crafter |
| "Is this SQL query vulnerable?" | `security_audit` | Security Auditor |
| "Fix work item #567 and create a PR" | `ticket→fix→pr` | Ticket Analyst → Code Explorer → PR Crafter → Code Reviewer |
| "Summarize all open Sev-1 incidents" | `ticket_summary` | Ticket Analyst |
| "Review PR #342 and #343" | `code_review_batch` | Code Reviewer (parallel instances) |

### Task Decomposition

Complex intents (e.g., `ticket→fix→pr`) are decomposed into a **DAG of sub-tasks**:

```
                    ┌──────────────┐
                    │ Ticket Query  │
                    │ (ServiceNow   │
                    │  or ADO)      │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │Ticket    │ │Code      │ │Related   │
        │Detail    │ │Explorer  │ │PRs/Issues│
        └────┬─────┘ └────┬─────┘ └────┬─────┘
             │            │            │
             └────────────┼────────────┘
                          │ (synthesize context)
                          ▼
                   ┌──────────────┐
                   │  PR Crafter  │
                   │ (GitHub or   │
                   │  Azure DevOps)│
                   └──────┬───────┘
                          │
                          ▼
                   ┌──────────────┐
                   │ Code Reviewer│
                   └──────────────┘
```

- Independent branches run in **parallel** via `delegate(async: true)`
- Dependent steps wait for upstream results via `load(taskId)`
- Each branch gets a sub-correlation ID derived from the root

### Minion Lifecycle Management

```
                     ┌─────────┐
                     │  IDLE   │
                     └────┬────┘
                          │ orchestrator.spawn(config)
                          ▼
                     ┌─────────┐
              ┌──────│ RUNNING │──────┐
              │      └────┬────┘      │
              │           │           │
              ▼           ▼           ▼
        ┌─────────┐ ┌─────────┐ ┌─────────┐
        │COMPLETED│ │ FAILED  │ │TIMED OUT│
        └────┬────┘ └────┬────┘ └────┬────┘
             │           │           │
             ▼           ▼           ▼
        result      retry/       retry/
        collected   escalate     escalate
```

- **Spawn:** `delegate(instructions, extensions, max_turns, async: true)`
- **Monitor:** Periodic `load(taskId)` with configurable polling interval
- **Timeout:** Configurable per minion type (e.g., Code Explorer: 5 min, PR Crafter: 15 min)
- **Retry:** Max 3 attempts with exponential backoff; escalate to human on terminal failure

### Correlation & Traceability

Every orchestration session generates a **root correlation ID** (`corr_<uuid>`). This propagates through:

```
Session: corr_a1b2c3
├── Minion: ticket-analyst      → corr_a1b2c3.1
│   ├── servicenow.query_incidents  (42ms ✓)
│   └── ado.search_work_items       (90ms ✓)
├── Minion: code-explorer       → corr_a1b2c3.2
│   ├── filesystem.list_directory    (5ms ✓)
│   ├── analyze.codebase            (1100ms ✓)
│   └── rg.search                   (300ms ✓)
└── Minion: pr-crafter          → corr_a1b2c3.3
    ├── git.create_branch           (80ms ✓)
    ├── filesystem.write_file        (12ms ✓)
    ├── shell.run_command           (4500ms ✓)
    ├── git.commit                  (150ms ✓)
    └── {github|ado}.create_pr      (600ms ✓)
```

The correlation tree is written to Azure Table Storage and streamed to Log Analytics, enabling reconstruction of any session's full execution trace.

### Future: Recursive Orchestration (V2)

In V1, the orchestrator is a flat manager — one session, one DAG of minions. This handles single tasks and cron-driven batch workloads well. But a user asking *"Fix all 50 open P1 bugs"* would push the flat model to its limit: 50 × 4 = 200 minion lifecycle slots managed by one orchestrator, one enormous correlation tree, and one giant result merge.

**Recursive orchestration** means the root orchestrator spawns **sub-orchestrators** — delegates that are themselves orchestrators. Each sub-orchestrator manages its own scoped task independently:

```
User: "Fix all 50 open P1 bugs across the Platform project"
       │
Root Orchestrator
   │
   ├── Sub-Orchestrator: "Fix bug #1"  (corr_x.1)
   │   ├── Ticket Analyst → Code Explorer → PR Crafter → Reviewer
   │   └── Reports summary: "✅ PR #892 — auth timeout fix"
   │
   ├── Sub-Orchestrator: "Fix bug #2"  (corr_x.2)
   │   └── Reports summary: "✅ PR #893 — payment retry loop"
   │
   ├── Sub-Orchestrator: "Fix bug #3"  (corr_x.3)
   │   └── Reports summary: "⚠️ Partial — only 2 of 3 files found"
   │
   └── ... 47 more ...
   
   Root collects 50 summaries → posts digest to Slack/Teams
```

The root doesn't manage individual minions — it manages sub-orchestrators, each of which manages its own minions. Correlation IDs become hierarchical (`corr_x.1.1`, `corr_x.1.2`), session data is naturally partitioned, and error handling scales: 3 of 50 failures produce partial results, not a single indecipherable error.

**Why it's deferred to V2:**

| Reason | Detail |
|---|---|
| **V1 tasks are single-intent** | Users ask "Fix this bug" or "Review this PR," not "Fix 50 bugs." Batch workloads use cron + parallel minions, which already covers the common case. |
| **Adds real complexity** | Nested timeout budgets, cross-sub-orchestrator deduplication, approval fan-out, recursive depth limits — each is a design session and a set of test cases that would delay V1. |
| **The architecture supports it natively** | Goose's `delegate` can spawn an orchestrator just as easily as a minion. Adding recursion in V2 is a configuration change — not a re-architecture. |
| **Production data should guide it** | Until we see real throughput, pipeline depth, and bottleneck data from Grafana, designing recursion is speculation. V1's dashboards will tell us exactly where the flat model strains. |

V1 handles batch workloads through **cron + parallel minions**: the daily PR review spawns 6 parallel Code Reviewers, the weekly security scan spawns 5 parallel Auditors — all flat, all managed by the root orchestrator. This works at V1 scale and produces the same digests. When production data shows the flat model straining (queue depth growing, session latency spiking), recursive orchestration is the V2 answer — and it slots into the existing architecture without rebuilding anything.

---

## Layer 3: Minion Pool

Each minion is a Goose `delegate` with:
- A **specialized system prompt** defining its role, boundaries, and output format
- A **curated tool allowlist** restricting which MCP tools it can call
- **Output schema** — structured JSON the orchestrator can parse and merge
- **Target platform awareness** — knows whether it's operating on GitHub or Azure DevOps

### Minion Definitions

---

#### 1. Code Explorer

| Attribute | Value |
|---|---|
| **Purpose** | Navigate large codebases, trace call graphs, find definitions and usage |
| **Triggers** | "Find where X is implemented", "How does Y work?", "Trace the flow of Z" |
| **System Prompt Focus** | "You are a code exploration agent. Use tree-sitter analysis, grep, and file reading to map code structure. Return structured findings: file paths, function signatures, call chains. Do NOT modify code." |
| **Tool Allowlist** | `analyze` (tree-sitter), `rg` (grep), `tree`, `shell` (read-only commands), Filesystem MCP, Git MCP (log/blame only), GitHub MCP (code search, get file), Azure DevOps MCP (repo search, get file) |
| **Output Schema** | `{ files: [...], symbols: [...], call_graph: {...}, summary: "..." }` |
| **Max Turns** | 15 |
| **Timeout** | 5 minutes |

---

#### 2. Code Reviewer

| Attribute | Value |
|---|---|
| **Purpose** | Review code diffs for bugs, style violations, performance issues, and security concerns |
| **Triggers** | "Review PR #N", "Review this diff", post-PR-creation review (both GitHub and Azure DevOps PRs) |
| **System Prompt Focus** | "You are a senior code reviewer. Analyze diffs systematically: correctness, readability, performance, security, test coverage. Produce a structured review with severity levels (blocker/major/minor/nit). Be constructive and specific. Work with both GitHub and Azure DevOps pull requests." |
| **Tool Allowlist** | GitHub MCP (PR diff, PR comments), Azure DevOps MCP (PR diff, PR comments), Filesystem MCP (read-only), `rg`, `shell` (lint/test runners) |
| **Output Schema** | `{ findings: [{file, line, severity, category, message, suggestion}], summary: "...", approved: bool }` |
| **Max Turns** | 20 |
| **Timeout** | 10 minutes |

---

#### 3. PR Crafter

| Attribute | Value |
|---|---|
| **Purpose** | Create branches, implement changes, commit, and open pull requests in GitHub or Azure DevOps |
| **Triggers** | "Create a PR for...", "Fix work item AB#1234 and open a PR", downstream from Ticket Analyst |
| **System Prompt Focus** | "You are a PR author. Given a problem description and code context, implement the fix, write tests, create a branch, commit with a meaningful message, and open a PR. Follow the repo's CONTRIBUTING.md. Link the PR to the relevant ticket/work item. Support GitHub and Azure DevOps repos." |
| **Tool Allowlist** | GitHub MCP (branches, commits, PRs), Azure DevOps MCP (branches, commits, PRs), Filesystem MCP (read/write), Git MCP, Shell MCP (build/test) |
| **Output Schema** | `{ pr_url: "...", platform: "github|ado", branch: "...", commits: [...], files_changed: [...], linked_work_items: [...], summary: "..." }` |
| **Max Turns** | 30 |
| **Timeout** | 15 minutes |

---

#### 4. Ticket Analyst

| Attribute | Value |
|---|---|
| **Purpose** | Query ticket systems (ServiceNow, Jira, Azure DevOps), summarize issues, link tickets to code and PRs |
| **Triggers** | "What's the status of X?", "Summarize open critical tickets", "Find tickets related to Y" |
| **System Prompt Focus** | "You are a support ticket analyst. Query ServiceNow, Jira, and Azure DevOps for ticket/work item details, history, and related items. Summarize findings clearly, cross-reference with GitHub/ADO issues/PRs when possible. Never modify tickets without explicit approval." |
| **Tool Allowlist** | ServiceNow MCP (read-only), Jira MCP (read-only), Azure DevOps MCP (work items, queries), GitHub MCP (issue/PR search) |
| **Output Schema** | `{ tickets: [{source, id, title, status, priority, assignee, summary, related_prs}], summary: "..." }` |
| **Max Turns** | 10 |
| **Timeout** | 5 minutes |

---

#### 5. Security Auditor

| Attribute | Value |
|---|---|
| **Purpose** | Scan code for vulnerabilities, review dependencies, assess security posture |
| **Triggers** | "Is this safe?", "Audit auth module", "Check dependencies for CVEs" |
| **System Prompt Focus** | "You are a security auditor. Scan code for OWASP Top 10 vulnerabilities, check dependencies against CVE databases, review authentication/authorization patterns. Report findings with CVSS severity where applicable. Check both GitHub Advisory DB and Azure DevOps security alerts." |
| **Tool Allowlist** | Filesystem MCP (read-only), Shell MCP (scanners: bandit, npm audit, trivy, gitleaks), GitHub MCP (advisories, dependabot), Azure DevOps MCP (advanced security alerts) |
| **Output Schema** | `{ vulnerabilities: [{file, line, cwe, severity, description, remediation}], dependency_issues: [...], summary: "..." }` |
| **Max Turns** | 20 |
| **Timeout** | 10 minutes |

---

## Layer 4: MCP Toolshed

The toolshed is a Goose extension (`mcp-toolshed`) that manages connections to multiple MCP servers and exposes their tools to minions via allowlists. It is also the **sole interception point** for all tool calls — every call passes through the toolshed for logging, allowlist enforcement, and rate limiting.

### Architecture

```
┌─────────────────────────────────────────┐
│           mcp-toolshed extension         │
│                                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │ MCP      │ │ Allowlist│ │ Tool Call│ │
│  │ Registry │ │ Manager  │ │ Logger   │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ │
│       │            │            │        │
│  ┌────┴────────────┴────────────┴─────┐  │
│  │      MCP Connection Pool            │  │
│  │  (stdio / SSE / WebSocket clients)  │  │
│  └──────────┬──────────────────────────┘  │
│             │                              │
│    ┌────────┴────────┐                     │
│    │  Rate Limiter   │                     │
│    │  (per-server,   │                     │
│    │   per-minion)   │                     │
│    └─────────────────┘                     │
└─────────────────────────────────────────┘
         │
         ▼
   Azure Table Storage ← tool call log
   Azure Log Analytics ← real-time stream
```

### MCP Server Catalog

| Server | Protocol | Key Tools | Authentication | Phase |
|---|---|---|---|---|
| **GitHub** | HTTP/SSE | `search_code`, `get_pr`, `create_pr`, `create_pr_review`, `get_issue`, `create_branch`, `commit_changes`, `get_vulnerability_alerts` | GitHub App token or PAT | 1 |
| **Azure DevOps** | HTTP/SSE | `search_work_items`, `get_work_item`, `create_work_item`, `update_work_item`, `get_pr`, `create_pr`, `get_pr_diff`, `create_pr_review`, `get_build`, `queue_build`, `get_release`, `search_repos`, `search_wiki`, `run_query` (WIQL) | Azure AD App Token or PAT | 1 |
| **ServiceNow** | HTTP/SSE | `query_incidents`, `get_incident`, `query_changes`, `get_change`, `update_ticket`, `assign_ticket` | OAuth 2.0 or Basic Auth | 3 |
| **Jira** | HTTP/SSE | `search_issues`, `get_issue`, `create_issue`, `transition_issue`, `get_sprint`, `search_boards` | API Token | 3 |
| **Slack** | HTTP/SSE / Socket Mode | `post_message`, `get_channel_history`, `get_user_info`, `add_reaction`, `upload_file` | Bot Token (OAuth) | 1 |
| **Microsoft Teams** | HTTP/SSE | `send_message`, `send_adaptive_card`, `get_channel`, `list_teams`, `get_thread`, `create_meeting` | Azure AD App Token | 1 |
| **Filesystem** | stdio | `read_file`, `write_file`, `list_directory`, `search_files`, `get_file_info` | Local OS permissions | 1 |
| **Git** | stdio | `status`, `diff`, `log`, `branch`, `checkout`, `commit`, `push`, `pull` | SSH key or PAT | 1 |
| **Shell** | stdio | `run_command` (sandboxed, allowlist of commands) | OS user permissions | 1 |
| **Docker** | stdio/HTTP | `build_image`, `run_container`, `list_containers`, `push_image` | Docker socket | 4 |
| **Custom** | Pluggable | Domain-specific tools (deployment, feature flags, monitoring) | Configurable | 4 |

### Allowlist Model

Each minion's tool access is defined in its extension manifest:

```yaml
minions:
  code-reviewer:
    tools:
      github:
        allow: [get_pr, get_pr_diff, create_pr_review, create_pr_review_comment]
      azure_devops:
        allow: [get_pr, get_pr_diff, create_pr_review]
      filesystem:
        allow: [read_file, list_directory, search_files]
      git:
        allow: [diff, log, show]
      shell:
        allow: [run_command]
        command_allowlist: [eslint, pylint, shellcheck, "go vet", "cargo clippy"]
    # No access to: servicenow, jira, slack, teams, docker
```

---

## Storage Architecture

The storage strategy uses **three purpose-built stores**, rejecting the expensive Cosmos DB path in favor of a tiered model costing ~$2-5/month at moderate scale.

### Store Selection

```
┌─────────────────────────────────────────────────────────┐
│                  Goose Agent Framework                    │
│                                                           │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────┐  │
│  │  Session     │   │  Tool Call   │   │  Minion      │  │
│  │  State       │   │  Log         │   │  Outputs     │  │
│  │  (hot)       │   │  (append)    │   │  (large)     │  │
│  └──────┬──────┘   └──────┬───────┘   └──────┬───────┘  │
│         │                 │                   │          │
│         ▼                 ▼                   ▼          │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────┐  │
│  │   SQLite    │   │ Azure Table  │   │  Azure Blob  │  │
│  │   (local)   │   │ Storage      │   │  Storage     │  │
│  │   ~$0/mo    │   │ ~$1.50/mo    │   │ ~$0.50/mo   │  │
│  └─────────────┘   └──────────────┘   └──────────────┘  │
│                                                           │
│  Estimated total storage cost: ~$2–$5/month               │
└─────────────────────────────────────────────────────────┘

Plus Azure Monitor / Log Analytics for search, dashboards, and alerting:
  - All tool calls ALSO stream to Log Analytics
  - KQL querying, dashboards, alert rules
  - Log Analytics: ~$2.30/GB ingested, 31-day free retention on Basic
```

### SQLite — Session State

| Aspect | Detail |
|---|---|
| **Purpose** | Hot session state — active conversations, in-flight minions, pending approvals |
| **Location** | Local to the toolshed container, on a mounted Azure Files share (`extensions/mcp-toolshed/src/store.ts`); the orchestrator's own conversation/session bookkeeping is a separate concern from the toolshed's governance state |
| **Schema** | Sessions, minion_runs, pending_approvals; rate limiter and circuit breaker state are in-process (`Map`-backed, not persisted to SQLite — see `rate-limiter.ts`/`circuit-breaker.ts`) |
| **Backup** | Periodic WAL snapshots to Azure Blob (cool tier) |
| **Cost** | $0 (embedded, no Azure resource) |
| **Limitation** | **Not shared across replicas, and the toolshed/bots/dashboard are pinned to a single replica because of it (ADR-025)** — pending approvals, the rate limiter's token buckets, and circuit breaker state are process-local with no cross-replica coordination, so unlike the orchestrator (which scales via Service Bus session affinity, ADR-004/ADR-012) there is no session-affinity trick that makes multiple toolshed replicas safe. See ADR-025 for the trigger condition and the deferred Redis/Table-Storage-lease alternatives. |

### Azure Table Storage — Tool Call Log

| Aspect | Detail |
|---|---|
| **Purpose** | Immutable, append-only log of every tool call with correlation IDs |
| **Partition Key** | `{session_correlation_id}` |
| **Row Key** | `{timestamp_tick}_{minion_id}_{tool_name}` |
| **Columns** | `minion_type`, `mcp_server`, `tool_name`, `parameters` (JSON), `result_summary`, `latency_ms`, `success` (bool), `error_message` |
| **Query Pattern** | "Show all tool calls for session X" or "Show all calls in last hour" (via Log Analytics, not Table Storage directly) |
| **Cost** | ~$1.50/month at 1M operations (storage: $0.045/GB, transactions: ~$0.0036 per 100K) |
| **Retention** | Configurable TTL (e.g., 90 days); older records archived to Blob (archive tier) |

### Azure Blob Storage — Minion Outputs & Artifacts

| Aspect | Detail |
|---|---|
| **Purpose** | Large artifacts: full minion outputs, diffs, attachments, conversation transcripts |
| **Structure** | `{container}/sessions/{correlation_id}/{minion_id}/output.json` |
| **Tier** | Cool tier (~$0.018/GB/month) for active; Archive tier (~$0.002/GB/month) for >90 days |
| **Cost** | ~$0.50/month for typical usage |

### SQLite Schema (Durable Tables)

```sql
-- Core session tracking
CREATE TABLE sessions (
    id              TEXT PRIMARY KEY,    -- corr_uuid
    channel         TEXT NOT NULL,       -- slack | teams | cron | web
    channel_id      TEXT,                -- Slack channel / Teams team+channel
    user_id         TEXT,                -- Slack user / Teams AAD object ID
    user_name       TEXT,
    intent          TEXT NOT NULL,
    raw_message     TEXT,
    status          TEXT DEFAULT 'active', -- active | completed | failed | cancelled
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at    TEXT
);

-- Individual minion invocations
CREATE TABLE minion_runs (
    id              TEXT PRIMARY KEY,    -- correlation_id.sub_id
    session_id      TEXT NOT NULL REFERENCES sessions(id),
    minion_type     TEXT NOT NULL,       -- code-explorer | code-reviewer | pr-crafter | ticket-analyst | security-auditor
    parent_run_id   TEXT,                -- for DAG dependency tracking
    instructions    TEXT NOT NULL,
    status          TEXT DEFAULT 'pending', -- pending | running | completed | failed | timed_out
    attempt         INTEGER DEFAULT 1,
    started_at      TEXT,
    completed_at    TEXT,
    turns_used      INTEGER,
    tokens_used     INTEGER,
    output_json     TEXT,                -- structured output from the minion
    error_message   TEXT
);

-- Pending human approval gates
CREATE TABLE pending_approvals (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES sessions(id),
    minion_run_id   TEXT NOT NULL REFERENCES minion_runs(id),
    action          TEXT NOT NULL,       -- github.merge_pr | ado.complete_pr | servicenow.close_incident
    target_url      TEXT NOT NULL,
    requested_at    TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at     TEXT,
    decision        TEXT                 -- approved | denied | timed_out
);

-- Rate limit tracking (ephemeral, can be in-memory + periodically flushed)
CREATE TABLE rate_limit_buckets (
    mcp_server      TEXT NOT NULL,
    minion_type     TEXT NOT NULL,
    window_start    TEXT NOT NULL,
    call_count      INTEGER DEFAULT 0,
    PRIMARY KEY (mcp_server, minion_type, window_start)
);
```

---

## Tool Call Capture

Every tool invocation flows through three layers of capture, each serving a distinct purpose.

### Layer A: Goose-Native (Automatic)

Goose's delegate/session infrastructure already tracks tool calls internally. The `chatrecall` extension surfaces session summaries. We extend this with a **structured export** that flattens tool calls into the Azure Table Storage schema.

**Captures:** Tool name, parameters, results, and timing at the delegate level.  
**Purpose:** Session reconstruction, debugging.

### Layer B: MCP Toolshed Proxy (Primary)

The `mcp-toolshed` extension is the **mandatory intermediary** between every minion and every MCP server. Every call passes through:

```
Minion → mcp-toolshed → [log] → [allowlist check] → [rate limit check] → MCP Server
```

**Before-call log (synchronous):**
- Timestamp (UTC)
- Correlation ID (minion run)
- MCP server name
- Tool name
- Parameters (JSON, truncated at 4KB)
- Minion type

**After-call log (synchronous):**
- Result summary (first 1KB)
- Status (success / error / blocked)
- Latency in milliseconds
- Error details if failed

**Blocked-call log (security event):**
- If allowlist rejected: logged as a **security event**, no call made
- If rate limit hit: logged as a **throttle event**, HTTP 429 returned to minion

All logs write to:
1. **Azure Table Storage** — durable, queryable by correlation ID
2. **stdout (structured JSON)** — picked up by Container Insights → Log Analytics for real-time KQL querying

### Layer C: MCP Server Side (Optional)

Each MCP server can independently emit its own usage/audit logs. This is optional because the toolshed already captures everything, but it provides defense-in-depth for:
- **GitHub:** Audit log events for API access
- **Azure DevOps:** Activity log for PAT / service principal usage
- **ServiceNow:** System log for REST API calls

### Correlation Model

Every orchestration carries a root correlation ID through the entire call tree:

```
corr_a1b2c3                              ← Root (session)
├── corr_a1b2c3.1                        ← Minion 1 (ticket-analyst)
│   ├── corr_a1b2c3.1.sn-001             ← Tool call: servicenow.query_incidents
│   └── corr_a1b2c3.1.ado-001            ← Tool call: ado.search_work_items
├── corr_a1b2c3.2                        ← Minion 2 (code-explorer)
│   ├── corr_a1b2c3.2.fs-001             ← Tool call: filesystem.list_directory
│   ├── corr_a1b2c3.2.az-001             ← Tool call: analyze.codebase
│   └── corr_a1b2c3.2.rg-001             ← Tool call: rg.search
└── corr_a1b2c3.3                        ← Minion 3 (pr-crafter)
    ├── corr_a1b2c3.3.git-001            ← Tool call: git.create_branch
    ├── corr_a1b2c3.3.fs-001             ← Tool call: filesystem.write_file
    ├── corr_a1b2c3.3.sh-001             ← Tool call: shell.run_command
    ├── corr_a1b2c3.3.git-002            ← Tool call: git.commit
    └── corr_a1b2c3.3.gh-001             ← Tool call: github.create_pr
```

### Querying the Audit Trail (via Log Analytics / KQL)

```kql
// All tool calls for a specific correlation ID
AppTraces
| where Properties.correlation_id startswith "corr_a1b2c3"
| project timestamp, Properties.minion_type, Properties.tool_name, 
          Properties.latency_ms, Properties.success
| order by timestamp asc

// Failed tool calls in the last hour
AppTraces
| where timestamp > ago(1h)
| where Properties.success == false
| summarize count() by Properties.tool_name, Properties.error_message

// Slowest tool calls today
AppTraces
| where timestamp > ago(1d)
| where Properties.latency_ms > 1000
| project timestamp, Properties.correlation_id, Properties.tool_name, 
          Properties.latency_ms
| order by Properties.latency_ms desc
| take 20
```

---

## Technical Architecture

The framework runs on **Azure AI Foundry** for AI inference and **Azure Container Apps** for compute, with a low-cost storage tier.

### Deployment Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                      Azure AI Foundry                                 │
│                                                                       │
│  ┌─────────────────────┐    ┌──────────────────────────────────────┐ │
│  │   AI Hub / Project   │    │        Model Catalog                 │ │
│  │   • RBAC + networking│    │  • fast tier (classification)        │ │
│  │   • Content filtering│    │  • reasoning tier (orchestration)    │ │
│  │   • Monitoring       │    │  • code_review tier (analysis)      │ │
│  │   • AI Content Safety│    │  • code_generation tier (PRs)       │ │
│  │                      │    │  • security tier (auditing)         │ │
│  └──────────┬──────────┘    └──────────────────────────────────────┘ │
└─────────────┼────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      Azure Compute                                    │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Azure Container Apps Environment                               │  │
│  │                                                                  │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │  │
│  │  │ Goose        │  │ Goose        │  │ Goose        │          │  │
│  │  │ Orchestrator │  │ Orchestrator │  │ Orchestrator │  (2-5   │  │
│  │  │ (container)  │  │ (container)  │  │ (container)  │   repl.) │  │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │  │
│  │         │                 │                 │                    │  │
│  │         └─────────────────┼─────────────────┘                    │  │
│  │                           │                                      │  │
│  │  ┌────────────────────────┴────────────────────────┐           │  │
│  │  │  Azure Service Bus                               │           │  │
│  │  │  • Topic: minion-tasks (async task queue)        │           │  │
│  │  │  • Subscription per minion type                  │           │  │
│  │  │  • Sessions enabled (ordered delivery per corr.) │           │  │
│  │  │  • Dead-letter on failure                        │           │  │
│  │  └─────────────────────────────────────────────────┘           │  │
│  │                                                                  │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │  │
│  │  │ Slack Bot    │  │ Teams Bot    │  │ MCP Sidecars │          │  │
│  │  │ (container)  │  │ (container)  │  │ (per-server) │          │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘          │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      Azure Data + Observability                        │
│                                                                       │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────┐ │
│  │ Azure Table  │   │ Azure Blob   │   │ Azure Monitor            │ │
│  │ Storage      │   │ Storage      │   │ • Log Analytics (KQL)    │ │
│  │ (tool logs)  │   │ (artifacts)  │   │ • Container Insights     │ │
│  │              │   │              │   │ • Dashboards             │ │
│  └──────────────┘   └──────────────┘   │ • Alerts (SMS/Teams)    │ │
│                                        └──────────────────────────┘ │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────┐ │
│  │ Azure Key    │   │ Azure AD     │   │ Azure AI Content Safety  │ │
│  │ Vault        │   │ (Managed     │   │ • Prompt injection guard │ │
│  │ (secrets)    │   │  Identities) │   │ • Harmful output filter  │ │
│  └──────────────┘   └──────────────┘   └──────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

### Component Rationale

| Component | Azure Service | Why |
|---|---|---|
| **Goose runtime** | Azure Container Apps | Serverless containers, scale-to-zero, KEDA autoscaling based on Service Bus queue depth. No cluster to manage. |
| **LLM inference** | Azure AI Foundry model catalog | Configurable model tiers (fast, reasoning, code_review, code_generation, security) mapped to deployments. Unified content safety. |
| **Async messaging** | Azure Service Bus (Standard tier) | Reliable minion task queue with sessions for ordered delivery. Dead-letter for failed tasks. ~$10/month for Standard tier (includes all features). |
| **Tool call log** | Azure Table Storage | ~$1.50/month. Immutable append-only log. Partitioned by correlation ID. |
| **Large artifacts** | Azure Blob Storage (Cool tier) | ~$0.50/month. Full minion outputs, diffs, conversation transcripts. |
| **Monitoring** | Azure Monitor + Log Analytics | Centralized logging from all containers and MCP servers. KQL queries for audit and troubleshooting. Dashboards for ops. Alert rules for failures. |
| **Content safety** | Azure AI Content Safety (via AI Foundry) | Prompt injection detection, harmful content filtering. Already built into AI Foundry. |
| **Secrets** | Azure Key Vault | All MCP tokens, PATs, API keys, bot credentials. Accessed via managed identity — no secrets in code or env vars. |
| **Networking** | VNet + Private Endpoints | All Azure services on private network. Only public ingress is Teams/Slack bot endpoints. |

### Scaling Model

| Trigger | Scaling Action |
|---|---|
| Service Bus queue depth > N messages | KEDA scales container count up (max 10) |
| Queue depth = 0 for T minutes | Scale to zero (or floor of 1 for latency-sensitive) |
| Minion timeout spike | Prometheus alert → ops investigate |
| Rate limit near exhaustion (GitHub/ADO) | Backpressure: orchestrator throttles dispatch |

---

## GitHub's Role

GitHub serves multiple roles in the framework, not just as an integration target.

### a) Framework Source of Truth (Primary)

The Goose agent framework itself lives in GitHub:

```
github.com/your-org/goose-agent-framework/
├── extensions/
│   ├── orchestrator/
│   │   ├── extension.yaml
│   │   ├── extension.ts          (or .py)
│   │   └── prompts/
│   │       ├── code-explorer.md
│   │       ├── code-reviewer.md
│   │       ├── pr-crafter.md
│   │       ├── ticket-analyst.md
│   │       └── security-auditor.md
│   ├── mcp-toolshed/
│   ├── slack-bot/
│   ├── teams-bot/
│   └── agent-dashboard/
├── recipes/
│   ├── daily-pr-review.yaml
│   ├── ticket-poll.yaml
│   └── weekly-security-scan.yaml
├── governance/
│   └── governance.yaml
├── docs/
│   ├── high-level-design.md
│   └── low-level-design.md
├── .github/
│   └── workflows/
│       ├── deploy-orchestrator.yml
│       ├── deploy-teams-bot.yml
│       └── deploy-slack-bot.yml
└── README.md
```

### b) Prompt & Config Versioning

Prompts, governance rules, and minion definitions are code. They change via **pull request**, are reviewed by humans, and deploy on merge.

```
Feature branch: update-code-reviewer-prompt
  → PR opened
  → Human reviews the prompt change
  → Merge to main
  → GitHub Actions deploys new container
  → Code Reviewer minion now uses the updated prompt
```

### c) CI/CD via GitHub Actions

Every extension deploys independently via GitHub Actions:

```yaml
# .github/workflows/deploy-orchestrator.yml
name: Deploy Orchestrator
on:
  push:
    branches: [main]
    paths:
      - 'extensions/orchestrator/**'
jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Azure login (OIDC)
        uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
      - name: Build and push container
        run: |
          az acr build \
            --registry gooseframework \
            --image orchestrator:${{ github.sha }} \
            --file extensions/orchestrator/Dockerfile \
            .
      - name: Deploy to Container Apps
        run: |
          az containerapp update \
            --name goose-orchestrator \
            --resource-group goose-framework \
            --image gooseframework.azurecr.io/orchestrator:${{ github.sha }}
```

### d) Self-Improvement Loop

Meta-capability: minions can propose improvements to the framework itself:

1. Code Reviewer minion notices a pattern of false negatives in its own review output
2. It opens a PR against `goose-agent-framework` suggesting a prompt change
3. Human operator reviews and merges
4. All future reviews benefit from the improvement

This creates a **virtuous cycle** where the framework gets better the more it's used.

### e) Issues & Project Board

Framework bugs, feature requests, and roadmap items are tracked in GitHub Issues. The orchestrator could theoretically work on its own backlog — analyzing items, proposing fixes, and opening PRs against itself.

---

## Data Flows

### Flow 1: Simple Query — "What's the status of AB#1234?"

```
Teams: "@minions what's the status of AB#1234?"

1. Teams Bot → Orchestrator (intent: ticket_lookup, platform: ado)
   Root correlation ID: corr_f7e8d9
2. Orchestrator → Ticket Analyst minion (delegate, async: false)
   Sub-correlation: corr_f7e8d9.1
3. Ticket Analyst → Azure DevOps MCP: get_work_item(id=1234)
   Tool call: corr_f7e8d9.1.ado-001 (logged to Table Storage)
4. Ticket Analyst → GitHub MCP: search_issues("AB#1234")  [cross-reference]
   Tool call: corr_f7e8d9.1.gh-001
5. Ticket Analyst returns structured result
6. Orchestrator formats Adaptive Card with work item summary + related PRs
7. Teams Bot posts card to channel
```

### Flow 2: Complex Pipeline — "Fix work item #567 in Azure DevOps and create a PR"

```
Teams: "@minions fix work item #567 and create a PR"

1. Teams Bot → Orchestrator (intent: ticket→fix→pr, platform: ado)
   Root correlation ID: corr_a1b2c3

2. Orchestrator decomposes into DAG:
   ┌──────────────────────────────────────────────────────────┐
   │ Phase 1 (parallel, async: true)                           │
   │   corr_a1b2c3.1: Ticket Analyst → ADO get_work_item(567) │
   │   corr_a1b2c3.2: Code Explorer → find relevant code      │
   │   corr_a1b2c3.3: Ticket Analyst → ADO find related PRs   │
   └──────────────────────────────────────────────────────────┘
                              │ (load all three, merge results)
                              ▼
   ┌──────────────────────────────────────────────────────────┐
   │ Phase 2: Orchestrator synthesizes fix context              │
   │   Context = ticket details + code locations + related PRs │
   └──────────────────────────────────────────────────────────┘
                              │
                              ▼
   ┌──────────────────────────────────────────────────────────┐
   │ Phase 3: corr_a1b2c3.4 — PR Crafter                      │
   │   → Git: create branch fix/AB567-auth-timeout             │
   │   → Filesystem: implement fix + tests                    │
   │   → Shell: run tests ("npm test", "cargo test")          │
   │   → Git: commit + push                                   │
   │   → Azure DevOps: create PR, link to work item #567      │
   └──────────────────────────────────────────────────────────┘
                              │
                              ▼
   ┌──────────────────────────────────────────────────────────┐
   │ Phase 4: corr_a1b2c3.5 — Code Reviewer (optional)         │
   │   → ADO: get PR diff                                     │
   │   → Analyze for issues                                   │
   │   → Post review comments as PR thread                    │
   └──────────────────────────────────────────────────────────┘
                              │
                              ▼
3. Orchestrator synthesizes Adaptive Card response
4. Teams Bot: posts card with:
   ✅ PR #892 created: fix(auth): resolve timeout (AB#567)
   | Branch: fix/AB567-auth-timeout
   | Review: passed (3 suggestions)
   | [View PR] [Approve] [Request Changes] [View Work Item]
```

### Flow 3: Scheduled — Daily PR Review Across GitHub + Azure DevOps

```
Cron: 0 8 * * 1-5

1. Scheduled trigger fires → Orchestrator
   Root correlation ID: corr_daily_20260605

2. Orchestrator queries both platforms (parallel):
   → GitHub MCP: list_open_prs(repo="org/repo-frontend")
   → GitHub MCP: list_open_prs(repo="org/repo-backend")
   → Azure DevOps MCP: get_prs(project="Platform", status="active")

3. For each PR (parallel, max concurrency 3, async):
   → Code Reviewer minion reviews PR
   → Posts structured review on the PR (GitHub review or ADO PR comment)

4. Orchestrator → Teams (primary) + Slack (secondary, if configured):
   Posts "Morning PR Review" Adaptive Card digest:
   📋 6 PRs across 3 repos reviewed
   ✅ 2 approved
   ⚠️ 3 with changes requested (2 major, 1 minor)
   🚫 1 blocked — security concern in PR #570 (SQL injection risk)
   | [View All] [Approve All Passing]
```

### Flow 4: Multi-Platform Ticket Drill-Down

```
Slack: "@minions summarize all Sev-1 incidents and cross-reference with ADO work items"

1. Slack Bot → Orchestrator (intent: ticket_summary_crossref)

2. Orchestrator spawns in parallel:
   → Ticket Analyst → ServiceNow: query_incidents(severity=1, state=open)
   → Ticket Analyst → Azure DevOps: run_query(WIQL: priority=1, state=active)

3. Ticket Analyst cross-references:
   → For each ServiceNow incident, search ADO for related work items
   → For each ADO work item, search ServiceNow for related incidents

4. Orchestrator synthesizes unified view in Slack:
   🔴 2 Sev-1 Incidents | 3 ADO Critical Work Items

   INC00812: Payment gateway timeout (Sev-1, 4h open)
   └── Related: AB#1234 (platform/payments), AB#1235 (platform/gateway)
   └── PR: #892 (in review)

   INC00823: Auth service degraded (Sev-1, 1h open)
   └── Related: AB#1290 (platform/auth)
   └── No PR yet — [Create Fix PR]
```

---

## Implementation Roadmap

### Phase 1 — Foundation + Teams + ADO (Weeks 1–2)

**Goal:** Core infrastructure — toolshed, Slack, Teams, GitHub, and Azure DevOps — all functional.

| # | Task | Deliverable |
|---|---|---|
| 1 | Build `mcp-toolshed` extension | MCP connection manager, allowlist engine, tool call logger |
| 2 | Integrate GitHub MCP | Full read/write: PRs, issues, branches, commits |
| 3 | Integrate Azure DevOps MCP | Work items, PRs, repos, builds, WIQL queries |
| 4 | Integrate Filesystem + Git MCP | Read/write, search, git operations |
| 5 | Build `slack-bot` extension | Receive `@minions` mentions, post threaded replies |
| 6 | Build `teams-bot` extension | Receive `@minions` mentions, post Adaptive Cards |
| 7 | Build `orchestrator` extension (skeleton) | Intent classification, single-minion dispatch, correlation IDs |
| 8 | Set up Azure infrastructure | Container Apps environment, Service Bus, Table Storage, Key Vault |

### Phase 2 — Minion Framework (Weeks 3–4)

**Goal:** The minion pool is operational. Code Explorer and Code Reviewer are live.

| # | Task | Deliverable |
|---|---|---|
| 9 | Define minion manifest format | YAML schema for system prompts, tool allowlists, timeouts |
| 10 | Implement minion lifecycle | Spawn/monitor/collect/terminate in orchestrator |
| 11 | Build Code Explorer minion | Tree-sitter analysis, grep, call-graph tracing |
| 12 | Build Code Reviewer minion | Diff analysis, structured review output, lint integration |
| 13 | Build tool call capture pipeline | Toolshed → Table Storage + stdout → Log Analytics |
| 14 | Shared memory / conversation log | Session persistence, cross-minion context sharing |
| 15 | Dashboard skeleton (optional) | Active minion status, correlation ID lookup |

### Phase 3 — Ticket & PR Pipeline (Weeks 5–6)

**Goal:** End-to-end ticket-to-PR pipeline across both GitHub and Azure DevOps.

| # | Task | Deliverable |
|---|---|---|
| 16 | Integrate ServiceNow MCP | Query incidents, changes, problems; link to code |
| 17 | Integrate Jira MCP | Query issues, sprints, boards |
| 18 | Build Ticket Analyst minion | Cross-reference across ServiceNow + Jira + ADO + GitHub |
| 19 | Build PR Crafter minion | Branch → implement → test → commit → PR (both platforms) |
| 20 | DAG-based task decomposition | Parallel execution of independent sub-tasks |
| 21 | Human-in-the-loop gating | Approval prompts in Slack/Teams for destructive actions |

### Phase 4 — Full Platform (Weeks 7–8)

**Goal:** Security, scheduling, dashboard, and production hardening.

| # | Task | Deliverable |
|---|---|---|
| 22 | Build Security Auditor minion | OWASP scanning, CVE checks, dependency audit |
| 23 | Scheduled job definitions | Cron recipes for daily PR review, ticket polling, security scans |
| 24 | Web dashboard (optional) | Real-time status, tool call log viewer, config UI |
| 25 | Governance & rate limiting | Full allowlist enforcement, rate limiter, blocked-tool alerts |
| 26 | Documentation & runbook | Operator guide, minion authoring guide, troubleshooting, KQL recipes |
| 27 | Self-improvement POC | Minion proposes a prompt fix → PR → human reviews |

---

## Key Design Decisions

| # | Decision | Rationale | ADR |
|---|---|---|---|
| 1 | **Goose `delegate` for minions** | Already supports async parallelism, isolated context windows, and tool allowlisting. No need to build a custom agent runtime. | ADR-001 |
| 2 | **MCP for all integrations** | Standard protocol with growing ecosystem. Clean separation of concerns — tools defined once and shared across minions. | ADR-002 |
| 3 | **Extensions as the packaging unit** | Each component is a standalone Goose extension. Enables independent versioning, testing, and deployment. | ADR-003 |
| 4 | **Stateless minions, stateful orchestrator** | Minions are disposable — they complete one task and terminate. The orchestrator holds the conversation thread, aggregates results, and maintains context across minion calls. | ADR-004 |
| 5 | **Tool allowlisting per minion** | Security and focus. A PR Crafter should never access ServiceNow; a Ticket Analyst should never write code. Least-privilege reduces blast radius. | ADR-005 |
| 6 | **Structured JSON output contracts** | Every minion returns typed JSON. The orchestrator can merge, validate, and synthesize without parsing free text. | ADR-006 |
| 7 | **Human-in-the-loop for destructive ops** | Merging PRs, closing tickets, deploying — all require explicit user confirmation via Slack/Teams. Minions recommend; humans decide. | ADR-007 |
| 8 | **Async-first with configurable sync** | Simple queries run synchronously. Complex pipelines run async with progress updates posted back to the chat channel. | ADR-008 |
| 9 | **SQLite + Azure Table Storage + Blob (reject Cosmos DB)** | Cosmos DB is cost-prohibitive (~$50-250/month). SQLite ($0) for hot state, Table Storage (~$1.50/mo) for tool call log, Blob (~$0.50/mo) for artifacts. Swappable abstraction layer. | ADR-009 |
| 10 | **Azure AI Foundry as AI platform** | Unified model catalog accessed via configurable tiers (fast, reasoning, code_review, code_generation, security). Built-in content safety, RBAC, monitoring. Avoids managing separate API keys per model provider. | ADR-010 |
| 11 | **Azure Container Apps for compute** | Serverless containers, KEDA autoscaling, scale-to-zero when idle. No Kubernetes cluster to manage. | ADR-011 |
| 12 | **Azure Service Bus for async task queue** | Reliable delivery, sessions for ordered execution per correlation ID, dead-lettering. Standard tier at ~$10/month. | ADR-012 |
| 13 | **GitHub as framework source of truth + CI/CD** | Prompts, configs, and extension code live in Git. Change via PR. Deploy via GitHub Actions. Self-improvement loop. | ADR-013 |
| 14 | **Microsoft Teams as Phase 1 priority** | Enterprise standard alongside Slack. Adaptive Cards for rich interaction. Deep integration with Azure AD and Azure DevOps. | ADR-014 |
| 15 | **Azure DevOps as first-class MCP integration** | Peer to GitHub. Full work item, PR, repo, build, and WIQL support. Ticket Analyst cross-references ADO with ServiceNow. | ADR-015 |
| 16 | **Three-layer tool call capture** | Goose-native (automatic), MCP toolshed proxy (primary, allowlist enforcement), server-side (optional defense-in-depth). Immutable log in Table Storage + real-time in Log Analytics. | ADR-016 |
| 17 | **Correlation ID propagation** | Every action carries a root → sub → tool-call ID. Full trace reconstruction from Table Storage + Log Analytics. | ADR-017 |

---

## Security & Governance

### Minion Sandboxing

- Each minion runs in an isolated Goose delegate context
- No access to the orchestrator's tools or memory beyond what's explicitly passed
- Shell commands are restricted to a per-minion allowlist
- Filesystem writes restricted to workspace boundaries

### Tool Permissions

- MCP toolshed enforces **read / write / admin** tiers:

| Tier | Operations | Requirement |
|---|---|---|
| **Read** | `get_*`, `search_*`, `list_*` | No approval needed |
| **Write** | `create_*`, `update_*`, `commit_*`, `push_*` | Allowlisted; some require human confirmation |
| **Admin** | `delete_*`, `merge_*`, `close_*` | Disabled by default; explicit human approval required per-action |

### Audit Trail

- Every minion invocation logged with correlation ID
- All PRs include a `Co-authored-by: goose-agent [bot]` trailer
- All ticket/work item updates include a "via Goose Agent" system note
- Tool call log is immutable (append-only Table Storage)
- 90-day retention in Table Storage; archive to Blob for longer

### Configuration Governance

```yaml
# ~/.goose/agent-framework/governance.yaml
governance:
  require_approval_for:
    - github.merge_pr
    - github.delete_branch
    - azure_devops.complete_pr
    - azure_devops.delete_branch
    - servicenow.close_incident
    - servicenow.update_incident
    - jira.transition_issue     # when target is Done/Closed

  blocked_tools:
    - github.delete_repo
    - azure_devops.delete_repo
    - azure_devops.delete_project
    - servicenow.delete_incident
    - jira.delete_issue
    - shell.rm_rf
    - shell.chmod_777

  rate_limits:
    github: 50 requests/min
    azure_devops: 40 requests/min
    servicenow: 20 requests/min
    jira: 30 requests/min

  workspace_boundaries:
    filesystem: ["/Volumes/ExtDisk1/Goose", "~/projects"]
    github_repos: ["org/repo-*"]
    azure_devops_projects: ["Platform", "Mobile"]

  minion_timeouts:
    code-explorer: 300      # seconds
    code-reviewer: 600
    pr-crafter: 900
    ticket-analyst: 300
    security-auditor: 600
```

---

## Observability

Observability is delivered in two tiers, both reading from the same data sources (Log Analytics + Table Storage):

| Tier | What | Who for | Phase |
|---|---|---|---|
| **Tier 1: Azure Managed Grafana** | Curated dashboards for minion health, tool call metrics, cost, and alerts | Platform operators, SREs | 2 |
| **Tier 2: Custom `agent-dashboard` extension** | Session replay, correlation tree viewer, live minion status, governance config | Framework users, developers | 4 |

See **[ADR-018](./adrs/adr-018-observability-dashboard.md)** for the full decision record.

### Tier 1: Azure Managed Grafana

Azure Managed Grafana provides zero-ops dashboards with native Log Analytics and Azure Monitor data sources. Azure AD single sign-on.

#### Dashboard 1: Overview

| Panel | Type | KQL / Metric |
|---|---|---|
| Active sessions (gauge) | Stat | `AppTraces \| where timestamp > ago(1h) \| where Properties.event == "session_started" \| summarize count()` |
| Minion runs / 24h (stacked bar) | Time series | `AppTraces \| where Properties.event == "minion_completed" \| summarize count() by bin(timestamp, 1h), Properties.minion_type` |
| Success rate / 24h | Stat | `AppTraces \| where Properties.event == "tool_call" \| summarize success = countif(Properties.success == true), total = count()` |
| Avg tool call latency / 24h | Time series | `AppTraces \| where Properties.event == "tool_call" \| summarize avg(Properties.latency_ms) by bin(timestamp, 10m)` |
| Queue depth (real-time) | Stat | Azure Service Bus metric: `Active Messages` |
| Tool call failures / 24h (by server) | Bar chart | `AppTraces \| where Properties.success == false \| summarize count() by Properties.mcp_server` |

#### Dashboard 2: Minion Health

| Panel | Type | KQL |
|---|---|---|
| Runs by minion type / 24h | Pie | `summarize count() by Properties.minion_type` |
| Timeout rate / 24h | Stat per minion | `where Properties.status == "timed_out" \| summarize count()` |
| Retry distribution | Heatmap | `summarize count() by Properties.minion_type, Properties.attempt` |
| Avg turns per minion type | Bar gauge | `summarize avg(Properties.turns_used) by Properties.minion_type` |
| Tokens consumed / 24h (by minion) | Time series | `summarize sum(Properties.tokens_used) by bin(timestamp, 1h), Properties.minion_type` |

#### Dashboard 3: Cost & Capacity

| Panel | Type | Data |
|---|---|---|
| Token usage / daily (by model) | Time series | AI Foundry metrics |
| Estimated cost / daily (by model) | Time series | Token count × model pricing rate |
| Rate limit hits / 24h (by server) | Bar chart | `AppTraces \| where Properties.status == "throttled" \| summarize count() by Properties.mcp_server` |
| Container replica count | Time series | Azure Container Apps metric |
| Service Bus DLQ depth | Stat | Service Bus metric: `Count of dead-lettered messages` |

#### Dashboard 4: Security

| Panel | Type | KQL |
|---|---|---|
| Blocked tool calls / 24h | Table | `where Properties.status == "blocked_by_allowlist"` |
| Pending approvals | Table | SQLite query exposed via structured log |
| Content safety triggers / 24h | Stat | AI Foundry content safety metrics |

#### Alert Rules

| Alert | Condition | Severity | Channel |
|---|---|---|---|
| Minion timeout rate > 10% (15 min) | Tool call log | Sev-2 | Teams |
| DLQ has messages | Service Bus metric | Sev-2 | Teams |
| Tool call failure rate > 20% (15 min) | Tool call log | Sev-1 | Teams + SMS |
| Rate limit hits > 10 (5 min rolling) | Tool call log | Sev-3 | Teams |
| No sessions in 4hr (business hours) | Tool call log | Sev-3 | Teams (info) |
| Pending approval > 1hr old | SQLite → structured log | Sev-3 | Teams |
| Container restarts > 3 in 30 min | Container Apps metric | Sev-2 | Teams |

### Tier 2: Custom `agent-dashboard` Extension

A Goose extension built in Phase 4 providing Goose-specific views that Grafana cannot provide:

| View | Description |
|---|---|
| **Session explorer** | Search sessions by user, channel, intent, date. Click any session to expand its full correlation tree. |
| **Correlation tree** | Visual DAG of a session: root → minions → tool calls. Color-coded: green (success), red (failure), yellow (timeout). Click a node for parameters, result, latency. |
| **Live minion status** | Real-time view of all active minions with progress bars. Cancel or retry individual minions. |
| **Tool call inspector** | Search/filter all tool calls by server, minion, status, date range. View parameters (truncated 4KB) and result summary. |
| **Governance config** | View and edit `governance.yaml` with inline validation. Proposed changes open a PR to the framework repo. |
| **Prompt viewer** | Inspect the current system prompt for each minion type. Browse version history (from Git). |

### Data Flow for Observability

```
Minion Tool Call
      │
      ▼
mcp-toolshed (Layer B capture)
      │
      ├──→ Azure Table Storage (durable audit, 90-day retention)
      │
      └──→ stdout (structured JSON)
              │
              ▼
       Container Insights
              │
              ▼
         Log Analytics ──→ Grafana dashboards (Tier 1)
              │              │
              │              └──→ Alert rules → Teams/SMS
              │
              └──→ agent-dashboard (Tier 2, Phase 4)
                       Reads Table Storage + Log Analytics
```

---

## Architecture Decision Records

All ADRs are maintained in [`adrs.md`](./adrs.md). See that document for the full list with context, decision, and consequences for each.

| ADR | Title |
|---|---|
| ADR-001 | Use Goose delegate as the minion runtime |
| ADR-002 | Use MCP for all tool integrations |
| ADR-003 | Use Goose extensions as the packaging unit |
| ADR-004 | Stateless minions, stateful orchestrator |
| ADR-005 | Tool allowlisting per minion |
| ADR-006 | Structured JSON output contracts for minions |
| ADR-007 | Human-in-the-loop for destructive operations |
| ADR-008 | Async-first task execution with sync fallback |
| ADR-009 | SQLite + Azure Table Storage + Azure Blob for storage (reject Cosmos DB) |
| ADR-010 | Azure AI Foundry as the AI platform |
| ADR-011 | Azure Container Apps for compute |
| ADR-012 | Azure Service Bus for async task queuing |
| ADR-013 | GitHub as framework source of truth + CI/CD |
| ADR-014 | Microsoft Teams as Phase 1 priority (peer to Slack) |
| ADR-015 | Azure DevOps as first-class MCP integration |
| ADR-016 | Three-layer tool call capture |
| ADR-017 | Correlation ID propagation for distributed tracing |
| ADR-018 | Observability dashboard design |
| ADR-019 | Filesystem path scoping per minion |
| ADR-020 | Optional semantic code tagging |

---

## Appendix: Extension Manifests

### `mcp-toolshed/extension.yaml`

```yaml
name: mcp-toolshed
version: 0.1.0
description: MCP server connection manager, tool allowlist engine, and tool-call logger

mcp_servers:
  github:
    transport: http
    url: "${GITHUB_MCP_URL}"
    auth:
      type: bearer
      token_env: GITHUB_TOKEN
    health_check_interval_secs: 30
    rate_limit:
      max_per_minute: 50

  azure_devops:
    transport: http
    url: "${ADO_MCP_URL}"
    auth:
      type: bearer
      token_env: AZURE_DEVOPS_PAT
    org_url: "https://dev.azure.com/${AZURE_DEVOPS_ORG}"
    health_check_interval_secs: 30
    rate_limit:
      max_per_minute: 40

  servicenow:
    transport: http
    url: "${SERVICENOW_MCP_URL}"
    auth:
      type: basic
      username_env: SERVICENOW_USER
      password_env: SERVICENOW_PASS
    health_check_interval_secs: 60
    rate_limit:
      max_per_minute: 20

  jira:
    transport: http
    url: "${JIRA_MCP_URL}"
    auth:
      type: bearer
      token_env: JIRA_API_TOKEN
    health_check_interval_secs: 60
    rate_limit:
      max_per_minute: 30

  filesystem:
    transport: stdio
    command: "npx"
    args: ["-y", "@anthropic/mcp-filesystem", "/Volumes/ExtDisk1/Goose"]
    health_check_interval_secs: 0   # stdio — health implied

  git:
    transport: stdio
    command: "npx"
    args: ["-y", "@anthropic/mcp-git"]
    health_check_interval_secs: 0

  slack:
    transport: http
    url: "${SLACK_MCP_URL}"
    auth:
      type: bearer
      token_env: SLACK_BOT_TOKEN

  teams:
    transport: http
    url: "${TEAMS_MCP_URL}"
    auth:
      type: azure_ad
      tenant_id_env: AZURE_TENANT_ID
      client_id_env: AZURE_CLIENT_ID
      client_secret_env: AZURE_CLIENT_SECRET

storage:
  tool_call_log:
    type: azure_table
    connection_string_env: AZURE_STORAGE_CONNECTION_STRING
    table_name: ToolCallLog
    ttl_days: 90
  artifacts:
    type: azure_blob
    connection_string_env: AZURE_STORAGE_CONNECTION_STRING
    container: minion-outputs
    tier: cool
  session_state:
    type: sqlite
    path: /data/goose-sessions.db
    backup_to_blob: true
    backup_interval_minutes: 15
```

### `orchestrator/extension.yaml` (partial)

```yaml
name: orchestrator
version: 0.1.0
description: Intent classification, task decomposition, and minion lifecycle manager

requires:
  - mcp-toolshed
  - chatrecall

minion_defaults:
  max_retries: 3
  retry_backoff: exponential
  poll_interval_secs: 5

minions:
  code-explorer:
    system_prompt_path: ./prompts/code-explorer.md
    max_turns: 15
    timeout_secs: 300
    tools:
      mcp-toolshed:
        github: {allow: [search_code, get_file]}
        azure_devops: {allow: [search_repos, get_file]}
        filesystem: {allow: [read_file, list_directory, search_files]}
        git: {allow: [log, show, blame]}

  code-reviewer:
    system_prompt_path: ./prompts/code-reviewer.md
    max_turns: 20
    timeout_secs: 600
    tools:
      mcp-toolshed:
        github: {allow: [get_pr, get_pr_diff, create_pr_review, create_pr_review_comment]}
        azure_devops: {allow: [get_pr, get_pr_diff, create_pr_review]}
        filesystem: {allow: [read_file, list_directory]}
        git: {allow: [diff, log, show]}

  pr-crafter:
    system_prompt_path: ./prompts/pr-crafter.md
    max_turns: 30
    timeout_secs: 900
    require_confirmation: true
    tools:
      mcp-toolshed:
        github: {allow: [create_branch, commit_changes, create_pr, get_pr, search_code]}
        azure_devops: {allow: [create_branch, commit_changes, create_pr, get_pr, search_repos]}
        filesystem: {allow: [read_file, write_file]}
        git: {allow: [status, diff, add, commit, push, branch, checkout]}
        shell: {allow: [run_command], command_allowlist: ["npm test", "npm run lint", "pytest", "go test ./...", "cargo test", "cargo clippy"]}

  ticket-analyst:
    system_prompt_path: ./prompts/ticket-analyst.md
    max_turns: 10
    timeout_secs: 300
    tools:
      mcp-toolshed:
        servicenow: {allow: [query_incidents, get_incident, query_changes, get_change]}
        jira: {allow: [search_issues, get_issue, get_sprint]}
        azure_devops: {allow: [search_work_items, get_work_item, run_query, search_wiki]}
        github: {allow: [search_issues, get_issue]}

  security-auditor:
    system_prompt_path: ./prompts/security-auditor.md
    max_turns: 20
    timeout_secs: 600
    tools:
      mcp-toolshed:
        filesystem: {allow: [read_file, list_directory]}
        github: {allow: [get_vulnerability_alerts, get_dependabot_alerts, search_code]}
        azure_devops: {allow: [get_advanced_security_alerts]}
        shell: {allow: [run_command], command_allowlist: ["bandit", "npm audit", "trivy", "gitleaks", "cargo audit"]}
```

---

## Next Steps

1. **Review & align** — Discuss the revised design with stakeholders; confirm Teams + ADO scope and storage architecture
2. **Provision Azure infra** — Container Apps environment, Service Bus namespace, Table Storage account, Key Vault
3. **Spike the toolshed** — Build a minimal `mcp-toolshed` extension connecting GitHub + Azure DevOps + Filesystem MCP servers with logging to Table Storage
4. **Prototype a single pipeline** — "Review PR #N" end-to-end via Teams (Teams Bot → Orchestrator → Code Reviewer → Adaptive Card response)
5. **Iterate** — Add ServiceNow, Jira, scheduled jobs, and the Security Auditor
6. **Productionize** — Governance controls, KQL dashboards, alert rules, and operator runbook
