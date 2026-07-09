import { describe, expect, it, jest } from '@jest/globals';
import { createHttpGooseClient, isGooseReplyResponsePayload } from '../src/goose-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('isGooseReplyResponsePayload', () => {
  it('accepts a well-formed payload', () => {
    expect(isGooseReplyResponsePayload({ role: 'assistant', content: 'hi' })).toBe(true);
  });

  it('rejects null, non-objects, and payloads missing fields', () => {
    expect(isGooseReplyResponsePayload(null)).toBe(false);
    expect(isGooseReplyResponsePayload('x')).toBe(false);
    expect(isGooseReplyResponsePayload({ role: 'assistant' })).toBe(false);
    expect(isGooseReplyResponsePayload({ content: 'hi' })).toBe(false);
  });
});

describe('createHttpGooseClient', () => {
  it('POSTs the exact GooseReplyRequestPayload shape to {baseUrl}/reply for classifyIntent', async () => {
    const fetchFn = jest.fn(async () => jsonResponse({ role: 'assistant', content: '{"intent":"ticket_lookup"}' }));
    const client = createHttpGooseClient({ baseUrl: 'http://localhost:3284', fetch: fetchFn as never });

    const result = await client.classifyIntent({
      systemPrompt: 'You are the orchestrator',
      userContent: 'classify this',
      sessionId: 'sess_1',
      correlationId: 'corr_1',
    });

    expect(result.raw).toBe('{"intent":"ticket_lookup"}');
    expect(fetchFn).toHaveBeenCalledWith(
      'http://localhost:3284/reply',
      expect.objectContaining({ method: 'POST' })
    );
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      messages: [
        { role: 'system', content: 'You are the orchestrator' },
        { role: 'user', content: 'classify this' },
      ],
      session_id: 'sess_1',
      correlation_id: 'corr_1',
    });
  });

  it('runMinion appends feedback as an extra user turn on a retry', async () => {
    const fetchFn = jest.fn(async () => jsonResponse({ role: 'assistant', content: '{}' }));
    const client = createHttpGooseClient({ baseUrl: 'http://localhost:3284', fetch: fetchFn as never });

    await client.runMinion({
      minionType: 'ticket_analyst',
      systemPrompt: 'sys',
      userContent: 'do the thing',
      sessionId: 'sess_1',
      correlationId: 'corr_1.0',
      minionToken: 'tok_1',
      feedback: ['field "summary" is required'],
    });

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages).toHaveLength(3);
    expect(body.messages[2].content).toContain('field "summary" is required');
  });

  it('runMinion omits the feedback turn when no feedback is given', async () => {
    const fetchFn = jest.fn(async () => jsonResponse({ role: 'assistant', content: '{}' }));
    const client = createHttpGooseClient({ baseUrl: 'http://localhost:3284', fetch: fetchFn as never });

    await client.runMinion({
      minionType: 'ticket_analyst',
      systemPrompt: 'sys',
      userContent: 'do the thing',
      sessionId: 'sess_1',
      correlationId: 'corr_1.0',
      minionToken: 'tok_1',
    });

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages).toHaveLength(2);
  });

  it('runMinion sends the minted minion token as an X-Minion-Token header', async () => {
    const fetchFn = jest.fn(async () => jsonResponse({ role: 'assistant', content: '{}' }));
    const client = createHttpGooseClient({ baseUrl: 'http://localhost:3284', fetch: fetchFn as never });

    await client.runMinion({
      minionType: 'ticket_analyst',
      systemPrompt: 'sys',
      userContent: 'do the thing',
      sessionId: 'sess_1',
      correlationId: 'corr_1.0',
      minionToken: 'tok_abc123',
    });

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Minion-Token']).toBe('tok_abc123');
  });

  it('classifyIntent sends no X-Minion-Token header (no minion is delegated yet)', async () => {
    const fetchFn = jest.fn(async () => jsonResponse({ role: 'assistant', content: '{}' }));
    const client = createHttpGooseClient({ baseUrl: 'http://localhost:3284', fetch: fetchFn as never });

    await client.classifyIntent({ systemPrompt: 's', userContent: 'u', sessionId: 's1', correlationId: 'c1' });

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Minion-Token']).toBeUndefined();
  });

  it('throws a descriptive error when fetch rejects (Goose unreachable)', async () => {
    const fetchFn = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = createHttpGooseClient({ baseUrl: 'http://localhost:3284', fetch: fetchFn as never });

    await expect(
      client.classifyIntent({ systemPrompt: 's', userContent: 'u', sessionId: 's1', correlationId: 'c1' })
    ).rejects.toThrow(/unreachable/);
  });

  it('stringifies a non-Error thrown value when fetch rejects', async () => {
    const fetchFn = jest.fn(async () => {
      // Intentionally a non-Error rejection, to exercise goose-client.ts's
      // `err instanceof Error ? err.message : String(err)` fallback branch.
      throw 'a plain string rejection';
    });
    const client = createHttpGooseClient({ baseUrl: 'http://localhost:3284', fetch: fetchFn as never });

    await expect(
      client.classifyIntent({ systemPrompt: 's', userContent: 'u', sessionId: 's1', correlationId: 'c1' })
    ).rejects.toThrow(/a plain string rejection/);
  });

  it('throws a descriptive error on a non-2xx response', async () => {
    const fetchFn = jest.fn(async () => jsonResponse({ error: 'boom' }, 500));
    const client = createHttpGooseClient({ baseUrl: 'http://localhost:3284', fetch: fetchFn as never });

    await expect(
      client.classifyIntent({ systemPrompt: 's', userContent: 'u', sessionId: 's1', correlationId: 'c1' })
    ).rejects.toThrow(/500/);
  });

  it('throws a descriptive error when the response body does not match the expected shape', async () => {
    const fetchFn = jest.fn(async () => jsonResponse({ unexpected: true }));
    const client = createHttpGooseClient({ baseUrl: 'http://localhost:3284', fetch: fetchFn as never });

    await expect(
      client.classifyIntent({ systemPrompt: 's', userContent: 'u', sessionId: 's1', correlationId: 'c1' })
    ).rejects.toThrow(/unexpected response shape/);
  });

  it('defaults to globalThis.fetch when no fetch override is supplied', async () => {
    const originalFetch = globalThis.fetch;
    const spy = jest.fn(async () => jsonResponse({ role: 'assistant', content: '{}' }));
    // @ts-expect-error -- test-only stub of the global fetch
    globalThis.fetch = spy;
    try {
      const client = createHttpGooseClient({ baseUrl: 'http://localhost:3284' });
      const result = await client.classifyIntent({
        systemPrompt: 's',
        userContent: 'u',
        sessionId: 's1',
        correlationId: 'c1',
      });
      expect(result.raw).toBe('{}');
      expect(spy).toHaveBeenCalledWith('http://localhost:3284/reply', expect.objectContaining({ method: 'POST' }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
