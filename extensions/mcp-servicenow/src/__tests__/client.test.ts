/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest } from '@jest/globals';
import { createServiceNowClient, type ServiceNowClient } from '../client.js';
import { ServiceNowApiError } from '../errors.js';

describe('createServiceNowClient', () => {
  const instance = 'testinstance';
  const username = 'testuser';
  const password = 'testpass';
  let fetchFn: jest.Mock<any>;
  let client: ServiceNowClient;

  beforeEach(() => {
    fetchFn = jest.fn() as jest.Mock<any>;
    client = createServiceNowClient({ instance, username, password, fetchFn });
  });

  it('uses the global fetch when fetchFn is omitted', () => {
    const defaultClient = createServiceNowClient({ instance, username, password });
    expect(defaultClient).toBeDefined();
  });

  function toResponse(response: { ok: boolean; status: number; text: string; headers?: Record<string, string> }) {
    const headerMap = new Map(
      Object.entries(response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    );
    return {
      ok: response.ok,
      status: response.status,
      headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
      text: async () => response.text,
      json: async () => (response.text ? JSON.parse(response.text) : undefined),
    };
  }

  function mockResponse(response: { ok: boolean; status: number; text: string }) {
    fetchFn.mockResolvedValue(toResponse(response));
  }

  it('uses the expected base URL and auth header', async () => {
    mockResponse({ ok: true, status: 200, text: '{}' });
    await client.getIncidentBySysId('abc123');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://testinstance.service-now.com/api/now/table/incident/abc123');
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('testuser:testpass').toString('base64')}`,
      Accept: 'application/json',
    });
  });

  describe('listIncidents', () => {
    it('lists with no filters, paginating via sysparm_offset', async () => {
      mockResponse({ ok: true, status: 200, text: '{"result":[]}' });
      await client.listIncidents();
      const [url] = fetchFn.mock.calls[0] as [string];
      expect(url).toContain('sysparm_offset=0');
      expect(url).toContain('sysparm_limit=100');
    });

    it('lists with limit and state as a single bounded page (no pagination)', async () => {
      mockResponse({ ok: true, status: 200, text: '{"result":[]}' });
      await client.listIncidents(10, '1');
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url] = fetchFn.mock.calls[0] as [string];
      expect(url).toContain('sysparm_limit=10');
      expect(url).toContain('sysparm_query=state%3D1');
      expect(url).not.toContain('sysparm_offset');
    });

    it('lists with only state, paginating', async () => {
      mockResponse({ ok: true, status: 200, text: '{"result":[]}' });
      await client.listIncidents(undefined, '2');
      const [url] = fetchFn.mock.calls[0] as [string];
      expect(url).toContain('sysparm_query=state%3D2');
      expect(url).toContain('sysparm_limit=100');
    });

    it('follows a three-page offset traversal and concatenates results', async () => {
      const fullPage = (start: number) =>
        Array.from({ length: 100 }, (_, i) => ({ sys_id: String(start + i) }));
      fetchFn.mockImplementation(async (url: string) => {
        const u = new URL(url);
        const offset = Number(u.searchParams.get('sysparm_offset') ?? '0');
        if (offset === 0) {
          return toResponse({ ok: true, status: 200, text: JSON.stringify({ result: fullPage(1) }) });
        }
        if (offset === 100) {
          return toResponse({ ok: true, status: 200, text: JSON.stringify({ result: fullPage(101) }) });
        }
        if (offset === 200) {
          return toResponse({ ok: true, status: 200, text: JSON.stringify({ result: [{ sys_id: '301' }] }) });
        }
        return toResponse({ ok: true, status: 200, text: '{"result":[]}' });
      });
      const result = (await client.listIncidents()) as { result: unknown[] };
      expect(result.result).toHaveLength(201);
      expect(fetchFn).toHaveBeenCalledTimes(3);
    });

    it('threads auth headers through every paginated page', async () => {
      mockResponse({ ok: true, status: 200, text: '{"result":[]}' });
      await client.listIncidents();
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(init.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from('testuser:testpass').toString('base64')}`,
      });
    });

    it('halts at the maxItems safety cap', async () => {
      const capped = createServiceNowClient({ instance, username, password, fetchFn, maxItems: 3 });
      fetchFn.mockImplementation(async () =>
        toResponse({ ok: true, status: 200, text: JSON.stringify({ result: [{ sys_id: '1' }, { sys_id: '2' }] }) })
      );
      const result = (await capped.listIncidents()) as { result: unknown[] };
      expect(result.result.length).toBeLessThanOrEqual(3);
    });

    it('treats a malformed page body (missing/non-array result) as an empty page', async () => {
      mockResponse({ ok: true, status: 200, text: '{}' });
      const result = (await client.listIncidents()) as { result: unknown[] };
      expect(result.result).toEqual([]);
    });

    it('surfaces ServiceNowApiError from errors.ts when a page in the traversal fails', async () => {
      mockResponse({ ok: false, status: 500, text: '{"error":"boom"}' });
      const error = await client.listIncidents().catch((e) => e);
      expect(error).toBeInstanceOf(ServiceNowApiError);
      expect(error.status).toBe(500);
    });
  });

  describe('retry/backoff (M8, F13)', () => {
    it('does not retry createIncident (POST) by default on a 503', async () => {
      const retryClient = createServiceNowClient({
        instance,
        username,
        password,
        fetchFn,
        retryPolicy: { sleep: async () => undefined, random: () => 0.5 },
      });
      mockResponse({ ok: false, status: 503, text: '{"error":"unavailable"}' });
      const error = await retryClient.createIncident({ short_description: 'x' }).catch((e) => e);
      expect(error).toBeInstanceOf(ServiceNowApiError);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('honors Retry-After (delta-seconds) on a 429 within the paginated traversal', async () => {
      const sleep = jest.fn(async () => undefined);
      const retryClient = createServiceNowClient({
        instance,
        username,
        password,
        fetchFn,
        retryPolicy: { sleep, random: () => 0.5 },
      });
      fetchFn
        .mockResolvedValueOnce(
          toResponse({ ok: false, status: 429, text: '', headers: { 'Retry-After': '2' } })
        )
        .mockResolvedValue(toResponse({ ok: true, status: 200, text: '{"result":[]}' }));
      await retryClient.listIncidents();
      expect(sleep).toHaveBeenCalledWith(2000);
    });

    it('exhausts retries on a persistent 502 for getIncidentBySysId and surfaces ServiceNowApiError from errors.ts', async () => {
      const retryClient = createServiceNowClient({
        instance,
        username,
        password,
        fetchFn,
        retryPolicy: { maxAttempts: 3, sleep: async () => undefined, random: () => 0 },
      });
      mockResponse({ ok: false, status: 502, text: '{"error":"bad gateway"}' });
      const error = await retryClient.getIncidentBySysId('abc123').catch((e) => e);
      expect(error).toBeInstanceOf(ServiceNowApiError);
      expect(error.status).toBe(502);
      expect(fetchFn).toHaveBeenCalledTimes(3);
    });

    it('retries updateIncident (PUT) on a 503 and eventually succeeds', async () => {
      const retryClient = createServiceNowClient({
        instance,
        username,
        password,
        fetchFn,
        retryPolicy: { sleep: async () => undefined, random: () => 0.5 },
      });
      fetchFn
        .mockResolvedValueOnce(toResponse({ ok: false, status: 503, text: '' }))
        .mockResolvedValueOnce(toResponse({ ok: true, status: 200, text: '{"result":{"sys_id":"abc"}}' }));
      const result = await retryClient.updateIncident('abc', { state: '2' });
      expect(result).toEqual({ result: { sys_id: 'abc' } });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('getIncidentBySysId', () => {
    it('fetches an incident by sys_id', async () => {
      mockResponse({ ok: true, status: 200, text: '{"result":{"sys_id":"abc123"}}' });
      const result = await client.getIncidentBySysId('abc123');
      expect(result).toEqual({ result: { sys_id: 'abc123' } });
    });

    it('URL-encodes the sys_id in the request path', async () => {
      mockResponse({ ok: true, status: 200, text: '{}' });
      await client.getIncidentBySysId('abc 123/xyz');
      const [url] = fetchFn.mock.calls[0] as [string];
      expect(url).toBe('https://testinstance.service-now.com/api/now/table/incident/abc%20123%2Fxyz');
    });
  });

  describe('getIncidentByNumber', () => {
    it('fetches an incident by number and returns the first result', async () => {
      mockResponse({ ok: true, status: 200, text: '{"result":[{"sys_id":"abc123","number":"INC001"}]}' });
      const result = await client.getIncidentByNumber('INC001');
      expect(result).toEqual({ sys_id: 'abc123', number: 'INC001' });
    });

    it('returns the raw response when result array is empty', async () => {
      mockResponse({ ok: true, status: 200, text: '{"result":[]}' });
      const result = await client.getIncidentByNumber('INC999');
      expect(result).toEqual({ result: [] });
    });

    it('handles unexpected response shape gracefully', async () => {
      mockResponse({ ok: true, status: 200, text: '{"result":{}}' });
      const result = await client.getIncidentByNumber('INC001');
      expect(result).toEqual({ result: {} });
    });
  });

  describe('updateIncident', () => {
    it('updates an incident', async () => {
      mockResponse({ ok: true, status: 200, text: '{"result":{"sys_id":"abc123"}}' });
      const result = await client.updateIncident('abc123', { state: '2' });
      expect(result).toEqual({ result: { sys_id: 'abc123' } });
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body as string)).toEqual({ state: '2' });
    });

    it('URL-encodes the sys_id when updating', async () => {
      mockResponse({ ok: true, status: 200, text: '{}' });
      await client.updateIncident('abc 123/xyz', { state: '2' });
      const [url] = fetchFn.mock.calls[0] as [string];
      expect(url).toBe('https://testinstance.service-now.com/api/now/table/incident/abc%20123%2Fxyz');
    });
  });

  describe('createIncident', () => {
    it('creates an incident', async () => {
      mockResponse({ ok: true, status: 201, text: '{"result":{"sys_id":"abc123","number":"INC001"}}' });
      const result = await client.createIncident({ short_description: 'Test incident' });
      expect(result).toEqual({ result: { sys_id: 'abc123', number: 'INC001' } });
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ short_description: 'Test incident' });
    });
  });

  describe('ServiceNowApiError', () => {
    it('uses a default message when none is provided', () => {
      const error = new ServiceNowApiError(500, { message: 'bad' });
      expect(error.message).toBe('ServiceNow API error (500)');
      expect(error.status).toBe(500);
      expect(error.body).toEqual({ message: 'bad' });
    });
  });

  describe('error handling', () => {
    it('throws ServiceNowApiError for non-2xx responses', async () => {
      mockResponse({ ok: false, status: 404, text: '{"error":{"message":"Not found"}}' });
      await expect(client.getIncidentBySysId('abc123')).rejects.toMatchObject({
        status: 404,
        body: { error: { message: 'Not found' } },
      });
    });

    it('throws ServiceNowApiError for non-JSON error bodies', async () => {
      mockResponse({ ok: false, status: 500, text: 'Internal Server Error' });
      const error = await client.getIncidentBySysId('abc123').catch((e) => e);
      expect(error).toBeInstanceOf(ServiceNowApiError);
      expect(error.status).toBe(500);
      expect(error.body).toBe('Internal Server Error');
    });

    it('throws ServiceNowApiError for network failures', async () => {
      fetchFn.mockRejectedValue(new Error('ECONNREFUSED'));
      const error = await client.getIncidentBySysId('abc123').catch((e) => e);
      expect(error).toBeInstanceOf(ServiceNowApiError);
      expect(error.status).toBe(0);
      expect(error.message).toContain('ECONNREFUSED');
    });

    it('throws ServiceNowApiError for non-Error network failures', async () => {
      fetchFn.mockRejectedValue('failure');
      const error = await client.getIncidentBySysId('abc123').catch((e) => e);
      expect(error).toBeInstanceOf(ServiceNowApiError);
      expect(error.message).toContain('failure');
    });

    it('returns undefined for empty response bodies', async () => {
      mockResponse({ ok: true, status: 204, text: '' });
      const result = await client.getIncidentBySysId('abc123');
      expect(result).toBeUndefined();
    });
  });
});
