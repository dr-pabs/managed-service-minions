import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSqliteStore = { createSession: jest.fn() };
const createSqliteStore = jest.fn().mockReturnValue(mockSqliteStore);
const mockToolshedState = { store: mockSqliteStore, signingSecret: 'sekret' };
const buildToolshedState = jest.fn<() => Promise<unknown>>().mockResolvedValue(mockToolshedState);
const initializeToolshed = jest.fn();
const verifyAndExecuteTool = jest.fn<() => Promise<unknown>>().mockResolvedValue({ status: 'success', data: {} });
const mockGatewayInstance = { draftEffect: jest.fn(), commitEffect: jest.fn() };
const EffectGateway = jest.fn().mockImplementation(() => mockGatewayInstance);
const makeEffectTypePolicy = jest.fn((effectType: unknown, reversibility: unknown, approvalClass: unknown) => ({
  effectType,
  reversibility,
  approvalClass,
}));

jest.unstable_mockModule('mcp-toolshed', () => ({
  createSqliteStore,
  buildToolshedState,
  initializeToolshed,
  verifyAndExecuteTool,
  EffectGateway,
  makeEffectTypePolicy,
}));

const mockOrchestratorRunner = { run: jest.fn() };
const createOrchestratorRunner = jest.fn().mockReturnValue(mockOrchestratorRunner);
const mockGooseClient = { classifyIntent: jest.fn(), runMinion: jest.fn() };
const createHttpGooseClient = jest.fn().mockReturnValue(mockGooseClient);

jest.unstable_mockModule('orchestrator', () => ({
  createOrchestratorRunner,
  createHttpGooseClient,
}));

const mockInMemoryQueue = {
  receive: jest.fn(),
  complete: jest.fn(),
  abandon: jest.fn(),
  deadLetter: jest.fn(),
  close: jest.fn(),
};
const InMemoryWorkItemQueue = jest.fn().mockImplementation(() => mockInMemoryQueue);
jest.unstable_mockModule('../src/queue.js', () => ({ InMemoryWorkItemQueue }));

const mockServiceBusQueue = {
  receive: jest.fn(),
  complete: jest.fn(),
  abandon: jest.fn(),
  deadLetter: jest.fn(),
  close: jest.fn(),
};
const ServiceBusWorkItemQueue = { connect: jest.fn().mockResolvedValue(mockServiceBusQueue) };
jest.unstable_mockModule('../src/service-bus-queue.js', () => ({ ServiceBusWorkItemQueue }));

const mockIdempotencyStore = { get: jest.fn(), set: jest.fn() };
const InMemoryIdempotencyStore = jest.fn().mockImplementation(() => mockIdempotencyStore);
jest.unstable_mockModule('../src/idempotency-store.js', () => ({ InMemoryIdempotencyStore }));

const mockProcessorInstance = { process: jest.fn() };
const WorkItemProcessor = jest.fn().mockImplementation(() => mockProcessorInstance);
jest.unstable_mockModule('../src/processor.js', () => ({ WorkItemProcessor }));

const consumeQueue = jest.fn().mockResolvedValue(0);
jest.unstable_mockModule('../src/consumer.js', () => ({ consumeQueue }));

// ADR-030 production wiring seam (pipeline-processor.ts), mocked so index.test
// asserts index.ts COMPOSES the seam correctly; the seam itself runs for real
// in pipeline-processor.test.ts and production-wiring.test.ts.
const loadPipelines = jest.fn((_recipesDir: string) => new Map<string, unknown>());
const resolvePipelinesDir = jest.fn((configured: string | undefined, defaultDir: string) => configured ?? defaultDir);
const buildEscalateEmitter = jest.fn((_options: unknown): unknown => undefined);
const mockCommit = jest.fn();
const buildGatewayCommit = jest.fn().mockReturnValue(mockCommit);
const mockResolverInstance = { set: jest.fn(), resolve: jest.fn() };
const PipelineVerificationResolver = jest.fn().mockImplementation(() => mockResolverInstance);
const mockPipelineProcessorInstance = { process: jest.fn() };
const PipelineWorkItemProcessor = jest.fn().mockImplementation(() => mockPipelineProcessorInstance);
jest.unstable_mockModule('../src/pipeline-processor.js', () => ({
  loadPipelines,
  resolvePipelinesDir,
  buildEscalateEmitter,
  buildGatewayCommit,
  PipelineVerificationResolver,
  PipelineWorkItemProcessor,
}));

