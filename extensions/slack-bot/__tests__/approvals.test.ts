import { jest } from '@jest/globals';
import type { PendingApproval } from 'framework-core';
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  postApprovalRequest,
  registerApprovalActions,
  createHttpOperatorClient,
  type ToolshedOperatorClient,
  type BlockActionArgs,
  type ActionRegisterable,
} from '../src/approvals.js';
import type { SlackPoster } from '../src/slack-bot.js';

function makeApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'appr_1',
    sessionId: 's1',
    correlationId: 'corr_1',
    serverAlias: 'github',
    toolName: 'merge_pull_request',
    paramsJson: JSON.stringify({ pr: 1 }),
    requestedAt: 1,
    timeoutAt: 999_999_999_999,
    requestHash: 'hash_1',
    ...overrides,
  };
}

describe('postApprovalRequest (Block Kit wiring, fake poster)', () => {
  it('posts an Approve/Deny Block Kit message summarizing server/tool/params', async () => {
    const postMessage = jest.fn().mockResolvedValue({});
    const poster: SlackPoster = { chat: { postMessage } };

    await postApprovalRequest(poster, 'C123', '1700000000.000100', makeApproval());

    expect(postMessage).toHaveBeenCalledTimes(1);
    const call = postMessage.mock.calls[0][0] as {
      channel: string;
      thread_ts: string;
      text: string;
      blocks: unknown[];
    };
    expect(call.channel).toBe('C123');
    expect(call.thread_ts).toBe('1700000000.000100');
    expect(call.text).toContain('github');
    expect(call.text).toContain('merge_pull_request');

    const actionsBlock = call.blocks[1] as { elements: Array<{ action_id: string; value: string }> };
    expect(actionsBlock.elements).toHaveLength(2);
    expect(actionsBlock.elements[0].action_id).toBe(APPROVE_ACTION_ID);
    expect(actionsBlock.elements[0].value).toBe('appr_1');
    expect(actionsBlock.elements[1].action_id).toBe(DENY_ACTION_ID);
    expect(actionsBlock.elements[1].value).toBe('appr_1');

    const sectionBlock = call.blocks[0] as { text: { text: string } };
    expect(sectionBlock.text.text).toContain('"pr": 1');
  });

  it('falls back to the raw paramsJson string if it is not valid JSON', async () => {
    const postMessage = jest.fn().mockResolvedValue({});
    const poster: SlackPoster = { chat: { postMessage } };

    await postApprovalRequest(poster, 'C123', '1700000000.000100', makeApproval({ paramsJson: 'not-json{{' }));

    const call = postMessage.mock.calls[0][0] as { blocks: unknown[] };
    const sectionBlock = call.blocks[0] as { text: { text: string } };
    expect(sectionBlock.text.text).toContain('not-json{{');
  });
});

describe('approvalNotifier wiring (fake poster, Milestone 4 acceptance: "one wiring test with a fake poster asserting the Block Kit payload")', () => {
  it('a ToolshedState.approvalNotifier built from postApprovalRequest posts the Block Kit payload for a real destructive-gate approval', async () => {
    const postMessage = jest.fn().mockResolvedValue({});
    const poster: SlackPoster = { chat: { postMessage } };

    // This is exactly the shape `ToolshedState.approvalNotifier` expects:
    // `(approval: PendingApproval, ctx: ToolContext) => Promise<void>`, with
    // channel/thread_ts closed over from the originating Slack event (the
    // orchestrator, Milestone 11, is what will supply real values here).
    const notifier = (approval: PendingApproval) => postApprovalRequest(poster, 'C999', '1700000000.000200', approval);

    await notifier(makeApproval({ id: 'appr_wiring', serverAlias: 'github', toolName: 'merge_pull_request' }));

    expect(postMessage).toHaveBeenCalledTimes(1);
    const call = postMessage.mock.calls[0][0] as { channel: string; thread_ts: string; blocks: unknown[] };
    expect(call.channel).toBe('C999');
    expect(call.thread_ts).toBe('1700000000.000200');
    const actionsBlock = call.blocks[1] as { elements: Array<{ action_id: string; value: string }> };
    expect(actionsBlock.elements.map((e) => e.action_id)).toEqual([APPROVE_ACTION_ID, DENY_ACTION_ID]);
    expect(actionsBlock.elements[0].value).toBe('appr_wiring');
  });
});

