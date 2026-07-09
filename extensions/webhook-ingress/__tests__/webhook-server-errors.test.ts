import { describe, expect, it, jest } from '@jest/globals';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { IngressRunner } from 'framework-core';
import { createWebhookServer } from '../src/webhook-ingress.js';

/**
 * Server-lifecycle and defensive-catch coverage that the request-level
 * behavioral tests in webhook-ingress.test.ts don't exercise: a `listen`
 * failure before the server is up, a `close()` failure, and the outer
 * try/catch around the whole request handler (an unexpected stream error
 * mid-body-read) -- mirrors `agent-dashboard`'s `dashboard-server-errors.test.ts`
 * fake-server pattern (the same repo already establishes this convention for
 * bare `node:http` server lifecycle testing).
 */
function createFakeServer(closeError?: Error): {
  server: http.Server;
  triggerListen: () => void;
  triggerError: (err: Error) => void;
} {
  const server = new EventEmitter() as http.Server;
  (server as unknown as http.Server).listen = jest.fn((_port: number, callback?: () => void) => {
    void callback;
    return server;
  }) as unknown as http.Server['listen'];
  (server as unknown as http.Server).close = jest.fn((callback?: (err?: Error) => void) => {
    if (callback) {
      callback(closeError);
    }
    return server;
  }) as unknown as http.Server['close'];
  (server as unknown as http.Server).address = jest.fn(() => null) as unknown as http.Server['address'];

  return {
    server: server as unknown as http.Server,
    triggerListen: () => {
      const listenCallback = ((server as unknown as http.Server).listen as jest.Mock).mock.calls[0][1];
      if (typeof listenCallback === 'function') {
        (listenCallback as () => void)();
      }
    },
    triggerError: (err: Error) => {
      server.emit('error', err);
    },
  };
}

const runner: IngressRunner = { run: jest.fn() };

