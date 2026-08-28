# recipes/

The declarative configuration surface for Stream item pipelines (ADR-030,
forge-ops execplan Milestone 16). Configuration plus prompts **is** the
recipe: the pipeline engine (`extensions/queue-ingress/src/item-pipeline.ts`)
is generic and knows nothing about refunds, payments, or any specific item —
adding an item type means editing files here, not the engine.

## Layout

```
recipes/
  item-pipelines.yaml     # one entry per Stream item_type
  prompts/                # system prompts referenced by the yaml (resolved to inline text at load)
    refund-classify.md
    refund-act.md
    refund-judge.md
  schemas/                # act-output JSON Schemas, compiled via framework-core's loadSchemas
    refund-action-output.json
    verification-v1.json
```

## `item-pipelines.yaml` schema

Top level is an `item_pipelines:` mapping keyed by `item_type`. Each entry
(validated by `extensions/queue-ingress/src/pipeline-config.ts`; malformed
recipes are rejected at load with a labelled error):

| key | required | default | meaning |
|---|---|---|---|
| `max_attempts` | no | `1` | integer >= 1; bounds the act/verify retry loop. Unbounded iteration belongs to Flow, never here. |
| `on_failure` | no | `dead_letter` | `dead_letter` or `escalate` (escalate = signed `escalation/v1` envelope to Flow, ADR-033) |
| `max_cost_usd` | no | _(uncapped)_ | hard per-item cost cap (budget/v1 `scope: "item"`, `policy: "halt"`); reaching it dead-letters the item as `BUDGET_EXCEEDED` — the item halts, never the queue (ADR-031) |
| `warn_at_pct` | no | — | 0–100; percentage of `max_cost_usd` at which the warning crossing fires |
| `classify` | no | — | `{ agent, system_prompt }` — optional classification step before act |
| `act` | **yes** | — | `{ agent, system_prompt, output_schema }` — the acting agent; `output_schema` names a file under `schemas/` |
| `verify` | **yes** | — | the verification chain, see below |
| `commit` | **yes** | — | `{ effect_type, target_system, reversibility }` — the effect draft handed to the effect gateway (ADR-028) |

`system_prompt` values are file paths relative to `prompts/`; the loader
inlines the file contents and fails if the file is missing.

### `verify` — the three-tier chain (ADR-030)

| key | required | meaning |
|---|---|---|
| `verifier` | **yes** | the verifier name stamped on `verification/v1` results |
| `schema` | no | `true` = validate the act output against its `output_schema` via the output-contract machinery (ADR-006) |
| `reconcile_checks` | no | array of declarative read-back checks: `{ server_alias, tool_name, params, assert: { read_field, output_field } }`. A `params` value of the form `"$output.<path>"` is interpolated from the act output (e.g. `order_id: "$output.order_id"`); the check reads a fact through the toolshed and asserts `read_field` of the read equals `output_field` of the output. |
| `judge` | no | `{ agent, system_prompt, sample_percent }` — an agent scoring the output, run on `sample_percent` (0–100) of items |

`passed` on the resulting `verification/v1` record is the verifier's verdict
on the work, never the acting agent's claim of success; finding ids are
stable across retries so a persisting failure is distinguishable from a new
one.

## How tests exercise this

The shipped `refund_request` recipe is executed for real by:

- `extensions/queue-ingress/__tests__/pipeline-config.test.ts` — loader
  validation, prompt/schema resolution, every error branch;
- `extensions/queue-ingress/__tests__/item-pipeline.test.ts`,
  `verification.test.ts`, `cost-control.test.ts`, `escalation.test.ts` — the
  engine, chain, budget, and escalation behavior;
- `test/src/e2e-item-pipeline.test.ts` — cross-package end-to-end: recipe →
  engine → toolshed → effect gateway;
- `test/src/bridge-e2e.test.ts` — the `escalate` path round-tripped against a
  live Forge (Flow) intake.

## Wiring status (honest note)

`loadPipeline`/`runItemPipeline` are **library-complete but not yet wired
into the production queue-ingress process**: `extensions/queue-ingress/src/index.ts`
currently routes work items straight to `WorkItemProcessor` → orchestrator
runner and wires only the daily budget. Until that production wiring lands,
this directory is exercised by the tests above, not by the deployed consumer.
See ADR-030's wiring note.
