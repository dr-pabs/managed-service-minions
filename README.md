# Minions Agent Framework

> Multi-agent orchestration for engineering operations. Mention `@minions` in Slack or Microsoft Teams and delegate complex work — PR reviews, ticket lookups, branch fixes, security audits — to a team of specialized sub-agents ("minions") working through a governed MCP toolshed.

[![CI](https://github.com/dr-pabs/managed-service-minions/actions/workflows/ci.yml/badge.svg)](https://github.com/dr-pabs/managed-service-minions/actions/workflows/ci.yml)



---

## Table of Contents

- [What is this?](#what-is-this)
- [Key capabilities](#key-capabilities)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Development workflow](#development-workflow)
- [Running locally with Minions](#running-locally-with-minions)
- [Testing](#testing)
- [Deployment](#deployment)
- [Security & governance](#security--governance)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## What is this?

The Minions Agent Framework extends the [Goose](https://goose-docs.ai/) agent runtime into a production-ready, multi-agent system for software engineering teams. It combines:

1. A **Goose plugin** that provides the orchestrator agent, minion prompts, skills, recipes, and governance rules.
2. A set of **MCP extensions** that wrap external systems — GitHub, Azure DevOps, ServiceNow, Jira, Slack, Teams, and the filesystem — behind a governed toolshed.
3. Azure infrastructure (Container Apps, Service Bus, Table Storage, Blob Storage, Key Vault, AI Foundry, Log Analytics) for durable, observable, multi-tenant operation.

A user can say:

> "@minions review PR #342"

The orchestrator classifies the intent, delegates to a **Code Reviewer** minion, lets it read the PR and related code through the toolshed, and posts a structured review back to the channel — fully correlated and audited.

The design authority lives in [`./docs/high-level-design.md`](./docs/high-level-design.md), [`./docs/delivery-specification.md`](./docs/delivery-specification.md), [`./docs/testing-strategy.md`](./docs/testing-strategy.md), and the [`adrs/`](./adrs/) folder.

---

## Key capabilities

| Capability | Description |
|---|---|
| **Multi-agent delegation** | Spawn focused minions for code exploration, review, PR creation, ticket analysis, and security auditing |
| **MCP toolshed** | Shared, governed pool of Model Context Protocol servers providing GitHub, Azure DevOps, ServiceNow, Jira, Slack, Teams, and filesystem tools |
| **Chat ingress** | Natural-language requests from Slack and Microsoft Teams |
| **Ticket integration** | Read, query, and act on ServiceNow, Jira, and Azure DevOps work items |
| **Code review automation** | Structured diff analysis covering correctness, style, performance, and security |
| **PR automation** | Branch creation, edits, commits, and pull-request opening in GitHub/Azure DevOps |
| **Scheduled jobs** | Cron-driven recipes such as daily PR review and ticket polling |
| **Immutable audit trail** | Every tool call captured with a correlation ID in Azure Table Storage |
| **Human-in-the-loop** | Destructive actions (merge, close ticket, deploy) pause for human approval |
| **Low-cost durable storage** | SQLite + Azure Table Storage + Azure Blob — ~$2–5/month at moderate scale |

---

## Forge Ops (Stream)

Forge Ops is Minions' high-volume customer-workflow runtime — the **Stream**
half of a two-runtime design (**Flow** lives in the Forge repository) joined by
versioned contracts in the
[`forge-contracts`](https://github.com/dr-pabs/forge-contracts) repository.
Stream processes thousands of short work items a day where Flow runs one long
checkpointed run. The Stream capabilities below are the Forge Ops distribution
of this repository, each with its backing test suite:

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

## Architecture

```text
┌─────────────────────────────────────────────────────────────────────┐
│  Slack    Teams    Web UI    Scheduled / Cron                       │
│   Bot      Bot                                                         │
└────────────────────┬──────────────────────────────────────────────────┘
                     │  ACP / WebSocket / HTTP
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Goose Orchestrator (plugin agent)                                   │
│  • Intent classification                                             │
│  • Task decomposition (DAG)                                          │
│  • Minion lifecycle: delegate → monitor → collect → synthesize       │
│  • Correlation-ID propagation                                        │
│  • Human approval gating                                             │
└────────────────────┬──────────────────────────────────────────────────┘
                     │ delegate(async: true)
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Minion Pool (code-explorer, code-reviewer, pr-crafter,              │
│  ticket-analyst, security-auditor)                                   │
└────────────────────┬──────────────────────────────────────────────────┘
                     │ execute_tool
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│  MCP Toolshed                                                        │
│  • Per-minion allowlists                                             │
│  • Path scoping for filesystem tools                                 │
│  • Rate limiting and circuit breakers per MCP server                 │
│  • Audit logging and tool-call caching                               │
└────────────────────┬──────────────────────────────────────────────────┘
                     │
         ┌───────────┼───────────┬──────────────┐
         ▼           ▼           ▼              ▼
      GitHub    Azure DevOps  ServiceNow    Jira
      Slack     Teams         Filesystem    Shell
```

- The **plugin** is a git-installable bundle of Markdown/JSON skills and agents. It is loaded with `minions plugin install`.
- The **MCP extensions** are Node.js MCP servers configured separately in Goose. They are built from this monorepo.
- The orchestrator spawns minions with `delegate(async: true)` because `delegate` inherits the parent’s extensions, giving minions access to shell, file, analyze, and the toolshed.

See [`./docs/logical-architecture.md`](./docs/logical-architecture.md), [`./docs/physical-architecture.md`](./docs/physical-architecture.md), and [`./docs/azure-architecture.md`](./docs/azure-architecture.md) for deeper detail.

---

## Repository layout

```text
.
├── .plugin/                    # Goose plugin manifest
├── agents/                     # Orchestrator and minion agent prompts
├── skills/                     # Reusable skills (intent, decomposition, synthesis, ...)
├── commands/                   # Slash-command recipes
├── rules/                      # Allowlists, governance, model tiers
├── hooks/                      # Lifecycle hooks
├── schemas/                    # JSON output schemas for minions
├── packages/
│   └── framework-core/         # Shared TypeScript library
├── extensions/
│   ├── mcp-toolshed/           # Governed MCP proxy
│   ├── slack-bot/              # Slack ingress/egress MCP server
│   ├── teams-bot/              # Teams ingress/egress MCP server
│   ├── webhook-ingress/        # GitHub/ADO event ingress
│   ├── queue-ingress/          # Service Bus work-item queue ingress
│   └── agent-dashboard/        # Dashboard backend MCP server
├── infra/                      # Azure Terraform modules
├── test/                       # Integration, E2E, prompt-quality, chaos tests
├── .github/workflows/          # CI/CD
└── docs/
    └── execplan/execution-plan.md   # Implementation plan
```

---

## Getting started

### Prerequisites

- Node.js `>=20`
- pnpm `10.10.0` (the repo declares it via `packageManager`)
- Goose CLI `>=1.37`
- (Optional) Azure CLI, Docker, and `gh` for deployment

### Install dependencies

```bash
corepack enable
corepack prepare pnpm@10.10.0 --activate
pnpm install
```

### Build, lint, and test

```bash
pnpm typecheck
pnpm build
pnpm lint
pnpm test --coverage
```

Expected result: all green, with each package meeting its `jest.config.js` coverage thresholds (95% branches/lines, 100% functions/statements) for `packages/framework-core/` and every `extensions/*/src/` directory — see `adrs/adr-023-100-percent-test-coverage-gate.md` and its 2026-07-09 amendment for why branches/lines were lowered from 100%.

---

## Development workflow

The repo is a pnpm monorepo. Root scripts run across all workspaces:

```bash
pnpm typecheck          # TypeScript --noEmit across the repo
pnpm build              # Compile every TypeScript package
pnpm lint               # ESLint 9 flat config
pnpm test               # Unit tests (Jest + ESM/ts-jest)
pnpm test:integration   # Integration tests (placeholder harness)
pnpm test:e2e           # End-to-end tests (placeholder harness)
```

Per-package commands work with `--filter <name>`:

```bash
pnpm --filter framework-core test
pnpm --filter mcp-toolshed test --coverage
```

### Quality gates

- **95% branch/line, 100% function/statement coverage** is enforced for every package that contains source code (lowered from a strict 100% across all four metrics on 2026-07-09 — see the ADR amendment below for why). No PR may lower a package's coverage below its configured threshold.
- **Red-build policy ("Ralph Wiggum" loop):** any failing typecheck, lint, test, or coverage gate blocks merge. The author must fix the root cause, re-run the full pipeline green, and obtain maintainer/QA approval.

See [`adrs/adr-023-100-percent-test-coverage-gate.md`](./adrs/adr-023-100-percent-test-coverage-gate.md) and [`adrs/adr-024-red-build-policy-ralph-wiggum-loop.md`](./adrs/adr-024-red-build-policy-ralph-wiggum-loop.md).

---

## Running locally with Minions

### Local development mode (docker-compose)

For a fully self-contained local environment with no Goose or cloud dependencies:

```bash
pnpm dev
```

This builds all TypeScript packages and starts `docker compose --profile dev up --build`, which brings up mock MCP servers returning canned data:

- GitHub (port 3001)
- Azure DevOps (port 3002)
- ServiceNow (port 3003)
- Jira (port 3004)
- Shell (port 3005)

The mock servers implement the MCP protocol (SSE transport) over HTTP, compatible with the toolshed's `createMcpAdapter` URL-based connection (see `extensions/mcp-toolshed/src/adapter.ts`). SQLite session/audit storage uses a local file at `/tmp/minions-dev.sqlite` (configured via `TOOLSHED_STORE_PATH` by `scripts/dev.sh`).

To stop: `Ctrl-C` (the dev script handles cleanup), or `docker compose --profile dev down`.

### 1. Install the plugin

```bash
minions plugin install file://$(pwd)
# or after pushing to GitHub:
# minions plugin install https://github.com/dr-pabs/managed-service-minions.git
```

The plugin content lands in `~/.agents/plugins/managed-service-minions/`.

### 2. Build the MCP extensions

```bash
pnpm build
```

### 3. Register the extensions in Minions config

Add to `~/.config/minions/config.yaml` (exact schema may vary by version):

```yaml
extensions:
  mcp-toolshed:
    cmd: node
    args: ["<repo-root>/extensions/mcp-toolshed/dist/index.js"]
    type: stdio
    enabled: true
  slack-bot:
    cmd: node
    args: ["<repo-root>/extensions/slack-bot/dist/index.js"]
    type: stdio
    enabled: true

chatrecall:
  enabled: true
orchestrator:
  enabled: true
```

> **Note:** `--with-builtin` does not override disabled config entries in Minions 1.37.0. Enable the extensions in config.

### 4. Run a one-off task

```bash
minions run \
  --with-extension "node extensions/mcp-toolshed/dist/index.js" \
  --with-builtin developer,analyze,chatrecall,orchestrator \
  -t "@minions review PR #342"
```

### 5. Validate recipes

Recipes inside a plugin’s `commands/` directory are not auto-discovered. Validate or run them by path:

```bash
minions recipe validate ~/.agents/plugins/managed-service-minions/commands/daily-pr-review.yaml
export MINIONS_RECIPE_PATH="$HOME/.agents/plugins/managed-service-minions/commands"
minions recipe list
```

---

## Testing

| Layer | Command | Notes |
|---|---|---|
| Unit | `pnpm test --coverage` | 95% branch/line, 100% function/statement thresholds on `packages/` and `extensions/` |
| Integration | `pnpm test:integration` | Mock MCP servers and SQLite-backed flows |
| E2E | `pnpm test:e2e` | Staging-environment smoke tests |
| Prompt quality | `pnpm test:prompts -- --minion <name> ...` | Compare candidate prompts against baselines |

The unit-test suite uses Jest with `--experimental-vm-modules` and ts-jest ESM support. The `test/` workspace holds integration, E2E, prompt-quality, and chaos harnesses.

---

## Deployment

Production deployment targets Azure:

- **Container Apps** for the orchestrator, chat bots, and MCP sidecars
- **Service Bus** for durable async minion tasks
- **Azure AI Foundry** for model-tier routing
- **Table Storage + Blob Storage** for audit logs and SQLite backups
- **Key Vault** for secrets
- **Log Analytics + Managed Grafana** for observability

Infrastructure is defined in [`infra/terraform/`](./infra/terraform/) and deployed via GitHub Actions using OIDC federation. CI/CD workflows live in [`.github/workflows/`](./.github/workflows/).

High-level deploy steps:

```bash
az login
cd infra/terraform
terraform init \
  -backend-config="resource_group_name=<STATE_RG>" \
  -backend-config="storage_account_name=<STATE_SA>" \
  -backend-config="container_name=tfstate" \
  -backend-config="key=dev.terraform.tfstate"
terraform plan -var-file=environments/dev/terraform.tfvars
terraform apply -var-file=environments/dev/terraform.tfvars
```

See [`./docs/azure-architecture.md`](./docs/azure-architecture.md), [`./docs/terraform-bootstrap.md`](./docs/terraform-bootstrap.md), [`./docs/disaster-recovery.md`](./docs/disaster-recovery.md), and the operational runbooks in [`./docs/runbooks/`](./docs/runbooks/) for details.

---

## Security & governance

- **Per-minion allowlists** block unauthorized tools (e.g., a Ticket Analyst cannot call `github.create_pr`).
- **Path scoping** keeps filesystem tools within allowed workspace boundaries.
- **Rate limits** and **circuit breakers** per MCP server prevent abuse and cascading failures.
- **Human-in-the-loop** gating pauses destructive actions until a human approves via Slack/Teams.
- **Audit logging** records every tool call with correlation ID, status, latency, and error.
- **Least-privilege** access via managed identities; no secrets are committed.

See [`adrs/adr-005-tool-allowlisting-per-minion.md`](./adrs/adr-005-tool-allowlisting-per-minion.md), [`adrs/adr-007-human-in-the-loop-destructive-ops.md`](./adrs/adr-007-human-in-the-loop-destructive-ops.md), and [`./docs/error-handling.md`](./docs/error-handling.md).

---

## Roadmap

The original v1 build plan is in [`docs/execplan/execution-plan.md`](./docs/execplan/execution-plan.md) (superseded — see below). The authoritative, up-to-date plan is the remediation ExecPlan, [`docs/execplan/2026-07-08-minions-remediation-and-features.md`](./docs/execplan/2026-07-08-minions-remediation-and-features.md), which fixed the Critical/High/Medium findings from the 2026-07-08 code review and delivered the feature set below across 19 milestones (0–18), all complete as of this writing.

| Milestone | Status | Description |
|---|---|---|
| **Milestones 0–6** | ✅ Complete | Workspace bootstrap; config integrity (minion naming fix); TTL/bounded tool-call cache; minion identity tokens (no self-reported identity); path-scope + shell-command governance hardening; async-first approval with Slack/Teams notification; per-server rate limits and durable circuit breakers |
| **Milestone 7** | ✅ Complete | Single-replica governance state made honest in Terraform and docs (`adrs/adr-025-single-replica-governance-state.md`) — toolshed/bots/dashboard pinned to `max_replicas = 1`; only the orchestrator scales (1–5, KEDA on Service Bus queue depth) |
| **Milestone 8** | ✅ Complete | Cloud audit trail hardening: durable retry, secret redaction |
| **Milestone 9** | ✅ Complete | Session lifecycle: Slack thread/channel disambiguation, `updatedAt`, expiry |
| **Milestone 10** | ✅ Complete | Runtime output-contract enforcement (JSON Schema validation, one governed retry) |
| **Milestone 11** | ✅ Complete | Real orchestrator runner wired end-to-end: intent classification, minion DAG execution, Goose contract test, `test/src/e2e-review-pr.test.ts` |
| **Milestone 12** | ✅ Complete | Shared REST client retry/backoff/pagination (`packages/framework-core/src/http-retry.ts`) across all four MCP clients |
| **Milestone 13** | ✅ Complete | OpenTelemetry spans/metrics (no-op when unconfigured) and per-session token/cost accounting |
| **Milestone 14** | ✅ Complete | Dashboard v2: bearer-token auth, SSE live updates, pending-approvals panel, audit search, cost view; Entra ID easy-auth documented for production in Terraform |
| **Milestone 15** | ✅ Complete | Webhook ingress (`extensions/webhook-ingress`): GitHub/ADO events drive the same orchestrator runner as chat mentions |
| **Milestone 16** | ✅ Complete | Prompt-injection quarantine: untrusted content fenced before reaching a model, verified via an injection e2e test |
| **Milestone 17** | ✅ Complete | Rules hot-reload behind `TOOLSHED_WATCH_RULES=1`, validated before swap |
| **Milestone 18** | ✅ Complete | Hygiene sweep: honest CI coverage gate, naming consistency, scaffolding cleanup, dashboard `?token=` scoped to `/api/events` only, this table |

See the remediation ExecPlan's `Progress`, `Decision Log`, and `Outcomes & Retrospective` sections for the full history, evidence, and rationale behind every milestone above.

---

## Contributing

1. Open an issue or discussion before large changes.
2. Keep changes aligned with the ADRs and design docs.
3. Follow the monorepo scripts: `pnpm typecheck`, `pnpm build`, `pnpm lint`, `pnpm test --coverage`.
4. Maintain each package's configured coverage threshold (95% branches/lines, 100% functions/statements) for any new TypeScript source.
5. Get maintainer/QA approval after any red-build fix.

See [`AGENTS.md`](./AGENTS.md) for agent-focused conventions.

---

## License

[MIT](./LICENSE) — or replace with your organization’s license.