describe('createHttpOperatorClient', () => {
  it('POSTs to the toolshed operator endpoint with a bearer token and returns the parsed body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      json: async () => ({ status: 'success' }),
    }) as unknown as typeof fetch;

    const client = createHttpOperatorClient('http://localhost:4000', 'op-token', fetchImpl);
    const result = await client.resolveApproval('appr_1', 'approved', { kind: 'slack', id: 'U123' });

    expect(result).toEqual({ status: 'success' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:4000/approvals/appr_1/resolve',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer op-token' }),
        body: JSON.stringify({ decision: 'approved', approverId: 'U123' }),
      })
    );
  });

  it('defaults to the global fetch when no fetchImpl is injected', () => {
    // Only exercising the default-parameter branch — no network call is
    // made, since the test never invokes resolveApproval.
    expect(() => createHttpOperatorClient('http://localhost:4000', 'op-token')).not.toThrow();
  });

  it('URL-encodes the approval id in the resolve path', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ json: async () => ({ status: 'success' }) }) as unknown as typeof fetch;
    const client = createHttpOperatorClient('http://localhost:4000', 'op-token', fetchImpl);
    await client.resolveApproval('appr with space', 'denied', { kind: 'slack', id: 'U1' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:4000/approvals/appr%20with%20space/resolve',
      expect.anything()
    );
  });
});

