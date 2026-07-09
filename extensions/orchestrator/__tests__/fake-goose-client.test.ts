import { describe, expect, it, jest } from '@jest/globals';
import { createFakeGooseClient } from '../src/fake-goose-client.js';
import type { ToolshedInvoker } from '../src/runner.js';

const SECRET = 'test-secret';

function makeToolshed(): { toolshed: ToolshedInvoker; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    toolshed: {
      verifyAndExecuteTool: jest.fn(async (input, serverAlias, toolName, params) => {
        calls.push({ input, serverAlias, toolName, params });
        return { status: 'success', data: {} };
      }),
    },
  };
}

describe('createFakeGooseClient', () => {
  it('throws when no script entry exists for the requested minion type', async () => {
    const { toolshed } = makeToolshed();
    const goose = createFakeGooseClient({ toolshed, secret: SECRET, script: {} });

    await expect(
      goose.runMinion({
        minionType: 'unscripted_minion',
        systemPrompt: 's',
        userContent: 'u',
        sessionId: 'sess_1',
        correlationId: 'corr_1.0',
        minionToken: 'irrelevant-token',
      })
    ).rejects.toThrow(/no scripted turn/);
  });

  it('throws when classifyIntent is called with no "orchestrator" script entry', async () => {
    const { toolshed } = makeToolshed();
    const goose = createFakeGooseClient({ toolshed, secret: SECRET, script: {} });

    await expect(
      goose.classifyIntent({ systemPrompt: 's', userContent: 'u', sessionId: 'sess_1', correlationId: 'corr_1' })
    ).rejects.toThrow(/no scripted turn for minion type "orchestrator"/);
  });

  it('executes scripted toolCalls against the toolshed using the CALLER-SUPPLIED minionToken (the runner-minted one), not a token the fake mints itself', async () => {
    const { toolshed, calls } = makeToolshed();
    const goose = createFakeGooseClient({
      toolshed,
      secret: SECRET,
      script: {
        code_explorer: {
          toolCalls: [{ serverAlias: 'github', toolName: 'github_get_pull_request_diff', params: { number: 1 } }],
          output: { summary: 'x', files_examined: [] },
        },
      },
    });

    await goose.runMinion({
      minionType: 'code_explorer',
      systemPrompt: 's',
      userContent: 'u',
      sessionId: 'sess_1',
      correlationId: 'corr_1.0',
      minionToken: 'a-real-caller-minted-token',
    });

    expect(calls).toHaveLength(1);
    expect((calls[0] as { serverAlias: string }).serverAlias).toBe('github');
    expect((calls[0] as { input: { minionToken: string } }).input.minionToken).toBe('a-real-caller-minted-token');
  });

  it('returns raw output unchanged (JSON-stringified) with no toolCalls scripted', async () => {
    const { toolshed } = makeToolshed();
    const goose = createFakeGooseClient({
      toolshed,
      secret: SECRET,
      script: { ticket_analyst: { output: { summary: 'ok', ticket_id: 'T1', title: 't', status: 'open' } } },
    });

    const response = await goose.runMinion({
      minionType: 'ticket_analyst',
      systemPrompt: 's',
      userContent: 'u',
      sessionId: 'sess_1',
      correlationId: 'corr_1.0',
      minionToken: 'a-real-caller-minted-token',
    });

    expect(JSON.parse(response.raw)).toEqual({ summary: 'ok', ticket_id: 'T1', title: 't', status: 'open' });
  });
});
