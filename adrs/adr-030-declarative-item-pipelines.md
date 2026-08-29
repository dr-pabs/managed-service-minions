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

## Current wiring status

**Wired into the production process** (this ADR's earlier "wiring pending" note is closed). `extensions/queue-ingress/src/index.ts` loads the recipes at startup (`PIPELINES_CONFIG_PATH`, default repo `recipes/`) and routes each work item by `item_type` through `src/pipeline-processor.ts`: a matching pipeline runs `runItemPipeline` — with the per-item cost cap (ADR-031, `BUDGET_EXCEEDED` dead-letter), the verification chain's reconcile reads through the toolshed's `verifyAndExecuteTool`, the effect-gateway commit seam, and the escalation emitter armed by `FORGE_INTAKE_URL` + `FORGE_BRIDGE_SECRET` (ADR-033) — while an unmatched `item_type` falls back to the original `WorkItemProcessor` → orchestrator runner path. The wiring is strictly additive and fail-safe: absent or broken recipes log once and disable pipeline routing, so deploying with no recipes present changes nothing. Covered by `extensions/queue-ingress/__tests__/production-wiring.test.ts` and `pipeline-processor.test.ts` alongside the pre-existing engine tests (`__tests__/`, `test/src/e2e-item-pipeline.test.ts`, `test/src/bridge-e2e.test.ts`).

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
- The production effect gateway is constructed with the recipes' commit policies but no external connectors are registered yet, so a passing item whose commit the gateway refuses escalates (bridged to Flow when armed, `ESCALATION_UNARMED` dead-letter when not) rather than acting — fail-safe until real connectors land.

## References

- `recipes/item-pipelines.yaml`, `recipes/prompts/`, `recipes/schemas/`, `recipes/README.md`
- `extensions/queue-ingress/src/item-pipeline.ts`, `pipeline-config.ts`, `verification.ts`, `pipeline-processor.ts`, `index.ts`
- ADR-006 (output contracts), ADR-027, ADR-028, ADR-031, ADR-033
- `forge-ops.execplan.md` (forge-contracts repo), Milestone 16
