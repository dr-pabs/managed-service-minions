import { fetchWithRetry, paginateByParam, type RetryPolicy } from 'framework-core';
import { ServiceNowApiError } from './errors.js';

/** Safety cap on total items collected across paginated list endpoints. */
const DEFAULT_MAX_ITEMS = 500;
/** Page size requested per call when paginating. */
const PAGE_SIZE = 100;

export interface ServiceNowClient {
  listIncidents(limit?: number, state?: string): Promise<unknown>;
  getIncidentBySysId(sysId: string): Promise<unknown>;
  getIncidentByNumber(number: string): Promise<unknown>;
  updateIncident(sysId: string, fields: Record<string, unknown>): Promise<unknown>;
  createIncident(fields: Record<string, unknown>): Promise<unknown>;
}

export interface ServiceNowClientConfig {
  instance: string;
  username: string;
  password: string;
  fetchFn?: typeof fetch;
  /** Retry/backoff policy applied to every request. Defaults per `http-retry.ts`. */
  retryPolicy?: RetryPolicy;
  /** Safety cap on items returned by paginated list endpoints. Default 500. */
  maxItems?: number;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toApiError(response: Response, responseBody: unknown): ServiceNowApiError {
  return new ServiceNowApiError(response.status, responseBody, `ServiceNow API returned ${response.status}`);
}

export function createServiceNowClient({
  instance,
  username,
  password,
  fetchFn = fetch,
  retryPolicy = {},
  maxItems = DEFAULT_MAX_ITEMS,
}: ServiceNowClientConfig): ServiceNowClient {
  const baseUrl = `https://${instance}.service-now.com/api/now/table/incident`;
  const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

  function authHeaders(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: authHeader,
      Accept: 'application/json',
    };
    if (hasBody) {
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  }

  async function request(
    method: string,
    resourcePath: string,
    query?: URLSearchParams,
    body?: unknown
  ): Promise<unknown> {
    const url = query && query.toString() ? `${baseUrl}${resourcePath}?${query.toString()}` : `${baseUrl}${resourcePath}`;

    let response: Response;
    try {
      response = await fetchWithRetry(
        fetchFn,
        url,
        {
          method,
          headers: authHeaders(body !== undefined),
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        retryPolicy
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ServiceNowApiError(0, err, `Network error contacting ServiceNow: ${message}`);
    }

    const responseBody = await parseResponseBody(response);

    if (!response.ok) {
      throw toApiError(response, responseBody);
    }

    return responseBody;
  }

  return {
    async listIncidents(limit?: number, state?: string): Promise<unknown> {
      // An explicit limit is a caller-bounded single page (preserves prior behavior);
      // otherwise page through the full result set via sysparm_offset up to maxItems.
      if (limit !== undefined) {
        const params = new URLSearchParams();
        params.set('sysparm_limit', String(limit));
        if (state !== undefined) {
          params.set('sysparm_query', `state=${state}`);
        }
        return request('GET', '', params);
      }

      const firstUrlObj = new URL(baseUrl);
      if (state !== undefined) {
        firstUrlObj.searchParams.set('sysparm_query', `state=${state}`);
      }

      const items = await paginateByParam(fetchFn, firstUrlObj.toString(), {
        ...retryPolicy,
        maxItems,
        pageSize: PAGE_SIZE,
        offsetParam: 'sysparm_offset',
        pageSizeParam: 'sysparm_limit',
        extractItems: (raw) => {
          const body = raw as { result?: unknown[] };
          return Array.isArray(body?.result) ? body.result : [];
        },
        init: { headers: authHeaders(false) },
        onError: async (response) => {
          const responseBody = await parseResponseBody(response);
          throw toApiError(response, responseBody);
        },
      });
      return { result: items };
    },

    async getIncidentBySysId(sysId: string): Promise<unknown> {
      return request('GET', `/${encodeURIComponent(sysId)}`);
    },

    async getIncidentByNumber(number: string): Promise<unknown> {
      const params = new URLSearchParams();
      params.set('sysparm_query', `number=${number}`);
      params.set('sysparm_limit', '1');
      const result = (await request('GET', '', params)) as { result?: unknown[] };
      return Array.isArray(result?.result) && result.result.length > 0 ? result.result[0] : result;
    },

    async updateIncident(sysId: string, fields: Record<string, unknown>): Promise<unknown> {
      return request('PUT', `/${encodeURIComponent(sysId)}`, undefined, fields);
    },

    async createIncident(fields: Record<string, unknown>): Promise<unknown> {
      return request('POST', '', undefined, fields);
    },
  };
}
