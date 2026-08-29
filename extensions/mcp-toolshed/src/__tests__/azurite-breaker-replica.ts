/**
 * One replica of the two-replica breaker test (remediation Milestone 11).
 * Driven over stdio by azurite-integration.test.ts:
 *
 *   {"cmd": "fail"}  -> recordBreakerFailure, reply {"ok": true}
 *   {"cmd": "can"}   -> reply {"can": <bool>}
 *   {"cmd": "ok"}    -> recordBreakerSuccess, reply {"ok": true}
 *
 * Run with: tsx azurite-breaker-replica.ts <connection-string> <table>
 */
import { createInterface } from 'node:readline';
import { TableClient } from '@azure/data-tables';
import { createSharedGovernanceStateStore } from '../shared-governance-state.js';
import { createMemoryStore } from '../store.js';

const BREAKER_CONFIG = {
  failureThreshold: 1,
  successThreshold: 2,
  timeoutSecs: 10,
  halfOpenMaxRequests: 1,
};
const DEFAULT_RATE_LIMIT = { requestsPerMinute: 60, burst: 10 };

async function main(): Promise<void> {
  // tsx injects its own entry into argv, so positional args are whatever
  // remains after dropping the script path itself.
  const positional = process.argv.slice(2).filter((arg) => !arg.endsWith('.ts'));
  const [connectionString, table] = positional;
  const client = TableClient.fromConnectionString(connectionString, table);
  const state = createSharedGovernanceStateStore({
    client,
    store: createMemoryStore(),
    circuitBreakerConfig: BREAKER_CONFIG,
    defaultRateLimit: DEFAULT_RATE_LIMIT,
  });
  const KEY = 'github';

  const write = (line: unknown): void => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  };

  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    try {
      const msg = JSON.parse(line) as { cmd: string };
      if (msg.cmd === 'fail') {
        await state.recordBreakerFailure(KEY);
        write({ ok: true });
      } else if (msg.cmd === 'ok') {
        await state.recordBreakerSuccess(KEY);
        write({ ok: true });
      } else if (msg.cmd === 'can') {
        write({ can: await state.canExecuteBreaker(KEY) });
      }
    } catch (err) {
      write({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

main().catch((err) => {
  process.stderr.write(`${err}\n`);
  process.exit(1);
});
