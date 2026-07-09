# orchestrator

The real orchestrator runner (Milestone 11 of the remediation ExecPlan,
review finding M5 / feature F8). Replaces the Slack/Teams bots'
`createEchoRunner()` dev stub with `createOrchestratorRunner`, which:

1. Classifies the user's message intent by sending `agents/orchestrator.md`'s
   prompt to a running `goose serve` process, validated against
   `schemas/intent.json`.
2. Looks up the ordered minion DAG for that intent in `rules/intents.yaml`.
3. Mints a short-lived, HMAC-signed minion token per DAG step
   (`framework-core`'s `mintMinionToken`, Milestone 3).
4. Runs each minion via Goose with its own `agents/*.md` prompt, wrapped in
   `framework-core`'s `runWithContract` (Milestone 10: schema validation
   with one retry-with-feedback).
5. Records a `MinionRun` row per minion with status transitions
   (`running` -> `completed` | `contract_violation` | `waiting_approval`).
6. Synthesizes a chat reply from the DAG's final minion output.

On `approval_pending` from the toolshed (a destructive tool call — Milestone
4's async approval contract), the runner marks the `MinionRun`
`waiting_approval` and replies in-thread; the DAG resumes on the session's
next message, per the resume-by-resubmit contract (an identical resubmitted
`execute_tool` call recognizes an already-approved pending record by request
hash and executes it exactly once).

## The Goose wire contract (`goose-client.ts`)

`packages/framework-core/src/goose-runner.ts` (used by the echo-runner path)
already guesses that a running `goose serve` process accepts:

```
POST {baseUrl}/reply
{ "messages": [{ "role": "system"|"user", "content": "..." }], "session_id": "...", "correlation_id": "..." }
```

and returns:

```
{ "role": "assistant", "content": "..." }
```

`extensions/orchestrator/src/goose-client.ts` extracts this into a proper
`GooseClient` interface (`classifyIntent`, `runMinion`) and sends the SAME
shape, so the orchestrator and the ingress-level echo path share one wire
contract. **This shape has never been verified against a real Goose
process** in this environment — no `goose` binary was available while
building this milestone. `test/src/goose-contract.test.ts` is the
authoritative check:

- With `GOOSE_BASE_URL` unset (the default — what runs in `pnpm test`/
  `pnpm test:e2e` here and in CI), the test replays the recorded
  request/response pairs in `test/fixtures/goose/*.json` through a fetch
  double and asserts they parse. This proves `goose-client.ts`'s own
  parsing/shape logic is self-consistent with the fixtures — it does **not**
  prove a real Goose process actually returns this shape (each fixture's
  own `_comment` field says so explicitly; they are hand-authored to match
  `goose-runner.ts`'s existing guess, not captured from a live process).
- With `GOOSE_BASE_URL` set, the same test instead POSTs a real request to
  that URL and asserts the response parses as `GooseReplyResponsePayload`.
  **If a live Goose's actual response shape differs, fix
  `extensions/orchestrator/src/goose-client.ts` (and
  `packages/framework-core/src/goose-runner.ts`, which shares the guess) and
  record the discrepancy in the ExecPlan's Surprises & Discoveries with the
  real request/response evidence — do not silently adjust the fixtures to
  match without updating both.**

## Recording fresh fixtures from a local Goose

If you have the [Goose CLI](https://github.com/block/goose) installed:

```sh
# From the repo root, build the toolshed extension goose will proxy through:
pnpm --filter mcp-toolshed build

# Start goose serve with the toolshed's stdio MCP server wired in (mirrors
# extensions/orchestrator/Dockerfile's CMD):
goose serve --port 3284 --with-extension "node extensions/mcp-toolshed/dist/server.js"

# In another shell, capture a real /reply exchange (adjust the body to match
# an agents/*.md prompt you want to record a fixture for):
curl -s -X POST http://localhost:3284/reply \
  -H 'Content-Type: application/json' \
  -H 'X-Correlation-Id: corr_manual_recording' \
  -d '{
        "messages": [
          {"role": "system", "content": "You are a test probe."},
          {"role": "user", "content": "Respond with {\"ok\": true} and nothing else."}
        ],
        "session_id": "manual-recording-session",
        "correlation_id": "corr_manual_recording"
      }' | tee /tmp/goose-reply.json
```

Paste the exact request body and the exact response body into a new
`test/fixtures/goose/*.json` file following the shape of the existing
fixtures (`{"_comment": "...", "request": {...}, "response": {...}}`), then
run `GOOSE_BASE_URL=http://localhost:3284 pnpm --filter test test -- goose-contract`
to also exercise the live path against the same process while it's running.
If the recorded response shape doesn't match `GooseReplyResponsePayload`
(`{role, content}`), that's the M5 discrepancy this milestone anticipated —
fix `goose-client.ts`/`goose-runner.ts` and update the ExecPlan.

## RUNNER flag

`extensions/slack-bot/src/index.ts` and `extensions/teams-bot/src/index.ts`
select the runner via `RUNNER=orchestrator|echo`:

- `orchestrator` (the default when `GOOSE_SERVE_URL` or `GOOSE_BASE_URL` is
  set): wires `createOrchestratorRunner` with a real `createHttpGooseClient`,
  the SQLite-backed toolshed, and `TOOLSHED_SIGNING_SECRET`.
- `echo` (the default otherwise, and always available as an explicit dev
  mode via `RUNNER=echo`): `createEchoRunner()`, unchanged from before this
  milestone — useful for local smoke tests with no Goose/toolshed running.

## Untrusted-content interpolation points (Milestone 16 will quarantine these)

`src/runner.ts`'s `buildMinionUserContent` and `classifyIntent` interpolate
`request.text` (the raw user chat message) directly into every minion's
prompt with no quarantine boundary — marked with `UNTRUSTED-INTERPOLATION-POINT`
comments in the source. A future DAG step that forwards one minion's raw
`resultJson` (e.g. a ticket body, PR description, or diff fetched via
`execute_tool`) into the next minion's prompt is the other class of
interpolation point Milestone 16 (`quarantineUntrusted`) must wrap. Nothing
here builds quarantine — this milestone only marks where it needs to go.
