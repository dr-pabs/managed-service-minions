# Deliver the Minions Agent Framework v1

> This ExecPlan is a living document. Maintain it in accordance with `.agents/PLANS.md`. It is intended to be self-contained: a contributor who has only this file and the current working tree should be able to implement the framework end-to-end.

## Purpose / Big Picture

After this work, a user can mention `@minions` in Slack or Microsoft Teams and ask for real engineering tasks — for example, "Review PR #342", "What's the status of INC00421?", or "Fix work item #567 and create a PR". Goose, guided by the framework's plugin, classifies the request, delegates to specialized sub-agents ("minions"), calls GitHub, Azure DevOps, ServiceNow, Jira, filesystem, and shell tools through a governed MCP toolshed, and returns a structured, traceable answer back to the chat channel. Operators can reconstruct every session from a correlation tree, audit every tool call, approve destructive actions, and observe health and cost through Azure dashboards.

This plan turns the design documents in this repository — `../delivery-specification.md`, `../high-level-design.md`, `../testing-strategy.md`, `../agent-led-development.md`, the ADRs, and the related architecture notes — into a working, deployed system.

## Progress

- [x] (2026-06-14 15:58Z) Draft ExecPlan in `docs/execplan/execution-plan.md`.
- [x] (2026-06-14) Confirmed with live CLI: the orchestrator is implemented as a Goose skill/agent, not a standalone service. The framework is a Goose **plugin** (skills, agents, commands, rules, hooks) plus **MCP extensions** for the toolshed and chat ingress.
- [x] (2026-06-14) Milestone 0 — Bootstrap plugin repository and MCP extension monorepo.
  - Scaffolding created: `.plugin/`, `agents/`, `skills/`, `commands/`, `rules/`, `hooks/`, `packages/framework-core/`, `extensions/mcp-toolshed/`, `extensions/slack-bot/`, `extensions/teams-bot/`, `extensions/agent-dashboard/`, `infra/`, `test/`, `.github/workflows/`.
  - Root toolchain: pnpm workspaces, TypeScript ESM/NodeNext, ESLint 9 flat config, Prettier, Jest with ESM/ts-jest.
  - Quality gates enforced: 100% coverage thresholds for every package with source code; CI runs `typecheck → build → lint → test --coverage`; red-build/Ralph Wiggum loop documented in ADR-024.
  - `packages/framework-core` implemented and tested (token budgets, errors, correlation IDs, platform formatter) at 100% coverage.
  - `extensions/mcp-toolshed` implemented and tested (config, allowlists, rate limiter, circuit breaker, SQLite/memory store, MCP adapter, `executeTool`, MCP server handlers) at 100% coverage.
  - `extensions/slack-bot`, `extensions/teams-bot`, `extensions/agent-dashboard` implemented and tested at 100% coverage.
  - Full local pipeline passes: `pnpm typecheck && pnpm build && pnpm lint && pnpm test --coverage`.
- [x] (2026-06-15) Milestone 1 — Phase 1 Foundation: full agent prompts, SQLite session store wired to Goose, and first end-to-end minion dispatch.
  - Delivered: all five minion agent prompts (`code-explorer`, `code-reviewer`, `pr-crafter`, `ticket-analyst`, `security-auditor`) plus `orchestrator.md` with role, model tier, allowlist, output schema, and system prompt.
  - Delivered: framework skills (`intent-classification`, `task-decomposition`, `delegate-management`, `result-synthesis`, `approval-gating`) with invocation rules, inputs, and outputs.
  - Delivered: `rules/allowlists.yaml`, `rules/governance.yaml`, and `rules/models.yaml` with per-minion tool lists, destructive-action gating, rate limits, path scopes, fallback behavior, and tier budgets.
  - SQLite session store implementation exists in `extensions/mcp-toolshed/src/store.ts` (memory + SQLite backends) and is used by the toolshed for audit logs, minion runs, approvals, and caching.
- [x] Milestone 2 — Phase 2 Minion Framework: orchestrator skill, intent classification, DAG decomposition, structured output schemas, and prompt-quality harness.
  - Agent prompts, skills, rules, recipes, and structured output schemas implemented and merged.
  - Prompt-quality harness added under `test/src/prompt-quality/` with 100% test coverage; supports required sections, forbidden phrases, length bounds, and baseline/candidate comparison.
- [x] Milestone 3 — Phase 3 Ticket and Review Pipelines: GitHub, Azure DevOps, ServiceNow, and Jira integrations; ticket→fix→PR flow; human approval gates.
  - [x] (2026-06-15) GitHub MCP server extension implemented in `extensions/mcp-github/` with PR list, PR details, diff, create, and merge tools; 100% TypeScript test coverage.
  - [x] (2026-06-15) Azure DevOps MCP server extension implemented in `extensions/mcp-azure-devops/` with PR and work-item tools; 100% TypeScript test coverage.
  - [x] (2026-06-15) ServiceNow MCP server extension implemented in `extensions/mcp-servicenow/` with list, get, update, and create incident tools; 100% TypeScript test coverage.
  - [x] (2026-06-15) Jira MCP server extension implemented in `extensions/mcp-jira/` with issue list, get, update, create, and comment tools; 100% TypeScript test coverage.
  - [x] (2026-06-15) Runtime approval gate implemented in `extensions/mcp-toolshed/` with `waitForApproval`, `resolveApproval`, `resolve_approval` MCP tool, timeout/denial handling, and durable `pending_approvals` persistence; 100% TypeScript test coverage.
  - [x] (2026-06-15) `commands/ticket-to-pr.yaml` recipe orchestrates Ticket Analyst → Code Explorer → PR Crafter → GitHub PR creation with human approval gate.
- [x] Milestone 4 — Phase 4 Platform Hardening: Terraform infrastructure modules, Container Apps, Service Bus, AI Foundry, observability, dashboard, CI/CD, and `terraform test`.
  - [x] Terraform modules and `terraform test` suite implemented for dev environment, including dashboard and toolshed Container Apps with health probes.
  - [x] Dockerfiles and container image build/push workflow (`.github/workflows/container-build.yml`) implemented for all runnable extensions.
  - [x] CI triggers fixed (`.github/workflows/ci.yml`) to run on `packages/**`, `extensions/**`, `commands/**`, `agents/**`, `skills/**`, `rules/**`, `test/**`, and root toolchain changes.
  - [x] Dashboard backend (`extensions/agent-dashboard/`) implemented with sessions, runs, correlation tree, pending approvals, and health endpoints; 100% TypeScript test coverage.
  - [x] Real Slack (`extensions/slack-bot/`) and Teams (`extensions/teams-bot/`) ingress bots with signature verification, event parsing, thread-aware replies, and shared `IngressRunner` interface; 100% TypeScript test coverage.
- [x] Milestone 5 — Acceptance, disaster recovery, performance/chaos validation, and production handoff.
  - [x] Integration test suite added under `test/src/integration/` exercising the toolshed end-to-end with mock MCP servers.
  - [x] E2E test suite added under `test/src/e2e/` validating the plugin manifest, orchestrator prompt, and ticket-to-pr recipe.
  - [x] Acceptance harness validates recipe schema and approval-gating language.
  - [x] Disaster-recovery, production-handoff, and security-review runbooks added under `docs/runbooks/`.
  - [x] Performance and chaos test scaffolding added under `test/performance/` and `test/chaos/`.
  - [ ] Real-environment validation (staging performance/chaos runs), backup/restore drill, dependency/container scanning, and formal security sign-off remain for the production handoff gate.
- [x] (2026-06-17) Gap 9 — model provider configuration:
  - All hardcoded model names removed from `rules/models.yaml`. Each tier now has empty `deployment` and `provider` fields with full operator documentation. Tier names (`fast`, `reasoning`, `code_review`, `code_generation`, `security`) remain stable code abstractions.
  - `infra/terraform/variables.tf` extended with `model_provider_keys` (sensitive `map(string)`, injects API keys verbatim as container secrets) and `model_provider_endpoints` (non-sensitive `map(string)`, injects base URL overrides as container env vars). Uses native provider env var names as keys (e.g., `ANTHROPIC_API_KEY`, `OLLAMA_HOST`).
  - `infra/terraform/modules/ai_foundry/variables.tf` and `main.tf` updated: `format` field added to deployment objects (`"OpenAI"` for Azure OpenAI Service, `"Azure"` for AI Foundry catalog models such as Claude, Deepseek, Qwen, MiMo).
  - `infra/terraform/main.tf` updated: `env_vars` and `secrets` now use `merge()` to inject `model_provider_endpoints` and `model_provider_keys` alongside the fixed platform secrets — no special naming conventions required.
  - `infra/terraform/environments/dev/terraform.tfvars` rewritten as a clean operator template: deprecated gpt-4o-mini/gpt-4.1 entries removed, all fields replaced with commented examples showing structure for Azure OpenAI, AI Foundry catalog (Claude, Deepseek, Qwen), Ollama, and vLLM. Operators fill in current model names at deploy time; no model names are committed.
- [x] (2026-06-17) Gap 10 — code-writer and test-writer agents:
  - **code-writer** (`agents/code-writer.md`): implements bug fixes, features, and unit tests. Tier: `code_generation`, budget: 50 000 tokens. Granted `shell.execute` access via `rules/allowlists.yaml` (shell server alias) to run tests before returning. Path scope: `/repo` with standard deny list. Output schema: `schemas/code-writer-output.json`.
  - **test-writer** (`agents/test-writer.md`): writes integration, acceptance, and E2E tests only — explicitly does not touch implementation files and does not write unit tests. Tier: `code_generation`, budget: 40 000 tokens. Same `shell.execute` and filesystem access as code-writer; implementation-file write restrictions enforced at the agent prompt level. Output schema: `schemas/test-writer-output.json`.
  - Both agents added to `rules/models.yaml` `agents:` section and `rules/allowlists.yaml` (allowlists + path_scopes).
  - `extensions/agent-dashboard/src/dashboard.ts` extended with `GET /api/config` endpoint returning `{ agentTypes: string[] }` and optional `agentTypes` parameter on `startDashboardServer`. Dashboard tests updated: two new tests assert the default empty case and all 7 agent types; 20 tests pass at 100% coverage.
