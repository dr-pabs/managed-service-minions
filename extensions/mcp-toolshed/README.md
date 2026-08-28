# mcp-toolshed

The `mcp-toolshed` is a governed MCP server proxy. It registers external MCP
servers, enforces per-minion allowlists, applies rate limits and circuit
breakers, and audits every tool call. Identity on every `execute_tool` call is
the verified `identity/v1` minion token (ADR-029). It also hosts the
in-process **effect gateway** and the **sampling QA loop** (below).

## Effect gateway (ADR-028)

The toolshed mounts an in-process MCP server under the alias `effect_gateway`
(`src/effect-gateway.ts`) — the Stream commit boundary for externally visible
side effects (`effects/v1`):

- **Tools:** `draft_effect` (produce an inert effect draft), `commit_effect`
  (gateway-only execution of a draft), `discard_effect` (abandon a draft with
  a required reason).
- **Evidence gate:** a commit requires a passing `verification/v1` result
  among the draft's evidence references; a draft with no passing evidence can
  never commit.
- **Approval classes:** every `effect_type` must be declared with a
  `reversibility` (`reversible`/`compensatable`/`irreversible`) and an
  `approval_class` (`auto`/`sampled`/`always_human`); undeclared types are
  refused. `irreversible` (or `always_human`) drafts refuse agent actors — a
  named human, reached through a resolved approval, is required on commit and
  discard alike. Commits are idempotent on the draft's `idempotency_key`.
- **Runtime-injected destructive rule:** `ensureEffectGatewayRules()` pins
  `effect_gateway.commit_effect` into the destructive-actions list at startup,
  **outside** `rules/governance.yaml`, so a commit always surfaces a
  human-visible approval even under an empty governance file. `discard_effect`
  is deliberately not destructive.
- Identity for a commit/discard comes only from the verified `identity/v1`
  token — smuggled `actor`/`token`/`approver_id` parameters are rejected, and
  with no `TOOLSHED_SIGNING_SECRET` no commit or discard can proceed
  (fail closed).

Being in-process, `effect_gateway` needs no `TOOLSHED_ADAPTERS` entry and no
`rules/allowlists.yaml` rows.

## Shared governance state (ADR-026)

The rate limiter's token buckets and the circuit breaker state can live on
Azure Table Storage (`src/shared-governance-state.ts`, table
`GovernanceState`, ETag-guarded read-modify-write) instead of process memory,
which is what lets the toolshed run 1–5 replicas with one consistent view of
rate limits and breaker trips. Set
`TOOLSHED_GOVERNANCE_STATE_CONNECTION_STRING` to enable it; unset, the
in-process adapter is used (local dev/tests need no cloud). Pending-approval
CRUD remains on SQLite (single-writer — see ADR-026's residual-limitation
note).

## Sampling QA loop (ADR-032)

After an agent-actor auto-commit through the effect gateway, a configurable
percentage of that effect type's commits route post hoc to a human reviewer
(`src/sampling-qa.ts`) as `review_commit` approvals on the existing approval
surface. `approve` records `agreed`, `deny` records `disagreed`; a
disagreement rate crossing the type's threshold trips a per-type circuit
breaker that turns auto-commit **off** for that type (forcing pre-commit human
approval) until an operator resets it — dashboard `GET /api/sampling-qa` and
`POST /api/sampling-qa/:effectType/reset`, runbook
`docs/runbooks/stream-operations.md`.

## Environment variables

Read by `src/server.ts` (and `store.ts`/`cloud-audit.ts`):

| var | meaning |
|---|---|
| `TOOLSHED_SIGNING_SECRET` | HMAC secret for verifying `identity/v1` minion tokens; **required** in production (`NODE_ENV=production` refuses to start without it) |
| `TOOLSHED_ALLOW_UNSIGNED` | `1` = loudly-logged dev-only escape hatch: `execute_tool` accepts caller-supplied `minion_type`/`team_id`. Never in production |
| `TOOLSHED_ADAPTERS` | JSON array of external MCP server adapters (see the registration sections below) |
| `TOOLSHED_ALLOWLISTS_PATH` / `TOOLSHED_GOVERNANCE_PATH` | paths to `rules/allowlists.yaml` / `rules/governance.yaml`; unset = built-in defaults |
| `TOOLSHED_STORE_PATH` | SQLite session/audit store path (default `:memory:`) |
| `TOOLSHED_ALLOW_MEMORY_STORE` | `1` = permit the in-memory store where a durable one is otherwise required (`NODE_ENV=production` refuses `:memory:` without it) |
| `TOOLSHED_REPO_ROOT` | repo root used to resolve rules/schemas |
| `TOOLSHED_GOVERNANCE_STATE_CONNECTION_STRING` | Azure Tables connection string enabling the shared governance state store (ADR-026); unset = in-process state |
| `TOOLSHED_GOVERNANCE_STATE_TABLE` | table name for the shared state (default `GovernanceState`) |
| `TOOLSHED_WATCH_RULES` | `1` = hot-reload the allowlists/governance YAML on change (validated before swap); only meaningful when the `*_PATH` vars point at real files |
| `TOOLSHED_OPERATOR_TOKEN` | bearer token for the operator HTTP endpoints (approve/deny resolution); unset = every operator request rejected 401 |
| `TOOLSHED_AUDIT_DLQ_PATH` | local dead-letter file for cloud audit writes that exhaust retries (default `./audit-dlq.jsonl`) |
| `TOOLSHED_EFFECT_<SYSTEM>_API_KEY` | per-target-system connector credential for the effect gateway (secrets agents never see) |

