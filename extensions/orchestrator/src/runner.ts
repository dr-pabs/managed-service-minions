import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  createMinionCorrelationId,
  createTrackedBudget,
  enforceTokenBudget,
  estimateTokensFromChars,
  extractTokenUsage,
  loadMinionSchemaMap,
  loadSchemas,
  mintMinionToken,
  runWithContract,
  TokenBudgetExceededError,
  validateMinionOutput,
  withSpan,
  type IngressRequest,
  type IngressResponse,
  type IngressRunner,
  type MinionRun,
  type SchemaCompileResult,
  type SessionStore,
} from 'framework-core';
import type { GooseClient } from './goose-client.js';

/**
 * The subset of `mcp-toolshed`'s `verifyAndExecuteTool` the runner needs.
 * Kept as a narrow structural interface (not an import of `mcp-toolshed`'s
 * concrete `MinionIdentityInput`/`ToolResult` types) so tests can supply a
 * trivial fake without dragging in the whole toolshed package — though the
 * real e2e test (Milestone 11's "highest-leverage test") DOES use the real
 * `mcp-toolshed` package end to end, exactly as the milestone specifies.
 *
 * In production (the topology `extensions/orchestrator/Dockerfile` builds),
 * `goose serve` itself holds the stdio MCP connection to the toolshed, so
 * every REAL minion tool call — the diff fetch, the PR merge — flows
 * through Goose's own session, not through this field. `deps.toolshed` here
 * exists for: (a) tests and the `FakeGooseClient`, which call it directly
 * to simulate a minion's tool call so the e2e test can assert against a
 * REAL toolshed's audit log with a REAL minted token (exactly what the
 * milestone's acceptance text requires); and (b) any future DAG step where
 * the RUNNER itself — not a minion via Goose — needs to make a governed
 * call directly (e.g. checking an approval's live status before deciding
 * whether to resume a DAG node). `extensions/slack-bot/src/index.ts` and
 * `extensions/teams-bot/src/index.ts` wire a real in-process toolshed via
 * `mcp-toolshed`'s own `buildToolshedState()` so this dependency is always
 * satisfiable, not a dead parameter.
 */
export interface ToolshedInvoker {
  verifyAndExecuteTool(
    input: { minionToken: string; correlationId: string; attempt: number },
    serverAlias: string,
    toolName: string,
    params: unknown
  ): Promise<{ status: string; data?: unknown; error?: string; approvalId?: string }>;
}

export interface OrchestratorRunnerDeps {
  goose: GooseClient;
  store: SessionStore;
  toolshed: ToolshedInvoker;
  /** Shared HMAC secret for minting minion tokens (Milestone 3, TOOLSHED_SIGNING_SECRET). */
  secret: string;
  /** Repo root used to resolve agents/, schemas/, rules/intents.yaml. Defaults to three directories above this file (mirrors mcp-toolshed's TOOLSHED_REPO_ROOT convention). */
  repoRoot?: string;
  /** Injectable clock for token TTL / MinionRun timestamps. Defaults to Date.now. */
  now?: () => number;
}

interface IntentDag {
  intents: Record<string, string[]>;
}

function defaultRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // extensions/orchestrator/src (or dist) -> repo root is three levels up.
  return path.resolve(here, '../../../');
}

function loadIntentDag(repoRoot: string): Record<string, string[]> {
  const intentsPath = path.join(repoRoot, 'rules', 'intents.yaml');
  const raw = yaml.load(fs.readFileSync(intentsPath, 'utf8')) as IntentDag | undefined;
  return raw?.intents ?? {};
}

interface AgentPromptAndFrontmatter {
  contents: string;
  frontmatter: Record<string, unknown>;
}

