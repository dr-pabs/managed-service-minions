import { afterEach, describe, expect, it, jest } from '@jest/globals';
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
import { createSlackBot, type SlackPoster } from 'slack-bot/slack-bot.js';
import { mintMinionToken } from 'framework-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Milestone 11 end-to-end test (review finding M5 / F8) -- "the plan's
 * highest-leverage test": a fake `app_mention` "review PR #1" drives intent
 * classification, minted tokens, governed tool calls, schema-valid minion
 * outputs, and a threaded reply, asserted against the audit log and
 * `MinionRun` rows. Everything is in-process and network-free:
 *
 * - `SessionStore`: the real `mcp-toolshed` memory store (not a hand-rolled
 *   fake), so the audit log / MinionRun assertions below exercise the real
 *   persistence layer.
 * - Toolshed: the real `mcp-toolshed` pipeline (`executeTool` /
 *   `verifyAndExecuteTool`), initialized with a MOCK GitHub adapter
 *   (`createMockAdapter`, the existing mock-adapter factory) returning a
 *   canned PR + diff, and the REAL `rules/allowlists.yaml` /
 *   `rules/governance.yaml` / `rules/tool-registry.yaml` loaded from disk --
 *   so the allowlist/rate-limit/audit machinery that governs a real deploy
 *   governs this test too.
 * - Goose: `createFakeGooseClient`, scripted so the orchestrator classifies
 *   `code_review` and the two minions (`code_explorer`, `code_reviewer`)
 *   return schema-valid outputs after calling `execute_tool` for the diff
 *   (via the fake's `toolCalls`, which mint a real per-minion token and
 *   invoke the real toolshed -- see `extensions/orchestrator/src/fake-goose-client.ts`).
 * - Slack: a fake Bolt `App` (mirrors `extensions/slack-bot/__tests__/slack-bot.test.ts`'s
 *   `MockApp`) and a fake poster capturing `postMessage` calls -- no real
 *   `@slack/bolt` HTTP server, no real Slack API.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const SECRET = 'e2e-test-signing-secret';

class FakeBoltApp {
  public eventHandlers: Record<string, (args: unknown) => Promise<void>> = {};
  public messageHandlers: Array<(args: unknown) => Promise<void>> = [];

  event = jest.fn((name: string, handler: (args: unknown) => Promise<void>) => {
    this.eventHandlers[name] = handler;
  });

  message = jest.fn((handler: (args: unknown) => Promise<void>) => {
    this.messageHandlers.push(handler);
  });

  start = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  stop = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
}

function makeFakePoster(): { poster: SlackPoster; posted: Array<{ channel: string; thread_ts?: string; text: string }> } {
  const posted: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  return {
    posted,
    poster: {
      chat: {
        postMessage: jest.fn(async (args: { channel: string; thread_ts?: string; text: string }) => {
          posted.push(args);
          return {};
        }),
      },
    },
  };
}

