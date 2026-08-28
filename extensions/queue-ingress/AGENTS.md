# AGENTS.md — extensions/queue-ingress

Package-local agent guide (per the root `AGENTS.md` mandate: every runnable
subproject carries its own AGENTS.md). This package is the Service Bus
work-queue consumer for Stream (ADR-027) and also houses the item-pipeline
engine, verification chain, cost control, and escalation emitter as libraries
(ADR-030/031/033 — library-complete; production wiring pending, see
`src/index.ts` and the README).

## Commands

```bash
pnpm --filter queue-ingress build        # tsc -p tsconfig.json
pnpm --filter queue-ingress start        # node ./dist/index.js (the production consumer)
pnpm --filter queue-ingress test         # jest --coverage (__tests__/ only; ADR-023 thresholds)
pnpm --filter queue-ingress test:soak    # Milestone 21 thousand-item soak (soak/ only, no coverage)
```

- The default `jest.config.js` discovers only `__tests__/`; the soak lives in
  `soak/soak.test.ts` and is reached solely via `test:soak`
  (`jest.soak.config.js`). The soak asserts zero double-commits and exact
  dead-letter accounting over 850 unique + 100 duplicate + 40 poison + 10
  malformed items.
- Filtered runs (`pnpm --filter ./extensions/queue-ingress test -- <pattern>`)
  skip the coverage thresholds by design (ADR-023, 2026-08-28 amendment);
  unfiltered runs keep them.
- Cross-package coverage: `test/src/e2e-item-pipeline.test.ts` and
  `test/src/bridge-e2e.test.ts` (the latter needs a live Forge intake:
  `FORGE_INTAKE_URL` + `FORGE_BRIDGE_SECRET`).

## Key environment variables

| var | meaning |
|---|---|
| `SERVICE_BUS_CONNECTION_STRING` | set = consume real Service Bus; unset = in-memory queue (local dev/tests, loud warning) |
| `SERVICE_BUS_QUEUE_NAME` | work queue name (default `minion-tasks`; the KEDA scale target) |
| `SQLITE_PATH` | session/audit store path (default `:memory:`) |
| `GOOSE_SERVE_URL` (fallback `GOOSE_BASE_URL`) | Goose runtime base URL (default `http://localhost:3284`) |
| `TOOLSHED_SIGNING_SECRET` | HMAC secret for `identity/v1` minion tokens (ADR-029) |
| `DAILY_BUDGET_MAX_COST_USD` | optional daily throughput cap; exhaustion pauses the queue, never drops work (ADR-031) |
| `FORGE_BRIDGE_SECRET` / `FORGE_INTAKE_URL` | escalation-bridge signing secret and Flow intake URL (ADR-033; used by the bridge e2e — production wiring pending) |

## Invariants to preserve when editing

- Dead-letter reason codes are load-bearing operator vocabulary:
  `MALFORMED_ENVELOPE`, `POISON_MESSAGE`, `BUDGET_EXCEEDED`
  (`docs/runbooks/stream-operations.md` triages by them).
- Idempotency is consumer-side (`IdempotencyStore`), not broker duplicate
  detection (ADR-027); record-before-settle ordering in `processor.ts` is what
  makes redelivery safe.
- The pipeline is bounded (`max_attempts`); never add unbounded iteration here
  (that belongs to Flow, ADR-030/033).
- The daily budget pauses consumption; it must never drop or dead-letter
  queued work (ADR-031).
- Escalation envelopes sign with sorted `canonicalJson` under the **bridge**
  secret, distinct from the identity secret (ADR-033).
