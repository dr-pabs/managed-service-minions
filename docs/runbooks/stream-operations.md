# Runbook — Stream Operations

Operator procedures for the Forge Ops Stream surfaces: the work queue and its
dead-letter queue (ADR-027), cost-control pauses (ADR-031), the sampling-QA
circuit breaker (ADR-032), and the escalation bridge (ADR-033).

Scope note: the item-pipeline engine, per-item cost control, and escalation
emitter are wired into the production consumer (see ADR-030's wiring note):
items are routed by `item_type` through their declarative pipeline, with
unmatched types falling back to the orchestrator-runner path. All procedures
below are live surfaces.

---

## 1. DLQ triage by reason code

Work items dead-letter on the Service Bus queue (`minion-tasks` by default,
`SERVICE_BUS_QUEUE_NAME`) with a machine-readable reason code set by the
queue-ingress (`extensions/queue-ingress/src/processor.ts`,
`cost-control.ts`). Inspect the DLQ with your Service Bus tooling of choice
(Azure portal → the queue's dead-letter subqueue, or Service Bus Explorer);
the dead-letter reason field carries one of:

| reason | meaning | operator response |
|---|---|---|
| `MALFORMED_ENVELOPE` | body failed `parseWorkItem` — not a JSON object, or missing/empty `item_type`/`idempotency_key`/`correlation_id`, or absent `payload`. No effect was attempted. | Fix the **producer**. Do not replay as-is — it will dead-letter again identically. If the item matters, re-enqueue a corrected envelope with the same `idempotency_key` (safe: idempotency short-circuits if any part already completed). |
| `POISON_MESSAGE` | well-formed item that failed repeatedly until delivery count reached the poison threshold (default 3, mirroring the queue's `max_delivery_count`). | Read the item's audit trail by `correlation_id` (dashboard `GET /api/audit?correlationId=...`) to find the failing step. Fix the underlying cause (downstream outage, bad payload semantics), then re-enqueue. A replay of an item that partially completed is safe under the idempotency store. |
| `BUDGET_EXCEEDED` | the item's accumulated model spend reached its recipe `max_cost_usd` cap (budget/v1 `scope: "item"`, `policy: "halt"`). The item halted; the queue kept flowing. | Decide whether the item was pathological (discard) or under-budgeted (raise `max_cost_usd` for its `item_type` in `recipes/item-pipelines.yaml`, redeploy config, re-enqueue). Check `warn_at_pct` warnings in the audit trail to see whether the spend ramped or spiked. |
| `ESCALATION_UNARMED` | a pipeline item reached its escalate outcome but the bridge emitter is not armed (`FORGE_INTAKE_URL`/`FORGE_BRIDGE_SECRET` unset in this deployment). | Either arm the bridge (set both env vars to match the Forge runtime) and re-enqueue, or triage the item manually from its audit trail — the attempt history is under its `correlation_id`. |
| `ESCALATION_UNRESOLVED` | the item was bridged to Flow and Flow's signed resolution came back `unresolved`. | Inspect the linked Flow run (the audit entry `toolName: bridge` carries `run_id`) and resolve manually; re-enqueue only after the underlying cause is fixed. |

Never delete DLQ messages without recording the correlation id: the DLQ is
the "no silent drops" guarantee (ADR-027/031).

## 2. Resetting a tripped sampling-QA breaker

Symptom: items of one effect type suddenly require pre-commit human approval
although their approval class is `auto` — the disagreement-rate breaker has
tripped for that type (ADR-032).

1. Confirm: `GET /api/sampling-qa` on the agent dashboard lists per-type
   stats (`reviewed`, `disagreed`, `disagreementRate`, `tripped`).
2. Investigate **before** resetting: the breaker tripped because human
   reviewers disagreed with the agent's auto-commits over the recent window.
   Review the `review_commit` approvals and the affected commits' audit
   entries; fix the prompt/recipe/policy cause.
3. Reset (clears the type's verdict window and trip state):

   ```bash
   curl -X POST "$DASHBOARD_URL/api/sampling-qa/<effectType>/reset" \
        -H "Authorization: Bearer $DASHBOARD_AUTH_TOKEN"
   ```

   (Behind Entra easy-auth, authenticate through the platform instead.)
4. Verify: `GET /api/sampling-qa` shows `tripped: false` for the type, and
   the next auto-class commit of that type commits without a pre-commit
   approval.

A reset endpoint that answers 404 means the dashboard instance has no
sampling-QA provider wired — reset at the toolshed's store directly or
restart with the wiring in place.

## 3. Daily-budget queue pause

Symptom: queue depth rises, the consumer is healthy, but nothing drains —
and KEDA may be adding replicas that also refuse to drain. This is the
daily throughput budget (ADR-031), not a stuck consumer.

1. Confirm: audit trail contains an `audit/v1` kind `budget` entry with
   status `exhausted` for today (UTC day key), written once per transition by
   the consume loop. The queue-ingress logs the transition as well.
2. Do **not** purge or dead-letter the backlog: the pause preserves work by
   design; consumption resumes automatically when the UTC accounting day
   rolls over (a `resumed` audit entry is written).
3. If the backlog cannot wait for midnight UTC: raise or unset
   `DAILY_BUDGET_MAX_COST_USD` on the queue-ingress container app and
   restart it. Treat this as a finance decision, not an ops reflex — the cap
   exists to bound a runaway day.
4. After resolution, check whether the spend was legitimate volume or a
   runaway producer (per-item `BUDGET_EXCEEDED` dead-letters alongside a
   daily exhaustion point at pathological items).

## 4. Stuck escalation envelope reconciliation

Symptom: an item escalated to Flow (pipeline outcome should become
`bridged`) but never closed — Flow's intake was down, the resolution never
returned, or signatures failed (ADR-033).

1. Find the escalation by `correlation_id`: the same id threads Stream's
   audit trail and Flow's run (correlation-id continuity is the contract).
2. Check delivery: intake refusals are synchronous — `deliverEscalation`
   surfaces HTTP failures. A 503 from `POST /api/escalations` means Flow's
   intake has no `FORGE_BRIDGE_SECRET` configured; a signature rejection
   usually means the two runtimes' `FORGE_BRIDGE_SECRET` values differ
   (note: this is deliberately a *different* secret from
   `TOOLSHED_SIGNING_SECRET`).
3. Check expiry: envelopes carry a 15-minute TTL and a nonce. An envelope
   older than its expiry will be refused by Flow; re-emit rather than
   replaying the stale envelope.
4. On the Flow side, query the run by correlation id to see whether it
   completed but the resolution was lost in transit. If Flow resolved it,
   close the Stream item manually against Flow's signed resolution; if Flow
   never received it, re-drive the escalation.
5. If the item cannot be reconciled, it must end in an explicit terminal
   state (dead-letter with a recorded reason) — never leave it silently
   half-escalated.

---

## 6. Remediation settings (2026-08-29)

The cross-repo remediation changed or added these operational surfaces:

Durability (at-most-once at deployment scale):

- `IDEMPOTENCY_STATE_CONNECTION_STRING` — when set, completed work-item
  outcomes are recorded to the shared `idempotency` Azure Table, so a
  duplicate landing on another consumer replica (the consumer scales 1–5)
  or after a restart short-circuits instead of re-running (ADR-034).
  Without it the in-memory store is used with a loud startup warning —
  single-process local dev only.
- `TOOLSHED_GOVERNANCE_STATE_CONNECTION_STRING` — one secret, two tables:
  the M18 `GovernanceState` table and the `commits` table, where the
  effect gateway records committed idempotency keys so a restart or a
  second gateway instance replays the recorded outcome without
  re-executing the effect.

Cost control:

- `DAILY_BUDGET_MAX_COST_USD` is now genuinely charged — every settled
  pipeline item's final spend (including the partial spend of a
  `BUDGET_EXCEEDED` halt) is recorded at terminal settle, and the consume
  loop pauses when the cap trips (the `budget_day_*` audit entries mark
  the transitions).
- A recipe declaring `max_cost_usd` with `PIPELINE_PRICE_PER_1K_TOKENS_USD`
  unset or zero fails startup loudly naming both variables;
  `PIPELINE_ALLOW_UNPRICED=1` opts out for simulation only.

Identity:

- `TOOLSHED_ALLOW_UNSIGNED=1` now resolves every unsigned caller to the
  fixed `dev-unsigned` principal (team `dev`) — self-reported identity
  fields are gone (ADR-035). A startup warning names the shared principal.

Verifying the durability stack locally:

    npx azurite --tableHost 127.0.0.1   # or: docker compose --profile dev up -d azurite
    AZURITE_TABLES_CONNECTION_STRING='UseDevelopmentStorage=true' pnpm --filter queue-ingress test -- azurite
    AZURITE_TABLES_CONNECTION_STRING='UseDevelopmentStorage=true' pnpm --filter mcp-toolshed test -- azurite

CI: the `contracts-and-azurite` job checks out `dr-pabs/forge-contracts`
beside the repo (drift suites run instead of skip) and runs both Azurite
suites against a service container.

---

## Related

- `docs/runbooks/production-handoff.md` (support model), `docs/error-handling.md`
- ADR-027, ADR-030, ADR-031, ADR-032, ADR-033, ADR-034, ADR-035
- forge-contracts repo: `forge-ops.execplan.md`, `forge-ops-remediation.execplan.md`, `schemas/escalation/v1/`, `schemas/budget/v1/`
