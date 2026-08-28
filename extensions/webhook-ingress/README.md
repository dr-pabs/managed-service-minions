# webhook-ingress

GitHub / Azure DevOps **event ingress** for the Minions Agent Framework
(Milestone 15, F11): events — not just chat mentions — can start orchestrator
work. A bare `node:http` server exposes `POST /webhooks/github` and
`POST /webhooks/ado`, verifies the sender **before touching the body**
(GitHub: HMAC signature against `GITHUB_WEBHOOK_SECRET`; ADO: basic auth
against `ADO_WEBHOOK_USERNAME`/`ADO_WEBHOOK_PASSWORD`), maps the event onto
the same `IngressRequest`/`IngressRunner` contract chat ingress uses
(`framework-core`'s `handleIngressMessage`), and replies by posting a PR
comment **through the governed toolshed** — never a direct GitHub API call.

## How it drives the orchestrator

`src/index.ts` is the production wiring, mirroring `slack-bot`'s shape: it
builds a real in-process toolshed via `mcp-toolshed`'s `buildToolshedState()`
(the same startup path the toolshed's own process uses), wires the real
orchestrator runner (`createOrchestratorRunner`) against it with
`verifyAndExecuteTool`, and starts the HTTP server. A verified webhook event
therefore takes the identical minion-DAG path as a Slack mention, with
identity tokens, allowlists, approvals, and audit intact.

Missing secrets warn loudly at startup and the affected route fails closed
(401) rather than blocking boot — a GitHub-only or ADO-only deployment still
serves its configured route.

## Configuration

| env var | default | meaning |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | _(unset — route rejects 401)_ | HMAC secret for `/webhooks/github` |
| `ADO_WEBHOOK_USERNAME` / `ADO_WEBHOOK_PASSWORD` | _(unset — route rejects 401)_ | basic auth for `/webhooks/ado` |
| `PORT` | `3100` | listen port |
| `SQLITE_PATH` | `:memory:` | session/audit store path |
| `GOOSE_SERVE_URL` (fallback `GOOSE_BASE_URL`) | `http://localhost:3284` | Goose runtime base URL |
| `TOOLSHED_SIGNING_SECRET` | _(unset)_ | HMAC secret for minting minion tokens |

## Build / run / test

```bash
pnpm --filter webhook-ingress build
pnpm --filter webhook-ingress start
pnpm --filter webhook-ingress test   # jest --coverage
```

The cross-package e2e (`test/src/e2e-webhook-ingress.test.ts`) drives a real
event through the server, runner, and toolshed.

## Deployment status — built, not yet deployed (known gap)

A `Dockerfile` exists here and CI builds and pushes a `webhook-ingress`
container image (`.github/workflows/container-build.yml`), **but no Terraform
container app deploys it yet** — `infra/terraform/modules/container_apps/`
defines orchestrator, queue-ingress, toolshed, dashboard, and the two bots
only. Until an app (with external ingress for the webhook routes) is added,
the image is built-but-not-deployed. This is a known, deliberate gap; treat
any claim that webhook events reach production as pending that wiring.
