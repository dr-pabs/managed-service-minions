import { validateMinionOutput, type SchemaCompileResult } from 'framework-core';

/**
 * The `verification/v1` result shape (Milestone 16) — one verifier's verdict
 * on an item's action. Mirrors the cross-language contract under
 * forge-contracts/schemas/verification/v1/schema.json: `passed`, `verifier`,
 * `findings`, `metrics`, `cost_usd` are required; `evidence_ref` is optional.
 * `passed` is the verifier's verdict on the work, never the agent's claim of
 * success. Finding `id`s are stable across retries (derived from the detected
 * condition — rule, mismatch kind, record identity — never the attempt
 * number), so a persisting failure is observable and a resolved one is
 * distinguishable from a new one.
 */
export interface VerificationFinding {
  id: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  location?: string;
}

export interface VerificationMetrics {
  [key: string]: number;
}

export interface VerificationResult {
  passed: boolean;
  verifier: string;
  findings: VerificationFinding[];
  metrics: VerificationMetrics;
  cost_usd: number;
  evidence_ref?: string;
}

/** One declarative reconcile check: read a fact and compare it against the output. */
export interface ReconcileCheckConfig {
  server_alias: string;
  tool_name: string;
  /** Tool params; a value of `"$output.<path>"` is resolved from the act output. */
  params: Record<string, unknown>;
  assert: { read_field: string; output_field: string };
}

/** The judge verifier: an agent scoring the output, run on a sample percentage. */
export interface JudgeConfig {
  agent: string;
  system_prompt: string;
  sample_percent: number;
}

/** The verify chain configuration, per item type (schema -> reconcile -> judge). */
export interface VerifyConfig {
  verifier: string;
  schema?: boolean;
  reconcile_checks?: ReconcileCheckConfig[];
  judge?: JudgeConfig;
}

export interface ReconcileReadResult {
  status: string;
  data?: unknown;
  error?: string;
  approvalId?: string;
}

export interface JudgeVerdict {
  passed: boolean;
  findings?: VerificationFinding[];
}

/** Everything the chain needs to verify one act output. */
export interface VerificationContext {
  minionType: string;
  output: unknown;
  schemaMap: Map<string, string>;
  schemas: SchemaCompileResult;
  minionToken: string;
  correlationId: string;
  attempt: number;
  sessionId: string;
  reconcile(args: { serverAlias: string; toolName: string; params: unknown }): Promise<ReconcileReadResult>;
  judge?(args: { userContent: string }): Promise<JudgeVerdict>;
  random?: () => number;
}

export interface ChainResult {
  results: VerificationResult[];
  composite: VerificationResult;
  passed: boolean;
}

/** The evidence reference the commit step cites for a passing chain (Milestone 14 gateway). */
export function evidenceRef(correlationId: string): string {
  return `verify://${correlationId}/verify`;
}

function itemName(verifier: string): string {
  const idx = verifier.indexOf(':');
  return idx === -1 ? 'item' : verifier.slice(idx + 1);
}

