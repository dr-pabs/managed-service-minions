import { describe, expect, it } from '@jest/globals';
import { mintMinionToken } from 'framework-core';
import { createMockAdapter } from '../adapter.js';
import { createMemoryStore } from '../store.js';
import {
  createDefaultToolshedState,
  initializeToolshed,
  verifyAndExecuteTool,
  type MinionIdentityInput,
} from '../toolshed.js';

/**
 * Remediation Milestone 12: the legacy self-reported identity fields are gone
 * from `MinionIdentityInput`. The unsigned dev path resolves every caller to
 * the fixed `dev-unsigned` principal (team `dev`) — a stray `legacy*`
 * property in the JSON buys nothing — and a typed caller cannot compile a
 * reference to the removed fields at all.
 */

const SECRET = 'removal-test-secret';

// Compile-level pin: the removed fields are gone from the type. If someone
// reintroduces them, the @ts-expect-error below stops erroring and the
// build fails — the removal cannot silently regress.
const _valid: MinionIdentityInput = { correlationId: 'c', attempt: 1 };
// @ts-expect-error legacyMinionType was removed (remediation Milestone 12)
const _gone: MinionIdentityInput = { correlationId: 'c', attempt: 1, legacyMinionType: 'code_explorer' };
void _valid;
void _gone;

function unsignedState(allowlists?: Record<string, Record<string, string[]>>) {
  const store = createMemoryStore();
  initializeToolshed(
    createDefaultToolshedState({
      store,
      adapters: new Map([['github', createMockAdapter('github', {
        callTool: async () => ({ content: 'hello' }),
      })]]),
      signingSecret: SECRET,
      allowUnsignedTokens: true,
      ...(allowlists
        ? { allowlists: { allowlists, pathScopes: {}, shellCommands: {} } }
        : {}),
    })
  );
  return store;
}

describe('legacy identity input removal (remediation Milestone 12)', () => {
  it('the unsigned dev path resolves the fixed dev-unsigned principal, whatever the JSON smuggles', async () => {
    const store = unsignedState({ dev: {} });
    const smuggled = {
      correlationId: 'corr_1',
      attempt: 1,
      legacyMinionType: 'admin',
      legacyTeamId: 'production',
      legacySessionId: 'sess-vip',
    } as unknown as MinionIdentityInput;

    const result = await verifyAndExecuteTool(smuggled, 'github', 'get_file_contents', {});

    expect(result.status).toBe('blocked_by_allowlist');
    const audit = store.listAuditEntries()[0];
    expect(audit.minionType).toBe('dev-unsigned');
    expect(audit.teamId).toBe('dev');
  });

  it('a verified token still governs identity on the signed path', async () => {
    const store = unsignedState({ code_explorer: { github: ['get_file_contents'] } });
    const token = mintMinionToken(
      { agent_id: 'code_explorer', scope_id: 'sess_1', correlation_id: 'corr_1' },
      SECRET
    );

    const result = await verifyAndExecuteTool(
      { minionToken: token, correlationId: 'corr_1', attempt: 1 },
      'github',
      'get_file_contents',
      {}
    );

    const audit = store.listAuditEntries()[0];
    expect(audit.minionType).toBe('code_explorer');
    expect(audit.teamId).toBe('sess_1');
    expect(result.status).not.toBe('error');
  });

  it('with the hatch off, an unsigned call is refused regardless of payload', async () => {
    const store = createMemoryStore();
    initializeToolshed(
      createDefaultToolshedState({
        store,
        adapters: new Map(),
        signingSecret: SECRET,
        allowUnsignedTokens: false,
      })
    );
    const result = await verifyAndExecuteTool(
      { correlationId: 'corr_1', attempt: 1 },
      'github',
      'get_file_contents',
      {}
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('invalid minion token');
  });
});