describe('createWebhookServer lifecycle errors', () => {
  it('rejects when the server emits an error before listening', async () => {
    const fake = createFakeServer();
    const createServer = jest.fn(() => fake.server);

    const promise = createWebhookServer({
      runner,
      githubWebhookSecret: 's',
      adoUsername: 'u',
      adoPassword: 'p',
      port: 0,
      createServer: createServer as unknown as typeof http.createServer,
    });
    fake.triggerError(new Error('listen failed'));

    await expect(promise).rejects.toThrow('listen failed');
  });

  it('close() rejects when server.close reports an error', async () => {
    const fake = createFakeServer(new Error('close failed'));
    const createServer = jest.fn(() => fake.server);

    const serverPromise = createWebhookServer({
      runner,
      githubWebhookSecret: 's',
      adoUsername: 'u',
      adoPassword: 'p',
      port: 0,
      createServer: createServer as unknown as typeof http.createServer,
    });
    fake.triggerListen();
    const server = await serverPromise;

    await expect(server.close()).rejects.toThrow('close failed');
  });

  it('a request-handler-level exception (e.g. a body stream error) is caught and answered with 500, not left to crash the process', async () => {
    const fake = createFakeServer();
    let requestHandler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
    const createServer = jest.fn((handler: (req: unknown, res: unknown) => Promise<void>) => {
      requestHandler = handler;
      return fake.server;
    });

    const serverPromise = createWebhookServer({
      runner,
      githubWebhookSecret: 's',
      adoUsername: 'u',
      adoPassword: 'p',
      port: 0,
      createServer: createServer as unknown as typeof http.createServer,
    });
    fake.triggerListen();
    await serverPromise;

    const res = {
      statusCode: 0,
      headers: {} as Record<string, unknown>,
      writeHead: jest.fn(function (this: { statusCode: number }, code: number) {
        this.statusCode = code;
      }),
      end: jest.fn(),
    };
    // A request object whose `.on('data', ...)` throws synchronously, so
    // readRawBody's Promise executor throws before ever attaching the
    // 'error'/'end' handlers -- the outer try/catch around the whole
    // handler is what has to answer this, not readRawBody's own reject path.
    const req = {
      method: 'POST',
      url: '/webhooks/github',
      headers: {},
      on: () => {
        throw new Error('stream exploded');
      },
    };

    await requestHandler!(req, res);

    expect(res.statusCode).toBe(500);
    const payload = JSON.parse((res.end.mock.calls[0] as string[])[0]);
    expect(payload.error).toBe('stream exploded');
  });

  it('handles array-valued X-Hub-Signature-256/X-GitHub-Event headers (Node normalizes duplicate headers to arrays) by using the first value', async () => {
    const fake = createFakeServer();
    let requestHandler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
    const createServer = jest.fn((handler: (req: unknown, res: unknown) => Promise<void>) => {
      requestHandler = handler;
      return fake.server;
    });

    const runMock = jest.fn(async () => ({ text: 'ok' }));
    const arrayHeaderRunner: IngressRunner = { run: runMock as unknown as IngressRunner['run'] };

    const secret = 's';
    const body = JSON.stringify({
      action: 'opened',
      pull_request: {
        number: 1,
        title: 'T',
        body: 'B',
        base: { repo: { owner: { login: 'acme' }, name: 'widgets' } },
      },
    });
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

    const serverPromise = createWebhookServer({
      runner: arrayHeaderRunner,
      githubWebhookSecret: secret,
      adoUsername: 'u',
      adoPassword: 'p',
      port: 0,
      createServer: createServer as unknown as typeof http.createServer,
    });
    fake.triggerListen();
    await serverPromise;

    const res = {
      statusCode: 0,
      writeHead: jest.fn(function (this: { statusCode: number }, code: number) {
        this.statusCode = code;
      }),
      end: jest.fn(),
    };
    const req = new EventEmitter() as unknown as {
      method: string;
      url: string;
      headers: Record<string, string[]>;
      on: (event: string, cb: (chunk?: Buffer) => void) => void;
    };
    req.method = 'POST';
    req.url = '/webhooks/github';
    req.headers = { 'x-hub-signature-256': [signature], 'x-github-event': ['pull_request'] };

    const handlerPromise = requestHandler!(req, res);
    (req as unknown as EventEmitter).emit('data', Buffer.from(body));
    (req as unknown as EventEmitter).emit('end');
    await handlerPromise;

    expect(res.statusCode).toBe(202);
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to "/" when req.url is undefined, and 404s (no matching route)', async () => {
    const fake = createFakeServer();
    let requestHandler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
    const createServer = jest.fn((handler: (req: unknown, res: unknown) => Promise<void>) => {
      requestHandler = handler;
      return fake.server;
    });

    const serverPromise = createWebhookServer({
      runner,
      githubWebhookSecret: 's',
      adoUsername: 'u',
      adoPassword: 'p',
      port: 0,
      createServer: createServer as unknown as typeof http.createServer,
    });
    fake.triggerListen();
    await serverPromise;

    const res = {
      statusCode: 0,
      writeHead: jest.fn(function (this: { statusCode: number }, code: number) {
        this.statusCode = code;
      }),
      end: jest.fn(),
    };
    const req = { method: 'GET', url: undefined, headers: {} };

    await requestHandler!(req, res);

    expect(res.statusCode).toBe(404);
  });

  it('stringifies a non-Error thrown value in the outer catch (e.g. a rejected string)', async () => {
    const fake = createFakeServer();
    let requestHandler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
    const createServer = jest.fn((handler: (req: unknown, res: unknown) => Promise<void>) => {
      requestHandler = handler;
      return fake.server;
    });

    const serverPromise = createWebhookServer({
      runner,
      githubWebhookSecret: 's',
      adoUsername: 'u',
      adoPassword: 'p',
      port: 0,
      createServer: createServer as unknown as typeof http.createServer,
    });
    fake.triggerListen();
    await serverPromise;

    const res = {
      statusCode: 0,
      writeHead: jest.fn(function (this: { statusCode: number }, code: number) {
        this.statusCode = code;
      }),
      end: jest.fn(),
    };
    // `new URL(...)` throws a non-Error-shaped rejection path is hard to
    // reach naturally, so directly force the outer catch's non-Error branch
    // by making `req.method` access throw a plain string via a Proxy.
    const req = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'url') return '/webhooks/github';
          if (prop === 'method') {
            throw 'plain string throw';
          }
          return undefined;
        },
      }
    );

    await requestHandler!(req, res);

    expect(res.statusCode).toBe(500);
    const payload = JSON.parse((res.end.mock.calls[0] as string[])[0]);
    expect(payload.error).toBe('plain string throw');
  });
});
