import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockStart = jest.fn<() => Promise<void>>();
const mockStop = jest.fn<() => Promise<unknown>>();
const MockSlackBot = {
  createSlackBot: jest.fn().mockReturnValue({ start: mockStart, stop: mockStop }),
};

jest.unstable_mockModule('../src/slack-bot.js', () => MockSlackBot);

const mockSqliteStore = { createSession: jest.fn() };
const createSqliteStore = jest.fn().mockReturnValue(mockSqliteStore);

jest.unstable_mockModule('mcp-toolshed', () => ({
  createSqliteStore,
}));

const mockGooseRunner = { run: jest.fn() };
const mockCreateGooseRunner = jest.fn().mockReturnValue(mockGooseRunner);

jest.unstable_mockModule('framework-core', () => ({
  createGooseRunner: mockCreateGooseRunner,
}));

const mockAppConstructor = jest.fn();
jest.unstable_mockModule('@slack/bolt', () => ({
  App: mockAppConstructor,
}));

describe('slack-bot index', () => {
  const originalEnv = process.env;
  let exitSpy: jest.SpiedFunction<typeof process.exit>;
  let errorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockStart.mockReset().mockResolvedValue(undefined);
    mockStop.mockReset().mockResolvedValue(undefined);
    MockSlackBot.createSlackBot.mockClear();
    mockCreateGooseRunner.mockClear();
    createSqliteStore.mockClear();
    mockAppConstructor.mockReset().mockReturnValue({});
  });

  afterEach(() => {
    process.env = originalEnv;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('creates a Bolt app and starts the bot with env config', async () => {
    process.env.SLACK_SIGNING_SECRET = 'signing';
    process.env.SLACK_BOT_TOKEN = 'token';
    process.env.PORT = '4000';
    process.env.SQLITE_PATH = '/data/bot.db';
    process.env.GOOSE_SERVE_URL = 'http://goose:3284';

    await import('../src/index.js');

    expect(mockAppConstructor).toHaveBeenCalledWith({
      signingSecret: 'signing',
      token: 'token',
    });
    expect(createSqliteStore).toHaveBeenCalledWith('/data/bot.db');
    expect(mockCreateGooseRunner).toHaveBeenCalledWith({ baseUrl: 'http://goose:3284' });
    expect(MockSlackBot.createSlackBot).toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalled();
  });

  it('falls back to localhost:3284 when GOOSE_SERVE_URL is not set', async () => {
    delete process.env.GOOSE_SERVE_URL;

    await import('../src/index.js');

    expect(mockCreateGooseRunner).toHaveBeenCalledWith({
      baseUrl: 'http://localhost:3284',
    });
  });

  it('exits when the bot fails to start', async () => {
    mockStart.mockRejectedValueOnce(new Error('start failed'));

    await import('../src/index.js');

    expect(errorSpy).toHaveBeenCalledWith('Slack bot failed to start', expect.any(Error));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
