import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { handleIngressMessage, mintMinionToken, type IngressRunner, type SessionStore } from 'framework-core';
import { createMemoryStore } from 'mcp-toolshed';

/**
 * GitHub/Azure DevOps webhook ingress (Milestone 15, F11): events, not just
 * chat mentions, can start orchestrator work. Mirrors `extensions/slack-bot`'s
 * layout -- a bare `node:http` server (like `agent-dashboard`'s, not Bolt's
 * HTTP handling, since neither GitHub nor ADO webhooks need a framework) that
 * verifies the sender before touching the body, maps the event to the SAME
 * `IngressRequest`/`IngressRunner` contract chat ingress uses
 * (`framework-core`'s `handleIngressMessage`), and replies by posting a PR
 * comment through the GOVERNED toolshed -- never a direct GitHub API call.
 */

/** Minimal shape of `mcp-toolshed`'s `verifyAndExecuteTool`, mirroring `extensions/orchestrator/src/runner.ts`'s `ToolshedInvoker`. */
export interface WebhookToolshedInvoker {
  verifyAndExecuteTool(
    input: { minionToken: string; correlationId: string; attempt: number },
    serverAlias: string,
    toolName: string,
    params: unknown
  ): Promise<{ status: string; data?: unknown; error?: string; approvalId?: string }>;
}

export interface WebhookServerDeps {
  runner: IngressRunner;
  /** `SessionStore` backing `handleIngressMessage`'s session lookup. Defaults to an in-memory Map-based store good enough for a single-process deploy; production wiring (`src/index.ts`) passes the real toolshed-backed store. */
  store?: SessionStore;
  githubWebhookSecret: string;
  adoUsername: string;
  adoPassword: string;
  port: number;
  createServer?: typeof http.createServer;
  /**
   * Governed reply path (Milestone 15's hard requirement: "replying by
   * posting a PR comment through the governed toolshed"). Optional so a
   * deployment/test that doesn't care about the reply (or wires it up
   * separately) can omit it -- when absent, the mapped event still drives
   * the runner, but no comment is posted.
   */
  toolshed?: WebhookToolshedInvoker;
  /** Shared HMAC secret used to mint the `code_reviewer` token for the reply comment (Milestone 3). Required when `toolshed` is supplied. */
  signingSecret?: string;
  /** Injectable clock for MinionRun/token timestamps in tests. Defaults to Date.now via mintMinionToken's own default. */
  now?: () => number;
}

export interface WebhookServer {
  port: number;
  close(): Promise<void>;
}

interface MappedWebhookEvent {
  request: { platform: 'webhook'; teamId: string; userId: string; text: string; threadId: string };
  /** Present only for events that came from a repo with an addressable PR/issue -- used to post the governed reply comment. */
  reply?: { owner: string; repo: string; issueNumber: number };
}

