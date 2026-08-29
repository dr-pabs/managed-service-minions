# ADR-034: Durable Idempotency and Commit Records

## Status

Accepted

## Date

2026-08-29

## Context

Two at-most-once guarantees were per-process only. The queue-ingress
idempotency store (`extensions/queue-ingress/src/idempotency-store.ts`)
shipped in-memory at M15 under ADR-025's single-replica posture — but M18
scaled the consumer to 1–5 replicas, so a duplicate delivery landing on
another replica (or after a restart) re-ran the item. The effect gateway's
commit deduplication on `idempotency_key` (`extensions/mcp-toolshed/src/
effect-gateway.ts`) was likewise in-process: a restart or a second replica
holding the same key could double-commit a replayed commit. The assessment
(2026-08-29) ranked both P1.

## Decision

Both records move to Azure Tables — the same storage account and pattern
ADR-026 established for shared governance state, so one operational surface
covers all three:

- `TableIdempotencyStore` (queue-ingress, table `idempotency` behind
  `IDEMPOTENCY_STATE_CONNECTION_STRING`): completed work-item outcomes,
  `IdempotencyStore` made async, `set` an insert-if-absent whose 409 is the
  first-writer-wins duplicate outcome across replicas; a corrupt row is a
  loud miss (the gateway's idempotency keys remain the backstop). Terraform
  provisions the table and injects the connection string.
- `TableCommitRecordStore` (mcp-toolshed, table `commits` behind
  `TOOLSHED_GOVERNANCE_STATE_CONNECTION_STRING`): the gateway consults it
  before gating — a key committed before a restart or by another replica
  replays its recorded outcome without executing the connector — and writes
  it before acknowledging a fresh commit, adopting the winner's outcome on a
  lost put race. Wired at the gateway's only production construction site
  (queue-ingress's `src/index.ts`).

Both are covered by hermetic 404/409-semantics fakes and live-Azurite
integration suites (concurrent clients, gateway replay across instances);
the CI `contracts-and-azurite` job runs the latter against an emulator.

## Consequences

- The M15 acceptance ("duplicate delivery of the same item commits at most
  one effect") now holds at deployment scale, and commit idempotency
  survives restarts — demonstrated, not assumed.
- The in-memory stores remain the no-configuration default (loudly warned)
  for local development; production sets the connection strings.
