# AGENTS.md

## Project overview

This folder contains the design, delivery, governance, and implementation scaffolding for the Minions Agent Framework. The primary focus remains specification- and architecture-oriented, but the repository now includes runnable TypeScript packages and MCP extensions.

Primary source documents include:
- `./docs/high-level-design.md` — system architecture and core capabilities
- `./docs/delivery-specification.md` — scope, workstreams, phases, and acceptance criteria
- `./docs/testing-strategy.md` — test pyramid, integration plans, and quality controls
- `./docs/agent-led-development.md` — agent/role mapping and operating model
- `docs/low-level-design.md` — low-level design covering Goose primitives and framework additions
- `docs/execplan/execution-plan.md` — living execution plan for implementation
- `docs/runbooks/` — operational runbooks for disaster recovery, production handoff, and security review
- `adrs/` — architecture decisions and governance rationale

When making changes, prefer to keep these artifacts aligned with one another and with the ADRs.

## What matters most here

1. Preserve the existing architecture narrative.
   - Keep the design docs consistent with the current delivery scope.
   - If a change affects runtime behavior, security, observability, or deployment assumptions, update the related design/spec documents too.

2. Respect the governance model.
   - This project explicitly uses human approval for destructive or high-risk actions.
   - Do not propose production changes, secret handling, or deployment actions without that guardrail.

3. Keep documentation grounded in evidence.
   - Prefer citing existing docs, ADRs, and current design decisions over inventing new assumptions.
   - When you add new guidance, make it specific to this repository’s architecture and delivery goals.

## Build, test, and validation guidance

The repository now contains both design/spec artifacts and runnable scaffolding:

- Root `package.json`, `pnpm-workspace.yaml`, and `tsconfig.json` define a pnpm monorepo.
- `packages/framework-core/` — shared TypeScript library.
- `extensions/*/` — MCP server extensions (mcp-toolshed, slack-bot, teams-bot, agent-dashboard).
- `infra/` — infrastructure as code (Terraform) and tests.
- `test/` — unit, integration, E2E, acceptance, and prompt-quality harnesses.
- `test/performance/` — k6 load-test skeleton for staging performance validation.
- `test/chaos/` — shell scripts for operational chaos tests.
- `docs/runbooks/` — operational runbooks for DR, handoff, and security review.
- `mocks/` — lightweight mock MCP servers (GitHub, Azure DevOps, ServiceNow, Jira, shell) for local development via docker-compose.

Common commands (after `pnpm install`):
- `pnpm typecheck` — run TypeScript `--noEmit` across the monorepo.
- `pnpm build` — build all packages and extensions.
- `pnpm lint` — run ESLint across the monorepo.
- `pnpm test` — run unit tests in each package.
- `pnpm test:integration` — run integration tests.
- `pnpm test:e2e` — run E2E smoke tests.
- `pnpm test:prompts` — run prompt-quality harness.

## Local Development

### Quick start

1. Install prerequisites: Node.js >= 20, pnpm 10.10.0, Docker.
2. Install dependencies: `pnpm install`
3. Start the local stack: `pnpm dev`

This builds all TypeScript packages and starts `docker compose --profile dev up --build`, which brings up mock MCP servers for GitHub (port 3001), Azure DevOps (3002), ServiceNow (3003), Jira (3004), and shell (3005). The mock servers return canned data so the full orchestration pipeline can be exercised locally without cloud credentials or a live Goose process. SQLite session/audit storage uses a local file at `/tmp/minions-dev.sqlite` (configured by `scripts/dev.sh`).

### Without Docker

If you have the Goose CLI installed, you can also run `goose serve --port 3284 --with-extension "node extensions/mcp-toolshed/dist/server.js"` and interact via the `goose` CLI directly. See the README's "Running locally with Minions" section for details.

Quality gates:
- **Coverage thresholds** are required for all runnable TypeScript code in `packages/` and `extensions/`: 95% branch and line coverage, 100% function and statement coverage per package. The CI pipeline fails if any package drops below its configured threshold. See `./docs/testing-strategy.md` and `./adrs/adr-023-100-percent-test-coverage-gate.md` (including its 2026-07-09 amendment) for the full coverage policy and why branches/lines were lowered from 100%.
- **Red build policy ("Ralph Wiggum" loop):** a failing CI check blocks merge until the root cause is fixed, the full pipeline is green, and a maintainer/QA reviewer approves the fix. No bypasses.

For day-to-day work here:
- Treat the Markdown docs as the primary deliverables.
- Keep design docs (`./docs/high-level-design.md`, `./docs/logical-architecture.md`, `./docs/physical-architecture.md`, `docs/low-level-design.md`, `docs/execplan/execution-plan.md`) aligned with any code changes.
- If you add a new runnable subproject, create a package-local `AGENTS.md` there and use that package’s native build/test commands.
- If you are asked to validate a change, verify the relevant Markdown or spec references and keep the surrounding docs consistent.

## Writing and style guidelines

- Use clear Markdown structure with concise headings and bullet points.
- Keep technical terminology consistent with the existing design language in the repo.
- Preserve links to related docs and ADRs when referencing decisions or dependencies.
- Prefer incremental updates over broad rewrites unless the task explicitly asks for a major redesign.
- When updating architecture or delivery notes, keep the status/date fields accurate if they already exist in the file.

## Security and operational considerations

- Never add secrets, tokens, credentials, or private endpoints to documentation.
- Keep security and governance language aligned with the ADRs, especially around least privilege, allowlisting, and human oversight.
- Avoid suggesting unsafe automation or destructive actions without explicit approval paths.

## ExecPlans

When writing complex features or significant refactors, use an ExecPlan (as described in .agent/PLANS.md) from design to implementation.

## Extra instructions

- If this folder later grows into multiple runnable packages or services, place another AGENTS.md in each subproject so the nearest file takes precedence.
- If you introduce new implementation work, document the architectural impact in the relevant design/spec file before or alongside the code change.
- Prefer traceability: changes should be explainable through the existing design docs, ADRs, and delivery goals.
