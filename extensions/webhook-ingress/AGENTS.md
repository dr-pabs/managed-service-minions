# AGENTS.md — extensions/webhook-ingress

Package-local agent guide (per the root `AGENTS.md` mandate: every runnable
subproject carries its own AGENTS.md). This package is the GitHub / Azure
DevOps webhook event ingress: it verifies webhook senders and drives the same
orchestrator runner chat ingress uses (see `README.md`).

## Commands

```bash
pnpm --filter webhook-ingress build   # tsc -p tsconfig.json
pnpm --filter webhook-ingress start   # node ./dist/index.js (serves POST /webhooks/github and /webhooks/ado)
pnpm --filter webhook-ingress test    # jest --coverage (ADR-023 thresholds)
```

Cross-package coverage: `test/src/e2e-webhook-ingress.test.ts` drives a real
event through server → runner → toolshed.

## Key environment variables

| var | meaning |
|---|---|
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for `/webhooks/github`; unset = loud warning, route rejects 401 (fail closed) |
| `ADO_WEBHOOK_USERNAME` / `ADO_WEBHOOK_PASSWORD` | basic auth for `/webhooks/ado`; either unset = loud warning, route rejects 401 |
| `PORT` | listen port (default `3100`) |
| `SQLITE_PATH` | session/audit store path (default `:memory:`) |
| `GOOSE_SERVE_URL` (fallback `GOOSE_BASE_URL`) | Goose runtime base URL (default `http://localhost:3284`) |
| `TOOLSHED_SIGNING_SECRET` | HMAC secret for `identity/v1` minion tokens (ADR-029) |

## Invariants to preserve when editing

- Verify the sender **before** touching the request body (HMAC/basic auth).
- Replies go through the governed toolshed (`verifyAndExecuteTool`), never a
  direct GitHub/ADO API call.
- Missing secrets warn loudly and fail the route closed; they must not block
  boot (a GitHub-only or ADO-only deployment stays viable).
- Deployment status: the container image is built by CI but **no Terraform
  container app deploys it yet** — keep the README's built-but-not-deployed
  note truthful if you change this.
