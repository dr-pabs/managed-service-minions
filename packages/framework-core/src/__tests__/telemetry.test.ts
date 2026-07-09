import { trace, context, metrics } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader, AggregationTemporality } from '@opentelemetry/sdk-metrics';
import {
  initTelemetry,
  shutdownTelemetry,
  isTelemetryEnabled,
  getTracer,
  getMeter,
  withSpan,
} from '../telemetry.js';

describe('initTelemetry', () => {
  const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  afterEach(async () => {
    if (originalEndpoint === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
    }
    await shutdownTelemetry();
  });

  it('is a complete no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset: no exporter, no error, no network', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    expect(() => initTelemetry()).not.toThrow();
    expect(isTelemetryEnabled()).toBe(false);

    // Spans/metrics API calls must still be safe no-ops (a global no-op
    // tracer/meter provider is always registered by @opentelemetry/api even
    // when nothing was configured) -- getTracer/getMeter/withSpan must never
    // throw or require a collector.
    const tracer = getTracer();
    expect(tracer).toBeDefined();
    const result = await withSpan('test-span', {}, async () => 'ok');
    expect(result).toBe('ok');

    const meter = getMeter();
    expect(meter).toBeDefined();
  });

  it('initTelemetry() called twice while unset is still a no-op (idempotent)', () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    expect(() => {
      initTelemetry();
      initTelemetry();
    }).not.toThrow();
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('shutdownTelemetry() is a no-op when telemetry was never enabled', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });

  it('starts a real NodeSDK when OTEL_EXPORTER_OTLP_ENDPOINT is set, and shuts it down cleanly (no real export -- no span is ever created in this test, so no network call happens)', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:1/otel-test-endpoint-never-called';
    expect(() => initTelemetry()).not.toThrow();
    expect(isTelemetryEnabled()).toBe(true);
    // A second call while already enabled is a no-op (idempotent), not a
    // second NodeSDK construction/start.
    expect(() => initTelemetry()).not.toThrow();
    await shutdownTelemetry();
    expect(isTelemetryEnabled()).toBe(false);
    // NodeSDK.start() globally registers trace/context/metrics providers
    // that outlive `sdk.shutdown()` unless explicitly disabled -- reset the
    // API globals so later describe blocks in this file get a clean no-op
    // (or their own explicitly-registered) provider instead of this test's.
    trace.disable();
    context.disable();
    metrics.disable();
  });
});

describe('span nesting (in-memory exporter)', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register({ contextManager: new AsyncLocalStorageContextManager() });
  });

  afterEach(async () => {
    exporter.reset();
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  it('nests ingress -> orchestrator run -> minion run -> execute_tool -> adapter call, carrying correlation_id/minion_type/session_id', async () => {
    const tracer = trace.getTracer('test');

    await withSpan(
      'ingress.message',
      { correlation_id: 'corr_root1', session_id: 'sess_1', minion_type: 'orchestrator' },
      async () => {
        await withSpan(
          'orchestrator.run',
          { correlation_id: 'corr_root1', session_id: 'sess_1', minion_type: 'orchestrator' },
          async () => {
            await withSpan(
              'minion.run',
              { correlation_id: 'corr_root1.0', session_id: 'sess_1', minion_type: 'code_explorer' },
              async () => {
                await withSpan(
                  'execute_tool',
                  { correlation_id: 'corr_root1.0.github-0', session_id: 'sess_1', minion_type: 'code_explorer' },
                  async () => {
                    await withSpan(
                      'adapter.call',
                      { correlation_id: 'corr_root1.0.github-0', session_id: 'sess_1', minion_type: 'code_explorer' },
                      async () => 'adapter-result'
                    );
                  }
                );
              }
            );
          }
        );
      },
      tracer
    );

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(5);

    const byName = new Map(spans.map((s) => [s.name, s]));
    const ingress = byName.get('ingress.message')!;
    const orchestratorRun = byName.get('orchestrator.run')!;
    const minionRun = byName.get('minion.run')!;
    const executeTool = byName.get('execute_tool')!;
    const adapterCall = byName.get('adapter.call')!;

    // Real nesting via the OTel context API, not a flat list: each child's
    // parentSpanId equals its parent's own spanId, and all five share one
    // traceId.
    expect(orchestratorRun.parentSpanContext?.spanId).toBe(ingress.spanContext().spanId);
    expect(minionRun.parentSpanContext?.spanId).toBe(orchestratorRun.spanContext().spanId);
    expect(executeTool.parentSpanContext?.spanId).toBe(minionRun.spanContext().spanId);
    expect(adapterCall.parentSpanContext?.spanId).toBe(executeTool.spanContext().spanId);

    const traceId = ingress.spanContext().traceId;
    for (const s of spans) {
      expect(s.spanContext().traceId).toBe(traceId);
    }

    // Attributes carried on every span.
    expect(minionRun.attributes.correlation_id).toBe('corr_root1.0');
    expect(minionRun.attributes.minion_type).toBe('code_explorer');
    expect(minionRun.attributes.session_id).toBe('sess_1');
    expect(executeTool.attributes.correlation_id).toBe('corr_root1.0.github-0');
  });

  it('records an exception and re-throws when the wrapped function rejects', async () => {
    const tracer = trace.getTracer('test');
    await expect(
      withSpan('failing.span', { correlation_id: 'c1', session_id: 's1', minion_type: 'x' }, async () => {
        throw new Error('boom');
      }, tracer)
    ).rejects.toThrow('boom');

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(2); // SpanStatusCode.ERROR
  });

  it('records a non-Error throw (e.g. a rejected string) with String(err) as the message', async () => {
    const tracer = trace.getTracer('test');
    await expect(
      withSpan(
        'failing.non-error',
        { correlation_id: 'c1', session_id: 's1', minion_type: 'x' },
        async () => {
          throw 'plain string failure';
        },
        tracer
      )
    ).rejects.toBe('plain string failure');

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(2); // SpanStatusCode.ERROR
    expect(spans[0].status.message).toBe('plain string failure');
  });
});

describe('metrics (in-memory reader)', () => {
  it('getMeter returns a meter backed by a configured MeterProvider and records a counter increment', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 100000 });
    const meterProvider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(meterProvider);

    const meter = getMeter();
    const counter = meter.createCounter('test_counter');
    counter.add(1, { status: 'allowed' });

    await reader.forceFlush();
    const [resourceMetrics] = exporter.getMetrics();
    const points = resourceMetrics.scopeMetrics.flatMap((sm) => sm.metrics).flatMap((m) => m.dataPoints);
    expect(points.some((p) => p.value === 1)).toBe(true);

    await meterProvider.shutdown();
  });
});
