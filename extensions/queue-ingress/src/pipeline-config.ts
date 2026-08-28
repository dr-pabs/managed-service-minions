import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { loadSchemas, type SchemaCompileResult } from 'framework-core';
import type { ItemPipelineConfig } from './item-pipeline.js';
import type { JudgeConfig, ReconcileCheckConfig, VerifyConfig } from './verification.js';

/**
 * Loads the declarative item-pipeline recipe (Milestone 16) from a
 * `recipes/` directory: the `item-pipelines.yaml` mapping, the per-pipeline
 * prompts (resolved to inline text), and the act output JSON Schemas (compiled
 * via the same `loadSchemas` the output-contract machinery uses). Configuration
 * plus prompts is the recipe — the pipeline engine (`item-pipeline.ts`) is
 * generic and knows nothing about refunds, payments, or any specific item.
 */

const SCHEMAS_DIR = 'schemas';
const PROMPTS_DIR = 'prompts';

interface RawReconcileCheck {
  server_alias?: unknown;
  tool_name?: unknown;
  params?: unknown;
  assert?: unknown;
}

interface RawJudge {
  agent?: unknown;
  system_prompt?: unknown;
  sample_percent?: unknown;
}

interface RawVerify {
  verifier?: unknown;
  schema?: unknown;
  reconcile_checks?: unknown;
  judge?: unknown;
}

interface RawPipeline {
  max_attempts?: unknown;
  on_failure?: unknown;
  classify?: unknown;
  act?: unknown;
  verify?: unknown;
  commit?: unknown;
}

interface RawConfigFile {
  item_pipelines?: unknown;
}

export interface LoadedPipeline {
  config: ItemPipelineConfig;
  schemas: SchemaCompileResult;
  schemaMap: Map<string, string>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  assert(typeof value === 'string' && value.length > 0, `${label}.${key} must be a non-empty string`);
  return value as string;
}

function readPrompt(recipeDir: string, promptPath: string): string {
  const full = path.resolve(recipeDir, PROMPTS_DIR, promptPath);
  assert(fs.existsSync(full), `loadPipeline: prompt file not found: ${full}`);
  return fs.readFileSync(full, 'utf8');
}

function parseReconcileChecks(raw: unknown, label: string): ReconcileCheckConfig[] {
  assert(Array.isArray(raw), `${label}.reconcile_checks must be an array`);
  return (raw as RawReconcileCheck[]).map((check, index) => {
    assert(isRecord(check), `${label}.reconcile_checks[${index}] must be a mapping`);
    const serverAlias = requireString(check, 'server_alias', `${label}.reconcile_checks[${index}]`);
    const toolName = requireString(check, 'tool_name', `${label}.reconcile_checks[${index}]`);
    assert(isRecord(check.params), `${label}.reconcile_checks[${index}].params must be a mapping`);
    assert(isRecord(check.assert), `${label}.reconcile_checks[${index}].assert must be a mapping`);
    const assertRecord = check.assert;
    const readField = requireString(assertRecord, 'read_field', `${label}.reconcile_checks[${index}].assert`);
    const outputField = requireString(assertRecord, 'output_field', `${label}.reconcile_checks[${index}].assert`);
    return {
      server_alias: serverAlias,
      tool_name: toolName,
      params: check.params as Record<string, unknown>,
      assert: { read_field: readField, output_field: outputField },
    };
  });
}

function parseJudge(raw: unknown, label: string): JudgeConfig {
  assert(isRecord(raw), `${label}.judge must be a mapping`);
  const record = raw;
  const agent = requireString(record, 'agent', `${label}.judge`);
  const promptPath = requireString(record, 'system_prompt', `${label}.judge`);
  const samplePercent = record.sample_percent ?? 0;
  assert(typeof samplePercent === 'number', `${label}.judge.sample_percent must be a number`);
  assert(samplePercent >= 0 && samplePercent <= 100, `${label}.judge.sample_percent must be between 0 and 100`);
  return { agent, system_prompt: promptPath, sample_percent: samplePercent };
}

function parseVerify(raw: unknown, recipeDir: string, label: string): VerifyConfig {
  assert(isRecord(raw), `${label}.verify must be a mapping`);
  const record = raw;
  const verifier = requireString(record, 'verifier', `${label}.verify`);
  const verify: VerifyConfig = { verifier };
  if (record.schema !== undefined) {
    assert(typeof record.schema === 'boolean', `${label}.verify.schema must be a boolean`);
    verify.schema = record.schema as boolean;
  }
  if (record.reconcile_checks !== undefined) {
    verify.reconcile_checks = parseReconcileChecks(record.reconcile_checks, `${label}.verify`);
  }
  if (record.judge !== undefined) {
    const judge = parseJudge(record.judge, `${label}.verify`);
    verify.judge = { ...judge, system_prompt: readPrompt(recipeDir, judge.system_prompt) };
  }
  return verify;
}

