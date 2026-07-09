import { fetchWithRetry, paginateByParam, type RetryPolicy } from 'framework-core';
import { JiraApiError } from './errors.js';
import type {
  AddCommentInput,
  CreateIssueInput,
  IssueKeyInput,
  JiraComment,
  JiraIssue,
  ListIssuesInput,
  UpdateIssueInput,
} from './types.js';

/** Safety cap on total items collected across paginated list endpoints. */
const DEFAULT_MAX_ITEMS = 500;
/** Page size requested per call when paginating. */
const PAGE_SIZE = 100;

export interface JiraClient {
  listIssues(input: ListIssuesInput): Promise<JiraIssue[]>;
  getIssue(input: IssueKeyInput): Promise<JiraIssue>;
  updateIssue(input: UpdateIssueInput): Promise<void>;
  createIssue(input: CreateIssueInput): Promise<JiraIssue>;
  addComment(input: AddCommentInput): Promise<JiraComment>;
}

export interface JiraClientOptions {
  host: string;
  email: string;
  apiToken: string;
  fetchFn?: typeof fetch;
  /** Retry/backoff policy applied to every request. Defaults per `http-retry.ts`. */
  retryPolicy?: RetryPolicy;
  /** Safety cap on items returned by paginated list endpoints. Default 500. */
  maxItems?: number;
}

export function createJiraClient(options: JiraClientOptions): JiraClient {
  const host = options.host.replace(/\/+$/u, '');
  const baseUrl = `https://${host}/rest/api/2`;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const auth = Buffer.from(`${options.email}:${options.apiToken}`).toString('base64');
  const retryPolicy = options.retryPolicy ?? {};
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;

  const defaultHeaders: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/json',
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
    throw new JiraApiError(`Jira API error ${response.status}: ${text}`, response.status, text);
  }

  async function request(
    path: string,
    init: RequestInit & { params?: Record<string, string | number> } = {}
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
    async listIssues(input): Promise<JiraIssue[]> {
      const jql = input.status
        ? `project=${input.projectKey} AND status=${input.status}`
        : `project=${input.projectKey}`;

      // An explicit limit is a caller-bounded single page (preserves prior behavior);
      // otherwise page through the full result set via startAt/maxResults up to maxItems.
      if (input.limit !== undefined) {
        const response = await request('/search', {
          params: { jql, maxResults: input.limit },
        });
        const body = (await response.json()) as { issues: JiraIssue[] };
        return body.issues;
      }

      const firstUrl = buildUrl('/search', { jql, maxResults: PAGE_SIZE });
      return paginateByParam<JiraIssue>(fetchFn, firstUrl, {
        ...retryPolicy,
        maxItems,
        pageSize: PAGE_SIZE,
        offsetParam: 'startAt',
        pageSizeParam: 'maxResults',
        extractItems: (raw) => {
          const body = raw as { issues?: JiraIssue[] };
          return Array.isArray(body?.issues) ? body.issues : [];
        },
        init: { headers: defaultHeaders },
        onError: raiseForStatus,
      });
    },

    async getIssue(input): Promise<JiraIssue> {
      const response = await request(`/issue/${input.issueKey}`);
      return (await response.json()) as JiraIssue;
    },

    async updateIssue(input): Promise<void> {
      await request(`/issue/${input.issueKey}`, {
        method: 'PUT',
        body: JSON.stringify({ fields: input.fields }),
      });
    },

    async createIssue(input): Promise<JiraIssue> {
      const issueType = input.issueType ?? 'Task';
      const body: Record<string, unknown> = {
        fields: {
          project: { key: input.projectKey },
          summary: input.summary,
          issuetype: { name: issueType },
        },
      };
      if (input.description !== undefined) {
        (body.fields as Record<string, unknown>).description = input.description;
      }
      const response = await request('/issue', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return (await response.json()) as JiraIssue;
    },

    async addComment(input): Promise<JiraComment> {
      const response = await request(`/issue/${input.issueKey}/comment`, {
        method: 'POST',
        body: JSON.stringify({ body: input.body }),
      });
      return (await response.json()) as JiraComment;
    },
  };
}