function outputField(output: unknown, path: string): unknown {
  let current: unknown = output;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveParamTemplate(value: unknown, output: unknown): unknown {
  if (typeof value !== 'string' || !value.startsWith('$output.')) {
    return value;
  }
  return outputField(output, value.slice('$output.'.length));
}

function deepEquals(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** A stable finding id for a schema error, keyed to the failing instance path. */
export function schemaFindingId(error: string): string {
  const match = /^(\S+)\s/.exec(error);
  return `schema.invalid:${match ? match[1] : 'root'}`;
}

function runSchemaVerifier(ctx: VerificationContext): VerificationResult {
  const outcome = validateMinionOutput(ctx.minionType, ctx.output, ctx.schemaMap, ctx.schemas);
  const verifier = `schema:${ctx.minionType}`;
  if (outcome.valid) {
    return {
      passed: true,
      verifier,
      findings: [{ id: 'schema.valid', message: 'output conforms to its declared JSON Schema', severity: 'info' }],
      metrics: { checks_run: 1 },
      cost_usd: 0,
    };
  }
  return {
    passed: false,
    verifier,
    findings: outcome.errors.map((error) => ({
      id: schemaFindingId(error),
      message: error,
      severity: 'error' as const,
      location: ctx.minionType,
    })),
    metrics: { checks_run: 1 },
    cost_usd: 0,
  };
}

async function runReconcileVerifier(
  config: VerifyConfig,
  ctx: VerificationContext
): Promise<VerificationResult | null> {
  const checks = config.reconcile_checks ?? [];
  if (checks.length === 0) {
    return null;
  }
  const findings: VerificationFinding[] = [];
  let passed = true;
  for (const check of checks) {
    const params = Object.fromEntries(
      Object.entries(check.params).map(([key, value]) => [key, resolveParamTemplate(value, ctx.output)])
    );
    const read = await ctx.reconcile({ serverAlias: check.server_alias, toolName: check.tool_name, params });
    if (read.status !== 'success') {
      passed = false;
      findings.push({
        id: `reconcile.${check.server_alias}.${check.tool_name}.read_failed`,
        message: `reconcile read ${check.server_alias}.${check.tool_name} failed: ${read.error ?? read.status}`,
        severity: 'error',
        location: `${check.server_alias}:${check.tool_name}`,
      });
      continue;
    }
    const readValue = outputField(read.data, check.assert.read_field);
    const outputValue = outputField(ctx.output, check.assert.output_field);
    if (deepEquals(readValue, outputValue)) {
      findings.push({
        id: `reconcile.${check.server_alias}.${check.tool_name}.match`,
        message: `reconcile ${check.server_alias}.${check.tool_name}.${check.assert.read_field} matches output (${JSON.stringify(readValue)})`,
        severity: 'info',
      });
    } else {
      passed = false;
      findings.push({
        id: `reconcile.${check.server_alias}.${check.tool_name}.mismatch`,
        message: `reconcile ${check.server_alias}.${check.tool_name}.${check.assert.read_field} is ${JSON.stringify(readValue)} but output.${check.assert.output_field} is ${JSON.stringify(outputValue)}`,
        severity: 'error',
        location: `${check.server_alias}:${check.tool_name}`,
      });
    }
  }
  return {
    passed,
    verifier: `reconcile:${itemName(config.verifier)}`,
    findings,
    metrics: { checks_run: checks.length },
    cost_usd: 0,
  };
}

async function runJudgeVerifier(config: VerifyConfig, ctx: VerificationContext): Promise<VerificationResult | null> {
  const judge = config.judge;
  if (!judge || !ctx.judge) {
    return null;
  }
  const sampled = (ctx.random ?? Math.random)() < judge.sample_percent / 100;
  if (!sampled) {
    return null;
  }
  const verdict = await ctx.judge({ userContent: JSON.stringify({ action: ctx.output }) });
  const name = itemName(config.verifier);
  const metrics: VerificationMetrics = { judge_sampled: 1 };
  if (verdict.passed) {
    return {
      passed: true,
      verifier: `judge:${name}`,
      findings: verdict.findings ?? [],
      metrics,
      cost_usd: 0.0001,
    };
  }
  const failing =
    verdict.findings && verdict.findings.length > 0
      ? verdict.findings
      : [{ id: 'judge.failed', message: 'judge rejected the output', severity: 'error' as const }];
  return {
    passed: false,
    verifier: `judge:${name}`,
    findings: failing,
    metrics,
    cost_usd: 0.0001,
  };
}

function composeComposite(config: VerifyConfig, results: VerificationResult[], correlationId: string): VerificationResult {
  return {
    passed: results.every((result) => result.passed),
    verifier: config.verifier,
    findings: results.flatMap((result) => result.findings),
    metrics: { verifiers_run: results.length },
    cost_usd: results.reduce((sum, result) => sum + result.cost_usd, 0),
    evidence_ref: evidenceRef(correlationId),
  };
}

/**
 * Runs the item's verification chain (Milestone 16): schema (via the existing
 * output-contract machinery), then reconcile (via the toolshed), then judge
 * (on a configurable sample). The composite verdict is the AND of every
 * verifier that ran; its `evidence_ref` is what the commit step cites.
 */
export async function runVerificationChain(config: VerifyConfig, ctx: VerificationContext): Promise<ChainResult> {
  const results: VerificationResult[] = [];
  if (config.schema !== false) {
    results.push(runSchemaVerifier(ctx));
  }
  const reconcile = await runReconcileVerifier(config, ctx);
  if (reconcile) {
    results.push(reconcile);
  }
  const judge = await runJudgeVerifier(config, ctx);
  if (judge) {
    results.push(judge);
  }
  const composite = composeComposite(config, results, ctx.correlationId);
  results.push(composite);
  return { results, composite, passed: composite.passed };
}

/** The error-severity findings across a chain, deduped by id for retry feedback. */
export function errorFindings(results: VerificationResult[]): VerificationFinding[] {
  const seen = new Set<string>();
  const findings: VerificationFinding[] = [];
  for (const result of results) {
    for (const finding of result.findings) {
      if (finding.severity === 'error' && !seen.has(finding.id)) {
        seen.add(finding.id);
        findings.push(finding);
      }
    }
  }
  return findings;
}
