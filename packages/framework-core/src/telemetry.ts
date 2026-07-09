/**
 * OpenTelemetry wiring for the Minions runtime (Milestone 13, review finding
 * M9 / F9 — "tokensUsed and token budgets are dead code", observability
 * half). This module is the ONLY place `@opentelemetry/sdk-node` is touched;
 * every caller (ingress, the orchestrator runner, the toolshed) depends on
 * `getTracer`/`getMeter`/`withSpan` from here, never on the SDK directly.
 *
 * Design constraint (non-negotiable, per the ExecPlan and
 * `toolshed-governance-invariants`): `pnpm test` and local dev must need
 * ZERO collectors. `initTelemetry()` is a complete no-op whenever
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is unset -- no `NodeSDK` is constructed, no
 * exporter is created, no network call is ever attempted. The
 * `@opentelemetry/api` package itself always provides a global no-op
 * tracer/meter provider, so `getTracer()`/`getMeter()`/`withSpan()` are safe
 * to call unconditionally regardless of whether `initTelemetry()` ran or
 * found telemetry configured -- spans/metrics simply go nowhere.
 */
import { trace, context, metrics, SpanStatusCode, type Tracer, type Meter, type Span } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const INSTRUMENTATION_NAME = 'minions';

let sdk: NodeSDK | undefined;
let enabled = false;

/**
 * Reads `OTEL_EXPORTER_OTLP_ENDPOINT`. When unset (or blank), telemetry
 * stays fully disabled: `initTelemetry()` returns immediately without
 * constructing a `NodeSDK`, an OTLP exporter, or any other SDK object that
 * could reach the network. When set, a real `NodeSDK` is started, exporting
 * traces via OTLP/HTTP to that endpoint.
 *
 * Safe to call multiple times (idempotent): a second call while already
 * initialized -- enabled or disabled -- is a no-op.
 */
export function initTelemetry(): void {
  if (sdk !== undefined || enabled) {
    return;
  }
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    return;
  }

  // The SDK/exporter/resource classes are static ESM imports at the top of
  // this module -- importing them is pure class/function construction with
  // no I/O, so it costs nothing on the disabled path. No network call is
  // made until `sdk.start()` below, which only ever runs on this branch
  // (endpoint configured).
  const traceExporter = new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` });

  sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'minions' }),
    traceExporter,
  });
  sdk.start();
  enabled = true;
}

/** True once `initTelemetry()` has found a configured endpoint and started the SDK. Always false when unconfigured. */
export function isTelemetryEnabled(): boolean {
  return enabled;
}

/** Flushes and tears down the SDK (if one was started). Always safe to call, including when telemetry was never enabled. */
export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = undefined;
  }
  enabled = false;
}

/**
 * The tracer every span in this codebase is created from. Always returns a
 * usable tracer -- `@opentelemetry/api`'s global default is a no-op tracer
 * whose spans are created but never exported, so this never throws or
 * requires `initTelemetry()` to have run.
 */
export function getTracer(): Tracer {
  return trace.getTracer(INSTRUMENTATION_NAME);
}

/** The meter every counter/histogram/gauge in this codebase is created from. Same no-op-safe guarantee as {@link getTracer}. */
export function getMeter(): Meter {
  return metrics.getMeter(INSTRUMENTATION_NAME);
}

/** The three identity attributes every span in the nesting chain must carry (ExecPlan Milestone 13). */
export interface SpanIdentityAttributes {
  correlation_id: string;
  minion_type?: string;
  session_id?: string;
  [key: string]: string | number | boolean | undefined;
}

/**
 * Runs `fn` inside a new span named `name`, nested under whatever span is
 * active on the current OTel context (real parent/child nesting via the
 * context API, not a flat span list) -- the caller does not need to thread
 * a parent span manually; `context.active()` already carries it once a
 * previous `withSpan` call's context has been entered.
 *
 * On success the span ends with no explicit status (OTel's default `UNSET`
 * reads as success). On a thrown/rejected `fn`, the span records the
 * exception, is marked `ERROR`, ends, and the error re-throws unchanged --
 * this wraps observability around a call, it never swallows a failure.
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanIdentityAttributes,
  fn: (span: Span) => Promise<T>,
  tracer: Tracer = getTracer()
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.end();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      span.recordException(err instanceof Error ? err : new Error(message));
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      span.end();
      throw err;
    }
  });
}

// Re-exported so callers that need the raw context API (e.g. to check
// "is there currently an active span") don't need their own
// `@opentelemetry/api` import.
export { context };
