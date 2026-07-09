import { startDashboardServer } from './dashboard.js';
import { createSqliteStore } from 'mcp-toolshed';

async function main(): Promise<void> {
  const port = Number(process.env.DASHBOARD_PORT ?? 3001);
  const storePath = process.env.SQLITE_PATH ?? '/data/dashboard.db';
  const store = createSqliteStore(storePath);

  // Milestone 14 (review finding M7 "dashboard has no auth"): DASHBOARD_AUTH_TOKEN
  // gates every route locally; production instead fronts this Container App
  // with Azure Entra ID easy-auth (see infra/terraform/modules/container_apps).
  // TOOLSHED_OPERATOR_URL/TOOLSHED_OPERATOR_TOKEN let the approve/deny routes
  // proxy to the toolshed's own operator HTTP endpoint (Milestone 4).
  await startDashboardServer(store, port, undefined, [], undefined, {
    authToken: process.env.DASHBOARD_AUTH_TOKEN,
    operatorUrl: process.env.TOOLSHED_OPERATOR_URL,
    operatorToken: process.env.TOOLSHED_OPERATOR_TOKEN,
  });
}

main().catch((err) => {
  console.error('Dashboard failed to start', err);
  process.exit(1);
});
