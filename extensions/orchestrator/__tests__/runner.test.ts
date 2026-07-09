import { describe, expect, it, jest } from '@jest/globals';
import { createOrchestratorRunner, type ToolshedInvoker } from '../src/runner.js';
import { createFakeGooseClient } from '../src/fake-goose-client.js';
import { createInMemoryTestStore } from './test-helpers.js';
import { verifyMinionToken } from 'framework-core';

const SECRET = 'test-signing-secret';

function makeBaseRequest() {
  return {
    platform: 'slack' as const,
    teamId: 'T1',
    channelId: 'C1',
    userId: 'U1',
    text: 'review PR #1',
    threadId: 'ts1',
    sessionId: 'sess_T1:slack:ts1',
    correlationRoot: 'corr_root1',
  };
}

/**
 * A toolshed fake that records every call and returns a fixed status,
 * mirroring the real `verifyAndExecuteTool` shape but with zero governance
 * logic -- used for runner-level unit tests that don't need the real
 * toolshed pipeline (the e2e test in test/src/e2e-review-pr.test.ts DOES use
 * the real mcp-toolshed package, per the milestone's acceptance criteria).
 */
function makeToolshed(status: string = 'success'): { toolshed: ToolshedInvoker; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    toolshed: {
      verifyAndExecuteTool: jest.fn(async (input, serverAlias, toolName, params) => {
        calls.push({ input, serverAlias, toolName, params });
        expect(verifyMinionToken(input.minionToken, SECRET).ok).toBe(true);
        return { status, data: { ok: true } };
      }),
    },
  };
}

describe('createOrchestratorRunner: intent classification', () => {
  it('classifies code_review and runs the code_explorer -> code_reviewer DAG', async () => {
    const store = createInMemoryTestStore();
    const { toolshed } = makeToolshed();
    const goose = createFakeGooseClient({
      toolshed,
      secret: SECRET,
      script: {
        orchestrator: { output: { intent: 'code_review', complexity: 'simple', platform: 'slack' } },
        code_explorer: {
          toolCalls: [{ serverAlias: 'github', toolName: 'github_get_pull_request_diff', params: { number: 1 } }],
          output: { summary: 'Explored PR #1', files_examined: ['a.ts'] },
        },
        code_reviewer: {
          output: { pr_number: 1, approved: true, summary: 'Looks good', findings: [] },
        },
      },
    });

    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET });
    const response = await runner.run(makeBaseRequest());

    expect(response.text).toContain('Looks good');
    expect(response.text).toContain('code_reviewer');

    const runs = store.listMinionRunsBySession('sess_T1:slack:ts1');
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === 'completed')).toBe(true);
    expect(runs.map((r) => r.minionType)).toEqual(['code_explorer', 'code_reviewer']);
  });

  it('replies gracefully when intent classification does not validate against schemas/intent.json', async () => {
    const store = createInMemoryTestStore();
    const { toolshed } = makeToolshed();
    const goose = createFakeGooseClient({
      toolshed,
      secret: SECRET,
      script: {
        orchestrator: { output: { intent: 'not_a_real_intent', complexity: 'simple', platform: 'slack' } },
      },
    });

    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET });
    const response = await runner.run(makeBaseRequest());

    expect(response.text).toMatch(/couldn't classify/i);
    expect(store.listMinionRunsBySession('sess_T1:slack:ts1')).toHaveLength(0);
  });

  it('runs a single-minion DAG for ticket_lookup', async () => {
    const store = createInMemoryTestStore();
    const { toolshed } = makeToolshed();
    const goose = createFakeGooseClient({
      toolshed,
      secret: SECRET,
      script: {
        orchestrator: { output: { intent: 'ticket_lookup', complexity: 'simple', platform: 'slack' } },
        ticket_analyst: {
          output: { summary: 'INC00421 is open', ticket_id: 'INC00421', title: 'Login timeout', status: 'open' },
        },
      },
    });

    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET });
    const response = await runner.run(makeBaseRequest());

    expect(response.text).toContain('INC00421 is open');
    const runs = store.listMinionRunsBySession('sess_T1:slack:ts1');
    expect(runs).toHaveLength(1);
    expect(runs[0].minionType).toBe('ticket_analyst');
  });
});

describe('createOrchestratorRunner: default repoRoot (against the real shipped agents/, schemas/, rules/intents.yaml)', () => {
  it('resolves agents/orchestrator.md, schemas/intent.json, and rules/intents.yaml with no repoRoot override', async () => {
    const store = createInMemoryTestStore();
    const { toolshed } = makeToolshed();
    const goose = createFakeGooseClient({
      toolshed,
      secret: SECRET,
      script: {
        orchestrator: { output: { intent: 'ticket_lookup', complexity: 'simple', platform: 'slack' } },
        ticket_analyst: {
          output: { summary: 'real config works', ticket_id: 'INC1', title: 'A ticket', status: 'open' },
        },
      },
    });

    // No repoRoot override: exercises defaultRepoRoot() against the actual
    // checked-in agents/schemas/rules trees, proving the three-directories-
    // up resolution (mirroring mcp-toolshed's TOOLSHED_REPO_ROOT default)
    // really finds the real files from extensions/orchestrator/src (or the
    // compiled dist/ equivalent).
    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET });
    const response = await runner.run(makeBaseRequest());

    expect(response.text).toContain('real config works');
  });
});