function parseAct(raw: unknown, recipeDir: string, label: string): ItemPipelineConfig['act'] {
  assert(isRecord(raw), `${label}.act must be a mapping`);
  const record = raw;
  const agent = requireString(record, 'agent', `${label}.act`);
  const promptPath = requireString(record, 'system_prompt', `${label}.act`);
  const outputSchema = requireString(record, 'output_schema', `${label}.act`);
  return { agent, system_prompt: readPrompt(recipeDir, promptPath), output_schema: outputSchema };
}

function parseClassify(raw: unknown, recipeDir: string, label: string): ItemPipelineConfig['classify'] {
  assert(isRecord(raw), `${label}.classify must be a mapping`);
  const record = raw;
  const agent = requireString(record, 'agent', `${label}.classify`);
  const promptPath = requireString(record, 'system_prompt', `${label}.classify`);
  return { agent, system_prompt: readPrompt(recipeDir, promptPath) };
}

function parseCommit(raw: unknown, label: string): ItemPipelineConfig['commit'] {
  assert(isRecord(raw), `${label}.commit must be a mapping`);
  const record = raw;
  return {
    effect_type: requireString(record, 'effect_type', `${label}.commit`),
    target_system: requireString(record, 'target_system', `${label}.commit`),
    reversibility: requireString(record, 'reversibility', `${label}.commit`),
  };
}

/**
 * Parses and validates one raw pipeline mapping into a typed config, resolving
 * prompt paths to inline text. Exported so tests can exercise the validator's
 * error branches against inline raw objects without building files on disk.
 */
export function parsePipelineYaml(raw: unknown, itemType: string, recipeDir: string): ItemPipelineConfig {
  const label = `item pipeline '${itemType}'`;
  assert(isRecord(raw), `${label} must be a mapping`);

  const maxAttempts = raw.max_attempts ?? 1;
  assert(typeof maxAttempts === 'number' && Number.isInteger(maxAttempts), `${label}.max_attempts must be an integer`);
  assert(maxAttempts >= 1, `${label}.max_attempts must be >= 1`);

  const onFailure = raw.on_failure ?? 'dead_letter';
  assert(onFailure === 'dead_letter' || onFailure === 'escalate', `${label}.on_failure must be 'dead_letter' or 'escalate'`);

  const act = parseAct(raw.act, recipeDir, label);
  const verify = parseVerify(raw.verify, recipeDir, label);
  const commit = parseCommit(raw.commit, label);

  const config: ItemPipelineConfig = {
    item_type: itemType,
    max_attempts: maxAttempts,
    on_failure: onFailure,
    act,
    verify,
    commit,
  };

  if (raw.max_cost_usd !== undefined) {
    assert(
      typeof raw.max_cost_usd === 'number' && Number.isFinite(raw.max_cost_usd),
      `${label}.max_cost_usd must be a finite number`
    );
    assert(raw.max_cost_usd > 0, `${label}.max_cost_usd must be > 0`);
    config.max_cost_usd = raw.max_cost_usd as number;
  }
  if (raw.warn_at_pct !== undefined) {
    assert(typeof raw.warn_at_pct === 'number', `${label}.warn_at_pct must be a number`);
    assert(raw.warn_at_pct >= 0 && raw.warn_at_pct <= 100, `${label}.warn_at_pct must be between 0 and 100`);
    config.warn_at_pct = raw.warn_at_pct as number;
  }
  if (raw.classify !== undefined) {
    config.classify = parseClassify(raw.classify, recipeDir, label);
  }
  return config;
}

/**
 * Loads one item pipeline from `recipeDir` (which must contain
 * `item-pipelines.yaml`, `prompts/`, and `schemas/`). The returned
 * `schemaMap` maps the act agent to its output-schema filename so the chain's
 * schema verifier resolves it through the output-contract machinery.
 */
export function loadPipeline(recipeDir: string, itemType: string): LoadedPipeline {
  const configPath = path.join(recipeDir, 'item-pipelines.yaml');
  assert(fs.existsSync(configPath), `loadPipeline: ${configPath} not found`);

  const rawFile = yaml.load(fs.readFileSync(configPath, 'utf8')) as RawConfigFile;
  assert(isRecord(rawFile) && isRecord(rawFile.item_pipelines), 'loadPipeline: item-pipelines.yaml must define an item_pipelines mapping');

  const pipelines = rawFile.item_pipelines as Record<string, unknown>;
  assert(isRecord(pipelines[itemType]), `loadPipeline: no pipeline for item type '${itemType}'`);

  const config = parsePipelineYaml(pipelines[itemType], itemType, recipeDir);
  const schemas = loadSchemas(path.join(recipeDir, SCHEMAS_DIR));
  const schemaMap = new Map<string, string>([[config.act.agent, config.act.output_schema]]);
  return { config, schemas, schemaMap };
}