function timingSafeEqualHex(expectedHex: string, actualHex: string): boolean {
  // timingSafeEqual requires equal-length buffers (guard BEFORE comparing --
  // never throw on a malformed/short signature, just fail closed).
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  if (expected.length === 0 || actual.length === 0 || expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

/**
 * Verifies `X-Hub-Signature-256` over the RAW request body BYTES (a Buffer,
 * never a parsed-then-re-serialized JSON object -- key order/whitespace in a
 * re-serialized body would silently pass this function's own tests while
 * failing against a real GitHub signature; see the ExecPlan Decision Log).
 */
export function verifyGitHubSignature(secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean {
  // Fail closed on an unset/empty secret rather than computing a real
  // HMAC-SHA256 over the empty key -- an empty-key MAC is still a valid MAC,
  // so an attacker who knows the secret is unset could forge a signature the
  // comparison below would accept. This mirrors the Milestone 3 N2 decision
  // (an empty toolshed signing secret rejects tokens outright; see the
  // ExecPlan Decision Log's M3 correction).
  if (!secret) {
    return false;
  }
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const providedHex = signatureHeader.slice('sha256='.length);
  const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqualHex(expectedHex, providedHex);
}

/**
 * ADO webhooks support HTTP Basic Auth as a shared-secret mechanism (chosen
 * over a bearer header since it's ADO's own documented convention -- see the
 * ExecPlan Decision Log). Verifies BEFORE the body is ever parsed/acted on,
 * same as the GitHub path.
 */
export function verifyAdoBasicAuth(username: string, password: string, authHeader: string | undefined): boolean {
  // Fail closed on empty configured credentials (same M3 N2 precedent as the
  // GitHub path). Making this an explicit early return -- rather than relying
  // on the incidental `length > 0` guards in the comparison below -- states
  // the intent and can never be weakened away by a later refactor of those
  // guards.
  if (!username || !password) {
    return false;
  }
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return false;
  }
  // node:Buffer's base64 decoder is lenient (never throws on malformed
  // input -- it decodes what it can and drops the rest), so there is no
  // exception path to guard here; an invalid credentials string simply
  // fails the length/timingSafeEqual comparison below like any other wrong
  // value.
  const decoded = Buffer.from(authHeader.slice('Basic '.length), 'base64').toString('utf8');
  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) {
    return false;
  }
  const providedUser = decoded.slice(0, separatorIndex);
  const providedPass = decoded.slice(separatorIndex + 1);

  const userBuf = Buffer.from(providedUser, 'utf8');
  const expectedUserBuf = Buffer.from(username, 'utf8');
  const passBuf = Buffer.from(providedPass, 'utf8');
  const expectedPassBuf = Buffer.from(password, 'utf8');

  const userMatches =
    userBuf.length === expectedUserBuf.length && userBuf.length > 0 && timingSafeEqual(userBuf, expectedUserBuf);
  const passMatches =
    passBuf.length === expectedPassBuf.length && passBuf.length > 0 && timingSafeEqual(passBuf, expectedPassBuf);
  return userMatches && passMatches;
}

interface GitHubPullRequestPayload {
  action?: string;
  pull_request?: {
    number?: number;
    title?: string;
    body?: string | null;
    base?: { repo?: { owner?: { login?: string }; name?: string } };
  };
}

interface GitHubCheckSuitePayload {
  action?: string;
  check_suite?: { conclusion?: string | null; pull_requests?: Array<{ number?: number }> };
  repository?: { owner?: { login?: string }; name?: string };
}

/**
 * Maps a GitHub webhook event to an `IngressRequest` (Milestone 15). Only
 * `pull_request.opened` and `check_suite.completed` (conclusion === 'failure'
 * only -- success/neutral/other conclusions are ignored) start work; every
 * other event is acknowledged but not dispatched. `threadId` is a stable
 * `${owner}/${repo}#${number}` repo+PR identifier so follow-up webhook
 * events for the SAME PR reuse the same session, per the M9 session model
 * (teamId, platform, threadId) in `framework-core`'s `ingress.ts`.
 */
export function mapGitHubEventToIngressRequest(eventName: string | undefined, payload: unknown): MappedWebhookEvent | undefined {
  if (eventName === 'pull_request') {
    const body = payload as GitHubPullRequestPayload;
    if (body.action !== 'opened') {
      return undefined;
    }
    const pr = body.pull_request;
    const owner = pr?.base?.repo?.owner?.login;
    const repo = pr?.base?.repo?.name;
    const number = pr?.number;
    if (!owner || !repo || typeof number !== 'number') {
      return undefined;
    }
    const teamId = `${owner}/${repo}`;
    const threadId = `${teamId}#${number}`;
    const text = `A new pull request was opened: #${number} "${pr?.title ?? ''}". ${pr?.body ?? ''}`.trim();
    return {
      request: { platform: 'webhook', teamId, userId: 'github', text, threadId },
      reply: { owner, repo, issueNumber: number },
    };
  }

  if (eventName === 'check_suite') {
    const body = payload as GitHubCheckSuitePayload;
    if (body.action !== 'completed') {
      return undefined;
    }
    if (body.check_suite?.conclusion !== 'failure') {
      return undefined;
    }
    const linkedPr = body.check_suite?.pull_requests?.[0];
    const owner = body.repository?.owner?.login;
    const repo = body.repository?.name;
    const number = linkedPr?.number;
    if (!owner || !repo || typeof number !== 'number') {
      // No linked PR to thread the follow-up on -- nothing addressable to reply to.
      return undefined;
    }
    const teamId = `${owner}/${repo}`;
    const threadId = `${teamId}#${number}`;
    const text = `A CI check suite failed for pull request #${number} in ${teamId}. Please investigate.`;
    return {
      request: { platform: 'webhook', teamId, userId: 'github', text, threadId },
      reply: { owner, repo, issueNumber: number },
    };
  }

  return undefined;
}

interface AdoPullRequestPayload {
  eventType?: string;
  resource?: {
    pullRequestId?: number;
    title?: string;
    description?: string;
    repository?: { name?: string; project?: { name?: string } };
  };
}

/** Maps an Azure DevOps service hook payload to an `IngressRequest` (Milestone 15). Only `git.pullrequest.created` starts work. */
export function mapAdoEventToIngressRequest(payload: unknown): MappedWebhookEvent | undefined {
  const body = payload as AdoPullRequestPayload;
  if (body.eventType !== 'git.pullrequest.created') {
    return undefined;
  }
  const resource = body.resource;
  const project = resource?.repository?.project?.name;
  const repo = resource?.repository?.name;
  const number = resource?.pullRequestId;
  if (!project || !repo || typeof number !== 'number') {
    return undefined;
  }
  const teamId = `${project}/${repo}`;
  const threadId = `${teamId}#${number}`;
  const text = `A new pull request was opened: #${number} "${resource?.title ?? ''}". ${resource?.description ?? ''}`.trim();
  return {
    request: { platform: 'webhook', teamId, userId: 'ado', text, threadId },
    reply: { owner: project, repo, issueNumber: number },
  };
}

function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

/**
 * Posts the orchestrator's reply as a PR/issue comment through the GOVERNED
 * toolshed -- mints a `code_reviewer` token (Milestone 3) and calls
 * `github_create_issue_comment` via `verifyAndExecuteTool`, exactly the same
 * governed path a minion's own tool call takes (allowlist, rate limit,
 * audit) -- never a direct GitHub API call bypassing the toolshed. Failure
 * here is logged, not thrown: a comment-post failure must not turn an
 * otherwise-successful webhook-triggered run into a 5xx retry storm from
 * GitHub/ADO.
 */
async function postGovernedReplyComment(
  toolshed: WebhookToolshedInvoker,
  signingSecret: string,
  reply: { owner: string; repo: string; issueNumber: number },
  correlationId: string,
  sessionId: string,
  text: string
): Promise<void> {
  const token = mintMinionToken({ agent_id: 'code_reviewer', scope_id: sessionId, correlation_id: correlationId }, signingSecret);
  const result = await toolshed.verifyAndExecuteTool(
    { minionToken: token, correlationId, attempt: 1 },
    'github',
    'github_create_issue_comment',
    { owner: reply.owner, repo: reply.repo, issue_number: reply.issueNumber, body: text }
  );
  if (result.status !== 'success') {
    console.error(`[webhook-ingress] governed reply comment failed: ${result.status} ${result.error ?? ''}`);
  }
}

/**
 * Routes a mapped event through `handleIngressMessage` (the SAME path chat
 * uses) and, once the runner responds, posts the reply as a governed PR
 * comment. Runs detached from the HTTP response (see `handleWebhookRequest`
 * below for the ack-then-work rationale) -- a rejection here is caught and
 * logged, never left as an unhandled rejection.
 */
function dispatchInBackground(deps: WebhookServerDeps, store: SessionStore, mapped: MappedWebhookEvent): void {
  void (async () => {
    try {
      const session = store.getSession(
        `sess_${mapped.request.teamId}:webhook:${mapped.request.threadId}`
      );
      const response = await handleIngressMessage(mapped.request, store, deps.runner);
      if (mapped.reply && deps.toolshed && deps.signingSecret) {
        const correlationRoot = session?.correlationRoot ?? `corr_${mapped.request.threadId}`;
        await postGovernedReplyComment(
          deps.toolshed,
          deps.signingSecret,
          mapped.reply,
          `${correlationRoot}.reply`,
          `sess_${mapped.request.teamId}:webhook:${mapped.request.threadId}`,
          response.text
        );
      }
    } catch (err) {
      console.error(`[webhook-ingress] background dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}

/**
 * Creates the webhook-ingress `node:http` server (Milestone 15, F11):
 * `POST /webhooks/github` and `POST /webhooks/ado`. Both routes read the raw
 * body FIRST, verify the sender, and only THEN parse/act on it -- a bad
 * signature/credential is rejected with 401 before any JSON parsing or
 * orchestrator dispatch happens (the security-critical property this
 * milestone's tests pin down).
 *
 * Ack-then-work (mirrors `extensions/slack-bot`'s pattern, adapted for
 * GitHub/ADO's constraints -- see the ExecPlan Decision Log): the HTTP
 * response is sent (202, "accepted, working on it") as soon as the event is
 * verified and mapped, WITHOUT awaiting `handleIngressMessage`/the governed
 * reply comment. GitHub's webhook delivery times out around 10s and retries
 * on non-2xx or timeout; a slow orchestrator run (multiple minion turns, a
 * governed tool call) can easily exceed that, so unlike Slack (which needs a
 * fast ack mainly to avoid a visible "nothing happened" UX gap before its
 * OWN retry-suppressing 200), GitHub webhooks structurally CANNOT wait on
 * the real work without risking duplicate deliveries. The background
 * dispatch's own errors are caught and logged (`dispatchInBackground`),
 * never left as unhandled rejections.
 */
export async function createWebhookServer(deps: WebhookServerDeps): Promise<WebhookServer> {
  const createServer = deps.createServer ?? http.createServer;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (req.method === 'POST' && url.pathname === '/webhooks/github') {
        const rawBody = await readRawBody(req);
        const signature = req.headers['x-hub-signature-256'];
        const signatureHeader = Array.isArray(signature) ? signature[0] : signature;
        if (!verifyGitHubSignature(deps.githubWebhookSecret, rawBody, signatureHeader)) {
          jsonResponse(res, 401, { error: 'invalid signature' });
          return;
        }

        let payload: unknown;
        try {
          payload = JSON.parse(rawBody.toString('utf8'));
        } catch {
          jsonResponse(res, 400, { error: 'invalid JSON body' });
          return;
        }

        const eventHeader = req.headers['x-github-event'];
        const eventName = Array.isArray(eventHeader) ? eventHeader[0] : eventHeader;
        const mapped = mapGitHubEventToIngressRequest(eventName, payload);

        // Ack immediately (see this function's docstring) -- do not await
        // the orchestrator run before responding.
        jsonResponse(res, 202, { status: 'accepted' });

        if (mapped) {
          dispatchInBackground(deps, resolveStore(deps), mapped);
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/webhooks/ado') {
        const rawBody = await readRawBody(req);
        const authHeader = req.headers.authorization;
        if (!verifyAdoBasicAuth(deps.adoUsername, deps.adoPassword, authHeader)) {
          jsonResponse(res, 401, { error: 'unauthorized' });
          return;
        }

        let payload: unknown;
        try {
          payload = JSON.parse(rawBody.toString('utf8'));
        } catch {
          jsonResponse(res, 400, { error: 'invalid JSON body' });
          return;
        }

        const mapped = mapAdoEventToIngressRequest(payload);

        jsonResponse(res, 202, { status: 'accepted' });

        if (mapped) {
          dispatchInBackground(deps, resolveStore(deps), mapped);
        }
        return;
      }

      jsonResponse(res, 404, { error: 'not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jsonResponse(res, 500, { error: message });
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(deps.port, () => {
      const address = server.address();
      const listeningPort = typeof address === 'object' && address !== null ? address.port : deps.port;
      console.log(`Webhook ingress listening on port ${listeningPort}`);
      resolve({
        port: listeningPort,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.closeAllConnections?.();
            server.close((err) => {
              if (err) {
                rejectClose(err);
              } else {
                resolveClose();
              }
            });
          }),
      });
    });
    server.on('error', reject);
  });
}

let fallbackStore: SessionStore | undefined;

/**
 * Test/dev convenience: when no `store` is injected, lazily build a single
 * in-memory session store shared across requests within this process, so
 * repeated webhook deliveries for the same PR still reuse one session
 * (production wiring, `src/index.ts`, always supplies a real store).
 */
function resolveStore(deps: WebhookServerDeps): SessionStore {
  if (deps.store) {
    return deps.store;
  }
  // mcp-toolshed's own createMemoryStore (the same implementation the e2e
  // test and the dashboard use) -- reused here rather than hand-rolling a
  // second SessionStore implementation, so a caller that omits `store`
  // (tests, a minimal dev run) still gets the real, fully-featured
  // in-memory store, not a partial stub.
  if (!fallbackStore) {
    fallbackStore = createMemoryStore();
  }
  return fallbackStore;
}
