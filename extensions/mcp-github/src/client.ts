import { fetchWithRetry, paginateGitHub, type RetryPolicy } from 'framework-core';
import { GitHubApiError } from './errors.js';
import type {
  CreateIssueCommentInput,
  CreatePullRequestInput,
  IssueComment,
  ListPullRequestsInput,
  MergePullRequestInput,
  MergeResult,
  PullNumberInput,
  PullRequest,
  PullRequestSummary,
} from './types.js';

/** Safety cap on total items collected across paginated list endpoints. */
const DEFAULT_MAX_ITEMS = 500;
/** Page size requested per call when paginating (GitHub's max is 100). */
const PAGE_SIZE = 100;

export interface GitHubClient {
  listPullRequests(input: ListPullRequestsInput): Promise<PullRequestSummary[]>;
  getPullRequest(input: PullNumberInput): Promise<PullRequest>;
  getPullRequestDiff(input: PullNumberInput): Promise<string>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  mergePullRequest(input: MergePullRequestInput): Promise<MergeResult>;
  createIssueComment(input: CreateIssueCommentInput): Promise<IssueComment>;
}

export interface GitHubClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  /** Retry/backoff policy applied to every request. Defaults per `http-retry.ts`. */
  retryPolicy?: RetryPolicy;
  /** Safety cap on items returned by paginated list endpoints. Default 500. */
  maxItems?: number;
}

export function createGitHubClient(
  token: string,
  options: GitHubClientOptions = {}
): GitHubClient {
  const baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/u, '');
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const retryPolicy = options.retryPolicy ?? {};
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;

  const defaultHeaders: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mcp-github',
  };

  function buildUrl(path: string, params?: Record<string, string | number>): string {
    const query = params
      ? `?${new URLSearchParams(
          Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]))
        ).toString()}`
      : '';
    return `${baseUrl}${path}${query}`;
  }

  async function raiseForStatus(response: Response): Promise<never> {
    const text = await response.text();
    throw new GitHubApiError(`GitHub API error ${response.status}: ${text}`, response.status, text);
  }

  async function request(
    path: string,
    init: RequestInit & { params?: Record<string, string | number> }
  ): Promise<Response> {
    const url = buildUrl(path, init.params);

    const response = await fetchWithRetry(
      fetchFn,
      url,
      {
        ...init,
        headers: {
          ...defaultHeaders,
          ...(init.headers ?? {}),
        },
      },
      retryPolicy
    );

    if (!response.ok) {
      await raiseForStatus(response);
    }

    return response;
  }

  return {
    async listPullRequests(input): Promise<PullRequestSummary[]> {
      // An explicit limit is a caller-bounded single page (preserves prior behavior);
      // otherwise page through the full result set via Link headers up to maxItems.
      if (input.limit !== undefined) {
        const response = await request(`/repos/${input.owner}/${input.repo}/pulls`, {
          params: { state: input.state, per_page: input.limit },
        });
        return (await response.json()) as PullRequestSummary[];
      }

      const firstUrl = buildUrl(`/repos/${input.owner}/${input.repo}/pulls`, {
        state: input.state,
        per_page: PAGE_SIZE,
      });
      return paginateGitHub<PullRequestSummary>(fetchFn, firstUrl, {
        ...retryPolicy,
        maxItems,
        onError: raiseForStatus,
        init: { headers: defaultHeaders },
      });
    },

    async getPullRequest(input): Promise<PullRequest> {
      const response = await request(
        `/repos/${input.owner}/${input.repo}/pulls/${input.pull_number}`,
        {}
      );
      return (await response.json()) as PullRequest;
    },

    async getPullRequestDiff(input): Promise<string> {
      const response = await request(
        `/repos/${input.owner}/${input.repo}/pulls/${input.pull_number}`,
        {
          headers: { Accept: 'application/vnd.github.diff' },
        }
      );
      return response.text();
    },

    async createPullRequest(input): Promise<PullRequest> {
      const body: Record<string, unknown> = {
        title: input.title,
        head: input.head,
        base: input.base,
      };
      if (input.body !== undefined) {
        body.body = input.body;
      }
      const response = await request(`/repos/${input.owner}/${input.repo}/pulls`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return (await response.json()) as PullRequest;
    },

    async mergePullRequest(input): Promise<MergeResult> {
      const body: Record<string, unknown> = {};
      if (input.commit_title !== undefined) {
        body.commit_title = input.commit_title;
      }
      if (input.commit_message !== undefined) {
        body.commit_message = input.commit_message;
      }
      if (input.merge_method !== undefined) {
        body.merge_method = input.merge_method;
      }
      const response = await request(
        `/repos/${input.owner}/${input.repo}/pulls/${input.pull_number}/merge`,
        {
          method: 'PUT',
          body: JSON.stringify(body),
        }
      );
      return (await response.json()) as MergeResult;
    },

    async createIssueComment(input): Promise<IssueComment> {
      const response = await request(`/repos/${input.owner}/${input.repo}/issues/${input.issue_number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: input.body }),
      });
      return (await response.json()) as IssueComment;
    },
  };
}
