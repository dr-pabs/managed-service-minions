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

/**
 * Loud startup warnings when a webhook route's secret is unset -- the route
 * stays wired but fails every request closed (401), so a partial config (only
 * one of GitHub/ADO configured) still serves the configured route. Mirrors the
 * toolshed's `TOOLSHED_ALLOW_UNSIGNED`/missing-`TOOLSHED_SIGNING_SECRET` and the
 * dashboard's `DASHBOARD_AUTH_TOKEN` loud-warn-then-fail-closed pattern (M3 N2,
 * M14). We start-but-reject-the-route rather than refusing to boot, so a
 * GitHub-only or ADO-only deployment is not blocked by the other's missing
 * secret. See the ExecPlan Decision Log (M15 review).
 */
function warnOnMissingWebhookSecrets(cfg: {
  githubWebhookSecret: string;
  adoUsername: string;
  adoPassword: string;
}): void {
  if (!cfg.githubWebhookSecret) {
    console.warn(
      '[webhook-ingress] GITHUB_WEBHOOK_SECRET is not set -- the /webhooks/github route will REJECT every request (401). Set it to enable GitHub webhooks.'
    );
  }
  if (!cfg.adoUsername || !cfg.adoPassword) {
    console.warn(
      '[webhook-ingress] ADO_WEBHOOK_USERNAME/ADO_WEBHOOK_PASSWORD is not set -- the /webhooks/ado route will REJECT every request (401). Set both to enable Azure DevOps webhooks.'
    );
  }
}

async function main(): Promise<void> {
  warnOnMissingWebhookSecrets(config);
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