// Drain the microtask queue so the fire-and-forget `void postSlackResponse(...)`
// inside createSlackBot's app_mention handler completes before assertions run.
function flushAsync(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const CANNED_PR = { number: 1, title: 'Fix login timeout', body: 'Fixes the login timeout bug.', state: 'open' };
const CANNED_DIFF = 'diff --git a/src/auth.ts b/src/auth.ts\n+ increase timeout to 30s\n';

describe('e2e: "@minions review PR #1" (Milestone 11, M5/F8)', () => {
  afterEach(() => {
    resetToolshed();
  });

  it('drives the full path: Slack ack -> intent classification -> minted tokens -> governed tool calls -> schema-valid minion outputs -> threaded reply -> MinionRun rows', async () => {
    // --- Toolshed: real pipeline, real rules/*.yaml, mock GitHub adapter ---
    const store: SessionStore = createMemoryStore();
    const githubCallTool = jest.fn(async (toolName: string, params: unknown) => {
      if (toolName === 'github_get_pull_request') return CANNED_PR;
      if (toolName === 'github_get_pull_request_diff') return { diff: CANNED_DIFF };
      throw new Error(`unexpected tool call in e2e test: ${toolName} ${JSON.stringify(params)}`);
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

    // --- Goose: fake client, scripted per-minion turns that call execute_tool for real ---
    const goose = createFakeGooseClient({
      toolshed,
      secret: SECRET,
      script: {
        orchestrator: { output: { intent: 'code_review', complexity: 'simple', platform: 'slack' } },
        code_explorer: {
          toolCalls: [
            { serverAlias: 'github', toolName: 'github_get_pull_request_diff', params: { number: 1 } },
          ],
          output: {
            summary: 'PR #1 increases the auth timeout to fix premature login expiry.',
            files_examined: ['src/auth.ts'],
            root_cause: 'Timeout was too short under slow network conditions.',
            recommended_next_steps: ['Verify with a load test'],
          },
        },
        code_reviewer: {
          toolCalls: [
            { serverAlias: 'github', toolName: 'github_get_pull_request', params: { number: 1 } },
          ],
          output: {
            pr_number: 1,
            approved: true,
            summary: 'Looks good: a minimal, well-scoped timeout fix with a clear root cause.',
            findings: [{ severity: 'info', message: 'Consider adding a regression test for the timeout value.' }],
          },
        },
      },
    });

    // --- Orchestrator runner ---
    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET, repoRoot: REPO_ROOT });

    // --- Fake Slack app + fake poster ---
    const app = new FakeBoltApp();
    const { poster, posted } = makeFakePoster();
    const bot = createSlackBot(app as never, store, runner, { signingSecret: 'x', token: 'y' });
    void bot; // start()/stop() are not exercised; only the registered handlers are fired directly.

    // --- Fire the app_mention event ---
    await app.eventHandlers['app_mention']({
      event: {
        type: 'app_mention',
        text: '<@U_MINIONS> review PR #1',
        team: 'T_E2E',
        channel: 'C_E2E',
        user: 'U_HUMAN',
        ts: '1720000000.000100',
      },
      say: jest.fn(async (text: string) => {
        posted.push({ channel: 'C_E2E', text });
      }),
      client: poster,
    });

    await flushAsync();
    await flushAsync();

    // ASSERT: the ack posted immediately.
    expect(posted.some((p) => p.text.includes('Working on it'))).toBe(true);

    // ASSERT: the final threaded reply contains the reviewer's summary.
    const finalReply = posted.find((p) => p.text.includes('well-scoped timeout fix'));
    expect(finalReply).toBeDefined();
    expect(finalReply?.thread_ts).toBe('1720000000.000100');
    expect(finalReply?.channel).toBe('C_E2E');

    // ASSERT: the audit log contains ALLOWED github_get_pull_request_diff
    // calls made WITH VALID TOKENS (this exercises M3 end to end -- a
    // rejected/forged token would show up as status 'error' with
    // minionType 'unverified', never 'success' with a real minionType).
    const auditEntries = store.listAuditEntries();
    const diffCallEntry = auditEntries.find((e) => e.toolName === 'github_get_pull_request_diff');
    expect(diffCallEntry).toBeDefined();
    expect(diffCallEntry?.status).toBe('success');
    expect(diffCallEntry?.minionType).toBe('code_explorer');
    expect(diffCallEntry?.minionType).not.toBe('unverified');

    const getPrCallEntry = auditEntries.find((e) => e.toolName === 'github_get_pull_request');
    expect(getPrCallEntry).toBeDefined();
    expect(getPrCallEntry?.status).toBe('success');
    expect(getPrCallEntry?.minionType).toBe('code_reviewer');

    // The mock GitHub adapter was really invoked (not short-circuited by a
    // stale/incorrect cache entry from a prior test or a bad TTL).
    expect(githubCallTool).toHaveBeenCalledWith('github_get_pull_request_diff', { number: 1 });
    expect(githubCallTool).toHaveBeenCalledWith('github_get_pull_request', { number: 1 });

    // ASSERT: a MinionRun row exists per minion with status: 'completed'.
    const sessionId = `sess_T_E2E:slack:1720000000.000100`;
    const runs = store.listMinionRunsBySession(sessionId);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.minionType)).toEqual(['code_explorer', 'code_reviewer']);
    expect(runs.every((r) => r.status === 'completed')).toBe(true);
    expect(runs.every((r) => typeof r.resultJson === 'string' && r.resultJson.length > 0)).toBe(true);
    expect(runs.every((r) => typeof r.completedAt === 'number')).toBe(true);
  });

  it('rejects a forged minion token end to end: a call with a token minted under the WRONG secret never reaches the adapter and is audited as unverified', async () => {
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
    // A "goose" scripted the same as the happy-path test, but the CALLER
    // (not the fake) mints the token under a DIFFERENT secret -- simulating
    // a prompt-injected or misbehaving model presenting a forged token to
    // call a tool as an arbitrary minion type. This is exactly what
    // FakeGooseClient's minionToken parameter is for: the fake never mints
    // its own token for runMinion (only the orchestrator runner does, in
    // production and in the happy-path test above), so a forged-token
    // scenario is expressed by the test supplying a bad one directly.
    const forgedGoose = createFakeGooseClient({
      toolshed,
      secret: SECRET,
      script: {
        code_explorer: {
          toolCalls: [{ serverAlias: 'github', toolName: 'github_get_pull_request_diff', params: { number: 1 } }],
          output: { summary: 'irrelevant', files_examined: [] },
        },
      },
    });

    const forgedToken = mintMinionToken(
      { minionType: 'code_explorer', sessionId: 'sess_forged', correlationId: 'corr_forged.0' },
      'attacker-controlled-secret'
    );

    await forgedGoose.runMinion({
      minionType: 'code_explorer',
      systemPrompt: 's',
      userContent: 'u',
      sessionId: 'sess_forged',
      correlationId: 'corr_forged.0',
      minionToken: forgedToken,
    });

    expect(githubCallTool).not.toHaveBeenCalled();
    const entries = store.listAuditEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('error');
    expect(entries[0].minionType).toBe('unverified');
  });
});
