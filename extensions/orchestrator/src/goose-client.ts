/**
 * `GooseClient` — the orchestrator runner's seam onto a running `goose
 * serve` process (Milestone 11, review finding M5: "goose-runner is
 * unverified against a real Goose server and unused").
 *
 * The request/response shapes below are extracted from
 * `packages/framework-core/src/goose-runner.ts`'s existing
 * `GooseReplyRequest`/`GooseReplyResponse` (that module's own guess at the
 * `POST {baseUrl}/reply` wire contract, built for the ingress-level
 * "echo the whole conversation" runner) rather than re-invented, so the
 * orchestrator sends the SAME shape goose-runner.ts already sends — one
 * contract, two callers (ingress-level chit-chat vs. per-minion prompts).
 * `test/src/goose-contract.test.ts` is the authority on whether a live Goose
 * actually accepts this shape; see that file and the ExecPlan Surprises &
 * Discoveries for the outcome of checking.
 */

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface GooseClientConfig {
  /** Base URL of a running `goose serve` process, e.g. http://localhost:3284 */
  baseUrl: string;
  /** Injectable fetch implementation. Defaults to globalThis.fetch. */
  fetch?: FetchFn;
}

/** One turn of conversation sent to Goose. Mirrors goose-runner.ts's GooseReplyRequest shape. */
export interface GooseMessage {
  role: 'system' | 'user';
  content: string;
}

/** The exact payload POSTed to `{baseUrl}/reply` — the wire contract under verification. */
export interface GooseReplyRequestPayload {
  messages: GooseMessage[];
  session_id: string;
  correlation_id: string;
}

/** The exact shape expected back from `{baseUrl}/reply`. */
export interface GooseReplyResponsePayload {
  role: string;
  content: string;
}

export function isGooseReplyResponsePayload(value: unknown): value is GooseReplyResponsePayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).role === 'string' &&
    typeof (value as Record<string, unknown>).content === 'string'
  );
}

/**
 * One minion invocation: a system prompt (the agent's `agents/*.md` body,
 * with any untrusted content already quarantined by the caller — see the
 * runner's interpolation-point comments), the session/correlation identity,
 * and optional retry feedback (Milestone 10's `runWithContract` passes this
 * back in as a second user turn on a schema-validation retry).
 */
export interface GooseMinionRequest {
  minionType: string;
  systemPrompt: string;
  userContent: string;
  sessionId: string;
  correlationId: string;
  /**
   * The signed minion token minted for THIS run (Milestone 3). Not part of
   * the `/reply` JSON body — goose-runner.ts's existing contract has no
   * field for it, and the body is shared with the ingress-level echo path
   * — sent as an `X-Minion-Token` header instead, mirroring how
   * `X-Correlation-Id` already rides alongside the body. A real Goose
   * process's `mcp-toolshed` stdio extension presents this token on the
   * minion's behalf for every `execute_tool` call it makes while producing
   * this turn's output; a `FakeGooseClient` in tests uses it (or mints its
   * own, scripted) to call the real toolshed directly.
   */
  minionToken: string;
  /** Validation errors from a prior attempt, appended as feedback (Milestone 10 retry-with-feedback). */
  feedback?: string[];
}

export interface GooseMinionResponse {
  /** Raw text content Goose returned; the runner is responsible for JSON-parsing it against the minion's output schema. */
  raw: string;
}

/**
 * The seam `createOrchestratorRunner` depends on instead of talking to
 * `fetch`/Goose directly, so tests can supply a `FakeGooseClient` (scripted
 * per-minion responses) with no network. A production instance is built by
 * `createHttpGooseClient` below.
 */
export interface GooseClient {
  /** Classifies intent by sending the orchestrator's own prompt against schemas/intent.json. Returns raw text for the caller to JSON-parse and validate. */
  classifyIntent(args: {
    systemPrompt: string;
    userContent: string;
    sessionId: string;
    correlationId: string;
  }): Promise<GooseMinionResponse>;
  /** Runs one minion turn. */
  runMinion(request: GooseMinionRequest): Promise<GooseMinionResponse>;
}

function buildMessages(systemPrompt: string, userContent: string, feedback?: string[]): GooseMessage[] {
  const messages: GooseMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
  if (feedback && feedback.length > 0) {
    messages.push({
      role: 'user',
      content: `Your previous output failed schema validation with these errors:\n${feedback.join('\n')}\nPlease correct your output and return valid JSON only.`,
    });
  }
  return messages;
}

/**
 * Real HTTP implementation, POSTing to `{baseUrl}/reply` exactly as
 * `goose-runner.ts`'s `createGooseRunner` does. Verified (or not) against a
 * live `goose serve` by `test/src/goose-contract.test.ts` when
 * `GOOSE_BASE_URL` is set; against recorded fixtures otherwise.
 */
export function createHttpGooseClient(config: GooseClientConfig): GooseClient {
  const fetchFn: FetchFn = config.fetch ?? ((url, init) => fetch(url, init));

  async function post(
    messages: GooseMessage[],
    sessionId: string,
    correlationId: string,
    minionToken?: string
  ): Promise<GooseMinionResponse> {
    const body: GooseReplyRequestPayload = {
      messages,
      session_id: sessionId,
      correlation_id: correlationId,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Correlation-Id': correlationId,
    };
    if (minionToken) {
      headers['X-Minion-Token'] = minionToken;
    }

    let res: Response;
    try {
      res = await fetchFn(`${config.baseUrl}/reply`, {
        method: 'POST',
        headers,
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
    if (!isGooseReplyResponsePayload(data)) {
      throw new Error('Goose serve returned an unexpected response shape');
    }

    return { raw: data.content };
  }

  return {
    classifyIntent: (args) =>
      post(buildMessages(args.systemPrompt, args.userContent), args.sessionId, args.correlationId),
    runMinion: (request) =>
      post(
        buildMessages(request.systemPrompt, request.userContent, request.feedback),
        request.sessionId,
        request.correlationId,
        request.minionToken
      ),
  };
}