- [x] (2026-06-17) Gap 7 — async/proactive messaging:
  - **Slack** (`extensions/slack-bot/src/slack-bot.ts`): replaced the synchronous `handleSlackMessage` pattern with a fire-and-acknowledge pattern. Both `app_mention` and `message` (DM) handlers now: (1) `await say(ack)` immediately so Bolt returns HTTP 200 before the 3-second Slack window closes, suppressing duplicate retries; (2) `void postSlackResponse(...)` fires the Goose run in the background; (3) the result is posted proactively via `client.chat.postMessage({ channel, thread_ts, text, blocks? })`. `SlackPoster` interface (duck-typed `WebClient` subset) added for testability.
  - **Teams** (`extensions/teams-bot/src/teams-bot.ts`): replaced the synchronous `handleTeamsMessage` pattern. The message handler now: (1) captures the conversation reference via `TurnContext.getConversationReference(activity)` before the turn ends; (2) `await context.sendActivity(ack)` sends the immediate acknowledgement; (3) `void postTeamsResponse(...)` fires the Goose run in the background; (4) the result is delivered proactively via `adapter.continueConversation(conversationRef, callback)`. `TurnContext` imported as a value (not a type-only import) to access the static method.
  - Both extensions maintain 100% line/branch/function/statement coverage. New test cases cover: ack-before-run, proactive result, proactive error, empty-array blocks, missing channel field.
- [x] (2026-06-17) Gap fixes — production blockers 4–6 resolved:
  - [x] Gap 4: Private endpoints and private DNS zones added to `infra/terraform/main.tf` for Key Vault (`vault`), Storage (`blob`, `table`, `file`), and Service Bus (`namespace`) — each with an `azurerm_private_dns_zone`, `azurerm_private_dns_zone_virtual_network_link`, and `azurerm_private_endpoint` with a `private_dns_zone_group`. All five services are now privately accessible from Container Apps and not publicly reachable. Terraform test `private_endpoints_secure_all_services` added.
  - [x] Gap 5: `infra/terraform/modules/storage/main.tf` extended with `azurerm_storage_share.sqlite_data` (5 GB quota). `container_apps` module extended with `azurerm_container_app_environment_storage.sqlite` and `volume`/`volume_mount` blocks in all five container apps mounting the share at `/data`. `SQLITE_PATH=/data/sessions.sqlite` wired into `env_vars` in root `main.tf`. Terraform test `sqlite_volume_is_mounted_in_all_apps` added.
  - [x] Gap 6: `extensions/agent-dashboard/src/dashboard.ts` extended with a `GET /` route that serves a self-contained HTML/JS dashboard UI (`DASHBOARD_HTML` constant). The UI shows live sessions, minion runs per session, pending approvals, and a correlation tree; auto-refreshes every 5 seconds. `htmlResponse` helper added. All three test suites updated; 100% TypeScript coverage maintained.
- [x] (2026-06-17) Gap fixes — production blockers 1–3 resolved:
  - [x] Gap 1: `createEchoRunner` replaced with `createGooseRunner` in both `extensions/slack-bot/src/index.ts` and `extensions/teams-bot/src/index.ts`. `GooseRunner` implemented in `packages/framework-core/src/goose-runner.ts`; POSTs to `GOOSE_SERVE_URL/reply` (default `http://localhost:3284`); injectable `fetch` for testing; 100% coverage across all branches and functions.
  - [x] Gap 2: Terraform `variables.tf` extended with 9 new sensitive variables (`slack_bot_token`, `slack_signing_secret`, `microsoft_app_id`, `microsoft_app_password`, `github_token`, `azure_devops_pat`, `servicenow_api_key`, `jira_api_token`, `goose_serve_url`). `main.tf` expanded: secrets map now includes all 8 platform/integration tokens plus `GOOSE_SERVE_URL` env var; Key Vault Secrets User role added for `dashboard` and `toolshed` identities; Storage Table Data Contributor added for `toolshed`, `dashboard`, `slack_bot`, `teams_bot`; Cognitive Services OpenAI User added for `toolshed` and `dashboard`.
  - [x] Gap 3: `extensions/orchestrator/Dockerfile` created — multi-stage build that installs Goose CLI binary, builds `mcp-toolshed`, copies the framework plugin, and runs `goose serve --port 3284 --with-extension node /app/toolshed/index.js`. Added `orchestrator` entry to `.github/workflows/container-build.yml` build matrix.

## Remaining Work

The framework is functionally complete, all TypeScript packages hit the 100% coverage gate, and the operational runbooks and test scaffolding are in place. The remaining work is real-environment validation and organizational sign-off before production handoff:

### CI/CD and Deployment

1. Add a deployment workflow that updates Azure Container Apps with newly pushed images.
2. Add dependency audit, secret scanning, and container image vulnerability scanning to CI.

### Terraform Platform Hardening

1. ~~Commit a default `ai_model_deployments` configuration for dev~~ — Resolved 2026-06-17 (Gap 9): `terraform.tfvars` rewritten as operator template; no model names hardcoded.
2. Add staging and prod environment directories under `infra/terraform/environments/`.
3. Add geo-redundant storage for SQLite state (backup/restore runbook and policy are already documented).
4. Add Log Analytics queries and/or Grafana dashboard definitions for minion status, tool-call audit, and cost.

### Chat Ingress and Dashboard

1. Add interactive approval buttons/cards to Slack and Teams bot responses.
2. Optionally serve a basic HTML/JS frontend from `extensions/agent-dashboard`.
3. ~~Add async/proactive messaging~~ — Resolved 2026-06-17 (Gap 7): fire-and-acknowledge pattern implemented in both Slack and Teams bots; proactive delivery via `client.chat.postMessage` and `adapter.continueConversation` respectively.

### Runtime Governance and Approvals

1. Integrate approval requests with Slack/Teams interactive messages and the dashboard UI.

### Infrastructure Gaps (next priority)

The following infrastructure gaps were identified in the 2026-06-17 gap analysis and must be addressed before production:

4. ~~Private endpoints & DNS~~ — Resolved 2026-06-17; see Progress above.
5. ~~SQLite volume mounts~~ — Resolved 2026-06-17; see Progress above.
6. ~~Dashboard frontend~~ — Resolved 2026-06-17; see Progress above.

### Integration, Acceptance, and Handoff

1. Validate the `ticket-to-pr` recipe end-to-end against a real repository and ticket system (or recorded mocks).
2. Add prompt-quality baselines for the new recipes.
3. Run performance and chaos tests against the staging environment.
4. Execute a documented backup/restore drill.
5. Obtain security review sign-off.

## Surprises & Discoveries

- **Goose "plugin" vs "extension" are distinct packaging concepts in the CLI.** A *plugin* is a git-installable bundle of skills, agents, commands, rules, and hooks (manifested by `.plugin/plugin.json`). An *extension* is an MCP server that provides tools, loaded via `--with-extension`, `--with-streamable-http-extension`, or config. The framework therefore ships as a **plugin** for orchestrator behavior and agent prompts, plus **MCP extensions** for the toolshed and chat-platform ingress.
  - Evidence: `goose plugin --help` only supports `install <git-url>` / `update`. `goose run --help` supports `--with-extension <CMD>`, `--with-streamable-http-extension <URL>`, and `--with-builtin <NAME>`. Example plugin `jezweb/office-town-plugin` has `.plugin/plugin.json`, `agents/`, `skills/`, `commands/`, `rules/`, `hooks/`.

- **`goose plugin install` accepts git URLs or local paths; it does not register MCP servers, recipes, or code packages from the plugin.** The plugin content is Markdown/JSON skill material. Any runnable code (MCP extensions) must be installed and registered separately.
  - Evidence: `goose plugin install` only copies the plugin tree into `~/.agents/plugins/`. `office-town-plugin` ships recipes in `commands/`, but those recipes are not auto-discovered, and the plugin has no MCP server directory.

- **`delegate` and `load` are provided by the built-in `Summon (delegation)` extension and are enabled by default.** `delegate` spawns sub-agents; `load` pulls a skill or resource into the current session context. The orchestrator agent can therefore instruct Goose to spawn minions via `delegate`, load framework skills via `load`, and collect results by inspecting the sub-agent session with `view_session` or from the persisted `SessionStore`.
  - Evidence:
    ```text
    goose run --with-builtin developer -t "List every tool available in your tool specification. Print each tool name on its own line. No commentary."
    goose run --with-builtin developer -t "Use the delegate tool to spawn a sub-agent that runs 'ls' and returns the result"
    ```
    Output showed `delegate` and `load` from Summon, plus `shell` and `tree` from Developer. `delegate` spawned a sub-agent that ran `shell: ls` and returned `Contents`.

- **`delegate(async: true)` inherits the parent's extensions, while `start_agent` creates bare agents with no inherited tools.** Minions dispatched with `delegate` receive shell, analyze, and the MCP toolshed because they inherit the orchestrator's extension set. Agents spawned with `start_agent` have none of these tools.
  - Evidence: A `start_agent` session failed to run `ls` because it had no shell tools. A `delegate(async: true)` dispatched sub-agent succeeded, and `list_sessions`/`view_session` showed the running session. `interrupt_agent` provides cancellation.

