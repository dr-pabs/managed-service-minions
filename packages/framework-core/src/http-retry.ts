/**
 * Shared HTTP resilience for the MCP REST clients (review finding M8, feature F13).
 *
 * `fetchWithRetry` wraps an injectable `fetch`-shaped function with:
 *  - Retry-After aware backoff on 429/502/503/504 (configurable set) and network errors.
 *  - Jittered exponential backoff ("full jitter": delay = random() * min(cap, base * 2^attempt)).
 *  - A hard rule against retrying non-idempotent HTTP methods (POST/PATCH/...) unless the
 *    caller explicitly opts in via `policy.allowNonIdempotentRetry`.
 *  - Fully injectable sleep/clock/RNG so tests never touch real time or randomness.
 *
 * `paginateGitHub` and `paginateByParam` are pagination helpers built on top of it, each
 * bounded by a `maxItems` safety cap (default 500) so a misbehaving server (or a bug) can
 * never trigger an unbounded loop.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** HTTP methods considered idempotent (safe to retry without caller opt-in). */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

const DEFAULT_RETRY_STATUS_CODES = [429, 502, 503, 504];
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 250;
/** Cap on the exponential growth of the backoff window, in ms (30s). */
const DEFAULT_MAX_DELAY_MS = 30_000;

export interface RetryPolicy {
  /** Maximum number of attempts (including the first). Default 4. */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff. Default 250. */
  baseDelayMs?: number;
  /** Upper bound on the backoff window before jitter is applied. Default 30000. */
  maxDelayMs?: number;
  /** HTTP status codes that trigger a retry. Default [429, 502, 503, 504]. */
  retryStatusCodes?: number[];
  /**
   * Non-idempotent methods (POST, PATCH, ...) are never retried by default, since a retry
   * could duplicate a side effect (e.g. double-create). Set true to opt in explicitly.
   */
  allowNonIdempotentRetry?: boolean;
  /** Injectable sleep, defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG in [0, 1), defaults to Math.random. Used for full jitter. */
  random?: () => number;
  /** Injectable clock (ms since epoch), defaults to Date.now. Used for Retry-After HTTP-dates. */
  now?: () => number;
}

interface ResolvedRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryStatusCodes: Set<number>;
  allowNonIdempotentRetry: boolean;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  now: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolvePolicy(policy: RetryPolicy): ResolvedRetryPolicy {
  return {
    maxAttempts: policy.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    baseDelayMs: policy.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: policy.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    retryStatusCodes: new Set(policy.retryStatusCodes ?? DEFAULT_RETRY_STATUS_CODES),
    allowNonIdempotentRetry: policy.allowNonIdempotentRetry ?? false,
    sleep: policy.sleep ?? defaultSleep,
    random: policy.random ?? Math.random,
    now: policy.now ?? Date.now,
  };
}

function methodOf(init: RequestInit | undefined): string {
  return (init?.method ?? 'GET').toUpperCase();
}

function isIdempotent(init: RequestInit | undefined): boolean {
  return IDEMPOTENT_METHODS.has(methodOf(init));
}

/**
 * Parses an HTTP `Retry-After` header value, which per RFC 9110 §10.2.3 is either:
 *  - delta-seconds (an integer number of seconds), or
 *  - an HTTP-date (e.g. `Wed, 21 Oct 2026 07:28:00 GMT`).
 *
 * Returns a wait duration in ms, or `undefined` if the header is absent or malformed
 * (malformed dates fall back to backoff rather than throwing).
 */
