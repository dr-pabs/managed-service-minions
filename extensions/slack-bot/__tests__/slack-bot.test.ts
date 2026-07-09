import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { App as BoltApp } from '@slack/bolt';
import { createSlackBot, createEchoRunner, type SlackPoster } from '../src/slack-bot.js';
import type { IngressRunner, SessionStore } from 'framework-core';

class MockApp {
  public eventHandlers: Record<string, (args: unknown) => Promise<void>> = {};
  public messageHandlers: Array<(args: unknown) => Promise<void>> = [];

  event = jest.fn((name: string, handler: (args: unknown) => Promise<void>) => {
    this.eventHandlers[name] = handler;
  });

  message = jest.fn((handler: (args: unknown) => Promise<void>) => {
    this.messageHandlers.push(handler);
  });

  start = jest.fn().mockResolvedValue(undefined);
  stop = jest.fn().mockResolvedValue(undefined);
}

function makeStore(): SessionStore {
  return {
    createSession: jest.fn(),
    getSession: jest.fn().mockReturnValue(undefined),
    updateSession: jest.fn(),
    listSessions: jest.fn(),
    expireSessions: jest.fn(),
    listSessionArchive: jest.fn(),
    createMinionRun: jest.fn(),
    updateMinionRun: jest.fn(),
    listMinionRunsBySession: jest.fn(),
    listMinionRunsByCorrelationRoot: jest.fn(),
    createApproval: jest.fn(),
    getApproval: jest.fn().mockReturnValue(undefined),
    resolveApproval: jest.fn(),
    listPendingApprovals: jest.fn(),
    createAuditEntry: jest.fn(),
    listAuditEntries: jest.fn().mockReturnValue([]),
    getCachedToolCall: jest.fn(),
    setCachedToolCall: jest.fn(),
  };
}

function makeClient(): SlackPoster {
  return {
    chat: {
      postMessage: jest.fn().mockResolvedValue({}),
    },
  };
}

