import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { buildMinionTypeToSchemaMap } from './agent-frontmatter.js';

/**
 * Runtime enforcement of minion output JSON Schemas (Milestone 10, review
 * finding M6 / feature F7: "Schema validation is prompt-level only —
 * nothing runs ajv/zod against minion outputs; retry_once_with_feedback has
 * no code behind it").
 *
 * This module is a library only. It does not run minions or know about
 * Goose, the orchestrator DAG, or MinionRun persistence — Milestone 11's
 * orchestrator runner wraps every minion call in `runWithContract` and is
 * responsible for turning a `ContractViolation` into a `MinionRun` status
 * transition and a chat-visible error. See the ExecPlan Interfaces and
 * Dependencies section for the authoritative name list.
 *
 * All eight schemas under `schemas/` declare
 * `"$schema": "https://json-schema.org/draft/2020-12/schema"`, so this
 * module compiles them with `ajv/dist/2020.js` (the entry point ajv ships
 * specifically for draft 2020-12; the default `ajv` export only understands
 * draft-07). None of the eight schemas use the `format` keyword, so
 * `ajv-formats` is not a dependency here — see the ExecPlan Decision Log.
 */

export interface SchemaCompileResult {
  /** Schema filename (e.g. `code-writer-output.json`) -> compiled validator. */
  validators: Map<string, ValidateFunction>;
}

/**
 * Compiles every `schemas/*-output.json` file plus `schemas/intent.json`
 * (the orchestrator's own output contract) found directly under
 * `schemasDir`, keyed by filename. Throws if any file fails to parse as
 * JSON or fails to compile as a schema — a malformed schema is a build-time
 * defect, not a runtime one, so this is meant to be called eagerly at
 * startup (or once per test file), not per minion call.
 */
export function loadSchemas(schemasDir: string): SchemaCompileResult {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validators = new Map<string, ValidateFunction>();

  const files = fs
    .readdirSync(schemasDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  for (const file of files) {
    const fullPath = path.join(schemasDir, file);
    let schema: unknown;
    try {
      schema = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (err) {
      throw new Error(`loadSchemas: ${file} is not valid JSON: ${(err as Error).message}`);
    }
    try {
      validators.set(file, ajv.compile(schema as Record<string, unknown>));
    } catch (err) {
      throw new Error(`loadSchemas: ${file} failed to compile as a JSON Schema: ${(err as Error).message}`);
    }
  }

  return { validators };
}

/**
 * `minion_type -> output_schema` map, sourced from `agents/*.md`
 * frontmatter via `buildMinionTypeToSchemaMap` (the SAME convention
 * Milestone 1's `scripts/validate-config.ts` cross-checks: frontmatter
 * `output_schema` must point to an existing file under `schemas/`). Kept
 * separate from schema *compilation* (`loadSchemas`) so a caller can load
 * schemas once and re-map minion types cheaply, and so tests can exercise
 * each independently.
 */
export function loadMinionSchemaMap(repoRoot: string): Map<string, string> {
  return buildMinionTypeToSchemaMap(repoRoot);
}

export type ValidationOutcome = { valid: true } | { valid: false; errors: string[] };

/**
 * Validates `output` against the JSON Schema registered for `minionType`.
 * `schemaMap` is `minion_type -> output_schema path relative to repoRoot`
 * (see `loadMinionSchemaMap`); `schemas` is the compiled set keyed by
 * filename (see `loadSchemas`) — the schema path's basename is the lookup
 * key, so `schemas/code-writer-output.json` resolves to the
 * `code-writer-output.json` entry.
 *
 * A `minionType` absent from `schemaMap`, or whose schema file was not
 * compiled into `schemas`, is treated as invalid with a descriptive error
 * rather than throwing — a caller mid-DAG should get a `ContractViolation`
 * for a config-drift bug, not a crash.
 */
export function validateMinionOutput(
  minionType: string,
  output: unknown,
  schemaMap: Map<string, string>,
  schemas: SchemaCompileResult
): ValidationOutcome {
  const schemaPath = schemaMap.get(minionType);
  if (!schemaPath) {
    return { valid: false, errors: [`no output_schema is registered for minion type "${minionType}"`] };
  }

  const schemaFile = path.basename(schemaPath);
  const validate = schemas.validators.get(schemaFile);
  if (!validate) {
    return {
      valid: false,
      errors: [`schema file "${schemaFile}" for minion type "${minionType}" was not compiled by loadSchemas`],
    };
  }

  const valid = validate(output);
  if (valid) {
    return { valid: true };
  }

  // ajv always populates `.errors` (with `.message` set) when `validate()`
  // returns false and `allErrors: true` is configured, as it is in
  // `loadSchemas` — there is no reachable case where `errors` ends up
  // empty, so this does not defensively guard against one.
  const errors = validate.errors!.map((e) => `${e.instancePath || '(root)'} ${e.message}`.trim());
  return { valid: false, errors };
}

/**
 * Result of `runWithContract`. `attempts` is 1 (valid on the first try) or
 * 2 (valid only after the retry-with-feedback). A `ContractViolation` means
 * the output was still invalid after the retry — this is a typed failure
 * value, not a thrown error, so a DAG runner (Milestone 11) can decide what
 * to do (fail the run, surface a chat error) instead of crashing.
 */
export type ContractResult<T> =
  | { status: 'valid'; output: T; attempts: 1 | 2 }
  | ContractViolation;

export interface ContractViolation {
  status: 'contract_violation';
  minionType: string;
  errors: string[];
  attempts: 2;
  /** The raw (invalid) output from the final attempt, for diagnostics/audit. */
  lastOutput: unknown;
}

export interface RunWithContractOptions {
  minionType: string;
  schemaMap: Map<string, string>;
  schemas: SchemaCompileResult;
}

/**
 * Implements `rules/governance.yaml`'s
 * `fallback_behavior.on_invalid_json_output: retry_once_with_feedback`.
 *
 * `runMinion` is called with no arguments on the first attempt. If its
 * resolved output fails schema validation, `runMinion` is called EXACTLY
 * ONCE more, this time passed the validation errors from the first attempt
 * (`runMinion(feedbackErrors)`) so a real implementation can append them to
 * the model prompt and ask it to correct its output. If the second attempt
 * is also invalid, the result is a typed `ContractViolation` — this
 * function never throws for a validation failure (a thrown error would
 * crash the orchestrator DAG; see the Milestone 10 scope note in the
 * ExecPlan). Errors thrown by `runMinion` itself (e.g. a network failure)
 * are NOT caught here — that is a different failure mode than an invalid
 * output and is the caller's concern (Milestone 11's `retry_up_to_3` /
 * `on_minion_timeout` handling).
 */
export async function runWithContract<T = unknown>(
  runMinion: (feedback?: string[]) => Promise<T>,
  opts: RunWithContractOptions
): Promise<ContractResult<T>> {
  const first = await runMinion();
  const firstOutcome = validateMinionOutput(opts.minionType, first, opts.schemaMap, opts.schemas);
  if (firstOutcome.valid) {
    return { status: 'valid', output: first, attempts: 1 };
  }

  const second = await runMinion(firstOutcome.errors);
  const secondOutcome = validateMinionOutput(opts.minionType, second, opts.schemaMap, opts.schemas);
  if (secondOutcome.valid) {
    return { status: 'valid', output: second, attempts: 2 };
  }

  return {
    status: 'contract_violation',
    minionType: opts.minionType,
    errors: secondOutcome.errors,
    attempts: 2,
    lastOutput: second,
  };
}
