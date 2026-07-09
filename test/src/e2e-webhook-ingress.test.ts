import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import {
  createDefaultToolshedState,
  createMemoryStore,
  createMockAdapter,
  initializeToolshed,
  loadAllowlists,
  loadGovernance,
  resetToolshed,
  verifyAndExecuteTool,
  type SessionStore,
} from 'mcp-toolshed';
import { createOrchestratorRunner, createFakeGooseClient, type ToolshedInvoker } from 'orchestrator';
import { createWebhookServer, type WebhookServer } from 'webhook-ingress/webhook-ingress.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Milestone 15 (F11) end-to-end test: a REAL `pull_request.opened` GitHub
 * webhook delivery (HTTP POST with a genuine HMAC-SHA256 X-Hub-Signature-256
 * over the raw body) drives the SAME path chat mentions use --
 * `handleIngressMessage` -> the real orchestrator runner -> intent
 * classification -> the `code_review` DAG -> governed tool calls with minted
 * tokens -- and the resulting reply is posted back as a PR comment through
 * the governed toolshed (`github_create_issue_comment`, granted to
 * `code_reviewer`), asserted against the audit log and `MinionRun` rows.
 * Mirrors `e2e-review-pr.test.ts`'s fixture/fake style exactly: real
 * `mcp-toolshed` pipeline, real `rules/*.yaml` loaded from disk, mock GitHub
 * adapter, `FakeGooseClient` -- no network beyond the loopback HTTP request
 * this test itself makes to its own in-process server.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const SECRET = 'e2e-webhook-test-signing-secret';
const GITHUB_WEBHOOK_SECRET = 'e2e-webhook-test-github-secret';

