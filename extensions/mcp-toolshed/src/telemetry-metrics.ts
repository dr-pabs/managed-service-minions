/**
 * Governance metrics (Milestone 13, review finding M9 / F9). Emitted at the
 * SAME decision points `executeTool`/`gateDestructiveCall`/`doExecuteTool`
 * already return from — this module is observe-only: it never changes a
 * decision, never touches the audit trail, and every counter/histogram
 * increment happens ALONGSIDE the existing `emit()` call, not instead of
 * it. See `toolshed-governance-invariants`: adding telemetry to
 * `executeTool` must never reorder or alter the enforcement pipeline.
 *
 * Built on `framework-core`'s `getMeter()` (itself built on
 * `@opentelemetry/api`'s global meter provider), so this module inherits
 * the SAME no-op-when-unconfigured guarantee: with no `OTEL_EXPORTER_OTLP_ENDPOINT`
 * and no test-injected `MeterProvider`, every `.add()`/`.record()` call
 * below goes through the API's no-op meter and does nothing.
 */
import { getMeter } from 'framework-core';

export type GovernanceOutcome =
  | 'allowed'
  | 'blocked'
  | 'throttled'
  | 'approval_requested'
  | 'approved'
  | 'denied';

let toolLatencyHistogram: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | undefined;
let governanceOutcomeCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']> | undefined;
let breakerStateGauge: ReturnType<ReturnType<typeof getMeter>['createUpDownCounter']> | undefined;

/**
 * Lazily creates (once per process) the three instruments the milestone
 * requires: a tool-latency histogram, a counter for the six governance
 * outcomes (allowed/blocked/throttled/approval-requested/approved/denied),
 * and a breaker-state gauge. Lazy + cached so every call site shares one
 * instrument instance (required for OTel counters to aggregate correctly)
 * without every module needing its own top-level `getMeter()` call at
 * import time (which would bind to whatever meter provider was global AT
 * IMPORT TIME, before a test's `metrics.setGlobalMeterProvider` call could
 * possibly run first).
 */
function instruments() {
  if (!toolLatencyHistogram) {
    const meter = getMeter();
    toolLatencyHistogram = meter.createHistogram('toolshed_tool_latency_ms', {
      description: 'Latency of a single execute_tool call, in milliseconds.',
      unit: 'ms',
    });
    governanceOutcomeCounter = meter.createCounter('toolshed_governance_outcomes_total', {
      description: 'Count of governance decisions by outcome (allowed/blocked/throttled/approval_requested/approved/denied).',
    });
    breakerStateGauge = meter.createUpDownCounter('toolshed_breaker_open', {
      description: '1 while a server alias breaker is open, 0 while closed (an up-down counter used as a gauge).',
    });
  }
  return {
    toolLatencyHistogram: toolLatencyHistogram!,
    governanceOutcomeCounter: governanceOutcomeCounter!,
    breakerStateGauge: breakerStateGauge!,
  };
}

/** Test-only: forces the next call to `instruments()` to re-fetch the meter/instruments, so a test that installs its own MeterProvider between tests gets a fresh, correctly-bound instrument. */
export function resetTelemetryMetricsForTests(): void {
  toolLatencyHistogram = undefined;
  governanceOutcomeCounter = undefined;
  breakerStateGauge = undefined;
}

export interface GovernanceMetricAttributes {
  serverAlias: string;
  toolName: string;
  minionType: string;
}

/** Increments the governance-outcome counter. Called from `executeTool`'s decision points, in addition to (never instead of) the existing `emit()` audit call. */
export function recordGovernanceOutcome(outcome: GovernanceOutcome, attrs: GovernanceMetricAttributes): void {
  instruments().governanceOutcomeCounter.add(1, {
    outcome,
    server_alias: attrs.serverAlias,
    tool_name: attrs.toolName,
    minion_type: attrs.minionType,
  });
}

/** Records one `execute_tool` call's latency against the histogram. */
export function recordToolLatency(latencyMs: number, attrs: GovernanceMetricAttributes): void {
  instruments().toolLatencyHistogram.record(latencyMs, {
    server_alias: attrs.serverAlias,
    tool_name: attrs.toolName,
    minion_type: attrs.minionType,
  });
}

/** Sets the breaker-state gauge for one server alias: `open=true` reports 1, `open=false` reports 0 (implemented via an UpDownCounter's signed delta, tracking the last-reported state per key so repeated calls with the same state are idempotent, not cumulative). */
const lastBreakerState = new Map<string, boolean>();
export function recordBreakerState(serverAlias: string, open: boolean): void {
  const previous = lastBreakerState.get(serverAlias);
  if (previous === open) return;
  const delta = open ? 1 : -1;
  // First observation of a CLOSED breaker needs no delta (gauge starts at
  // 0); only report a delta when the value actually needs to move by 1.
  if (previous === undefined && !open) {
    lastBreakerState.set(serverAlias, open);
    return;
  }
  instruments().breakerStateGauge.add(delta, { server_alias: serverAlias });
  lastBreakerState.set(serverAlias, open);
}

/** Test-only: clears the breaker-state idempotency cache alongside {@link resetTelemetryMetricsForTests}. */
export function resetBreakerStateForTests(): void {
  lastBreakerState.clear();
}
