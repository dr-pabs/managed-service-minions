import { App } from '@slack/bolt';
import {
  buildToolshedState,
  createSqliteStore,
  initializeToolshed,
  verifyAndExecuteTool,
} from 'mcp-toolshed';
import type { IngressRunner } from 'framework-core';
import { createOrchestratorRunner, createHttpGooseClient } from 'orchestrator';
import { createEchoRunner, createSlackBot } from './slack-bot.js';

const config = {
  signingSecret: process.env.SLACK_SIGNING_SECRET ?? '',
  token: process.env.SLACK_BOT_TOKEN ?? '',
  port: Number(process.env.PORT ?? 3000),
};

const app = new App({
  signingSecret: config.signingSecret,
  token: config.token,
});

const store = createSqliteStore(process.env.SQLITE_PATH ?? ':memory:');

/**
 * RUNNER=orchestrator|echo (Milestone 11). `RUNNER` wins when set;
 * otherwise the real orchestrator runner is the default whenever a Goose
 * endpoint is configured (GOOSE_SERVE_URL), falling back to the echo dev
 * stub only when nothing points at a real Goose process — never the
 * production default. `createEchoRunner` stays available as an EXPLICIT
 * dev mode (`RUNNER=echo`), never wired in silently.
 *
 * The in-process toolshed state built here (via `mcp-toolshed`'s own
 * `buildToolshedState()` — the SAME startup path the toolshed's own process
 * uses, including config validation, real MCP adapter connections from
 * `TOOLSHED_ADAPTERS`, and the signing-secret production gate) exists so
 * `createOrchestratorRunner`'s `toolshed: ToolshedInvoker` dependency has a
 * real implementation to call in this same process. In topologies where the
 * toolshed runs as its own container (the default per
 * `extensions/orchestrator/Dockerfile`, wired into `goose serve` as an MCP
 * extension over stdio), Goose's own MCP session is what actually calls
 * `execute_tool` — this in-process toolshed is for single-process/dev
 * deployments and for the runner's own governed calls (if any DAG step ever
 * needs one directly rather than through Goose).
 */
async function selectRunner(): Promise<IngressRunner> {
  const mode = process.env.RUNNER ?? (process.env.GOOSE_SERVE_URL ? 'orchestrator' : 'echo');
  if (mode === 'echo') {
    return createEchoRunner();
  }

  const state = await buildToolshedState();
  initializeToolshed(state);

  const goose = createHttpGooseClient({
    baseUrl: process.env.GOOSE_SERVE_URL ?? process.env.GOOSE_BASE_URL ?? 'http://localhost:3284',
  });

  return createOrchestratorRunner({
    goose,
    store,
    toolshed: { verifyAndExecuteTool },
    secret: process.env.TOOLSHED_SIGNING_SECRET ?? '',
  });
}

selectRunner()
  .then((runner) => {
    const bot = createSlackBot(app, store, runner, config);
    return bot.start();
  })
  .catch((err) => {
    console.error('Slack bot failed to start', err);
    process.exit(1);
  });