- **The built-in `Orchestrator` extension exposes `list_sessions`, `view_session`, and `interrupt_agent`, but it is disabled by default.** It provides a control plane for monitoring and cancelling active minion sessions; it must be enabled in `~/.config/goose/config.yaml` to be used.
  - Evidence: `goose info` shows `Orchestrator` as a disabled built-in extension. Live testing used `list_sessions`, `view_session`, and `interrupt_agent` after enabling it.

- **The built-in `Chat Recall` extension provides session memory, but it is disabled by default.** The orchestrator depends on it to load prior context so downstream minions can reuse upstream results without re-querying.
  - Evidence: `goose info` shows `Chat Recall` as disabled. A tool-listing run with `--with-builtin developer` did not expose chat-recall tools because the extension was disabled.

- **`--with-builtin <name>` adds an extension to a run, but it does not override a disabled config entry in Goose 1.37.0.** If an extension is disabled in `~/.config/goose/config.yaml`, passing it via `--with-builtin` is not enough; it must be enabled in config or Goose must be started with `--no-profile`.
  - Evidence: With `chatrecall: enabled: false` in config, `goose run --with-builtin developer` only exposed Developer tools. `chatrecall` remained absent until enabled in config.

- **The built-in `Developer` extension exposes shell, file, edit, write, and tree tools.** These are the filesystem and shell primitives that minions need for repo exploration and editing.
  - Evidence: Tool listing with `--with-builtin developer` returned `shell`, `tree`, `edit`, and `write`. The `Skills` extension (enabled by default) provides `load_skill` separately.

- **The built-in `Analyze` extension exposes tree-sitter code-analysis tools.** This covers code parsing/structural queries without requiring a separate MCP server.
  - Evidence: `goose info` lists `Analyze` as an enabled built-in extension. The tool listing included `analyze`.

- **The built-in `Apps` extension exposes `apps__create_app`, `apps__iterate_app`, `apps__list_apps`, and `apps__delete_app`.** This is the dashboard/UI scaffolding capability; no external MCP server is required for simple app creation.
  - Evidence: Tool listing with `--with-builtin developer` returned the four `apps__*` tools alongside `delegate`, `load`, `shell`, etc.

- **The built-in `Todo` extension exposes `todo__todo_write` for task tracking.** While not central to the framework, it confirms that Goose has lightweight progress-tracking primitives available by default.
  - Evidence: Tool listing returned `todo__todo_write`.

- **Goose plugins cannot bundle MCP extensions.** The plugin format supports skills, agents, commands, rules, and hooks only. MCP extensions must be configured separately in `~/.config/goose/config.yaml`, via CLI flags (`--with-extension`, `--with-streamable-http-extension`), or via deeplinks. The framework is therefore delivered as two artifacts: a plugin for orchestrator behavior and agent prompts, and one or more MCP extensions for the toolshed and chat ingress.
  - Evidence: Goose docs state plugins provide skills/hooks; extensions are MCP servers configured separately. The `office-town-plugin` repo contains no MCP server directory, and there is no documented plugin path for auto-registering extensions.

- **Recipes shipped in a plugin's `commands/` directory are not auto-discovered by `goose recipe list`.** `goose recipe list` only scans the current directory, `$GOOSE_RECIPE_PATH`, `~/.config/goose/recipes/`, `./.goose/recipes/`, and `$GOOSE_RECIPE_GITHUB_REPO`. Plugin recipes must be run/validated by full path, copied/symlinked into a scanned directory, or added to `GOOSE_RECIPE_PATH`.
  - Evidence: The `office-town-plugin` recipes live in `~/.agents/plugins/office-town/commands/`, but `goose recipe list` found none until `GOOSE_RECIPE_PATH` pointed at that directory. `goose run --recipe ~/.agents/plugins/office-town/commands/<recipe>.yaml` worked directly.

## Decision Log

- **Decision:** Implement `GooseRunner` in `packages/framework-core` (shared) rather than duplicating it in each bot extension.
  - **Rationale:** The `IngressRunner` interface is already defined in `framework-core`. Placing `GooseRunner` there keeps the coupling symmetrical — both bots depend on `framework-core` and get the runner for free. No code duplication.
  - **Date/Author:** 2026-06-17 / Claude Sonnet 4.6

- **Decision:** Inject `fetch` as a config parameter rather than monkey-patching `globalThis.fetch` or using a DI container.
  - **Rationale:** Node 20+ has native `fetch`; the default production path requires no extra dependency. Injection keeps tests pure: pass a `jest.fn()` rather than stubbing globals. The one test that exercises the global-fetch path assigns to `globalThis.fetch` temporarily and restores it in a `finally` block.
  - **Date/Author:** 2026-06-17 / Claude Sonnet 4.6

- **Decision:** Place private endpoint and DNS zone resources in root `main.tf` rather than inside the `networking` module.
  - **Rationale:** Private endpoints reference IDs from storage, keyvault, and service_bus modules. Putting them in `networking` would require passing those IDs as variables, creating cross-module coupling. Root resources can reference all module outputs directly; Terraform resolves the dependency graph automatically.
  - **Date/Author:** 2026-06-17 / Claude Sonnet 4.6

- **Decision:** Mount a single Azure File Share at `/data` in all five container apps and use `SQLITE_PATH=/data/sessions.sqlite` for all.
  - **Rationale:** All five apps (orchestrator, slack-bot, teams-bot, toolshed, dashboard) use SQLite for session state. Sharing one File Share simplifies provisioning, and using the same path avoids per-app environment variable variation. The share is 5 GB, which is sufficient for v1 session volumes.
  - **Date/Author:** 2026-06-17 / Claude Sonnet 4.6

- **Decision:** Serve the dashboard HTML UI as an inline constant in `dashboard.ts` rather than a static file served from disk.
  - **Rationale:** The dashboard server is a zero-dependency Node.js HTTP server (no Express, no static-file middleware). Inlining the HTML avoids working-directory assumptions in the container, keeps tests hermetic, and requires no change to the Dockerfile.
  - **Date/Author:** 2026-06-17 / Claude Sonnet 4.6

- **Decision:** Never hardcode model names or versions anywhere in the codebase; tier names are stable, specific models are operator configuration.
  - **Rationale:** Model names and version strings rotate rapidly across all providers (OpenAI, Anthropic, Deepseek, ZhipuAI, etc.). Hardcoding them creates immediate technical debt and misleads operators who have different model access. Tier names (`fast`, `reasoning`, `code_review`, `code_generation`, `security`) are semantically stable; the model behind each tier is chosen by the operator at deploy time via `rules/models.yaml` and `terraform.tfvars`.
  - **Date/Author:** 2026-06-17 / Claude Sonnet 4.6

- **Decision:** Use native provider env var names as keys for `model_provider_keys` and `model_provider_endpoints`.
  - **Rationale:** Provider SDKs look for specific env vars (e.g., `ANTHROPIC_API_KEY`, `OLLAMA_HOST`). Using those same names as map keys means the operator sees a single canonical location to set them, and the container picks them up with zero extra mapping or naming conventions.
  - **Date/Author:** 2026-06-17 / Claude Sonnet 4.6

- **Decision:** Expand all container app secrets in the shared `secrets` map rather than building per-app secret maps.
  - **Rationale:** The current Terraform `container_apps` module accepts a single `secrets` map applied to all apps. Adding per-app maps would require significant module surgery. All containers getting all secrets is over-privileged but acceptable for v1; the Key Vault RBAC ensures only containers with the correct managed identity can actually read the underlying secret values.
  - **Date/Author:** 2026-06-17 / Claude Sonnet 4.6

- **Decision:** Deliver the framework as a Goose **plugin** plus **MCP extensions**, not as a monolithic TypeScript service.
  - **Rationale:** The live Goose CLI separates plugins (skills/agents/hooks) from extensions (MCP tool servers). The orchestrator is a skill/agent that instructs Goose to classify intent, build a DAG, and call `delegate`. The MCP toolshed, Slack bot, Teams bot, and dashboard backend are MCP extensions that expose tools to the agent. This matches Goose's native packaging model.
  - **Date/Author:** 2026-06-14 / Kimi Code CLI

- **Decision:** Use a pnpm monorepo for the MCP extensions, and Markdown-based skills/agents for the plugin content.
  - **Rationale:** MCP extensions are implemented in TypeScript using the MCP SDK. The plugin content (agents, skills, commands, rules, hooks) is Markdown/JSON per the Goose plugin format. Separating them lets each part use the right tooling.
  - **Date/Author:** 2026-06-14 / Kimi Code CLI

- **Decision:** Use `better-sqlite3` for local SQLite session state, `@azure/data-tables` for the tool-call audit log, and `@azure/storage-blob` for large artifacts.
  - **Rationale:** Matches ADR-009 (SQLite + Table Storage + Blob, rejecting Cosmos DB). `better-sqlite3` is synchronous and embedded, which keeps the toolshed simple; the Azure SDKs are the official clients for the chosen stores.
  - **Date/Author:** 2026-06-14 / Kimi Code CLI

- **Decision:** Build Slack first, then Teams, while keeping both adapters behind a shared platform-agnostic response formatter.
  - **Rationale:** ADR-014 elevates Teams to a Phase 1 peer priority, but Teams bot registration and the Microsoft 365 Agent SDK have more moving parts than Slack Bolt. Implementing Slack first proves the adapter contract; the Teams adapter reuses the same orchestrator payload and only differs in rendering.
  - **Date/Author:** 2026-06-14 / Kimi Code CLI

- **Decision:** Enable live "cancel running minion" in the dashboard via the built-in `Orchestrator` extension's `interrupt_agent` tool.
  - **Rationale:** The built-in `Orchestrator` extension exposes `interrupt_agent`, which cancels a busy agent session. This removes the earlier dependency on a Goose core `cancel(taskId)` primitive and allows the Live Minion Status dashboard view to offer a Cancel button in v1.
  - **Date/Author:** 2026-06-14 / Kimi Code CLI

