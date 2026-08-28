import { buildToolshedState, createSqliteStore, initializeToolshed, verifyAndExecuteTool } from 'mcp-toolshed';
import { createOrchestratorRunner, createHttpGooseClient } from 'orchestrator';
import { consumeQueue } from './consumer.js';
import { InMemoryIdempotencyStore } from './idempotency-store.js';
import { WorkItemProcessor } from './processor.js';
import { InMemoryWorkItemQueue, type WorkItemQueue } from './queue.js';
import { ServiceBusWorkItemQueue } from './service-bus-queue.js';

/**
 * Production wiring for the queue-ingress consumer (Milestone 15) -- mirrors
 * `extensions/webhook-ingress/src/index.ts`: build a real in-process toolshed
 * via `mcp-toolshed`'s own `buildToolshedState()`, wire the real orchestrator
 * runner against it, then drain the work queue. The queue is a Service Bus
 * consumer when `SERVICE_BUS_CONNECTION_STRING` is set, otherwise an in-memory
 * queue (local dev / tests) -- the same dual-backend shape `mcp-toolshed`'s
 * `store.ts` uses, so the package runs with zero cloud dependency.
 */
const config = {
  connectionString: process.env.SERVICE_BUS_CONNECTION_STRING ?? '',
  queueName: process.env.SERVICE_BUS_QUEUE_NAME ?? 'minion-tasks',
  sqlitePath: process.env.SQLITE_PATH ?? ':memory:',
  gooseUrl: process.env.GOOSE_SERVE_URL ?? process.env.GOOSE_BASE_URL ?? 'http://localhost:3284',
  signingSecret: process.env.TOOLSHED_SIGNING_SECRET ?? '',
};

async function buildQueue(): Promise<WorkItemQueue> {
  if (!config.connectionString) {
    console.warn(
      '[queue-ingress] SERVICE_BUS_CONNECTION_STRING is not set -- using the in-memory work queue (local dev / tests). Set it to consume real Stream work items.'
    );
    return new InMemoryWorkItemQueue();
  }
  return ServiceBusWorkItemQueue.connect(config.connectionString, config.queueName);
}

async function main(): Promise<void> {
  const queue = await buildQueue();
  const store = createSqliteStore(config.sqlitePath);
  const state = await buildToolshedState();
  initializeToolshed(state);

  const goose = createHttpGooseClient({ baseUrl: config.gooseUrl });
  const runner = createOrchestratorRunner({
    goose,
    store,
    toolshed: { verifyAndExecuteTool },
    secret: config.signingSecret,
  });

  const processor = new WorkItemProcessor({
    runner,
    queue,
    outcomes: new InMemoryIdempotencyStore(),
  });

  await consumeQueue({ queue, processor });
}

main().catch((err) => {
  console.error('Queue ingress failed to start', err);
  process.exit(1);
});
