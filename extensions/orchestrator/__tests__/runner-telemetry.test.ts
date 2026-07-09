import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { trace, context } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { withSpan } from 'framework-core';
import {
  createDefaultToolshedState,
  createMemoryStore,
  createMockAdapter,
  initializeToolshed,
  resetToolshed,
  verifyAndExecuteTool,
} from 'mcp-toolshed';
import { createOrchestratorRunner, type ToolshedInvoker } from '../src/runner.js';
import { createFakeGooseClient } from '../src/fake-goose-client.js';
import { createInMemoryTestStore } from './test-helpers.js';

const SECRET = 'test-signing-secret';

function makeToolshed(): { toolshed: ToolshedInvoker } {
  return {
    toolshed: {
      verifyAndExecuteTool: jest.fn(async () => ({ status: 'success', data: {} })),
    },
  };
}

/**
 * A REAL in-process `mcp-toolshed` pipeline (not a hand-rolled fake), so the
 * span-nesting test proves `execute_tool`/`adapter.call` spans the toolshed
 * package itself creates nest under the ORCHESTRATOR's spans via genuine
 * OTel context propagation -- mirroring how `test/src/e2e-review-pr.test.ts`
 * wires the same real pipeline for its governance assertions.
 */
function makeRealToolshed(): { toolshed: ToolshedInvoker; cleanup: () => void } {
  initializeToolshed(
    createDefaultToolshedState({
      store: createMemoryStore(),
      adapters: new Map([
        ['github', createMockAdapter('github', { callTool: async () => ({ diff: 'diff --git a/x b/x' }) })],
      ]),
      allowlists: {
        allowlists: { code_explorer: { github: ['github_get_pull_request_diff'] } },
        pathScopes: {},
        shellCommands: {},
      },
      signingSecret: SECRET,
    })
  );
  return {
    toolshed: { verifyAndExecuteTool },
    cleanup: () => resetToolshed(),
  };
}

function makeRequest() {
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

describe('createOrchestratorRunner: span nesting (in-memory exporter)', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register({ contextManager: new AsyncLocalStorageContextManager() });
  });

  afterEach(async () => {
    exporter.reset();
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  it('nests orchestrator.run -> minion.run -> execute_tool -> adapter.call spans under an ingress.message root, carrying correlation_id/minion_type/session_id', async () => {
    const store = createInMemoryTestStore();
    const { toolshed, cleanup } = makeRealToolshed();
    try {
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

      // Simulates the ingress-level root span (framework-core's ingress.ts
      // wraps handleIngressMessage in this same span) so the test proves the
      // ORCHESTRATOR's own spans nest under it via real context propagation,
      // not just that the runner creates spans in isolation.
      await withSpan('ingress.message', { correlation_id: 'corr_root1', session_id: 'sess_T1:slack:ts1' }, async () => {
        await runner.run(makeRequest());
      });

      const spans = exporter.getFinishedSpans();
      const byName = (name: string) => spans.filter((s) => s.name === name);

      expect(byName('ingress.message')).toHaveLength(1);
      expect(byName('orchestrator.run')).toHaveLength(1);
      expect(byName('minion.run')).toHaveLength(2); // code_explorer, code_reviewer
      expect(byName('execute_tool')).toHaveLength(1); // code_explorer's one tool call
      expect(byName('adapter.call')).toHaveLength(1); // the real toolshed's downstream github adapter call

      const ingress = byName('ingress.message')[0];
      const orchestratorRun = byName('orchestrator.run')[0];
      const minionRuns = byName('minion.run');
      const executeTool = byName('execute_tool')[0];
      const adapterCall = byName('adapter.call')[0];

      expect(orchestratorRun.parentSpanContext?.spanId).toBe(ingress.spanContext().spanId);
      for (const minionSpan of minionRuns) {
        expect(minionSpan.parentSpanContext?.spanId).toBe(orchestratorRun.spanContext().spanId);
      }
      const codeExplorerSpan = minionRuns.find((s) => s.attributes.minion_type === 'code_explorer')!;
      expect(executeTool.parentSpanContext?.spanId).toBe(codeExplorerSpan.spanContext().spanId);
      expect(adapterCall.parentSpanContext?.spanId).toBe(executeTool.spanContext().spanId);

      // All spans in one trace.
      const traceId = ingress.spanContext().traceId;
      for (const s of spans) {
        expect(s.spanContext().traceId).toBe(traceId);
      }

      // Identity attributes on every span in the chain.
      expect(orchestratorRun.attributes.correlation_id).toBe('corr_root1');
      expect(orchestratorRun.attributes.session_id).toBe('sess_T1:slack:ts1');
      expect(codeExplorerSpan.attributes.minion_type).toBe('code_explorer');
      expect(codeExplorerSpan.attributes.session_id).toBe('sess_T1:slack:ts1');
      expect(executeTool.attributes.minion_type).toBe('code_explorer');
      expect(executeTool.attributes.correlation_id).toContain('corr_root1.0');
      expect(adapterCall.attributes.minion_type).toBe('code_explorer');
    } finally {
      cleanup();
    }
  });
});

describe('createOrchestratorRunner: token accounting', () => {
  it('populates MinionRun.tokensUsed via the characters/4 estimate (Goose /reply carries no usage field)', async () => {
    const store = createInMemoryTestStore();
    const { toolshed } = makeToolshed();
    const goose = createFakeGooseClient({
      toolshed,
      secret: SECRET,
      script: {
        orchestrator: { output: { intent: 'ticket_lookup', complexity: 'simple', platform: 'slack' } },
        ticket_analyst: { output: { ticket_id: 'INC1', title: 't', status: 'open', summary: 'a summary' } },
      },
    });

    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET });
    await runner.run({ ...makeRequest(), text: 'status of INC1?' });

    const runs = store.listMinionRunsBySession('sess_T1:slack:ts1');
    const ticketRun = runs.find((r) => r.minionType === 'ticket_analyst')!;
    expect(ticketRun.tokensUsed).toBeGreaterThan(0);
  });

  it('aborts a minion with TokenBudgetExceededError when its frontmatter token_budget is exceeded, surfaced as a typed chat message (not a crash)', async () => {
    const store = createInMemoryTestStore();
    const { toolshed } = makeToolshed();
    // ticket_analyst's real frontmatter token_budget is 10000 -- a single
    // huge user-content string estimates to well over that via chars/4,
    // so the very first call already exceeds the budget.
    const hugeText = 'x'.repeat(10000 * 4 + 100);
    const goose = createFakeGooseClient({
      toolshed,
      secret: SECRET,
      script: {
        orchestrator: { output: { intent: 'ticket_lookup', complexity: 'simple', platform: 'slack' } },
        ticket_analyst: { output: { ticket_id: 'INC1', title: 't', status: 'open', summary: 'a summary' } },
      },
    });

    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET });
    const response = await runner.run({ ...makeRequest(), text: hugeText });

    expect(response.text).toMatch(/token budget/i);
    expect(response.text).toContain('ticket_analyst');

    const runs = store.listMinionRunsBySession('sess_T1:slack:ts1');
    const ticketRun = runs.find((r) => r.minionType === 'ticket_analyst')!;
    expect(ticketRun.status).toBe('token_budget_exceeded');
  });
});
