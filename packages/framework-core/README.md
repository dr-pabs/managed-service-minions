# framework-core

Shared TypeScript core library for the Minions Agent Framework. Everything here
is runtime-agnostic plumbing consumed by the extensions (`orchestrator`,
`mcp-toolshed`, the chat bots, `webhook-ingress`, `queue-ingress`): identity
tokens, output contracts, ingress handling, quarantine, canonical JSON, token
accounting, telemetry, and the session/audit store types.

```bash
pnpm --filter framework-core build
pnpm --filter framework-core test          # jest --coverage (thresholds per ADR-023)
```

## Minion tokens — the `identity/v1` claim set

`src/minion-token.ts` mints and verifies the signed identity every
`execute_tool` call and every effect-gateway decision is checked against
(ADR-029). The claim set is:

| claim | meaning |
|---|---|
| `agent_id` | the minion/agent identity the token was minted for |
| `scope_id` | exactly one unit of work: a Stream work-item id or a Flow run id |
| `correlation_id` | the trace id threaded end-to-end (ADR-017) |
| `exp` | expiry, epoch **milliseconds** — added by `mintMinionToken`, never caller-supplied |

Two things about this module are load-bearing and easy to break by accident:

1. **The claim insertion order is pinned** to
   `agent_id, scope_id, correlation_id, exp` (see the comment on
   `mintMinionToken`, `src/minion-token.ts:44-52`). The payload is serialised
   with plain `JSON.stringify`, so claim order **is** object-insertion order,
   and the cross-language `identity/v1` vectors shared with the Forge (Python)
   runtime depend on those exact bytes. Reordering the object literal — even
   as a no-op refactor — breaks byte-exact conformance while every local unit
   test still passes. Do not "tidy" it, and do not switch it to
   `canonicalJson`.
2. **It is deliberately not a JWT.** The token is
   `base64url(json-with-exp).base64url(HMAC-SHA256)` under one shared secret
   between two co-deployed trusted processes — no header, no `alg`
   negotiation, no third-party library surface. Verification uses
   `timingSafeEqual` and returns typed `{ ok: false, reason }` refusals, never
   exceptions. Default TTL is 15 minutes.

The legacy `minionType`/`sessionId` claim names were removed at forge-ops
Milestone 21; only the canonical names verify.

### Conformance test contract

`src/__tests__/identity-contract.test.ts` replays the shared accept/reject
vectors from the forge-contracts repository:

```bash
FORGE_CONTRACTS_DIR=/Volumes/ExtDisk1/forge-contracts pnpm --filter framework-core test
```

It reads `<FORGE_CONTRACTS_DIR>/vectors/identity/v1/vectors.json` (default
checkout path `/Volumes/ExtDisk1/forge-contracts`): `mintMinionToken` must
reproduce every accept vector byte-for-byte and `verifyMinionToken` must
reject every reject vector with its labeled reason. When the vectors file is
absent the suite **skips loudly** — a multi-line `⚠️` banner naming the
missing path and the env var to set — rather than silently passing, so a
green run without the banner really did prove conformance.

## Brief tour of the rest

- **`output-contract.ts`** — runtime enforcement of minion output JSON
  Schemas (ADR-006): compiles the schemas under `schemas/`, validates minion
  output against the type's declared contract, and implements
  retry-once-with-feedback via `runWithContract`. Also reused by the Stream
  verification chain's schema tier (ADR-030).
- **`quarantine.ts`** — prompt-injection quarantine for any text that
  originates outside the system's own prompts (ticket bodies, PR
  descriptions, diffs, webhook payloads, chat messages). Defense in depth on
  top of the toolshed governance layer, not a substitute for it.
- **`canonical-json.ts`** — deterministic JSON with recursively sorted object
  keys (arrays preserved). Used where byte-identical hashing/signing across
  serialisations matters: the toolshed's approval `requestHash` and the
  `escalation/v1` bridge signature (ADR-033). Deliberately **not** used for
  minion tokens (see the pinned-order note above).
- **`token-accounting.ts` / `token-budget.ts` / `model-cost.ts`** — the
  accounting side of cost: `extractTokenUsage` (forward-compatible read of a
  `usage.total_tokens` field) with a characters/4 fallback estimate,
  `TokenBudgetTracker` accumulation with warning/exceeded thresholds, and
  per-session cost math joining recorded runs against `rules/models.yaml`
  tier prices. The *enforcement* half for Stream (per-item and daily caps)
  lives in `extensions/queue-ingress/src/cost-control.ts` (ADR-031).
- **`ingress.ts`**, **`store.ts`**, **`correlation.ts`**, **`telemetry.ts`**,
  **`goose-runner.ts`**, **`agent-frontmatter.ts`**, **`errors.ts`**,
  **`http-retry.ts`**, **`platform-formatter.ts`** — the shared ingress
  contract (`handleIngressMessage`/`IngressRunner`), session/audit store
  types, correlation-id propagation, OpenTelemetry wiring, agent frontmatter
  parsing, typed errors, retry helpers, and chat-platform formatting.

## Related

- ADR-006 (output contracts), ADR-017 (correlation ids), ADR-023 (coverage
  gate, incl. the filtered-run amendment), ADR-029 (`identity/v1`)
- forge-contracts repo: `schemas/`, `vectors/identity/v1/`