## Registering the GitHub MCP server

The framework ships a dedicated GitHub MCP server in `extensions/mcp-github/`.
To make it available to Goose minions, build it and register it as an MCP
extension, then point the toolshed at it via the `TOOLSHED_ADAPTERS` environment
variable.

Build the server:

```bash
pnpm --filter @minions-agent-framework/mcp-github build
```

Add the server to your Minions config (`~/.config/minions/config.yaml`):

```yaml
extensions:
  mcp-github:
    cmd: node
    args: ["/path/to/repo/extensions/mcp-github/dist/index.js"]
    type: stdio
    enabled: true
```

The server requires a `GITHUB_TOKEN` environment variable. For GitHub Enterprise
Server, you can also set `GITHUB_API_URL`:

```bash
export GITHUB_TOKEN="ghp_..."
export GITHUB_API_URL="https://github.example.com/api/v3"
```

To route the server through the toolshed so that allowlists, rate limits, and
audit logging apply, register it as an adapter:

```bash
export TOOLSHED_ADAPTERS='[
  {
    "alias": "github",
    "command": "node",
    "args": ["/path/to/repo/extensions/mcp-github/dist/index.js"],
    "env": { "GITHUB_TOKEN": "ghp_..." }
  }
]'
node extensions/mcp-toolshed/dist/index.js
```

Tools exposed by `mcp-github` include:

- `github_list_pull_requests`
- `github_get_pull_request`
- `github_get_pull_request_diff`
- `github_create_pull_request`
- `github_merge_pull_request`

Each tool returns JSON with `success` and either `data` or `error`.

## Registering the Azure DevOps MCP server

The `extensions/mcp-azure-devops` MCP server can be registered with the toolshed
via the `TOOLSHED_ADAPTERS` environment variable:

```json
[
  {
    "alias": "azure_devops",
    "command": "node",
    "args": ["/path/to/repo/extensions/mcp-azure-devops/dist/index.js"],
    "env": {
      "AZURE_DEVOPS_ORG": "<your-organization>",
      "AZURE_DEVOPS_PROJECT": "<your-project>",
      "AZURE_DEVOPS_TOKEN": "<personal-access-token>"
    }
  }
]
```

After building the extension (`pnpm --filter @minions-agent-framework/mcp-azure-devops build`),
start the toolshed with `TOOLSHED_ADAPTERS` set to the JSON above. Minions can
then call Azure DevOps tools such as `ado_get_pull_request`, `ado_list_work_items`,
and `ado_update_work_item` through the toolshed.

## Registering the ServiceNow MCP server

The `extensions/mcp-servicenow` MCP server can be registered with the toolshed
via the `TOOLSHED_ADAPTERS` environment variable:

```json
[
  {
    "alias": "servicenow",
    "command": "node",
    "args": ["/path/to/repo/extensions/mcp-servicenow/dist/index.js"],
    "env": {
      "SERVICENOW_INSTANCE": "<your-instance>",
      "SERVICENOW_USERNAME": "<username>",
      "SERVICENOW_PASSWORD": "<password>"
    }
  }
]
```

After building the extension (`pnpm --filter @minions-agent-framework/mcp-servicenow build`),
start the toolshed with `TOOLSHED_ADAPTERS` set to the JSON above. Minions can
then call ServiceNow tools such as `servicenow_list_incidents`,
`servicenow_get_incident`, `servicenow_update_incident`, and
`servicenow_create_incident` through the toolshed.

## Registering the Jira MCP server

The `extensions/mcp-jira` MCP server can be registered with the toolshed via the
`TOOLSHED_ADAPTERS` environment variable:

```json
[
  {
    "alias": "jira",
    "command": "node",
    "args": ["/path/to/repo/extensions/mcp-jira/dist/index.js"],
    "env": {
      "JIRA_HOST": "<your-jira-host>",
      "JIRA_EMAIL": "<your-email>",
      "JIRA_API_TOKEN": "<your-api-token>"
    }
  }
]
```

After building the extension (`pnpm --filter @minions-agent-framework/mcp-jira build`),
start the toolshed with `TOOLSHED_ADAPTERS` set to the JSON above. Minions can
then call Jira tools such as `jira_list_issues`, `jira_get_issue`,
`jira_update_issue`, `jira_create_issue`, and `jira_add_comment` through the
toolshed.
