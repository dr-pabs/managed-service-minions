# queue-ingress

Service Bus work-item queue ingress for the Minions Agent Framework
(forge-ops Milestone 15, ADR-027). It consumes typed `WorkItem` envelopes off
a single work queue and drives the **same orchestrator runner** the chat and
webhook ingresses use, so a Stream-sourced work item takes the identical
minion-DAG path as a Slack mention or a webhook. The queue is the **KEDA
scale target** (`infra/terraform/modules/container_apps/main.tf` scales this
app 1–5 on queue depth; the scaler moved here from the orchestrator).

Beyond the consumer, this package houses the Stream item-processing libraries:

| module | what it is | wiring status |
|---|---|---|
| `item-pipeline.ts` + `pipeline-config.ts` | the bounded classify→act→verify→commit/escalate engine and the `recipes/item-pipelines.yaml` loader (ADR-030) | **library-complete; production wiring pending** — `src/index.ts` routes work items straight to `WorkItemProcessor` → orchestrator runner |
| `verification.ts` | the three-tier `verification/v1` chain (schema / reconcile / sampled judge) | library-complete; production wiring pending |
| `cost-control.ts` | `budget/v1` enforcement: per-item ledger (`BUDGET_EXCEEDED` dead-letter) and `DailyBudget` | daily budget **wired** in `src/index.ts`; per-item path library-complete, wiring pending |
| `escalation.ts` | the `escalation/v1` bridge emitter to the Forge (Flow) intake (ADR-033) | library-complete; production wiring pending (proven by `test/src/bridge-e2e.test.ts`) |

## The envelope

A message body is a `WorkItem`:

| field            | type     | meaning                                                        |
| ---------------- | -------- | -------------------------------------------------------------- |
| `item_type`      | `string` | the Stream item type (e.g. `ticket`, `pr`, `refund_request`)   |
| `payload`        | `unknown`| the item payload (its shape is the pipeline's concern — see `recipes/item-pipelines.yaml` and `recipes/README.md`) |
| `idempotency_key`| `string` | stable key; a redelivery short-circuits to the recorded result |
| `correlation_id` | `string` | root correlation id — preserved end-to-end on the runner       |

Any body that fails `parseWorkItem` (non-object, or missing/empty required
string fields, or absent `payload`) is dead-lettered with reason
`MALFORMED_ENVELOPE`.

## Redelivery safety

* **At-most-once effect commits.** A completed `idempotency_key` is recorded
  *before* the message is settled; a duplicate delivery or redelivery of the
  same key short-circuits to the recorded outcome without re-running the
  runner.
* **Poison messages never silently drop.** A well-formed item that repeatedly
  fails is abandoned for redelivery until its delivery count reaches
  `maxDeliveryCount` (default 3, mirroring the Service Bus queue's
  `max_delivery_count`), then dead-lettered with reason `POISON_MESSAGE`.
* **Budget-halted items dead-letter as `BUDGET_EXCEEDED`.** An item whose
  accumulated model spend reaches its recipe `max_cost_usd` cap halts and
  dead-letters with reason `BUDGET_EXCEEDED` (`budget/v1` `scope: "item"`,
  `policy: "halt"`, ADR-031) — the item halts, never the queue around it.
  (Per-item enforcement lives in the pipeline engine; see the wiring table
  above.)

Operator triage for all three reason codes:
`docs/runbooks/stream-operations.md`.

## Backends

The queue is one interface (`WorkItemQueue`) with two implementations — the
same dual-backend shape as `mcp-toolshed`'s `store.ts`:

* `InMemoryWorkItemQueue` — local dev and tests; no cloud dependency.
* `ServiceBusWorkItemQueue` — the real Azure Service Bus consumer. The
  `@azure/service-bus` SDK is loaded **only** via a dynamic import inside
  `ServiceBusWorkItemQueue.connect`, so the package (and its test suite) runs
  without the SDK present.

## Configuration

| env var                        | default               | meaning                                  |
| ------------------------------ | --------------------- | ---------------------------------------- |
| `SERVICE_BUS_CONNECTION_STRING`| _(unset)_             | when set, consume real Service Bus; otherwise use the in-memory queue |
| `SERVICE_BUS_QUEUE_NAME`       | `minion-tasks`        | Service Bus queue name (the KEDA scale target) |
| `SQLITE_PATH`                  | `:memory:`            | session/audit store path (passed to `mcp-toolshed`) |
| `GOOSE_SERVE_URL` (fallback: `GOOSE_BASE_URL`) | `http://localhost:3284`| Goose runtime base URL |
| `TOOLSHED_SIGNING_SECRET`      | _(unset)_             | HMAC secret for minting `identity/v1` minion tokens (ADR-029) |
| `DAILY_BUDGET_MAX_COST_USD`    | _(unset = unbounded)_ | daily throughput cap (`budget/v1` `scope: "day"`, `policy: "halt"`); exhaustion pauses consumption (never drops work) and resumes on the next UTC day (ADR-031) |
| `FORGE_INTAKE_URL`             | _(unset)_             | Flow's escalation intake endpoint (ADR-033); used by the cross-repo bridge e2e today — production wiring pending |
| `FORGE_BRIDGE_SECRET`          | _(unset)_             | `escalation/v1` bridge signing secret, deliberately **separate** from `TOOLSHED_SIGNING_SECRET` (ADR-033); same wiring status as above |

## Running

```bash
pnpm --filter queue-ingress build
SERVICE_BUS_CONNECTION_STRING="Endpoint=sb://..." pnpm --filter queue-ingress start
```

## Testing

```bash
pnpm --filter queue-ingress test        # unit suite (__tests__/), jest --coverage
pnpm --filter queue-ingress test:soak   # Milestone 21 thousand-item soak (soak/ only)
```

The soak drives the real in-memory queue + processor + idempotency store +
consume loop over 1,000 messages (850 unique, 100 duplicates, 40 poison, 10
malformed) and asserts zero double-commits and exact dead-letter accounting.
It is excluded from the default jest run (`testMatch` only discovers
`__tests__/`) and carries no coverage threshold — it is a correctness/scale
check, not a coverage target.

## Out of scope

SIGTERM/SIGINT handling that would abort the consume loop is deliberately not
implemented in this milestone; the loop runs until the process is terminated.
The `consumeQueue` helper already accepts an `AbortSignal` so graceful shutdown
can be wired later without changing the loop.
