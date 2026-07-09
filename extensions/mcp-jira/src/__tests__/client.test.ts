/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest } from '@jest/globals';
import { createJiraClient } from '../client.js';
import { JiraApiError } from '../errors.js';

function mockResponse(options: {
  ok: boolean;
  status: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}): Response {
  const headerMap = new Map(
    Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    ok: options.ok,
    status: options.status,
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
    json: async () => options.json,
    text: async () => options.text ?? '',
  } as unknown as Response;
}

function createFetchMock() {
  return jest.fn() as jest.Mock<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >;
}

describe('createJiraClient', () => {
  let fetchMock: ReturnType<typeof createFetchMock>;

  beforeEach(() => {
    fetchMock = createFetchMock();
  });

  const options = {
    host: 'jira.example.com',
    email: 'user@example.com',
    apiToken: 'token',
  };

  function authHeader(): string {
    return `Basic ${Buffer.from('user@example.com:token').toString('base64')}`;
  }

  it('uses global fetch when fetchFn is not supplied', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: true, status: 200, json: { issues: [] } })
    );
    const globalSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(fetchMock as unknown as typeof fetch);

    const client = createJiraClient(options);
    await client.listIssues({ projectKey: 'PROJ' });

    expect(globalSpy).toHaveBeenCalledWith(
      'https://jira.example.com/rest/api/2/search?jql=project%3DPROJ&maxResults=100&startAt=0',
      expect.anything()
    );

    globalSpy.mockRestore();
  });

  it('trims trailing slashes from host', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: true, status: 200, json: { issues: [] } })
    );
    const client = createJiraClient({ ...options, host: 'jira.example.com/', fetchFn: fetchMock as any });
    await client.listIssues({ projectKey: 'PROJ' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://jira.example.com/rest/api/2/search?jql=project%3DPROJ&maxResults=100&startAt=0',
      expect.anything()
    );
  });

  describe('listIssues', () => {
    it('lists issues without status or limit, paginating via startAt/maxResults', async () => {
      const issues = [{ key: 'PROJ-1' }];
      fetchMock.mockResolvedValue(
        mockResponse({ ok: true, status: 200, json: { issues } })
      );
      const client = createJiraClient({ ...options, fetchFn: fetchMock as any });
      const result = await client.listIssues({ projectKey: 'PROJ' });
      expect(result).toEqual(issues);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://jira.example.com/rest/api/2/search?jql=project%3DPROJ&maxResults=100&startAt=0',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: authHeader(),
            Accept: 'application/json',
          }),
        })
      );
    });

    it('follows a three-page offset traversal and concatenates results', async () => {
      const fullPage = (start: number) =>
        Array.from({ length: 100 }, (_, i) => ({ key: `PROJ-${start + i}` }));
      fetchMock.mockImplementation(async (url: string) => {
        const u = new URL(url as string);
        const startAt = Number(u.searchParams.get('startAt') ?? '0');
        if (startAt === 0) {
          return mockResponse({ ok: true, status: 200, json: { issues: fullPage(1) } });
        }
        if (startAt === 100) {
          return mockResponse({ ok: true, status: 200, json: { issues: fullPage(101) } });
        }
        if (startAt === 200) {
          return mockResponse({ ok: true, status: 200, json: { issues: [{ key: 'PROJ-301' }] } });
        }
        return mockResponse({ ok: true, status: 200, json: { issues: [] } });
      });
      const client = createJiraClient({ ...options, fetchFn: fetchMock as any });
      const result = await client.listIssues({ projectKey: 'PROJ' });
      expect(result).toHaveLength(201);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('halts at the maxItems safety cap', async () => {
      fetchMock.mockImplementation(async () =>
        mockResponse({ ok: true, status: 200, json: { issues: [{ key: 'A' }, { key: 'B' }] } })
      );
      const client = createJiraClient({ ...options, fetchFn: fetchMock as any, maxItems: 3 });
      const result = await client.listIssues({ projectKey: 'PROJ' });
      expect(result.length).toBeLessThanOrEqual(3);
    });

    it('treats a malformed page body (missing/non-array issues) as an empty page', async () => {
      fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200, json: {} }));
      const client = createJiraClient({ ...options, fetchFn: fetchMock as any });
      const result = await client.listIssues({ projectKey: 'PROJ' });
      expect(result).toEqual([]);
    });

    it('surfaces JiraApiError from errors.ts when a page in the traversal fails', async () => {
      fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 500, text: 'boom' }));
      const client = createJiraClient({ ...options, fetchFn: fetchMock as any });
      await expect(client.listIssues({ projectKey: 'PROJ' })).rejects.toBeInstanceOf(JiraApiError);
    });

    it('filters by status and applies limit', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({ ok: true, status: 200, json: { issues: [] } })
      );
      const client = createJiraClient({ ...options, fetchFn: fetchMock as any });
      await client.listIssues({ projectKey: 'PROJ', status: 'Open', limit: 10 });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://jira.example.com/rest/api/2/search?jql=project%3DPROJ+AND+status%3DOpen&maxResults=10',
        expect.anything()
      );
    });

    it('applies limit without status', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({ ok: true, status: 200, json: { issues: [] } })
      );
      const client = createJiraClient({ ...options, fetchFn: fetchMock as any });
      await client.listIssues({ projectKey: 'PROJ', limit: 5 });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://jira.example.com/rest/api/2/search?jql=project%3DPROJ&maxResults=5',
        expect.anything()
      );
    });

    it('filters by status without limit, paginating', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({ ok: true, status: 200, json: { issues: [] } })
      );
      const client = createJiraClient({ ...options, fetchFn: fetchMock as any });
      await client.listIssues({ projectKey: 'PROJ', status: 'Closed' });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://jira.example.com/rest/api/2/search?jql=project%3DPROJ+AND+status%3DClosed&maxResults=100&startAt=0',
        expect.anything()
      );
    });
  });

  describe('getIssue', () => {
    it('fetches an issue by key', async () => {
      const issue = { key: 'PROJ-2' };
      fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200, json: issue }));
      const client = createJiraClient({ ...options, fetchFn: fetchMock as any });
      const result = await client.getIssue({ issueKey: 'PROJ-2' });
      expect(result).toEqual(issue);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://jira.example.com/rest/api/2/issue/PROJ-2',
        expect.anything()
      );
    });
  });

  describe('updateIssue', () => {
    it('updates issue fields', async () => {
      fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 204 }));
      const client = createJiraClient({ ...options, fetchFn: fetchMock as any });
      await client.updateIssue({ issueKey: 'PROJ-3', fields: { summary: 'Updated' } });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://jira.example.com/rest/api/2/issue/PROJ-3',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ fields: { summary: 'Updated' } }),
        })
      );
    });
  });

  describe('createIssue', () => {
    it('creates an issue with description', async () => {
      const issue = { key: 'PROJ-4' };
      fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 201, json: issue }));
      const client = createJiraClient({ ...options, fetchFn: fetchMock as any });
      const result = await client.createIssue({
        projectKey: 'PROJ',
        summary: 'New issue',
        description: 'Details',
        issueType: 'Bug',
      });
      expect(result).toEqual(issue);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://jira.example.com/rest/api/2/issue',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            fields: {
              project: { key: 'PROJ' },
              summary: 'New issue',
              issuetype: { name: 'Bug' },
              description: 'Details',
            },
          }),
        })
      );
    });

    it('creates an issue with default type and no description', async () => {
      fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 201, json: { key: 'PROJ-5' } }));
      const client = createJiraClient({ ...options, fetchFn: fetchMock as any });
      await client.createIssue({ projectKey: 'PROJ', summary: 'Minimal' });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://jira.example.com/rest/api/2/issue',
        expect.objectContaining({
          body: JSON.stringify({
            fields: {
              project: { key: 'PROJ' },
              summary: 'Minimal',
              issuetype: { name: 'Task' },
            },
          }),
        })
      );
    });
  });

  describe('addComment', () => {
    it('adds a comment to an issue', async () => {
      const comment = { id: '100' };
      fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 201, json: comment }));
      const client = createJiraClient({ ...options, fetchFn: fetchMock as any });
      const result = await client.addComment({ issueKey: 'PROJ-6', body: 'hello' });
      expect(result).toEqual(comment);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://jira.example.com/rest/api/2/issue/PROJ-6/comment',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ body: 'hello' }),
        })
      );
    });
  });

  describe('error handling', () => {
    it('throws JiraApiError for non-OK responses', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({ ok: false, status: 404, text: JSON.stringify({ errorMessages: ['Issue not found'] }) })
      );
      const client = createJiraClient({ ...options, fetchFn: fetchMock as any });
      await expect(client.getIssue({ issueKey: 'MISSING' })).rejects.toBeInstanceOf(JiraApiError);
      await expect(client.getIssue({ issueKey: 'MISSING' })).rejects.toThrow('Jira API error 404');
    });

    it('propagates network errors', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      const client = createJiraClient({ ...options, fetchFn: fetchMock as any });
      await expect(client.listIssues({ projectKey: 'PROJ' })).rejects.toThrow('fetch failed');
    });
  });

  describe('retry/backoff (M8, F13)', () => {
    it('honors Retry-After (delta-seconds) on a 429 within the paginated traversal', async () => {
      const sleep = jest.fn(async () => undefined);
      fetchMock
        .mockResolvedValueOnce(
          mockResponse({ ok: false, status: 429, headers: { 'Retry-After': '2' } })
        )
        .mockResolvedValue(mockResponse({ ok: true, status: 200, json: { issues: [] } }));
      const client = createJiraClient({
        ...options,
        fetchFn: fetchMock as any,
        retryPolicy: { sleep, random: () => 0.5 },
      });
      await client.listIssues({ projectKey: 'PROJ' });
      expect(sleep).toHaveBeenCalledWith(2000);
    });

    it('does not retry createIssue (POST) by default on a 503', async () => {
      fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 503, text: 'unavailable' }));
      const client = createJiraClient({
        ...options,
        fetchFn: fetchMock as any,
        retryPolicy: { sleep: async () => undefined, random: () => 0.5 },
      });
      await expect(
        client.createIssue({ projectKey: 'PROJ', summary: 'x' })
      ).rejects.toBeInstanceOf(JiraApiError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('exhausts retries on a persistent 502 for getIssue and surfaces JiraApiError from errors.ts', async () => {
      fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 502, text: 'bad gateway' }));
      const client = createJiraClient({
        ...options,
        fetchFn: fetchMock as any,
        retryPolicy: { maxAttempts: 3, sleep: async () => undefined, random: () => 0 },
      });
      const error = await client.getIssue({ issueKey: 'PROJ-1' }).catch((e) => e);
      expect(error).toBeInstanceOf(JiraApiError);
      expect(error.status).toBe(502);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('retries updateIssue (PUT) on a 503 and eventually succeeds', async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse({ ok: false, status: 503 }))
        .mockResolvedValueOnce(mockResponse({ ok: true, status: 204 }));
      const client = createJiraClient({
        ...options,
        fetchFn: fetchMock as any,
        retryPolicy: { sleep: async () => undefined, random: () => 0.5 },
      });
      await client.updateIssue({ issueKey: 'PROJ-3', fields: { summary: 'x' } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
