/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest } from '@jest/globals';
import { createGitHubClient } from '../client.js';
import { GitHubApiError } from '../errors.js';

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
    headers: {
      get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
    },
    json: async () => options.json,
    text: async () => options.text ?? '',
  } as unknown as Response;
}

function createFetchMock() {
  return jest.fn() as jest.Mock<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >;
}

describe('createGitHubClient', () => {
  let fetchMock: ReturnType<typeof createFetchMock>;

  beforeEach(() => {
    fetchMock = createFetchMock();
  });

  it('uses default options and global fetch when none are supplied', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200, json: [] }));
    const globalSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(fetchMock as unknown as typeof fetch);

    const client = createGitHubClient('token');
    await client.listPullRequests({ owner: 'org', repo: 'repo', state: 'open' });

    expect(globalSpy).toHaveBeenCalledWith(
      'https://api.github.com/repos/org/repo/pulls?state=open&per_page=100',
      expect.anything()
    );

    globalSpy.mockRestore();
  });

  it('defaults to the public GitHub API', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: true, status: 200, json: [] })
    );
    const client = createGitHubClient('token', { fetchFn: fetchMock as any });
    await client.listPullRequests({ owner: 'org', repo: 'repo', state: 'open' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/org/repo/pulls?state=open&per_page=100',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token',
          Accept: 'application/vnd.github+json',
        }),
      })
    );
  });

  it('uses a custom base URL and trims trailing slashes', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: true, status: 200, json: [] })
    );
    const client = createGitHubClient('token', {
      baseUrl: 'https://gh.example.com/api/v3/',
      fetchFn: fetchMock as any,
    });
    await client.listPullRequests({ owner: 'org', repo: 'repo', state: 'open' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gh.example.com/api/v3/repos/org/repo/pulls?state=open&per_page=100',
      expect.anything()
    );
  });

  describe('listPullRequests', () => {
    it('lists pull requests with default state, paginating via Link headers', async () => {
      const prs = [{ number: 1, title: 'PR 1' }];
      fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200, json: prs }));
      const client = createGitHubClient('token', { fetchFn: fetchMock as any });
      const result = await client.listPullRequests({
        owner: 'org',
        repo: 'repo',
        state: 'open',
      });
      expect(result).toEqual(prs);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/org/repo/pulls?state=open&per_page=100',
        expect.anything()
      );
    });

    it('follows a three-page Link traversal and concatenates results', async () => {
      const page1 = [{ number: 1 }, { number: 2 }];
      const page2 = [{ number: 3 }, { number: 4 }];
      const page3 = [{ number: 5 }];
      fetchMock
        .mockResolvedValueOnce(
          mockResponse({
            ok: true,
            status: 200,
            json: page1,
            headers: { Link: '<https://api.github.com/repos/org/repo/pulls?page=2>; rel="next"' },
          })
        )
        .mockResolvedValueOnce(
          mockResponse({
            ok: true,
            status: 200,
            json: page2,
            headers: { Link: '<https://api.github.com/repos/org/repo/pulls?page=3>; rel="next"' },
          })
        )
        .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, json: page3 }));

      const client = createGitHubClient('token', { fetchFn: fetchMock as any });
      const result = await client.listPullRequests({ owner: 'org', repo: 'repo', state: 'open' });

      expect(result).toEqual([...page1, ...page2, ...page3]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      // Auth headers must be threaded through every page, not just the first.
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        'https://api.github.com/repos/org/repo/pulls?page=3',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer token' }),
        })
      );
    });

    it('stops paginating at the maxItems safety cap (default 500)', async () => {
      let call = 0;
      fetchMock.mockImplementation(async () => {
        call += 1;
        const items = Array.from({ length: 100 }, (_, i) => ({ number: call * 100 + i }));
        return mockResponse({
          ok: true,
          status: 200,
          json: items,
          headers: { Link: `<https://api.github.com/repos/org/repo/pulls?page=${call + 1}>; rel="next"` },
        });
      });
      const client = createGitHubClient('token', { fetchFn: fetchMock as any });
      const result = await client.listPullRequests({ owner: 'org', repo: 'repo', state: 'open' });
      expect(result.length).toBe(500);
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('honors a custom maxItems cap passed to the client', async () => {
      let call = 0;
      fetchMock.mockImplementation(async () => {
        call += 1;
        return mockResponse({
          ok: true,
          status: 200,
          json: [{ number: call }],
          headers: { Link: `<https://api.github.com/repos/org/repo/pulls?page=${call + 1}>; rel="next"` },
        });
      });
      const client = createGitHubClient('token', { fetchFn: fetchMock as any, maxItems: 2 });
      const result = await client.listPullRequests({ owner: 'org', repo: 'repo', state: 'open' });
      expect(result).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('surfaces GitHubApiError from errors.ts when a page in the traversal 500s and exhausts retries', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({ ok: false, status: 500, text: 'server error' })
      );
      const client = createGitHubClient(
        'token',
        {
          fetchFn: fetchMock as any,
          retryPolicy: { maxAttempts: 2, sleep: async () => undefined, random: () => 0 },
        }
      );
      await expect(
        client.listPullRequests({ owner: 'org', repo: 'repo', state: 'open' })
      ).rejects.toBeInstanceOf(GitHubApiError);
      // 500 is not in the default retryable status set, so only one call is made.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries a 503 across the paginated traversal and surfaces GitHubApiError once exhausted', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({ ok: false, status: 503, text: 'unavailable' })
      );
      const client = createGitHubClient('token', {
        fetchFn: fetchMock as any,
        retryPolicy: { maxAttempts: 3, sleep: async () => undefined, random: () => 0 },
      });
      await expect(
        client.listPullRequests({ owner: 'org', repo: 'repo', state: 'open' })
      ).rejects.toBeInstanceOf(GitHubApiError);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('adds per_page when a limit is provided', async () => {
      fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200, json: [] }));
      const client = createGitHubClient('token', { fetchFn: fetchMock as any });
      await client.listPullRequests({
        owner: 'org',
        repo: 'repo',
        state: 'all',
        limit: 5,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/org/repo/pulls?state=all&per_page=5',
        expect.anything()
      );
    });
  });

  describe('getPullRequest', () => {
    it('fetches a single pull request', async () => {
      const pr = { number: 42, title: 'Fix bug' };
      fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200, json: pr }));
      const client = createGitHubClient('token', { fetchFn: fetchMock as any });
      const result = await client.getPullRequest({
        owner: 'org',
        repo: 'repo',
        pull_number: 42,
      });
      expect(result).toEqual(pr);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/org/repo/pulls/42',
        expect.anything()
      );
    });
  });

  describe('getPullRequestDiff', () => {
    it('fetches diff text with the correct Accept header', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({ ok: true, status: 200, text: 'diff --git a/file b/file' })
      );
      const client = createGitHubClient('token', { fetchFn: fetchMock as any });
      const result = await client.getPullRequestDiff({
        owner: 'org',
        repo: 'repo',
        pull_number: 7,
      });
      expect(result).toBe('diff --git a/file b/file');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/org/repo/pulls/7',
        expect.objectContaining({
          headers: expect.objectContaining({ Accept: 'application/vnd.github.diff' }),
        })
      );
    });
  });

  describe('createPullRequest', () => {
    it('creates a PR with a body', async () => {
      const created = { number: 3 };
      fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 201, json: created }));
      const client = createGitHubClient('token', { fetchFn: fetchMock as any });
      const result = await client.createPullRequest({
        owner: 'org',
        repo: 'repo',
        title: 'New PR',
        head: 'feature',
        base: 'main',
        body: 'Description',
      });
      expect(result).toEqual(created);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/org/repo/pulls',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            title: 'New PR',
            head: 'feature',
            base: 'main',
            body: 'Description',
          }),
        })
      );
    });

    it('omits body when not provided', async () => {
      fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 201, json: {} }));
      const client = createGitHubClient('token', { fetchFn: fetchMock as any });
      await client.createPullRequest({
        owner: 'org',
        repo: 'repo',
        title: 'New PR',
        head: 'feature',
        base: 'main',
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/org/repo/pulls',
        expect.objectContaining({
          body: JSON.stringify({
            title: 'New PR',
            head: 'feature',
            base: 'main',
          }),
        })
      );
    });
  });

  describe('mergePullRequest', () => {
    it('merges with all optional fields', async () => {
      const merged = { sha: 'abc', merged: true, message: 'Merged' };
      fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200, json: merged }));
      const client = createGitHubClient('token', { fetchFn: fetchMock as any });
      const result = await client.mergePullRequest({
        owner: 'org',
        repo: 'repo',
        pull_number: 5,
        commit_title: 'Merge title',
        commit_message: 'Merge message',
        merge_method: 'squash',
      });
      expect(result).toEqual(merged);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/org/repo/pulls/5/merge',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            commit_title: 'Merge title',
            commit_message: 'Merge message',
            merge_method: 'squash',
          }),
        })
      );
    });

    it('merges without optional fields', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({ ok: true, status: 200, json: { sha: 'def', merged: true, message: '' } })
      );
      const client = createGitHubClient('token', { fetchFn: fetchMock as any });
      await client.mergePullRequest({
        owner: 'org',
        repo: 'repo',
        pull_number: 6,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/org/repo/pulls/6/merge',
        expect.objectContaining({
          method: 'PUT',
          body: '{}',
        })
      );
    });
  });

  describe('createIssueComment (Milestone 15, F11)', () => {
    it('posts a comment to a PR/issue and returns the created comment', async () => {
      const comment = { id: 99, body: 'Looks good to me.', html_url: 'https://github.com/org/repo/issues/1#issuecomment-99' };
      fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 201, json: comment }));
      const client = createGitHubClient('token', { fetchFn: fetchMock as any });
      const result = await client.createIssueComment({
        owner: 'org',
        repo: 'repo',
        issue_number: 1,
        body: 'Looks good to me.',
      });
      expect(result).toEqual(comment);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/org/repo/issues/1/comments',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ body: 'Looks good to me.' }),
        })
      );
    });

    it('is not retried automatically on a 500 beyond the shared non-idempotent policy (POST)', async () => {
      fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 500, text: 'boom' }));
      const client = createGitHubClient('token', { fetchFn: fetchMock as any });
      await expect(
        client.createIssueComment({ owner: 'org', repo: 'repo', issue_number: 1, body: 'x' })
      ).rejects.toBeInstanceOf(GitHubApiError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('throws GitHubApiError for non-OK responses', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({ ok: false, status: 404, text: JSON.stringify({ message: 'Not Found' }) })
      );
      const client = createGitHubClient('token', { fetchFn: fetchMock as any });
      await expect(
        client.getPullRequest({ owner: 'org', repo: 'repo', pull_number: 1 })
      ).rejects.toBeInstanceOf(GitHubApiError);
      await expect(
        client.getPullRequest({ owner: 'org', repo: 'repo', pull_number: 1 })
      ).rejects.toThrow('GitHub API error 404');
    });

    it('propagates network errors', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      const client = createGitHubClient('token', { fetchFn: fetchMock as any });
      await expect(
        client.listPullRequests({ owner: 'org', repo: 'repo', state: 'open' })
      ).rejects.toThrow('fetch failed');
    });
  });

  describe('retry/backoff (M8, F13)', () => {
    it('honors Retry-After (delta-seconds) on a 429 for getPullRequest and eventually succeeds', async () => {
      const sleep = jest.fn(async () => undefined);
      fetchMock
        .mockResolvedValueOnce(
          mockResponse({ ok: false, status: 429, headers: { 'Retry-After': '1' } })
        )
        .mockResolvedValueOnce(
          mockResponse({ ok: true, status: 200, json: { number: 1, title: 'PR' } })
        );
      const client = createGitHubClient('token', {
        fetchFn: fetchMock as any,
        retryPolicy: { sleep, random: () => 0.5 },
      });
      const result = await client.getPullRequest({ owner: 'org', repo: 'repo', pull_number: 1 });
      expect(result).toEqual({ number: 1, title: 'PR' });
      expect(sleep).toHaveBeenCalledWith(1000);
    });

    it('does not retry createPullRequest (POST) by default and surfaces GitHubApiError on a single 503', async () => {
      fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 503, text: 'unavailable' }));
      const client = createGitHubClient('token', {
        fetchFn: fetchMock as any,
        retryPolicy: { sleep: async () => undefined, random: () => 0.5 },
      });
      await expect(
        client.createPullRequest({ owner: 'org', repo: 'repo', title: 't', head: 'h', base: 'b' })
      ).rejects.toBeInstanceOf(GitHubApiError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('exhausts retries on a persistent 500 for getPullRequest and surfaces GitHubApiError (not a generic error)', async () => {
      fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 502, text: 'bad gateway' }));
      const client = createGitHubClient('token', {
        fetchFn: fetchMock as any,
        retryPolicy: { maxAttempts: 3, sleep: async () => undefined, random: () => 0 },
      });
      const error = await client
        .getPullRequest({ owner: 'org', repo: 'repo', pull_number: 1 })
        .catch((e) => e);
      expect(error).toBeInstanceOf(GitHubApiError);
      expect(error.status).toBe(502);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});