// Drain the microtask / I/O queue so fire-and-forget background work completes.
function flushAsync(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe('createSlackBot', () => {
  let app: MockApp;
  let store: SessionStore;
  let runner: IngressRunner;
  let say: jest.Mock<() => Promise<void>>;
  let client: SlackPoster;

  beforeEach(() => {
    app = new MockApp();
    store = makeStore();
    runner = { run: jest.fn().mockResolvedValue({ text: 'Done' }) };
    say = jest.fn().mockResolvedValue(undefined);
    client = makeClient();
  });

  it('registers app_mention and message handlers', () => {
    createSlackBot(app as unknown as BoltApp, store, runner, {
      signingSecret: 'secret',
      token: 'token',
    });

    expect(app.event).toHaveBeenCalledWith('app_mention', expect.any(Function));
    expect(app.message).toHaveBeenCalledWith(expect.any(Function));
  });

  it('acknowledges app_mention immediately then posts the runner reply proactively', async () => {
    createSlackBot(app as unknown as BoltApp, store, runner, {
      signingSecret: 'secret',
      token: 'token',
    });

    await app.eventHandlers['app_mention']({
      event: {
        type: 'app_mention',
        text: '<@U123> review PR #42',
        team: 'T1',
        channel: 'C1',
        user: 'U42',
        thread_ts: '123.456',
      },
      say,
      client,
    });

    // Ack sent synchronously before Goose runs
    expect(say).toHaveBeenCalledWith(':hourglass_flowing_sand: Working on it…');
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'slack',
        teamId: 'T1',
        channelId: 'C1',
        userId: 'U42',
        text: 'review PR #42',
        threadId: '123.456',
      })
    );

    // Wait for background work to complete
    await flushAsync();

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C1', text: 'Done' })
    );
  });

  it('greets the user when the mention contains only the bot mention', async () => {
    createSlackBot(app as unknown as BoltApp, store, runner, {
      signingSecret: 'secret',
      token: 'token',
    });

    await app.eventHandlers['app_mention']({
      event: {
        type: 'app_mention',
        text: '<@U123>',
        team: 'T1',
        channel: 'C1',
        user: 'U42',
      },
      say,
      client,
    });

    expect(say).toHaveBeenCalledWith('Hi! What can I help you with?');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('falls back to event.ts when thread_ts is absent', async () => {
    createSlackBot(app as unknown as BoltApp, store, runner, {
      signingSecret: 'secret',
      token: 'token',
    });

    await app.eventHandlers['app_mention']({
      event: {
        type: 'app_mention',
        text: '<@U123> help',
        team: 'T1',
        channel: 'C1',
        user: 'U42',
        ts: 'ts-root',
        // no thread_ts
      },
      say,
      client,
    });

    await flushAsync();

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: 'ts-root' })
    );
  });

  it('uses the message own ts (not the channel) as threadId for a non-threaded channel message', async () => {
    createSlackBot(app as unknown as BoltApp, store, runner, {
      signingSecret: 'secret',
      token: 'token',
    });

    await app.eventHandlers['app_mention']({
      event: {
        type: 'app_mention',
        text: '<@U123> help',
        team: 'T1',
        channel: 'C1',
        user: 'U42',
        ts: 'ts-root',
        // no thread_ts: a bare, non-threaded channel message must key its
        // OWN session by its own ts, never by the shared channel id (M3
        // review finding — the old `event.thread_ts ?? event.channel`
        // fallback made every non-threaded message in a channel share one
        // session forever).
      },
      say,
      client,
    });

    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'ts-root' })
    );
    expect(runner.run).not.toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'C1' })
    );
  });

  it('handles direct messages — acks then posts proactively', async () => {
    createSlackBot(app as unknown as BoltApp, store, runner, {
      signingSecret: 'secret',
      token: 'token',
    });

    await app.messageHandlers[0]({
      message: {
        type: 'message',
        subtype: undefined,
        channel_type: 'im',
        text: 'hello minions',
        team: 'T1',
        channel: 'D1',
        user: 'U42',
        ts: '1',
        event_ts: '1',
      },
      say,
      client,
    });

    expect(say).toHaveBeenCalledWith(':hourglass_flowing_sand: Working on it…');
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'slack',
        teamId: 'T1',
        channelId: 'D1',
        userId: 'U42',
        text: 'hello minions',
      })
    );

    await flushAsync();

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'D1', text: 'Done' })
    );
  });

  it('uses empty string for channel when DM event has no channel field', async () => {
    createSlackBot(app as unknown as BoltApp, store, runner, {
      signingSecret: 'secret',
      token: 'token',
    });

    await app.messageHandlers[0]({
      message: {
        type: 'message',
        subtype: undefined,
        channel_type: 'im',
        text: 'hello',
        team: 'T1',
        // no channel
        user: 'U42',
        ts: '2',
        event_ts: '2',
      },
      say,
      client,
    });

    await flushAsync();

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: '' })
    );
  });

  it('ignores non-direct message channel events', async () => {
    createSlackBot(app as unknown as BoltApp, store, runner, {
      signingSecret: 'secret',
      token: 'token',
    });

    await app.messageHandlers[0]({
      message: {
        type: 'message',
        subtype: undefined,
        channel_type: 'channel',
        text: 'hello minions',
        team: 'T1',
        channel: 'C1',
        user: 'U42',
        ts: '1',
        event_ts: '1',
      },
      say,
      client,
    });

    expect(runner.run).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  it('ignores direct messages with no text', async () => {
    createSlackBot(app as unknown as BoltApp, store, runner, {
      signingSecret: 'secret',
      token: 'token',
    });

    await app.messageHandlers[0]({
      message: {
        type: 'message',
        subtype: undefined,
        channel_type: 'im',
        text: undefined,
        team: 'T1',
        channel: 'D1',
        user: 'U42',
        ts: '1',
        event_ts: '1',
      },
      say,
      client,
    });

    expect(runner.run).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  it('omits blocks from the proactive post when blocks array is empty', async () => {
    runner = { run: jest.fn().mockResolvedValue({ text: 'Summary', blocks: [] }) };

    createSlackBot(app as unknown as BoltApp, store, runner, {
      signingSecret: 'secret',
      token: 'token',
    });

    await app.eventHandlers['app_mention']({
      event: {
        type: 'app_mention',
        text: '<@U123> summarize',
        team: 'T1',
        channel: 'C1',
        user: 'U42',
        ts: '1',
      },
      say,
      client,
    });

    await flushAsync();

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({ blocks: expect.anything() })
    );
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Summary' })
    );
  });

  it('includes blocks in the proactive post when the runner returns them', async () => {
    runner = {
      run: jest.fn().mockResolvedValue({
        text: 'Summary',
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Summary' } }],
      }),
    };

    createSlackBot(app as unknown as BoltApp, store, runner, {
      signingSecret: 'secret',
      token: 'token',
    });

    await app.eventHandlers['app_mention']({
      event: {
        type: 'app_mention',
        text: '<@U123> summarize',
        team: 'T1',
        channel: 'C1',
        user: 'U42',
        ts: '1',
      },
      say,
      client,
    });

    await flushAsync();

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Summary',
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Summary' } }],
      })
    );
  });

  it('posts runner errors proactively as user-facing messages', async () => {
    runner = { run: jest.fn().mockRejectedValue(new Error('boom')) };

    createSlackBot(app as unknown as BoltApp, store, runner, {
      signingSecret: 'secret',
      token: 'token',
    });

    await app.eventHandlers['app_mention']({
      event: {
        type: 'app_mention',
        text: '<@U123> fail',
        team: 'T1',
        channel: 'C1',
        user: 'U42',
        ts: '1',
      },
      say,
      client,
    });

    // Ack still sent immediately
    expect(say).toHaveBeenCalledWith(':hourglass_flowing_sand: Working on it…');

    await flushAsync();

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('boom') as string })
    );
  });

  it('posts non-Error failures proactively as user-facing messages', async () => {
    runner = { run: jest.fn().mockRejectedValue('string failure') };

    createSlackBot(app as unknown as BoltApp, store, runner, {
      signingSecret: 'secret',
      token: 'token',
    });

    await app.eventHandlers['app_mention']({
      event: {
        type: 'app_mention',
        text: '<@U123> fail',
        team: 'T1',
        channel: 'C1',
        user: 'U42',
        ts: '1',
      },
      say,
      client,
    });

    await flushAsync();

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('string failure') as string })
    );
  });

  it('fills in defaults when mention metadata is missing', async () => {
    createSlackBot(app as unknown as BoltApp, store, runner, {
      signingSecret: 'secret',
      token: 'token',
    });

    await app.eventHandlers['app_mention']({
      event: {
        type: 'app_mention',
        text: '<@U123> help',
      },
      say,
      client,
    });

    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 'unknown',
        channelId: undefined,
        userId: 'unknown',
        threadId: undefined,
      })
    );
  });

  it('starts and stops the underlying Bolt app', async () => {
    const bot = createSlackBot(app as unknown as BoltApp, store, runner, {
      signingSecret: 'secret',
      token: 'token',
      port: 4000,
    });

    await bot.start();
    expect(app.start).toHaveBeenCalledWith(4000);

    await bot.stop();
    expect(app.stop).toHaveBeenCalled();
  });

  it('uses the default port when none is configured', async () => {
    const bot = createSlackBot(app as unknown as BoltApp, store, runner, {
      signingSecret: 'secret',
      token: 'token',
    });

    await bot.start();
    expect(app.start).toHaveBeenCalledWith(3000);
  });

  describe('createEchoRunner', () => {
    it('returns the request text wrapped in a friendly message', async () => {
      const response = await createEchoRunner().run({
        platform: 'slack',
        teamId: 'T1',
        userId: 'U1',
        text: 'hello',
        sessionId: 's1',
        correlationRoot: 'corr_1',
      });

      expect(response.text).toBe('Minions received: hello');
    });
  });
});
