import { describe, expect, it, jest } from '@jest/globals';
import { createGooseRunner } from '../goose-runner.js';
import type { FetchFn } from '../goose-runner.js';

function makeRequest() {
  return {
    platform: 'slack' as const,
    teamId: 'T1',
    userId: 'U1',
    text: 'review PR #42',
    sessionId: 'sess-1',
    correlationRoot: 'corr_abc',
  };
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn<() => Promise<string>>().mockResolvedValue(JSON.stringify(body)),
    json: jest.fn<() => Promise<unknown>>().mockResolvedValue(body),
  } as unknown as Response;
}

function makeTextResponse(text: string, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn<() => Promise<string>>().mockResolvedValue(text),
    json: jest.fn<() => Promise<unknown>>().mockRejectedValue(new Error('not json')),
  } as unknown as Response;
}

describe('createGooseRunner', () => {
  it('posts to {baseUrl}/reply with correct shape', async () => {
    const fetch = jest.fn<FetchFn>().mockResolvedValue(
      makeJsonResponse({ role: 'assistant', content: 'Done' })
    );

    const runner = createGooseRunner({ baseUrl: 'http://goose:3284', fetch });
    await runner.run(makeRequest());

    expect(fetch).toHaveBeenCalledWith(
      'http://goose:3284/reply',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Correlation-Id': 'corr_abc',
        }),
      })
    );

    const call = fetch.mock.calls[0];
    const bodyStr = (call[1] as RequestInit).body as string;
    const body = JSON.parse(bodyStr);
    expect(body).toEqual({
      messages: [{ role: 'user', content: 'review PR #42' }],
      session_id: 'sess-1',
      correlation_id: 'corr_abc',
    });
  });

  it('returns text from the assistant reply', async () => {
    const fetch = jest.fn<FetchFn>().mockResolvedValue(
      makeJsonResponse({ role: 'assistant', content: 'Here is the review.' })
    );

    const runner = createGooseRunner({ baseUrl: 'http://goose:3284', fetch });
    const result = await runner.run(makeRequest());

    expect(result).toEqual({ text: 'Here is the review.' });
  });

  it('uses globalThis.fetch when no fetch is provided', async () => {
    const globalFetch = jest.fn<FetchFn>().mockResolvedValue(
      makeJsonResponse({ role: 'assistant', content: 'ok' })
    );
    // Temporarily replace globalThis.fetch
    const original = globalThis.fetch;
    // @ts-expect-error — assigning mock to globalThis.fetch for test isolation
    globalThis.fetch = globalFetch;

    try {
      const runner = createGooseRunner({ baseUrl: 'http://goose:3284' });
      const result = await runner.run(makeRequest());
      expect(globalFetch).toHaveBeenCalled();
      expect(result.text).toBe('ok');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('throws a descriptive error when the server is unreachable', async () => {
    const fetch = jest.fn<FetchFn>().mockRejectedValue(new Error('ECONNREFUSED'));

    const runner = createGooseRunner({ baseUrl: 'http://goose:3284', fetch });

    await expect(runner.run(makeRequest())).rejects.toThrow(
      'Goose serve unreachable at http://goose:3284: ECONNREFUSED'
    );
  });

  it('wraps non-Error network failures in a descriptive error', async () => {
    const fetch = jest.fn<FetchFn>().mockRejectedValue('timeout');

    const runner = createGooseRunner({ baseUrl: 'http://goose:3284', fetch });

    await expect(runner.run(makeRequest())).rejects.toThrow(
      'Goose serve unreachable at http://goose:3284: timeout'
    );
  });

  it('throws when goose serve returns a non-2xx status', async () => {
    const fetch = jest.fn<FetchFn>().mockResolvedValue(
      makeTextResponse('service unavailable', 503)
    );

    const runner = createGooseRunner({ baseUrl: 'http://goose:3284', fetch });

    await expect(runner.run(makeRequest())).rejects.toThrow(
      'Goose serve returned 503: service unavailable'
    );
  });

  it('throws when the response body is missing the content field', async () => {
    const fetch = jest.fn<FetchFn>().mockResolvedValue(
      makeJsonResponse({ role: 'assistant' })
    );

    const runner = createGooseRunner({ baseUrl: 'http://goose:3284', fetch });

    await expect(runner.run(makeRequest())).rejects.toThrow(
      'Goose serve returned an unexpected response shape'
    );
  });

  it('throws when the response body is missing the role field', async () => {
    const fetch = jest.fn<FetchFn>().mockResolvedValue(
      makeJsonResponse({ content: 'hello' })
    );

    const runner = createGooseRunner({ baseUrl: 'http://goose:3284', fetch });

    await expect(runner.run(makeRequest())).rejects.toThrow(
      'Goose serve returned an unexpected response shape'
    );
  });

  it('throws when the response body is null', async () => {
    const fetch = jest.fn<FetchFn>().mockResolvedValue(makeJsonResponse(null));

    const runner = createGooseRunner({ baseUrl: 'http://goose:3284', fetch });

    await expect(runner.run(makeRequest())).rejects.toThrow(
      'Goose serve returned an unexpected response shape'
    );
  });

  it('throws when the response body is not an object', async () => {
    const fetch = jest.fn<FetchFn>().mockResolvedValue(makeJsonResponse('plain string'));

    const runner = createGooseRunner({ baseUrl: 'http://goose:3284', fetch });

    await expect(runner.run(makeRequest())).rejects.toThrow(
      'Goose serve returned an unexpected response shape'
    );
  });
});
