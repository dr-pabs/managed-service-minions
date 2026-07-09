import { buildToolshedState, createSqliteStore, initializeToolshed, verifyAndExecuteTool } from 'mcp-toolshed';
import { createOrchestratorRunner, createHttpGooseClient } from 'orchestrator';
import { createWebhookServer } from './webhook-ingress.js';

/**
 * Production wiring for the webhook-ingress server (Milestone 15, F11) --
 * mirrors `extensions/slack-bot/src/index.ts`'s shape: build a real
 * in-process toolshed via `mcp-toolshed`'s own `buildToolshedState()` (the
 * SAME startup path the toolshed's own process uses), wire the real
 * orchestrator runner against it, and start the bare `node:http` server.
 */
const config = {
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? '',
  adoUsername: process.env.ADO_WEBHOOK_USERNAME ?? '',
  adoPassword: process.env.ADO_WEBHOOK_PASSWORD ?? '',
  port: Number(process.env.PORT ?? 3100),
};

const store = createSqliteStore(process.env.SQLITE_PATH ?? ':memory:');

async function main(): Promise<void> {
  const state = await buildToolshedState();
  initializeToolshed(state);

  const goose = createHttpGooseClient({
    baseUrl: process.env.GOOSE_SERVE_URL ?? process.env.GOOSE_BASE_URL ?? 'http://localhost:3284',
  });

  const secret = process.env.TOOLSHED_SIGNING_SECRET ?? '';

  const runner = createOrchestratorRunner({
    goose,
    store,
    toolshed: { verifyAndExecuteTool },
    secret,
  });

  await createWebhookServer({
    runner,
    store,
    githubWebhookSecret: config.githubWebhookSecret,
    adoUsername: config.adoUsername,
    adoPassword: config.adoPassword,
    port: config.port,
    toolshed: { verifyAndExecuteTool },
    signingSecret: secret,
  });
}

main().catch((err) => {
  console.error('Webhook ingress failed to start', err);
  process.exit(1);
});
