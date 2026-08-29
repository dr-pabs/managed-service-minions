# ADR-029: `identity/v1` token claim set (`agent_id`, `scope_id`, `correlation_id`, `exp`)

| Key | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-28 |
| **Deciders** | Paul Brown |
| **Replaces** | — |
| **Superseded by** | — |

---

## Context

The minion token (`packages/framework-core/src/minion-token.ts`) is the signed identity every `execute_tool` call and every effect-gateway decision (ADR-028) is verified against. Historically its payload used repository-local claim names (`minionType`, `sessionId`). The Forge Ops program made identity a *cross-language contract*: Stream (this repo, TypeScript) and Flow (the Forge, Python) mint and verify the same tokens, proven byte-for-byte by shared test vectors in the forge-contracts repository. That requires one canonical claim set and a deterministic serialisation.

## Decision

1. **Adopt the `identity/v1` claim set:** `{ agent_id, scope_id, correlation_id, exp }`. `agent_id` names the minion/agent; `scope_id` binds the token to exactly one unit of work (a Stream work-item id or a Flow run id — wherever a session id was bound before the rename, a work-item id may be bound now); `correlation_id` threads the trace (ADR-017); `exp` (epoch ms) is added by `mintMinionToken`, never supplied by the caller. Default TTL 15 minutes.
2. **The legacy `minionType`/`sessionId` compatibility shim is removed** (forge-ops execplan Milestone 21). Verification accepts only the canonical claim names; a token carrying legacy names is rejected as structurally incomplete.
3. **Claim insertion order is pinned** to `agent_id, scope_id, correlation_id, exp`. The payload is serialised with plain `JSON.stringify` (object-insertion order), *not* `canonicalJson` — the cross-language vectors depend on that exact byte order, so the construction order in `mintMinionToken` is load-bearing and must never be "tidied".
4. **HMAC, not JWT — reaffirmed.** The token is `base64url(json-with-exp).base64url(HMAC-SHA256)` under one shared secret between co-deployed trusted processes; there is no header, no `alg` negotiation, and no JWT library. Verification compares signatures with `timingSafeEqual` and returns typed refusal reasons, never exceptions.
5. **Conformance is enforced by shared vectors.** `packages/framework-core/src/__tests__/identity-contract.test.ts` replays the accept/reject vectors from `<forge-contracts>/vectors/identity/v1/vectors.json` (checkout located via `FORGE_CONTRACTS_DIR`, defaulting to `/Volumes/ExtDisk1/forge-contracts`). When the vectors are absent the suite skips with a loud multi-line warning rather than silently passing.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **Keep the legacy claim names with a permanent mapping shim** | Two names for one concept is drift waiting to happen across two runtimes; the shim existed only to stage the migration (M13) and was deleted on schedule (M21). |
| **JWT** | One shared secret between two trusted, co-deployed processes needs no header/alg negotiation, no key-id indirection, and no third-party library surface. (See the forge-ops ExecPlan Decision Log.) |
| **Canonical (sorted) JSON for the token payload** | Sorting would change the signed bytes and break the shipped vectors for no benefit — both minters already agree on insertion order. Sorted canonical JSON *is* used where a contract says so (e.g. `escalation/v1` envelopes, ADR-033); the two schemes are deliberately distinct. |

## Consequences

### Positive
- One identity vocabulary across both runtimes, provable offline by fixtures — a change in either repo that breaks token bytes fails a test, not production.
- `scope_id` generalises cleanly over chat sessions, work items, and Flow runs.

### Negative / Mitigations
- Pinned insertion order is an easy thing for a refactor to break invisibly (the unit tests would still pass; only the vectors catch it). Mitigation: the source comment in `mintMinionToken` states the invariant, and CI runs the conformance suite wherever `FORGE_CONTRACTS_DIR` is available.
- The conformance suite is skipped (loudly) without a forge-contracts checkout, so a laptop run without it proves less than the full bar. Mitigation: the skip banner names the missing path and the env var to set.

## References

- `packages/framework-core/src/minion-token.ts`, `packages/framework-core/src/__tests__/identity-contract.test.ts`
- forge-contracts repo: `vectors/identity/v1/vectors.json`, `schemas/`, `forge-ops.execplan.md` Milestones 13 and 21
- ADR-017 (correlation ids), ADR-028 (effect gateway — consumes verified identity)
