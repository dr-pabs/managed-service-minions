import { Application, TeamsAdapter } from '@microsoft/teams-ai';
import {
  buildToolshedState,
  createSqliteStore,
  initializeToolshed,
  verifyAndExecuteTool,
} from 'mcp-toolshed';
import type { IngressRunner } from 'framework-core';
import { createOrchestratorRunner, createHttpGooseClient } from 'orchestrator';
import { createEchoRunner, createTeamsBot } from './teams-bot.js';

const botFrameworkAuthConfig = {
  MicrosoftAppId: process.env.MICROSOFT_APP_ID ?? '',
  MicrosoftAppPassword: process.env.MICROSOFT_APP_PASSWORD ?? '',
  MicrosoftAppType: process.env.MICROSOFT_APP_TYPE ?? 'MultiTenant',
};

const adapter = new TeamsAdapter(botFrameworkAuthConfig);
const app = new Application({
  adapter,
  removeRecipientMention: true,
  startTypingTimer: true,
});

const store = createSqliteStore(process.env.SQLITE_PATH ?? ':memory:');

/**
 * RUNNER=orchestrator|echo (Milestone 11) — mirrors
 * extensions/slack-bot/src/index.ts's `selectRunner`; see that file's doc
 * comment for the full rationale (RUNNER wins when set; otherwise
 * orchestrator is the default whenever GOOSE_SERVE_URL is configured,
 * echo otherwise; echo stays available as an explicit dev mode).
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
    const bot = createTeamsBot(app, store, runner, {
      port: Number(process.env.PORT ?? 3978),
    });
    return bot.start();
  })
  .catch((err) => {
    console.error('Teams bot failed to start', err);
    process.exit(1);
  });
