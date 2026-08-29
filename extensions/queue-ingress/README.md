# queue-ingress

Service Bus work-item queue ingress for the Minions Agent Framework
(forge-ops Milestone 15, ADR-027). It consumes typed `WorkItem` envelopes off
a single work queue and routes each item by `item_type`: an item whose type
has a pipeline in `recipes/item-pipelines.yaml` runs the bounded declarative
pipeline (ADR-030), and every other item drives the **same orchestrator
runner** the chat and webhook ingresses use, so a Stream-sourced work item
takes the identical minion-DAG path as a Slack mention or a webhook. The
queue is the **KEDA scale target**
(`infra/terraform/modules/container_apps/main.tf` scales this app 1–5 on
queue depth; the scaler moved here from the orchestrator).

The Stream item-processing modules this package houses:

| module | what it is | wiring status |
|---|---|---|
| `item-pipeline.ts` + `pipeline-config.ts` | the bounded classify→act→verify→commit/escalate engine and the `recipes/item-pipelines.yaml` loader (ADR-030) | **wired** — `src/pipeline-processor.ts` routes matching item types through `runItemPipeline`; unmatched types (or no recipes at all) fall back to `WorkItemProcessor` → orchestrator runner |
| `pipeline-processor.ts` | the production routing seam: recipe loading, per-`item_type` routing with fallback, the gateway commit adapter, and the escalation-emitter builder | **wired** in `src/index.ts`; exercised by `__tests__/production-wiring.test.ts` |
| `verification.ts` | the three-tier `verification/v1` chain (schema / reconcile / sampled judge) | **wired** — runs inside every pipeline-routed item; reconcile reads go through the toolshed's `verifyAndExecuteTool` |
| `cost-control.ts` | `budget/v1` enforcement: per-item ledger (`BUDGET_EXCEEDED` dead-letter) and `DailyBudget` | both **wired** in `src/index.ts` — the daily budget gates the consume loop for both routing paths; the per-item cap halts a pipeline item (price via `PIPELINE_PRICE_PER_1K_TOKENS_USD`) |
| `escalation.ts` | the `escalation/v1` bridge emitter to the Forge (Flow) intake (ADR-033) | **wired** — armed when `FORGE_INTAKE_URL` + `FORGE_BRIDGE_SECRET` are both set; unarmed, an escalating item dead-letters as `ESCALATION_UNARMED` (never throws) |

## Routing rules (ADR-030 wiring)

At startup `src/index.ts` loads `item-pipelines.yaml` from
`PIPELINES_CONFIG_PATH` (default: the repo-relative `recipes/` directory the
tests use). Then, per message:

1. A malformed envelope dead-letters as `MALFORMED_ENVELOPE` (unchanged).
2. An `item_type` **with** a pipeline runs
   classify→act→verify→commit/escalate: a passing chain commits through the
   effect gateway seam; a `BUDGET_EXCEEDED` cost-cap halt dead-letters; an
   escalation is bridged to Flow when the emitter is armed (resolved →
   complete, unresolved → `ESCALATION_UNRESOLVED`) and dead-letters as
   `ESCALATION_UNARMED` when it is not.
3. Every other `item_type` takes the original `WorkItemProcessor` →
   orchestrator runner path (logged once per item type).

The wiring is strictly additive and fail-safe: an absent or unreadable
`item-pipelines.yaml` (or one broken recipe entry) logs once and falls back —
deploying with no recipes present changes nothing. Idempotency short-circuit,
poison dead-lettering, and record-before-settle ordering are identical on
both paths, against one shared `IdempotencyStore`.

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
* **Budget-halted items dead-letter as `BUDGET_EXCEEDED`.** A pipeline-routed
  item whose accumulated model spend reaches its recipe `max_cost_usd` cap
  halts and dead-letters with reason `BUDGET_EXCEEDED` (`budget/v1`
  `scope: "item"`, `policy: "halt"`, ADR-031) — the item halts, never the
  queue around it.
* **Unroutable escalations dead-letter, never throw.** A pipeline item whose
  terminal outcome is escalation dead-letters as `ESCALATION_UNARMED` when the
  bridge emitter is not armed (`FORGE_INTAKE_URL`/`FORGE_BRIDGE_SECRET`
  unset), and as `ESCALATION_UNRESOLVED` when Flow's verified resolution came
  back `unresolved` — both with a log, so no item is silently lost. A
  transient intake failure abandons the message for redelivery instead (the
  poison path eventually trips).

Operator triage for these reason codes:
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
| `DAILY_BUDGET_MAX_COST_USD`    | _(unset = unbounded)_ | daily throughput cap (`budget/v1` `scope: "day"`, `policy: "halt"`); exhaustion pauses consumption (never drops work) and resumes on the next UTC day (ADR-031); gates both routing paths identically |
| `PIPELINES_CONFIG_PATH`        | repo-relative `recipes/` | the recipes directory holding `item-pipelines.yaml` (the yaml file path itself is accepted too); absent recipes log once and disable pipeline routing |
| `PIPELINE_PRICE_PER_1K_TOKENS_USD` | `0`               | blended USD price per 1,000 tokens for pipeline model calls (ADR-031); `0` tracks per-item spend but never trips a recipe's `max_cost_usd` |
| `FORGE_INTAKE_URL`             | _(unset)_             | Flow's escalation intake endpoint (ADR-033); with `FORGE_BRIDGE_SECRET` it arms the production escalation emitter (and the cross-repo bridge e2e) |
| `FORGE_BRIDGE_SECRET`          | _(unset)_             | `escalation/v1` bridge signing secret, deliberately **separate** from `TOOLSHED_SIGNING_SECRET` (ADR-033); both vars set = emitter armed, either unset = escalations dead-letter as `ESCALATION_UNARMED` |

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
