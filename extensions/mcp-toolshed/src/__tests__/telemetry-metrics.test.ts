import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { metrics } from '@opentelemetry/api';
import { InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader, AggregationTemporality } from '@opentelemetry/sdk-metrics';
import {
  recordGovernanceOutcome,
  recordToolLatency,
  recordBreakerState,
  resetTelemetryMetricsForTests,
  resetBreakerStateForTests,
} from '../telemetry-metrics.js';

describe('telemetry-metrics (in-memory reader)', () => {
  let exporter: InMemoryMetricExporter;
  let reader: PeriodicExportingMetricReader;
  let provider: MeterProvider;

  beforeEach(() => {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 100000 });
    provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);
    resetTelemetryMetricsForTests();
    resetBreakerStateForTests();
  });

  afterEach(async () => {
    await provider.shutdown();
    metrics.disable();
    resetTelemetryMetricsForTests();
    resetBreakerStateForTests();
  });

  async function collectDataPoints(metricName: string) {
    await reader.forceFlush();
    // `exporter.getMetrics()` accumulates one entry per export call (it
    // never overwrites) -- always read the MOST RECENT export, not the
    // first, so a second `collectDataPoints` call after further add()s sees
    // the latest cumulative value rather than a stale first snapshot.
    const allExports = exporter.getMetrics();
    const resourceMetrics = allExports[allExports.length - 1];
    const metric = resourceMetrics?.scopeMetrics
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === metricName);
    return metric?.dataPoints ?? [];
  }

  it('increments the governance outcome counter, tagged by outcome/server_alias/tool_name/minion_type', async () => {
    recordGovernanceOutcome('allowed', { serverAlias: 'github', toolName: 'github_get_pull_request', minionType: 'code_explorer' });
    recordGovernanceOutcome('blocked', { serverAlias: 'github', toolName: 'delete_repo', minionType: 'code_explorer' });
    recordGovernanceOutcome('throttled', { serverAlias: 'github', toolName: 'github_get_pull_request', minionType: 'code_explorer' });
    recordGovernanceOutcome('approval_requested', { serverAlias: 'github', toolName: 'merge_pull_request', minionType: 'code_explorer' });
    recordGovernanceOutcome('approved', { serverAlias: 'github', toolName: 'merge_pull_request', minionType: 'code_explorer' });
    recordGovernanceOutcome('denied', { serverAlias: 'github', toolName: 'merge_pull_request', minionType: 'code_explorer' });

    const points = await collectDataPoints('toolshed_governance_outcomes_total');
    const outcomes = points.map((p) => p.attributes.outcome).sort();
    expect(outcomes).toEqual(['allowed', 'approval_requested', 'approved', 'blocked', 'denied', 'throttled']);
    expect(points.every((p) => p.value === 1)).toBe(true);
    const allowedPoint = points.find((p) => p.attributes.outcome === 'allowed')!;
    expect(allowedPoint.attributes.server_alias).toBe('github');
    expect(allowedPoint.attributes.minion_type).toBe('code_explorer');
  });

  it('records tool latency into the histogram', async () => {
    recordToolLatency(42, { serverAlias: 'github', toolName: 'github_get_pull_request', minionType: 'code_explorer' });

    const points = await collectDataPoints('toolshed_tool_latency_ms');
    expect(points).toHaveLength(1);
    expect((points[0].value as { sum: number }).sum).toBe(42);
  });

  it('reports the breaker-state gauge as 1 when open, 0 when closed, and is idempotent for repeated identical states', async () => {
    recordBreakerState('github', true);
    recordBreakerState('github', true); // repeated -- must not double-add
    let points = await collectDataPoints('toolshed_breaker_open');
    expect(points.find((p) => p.attributes.server_alias === 'github')?.value).toBe(1);

    recordBreakerState('github', false);
    points = await collectDataPoints('toolshed_breaker_open');
    expect(points.find((p) => p.attributes.server_alias === 'github')?.value).toBe(0);
  });

  it('a breaker reported closed for the first time never emits a spurious delta', async () => {
    recordBreakerState('azure_devops', false);
    const points = await collectDataPoints('toolshed_breaker_open');
    // No data point at all yet -- an UpDownCounter with a net-zero
    // contribution across its lifetime reports nothing until a real add()
    // call happens; the first "closed" observation intentionally records no
    // delta (gauge already implicitly starts at 0).
    expect(points.find((p) => p.attributes.server_alias === 'azure_devops')).toBeUndefined();
  });
});