/** A loaded pipeline as index.ts consumes it (config.commit drives the gateway policy map). */
function loadedRefundPipeline() {
  return {
    config: {
      item_type: 'refund_request',
      max_attempts: 2,
      on_failure: 'dead_letter',
      act: { agent: 'refund_processor', system_prompt: 'p', output_schema: 'refund-action-output.json' },
      verify: { verifier: 'composite:refund_request' },
      commit: { effect_type: 'payment.refund', target_system: 'payments', reversibility: 'compensatable' },
    },
    schemas: {},
    schemaMap: new Map([['refund_processor', 'refund-action-output.json']]),
  };
}

describe('queue-ingress index (Milestones 15-20 wiring)', () => {
  const originalEnv = process.env;
  let exitSpy: jest.SpiedFunction<typeof process.exit>;
  let errorSpy: jest.SpiedFunction<typeof console.error>;
  let warnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.SERVICE_BUS_CONNECTION_STRING;
    delete process.env.SERVICE_BUS_QUEUE_NAME;
    delete process.env.SQLITE_PATH;
    delete process.env.GOOSE_SERVE_URL;
    delete process.env.GOOSE_BASE_URL;
    delete process.env.TOOLSHED_SIGNING_SECRET;
    delete process.env.DAILY_BUDGET_MAX_COST_USD;
    delete process.env.PIPELINES_CONFIG_PATH;
    delete process.env.PIPELINE_PRICE_PER_1K_TOKENS_USD;
    delete process.env.FORGE_INTAKE_URL;
    delete process.env.FORGE_BRIDGE_SECRET;
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    createSqliteStore.mockClear().mockReturnValue(mockSqliteStore);
    buildToolshedState.mockClear().mockResolvedValue(mockToolshedState);
    initializeToolshed.mockClear();
    verifyAndExecuteTool.mockClear().mockResolvedValue({ status: 'success', data: {} });
    EffectGateway.mockClear().mockImplementation(() => mockGatewayInstance);
    makeEffectTypePolicy.mockClear();
    createOrchestratorRunner.mockClear().mockReturnValue(mockOrchestratorRunner);
    createHttpGooseClient.mockClear().mockReturnValue(mockGooseClient);
    InMemoryWorkItemQueue.mockClear().mockImplementation(() => mockInMemoryQueue);
    ServiceBusWorkItemQueue.connect.mockClear().mockResolvedValue(mockServiceBusQueue);
    InMemoryIdempotencyStore.mockClear().mockImplementation(() => mockIdempotencyStore);
    WorkItemProcessor.mockClear().mockImplementation(() => mockProcessorInstance);
    consumeQueue.mockClear().mockResolvedValue(0);
    loadPipelines.mockClear().mockImplementation(() => new Map<string, unknown>());
    resolvePipelinesDir.mockClear().mockImplementation((configured: string | undefined, defaultDir: string) => configured ?? defaultDir);
    buildEscalateEmitter.mockClear().mockImplementation(() => undefined);
    buildGatewayCommit.mockClear().mockReturnValue(mockCommit);
    PipelineVerificationResolver.mockClear().mockImplementation(() => mockResolverInstance);
    PipelineWorkItemProcessor.mockClear().mockImplementation(() => mockPipelineProcessorInstance);
  });

  afterEach(() => {
    process.env = originalEnv;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('wires the toolshed + orchestrator runner and consumes from the in-memory queue when no connection string is set', async () => {
    await import('../src/index.js');
    await flushMicrotasks();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SERVICE_BUS_CONNECTION_STRING is not set'));
    expect(ServiceBusWorkItemQueue.connect).not.toHaveBeenCalled();
    expect(InMemoryWorkItemQueue).toHaveBeenCalledTimes(1);
    expect(createSqliteStore).toHaveBeenCalledWith(':memory:');
    expect(buildToolshedState).toHaveBeenCalled();
    expect(initializeToolshed).toHaveBeenCalledWith(mockToolshedState);
    expect(createHttpGooseClient).toHaveBeenCalledWith({ baseUrl: 'http://localhost:3284' });
    expect(createOrchestratorRunner).toHaveBeenCalledWith({
      goose: mockGooseClient,
      store: mockSqliteStore,
      toolshed: { verifyAndExecuteTool },
      secret: '',
    });
    expect(WorkItemProcessor).toHaveBeenCalledWith({
      runner: mockOrchestratorRunner,
      queue: mockInMemoryQueue,
      outcomes: mockIdempotencyStore,
    });
    expect(consumeQueue).toHaveBeenCalledWith({
      queue: mockInMemoryQueue,
      processor: mockProcessorInstance,
      store: mockSqliteStore,
    });
  });

  it('consumes from Service Bus when a connection string is set', async () => {
    process.env.SERVICE_BUS_CONNECTION_STRING = 'Endpoint=sb://ns';
    process.env.SERVICE_BUS_QUEUE_NAME = 'my-queue';

    await import('../src/index.js');
    await flushMicrotasks();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(InMemoryWorkItemQueue).not.toHaveBeenCalled();
    expect(ServiceBusWorkItemQueue.connect).toHaveBeenCalledWith('Endpoint=sb://ns', 'my-queue');
    expect(consumeQueue).toHaveBeenCalledWith({
      queue: mockServiceBusQueue,
      processor: mockProcessorInstance,
      store: mockSqliteStore,
    });
  });

  it('defaults the Service Bus queue name to minion-tasks', async () => {
    process.env.SERVICE_BUS_CONNECTION_STRING = 'Endpoint=sb://ns';

    await import('../src/index.js');
    await flushMicrotasks();

    expect(ServiceBusWorkItemQueue.connect).toHaveBeenCalledWith('Endpoint=sb://ns', 'minion-tasks');
  });

  it('honours SQLITE_PATH, GOOSE_BASE_URL, and TOOLSHED_SIGNING_SECRET when set', async () => {
    process.env.SQLITE_PATH = '/data/queue.db';
    process.env.GOOSE_BASE_URL = 'http://goose-base:3284';
    process.env.TOOLSHED_SIGNING_SECRET = 'the-secret';

    await import('../src/index.js');
    await flushMicrotasks();

    expect(createSqliteStore).toHaveBeenCalledWith('/data/queue.db');
    expect(createHttpGooseClient).toHaveBeenCalledWith({ baseUrl: 'http://goose-base:3284' });
    expect(createOrchestratorRunner).toHaveBeenCalledWith(expect.objectContaining({ secret: 'the-secret' }));
  });

  it('wires a daily budget when DAILY_BUDGET_MAX_COST_USD is a positive number', async () => {
    process.env.DAILY_BUDGET_MAX_COST_USD = '250.0';

    await import('../src/index.js');
    await flushMicrotasks();

    const consumeArg = consumeQueue.mock.calls[0][0];
    expect(consumeArg.store).toBe(mockSqliteStore);
    expect(consumeArg.dailyBudget).toBeDefined();
    expect(consumeArg.dailyBudget.maxCostUsd).toBe(250.0);
  });

  it('skips the daily budget when DAILY_BUDGET_MAX_COST_USD is not positive', async () => {
    process.env.DAILY_BUDGET_MAX_COST_USD = '0';

    await import('../src/index.js');
    await flushMicrotasks();

    const consumeArg = consumeQueue.mock.calls[0][0];
    expect(consumeArg.store).toBe(mockSqliteStore);
    expect(consumeArg.dailyBudget).toBeUndefined();
  });

  it('loads pipelines from the repo-relative recipes dir by default and honours PIPELINES_CONFIG_PATH', async () => {
    process.env.PIPELINES_CONFIG_PATH = '/etc/minions/recipes';

    await import('../src/index.js');
    await flushMicrotasks();

    expect(resolvePipelinesDir).toHaveBeenCalledWith('/etc/minions/recipes', expect.stringMatching(/recipes$/));
    expect(loadPipelines).toHaveBeenCalledWith('/etc/minions/recipes');
  });

  it('routes work items through PipelineWorkItemProcessor when pipelines load, with the gateway commit seam', async () => {
    process.env.TOOLSHED_SIGNING_SECRET = 'the-secret';
    const pipelines = new Map([['refund_request', loadedRefundPipeline()]]);
    loadPipelines.mockImplementation(() => pipelines);

    await import('../src/index.js');
    await flushMicrotasks();

    // The gateway is built from the recipe's commit block, fail-closed 'auto'.
    expect(makeEffectTypePolicy).toHaveBeenCalledWith('payment.refund', 'compensatable', 'auto');
    expect(EffectGateway).toHaveBeenCalledWith({
      effectTypes: expect.any(Map),
      signingSecret: 'the-secret',
      evidenceResolver: mockResolverInstance,
    });
    expect(buildGatewayCommit).toHaveBeenCalledWith(mockGatewayInstance, mockResolverInstance);

    expect(PipelineWorkItemProcessor).toHaveBeenCalledWith({
      pipelines,
      deps: expect.objectContaining({
        goose: mockGooseClient,
        store: mockSqliteStore,
        secret: 'the-secret',
        commit: mockCommit,
        pricePer1kTokensUsd: 0,
      }),
      fallback: mockProcessorInstance,
      queue: mockInMemoryQueue,
      outcomes: mockIdempotencyStore,
    });
    expect(consumeQueue).toHaveBeenCalledWith(
      expect.objectContaining({ processor: mockPipelineProcessorInstance })
    );
  });

  it('keeps the WorkItemProcessor path (and builds no gateway) when no pipelines load', async () => {
    await import('../src/index.js');
    await flushMicrotasks();

    expect(EffectGateway).not.toHaveBeenCalled();
    expect(PipelineWorkItemProcessor).not.toHaveBeenCalled();
    expect(consumeQueue).toHaveBeenCalledWith(expect.objectContaining({ processor: mockProcessorInstance }));
  });

  it("wires the pipeline reconcile seam to the toolshed's verifyAndExecuteTool", async () => {
    loadPipelines.mockImplementation(() => new Map([['refund_request', loadedRefundPipeline()]]));

    await import('../src/index.js');
    await flushMicrotasks();

    const deps = PipelineWorkItemProcessor.mock.calls[0][0].deps;
    await deps.reconcile({
      minionToken: 'tok',
      correlationId: 'corr-1',
      attempt: 2,
      serverAlias: 'payments',
      toolName: 'payments_get_charge',
      params: { order_id: 'R-1' },
    });
    expect(verifyAndExecuteTool).toHaveBeenCalledWith(
      { minionToken: 'tok', correlationId: 'corr-1', attempt: 2 },
      'payments',
      'payments_get_charge',
      { order_id: 'R-1' }
    );
  });

  it('arms the escalation emitter only when FORGE_INTAKE_URL and FORGE_BRIDGE_SECRET are both set', async () => {
    process.env.FORGE_INTAKE_URL = 'http://forge:8787/intake';
    process.env.FORGE_BRIDGE_SECRET = 'bridge-secret';
    const emitter = jest.fn();
    buildEscalateEmitter.mockImplementation(() => emitter);
    loadPipelines.mockImplementation(() => new Map([['refund_request', loadedRefundPipeline()]]));

    await import('../src/index.js');
    await flushMicrotasks();

    expect(buildEscalateEmitter).toHaveBeenCalledWith({
      intakeUrl: 'http://forge:8787/intake',
      bridgeSecret: 'bridge-secret',
    });
    const deps = PipelineWorkItemProcessor.mock.calls[0][0].deps;
    expect(deps.escalate).toBe(emitter);
    expect(deps.bridgeSecret).toBe('bridge-secret');
  });

  it('leaves the escalation emitter unarmed when the bridge env vars are absent', async () => {
    loadPipelines.mockImplementation(() => new Map([['refund_request', loadedRefundPipeline()]]));

    await import('../src/index.js');
    await flushMicrotasks();

    expect(buildEscalateEmitter).toHaveBeenCalledWith({ intakeUrl: undefined, bridgeSecret: undefined });
    const deps = PipelineWorkItemProcessor.mock.calls[0][0].deps;
    expect(deps.escalate).toBeUndefined();
    expect(deps.bridgeSecret).toBeUndefined();
  });

  it('prices pipeline model calls from PIPELINE_PRICE_PER_1K_TOKENS_USD when positive', async () => {
    process.env.PIPELINE_PRICE_PER_1K_TOKENS_USD = '0.02';
    loadPipelines.mockImplementation(() => new Map([['refund_request', loadedRefundPipeline()]]));

    await import('../src/index.js');
    await flushMicrotasks();

    expect(PipelineWorkItemProcessor.mock.calls[0][0].deps.pricePer1kTokensUsd).toBe(0.02);
  });

  it('prices pipeline model calls at 0 when PIPELINE_PRICE_PER_1K_TOKENS_USD is absent or not positive', async () => {
    process.env.PIPELINE_PRICE_PER_1K_TOKENS_USD = '-4';
    loadPipelines.mockImplementation(() => new Map([['refund_request', loadedRefundPipeline()]]));

    await import('../src/index.js');
    await flushMicrotasks();

    expect(PipelineWorkItemProcessor.mock.calls[0][0].deps.pricePer1kTokensUsd).toBe(0);
  });

  it('exits when building the toolshed state rejects', async () => {
    buildToolshedState.mockReset().mockRejectedValue(new Error('config validation failed'));

    await import('../src/index.js');
    await flushMicrotasks();

    expect(errorSpy).toHaveBeenCalledWith('Queue ingress failed to start', expect.any(Error));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits when connecting to Service Bus rejects', async () => {
    process.env.SERVICE_BUS_CONNECTION_STRING = 'Endpoint=sb://ns';
    ServiceBusWorkItemQueue.connect.mockReset().mockRejectedValue(new Error('connect failed'));

    await import('../src/index.js');
    await flushMicrotasks();

    expect(errorSpy).toHaveBeenCalledWith('Queue ingress failed to start', expect.any(Error));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
