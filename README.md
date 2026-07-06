# Minions Agent Framework

> Multi-agent orchestration for engineering operations. Mention `@minions` in Slack or Microsoft Teams and delegate complex work — PR reviews, ticket lookups, branch fixes, security audits — to a team of specialized sub-agents ("minions") working through a governed MCP toolshed.

[![CI](https://github.com/dr-pabs/managed-service-minions/actions/workflows/ci.yml/badge.svg)](https://github.com/dr-pabs/managed-service-minions/actions/workflows/ci.yml)

> **Status:** v1 build complete. All TypeScript packages pass typecheck, build, lint, and tests with 100% coverage. Operational runbooks and DR/test scaffolding are in `docs/runbooks/`, `test/performance/`, and `test/chaos/`.

---

## Table of Contents

- [What is this?](#what-is-this)
- [Key capabilities](#key-capabilities)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Development workflow](#development-workflow)
- [Running locally with Minions](#running-locally-with-goose)
- [Testing](#testing)
- [Deployment](#deployment)
- [Security & governance](#security--governance)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## What is this?

The Goose Agent Framework extends the [Goose](https://goose-docs.ai/) agent runtime into a production-ready, multi-agent system for software engineering teams. It combines:

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

- The **plugin** is a git-installable bundle of Markdown/JSON skills and agents. It is loaded with `goose plugin install`.
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

Expected result: all green, with 100% line/branch/function/statement coverage for `packages/framework-core/` and every `extensions/*/src/` directory.

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

- **100% coverage** is enforced for every package that contains source code. No PR may lower coverage.
- **Red-build policy ("Ralph Wiggum" loop):** any failing typecheck, lint, test, or coverage gate blocks merge. The author must fix the root cause, re-run the full pipeline green, and obtain maintainer/QA approval.

See [`adrs/adr-023-100-percent-test-coverage-gate.md`](./adrs/adr-023-100-percent-test-coverage-gate.md) and [`adrs/adr-024-red-build-policy-ralph-wiggum-loop.md`](./adrs/adr-024-red-build-policy-ralph-wiggum-loop.md).

---

## Running locally with Goose

### 1. Install the plugin

```bash
goose plugin install file://$(pwd)
# or after pushing to GitHub:
# goose plugin install https://github.com/dr-pabs/managed-service-minions.git
```

The plugin content lands in `~/.agents/plugins/managed-service-minions/`.

### 2. Build the MCP extensions

```bash
pnpm build
```

### 3. Register the extensions in Goose config

Add to `~/.config/goose/config.yaml` (exact schema may vary by Goose version):

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

> **Note:** `--with-builtin` does not override disabled config entries in Goose 1.37.0. Enable the extensions in config.

### 4. Run a one-off task

```bash
goose run \
  --with-extension "node extensions/mcp-toolshed/dist/index.js" \
  --with-builtin developer,analyze,chatrecall,orchestrator \
  -t "@minions review PR #342"
```

### 5. Validate recipes

Recipes inside a plugin’s `commands/` directory are not auto-discovered. Validate or run them by path:

```bash
goose recipe validate ~/.agents/plugins/managed-service-minions/commands/daily-pr-review.yaml
export GOOSE_RECIPE_PATH="$HOME/.agents/plugins/managed-service-minions/commands"
goose recipe list
```

---

## Testing

| Layer | Command | Notes |
|---|---|---|
| Unit | `pnpm test --coverage` | 100% thresholds on `packages/` and `extensions/` |
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

The implementation plan is in [`docs/execplan/execution-plan.md`](./docs/execplan/execution-plan.md).

| Milestone | Status | Description |
|---|---|---|
| **Milestone 0** | ✅ Complete | Bootstrap plugin + MCP monorepo, build/test/lint pipeline, 100% coverage gates |
| **Milestone 1** | ✅ Complete | MCP toolshed wiring, agent prompts, SQLite session store, first end-to-end minion dispatch |
| **Milestone 2** | ✅ Complete | Orchestrator skill, DAG decomposition, structured output schemas, prompt-quality harness |
| **Milestone 3** | ✅ Complete | GitHub/ADO/ServiceNow/Jira pipelines; ticket→fix→PR; approval gating |
| **Milestone 4** | ✅ Complete | Azure infrastructure, Container Apps, Service Bus, observability, dashboard, CI/CD |
| **Milestone 5** | ✅ Build artifacts complete | Integration/E2E/acceptance tests, DR/handoff/security runbooks, performance/chaos scaffolding; staging validation and formal sign-off remain for production handoff |

---

## Contributing

1. Open an issue or discussion before large changes.
2. Keep changes aligned with the ADRs and design docs.
3. Follow the monorepo scripts: `pnpm typecheck`, `pnpm build`, `pnpm lint`, `pnpm test --coverage`.
4. Maintain 100% coverage for any new TypeScript source.
5. Get maintainer/QA approval after any red-build fix.

See [`AGENTS.md`](./AGENTS.md) for agent-focused conventions.

---

## License

[MIT](./LICENSE) — or replace with your organization’s license.
