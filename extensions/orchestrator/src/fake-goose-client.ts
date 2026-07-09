import { mintMinionToken } from 'framework-core';
import type { GooseClient, GooseMinionRequest, GooseMinionResponse } from './goose-client.js';
import type { ToolshedInvoker } from './runner.js';

/**
 * A per-minion-type scripted response. `toolCalls` are executed against the
 * real toolshed (via a freshly minted token for this exact minion turn)
 * BEFORE the scripted `output`/`approvalPending` result is returned, so a
 * fake minion turn produces real, governed, auditable `execute_tool` calls
 * — exactly what the Milestone 11 e2e test asserts ("the audit log contains
 * ALLOWED github_get_pull_request_diff calls made WITH VALID TOKENS").
 *
 * `output` is returned as-is on the FIRST call for this minion type;
 * `retryOutput` (if given) is returned on a SECOND call (Milestone 10's
 * retry-with-feedback) — omit it to let a schema-invalid `output` produce a
 * genuine `contract_violation` in a test that wants one.
 */
export interface ScriptedMinionTurn {
  toolCalls?: Array<{ serverAlias: string; toolName: string; params: unknown }>;
  output?: unknown;
  retryOutput?: unknown;
  /** When true, the FIRST call for this minion type returns approval_pending instead of output. */
  approvalPendingFirst?: boolean;
}

export interface FakeGooseClientConfig {
  toolshed: ToolshedInvoker;
  secret: string;
  /** minion_type -> scripted turn. `classifyIntent` uses the special key "orchestrator". */
  script: Record<string, ScriptedMinionTurn>;
}

/**
 * One request the fake actually received, in call order. This is the exact
 * text the "model" (the seam a real Goose process would occupy) saw --
 * capturing it lets tests assert on what the CALLER (the orchestrator
 * runner) sent, not just on the fake's scripted response. Added for the
 * Milestone 16 review's finding F1: without this, nothing pinned that
 * `runner.ts`'s `quarantineUntrusted` wiring at `buildMinionUserContent`/
 * `classifyIntent` actually reaches this seam -- stripping all three call
 * sites left every then-existing test green (see the ExecPlan's M16 review
 * remediation entry).
 */
export interface FakeGooseReceivedRequest {
  /** "orchestrator" for a classifyIntent call, else the minion type. */
  minionType: string;
  systemPrompt: string;
  userContent: string;
}

export interface FakeGooseClient extends GooseClient {
  /** Every request received so far, in call order (classifyIntent and runMinion both append). */
  readonly receivedRequests: FakeGooseReceivedRequest[];
}

/**
 * Scripted `GooseClient` double for tests (Milestone 11 acceptance: "no
 * network... FakeGooseClient with scripted per-minion responses"). Tracks
 * how many times each minion type has been called so a script can supply
 * different output on a retry.
 */
export function createFakeGooseClient(config: FakeGooseClientConfig): FakeGooseClient {
  const callCounts = new Map<string, number>();
  const receivedRequests: FakeGooseReceivedRequest[] = [];

  async function runToolCalls(
    minionToken: string,
    correlationId: string,
    toolCalls: ScriptedMinionTurn['toolCalls']
  ): Promise<void> {
    if (!toolCalls) return;
    for (const call of toolCalls) {
      await config.toolshed.verifyAndExecuteTool(
        { minionToken, correlationId, attempt: 1 },
        call.serverAlias,
        call.toolName,
        call.params
      );
    }
  }

  async function handle(
    minionType: string,
    correlationId: string,
    minionToken: string,
    turn: ScriptedMinionTurn
  ): Promise<GooseMinionResponse> {
    const callIndex = callCounts.get(minionType) ?? 0;
    callCounts.set(minionType, callIndex + 1);

    if (turn.approvalPendingFirst && callIndex === 0) {
      await runToolCalls(minionToken, correlationId, turn.toolCalls);
      return { raw: '__APPROVAL_PENDING__' };
    }

    await runToolCalls(minionToken, correlationId, turn.toolCalls);

    const output = callIndex === 0 || turn.retryOutput === undefined ? turn.output : turn.retryOutput;
    return { raw: JSON.stringify(output) };
  }

  return {
    receivedRequests,
    classifyIntent: async (args) => {
      const turn = config.script.orchestrator;
      receivedRequests.push({
        minionType: 'orchestrator',
        systemPrompt: args.systemPrompt,
        userContent: args.userContent,
      });
      if (!turn) {
        throw new Error('FakeGooseClient: no scripted turn for minion type "orchestrator"');
      }
      // classifyIntent has no minted minion token of its own (the
      // orchestrator classifies intent before any delegate exists) — mint a
      // throwaway one only so runToolCalls has something to present if a
      // test scripts a toolCall on the "orchestrator" entry (uncommon, but
      // not disallowed).
      const token = mintMinionToken(
        { minionType: 'orchestrator', sessionId: args.sessionId, correlationId: args.correlationId },
        config.secret
      );
      return handle('orchestrator', args.correlationId, token, turn);
    },
    runMinion: async (request: GooseMinionRequest) => {
      const turn = config.script[request.minionType];
      receivedRequests.push({
        minionType: request.minionType,
        systemPrompt: request.systemPrompt,
        userContent: request.userContent,
      });
      if (!turn) {
        throw new Error(`FakeGooseClient: no scripted turn for minion type "${request.minionType}"`);
      }
      return handle(request.minionType, request.correlationId, request.minionToken, turn);
    },
  };
}
