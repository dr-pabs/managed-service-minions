import http from 'node:http';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Application } from '@microsoft/teams-ai';
import type { Activity, TurnContext } from 'botbuilder';
import { createTeamsBot, createEchoRunner } from '../src/teams-bot.js';
import type { IngressRunner, SessionStore } from 'framework-core';

// Drain the microtask / I/O queue so fire-and-forget background work completes.
function flushAsync(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

class MockApplication {
  public messageHandlers: Array<(context: TurnContext, state: unknown) => Promise<void>> = [];

  message = jest.fn((...args: unknown[]) => {
    const handler = args[args.length - 1] as (context: TurnContext, state: unknown) => Promise<void>;
    this.messageHandlers.push(handler);
  });

  adapter = {
    process: jest.fn().mockImplementation(async (req, res, logic) => {
      res.header('X-Test', '1');
      res.status(200);
      if (req.body && (req.body as Record<string, unknown>).type === 'message') {
        res.send('ok');
      } else {
        res.end();
      }
      const context = {
        activity: (req.body as Activity | undefined) ?? ({ type: 'message', text: 'ping' } as Activity),
        sendActivity: jest.fn().mockResolvedValue({}),
      } as unknown as TurnContext;
      await logic(context);
    }),
    // Proactive messaging: call the logic callback with a fresh mock context so
    // tests can inspect what was sent via continueConversation.
    continueConversation: jest.fn().mockImplementation(async (_ref: unknown, logic: (ctx: TurnContext) => Promise<void>) => {
      const proactiveCtx = {
        activity: {} as Activity,
        sendActivity: jest.fn().mockResolvedValue({}),
      } as unknown as TurnContext;
      await logic(proactiveCtx);
    }),
  };

  run = jest.fn().mockResolvedValue(true);
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

function createContext(activity: Partial<Activity>): TurnContext {
  return {
    activity: activity as Activity,
    sendActivity: jest.fn().mockResolvedValue({}),
  } as unknown as TurnContext;
}

describe('createTeamsBot', () => {
  let app: MockApplication;
  let store: SessionStore;
  let runner: IngressRunner;

  beforeEach(() => {
    app = new MockApplication();
    store = makeStore();
    runner = { run: jest.fn().mockResolvedValue({ text: 'Done' }) };
  });

  it('registers a message handler', () => {
    createTeamsBot(app as unknown as Application, store, runner);
    expect(app.message).toHaveBeenCalledWith(/.*/, expect.any(Function));
  });

  it('acknowledges a Teams message immediately then sends the reply proactively', async () => {
    createTeamsBot(app as unknown as Application, store, runner);
    const context = createContext({
      type: 'message',
      text: 'review PR #42',
      conversation: { id: 'conv-1', tenantId: 'tenant-1', isGroup: false, conversationType: 'channel', name: '' },
      from: { id: 'user-1', name: '' },
    });

    await app.messageHandlers[0](context, {});

    // Ack sent synchronously before Goose runs
    expect(context.sendActivity).toHaveBeenCalledWith(':hourglass_flowing_sand: Working on it…');
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'teams',
        teamId: 'tenant-1',
        channelId: 'conv-1',
        userId: 'user-1',
        text: 'review PR #42',
        threadId: 'conv-1',
      })
    );

    await flushAsync();

    // Proactive reply sent via continueConversation
    expect(app.adapter.continueConversation).toHaveBeenCalled();
    const [[, logic]] = (app.adapter.continueConversation as jest.Mock).mock.calls as [[unknown, (ctx: TurnContext) => Promise<void>]];
    const proactiveCtx = { sendActivity: jest.fn().mockResolvedValue({}) } as unknown as TurnContext;
    await logic(proactiveCtx);
    expect(proactiveCtx.sendActivity).toHaveBeenCalledWith('Done');
  });

  it('ignores messages with no text', async () => {
    createTeamsBot(app as unknown as Application, store, runner);
    const context = createContext({
      type: 'message',
      text: undefined,
      conversation: { id: 'conv-1', isGroup: false, conversationType: 'channel', name: '' },
      from: { id: 'user-1', name: '' },
    });

    await app.messageHandlers[0](context, {});

    expect(runner.run).not.toHaveBeenCalled();
    expect(context.sendActivity).not.toHaveBeenCalled();
  });

  it('fills in defaults when activity metadata is missing', async () => {
    createTeamsBot(app as unknown as Application, store, runner);
    const context = createContext({
      type: 'message',
      text: 'help',
    });

    await app.messageHandlers[0](context, {});

    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 'unknown',
        userId: 'unknown',
        channelId: undefined,
        threadId: undefined,
      })
    );
  });

  it('sends an Adaptive Card proactively when the runner returns one', async () => {
    runner = {
      run: jest.fn().mockResolvedValue({
        text: 'Summary',
        adaptiveCard: { type: 'AdaptiveCard', body: [] },
      }),
    };

    createTeamsBot(app as unknown as Application, store, runner);
    const context = createContext({
      type: 'message',
      text: 'summarize',
      conversation: { id: 'conv-1', isGroup: false, conversationType: 'channel', name: '' },
      from: { id: 'user-1', name: '' },
    });

    await app.messageHandlers[0](context, {});
    await flushAsync();

    expect(app.adapter.continueConversation).toHaveBeenCalled();
    const [[, logic]] = (app.adapter.continueConversation as jest.Mock).mock.calls as [[unknown, (ctx: TurnContext) => Promise<void>]];
    const proactiveCtx = { sendActivity: jest.fn().mockResolvedValue({}) } as unknown as TurnContext;
    await logic(proactiveCtx);
    expect(proactiveCtx.sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Summary',
        attachments: expect.arrayContaining([
          expect.objectContaining({
            contentType: 'application/vnd.microsoft.card.adaptive',
          }),
        ]) as unknown[],
      })
    );
  });

  it('sends runner errors proactively as user-facing messages', async () => {
    runner = { run: jest.fn().mockRejectedValue(new Error('boom')) };

    createTeamsBot(app as unknown as Application, store, runner);
    const context = createContext({
      type: 'message',
      text: 'fail',
      conversation: { id: 'conv-1', isGroup: false, conversationType: 'channel', name: '' },
      from: { id: 'user-1', name: '' },
    });

    await app.messageHandlers[0](context, {});

    // Ack still sent immediately
    expect(context.sendActivity).toHaveBeenCalledWith(':hourglass_flowing_sand: Working on it…');

    await flushAsync();

    expect(app.adapter.continueConversation).toHaveBeenCalled();
    const [[, logic]] = (app.adapter.continueConversation as jest.Mock).mock.calls as [[unknown, (ctx: TurnContext) => Promise<void>]];
    const proactiveCtx = { sendActivity: jest.fn().mockResolvedValue({}) } as unknown as TurnContext;
    await logic(proactiveCtx);
    expect(proactiveCtx.sendActivity).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('sends non-Error failures proactively as user-facing messages', async () => {
    runner = { run: jest.fn().mockRejectedValue('string failure') };

    createTeamsBot(app as unknown as Application, store, runner);
    const context = createContext({
      type: 'message',
      text: 'fail',
      conversation: { id: 'conv-1', isGroup: false, conversationType: 'channel', name: '' },
      from: { id: 'user-1', name: '' },
    });

    await app.messageHandlers[0](context, {});
    await flushAsync();

    expect(app.adapter.continueConversation).toHaveBeenCalled();
    const [[, logic]] = (app.adapter.continueConversation as jest.Mock).mock.calls as [[unknown, (ctx: TurnContext) => Promise<void>]];
    const proactiveCtx = { sendActivity: jest.fn().mockResolvedValue({}) } as unknown as TurnContext;
    await logic(proactiveCtx);
    expect(proactiveCtx.sendActivity).toHaveBeenCalledWith(expect.stringContaining('string failure'));
  });

  it('starts and stops the HTTP server and forwards requests to the adapter', async () => {
    const originalCreateServer = http.createServer;
    let capturedServer: http.Server | undefined;
    const createServerSpy = jest.spyOn(http, 'createServer').mockImplementation((...args: unknown[]) => {
      const server = (originalCreateServer as (...args: unknown[]) => http.Server)(...(args as [http.RequestListener]));
      capturedServer = server;
      return server;
    });

    function post(path: string, body: string, contentType: string): Promise<http.IncomingMessage> {
      return new Promise((resolve, reject) => {
        const address = capturedServer!.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        const req = http.request(
          { hostname: '127.0.0.1', port, method: 'POST', path, headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) } },
          (res) => {
            res.resume();
            resolve(res);
          }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });
    }

    const bot = createTeamsBot(app as unknown as Application, store, runner, { port: 0 });
    await bot.start();

    expect(capturedServer).toBeDefined();
    expect(app.adapter.process).toHaveBeenCalledTimes(0);

    await new Promise<void>((resolve, reject) => {
      const address = capturedServer!.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const req = http.get(`http://127.0.0.1:${port}/api/messages`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', reject);
    });
    expect(app.adapter.process).toHaveBeenCalledTimes(1);

    await post('/api/messages', JSON.stringify({ type: 'message', text: 'hello' }), 'application/json');
    expect(app.adapter.process).toHaveBeenCalledTimes(2);

    await post('/api/messages', 'not-json', 'text/plain');
    expect(app.adapter.process).toHaveBeenCalledTimes(3);

    await bot.stop();
    createServerSpy.mockRestore();
  });

  it('uses the default port when none is configured', async () => {
    const bot = createTeamsBot(app as unknown as Application, store, runner);

    await bot.start();
    await bot.stop();
  });

  it('rejects start when the configured port is already in use', async () => {
    const originalCreateServer = http.createServer;
    let capturedServer: http.Server | undefined;
    const createServerSpy = jest.spyOn(http, 'createServer').mockImplementation((...args: unknown[]) => {
      const server = (originalCreateServer as (...args: unknown[]) => http.Server)(...(args as [http.RequestListener]));
      capturedServer = server;
      return server;
    });

    const firstBot = createTeamsBot(app as unknown as Application, store, runner, { port: 0 });
    await firstBot.start();

    const address = capturedServer!.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    const secondApp = new MockApplication();
    const secondBot = createTeamsBot(secondApp as unknown as Application, store, runner, { port });
    await expect(secondBot.start()).rejects.toThrow();

    await firstBot.stop();
    await secondBot.stop();
    createServerSpy.mockRestore();
  });

  it('resolves stop when the server was never started', async () => {
    const bot = createTeamsBot(app as unknown as Application, store, runner);
    await expect(bot.stop()).resolves.toBeUndefined();
  });

  describe('createEchoRunner', () => {
    it('returns the request text wrapped in a friendly message', async () => {
      const response = await createEchoRunner().run({
        platform: 'teams',
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
