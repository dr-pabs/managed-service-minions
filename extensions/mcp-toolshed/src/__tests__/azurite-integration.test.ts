import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { TableClient } from '@azure/data-tables';
import { createMemoryStore } from '../store.js';
import { createSharedGovernanceStateStore } from '../shared-governance-state.js';

/**
 * Live-Azurite integration for the shared governance state (remediation
 * Milestone 11). The hermetic fake in shared-governance-state.test.ts proves
 * the state machine; these tests prove it against the real table service
 * semantics (ETags, 412s, entity CRUD) that only an emulator exercises.
 * Skips loudly unless AZURITE_TABLES_CONNECTION_STRING is set:
 *
 *     npx azurite --tableHost 127.0.0.1   # or the docker-compose service
 *     AZURITE_TABLES_CONNECTION_STRING='UseDevelopmentStorage=true' pnpm --filter mcp-toolshed test -- azurite
 */

const CONNECTION_STRING = process.env.AZURITE_TABLES_CONNECTION_STRING;
const describeAzurite = CONNECTION_STRING ? describe : describe.skip;

if (!CONNECTION_STRING) {
  console.warn(
    [
      '',
      '⚠️  azurite-integration.test.ts (mcp-toolshed): SKIPPING — AZURITE_TABLES_CONNECTION_STRING is not set.',
      '⚠️  Start the emulator (npx azurite, or the docker-compose dev profile) and set it to run these tests.',
      '',
    ].join('\n')
  );
}

const BREAKER_CONFIG = {
  failureThreshold: 1,
  successThreshold: 2,
  timeoutSecs: 10,
  halfOpenMaxRequests: 1,
};
const DEFAULT_RATE_LIMIT = { requestsPerMinute: 60, burst: 10 };

const TABLE = `govtest${Date.now()}${process.pid}`;
let client: TableClient;
let clockMs = 1_000_000;

function makeState() {
  return createSharedGovernanceStateStore({
    client,
    store: createMemoryStore(),
    circuitBreakerConfig: BREAKER_CONFIG,
    defaultRateLimit: DEFAULT_RATE_LIMIT,
    now: () => clockMs,
  });
}

beforeAll(async () => {
  client = TableClient.fromConnectionString(CONNECTION_STRING!, TABLE);
  await client.createTable();
});

afterAll(async () => {
  await client.deleteTable();
});

describeAzurite('shared governance state against live Azurite', () => {
  it('exhausts a rate-limit bucket at its limit', async () => {
    const state = makeState();
    const limit = { requestsPerMinute: 2, burst: 2 };
    const first = await state.takeRateLimitToken('ratelimit:live', limit);
    const second = await state.takeRateLimitToken('ratelimit:live', limit);
    const third = await state.takeRateLimitToken('ratelimit:live', limit);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
  });

  it('opens and half-opens a breaker with a controllable clock', async () => {
    const state = makeState();
    expect(await state.canExecuteBreaker('breaker:live')).toBe(true);
    await state.recordBreakerFailure('breaker:live');
    expect(await state.canExecuteBreaker('breaker:live')).toBe(false);
    expect(await state.breakerRetryAfterSeconds('breaker:live')).toBeGreaterThan(0);
    // Advance past the open timeout: the breaker half-opens and permits a probe.
    clockMs += (BREAKER_CONFIG.timeoutSecs + 1) * 1000;
    expect(await state.canExecuteBreaker('breaker:live')).toBe(true);
    await state.recordBreakerSuccess('breaker:live');
    await state.recordBreakerSuccess('breaker:live');
    expect(await state.canExecuteBreaker('breaker:live')).toBe(true);
  });

  it('TWO REPLICAS share one breaker state through the table', async () => {
    // The point of the shared store (ADR-026): replica A's breaker opening
    // must be observed by replica B — in-process state could never pass.
    // Two real child processes, one table, stdio-driven.
    const here = path.dirname(import.meta.url.replace('file://', ''));
    const repoRoot = path.resolve(here, '..', '..', '..', '..');
    const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
    mkdirSync(path.dirname(tsxBin), { recursive: true });

    const startReplica = () =>
      new Promise<{ send: (cmd: string) => void; ask: (cmd: string) => Promise<unknown>; close: () => void }>((resolve, reject) => {
        const child = spawn(tsxBin, [path.join(here, 'azurite-breaker-replica.ts'), CONNECTION_STRING!, TABLE], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const pending = new Array<(value: unknown) => void>();
        let buffer = '';
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.trim() && pending.length > 0) {
              pending.shift()(JSON.parse(line));
            }
          }
        });
        child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
        child.on('error', reject);
        const ready = { send: (cmd: string) => child.stdin.write(`${JSON.stringify({ cmd })}\n`) };
        const ask = (cmd: string) =>
          new Promise<unknown>((res) => {
            pending.push(res);
            ready.send(cmd);
          });
        // Wait for the child to be listening: a probe round-trip.
        ask('can').then(() => resolve({ ...ready, ask, close: () => child.kill() }), reject);
      });

    const replicaA = await startReplica();
    const replicaB = await startReplica();
    try {
      // Both replicas start permissive.
      expect(await replicaB.ask('can')).toEqual({ can: true });

      // Replica A's failure opens the breaker — in the SHARED table.
      await replicaA.send('fail');
      await new Promise((r) => setTimeout(r, 500));

      // Replica B, a different process with no shared memory, sees it.
      expect(await replicaB.ask('can')).toEqual({ can: false });
    } finally {
      replicaA.close();
      replicaB.close();
    }
  }, 30_000);
});
