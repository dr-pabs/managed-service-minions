import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockStart = jest.fn<() => Promise<void>>();
const mockStop = jest.fn<() => Promise<void>>();
const mockEchoRunner = { run: jest.fn() };
const MockTeamsBot = {
  createTeamsBot: jest.fn().mockReturnValue({ start: mockStart, stop: mockStop }),
  createEchoRunner: jest.fn().mockReturnValue(mockEchoRunner),
};

jest.unstable_mockModule('../src/teams-bot.js', () => MockTeamsBot);

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

const mockApplicationConstructor = jest.fn();
const mockTeamsAdapterConstructor = jest.fn();

jest.unstable_mockModule('@microsoft/teams-ai', () => ({
  Application: mockApplicationConstructor,
  TeamsAdapter: mockTeamsAdapterConstructor,
}));

describe('teams-bot index (RUNNER=orchestrator|echo, Milestone 11)', () => {
  const originalEnv = process.env;
  let exitSpy: jest.SpiedFunction<typeof process.exit>;
  let errorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.RUNNER;
    delete process.env.GOOSE_SERVE_URL;
    delete process.env.GOOSE_BASE_URL;
    delete process.env.TOOLSHED_SIGNING_SECRET;
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockStart.mockReset().mockResolvedValue(undefined);
    mockStop.mockReset().mockResolvedValue(undefined);
    MockTeamsBot.createTeamsBot.mockClear();
    MockTeamsBot.createEchoRunner.mockClear();
    createSqliteStore.mockClear();
    buildToolshedState.mockClear().mockResolvedValue(mockToolshedState);
    initializeToolshed.mockClear();
    createOrchestratorRunner.mockClear().mockReturnValue(mockOrchestratorRunner);
    createHttpGooseClient.mockClear().mockReturnValue(mockGooseClient);
    mockApplicationConstructor.mockReset().mockReturnValue({});
    mockTeamsAdapterConstructor.mockReset().mockReturnValue({});
  });

  afterEach(() => {
    process.env = originalEnv;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('creates a Teams adapter and application with env config', async () => {
    process.env.MICROSOFT_APP_ID = 'app-id';
    process.env.MICROSOFT_APP_PASSWORD = 'app-password';
    process.env.MICROSOFT_APP_TYPE = 'SingleTenant';
    process.env.PORT = '4000';
    process.env.SQLITE_PATH = '/data/bot.db';

    await import('../src/index.js');
    await flushMicrotasks();

    expect(mockTeamsAdapterConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        MicrosoftAppId: 'app-id',
        MicrosoftAppPassword: 'app-password',
        MicrosoftAppType: 'SingleTenant',
      })
    );
    expect(createSqliteStore).toHaveBeenCalledWith('/data/bot.db');
  });

  it('defaults to the echo runner when RUNNER is unset and GOOSE_SERVE_URL is unset', async () => {
    await import('../src/index.js');
    await flushMicrotasks();

    expect(MockTeamsBot.createEchoRunner).toHaveBeenCalled();
    expect(buildToolshedState).not.toHaveBeenCalled();
    expect(MockTeamsBot.createTeamsBot).toHaveBeenCalledWith(
      expect.anything(),
      mockSqliteStore,
      mockEchoRunner,
      expect.anything()
    );
    expect(mockStart).toHaveBeenCalled();
  });

  it('defaults to the orchestrator runner when GOOSE_SERVE_URL is set (RUNNER unset)', async () => {
    process.env.GOOSE_SERVE_URL = 'http://goose:3284';
    process.env.TOOLSHED_SIGNING_SECRET = 'the-secret';

    await import('../src/index.js');
    await flushMicrotasks();

    expect(buildToolshedState).toHaveBeenCalled();
    expect(initializeToolshed).toHaveBeenCalledWith(mockToolshedState);
    expect(createHttpGooseClient).toHaveBeenCalledWith({ baseUrl: 'http://goose:3284' });
    expect(createOrchestratorRunner).toHaveBeenCalledWith({
      goose: mockGooseClient,
      store: mockSqliteStore,
      toolshed: { verifyAndExecuteTool },
      secret: 'the-secret',
    });
    expect(MockTeamsBot.createTeamsBot).toHaveBeenCalledWith(
      expect.anything(),
      mockSqliteStore,
      mockOrchestratorRunner,
      expect.anything()
    );
  });

  it('RUNNER=echo forces the echo runner even when GOOSE_SERVE_URL is set', async () => {
    process.env.GOOSE_SERVE_URL = 'http://goose:3284';
    process.env.RUNNER = 'echo';

    await import('../src/index.js');
    await flushMicrotasks();

    expect(MockTeamsBot.createEchoRunner).toHaveBeenCalled();
    expect(buildToolshedState).not.toHaveBeenCalled();
  });

  it('RUNNER=orchestrator forces the orchestrator runner even when GOOSE_SERVE_URL is unset, falling back to localhost:3284', async () => {
    process.env.RUNNER = 'orchestrator';

    await import('../src/index.js');
    await flushMicrotasks();

    expect(createHttpGooseClient).toHaveBeenCalledWith({ baseUrl: 'http://localhost:3284' });
  });

  it('exits when the bot fails to start', async () => {
    mockStart.mockRejectedValueOnce(new Error('start failed'));

    await import('../src/index.js');
    await flushMicrotasks();

    expect(errorSpy).toHaveBeenCalledWith('Teams bot failed to start', expect.any(Error));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits when building the toolshed state rejects', async () => {
    process.env.RUNNER = 'orchestrator';
    buildToolshedState.mockReset().mockRejectedValue(new Error('config validation failed'));

    await import('../src/index.js');
    await flushMicrotasks();

    expect(errorSpy).toHaveBeenCalledWith('Teams bot failed to start', expect.any(Error));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
