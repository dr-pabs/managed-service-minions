import { jest } from '@jest/globals';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createMemoryStore } from 'mcp-toolshed';
import { startDashboardServer } from '../src/dashboard.js';

function createFakeServer(closeError?: Error): {
  server: http.Server;
  triggerListen: () => void;
  triggerError: (err: Error) => void;
} {
  const server = new EventEmitter() as http.Server;
  (server as unknown as http.Server).listen = jest.fn((_port: number, callback?: () => void) => {
    if (callback) {
      return server;
    }
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
        listenCallback();
      }
    },
    triggerError: (err: Error) => {
      server.emit('error', err);
    },
  };
}

describe('startDashboardServer server lifecycle errors', () => {
  it('rejects when the server emits an error before listening', async () => {
    const fake = createFakeServer();
    const createServer = jest.fn(() => fake.server);

    const promise = startDashboardServer(createMemoryStore(), 3001, createServer as unknown as typeof http.createServer);
    fake.triggerError(new Error('listen failed'));

    await expect(promise).rejects.toThrow('listen failed');
  });

  it('close rejects when server.close reports an error', async () => {
    const fake = createFakeServer(new Error('close failed'));
    const createServer = jest.fn(() => fake.server);

    const serverPromise = startDashboardServer(
      createMemoryStore(),
      3001,
      createServer as unknown as typeof http.createServer
    );
    fake.triggerListen();
    const server = await serverPromise;

    await expect(server.close()).rejects.toThrow('close failed');
  });

  it('handles a request with no url by falling back to / and serving the dashboard', async () => {
    const fake = createFakeServer();
    let requestHandler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
    const createServer = jest.fn((handler: (req: unknown, res: unknown) => Promise<void>) => {
      requestHandler = handler;
      return fake.server;
    });

    startDashboardServer(createMemoryStore(), 3001, createServer as unknown as typeof http.createServer);
    fake.triggerListen();

    const res = {
      statusCode: 0,
      writeHead: jest.fn(function (this: { statusCode: number }, code: number) {
        this.statusCode = code;
      }),
      end: jest.fn(),
    };

    await requestHandler!({ method: 'GET', url: undefined }, res);

    // url ?? '/' falls back to '/', which now matches the GET / dashboard route
    expect(res.statusCode).toBe(200);
    const html = (res.end.mock.calls[0] as string[])[0];
    expect(html).toContain('<!doctype html>');
  });
});
