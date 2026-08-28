# ADR-028: Effect gateway — agents draft, only the gateway commits

| Key | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-28 |
| **Deciders** | Paul Brown |
| **Replaces** | — (extends ADR-007) |
| **Superseded by** | — |

---

## Context

ADR-007 established human-in-the-loop approval for destructive operations, enforced by the toolshed's governance rules (`rules/governance.yaml`) at the tool-call boundary. Stream raises the stakes: item pipelines produce externally visible side effects (refunds, payments, ticket transitions) at queue-driven volume, where "a human approves every destructive call" does not scale and "the agent calls the connector directly" is unacceptable. The Forge Ops plan (Milestone 14) introduces the `effects/v1` contract: every side effect exists first as an inert draft, and a separate, credential-holding component decides whether it happens.

## Decision

Ship the effect gateway as an in-process MCP server in the toolshed (`extensions/mcp-toolshed/src/effect-gateway.ts`, alias `effect_gateway`, tools `draft_effect` / `commit_effect` / `discard_effect`), the TypeScript mirror of Flow's `forge/tools/effect_gateway.py`.

1. **Agents draft; only the gateway commits.** `draft_effect` produces an inert `effect_draft` record; the gateway is the only component holding the connector credentials that reach the outside world (`EffectCredentials` masks secret values everywhere they could serialise). A commit or discard writes a `decision_record`.
2. **Evidence gate.** A commit requires a passing `verification/v1` result among the draft's evidence references, resolved through a `VerificationResolver`. A draft with no passing evidence can never commit — an empty evidence array is a valid draft that is simply uncommittable.
3. **Approval classes and reversibility.** Every `effect_type` must be declared with a `reversibility` (`reversible` / `compensatable` / `irreversible`) and an `approval_class` (`auto` / `sampled` / `always_human`); an undeclared type is refused by default. `sampled` routes a configurable fraction of commits through pre-commit human approval; `always_human` always does.
4. **Verified identity, never parameters.** The actor on a commit or discard comes only from the calling context's verified `identity/v1` token (ADR-029) — a smuggled `actor`, `token`, or `approver_id` parameter is rejected. With no signing secret configured, no commit or discard can proceed (fail closed).
5. **Irreversible refuses agent actors.** An `irreversible` (or `always_human`) draft can never be decided by an agent actor: a named human, reached through a resolved approval carrying an authenticated `approver_id`, is required on commit **and on discard alike**.
6. **Idempotent commits.** Commits are idempotent on the draft's `idempotency_key`: an already-committed draft (or a sibling sharing the key) replays the recorded outcome without re-executing the connector. Decisions are serialised through an internal lock so concurrent commits cannot double-execute.
7. **`commit_effect` is injected as destructive at runtime.** `ensureEffectGatewayRules()` pins `effect_gateway.commit_effect` into the governance config's destructive-actions list whenever the gateway is wired into a toolshed, *outside* `rules/governance.yaml` — so a commit surfaces a human-visible approval under ADR-007's machinery even under an empty or stale governance file. The injection is idempotent; `discard_effect` is deliberately not destructive.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **Agents call connectors directly, gated by ADR-007 approvals alone** | Puts external credentials in the agent's reach and makes every side effect a bespoke tool call with no uniform evidence gate, idempotency, or decision record. |
| **List `commit_effect` in `rules/governance.yaml` instead of runtime injection** | A config file can be edited, trimmed, or forgotten; the invariant "a commit is always destructive" is safety-critical, so it is enforced in code and merely *mirrored* by documentation. |
| **Pre-commit human approval for everything (no `auto`/`sampled`)** | Does not scale to queue-driven Stream volume; the sampling QA loop (ADR-032) provides the statistical backstop that makes `auto` defensible. |

## Consequences

### Positive
- One choke point for all external side effects, with a uniform audit trail (`effect_draft` / `effect_commit` / `effect_discard` events) keyed by correlation id (ADR-017).
- The commit boundary composes with the rest of the governance stack: pre-commit approvals reuse the toolshed's existing `PendingApproval` store and notification surfaces, and post-hoc sampling QA (ADR-032) hangs off agent-actor commits.
- Fail-closed defaults throughout: unknown effect types, missing evidence, unverified identity, unnamed approvers, and unmounted connectors are all refusals, never fallthroughs.

### Negative / Mitigations
- Every effectful pipeline step pays the draft→commit round trip. Mitigation: drafts are cheap in-process records, and idempotent replay makes retries free.
- The runtime-injected destructive rule means `rules/governance.yaml` alone understates the real rule set. Mitigation: the file carries a comment saying exactly that, and this ADR is the authoritative record.

## References

- `extensions/mcp-toolshed/src/effect-gateway.ts`, `effect-store.ts`, `sampling-qa.ts`
- ADR-005 (tool allowlisting — `effect_gateway` is in-process and needs no allowlist entries), ADR-007 (extended by this ADR), ADR-017, ADR-029, ADR-032
- `forge-ops.execplan.md` (forge-contracts repo), Milestone 14; `effects/v1` contract in forge-contracts
