import type { PendingApproval } from 'framework-core';
import type { SlackPoster } from './slack-bot.js';

/**
 * Chat-visible approvals (Milestone 4, H3/F1): posts an Approve/Deny Block
 * Kit message into the originating thread for a destructive tool call, and
 * wires the button clicks back to the toolshed's operator HTTP endpoint.
 *
 * The toolshed and this bot are separate processes, so resolving an
 * approval from a button click goes over HTTP (`resolveApprovalViaHttp`)
 * to `POST /approvals/:id/resolve` — never by importing `mcp-toolshed`'s
 * internal `resolveApprovalRecord` directly, which would require sharing a
 * process and a `SessionStore` instance neither side actually shares in
 * production.
 */

export const APPROVE_ACTION_ID = 'minions_approve';
export const DENY_ACTION_ID = 'minions_deny';

/** Duck-typed subset of a Slack `params` object passed to `postMessage`. */
export interface ApprovalSummary {
  serverAlias: string;
  toolName: string;
  paramsJson: string;
}

function approvalBlocks(approval: PendingApproval): unknown[] {
  let paramsPretty = approval.paramsJson;
  try {
    paramsPretty = JSON.stringify(JSON.parse(approval.paramsJson), null, 2);
  } catch {
    // Leave paramsPretty as the raw string if it's somehow not valid JSON.
  }
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:warning: *Approval required*\n*Server:* \`${approval.serverAlias}\`\n*Tool:* \`${approval.toolName}\`\n*Params:*\n\`\`\`${paramsPretty}\`\`\``,
      },
    },
    {
      type: 'actions',
      block_id: `minions_approval_${approval.id}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve' },
          style: 'primary',
          action_id: APPROVE_ACTION_ID,
          value: approval.id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny' },
          style: 'danger',
          action_id: DENY_ACTION_ID,
          value: approval.id,
        },
      ],
    },
  ];
}

/**
 * Posts the Approve/Deny Block Kit message into the thread that originated
 * the destructive call. This is the function wired in as (or called from)
 * `ToolshedState.approvalNotifier` for the Slack ingress path.
 */
export async function postApprovalRequest(
  poster: SlackPoster,
  channel: string,
  thread_ts: string,
  approval: PendingApproval
): Promise<unknown> {
  return poster.chat.postMessage({
    channel,
    thread_ts,
    text: `Approval required: ${approval.serverAlias}.${approval.toolName}`,
    blocks: approvalBlocks(approval),
  });
}

/** What the action handler needs to talk to the toolshed's operator HTTP endpoint. */
export interface ToolshedOperatorClient {
  resolveApproval(
    approvalId: string,
    decision: 'approved' | 'denied',
    approver: { kind: 'slack'; id: string }
  ): Promise<{ status: string; error?: string }>;
}

/**
 * `fetch`-backed `ToolshedOperatorClient`. Kept separate from the handler
 * itself so tests can inject a fake client with no network at all.
 */
export function createHttpOperatorClient(
  baseUrl: string,
  operatorToken: string,
  fetchImpl: typeof fetch = fetch
): ToolshedOperatorClient {
  return {
    async resolveApproval(approvalId, decision, approver) {
      const response = await fetchImpl(`${baseUrl}/approvals/${encodeURIComponent(approvalId)}/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${operatorToken}`,
        },
        // approverKind identifies the operator surface (M4 review N1): without
        // it, the toolshed's endpoint defaulted every resolution to
        // 'dashboard' and Slack decisions were mis-audited.
        body: JSON.stringify({ decision, approverId: approver.id, approverKind: approver.kind }),
      });
      const body = (await response.json()) as { status: string; error?: string };
      return body;
    },
  };
}

/**
 * Minimal duck-typed subset of the Slack `block_actions` payload this
 * handler needs — real Bolt supplies far more, but pinning only what's used
 * keeps the handler testable against a fake Bolt `App`.
 */
export interface BlockActionArgs {
  ack: () => Promise<void>;
  action: { action_id: string; value: string };
  body: {
    user: { id: string };
    channel?: { id: string };
    message?: { ts?: string; blocks?: unknown[] };
  };
  client: SlackPoster & {
    chat: SlackPoster['chat'] & {
      update(args: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<unknown>;
    };
  };
}

/**
 * Wires the Approve/Deny button actions into a Bolt `App`. Every click:
 *   (a) checks the acting user against `MINIONS_APPROVERS` (comma-separated
 *       Slack user IDs; empty/unset denies everyone and logs it — no
 *       approver allowlist configured means no one can approve from Slack,
 *       fail closed);
 *   (b) resolves via the toolshed's operator HTTP endpoint with
 *       `{kind: 'slack', id: user.id}`;
 *   (c) edits the original message to show the outcome and who decided.
 */
export interface ActionRegisterable {
  action(actionId: string, handler: (args: BlockActionArgs) => Promise<void>): void;
}

export function registerApprovalActions(
  app: ActionRegisterable,
  operatorClient: ToolshedOperatorClient,
  approvers: string,
  log: (message: string) => void = console.warn
): void {
  const allowlist = new Set(
    approvers
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  );

  const handle = (decision: 'approved' | 'denied') =>
    async ({ ack, action, body, client }: BlockActionArgs) => {
      await ack();
      const approvalId = action.value;
      const userId = body.user.id;
      const channel = body.channel?.id;
      const messageTs = body.message?.ts;

      if (allowlist.size === 0 || !allowlist.has(userId)) {
        log(
          `[slack-bot] approval action REJECTED: user ${userId} is not in MINIONS_APPROVERS (${
            allowlist.size === 0 ? 'allowlist is empty — deny-all' : 'not a member'
          })`
        );
        if (channel && messageTs) {
          await client.chat.update({
            channel,
            ts: messageTs,
            text: `:no_entry: <@${userId}> is not authorized to approve/deny Minions actions.`,
          });
        }
        return;
      }

      const result = await operatorClient.resolveApproval(approvalId, decision, { kind: 'slack', id: userId });

      if (channel && messageTs) {
        const outcomeText =
          result.status === 'success'
            ? `${decision === 'approved' ? ':white_check_mark: Approved' : ':x: Denied'} by <@${userId}>`
            : `:warning: Failed to resolve approval: ${result.error ?? 'unknown error'}`;
        await client.chat.update({ channel, ts: messageTs, text: outcomeText });
      }
    };

  app.action(APPROVE_ACTION_ID, handle('approved'));
  app.action(DENY_ACTION_ID, handle('denied'));
}
