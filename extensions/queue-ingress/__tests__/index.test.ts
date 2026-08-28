import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSqliteStore = { createSession: jest.fn() };
const createSqliteStore = jest.fn().mockReturnValue(mockSqliteStore);
const mockToolshedState = { store: mockSqliteStore, signingSecret: 'sekret' };
const buildToolshedState = jest.fn<() => Promise<unknown>>().mockResolvedValue(mockToolshedState);
const initializeToolshed = jest.fn();
const verifyAndExecuteTool = jest.fn();

jest.unstable_mockModule('mcp-toolshed', () => ({
  createSqliteStore,
  buildToolshedState,
  initializeToolshed,
  verifyAndExecuteTool,
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

describe('queue-ingress index (Milestone 15)', () => {
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
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    createSqliteStore.mockClear().mockReturnValue(mockSqliteStore);
    buildToolshedState.mockClear().mockResolvedValue(mockToolshedState);
    initializeToolshed.mockClear();
    createOrchestratorRunner.mockClear().mockReturnValue(mockOrchestratorRunner);
    createHttpGooseClient.mockClear().mockReturnValue(mockGooseClient);
    InMemoryWorkItemQueue.mockClear().mockImplementation(() => mockInMemoryQueue);
    ServiceBusWorkItemQueue.connect.mockClear().mockResolvedValue(mockServiceBusQueue);
    InMemoryIdempotencyStore.mockClear().mockImplementation(() => mockIdempotencyStore);
    WorkItemProcessor.mockClear().mockImplementation(() => mockProcessorInstance);
    consumeQueue.mockClear().mockResolvedValue(0);
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