- **Decision:** Support multi-tenancy in config from the start, but ship with a single default team configuration.
  - **Rationale:** ADR-022 describes shared-instance hard isolation. Building `team_id` into sessions, storage prefixes, and governance lookup from the beginning avoids a painful refactor later, while the first deployment uses one team and one `governance.yaml`.
  - **Date/Author:** 2026-06-14 / Kimi Code CLI

- **Decision:** Enforce per-minion token budgets and model-tier routing via the orchestrator skill's instructions and config.
  - **Rationale:** `../how-goose-works-with-llms.md` describes tier-based routing and token budgets as the primary cost-control mechanism. The orchestrator agent assigns the tier per minion type and monitors cumulative token usage from the sub-agent session transcript (`view_session`) and persisted `SessionStore`.
  - **Date/Author:** 2026-06-14 / Kimi Code CLI

- **Decision:** Implement circuit breakers in the MCP toolshed per MCP server alias.
  - **Rationale:** `../error-handling.md` specifies circuit breaker behavior: open after N consecutive failures, half-open after a timeout, close after M consecutive successes. This prevents minions from waiting on unhealthy MCP servers and gives fast-fail feedback with `retry_after`.
  - **Date/Author:** 2026-06-14 / Kimi Code CLI

- **Decision:** Use Goose built-in extensions for `delegate`, `load`, session memory, shell/files, tree-sitter analysis, and app creation; build the MCP toolshed only for external MCP servers.
  - **Rationale:** The live config shows `Summon (delegation)` provides `delegate` and `load`, `Chat Recall` provides session memory, `Developer` provides shell/files, `Analyze` provides tree-sitter, and `Apps` provides `apps__create_app` and related app tools. `Chat Recall` and `Orchestrator` are disabled by default and must be enabled in config. This avoids reimplementing core Goose capabilities. The toolshed is still required to wrap GitHub, ADO, ServiceNow, Jira, Slack, Teams, and other external MCP servers with allowlists, rate limits, and audit logging.
  - **Date/Author:** 2026-06-14 / Kimi Code CLI

- **Decision:** Use `delegate(async: true)` for all minion dispatch, and use the built-in `Orchestrator` extension only for monitoring and cancellation.
  - **Rationale:** Live testing showed `delegate` is the only tool that inherits the parent's extensions, so minions get the tools they need (developer, analyze, mcp-toolshed). `start_agent` creates bare agents with no tools. The `Orchestrator` extension's `list_sessions`, `view_session`, and `interrupt_agent` provide the control plane for monitoring live minions and cancelling stuck ones.
  - **Date/Author:** 2026-06-14 / Kimi Code CLI

- **Decision:** Ship the framework as a Goose plugin **plus separately configured MCP extensions**.
  - **Rationale:** Goose plugins can only bundle skills and hooks, not MCP servers. The toolshed and chat ingress must be MCP extensions configured in Goose's `config.yaml` (stdio cmd, HTTP URL, or deeplink). The plugin provides the orchestrator agent, minion prompts, recipes, governance rules, and hooks; the extensions provide the governed tools and platform adapters.
  - **Date/Author:** 2026-06-14 / Kimi Code CLI

- **Decision:** Use a consistent four-field error template for every user-facing failure.
  - **Rationale:** `../error-handling.md` defines the pattern: severity icon, one-line summary, cause, impact, action, and correlation ID. Following this from the start makes bot responses predictable and debuggable.
  - **Date/Author:** 2026-06-14 / Kimi Code CLI

## Outcomes & Retrospective

Not executed yet. Summarize what shipped, what remains, and lessons learned at the end of each milestone and at final completion.

## Context and Orientation

This repository is currently documentation-first. The root is `/Volumes/ExtDisk1/Minions`. The design authority lives in these files:

- `../delivery-specification.md` — scope, phases, workstreams, acceptance criteria.
- `../high-level-design.md` — logical architecture, minion definitions, data flows, storage, observability.
- `../testing-strategy.md` — test pyramid, prompt-quality harness, CI gates.
- `../agent-led-development.md` — agent/human operating model.
- `../goose-changes-required.md` — what needs a Goose core change vs. what is extension-only.
- `../goose-capabilities-and-usage.md` — Goose primitives the framework uses and ignores.
- `../how-goose-works-with-llms.md` — provider abstraction, model tiers, token budgets.
- `../logical-architecture.md`, `../physical-architecture.md`, `../azure-architecture.md`, `../dashboard-design.md` — architecture details.
- `../error-handling.md`, `../disaster-recovery.md` — failure and recovery patterns.
- `../gap-analysis.md` — what is designed and what still needs production validation.
- `../skills-and-roles.md` — team allocation by phase.
- `adrs/adr-*.md` — architecture decisions.

This plan creates a Goose **plugin** plus separately configured MCP **extensions**:

**Plugin content (skills/agents/rules/hooks):**
- `.plugin/` — `plugin.json` manifest for the framework plugin.
- `agents/` — orchestrator and minion agent prompts (`orchestrator.md`, `code-explorer.md`, `code-reviewer.md`, `pr-crafter.md`, `ticket-analyst.md`, `security-auditor.md`).
- `skills/` — reusable skills for intent classification, task decomposition, result synthesis, approval gating, error handling.
- `commands/` — slash-command recipes such as `daily-pr-review.yaml` and `ticket-poll.yaml`. Goose does not scan a plugin's `commands/` directory automatically; recipes are run/validated by path or made discoverable by copying/symlinking them into `~/.config/goose/recipes/` or setting `GOOSE_RECIPE_PATH`.
- `rules/` — governance rules, allowlists, channel registry.
- `hooks/` — lifecycle hooks (session start/end logging, backup triggers).

**MCP extensions (MCP servers, configured separately in Goose):**
- `extensions/mcp-toolshed/` — governed proxy to external MCP servers.
- `extensions/slack-bot/` — Slack ingress/egress MCP server.
- `extensions/teams-bot/` — Teams ingress/egress MCP server.
- `extensions/agent-dashboard/` — dashboard backend MCP server.

**Infrastructure and delivery:**
- `infra/terraform/` — Azure infrastructure as code.
- `test/` — unit, integration, prompt-quality, E2E, security, performance, and chaos tests.
- `.github/workflows/` — CI/CD pipelines for the plugin and the extensions.

Because Goose plugins cannot bundle MCP servers, the framework repo contains both sets of files, but users install the plugin via `goose plugin install` and then add the MCP extensions to `~/.config/goose/config.yaml` (or run them with `--with-extension`).

Key terms:

- **Goose** — the agent runtime that provides the agent loop, tool calling, sessions, and the `delegate` primitive.
- **Plugin** — a git-installable bundle of skills, agents, commands, rules, and hooks. Installed via `goose plugin install <url>`. Manifest lives at `.plugin/plugin.json`.
- **Extension** — an MCP server that provides tools to Goose. Loaded via `--with-extension <CMD>`, `--with-streamable-http-extension <URL>`, `--with-builtin <NAME>`, or config entries.
- **Minion** — a focused sub-agent spawned by the orchestrator agent as a Goose `delegate`. Each minion agent prompt defines its role, boundaries, and output schema.
- **Orchestrator** — a Goose agent/skill that receives user requests, classifies intent, decomposes complex work into a DAG of minions, manages their lifecycle, and synthesizes replies.
- **MCP toolshed** — an MCP extension that registers MCP servers, enforces per-minion allowlists and path scopes, applies rate limits, circuit breakers, and captures an audit log of every tool call.
- **MCP server** — a Model Context Protocol server that exposes tools for a backend such as GitHub, Azure DevOps, ServiceNow, Jira, filesystem, or shell.
- **Correlation ID** — a hierarchical identifier (`corr_<uuid>.<minion>.<server>-<n>`) that ties every tool call back to the originating user session (ADR-017).
- **DAG** — directed acyclic graph. Complex tasks are broken into phases; independent minions run in parallel, dependent minions wait for upstream results.
- **Adaptive Card** — a Microsoft Teams rich message format with buttons, links, and structured content. Slack uses Block Kit for the same purpose.
- **Human-in-the-loop** — destructive actions (merge, close ticket, deploy) are paused until a human approves via Slack/Teams (ADR-007).
- **chatrecall** — a Goose built-in extension (`Chat Recall`) that searches past conversations and loads session summaries. It is disabled by default in the current config; the framework requires it, so enable it in `~/.config/goose/config.yaml` (or start Goose with `--no-profile`). The orchestrator uses it so downstream minions can reuse upstream results without re-querying.
- **Summon (delegation)** — the Goose built-in extension that exposes `delegate` (spawn sub-agents) and `load` (load a skill/resource into context).
- **Orchestrator (built-in extension)** — the Goose built-in extension that exposes `list_sessions`, `view_session`, and `interrupt_agent` for monitoring and cancelling agent sessions. It is not used to spawn minions because `start_agent` creates bare agents without inherited tools.
- **Developer** — the Goose built-in extension that exposes shell and file-system tools.
- **Analyze** — the Goose built-in extension that exposes tree-sitter code analysis tools.
- **Apps** — the Goose built-in extension that exposes `apps__create_app`, `apps__iterate_app`, `apps__list_apps`, and `apps__delete_app` for building the dashboard UI.

### Goose CLI conventions used in this plan