function parseRetryAfterMs(headerValue: string | null, nowMs: number): number | undefined {
  if (headerValue === null || headerValue.trim() === '') {
    return undefined;
  }
  const trimmed = headerValue.trim();

  if (/^\d+$/u.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const parsedDate = Date.parse(trimmed);
  if (Number.isNaN(parsedDate)) {
    // Malformed HTTP-date: fall back to backoff rather than throwing.
    return undefined;
  }

  const deltaMs = parsedDate - nowMs;
  // Already elapsed (or equal) -> no/minimal wait.
  return deltaMs > 0 ? deltaMs : 0;
}

/** Full-jitter backoff: delay = random() * min(maxDelayMs, baseDelayMs * 2^attempt). */
function computeBackoffMs(attempt: number, resolved: ResolvedRetryPolicy): number {
  const window = Math.min(resolved.maxDelayMs, resolved.baseDelayMs * 2 ** attempt);
  return Math.floor(resolved.random() * window);
}

/**
 * Fetches `url` via `fetchImpl`, retrying on the configured retryable status codes and on
 * network errors (fetch rejecting), honoring `Retry-After` when present, using full-jitter
 * exponential backoff otherwise. Never retries a non-idempotent method (POST/PATCH/...)
 * unless `policy.allowNonIdempotentRetry` is true.
 *
 * Returns the last `Response` received (which may be a non-OK response if retries were
 * exhausted or the status wasn't retryable) so the caller can raise its own typed error —
 * this function never invents an error type of its own for HTTP-level failures. Network
 * errors (fetch rejecting) are rethrown after retries are exhausted.
 */
export async function fetchWithRetry(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit = {},
  policy: RetryPolicy = {}
): Promise<Response> {
  const resolved = resolvePolicy(policy);
  const canRetryMethod = resolved.allowNonIdempotentRetry || isIdempotent(init);
  const attempts = Math.max(1, resolved.maxAttempts);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const isLastAttempt = attempt === attempts - 1;
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (err) {
      if (!canRetryMethod || isLastAttempt) {
        throw err;
      }
      await resolved.sleep(computeBackoffMs(attempt, resolved));
      continue;
    }

    if (response.ok || !resolved.retryStatusCodes.has(response.status)) {
      return response;
    }

    if (!canRetryMethod || isLastAttempt) {
      return response;
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'), resolved.now());
    const waitMs = retryAfterMs ?? computeBackoffMs(attempt, resolved);
    await resolved.sleep(waitMs);
  }

  // Unreachable: the loop above always returns or throws on its final iteration
  // (isLastAttempt is true when attempt === attempts - 1, and attempts >= 1).
  /* istanbul ignore next */
  throw new Error('fetchWithRetry: unreachable');
}

/** Parses the `Link` response header (RFC 5988 / RFC 8288) into a rel -> url map. */
function parseLinkHeader(headerValue: string | null): Record<string, string> {
  if (!headerValue) {
    return {};
  }
  const links: Record<string, string> = {};
  for (const part of headerValue.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/u.exec(part.trim());
    if (match) {
      const [, linkUrl, rel] = match;
      if (linkUrl && rel) {
        links[rel] = linkUrl;
      }
    }
  }
  return links;
}

const DEFAULT_MAX_ITEMS = 500;

export interface PaginationOptions extends RetryPolicy {
  /** Safety cap on total items collected across all pages. Default 500. */
  maxItems?: number;
  /**
   * Called when a page response is not OK, after retries (if any) are exhausted. Should
   * throw the caller's typed error (e.g. `GitHubApiError`); if it returns instead of
   * throwing, pagination stops and the items collected so far are returned.
   */
  onError?: (response: Response) => void | Promise<void>;
  /** RequestInit (e.g. auth headers) applied to every page request. Method is always GET. */
  init?: RequestInit;
}

/**
 * Follows a GitHub-style `Link: rel="next"` header (RFC 5988) starting from `firstUrl`,
 * concatenating each page's JSON array body, until there is no `next` link or the
 * `maxItems` safety cap (default 500) is reached. Each page request goes through
 * `fetchWithRetry` using the same policy.
 */
export async function paginateGitHub<T = unknown>(
  fetchImpl: FetchLike,
  firstUrl: string,
  options: PaginationOptions = {}
): Promise<T[]> {
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const items: T[] = [];
  let nextUrl: string | undefined = firstUrl;

  while (nextUrl && items.length < maxItems) {
    const response: Response = await fetchWithRetry(fetchImpl, nextUrl, options.init ?? {}, options);
    if (!response.ok) {
      if (options.onError) {
        await options.onError(response);
      }
      break;
    }

    const page = (await response.json()) as T[];
    for (const item of page) {
      if (items.length >= maxItems) {
        break;
      }
      items.push(item);
    }

    const links = parseLinkHeader(response.headers.get('Link'));
    nextUrl = links.next;
  }

  return items;
}

export interface PaginateByParamOptions<T> extends RetryPolicy {
  /** Number of items requested per page. */
  pageSize: number;
  /** Query-string param name carrying the zero-based offset (e.g. "offset", "$skip"). */
  offsetParam?: string;
  /** Query-string param name carrying the one-based (or `startPage`-based) page number. */
  pageParam?: string;
  /** Query-string param name carrying the page size, if the API accepts one. */
  pageSizeParam?: string;
  /** Starting page number when using `pageParam`. Default 1. */
  startPage?: number;
  /** Extracts the array of items from a parsed page body. */
  extractItems: (body: unknown) => T[];
  /** Safety cap on total items collected across all pages. Default 500. */
  maxItems?: number;
  /** See `PaginationOptions.onError`. */
  onError?: (response: Response) => void | Promise<void>;
  /** RequestInit (e.g. auth headers, method) applied to every page request. */
  init?: RequestInit;
}

/**
 * Generic offset/page-style pagination for APIs like Azure DevOps, Jira, and ServiceNow,
 * which return a page of results under a body field (extracted via `extractItems`) rather
 * than a `Link` header. Supports either offset-based (`offsetParam`, e.g. ADO's `$skip` /
 * ServiceNow's `sysparm_offset`) or page-number-based (`pageParam`) traversal. Stops when
 * a page returns fewer than `pageSize` items (end of results) or the `maxItems` safety cap
 * (default 500) is reached. Each page request goes through `fetchWithRetry`.
 */
export async function paginateByParam<T = unknown>(
  fetchImpl: FetchLike,
  firstUrl: string,
  options: PaginateByParamOptions<T>
): Promise<T[]> {
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const items: T[] = [];

  let offset = 0;
  let page = options.startPage ?? 1;

  for (;;) {
    if (items.length >= maxItems) {
      break;
    }

    const url = new URL(firstUrl);
    if (options.offsetParam) {
      url.searchParams.set(options.offsetParam, String(offset));
    }
    if (options.pageParam) {
      url.searchParams.set(options.pageParam, String(page));
    }
    if (options.pageSizeParam) {
      url.searchParams.set(options.pageSizeParam, String(options.pageSize));
    }

    const response: Response = await fetchWithRetry(
      fetchImpl,
      url.toString(),
      options.init ?? {},
      options
    );
    if (!response.ok) {
      if (options.onError) {
        await options.onError(response);
      }
      break;
    }

    const body = (await response.json()) as unknown;
    const pageItems = options.extractItems(body);

    for (const item of pageItems) {
      if (items.length >= maxItems) {
        break;
      }
      items.push(item);
    }

    if (pageItems.length < options.pageSize) {
      break;
    }

    offset += options.pageSize;
    page += 1;
  }

  return items;
}