describe('createOrchestratorRunner: minion tokens (Milestone 3 integration)', () => {
  it('mints a distinct, verifiable token per minion with the session id and a unique correlation id', async () => {
    const store = createInMemoryTestStore();
    const { toolshed, calls } = makeToolshed();
    const goose = createFakeGooseClient({
      toolshed,
      secret: SECRET,
      script: {
        orchestrator: { output: { intent: 'code_review', complexity: 'simple', platform: 'slack' } },
        code_explorer: {
          toolCalls: [{ serverAlias: 'github', toolName: 'github_get_pull_request_diff', params: { number: 1 } }],
          output: { summary: 'x', files_examined: [] },
        },
        code_reviewer: {
          toolCalls: [{ serverAlias: 'github', toolName: 'github_get_pull_request', params: { number: 1 } }],
          output: { pr_number: 1, approved: true, summary: 'y', findings: [] },
        },
      },
    });

    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET });
    await runner.run(makeBaseRequest());

    expect(calls).toHaveLength(2);
    const tokens = calls.map((c) => (c as { input: { minionToken: string } }).input.minionToken);
    expect(new Set(tokens).size).toBe(2);
    const payloads = tokens.map((t) => verifyMinionToken(t, SECRET));
    expect(payloads.every((p) => p.ok)).toBe(true);
    expect((payloads[0] as { ok: true; payload: { minionType: string } }).payload.minionType).toBe('code_explorer');
    expect((payloads[1] as { ok: true; payload: { minionType: string } }).payload.minionType).toBe('code_reviewer');
  });
});

describe('createOrchestratorRunner: output contract enforcement (Milestone 10 integration)', () => {
  it('retries once with feedback on an invalid minion output, then succeeds', async () => {
    const store = createInMemoryTestStore();
    const { toolshed } = makeToolshed();
    const goose = createFakeGooseClient({
      toolshed,
      secret: SECRET,
      script: {
        orchestrator: { output: { intent: 'ticket_lookup', complexity: 'simple', platform: 'slack' } },
        ticket_analyst: {
          output: { not_a_valid_field: true }, // missing required "summary"
          retryOutput: { summary: 'Fixed on retry', ticket_id: 'INC1', title: 'A ticket', status: 'open' },
        },
      },
    });

    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET });
    const response = await runner.run(makeBaseRequest());

    expect(response.text).toContain('Fixed on retry');
    const runs = store.listMinionRunsBySession('sess_T1:slack:ts1');
    expect(runs[0].status).toBe('completed');
  });

  it('records a contract_violation MinionRun and replies with a diagnosable error when both attempts are invalid', async () => {
    const store = createInMemoryTestStore();
    const { toolshed } = makeToolshed();
    const goose = createFakeGooseClient({
      toolshed,
      secret: SECRET,
      script: {
        orchestrator: { output: { intent: 'ticket_lookup', complexity: 'simple', platform: 'slack' } },
        ticket_analyst: {
          output: { still: 'invalid' },
          retryOutput: { also: 'invalid' },
        },
      },
    });

    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET });
    const response = await runner.run(makeBaseRequest());

    expect(response.text).toMatch(/schema/i);
    const runs = store.listMinionRunsBySession('sess_T1:slack:ts1');
    expect(runs[0].status).toBe('contract_violation');
  });
});

describe('createOrchestratorRunner: approval_pending (Milestone 4 resume-by-resubmit integration)', () => {
  it('marks the run waiting_approval and replies in-thread when the toolshed returns approval_pending', async () => {
    const store = createInMemoryTestStore();
    const { toolshed } = makeToolshed('approval_pending');
    const goose = createFakeGooseClient({
      toolshed,
      secret: SECRET,
      script: {
        orchestrator: { output: { intent: 'pr_create', complexity: 'simple', platform: 'slack' } },
        code_explorer: {
          output: { summary: 'x', files_examined: [] },
        },
        pr_create: {
          toolCalls: [{ serverAlias: 'github', toolName: 'github_create_pull_request', params: {} }],
          approvalPendingFirst: true,
          output: { branch: 'fix/pr-2', pr_url: 'https://github.com/x/y/pull/2', pr_number: 2, files_changed: ['a.ts'] },
        },
      },
    });

    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET });
    const response = await runner.run(makeBaseRequest());

    expect(response.text).toMatch(/approval/i);
    const runs = store.listMinionRunsBySession('sess_T1:slack:ts1');
    const prRun = runs.find((r) => r.minionType === 'pr_create');
    expect(prRun?.status).toBe('waiting_approval');
  });
});
