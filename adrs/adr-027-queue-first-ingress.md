# ADR-027: Queue-first Stream ingress (single work queue, consumer-side idempotency, KEDA on the queue-ingress)

| Key | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-28 |
| **Deciders** | Paul Brown |
| **Replaces** | — (amends ADR-012) |
| **Superseded by** | — |

---

## Context

ADR-012 chose Azure Service Bus and specified a topology of a `minion-tasks` **topic** with one **subscription per minion type** (each filtering on a `minion_type` message property), sessions for ordering, and the broker's built-in duplicate detection to prevent double-processing. That topology was designed for the chat-driven orchestration workload, where the orchestrator dispatched typed minion tasks and was itself the KEDA scale target.

The Forge Ops Stream (forge-ops execplan, forge-contracts repo, Milestone 15) changed the shape of the work: the unit of queued input is now a typed `WorkItem` envelope (`item_type`, `payload`, `idempotency_key`, `correlation_id` — `extensions/queue-ingress/src/work-item.ts`) consumed by a dedicated `queue-ingress` extension that drives the same orchestrator runner the chat and webhook ingresses use. Routing by minion type at the broker is no longer meaningful — the consumer reads every item and the item's `item_type` selects how it is handled downstream, not which subscription it lands on.

## Decision

1. **A single Service Bus queue, not a topic + per-minion-type subscriptions.** `infra/terraform/modules/service_bus/main.tf` provisions one `azurerm_servicebus_queue` named `minion-tasks` (`queue_name` variable). All Stream work items are enqueued there; `item_type` is a field of the envelope, not a broker routing property. `max_delivery_count = 3` mirrors the queue-ingress processor's poison threshold, so a repeatedly failing item dead-letters rather than looping.
2. **The KEDA scale target moves from the orchestrator to the queue-ingress.** The `azure-servicebus` custom scale rule now lives on the `queue_ingress` container app (`infra/terraform/modules/container_apps/main.tf`) in queue-mode metadata (`queueName`), replacing the topic+subscription scaler that previously lived on the orchestrator app. The consumer of the queue is the thing that scales with its depth.
3. **Idempotency is a consumer-side concern, not Service Bus duplicate detection.** The queue-ingress records completed outcomes against each item's `idempotency_key` in an `IdempotencyStore` (`extensions/queue-ingress/src/idempotency-store.ts`); a redelivery or producer-side duplicate short-circuits to the recorded outcome instead of re-running the orchestrator. Broker duplicate detection only dedupes identical `MessageId`s inside a time window and cannot return the original outcome to the duplicate — the consumer-side store gives exactly-once *effects* semantics under at-least-once delivery, which is the property Stream actually needs. The reference implementation is in-memory (`InMemoryIdempotencyStore`); the interface is the seam for a durable, replica-shared backend.
4. **Malformed and poison input dead-letters with a named reason code** — `MALFORMED_ENVELOPE` for a body that does not parse as a `WorkItem`, `POISON_MESSAGE` for a well-formed item that exhausts its delivery attempts, and `BUDGET_EXCEEDED` for an item halted by its cost cap (ADR-031) — so operators can triage the DLQ by reason (`docs/runbooks/stream-operations.md`).

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **Keep the ADR-012 topic + per-minion-type subscriptions** | Broker-side routing by `minion_type` no longer matches the consumption model: one queue-ingress consumes every work item and dispatches on the envelope's `item_type`. Per-type subscriptions would multiply infrastructure (one subscription, one scaler, one DLQ each) for zero routing benefit. |
| **Service Bus duplicate detection instead of a consumer-side store** | Dedupes only identical `MessageId`s inside a bounded window, silently drops the duplicate (no recorded outcome to return), and does nothing for redelivery after a consumer crash mid-processing. The consumer-side `IdempotencyStore` handles all three and is testable without a broker. |
| **Keep KEDA scaling on the orchestrator** | The orchestrator is no longer the queue consumer; scaling it on queue depth would scale the wrong process. The queue-ingress runs the orchestrator runner in-process, so scaling the ingress scales the work. |

## Consequences

### Positive
- One queue, one scaler, one DLQ: simpler topology that matches how the work is actually consumed.
- Idempotency semantics are owned by code the repository tests (redelivery, duplicate, and poison paths are all exercised, including by the Milestone 21 thousand-item soak in `extensions/queue-ingress/soak/`).
- Local development needs no broker at all: without `SERVICE_BUS_CONNECTION_STRING` the queue-ingress runs an in-memory queue with identical semantics.

### Negative / Mitigations
- ADR-012's session-based per-correlation ordering is not part of the work-queue topology; Stream items are independent units by design (each carries its own `idempotency_key` and `correlation_id`). Workloads needing ordered multi-step fan-out remain the orchestrator's concern.
- The reference `IdempotencyStore` is in-memory: a process restart re-runs in-flight items. Acceptable under at-least-once semantics plus idempotent commits (ADR-028); a durable shared backend is a drop-in behind the interface.

## References

- `extensions/queue-ingress/src/work-item.ts`, `processor.ts`, `idempotency-store.ts`, `consumer.ts`, `queue.ts`, `service-bus-queue.ts`
- `infra/terraform/modules/service_bus/main.tf`, `infra/terraform/modules/container_apps/main.tf`
- ADR-012 (amended by this ADR), ADR-031 (cost control), `docs/runbooks/stream-operations.md`
- `forge-ops.execplan.md` (forge-contracts repo), Milestone 15
