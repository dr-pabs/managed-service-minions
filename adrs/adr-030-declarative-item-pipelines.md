# ADR-030: Declarative item pipelines under `recipes/`

| Key | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-28 |
| **Deciders** | Paul Brown |
| **Replaces** | — |
| **Superseded by** | — |

---

## Context

Stream work items (ADR-027) need a repeatable path from raw payload to committed effect. Encoding that path as orchestrator code would invite unbounded agent iteration and per-item-type forks of the engine. The Forge Ops plan (Milestone 16) draws the line differently: iteration belongs to Flow; Stream runs a *bounded* per-item sequence expressed as configuration plus prompts, with the engine generic and item-type-agnostic.

## Decision

1. **`recipes/` is the configuration surface.** `recipes/item-pipelines.yaml` maps each `item_type` to a pipeline definition; `recipes/prompts/` holds the referenced system prompts (resolved to inline text at load); `recipes/schemas/` holds the act-output JSON Schemas, compiled through the same `loadSchemas` machinery the output-contract system (ADR-006) uses. `extensions/queue-ingress/src/pipeline-config.ts` (`loadPipeline`) validates and loads the recipe; the engine (`item-pipeline.ts`, `runItemPipeline`) knows nothing about refunds, payments, or any specific item.
2. **The pipeline is bounded: classify → act → verify → commit or escalate.** `max_attempts` bounds the act/verify retry loop — the pipeline never loops unboundedly. `on_failure` selects `dead_letter` or `escalate` (ADR-033); per-item cost caps (`max_cost_usd`, `warn_at_pct`) halt runaway items (ADR-031).
3. **Three-tier verification** (`verification.ts`, producing `verification/v1` results): **schema** — the act output must validate against its declared output contract (ADR-006); **reconcile** — declarative read-back checks through the toolshed (`server_alias`/`tool_name`/`params` with `$output.*` interpolation, asserting a read field equals an output field); **judge** — an agent scoring the output on a `sample_percent` of items. `passed` is the verifier's verdict on the work, never the agent's claim of success, and finding ids are stable across retries.
4. **Commit goes through the effect gateway** (ADR-028): the commit stanza names the `effect_type`/`target_system`/`reversibility` of the draft the pipeline hands to the gateway; the gateway's evidence gate then requires the pipeline's own passing verification result.

## Current wiring status (honest note)

`loadPipeline`/`runItemPipeline`, the per-item cost-control path, and the escalation emitter are **library-complete but not yet wired into the production process**: `extensions/queue-ingress/src/index.ts` currently routes work items straight to `WorkItemProcessor` → orchestrator runner and wires only the daily budget. The pipeline engine, recipe loader, verification chain, per-item ledger, and bridge emitter are exercised end-to-end by tests (`extensions/queue-ingress/__tests__/`, `test/src/e2e-item-pipeline.test.ts`, `test/src/bridge-e2e.test.ts`). Production wiring is pending; capability claims elsewhere in the docs carry the same qualifier.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **Per-item-type pipeline code in the orchestrator** | Every new item type would fork engine logic; bounded-ness and cost semantics would be re-implemented (or forgotten) per type. Config + prompts keeps one tested engine. |
| **Unbounded agent iteration per item ("retry until it works")** | Unbounded iteration is Flow's job, with a human-shaped SOP around it. Stream is high-volume and must terminate: `max_attempts`, then dead-letter or escalate. |
| **Trusting the agent's own success claim as verification** | The entire point of the verify tier is that `passed` is computed *about* the output (schema, reconciliation against read-back facts, sampled judge), not asserted *by* the actor. |

## Consequences

### Positive
- Adding an item type is a YAML stanza, two prompts, and a schema — no engine changes; the loader rejects malformed recipes at startup rather than at item time.
- Verification results double as the effect gateway's commit evidence, so "verified before committed" is structural.

### Negative / Mitigations
- Declarative reconcile checks cover equality assertions on read-back fields only; richer invariants need a judge or a custom verifier. Acceptable for the current item types.
- Until the production wiring lands, the shipped consumer processes items without the pipeline engine; the qualifier above must stay in the docs until it does.

## References

- `recipes/item-pipelines.yaml`, `recipes/prompts/`, `recipes/schemas/`, `recipes/README.md`
- `extensions/queue-ingress/src/item-pipeline.ts`, `pipeline-config.ts`, `verification.ts`, `index.ts`
- ADR-006 (output contracts), ADR-027, ADR-028, ADR-031, ADR-033
- `forge-ops.execplan.md` (forge-contracts repo), Milestone 16
