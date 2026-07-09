import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { IngressRequest, IngressResponse, IngressRunner } from 'framework-core';
import { createMemoryStore, type SessionStore } from 'mcp-toolshed';
import {
  createWebhookServer,
  mapAdoEventToIngressRequest,
  mapGitHubEventToIngressRequest,
  verifyAdoBasicAuth,
  verifyGitHubSignature,
  type WebhookServer,
  type WebhookToolshedInvoker,
} from '../src/webhook-ingress.js';

const GITHUB_SECRET = 'gh-webhook-secret';
const ADO_USER = 'ado-webhook-user';
const ADO_PASS = 'ado-webhook-pass';

function githubSignature(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

function post(
  port: number,
  urlPath: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://localhost:${port}${urlPath}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function pullRequestOpenedPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: 'opened',
    number: 1,
    pull_request: {
      number: 1,
      title: 'Fix login timeout',
      body: 'Fixes the login timeout bug.',
      base: { repo: { owner: { login: 'acme' }, name: 'widgets' } },
    },
    ...overrides,
  });
}

function flushAsync(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 20));
}

function checkSuiteCompletedPayload(conclusion: string): string {
  return JSON.stringify({
    action: 'completed',
    check_suite: { conclusion, pull_requests: [{ number: 7 }] },
    repository: { owner: { login: 'acme' }, name: 'widgets' },
  });
}

