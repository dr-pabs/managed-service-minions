import { beforeEach, describe, expect, it, jest } from '@jest/globals';

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

const mockWebhookServer = { port: 3100, close: jest.fn() };
const createWebhookServer = jest.fn<() => Promise<unknown>>().mockResolvedValue(mockWebhookServer);
jest.unstable_mockModule('../src/webhook-ingress.js', () => ({ createWebhookServer }));

describe('webhook-ingress index (Milestone 15, F11)', () => {
  const originalEnv = process.env;
  let exitSpy: jest.SpiedFunction<typeof process.exit>;
  let errorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.ADO_WEBHOOK_USERNAME;
    delete process.env.ADO_WEBHOOK_PASSWORD;
    delete process.env.PORT;
    delete process.env.SQLITE_PATH;
    delete process.env.GOOSE_SERVE_URL;
    delete process.env.GOOSE_BASE_URL;
    delete process.env.TOOLSHED_SIGNING_SECRET;
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    createSqliteStore.mockClear();
    buildToolshedState.mockClear().mockResolvedValue(mockToolshedState);
    initializeToolshed.mockClear();
    createOrchestratorRunner.mockClear().mockReturnValue(mockOrchestratorRunner);
    createHttpGooseClient.mockClear().mockReturnValue(mockGooseClient);
    createWebhookServer.mockClear().mockResolvedValue(mockWebhookServer);
  });

  afterEach(() => {
    process.env = originalEnv;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('builds the real in-process toolshed, the orchestrator runner, and starts the webhook server from env config', async () => {
    process.env.GITHUB_WEBHOOK_SECRET = 'gh-secret';
    process.env.ADO_WEBHOOK_USERNAME = 'ado-user';
    process.env.ADO_WEBHOOK_PASSWORD = 'ado-pass';
    process.env.PORT = '4100';
    process.env.SQLITE_PATH = '/data/webhook.db';
    process.env.GOOSE_SERVE_URL = 'http://goose:3284';
    process.env.TOOLSHED_SIGNING_SECRET = 'the-secret';

    await import('../src/index.js');
    await flushMicrotasks();

    expect(createSqliteStore).toHaveBeenCalledWith('/data/webhook.db');
    expect(buildToolshedState).toHaveBeenCalled();
    expect(initializeToolshed).toHaveBeenCalledWith(mockToolshedState);
    expect(createHttpGooseClient).toHaveBeenCalledWith({ baseUrl: 'http://goose:3284' });
    expect(createOrchestratorRunner).toHaveBeenCalledWith({
      goose: mockGooseClient,
      store: mockSqliteStore,
      toolshed: { verifyAndExecuteTool },
      secret: 'the-secret',
    });
    expect(createWebhookServer).toHaveBeenCalledWith({
      runner: mockOrchestratorRunner,
      store: mockSqliteStore,
      githubWebhookSecret: 'gh-secret',
      adoUsername: 'ado-user',
      adoPassword: 'ado-pass',
      port: 4100,
      toolshed: { verifyAndExecuteTool },
      signingSecret: 'the-secret',
    });
  });

  it('defaults PORT to 3100 and the Goose URL to localhost:3284 when unset', async () => {
    await import('../src/index.js');
    await flushMicrotasks();

    expect(createHttpGooseClient).toHaveBeenCalledWith({ baseUrl: 'http://localhost:3284' });
    expect(createWebhookServer).toHaveBeenCalledWith(expect.objectContaining({ port: 3100 }));
  });

  it('exits when building the toolshed state rejects', async () => {
    buildToolshedState.mockReset().mockRejectedValue(new Error('config validation failed'));

    await import('../src/index.js');
    await flushMicrotasks();

    expect(errorSpy).toHaveBeenCalledWith('Webhook ingress failed to start', expect.any(Error));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits when the webhook server fails to start', async () => {
    createWebhookServer.mockReset().mockRejectedValue(new Error('EADDRINUSE'));

    await import('../src/index.js');
    await flushMicrotasks();

    expect(errorSpy).toHaveBeenCalledWith('Webhook ingress failed to start', expect.any(Error));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