describe('registerApprovalActions', () => {
  class FakeApp implements ActionRegisterable {
    handlers: Record<string, (args: BlockActionArgs) => Promise<void>> = {};
    action(actionId: string, handler: (args: BlockActionArgs) => Promise<void>): void {
      this.handlers[actionId] = handler;
    }
  }

  function makeArgs(overrides: Partial<BlockActionArgs> = {}): BlockActionArgs {
    return {
      ack: jest.fn().mockResolvedValue(undefined) as unknown as BlockActionArgs['ack'],
      action: { action_id: APPROVE_ACTION_ID, value: 'appr_1' },
      body: {
        user: { id: 'U_APPROVED' },
        channel: { id: 'C123' },
        message: { ts: '1700000000.000100' },
      },
      client: {
        chat: {
          postMessage: jest.fn().mockResolvedValue({}) as unknown as SlackPoster['chat']['postMessage'],
          update: jest.fn().mockResolvedValue({}) as unknown as never,
        },
      } as BlockActionArgs['client'],
      ...overrides,
    };
  }

  it('registers both the approve and deny action handlers', () => {
    const app = new FakeApp();
    const operatorClient: ToolshedOperatorClient = { resolveApproval: jest.fn() as never };
    registerApprovalActions(app, operatorClient, 'U_APPROVED');

    expect(app.handlers[APPROVE_ACTION_ID]).toBeDefined();
    expect(app.handlers[DENY_ACTION_ID]).toBeDefined();
  });

  it('rejects a user not in MINIONS_APPROVERS and edits the message to say so, without calling the toolshed', async () => {
    const app = new FakeApp();
    const resolveApproval = jest.fn().mockResolvedValue({ status: 'success' });
    const log = jest.fn();
    registerApprovalActions(app, { resolveApproval } as unknown as ToolshedOperatorClient, 'U_APPROVED', log);

    const args = makeArgs({ body: { user: { id: 'U_STRANGER' }, channel: { id: 'C123' }, message: { ts: '123' } } });
    await app.handlers[APPROVE_ACTION_ID](args);

    expect(args.ack).toHaveBeenCalled();
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('U_STRANGER'));
    expect(args.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C123', ts: '123', text: expect.stringContaining('not authorized') })
    );
  });

  it('deny-alls (rejects everyone) and logs when MINIONS_APPROVERS is empty', async () => {
    const app = new FakeApp();
    const resolveApproval = jest.fn();
    const log = jest.fn();
    registerApprovalActions(app, { resolveApproval } as unknown as ToolshedOperatorClient, '', log);

    await app.handlers[APPROVE_ACTION_ID](makeArgs());

    expect(resolveApproval).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('deny-all'));
  });

  it('trims and ignores empty entries in a comma-separated MINIONS_APPROVERS list', async () => {
    const app = new FakeApp();
    const resolveApproval = jest.fn().mockResolvedValue({ status: 'success' });
    registerApprovalActions(app, { resolveApproval } as unknown as ToolshedOperatorClient, ' U_APPROVED , ,U_OTHER ');

    await app.handlers[APPROVE_ACTION_ID](makeArgs());
    expect(resolveApproval).toHaveBeenCalledWith('appr_1', 'approved', { kind: 'slack', id: 'U_APPROVED' });
  });

  it('resolves via the operator client with {kind: "slack", id} for an allowlisted approver and updates the message on approve', async () => {
    const app = new FakeApp();
    const resolveApproval = jest.fn().mockResolvedValue({ status: 'success' });
    registerApprovalActions(app, { resolveApproval } as unknown as ToolshedOperatorClient, 'U_APPROVED');

    const args = makeArgs();
    await app.handlers[APPROVE_ACTION_ID](args);

    expect(resolveApproval).toHaveBeenCalledWith('appr_1', 'approved', { kind: 'slack', id: 'U_APPROVED' });
    expect(args.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Approved') })
    );
  });

  it('resolves via the operator client for deny and updates the message to show denial', async () => {
    const app = new FakeApp();
    const resolveApproval = jest.fn().mockResolvedValue({ status: 'success' });
    registerApprovalActions(app, { resolveApproval } as unknown as ToolshedOperatorClient, 'U_APPROVED');

    const args = makeArgs({ action: { action_id: DENY_ACTION_ID, value: 'appr_1' } });
    await app.handlers[DENY_ACTION_ID](args);

    expect(resolveApproval).toHaveBeenCalledWith('appr_1', 'denied', { kind: 'slack', id: 'U_APPROVED' });
    expect(args.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Denied') })
    );
  });

  it('shows a failure message when the operator client reports an error status', async () => {
    const app = new FakeApp();
    const resolveApproval = jest.fn().mockResolvedValue({ status: 'error', error: 'approval not found' });
    registerApprovalActions(app, { resolveApproval } as unknown as ToolshedOperatorClient, 'U_APPROVED');

    const args = makeArgs();
    await app.handlers[APPROVE_ACTION_ID](args);

    expect(args.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('approval not found') })
    );
  });

  it('shows a generic failure message when the operator client reports an error status with no error text', async () => {
    const app = new FakeApp();
    const resolveApproval = jest.fn().mockResolvedValue({ status: 'error' });
    registerApprovalActions(app, { resolveApproval } as unknown as ToolshedOperatorClient, 'U_APPROVED');

    const args = makeArgs();
    await app.handlers[APPROVE_ACTION_ID](args);

    expect(args.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('unknown error') })
    );
  });

  it('does nothing further when channel or message ts is missing on an allowlisted approval', async () => {
    const app = new FakeApp();
    const resolveApproval = jest.fn().mockResolvedValue({ status: 'success' });
    registerApprovalActions(app, { resolveApproval } as unknown as ToolshedOperatorClient, 'U_APPROVED');

    const args = makeArgs({ body: { user: { id: 'U_APPROVED' } } });
    await app.handlers[APPROVE_ACTION_ID](args);

    expect(resolveApproval).toHaveBeenCalled();
    expect(args.client.chat.update).not.toHaveBeenCalled();
  });

  it('does nothing further for a rejected user when channel or message ts is missing', async () => {
    const app = new FakeApp();
    const log = jest.fn();
    registerApprovalActions(app, { resolveApproval: jest.fn() } as unknown as ToolshedOperatorClient, 'U_APPROVED', log);

    const args = makeArgs({ body: { user: { id: 'U_STRANGER' } } });
    await app.handlers[APPROVE_ACTION_ID](args);

    expect(log).toHaveBeenCalled();
    expect(args.client.chat.update).not.toHaveBeenCalled();
  });

  it('uses the default console.warn logger when none is injected', async () => {
    const app = new FakeApp();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    registerApprovalActions(app, { resolveApproval: jest.fn() } as unknown as ToolshedOperatorClient, 'U_APPROVED');

    const args = makeArgs({ body: { user: { id: 'U_STRANGER' }, channel: { id: 'C1' }, message: { ts: '1' } } });
    await app.handlers[APPROVE_ACTION_ID](args);

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
