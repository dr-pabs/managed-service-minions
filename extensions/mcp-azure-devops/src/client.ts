import { fetchWithRetry, paginateByParam, type RetryPolicy } from 'framework-core';
import { AzureDevOpsApiError } from './errors.js';

/** Safety cap on total items collected across paginated list endpoints. */
const DEFAULT_MAX_ITEMS = 500;
/** Page size requested per call when paginating. */
const PAGE_SIZE = 100;

export interface AzureDevOpsClient {
  listPullRequests(repositoryId: string, status?: string, top?: number): Promise<unknown>;
  getPullRequest(repositoryId: string, pullRequestId: number): Promise<unknown>;
  getPullRequestDiff(repositoryId: string, pullRequestId: number): Promise<unknown>;
  createPullRequest(
    repositoryId: string,
    title: string,
    sourceRefName: string,
    targetRefName: string,
    description?: string
  ): Promise<unknown>;
  mergePullRequest(repositoryId: string, pullRequestId: number, comment?: string): Promise<unknown>;
  listWorkItems(wiql?: string, ids?: number[]): Promise<unknown>;
  getWorkItem(id: number): Promise<unknown>;
  updateWorkItem(id: number, fields: Record<string, unknown>): Promise<unknown>;
}

export interface AzureDevOpsClientConfig {
  org: string;
  project: string;
  token: string;
  fetchFn?: typeof fetch;
  /** Retry/backoff policy applied to every request. Defaults per `http-retry.ts`. */
  retryPolicy?: RetryPolicy;
  /** Safety cap on items returned by paginated list endpoints. Default 500. */
  maxItems?: number;
}

const API_VERSION_KEY = 'api-version';
const API_VERSION_VALUE = '7.1';

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toApiError(response: Response, responseBody: unknown): AzureDevOpsApiError {
  return new AzureDevOpsApiError(
    response.status,
    responseBody,
    `Azure DevOps API returned ${response.status}`
  );
}

