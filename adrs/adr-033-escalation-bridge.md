# ADR-033: Escalation bridge — signed `escalation/v1` envelopes from Stream to the Forge (Flow)

| Key | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-28 |
| **Deciders** | Paul Brown |
| **Replaces** | — |
| **Superseded by** | — |

---

## Context

Stream's item pipeline is bounded by design (ADR-030): when an item exceeds its retry, cost, or complexity thresholds, Stream must stop iterating. But "dead-letter and forget" wastes the attempt history, and unbounded iteration belongs to Flow (the Forge repo's SOP-driven runtime). The Forge Ops plan (Milestone 20) makes the hand-off a first-class, signed seam between the two runtimes: the `escalation/v1` contract in forge-contracts.

## Decision

1. **Emitter in Stream.** `extensions/queue-ingress/src/escalation.ts` assembles an `escalation/v1` envelope — the work item, its full `AttemptRecord` history (each attempt ending in a `verification/v1` verdict), the correlation id, a `cause` from the contract enum (`retry_exceeded` / `cost_cap` / `complexity`), a nonce, and a 15-minute expiry — signs it, and `deliverEscalation` POSTs it to Flow's intake endpoint (`POST /api/escalations`, mounted by `forge serve`). The signed resolution envelope Flow returns is verified before Stream closes the item (pipeline outcome `bridged`).
2. **Canonical-JSON HMAC under a dedicated bridge secret.** The signature is `base64url(HMAC-SHA256(canonicalJson(unsigned)))` — the same HMAC primitive as `identity/v1` tokens but over *sorted* canonical JSON, so both runtimes produce byte-identical signatures without a pinned insertion order. The bridge key (`FORGE_BRIDGE_SECRET`) is **separate from** the agent-identity key (`TOOLSHED_SIGNING_SECRET`): compromising agent identity must not grant the ability to forge cross-runtime escalations, and vice versa. On the Flow side the same variable gates the intake (absent → the endpoint answers 503).
3. **Correlation-id continuity across runtimes.** The envelope carries the item's correlation id, Flow materialises its run under the same id, and the resolution comes back bearing it — so one id threads the audit trails of both repositories (ADR-017 extended across the process boundary), proven end-to-end by the round-trip gate (`test/src/bridge-e2e.test.ts` against a live `forge serve`, `FORGE_INTAKE_URL`/`FORGE_BRIDGE_SECRET`).

## Wiring status (honest note)

The emitter is wired in the production queue-ingress process: `src/index.ts` arms it (via `src/pipeline-processor.ts`'s `buildEscalateEmitter`) when BOTH `FORGE_INTAKE_URL` and `FORGE_BRIDGE_SECRET` are set, and pipeline escalations then travel the signed envelope round trip; unarmed, an escalating item dead-letters as `ESCALATION_UNARMED` (with a log, never a throw), and a bridged item whose verified resolution is `unresolved` dead-letters as `ESCALATION_UNRESOLVED`. Proven by the cross-repo bridge e2e and `extensions/queue-ingress/__tests__/production-wiring.test.ts`. Deployments that bridge to Flow must set `FORGE_BRIDGE_SECRET` to the same value in both runtimes and point the emitter at Flow's intake URL.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **Reuse `TOOLSHED_SIGNING_SECRET` for the bridge** | One key would collapse two trust domains: an attacker (or bug) holding the identity key could inject fabricated escalations into Flow's intake. Separate keys keep the blast radii separate. |
| **Unsigned escalation over a private network** | The envelope crosses runtime and repository boundaries; "the network is trusted" is not a contract. Signature + expiry + nonce is cheap and testable offline. |
| **Escalate by re-enqueueing into a Flow-side queue** | Flow's intake is an HTTP endpoint with synchronous signature verification and a signed resolution path back; a queue would need its own contract for the return leg and would hide intake refusals. |
| **Pinned-insertion-order JSON (as `identity/v1` uses)** | The envelope is a large, evolving structure assembled in two languages; sorted canonical JSON removes the ordering burden entirely. The token keeps its pinned order for vector compatibility (ADR-029); the two schemes are deliberately distinct. |

## Consequences

### Positive
- Bounded Stream and iterative Flow compose: an item that outgrows the pipeline carries its evidence with it, and its closure is verifiable, auditable, and traceable end-to-end under one correlation id.
- Both halves are testable without the other repo present (signature/expiry/nonce logic is pure), and the cross-repo e2e proves the real round trip.

### Negative / Mitigations
- A second shared secret to provision and rotate. Mitigation: it is one env var on each side, and absence fails safe (Flow's intake refuses to start; an unwired emitter escalates locally as `escalated` rather than silently dropping).
- Stuck envelopes (intake down, resolution never returns) need operator reconciliation. Mitigation: `docs/runbooks/stream-operations.md` documents the triage path.

## References

- `extensions/queue-ingress/src/escalation.ts`, `item-pipeline.ts` (the `escalate` seam and `bridged` outcome)
- `test/src/bridge-e2e.test.ts`; forge-contracts: `schemas/escalation/v1/`, `forge-ops.execplan.md` Milestone 20
- ADR-017 (correlation ids — extended across runtimes by this ADR), ADR-029, ADR-030
- `docs/runbooks/stream-operations.md`
