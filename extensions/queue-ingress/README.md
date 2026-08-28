# queue-ingress

Service Bus work-item queue ingress for the Minions Agent Framework
(Milestone 15). It consumes typed `WorkItem` envelopes off a work queue and
drives the **same orchestrator runner** the chat and webhook ingresses use, so
a Stream-sourced work item takes the identical minion-DAG path as a Slack
mention or a webhook.

## The envelope

A message body is a `WorkItem`:

| field            | type     | meaning                                                        |
| ---------------- | -------- | -------------------------------------------------------------- |
| `item_type`      | `string` | the Stream item type (e.g. `ticket`, `pr`, `diff`)             |
| `payload`        | `unknown`| the item payload (its shape is the pipeline's concern, M16)    |
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
  `maxDeliveryCount` (default 3, mirroring the Service Bus subscription's
  `max_delivery_count`), then dead-lettered with reason `POISON_MESSAGE`.

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
| `SERVICE_BUS_QUEUE_NAME`       | `minion-tasks`        | Service Bus queue name                   |
| `SQLITE_PATH`                  | `:memory:`            | session/audit store path (passed to `mcp-toolshed`) |
| `GOOSE_SERVE_URL`              | `http://localhost:3284`| Goose runtime base URL                  |
| `TOOLSHED_SIGNING_SECRET`      | _(unset)_             | HMAC secret for minting minion tokens    |

## Running

```bash
pnpm --filter queue-ingress build
SERVICE_BUS_CONNECTION_STRING="Endpoint=sb://..." pnpm --filter queue-ingress start
```

## Out of scope

SIGTERM/SIGINT handling that would abort the consume loop is deliberately not
implemented in this milestone; the loop runs until the process is terminated.
The `consumeQueue` helper already accepts an `AbortSignal` so graceful shutdown
can be wired later without changing the loop.