export function createAzureDevOpsClient({
  org,
  project,
  token,
  fetchFn = fetch,
  retryPolicy = {},
  maxItems = DEFAULT_MAX_ITEMS,
}: AzureDevOpsClientConfig): AzureDevOpsClient {
  const baseUrl = `https://dev.azure.com/${org}/${project}/_apis/`;
  const authHeader = `Basic ${Buffer.from(`:${token}`).toString('base64')}`;

  function authHeaders(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: authHeader,
      Accept: 'application/json',
    };
    if (contentType) {
      headers['Content-Type'] = contentType;
    }
    return headers;
  }

  async function request(
    method: string,
    relativeUrl: string,
    body?: unknown,
    contentType = 'application/json'
  ): Promise<unknown> {
    const headers = authHeaders(body !== undefined ? contentType : undefined);

    let response: Response;
    try {
      response = await fetchWithRetry(
        fetchFn,
        baseUrl + relativeUrl,
        {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        retryPolicy
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AzureDevOpsApiError(0, err, `Network error contacting Azure DevOps: ${message}`);
    }

    const responseBody = await parseResponseBody(response);

    if (!response.ok) {
      throw toApiError(response, responseBody);
    }

    return responseBody;
  }

  return {
    async listPullRequests(repositoryId: string, status = 'active', top?: number): Promise<unknown> {
      // An explicit top is a caller-bounded single page (preserves prior behavior);
      // otherwise page through the full result set via $skip/$top up to maxItems.
      if (top !== undefined) {
        const params = new URLSearchParams();
        params.set('searchCriteria.status', status);
        params.set(API_VERSION_KEY, API_VERSION_VALUE);
        params.set('$top', String(top));
        return request('GET', `git/repositories/${repositoryId}/pullrequests?${params.toString()}`);
      }

      const firstUrl = new URL(
        `git/repositories/${repositoryId}/pullrequests`,
        baseUrl
      );
      firstUrl.searchParams.set('searchCriteria.status', status);
      firstUrl.searchParams.set(API_VERSION_KEY, API_VERSION_VALUE);

      const items = await paginateByParam(fetchFn, firstUrl.toString(), {
        ...retryPolicy,
        maxItems,
        pageSize: PAGE_SIZE,
        offsetParam: '$skip',
        pageSizeParam: '$top',
        extractItems: (raw) => {
          const body = raw as { value?: unknown[] };
          return Array.isArray(body?.value) ? body.value : [];
        },
        init: { headers: authHeaders() },
        onError: async (response) => {
          const responseBody = await parseResponseBody(response);
          throw toApiError(response, responseBody);
        },
      });
      return { value: items, count: items.length };
    },

    async getPullRequest(repositoryId: string, pullRequestId: number): Promise<unknown> {
      const params = new URLSearchParams();
      params.set(API_VERSION_KEY, API_VERSION_VALUE);
      return request(
        'GET',
        `git/repositories/${repositoryId}/pullrequests/${pullRequestId}?${params.toString()}`
      );
    },

    async getPullRequestDiff(repositoryId: string, pullRequestId: number): Promise<unknown> {
      const params = new URLSearchParams();
      params.set(API_VERSION_KEY, API_VERSION_VALUE);
      return request(
        'GET',
        `git/repositories/${repositoryId}/pullrequests/${pullRequestId}/diff?${params.toString()}`
      );
    },

    async createPullRequest(
      repositoryId: string,
      title: string,
      sourceRefName: string,
      targetRefName: string,
      description?: string
    ): Promise<unknown> {
      const body: Record<string, unknown> = {
        title,
        sourceRefName,
        targetRefName,
      };
      if (description !== undefined) {
        body.description = description;
      }
      const params = new URLSearchParams();
      params.set(API_VERSION_KEY, API_VERSION_VALUE);
      return request('POST', `git/repositories/${repositoryId}/pullrequests?${params.toString()}`, body);
    },

    async mergePullRequest(
      repositoryId: string,
      pullRequestId: number,
      comment?: string
    ): Promise<unknown> {
      const body: Record<string, unknown> = {
        status: 'completed',
      };
      if (comment !== undefined) {
        body.completionOptions = { mergeCommitMessage: comment };
      }
      const params = new URLSearchParams();
      params.set(API_VERSION_KEY, API_VERSION_VALUE);
      return request(
        'PATCH',
        `git/repositories/${repositoryId}/pullrequests/${pullRequestId}?${params.toString()}`,
        body
      );
    },

    async listWorkItems(wiql?: string, ids?: number[]): Promise<unknown> {
      if (ids !== undefined && ids.length > 0) {
        const params = new URLSearchParams();
        params.set('ids', ids.join(','));
        params.set(API_VERSION_KEY, API_VERSION_VALUE);
        return request('GET', `wit/workitems?${params.toString()}`);
      }
      if (wiql !== undefined) {
        const params = new URLSearchParams();
        params.set(API_VERSION_KEY, API_VERSION_VALUE);
        return request('POST', `wit/wiql?${params.toString()}`, { query: wiql });
      }
      throw new AzureDevOpsApiError(400, undefined, 'Either wiql or ids must be provided');
    },

    async getWorkItem(id: number): Promise<unknown> {
      const params = new URLSearchParams();
      params.set(API_VERSION_KEY, API_VERSION_VALUE);
      return request('GET', `wit/workitems/${id}?${params.toString()}`);
    },

    async updateWorkItem(id: number, fields: Record<string, unknown>): Promise<unknown> {
      const patch = Object.entries(fields).map(([key, value]) => ({
        op: 'add',
        path: `/fields/${key}`,
        value,
      }));
      const params = new URLSearchParams();
      params.set(API_VERSION_KEY, API_VERSION_VALUE);
      return request(
        'PATCH',
        `wit/workitems/${id}?${params.toString()}`,
        patch,
        'application/json-patch+json'
      );
    },
  };
}
