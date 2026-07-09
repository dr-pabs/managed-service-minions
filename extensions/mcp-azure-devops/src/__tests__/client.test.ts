/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest } from '@jest/globals';
import { createAzureDevOpsClient, type AzureDevOpsClient } from '../client.js';
import { AzureDevOpsApiError } from '../errors.js';

describe('createAzureDevOpsClient', () => {
  const org = 'testorg';
  const project = 'testproject';
  const token = 'testtoken';
  let fetchFn: jest.Mock<any>;
  let client: AzureDevOpsClient;

  beforeEach(() => {
    fetchFn = jest.fn() as jest.Mock<any>;
    client = createAzureDevOpsClient({ org, project, token, fetchFn });
  });

  it('uses the global fetch when fetchFn is omitted', () => {
    const defaultClient = createAzureDevOpsClient({ org, project, token });
    expect(defaultClient).toBeDefined();
  });

  function toResponse(response: { ok: boolean; status: number; text: string }) {
    return {
      ok: response.ok,
      status: response.status,
      headers: { get: () => null },
      text: async () => response.text,
      json: async () => (response.text ? JSON.parse(response.text) : undefined),
    };
  }

  function mockResponse(response: { ok: boolean; status: number; text: string }) {
    fetchFn.mockResolvedValue(toResponse(response));
  }

  it('uses the expected base URL and auth header', async () => {
    mockResponse({ ok: true, status: 200, text: '{}' });
    await client.getWorkItem(123);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://dev.azure.com/testorg/testproject/_apis/wit/workitems/123?api-version=7.1'
    );
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from(':testtoken').toString('base64')}`,
      Accept: 'application/json',
    });
  });

  describe('listPullRequests', () => {
    it('lists with default active status, paginating via $skip/$top', async () => {
      mockResponse({ ok: true, status: 200, text: '{"value":[]}' });
      await client.listPullRequests('repo-1');
      const [url] = fetchFn.mock.calls[0] as [string];
      expect(url).toContain('searchCriteria.status=active');
      expect(url).toContain('api-version=7.1');
      expect(url).toContain('%24top=100');
      expect(url).toContain('%24skip=0');
    });

    it('lists with explicit status and top as a single bounded page (no pagination)', async () => {
      mockResponse({ ok: true, status: 200, text: '{"value":[]}' });
      await client.listPullRequests('repo-1', 'completed', 10);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url] = fetchFn.mock.calls[0] as [string];
      expect(url).toContain('searchCriteria.status=completed');
      expect(url).toContain('%24top=10');
      expect(url).not.toContain('%24skip');
    });

    it('follows a three-page offset traversal and concatenates results', async () => {
      // Each page must be exactly PAGE_SIZE (100) items to trigger a next page; the final
      // (partial) page ends the traversal.
      const fullPage = (start: number) =>
        Array.from({ length: 100 }, (_, i) => ({ pullRequestId: start + i }));

      fetchFn.mockImplementation(async (url: string) => {
        const u = new URL(url);
        const skip = Number(u.searchParams.get('$skip') ?? '0');
        if (skip === 0) {
          return toResponse({ ok: true, status: 200, text: JSON.stringify({ value: fullPage(1) }) });
        }
        if (skip === 100) {
          return toResponse({ ok: true, status: 200, text: JSON.stringify({ value: fullPage(101) }) });
        }
        if (skip === 200) {
          return toResponse({ ok: true, status: 200, text: JSON.stringify({ value: [{ pullRequestId: 301 }] }) });
        }
        return toResponse({ ok: true, status: 200, text: '{"value":[]}' });
      });
      const result = (await client.listPullRequests('repo-1')) as { value: unknown[]; count: number };
      expect(result.value).toHaveLength(201);
      expect(result.count).toBe(201);
      expect((result.value[0] as { pullRequestId: number }).pullRequestId).toBe(1);
      expect((result.value[200] as { pullRequestId: number }).pullRequestId).toBe(301);
      expect(fetchFn).toHaveBeenCalledTimes(3);
    });

    it('treats a malformed page body (missing/non-array value) as an empty page', async () => {
      fetchFn.mockResolvedValue(toResponse({ ok: true, status: 200, text: '{}' }));
      const result = (await client.listPullRequests('repo-1')) as { value: unknown[]; count: number };
      expect(result.value).toEqual([]);
      expect(result.count).toBe(0);
    });

    it('threads auth headers through every paginated page', async () => {
      fetchFn.mockResolvedValue(toResponse({ ok: true, status: 200, text: '{"value":[]}' }));
      await client.listPullRequests('repo-1');
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(init.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from(':testtoken').toString('base64')}`,
      });
    });

    it('halts at the maxItems safety cap', async () => {
      const capped = createAzureDevOpsClient({ org, project, token, fetchFn, maxItems: 3 });
      fetchFn.mockImplementation(async () =>
        toResponse({
          ok: true,
          status: 200,
          text: JSON.stringify({ value: [{ pullRequestId: 1 }, { pullRequestId: 2 }] }),
        })
      );
      const result = (await capped.listPullRequests('repo-1')) as { value: unknown[] };
      expect(result.value.length).toBeLessThanOrEqual(3);
    });

    it('exhausts retries on a persistent 503 and surfaces AzureDevOpsApiError from errors.ts', async () => {
      const retryClient = createAzureDevOpsClient({
        org,
        project,
        token,
        fetchFn,
        retryPolicy: { maxAttempts: 3, sleep: async () => undefined, random: () => 0 },
      });
      fetchFn.mockResolvedValue(toResponse({ ok: false, status: 503, text: '{"message":"unavailable"}' }));
      const error = await retryClient.listPullRequests('repo-1').catch((e) => e);
      expect(error).toBeInstanceOf(AzureDevOpsApiError);
      expect(error.status).toBe(503);
      expect(fetchFn).toHaveBeenCalledTimes(3);
    });

    it('honors Retry-After (delta-seconds) on a 429 within the paginated traversal', async () => {
      const sleep = jest.fn(async () => undefined);
      const retryClient = createAzureDevOpsClient({
        org,
        project,
        token,
        fetchFn,
        retryPolicy: { sleep, random: () => 0.5 },
      });
      fetchFn
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '2' : null) },
          text: async () => '',
        })
        .mockResolvedValue(toResponse({ ok: true, status: 200, text: '{"value":[]}' }));
      await retryClient.listPullRequests('repo-1');
      expect(sleep).toHaveBeenCalledWith(2000);
    });
  });

  describe('getPullRequest', () => {
    it('fetches a pull request', async () => {
      mockResponse({ ok: true, status: 200, text: '{"pullRequestId":42}' });
      const result = await client.getPullRequest('repo-1', 42);
      expect(result).toEqual({ pullRequestId: 42 });
      const [url] = fetchFn.mock.calls[0] as [string];
      expect(url).toContain('/pullrequests/42?');
    });
  });

  describe('getPullRequestDiff', () => {
    it('fetches a diff', async () => {
      mockResponse({ ok: true, status: 200, text: '{"changes":[]}' });
      const result = await client.getPullRequestDiff('repo-1', 42);
      expect(result).toEqual({ changes: [] });
      const [url] = fetchFn.mock.calls[0] as [string];
      expect(url).toContain('/pullrequests/42/diff?');
    });
  });

  describe('createPullRequest', () => {
    it('creates without description', async () => {
      mockResponse({ ok: true, status: 200, text: '{"pullRequestId":99}' });
      const result = await client.createPullRequest(
        'repo-1',
        'Fix bug',
        'refs/heads/feature',
        'refs/heads/main'
      );
      expect(result).toEqual({ pullRequestId: 99 });
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual({
        title: 'Fix bug',
        sourceRefName: 'refs/heads/feature',
        targetRefName: 'refs/heads/main',
      });
      expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    });

    it('creates with description', async () => {
      mockResponse({ ok: true, status: 200, text: '{"pullRequestId":99}' });
      await client.createPullRequest(
        'repo-1',
        'Fix bug',
        'refs/heads/feature',
        'refs/heads/main',
        'Detailed description'
      );
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toMatchObject({
        description: 'Detailed description',
      });
    });
  });

  describe('mergePullRequest', () => {
    it('completes without comment', async () => {
      mockResponse({ ok: true, status: 200, text: '{"status":"completed"}' });
      const result = await client.mergePullRequest('repo-1', 42);
      expect(result).toEqual({ status: 'completed' });
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual({ status: 'completed' });
      expect(init.method).toBe('PATCH');
    });

    it('completes with comment', async () => {
      mockResponse({ ok: true, status: 200, text: '{"status":"completed"}' });
      await client.mergePullRequest('repo-1', 42, 'Merging now');
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual({
        status: 'completed',
        completionOptions: { mergeCommitMessage: 'Merging now' },
      });
    });
  });

  describe('listWorkItems', () => {
    it('queries by ids', async () => {
      mockResponse({ ok: true, status: 200, text: '{"value":[]}' });
      await client.listWorkItems(undefined, [1, 2, 3]);
      const [url] = fetchFn.mock.calls[0] as [string];
      expect(url).toContain('ids=1%2C2%2C3');
      expect(url).toContain('api-version=7.1');
    });

    it('queries by wiql', async () => {
      mockResponse({ ok: true, status: 200, text: '{"workItems":[]}' });
      await client.listWorkItems('SELECT [System.Id] FROM workitems');
      const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/wiql?');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({
        query: 'SELECT [System.Id] FROM workitems',
      });
    });

    it('throws when neither ids nor wiql are provided', async () => {
      await expect(client.listWorkItems()).rejects.toThrow(AzureDevOpsApiError);
    });
  });

  describe('getWorkItem', () => {
    it('fetches a work item', async () => {
      mockResponse({ ok: true, status: 200, text: '{"id":123}' });
      const result = await client.getWorkItem(123);
      expect(result).toEqual({ id: 123 });
    });
  });

  describe('updateWorkItem', () => {
    it('patches fields', async () => {
      mockResponse({ ok: true, status: 200, text: '{"id":123}' });
      const result = await client.updateWorkItem(123, { 'System.Title': 'New title' });
      expect(result).toEqual({ id: 123 });
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual([
        { op: 'add', path: '/fields/System.Title', value: 'New title' },
      ]);
      expect(init.headers).toMatchObject({ 'Content-Type': 'application/json-patch+json' });
    });
  });

  describe('AzureDevOpsApiError', () => {
    it('uses a default message when none is provided', () => {
      const error = new AzureDevOpsApiError(500, { message: 'bad' });
      expect(error.message).toBe('Azure DevOps API error (500)');
      expect(error.status).toBe(500);
      expect(error.body).toEqual({ message: 'bad' });
    });
  });

  describe('error handling', () => {
    it('throws AzureDevOpsApiError for non-2xx responses', async () => {
      mockResponse({ ok: false, status: 404, text: '{"message":"Not found"}' });
      await expect(client.getWorkItem(123)).rejects.toMatchObject({
        status: 404,
        body: { message: 'Not found' },
      });
    });

    it('throws AzureDevOpsApiError for non-JSON error bodies', async () => {
      mockResponse({ ok: false, status: 500, text: 'Internal Server Error' });
      const error = await client.getWorkItem(123).catch((e) => e);
      expect(error).toBeInstanceOf(AzureDevOpsApiError);
      expect(error.status).toBe(500);
      expect(error.body).toBe('Internal Server Error');
    });

    it('throws AzureDevOpsApiError for network failures', async () => {
      fetchFn.mockRejectedValue(new Error('ECONNREFUSED'));
      const error = await client.getWorkItem(123).catch((e) => e);
      expect(error).toBeInstanceOf(AzureDevOpsApiError);
      expect(error.status).toBe(0);
      expect(error.message).toContain('ECONNREFUSED');
    });

    it('throws AzureDevOpsApiError for non-Error network failures', async () => {
      fetchFn.mockRejectedValue('failure');
      const error = await client.getWorkItem(123).catch((e) => e);
      expect(error).toBeInstanceOf(AzureDevOpsApiError);
      expect(error.message).toContain('failure');
    });

    it('returns undefined for empty response bodies', async () => {
      mockResponse({ ok: true, status: 204, text: '' });
      const result = await client.getWorkItem(123);
      expect(result).toBeUndefined();
    });
  });

  describe('retry/backoff (M8, F13)', () => {
    it('does not retry createPullRequest (POST) by default on a 503', async () => {
      const retryClient = createAzureDevOpsClient({
        org,
        project,
        token,
        fetchFn,
        retryPolicy: { sleep: async () => undefined, random: () => 0.5 },
      });
      mockResponse({ ok: false, status: 503, text: '{"message":"unavailable"}' });
      const error = await retryClient
        .createPullRequest('repo-1', 'Fix', 'refs/heads/f', 'refs/heads/main')
        .catch((e) => e);
      expect(error).toBeInstanceOf(AzureDevOpsApiError);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('retries getWorkItem (GET) on a 502 and eventually succeeds', async () => {
      const retryClient = createAzureDevOpsClient({
        org,
        project,
        token,
        fetchFn,
        retryPolicy: { sleep: async () => undefined, random: () => 0.5 },
      });
      fetchFn
        .mockResolvedValueOnce(toResponse({ ok: false, status: 502, text: '' }))
        .mockResolvedValueOnce(toResponse({ ok: true, status: 200, text: '{"id":123}' }));
      const result = await retryClient.getWorkItem(123);
      expect(result).toEqual({ id: 123 });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });
  });
});