- `goose plugin install https://github.com/org/goose-agent-framework` installs the framework plugin into `~/.agents/plugins/goose-agent-framework`.
- `goose run --with-extension "node extensions/mcp-toolshed/dist/index.js" --with-extension "node extensions/slack-bot/dist/index.js" -t "..."` loads MCP extensions for a one-off run.
- `goose serve --with-extension ... --port 3284` exposes Goose over HTTP/WebSocket so external bot adapters can connect.
- `goose run --recipe ~/.agents/plugins/goose-agent-framework/commands/daily-pr-review.yaml` executes a framework recipe by path (recipes shipped inside a plugin's `commands/` directory are not auto-discovered).
- `goose recipe validate ~/.agents/plugins/goose-agent-framework/commands/daily-pr-review.yaml` validates a recipe before shipping.
- `goose recipe list` lists recipes from the current directory, `$GOOSE_RECIPE_PATH`, `~/.config/goose/recipes/`, `./.goose/recipes/`, or `$GOOSE_RECIPE_GITHUB_REPO`. To see plugin recipes, either set `GOOSE_RECIPE_PATH=$HOME/.agents/plugins/goose-agent-framework/commands` or copy them into `~/.config/goose/recipes/`.
- Logs and sessions live under `~/.local/share/goose/` and `~/.local/state/goose/logs`.

## Plan of Work

The work is delivered in six milestones. Each milestone produces a running, testable increment. Milestones 1–4 map directly to the delivery phases in `../delivery-specification.md`.

### Milestone 0 — Bootstrap plugin repository and MCP extension monorepo

**Status: Complete as of 2026-06-14.**

Goal: Create a clean repository layout that packages both the Goose plugin and the MCP extensions, plus a local development loop that can build, lint, and test everything.

What exists now:
- `.plugin/plugin.json` — framework plugin manifest.
- `agents/`, `skills/`, `commands/`, `rules/`, `hooks/` directories with skeleton files.
- `extensions/` packages for `mcp-toolshed`, `slack-bot`, `teams-bot`, `agent-dashboard`.
- `packages/framework-core/` — shared TypeScript library for token budgets, error formatting, correlation IDs, and platform formatting.
- Root `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `eslint.config.js` (ESLint 9 flat config), `.prettierrc`, `.npmrc`.
- Root scripts: `pnpm typecheck`, `pnpm build`, `pnpm lint`, `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`.
- Per-package Jest configs with **100% coverage thresholds** for `packages/` and `extensions/`.
- GitHub Actions CI at `.github/workflows/ci.yml` enforcing typecheck → build → lint → test with coverage.
- `.github/workflows/ci.yml` also enforces the red-build/Ralph Wiggum loop: no merge until the full pipeline is green and a maintainer/QA approves.

Implementation notes:
- Workspaces are `packages/*`, `extensions/*`, `infra`, and `test`.
- Each MCP extension has its own `package.json`, `tsconfig.json`, `src/`, and `Dockerfile`.
- `packages/framework-core` is imported by MCP extensions and by test/prompt-quality harnesses. It does not contain Goose-specific runtime code.
- The plugin content is Markdown/JSON and is validated by a small test harness (e.g., frontmatter lint, JSON schema check, agent prompt sanity checks).
- Enforce **100% code coverage** from the first line of TypeScript in `packages/` and `extensions/`. The CI pipeline fails if any package drops below 100% line, branch, function, and statement coverage.
- Add a root `.gitignore` that ignores `node_modules/`, `dist/`, `*.sqlite*`, `.env`, and Azure deployment outputs.
- Decide plugin name and repository URL early; `plugin.json` references it.
- Keep plugin content and MCP extensions in the same repo for coordinated versioning, but document that MCP extensions must be registered separately in Goose config.

### Milestone 1 — Phase 1 Foundation: MCP toolshed, agent prompts, and local state

**Status: Complete as of 2026-06-15.**

Goal: Build the toolshed MCP extension and the first agent prompts, and prove that Goose can load the plugin, spawn a minion agent, call a tool through the toolshed, and log the call.

What will exist at the end:
- `extensions/mcp-toolshed/` — MCP server that registers MCP servers, enforces allowlists, path scopes, rate limits, circuit breakers, and writes tool-call logs. (Core implementation already complete and at 100% coverage.)
- `agents/code-explorer.md` — first minion agent prompt with tool allowlist and output schema.
- `agents/orchestrator.md` — skeleton orchestrator agent prompt that can spawn Code Explorer via `delegate`.
- `skills/delegate-management/SKILL.md` — skill that teaches the orchestrator how to call `delegate`, use `load` to pull skills/resources into context, collect results via `view_session` and the `SessionStore`, and validate structured output.
- `rules/allowlists.yaml` — first version of per-minion tool allowlists.
- `rules/governance.yaml` — default governance: destructive actions requiring approval, rate-limit defaults, workspace boundaries.
- `extensions/mcp-toolshed/config/circuit-breakers.yaml` — per-server circuit breaker thresholds and timeouts.
- SQLite schema in `extensions/mcp-toolshed/src/schema.sql` and a `SessionStore` module.
- Unit tests for allowlist enforcement, rate limiting, circuit breaker state transitions, and session persistence. These tests must achieve 100% coverage of `extensions/mcp-toolshed/src/`.

Implementation notes:
- The toolshed exposes an MCP tool:
  ```json
  {
    "name": "execute_tool",
    "description": "Execute a tool on behalf of a minion through the governed toolshed.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "correlation_id": { "type": "string" },
        "team_id": { "type": "string" },
        "minion_type": { "type": "string" },
        "server_alias": { "type": "string" },
        "tool_name": { "type": "string" },
        "params": { "type": "object" }
      },
      "required": ["correlation_id", "minion_type", "server_alias", "tool_name"]
    }
  }
  ```
- The toolshed consults `rules/allowlists.yaml` keyed by `minionType`.
- Path scoping for filesystem tools is checked inside `execute_tool` using the minion's `path_scope` config (ADR-019).
- The toolshed maintains a `CircuitBreaker` per MCP server alias. State transitions follow `../error-handling.md`:
  - `closed` → `open` after `failure_threshold` consecutive failures.
  - `open` → `half-open` after `timeout_secs`.
  - `half-open` → `closed` after `success_threshold` consecutive successes; any failure re-opens.
- A `HealthMonitor` pings each registered MCP server every 30 seconds. Failed health checks count toward the circuit breaker threshold.
- The toolshed returns a fast-fail result when a breaker is open.
- The orchestrator agent prompt instructs Goose to dispatch minions using the `delegate` tool (provided by the built-in `Summon (delegation)` extension):
  - **Simple synchronous queries** use `delegate(..., async: false)`.
  - **Complex async pipelines** use `delegate(..., async: true)`.
- The orchestrator agent uses the built-in `Orchestrator` extension as a control plane:
  - `list_sessions` and `view_session` to monitor live minions.
  - `interrupt_agent` to cancel a stuck minion.
- Allowlisting has two layers:
  1. **Built-in tools** (delegate, shell, file ops, analyze, etc.) are controlled by the `extensions` list passed to `delegate`.
  2. **External MCP tools** (GitHub, ADO, ServiceNow, Jira, etc.) are controlled by the toolshed using `rules/allowlists.yaml`.
- The toolshed only wraps external MCP servers; it does not intercept built-in Goose tools. Built-in tool calls are still captured by Goose's native logging (Layer A in ADR-016).

### Milestone 2 — Phase 2 Minion Framework: orchestrator skill, DAG, schemas, and prompts

**Status: Complete as of 2026-06-15.**

Goal: Implement the orchestrator agent/skill and the five minion types defined in `../high-level-design.md` §5.

What will exist at the end:
- `agents/orchestrator.md` — full orchestrator agent prompt covering intent classification, task decomposition, DAG execution, result collection, synthesis, and approval gating.
- `skills/intent-classification/SKILL.md` — reusable skill for classifying user messages into intents with complexity and platform.
- `skills/task-decomposition/SKILL.md` — reusable skill for mapping intent → DAG of minion specs.
- `skills/result-synthesis/SKILL.md` — reusable skill for merging minion outputs into a platform-agnostic response.
- `agents/code-reviewer.md`, `agents/pr-crafter.md`, `agents/ticket-analyst.md`, `agents/security-auditor.md`.
- JSON schemas for each minion output in `schemas/`.
- `rules/models.yaml` — tier-to-deployment mapping and per-minion token budgets.
- `test/prompt-quality/harness.ts` — runs a candidate prompt against baseline prompts and test cases, producing schema compliance, recall, precision, and token-efficiency metrics.
- Integration tests that exercise a full "simple query" flow end-to-end using mock MCP servers.

Implementation notes:
- The orchestrator agent uses the fast-tier model for classification and the reasoning tier for DAG construction (ADR-010). If a deployment is unavailable, it falls back to the next tier defined in `rules/models.yaml`.
- Complexity is `simple` or `complex`. Simple intents (`ticket_lookup`, `code_explore`, `ticket_summary`, `security_audit`, `code_review`) run synchronously via a single `delegate(..., async: false)`. Complex intents (`ticket_fix_pr`, `pr_create`, batch reviews) run asynchronously via `delegate(..., async: true)` and, for durability at scale, via Service Bus (ADR-008), with the orchestrator skill enqueueing tasks and later collecting results.
- The DAG model groups minions into ordered phases. Independent minions run in parallel via `delegate(async: true)`. The orchestrator collects results by reading each sub-agent session transcript with `view_session` and by loading persisted results from the `SessionStore` / durable queue for each phase before advancing. `list_sessions` and `view_session` provide live visibility; `interrupt_agent` provides cancellation.
- Correlation IDs follow the hierarchical format from ADR-017:
  - session root: `corr_<uuid>`
  - minion run: `corr_<uuid>.<n>`
  - tool call: `corr_<uuid>.<n>.<server>-<m>`
- Each minion agent prompt includes its output schema as JSON and its correlation ID.
- Model tiers map to Azure AI Foundry deployments in `rules/models.yaml`. Example:
  ```yaml
  tiers:
    fast: { deployment: gpt-4o-mini, max_tokens_per_call: 4096 }
    reasoning: { deployment: gpt-4.1, max_tokens_per_call: 16384 }
    code_review: { deployment: claude-sonnet-4-8, max_tokens_per_call: 32768 }
    code_generation: { deployment: gpt-4.1, max_tokens_per_call: 16384 }
    security: { deployment: claude-sonnet-4-8, max_tokens_per_call: 32768 }
  minions:
    ticket-analyst: { tier: fast, budget: 10000 }
    code-explorer: { tier: reasoning, budget: 25000 }
    code-reviewer: { tier: code_review, budget: 40000 }
    pr-crafter: { tier: code_generation, budget: 40000 }
    security-auditor: { tier: security, budget: 40000 }
  ```
- Token budgets are enforced by the orchestrator agent. After collecting each `delegate` result (via `view_session` and the `SessionStore`), it checks `tokens_used`. If the minion is within 80% of its budget, the next instructions say: "You are near your token budget. Summarize and return final JSON now." If the budget is exceeded, the run is marked `budget_exceeded`.
- Tool-call caching: identical calls within the same session (same server, tool, and parameters) are cached in SQLite for the session lifetime. This avoids re-querying ServiceNow or ADO when a downstream minion asks for the same ticket the upstream minion already fetched.
- Progressive disclosure: the Code Explorer agent prompt explicitly instructs "search first, read targeted files, then reason — never read the entire repo." This keeps context small and token usage low.
- The orchestrator skill uses the built-in `Chat Recall` extension to load relevant prior session context before spawning downstream minions. Ensure `Chat Recall` is enabled in `~/.config/goose/config.yaml` (`--with-builtin chatrecall` does not override a disabled config entry in Goose 1.37.0).
- Retry policy: up to 3 attempts with exponential backoff (1s, 2s, 4s). Terminal failures are sent to the Service Bus dead-letter queue and surfaced to the user with the correlation ID.
- Schema validation uses AJV. Malformed output triggers a retry with the previous output appended as feedback.
- The prompt-quality harness reads test cases from `test/prompt-quality/test-cases/<minion>/` and compares candidate vs. baseline. See `../testing-strategy.md` §Prompt Quality Tests for thresholds.

### Milestone 3 — Phase 3 Ticket and Review Pipelines

**Status: Complete as of 2026-06-15.**

Goal: Wire the end-to-end operational flows: ticket analysis, code review, PR creation, and human approval.

What exists now:
- `extensions/mcp-github/` — standalone MCP server for GitHub PR review and basic PR automation (list, get, diff, create, and merge pull requests). Implemented with 100% TypeScript test coverage.
- `extensions/mcp-azure-devops/` — standalone MCP server for Azure DevOps PRs and work items. Implemented with 100% TypeScript test coverage.
- `extensions/mcp-servicenow/` — standalone MCP server for ServiceNow incidents. Implemented with 100% TypeScript test coverage.
- `extensions/mcp-jira/` — standalone MCP server for Jira issues. Implemented with 100% TypeScript test coverage.
- `commands/ticket-to-pr.yaml` — recipe orchestrating Ticket Analyst → Code Explorer → PR Crafter → GitHub PR creation with human approval gate.
- `commands/daily-pr-review.yaml` and `commands/ticket-poll.yaml` slash-command recipes.
- Integration tests under `test/src/integration/` exercising the toolshed end-to-end with mock MCP servers.
- Security tests in `extensions/mcp-toolshed/src/__tests__/toolshed.test.ts` verifying allowlist blocks, path scoping, and rate limiting.

Implementation notes:
- Each MCP server adapter implements a minimal interface:
  ```ts
  export interface McpServerAdapter {
    alias: string;
    health(): Promise<HealthStatus>;
    listTools(): Promise<ToolDefinition[]>;
    callTool(name: string, params: unknown): Promise<unknown>;
  }
  ```
- The toolshed registers adapters from `extensions/mcp-toolshed/config/servers.yaml`.
- For local development and tests, use the mock adapter at `createMockAdapter` in `extensions/mcp-toolshed/src/adapter.js`.
- The runtime approval gate works as follows:
  1. A minion calls a tool that is flagged as destructive in `rules/governance.yaml`.
  2. The toolshed creates a `pending_approvals` row and polls the session store for a decision.
  3. The `resolve_approval` MCP tool (orchestrator/slack/teams/dashboard) writes `approved` or `denied` to the row.
  4. On approval, the toolshed proceeds with the original tool call and returns the result. On denial or timeout, it returns `approval_denied` or `approval_timeout` and the orchestrator aborts or reports the outcome.
- PR creation links back to the source ticket/work item using the platform's linking syntax (`Fixes AB#567`, `Closes #123`).
- PR creation links back to the source ticket/work item using the platform's linking syntax (`Fixes AB#567`, `Closes #123`).
- Error handling follows `../error-handling.md`. Every failure path produces a user-facing message with: severity icon, one-line summary, cause, impact, action, and correlation ID. Example:
  ```text
  ❌ Unable to review PR #342
  Cause: GitHub API rate limit exceeded (50 req/min).
  Impact: Review not posted. PR #342 remains unreviewed.
  Action: Review will be retried automatically in 2 minutes.
  Session: corr_a1b2c3 — [View Details] [Retry Now]
  ```
- Partial results are surfaced when some parallel minions succeed and others fail. The orchestrator marks the session `degraded` and includes both ✅ and ❌ lines in the response.
- Circuit breaker events are logged as `throttled` or `error` status in the tool-call log; the user sees a fast-fail message rather than a long timeout.

### Milestone 4 — Phase 4 Platform Hardening

**Status: Complete as of 2026-06-15 for dev foundation.**

Goal: Deploy the framework to Azure with infrastructure as code, observability, and CI/CD.

What exists now:
- `infra/terraform/main.tf` and child modules for resource group, networking, observability, managed identities, Key Vault, Storage, Service Bus, Container Registry, Container Apps, AI Foundry, and Grafana.
- `infra/terraform/environments/dev/` thin wrapper with `terraform.tfvars`.
- `infra/terraform/tests/main.tftest.hcl` mock-based Terraform tests covering naming, validation, and wiring assertions.
- Dockerfiles for each runnable MCP extension (`extensions/mcp-toolshed`, `mcp-github`, `mcp-azure-devops`, `mcp-servicenow`, `mcp-jira`, `slack-bot`, `teams-bot`, `agent-dashboard`).
- `.github/workflows/ci.yml` with fixed triggers and `.github/workflows/container-build.yml` for image build/push.
- `extensions/agent-dashboard/` — dashboard backend MCP server with Session Explorer, Correlation Tree, Live Minion Status, Pending Approvals, and Health views (ADR-018); 100% test coverage.
- Real Slack (`extensions/slack-bot/`) and Teams (`extensions/teams-bot/`) ingress bots with event adapters and shared `IngressRunner` interface; 100% test coverage.

Implementation notes:
- Container Apps scale rules: KEDA on Service Bus active message count; minimum 1 replica for chat bots during business hours; orchestrator scales 1–5 based on queue depth (ADR-011, ADR-012).
- Service Bus uses topic `minion-tasks` with subscriptions per minion type; sessions are enabled and session ID is the root correlation ID.
- Key Vault stores all secrets; containers use managed identity (`DefaultAzureCredential`). No secrets in environment variables except non-secret config.
- AI Foundry model tiers are mapped in `infra/terraform/modules/ai_foundry` (using `azapi`) and referenced by name from `rules/models.yaml` (ADR-010).
- SQLite state is backed up to Blob Storage on a schedule and restored on container startup (ADR-009).
- CI/CD uses OIDC federation to Azure, ACR build tasks, and `az containerapp update`. Infrastructure deployments use `terraform plan` in PR checks and require human approval for production (ADR-013).

### Milestone 5 — Acceptance, Disaster Recovery, and Production Handoff

**Status: Complete for v1 build artifacts.** Operational runbooks and test scaffolding are in place; staging validation and formal sign-off remain for the production handoff gate.

What exists now:
- Integration tests under `test/src/integration/` exercising the toolshed end-to-end.
- E2E tests under `test/src/e2e/` validating the plugin manifest, orchestrator prompt, and recipes.
- Acceptance harness validating recipe schema and approval-gating language.
- Disaster-recovery, production-handoff, and security-review runbooks under `docs/runbooks/`.
- k6 performance skeleton (`test/performance/load-test.js`) and chaos scripts (`test/chaos/corrupt-sqlite.sh`, `test/chaos/kill-orchestrator.sh`).

What remains before production handoff:
- E2E test results from the staging environment.
- Performance and chaos test results against staging.
- A documented backup/restore drill.
- Dependency audit, secret scanning, and container image vulnerability scanning in CI.
- Security review sign-off.
- Production deployment with human approval gate for destructive actions.

Implementation notes:
- E2E scenarios are defined in `test/src/e2e/` and run nightly against staging.
- Performance tests use k6 scripts in `test/performance/`.
- Chaos tests are shell scripts in `test/chaos/` (kill orchestrator, corrupt SQLite, etc.).
- DR targets: RPO < 15 minutes via SQLite blob backups; RTO measured and documented in `../disaster-recovery.md` and `docs/runbooks/disaster-recovery.md`.

## Concrete Steps

These commands assume you are at the repository root (`/Volumes/ExtDisk1/Minions`) and have Node.js 20+, pnpm, Azure CLI, Docker, and the Goose CLI installed.

1. Bootstrap the plugin + extension monorepo:
   ```bash
   corepack enable
   corepack prepare pnpm@latest --activate
   pnpm init
   mkdir -p infra test .plugin agents skills commands rules hooks extensions \
     extensions/mcp-toolshed extensions/slack-bot extensions/teams-bot extensions/agent-dashboard \
     packages/framework-core/src packages/framework-core/__tests__
   cat > pnpm-workspace.yaml <<'EOF'
   packages:
     - 'packages/*'
     - 'extensions/*'
     - 'infra'
     - 'test'
   EOF
   pnpm add -D typescript @types/node tsx jest @types/jest eslint prettier
   pnpm exec tsc --init
   ```

2. Create the plugin manifest:
   ```bash
   cat > .plugin/plugin.json <<'EOF'
   {
     "name": "goose-agent-framework",
     "version": "0.1.0",
     "description": "Multi-agent orchestration framework for engineering operations.",
     "repository": "https://github.com/your-org/goose-agent-framework",
     "agents": "./agents/",
     "skills": "./skills/",
     "commands": "./commands/",
     "rules": "./rules/",
     "hooks": "./hooks/hooks.json"
   }
   EOF
   ```

3. Create the MCP extension packages and install their dependencies:
   ```bash
   for name in mcp-toolshed slack-bot teams-bot agent-dashboard; do
     mkdir -p extensions/$name/src extensions/$name/config extensions/$name/__tests__
     cd extensions/$name && pnpm init && cd ../..
     node -e "const fs=require('fs'), p='extensions/$name/package.json', pkg=JSON.parse(fs.readFileSync(p)); pkg.name='$name'; fs.writeFileSync(p, JSON.stringify(pkg,null,2)+'\\n');"
   done
   cd packages/framework-core && pnpm init && cd ../..
   node -e "const fs=require('fs'), p='packages/framework-core/package.json', pkg=JSON.parse(fs.readFileSync(p)); pkg.name='framework-core'; fs.writeFileSync(p, JSON.stringify(pkg,null,2)+'\\n');"
   pnpm --filter mcp-toolshed add @modelcontextprotocol/sdk @azure/data-tables @azure/storage-blob @azure/identity better-sqlite3
   pnpm --filter slack-bot add @slack/bolt
   pnpm --filter teams-bot add @microsoft/teams-ai
   pnpm --filter framework-core add -D typescript
   # Link shared core into extensions that need it
   pnpm --filter mcp-toolshed add framework-core
   pnpm --filter agent-dashboard add framework-core
   ```

4. Install the plugin locally for development:
   ```bash
   # From the repo root
   goose plugin install file://$(pwd)
   # or
   goose plugin install https://github.com/your-org/goose-agent-framework.git
   ```
   Verify it appears in `~/.agents/plugins/goose-agent-framework` and that agents/skills/commands are loaded. Validate recipes before committing (recipes inside a plugin's `commands/` directory are not on Goose's recipe search path, so use the full path):
   ```bash
   goose recipe validate ~/.agents/plugins/goose-agent-framework/commands/daily-pr-review.yaml
   goose recipe validate ~/.agents/plugins/goose-agent-framework/commands/ticket-poll.yaml
   ```
   To make plugin recipes discoverable by `goose recipe list`, either copy/symlink them into `~/.config/goose/recipes/` or set:
   ```bash
   export GOOSE_RECIPE_PATH="$HOME/.agents/plugins/goose-agent-framework/commands"
   goose recipe list
   ```

5. Register the MCP extensions and enable required built-ins in Goose config. Because plugins cannot bundle MCP servers, add them to `~/.config/goose/config.yaml`. Also enable `chatrecall` and `orchestrator` if they are disabled (`--with-builtin` does not override disabled config entries in Goose 1.37.0):
   ```yaml
   extensions:
     mcp-toolshed:
       cmd: node
       args: ["/Volumes/ExtDisk1/Minions/extensions/mcp-toolshed/dist/index.js"]
       type: stdio
       enabled: true
     slack-bot:
       cmd: node
       args: ["/Volumes/ExtDisk1/Minions/extensions/slack-bot/dist/index.js"]
       type: stdio
       enabled: true
   chatrecall:
     enabled: true
   orchestrator:
     enabled: true
   ```
   Exact config keys may vary by Goose version; adjust to match the local schema shown by `goose info`.

6. Run a one-off task with the toolshed extension loaded:
   ```bash
   pnpm --filter mcp-toolshed build
   goose run \
     --with-extension "node extensions/mcp-toolshed/dist/index.js" \
     --with-builtin developer,analyze,chatrecall,orchestrator \
     -t "@minions review PR #342"
   ```
   `delegate` and `load` are provided by the built-in `Summon (delegation)` extension, which is enabled by default. If it is disabled in your config, add `summon` to the `--with-builtin` list or enable it in `~/.config/goose/config.yaml`.

7. Type-check, build, lint, and test the monorepo after each milestone:
   ```bash
   pnpm typecheck
   pnpm -r build
   pnpm lint
   pnpm test
   ```
   Expected output:
   ```text
   Test Suites: N passed, N total
   Tests:       M passed, M total
   ```

8. Run integration tests with mock MCP servers:
   ```bash
   pnpm test:integration
   ```
   Expected output: all pipeline scenarios pass and tool-call logs contain the expected correlation IDs.

9. Run prompt-quality evaluation when prompts change:
   ```bash
   pnpm test:prompts -- --minion code-reviewer \
     --candidate agents/code-reviewer/v1.1.0.md \
     --baseline agents/code-reviewer/v1.0.0.md
   ```

10. Deploy infrastructure to a dev environment:
    ```bash
    az login
    cd infra/terraform
    terraform init \
      -backend-config="resource_group_name=<STATE_RG>" \
      -backend-config="storage_account_name=<STATE_SA>" \
      -backend-config="container_name=tfstate" \
      -backend-config="key=dev.terraform.tfstate"
    terraform plan -var-file=../environments/dev/terraform.tfvars
    terraform apply -var-file=../environments/dev/terraform.tfvars
    ```

11. Build and deploy an MCP extension:
    ```bash
    az acr build --registry gooseframework \
      --image mcp-toolshed:$(git rev-parse --short HEAD) \
      --file extensions/mcp-toolshed/Dockerfile .
    az containerapp update --name goose-mcp-toolshed \
      --resource-group goose-framework-dev \
      --image gooseframework.azurecr.io/mcp-toolshed:$(git rev-parse --short HEAD)
    ```

12. Run E2E smoke tests after a staging deployment:
    ```bash
    pnpm test:e2e -- --environment staging
    ```

## Validation and Acceptance

The work is complete when the following behaviors are observable. These map directly to `../delivery-specification.md` §7.

1. **Intent classification and dispatch.** Send a Slack message `@minions review PR #342`. The orchestrator agent classifies intent `code_review`, delegates to the Code Reviewer agent, and posts a structured review to the channel. The correlation tree in the dashboard shows `corr_xxxx`, `corr_xxxx.1`, and `corr_xxxx.1.github-001`.

2. **Ticket lookup across ServiceNow and Azure DevOps.** Ask `@minions what's the status of INC00421?` or `@minions what's the status of AB#1234?`. The bot returns ticket details and any related PRs/issues.

3. **Ticket→fix→PR pipeline.** Ask `@minions fix work item #567 and create a PR`. The bot creates a branch, commits a fix, opens a PR, links it to the work item, and posts the PR URL. Tool calls are logged with correlation IDs.

4. **Allowlist enforcement and audit.** A Ticket Analyst that tries to call `github.create_pr` is blocked by the toolshed, receives an error, and a security event is written to the tool-call log.

5. **Slack and Teams parity.** The same orchestrator payload renders correctly in both Slack (Block Kit) and Teams (Adaptive Card). Both can trigger and receive results.

6. **Observability.** The Grafana Overview dashboard shows active sessions, minion runs, success rate, and queue depth. The custom dashboard shows a clickable correlation tree for any session.

7. **Failure handling.** Kill an orchestrator replica during a pipeline; KEDA respawns it, Service Bus redelivers the message, and the pipeline resumes from SQLite state without silent loss.

8. **Azure deployment and DR.** `infra/terraform/` deploys reproducibly to dev, staging, and production. Backup/restore of SQLite from Blob Storage is tested and documented.

9. **Prompt quality gates.** A prompt change that fails the prompt-quality harness is blocked from merge. A canary prompt is rolled back if review acceptance drops.

10. **Human approval for destructive actions.** Asking `@minions merge PR #342` pauses, posts an approval card, and only merges after a human clicks Approve.

11. **100% code coverage.** `pnpm test` reports 100% line, branch, function, and statement coverage for `packages/framework-core/` and every `extensions/*/src/` directory. No PR may lower coverage.

12. **Red build policy ("Ralph Wiggum" loop).** A failing CI check blocks merge until the author fixes the root cause, the full pipeline re-runs green, and a maintainer/QA reviewer approves the fix. There is no bypass for failing tests, lint, type-checks, or coverage gates.

## Idempotence and Recovery

- The local SQLite file is `.data/sessions.sqlite` by default. Delete it and restart to reset local state.
- Integration tests use ephemeral SQLite and mock servers; they can be rerun safely with `pnpm test:integration`.
- Infrastructure deployments use Bicep `what-if` in PR checks. Production deployments require a GitHub Environment protection rule with human approval.
- Container image tags use the Git commit SHA, so rolling back is `az containerapp update --image <previous-sha>`.
- Prompt rollbacks are Git reverts + redeploy; no runtime configuration mutation is required.
- Plugin updates are `git revert` or `goose plugin update goose-agent-framework` after a new release.
- No secrets are committed. Key Vault is the only secret store. If a local `.env` file is created for development, it is ignored by `.gitignore`.

## Artifacts and Notes

Example plugin manifest (`.plugin/plugin.json`):
```json
{
  "name": "goose-agent-framework",
  "version": "0.1.0",
  "description": "Multi-agent orchestration framework for engineering operations.",
  "repository": "https://github.com/your-org/goose-agent-framework",
  "agents": "./agents/",
  "skills": "./skills/",
  "commands": "./commands/",
  "rules": "./rules/",
  "hooks": "./hooks/hooks.json"
}
```

Example agent prompt frontmatter (`agents/code-reviewer.md`):
```markdown
---
name: code-reviewer
minion_type: code-reviewer
model_tier: code_review
token_budget: 40000
output_schema: schemas/code-reviewer.json
---

# Code Reviewer

You are a senior code reviewer. Analyze diffs for correctness, readability, performance, security, and test coverage. Produce structured JSON with findings, severity, and an approved flag.

## Tool allowlist
- github.get_pr, github.get_pr_diff, github.create_pr_review, github.create_pr_review_comment
- azure_devops.get_pr, azure_devops.get_pr_diff, azure_devops.create_pr_review
- filesystem.read_file, filesystem.list_directory, filesystem.search_files
- shell.run_command (eslint, pylint, shellcheck, go vet, cargo clippy only)

## Output schema
Return only JSON matching `schemas/code-reviewer.json`.
```

Example structured log entry emitted by the toolshed:
```json
{
  "timestamp": "2026-06-14T16:00:00Z",
  "event": "tool_call",
  "correlation_id": "corr_a1b2c3.1.github-001",
  "team_id": "default",
  "minion_type": "code-reviewer",
  "mcp_server": "github",
  "tool_name": "get_pr_diff",
  "status": "success",
  "latency_ms": 142,
  "parameters_sha256": "abc123..."
}
```

Example KQL query for the dashboard:
```kusto
AppTraces
| where Properties.correlation_id startswith "corr_a1b2c3"
| project timestamp, Properties.minion_type, Properties.tool_name, Properties.latency_ms, Properties.status
| order by timestamp asc
```

Example minion allowlist excerpt (`rules/allowlists.yaml`):
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
    path_scope:
      mode: denylist
      paths: [".git/", "node_modules/", "secrets/"]
```

## Interfaces and Dependencies

### Required libraries and services
- **Goose CLI/runtime** — provides `delegate` and `load` via the built-in `Summon (delegation)` extension, session management, built-in extensions (`developer`, `analyze`, `chatrecall`, `apps`, `orchestrator`), plugin loading, and `goose serve`.
- **Node.js 20+ and pnpm** — runtime and package manager for MCP extensions.
- **Azure services** — Container Apps, Service Bus, Table Storage, Blob Storage, Key Vault, AI Foundry, Log Analytics, Managed Grafana.
- **MCP SDK** — for building MCP server extensions (stdio/SSE/WebSocket).
- **Slack Bolt** — Slack bot adapter.
- **Microsoft 365 Agent SDK** — Teams bot adapter.
- **better-sqlite3** — embedded session store.
- **@azure/data-tables, @azure/storage-blob, @azure/identity** — Azure storage and auth.
- **Circuit-breaker logic** — either a small custom implementation or a package such as `opossum` (Node.js).

### Key interfaces that must exist at the end

`.plugin/plugin.json`:
```json
{
  "name": "goose-agent-framework",
  "version": "string",
  "description": "string",
  "repository": "string",
  "agents": "./agents/",
  "skills": "./skills/",
  "commands": "./commands/",
  "rules": "./rules/",
  "hooks": "./hooks/hooks.json"
}
```

`agents/<minion>.md` frontmatter:
```yaml
---
name: string                 # agent identifier
minion_type: string          # code-explorer | code-reviewer | pr-crafter | ticket-analyst | security-auditor
model_tier: string           # fast | reasoning | code_review | code_generation | security
token_budget: number
output_schema: string        # path to JSON schema
---
```

`packages/framework-core/src/token-budget.ts`:
```ts
export interface MinionBudget {
  maxTokensPerRun: number;
  warningThreshold: number; // e.g., 0.8
}

export class TokenBudgetTracker {
  constructor(budget: MinionBudget);
  recordUsage(tokensUsed: number): { status: 'ok' | 'warning' | 'exceeded'; remaining: number };
  getWrapUpHint(): string;
}
```

`packages/framework-core/src/errors.ts`:
```ts
export interface UserFacingError {
  severity: 'success' | 'degraded' | 'failure' | 'infrastructure';
  summary: string;
  cause: string;
  impact: string;
  action: string;
  correlationId: string;
}

export function formatError(e: UserFacingError): string;
```

`extensions/mcp-toolshed/src/toolshed.ts`:
```ts
export interface ToolContext {
  teamId: string;
  minionType: string;
  correlationId: string;
  attempt: number;
}

export interface ToolResult {
  status: 'success' | 'error' | 'blocked_by_allowlist' | 'throttled' | 'approval_required';
  data?: unknown;
  error?: string;
}

export async function executeTool(
  ctx: ToolContext,
  serverAlias: string,
  toolName: string,
  params: unknown
): Promise<ToolResult>;
```

`extensions/mcp-toolshed/src/circuit-breaker.ts`:
```ts
export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeoutSecs: number;
  halfOpenMaxRequests: number;
}

export type BreakerState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  constructor(config: CircuitBreakerConfig);
  get state(): BreakerState;
  recordSuccess(): void;
  recordFailure(): void;
  canExecute(): boolean;
  readonly retryAfterSeconds: number;
}
```

`extensions/mcp-toolshed/src/server.ts`:
```ts
export interface McpServerAdapter {
  alias: string;
  health(): Promise<HealthStatus>;
  listTools(): Promise<ToolDefinition[]>;
  callTool(name: string, params: unknown): Promise<unknown>;
}
```

`extensions/mcp-toolshed/src/store.ts`:
```ts
export interface SessionStore {
  createSession(session: Session): void;
  getSession(id: string): Session | undefined;
  createMinionRun(run: MinionRun): void;
  updateMinionRun(id: string, patch: Partial<MinionRun>): void;
  createApproval(approval: PendingApproval): void;
  resolveApproval(id: string, decision: 'approved' | 'denied'): void;
  getCachedToolCall(key: string): unknown | undefined;
  setCachedToolCall(key: string, value: unknown): void;
}
```

### Dependencies between milestones
- Milestone 1 must finish before Milestone 2 (toolshed and session store are prerequisites).
- Milestone 2 must finish before Milestone 3 (minion framework is needed for pipelines).
- Milestone 3 must finish before Milestone 4 end-to-end platform validation (E2E needs real integrations).
- Milestone 4 infrastructure can be provisioned in parallel with Milestones 2–3, but production wiring waits for Milestone 3.

---

## Revision Notes

- **2026-06-14:** Major revision after live Goose CLI exploration and reading `../goose-capabilities-and-usage.md`, `../how-goose-works-with-llms.md`, `../logical-architecture.md`, `../physical-architecture.md`, `../error-handling.md`, `../disaster-recovery.md`, `../azure-architecture.md`, `../dashboard-design.md`, and the Goose guides at https://goose-docs.ai/docs/category/guides.
  - Replaced the standalone-service model with the Goose-native **plugin + MCP extensions** model.
  - Added plugin manifest, agents, skills, commands, rules, hooks directory structure.
  - Added circuit breakers, health monitoring, token budgets, model-tier routing, `chatrecall` dependency, tool-call caching, progressive disclosure, Goose CLI conventions, and the four-field user-facing error template.
  - Updated Concrete Steps to use `goose plugin install`, `goose recipe validate`, `goose run --with-extension`, and `goose serve`; added explicit MCP-extension registration in `~/.config/goose/config.yaml`; added monorepo bootstrap including `packages/framework-core`.
  - Corrected minion dispatch model after live testing: `delegate(async: true)` is used for all minion execution because it inherits parent extensions; the built-in `Orchestrator` extension is used only for monitoring (`list_sessions`, `view_session`) and cancellation (`interrupt_agent`).
  - Corrected built-in extension facts after a tool-listing run: `Summon` provides both `delegate` and `load`; `Developer` provides shell/file/edit/write/tree; `Analyze` provides tree-sitter; `Apps` exposes `apps__create_app`, `apps__iterate_app`, `apps__list_apps`, and `apps__delete_app`; `Todo` provides `todo__todo_write`; `Chat Recall` and `Orchestrator` are disabled by default and must be enabled in `~/.config/goose/config.yaml` (`--with-builtin` does not override disabled entries in Goose 1.37.0).
  - Expanded **Surprises & Discoveries** into 13 top-level items, each with nested evidence.
  - Corrected recipe discovery: recipes inside a plugin's `commands/` directory must be run/validated by path or added to `GOOSE_RECIPE_PATH` / `~/.config/goose/recipes/`; `goose recipe list` does not scan plugin directories.
- **2026-06-14 (later):** Scaffolding built and local pipeline verified.
  - Marked Milestone 0 complete and Milestone 1 in progress.
  - Implemented `packages/framework-core` (token budgets, errors, correlation IDs, platform formatter) and `extensions/mcp-toolshed` (config, allowlists, rate limiter, circuit breaker, SQLite/memory store, MCP adapter, `executeTool`, server handlers) with 100% test coverage.
  - Implemented `extensions/slack-bot`, `extensions/teams-bot`, and `extensions/agent-dashboard` with 100% test coverage.
  - Verified `pnpm typecheck && pnpm build && pnpm lint && pnpm test --coverage` passes locally.
  - Added `.npmrc` with `onlyBuiltDependencies=better-sqlite3` and built the native SQLite bindings.
  - Updated root lint script to `eslint .` for ESLint 9 flat-config compatibility.