function loadAgentPromptAndFrontmatter(repoRoot: string, minionType: string): AgentPromptAndFrontmatter {
  // Agent filenames use hyphens (code-explorer.md) while minion_type uses
  // underscores (code_explorer) -- minions-repo-conventions documents this
  // convention explicitly ("Minion identity string = agent filename with
  // underscores"), except pr-crafter.md/pr_create, which is why this looks
  // the file up by SCANNING agents/*.md frontmatter for a matching
  // minion_type rather than deriving a filename from the identity string.
  const agentsDir = path.join(repoRoot, 'agents');
  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
  for (const file of files) {
    const contents = fs.readFileSync(path.join(agentsDir, file), 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(contents);
    if (!match) continue;
    const frontmatter = yaml.load(match[1]) as Record<string, unknown> | undefined;
    if (frontmatter?.minion_type === minionType) {
      return { contents, frontmatter };
    }
  }
  throw new Error(`No agents/*.md file found with minion_type "${minionType}"`);
}

function loadAgentPrompt(repoRoot: string, minionType: string): string {
  return loadAgentPromptAndFrontmatter(repoRoot, minionType).contents;
}

/**
 * Frontmatter `token_budget` (Milestone 13, review finding M9/F9) enforced
 * per run via the existing `TokenBudgetTracker`. Falls back to
 * `Number.POSITIVE_INFINITY` (never aborts) when the field is absent or not
 * a positive number -- a minion whose frontmatter doesn't declare a budget
 * is not retroactively broken by this milestone.
 */
function loadAgentTokenBudget(repoRoot: string, minionType: string): number {
  const { frontmatter } = loadAgentPromptAndFrontmatter(repoRoot, minionType);
  const budget = frontmatter.token_budget;
  return typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : Number.POSITIVE_INFINITY;
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Goose/model output is sometimes fenced in ```json ... ``` -- strip a
    // single leading/trailing fence before giving up, rather than fail a
    // minion run over cosmetic formatting.
    const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(raw);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * Creates the real `IngressRunner` (Milestone 11, review finding M5 / F8 —
 * "the pivot of the whole plan"). Wires together, in order:
 *
 * 1. **Classify** the user's message against `schemas/intent.json` by
 *    sending `agents/orchestrator.md`'s prompt to Goose, validated via
 *    Milestone 10's `validateMinionOutput`.
 * 2. **Look up** the ordered minion DAG for that intent in
 *    `rules/intents.yaml`.
 * 3. **Mint** a short-lived minion token (Milestone 3's `mintMinionToken`)
 *    per DAG step, scoped to that minion's type and this session.
 * 4. **Run** each minion via Goose with its own `agents/*.md` prompt,
 *    wrapped in Milestone 10's `runWithContract` (schema validation +
 *    one retry-with-feedback).
 * 5. **Record** a `MinionRun` row per minion with status transitions
 *    (`running` -> `completed` | `contract_violation` | `error` |
 *    `waiting_approval`).
 * 6. **Synthesize** a reply from the last minion's output (or every
 *    minion's output, joined, for a multi-step DAG).
 *
 * Untrusted-content interpolation points (Milestone 16 will wrap these in
 * `quarantineUntrusted`; not built here — see the ExecPlan's Milestone 11
 * scope note and this function's own inline markers below): a ticket body,
 * PR title/description, or diff returned by a minion's own tool call is
 * NEVER placed back into a downstream minion's prompt by this runner today
 * (each minion fetches its own context directly via `execute_tool`), but
 * `userContent` built in `buildMinionUserContent` below interpolates the
 * ORIGINAL USER MESSAGE (`request.text`) into every minion's first turn,
 * and a future DAG step that forwards one minion's raw `resultJson` into
 * the next minion's prompt (e.g. ticket_fix_pr's ticket_analyst ->
 * code_explorer handoff) is exactly the kind of untrusted-content
 * interpolation point Milestone 16 must quarantine. Marked with
 * `UNTRUSTED-INTERPOLATION-POINT` comments below.
 */
export function createOrchestratorRunner(deps: OrchestratorRunnerDeps): IngressRunner {
  const repoRoot = deps.repoRoot ?? defaultRepoRoot();
  const now = deps.now ?? Date.now;

  let schemas: SchemaCompileResult | undefined;
  let schemaMap: Map<string, string> | undefined;
  function loadedSchemas(): { schemas: SchemaCompileResult; schemaMap: Map<string, string> } {
    if (!schemas || !schemaMap) {
      schemas = loadSchemas(path.join(repoRoot, 'schemas'));
      schemaMap = loadMinionSchemaMap(repoRoot);
    }
    return { schemas, schemaMap };
  }

  function buildMinionUserContent(request: IngressRequest, priorOutputs: unknown[]): string {
    // UNTRUSTED-INTERPOLATION-POINT: request.text is user-supplied chat
    // text (a Slack/Teams message). It is placed directly into the minion's
    // prompt here with no quarantine boundary -- Milestone 16 owns wrapping
    // this (and any prior minion's resultJson forwarded in priorOutputs)
    // in `quarantineUntrusted` before it reaches a model.
    const parts = [`User request: ${request.text}`];
    if (priorOutputs.length > 0) {
      parts.push(`Prior minion outputs (JSON): ${JSON.stringify(priorOutputs)}`);
    }
    return parts.join('\n\n');
  }

  async function classifyIntent(
    request: IngressRequest & { sessionId: string; correlationRoot: string }
  ): Promise<{ intent: string; complexity: string; platform: string } | undefined> {
    const orchestratorPrompt = loadAgentPrompt(repoRoot, 'orchestrator');
    const { schemas: compiled, schemaMap: map } = loadedSchemas();
    const response = await deps.goose.classifyIntent({
      systemPrompt: orchestratorPrompt,
      // UNTRUSTED-INTERPOLATION-POINT: same as buildMinionUserContent above.
      userContent: `User request: ${request.text}\nRespond with JSON matching schemas/intent.json only.`,
      sessionId: request.sessionId,
      correlationId: request.correlationRoot,
    });
    const parsed = tryParseJson(response.raw);
    const outcome = validateMinionOutput('orchestrator', parsed, map, compiled);
    if (!outcome.valid) {
      return undefined;
    }
    return parsed as { intent: string; complexity: string; platform: string };
  }

  async function runOneMinion(
    minionType: string,
    minionIndex: number,
    request: IngressRequest & { sessionId: string; correlationRoot: string },
    priorOutputs: unknown[]
  ): Promise<
    | { run: MinionRun; output: unknown }
    | { run: MinionRun; waitingApproval: true }
    | { run: MinionRun; tokenBudgetExceeded: TokenBudgetExceededError }
  > {
    const correlationId = createMinionCorrelationId(request.correlationRoot, minionIndex);
    const token = mintMinionToken(
      { minionType, sessionId: request.sessionId, correlationId },
      deps.secret
    );
    const { contents: prompt } = loadAgentPromptAndFrontmatter(repoRoot, minionType);
    const tokenBudget = loadAgentTokenBudget(repoRoot, minionType);
    // Fresh tracked budget per minion RUN (one DAG step = one run, per this
    // runner's model): `TokenBudgetTracker` accumulates across the calls
    // WITHIN this run (e.g. Milestone 10's runWithContract retry-with-
    // feedback second attempt), which is why it's created once here and
    // closed over by every call inside the runWithContract callback below,
    // rather than reset per call.
    const trackedBudget = createTrackedBudget(tokenBudget);
    const { schemas: compiled, schemaMap: map } = loadedSchemas();

    const runId = `run_${request.sessionId}_${minionIndex}_${now()}`;
    const run: MinionRun = {
      id: runId,
      sessionId: request.sessionId,
      minionType,
      correlationId,
      status: 'running',
      createdAt: now(),
    };
    deps.store.createMinionRun(run);

    let approvalPending: string | undefined;
    let tokenBudgetExceeded: TokenBudgetExceededError | undefined;
    let tokensForThisMinion = 0;

    const result = await withSpan(
      'minion.run',
      { correlation_id: correlationId, minion_type: minionType, session_id: request.sessionId },
      () =>
        runWithContract(
          async (feedback?: string[]) => {
            const userContent = buildMinionUserContent(request, priorOutputs);
            const response = await deps.goose.runMinion({
              minionType,
              systemPrompt: prompt,
              userContent,
              sessionId: request.sessionId,
              correlationId,
              minionToken: token,
              feedback,
            });

            // Token accounting (Milestone 13, M9/F9): the Goose /reply
            // response, as verified against Milestone 11's fixtures
            // (test/fixtures/goose/*.json), is exactly {role, content} --
            // no usage field of any kind. extractTokenUsage stays
            // forward-compatible (reads one if a future response ever adds
            // it) but on today's real contract always falls through to the
            // characters/4 estimate over the prompt+content actually sent
            // and received this turn.
            const measuredUsage = extractTokenUsage(response);
            const tokensThisCall =
              measuredUsage ??
              estimateTokensFromChars(prompt) + estimateTokensFromChars(userContent) + estimateTokensFromChars(response.raw);
            tokensForThisMinion += tokensThisCall;

            // enforceTokenBudget's only throw path is TokenBudgetExceededError
            // (see token-accounting.ts) -- caught here, never left to
            // propagate as an uncaught rejection, so a minion whose budget
            // is blown gets a typed abort surfaced to chat (below) instead
            // of crashing the whole ingress request.
            try {
              enforceTokenBudget(trackedBudget, tokensThisCall, {
                minionType,
                sessionId: request.sessionId,
                correlationId,
                budget: tokenBudget,
              });
            } catch (err) {
              tokenBudgetExceeded = err as TokenBudgetExceededError;
              return undefined as unknown;
            }

            // A scripted/real minion turn may itself invoke execute_tool
            // through the toolshed via `toolCall` metadata the
            // FakeGooseClient (or a real Goose+MCP session) triggers as a
            // side effect of producing its output -- see goose-client.ts
            // and the e2e test for how this is exercised with a minted
            // token. If that call comes back approval_pending, the
            // FakeGooseClient encodes that as a special raw payload the
            // runner recognizes below.
            if (response.raw === '__APPROVAL_PENDING__') {
              approvalPending = 'pending';
              return undefined as unknown;
            }
            return tryParseJson(response.raw);
          },
          { minionType, schemaMap: map, schemas: compiled }
        )
    );

    deps.store.updateMinionRun(runId, { tokensUsed: tokensForThisMinion });

    if (tokenBudgetExceeded) {
      deps.store.updateMinionRun(runId, { status: 'token_budget_exceeded', completedAt: now() });
      return { run: { ...run, status: 'token_budget_exceeded' }, tokenBudgetExceeded };
    }

    if (approvalPending) {
      deps.store.updateMinionRun(runId, { status: 'waiting_approval' });
      return { run: { ...run, status: 'waiting_approval' }, waitingApproval: true };
    }

    if (result.status === 'contract_violation') {
      deps.store.updateMinionRun(runId, {
        status: 'contract_violation',
        resultJson: JSON.stringify(result.lastOutput ?? null),
        completedAt: now(),
      });
      return { run: { ...run, status: 'contract_violation' }, output: result.lastOutput };
    }

    deps.store.updateMinionRun(runId, {
      status: 'completed',
      resultJson: JSON.stringify(result.output),
      completedAt: now(),
    });
    return { run: { ...run, status: 'completed' }, output: result.output };
  }

  function synthesizeReply(outputs: Array<{ minionType: string; output: unknown }>): string {
    // outputs is always non-empty here: the caller already returns early
    // when the DAG has zero entries (see the `minionTypes.length === 0`
    // check below), so every call into this function has run at least one
    // minion.
    const last = outputs[outputs.length - 1];
    const summary =
      typeof last.output === 'object' && last.output !== null && 'summary' in (last.output as Record<string, unknown>)
        ? String((last.output as Record<string, unknown>).summary)
        : JSON.stringify(last.output);
    return `${summary}\n\n(via ${last.minionType})`;
  }

  return {
    run: async (
      request: IngressRequest & { sessionId: string; correlationRoot: string }
    ): Promise<IngressResponse> =>
      withSpan(
        'orchestrator.run',
        { correlation_id: request.correlationRoot, minion_type: 'orchestrator', session_id: request.sessionId },
        async () => {
          const classification = await classifyIntent(request);
          if (!classification) {
            return { text: "I couldn't classify your request into a supported intent. Could you rephrase it?" };
          }

          const dag = loadIntentDag(repoRoot);
          const minionTypes = dag[classification.intent];
          if (!minionTypes || minionTypes.length === 0) {
            return { text: `I understood this as "${classification.intent}" but no minion DAG is configured for it.` };
          }

          const outputs: Array<{ minionType: string; output: unknown }> = [];
          for (let i = 0; i < minionTypes.length; i++) {
            const minionType = minionTypes[i];
            const outcome = await runOneMinion(
              minionType,
              i,
              request,
              outputs.map((o) => o.output)
            );
            if ('tokenBudgetExceeded' in outcome) {
              // Typed error surfaced as a clean chat message (Milestone 13,
              // M9/F9) -- never a crash/thrown exception reaching the bot
              // process. The MinionRun row is already persisted with
              // status 'token_budget_exceeded' by runOneMinion above.
              return { text: outcome.tokenBudgetExceeded.message };
            }
            if ('waitingApproval' in outcome) {
              return {
                text: `This action (${minionType}) requires operator approval before it can proceed. I'll pick back up once it's approved -- just send another message here to check.`,
              };
            }
            if (outcome.run.status === 'contract_violation') {
              return {
                text: `The ${minionType} minion's output didn't match its expected schema after a retry. This has been logged; an operator can inspect the run (${outcome.run.correlationId}).`,
              };
            }
            outputs.push({ minionType, output: outcome.output });
          }

          return { text: synthesizeReply(outputs) };
        }
      ),
  };
}
