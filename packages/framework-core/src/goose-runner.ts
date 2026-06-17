import type { IngressRunner, IngressRequest, IngressResponse } from './ingress.js';

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface GooseRunnerConfig {
  /** Base URL of the running `goose serve` process, e.g. http://localhost:3284 */
  baseUrl: string;
  /** Injectable fetch implementation. Defaults to globalThis.fetch. */
  fetch?: FetchFn;
}

interface GooseReplyRequest {
  messages: Array<{ role: 'user'; content: string }>;
  session_id: string;
  correlation_id: string;
}

interface GooseReplyResponse {
  role: string;
  content: string;
}

function isGooseReplyResponse(value: unknown): value is GooseReplyResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['role'] === 'string' &&
    typeof (value as Record<string, unknown>)['content'] === 'string'
  );
}

/**
 * Creates an IngressRunner that forwards requests to a running `goose serve`
 * HTTP endpoint and returns the assistant reply as an IngressResponse.
 *
 * The runner POSTs to `{baseUrl}/reply` with the normalized message text,
 * session ID, and correlation root. It expects a JSON body with `role` and
 * `content` fields in the response.
 */
export function createGooseRunner(config: GooseRunnerConfig): IngressRunner {
  const fetchFn: FetchFn = config.fetch ?? ((url, init) => fetch(url, init));

  return {
    run: async (
      request: IngressRequest & { sessionId: string; correlationRoot: string }
    ): Promise<IngressResponse> => {
      const body: GooseReplyRequest = {
        messages: [{ role: 'user', content: request.text }],
        session_id: request.sessionId,
        correlation_id: request.correlationRoot,
      };

      let res: Response;
      try {
        res = await fetchFn(`${config.baseUrl}/reply`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Correlation-Id': request.correlationRoot,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Goose serve unreachable at ${config.baseUrl}: ${message}`);
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Goose serve returned ${res.status}: ${text}`);
      }

      const data: unknown = await res.json();
      if (!isGooseReplyResponse(data)) {
        throw new Error('Goose serve returned an unexpected response shape');
      }

      return { text: data.content };
    },
  };
}
