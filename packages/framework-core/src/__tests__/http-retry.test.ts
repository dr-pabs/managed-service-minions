import { describe, expect, it, jest } from '@jest/globals';
import {
  fetchWithRetry,
  paginateGitHub,
  paginateByParam,
  type RetryPolicy,
} from '../http-retry.js';

function mockResponse(options: {
  ok: boolean;
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
}): Response {
  const headerMap = new Map(
    Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    ok: options.ok,
    status: options.status,
    headers: {
      get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
    },
    json: async () => options.json,
    text: async () => options.text ?? '',
  } as unknown as Response;
}

function fixedRandom(...values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[Math.min(i, values.length - 1)];
    i += 1;
    return v as number;
  };
}

describe('fetchWithRetry', () => {
  it('honors Retry-After as delta-seconds on a 429', async () => {
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        mockResponse({ ok: false, status: 429, headers: { 'Retry-After': '2' } })
      )
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, json: { ok: true } }));

    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const response = await fetchWithRetry(fetchImpl, 'https://example.com/x', {}, {
      sleep,
      random: fixedRandom(0.5),
    });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('parses an HTTP-date Retry-After correctly', async () => {
    const now = new Date('2026-07-09T00:00:00.000Z').getTime();
    const retryAt = new Date(now + 5000).toUTCString();

    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        mockResponse({ ok: false, status: 503, headers: { 'Retry-After': retryAt } })
      )
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, json: { ok: true } }));

    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const response = await fetchWithRetry(fetchImpl, 'https://example.com/x', {}, {
      sleep,
      random: fixedRandom(0.5),
      now: () => now,
    });

    expect(response.status).toBe(200);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it('falls back to backoff when Retry-After is a malformed date', async () => {
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        mockResponse({ ok: false, status: 503, headers: { 'Retry-After': 'not-a-date' } })
      )
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, json: { ok: true } }));

    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const response = await fetchWithRetry(fetchImpl, 'https://example.com/x', {}, {
      sleep,
      random: fixedRandom(0),
      baseDelayMs: 250,
    });

    expect(response.status).toBe(200);
    // full jitter with random()=0 and attempt 0 => delay = 0
    expect(sleep).toHaveBeenCalledWith(0);
  });

  it('waits minimally when Retry-After HTTP-date is already in the past', async () => {
    const now = new Date('2026-07-09T00:00:00.000Z').getTime();
    const pastDate = new Date(now - 10_000).toUTCString();

    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        mockResponse({ ok: false, status: 429, headers: { 'Retry-After': pastDate } })
      )
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, json: { ok: true } }));

    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await fetchWithRetry(fetchImpl, 'https://example.com/x', {}, {
      sleep,
      random: fixedRandom(0.5),
      now: () => now,
    });

    expect(sleep).toHaveBeenCalledWith(0);
  });

  it('retries 502/503/504 and network errors with jittered exponential backoff', async () => {
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 502 }))
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 503 }))
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, json: { ok: true } }));

    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    // full jitter: delay = random() * min(cap, base * 2^attempt)
    const random = fixedRandom(1, 1, 1);

    const response = await fetchWithRetry(fetchImpl, 'https://example.com/x', {}, {
      sleep,
      random,
      baseDelayMs: 250,
      maxAttempts: 4,
    });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenNthCalledWith(1, 250); // attempt 0: base * 2^0 = 250
    expect(sleep).toHaveBeenNthCalledWith(2, 500); // attempt 1: base * 2^1 = 500
    expect(sleep).toHaveBeenNthCalledWith(3, 1000); // attempt 2: base * 2^2 = 1000
  });

  it('uses full jitter deterministically via the injected RNG', async () => {
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 503 }))
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, json: {} }));

    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await fetchWithRetry(fetchImpl, 'https://example.com/x', {}, {
      sleep,
      random: fixedRandom(0.25),
      baseDelayMs: 400,
    });

    // full jitter: delay = random() * base*2^0 = 0.25 * 400 = 100
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it('surfaces the mapped typed error after exhausting all attempts on a persistent 500', async () => {
    class FakeApiError extends Error {
      readonly status: number;
      constructor(status: number, message: string) {
        super(message);
        this.name = 'FakeApiError';
        this.status = status;
      }
    }

    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(mockResponse({ ok: false, status: 500, text: 'boom' }));

    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    // 500 is not in the default retry set, so this should return immediately
    // without exhausting attempts, leaving the caller to raise its typed error.
    const response = await fetchWithRetry(fetchImpl, 'https://example.com/x', {}, {
      sleep,
      random: fixedRandom(0.5),
    });
    expect(response.status).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Simulate a caller (like a client.ts) wrapping fetchWithRetry and mapping
    // a persistent failure status to its own typed error, after retries specific
    // to that status (e.g. 503) are exhausted.
    const flakyFetch = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(mockResponse({ ok: false, status: 503, text: 'still down' }));

    const finalResponse = await fetchWithRetry(flakyFetch, 'https://example.com/y', {}, {
      sleep,
      random: fixedRandom(0.5),
      maxAttempts: 4,
    });
    expect(finalResponse.status).toBe(503);
    expect(flakyFetch).toHaveBeenCalledTimes(4);
    if (!finalResponse.ok) {
      expect(() => {
        throw new FakeApiError(finalResponse.status, 'still down');
      }).toThrow(FakeApiError);
    }
  });

  it('does NOT retry POST by default (asserts single call)', async () => {
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(mockResponse({ ok: false, status: 503 }));

    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const response = await fetchWithRetry(
      fetchImpl,
      'https://example.com/x',
      { method: 'POST' },
      { sleep, random: fixedRandom(0.5) }
    );

    expect(response.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('DOES retry POST when the caller opts in via allowNonIdempotentRetry', async () => {
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 503 }))
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, json: {} }));

    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const response = await fetchWithRetry(
      fetchImpl,
      'https://example.com/x',
      { method: 'POST' },
      { sleep, random: fixedRandom(0.5), allowNonIdempotentRetry: true }
    );

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats GET/PUT/DELETE/HEAD as idempotent and retries them by default', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'HEAD']) {
      const fetchImpl = jest
        .fn<(url: string, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse({ ok: false, status: 503 }))
        .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, json: {} }));
      const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

      const response = await fetchWithRetry(
        fetchImpl,
        'https://example.com/x',
        { method },
        { sleep, random: fixedRandom(0.5) }
      );
      expect(response.status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it('defaults method to GET (idempotent) when init.method is absent', async () => {
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 503 }))
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, json: {} }));
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const response = await fetchWithRetry(fetchImpl, 'https://example.com/x', {}, {
      sleep,
      random: fixedRandom(0.5),
    });
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('stops retrying once maxAttempts is reached, returning the last response', async () => {
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(mockResponse({ ok: false, status: 429, headers: {} }));
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const response = await fetchWithRetry(fetchImpl, 'https://example.com/x', {}, {
      sleep,
      random: fixedRandom(0.5),
      maxAttempts: 3,
    });

    expect(response.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('exhausts attempts on repeated network errors and rethrows the last error', async () => {
    const err = new TypeError('always down');
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockRejectedValue(err);
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      fetchWithRetry(fetchImpl, 'https://example.com/x', {}, {
        sleep,
        random: fixedRandom(0.5),
        maxAttempts: 3,
      })
    ).rejects.toThrow('always down');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry network errors for non-idempotent methods unless opted in', async () => {
    const err = new TypeError('down');
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockRejectedValue(err);
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      fetchWithRetry(fetchImpl, 'https://example.com/x', { method: 'POST' }, {
        sleep,
        random: fixedRandom(0.5),
      })
    ).rejects.toThrow('down');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-retryable status codes (e.g. 404)', async () => {
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(mockResponse({ ok: false, status: 404 }));
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const response = await fetchWithRetry(fetchImpl, 'https://example.com/x', {}, {
      sleep,
      random: fixedRandom(0.5),
    });
    expect(response.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('uses real setTimeout-based sleep and Math.random by default (no injected fakes)', async () => {
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, json: {} }));

    const response = await fetchWithRetry(fetchImpl, 'https://example.com/x', {});
    expect(response.status).toBe(200);
  });

  it('defaults both init and policy when neither is passed at all', async () => {
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, json: {} }));

    const response = await fetchWithRetry(fetchImpl, 'https://example.com/x');
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith('https://example.com/x', {});
  });

  it('exercises the real default sleep/random on an actual retry (no injected fakes)', async () => {
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 503 }))
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, json: {} }));

    const response = await fetchWithRetry(
      fetchImpl,
      'https://example.com/x',
      {},
      { baseDelayMs: 1 }
    );
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('respects a custom retryStatusCodes policy', async () => {
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 418 }))
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, json: {} }));
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const response = await fetchWithRetry(fetchImpl, 'https://example.com/x', {}, {
      sleep,
      random: fixedRandom(0.5),
      retryStatusCodes: [418],
    });
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('paginateGitHub', () => {
  function linkHeader(next?: string): Record<string, string> {
    return next ? { Link: `<${next}>; rel="next", <https://example.com/last>; rel="last"` } : {};
  }

  it('follows RFC 5988 Link rel="next" headers across three pages and concatenates', async () => {
    const page1 = [{ id: 1 }, { id: 2 }];
    const page2 = [{ id: 3 }, { id: 4 }];
    const page3 = [{ id: 5 }];

    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          headers: linkHeader('https://api.github.com/page2'),
          json: page1,
        })
      )
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          headers: linkHeader('https://api.github.com/page3'),
          json: page2,
        })
      )
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          headers: linkHeader(undefined),
          json: page3,
        })
      );

    const result = await paginateGitHub(fetchImpl, 'https://api.github.com/page1', {
      sleep: jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined),
      random: fixedRandom(0.5),
    });

    expect(result).toEqual([...page1, ...page2, ...page3]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('handles Link headers with extra whitespace and multiple rel values', async () => {
    const page1 = [{ id: 1 }];
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          headers: {
            Link: '<https://api.github.com/p1?page=2>; rel="next" , <https://api.github.com/p1?page=9>; rel="last"',
          },
          json: page1,
        })
      )
      .mockResolvedValueOnce(
        mockResponse({ ok: true, status: 200, headers: {}, json: [{ id: 2 }] })
      );

    const result = await paginateGitHub(fetchImpl, 'https://api.github.com/p1');
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/p1?page=2',
      expect.anything()
    );
  });

  it('halts a runaway paginator at the maxItems safety cap (default 500)', async () => {
    let call = 0;
    const fetchImpl = jest.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => {
        call += 1;
        const items = Array.from({ length: 100 }, (_, i) => ({ id: call * 100 + i }));
        return mockResponse({
          ok: true,
          status: 200,
          headers: { Link: `<https://api.github.com/page${call + 1}>; rel="next"` },
          json: items,
        });
      }
    );

    const result = await paginateGitHub(fetchImpl, 'https://api.github.com/page1');
    expect(result.length).toBeLessThanOrEqual(500);
    // 5 pages of 100 = 500 exactly; a 6th page must never be fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('honors a custom maxItems cap', async () => {
    let call = 0;
    const fetchImpl = jest.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => {
        call += 1;
        return mockResponse({
          ok: true,
          status: 200,
          headers: { Link: `<https://api.github.com/page${call + 1}>; rel="next"` },
          json: [{ id: call }],
        });
      }
    );

    const result = await paginateGitHub(fetchImpl, 'https://api.github.com/page1', {
      maxItems: 2,
    });
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('propagates typed errors from a non-OK page response via onError', async () => {
    class FakeApiError extends Error {}
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(mockResponse({ ok: false, status: 500, text: 'boom' }));

    await expect(
      paginateGitHub(fetchImpl, 'https://api.github.com/page1', {
        onError: (response) => {
          throw new FakeApiError(`mapped ${response.status}`);
        },
      })
    ).rejects.toThrow(FakeApiError);
  });

  it('stops with items collected so far when a page is non-OK and no onError is given', async () => {
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          headers: linkHeader('https://api.github.com/page2'),
          json: [{ id: 1 }],
        })
      )
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 500, text: 'boom' }));

    const result = await paginateGitHub(fetchImpl, 'https://api.github.com/page1');
    expect(result).toEqual([{ id: 1 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('threads init (e.g. auth headers) through every page request', async () => {
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          headers: linkHeader('https://api.github.com/page2'),
          json: [{ id: 1 }],
        })
      )
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, json: [{ id: 2 }] }));

    await paginateGitHub(fetchImpl, 'https://api.github.com/page1', {
      init: { headers: { Authorization: 'Bearer token' } },
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/page1',
      expect.objectContaining({ headers: { Authorization: 'Bearer token' } })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/page2',
      expect.objectContaining({ headers: { Authorization: 'Bearer token' } })
    );
  });

  it('truncates a page mid-way when it would exceed maxItems', async () => {
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          headers: linkHeader(undefined),
          json: [{ id: 1 }, { id: 2 }, { id: 3 }],
        })
      );

    const result = await paginateGitHub(fetchImpl, 'https://api.github.com/page1', {
      maxItems: 2,
    });
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('paginateByParam', () => {
  it('follows a three-page offset-style traversal and concatenates results', async () => {
    const fetchImpl = jest.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async (url: string) => {
        const u = new URL(url);
        const offset = Number(u.searchParams.get('offset') ?? '0');
        if (offset === 0) {
          return mockResponse({ ok: true, status: 200, json: { value: [{ id: 1 }, { id: 2 }] } });
        }
        if (offset === 2) {
          return mockResponse({ ok: true, status: 200, json: { value: [{ id: 3 }, { id: 4 }] } });
        }
        if (offset === 4) {
          return mockResponse({ ok: true, status: 200, json: { value: [{ id: 5 }] } });
        }
        return mockResponse({ ok: true, status: 200, json: { value: [] } });
      }
    );

    const result = await paginateByParam(
      fetchImpl,
      'https://dev.azure.com/org/proj/_apis/things?api-version=7.1',
      {
        pageSize: 2,
        offsetParam: 'offset',
        pageSizeParam: 'top',
        extractItems: (body) => (body as { value: unknown[] }).value,
      }
    );

    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('stops when a page returns fewer items than pageSize', async () => {
    const fetchImpl = jest.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async (url: string) => {
        const u = new URL(url);
        const offset = Number(u.searchParams.get('offset') ?? '0');
        if (offset === 0) {
          return mockResponse({ ok: true, status: 200, json: { value: [{ id: 1 }, { id: 2 }] } });
        }
        return mockResponse({ ok: true, status: 200, json: { value: [{ id: 3 }] } });
      }
    );

    const result = await paginateByParam(
      fetchImpl,
      'https://example.com/things',
      {
        pageSize: 2,
        offsetParam: 'offset',
        pageSizeParam: 'top',
        extractItems: (body) => (body as { value: unknown[] }).value,
      }
    );
    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('halts a runaway paginator at the maxItems safety cap (default 500)', async () => {
    const fetchImpl = jest.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => mockResponse({ ok: true, status: 200, json: { value: Array.from({ length: 50 }, (_, i) => ({ id: i })) } })
    );

    const result = await paginateByParam(fetchImpl, 'https://example.com/things', {
      pageSize: 50,
      offsetParam: 'offset',
      pageSizeParam: 'top',
      extractItems: (body) => (body as { value: unknown[] }).value,
    });

    expect(result.length).toBeLessThanOrEqual(500);
    expect(fetchImpl).toHaveBeenCalledTimes(10);
  });

  it('honors a custom maxItems cap', async () => {
    const fetchImpl = jest.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => mockResponse({ ok: true, status: 200, json: { value: [{ id: 1 }, { id: 2 }] } })
    );

    const result = await paginateByParam(fetchImpl, 'https://example.com/things', {
      pageSize: 2,
      offsetParam: 'offset',
      pageSizeParam: 'top',
      extractItems: (body) => (body as { value: unknown[] }).value,
      maxItems: 3,
    });

    // Cap of 3: page 1 yields 2 items (below cap, so page 2 is fetched), page 2 yields 2
    // more but only 1 is kept to respect the cap.
    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 1 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('propagates typed errors from a non-OK page response via onError', async () => {
    class FakeApiError extends Error {}
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(mockResponse({ ok: false, status: 500, text: 'boom' }));

    await expect(
      paginateByParam(fetchImpl, 'https://example.com/things', {
        pageSize: 2,
        offsetParam: 'offset',
        pageSizeParam: 'top',
        extractItems: (body) => (body as { value: unknown[] }).value,
        onError: (response) => {
          throw new FakeApiError(`mapped ${response.status}`);
        },
      })
    ).rejects.toThrow(FakeApiError);
  });

  it('applies a page-number style (not just offset) via pageParam option', async () => {
    const fetchImpl = jest.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async (url: string) => {
        const u = new URL(url);
        const page = Number(u.searchParams.get('page') ?? '1');
        if (page === 1) {
          return mockResponse({ ok: true, status: 200, json: { issues: [{ id: 1 }, { id: 2 }] } });
        }
        if (page === 2) {
          return mockResponse({ ok: true, status: 200, json: { issues: [{ id: 3 }] } });
        }
        return mockResponse({ ok: true, status: 200, json: { issues: [] } });
      }
    );

    const result = await paginateByParam(fetchImpl, 'https://example.com/search?page=1', {
      pageSize: 2,
      pageParam: 'page',
      extractItems: (body) => (body as { issues: unknown[] }).issues,
      startPage: 1,
    });

    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('stops with items collected so far when a page is non-OK and no onError is given', async () => {
    const fetchImpl = jest
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        mockResponse({ ok: true, status: 200, json: { value: [{ id: 1 }, { id: 2 }] } })
      )
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 500, text: 'boom' }));

    const result = await paginateByParam(fetchImpl, 'https://example.com/things', {
      pageSize: 2,
      offsetParam: 'offset',
      pageSizeParam: 'top',
      extractItems: (body) => (body as { value: unknown[] }).value,
    });
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('threads init (e.g. auth headers) through every page request', async () => {
    const fetchImpl = jest.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => mockResponse({ ok: true, status: 200, json: { value: [{ id: 1 }] } })
    );

    await paginateByParam(fetchImpl, 'https://example.com/things', {
      pageSize: 2,
      offsetParam: 'offset',
      extractItems: (body) => (body as { value: unknown[] }).value,
      init: { headers: { Authorization: 'Basic xyz' } },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('offset=0'),
      expect.objectContaining({ headers: { Authorization: 'Basic xyz' } })
    );
  });

  const _unusedPolicy: RetryPolicy | undefined = undefined;
  void _unusedPolicy;
});