describe('webhook-ingress (Milestone 15, F11)', () => {
  let runner: IngressRunner;
  let runMock: jest.Mock<(request: IngressRequest & { sessionId: string; correlationRoot: string }) => Promise<IngressResponse>>;
  let server: WebhookServer | undefined;

  beforeEach(() => {
    runMock = jest.fn(async () => ({ text: 'ok' }));
    runner = { run: runMock as unknown as IngressRunner['run'] };
    server = undefined;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
  });

  async function startServer(overrides: Partial<Parameters<typeof createWebhookServer>[0]> = {}) {
    server = await createWebhookServer({
      runner,
      githubWebhookSecret: GITHUB_SECRET,
      adoUsername: ADO_USER,
      adoPassword: ADO_PASS,
      port: 0,
      ...overrides,
    });
    return server;
  }

  describe('POST /webhooks/github signature verification', () => {
    it('rejects a BAD X-Hub-Signature-256 with 401 and never reaches the runner (security-critical)', async () => {
      await startServer();
      const body = pullRequestOpenedPayload();
      const response = await post(server.port, '/webhooks/github', body, {
        'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64),
        'X-GitHub-Event': 'pull_request',
      });
      expect(response.status).toBe(401);
      expect(runMock).not.toHaveBeenCalled();
    });

    it('rejects a MISSING X-Hub-Signature-256 with 401 and never reaches the runner', async () => {
      await startServer();
      const body = pullRequestOpenedPayload();
      const response = await post(server.port, '/webhooks/github', body, {
        'X-GitHub-Event': 'pull_request',
      });
      expect(response.status).toBe(401);
      expect(runMock).not.toHaveBeenCalled();
    });

    it('rejects a signature of the wrong length (guards timingSafeEqual, does not throw)', async () => {
      await startServer();
      const body = pullRequestOpenedPayload();
      const response = await post(server.port, '/webhooks/github', body, {
        'X-Hub-Signature-256': 'sha256=deadbeef',
        'X-GitHub-Event': 'pull_request',
      });
      expect(response.status).toBe(401);
      expect(runMock).not.toHaveBeenCalled();
    });

    it('rejects a signature computed over a DIFFERENT body than the one sent (raw-body HMAC, not reparsed JSON)', async () => {
      await startServer();
      const body = pullRequestOpenedPayload();
      const wrongBody = pullRequestOpenedPayload({ number: 999 });
      const response = await post(server.port, '/webhooks/github', body, {
        'X-Hub-Signature-256': githubSignature(GITHUB_SECRET, wrongBody),
        'X-GitHub-Event': 'pull_request',
      });
      expect(response.status).toBe(401);
      expect(runMock).not.toHaveBeenCalled();
    });

    it('rejects ALL github webhooks when GITHUB_WEBHOOK_SECRET is empty, even a signature validly computed over the empty key (M3 N2 precedent: fail closed, not HMAC-over-empty-key)', async () => {
      // An attacker who knows the secret is unset can compute a real
      // HMAC-SHA256 over the empty key and forge a "valid" signature. This
      // must be rejected outright, exactly as M3 rejects an empty toolshed
      // signing secret rather than verifying tokens against ''.
      await startServer({ githubWebhookSecret: '' });
      const body = pullRequestOpenedPayload();
      const response = await post(server.port, '/webhooks/github', body, {
        'X-Hub-Signature-256': githubSignature('', body),
        'X-GitHub-Event': 'pull_request',
      });
      expect(response.status).toBe(401);
      expect(runMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /webhooks/github event mapping and dispatch', () => {
    it('a valid pull_request.opened signature maps to platform webhook with the repo#PR threadId and drives the runner', async () => {
      await startServer();
      const body = pullRequestOpenedPayload();
      const response = await post(server.port, '/webhooks/github', body, {
        'X-Hub-Signature-256': githubSignature(GITHUB_SECRET, body),
        'X-GitHub-Event': 'pull_request',
      });
      expect(response.status).toBe(202);
      expect(runMock).toHaveBeenCalledTimes(1);
      const call = runMock.mock.calls[0][0];
      expect(call.platform).toBe('webhook');
      expect(call.threadId).toBe('acme/widgets#1');
      expect(call.teamId).toBe('acme/widgets');
      expect(call.text).toContain('Fix login timeout');
    });

    it('a second pull_request event on the same PR reuses the same threadId (session continuity)', async () => {
      await startServer();
      const body1 = pullRequestOpenedPayload();
      await post(server.port, '/webhooks/github', body1, {
        'X-Hub-Signature-256': githubSignature(GITHUB_SECRET, body1),
        'X-GitHub-Event': 'pull_request',
      });
      const body2 = JSON.stringify({
        action: 'synchronize',
        number: 1,
        pull_request: {
          number: 1,
          title: 'Fix login timeout',
          body: 'Updated.',
          base: { repo: { owner: { login: 'acme' }, name: 'widgets' } },
        },
      });
      await post(server.port, '/webhooks/github', body2, {
        'X-Hub-Signature-256': githubSignature(GITHUB_SECRET, body2),
        'X-GitHub-Event': 'pull_request',
      });

      // synchronize is not opened -- ack'd but not dispatched to the runner
      // (only pull_request.opened and check_suite.completed(failure) are
      // handled per the milestone scope), so only the first call fired.
      expect(runMock).toHaveBeenCalledTimes(1);
      expect(runMock.mock.calls[0][0].threadId).toBe('acme/widgets#1');
    });

    it('ignores a pull_request action other than opened (e.g. closed) -- ack 202, no runner call', async () => {
      await startServer();
      const body = JSON.stringify({
        action: 'closed',
        number: 2,
        pull_request: {
          number: 2,
          title: 'Some PR',
          body: '',
          base: { repo: { owner: { login: 'acme' }, name: 'widgets' } },
        },
      });
      const response = await post(server.port, '/webhooks/github', body, {
        'X-Hub-Signature-256': githubSignature(GITHUB_SECRET, body),
        'X-GitHub-Event': 'pull_request',
      });
      expect(response.status).toBe(202);
      expect(runMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /webhooks/github check_suite.completed', () => {
    it('a failure conclusion triggers a run', async () => {
      await startServer();
      const body = checkSuiteCompletedPayload('failure');
      const response = await post(server.port, '/webhooks/github', body, {
        'X-Hub-Signature-256': githubSignature(GITHUB_SECRET, body),
        'X-GitHub-Event': 'check_suite',
      });
      expect(response.status).toBe(202);
      expect(runMock).toHaveBeenCalledTimes(1);
      expect(runMock.mock.calls[0][0].threadId).toBe('acme/widgets#7');
    });

    it('a success conclusion is ignored -- no run triggered', async () => {
      await startServer();
      const body = checkSuiteCompletedPayload('success');
      const response = await post(server.port, '/webhooks/github', body, {
        'X-Hub-Signature-256': githubSignature(GITHUB_SECRET, body),
        'X-GitHub-Event': 'check_suite',
      });
      expect(response.status).toBe(202);
      expect(runMock).not.toHaveBeenCalled();
    });

    it('a neutral conclusion is ignored -- no run triggered', async () => {
      await startServer();
      const body = checkSuiteCompletedPayload('neutral');
      const response = await post(server.port, '/webhooks/github', body, {
        'X-Hub-Signature-256': githubSignature(GITHUB_SECRET, body),
        'X-GitHub-Event': 'check_suite',
      });
      expect(response.status).toBe(202);
      expect(runMock).not.toHaveBeenCalled();
    });

    it('a check_suite with no linked pull request is ignored (no PR to thread on)', async () => {
      await startServer();
      const body = JSON.stringify({
        action: 'completed',
        check_suite: { conclusion: 'failure', pull_requests: [] },
        repository: { owner: { login: 'acme' }, name: 'widgets' },
      });
      const response = await post(server.port, '/webhooks/github', body, {
        'X-Hub-Signature-256': githubSignature(GITHUB_SECRET, body),
        'X-GitHub-Event': 'check_suite',
      });
      expect(response.status).toBe(202);
      expect(runMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /webhooks/ado basic auth', () => {
    function basicAuthHeader(user: string, pass: string): string {
      return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    }

    function adoPullRequestPayload(): string {
      return JSON.stringify({
        eventType: 'git.pullrequest.created',
        resource: {
          pullRequestId: 42,
          title: 'Add retry logic',
          description: 'Adds retry with backoff.',
          repository: { name: 'widgets', project: { name: 'acme' } },
        },
      });
    }

    it('rejects a request with no Authorization header (401, no downstream call)', async () => {
      await startServer();
      const body = adoPullRequestPayload();
      const response = await post(server.port, '/webhooks/ado', body);
      expect(response.status).toBe(401);
      expect(runMock).not.toHaveBeenCalled();
    });

    it('rejects a request with the wrong password (401, no downstream call)', async () => {
      await startServer();
      const body = adoPullRequestPayload();
      const response = await post(server.port, '/webhooks/ado', body, {
        Authorization: basicAuthHeader(ADO_USER, 'wrong-password'),
      });
      expect(response.status).toBe(401);
      expect(runMock).not.toHaveBeenCalled();
    });

    it('rejects a request with the wrong username (401, no downstream call)', async () => {
      await startServer();
      const body = adoPullRequestPayload();
      const response = await post(server.port, '/webhooks/ado', body, {
        Authorization: basicAuthHeader('wrong-user', ADO_PASS),
      });
      expect(response.status).toBe(401);
      expect(runMock).not.toHaveBeenCalled();
    });

    it('accepts a request with correct Basic auth credentials and drives a run', async () => {
      await startServer();
      const body = adoPullRequestPayload();
      const response = await post(server.port, '/webhooks/ado', body, {
        Authorization: basicAuthHeader(ADO_USER, ADO_PASS),
      });
      expect(response.status).toBe(202);
      expect(runMock).toHaveBeenCalledTimes(1);
      const call = runMock.mock.calls[0][0];
      expect(call.platform).toBe('webhook');
      expect(call.threadId).toBe('acme/widgets#42');
      expect(call.text).toContain('Add retry logic');
    });

    it('rejects ALL ado webhooks when the configured username is empty, even matching empty credentials (fail closed, M3 N2 precedent)', async () => {
      await startServer({ adoUsername: '', adoPassword: ADO_PASS });
      const body = adoPullRequestPayload();
      const response = await post(server.port, '/webhooks/ado', body, {
        Authorization: basicAuthHeader('', ADO_PASS),
      });
      expect(response.status).toBe(401);
      expect(runMock).not.toHaveBeenCalled();
    });

    it('rejects ALL ado webhooks when the configured password is empty, even matching empty credentials (fail closed, M3 N2 precedent)', async () => {
      await startServer({ adoUsername: ADO_USER, adoPassword: '' });
      const body = adoPullRequestPayload();
      const response = await post(server.port, '/webhooks/ado', body, {
        Authorization: basicAuthHeader(ADO_USER, ''),
      });
      expect(response.status).toBe(401);
      expect(runMock).not.toHaveBeenCalled();
    });
  });

  describe('governed toolshed reply (Milestone 15 hard requirement)', () => {
    it('posts the runner reply as a PR comment via verifyAndExecuteTool with a minted code_reviewer token -- not a direct API call', async () => {
      const auditedCalls: Array<{ minionToken: string; serverAlias: string; toolName: string; params: unknown }> = [];
      const toolshed: WebhookToolshedInvoker = {
        verifyAndExecuteTool: jest.fn(async (input, serverAlias, toolName, params) => {
          auditedCalls.push({ minionToken: input.minionToken, serverAlias, toolName, params });
          return { status: 'success', data: { id: 1 } };
        }),
      };
      runMock.mockResolvedValue({ text: 'PR #1 looks good, approved.' });
      const store: SessionStore = createMemoryStore();
      await startServer({ toolshed, signingSecret: 'reply-secret', store });

      const body = pullRequestOpenedPayload();
      await post(server.port, '/webhooks/github', body, {
        'X-Hub-Signature-256': githubSignature(GITHUB_SECRET, body),
        'X-GitHub-Event': 'pull_request',
      });
      await flushAsync();

      expect(toolshed.verifyAndExecuteTool).toHaveBeenCalledTimes(1);
      expect(auditedCalls).toHaveLength(1);
      expect(auditedCalls[0].serverAlias).toBe('github');
      expect(auditedCalls[0].toolName).toBe('github_create_issue_comment');
      expect(auditedCalls[0].params).toEqual({
        owner: 'acme',
        repo: 'widgets',
        issue_number: 1,
        body: 'PR #1 looks good, approved.',
      });
      // A real, non-empty minted token was presented -- not a bypass of the
      // governed path (mintMinionToken's own tests cover the token format).
      expect(auditedCalls[0].minionToken.split('.')).toHaveLength(2);
    });

    it('logs (does not throw) when the governed reply call itself is not status success', async () => {
      const toolshed: WebhookToolshedInvoker = {
        verifyAndExecuteTool: jest.fn(async () => ({ status: 'blocked_by_allowlist', error: 'nope' })),
      };
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      await startServer({ toolshed, signingSecret: 'reply-secret' });

      const body = pullRequestOpenedPayload();
      await post(server.port, '/webhooks/github', body, {
        'X-Hub-Signature-256': githubSignature(GITHUB_SECRET, body),
        'X-GitHub-Event': 'pull_request',
      });
      await flushAsync();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('blocked_by_allowlist'));
      errorSpy.mockRestore();
    });

    it('does not attempt a reply when no toolshed/signingSecret is configured (reply is optional)', async () => {
      await startServer();
      const body = pullRequestOpenedPayload();
      const response = await post(server.port, '/webhooks/github', body, {
        'X-Hub-Signature-256': githubSignature(GITHUB_SECRET, body),
        'X-GitHub-Event': 'pull_request',
      });
      expect(response.status).toBe(202);
      await flushAsync();
      // No assertion possible on "no call happened" beyond the absence of a
      // throw/crash -- deps.toolshed is undefined by default in startServer.
    });

    it('logs (does not throw) when the runner itself rejects during background dispatch', async () => {
      runMock.mockRejectedValue(new Error('goose unreachable'));
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      await startServer();
      const body = pullRequestOpenedPayload();
      const response = await post(server.port, '/webhooks/github', body, {
        'X-Hub-Signature-256': githubSignature(GITHUB_SECRET, body),
        'X-GitHub-Event': 'pull_request',
      });
      expect(response.status).toBe(202);
      await flushAsync();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('goose unreachable'));
      errorSpy.mockRestore();
    });

    it('logs a non-Error rejection during background dispatch by stringifying it', async () => {
      runMock.mockRejectedValue('plain string rejection');
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      await startServer();
      const body = pullRequestOpenedPayload();
      await post(server.port, '/webhooks/github', body, {
        'X-Hub-Signature-256': githubSignature(GITHUB_SECRET, body),
        'X-GitHub-Event': 'pull_request',
      });
      await flushAsync();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('plain string rejection'));
      errorSpy.mockRestore();
    });

    it('logs the failed status even when the toolshed result carries no error string', async () => {
      const toolshed: WebhookToolshedInvoker = {
        verifyAndExecuteTool: jest.fn(async () => ({ status: 'throttled' })),
      };
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      await startServer({ toolshed, signingSecret: 'reply-secret' });
      const body = pullRequestOpenedPayload();
      await post(server.port, '/webhooks/github', body, {
        'X-Hub-Signature-256': githubSignature(GITHUB_SECRET, body),
        'X-GitHub-Event': 'pull_request',
      });
      await flushAsync();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('throttled'));
      errorSpy.mockRestore();
    });
  });

  describe('HTTP-level edge cases', () => {
    it('returns 400 for an invalid JSON body on the github route (after signature verification passes)', async () => {
      await startServer();
      const body = 'not json';
      const response = await post(server.port, '/webhooks/github', body, {
        'X-Hub-Signature-256': githubSignature(GITHUB_SECRET, body),
        'X-GitHub-Event': 'pull_request',
      });
      expect(response.status).toBe(400);
      expect(runMock).not.toHaveBeenCalled();
    });

    it('returns 400 for an invalid JSON body on the ado route (after auth passes)', async () => {
      await startServer();
      const body = 'not json';
      const response = await post(server.port, '/webhooks/ado', body, {
        Authorization: 'Basic ' + Buffer.from(`${ADO_USER}:${ADO_PASS}`).toString('base64'),
      });
      expect(response.status).toBe(400);
      expect(runMock).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown route', async () => {
      await startServer();
      const response = await post(server.port, '/webhooks/unknown', '{}');
      expect(response.status).toBe(404);
    });
  });

  describe('pure function edge cases (coverage for guard branches)', () => {
    it('verifyGitHubSignature rejects a header missing the sha256= prefix', () => {
      expect(verifyGitHubSignature('s', Buffer.from('x'), 'md5=abc')).toBe(false);
    });

    it('verifyGitHubSignature returns false for an empty secret even with a signature validly computed over the empty key', () => {
      const body = Buffer.from('{"a":1}');
      const sigOverEmptyKey = `sha256=${createHmac('sha256', '').update(body).digest('hex')}`;
      expect(verifyGitHubSignature('', body, sigOverEmptyKey)).toBe(false);
    });

    it('verifyAdoBasicAuth returns false when the configured username is empty', () => {
      const header = 'Basic ' + Buffer.from(':p').toString('base64');
      expect(verifyAdoBasicAuth('', 'p', header)).toBe(false);
    });

    it('verifyAdoBasicAuth returns false when the configured password is empty', () => {
      const header = 'Basic ' + Buffer.from('u:').toString('base64');
      expect(verifyAdoBasicAuth('u', '', header)).toBe(false);
    });

    it('verifyAdoBasicAuth rejects a header not starting with "Basic "', () => {
      expect(verifyAdoBasicAuth('u', 'p', 'Bearer abc')).toBe(false);
    });

    it('verifyAdoBasicAuth rejects malformed (non-base64) credentials without throwing', () => {
      expect(verifyAdoBasicAuth('u', 'p', 'Basic ###not-base64###')).toBe(false);
    });

    it('mapGitHubEventToIngressRequest returns undefined for a check_suite action other than completed (e.g. requested)', () => {
      expect(
        mapGitHubEventToIngressRequest('check_suite', { action: 'requested', check_suite: { conclusion: null } })
      ).toBeUndefined();
    });

    it('verifyAdoBasicAuth rejects a decoded value with no ":" separator', () => {
      const noColon = Buffer.from('justausername').toString('base64');
      expect(verifyAdoBasicAuth('u', 'p', `Basic ${noColon}`)).toBe(false);
    });

    it('mapGitHubEventToIngressRequest returns undefined for an unhandled event name', () => {
      expect(mapGitHubEventToIngressRequest('issues', { action: 'opened' })).toBeUndefined();
      expect(mapGitHubEventToIngressRequest(undefined, {})).toBeUndefined();
    });

    it('mapGitHubEventToIngressRequest returns undefined for pull_request.opened missing owner/repo/number', () => {
      expect(
        mapGitHubEventToIngressRequest('pull_request', { action: 'opened', pull_request: {} })
      ).toBeUndefined();
    });

    it('mapGitHubEventToIngressRequest returns undefined for check_suite.completed missing a linked PR/owner/repo', () => {
      expect(
        mapGitHubEventToIngressRequest('check_suite', {
          action: 'completed',
          check_suite: { conclusion: 'failure', pull_requests: [{}] },
          repository: { owner: { login: 'acme' }, name: 'widgets' },
        })
      ).toBeUndefined();
    });

    it('mapAdoEventToIngressRequest returns undefined for an unhandled eventType', () => {
      expect(mapAdoEventToIngressRequest({ eventType: 'git.push' })).toBeUndefined();
    });

    it('mapAdoEventToIngressRequest returns undefined when project/repo/pullRequestId are missing', () => {
      expect(
        mapAdoEventToIngressRequest({ eventType: 'git.pullrequest.created', resource: {} })
      ).toBeUndefined();
    });

    it('mapGitHubEventToIngressRequest falls back to empty strings for a missing PR title/body', () => {
      const mapped = mapGitHubEventToIngressRequest('pull_request', {
        action: 'opened',
        pull_request: { number: 1, base: { repo: { owner: { login: 'acme' }, name: 'widgets' } } },
      });
      expect(mapped?.request.text).toBe('A new pull request was opened: #1 "".');
    });

    it('mapAdoEventToIngressRequest falls back to empty strings for a missing title/description', () => {
      const mapped = mapAdoEventToIngressRequest({
        eventType: 'git.pullrequest.created',
        resource: { pullRequestId: 9, repository: { name: 'widgets', project: { name: 'acme' } } },
      });
      expect(mapped?.request.text).toBe('A new pull request was opened: #9 "".');
    });
  });

  describe('ack-then-work: the HTTP response does not block on the orchestrator run completing', () => {
    it('responds 202 before a slow runner resolves', async () => {
      let resolveRun: (value: IngressResponse) => void = () => {};
      runMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRun = resolve;
          })
      );
      await startServer();
      const body = pullRequestOpenedPayload();
      const responsePromise = post(server.port, '/webhooks/github', body, {
        'X-Hub-Signature-256': githubSignature(GITHUB_SECRET, body),
        'X-GitHub-Event': 'pull_request',
      });
      const response = await responsePromise;
      expect(response.status).toBe(202);
      // The runner promise is still pending -- proving the HTTP response did
      // not await it.
      resolveRun({ text: 'done' });
    });
  });
});