function githubSignature(secret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

function post(port: number, urlPath: string, body: string, headers: Record<string, string>): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://localhost:${port}${urlPath}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

const CANNED_PR = { number: 1, title: 'Fix login timeout', body: 'Fixes the login timeout bug.', state: 'open' };
const CANNED_DIFF = 'diff --git a/src/auth.ts b/src/auth.ts\n+ increase timeout to 30s\n';

describe('e2e: GitHub webhook "pull_request.opened" (Milestone 15, F11)', () => {
  let server: WebhookServer | undefined;

  afterEach(async () => {
    resetToolshed();
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it('drives the full path: verified webhook -> intent classification -> code_review DAG -> governed tool calls -> governed PR-comment reply', async () => {
    const store: SessionStore = createMemoryStore();
    const githubCallTool = jest.fn(async (toolName: string, params: unknown) => {
      if (toolName === 'github_get_pull_request') return CANNED_PR;
      if (toolName === 'github_get_pull_request_diff') return { diff: CANNED_DIFF };
      if (toolName === 'github_create_issue_comment') return { id: 1, body: (params as { body: string }).body, html_url: 'https://github.com/acme/widgets/pull/1#issuecomment-1' };
      throw new Error(`unexpected tool call in webhook e2e test: ${toolName} ${JSON.stringify(params)}`);
    });
    const githubAdapter = createMockAdapter('github', { callTool: githubCallTool });

    initializeToolshed(
      createDefaultToolshedState({
        store,
        adapters: new Map([['github', githubAdapter]]),
        allowlists: loadAllowlists(path.join(REPO_ROOT, 'rules', 'allowlists.yaml')),
        governance: loadGovernance(path.join(REPO_ROOT, 'rules', 'governance.yaml')),
        signingSecret: SECRET,
        allowUnsignedTokens: false,
      })
    );

    const toolshed: ToolshedInvoker = { verifyAndExecuteTool };

    const goose = createFakeGooseClient({
      toolshed,
      secret: SECRET,
      script: {
        orchestrator: { output: { intent: 'code_review', complexity: 'simple', platform: 'webhook' } },
        code_explorer: {
          toolCalls: [{ serverAlias: 'github', toolName: 'github_get_pull_request_diff', params: { number: 1 } }],
          output: {
            summary: 'PR #1 increases the auth timeout to fix premature login expiry.',
            files_examined: ['src/auth.ts'],
            root_cause: 'Timeout was too short under slow network conditions.',
            recommended_next_steps: ['Verify with a load test'],
          },
        },
        code_reviewer: {
          toolCalls: [{ serverAlias: 'github', toolName: 'github_get_pull_request', params: { number: 1 } }],
          output: {
            pr_number: 1,
            approved: true,
            summary: 'Looks good: a minimal, well-scoped timeout fix with a clear root cause.',
            findings: [{ severity: 'info', message: 'Consider adding a regression test for the timeout value.' }],
          },
        },
      },
    });

    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET, repoRoot: REPO_ROOT });

    server = await createWebhookServer({
      runner,
      store,
      githubWebhookSecret: GITHUB_WEBHOOK_SECRET,
      adoUsername: 'unused',
      adoPassword: 'unused',
      port: 0,
      toolshed: { verifyAndExecuteTool },
      signingSecret: SECRET,
    });

    const body = JSON.stringify({
      action: 'opened',
      number: 1,
      pull_request: {
        number: 1,
        title: 'Fix login timeout',
        body: 'Fixes the login timeout bug.',
        base: { repo: { owner: { login: 'acme' }, name: 'widgets' } },
      },
    });

    const response = await post(server.port, '/webhooks/github', body, {
      'X-Hub-Signature-256': githubSignature(GITHUB_WEBHOOK_SECRET, body),
      'X-GitHub-Event': 'pull_request',
    });

    // ASSERT: the webhook ack is fast and does not block on the orchestrator run.
    expect(response.status).toBe(202);

    await flushAsync();
    await flushAsync();

    // ASSERT: the audit log contains ALLOWED calls made WITH VALID TOKENS for
    // both minion tool calls AND the governed PR-comment reply.
    const auditEntries = store.listAuditEntries();

    const diffCallEntry = auditEntries.find((e) => e.toolName === 'github_get_pull_request_diff');
    expect(diffCallEntry?.status).toBe('success');
    expect(diffCallEntry?.minionType).toBe('code_explorer');

    const getPrCallEntry = auditEntries.find((e) => e.toolName === 'github_get_pull_request');
    expect(getPrCallEntry?.status).toBe('success');
    expect(getPrCallEntry?.minionType).toBe('code_reviewer');

    // ASSERT: the reply comment went through the GOVERNED toolshed (a real
    // execute_tool call, real minted token, real audit entry) -- NOT a
    // direct GitHub API call bypassing it.
    const commentCallEntry = auditEntries.find((e) => e.toolName === 'github_create_issue_comment');
    expect(commentCallEntry).toBeDefined();
    expect(commentCallEntry?.status).toBe('success');
    expect(commentCallEntry?.minionType).toBe('code_reviewer');
    expect(githubCallTool).toHaveBeenCalledWith(
      'github_create_issue_comment',
      expect.objectContaining({ owner: 'acme', repo: 'widgets', issue_number: 1 })
    );

    // ASSERT: a MinionRun row exists per minion, keyed under the webhook's
    // deterministic sess_<owner/repo>:webhook:<owner/repo#PR> session id (the
    // M9 session model applied to platform: 'webhook').
    const sessionId = 'sess_acme/widgets:webhook:acme/widgets#1';
    const runs = store.listMinionRunsBySession(sessionId);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.minionType)).toEqual(['code_explorer', 'code_reviewer']);
    expect(runs.every((r) => r.status === 'completed')).toBe(true);
  });

  it('rejects a webhook with a bad signature: 401, and NO downstream work happens at all (zero audit entries, zero adapter calls)', async () => {
    const store: SessionStore = createMemoryStore();
    const githubCallTool = jest.fn(async () => ({ diff: CANNED_DIFF }));
    const githubAdapter = createMockAdapter('github', { callTool: githubCallTool });

    initializeToolshed(
      createDefaultToolshedState({
        store,
        adapters: new Map([['github', githubAdapter]]),
        allowlists: loadAllowlists(path.join(REPO_ROOT, 'rules', 'allowlists.yaml')),
        governance: loadGovernance(path.join(REPO_ROOT, 'rules', 'governance.yaml')),
        signingSecret: SECRET,
        allowUnsignedTokens: false,
      })
    );

    const toolshed: ToolshedInvoker = { verifyAndExecuteTool };
    const goose = createFakeGooseClient({ toolshed, secret: SECRET, script: {} });
    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET, repoRoot: REPO_ROOT });

    server = await createWebhookServer({
      runner,
      store,
      githubWebhookSecret: GITHUB_WEBHOOK_SECRET,
      adoUsername: 'unused',
      adoPassword: 'unused',
      port: 0,
      toolshed: { verifyAndExecuteTool },
      signingSecret: SECRET,
    });

    const body = JSON.stringify({
      action: 'opened',
      number: 1,
      pull_request: {
        number: 1,
        title: 'Fix login timeout',
        body: 'x',
        base: { repo: { owner: { login: 'acme' }, name: 'widgets' } },
      },
    });

    const response = await post(server.port, '/webhooks/github', body, {
      'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64),
      'X-GitHub-Event': 'pull_request',
    });

    expect(response.status).toBe(401);
    await flushAsync();

    expect(githubCallTool).not.toHaveBeenCalled();
    expect(store.listAuditEntries()).toHaveLength(0);
    expect(store.listMinionRunsBySession('sess_acme/widgets:webhook:acme/widgets#1')).toHaveLength(0);
  });
});
